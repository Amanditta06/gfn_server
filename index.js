// index.js - simple REST API for SL vehicles
import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import cors from "cors";

const app = express();
app.use(bodyParser.json());
app.use(cors()); // optional - allows browser testing

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || "changeme";
const DB_FILE = path.join(process.cwd(), "db.json");

// Load DB (simple file persistence)
let db = {};
try {
  if (fs.existsSync(DB_FILE)) {
    const content = fs.readFileSync(DB_FILE, "utf8");
    db = content ? JSON.parse(content) : {};
  }
} catch (e) {
  console.error("Error loading DB:", e);
  db = {};
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("Error saving DB:", e);
  }
}

// Middleware to require token in header 'x-api-token'
function requireToken(req, res, next) {
  const token = req.header("x-api-token");
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ error: "invalid token" });
  }
  next();
}

// GET /get?id=CARID  -> returns { id, value }
app.get("/get", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "missing id" });
  const value = db[id] === undefined ? null : db[id];
  return res.json({ id, value });
});

// POST /set  -> body { id, value }  (requires token)
app.post("/set", requireToken, (req, res) => {
  const { id, value } = req.body;
  if (!id) return res.status(400).json({ error: "missing id" });
  db[id] = value;
  saveDB();
  return res.json({ status: "ok", id, value });
});

// DELETE /del?id=CARID  (requires token)
app.delete("/del", requireToken, (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "missing id" });
  delete db[id];
  saveDB();
  return res.json({ status: "deleted", id });
});

// Health
app.get("/", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
