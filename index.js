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

const getUnixTime = () => Math.floor(Date.now() / 1000);
const getCurrentWeek = () => Math.floor((getUnixTime() + 345600) / 604800);
let activeServerWeek = getCurrentWeek();

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
  let data = { M: 0, P: 0, P_W: 0, TC_V: 0, TC_W: 0, EV_V: 0, EV_W: 0, RE: 0, AT: "", B_M: 1.0, B_T: 0, ACTIVE_PARCEL: "", PARCEL_TIME: 0, LAST_DIST: 0, AFFINITY: {}, AFFINITY_TIME: {}, MIGUS: [], ACTIVE_MIGU: "" };
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

      // MIGUS CONVERSION & STRUCTURE UPGRADE
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
                        await addPlayerMessage(pUuid, `⚠️ The Migu [${name}] was permanently deleted from the system. You received ${compensation} F₵ as compensation for losing ${count} Migus.`);
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
  
  if (player.M >= MIGU_CONFIG.cookie_cost) {
      return res.json({ status: "OK", balance: player.M });
  } else {
      return res.json({ status: "INSUFFICIENT", balance: player.M });
  }
});

app.get('/migu/inventory', async (req, res) => {
  const { uuid } = req.query;
  let player = await getPlayerData(uuid);
  res.json({ status: "OK", migus: player.MIGUS || [] });
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

      // Check Inventory Limit (Max 20)
      if (player.MIGUS.length >= 20) {
          return res.send(`Failed: Your Migu inventory is full (Max 20). Abandon a Migu to catch more!`);
      }

      if (player.M < MIGU_CONFIG.cookie_cost) {
          return res.send(`Failed: You need ${MIGU_CONFIG.cookie_cost} F₵ to throw a Cookie. Do some GFN deliveries!`);
      }
      
      player.M -= MIGU_CONFIG.cookie_cost;

      let envClass = "Walker";
      if (parseFloat(z) > 100) envClass = "Flyer";
      else if (parseFloat(water) > parseFloat(ground)) envClass = "Swimmer";

      let availableMigus = MIGU_LIST.filter(m => m.subClass.toLowerCase() === envClass.toLowerCase());
      
      if (availableMigus.length === 0) {
          await savePlayerData(uuid, player);
          return res.send(`The Cookie broke! Sadly, no Migus of type [${envClass}] are registered here. (-${MIGU_CONFIG.cookie_cost} F₵)`);
      }

      if (Math.random() <= MIGU_CONFIG.catch_chance) {
          const selected = availableMigus[Math.floor(Math.random() * availableMigus.length)];
          
          // RARITY & STATS ROLL (10 to 50 initial)
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
          return res.send(`SUCCESS! You caught a [${selected.name}] (${rarity})! [P: ${initPower} | HP: ${initHp}] (-${MIGU_CONFIG.cookie_cost} F₵) | Slots: ${player.MIGUS.length}/20`);
      } else {
          await savePlayerData(uuid, player);
          return res.send(`The Migu broke the Cookie and fled! (-${MIGU_CONFIG.cookie_cost} F₵) | Balance: ${player.M} F₵`);
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
          
          // Winner: +10 power, +10 hp (Capped at max)
          p1Migu.power = Math.min(p1Migu.maxPower, p1Migu.power + 10);
          p1Migu.hp = Math.min(p1Migu.maxHp, p1Migu.hp + 10);
          // Loser: +5 power, +5 hp (Capped at max)
          p2Migu.power = Math.min(p2Migu.maxPower, p2Migu.power + 5);
          p2Migu.hp = Math.min(p2Migu.maxHp, p2Migu.hp + 5);

          await savePlayerData(p1, player1);
          await savePlayerData(p2, player2);
          return res.send(`⚔️ CHALLENGER WINS!\n[${p1Migu.name}] (+10 P/HP) defeated [${p2Migu.name}] (+5 P/HP).\nWon ${MIGU_CONFIG.duel_wager} F₵!`);
      } else {
          player2.M += MIGU_CONFIG.duel_wager;
          player1.M -= MIGU_CONFIG.duel_wager;
          
          // Winner: +10 power, +10 hp
          p2Migu.power = Math.min(p2Migu.maxPower, p2Migu.power + 10);
          p2Migu.hp = Math.min(p2Migu.maxHp, p2Migu.hp + 10);
          // Loser: +5 power, +5 hp
          p1Migu.power = Math.min(p1Migu.maxPower, p1Migu.power + 5);
          p1Migu.hp = Math.min(p1Migu.maxHp, p1Migu.hp + 5);

          await savePlayerData(p1, player1);
          await savePlayerData(p2, player2);
          return res.send(`⚔️ DEFENDER WINS!\n[${p2Migu.name}] (+10 P/HP) destroyed [${p1Migu.name}] (+5 P/HP).\nChallenger lost ${MIGU_CONFIG.duel_wager} F₵!`);
      }
  });
});
// ========================================================
// END MIGUS ROUTES
// ========================================================


// YOUR EXISTING ROUTES (UNCHANGED)
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

        let updatedCount = 0;
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
                    updatedCount++;
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

      if (safeTopic === "cargo sell") {
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
        await addPlayerMessage(user, `You have ${player.M} F₵.`);
        await addPlayerMessage(user, `You have ${player.P} GFN points this week.`);
      }
      else if (safeTopic === "godcheck") {
        let tPlayer = await getPlayerData(target);
        await addPlayerMessage(user, `[ADMIN CHECK] Target secondlife:///app/agent/${target}/inspect Balance: ${tPlayer.M} F₵ | Points: ${tPlayer.P}`);
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

    res.json({ status: "ok", id, value });
  } catch (e) { res.status(500).json({ error: "db error" }); }
});

app.get("/", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log("API running on port", PORT));
