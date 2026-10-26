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
const GROQ_API_KEY = process.env.GROQ_API_KEY || "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";

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
// MIGUS GLOBAL CACHE & AI KNOWLEDGE BASE
// ========================================================
let MIGU_CONFIG = { version: "1.0", duel_wager: 50, cookie_cost: 10, catch_chance: 0.55 };
let MIGU_LIST = []; 
let GFN_KB = []; 

// ========================================================
// GACHA SYSTEM LISTS (NEW)
// ========================================================
let GACHA_LISTS = {
  eyes: [], mouths: [], pattern: [], outline: [], color_up: [], color_down: []
};
const DEFAULT_TEXTURE = "5748decc-f629-461c-9a36-a35a221fe21f"; // TEXTURE_BLANK do SL

// ========================================================
// DREDGE BRUSH & UUID RETURN QUEUE CONSTANTS
// ========================================================
const DREDGE_RADIUS = 4.0; 
const DREDGE_RADIUS_SQ = DREDGE_RADIUS * DREDGE_RADIUS; 
const DREDGE_RESTORE_SECONDS = 86400; 
const DREDGE_RETURN_TTL = 300; 
const BRUSH_TICK_OPACITY = 0.03; 

const CELLS_PER_BRUSH = (() => {
  let count = 0;
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -4; dy <= 4; dy++) {
      if (dx * dx + dy * dy <= DREDGE_RADIUS_SQ) count++;
    }
  }
  return count;
})();

let DREDGE_VERSION = "1.0";
let DREDGE_CONFIG = {
  sandPrice: 0.5, gravelPrice: 1.0, clayPrice: 1.8, ironPrice: 3.5, copperPrice: 7.0,
  titaniumPrice: 14.0, silverPrice: 30.0, goldPrice: 75.0, platinumPrice: 150.0,
  diamondPrice: 400.0, weightMult: 1.0, maxCapacityKg: 5000.0, pointsPct: 0.10
};

let DREDGE_CELLS = new Map();
let DREDGE_RETURNS = new Map();
let DREDGE_LAST_POS = new Map();

// ========================================================
// OIL DRILLING & EXTRACTION SYSTEM CONSTANTS
// ========================================================
const OIL_ZONE_DIAMETER = 30.0; 
const OIL_LOCK_TIMEOUT = 18;    

let OIL_VERSION = "1.0";
let OIL_CONFIG = {
  oilPricePerLiter: 2.5,     
  minWellOil: 5000.0,         
  maxWellOil: 15000.0,        
  maxExtractPerTick: 250.0,   
  pointsPct: 0.10
};

let OIL_ZONES = new Map();
let OIL_TANK_LEDGER = new Map();
let OIL_SCAN_COOLDOWN = new Map();

// ========================================================
// CORE HELPERS & LOCKS
// ========================================================
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

// ========================================================
// GACHA HELPERS (NEW)
// ========================================================
function getLum(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Gera uma cor aleatória em formato LSL. contrastLum = -1 significa ignorar contraste.
function generateColor(contrastLum = -1) {
  let r, g, b, l;
  let attempts = 0;
  do {
    r = Math.random(); g = Math.random(); b = Math.random();
    l = getLum(r, g, b);
    attempts++;
    if (contrastLum === -1) break;
    // Se o fundo é escuro (< 0.5), gerar cor clara (> 0.6)
    if (contrastLum <= 0.5 && l > 0.6) break;
    // Se o fundo é claro (> 0.5), gerar cor escura (< 0.4)
    if (contrastLum > 0.5 && l < 0.4) break;
  } while (attempts < 50); // Fallback para não travar num loop infinito
  return { vec: `<${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}>`, lum: l };
}

async function initGacha() {
  if (!DATABASE_URL) return;
  try {
    for (const key of Object.keys(GACHA_LISTS)) {
      let res = await dbGet(`GACHA_${key.toUpperCase()}`);
      if (res) {
        try { GACHA_LISTS[key] = JSON.parse(res); } catch(e) { GACHA_LISTS[key] = []; }
      }
    }
  } catch (e) { console.error("Erro no Gacha Init:", e); }
}

// ========================================================
// DREDGE FUNCTIONS
// ========================================================
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

function pruneExpiredDredgeReturns() {
  const now = getUnixTime();
  for (const [msgId, pkg] of DREDGE_RETURNS.entries()) {
    if ((now - pkg.createdAt) >= DREDGE_RETURN_TTL) {
      DREDGE_RETURNS.delete(msgId);
    }
  }
  for (const [dUuid, posObj] of DREDGE_LAST_POS.entries()) {
    if ((now - posObj.t) >= 60) {
      DREDGE_LAST_POS.delete(dUuid);
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
      await dbSet("DREDGE_ZONES", serializeDredgeCells());
    } catch (e) {}
  }
}

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

function applyContinuousStrokeSegment(x1, y1, x2, y2, ticks, now) {
  let extracted = 0.0;
  const dist = Math.hypot(x2 - x1, y2 - y1);

  if (dist <= 0.75 || dist > 15.0 || isNaN(x1) || isNaN(y1)) {
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

// ========================================================
// OIL DRILLING FUNCTIONS
// ========================================================
function getOilGridKey(worldX, worldY) {
  const gx = Math.floor(worldX / OIL_ZONE_DIAMETER);
  const gy = Math.floor(worldY / OIL_ZONE_DIAMETER);
  return {
    key: `${gx}_${gy}`,
    centerX: (gx * OIL_ZONE_DIAMETER) + (OIL_ZONE_DIAMETER * 0.5),
    centerY: (gy * OIL_ZONE_DIAMETER) + (OIL_ZONE_DIAMETER * 0.5)
  };
}

function parseOilSettingsString(valStr) {
  if (!valStr) return;
  const parts = valStr.split("|");
  if (parts.length >= 5) {
    OIL_CONFIG.oilPricePerLiter = parseFloat(parts[0]) || 2.5;
    OIL_CONFIG.minWellOil = parseFloat(parts[1]) || 5000.0;
    OIL_CONFIG.maxWellOil = parseFloat(parts[2]) || 15000.0;
    OIL_CONFIG.maxExtractPerTick = parseFloat(parts[3]) || 250.0;
    OIL_CONFIG.pointsPct = parseFloat(parts[4]) || 0.10;
  }
}

function serializeOilZones() {
  const arr = [];
  for (const [key, val] of OIL_ZONES.entries()) {
    arr.push([
      key,
      val.hasWell ? 1 : 0,
      Math.round(val.oilLeft * 10) / 10,
      Math.round(val.maxOil * 10) / 10,
      Math.round(val.x * 10) / 10,
      Math.round(val.y * 10) / 10,
      val.week || getCurrentWeek()
    ]);
  }
  return JSON.stringify(arr);
}

function deserializeOilZones(rawStr) {
  OIL_ZONES.clear();
  if (!rawStr) return;
  try {
    const parsed = JSON.parse(rawStr);
    const curWeek = getCurrentWeek();
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (Array.isArray(item) && item.length >= 6) {
          const [key, hasWellInt, oilLeft, maxOil, x, y, wk] = item;
          if (!wk || wk === curWeek) {
            OIL_ZONES.set(String(key), {
              hasWell: Boolean(hasWellInt),
              oilLeft: Math.max(0, Number(oilLeft) || 0),
              maxOil: Math.max(0, Number(maxOil) || 0),
              x: Number(x) || 0,
              y: Number(y) || 0,
              activeRig: "",
              lastTick: 0,
              week: curWeek
            });
          }
        }
      }
    }
  } catch (e) {}
}

function serializeOilTanks() {
  const obj = {};
  const now = getUnixTime();
  for (const [k, v] of OIL_TANK_LEDGER.entries()) {
    if (v.oil > 0.05 && (now - v.updatedAt) < 604800) {
      obj[k] = v;
    }
  }
  return JSON.stringify(obj);
}

function deserializeOilTanks(rawStr) {
  OIL_TANK_LEDGER.clear();
  if (!rawStr) return;
  try {
    const obj = JSON.parse(rawStr);
    for (const k in obj) {
      if (obj[k] && typeof obj[k].oil === "number") {
        OIL_TANK_LEDGER.set(k, obj[k]);
      }
    }
  } catch (e) {}
}

async function initOilSystemOnBoot() {
  if (!DATABASE_URL) return;
  try {
    const oVer = await dbGet("OIL_VERSION");
    if (oVer) OIL_VERSION = oVer.trim();
    else await dbSet("OIL_VERSION", OIL_VERSION);

    const oSet = await dbGet("OIL_SETTINGS");
    if (oSet) parseOilSettingsString(oSet);
    else {
      const def = [OIL_CONFIG.oilPricePerLiter, OIL_CONFIG.minWellOil, OIL_CONFIG.maxWellOil, OIL_CONFIG.maxExtractPerTick, OIL_CONFIG.pointsPct].join("|");
      await dbSet("OIL_SETTINGS", def);
    }

    const oZones = await dbGet("OIL_ZONES");
    if (oZones) deserializeOilZones(oZones);

    const oTanks = await dbGet("OIL_TANKS");
    if (oTanks) deserializeOilTanks(oTanks);
  } catch (e) {}
}

async function resetWeeklyOilSeabed() {
  OIL_ZONES.clear();
  OIL_SCAN_COOLDOWN.clear();
  await dbSet("OIL_ZONES", "[]");
}

// ========================================================
// SHARED DB HELPERS & DEMAND LOGIC
// ========================================================
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

async function getParcelDemandOnly(parcelUuid) {
  let data = { mult: 1.0, last_delivery: 0, cap: 50 };
  try {
    let res = await dbGet(`PARCEL_${parcelUuid}`);
    if (res) {
      let parsed = JSON.parse(res);
      data.mult = parsed.mult !== undefined ? parsed.mult : 1.0;
      data.last_delivery = parsed.last_delivery || 0;

      let now = getUnixTime();
      if (data.last_delivery > 0 && data.mult < 1.0) {
          let timeOffline = now - data.last_delivery;
          let recovered = (timeOffline / 600.0) * 0.15;
          data.mult = Math.min(1.0, data.mult + recovered);
      }
    }
  } catch(e) {}
  return data;
}

async function processParcelDemand(parcelUuid, userUuid) {
  return await withLock(`LOCK_PARCEL_${parcelUuid}`, async () => {
    let now = getUnixTime();
    let currentData = await getParcelDemandOnly(parcelUuid);
    let finalMult = currentData.mult;
    
    currentData.mult = Math.max(0.1, currentData.mult - 0.25);
    currentData.last_delivery = now;
    
    await dbSet(`PARCEL_${parcelUuid}`, JSON.stringify(currentData));
    return Math.round(finalMult * 1000) / 1000;
  });
}

async function isValidGfnHub(parcelUuid) {
  if (!parcelUuid) return false;
  const cleanTarget = parcelUuid.toLowerCase().replace(/[^0-9a-f\-]/g, "");
  if (cleanTarget.length !== 36) return false;

  try {
    const serversRes = await dbGet("SERVERS");
    if (!serversRes) return false;
    const continents = serversRes.split("ç").filter(Boolean);

    for (const cont of continents) {
      const cRes = await dbGet(cont);
      if (cRes) {
        const hubs = cRes.split("ç").filter(Boolean);
        for (const h of hubs) {
          const hubUuid = h.split("#")[0].toLowerCase().replace(/[^0-9a-f\-]/g, "");
          if (hubUuid === cleanTarget) return true;
        }
      }
    }
  } catch (e) {}
  return false;
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

async function loadGlobalSettings() {
  try {
    const res = await dbGet("GLOBAL_SETTINGS");
    if (res) {
      const parts = res.split("|");
      if (parts[6] !== undefined && !isNaN(parseInt(parts[6]))) MAX_TC = parseInt(parts[6]);
      if (parts[7] !== undefined && !isNaN(parseInt(parts[7]))) MAX_EV = parseInt(parts[7]);
      if (parts[8] !== undefined && !isNaN(parseInt(parts[8]))) MAX_F = parseInt(parts[8]);
    }

    const mCfgRes = await dbGet("MIGU_CONFIG");
    if (mCfgRes) MIGU_CONFIG = { ...MIGU_CONFIG, ...JSON.parse(mCfgRes) };

    const mListRes = await dbGet("MIGU_LIST");
    if (mListRes) MIGU_LIST = JSON.parse(mListRes);

    const dVerRes = await dbGet("DREDGE_VERSION");
    if (dVerRes) DREDGE_VERSION = dVerRes.trim();
    else await dbSet("DREDGE_VERSION", DREDGE_VERSION);

    const dSetRes = await dbGet("DREDGE_SETTINGS");
    if (dSetRes) parseDredgeSettingsString(dSetRes);
    else {
      const defaultStr = [
        DREDGE_CONFIG.sandPrice, DREDGE_CONFIG.gravelPrice, DREDGE_CONFIG.clayPrice,
        DREDGE_CONFIG.ironPrice, DREDGE_CONFIG.copperPrice, DREDGE_CONFIG.titaniumPrice,
        DREDGE_CONFIG.silverPrice, DREDGE_CONFIG.goldPrice, DREDGE_CONFIG.platinumPrice,
        DREDGE_CONFIG.diamondPrice, DREDGE_CONFIG.weightMult, DREDGE_CONFIG.maxCapacityKg,
        DREDGE_CONFIG.pointsPct
      ].join("|");
      await dbSet("DREDGE_SETTINGS", defaultStr);
    }

    const dZonesRes = await dbGet("DREDGE_ZONES");
    if (dZonesRes) deserializeDredgeCells(dZonesRes);

    const kbRes = await dbGet("GFN_KNOWLEDGE_BASE");
    if (kbRes) {
      try { GFN_KB = JSON.parse(kbRes); } catch(e) { GFN_KB = []; }
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
  } catch (e) {}
}

setInterval(cleanupStaleAffinities, 24 * 60 * 60 * 1000);
setInterval(pruneExpiredDredgeZones, 15 * 60 * 1000);
setInterval(pruneExpiredDredgeReturns, 30 * 1000);

async function processHallOfFame(rankString) {
  if (!rankString || rankString.length <= 5 || rankString.includes("Waiting")) return;
  try {
    let hofRes = await dbGet("HALL_OF_FAME");
    let hofList = [];
    if (hofRes) { try { hofList = JSON.parse(hofRes); } catch(e){} }
    
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
    
    await dbSet("HALL_OF_FAME", JSON.stringify(hofList));
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
    await initOilSystemOnBoot();
    await initGacha(); // LOAD GACHA ON BOOT
    
    const lastRankRes = await dbGet("lastWeekTopFive");
    if (lastRankRes) {
       await processHallOfFame(lastRankRes);
    }
  } catch (e) {}
}
ensureTable();

setInterval(async () => {
  let currentNowWeek = getCurrentWeek();
  if (currentNowWeek !== activeServerWeek) {
    try {
      const oldRank = await dbGet("weeklyTopFive") || "";
      if (oldRank && oldRank.length > 5 && !oldRank.includes("Waiting")) {
        await dbSet("lastWeekTopFive", oldRank);
        await processHallOfFame(oldRank);
      }
      await dbSet("weeklyTopFive", "Waiting for new deliveries...");
      await resetWeeklyOilSeabed();
      activeServerWeek = currentNowWeek;
    } catch (e) {}
  }
}, 60000);

function requireToken(req, res, next) {
  const token = req.header("x-api-token");
  if (!token || token !== API_TOKEN) return res.status(401).json({ error: "invalid token" });
  next();
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
    const res = await dbGet(keyId);
    let messages = [];
    if (res) { try { messages = JSON.parse(res); } catch(e) {} }
    messages.push(msg);
    if (messages.length > 20) messages = messages.slice(-20);
    await dbSet(keyId, JSON.stringify(messages));
  } catch (e) {}
}

async function getPlayerData(uuid) {
  if (!uuid) return null;
  const res = await dbGet(`player_${uuid}`);
  let data = { 
    M: 0, P: 0, P_W: 0, TC_V: 0, TC_W: 0, EV_V: 0, EV_W: 0, RE: 0, 
    AT: "", B_M: 1.0, B_T: 0, ACTIVE_PARCEL: "", PARCEL_TIME: 0, LAST_DIST: 0, 
    AFFINITY: {}, AFFINITY_TIME: {}, MIGUS: [], ACTIVE_MIGU: "", COOKIE_STOCK: 0,
    P_IN: true, P_OUT: true 
  };
  
  if (res) {
    try { 
      let parsedData = JSON.parse(res);
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
      
      data.P_IN = parsedData.P_IN !== undefined ? parsedData.P_IN : true;
      data.P_OUT = parsedData.P_OUT !== undefined ? parsedData.P_OUT : true;

      if (parsedData.MIGUS) {
        data.MIGUS = parsedData.MIGUS.map(m => {
            if (typeof m === 'string') return { name: m, mClass: "Unknown", subClass: "Walker", rarity: "Common", power: 30, maxPower: 130, hp: 30, maxHp: 130 };
            if (!m.maxPower) m.maxPower = m.power + 100;
            if (!m.maxHp) m.maxHp = m.hp + 100;
            if (!m.rarity) m.rarity = "Common";
            return m;
        });
      } else { data.MIGUS = []; }

      let now = getUnixTime();
      let maxAllowedFuture = now + (5 * 365 * 24 * 60 * 60); 
      if (data.B_T > maxAllowedFuture) { data.B_T = 0; data.B_M = 1.0; }
    } catch(e) {}
  }
  return data;
}

async function savePlayerData(uuid, data) {
  await dbSet(`player_${uuid}`, JSON.stringify(data));
}

// ========================================================
// API ROUTES
// ========================================================

app.post("/admin/parcel", requireToken, async (req, res) => {
  const { action, serverId, uuid, pos, regionName, num, newPos } = req.body;
  if (!serverId) return res.status(400).json({ error: "Missing serverId" });

  await withLock(`SERVER_${serverId}`, async () => {
    try {
      let mainStr = await dbGet(serverId) || "";
      let mainList = mainStr ? mainStr.split("ç").filter(Boolean) : [];

      let namesList = [];
      for (let i = 1; i <= 5; i++) {
        let chunk = await dbGet(`${serverId}_NAMES_${i}`);
        if (chunk) {
            let parsedChunk = chunk.split("ç").filter(Boolean);
            namesList.push(...parsedChunk);
        }
      }

      while (namesList.length < mainList.length) namesList.push("Unknown Region");

      let findIndexByUuid = (u) => mainList.findIndex(item => item.toLowerCase().startsWith(u.toLowerCase() + "#"));
      let effRegion = (regionName || "Unknown").replace(/ç/g, "").replace(/#/g, "");
      let newItemStr = `${uuid}#${pos}#${effRegion}`;

      if (action === "SET_PARCEL" || action === "MOVE_HUB") {
        let idx = findIndexByUuid(uuid);
        if (idx !== -1) {
          mainList[idx] = newItemStr;
          namesList[idx] = effRegion;
        } else {
          mainList.push(newItemStr);
          namesList.push(effRegion);
        }
      }
      else if (action === "DEL_PARCEL") {
        let idx = findIndexByUuid(uuid);
        if (idx !== -1) {
          mainList.splice(idx, 1);
          namesList.splice(idx, 1);
        }
      }
      else if (action === "DEL_NUM") {
        let idx = parseInt(num); 
        if (!isNaN(idx) && idx >= 0 && idx < mainList.length) {
          mainList.splice(idx, 1);
          namesList.splice(idx, 1);
        }
      }
      else if (action === "REORDER") {
         let oldIdx = findIndexByUuid(uuid);
         let nPos = parseInt(newPos);
         if (oldIdx !== -1 && !isNaN(nPos) && nPos >= 0 && nPos <= mainList.length) {
            let mItem = mainList.splice(oldIdx, 1)[0];
            let nItem = namesList.splice(oldIdx, 1)[0];
            mainList.splice(nPos, 0, mItem);
            namesList.splice(nPos, 0, nItem);
         }
      }
      else if (action === "UPDATE_REGION") {
        let idx = findIndexByUuid(uuid);
        if (idx !== -1) {
            let oldParts = mainList[idx].split("#");
            let oldPos = oldParts.length > 1 ? oldParts[1] : "";
            mainList[idx] = `${uuid}#${oldPos}#${effRegion}`;
            namesList[idx] = effRegion;
        }
      }

      await saveServerChunks(serverId, mainList, namesList);
      res.json({ status: "success", action });

    } catch (e) {
      console.error("Erro no /admin/parcel:", e);
      res.status(500).json({ error: "Internal error" });
    }
  });
});

app.get("/get-msg", async (req, res) => {
  const uuid = req.query.uuid;
  if (!uuid) return res.status(400).json({ error: "missing uuid" });
  try {
    const q = await dbGet(`${uuid}_MSG`);
    res.json({ messages: q ? JSON.parse(q) : [] });
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

app.get('/dredge/check-zone', async (req, res) => {
  const { x, y, version } = req.query;
  if (version && version !== DREDGE_VERSION) return res.json({ status: "OUTDATED", serverVersion: DREDGE_VERSION });

  const worldX = parseFloat(x); const worldY = parseFloat(y);
  if (isNaN(worldX) || isNaN(worldY)) return res.status(400).json({ status: "ERROR", message: "Invalid world coordinates." });

  pruneExpiredDredgeReturns();
  const { depletedFraction, remainingSeconds } = inspectBrushArea(worldX, worldY);

  if (depletedFraction >= 0.995) return res.json({ status: "DEPLETED", depletedPct: 100, efficiency: 0.0, restoreText: formatDuration(remainingSeconds) });
  const depletedPct = Math.round(depletedFraction * 1000) / 10;
  const efficiency = Math.round((1.0 - depletedFraction) * 1000) / 1000;
  return res.json({ status: "OK", depletedPct, efficiency });
});

app.post('/dredge/sync-brush', requireToken, async (req, res) => {
  const { dredgeUuid, user, ackMsgId, strokes } = req.body;
  const effectiveUuid = String(dredgeUuid || user || "").trim();

  if (!effectiveUuid || !strokes || typeof strokes !== "string") return res.status(400).json({ status: "ERROR", message: "Missing dredgeUuid or strokes." });

  await withLock("DREDGE_ZONES_LOCK", async () => {
    const now = getUnixTime();
    pruneExpiredDredgeReturns();

    if (ackMsgId && DREDGE_RETURNS.has(String(ackMsgId))) DREDGE_RETURNS.delete(String(ackMsgId));

    const strokeList = strokes.split("|").filter(Boolean);
    let totalExtractedUnits = 0.0;
    let prevX = NaN; let prevY = NaN;
    if (DREDGE_LAST_POS.has(effectiveUuid)) {
      const lastPos = DREDGE_LAST_POS.get(effectiveUuid);
      if ((now - lastPos.t) <= 12) { prevX = lastPos.x; prevY = lastPos.y; }
    }

    let lastX = NaN; let lastY = NaN;
    for (const s of strokeList) {
      const parts = s.split(",");
      if (parts.length >= 3) {
        const sx = parseFloat(parts[0]); const sy = parseFloat(parts[1]); const rawVal = parseFloat(parts[2]) || 1;
        let ticks = (rawVal < 1.0 && rawVal > 0.0) ? Math.max(1, Math.round(rawVal / BRUSH_TICK_OPACITY)) : Math.min(40, Math.max(1, Math.round(rawVal)));
        if (!isNaN(sx) && !isNaN(sy)) {
          totalExtractedUnits += applyContinuousStrokeSegment(prevX, prevY, sx, sy, ticks, now);
          prevX = sx; prevY = sy; lastX = sx; lastY = sy;
        }
      }
    }

    if (!isNaN(lastX) && !isNaN(lastY)) DREDGE_LAST_POS.set(effectiveUuid, { x: lastX, y: lastY, t: now });

    let spotEfficiency = 1.0; let restoreText = "24h 0m";
    if (!isNaN(lastX) && !isNaN(lastY)) {
      const { depletedFraction, remainingSeconds } = inspectBrushArea(lastX, lastY);
      spotEfficiency = Math.round(Math.max(0.0, 1.0 - depletedFraction) * 1000) / 1000;
      restoreText = formatDuration(remainingSeconds);
    }

    const msgId = `${effectiveUuid.substring(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    let returnPkg;

    if (totalExtractedUnits <= 0.0001) {
      returnPkg = { msgId, dredgeUuid: effectiveUuid, status: "DEPLETED", spotEfficiency: 0.0, restoreText, addedKg: 0.0, weights: "0|0|0|0|0|0|0|0|0|0", createdAt: now };
    } else {
      await dbSet("DREDGE_ZONES", serializeDredgeCells());
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

      const addedKg = roundKg(sandKg + gravelKg + clayKg + ironKg + copperKg + titaniumKg + silverKg + goldKg + platinumKg + diamondKg);
      const weightsStr = [sandKg, gravelKg, clayKg, ironKg, copperKg, titaniumKg, silverKg, goldKg, platinumKg, diamondKg].join("|");

      returnPkg = { msgId, dredgeUuid: effectiveUuid, status: "OK", spotEfficiency, restoreText, addedKg, weights: weightsStr, createdAt: now };
    }

    for (const [oldId, oldPkg] of DREDGE_RETURNS.entries()) {
      if (oldPkg.dredgeUuid === effectiveUuid) DREDGE_RETURNS.delete(oldId);
    }
    DREDGE_RETURNS.set(msgId, returnPkg);

    const broadcastList = [returnPkg];
    for (const [id, pkg] of DREDGE_RETURNS.entries()) {
      if (id !== msgId && broadcastList.length < 3) broadcastList.push(pkg);
    }
    return res.json({ status: "QUEUED", returns: broadcastList });
  });
});

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
  DREDGE_CELLS.clear(); DREDGE_RETURNS.clear(); DREDGE_LAST_POS.clear();
  await dbSet("DREDGE_ZONES", "[]");
  res.json({ status: "ok", message: "All depleted dredge zones and pending return queues have been cleared." });
});

app.post("/oil/scan-zone", requireToken, async (req, res) => {
  const { rigUuid, user, x, y, hasWell, oilAmount, version } = req.body;
  if (version && String(version) !== OIL_VERSION) return res.json({ status: "OUTDATED", serverVersion: OIL_VERSION });

  const worldX = parseFloat(x); const worldY = parseFloat(y); const effRig = String(rigUuid || "").trim();
  if (!effRig || isNaN(worldX) || isNaN(worldY)) return res.status(400).json({ status: "ERROR", message: "Invalid coordinates or rigUuid" });

  await withLock("OIL_ZONES_LOCK", async () => {
    const now = getUnixTime(); const curWeek = getCurrentWeek();
    const { key, centerX, centerY } = getOilGridKey(worldX, worldY);

    if (OIL_ZONES.has(key)) {
      const existing = OIL_ZONES.get(key);
      if (existing.week === curWeek) {
        if (!existing.hasWell) return res.json({ status: "NO_WELL", alreadyMapped: true, zoneKey: key, wellX: existing.x, wellY: existing.y, oilLeft: 0 });
        if (existing.oilLeft <= 0.1) return res.json({ status: "DEPLETED", alreadyMapped: true, zoneKey: key, wellX: existing.x, wellY: existing.y, oilLeft: 0, maxOil: existing.maxOil });
        const isBusy = existing.activeRig && existing.activeRig !== effRig && (now - existing.lastTick) < OIL_LOCK_TIMEOUT;
        return res.json({ status: "HAS_WELL", alreadyMapped: true, zoneKey: key, wellX: existing.x, wellY: existing.y, oilLeft: existing.oilLeft, maxOil: existing.maxOil, busy: isBusy });
      }
    }

    const lastScan = OIL_SCAN_COOLDOWN.get(effRig) || 0;
    if ((Date.now() - lastScan) < 3800) return res.json({ status: "RATE_LIMIT" });
    OIL_SCAN_COOLDOWN.set(effRig, Date.now());

    let clientReportedWell = Boolean(hasWell === true || hasWell === 1 || hasWell === "1");
    let finalHasWell = clientReportedWell; let initialOil = 0.0;
    if (finalHasWell) {
      let rawOil = parseFloat(oilAmount) || OIL_CONFIG.minWellOil;
      initialOil = Math.min(OIL_CONFIG.maxWellOil, Math.max(OIL_CONFIG.minWellOil, Math.round(rawOil * 10) / 10));
    }
    const newZone = { hasWell: finalHasWell, oilLeft: initialOil, maxOil: initialOil, x: centerX, y: centerY, activeRig: "", lastTick: 0, week: curWeek };
    OIL_ZONES.set(key, newZone); await dbSet("OIL_ZONES", serializeOilZones());
    if (!finalHasWell) return res.json({ status: "NO_WELL", alreadyMapped: false, zoneKey: key, wellX: centerX, wellY: centerY, oilLeft: 0 });
    return res.json({ status: "HAS_WELL", alreadyMapped: false, zoneKey: key, wellX: centerX, wellY: centerY, oilLeft: initialOil, maxOil: initialOil, busy: false });
  });
});

app.post("/oil/lock-well", requireToken, async (req, res) => {
  const { rigUuid, x, y, version } = req.body;
  if (version && String(version) !== OIL_VERSION) return res.json({ status: "OUTDATED" });
  const worldX = parseFloat(x); const worldY = parseFloat(y); const effRig = String(rigUuid || "").trim();

  await withLock("OIL_ZONES_LOCK", async () => {
    const now = getUnixTime(); const { key } = getOilGridKey(worldX, worldY); const zone = OIL_ZONES.get(key);
    if (!zone || !zone.hasWell) return res.json({ status: "NO_WELL" });
    if (zone.oilLeft <= 0.1) return res.json({ status: "DEPLETED", oilLeft: 0 });
    if (zone.activeRig && zone.activeRig !== effRig && (now - zone.lastTick) < OIL_LOCK_TIMEOUT) return res.json({ status: "BUSY_OTHER_RIG" });
    zone.activeRig = effRig; zone.lastTick = now; OIL_ZONES.set(key, zone);
    return res.json({ status: "LOCKED", zoneKey: key, oilLeft: zone.oilLeft, maxOil: zone.maxOil });
  });
});

app.post("/oil/extract-tick", requireToken, async (req, res) => {
  const { rigUuid, tankUuid, tankOwner, x, y, requestedOil } = req.body;
  const effRig = String(rigUuid || "").trim(); const effTank = String(tankUuid || "").trim();
  const worldX = parseFloat(x); const worldY = parseFloat(y);
  if (!effRig || !effTank || isNaN(worldX) || isNaN(worldY)) return res.status(400).json({ status: "ERROR" });

  await withLock("OIL_ZONES_LOCK", async () => {
    const now = getUnixTime(); const { key } = getOilGridKey(worldX, worldY); const zone = OIL_ZONES.get(key);
    if (!zone || !zone.hasWell) return res.json({ status: "NO_WELL", extracted: 0, oilLeft: 0 });
    if (zone.activeRig && zone.activeRig !== effRig && (now - zone.lastTick) < OIL_LOCK_TIMEOUT) return res.json({ status: "BUSY_OTHER_RIG", extracted: 0, oilLeft: zone.oilLeft });
    if (zone.oilLeft <= 0.05) { zone.oilLeft = 0; zone.activeRig = ""; await dbSet("OIL_ZONES", serializeOilZones()); return res.json({ status: "DEPLETED", extracted: 0, oilLeft: 0 }); }
    let reqAmt = parseFloat(requestedOil) || 0; reqAmt = Math.min(OIL_CONFIG.maxExtractPerTick, Math.max(0, reqAmt));
    const actualExtracted = Math.round(Math.min(zone.oilLeft, reqAmt) * 10) / 10;
    zone.oilLeft = Math.round(Math.max(0, zone.oilLeft - actualExtracted) * 10) / 10;
    zone.activeRig = effRig; zone.lastTick = now; OIL_ZONES.set(key, zone);
    const tankEntry = OIL_TANK_LEDGER.get(effTank) || { oil: 0.0, owner: String(tankOwner || ""), updatedAt: now };
    tankEntry.oil = Math.round((tankEntry.oil + actualExtracted) * 10) / 10;
    if (tankOwner) tankEntry.owner = String(tankOwner); tankEntry.updatedAt = now; OIL_TANK_LEDGER.set(effTank, tankEntry);
    await dbSet("OIL_ZONES", serializeOilZones()); await dbSet("OIL_TANKS", serializeOilTanks());
    return res.json({ status: zone.oilLeft <= 0.05 ? "DEPLETED" : "OK", extracted: actualExtracted, oilLeft: zone.oilLeft, maxOil: zone.maxOil, tankVerifiedOil: tankEntry.oil });
  });
});

app.post("/oil/stop-extract", requireToken, async (req, res) => {
  const { rigUuid, x, y } = req.body; const effRig = String(rigUuid || "").trim(); const worldX = parseFloat(x); const worldY = parseFloat(y);
  await withLock("OIL_ZONES_LOCK", async () => {
    const { key } = getOilGridKey(worldX, worldY); const zone = OIL_ZONES.get(key);
    if (zone && zone.activeRig === effRig) { zone.activeRig = ""; zone.lastTick = 0; OIL_ZONES.set(key, zone); }
    return res.json({ status: "RELEASED" });
  });
});

app.get("/oil/pump-access", async (req, res) => {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ error: "missing uuid" });
    let pData = await getPlayerData(uuid);
    res.json({ status: "OK", in: pData.P_IN, out: pData.P_OUT });
});

app.post("/oil/pump-access", requireToken, async (req, res) => {
    const { uuid, action } = req.body;
    if (!uuid) return res.status(400).json({ error: "missing uuid" });
    
    await withLock(uuid, async () => {
        let pData = await getPlayerData(uuid);
        if (action === "ALLOW_IN") pData.P_IN = true;
        if (action === "DENY_IN") pData.P_IN = false;
        if (action === "ALLOW_OUT") pData.P_OUT = true;
        if (action === "DENY_OUT") pData.P_OUT = false;
        await savePlayerData(uuid, pData);
        res.json({ status: "OK", in: pData.P_IN, out: pData.P_OUT });
    });
});

app.post("/oil/fluid-transaction", requireToken, async (req, res) => {
  const { mode, tankUuid, tankOwner, targetOwner, amount, penaltyAmount, fluid, plan } = req.body;
  const effMode = String(mode || "SELL").toUpperCase().trim();
  const sOwner = String(tankOwner || "").trim();
  const tOwner = String(targetOwner || "").trim();
  const fType = String(fluid || "OIL").toUpperCase().trim();
  
  let reqLiters = Math.round((parseFloat(amount) || 0.0) * 10) / 10;
  let reqPenalty = Math.round((parseFloat(penaltyAmount) || 0.0) * 10) / 10;
  if (reqPenalty > reqLiters) reqPenalty = reqLiters; // Prevenção de bug matemático
  let normalLiters = Math.max(0, reqLiters - reqPenalty);

  if (reqLiters <= 0.05 || !sOwner || !tOwner) return res.json({ status: "ERROR" });

  const FLUID_PRICES = { "OIL": 1.0, "REGULAR": 2.5, "DIESEL": 2.6, "NATGAS": 1.5, "JETFUEL": 2.8, "AVGAS": 3.5, "PARAFFIN": 2.0 };
  let basePrice = FLUID_PRICES[fType] || 1.0;

  const lockKey = [sOwner, tOwner].sort().join("_");
  await withLock(lockKey, async () => {
     let tankPlayer = await getPlayerData(sOwner);
     let targetPlayer = await getPlayerData(tOwner);
     let now = getUnixTime();

     if (sOwner === tOwner) {
        return res.json({ status: "OK_SAME_OWNER", amount: reqLiters, paidFc: 0 });
     }

     if (effMode === "BUY") {
        if (!targetPlayer.P_OUT && sOwner !== tOwner) return res.json({ status: "BLOCKED_BY_TARGET" });

        let unitPrice = basePrice * 0.7; 
        let fullCost = Math.ceil(reqLiters * unitPrice);

        tankPlayer.M -= fullCost; 
        targetPlayer.M += fullCost;

        await savePlayerData(sOwner, tankPlayer);
        await savePlayerData(tOwner, targetPlayer);

        let msgTank = `✅ ⛽ You BOUGHT ${reqLiters} L of ${fType} for ${fullCost} F₵. Balance: ${tankPlayer.M} F₵`;
        let msgTarget = `✅ ⛽ You SOLD ${reqLiters} L of ${fType} for ${fullCost} F₵. Balance: ${targetPlayer.M} F₵`;

        await addPlayerMessage(sOwner, msgTank);
        await addPlayerMessage(tOwner, msgTarget);

        return res.json({ status: "OK_BOUGHT", amount: reqLiters, paidFc: fullCost });
     }
     else if (effMode === "SELL") {
        if (!targetPlayer.P_IN && sOwner !== tOwner) return res.json({ status: "BLOCKED_BY_TARGET" });

        let unitPrice = basePrice * 1.0; 
        let penaltyUnitPrice = basePrice * 0.85; 
        
        let fullCost = Math.ceil((normalLiters * unitPrice) + (reqPenalty * penaltyUnitPrice));

        let boost_m = 1.0;
        if (tankPlayer.B_T > now) {
            boost_m = parseFloat(tankPlayer.B_M) || 1.0;
            if (boost_m > 1.0) fullCost = Math.ceil(fullCost * boost_m);
        }

        let affinityBonus = 0;
        if (tankPlayer.ACTIVE_PARCEL && tankPlayer.AFFINITY) {
           let parcel = tankPlayer.ACTIVE_PARCEL.toLowerCase();
           let currentAffinity = parseFloat(tankPlayer.AFFINITY[parcel]) || 0.0;
           if (currentAffinity > 0) affinityBonus = Math.round(fullCost * currentAffinity);
        }

        if (plan === "PREMIUM") fullCost += Math.floor(fullCost * 0.2);

        targetPlayer.M -= fullCost;
        tankPlayer.M += (fullCost + affinityBonus);
        tankPlayer.P += Math.round((fullCost + affinityBonus) * 0.10);

        await savePlayerData(sOwner, tankPlayer);
        await savePlayerData(tOwner, targetPlayer);

        let msgSeller = `✅ ⛽ Sold ${reqLiters} L of ${fType} to secondlife:///app/agent/${tOwner}/inspect for ${fullCost} F₵. Balance: ${tankPlayer.M} F₵`;
        let msgBuyer = `✅ ⛽ Purchased ${reqLiters} L of ${fType} from secondlife:///app/agent/${sOwner}/inspect for ${fullCost} F₵. Balance: ${targetPlayer.M} F₵`;

        await addPlayerMessage(sOwner, msgSeller);
        await addPlayerMessage(tOwner, msgBuyer);

        return res.json({ status: "OK_SOLD", amount: reqLiters, paidFc: fullCost });
     }
  });
});

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
          DREDGE_CONFIG.sandPrice, DREDGE_CONFIG.gravelPrice, DREDGE_CONFIG.clayPrice,
          DREDGE_CONFIG.ironPrice, DREDGE_CONFIG.copperPrice, DREDGE_CONFIG.titaniumPrice,
          DREDGE_CONFIG.silverPrice, DREDGE_CONFIG.goldPrice, DREDGE_CONFIG.platinumPrice,
          DREDGE_CONFIG.diamondPrice
        ];

        let rawTotal = 0; let totalKg = 0;
        for (let i = 0; i < 10; i++) {
          rawTotal += wParts[i] * prices[i];
          totalKg += wParts[i];
        }

        let price = Math.round(rawTotal);
        if (price <= 0) return res.json({ status: "empty" });
        if (price > MAX_TRANSACTION) price = MAX_TRANSACTION;

        let demandMult = 1.0; let targetParcel = null;
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
            await addPlayerMessage(user, `📉 [DEMAND ALERT] This location is saturated! Payout reduced by ${lostPercent}% (${demandMult}x). Demand recovers +15% every 10 minutes sem deliveries.`);
        }

        let recebido = 0; let boost_m = 1.0; let currentWeek = getCurrentWeek();

        if (player.P_W !== currentWeek) { player.P = 0; player.P_W = currentWeek; }

        if (player.B_T > now) {
          boost_m = parseFloat(player.B_M) || 1.0;
          if (boost_m > 1.0) price = Math.round(price * boost_m);
        } else if (player.B_T > 0) {
          player.B_M = 1.0; player.B_T = 0;
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
          player.M += (price + premiumBonus); recebido = price + premiumBonus;
        } else if (plan === "TEST_CARGO") {
          if (player.TC_W !== currentWeek) { player.TC_V = 0; player.TC_W = currentWeek; }
          if (player.TC_V >= MAX_TC) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_TC} F₵ in your test plan this week.`);
          } else {
            let grant = (player.TC_V + price >= MAX_TC) ? (MAX_TC - player.TC_V) : price;
            player.TC_V += grant; player.M += grant; recebido = grant;
            await addPlayerMessage(user, `⚓ Sold dredged minerals for ${grant} F₵.`);
          }
          player.P += Math.round((recebido * 0.8) * ptsMult);
        } else if (plan === "EVENT") {
          if (player.EV_W !== currentWeek) { player.EV_V = 0; player.EV_W = currentWeek; }
          if (player.EV_V >= MAX_EV) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_EV} F₵ in your event plan this week.`);
          } else {
            let grant = (player.EV_V + price >= MAX_EV) ? (MAX_EV - player.EV_V) : price;
            player.EV_V += grant; player.M += grant; recebido = grant;
            await addPlayerMessage(user, `⚓ Sold dredged minerals for ${grant} F₵.`);
          }
          player.P += Math.round((recebido * 0.5) * ptsMult);
        } else if (plan === "FREE") {
          if (player.RE >= MAX_F) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_F} F₵ in your free plan.`);
          } else {
            let grant = (player.RE + price >= MAX_F) ? (MAX_F - player.RE) : price;
            player.RE += grant; player.M += grant; recebido = grant;
            await addPlayerMessage(user, `⚓ Sold dredged minerals for ${grant} F₵.`);
          }
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
                }
            }
        }
        
        await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        player.LAST_DIST = 0; 
        await savePlayerData(user, player);
        responsePayload.recebido = recebido;
        responsePayload.msg = `⚓ Sold Dredge for ${recebido} F₵. Balance: ${player.M} F₵`;
      } 
      
      else if (safeTopic === "cargo sell") {
        let price = parseInt(content) || 0;
        if (price > MAX_TRANSACTION) price = MAX_TRANSACTION;

        let demandMult = 1.0; let targetParcel = null;

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
            const buyersRes = await dbGet("GFN_BUYERS");
            let buyersList = [];
            if (buyersRes) buyersList = buyersRes.split(",").filter(Boolean);
            if (!buyersList.includes(user)) {
              buyersList.push(user);
              await dbSet("GFN_BUYERS", buyersList.join(","));
            }
          } catch (e) {}

          let premiumBonus = 0;
          if (plan === "PREMIUM") {
            if (price <= 0) price = 1;
            premiumBonus = Math.floor(price * 0.2); 
            await addPlayerMessage(user, "You won 20% more for being premium.");
          }
          player.M += (price + premiumBonus); recebido = price + premiumBonus;
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
                }
            }
        }
        
        await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        player.LAST_DIST = 0; 
        await savePlayerData(user, player);
        responsePayload.recebido = recebido;
        responsePayload.msg = `Sold cargo for ${recebido} F₵. Balance: ${player.M} F₵`;
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
    if (id === "OIL_SETTINGS") parseOilSettingsString(value);
    if (id === "OIL_VERSION" && value) OIL_VERSION = value.trim();

    res.json({ status: "ok", id, value });
  } catch (e) { res.status(500).json({ error: "db error" }); }
});

app.get("/ai/kb", async (req, res) => {
  res.json({ status: "OK", kb: GFN_KB });
});

app.post("/ai/kb/add", requireToken, async (req, res) => {
  const { q, a } = req.body;
  if (!q || !a) return res.status(400).json({ error: "missing q or a" });
  
  const newId = Date.now().toString().slice(-6);
  GFN_KB.push({ id: newId, q, a });
  
  await dbSet("GFN_KNOWLEDGE_BASE", JSON.stringify(GFN_KB));
  res.json({ status: "success", id: newId });
});

app.post("/ai/kb/delete", requireToken, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "missing id" });
  
  const originalLength = GFN_KB.length;
  GFN_KB = GFN_KB.filter(item => item.id !== String(id));
  
  if (GFN_KB.length < originalLength) {
    await dbSet("GFN_KNOWLEDGE_BASE", JSON.stringify(GFN_KB));
    res.json({ status: "success" });
  } else {
    res.json({ status: "not_found" });
  }
});

app.post("/ai/chat", requireToken, async (req, res) => {
  const { user, message } = req.body;
  if (!user || !message) {
    return res.status(400).json({ error: "missing user or message" });
  }

  try {
    let playerData = await getPlayerData(user);
    let currentWeek = getCurrentWeek();
    let weeklyPoints = (playerData.P_W === currentWeek) ? (playerData.P || 0) : 0;

    let kbContext = "";
    if (GFN_KB && GFN_KB.length > 0) {
      kbContext = "Here is the official GFN Product Knowledge Base. Use this exact information if the user asks something related, but rephrase it naturally in your persona style (do not sound like a robot reading a manual):\n";
      GFN_KB.forEach(item => {
        kbContext += `Q: ${item.q} | A: ${item.a}\n`;
      });
    }

    const systemPrompt = `You are Bara, a Capybara who is a Sea Captain, and the official AI mascot and assistant for Grid Freight Net (GFN) in Second Life. 
    The user speaking to you has a balance of ${playerData.M || 0} F₵, ${weeklyPoints} weekly points, and ${playerData.COOKIE_STOCK || 0} Taming Cookies. 
    ${kbContext}
    IMPORTANT RULES:
    1. ALWAYS reply in the exact language the user used to talk to you. Translate any knowledge base answers to their language.
    2. Always embody your persona (Capybara Captain Bara). You can be slightly playful or use nautical/capybara references, but prioritize helping the user.
    3. Be extremely concise (maximum 2 to 3 short sentences so it fits cleanly in Second Life chat). Never write long paragraphs.`;

    const aiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: String(message) }
        ],
        max_tokens: 180,
        temperature: 0.7
      })
    });

    const aiData = await aiResponse.json();
    
    if (!aiResponse.ok) {
      return res.status(500).json({ error: "Groq API error", details: aiData });
    }

    const reply = aiData.choices?.[0]?.message?.content || "Sem resposta da IA.";
    res.json({ status: "success", reply });
  } catch (err) {
    console.error("[AI CHAT] Erro fatal:", err);
    res.status(500).json({ error: "Internal server error during AI processing", details: err.message });
  }
});


// ========================================================
// GACHA ENDPOINTS (NEW)
// ========================================================

// ADMIN: Adicionar textura nas listas do gacha
app.post("/gacha/add-texture", requireToken, async (req, res) => {
  const { part, uuid } = req.body;
  if (!part || !uuid) return res.status(400).json({ error: "missing part or uuid" });
  
  const validParts = Object.keys(GACHA_LISTS);
  if (!validParts.includes(part)) return res.status(400).json({ error: "invalid part name" });

  await withLock("GACHA_LIST_LOCK", async () => {
    if (!GACHA_LISTS[part].includes(uuid)) {
      GACHA_LISTS[part].push(uuid);
      await dbSet(`GACHA_${part.toUpperCase()}`, JSON.stringify(GACHA_LISTS[part]));
    }
    res.json({ status: "success", message: `Texture added to ${part}` });
  });
});

// GACHA: Gerar build aleatória na primeira vez que for rezzado
app.post("/gacha/build", requireToken, async (req, res) => {
  const { object_uuid } = req.body;
  if (!object_uuid) return res.status(400).json({ error: "missing object_uuid" });

  // Proteção do lado do server contra requests duplos
  const hasBuilt = await dbGet(`GACHA_BUILT_${object_uuid}`);
  if (hasBuilt) {
    return res.json({ status: "already_built" });
  }

  // Pegar uma textura aleatória da lista (ou textura em branco se lista vazia)
  const getTex = (part) => {
    const list = GACHA_LISTS[part];
    if (!list || list.length === 0) return DEFAULT_TEXTURE;
    return list[Math.floor(Math.random() * list.length)];
  };

  // 1. Gerar cor de base (sem restrição de contraste)
  const baseColor = generateColor(-1);
  
  // 2. Gerar color_up e color_down (sem restrição, podem ser qualquer cor)
  const colUp = generateColor(-1);
  const colDown = generateColor(-1);

  // 3. Olhos dependem do color_up, Boca depende do color_down
  const eyesColor = generateColor(colUp.lum);
  const mouthColor = generateColor(colDown.lum);

  // 4. Pattern e Outline precisam contrastar com ambos. Tiramos a média de luminância.
  const avgLum = (colUp.lum + colDown.lum) / 2.0;
  const patternColor = generateColor(avgLum);
  const outlineColor = generateColor(avgLum);

  const config = {
    // 0 = Pattern
    tex_0: getTex("pattern"), col_0: patternColor.vec,
    // 1 = Base (Sem textura via render)
    tex_1: "NULL", col_1: baseColor.vec,
    // 2 = Color Down
    tex_2: getTex("color_down"), col_2: colDown.vec,
    // 3 = Color Up
    tex_3: getTex("color_up"), col_3: colUp.vec,
    // 4 = Eyes
    tex_4: getTex("eyes"), col_4: eyesColor.vec,
    // 5 = Mouth
    tex_5: getTex("mouths"), col_5: mouthColor.vec,
    // 6 = Outline
    tex_6: getTex("outline"), col_6: outlineColor.vec
  };

  // Salvar no banco que este uuid já foi gerado
  await dbSet(`GACHA_BUILT_${object_uuid}`, "1");
  
  res.json({ status: "success", config });
});

app.get("/", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log("API running on port", PORT));
