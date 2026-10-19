import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(bodyParser.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || "changeme";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL not set. DB calls will fail until it's configured.");
}

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

let MAX_TC = 5000;
let MAX_EV = 5000;
let MAX_F = 2000;
let MAX_TRANSACTION = 1000000;

// ========================================================
// MIGUS GLOBAL CACHE
// ========================================================
let MIGU_CONFIG = { version: "1.0", duel_wager: 50, cookie_cost: 10, catch_chance: 0.55 };
let MIGU_LIST = []; // Array of { name, mClass, subClass, image }

// ========================================================
// DREDGE BRUSH & UUID RETURN QUEUE CONSTANTS (8m DIAMETER)
// ========================================================
const DREDGE_RADIUS = 4.0; // 4m radius = 8m total diameter
const DREDGE_RADIUS_SQ = DREDGE_RADIUS * DREDGE_RADIUS; // 16.0
const DREDGE_RESTORE_SECONDS = 86400; // 24 hours (1 full day) to restore seabed
const DREDGE_RETURN_TTL = 300; // 5 minutes (300 seconds) auto-delete for unacknowledged dredge returns
const BRUSH_TICK_OPACITY = 0.03; // 3% per 0.3s tick = 10% per second (10s = 100% depleted)

// Count of 1m x 1m cells inside a 4m radius circle (49 cells)
const CELLS_PER_BRUSH = (() => {
  let count = 0;
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -4; dy <= 4; dy++) {
      if (dx * dx + dy * dy <= DREDGE_RADIUS_SQ) count++;
    }
  }
  return count; // 49
})();

let DREDGE_VERSION = "1.0";
let DREDGE_CONFIG = {
  sandPrice: 0.5,
  gravelPrice: 1.0,
  clayPrice: 1.8,
  ironPrice: 3.5,
  copperPrice: 7.0,
  titaniumPrice: 14.0,
  silverPrice: 30.0,
  goldPrice: 75.0,
  platinumPrice: 150.0,
  diamondPrice: 400.0,
  weightMult: 1.0,
  maxCapacityKg: 5000.0,
  pointsPct: 0.10
};

// Spatial Hash Map of 1m x 1m world seabed cells: key = "gx_gy", value = { d: depletion (0.0-1.0), t: unixTime }
let DREDGE_CELLS = new Map();

// Pending Return Queue tagged by Dredge UUID (Auto-deleted on ACK or after 5 minutes)
// Map key = msgId, value = { msgId, dredgeUuid, weights, addedKg, spotEfficiency, restoreText, status, createdAt }
let DREDGE_RETURNS = new Map();

const globalDebounce = new Set();
const mutexes = {};

async function withLock(key, fn) {
  if (!mutexes[key]) mutexes[key] = Promise.resolve();
  let release;
  const nextPromise = new Promise(resolve => release = resolve);
  const waitPromise = mutexes[key];
  mutexes[key] = waitPromise.then(() => nextPromise);
  try {
    await waitPromise;
    return await fn();
  } finally {
    release();
    if (mutexes[key] === nextPromise) delete mutexes[key];
  }
}

const getUnixTime = () => Math.floor(Date.now() / 1000);
const getCurrentWeek = () => Math.floor((getUnixTime() + 345600) / 604800);
let activeServerWeek = getCurrentWeek();

function parseDredgeSettingsString(valStr) {
  if (!valStr) return;
  const parts = valStr.split("|");
  if (parts.length >= 13) {
    DREDGE_CONFIG.sandPrice = parseFloat(parts[0]) || 0.5;
    DREDGE_CONFIG.gravelPrice = parseFloat(parts[1]) || 1.0;
    DREDGE_CONFIG.clayPrice = parseFloat(parts[2]) || 1.8;
    DREDGE_CONFIG.ironPrice = parseFloat(parts[3]) || 3.5;
    DREDGE_CONFIG.copperPrice = parseFloat(parts[4]) || 7.0;
    DREDGE_CONFIG.titaniumPrice = parseFloat(parts[5]) || 14.0;
    DREDGE_CONFIG.silverPrice = parseFloat(parts[6]) || 30.0;
    DREDGE_CONFIG.goldPrice = parseFloat(parts[7]) || 75.0;
    DREDGE_CONFIG.platinumPrice = parseFloat(parts[8]) || 150.0;
    DREDGE_CONFIG.diamondPrice = parseFloat(parts[9]) || 400.0;
    DREDGE_CONFIG.weightMult = parseFloat(parts[10]) || 1.0;
    DREDGE_CONFIG.maxCapacityKg = parseFloat(parts[11]) || 5000.0;
    DREDGE_CONFIG.pointsPct = parseFloat(parts[12]) || 0.10;
  }
}

function serializeDredgeCells() {
  const now = getUnixTime();
  const arr = [];
  for (const [key, val] of DREDGE_CELLS.entries()) {
    if ((now - val.t) < DREDGE_RESTORE_SECONDS && val.d > 0.001) {
      arr.push([key, Math.round(val.d * 1000) / 1000, val.t]);
    }
  }
  return JSON.stringify(arr);
}

function deserializeDredgeCells(rawStr) {
  DREDGE_CELLS.clear();
  if (!rawStr) return;
  try {
    const parsed = JSON.parse(rawStr);
    const now = getUnixTime();
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (Array.isArray(item) && item.length >= 3) {
          const [key, d, t] = item;
          if ((now - t) < DREDGE_RESTORE_SECONDS && d > 0) {
            DREDGE_CELLS.set(String(key), { d: Math.min(1.0, Number(d)), t: Number(t) });
          }
        }
      }
    }
  } catch (e) {}
}

// Automatically deletes any unacknowledged dredge return message older than 5 minutes (300 seconds)
function pruneExpiredDredgeReturns() {
  const now = getUnixTime();
  for (const [msgId, pkg] of DREDGE_RETURNS.entries()) {
    if ((now - pkg.createdAt) >= DREDGE_RETURN_TTL) {
      DREDGE_RETURNS.delete(msgId);
    }
  }
}

async function pruneExpiredDredgeZones() {
  const now = getUnixTime();
  let removed = 0;
  for (const [key, val] of DREDGE_CELLS.entries()) {
    if ((now - val.t) >= DREDGE_RESTORE_SECONDS) {
      DREDGE_CELLS.delete(key);
      removed++;
    }
  }
  if (removed > 0 && DATABASE_URL) {
    try {
      await db.query(
        `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
        ["DREDGE_ZONES", serializeDredgeCells()]
      );
    } catch (e) {}
  }
}

// Inspects the 8m circle (4m radius) around (targetX, targetY) without modifying it
function inspectBrushArea(targetX, targetY) {
  const now = getUnixTime();
  const baseX = Math.floor(targetX);
  const baseY = Math.floor(targetY);
  let totalDepletion = 0.0;
  let cellCount = 0;
  let maxRestoreTime = 0;

  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -5; dy <= 5; dy++) {
      const gx = baseX + dx;
      const gy = baseY + dy;
      const distSq = (gx + 0.5 - targetX) * (gx + 0.5 - targetX) + (gy + 0.5 - targetY) * (gy + 0.5 - targetY);
      if (distSq <= DREDGE_RADIUS_SQ) {
        cellCount++;
        const key = `${gx}_${gy}`;
        const cell = DREDGE_CELLS.get(key);
        if (cell) {
          if ((now - cell.t) < DREDGE_RESTORE_SECONDS) {
            totalDepletion += cell.d;
            const restoreAt = cell.t + DREDGE_RESTORE_SECONDS;
            if (restoreAt > maxRestoreTime) maxRestoreTime = restoreAt;
          } else {
            DREDGE_CELLS.delete(key);
          }
        }
      }
    }
  }

  const denom = cellCount > 0 ? cellCount : CELLS_PER_BRUSH;
  const depletedFraction = Math.min(1.0, Math.max(0.0, totalDepletion / denom));
  const remainingSeconds = maxRestoreTime > now ? (maxRestoreTime - now) : 0;
  return { depletedFraction, remainingSeconds };
}

// Paints an 8m circular brush stamp at exact world coordinates (targetX, targetY).
// Every 1m x 1m cell yields resources strictly proportional to what is still left in that specific meter!
// If Dredge 2 crosses Dredge 1's trail, the cells inside Dredge 1's trail have lower 'avail' and yield less.
function paintBrushStamp(targetX, targetY, opacity, now) {
  const baseX = Math.floor(targetX);
  const baseY = Math.floor(targetY);
  let weightedYieldSum = 0.0;
  let cellCount = 0;

  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -5; dy <= 5; dy++) {
      const gx = baseX + dx;
      const gy = baseY + dy;
      const distSq = (gx + 0.5 - targetX) * (gx + 0.5 - targetX) + (gy + 0.5 - targetY) * (gy + 0.5 - targetY);

      if (distSq <= DREDGE_RADIUS_SQ) {
        cellCount++;
        const key = `${gx}_${gy}`;
        const cell = DREDGE_CELLS.get(key);
        let currentDep = 0.0;

        if (cell && (now - cell.t) < DREDGE_RESTORE_SECONDS) {
          currentDep = cell.d;
        }

        const avail = Math.max(0.0, 1.0 - currentDep);
        if (avail > 0.0) {
          const depletionAdded = Math.min(avail, opacity);
          // Dynamic yield per meter: scaled by 'avail' (how much resource actually remains in this 1m² cell)
          const cellYield = depletionAdded * avail;
          weightedYieldSum += cellYield;

          DREDGE_CELLS.set(key, {
            d: Math.min(1.0, currentDep + depletionAdded),
            t: now
          });
        }
      }
    }
  }

  const denom = cellCount > 0 ? cellCount : CELLS_PER_BRUSH;
  return weightedYieldSum / denom;
}

// Interpolates between (x1, y1) and (x2, y2) if the dredge moved more than 0.75m between samples
// so the trail ("rastro") is 100% continuous without skipping any meters.
function applyContinuousStrokeSegment(x1, y1, x2, y2, ticks, now) {
  let extracted = 0.0;
  const dist = Math.hypot(x2 - x1, y2 - y1);

  if (dist <= 0.75 || isNaN(x1) || isNaN(y1)) {
    for (let t = 0; t < ticks; t++) {
      extracted += paintBrushStamp(x2, y2, BRUSH_TICK_OPACITY, now);
    }
    return extracted;
  }

  const steps = Math.max(1, Math.min(20, Math.ceil(dist / 0.5)));
  const totalOpacity = ticks * BRUSH_TICK_OPACITY;
  const stepOpacity = totalOpacity / steps;

  for (let s = 1; s <= steps; s++) {
    const ratio = s / steps;
    const ix = x1 + (x2 - x1) * ratio;
    const iy = y1 + (y2 - y1) * ratio;
    extracted += paintBrushStamp(ix, iy, stepOpacity, now);
  }
  return extracted;
}

function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

async function isValidGfnHub(parcelUuid) {
  if (!parcelUuid) return false;
  const cleanTarget = parcelUuid.toLowerCase().replace(/[^0-9a-f\-]/g, "");
  if (cleanTarget.length !== 36) return false;

  try {
    const serversRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["SERVERS"]);
    if (serversRes.rowCount === 0 || !serversRes.rows[0].value) return false;
    const continents = serversRes.rows[0].value.split("ç").filter(Boolean);

    for (const cont of continents) {
      const cRes = await db.query("SELECT value FROM kvstore WHERE id=$1", [cont]);
      if (cRes.rowCount > 0 && cRes.rows[0].value) {
        const hubs = cRes.rows[0].value.split("ç").filter(Boolean);
        for (const h of hubs) {
          const hubUuid = h.split("#")[0].toLowerCase().replace(/[^0-9a-f\-]/g, "");
          if (hubUuid === cleanTarget) return true;
        }
      }
    }
  } catch (e) {}
  return false;
}

async function loadGlobalSettings() {
  try {
    const res = await db.query("SELECT value FROM kvstore WHERE id=$1", ["GLOBAL_SETTINGS"]);
    if (res.rowCount > 0 && res.rows[0].value) {
      const parts = res.rows[0].value.split("|");
      if (parts[6] !== undefined && !isNaN(parseInt(parts[6]))) MAX_TC = parseInt(parts[6]);
      if (parts[7] !== undefined && !isNaN(parseInt(parts[7]))) MAX_EV = parseInt(parts[7]);
      if (parts[8] !== undefined && !isNaN(parseInt(parts[8]))) MAX_F = parseInt(parts[8]);
    }

    const mCfgRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["MIGU_CONFIG"]);
    if (mCfgRes.rowCount > 0 && mCfgRes.rows[0].value) {
      MIGU_CONFIG = { ...MIGU_CONFIG, ...JSON.parse(mCfgRes.rows[0].value) };
    }

    const mListRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["MIGU_LIST"]);
    if (mListRes.rowCount > 0 && mListRes.rows[0].value) {
      MIGU_LIST = JSON.parse(mListRes.rows[0].value);
    }

    const dVerRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["DREDGE_VERSION"]);
    if (dVerRes.rowCount > 0 && dVerRes.rows[0].value) {
      DREDGE_VERSION = dVerRes.rows[0].value.trim();
    } else {
      await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, ["DREDGE_VERSION", DREDGE_VERSION]);
    }

    const dSetRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["DREDGE_SETTINGS"]);
    if (dSetRes.rowCount > 0 && dSetRes.rows[0].value) {
      parseDredgeSettingsString(dSetRes.rows[0].value);
    } else {
      const defaultStr = [
        DREDGE_CONFIG.sandPrice, DREDGE_CONFIG.gravelPrice, DREDGE_CONFIG.clayPrice,
        DREDGE_CONFIG.ironPrice, DREDGE_CONFIG.copperPrice, DREDGE_CONFIG.titaniumPrice,
        DREDGE_CONFIG.silverPrice, DREDGE_CONFIG.goldPrice, DREDGE_CONFIG.platinumPrice,
        DREDGE_CONFIG.diamondPrice, DREDGE_CONFIG.weightMult, DREDGE_CONFIG.maxCapacityKg,
        DREDGE_CONFIG.pointsPct
      ].join("|");
      await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, ["DREDGE_SETTINGS", defaultStr]);
    }

    const dZonesRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["DREDGE_ZONES"]);
    if (dZonesRes.rowCount > 0 && dZonesRes.rows[0].value) {
      deserializeDredgeCells(dZonesRes.rows[0].value);
    }
  } catch (e) {}
}

async function clearAllMessageQueues() {
  if (!DATABASE_URL) return;
  try {
    await db.query("DELETE FROM kvstore WHERE id LIKE '%_MSG'");
    await db.query("DELETE FROM kvstore WHERE id LIKE '%_ALERTS'"); 
  } catch (e) {}
}

async function cleanupStaleAffinities() {
  if (!DATABASE_URL) return;
  try {
    const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'player_%'");
    let now = getUnixTime();
    for (let row of q.rows) {
      try {
        let pData = JSON.parse(row.value);
        let modified = false;
        if (pData.AFFINITY && pData.AFFINITY_TIME) {
          for (let hubUuid in pData.AFFINITY) {
            let lastTime = pData.AFFINITY_TIME[hubUuid] || 0;
            if (lastTime === 0) {
              pData.AFFINITY_TIME[hubUuid] = now;
              modified = true;
            } else if ((now - lastTime) > 604800) {
              delete pData.AFFINITY[hubUuid];
              delete pData.AFFINITY_TIME[hubUuid];
              modified = true;
            }
          }
        }
        if (modified) await db.query("UPDATE kvstore SET value = $1 WHERE id = $2", [JSON.stringify(pData), row.id]);
      } catch (e) {}
    }
  } catch (e) { console.error("Erro afinidades:", e); }
}

setInterval(cleanupStaleAffinities, 24 * 60 * 60 * 1000);
setInterval(pruneExpiredDredgeZones, 15 * 60 * 1000);
// Background timer to automatically purge unacknowledged dredge returns older than 5 minutes
setInterval(pruneExpiredDredgeReturns, 30 * 1000);

async function processHallOfFame(rankString) {
  if (!rankString || rankString.length <= 5 || rankString.includes("Waiting")) return;
  try {
    let hofRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["HALL_OF_FAME"]);
    let hofList = [];
    if (hofRes.rowCount > 0 && hofRes.rows[0].value) { try { hofList = JSON.parse(hofRes.rows[0].value); } catch(e){} }
    
    let playerRecords = new Map();
    hofList.forEach(p => {
      if (p && p.name) {
        let cleanName = p.name.trim().toLowerCase();
        if (!playerRecords.has(cleanName) || playerRecords.get(cleanName).score < p.score) {
          playerRecords.set(cleanName, { name: p.name.trim(), score: p.score });
        }
      }
    });
    
    const lines = rankString.split(/\\n|\n/);
    lines.forEach(line => {
       let match = line.match(/(?:[\d]+[°\.]\s*:?\s*)?(.+?)\s*(?:\(([\d,\.]+)\)|-\s*([\d,\.]+))/);
       if (match) {
         let playerName = match[1].trim();
         let cleanName = playerName.toLowerCase();
         let scoreStr = match[2] || match[3];
         let weeklyScore = parseInt(scoreStr.replace(/\D/g, ''));
         
         if (!isNaN(weeklyScore)) {
           if (playerRecords.has(cleanName)) {
             let existing = playerRecords.get(cleanName);
             if (weeklyScore > existing.score) {
               existing.score = weeklyScore;
               existing.name = playerName;
             }
           } else {
             playerRecords.set(cleanName, { name: playerName, score: weeklyScore });
           }
         }
       }
    });
    
    hofList = Array.from(playerRecords.values());
    hofList.sort((a, b) => b.score - a.score);
    hofList = hofList.slice(0, 3);
    
    await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, ["HALL_OF_FAME", JSON.stringify(hofList)]);
  } catch(e) {}
}

async function ensureTable() {
  if (!DATABASE_URL) return;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS kvstore (id TEXT PRIMARY KEY, value TEXT);`);
    await loadGlobalSettings(); 
    await clearAllMessageQueues();
    await db.query("DELETE FROM kvstore WHERE id LIKE 'PARCEL_%'");
    await cleanupStaleAffinities();
    
    const lastRankRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["lastWeekTopFive"]);
    if (lastRankRes.rowCount > 0 && lastRankRes.rows[0].value) {
       await processHallOfFame(lastRankRes.rows[0].value);
    }
  } catch (e) {}
}
ensureTable();

setInterval(async () => {
  let currentNowWeek = getCurrentWeek();
  if (currentNowWeek !== activeServerWeek) {
    try {
      const oldRankRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["weeklyTopFive"]);
      let oldRank = oldRankRes.rowCount > 0 ? oldRankRes.rows[0].value : "";

      if (oldRank && oldRank.length > 5 && !oldRank.includes("Waiting")) {
        await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, ["lastWeekTopFive", oldRank]);
        await processHallOfFame(oldRank);
      }
      await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, ["weeklyTopFive", "Waiting for new deliveries..."]);
      activeServerWeek = currentNowWeek;
    } catch (e) {}
  }
}, 60000);

function requireToken(req, res, next) {
  const token = req.header("x-api-token");
  if (!token || token !== API_TOKEN) return res.status(401).json({ error: "invalid token" });
  next();
}

async function dbGet(id) {
  try {
    const res = await db.query("SELECT value FROM kvstore WHERE id=$1", [id]);
    return res.rowCount > 0 ? res.rows[0].value : null;
  } catch (e) { return null; }
}

async function dbSet(id, value) {
  try {
    await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, [id, value]);
  } catch (e) {}
}

async function saveServerChunks(srvName, mainList, namesList) {
  const newMainStr = mainList.join("ç");
  const chunks = ["", "", "", "", ""];
  for (let i = 0; i < namesList.length; i++) {
    let chunkIdx = Math.floor(i / 20);
    if (chunkIdx < 5) {
      if (chunks[chunkIdx] !== "") chunks[chunkIdx] += "ç";
      chunks[chunkIdx] += namesList[i];
    }
  }
  await dbSet(srvName, newMainStr);
  await dbSet(`${srvName}_NAMES_1`, chunks[0]);
  await dbSet(`${srvName}_NAMES_2`, chunks[1]);
  await dbSet(`${srvName}_NAMES_3`, chunks[2]);
  await dbSet(`${srvName}_NAMES_4`, chunks[3]);
  await dbSet(`${srvName}_NAMES_5`, chunks[4]);
}

async function addPlayerMessage(uuid, msg) {
  const keyId = `${uuid}_MSG`;
  try {
    const res = await db.query("SELECT value FROM kvstore WHERE id=$1", [keyId]);
    let messages = [];
    if (res.rowCount > 0 && res.rows[0].value) { try { messages = JSON.parse(res.rows[0].value); } catch(e) {} }
    messages.push(msg);
    if (messages.length > 20) messages = messages.slice(-20);
    await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, [keyId, JSON.stringify(messages)]);
  } catch (e) {}
}

app.get("/get-msg", async (req, res) => {
  const uuid = req.query.uuid;
  if (!uuid) return res.status(400).json({ error: "missing uuid" });
  try {
    const q = await db.query("SELECT value FROM kvstore WHERE id=$1", [`${uuid}_MSG`]);
    res.json({ messages: (q.rowCount > 0 && q.rows[0].value) ? JSON.parse(q.rows[0].value) : [] });
  } catch (e) { res.status(500).json({ error: "db error" }); }
});

app.post("/ack-msg", async (req, res) => {
  const { uuid } = req.body;
  if (!uuid) return res.status(400).json({ error: "missing uuid" });
  try {
    await db.query("DELETE FROM kvstore WHERE id=$1", [`${uuid}_MSG`]);
    res.json({ status: "cleared" });
  } catch (e) { res.status(500).json({ error: "db error" }); }
});

async function getPlayerData(uuid) {
  if (!uuid) return null;
  const res = await db.query("SELECT value FROM kvstore WHERE id=$1", [`player_${uuid}`]);
  let data = { M: 0, P: 0, P_W: 0, TC_V: 0, TC_W: 0, EV_V: 0, EV_W: 0, RE: 0, AT: "", B_M: 1.0, B_T: 0, ACTIVE_PARCEL: "", PARCEL_TIME: 0, LAST_DIST: 0, AFFINITY: {}, AFFINITY_TIME: {}, MIGUS: [], ACTIVE_MIGU: "", COOKIE_STOCK: 0 };
  if (res.rowCount > 0) {
    try { 
      let parsedData = JSON.parse(res.rows[0].value);
      data = { ...data, ...parsedData }; 
      data.M = parseInt(data.M, 10) || 0;
      data.P = parseInt(data.P, 10) || 0;
      data.P_W = parseInt(data.P_W, 10) || 0;
      data.TC_V = parseInt(data.TC_V, 10) || 0;
      data.TC_W = parseInt(data.TC_W, 10) || 0;
      data.EV_V = parseInt(data.EV_V, 10) || 0;
      data.EV_W = parseInt(data.EV_W, 10) || 0;
      data.RE = parseInt(data.RE, 10) || 0;
      data.B_M = parseFloat(data.B_M) || 1.0;
      data.B_T = parseInt(data.B_T, 10) || 0;
      data.PARCEL_TIME = parseInt(data.PARCEL_TIME, 10) || 0;
      data.LAST_DIST = parseFloat(data.LAST_DIST) || 0;
      data.AFFINITY = parsedData.AFFINITY || {};
      data.AFFINITY_TIME = parsedData.AFFINITY_TIME || {};
      data.ACTIVE_MIGU = parsedData.ACTIVE_MIGU || "";
      data.COOKIE_STOCK = parseInt(data.COOKIE_STOCK, 10) || 0;

      if (parsedData.MIGUS) {
        data.MIGUS = parsedData.MIGUS.map(m => {
            if (typeof m === 'string') {
                return { name: m, mClass: "Unknown", subClass: "Walker", rarity: "Common", power: 30, maxPower: 130, hp: 30, maxHp: 130 };
            }
            if (!m.maxPower) m.maxPower = m.power + 100;
            if (!m.maxHp) m.maxHp = m.hp + 100;
            if (!m.rarity) m.rarity = "Common";
            return m;
        });
      } else {
        data.MIGUS = [];
      }

      let now = getUnixTime();
      let maxAllowedFuture = now + (5 * 365 * 24 * 60 * 60); 
      if (data.B_T > maxAllowedFuture) { data.B_T = 0; data.B_M = 1.0; }
    } catch(e) {}
  }
  return data;
}

async function savePlayerData(uuid, data) {
  await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, [`player_${uuid}`, JSON.stringify(data)]);
}

// ========================================================
// DREDGE BRUSH & UUID RETURN QUEUE ROUTES
// ========================================================
app.get('/dredge/check-zone', async (req, res) => {
  const { x, y, version } = req.query;
  if (version && version !== DREDGE_VERSION) {
    return res.json({ status: "OUTDATED", serverVersion: DREDGE_VERSION });
  }

  const worldX = parseFloat(x);
  const worldY = parseFloat(y);
  if (isNaN(worldX) || isNaN(worldY)) {
    return res.status(400).json({ status: "ERROR", message: "Invalid world coordinates." });
  }

  pruneExpiredDredgeReturns();
  const { depletedFraction, remainingSeconds } = inspectBrushArea(worldX, worldY);

  if (depletedFraction >= 0.995) {
    return res.json({
      status: "DEPLETED",
      depletedPct: 100,
      efficiency: 0.0,
      restoreText: formatDuration(remainingSeconds)
    });
  }

  const depletedPct = Math.round(depletedFraction * 1000) / 10;
  const efficiency = Math.round((1.0 - depletedFraction) * 1000) / 1000;

  return res.json({
    status: "OK",
    depletedPct,
    efficiency
  });
});

// Receives the 5-second batch of 0.3s strokes along with the dredge's UUID.
// Calculates per-meter dynamic extraction, tags the return package with dredgeUuid,
// and places it on the network return queue with a 5-minute auto-delete timer.
app.post('/dredge/sync-brush', requireToken, async (req, res) => {
  const { dredgeUuid, ackMsgId, strokes } = req.body;
  if (!dredgeUuid || !strokes || typeof strokes !== "string") {
    return res.status(400).json({ status: "ERROR", message: "Missing dredgeUuid or strokes." });
  }

  await withLock("DREDGE_ZONES_LOCK", async () => {
    const now = getUnixTime();
    pruneExpiredDredgeReturns();

    // If the dredge piggybacked an ACK from a previous batch, delete it immediately
    if (ackMsgId && DREDGE_RETURNS.has(String(ackMsgId))) {
      DREDGE_RETURNS.delete(String(ackMsgId));
    }

    const strokeList = strokes.split("|").filter(Boolean);
    let totalExtractedUnits = 0.0;
    let prevX = NaN;
    let prevY = NaN;
    let lastX = NaN;
    let lastY = NaN;

    for (const s of strokeList) {
      const parts = s.split(",");
      if (parts.length >= 3) {
        const sx = parseFloat(parts[0]);
        const sy = parseFloat(parts[1]);
        const ticks = Math.min(35, Math.max(1, parseInt(parts[2], 10) || 1));
        if (!isNaN(sx) && !isNaN(sy)) {
          totalExtractedUnits += applyContinuousStrokeSegment(prevX, prevY, sx, sy, ticks, now);
          prevX = sx;
          prevY = sy;
          lastX = sx;
          lastY = sy;
        }
      }
    }

    let spotEfficiency = 1.0;
    let restoreText = "24h 0m";
    if (!isNaN(lastX) && !isNaN(lastY)) {
      const { depletedFraction, remainingSeconds } = inspectBrushArea(lastX, lastY);
      spotEfficiency = Math.round(Math.max(0.0, 1.0 - depletedFraction) * 1000) / 1000;
      restoreText = formatDuration(remainingSeconds);
    }

    const msgId = `${dredgeUuid.substring(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    let returnPkg;

    if (totalExtractedUnits <= 0.0001) {
      returnPkg = {
        msgId,
        dredgeUuid,
        status: "DEPLETED",
        spotEfficiency: 0.0,
        restoreText,
        addedKg: 0.0,
        weights: "0|0|0|0|0|0|0|0|0|0",
        createdAt: now
      };
    } else {
      await dbSet("DREDGE_ZONES", serializeDredgeCells());

      // Normalize so a full 10-second virgin extraction equals 1.0 full weightMult cycle
      const mult = DREDGE_CONFIG.weightMult * (totalExtractedUnits * 2.0);
      const randRange = (min, max) => min + Math.random() * (max - min);
      const roundKg = (val) => Math.round(val * 10) / 10;

      let sandKg     = roundKg(randRange(25, 45) * mult);
      let gravelKg   = Math.random() <= 0.90 ? roundKg(randRange(12, 26) * mult) : 0;
      let clayKg     = Math.random() <= 0.75 ? roundKg(randRange(6, 15) * mult) : 0;
      let ironKg     = Math.random() <= 0.60 ? roundKg(randRange(3, 9) * mult) : 0;
      let copperKg   = Math.random() <= 0.40 ? roundKg(randRange(1.5, 5.0) * mult) : 0;
      let titaniumKg = Math.random() <= 0.25 ? roundKg(randRange(0.8, 3.0) * mult) : 0;
      let silverKg   = Math.random() <= 0.15 ? roundKg(randRange(0.4, 1.6) * mult) : 0;
      let goldKg     = Math.random() <= 0.08 ? roundKg(randRange(0.2, 0.9) * mult) : 0;
      let platinumKg = Math.random() <= 0.04 ? roundKg(randRange(0.1, 0.5) * mult) : 0;
      let diamondKg  = Math.random() <= 0.015 ? roundKg(randRange(0.1, 0.3) * mult) : 0;

      const addedKg = roundKg(
        sandKg + gravelKg + clayKg + ironKg + copperKg +
        titaniumKg + silverKg + goldKg + platinumKg + diamondKg
      );

      const weightsStr = [
        sandKg, gravelKg, clayKg, ironKg, copperKg,
        titaniumKg, silverKg, goldKg, platinumKg, diamondKg
      ].join("|");

      returnPkg = {
        msgId,
        dredgeUuid,
        status: "OK",
        spotEfficiency,
        restoreText,
        addedKg,
        weights: weightsStr,
        createdAt: now
      };
    }

    // Remove any older unacknowledged message for this same dredgeUuid before queuing the new one
    for (const [oldId, oldPkg] of DREDGE_RETURNS.entries()) {
      if (oldPkg.dredgeUuid === dredgeUuid) {
        DREDGE_RETURNS.delete(oldId);
      }
    }

    // Store in the 5-minute network queue tagged with dredgeUuid
    DREDGE_RETURNS.set(msgId, returnPkg);

    // Build compact network broadcast list (matching dredgeUuid + up to 2 other active packages)
    // so every dredge checks the UUID of incoming packages without exceeding LSL's 64KB memory
    const broadcastList = [returnPkg];
    for (const [id, pkg] of DREDGE_RETURNS.entries()) {
      if (id !== msgId && broadcastList.length < 3) {
        broadcastList.push(pkg);
      }
    }

    return res.json({
      status: "QUEUED",
      returns: broadcastList
    });
  });
});

// Explicit ACK endpoint: when a dredge verifies that a return package matches its UUID and stores
// the resources, it calls this endpoint to immediately delete the message from Render.
app.post('/dredge/ack-return', requireToken, async (req, res) => {
  const { dredgeUuid, msgId } = req.body;
  pruneExpiredDredgeReturns();

  if (msgId && DREDGE_RETURNS.has(String(msgId))) {
    const pkg = DREDGE_RETURNS.get(String(msgId));
    if (!dredgeUuid || pkg.dredgeUuid === String(dredgeUuid)) {
      DREDGE_RETURNS.delete(String(msgId));
      return res.json({ status: "DELETED", msgId });
    }
  }
  return res.json({ status: "NOT_FOUND_OR_EXPIRED" });
});

app.post('/admin/dredge/clear-zones', requireToken, async (req, res) => {
  DREDGE_CELLS.clear();
  DREDGE_RETURNS.clear();
  await dbSet("DREDGE_ZONES", "[]");
  res.json({ status: "ok", message: "All depleted dredge zones and pending return queues have been cleared." });
});

// ========================================================
// MIGUS ADMIN ROUTES
// ========================================================
app.post('/admin/migu/config', requireToken, async (req, res) => {
    const { version, duel_wager, cookie_cost } = req.body;
    if (version) MIGU_CONFIG.version = version;
    if (duel_wager !== undefined) MIGU_CONFIG.duel_wager = parseInt(duel_wager);
    if (cookie_cost !== undefined) MIGU_CONFIG.cookie_cost = parseInt(cookie_cost);
    
    await dbSet("MIGU_CONFIG", JSON.stringify(MIGU_CONFIG));
    res.json({ success: true, message: "Global Migu Configuration Updated", config: MIGU_CONFIG });
});

app.post('/admin/migu/add', requireToken, async (req, res) => {
    const { name, mClass, subClass, image } = req.body;
    if (!name || !mClass || !subClass) return res.status(400).json({ error: "Missing Migu properties" });

    let idx = MIGU_LIST.findIndex(m => m.name.toLowerCase() === name.toLowerCase());
    if (idx !== -1) {
        MIGU_LIST[idx] = { name, mClass, subClass, image };
    } else {
        MIGU_LIST.push({ name, mClass, subClass, image });
    }
    
    await dbSet("MIGU_LIST", JSON.stringify(MIGU_LIST));
    res.json({ success: true, message: `Migu [${name}] added to the Database.` });
});

app.post('/admin/migu/delete', requireToken, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Missing name" });

    MIGU_LIST = MIGU_LIST.filter(m => m.name.toLowerCase() !== name.toLowerCase());
    await dbSet("MIGU_LIST", JSON.stringify(MIGU_LIST));

    let affectedPlayers = 0;
    try {
        const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'player_%'");
        for (let row of q.rows) {
            try {
                let pData = JSON.parse(row.value);
                if (pData.MIGUS && pData.MIGUS.length > 0) {
                    let count = 0;
                    let newInventory = [];
                    for (let m of pData.MIGUS) {
                        let mName = (typeof m === 'string') ? m : m.name;
                        if (mName.toLowerCase() === name.toLowerCase()) count++;
                        else newInventory.push(m);
                    }
                    if (count > 0) {
                        pData.MIGUS = newInventory;
                        if (pData.ACTIVE_MIGU && pData.ACTIVE_MIGU.toLowerCase() === name.toLowerCase()) {
                            pData.ACTIVE_MIGU = pData.MIGUS.length > 0 ? pData.MIGUS[0].name : "";
                        }
                        let compensation = count * 10000;
                        pData.M += compensation;
                        await db.query("UPDATE kvstore SET value = $1 WHERE id = $2", [JSON.stringify(pData), row.id]);
                        
                        let pUuid = row.id.replace("player_", "");
                        await addPlayerMessage(pUuid, `⚠️ The Migu [${name}] was permanently deleted. You received ${compensation} F₵ compensation.`);
                        affectedPlayers++;
                    }
                }
            } catch(e) {}
        }
    } catch(err) {
        return res.status(500).json({ error: "Database error during mass compensation." });
    }

    res.json({ success: true, message: `Migu [${name}] deleted. Compensated ${affectedPlayers} players.` });
});

// ========================================================
// MIGUS GAMEPLAY ROUTES
// ========================================================
app.get('/migu/config', async (req, res) => {
  const { version, uuid } = req.query;
  if (version !== MIGU_CONFIG.version) return res.json({ status: "OUTDATED" });

  let player = await getPlayerData(uuid);
  let updated = false;
  if (!player.MIGUS) { player.MIGUS = []; updated = true; }
  if (!player.ACTIVE_MIGU) { player.ACTIVE_MIGU = ""; updated = true; }
  if (updated) await savePlayerData(uuid, player);

  return res.json({
      status: "OK",
      duel_wager: MIGU_CONFIG.duel_wager,
      cookie_cost: MIGU_CONFIG.cookie_cost
  });
});

app.get('/migu/check-funds', async (req, res) => {
  const { uuid } = req.query;
  let player = await getPlayerData(uuid);
  
  if (player.COOKIE_STOCK > 0 || player.M >= MIGU_CONFIG.cookie_cost) {
      return res.json({ status: "OK", balance: player.M, cookie_stock: player.COOKIE_STOCK });
  } else {
      return res.json({ status: "INSUFFICIENT", balance: player.M, cookie_stock: player.COOKIE_STOCK });
  }
});

app.get('/migu/buy-cookie', async (req, res) => {
  const { uuid } = req.query;
  await withLock(uuid, async () => {
      let player = await getPlayerData(uuid);
      if (player.M < MIGU_CONFIG.cookie_cost) {
          return res.send(`Failed: You need ${MIGU_CONFIG.cookie_cost} F₵ to buy a Taming Cookie.`);
      }
      player.M -= MIGU_CONFIG.cookie_cost;
      player.COOKIE_STOCK = (player.COOKIE_STOCK || 0) + 1;
      await savePlayerData(uuid, player);
      return res.send(`SUCCESS: Bought 1 Taming Cookie! Stock: ${player.COOKIE_STOCK} | Balance: ${player.M} F₵`);
  });
});

app.get('/migu/inventory', async (req, res) => {
  const { uuid } = req.query;
  let player = await getPlayerData(uuid);
  res.json({ status: "OK", migus: player.MIGUS || [], cookie_stock: player.COOKIE_STOCK || 0 });
});

app.get('/migu/abandon', async (req, res) => {
  const { uuid, name } = req.query;
  await withLock(uuid, async () => {
      let player = await getPlayerData(uuid);
      if (!player.MIGUS) player.MIGUS = [];
      let idx = player.MIGUS.findIndex(m => m.name.toLowerCase() === name.toLowerCase());
      if (idx === -1) return res.send("Error: Migu not found in inventory.");
      
      player.MIGUS.splice(idx, 1);
      if (player.ACTIVE_MIGU && player.ACTIVE_MIGU.toLowerCase() === name.toLowerCase()) {
          player.ACTIVE_MIGU = player.MIGUS.length > 0 ? player.MIGUS[0].name : "";
      }
      await savePlayerData(uuid, player);
      return res.send(`SUCCESS: Abandoned [${name}]. Released back into the wild.`);
  });
});

app.get('/migu/catch', async (req, res) => {
  const { uuid, z, water, ground } = req.query;

  await withLock(uuid, async () => {
      let player = await getPlayerData(uuid);
      if (!player.MIGUS) player.MIGUS = [];

      if (player.MIGUS.length >= 20) {
          return res.send(`Failed: Your Migu inventory is full (Max 20). Abandon a Migu to catch more!`);
      }

      let usedStock = false;
      if ((player.COOKIE_STOCK || 0) > 0) {
          player.COOKIE_STOCK -= 1;
          usedStock = true;
      } else {
          if (player.M < MIGU_CONFIG.cookie_cost) {
              return res.send(`Failed: You need ${MIGU_CONFIG.cookie_cost} F₵ or a Cookie in stock!`);
          }
          player.M -= MIGU_CONFIG.cookie_cost;
      }

      let envClass = "Walker";
      if (parseFloat(z) > 100) envClass = "Flyer";
      else if (parseFloat(water) > parseFloat(ground)) envClass = "Swimmer";

      let availableMigus = MIGU_LIST.filter(m => m.subClass.toLowerCase() === envClass.toLowerCase());
      
      if (availableMigus.length === 0) {
          await savePlayerData(uuid, player);
          return res.send(`The Cookie broke! No Migus of type [${envClass}] registered here.`);
      }

      if (Math.random() <= MIGU_CONFIG.catch_chance) {
          const selected = availableMigus[Math.floor(Math.random() * availableMigus.length)];
          
          let rarityRoll = Math.random();
          let rarity = "Common";
          let minVal = 10, maxVal = 20;
          if (rarityRoll < 0.10) { rarity = "Rare"; minVal = 36; maxVal = 50; }
          else if (rarityRoll < 0.40) { rarity = "Uncommon"; minVal = 21; maxVal = 35; }

          let initPower = Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
          let initHp = Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;

          const newMigu = {
              name: selected.name,
              mClass: selected.mClass,
              subClass: selected.subClass,
              rarity: rarity,
              power: initPower,
              maxPower: initPower + 100,
              hp: initHp,
              maxHp: initHp + 100
          };

          player.MIGUS.push(newMigu);
          if (!player.ACTIVE_MIGU) player.ACTIVE_MIGU = selected.name; 
          await savePlayerData(uuid, player);
          return res.send(`SUCCESS! Caught [${selected.name}] (${rarity})! [P:${initPower}|HP:${initHp}] | Stock: ${player.COOKIE_STOCK} | Bal: ${player.M}F₵`);
      } else {
          let willStay = Math.random() < 0.5;
          await savePlayerData(uuid, player);

          if (willStay) {
              return res.send(`RETRY: The Migu resisted the Cookie, but stayed in place! Try again? (Stock: ${player.COOKIE_STOCK} | Bal: ${player.M}F₵)`);
          } else {
              return res.send(`FLED: The Migu broke the Cookie and fled into the wild! (Stock: ${player.COOKIE_STOCK} | Bal: ${player.M}F₵)`);
          }
      }
  });
});

app.get('/migu/duel', async (req, res) => {
  const { p1, p2, m1, m2 } = req.query;
  const duelLockStr = [p1, p2].sort().join("_");
  
  await withLock(duelLockStr, async () => {
      let player1 = await getPlayerData(p1);
      let player2 = await getPlayerData(p2);

      if (player1.M < MIGU_CONFIG.duel_wager) return res.send(`Duel Cancelled: Challenger doesn't have ${MIGU_CONFIG.duel_wager} F₵.`);
      if (player2.M < MIGU_CONFIG.duel_wager) return res.send(`Duel Cancelled: Opponent doesn't have ${MIGU_CONFIG.duel_wager} F₵.`);

      let p1Migu = player1.MIGUS.find(m => m.name.toLowerCase() === m1.toLowerCase());
      let p2Migu = player2.MIGUS.find(m => m.name.toLowerCase() === m2.toLowerCase());

      if (!p1Migu) return res.send(`Duel Cancelled: Challenger Migu [${m1}] not found.`);
      if (!p2Migu) return res.send(`Duel Cancelled: Opponent Migu [${m2}] not found.`);

      const p1Score = (p1Migu.power * 0.6 + p1Migu.hp * 0.4) * (0.8 + Math.random() * 0.4);
      const p2Score = (p2Migu.power * 0.6 + p2Migu.hp * 0.4) * (0.8 + Math.random() * 0.4);

      if (p1Score > p2Score) {
          player1.M += MIGU_CONFIG.duel_wager;
          player2.M -= MIGU_CONFIG.duel_wager;
          
          p1Migu.power = Math.min(p1Migu.maxPower, p1Migu.power + 10);
          p1Migu.hp = Math.min(p1Migu.maxHp, p1Migu.hp + 10);
          p2Migu.power = Math.min(p2Migu.maxPower, p2Migu.power + 5);
          p2Migu.hp = Math.min(p2Migu.maxHp, p2Migu.hp + 5);

          await savePlayerData(p1, player1);
          await savePlayerData(p2, player2);
          return res.send(`⚔️ CHALLENGER WINS!\n[${p1Migu.name}] (+10 P/HP) defeated [${p2Migu.name}] (+5 P/HP).\nWon ${MIGU_CONFIG.duel_wager} F₵!`);
      } else {
          player2.M += MIGU_CONFIG.duel_wager;
          player1.M -= MIGU_CONFIG.duel_wager;
          
          p2Migu.power = Math.min(p2Migu.maxPower, p2Migu.power + 10);
          p2Migu.hp = Math.min(p2Migu.maxHp, p2Migu.hp + 10);
          p1Migu.power = Math.min(p1Migu.maxPower, p1Migu.power + 5);
          p1Migu.hp = Math.min(p1Migu.maxHp, p1Migu.hp + 5);

          await savePlayerData(p1, player1);
          await savePlayerData(p2, player2);
          return res.send(`⚔️ DEFENDER WINS!\n[${p2Migu.name}] (+10 P/HP) destroyed [${p1Migu.name}] (+5 P/HP).\nChallenger lost ${MIGU_CONFIG.duel_wager} F₵!`);
      }
  });
});

// ========================================================
// CORE ADMIN PARCEL ROUTE
// ========================================================
app.post('/admin/parcel', requireToken, async (req, res) => {
  const { action, serverId, uuid, pos, regionName, num, newPos } = req.body;
  if (!serverId) return res.status(400).json({ error: "serverId obrigatório" });

  try {
    let targetServer = serverId;
    const formatRegion = (name) => {
      if (!name) return "NULL";
      let clean = name.trim();
      if (clean.toLowerCase() === "royie" || clean.toLowerCase() === "royier") return "Royier";
      return clean;
    };

    if (serverId === "AUTO") {
      let serversData = await dbGet("SERVERS");
      let servers = serversData ? serversData.split("ç") : [];
      let found = false;
      for (let srv of servers) {
        let mData = await dbGet(srv) || "";
        let mList = mData ? mData.split("ç") : [];
        if (mList.findIndex(item => item.startsWith(uuid + "#")) !== -1) {
          targetServer = srv;
          found = true;
          break; 
        }
      }
      if (!found && action !== "SET_PARCEL") return res.status(404).json({ error: "Parcela não encontrada em nenhum continente ativo." });
      if (!found) targetServer = servers[0] || "Satori";
    }

    let serversData = await dbGet("SERVERS");
    let servers = serversData ? serversData.split("ç") : [];

    if (action === "SET_PARCEL") {
      const newItem = `${uuid}#${pos}`;
      const cleanRegion = formatRegion(regionName);

      for (let srv of servers) {
        let mData = await dbGet(srv) || "";
        let mList = mData ? mData.split("ç") : [];
        let joined = [await dbGet(`${srv}_NAMES_1`), await dbGet(`${srv}_NAMES_2`), await dbGet(`${srv}_NAMES_3`), await dbGet(`${srv}_NAMES_4`), await dbGet(`${srv}_NAMES_5`)].filter(Boolean).join("ç");
        let nList = joined ? joined.split("ç") : [];
        while (nList.length < mList.length) nList.push("NULL");

        let idx = mList.findIndex(item => item.startsWith(uuid + "#"));
        if (idx !== -1) {
          mList.splice(idx, 1);
          nList.splice(idx, 1);
          await saveServerChunks(srv, mList, nList);
        }
      }

      let targetMainData = await dbGet(targetServer) || ""; 
      let targetMainList = targetMainData ? targetMainData.split("ç") : [];
      let tJoined = [await dbGet(`${targetServer}_NAMES_1`), await dbGet(`${targetServer}_NAMES_2`), await dbGet(`${targetServer}_NAMES_3`), await dbGet(`${targetServer}_NAMES_4`), await dbGet(`${targetServer}_NAMES_5`)].filter(Boolean).join("ç");
      let targetNamesList = tJoined ? tJoined.split("ç") : [];
      while (targetNamesList.length < targetMainList.length) targetNamesList.push("NULL");

      targetMainList.push(newItem);
      targetNamesList.push(cleanRegion);
      await saveServerChunks(targetServer, targetMainList, targetNamesList);
    } 
    else if (action === "MOVE_HUB") {
      let foundItem = null;
      let foundName = null;

      for (let srv of servers) {
        let mData = await dbGet(srv) || "";
        let mList = mData ? mData.split("ç") : [];
        
        let idx = mList.findIndex(item => item.startsWith(uuid + "#"));
        if (idx !== -1) {
          let joined = [await dbGet(`${srv}_NAMES_1`), await dbGet(`${srv}_NAMES_2`), await dbGet(`${srv}_NAMES_3`), await dbGet(`${srv}_NAMES_4`), await dbGet(`${srv}_NAMES_5`)].filter(Boolean).join("ç");
          let nList = joined ? joined.split("ç") : [];
          while (nList.length < mList.length) nList.push("NULL");

          foundItem = mList.splice(idx, 1)[0];
          foundName = nList.splice(idx, 1)[0];

          await saveServerChunks(srv, mList, nList);
          break;
        }
      }

      if (!foundItem) {
          return res.status(404).json({ error: "Parcela não encontrada em nenhum continente ativo para mover." });
      }

      let destMainData = await dbGet(targetServer) || "";
      let destMainList = destMainData ? destMainData.split("ç") : [];
      let tJoined = [await dbGet(`${targetServer}_NAMES_1`), await dbGet(`${targetServer}_NAMES_2`), await dbGet(`${targetServer}_NAMES_3`), await dbGet(`${targetServer}_NAMES_4`), await dbGet(`${targetServer}_NAMES_5`)].filter(Boolean).join("ç");
      let destNamesList = tJoined ? tJoined.split("ç") : [];
      while (destNamesList.length < destMainList.length) destNamesList.push("NULL");

      destMainList.push(foundItem);
      destNamesList.push(foundName);
      await saveServerChunks(targetServer, destMainList, destNamesList);
    }
    else {
      let mainData = await dbGet(targetServer) || ""; 
      let mainList = mainData ? mainData.split("ç") : [];
      let joined = [await dbGet(`${targetServer}_NAMES_1`), await dbGet(`${targetServer}_NAMES_2`), await dbGet(`${targetServer}_NAMES_3`), await dbGet(`${targetServer}_NAMES_4`), await dbGet(`${targetServer}_NAMES_5`)].filter(Boolean).join("ç");
      let namesList = joined ? joined.split("ç") : [];
      while (namesList.length < mainList.length) namesList.push("NULL");

      if (action === "DEL_PARCEL") {
        const idx = mainList.findIndex(item => item.startsWith(uuid + "#"));
        if (idx !== -1) { mainList.splice(idx, 1); namesList.splice(idx, 1); }
      } 
      else if (action === "DEL_NUM") {
        if (num >= 0 && num < mainList.length) { mainList.splice(num, 1); namesList.splice(num, 1); }
      } 
      else if (action === "REORDER") {
        const idx = mainList.findIndex(item => item.startsWith(uuid + "#"));
        if (idx !== -1) {
          let targetPos = newPos < 0 ? 0 : (newPos > mainList.length ? mainList.length : newPos);
          const item = mainList.splice(idx, 1)[0];
          const name = namesList.splice(idx, 1)[0];
          mainList.splice(targetPos, 0, item);
          namesList.splice(targetPos, 0, name);
        }
      }
      else if (action === "UPDATE_REGION") {
        const idx = mainList.findIndex(item => item.startsWith(uuid + "#"));
        if (idx !== -1) namesList[idx] = formatRegion(regionName);
        namesList = namesList.map(name => formatRegion(name));
      }
      await saveServerChunks(targetServer, mainList, namesList);
    }
    res.status(200).json({ success: true, message: `Ação ${action} processada.` });
  } catch (error) { res.status(500).json({ error: "Erro interno no servidor" }); }
});

app.post('/admin/sync-regions', requireToken, async (req, res) => {
  res.json({ status: "success", message: "Sincronização iniciada." });
  (async () => {
    try {
      let serversData = await dbGet("SERVERS");
      let servers = serversData ? serversData.split("ç").filter(Boolean) : [];
      for (let srv of servers) {
        let mainData = await dbGet(srv) || "";
        let mainList = mainData ? mainData.split("ç").filter(Boolean) : [];
        if (mainList.length === 0) continue;

        let originalNames = [await dbGet(`${srv}_NAMES_1`), await dbGet(`${srv}_NAMES_2`), await dbGet(`${srv}_NAMES_3`), await dbGet(`${srv}_NAMES_4`), await dbGet(`${srv}_NAMES_5`)].filter(Boolean).join("ç");
        let namesList = originalNames ? originalNames.split("ç") : [];
        while (namesList.length < mainList.length) namesList.push("NULL");

        for (let i = 0; i < mainList.length; i++) {
          let uuid = mainList[i].split("#")[0];
          if (uuid && uuid.length === 36) {
            try {
              const fetchOptions = { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html,application/xml" } };
              let slRes = await fetch(`https://world.secondlife.com/parcel/${uuid}`, fetchOptions);
              if (!slRes.ok) slRes = await fetch(`https://world.secondlife.com/place/${uuid}`, fetchOptions);

              if (slRes.ok) {
                const html = await slRes.text();
                let extractedRegion = "";
                const mapMatch = html.match(/maps\.secondlife\.com\/secondlife\/([^\/"]+)/i);
                if (mapMatch && mapMatch[1]) { extractedRegion = decodeURIComponent(mapMatch[1]).replace(/\+/g, ' ').trim(); } 
                else {
                  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                  if (titleMatch && titleMatch[1]) {
                    let title = titleMatch[1].replace(/\n/g, ' ').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
                    let slIdx = title.indexOf(" - Second Life");
                    if (slIdx !== -1) title = title.substring(0, slIdx).trim();
                    let lastDashIdx = title.lastIndexOf(" - ");
                    if (lastDashIdx !== -1) title = title.substring(lastDashIdx + 3).trim();
                    extractedRegion = title;
                  }
                }
                if (extractedRegion) {
                  if (extractedRegion.toLowerCase() === "royie" || extractedRegion.toLowerCase() === "royier") extractedRegion = "Royier";
                  extractedRegion = extractedRegion.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                  if (namesList[i] !== extractedRegion && extractedRegion !== "Second Life") {
                    namesList[i] = extractedRegion;
                  }
                }
              }
            } catch (err) {}
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }
        let newNames = namesList.join("ç");
        if (newNames !== originalNames) await saveServerChunks(srv, mainList, namesList);
      }
    } catch (err) {}
  })();
});

async function isHubImmune(parcelUuid) {
  if (!parcelUuid) return false;
  let target = parcelUuid.toLowerCase().replace(/[^0-9a-f\-]/g, ""); 
  if (target.length !== 36) return false;

  try {
      const qSatori = await db.query("SELECT value FROM kvstore WHERE id ILIKE 'satori'");
      for (let row of qSatori.rows) {
          if (row.value) {
              let list = row.value.split("ç").filter(Boolean);
              if (list.length > 0) {
                  let mainUuid = list[0].split("#")[0].toLowerCase().replace(/[^0-9a-f\-]/g, "");
                  if (target === mainUuid) return true; 
              }
          }
      }

      let targetRegionName = "";
      const qContinents = await db.query("SELECT value FROM kvstore WHERE id IN ('Satori', 'Corsica', 'Nautilus', 'Heterocera', 'Jeogeot', 'Gaeta5', 'Zindra', 'Bellisseria', 'Blake_Sea', 'SATORI')");
      for (let row of qContinents.rows) {
          if (row.value) {
              let list = row.value.split("ç").filter(Boolean);
              for (let item of list) {
                  let parts = item.split("#");
                  if (parts[0].toLowerCase().replace(/[^0-9a-f\-]/g, "") === target) {
                      if (parts.length > 1) {
                          targetRegionName = parts[1].toLowerCase().trim();
                          break;
                      }
                  }
              }
          }
          if (targetRegionName) break;
      }

      const qBoosted = await db.query(`SELECT id, value FROM kvstore WHERE id ILIKE '%boost%' OR id ILIKE '%event%' OR id ILIKE '%hub%'`);
      for (let row of qBoosted.rows) {
          if (row.value && typeof row.value === 'string') {
              let valStr = row.value.toLowerCase();
              if (valStr.includes(target)) return true;
              if (targetRegionName && targetRegionName.length > 2 && valStr.includes(targetRegionName)) return true; 
          }
      }
  } catch(e) { console.error("Erro imunidade:", e); }
  return false; 
}

async function processParcelDemand(parcelUuid, user) {
  if (!parcelUuid || parcelUuid.length < 36) return 1.0;
  let cleanUuid = parcelUuid.toLowerCase().replace(/[^0-9a-f\-]/g, "");
  if (cleanUuid.length !== 36) return 1.0;
  
  const key = `PARCEL_${cleanUuid}`;
  let isImmune = await isHubImmune(cleanUuid);

  try {
      let dataStr = await dbGet(key);
      let parcel = dataStr ? JSON.parse(dataStr) : { mult: 1.0, history: [], last_delivery: 0, user_history: {} };
      if (!parcel.user_history) parcel.user_history = {};
      let now = getUnixTime();

      if (isImmune) {
          parcel.mult = 1.0;
          parcel.history = [];
          parcel.last_delivery = now;
          await dbSet(key, JSON.stringify(parcel));
          return 1.0;
      }

      parcel.history = parcel.history.filter(ts => (now - ts) <= 10800);
      let lastUserTime = parcel.user_history[user] || 0;
      let alreadyCountedRecently = (now - lastUserTime) < 15;

      if (!alreadyCountedRecently) {
         if (parcel.last_delivery > 0 && parcel.mult < 1.0) {
            let timeOffline = now - parcel.last_delivery;
            let recovered = (timeOffline / 600.0) * 0.15;
            parcel.mult = Math.min(1.0, parcel.mult + recovered);
         }
         parcel.history.push(now);
         parcel.last_delivery = now; 
         parcel.user_history[user] = now;
         parcel.mult = Math.max(0.1, parcel.mult - 0.1);
         parcel.mult = Math.round(parcel.mult * 10) / 10;
         await dbSet(key, JSON.stringify(parcel));
      }
      return parcel.mult;
  } catch (err) { return 1.0; }
}

async function getParcelDemandOnly(parcelUuid) {
  if (!parcelUuid || parcelUuid.length < 36) return { mult: 1.0, last_delivery: 0 };
  let cleanUuid = parcelUuid.toLowerCase().replace(/[^0-9a-f\-]/g, "");
  if (cleanUuid.length !== 36) return { mult: 1.0, last_delivery: 0 };
  if (await isHubImmune(cleanUuid)) return { mult: 1.0, last_delivery: 0 };
  
  const key = `PARCEL_${cleanUuid}`;
  try {
      let dataStr = await dbGet(key);
      if (!dataStr) return { mult: 1.0, last_delivery: 0 };
      let parcel = JSON.parse(dataStr);
      let now = getUnixTime();
      let mult = parcel.mult;
      if (parcel.last_delivery > 0 && mult < 1.0) {
         let timeOffline = now - parcel.last_delivery;
         let recovered = (timeOffline / 600.0) * 0.15;
         mult = Math.min(1.0, mult + recovered);
      }
      return { mult: Math.round(mult * 10) / 10, last_delivery: parcel.last_delivery || 0 };
  } catch (err) { return { mult: 1.0, last_delivery: 0 }; }
}

app.post("/action", requireToken, async (req, res) => {
  const { topic, user, target, content, plan, productName, reqTime, action } = req.body;
  let safeTopic = (topic || action || "").toLowerCase().trim();

  const txHash = `${user}_${safeTopic}_${content}`;
  if (globalDebounce.has(txHash)) return res.json({ status: "ignored" });
  globalDebounce.add(txHash);
  setTimeout(() => globalDebounce.delete(txHash), 2500);

  let responsePayload = { status: "success" };

  await withLock(user, async () => {
    try {
      let player = await getPlayerData(user);
      let now = getUnixTime();

      if (safeTopic === "dredge sell") {
        const isHub = await isValidGfnHub(target);
        if (!isHub) {
          responsePayload = { status: "not_a_hub" };
          return res.json(responsePayload);
        }

        const wParts = (content || "").split("|").map(v => Math.max(0, parseFloat(v) || 0));
        while (wParts.length < 10) wParts.push(0);

        const prices = [
          DREDGE_CONFIG.sandPrice,
          DREDGE_CONFIG.gravelPrice,
          DREDGE_CONFIG.clayPrice,
          DREDGE_CONFIG.ironPrice,
          DREDGE_CONFIG.copperPrice,
          DREDGE_CONFIG.titaniumPrice,
          DREDGE_CONFIG.silverPrice,
          DREDGE_CONFIG.goldPrice,
          DREDGE_CONFIG.platinumPrice,
          DREDGE_CONFIG.diamondPrice
        ];

        let rawTotal = 0;
        let totalKg = 0;
        for (let i = 0; i < 10; i++) {
          rawTotal += wParts[i] * prices[i];
          totalKg += wParts[i];
        }

        let price = Math.round(rawTotal);
        if (price <= 0) {
          responsePayload = { status: "empty" };
          return res.json(responsePayload);
        }
        if (price > MAX_TRANSACTION) price = MAX_TRANSACTION;

        let recebido = 0;
        let boost_m = 1.0;
        let currentWeek = getCurrentWeek();

        if (player.P_W !== currentWeek) { player.P = 0; player.P_W = currentWeek; }

        if (player.B_T > now) {
          boost_m = parseFloat(player.B_M) || 1.0;
          if (boost_m > 1.0) price = Math.round(price * boost_m);
        } else if (player.B_T > 0) {
          player.B_M = 1.0;
          player.B_T = 0;
        }

        const ptsMult = DREDGE_CONFIG.pointsPct || 0.10;

        if (plan !== "FREE" && plan !== "EVENT" && plan !== "TEST_CARGO") {
          if (boost_m > 1.0) await addPlayerMessage(user, `⚓ Dredge payout boosted by ${boost_m}X!`);
          await addPlayerMessage(user, `⚓ Sold ${Math.round(totalKg * 10) / 10} kg of dredged minerals for ${price} F₵.`);

          player.P += Math.round(price * ptsMult);
          if (player.AT !== "A") { player.AT = "A"; responsePayload.newBuyer = true; }

          let premiumBonus = 0;
          if (plan === "PREMIUM") {
            premiumBonus = Math.floor(price * 0.2);
            await addPlayerMessage(user, "You won 20% more for being PREMIUM.");
          }
          player.M += (price + premiumBonus);
          recebido = price + premiumBonus;
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } else if (plan === "TEST_CARGO") {
          if (player.TC_W !== currentWeek) { player.TC_V = 0; player.TC_W = currentWeek; }
          if (player.TC_V >= MAX_TC) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_TC} F₵ in your test plan this week.`);
          } else {
            let grant = (player.TC_V + price >= MAX_TC) ? (MAX_TC - player.TC_V) : price;
            player.TC_V += grant;
            player.M += grant;
            recebido = grant;
            await addPlayerMessage(user, `⚓ Sold dredged minerals for ${grant} F₵.`);
          }
          player.P += Math.round((recebido * 0.8) * ptsMult);
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } else if (plan === "EVENT") {
          if (player.EV_W !== currentWeek) { player.EV_V = 0; player.EV_W = currentWeek; }
          if (player.EV_V >= MAX_EV) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_EV} F₵ in your event plan this week.`);
          } else {
            let grant = (player.EV_V + price >= MAX_EV) ? (MAX_EV - player.EV_V) : price;
            player.EV_V += grant;
            player.M += grant;
            recebido = grant;
            await addPlayerMessage(user, `⚓ Sold dredged minerals for ${grant} F₵.`);
          }
          player.P += Math.round((recebido * 0.5) * ptsMult);
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } else if (plan === "FREE") {
          if (player.RE >= MAX_F) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_F} F₵ in your free plan.`);
          } else {
            let grant = (player.RE + price >= MAX_F) ? (MAX_F - player.RE) : price;
            player.RE += grant;
            player.M += grant;
            recebido = grant;
            await addPlayerMessage(user, `⚓ Sold dredged minerals for ${grant} F₵.`);
          }
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        }

        await savePlayerData(user, player);
        responsePayload.recebido = recebido;
      }
      else if (safeTopic === "cargo sell") {
        let price = parseInt(content) || 0;
        if (price > MAX_TRANSACTION) price = MAX_TRANSACTION;

        let demandMult = 1.0;
        let targetParcel = null;

        for (let i = 0; i < 8; i++) {
            if (player.ACTIVE_PARCEL && (now - player.PARCEL_TIME) < 1800) { 
                targetParcel = player.ACTIVE_PARCEL.toLowerCase(); 
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            player = await getPlayerData(user);
        }

        if (targetParcel && targetParcel.length >= 36) demandMult = await processParcelDemand(targetParcel, user);

        let savedParcelForAffinity = targetParcel; 
        player.ACTIVE_PARCEL = ""; player.PARCEL_TIME = 0;

        if (demandMult < 1.0 && plan !== "EVENT") {
            price = Math.round(price * demandMult);
            let lostPercent = Math.round((1.0 - demandMult) * 100);
            await addPlayerMessage(user, `📉 [DEMAND ALERT] This location is saturated! Payout reduced by ${lostPercent}% (${demandMult}x). Demand recovers +15% every 10 minutes without deliveries.`);
        }

        let recebido = 0; let boost_m = 1.0; let currentWeek = getCurrentWeek();

        if (player.P_W !== currentWeek) { player.P = 0; player.P_W = currentWeek; }

        if (player.B_T > now) {
          boost_m = parseFloat(player.B_M) || 1.0;
          if (boost_m > 1.0) price = Math.round(price * boost_m);
        } else if (player.B_T > 0) { player.B_M = 1.0; player.B_T = 0; }

        if (plan !== "FREE" && plan !== "EVENT" && plan !== "TEST_CARGO") {
          if (boost_m > 1.0) await addPlayerMessage(user, `Cargo value boosted by ${boost_m}X!`);
          await addPlayerMessage(user, `You won ${price} F₵.`);

          player.P += Math.round(price * 0.1);
          if (player.AT !== "A") { player.AT = "A"; responsePayload.newBuyer = true; }

          try {
            const buyersRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["GFN_BUYERS"]);
            let buyersList = [];
            if (buyersRes.rowCount > 0 && buyersRes.rows[0].value) buyersList = buyersRes.rows[0].value.split(",").filter(Boolean);
            if (!buyersList.includes(user)) {
              buyersList.push(user);
              await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, ["GFN_BUYERS", buyersList.join(",")]);
            }
          } catch (e) {}

          let premiumBonus = 0;
          if (plan === "PREMIUM") {
            if (price <= 0) price = 1;
            premiumBonus = Math.floor(price * 0.2); 
            await addPlayerMessage(user, "You won 20% more for being premium.");
          }
          player.M += (price + premiumBonus); recebido = price + premiumBonus;
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } 
        else if (plan === "TEST_CARGO") {
          if (player.TC_W !== currentWeek) { player.TC_V = 0; player.TC_W = currentWeek; }
          if (player.TC_V >= MAX_TC) await addPlayerMessage(user, `You have reached the limit of ${MAX_TC} F₵ in your test cargo plan this week.`);
          else {
            if (player.TC_V + price >= MAX_TC) {
              let resto = MAX_TC - player.TC_V;
              player.TC_V = MAX_TC; player.M += resto; recebido = resto;
              await addPlayerMessage(user, `You won ${resto} F₵.`);
            } else {
              player.TC_V += price; player.M += price; recebido = price;
              await addPlayerMessage(user, `You won ${price} F₵.`);
            }
          }
          player.P += Math.round((recebido * 0.8) * 0.1);
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } 
        else if (plan === "EVENT") {
          if (player.EV_W !== currentWeek) { player.EV_V = 0; player.EV_W = currentWeek; }
          if (player.EV_V >= MAX_EV) await addPlayerMessage(user, `You have reached the limit of ${MAX_EV} F₵ in your event plan this week.`);
          else {
            if (player.EV_V + price >= MAX_EV) {
              let resto = MAX_EV - player.EV_V;
              player.EV_V = MAX_EV; player.M += resto; recebido = resto;
              await addPlayerMessage(user, `You won ${resto} F₵.`);
            } else {
              player.EV_V += price; player.M += price; recebido = price;
              await addPlayerMessage(user, `You won ${price} F₵.`);
            }
          }
          player.P += Math.round((recebido * 0.5) * 0.1);
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } 
        else if (plan === "FREE") {
          if (player.RE >= MAX_F) await addPlayerMessage(user, `You have reached the limit of ${MAX_F} F₵ in your free plan.`);
          else {
            if (player.RE + price >= MAX_F) {
              let resto = MAX_F - player.RE;
              player.RE = MAX_F; player.M += resto; recebido = resto;
              await addPlayerMessage(user, `You won ${resto} F₵.`);
            } else {
              player.RE += price; player.M += price; recebido = price;
              await addPlayerMessage(user, `You won ${price} F₵.`);
            }
          }
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        }

        if (!player.AFFINITY) player.AFFINITY = {};
        if (!player.AFFINITY_TIME) player.AFFINITY_TIME = {};

        for (let hubUuid in player.AFFINITY) {
            let lastTime = player.AFFINITY_TIME[hubUuid] || 0;
            if (lastTime === 0) player.AFFINITY_TIME[hubUuid] = now;
            else if ((now - lastTime) > 604800) { delete player.AFFINITY[hubUuid]; delete player.AFFINITY_TIME[hubUuid]; }
        }

        if (savedParcelForAffinity && savedParcelForAffinity.length >= 36) {
            player.AFFINITY_TIME[savedParcelForAffinity] = now;
            let currentAffinity = parseFloat(player.AFFINITY[savedParcelForAffinity]) || 0.0;
            let distance = player.LAST_DIST || 0;
            let addedAffinity = 0;

            if (distance > 1000) {
                if (currentAffinity < 0.5) {
                    addedAffinity = 0.01;
                    currentAffinity = Math.min(0.5, currentAffinity + 0.01);
                    currentAffinity = Math.round(currentAffinity * 100) / 100;
                    player.AFFINITY[savedParcelForAffinity] = currentAffinity;
                    await addPlayerMessage(user, `Your affinity with this HUB has increased by +${addedAffinity}. You now have ${currentAffinity} total affinity with this HUB.`);
                }
            }

            if (currentAffinity > 0 && price > 0) {
                let affinityBonus = Math.round(price * currentAffinity);
                if (affinityBonus > 0) {
                    player.M += affinityBonus; recebido += affinityBonus;
                    await addPlayerMessage(user, `You received an extra payout of ${affinityBonus} F₵ due to the affinity bonus (${currentAffinity}x / ${(currentAffinity * 100).toFixed(0)}%) with this HUB.`);
                    await addPlayerMessage(user, `You have now ${player.M} F₵.`);
                }
            }
        }
        player.LAST_DIST = 0; 
        await savePlayerData(user, player);
        responsePayload.recebido = recebido;
      } 
      else if (safeTopic === "addboost") {
        let add_mult = parseFloat(content) || 1.0;
        let add_time = parseInt(target) || 0;
        let player = await getPlayerData(user);
        let now = getUnixTime();

        if (add_time > 31536000) add_time = 604800; 
        let current_time = player.B_T;
        if (current_time < now) current_time = now;
        
        current_time += add_time; 
        player.B_M = add_mult; player.B_T = current_time;
        await savePlayerData(user, player);
      }
      else if (safeTopic === "check") {
        let player = await getPlayerData(user);
        let currentWeek = getCurrentWeek();
        let weeklyPoints = (player.P_W === currentWeek) ? (player.P || 0) : 0;
        
        await addPlayerMessage(user, `You have ${player.M} F₵.`);
        await addPlayerMessage(user, `You have ${weeklyPoints} points this week.`);
        await addPlayerMessage(user, `You have ${player.COOKIE_STOCK} Taming Cookies in stock.`);
      }
      else if (safeTopic === "godcheck") {
        let tPlayer = await getPlayerData(target);
        await addPlayerMessage(user, `[ADMIN CHECK] Target secondlife:///app/agent/${target}/inspect Balance: ${tPlayer.M} F₵ | Cookies: ${tPlayer.COOKIE_STOCK}`);
      }
      else if (safeTopic === "m_reset") {
        let tPlayer = await getPlayerData(target);
        tPlayer.M = parseInt(content) || 0;
        await savePlayerData(target, tPlayer);
        await addPlayerMessage(user, `Money reset for secondlife:///app/agent/${target}/inspect. New balance: ${tPlayer.M} F₵`);
        await addPlayerMessage(target, `Your money balance was reset by an administrator.`);
      }
      else if (safeTopic === "p_reset") {
        let tPlayer = await getPlayerData(target);
        tPlayer.P = parseInt(content) || 0;
        await savePlayerData(target, tPlayer);
        await addPlayerMessage(user, `Points reset for secondlife:///app/agent/${target}/inspect. New points: ${tPlayer.P}`);
        await addPlayerMessage(target, `Your GFN points were reset by an administrator.`);
      }
      else if (safeTopic === "pay") {
        let amountVal = parseInt(content) || 0;
        if (amountVal <= 0) {
            await addPlayerMessage(user, "⚠️ Denied: You cannot transfer zero or negative amounts.");
            return res.json({ status: "denied" });
        }
        if (amountVal > MAX_TRANSACTION) amountVal = MAX_TRANSACTION;

        if (plan === "GOD") {
            let tPlayer = await getPlayerData(target);
            tPlayer.M += amountVal; 
            await savePlayerData(target, tPlayer);
            await addPlayerMessage(user, `[ADMIN PAY] You paid ${amountVal} F₵ to secondlife:///app/agent/${target}/inspect.`);
            await addPlayerMessage(target, `⚠️ An ADMIN has paid you ${amountVal} F₵. Your balance is now ${tPlayer.M} F₵.`);
        } else {
            let sender = await getPlayerData(user);
            if (sender.M < amountVal) {
                await addPlayerMessage(user, `⚠️ Denied: Insufficient balance. Your balance is ${sender.M} F₵.`);
                return res.json({ status: "denied" });
            }
            if (user === target) {
                await addPlayerMessage(user, "⚠️ Denied: You cannot transfer F₵ to yourself.");
                return res.json({ status: "denied" });
            }

            let tPlayer = await getPlayerData(target);
            sender.M -= amountVal; tPlayer.M += amountVal;
            await savePlayerData(user, sender); await savePlayerData(target, tPlayer);
            
            await addPlayerMessage(user, `You successfully paid ${amountVal} F₵ to secondlife:///app/agent/${target}/about. Your new balance: ${sender.M} F₵`);
            await addPlayerMessage(target, `You received ${amountVal} F₵ from secondlife:///app/agent/${user}/about. Your new balance: ${tPlayer.M} F₵`);
        }
      }
      else if (safeTopic === "mass_money_reset_custom") {
        const maxValue = parseInt(content) || 0;
        const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'player_%'");
        for (let row of q.rows) {
          try {
            let pData = JSON.parse(row.value);
            if (pData.M > maxValue) {
                pData.M = maxValue;
                await db.query("UPDATE kvstore SET value = $1 WHERE id = $2", [JSON.stringify(pData), row.id]);
                await addPlayerMessage(row.id.replace("player_", ""), plan);
            }
          } catch(e) {}
        }
        await addPlayerMessage(user, `SWEEP COMPLETED! Accounts limited to ${maxValue} F₵.`);
        responsePayload.status = "success";
      }
      else if (safeTopic === "mass_boost_reset") {
        const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'player_%'");
        for (let row of q.rows) {
          try {
            let pData = JSON.parse(row.value);
            if (pData.B_T > 0 || pData.B_M !== 1.0) {
                pData.B_T = 0; pData.B_M = 1.0;
                await db.query("UPDATE kvstore SET value = $1 WHERE id = $2", [JSON.stringify(pData), row.id]);
            }
          } catch(e) {}
        }
        await addPlayerMessage(user, "SWEEP COMPLETED! All player boosts and weeks have been reset.");
        responsePayload.status = "success";
      }
      else if (safeTopic === "buy") {
        let price = parseInt(content) || 0;
        if (price > MAX_TRANSACTION) { responsePayload.status = "denied"; return res.json(responsePayload); }
        let buyer = await getPlayerData(user);
        if (buyer.M < price) { responsePayload.status = "denied"; } 
        else {
          if (target === user) { responsePayload.status = "success"; } 
          else {
            buyer.M -= price; await savePlayerData(user, buyer);
            await addPlayerMessage(user, `You successfully bought ${plan} for ${price} F₵. Balance: ${buyer.M} F₵`);
            if (target) {
              let ownerData = await getPlayerData(target);
              ownerData.M += price; await savePlayerData(target, ownerData);
              await addPlayerMessage(target, `Your vending machine sold ${plan} for ${price} F₵. Balance: ${ownerData.M} F₵`);
            }
            responsePayload.status = "success";
          }
        }
      }
      else if (safeTopic === "refillpay") {
        let cost = parseInt(content) || 0;
        if (cost > MAX_TRANSACTION) { responsePayload.status = "denied"; return res.json(responsePayload); }
        let owner = await getPlayerData(user);
        if (owner.M < cost) { responsePayload.status = "denied"; } 
        else {
          owner.M -= cost; await savePlayerData(user, owner);
          await addPlayerMessage(user, `Refill paid: ${cost} F₵. Balance: ${owner.M} F₵`);
          responsePayload.status = "ok";
        }
      }
      res.json(responsePayload);
    } catch (err) { res.status(500).json({ error: "Internal calculation error" }); }
  });
});

app.get("/get-rank", async (req, res) => {
  try {
    const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'player_%'");
    let players = []; let currentWeek = getCurrentWeek();
    for (let row of q.rows) {
      try {
        let data = JSON.parse(row.value);
        if (data.P_W === currentWeek && data.P && data.P > 0) players.push({ uuid: row.id.replace("player_", ""), points: data.P });
      } catch(e) {}
    }
    players.sort((a, b) => b.points - a.points);
    res.json({ status: "success", top: players.slice(0, 5) });
  } catch (e) { res.status(500).json({ error: "db error" }); }
});

app.get("/get", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "missing id" });
  try {
    const q = await db.query("SELECT value FROM kvstore WHERE id=$1", [id]);
    let val = q.rowCount === 0 ? null : q.rows[0].value;
    
    if (val && id.startsWith("PARCEL_")) {
        try {
            let parcel = JSON.parse(val);
            let now = getUnixTime();
            if (parcel.last_delivery > 0 && parcel.mult < 1.0) {
                let timeOffline = now - parcel.last_delivery;
                let recovered = (timeOffline / 600.0) * 0.15;
                parcel.mult = Math.min(1.0, parcel.mult + recovered);
                parcel.mult = Math.round(parcel.mult * 10000) / 10000;
                val = JSON.stringify(parcel);
            }
        } catch(e){}
    }

    res.json({ id, value: val });
  } catch (e) { res.status(500).json({ error: "db error" }); }
});

app.post("/set", requireToken, async (req, res) => {
  let { id, value } = req.body; 
  if (!id) return res.status(400).json({ error: "missing id" });
  
  try {
    if (id === "gfn_admin_logs" && value) {
        let logs = value.split("|#|").filter(Boolean);
        let lastLog = logs[logs.length - 1] || "";
        
        let agentMatch = lastLog.match(/\/app\/agent\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        let parcelMatch = lastLog.match(/\/app\/parcel\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        
        if (agentMatch && parcelMatch) {
            let playerUuid = agentMatch[1].toLowerCase();
            let parcelUuid = parcelMatch[1].toLowerCase(); 
            
            if (lastLog.includes("Action: Cargo Delivered")) {
                let pData = await getPlayerData(playerUuid);
                pData.ACTIVE_PARCEL = parcelUuid;
                pData.PARCEL_TIME = getUnixTime();
                
                let distMatch = lastLog.match(/(?:dist(?:ancia|ance)?[:\s]*)([\d,\.]+)\s*m?/i) || lastLog.match(/([\d,\.]+)\s*m\b/i);
                let distance = 0;
                if (distMatch) distance = parseFloat(distMatch[1].replace(',', '.')) || 0;
                else {
                    let numMatch = lastLog.match(/(\d+)\s*(?:m|metros)/i);
                    if (numMatch) distance = parseFloat(numMatch[1]) || 0;
                }
                pData.LAST_DIST = distance;
                await savePlayerData(playerUuid, pData);
            } 
            else if (lastLog.toLowerCase().includes("cargo loaded") || lastLog.includes("Action: Cargo Loaded")) {
                let currentDemand = await getParcelDemandOnly(parcelUuid);
                if (currentDemand.mult < 1.0) {
                    let lostPercent = Math.round((1.0 - currentDemand.mult) * 100);
                    let warningLog = `[${getUnixTime()}] secondlife:///app/agent/${playerUuid}/inspect | ⚠️ [DEMAND WARNING] Destination has low demand: ${currentDemand.mult}x (-${lostPercent}% payout).`;
                    value = value + "|#|" + warningLog; 
                }
            }
        }
    }

    await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, [id, value]);
    if (id === "GLOBAL_SETTINGS") await loadGlobalSettings();
    if (id === "DREDGE_SETTINGS") parseDredgeSettingsString(value);
    if (id === "DREDGE_VERSION" && value) DREDGE_VERSION = value.trim();

    res.json({ status: "ok", id, value });
  } catch (e) { res.status(500).json({ error: "db error" }); }
});

app.get("/", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log("API running on port", PORT));
