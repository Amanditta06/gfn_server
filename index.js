// index.js - REST API para SL usando PostgreSQL
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

// Se DATABASE_URL não estiver setado, o app tenta rodar (útil p/ dev local)
// mas as rotas que acessam DB vão falhar até você setar a variável.
if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL not set. DB calls will fail until it's configured.");
}

// Conexão com PostgreSQL
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

// Cria a tabela kvstore caso não exista (id TEXT PRIMARY KEY, value TEXT)
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
  } catch (e) {
    console.error("Error ensuring kvstore table:", e);
  }
}

// chama no startup
ensureTable();

// Middleware para validar token
function requireToken(req, res, next) {
  const token = req.header("x-api-token");
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ error: "invalid token" });
  }
  next();
}

// GET /get?id=xxx
app.get("/get", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "missing id" });

  try {
    const q = await db.query("SELECT value FROM kvstore WHERE id=$1", [id]);
    const value = q.rowCount === 0 ? null : q.rows[0].value;
    res.json({ id, value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

// POST /set   → body { id, value }
app.post("/set", requireToken, async (req, res) => {
  const { id, value } = req.body;
  if (!id) return res.status(400).json({ error: "missing id" });

  try {
    await db.query(
      `INSERT INTO kvstore (id, value)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
      [id, value]
    );

    res.json({ status: "ok", id, value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

// DELETE /del?id=xxx
app.delete("/del", requireToken, async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "missing id" });

  try {
    await db.query("DELETE FROM kvstore WHERE id=$1", [id]);
    res.json({ status: "deleted", id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

// Healthcheck
app.get("/", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log("API running on port", PORT);
});
