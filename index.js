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
// --- SISTEMA DE SEGURANÇA BANCÁRIA (MUTEX & DEBOUNCE) ---
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
// ========================================================

async function loadGlobalSettings() {
  try {
    const res = await db.query("SELECT value FROM kvstore WHERE id=$1", ["GLOBAL_SETTINGS"]);
    if (res.rowCount > 0 && res.rows[0].value) {
      const parts = res.rows[0].value.split("|");
      if (parts[6] !== undefined && !isNaN(parseInt(parts[6]))) MAX_TC = parseInt(parts[6]);
      if (parts[7] !== undefined && !isNaN(parseInt(parts[7]))) MAX_EV = parseInt(parts[7]);
      if (parts[8] !== undefined && !isNaN(parseInt(parts[8]))) MAX_F = parseInt(parts[8]);
    }
  } catch (e) {
    console.error("Error loading settings:", e);
  }
}

async function clearAllMessageQueues() {
  if (!DATABASE_URL) return;
  try {
    const res = await db.query("DELETE FROM kvstore WHERE id LIKE '%_MSG'");
    console.log(`🧹 Limpeza de Boot: ${res.rowCount} filas de mensagens antigas foram apagadas com sucesso!`);
  } catch (e) {
    console.error("Error clearing message queues on reboot:", e);
  }
}

async function ensureTable() {
  if (!DATABASE_URL) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS kvstore (
        id TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    console.log("kvstore table ready");
    await loadGlobalSettings(); 
    await clearAllMessageQueues();
  } catch (e) {
    console.error("Error ensuring kvstore table:", e);
  }
}
ensureTable();

const getUnixTime = () => Math.floor(Date.now() / 1000);
const getCurrentWeek = () => Math.floor((getUnixTime() + 345600) / 604800);

let activeServerWeek = getCurrentWeek();

setInterval(async () => {
  let currentNowWeek = getCurrentWeek();
  if (currentNowWeek !== activeServerWeek) {
    try {
      console.log("Week Rollover Detected! Archiving Last Week and processing Global Hall of Fame...");
      const oldRankRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["weeklyTopFive"]);
      let oldRank = oldRankRes.rowCount > 0 ? oldRankRes.rows[0].value : "";

      if (oldRank && oldRank.length > 5 && !oldRank.includes("Waiting")) {
        await db.query(
          `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, 
          ["lastWeekTopFive", oldRank]
        );

        let hofRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["HALL_OF_FAME"]);
        let hofList = [];
        if (hofRes.rowCount > 0 && hofRes.rows[0].value) {
           try { hofList = JSON.parse(hofRes.rows[0].value); } catch(e){}
        }

        const lines = oldRank.split('\n');
        lines.forEach(line => {
           let match = line.match(/(?:[\d]+[°\.]\s*:?\s*)?(.+?)\s*(?:\(([\d,\.]+)\)|-\s*([\d,\.]+))/);
           if (match) {
             let playerName = match[1].trim();
             let scoreStr = match[2] || match[3];
             let weeklyScore = parseInt(scoreStr.replace(/\D/g, ''));
             if (!isNaN(weeklyScore)) {
               let existing = hofList.find(p => p.name === playerName);
               if (existing) {
                 if (weeklyScore > existing.score) existing.score = weeklyScore;
               } else {
                 hofList.push({ name: playerName, score: weeklyScore });
               }
             }
           }
        });

        hofList.sort((a, b) => b.score - a.score);
        hofList = hofList.slice(0, 3);
        await db.query(
          `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, 
          ["HALL_OF_FAME", JSON.stringify(hofList)]
        );
      }

      await db.query(
        `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, 
        ["weeklyTopFive", "Waiting for new deliveries..."]
      );

      activeServerWeek = currentNowWeek;
      console.log("Rollover complete!");
    } catch (e) {
      console.error("Error during week rollover:", e);
    }
  }
}, 60000);

function requireToken(req, res, next) {
  const token = req.header("x-api-token");
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ error: "invalid token" });
  }
  next();
}

async function dbGet(id) {
  try {
    const res = await db.query("SELECT value FROM kvstore WHERE id=$1", [id]);
    return res.rowCount > 0 ? res.rows[0].value : null;
  } catch (e) {
    console.error("dbGet error:", e);
    return null;
  }
}

async function dbSet(id, value) {
  try {
    await db.query(
      `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
      [id, value]
    );
  } catch (e) {
    console.error("dbSet error:", e);
  }
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
    if (res.rowCount > 0 && res.rows[0].value) {
      try { messages = JSON.parse(res.rows[0].value); } catch(e) {}
    }
    messages.push(msg);
    if (messages.length > 20) {
        messages = messages.slice(-20);
    }
    await db.query(
      `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
      [keyId, JSON.stringify(messages)]
    );
  } catch (e) {
    console.error("Error adding message:", e);
  }
}

app.get("/get-msg", async (req, res) => {
  const uuid = req.query.uuid;
  if (!uuid) return res.status(400).json({ error: "missing uuid" });
  const keyId = `${uuid}_MSG`;
  try {
    const q = await db.query("SELECT value FROM kvstore WHERE id=$1", [keyId]);
    const messages = (q.rowCount > 0 && q.rows[0].value) ? JSON.parse(q.rows[0].value) : [];
    res.json({ messages });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/ack-msg", async (req, res) => {
  const { uuid } = req.body;
  if (!uuid) return res.status(400).json({ error: "missing uuid" });
  const keyId = `${uuid}_MSG`;
  try {
    await db.query("DELETE FROM kvstore WHERE id=$1", [keyId]);
    res.json({ status: "cleared" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

async function getPlayerData(uuid) {
  if (!uuid) return null;
  const res = await db.query("SELECT value FROM kvstore WHERE id=$1", [`player_${uuid}`]);
  let data = { M: 0, P: 0, P_W: 0, TC_V: 0, TC_W: 0, EV_V: 0, EV_W: 0, RE: 0, AT: "", B_M: 1.0, B_T: 0 };
  
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
    } catch(e) {
      console.error(`Error parsing player data for ${uuid}:`, e);
    }
  }
  return data;
}

async function savePlayerData(uuid, data) {
  await db.query(
    `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
    [`player_${uuid}`, JSON.stringify(data)]
  );
}

// ========================================================
// --- GERENCIADOR DE PARCELAS INTELIGENTE ---
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
        let idx = mList.findIndex(item => item.startsWith(uuid + "#"));
        if (idx !== -1) {
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
        let n1 = await dbGet(`${srv}_NAMES_1`) || "";
        let n2 = await dbGet(`${srv}_NAMES_2`) || "";
        let n3 = await dbGet(`${srv}_NAMES_3`) || "";
        let n4 = await dbGet(`${srv}_NAMES_4`) || "";
        let n5 = await dbGet(`${srv}_NAMES_5`) || "";
        let joined = [n1, n2, n3, n4, n5].filter(Boolean).join("ç");
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
      let tN1 = await dbGet(`${targetServer}_NAMES_1`) || "";
      let tN2 = await dbGet(`${targetServer}_NAMES_2`) || "";
      let tN3 = await dbGet(`${targetServer}_NAMES_3`) || "";
      let tN4 = await dbGet(`${targetServer}_NAMES_4`) || "";
      let tN5 = await dbGet(`${targetServer}_NAMES_5`) || "";
      let tJoined = [tN1, tN2, tN3, tN4, tN5].filter(Boolean).join("ç");
      let targetNamesList = tJoined ? tJoined.split("ç") : [];
      while (targetNamesList.length < targetMainList.length) targetNamesList.push("NULL");

      targetMainList.push(newItem);
      targetNamesList.push(cleanRegion);
      await saveServerChunks(targetServer, targetMainList, targetNamesList);
    } 
    else {
      let mainData = await dbGet(targetServer) || ""; 
      let mainList = mainData ? mainData.split("ç") : [];
      let n1 = await dbGet(`${targetServer}_NAMES_1`) || "";
      let n2 = await dbGet(`${targetServer}_NAMES_2`) || "";
      let n3 = await dbGet(`${targetServer}_NAMES_3`) || "";
      let n4 = await dbGet(`${targetServer}_NAMES_4`) || "";
      let n5 = await dbGet(`${targetServer}_NAMES_5`) || "";
      let joined = [n1, n2, n3, n4, n5].filter(Boolean).join("ç");
      let namesList = joined ? joined.split("ç") : [];
      while (namesList.length < mainList.length) namesList.push("NULL");

      if (action === "DEL_PARCEL") {
        const idx = mainList.findIndex(item => item.startsWith(uuid + "#"));
        if (idx !== -1) {
          mainList.splice(idx, 1);
          namesList.splice(idx, 1);
        }
      } 
      else if (action === "DEL_NUM") {
        if (num >= 0 && num < mainList.length) {
          mainList.splice(num, 1);
          namesList.splice(num, 1);
        }
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
        if (idx !== -1) {
          namesList[idx] = formatRegion(regionName);
        }
        namesList = namesList.map(name => formatRegion(name));
      }
      await saveServerChunks(targetServer, mainList, namesList);
    }
    res.status(200).json({ success: true, message: `Ação ${action} processada no servidor: ${targetServer}.` });
  } catch (error) {
    console.error("Erro no processamento de parcelas:", error);
    res.status(500).json({ error: "Erro interno no servidor de parcelas" });
  }
});

// ========================================================
// --- AUTO-SINCER (WEBSCRAPING PELA URL DO TELEPORTE) ---
// ========================================================
app.post('/admin/sync-regions', requireToken, async (req, res) => {
  res.json({ status: "success", message: "Sincronização iniciada em segundo plano. Isso pode levar alguns minutos." });
  (async () => {
    try {
      console.log("[SYNC] Iniciando varredura automatizada das parcelas via Second Life Web...");
      let serversData = await dbGet("SERVERS");
      let servers = serversData ? serversData.split("ç").filter(Boolean) : [];

      for (let srv of servers) {
        let mainData = await dbGet(srv) || "";
        let mainList = mainData ? mainData.split("ç").filter(Boolean) : [];
        if (mainList.length === 0) continue;

        let n1 = await dbGet(`${srv}_NAMES_1`) || "";
        let n2 = await dbGet(`${srv}_NAMES_2`) || "";
        let n3 = await dbGet(`${srv}_NAMES_3`) || "";
        let n4 = await dbGet(`${srv}_NAMES_4`) || "";
        let n5 = await dbGet(`${srv}_NAMES_5`) || "";
        
        let originalNames = [n1, n2, n3, n4, n5].filter(Boolean).join("ç");
        let namesList = originalNames ? originalNames.split("ç") : [];
        while (namesList.length < mainList.length) namesList.push("NULL");

        let updatedCount = 0;

        for (let i = 0; i < mainList.length; i++) {
          let uuid = mainList[i].split("#")[0];
          if (uuid && uuid.length === 36) {
            try {
              const fetchOptions = {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                  "Accept": "text/html,application/xhtml+xml,application/xml"
                }
              };
              let slRes = await fetch(`https://world.secondlife.com/parcel/${uuid}`, fetchOptions);
              if (!slRes.ok) slRes = await fetch(`https://world.secondlife.com/place/${uuid}`, fetchOptions);

              if (slRes.ok) {
                const html = await slRes.text();
                let extractedRegion = "";
                const mapMatch = html.match(/maps\.secondlife\.com\/secondlife\/([^\/"]+)/i);
                
                if (mapMatch && mapMatch[1]) {
                  extractedRegion = decodeURIComponent(mapMatch[1]).replace(/\+/g, ' ').trim();
                } else {
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
                  if (namesList[i] !== extractedRegion && extractedRegion.length > 0 && extractedRegion !== "Second Life") {
                    console.log(`[SYNC] Corrigindo banco: de "${namesList[i]}" para -> "${extractedRegion}"`);
                    namesList[i] = extractedRegion;
                    updatedCount++;
                  }
                }
              }
            } catch (fetchErr) {
              console.error(`[SYNC] Erro HTTP ao processar UUID ${uuid}: ${fetchErr.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }
        let newNames = namesList.join("ç");
        if (newNames !== originalNames) {
          await saveServerChunks(srv, mainList, namesList);
          console.log(`[SYNC] Continente ${srv} atualizado no BD! (Registros corrigidos: ${updatedCount})`);
        }
      }
      console.log("[SYNC] Varredura GLOBAL finalizada com sucesso!");
    } catch (err) {
      console.error("[SYNC] Erro fatal durante a varredura:", err);
    }
  })();
});

// ========================================================
// --- TABELA DE DEMANDA ISOLADA POR UUID DA PARCELA ---
// ========================================================
async function processParcelDemand(parcelUuid, user) {
  try {
      let demandDataStr = await dbGet("PARCEL_DEMANDS") || "{}";
      let demandData = {};
      try { demandData = JSON.parse(demandDataStr); } catch(e) {}

      let parcel = demandData[parcelUuid] || { mult: 1.0, history: [], last_delivery: 0, user_history: {} };
      if (!parcel.user_history) parcel.user_history = {};

      let now = getUnixTime();

      // Limpa entregas mais velhas que 3 horas (10800s)
      parcel.history = parcel.history.filter(ts => (now - ts) <= 10800);

      // Proteção anti-duplo clique (15 segundos para o mesmo usuário na mesma parcela)
      let lastUserTime = parcel.user_history[user] || 0;
      let alreadyCountedRecently = (now - lastUserTime) < 15;

      if (!alreadyCountedRecently) {
         // Recuperação de Demanda (+0.2 por cada hora sem entregas)
         if (parcel.last_delivery > 0 && parcel.mult < 1.0) {
            let timeOffline = now - parcel.last_delivery;
            if (timeOffline >= 3600) {
               let hoursRecovered = Math.floor(timeOffline / 3600);
               parcel.mult = Math.min(1.0, parcel.mult + (hoursRecovered * 0.2));
            }
         }

         parcel.history.push(now);
         parcel.last_delivery = now;
         parcel.user_history[user] = now;

         // Queda se houver 3 ou mais entregas nas últimas 3 horas
         if (parcel.history.length >= 3) {
            parcel.mult = Math.max(0.1, parcel.mult - 0.1);
         }

         parcel.mult = Math.round(parcel.mult * 10) / 10;

         demandData[parcelUuid] = parcel;
         await dbSet("PARCEL_DEMANDS", JSON.stringify(demandData));
      }

      return parcel.mult;
  } catch (err) {
      console.error("Erro no processParcelDemand:", err);
      return 1.0;
  }
}
// ========================================================

app.post("/action", requireToken, async (req, res) => {
  const { topic, user, target, content, plan, productName, reqTime, action } = req.body;
  let safeTopic = (topic || action || "").toLowerCase().trim();
  
  // ========================================================
  // EXTRATOR EXATO DA UUID DA PARCELA NO PAYLOAD
  // ========================================================
  let rawData = `${target || ""} ${content || ""} ${plan || ""} ${productName || ""} ${action || ""}`;
  let parcelUuid = null;
  let uuidMatch = rawData.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (uuidMatch) {
      parcelUuid = uuidMatch[1];
  }
  // ========================================================

  // ========================================================
  // 1. DEBOUNCE ANTI-GLITCH
  // ========================================================
  const txHash = `${user}_${safeTopic}_${parcelUuid || 'gen'}_${content}`;
  if (globalDebounce.has(txHash)) {
      return res.json({ status: "ignored" });
  }
  globalDebounce.add(txHash);
  setTimeout(() => globalDebounce.delete(txHash), 2500);
  // ========================================================

  let responsePayload = { status: "success" };

  // ========================================================
  // 2. LOCK POR USUÁRIO
  // ========================================================
  await withLock(user, async () => {
    try {
      
      if (safeTopic === "cargo sell" || safeTopic === "delivered" || safeTopic === "delivery") {
        let price = parseInt(content) || 0;
        if (price > MAX_TRANSACTION) price = MAX_TRANSACTION;

        let player = await getPlayerData(user);
        let demandMult = 1.0;
        let now = getUnixTime();

        // SE HOUVER UMA UUID DE PARCELA VÁLIDA, PROCESSA A DEMANDA ESPECÍFICA DESTA PARCELA
        if (parcelUuid && parcelUuid.length === 36 && parcelUuid !== "00000000-0000-0000-0000-000000000000") {
            demandMult = await processParcelDemand(parcelUuid, user);
        }

        if (safeTopic !== "cargo sell") {
            return res.json({ status: "success" });
        }

        // APLICA O DESCONTO DE DEMANDA EM TUDO, EXCETO NO PLANO "EVENT"
        if (demandMult < 1.0 && plan !== "EVENT") {
            price = Math.round(price * demandMult);
            let lostPercent = Math.round((1.0 - demandMult) * 100);
            await addPlayerMessage(user, `📉 [DEMAND ALERT] This location is saturated! Payout reduced by ${lostPercent}% (${demandMult}x). Demand recovers +20% every hour without deliveries.`);
        }

        let recebido = 0;
        let boost_m = 1.0;
        let currentWeek = getCurrentWeek();

        if (player.P_W !== currentWeek) {
          player.P = 0;
          player.P_W = currentWeek;
        }

        if (player.B_T > now) {
          boost_m = parseFloat(player.B_M) || 1.0;
          if (boost_m > 1.0) price = Math.round(price * boost_m);
        } else if (player.B_T > 0) {
          player.B_M = 1.0;
          player.B_T = 0;
        }

        if (plan !== "FREE" && plan !== "EVENT" && plan !== "TEST_CARGO") {
          if (boost_m > 1.0) await addPlayerMessage(user, `Cargo value boosted by ${boost_m}X!`);
          await addPlayerMessage(user, `You won ${price} F₵.`);

          player.P += Math.round(price * 0.1);
          if (player.AT !== "A") {
            player.AT = "A";
            responsePayload.newBuyer = true;
          }

          try {
            const buyersRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["GFN_BUYERS"]);
            let buyersList = [];
            if (buyersRes.rowCount > 0 && buyersRes.rows[0].value) {
              buyersList = buyersRes.rows[0].value.split(",").filter(Boolean);
            }
            if (!buyersList.includes(user)) {
              buyersList.push(user);
              await db.query(
                `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
                ["GFN_BUYERS", buyersList.join(",")]
              );
            }
          } catch (e) {
            console.error("Error updating GFN_BUYERS:", e);
          }

          let premiumBonus = 0;
          if (plan === "PREMIUM") {
            if (price <= 0) price = 1;
            premiumBonus = Math.floor(price * 0.2); 
            await addPlayerMessage(user, "You won 20% more for being premium.");
          }

          player.M += (price + premiumBonus);
          recebido = price + premiumBonus;
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } 
        else if (plan === "TEST_CARGO") {
          if (player.TC_W !== currentWeek) { player.TC_V = 0; player.TC_W = currentWeek; }
          if (player.TC_V >= MAX_TC) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_TC} F₵ in your test cargo plan this week.`);
          } else {
            if (player.TC_V + price >= MAX_TC) {
              let resto = MAX_TC - player.TC_V;
              player.TC_V = MAX_TC;
              player.M += resto;
              recebido = resto;
              await addPlayerMessage(user, `You won ${resto} F₵.`);
            } else {
              player.TC_V += price;
              player.M += price;
              recebido = price;
              await addPlayerMessage(user, `You won ${price} F₵.`);
            }
          }
          player.P += Math.round((recebido * 0.8) * 0.1);
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } 
        else if (plan === "EVENT") {
          if (player.EV_W !== currentWeek) { player.EV_V = 0; player.EV_W = currentWeek; }
          if (player.EV_V >= MAX_EV) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_EV} F₵ in your event plan this week.`);
          } else {
            if (player.EV_V + price >= MAX_EV) {
              let resto = MAX_EV - player.EV_V;
              player.EV_V = MAX_EV;
              player.M += resto;
              recebido = resto;
              await addPlayerMessage(user, `You won ${resto} F₵.`);
            } else {
              player.EV_V += price;
              player.M += price;
              recebido = price;
              await addPlayerMessage(user, `You won ${price} F₵.`);
            }
          }
          player.P += Math.round((recebido * 0.5) * 0.1);
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        } 
        else if (plan === "FREE") {
          if (player.RE >= MAX_F) {
            await addPlayerMessage(user, `You have reached the limit of ${MAX_F} F₵ in your free plan.`);
          } else {
            if (player.RE + price >= MAX_F) {
              let resto = MAX_F - player.RE;
              player.RE = MAX_F;
              player.M += resto;
              recebido = resto;
              await addPlayerMessage(user, `You won ${resto} F₵.`);
            } else {
              player.RE += price;
              player.M += price;
              recebido = price;
              await addPlayerMessage(user, `You won ${price} F₵.`);
            }
          }
          await addPlayerMessage(user, `You have now ${player.M} F₵.`);
        }

        await savePlayerData(user, player);
        responsePayload.recebido = recebido;
      } 
      else if (safeTopic === "addboost") {
        let add_mult = parseFloat(content) || 1.0;
        let add_time = parseInt(target) || 0;
        let player = await getPlayerData(user);
        let now = getUnixTime();
        let current_time = player.B_T;
        if (current_time < now) current_time = now;
        current_time += add_time;
        player.B_M = add_mult;
        player.B_T = current_time;
        await savePlayerData(user, player);
      } 
      else if (safeTopic === "check") {
        let player = await getPlayerData(user);
        await addPlayerMessage(user, `You have ${player.M} F₵.`);
        await addPlayerMessage(user, `You have ${player.P} GFN points this week.`);
      }
      else if (safeTopic === "godcheck") {
        let tPlayer = await getPlayerData(target);
        await addPlayerMessage(user, `Target (${target}) Balance: ${tPlayer.M} F₵ | Points: ${tPlayer.P}`);
      }
      else if (safeTopic === "m_reset") {
        let tPlayer = await getPlayerData(target);
        tPlayer.M = parseInt(content) || 0;
        await savePlayerData(target, tPlayer);
        await addPlayerMessage(user, `Money reset for ${target}. New balance: ${tPlayer.M} F₵`);
        await addPlayerMessage(target, `Your money balance was reset by an administrator.`);
      }
      else if (safeTopic === "p_reset") {
        let tPlayer = await getPlayerData(target);
        tPlayer.P = parseInt(content) || 0;
        await savePlayerData(target, tPlayer);
        await addPlayerMessage(user, `Points reset for ${target}. New points: ${tPlayer.P}`);
        await addPlayerMessage(target, `Your GFN points were reset by an administrator.`);
      }
      else if (safeTopic === "pay") {
        let amountVal = parseInt(content) || 0;
        if (amountVal <= 0) {
          await addPlayerMessage(user, "Transaction failed. Invalid amount.");
          return res.json({ status: "denied" });
        }
        if (amountVal > MAX_TRANSACTION) amountVal = MAX_TRANSACTION;
        
        let sender = await getPlayerData(user);
        if (sender.M < amountVal) {
          await addPlayerMessage(user, `Transaction failed. You don't have enough F₵. Current balance: ${sender.M} F₵`);
          return res.json({ status: "denied" });
        }
        if (user === target) {
          await addPlayerMessage(user, "Transaction failed. You cannot pay yourself.");
          return res.json({ status: "denied" });
        }

        let tPlayer = await getPlayerData(target);
        sender.M -= amountVal;
        tPlayer.M += amountVal;
        
        await savePlayerData(user, sender);
        await savePlayerData(target, tPlayer);

        let senderProfile = `secondlife:///app/agent/${user}/about`;
        let targetProfile = `secondlife:///app/agent/${target}/about`;

        await addPlayerMessage(user, `You successfully paid ${amountVal} F₵ to ${targetProfile}. Your new balance: ${sender.M} F₵`);
        await addPlayerMessage(target, `You received ${amountVal} F₵ from ${senderProfile}. Your new balance: ${tPlayer.M} F₵`);
      }
      else if (safeTopic === "mass_money_reset_custom") {
        const maxValue = parseInt(content) || 0;
        const alertMessage = plan;
        const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'player_%'");
        let affected = 0;
        for (let row of q.rows) {
          try {
            let pData = JSON.parse(row.value);
            if (pData.M > maxValue) {
                pData.M = maxValue;
                await db.query("UPDATE kvstore SET value = $1 WHERE id = $2", [JSON.stringify(pData), row.id]);
                let playerUuid = row.id.replace("player_", "");
                await addPlayerMessage(playerUuid, alertMessage);
                affected++;
            }
          } catch(e) {
            console.error("Erro ao analisar dados do jogador no RESET:", e);
          }
        }
        await addPlayerMessage(user, `VARREDURA CONCLUÍDA! ${affected} contas foram limitadas a ${maxValue} F₵ e notificadas.`);
        responsePayload.status = "success";
      }
      else if (safeTopic === "buy") {
        let price = parseInt(content) || 0;
        if (price > MAX_TRANSACTION) {
          responsePayload.status = "denied";
          await addPlayerMessage(user, `Purchase blocked! You cannot spend more than ${MAX_TRANSACTION} F₵ in a single transaction.`);
          return res.json(responsePayload);
        }
        let buyer = await getPlayerData(user);
        let ownerUuid = target;
        if (buyer.M < price) {
          await addPlayerMessage(user, `You don't have enough F₵. Required: ${price}, You have: ${buyer.M}`);
          responsePayload.status = "denied";
        } else {
          if (ownerUuid === user) {
            await addPlayerMessage(user, `You bought your own product (${plan}). Your balance remains ${buyer.M} F₵.`);
            responsePayload.status = "success";
          } 
          else {
            buyer.M -= price;
            await savePlayerData(user, buyer);
            await addPlayerMessage(user, `You successfully bought ${plan} for ${price} F₵. Balance: ${buyer.M} F₵`);
            if (ownerUuid) {
              let ownerData = await getPlayerData(ownerUuid);
              ownerData.M += price;
              await savePlayerData(ownerUuid, ownerData);
              await addPlayerMessage(ownerUuid, `Your vending machine sold ${plan} for ${price} F₵. Balance: ${ownerData.M} F₵`);
            }
            responsePayload.status = "success";
          }
        }
      }
      else if (safeTopic === "refillpay") {
        let cost = parseInt(content) || 0;
        if (cost > MAX_TRANSACTION) {
          responsePayload.status = "denied";
          await addPlayerMessage(user, `Refill blocked! Cost exceeds the single transaction limit of ${MAX_TRANSACTION} F₵.`);
          return res.json(responsePayload);
        }
        let owner = await getPlayerData(user);
        if (owner.M < cost) {
          await addPlayerMessage(user, `You don't have enough F₵ to refill. Required: ${cost}, You have: ${owner.M}`);
          responsePayload.status = "denied";
        } else {
          owner.M -= cost;
          await savePlayerData(user, owner);
          await addPlayerMessage(user, `Refill paid: ${cost} F₵. Balance: ${owner.M} F₵`);
          responsePayload.status = "ok";
        }
      }

      res.json(responsePayload);

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal calculation error" });
    }
  });
  // FIM DO BLOCO DE LOCK
});

app.get("/get-rank", async (req, res) => {
  try {
    const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'player_%'");
    let players = [];
    let currentWeek = getCurrentWeek();
    for (let row of q.rows) {
      try {
        let data = JSON.parse(row.value);
        if (data.P_W === currentWeek && data.P && data.P > 0) {
          let uuid = row.id.replace("player_", "");
          players.push({ uuid, points: data.P });
        }
      } catch(e) {}
    }
    players.sort((a, b) => b.points - a.points);
    let top5 = players.slice(0, 5);
    res.json({ status: "success", top: top5 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

app.get("/get", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "missing id" });
  date; // no-op
  if (!id) return res.status(400).json({ error: "missing id" });
  try {
    const q = await db.query("SELECT value FROM kvstore WHERE id=$1", [id]);
    const value = q.rowCount === 0 ? null : q.rows[0].value;
    res.json({ id, value });
  } catch (e) {
    res.status(500).json({ error: "db error" });
  }
});

app.post("/set", requireToken, async (req, res) => {
  const { id, value } = req.body;
  if (!id) return res.status(400).json({ error: "missing id" });
  try {
    await db.query(
      `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
      [id, value]
    );
    if (id === "GLOBAL_SETTINGS") {
        await loadGlobalSettings();
    }
    res.json({ status: "ok", id, value });
  } catch (e) {
    res.status(500).json({ error: "db error" });
  }
});

app.get("/", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log("API running on port", PORT);
});
