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
  } catch (e) {
    console.error("Error ensuring kvstore table:", e);
  }
}
ensureTable();

function requireToken(req, res, next) {
  const token = req.header("x-api-token");
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ error: "invalid token" });
  }
  next();
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

const getUnixTime = () => Math.floor(Date.now() / 1000);
const getCurrentWeek = () => Math.floor((getUnixTime() + 345600) / 604800);

async function getPlayerData(uuid) {
  if (!uuid) return null;
  const res = await db.query("SELECT value FROM kvstore WHERE id=$1", [`player_${uuid}`]);
  let data = { M: 0, P: 0, P_W: 0, TC_V: 0, TC_W: 0, EV_V: 0, EV_W: 0, RE: 0, AT: "", B_M: 1.0, B_T: 0 };
  if (res.rowCount > 0) {
    try { data = { ...data, ...JSON.parse(res.rows[0].value) }; } catch(e) {}
  }
  return data;
}

async function savePlayerData(uuid, data) {
  await db.query(
    `INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
    [`player_${uuid}`, JSON.stringify(data)]
  );
}

app.post("/action", requireToken, async (req, res) => {
  const { topic, user, target, content, plan, productName, reqTime } = req.body;
  let targetUuid = target || plan; // Captura o alvo enviado pelo HUD (tanto em target quanto em plan)
  let responsePayload = { status: "success" };

  try {
    if (topic === "cargo sell") {
      let price = parseInt(content) || 0;
      let player = await getPlayerData(user);
      let recebido = 0;
      let boost_m = 1.0;
      let now = getUnixTime();
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
    else if (topic === "addBoost") {
      let add_mult = parseFloat(content) || 1.0;
      let add_time = parseInt(targetUuid) || 0;
      let player = await getPlayerData(user);
      let now = getUnixTime();
      let current_time = player.B_T;
      if (current_time < now) current_time = now;
      current_time += add_time;
      player.B_M = add_mult;
      player.B_T = current_time;
      await savePlayerData(user, player);
    } 
    else if (topic === "check") {
      let player = await getPlayerData(user);
      await addPlayerMessage(user, `You have ${player.M} F₵.`);
      await addPlayerMessage(user, `You have ${player.P} GFN points this week.`);
    }
    // --- NOVOS TÓPICOS PARA O ADMIN HUD ---
    else if (topic === "godCheck") {
      let tPlayer = await getPlayerData(targetUuid);
      await addPlayerMessage(user, `Target (${targetUuid}) Balance: ${tPlayer.M} F₵ | Points: ${tPlayer.P}`);
    }
    else if (topic === "M_RESET") {
      let tPlayer = await getPlayerData(targetUuid);
      tPlayer.M = parseInt(content) || 0;
      await savePlayerData(targetUuid, tPlayer);
      await addPlayerMessage(user, `Money reset for ${targetUuid}. New balance: ${tPlayer.M} F₵`);
      await addPlayerMessage(targetUuid, `Your money balance was reset by an administrator.`);
    }
    else if (topic === "P_RESET") {
      let tPlayer = await getPlayerData(targetUuid);
      tPlayer.P = parseInt(content) || 0;
      await savePlayerData(targetUuid, tPlayer);
      await addPlayerMessage(user, `Points reset for ${targetUuid}. New points: ${tPlayer.P}`);
      await addPlayerMessage(targetUuid, `Your GFN points were reset by an administrator.`);
    }
    else if (topic === "pay") {
      let amountVal = parseInt(content) || 0;
      let tPlayer = await getPlayerData(targetUuid);
      tPlayer.M += amountVal;
      await savePlayerData(targetUuid, tPlayer);
      await addPlayerMessage(user, `Successfully adjusted balance of ${targetUuid} by ${amountVal} F₵. New balance: ${tPlayer.M} F₵`);
      await addPlayerMessage(targetUuid, `Your balance was adjusted by ${amountVal} F₵ by an administrator. Current balance: ${tPlayer.M} F₵`);
    }

    res.json(responsePayload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal calculation error" });
  }
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
