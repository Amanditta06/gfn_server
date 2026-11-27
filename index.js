import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";
import crypto from "crypto";

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
// MIGUS GLOBAL CACHE & KNOWLEDGE BASE
// ========================================================
let MIGU_CONFIG = { version: "1.0", duel_wager: 50, cookie_cost: 10, catch_chance: 0.55 };
let MIGU_LIST = []; 
let GFN_KB = []; 

// ========================================================
// GACHA SYSTEM LISTS & PRICES
// ========================================================
let GACHA_LISTS = {
  eyes: [], mouths: [], pattern: [], outline: [], color_up: [], color_down: []
};
let GACHA_PRICES = { pattern: 10, base: 10, color_down: 10, color_up: 10, eyes: 10, mouths: 10, outline: 10, heal: 5, crit: 5 };

const DEFAULT_TEXTURE = "5748decc-f629-461c-9a36-a35a221fe21f"; 

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
// LED OUTDOOR COMMERCIAL AD SYSTEM (MULTI-IMAGE + LINKS + ADMIN)
// ========================================================
const OUTDOOR_CHUNK_SIZE = 25; // Reduzido para 25 por pacote para comportar UUID + Link com folga nos 16KB do LSL
const OUTDOOR_WEEK_SECONDS = 604800; // 7 days in seconds
const OUTDOOR_MAX_LINK_LEN = 250;

let OUTDOOR_CONFIG = {
  weeklyPrice: 100,
  maxImagesPerPlan: 5
};

let OUTDOOR_ACCOUNTS = new Map(); // uuid -> { uuid, legacyName, password, isAdmin, plans: [] }
let OUTDOOR_NAME_MAP = new Map(); // legacyNameLower -> uuid

function normalizeLegacyName(raw) {
  if (!raw) return "";
  let clean = String(raw).trim().replace(/\s+/g, " ");
  if (clean.toLowerCase().endsWith(" resident")) {
    clean = clean.slice(0, -9).trim();
  }
  return clean;
}

function isValidUuid(str) {
  return typeof str === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
}

// Valida se a string é um link HTTP/HTTPS ou Second Life SLURL válido
function isValidAdLink(raw) {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (!s) return false;
  if (s.length > OUTDOOR_MAX_LINK_LEN) return false;
  if (/[\sç|"<>\x00-\x1F\x7F]/.test(s)) return false;

  // Aceita SLURLs do Second Life (ex: secondlife://Region/128/128/25 ou secondlife:///app/...)
  if (/^secondlife:\/\//i.test(s)) {
    const rest = s.slice(13);
    return rest.length >= 3;
  }

  // Aceita apenas http:// ou https:// com domínio válido
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname || !u.hostname.includes(".")) return false;
    if (u.hostname.startsWith(".") || u.hostname.endsWith(".")) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeImageEntry(entry) {
  if (typeof entry === "string") {
    const u = entry.trim().toLowerCase();
    return isValidUuid(u) ? { uuid: u, link: "" } : null;
  }
  if (entry && typeof entry === "object") {
    const u = String(entry.uuid || "").trim().toLowerCase();
    if (!isValidUuid(u)) return null;
    const rawLink = String(entry.link || "").trim();
    const safeLink = isValidAdLink(rawLink) ? rawLink : "";
    return { uuid: u, link: safeLink };
  }
  return null;
}

function formatRemainingShort(seconds) {
  if (seconds <= 0) return "EXPIRED";
  const days = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

function pruneExpiredPlansForAccount(acc, now = getUnixTime()) {
  if (!acc) return false;
  let changed = false;

  if (typeof acc.isAdmin !== "boolean") {
    acc.isAdmin = Boolean(acc.isAdmin);
    changed = true;
  }
  if (!Array.isArray(acc.plans)) {
    acc.plans = [];
    changed = true;
  }

  const kept = [];
  for (const p of acc.plans) {
    // Migra formato antigo (textureUuid ou array de strings) para [{ uuid, link }]
    if (!Array.isArray(p.images)) {
      p.images = [];
      if (p.textureUuid && isValidUuid(p.textureUuid)) {
        p.images.push({ uuid: p.textureUuid.trim().toLowerCase(), link: "" });
      }
      delete p.textureUuid;
      changed = true;
    } else {
      const normalized = [];
      let imgChanged = false;
      for (const item of p.images) {
        const norm = normalizeImageEntry(item);
        if (!norm) {
          imgChanged = true;
          continue;
        }
        if (typeof item === "string" || item.uuid !== norm.uuid || (item.link || "") !== norm.link) {
          imgChanged = true;
        }
        normalized.push(norm);
      }
      if (imgChanged) {
        p.images = normalized;
        changed = true;
      }
    }

    if (acc.isAdmin && p.isAdminFree) {
      kept.push(p);
      continue;
    }

    if (!acc.isAdmin && p.isAdminFree) {
      p.isAdminFree = false;
      p.wasAdminFree = true;
      p.expiresAt = now;
      changed = true;
    }

    const deleteAt = (p.expiresAt || 0) + OUTDOOR_WEEK_SECONDS;
    if (now >= deleteAt) {
      changed = true;
    } else {
      kept.push(p);
    }
  }

  if (kept.length !== acc.plans.length) {
    acc.plans = kept;
    changed = true;
  }
  return changed;
}

async function saveOutdoorAccount(acc) {
  OUTDOOR_ACCOUNTS.set(acc.uuid, acc);
  if (acc.legacyName) {
    OUTDOOR_NAME_MAP.set(normalizeLegacyName(acc.legacyName).toLowerCase(), acc.uuid);
  }
  await dbSet(`outdoor_acc_${acc.uuid}`, JSON.stringify(acc));
}

async function pruneAllOutdoorPlans() {
  const now = getUnixTime();
  for (const acc of OUTDOOR_ACCOUNTS.values()) {
    if (pruneExpiredPlansForAccount(acc, now)) {
      await saveOutdoorAccount(acc);
    }
  }
}

function serializePlanForClient(p, isAdmin, now = getUnixTime()) {
  const isInfinite = Boolean(isAdmin && p.isAdminFree);
  const active = isInfinite || (p.expiresAt > now);
  const remainingSeconds = isInfinite ? -1 : Math.max(0, (p.expiresAt || 0) - now);
  const graceRemainingSeconds = active ? 0 : Math.max(0, ((p.expiresAt || 0) + OUTDOOR_WEEK_SECONDS) - now);

  const normalizedImgs = (Array.isArray(p.images) ? p.images : [])
    .map(normalizeImageEntry)
    .filter(Boolean);

  return {
    name: p.name,
    isAdminFree: isInfinite,
    active,
    expiresAt: p.expiresAt || 0,
    remainingSeconds,
    graceRemainingSeconds,
    images: normalizedImgs
  };
}

async function initOutdoorSystem() {
  if (!DATABASE_URL) return;
  try {
    const cfgRes = await dbGet("OUTDOOR_CONFIG");
    if (cfgRes) {
      try { OUTDOOR_CONFIG = { ...OUTDOOR_CONFIG, ...JSON.parse(cfgRes) }; } catch (e) {}
    } else {
      await dbSet("OUTDOOR_CONFIG", JSON.stringify(OUTDOOR_CONFIG));
    }

    OUTDOOR_ACCOUNTS.clear();
    OUTDOOR_NAME_MAP.clear();

    const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'outdoor_acc_%'");
    const now = getUnixTime();
    for (const row of q.rows) {
      try {
        const acc = JSON.parse(row.value);
        if (acc && acc.uuid) {
          const modified = pruneExpiredPlansForAccount(acc, now);
          OUTDOOR_ACCOUNTS.set(acc.uuid, acc);
          if (acc.legacyName) {
            OUTDOOR_NAME_MAP.set(normalizeLegacyName(acc.legacyName).toLowerCase(), acc.uuid);
          }
          if (modified) await saveOutdoorAccount(acc);
        }
      } catch (e) {}
    }
    console.log(`[OUTDOOR] Loaded ${OUTDOOR_ACCOUNTS.size} accounts. Price: L$${OUTDOOR_CONFIG.weeklyPrice} | Max images: ${OUTDOOR_CONFIG.maxImagesPerPlan}`);
  } catch (e) {
    console.error("Error in initOutdoorSystem:", e);
  }
}

// Retorna cada entrada no formato "uuid|link" (revalidando o link antes de enviar ao outdoor)
function getActiveOutdoorAdsList() {
  const now = getUnixTime();
  const maxImgs = OUTDOOR_CONFIG.maxImagesPerPlan || 5;
  const activeEntries = [];

  for (const acc of OUTDOOR_ACCOUNTS.values()) {
    if (!Array.isArray(acc.plans)) continue;
    for (const p of acc.plans) {
      const isActive = (acc.isAdmin && p.isAdminFree) || (p.expiresAt > now);
      if (!isActive || !Array.isArray(p.images)) continue;

      const allowed = p.images.slice(0, maxImgs);
      for (const rawItem of allowed) {
        const item = normalizeImageEntry(rawItem);
        if (!item) continue;
        const verifiedLink = isValidAdLink(item.link) ? item.link : "";
        activeEntries.push(`${item.uuid}|${verifiedLink}`);
      }
    }
  }
  return activeEntries;
}

setInterval(pruneAllOutdoorPlans, 10 * 60 * 1000);
/////////////////////////////////////////////////////////////////////////////////////////

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
// GACHA HELPERS
// ========================================================
function getLum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

function generateColor(contrastLum = -1) {
  let r, g, b, l;
  let attempts = 0;
  do {
    r = Math.random(); g = Math.random(); b = Math.random();
    l = getLum(r, g, b);
    attempts++;
    if (contrastLum === -1) break;
    if (contrastLum <= 0.5 && l > 0.6) break;
    if (contrastLum > 0.5 && l < 0.4) break;
  } while (attempts < 50); 
  return { vec: `<${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}>`, lum: l };
}

const parseVecToLum = (vecStr) => {
  try {
    let parts = vecStr.replace(/[<>]/g, "").split(",");
    return getLum(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
  } catch(e) { return 0.5; }
};

async function initGacha() {
  if (!DATABASE_URL) return;
  try {
    for (const key of Object.keys(GACHA_LISTS)) {
      let res = await dbGet(`GACHA_${key.toUpperCase()}`);
      if (res) {
        try { GACHA_LISTS[key] = JSON.parse(res); } catch(e) { GACHA_LISTS[key] = []; }
      }
    }
    const pRes = await dbGet("GACHA_PRICES");
    if (pRes) {
      try { GACHA_PRICES = { ...GACHA_PRICES, ...JSON.parse(pRes) }; } catch(e) {}
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
    try { await dbSet("DREDGE_ZONES", serializeDredgeCells()); } catch (e) {}
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

// ========================================================
// MINING VEIN SYSTEM (RESET DAILY LOGIC)
// ========================================================
async function doDailyVeinReset() {
  console.log("Running Global Vein Reset...");
  try {
    const q = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'veins_%'");
    for (let row of q.rows) {
      let pVeins = [];
      try { pVeins = JSON.parse(row.value); } catch(e){}
      let keepVeins = [];
      let modified = false;

      for (let v of pVeins) {
        if (v.cur <= (v.max / 2)) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(v.url + "/reset", { method: "POST", signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.status === 200) {
              keepVeins.push(v);
            } else {
              modified = true; 
            }
          } catch(e) {
            modified = true; 
          }
        } else {
          keepVeins.push(v);
        }
      }
      if (modified) {
        await dbSet(row.id, JSON.stringify(keepVeins));
      }
    }
  } catch (e) { console.error("Vein reset error:", e); }
}

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

// ========================================================
// HELPERS DE CARREGAMENTO, REPARO E SALVAMENTO DOS HUBS
// ========================================================
function stripControlChars(str) {
  if (!str) return "";
  return String(str).replace(/[\x00-\x1F\x7F]/g, "");
}

function sanitizeRegionName(raw) {
  if (!raw) return "";
  let clean = stripControlChars(raw)
    .replace(/ç/g, "")
    .replace(/#/g, "")
    .replace(/"/g, "")
    .trim();

  if (clean.toLowerCase() === "royie") {
    clean = "Royier";
  }
  return clean;
}

async function loadAndCleanServerHubs(serverId) {
  let rawMainStr = await dbGet(serverId) || "";
  let mainStr = stripControlChars(rawMainStr);
  let rawMainList = mainStr ? mainStr.split("ç").filter(Boolean) : [];

  let rawNamesList = [];
  for (let i = 1; i <= 5; i++) {
    let rawChunk = await dbGet(`${serverId}_NAMES_${i}`) || "";
    let chunk = stripControlChars(rawChunk).trim();
    if (chunk !== "") {
      let parsedChunk = chunk.split("ç");
      rawNamesList.push(...parsedChunk);
    }
  }

  let mainList = [];
  let namesList = [];
  let neededRepair = false;

  for (let i = 0; i < rawMainList.length; i++) {
    let parts = rawMainList[i].split("#");
    let itemUuid = (parts[0] || "").toLowerCase().replace(/[^0-9a-f\-]/g, "");
    if (itemUuid.length !== 36) {
      itemUuid = (parts[0] || "").trim();
    }
    let itemPos = parts.length > 1 ? parts[1].trim() : "";
    let embeddedRegion = parts.length > 2 ? sanitizeRegionName(parts[2]) : "";

    if (parts.length > 2 || rawMainList[i] !== `${itemUuid}#${itemPos}`) {
      neededRepair = true;
    }

    mainList.push(`${itemUuid}#${itemPos}`);

    let rawExisting = rawNamesList[i] || "";
    let existingName = sanitizeRegionName(rawExisting);
    if (existingName !== rawExisting.trim()) {
      neededRepair = true;
    }

    if ((!existingName || existingName === "Unknown Region") && embeddedRegion && embeddedRegion !== "Unknown Region") {
      existingName = embeddedRegion;
      neededRepair = true;
    }
    if (!existingName) {
      existingName = "Unknown Region";
      neededRepair = true;
    }
    namesList.push(existingName);
  }

  if (rawNamesList.length !== namesList.length) {
    neededRepair = true;
  }

  return { mainList, namesList, neededRepair };
}

async function saveServerChunks(srvName, mainList, namesList) {
  const alignedNames = [];
  for (let i = 0; i < mainList.length; i++) {
    let cleanName = sanitizeRegionName(namesList[i]);
    alignedNames.push(cleanName || "Unknown Region");
  }

  const newMainStr = mainList.join("ç");
  const chunks = ["", "", "", "", ""];
  for (let i = 0; i < alignedNames.length; i++) {
    let chunkIdx = Math.floor(i / 20);
    if (chunkIdx < 5) {
      if (chunks[chunkIdx] !== "") chunks[chunkIdx] += "ç";
      chunks[chunkIdx] += alignedNames[i];
    }
  }
  await dbSet(srvName, newMainStr);
  await dbSet(`${srvName}_NAMES_1`, chunks[0]);
  await dbSet(`${srvName}_NAMES_2`, chunks[1]);
  await dbSet(`${srvName}_NAMES_3`, chunks[2]);
  await dbSet(`${srvName}_NAMES_4`, chunks[3]);
  await dbSet(`${srvName}_NAMES_5`, chunks[4]);
}

async function healAllContinentsOnBoot() {
  if (!DATABASE_URL) return;
  try {
    await db.query("DELETE FROM kvstore WHERE id = 'AUTO' OR id LIKE 'AUTO_NAMES_%'");

    let serversStr = await dbGet("SERVERS");
    if (!serversStr) return;
    let continents = stripControlChars(serversStr).split("ç").filter(Boolean);

    for (const cont of continents) {
      const srv = cont.trim();
      if (!srv) continue;
      await withLock(`SERVER_${srv}`, async () => {
        const { mainList, namesList, neededRepair } = await loadAndCleanServerHubs(srv);
        if (neededRepair) {
          await saveServerChunks(srv, mainList, namesList);
          console.log(`[BOOT-HEAL] Continente '${srv}' realinhado (${mainList.length} HUBs).`);
        }
      });
    }
  } catch (e) {
    console.error("Erro no healAllContinentsOnBoot:", e);
  }
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
    await initGacha();
    await healAllContinentsOnBoot();
    await initOutdoorSystem();
    await initFactionSystem();
    
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

  try {
      const dailyVeinCheck = await dbGet("last_daily_vein_reset");
      const currentDay = Math.floor(getUnixTime() / 86400);
      if (!dailyVeinCheck || parseInt(dailyVeinCheck) !== currentDay) {
          await doDailyVeinReset();
          await dbSet("last_daily_vein_reset", currentDay.toString());
      }
  } catch(e){}
}, 60000);

function requireToken(req, res, next) {
  const token = req.header("x-api-token");
  if (!token || token !== API_TOKEN) return res.status(401).json({ error: "invalid token" });
  next();
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
    P_IN: true, P_OUT: true, JELLY: 0, M_XP: 0, 
    BOOST_PCT: 0.0, BOOST_END: 0 
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
      data.JELLY = parseInt(data.JELLY, 10) || 0;

      data.M_XP = parseFloat(data.M_XP) || 0.0;
      data.BOOST_PCT = parseFloat(data.BOOST_PCT) || 0.0;
      data.BOOST_END = parseInt(data.BOOST_END, 10) || 0;

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
// FUNÇÃO DE BUSCA NA WORLD API (COM TIMEOUT DE 3s)
// ========================================================
async function fetchRegionFromWorldAPI(parcelUuid) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const url = `https://world.secondlife.com/place/${parcelUuid}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const html = await response.text();
    const match = html.match(/<meta\s+name=["']region["']\s+content=["']([^"']+)["']/i);
    if (match && match[1]) {
      return sanitizeRegionName(match[1]);
    }
  } catch (e) {
    clearTimeout(timeoutId);
  }
  return null;
}

// ========================================================
// ROTA PRINCIPAL PARA OS HUBS (COM AUTO-DETECT COMPLETO)
// ========================================================
app.post("/admin/parcel", requireToken, async (req, res) => {
  const { action, serverId, uuid, pos, regionName, num, newPos } = req.body;
  if (!serverId) return res.status(400).json({ error: "Missing serverId" });

  let cleanUuid = uuid ? String(uuid).toLowerCase().replace(/[^0-9a-f\-]/g, "") : "";
  let cleanPos = pos ? stripControlChars(pos).replace(/[ç#]/g, "").trim() : "";
  let effRegion = sanitizeRegionName(regionName);

  // Se o LSL não enviou um nome válido de região, tenta buscar na World API como fallback
  if ((!effRegion || effRegion === "Unknown Region" || effRegion === "Unknown") && cleanUuid.length === 36) {
    if (action === "SET_PARCEL" || action === "MOVE_HUB" || action === "UPDATE_REGION") {
      let autoRegion = await fetchRegionFromWorldAPI(cleanUuid);
      if (autoRegion && autoRegion !== "Unknown" && autoRegion !== "UnknownRegion") {
        effRegion = autoRegion;
      }
    }
  }
  if (!effRegion) effRegion = "Unknown Region";

  // ========================================================
  // MODO AUTO-DETECT (DEL_PARCEL, REORDER e UPDATE_REGION com "AUTO")
  // ========================================================
  if (serverId === "AUTO" || serverId.includes("ç")) {
    if (cleanUuid.length !== 36) return res.json({ status: "ignored_invalid_uuid" });
    try {
      let serversStr = serverId === "AUTO" ? (await dbGet("SERVERS") || "") : serverId;
      let continents = stripControlChars(serversStr).split("ç").filter(Boolean);
      let updatedServers = [];

      for (const cont of continents) {
        const srv = cont.trim();
        if (!srv || srv === "AUTO") continue;

        await withLock(`SERVER_${srv}`, async () => {
          let { mainList, namesList, neededRepair } = await loadAndCleanServerHubs(srv);
          let findIdx = () => mainList.findIndex(item => item.split("#")[0].toLowerCase().replace(/[^0-9a-f\-]/g, "") === cleanUuid);
          let idx = findIdx();

          if (idx !== -1) {
            if (action === "DEL_PARCEL") {
              while ((idx = findIdx()) !== -1) {
                mainList.splice(idx, 1);
                namesList.splice(idx, 1);
              }
              await saveServerChunks(srv, mainList, namesList);
              updatedServers.push(srv);
            }
            else if (action === "REORDER") {
              let nPos = parseInt(newPos, 10);
              if (!isNaN(nPos)) {
                let mItem = mainList.splice(idx, 1)[0];
                let nItem = namesList.splice(idx, 1)[0];
                nPos = Math.max(0, Math.min(mainList.length, nPos));
                mainList.splice(nPos, 0, mItem);
                namesList.splice(nPos, 0, nItem);
                await saveServerChunks(srv, mainList, namesList);
                updatedServers.push(srv);
              }
            }
            else if (action === "UPDATE_REGION") {
              let oldParts = mainList[idx].split("#");
              let oldPos = oldParts.length > 1 ? oldParts[1].trim() : cleanPos;
              mainList[idx] = `${cleanUuid}#${oldPos}`;
              if (effRegion && effRegion !== "Unknown Region") {
                namesList[idx] = effRegion;
              }
              await saveServerChunks(srv, mainList, namesList);
              updatedServers.push(srv);
            }
          } else if (neededRepair) {
            await saveServerChunks(srv, mainList, namesList);
          }
        });
      }
      return res.json({ status: "success", action, updatedServers, finalRegion: effRegion });
    } catch (e) {
      console.error("Erro no /admin/parcel AUTO:", e);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // ========================================================
  // SE FOR MOVE_HUB, REMOVE DOS OUTROS CONTINENTES ANTES DE ADICIONAR NO DESTINO
  // ========================================================
  if (action === "MOVE_HUB" && cleanUuid.length === 36) {
    try {
      let serversStr = await dbGet("SERVERS") || "";
      let continents = stripControlChars(serversStr).split("ç").filter(Boolean);
      for (const cont of continents) {
        const srv = cont.trim();
        if (!srv || srv === "AUTO" || srv === serverId) continue;
        await withLock(`SERVER_${srv}`, async () => {
          let { mainList, namesList } = await loadAndCleanServerHubs(srv);
          let idx;
          let modified = false;
          while ((idx = mainList.findIndex(item => item.split("#")[0].toLowerCase().replace(/[^0-9a-f\-]/g, "") === cleanUuid)) !== -1) {
            mainList.splice(idx, 1);
            namesList.splice(idx, 1);
            modified = true;
          }
          if (modified) {
            await saveServerChunks(srv, mainList, namesList);
          }
        });
      }
    } catch (e) {}
  }

  // ========================================================
  // EXECUÇÃO EM UM CONTINENTE ESPECÍFICO
  // ========================================================
  await withLock(`SERVER_${serverId}`, async () => {
    try {
      let { mainList, namesList } = await loadAndCleanServerHubs(serverId);

      let findIndexByUuid = (target) => {
        let cleanTarget = target ? String(target).toLowerCase().replace(/[^0-9a-f\-]/g, "") : "";
        if (cleanTarget.length !== 36) return -1;
        return mainList.findIndex(item => {
          let itemUuid = item.split("#")[0].toLowerCase().replace(/[^0-9a-f\-]/g, "");
          return itemUuid === cleanTarget;
        });
      };

      if (action === "SET_PARCEL" || action === "MOVE_HUB") {
        let idx = findIndexByUuid(cleanUuid);
        if (idx !== -1) {
          let oldParts = mainList[idx].split("#");
          let finalPos = cleanPos || (oldParts.length > 1 ? oldParts[1].trim() : "");
          let finalRegion = (effRegion && effRegion !== "Unknown Region") ? effRegion : (namesList[idx] || "Unknown Region");
          mainList[idx] = `${cleanUuid}#${finalPos}`;
          namesList[idx] = finalRegion;
        } else if (cleanUuid.length === 36) {
          mainList.push(`${cleanUuid}#${cleanPos}`);
          namesList.push(effRegion);
        }
      }
      else if (action === "DEL_PARCEL") {
        let idx;
        while ((idx = findIndexByUuid(cleanUuid)) !== -1) {
          mainList.splice(idx, 1);
          namesList.splice(idx, 1);
        }
      }
      else if (action === "DEL_NUM") {
        let idx = parseInt(num, 10);
        if (!isNaN(idx) && idx >= 0 && idx < mainList.length) {
          mainList.splice(idx, 1);
          namesList.splice(idx, 1);
        }
      }
      else if (action === "REORDER") {
        let oldIdx = findIndexByUuid(cleanUuid);
        let nPos = parseInt(newPos, 10);
        if (oldIdx !== -1 && !isNaN(nPos)) {
          let mItem = mainList.splice(oldIdx, 1)[0];
          let nItem = namesList.splice(oldIdx, 1)[0];
          nPos = Math.max(0, Math.min(mainList.length, nPos));
          mainList.splice(nPos, 0, mItem);
          namesList.splice(nPos, 0, nItem);
        }
      }
      else if (action === "UPDATE_REGION") {
        let idx = findIndexByUuid(cleanUuid);
        if (idx !== -1) {
          let oldParts = mainList[idx].split("#");
          let oldPos = oldParts.length > 1 ? oldParts[1].trim() : cleanPos;
          mainList[idx] = `${cleanUuid}#${oldPos}`;
          if (effRegion && effRegion !== "Unknown Region") {
            namesList[idx] = effRegion;
          }
        }
      }

      await saveServerChunks(serverId, mainList, namesList);
      res.json({ status: "success", action, finalRegion: effRegion, totalHubs: mainList.length });
    } catch (e) {
      console.error("Erro no /admin/parcel:", e);
      res.status(500).json({ error: "Internal error" });
    }
  });
});

// ========================================================
// ROTA DE VARREDURA DE HUBS (SEM CORROMPER MAINLIST)
// ========================================================
app.post("/admin/scan-hubs", requireToken, async (req, res) => {
  res.json({ status: "scanning_started", message: "Iniciando varredura GLOBAL em background..." });

  (async () => {
    try {
      let serversStr = await dbGet("SERVERS");
      if (!serversStr) return;

      let continents = stripControlChars(serversStr).split("ç").filter(Boolean);

      for (let c = 0; c < continents.length; c++) {
        let serverId = continents[c].trim();
        if (!serverId) continue;

        await withLock(`SERVER_${serverId}`, async () => {
          let { mainList, namesList, neededRepair } = await loadAndCleanServerHubs(serverId);
          let updatedCount = neededRepair ? 1 : 0;

          for (let i = 0; i < mainList.length; i++) {
            let parts = mainList[i].split("#");
            let cleanUuid = (parts[0] || "").toLowerCase().replace(/[^0-9a-f\-]/g, "");
            let pos = parts.length > 1 ? parts[1].trim() : "";

            if (cleanUuid.length === 36) {
              let newRegion = await fetchRegionFromWorldAPI(cleanUuid);
              mainList[i] = `${cleanUuid}#${pos}`;

              if (newRegion && newRegion !== "Unknown" && newRegion !== "UnknownRegion") {
                namesList[i] = newRegion;
                updatedCount++;
              }
            }
            await new Promise(resolve => setTimeout(resolve, 400));
          }

          if (updatedCount > 0) {
            await saveServerChunks(serverId, mainList, namesList);
            console.log(`[SCAN GLOBAL] ${serverId} salvo e alinhado com sucesso!`);
          }
        });

        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      console.log("[SCAN GLOBAL] Varredura global finalizada!");
    } catch (e) {
      console.error("Erro durante o scan-hubs global:", e);
    }
  })();
});

// ========================================================
// DEMAIS ROTAS DO SISTEMA
// ========================================================

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
  if (reqPenalty > reqLiters) reqPenalty = reqLiters; 
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
        const baseCargoValue = price;

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

        if (savedParcelForAffinity && savedParcelForAffinity.length >= 36) {
            price = await applyFactionCargoEffect(user, savedParcelForAffinity, baseCargoValue, price);
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
    if (id === "MINING_STATS") {
        let uuid = req.query.uuid;
        let pData = await getPlayerData(uuid);
        let xp = pData ? (pData.M_XP || 0) : 0;
        let bp = pData ? (pData.BOOST_PCT || 0.0) : 0.0;
        let be = pData ? (pData.BOOST_END || 0) : 0;

        let forceVal = "50.0";
        const qForce = await db.query("SELECT value FROM kvstore WHERE id='P_FORCE'");
        if (qForce.rowCount > 0 && qForce.rows[0].value) forceVal = qForce.rows[0].value;

        return res.json({ id, value: `${forceVal}|${xp}|${bp}|${be}` });
    }

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
  GFN_KB = GFN_KB || [];
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

// ========================================================
// MINING VEIN ENDPOINTS
// ========================================================

app.post("/mining/admin_set_limit", requireToken, async (req, res) => {
    const { target_uuid, limit } = req.body;
    let newLimit = parseInt(limit);
    if (!target_uuid || isNaN(newLimit) || newLimit < 0) return res.status(400).json({ error: "invalid limit or uuid" });

    try {
        let limitsData = {};
        let row = await dbGet("VEIN_LIMITS");
        if (row) { try { limitsData = JSON.parse(row); } catch(e){} }

        limitsData[target_uuid] = newLimit;
        await dbSet("VEIN_LIMITS", JSON.stringify(limitsData));

        res.json({ status: "OK", message: `Limit for ${target_uuid} set to ${newLimit} veins.` });
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

app.post("/mining/sync_xp", requireToken, async (req, res) => {
    const { user_uuid, added_xp } = req.body;
    if (!user_uuid) return res.status(400).json({error: "missing data"});

    await withLock(user_uuid, async () => {
        let pData = await getPlayerData(user_uuid);
        let added = parseFloat(added_xp) || 0;

        if (added > 0.0) {
            pData.M_XP = (parseFloat(pData.M_XP) || 0) + added;
            await savePlayerData(user_uuid, pData);
        }

        res.json({ 
            status: "OK", 
            xp: pData.M_XP || 0, 
            boost_pct: pData.BOOST_PCT || 0, 
            boost_end: pData.BOOST_END || 0 
        });
    });
});

app.post("/mining/drink_booster", requireToken, async (req, res) => {
    const { user_uuid, boost_pct, boost_duration } = req.body;
    if (!user_uuid) return res.status(400).json({error: "missing data"});

    await withLock(user_uuid, async () => {
        let pData = await getPlayerData(user_uuid);
        let now = getUnixTime();
        let nPct = parseFloat(boost_pct) || 0.0;
        let nDur = parseInt(boost_duration) || 0;

        let current_end = parseInt(pData.BOOST_END, 10) || 0;
        let current_pct = parseFloat(pData.BOOST_PCT) || 0.0;

        if (current_end <= now) {
            pData.BOOST_PCT = nPct;
            pData.BOOST_END = now + nDur;
        } else {
            if (nPct === current_pct) {
                pData.BOOST_END = current_end + nDur;
            } else if (nPct < current_pct) {
                pData.BOOST_END = current_end + Math.round(nDur * (nPct / current_pct));
            } else {
                pData.BOOST_END = current_end + nDur;
                pData.BOOST_PCT = current_pct + ((nPct - current_pct) * 0.30);
            }
        }

        await savePlayerData(user_uuid, pData);
        res.json({ status: "OK" });
    });
});

app.post("/mining/register", requireToken, async (req, res) => {
    const { user_uuid, vein_uuid, url, max_kg, current_kg, inventory } = req.body;
    if (!user_uuid || !vein_uuid || !url) return res.status(400).json({error: "missing data"});

    await withLock(`VEIN_${user_uuid}`, async () => {
        let playerLimit = 3; 
        try {
            let limitsRow = await dbGet("VEIN_LIMITS");
            if (limitsRow) {
                let limitsData = JSON.parse(limitsRow);
                if (limitsData[user_uuid] !== undefined) playerLimit = parseInt(limitsData[user_uuid]);
            }
        } catch(e){}

        let pVeins = [];
        let row = await dbGet(`veins_${user_uuid}`);
        if (row) { try { pVeins = JSON.parse(row); } catch(e){} }

        let aliveVeins = [];
        let deadVeins = [];
        let exactMatch = null;

        for (let v of pVeins) {
            if (v.uuid === vein_uuid) {
                exactMatch = v; 
                continue; 
            }
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2000);
                const pingRes = await fetch(v.url + "/ping", { method: "GET", signal: controller.signal });
                clearTimeout(timeoutId);

                if (pingRes.status === 200) {
                    aliveVeins.push(v);
                } else {
                    deadVeins.push(v);
                    fetch(v.url + "/die", { method: "POST" }).catch(()=>null);
                }
            } catch(e) {
                deadVeins.push(v);
                fetch(v.url + "/die", { method: "POST" }).catch(()=>null);
            }
        }

        if (aliveVeins.length >= playerLimit && !exactMatch) {
            return res.json({ status: "DENIED", message: `Max ${playerLimit} veins allowed for your account.` });
        }

        if (exactMatch) {
            let restoredVein = exactMatch;
            let newVeinObj = {
                uuid: vein_uuid,
                url: url,
                max: restoredVein.max,
                cur: restoredVein.cur,
                inventory: restoredVein.inventory 
            };
            aliveVeins.push(newVeinObj);
            let finalVeins = aliveVeins.concat(deadVeins);
            await dbSet(`veins_${user_uuid}`, JSON.stringify(finalVeins));

            return res.json({ status: "RESTORE", inventory: restoredVein.inventory, max_kg: restoredVein.max, current_kg: restoredVein.cur });
        }
        else if (deadVeins.length > 0) {
            let restoredVein = deadVeins.shift(); 
            let newVeinObj = {
                uuid: vein_uuid,
                url: url,
                max: restoredVein.max,
                cur: restoredVein.cur,
                inventory: restoredVein.inventory
            };
            aliveVeins.push(newVeinObj);
            let finalVeins = aliveVeins.concat(deadVeins);
            await dbSet(`veins_${user_uuid}`, JSON.stringify(finalVeins));

            return res.json({ status: "RESTORE", inventory: restoredVein.inventory, max_kg: restoredVein.max, current_kg: restoredVein.cur });
        } else {
            let newVeinObj = {
                uuid: vein_uuid,
                url: url,
                max: parseFloat(max_kg),
                cur: parseFloat(current_kg),
                inventory: inventory
            };
            aliveVeins.push(newVeinObj);
            await dbSet(`veins_${user_uuid}`, JSON.stringify(aliveVeins));

            return res.json({ status: "NEW" });
        }
    });
});

app.post("/mining/update", requireToken, async (req, res) => {
    const { user_uuid, vein_uuid, current_kg, max_kg, inventory } = req.body;
    if (!user_uuid || !vein_uuid) return res.status(400).json({error: "missing data"});

    await withLock(`VEIN_${user_uuid}`, async () => {
        let pVeins = [];
        let row = await dbGet(`veins_${user_uuid}`);
        if (row) { try { pVeins = JSON.parse(row); } catch(e){} }

        let found = false;
        for (let v of pVeins) {
            if (v.uuid === vein_uuid) {
                if (current_kg !== undefined) v.cur = parseFloat(current_kg);
                if (max_kg !== undefined) v.max = parseFloat(max_kg);
                if (inventory !== undefined) v.inventory = inventory; 
                found = true;
                break;
            }
        }
        if (found) await dbSet(`veins_${user_uuid}`, JSON.stringify(pVeins));
        res.json({ status: "OK" });
    });
});

app.post("/mining/admin_reset", requireToken, async (req, res) => {
    await doDailyVeinReset();
    res.json({ status: "OK", message: "Manual global reset of depleted veins triggered." });
});

// ========================================================
// GACHA & JELLY ENDPOINTS
// ========================================================

app.post("/gacha/set-price", requireToken, async (req, res) => {
  const { part, price } = req.body;
  let val = parseInt(price);
  if (!part || isNaN(val) || val < 0) return res.status(400).json({error: "invalid"});
  GACHA_PRICES[part] = val;
  await dbSet("GACHA_PRICES", JSON.stringify(GACHA_PRICES));
  res.json({status: "success", message: `Price for ${part} set to ${val} Jelly.`});
});

app.get("/gacha/prices", async (req, res) => {
  const { uuid } = req.query;
  let player = await getPlayerData(uuid);
  res.json({ status: "success", jelly: player.JELLY, prices: GACHA_PRICES });
});

app.post("/gacha/buy-jelly", requireToken, async (req, res) => {
  const { user_uuid, amount } = req.body;
  let added = parseInt(amount) || 0;
  if (!user_uuid || added <= 0) return res.status(400).json({error: "invalid"});
  await withLock(user_uuid, async () => {
    let player = await getPlayerData(user_uuid);
    player.JELLY += added;
    await savePlayerData(user_uuid, player);
    res.json({status: "success", balance: player.JELLY, added});
  });
});

app.post("/gacha/buy-potion", requireToken, async (req, res) => {
  const { user_uuid, item } = req.body;
  if (!user_uuid || !item) return res.status(400).json({error: "missing data"});

  await withLock(user_uuid, async () => {
    let player = await getPlayerData(user_uuid);
    let price = GACHA_PRICES[item] !== undefined ? GACHA_PRICES[item] : 5;

    if (player.JELLY < price) {
      return res.json({ status: "insufficient", message: `Not enough Jelly. You need ${price} Jelly.` });
    }

    player.JELLY -= price;
    await savePlayerData(user_uuid, player);

    res.json({ status: "success", item, balance: player.JELLY });
  });
});

app.post("/gacha/add-texture", requireToken, async (req, res) => {
  const { part, uuid, name } = req.body;
  if (!part || !uuid || !name) return res.status(400).json({ error: "missing part, uuid, or name" });

  const validParts = Object.keys(GACHA_LISTS);
  if (!validParts.includes(part)) return res.status(400).json({ error: "invalid part name" });

  await withLock("GACHA_LIST_LOCK", async () => {
    const safeName = name.toLowerCase();
    GACHA_LISTS[part] = GACHA_LISTS[part].filter(item => typeof item === 'object' ? item.name !== safeName : item !== uuid);
    GACHA_LISTS[part].push({ name: safeName, uuid });
    await dbSet(`GACHA_${part.toUpperCase()}`, JSON.stringify(GACHA_LISTS[part]));
    res.json({ status: "success", message: `Texture '${safeName}' added to ${part}` });
  });
});

app.post("/gacha/remove-texture", requireToken, async (req, res) => {
  const { part, name } = req.body;
  if (!part || !name) return res.status(400).json({ error: "missing part or name" });

  const validParts = Object.keys(GACHA_LISTS);
  if (!validParts.includes(part)) return res.status(400).json({ error: "invalid part name" });

  await withLock("GACHA_LIST_LOCK", async () => {
    const safeName = name.toLowerCase();
    const initialLength = GACHA_LISTS[part].length;
    GACHA_LISTS[part] = GACHA_LISTS[part].filter(item => typeof item === 'object' && item.name !== safeName);

    if (GACHA_LISTS[part].length < initialLength) {
      await dbSet(`GACHA_${part.toUpperCase()}`, JSON.stringify(GACHA_LISTS[part]));
      res.json({ status: "success", message: `Texture '${safeName}' removed from ${part}` });
    } else {
      res.json({ status: "error", message: `Texture '${safeName}' not found in ${part}` });
    }
  });
});

app.post("/gacha/reroll", requireToken, async (req, res) => {
  const { object_uuid, user_uuid, part, col_up, col_down } = req.body;
  if (!object_uuid || !user_uuid || part === undefined) return res.status(400).json({error: "missing data"});

  const partNames = ["pattern", "base", "color_down", "color_up", "eyes", "mouths", "outline"];
  const partIdx = parseInt(part);
  const partName = partNames[partIdx];
  if (!partName) return res.status(400).json({error: "invalid part"});

  await withLock(user_uuid, async () => {
    let player = await getPlayerData(user_uuid);
    let price = GACHA_PRICES[partName] !== undefined ? GACHA_PRICES[partName] : 10;

    if (player.JELLY < price) {
      return res.json({ status: "insufficient", message: "Not enough Jelly to reroll this part.", price, balance: player.JELLY });
    }

    player.JELLY -= price;
    await savePlayerData(user_uuid, player);

    let upLum = parseVecToLum(col_up || "<0.5, 0.5, 0.5>");
    let downLum = parseVecToLum(col_down || "<0.5, 0.5, 0.5>");
    let avgLum = (upLum + downLum) / 2.0;

    const getTex = (p) => {
      const list = GACHA_LISTS[p];
      if (!list || list.length === 0) return DEFAULT_TEXTURE;
      const item = list[Math.floor(Math.random() * list.length)];
      return typeof item === "string" ? item : item.uuid;
    };

    let newCol, newTex;
    if (partIdx === 0) { newCol = generateColor(avgLum); newTex = getTex("pattern"); }
    else if (partIdx === 1) { newCol = generateColor(-1); newTex = "NULL"; }
    else if (partIdx === 2) { newCol = generateColor(-1); newTex = getTex("color_down"); }
    else if (partIdx === 3) { newCol = generateColor(-1); newTex = getTex("color_up"); }
    else if (partIdx === 4) { newCol = generateColor(upLum); newTex = getTex("eyes"); }
    else if (partIdx === 5) { newCol = generateColor(downLum); newTex = getTex("mouths"); }
    else if (partIdx === 6) { newCol = generateColor(avgLum); newTex = getTex("outline"); }

    res.json({
      status: "success", object_uuid, part: partIdx, tex: newTex, col: newCol.vec, balance: player.JELLY
    });
  });
});

app.post("/gacha/build", requireToken, async (req, res) => {
  const { object_uuid } = req.body;
  if (!object_uuid) return res.status(400).json({ error: "missing object_uuid" });

  const getTex = (part) => {
    const list = GACHA_LISTS[part];
    if (!list || list.length === 0) return DEFAULT_TEXTURE;
    const item = list[Math.floor(Math.random() * list.length)];
    return typeof item === "string" ? item : item.uuid; 
  };

  const baseColor = generateColor(-1);
  const colUp = generateColor(-1);
  const colDown = generateColor(-1);

  const eyesColor = generateColor(colUp.lum);
  const mouthColor = generateColor(colDown.lum);

  const avgLum = (colUp.lum + colDown.lum) / 2.0;
  const patternColor = generateColor(avgLum);
  const outlineColor = generateColor(avgLum);

  const config = {
    tex_0: getTex("pattern"), col_0: patternColor.vec,
    tex_1: "NULL", col_1: baseColor.vec,
    tex_2: getTex("color_down"), col_2: colDown.vec,
    tex_3: getTex("color_up"), col_3: colUp.vec,
    tex_4: getTex("eyes"), col_4: eyesColor.vec,
    tex_5: getTex("mouths"), col_5: mouthColor.vec,
    tex_6: getTex("outline"), col_6: outlineColor.vec
  };

  res.json({ status: "success", object_uuid, config });
});

// ========================================================
// LED OUTDOOR ENDPOINTS
// ========================================================

// 1. Chunked active ad UUIDs for the LED Outdoor
app.get("/outdoor/ads", async (req, res) => {
  await pruneAllOutdoorPlans();
  const activeAds = getActiveOutdoorAdsList();
  const totalAds = activeAds.length;

  if (totalAds === 0) {
    return res.json({ status: "OK", chunk: 1, totalChunks: 1, totalAds: 0, value: "" });
  }

  const totalChunks = Math.ceil(totalAds / OUTDOOR_CHUNK_SIZE);
  let chunk = parseInt(req.query.chunk, 10) || 1;
  if (chunk < 1 || chunk > totalChunks) chunk = 1;

  const start = (chunk - 1) * OUTDOOR_CHUNK_SIZE;
  const slice = activeAds.slice(start, start + OUTDOOR_CHUNK_SIZE);

  res.json({
    status: "OK",
    chunk,
    totalChunks,
    totalAds,
    value: slice.join("ç")
  });
});

// 2. Payment Terminal fetches pricing + player's plans
app.get("/outdoor/player", requireToken, async (req, res) => {
  const uuid = String(req.query.uuid || "").trim().toLowerCase();
  if (!uuid) return res.status(400).json({ error: "missing uuid" });

  const acc = OUTDOOR_ACCOUNTS.get(uuid);
  const now = getUnixTime();
  let planEntries = [];

  if (acc) {
    if (pruneExpiredPlansForAccount(acc, now)) {
      await saveOutdoorAccount(acc);
    }
    planEntries = (acc.plans || []).map(p => {
      if (acc.isAdmin && p.isAdminFree) {
        return `${p.name}|ADMIN FREE`;
      }
      if (p.expiresAt > now) {
        return `${p.name}|${formatRemainingShort(p.expiresAt - now)}`;
      }
      const graceLeft = Math.max(0, (p.expiresAt + OUTDOOR_WEEK_SECONDS) - now);
      return `${p.name}|EXP (del ${formatRemainingShort(graceLeft)})`;
    });
  }

  res.json({
    status: "OK",
    weeklyPrice: OUTDOOR_CONFIG.weeklyPrice,
    maxImagesPerPlan: OUTDOOR_CONFIG.maxImagesPerPlan,
    hasPassword: Boolean(acc && acc.password),
    plans: planEntries.join("ç")
  });
});

// 3. Payment Terminal registers new plan or renewal
app.post("/outdoor/pay", requireToken, async (req, res) => {
  const { uuid, legacyName, planName, weeks, autoPassword } = req.body;
  const cleanUuid = String(uuid || "").trim().toLowerCase();
  const cleanName = normalizeLegacyName(legacyName);
  const cleanPlan = stripControlChars(planName || "").replace(/[ç|"#<>]/g, "").trim();
  const numWeeks = parseInt(weeks, 10) || 0;

  if (!cleanUuid || !cleanPlan || numWeeks < 1 || numWeeks > 4) {
    return res.status(400).json({ status: "ERROR", message: "Invalid payment payload." });
  }

  await withLock(`OUTDOOR_${cleanUuid}`, async () => {
    const now = getUnixTime();
    let acc = OUTDOOR_ACCOUNTS.get(cleanUuid);
    let isNewPassword = false;

    if (!acc) {
      acc = {
        uuid: cleanUuid,
        legacyName: cleanName || cleanUuid,
        password: String(autoPassword || "").trim(),
        isAdmin: false,
        plans: []
      };
      isNewPassword = true;
    } else {
      pruneExpiredPlansForAccount(acc, now);
      if (cleanName) acc.legacyName = cleanName;
      if (!acc.password && autoPassword) {
        acc.password = String(autoPassword).trim();
        isNewPassword = true;
      }
    }

    const addSeconds = numWeeks * OUTDOOR_WEEK_SECONDS;
    let existing = acc.plans.find(p => p.name.toLowerCase() === cleanPlan.toLowerCase());

    if (existing) {
      const baseTime = existing.expiresAt > now ? existing.expiresAt : now;
      existing.expiresAt = baseTime + addSeconds;
      existing.isAdminFree = false;
      existing.wasAdminFree = false;
      existing.updatedAt = now;
    } else {
      existing = {
        name: cleanPlan,
        expiresAt: now + addSeconds,
        isAdminFree: false,
        wasAdminFree: false,
        images: [],
        updatedAt: now
      };
      acc.plans.push(existing);
    }

    await saveOutdoorAccount(acc);

    const remainingText = formatRemainingShort(existing.expiresAt - now);
    res.json({
      status: "OK",
      isNewPassword: isNewPassword ? 1 : 0,
      password: isNewPassword ? acc.password : "",
      legacyName: acc.legacyName,
      planName: existing.name,
      remaining: remainingText
    });
  });
});

// 4. Payment Terminal changes player's password ([PASS])
app.post("/outdoor/set-password", requireToken, async (req, res) => {
  const { uuid, legacyName, password } = req.body;
  const cleanUuid = String(uuid || "").trim().toLowerCase();
  const cleanName = normalizeLegacyName(legacyName);
  const cleanPass = String(password || "").trim();

  if (!cleanUuid || cleanPass.length < 4 || cleanPass.length > 24) {
    return res.status(400).json({ status: "ERROR", message: "Password must be 4-24 characters." });
  }

  await withLock(`OUTDOOR_${cleanUuid}`, async () => {
    let acc = OUTDOOR_ACCOUNTS.get(cleanUuid);
    if (!acc) {
      acc = {
        uuid: cleanUuid,
        legacyName: cleanName || cleanUuid,
        password: cleanPass,
        isAdmin: false,
        plans: []
      };
    } else {
      if (cleanName) acc.legacyName = cleanName;
      acc.password = cleanPass;
    }

    await saveOutdoorAccount(acc);
    res.json({ status: "OK", legacyName: acc.legacyName });
  });
});

// 5. LSL Admin Panel: fetch current config & stats
app.get("/outdoor/admin/info", requireToken, async (req, res) => {
  await pruneAllOutdoorPlans();
  let adminCount = 0;
  for (const acc of OUTDOOR_ACCOUNTS.values()) {
    if (acc.isAdmin) adminCount++;
  }
  res.json({
    status: "OK",
    weeklyPrice: OUTDOOR_CONFIG.weeklyPrice,
    maxImagesPerPlan: OUTDOOR_CONFIG.maxImagesPerPlan,
    totalAccounts: OUTDOOR_ACCOUNTS.size,
    activeAds: getActiveOutdoorAdsList().length,
    adminCount
  });
});

// 6. LSL Admin Panel: update weekly price
app.post("/outdoor/admin/set-price", requireToken, async (req, res) => {
  const newPrice = parseInt(req.body.weeklyPrice, 10);
  if (isNaN(newPrice) || newPrice < 5 || newPrice > 100000) {
    return res.status(400).json({ status: "ERROR", message: "Price must be between 5 and 100000 L$." });
  }
  OUTDOOR_CONFIG.weeklyPrice = newPrice;
  await dbSet("OUTDOOR_CONFIG", JSON.stringify(OUTDOOR_CONFIG));
  res.json({ status: "OK", weeklyPrice: OUTDOOR_CONFIG.weeklyPrice });
});

// 7. LSL Admin Panel: update max images per plan
app.post("/outdoor/admin/set-max-images", requireToken, async (req, res) => {
  const newMax = parseInt(req.body.maxImagesPerPlan, 10);
  if (isNaN(newMax) || newMax < 1 || newMax > 20) {
    return res.status(400).json({ status: "ERROR", message: "Max images must be between 1 and 20." });
  }
  OUTDOOR_CONFIG.maxImagesPerPlan = newMax;
  await dbSet("OUTDOOR_CONFIG", JSON.stringify(OUTDOOR_CONFIG));
  res.json({ status: "OK", maxImagesPerPlan: OUTDOOR_CONFIG.maxImagesPerPlan });
});

// 8. LSL Admin Panel: grant Admin status + 1 free infinite plan
app.post("/outdoor/admin/set-admin", requireToken, async (req, res) => {
  const { uuid, legacyName, autoPassword } = req.body;
  const cleanUuid = String(uuid || "").trim().toLowerCase();
  const cleanName = normalizeLegacyName(legacyName);

  if (!cleanUuid || !isValidUuid(cleanUuid)) {
    return res.status(400).json({ status: "ERROR", message: "Invalid avatar UUID." });
  }

  await withLock(`OUTDOOR_${cleanUuid}`, async () => {
    const now = getUnixTime();
    let acc = OUTDOOR_ACCOUNTS.get(cleanUuid);
    let isNewPassword = false;

    if (!acc) {
      acc = {
        uuid: cleanUuid,
        legacyName: cleanName || cleanUuid,
        password: String(autoPassword || "").trim(),
        isAdmin: true,
        plans: []
      };
      isNewPassword = true;
    } else {
      pruneExpiredPlansForAccount(acc, now);
      if (cleanName) acc.legacyName = cleanName;
      if (!acc.password && autoPassword) {
        acc.password = String(autoPassword).trim();
        isNewPassword = true;
      }
      acc.isAdmin = true;
    }

    // Ensure admin has 1 free infinite plan
    let freePlan = acc.plans.find(p => p.isAdminFree);
    if (!freePlan) {
      // Restore previously revoked admin plan if still inside its 1-week grace window
      let prevFree = acc.plans.find(p => p.wasAdminFree);
      if (prevFree) {
        prevFree.isAdminFree = true;
        prevFree.wasAdminFree = false;
        prevFree.expiresAt = 0;
        prevFree.updatedAt = now;
        freePlan = prevFree;
      } else {
        // Pick a unique plan name (<= 7 chars)
        let baseName = "ADMIN";
        let counter = 1;
        while (acc.plans.some(p => p.name.toLowerCase() === baseName.toLowerCase())) {
          baseName = `ADM${counter}`;
          counter++;
        }
        freePlan = {
          name: baseName,
          expiresAt: 0,
          isAdminFree: true,
          wasAdminFree: false,
          images: [],
          updatedAt: now
        };
        acc.plans.push(freePlan);
      }
    }

    await saveOutdoorAccount(acc);

    res.json({
      status: "OK",
      uuid: acc.uuid,
      legacyName: acc.legacyName,
      password: acc.password,
      isNewPassword: isNewPassword ? 1 : 0,
      freePlanName: freePlan.name
    });
  });
});

// 9. LSL Admin Panel: list all current admins
app.get("/outdoor/admin/list-admins", requireToken, (req, res) => {
  const entries = [];
  for (const acc of OUTDOOR_ACCOUNTS.values()) {
    if (acc.isAdmin) {
      entries.push(`${acc.uuid}|${acc.legacyName}`);
    }
  }
  res.json({
    status: "OK",
    count: entries.length,
    admins: entries.join("ç")
  });
});

// 10. LSL Admin Panel: revoke Admin status (free plan enters 1-week payment grace period)
app.post("/outdoor/admin/unset-admin", requireToken, async (req, res) => {
  const cleanUuid = String(req.body.uuid || "").trim().toLowerCase();
  if (!cleanUuid) return res.status(400).json({ status: "ERROR", message: "Missing UUID." });

  await withLock(`OUTDOOR_${cleanUuid}`, async () => {
    const acc = OUTDOOR_ACCOUNTS.get(cleanUuid);
    if (!acc) return res.status(404).json({ status: "ERROR", message: "Account not found." });

    const now = getUnixTime();
    acc.isAdmin = false;

    for (const p of (acc.plans || [])) {
      if (p.isAdminFree) {
        p.isAdminFree = false;
        p.wasAdminFree = true;
        p.expiresAt = now; // Immediately stops showing on outdoor; 7-day deletion clock starts now
        p.updatedAt = now;
      }
    }

    await saveOutdoorAccount(acc);
    res.json({ status: "OK", uuid: acc.uuid, legacyName: acc.legacyName });
  });
});

// 11. Website: login (normal or as Admin)
app.post("/outdoor/web/login", async (req, res) => {
  const { legacyName, password, asAdmin } = req.body;
  const lookup = normalizeLegacyName(legacyName).toLowerCase();
  const pass = String(password || "").trim();

  if (!lookup || !pass) {
    return res.status(400).json({ status: "ERROR", message: "Please enter your Legacy Name and Password." });
  }

  const uuid = OUTDOOR_NAME_MAP.get(lookup);
  if (!uuid) {
    return res.status(401).json({ status: "ERROR", message: "Account not found. Use the in-world terminal first." });
  }

  const acc = OUTDOOR_ACCOUNTS.get(uuid);
  if (!acc || acc.password !== pass) {
    return res.status(401).json({ status: "ERROR", message: "Invalid password." });
  }

  if (asAdmin && !acc.isAdmin) {
    return res.status(403).json({ status: "ERROR", message: "Access denied. This account does not have Admin status." });
  }

  const now = getUnixTime();
  if (pruneExpiredPlansForAccount(acc, now)) {
    await saveOutdoorAccount(acc);
  }

  res.json({
    status: "OK",
    legacyName: acc.legacyName,
    isAdmin: Boolean(acc.isAdmin),
    adminMode: Boolean(asAdmin && acc.isAdmin),
    maxImagesPerPlan: OUTDOOR_CONFIG.maxImagesPerPlan,
    plans: (acc.plans || []).map(p => serializePlanForClient(p, acc.isAdmin, now))
  });
});

// 12. Website: live session & admin status check (auto-kick heartbeat + Admin Mode toggle)
app.post("/outdoor/web/status", (req, res) => {
  const { legacyName, password } = req.body;
  const lookup = normalizeLegacyName(legacyName).toLowerCase();
  const pass = String(password || "").trim();

  const uuid = OUTDOOR_NAME_MAP.get(lookup);
  const acc = uuid ? OUTDOOR_ACCOUNTS.get(uuid) : null;
  if (!acc || acc.password !== pass) {
    return res.status(401).json({ status: "ERROR", message: "Invalid session." });
  }

  res.json({
    status: "OK",
    isAdmin: Boolean(acc.isAdmin),
    maxImagesPerPlan: OUTDOOR_CONFIG.maxImagesPerPlan
  });
});

// 13. Website: player updates up to maxImagesPerPlan image UUIDs + optional validated links
app.post("/outdoor/web/update-images", async (req, res) => {
  const { legacyName, password, planName, images } = req.body;
  const lookup = normalizeLegacyName(legacyName).toLowerCase();
  const pass = String(password || "").trim();

  const uuid = OUTDOOR_NAME_MAP.get(lookup);
  const accCheck = uuid ? OUTDOOR_ACCOUNTS.get(uuid) : null;
  if (!accCheck || accCheck.password !== pass) {
    return res.status(401).json({ status: "ERROR", message: "Invalid credentials." });
  }

  if (!Array.isArray(images)) {
    return res.status(400).json({ status: "ERROR", message: "Invalid images payload." });
  }

  const cleanImages = [];
  for (let i = 0; i < images.length; i++) {
    const raw = images[i];
    const rawUuid = typeof raw === "string" ? raw.trim() : String(raw?.uuid || "").trim();
    const rawLink = typeof raw === "string" ? "" : String(raw?.link || "").trim();

    if (!rawUuid && !rawLink) continue;

    if (!rawUuid && rawLink) {
      return res.status(400).json({ status: "ERROR", message: `Slot #${i + 1} has a link but no Texture UUID.` });
    }
    if (!isValidUuid(rawUuid)) {
      return res.status(400).json({ status: "ERROR", message: `Invalid Texture UUID in slot #${i + 1}: ${rawUuid}` });
    }
    if (rawLink && !isValidAdLink(rawLink)) {
      return res.status(400).json({
        status: "ERROR",
        message: `Invalid link in slot #${i + 1}. Must be a valid http://, https://, or secondlife:// URL (max ${OUTDOOR_MAX_LINK_LEN} chars, no spaces).`
      });
    }

    cleanImages.push({
      uuid: rawUuid.toLowerCase(),
      link: rawLink
    });
  }

  if (cleanImages.length > OUTDOOR_CONFIG.maxImagesPerPlan) {
    return res.status(400).json({
      status: "ERROR",
      message: `Each plan supports up to ${OUTDOOR_CONFIG.maxImagesPerPlan} images.`
    });
  }

  await withLock(`OUTDOOR_${uuid}`, async () => {
    const now = getUnixTime();
    const acc = OUTDOOR_ACCOUNTS.get(uuid);
    pruneExpiredPlansForAccount(acc, now);

    const plan = (acc.plans || []).find(p => p.name.toLowerCase() === String(planName || "").toLowerCase());
    if (!plan) {
      return res.status(404).json({ status: "ERROR", message: "Plan not found or already deleted." });
    }

    plan.images = cleanImages;
    plan.updatedAt = now;
    await saveOutdoorAccount(acc);

    res.json({
      status: "OK",
      planName: plan.name,
      images: plan.images,
      maxImagesPerPlan: OUTDOOR_CONFIG.maxImagesPerPlan
    });
  });
});

// 14. Website Admin Mode: list all players and their plans
app.post("/outdoor/web/admin/players", async (req, res) => {
  const { legacyName, password } = req.body;
  const lookup = normalizeLegacyName(legacyName).toLowerCase();
  const pass = String(password || "").trim();

  const uuid = OUTDOOR_NAME_MAP.get(lookup);
  const adminAcc = uuid ? OUTDOOR_ACCOUNTS.get(uuid) : null;
  if (!adminAcc || adminAcc.password !== pass) {
    return res.status(401).json({ status: "ERROR", message: "Unauthorized." });
  }
  if (!adminAcc.isAdmin) {
    return res.status(403).json({ status: "ADMIN_REVOKED", message: "Your Admin privileges were revoked." });
  }

  await pruneAllOutdoorPlans();
  const now = getUnixTime();
  const players = [];

  for (const acc of OUTDOOR_ACCOUNTS.values()) {
    players.push({
      uuid: acc.uuid,
      legacyName: acc.legacyName,
      isAdmin: Boolean(acc.isAdmin),
      plans: (acc.plans || []).map(p => serializePlanForClient(p, acc.isAdmin, now))
    });
  }

  players.sort((a, b) => a.legacyName.localeCompare(b.legacyName));
  res.json({
    status: "OK",
    maxImagesPerPlan: OUTDOOR_CONFIG.maxImagesPerPlan,
    players
  });
});

// 15. Website Admin Mode: delete a prohibited image (and its link) from any player's plan
app.post("/outdoor/web/admin/delete-image", async (req, res) => {
  const { legacyName, password, targetUuid, planName, imageIndex, imageUuid } = req.body;
  const lookup = normalizeLegacyName(legacyName).toLowerCase();
  const pass = String(password || "").trim();

  const uuid = OUTDOOR_NAME_MAP.get(lookup);
  const adminAcc = uuid ? OUTDOOR_ACCOUNTS.get(uuid) : null;
  if (!adminAcc || adminAcc.password !== pass) {
    return res.status(401).json({ status: "ERROR", message: "Unauthorized." });
  }
  if (!adminAcc.isAdmin) {
    return res.status(403).json({ status: "ADMIN_REVOKED", message: "Your Admin privileges were revoked." });
  }

  const cleanTarget = String(targetUuid || "").trim().toLowerCase();
  await withLock(`OUTDOOR_${cleanTarget}`, async () => {
    const targetAcc = OUTDOOR_ACCOUNTS.get(cleanTarget);
    if (!targetAcc) return res.status(404).json({ status: "ERROR", message: "Target player not found." });

    const plan = (targetAcc.plans || []).find(p => p.name.toLowerCase() === String(planName || "").toLowerCase());
    if (!plan || !Array.isArray(plan.images)) {
      return res.status(404).json({ status: "ERROR", message: "Target plan not found." });
    }

    const getEntryUuid = (entry) => (typeof entry === "string" ? entry : (entry?.uuid || "")).toLowerCase();
    const targetImgUuid = String(imageUuid || "").toLowerCase();
    const idx = parseInt(imageIndex, 10);

    if (!isNaN(idx) && idx >= 0 && idx < plan.images.length && (!targetImgUuid || getEntryUuid(plan.images[idx]) === targetImgUuid)) {
      plan.images.splice(idx, 1);
    } else if (targetImgUuid) {
      const foundIdx = plan.images.findIndex(entry => getEntryUuid(entry) === targetImgUuid);
      if (foundIdx !== -1) plan.images.splice(foundIdx, 1);
    }

    plan.updatedAt = getUnixTime();
    await saveOutdoorAccount(targetAcc);

    res.json({
      status: "OK",
      targetUuid: cleanTarget,
      planName: plan.name,
      images: plan.images
    });
  });
});
///////////////////////////////////////////////////////////////////

// ========================================================
// STREET CONQUESTERS — FACTION, TERRITORY, ALLIANCES, SHIELD, NEWS & BLACKLIST
// ========================================================
const FACTIONS = new Map();                 // factionId -> factionObj
const FACTION_BY_MEMBER = new Map();        // memberUuid -> factionId
const FACTION_BY_LEADER_NAME = new Map();   // leaderLegacyNameLower -> factionId
const FACTION_BY_PERM_ID = new Map();       // permId (hash imutável) -> factionId
const FACTION_PARCELS = new Map();          // parcelUuid -> parcelObj
const FACTION_CONQUER_DEBOUNCE = new Map(); // parcelUuid -> { factionId, time }

// Novos sistemas: Alianças, Capturas ao Vivo, Notícias e Blacklist
const ALLIANCES = new Map();                // allianceId -> { id, members: [permId], kickVotes: {}, createdAt }
const ALLIANCE_BY_PERM_ID = new Map();      // permId -> allianceId
let ALLIANCE_INVITES = [];                  // [{ id, fromPermId, toPermId, allianceId, createdAt }]

const FACTION_ACTIVE_CAPTURES = new Map();  // parcelUuid -> captura/ataque em andamento
const FACTION_NEWS_DEBOUNCE = new Map();    // key -> unixTime
let FACTION_NEWS = [];                      // [{ id, type, text, regionName, parcelUuid, time }]
const FACTION_BLACKLIST = new Map();        // parcelUuid -> { parcelUuid, regionName, reason, addedAt }
const FACTION_WEB_SESSIONS = new Map();     // token -> { token, deviceHash, facId, leaderUuid, passwordSnapshot, expiresAt }
const FACTION_REMEMBER_SECONDS = 7 * 24 * 3600; // 7 dias
// --------------------------------------------------------
// CONFIGURAÇÕES DE BALANCEAMENTO (fácil de ajustar depois)
// --------------------------------------------------------
const FACTION_BASE_SQM_LIMIT = 4096;        // Limite no Nível 0
const FACTION_SQM_PER_LEVEL  = 1024;        // +1024 sqm a cada nível
const FACTION_SHIELD_SECONDS = 6 * 3600;    // 6 horas de Escudo de Pós-Conquista (21600s)
const FACTION_CAPTURE_TTL    = 15;          // Segundos sem sinal para encerrar o piscar no mapa
const FACTION_NEWS_MAX_ITEMS = 5;          // Máximo de notícias guardadas para o mural

const FACTION_XP_PER_1K_ALLY    = 8.0;      // Pouco XP (mesma facção ou aliada)
const FACTION_XP_PER_1K_NEUTRAL = 20.0;     // XP médio (vendedor sem facção)
const FACTION_XP_PER_1K_RIVAL   = 40.0;     // Bastante XP (vendedor rival)
const FACTION_ALLY_CARGO_BONUS_MULT = 0.25; // Aliado ganha só 25% do bônus normal no terreno aliado (incentiva ser rival)
const FACTION_MAX_RIVAL_PENALTY_PCT = 60.0; // Máximo de perda de carga em território rival

// Short 10-char password hashed from uuid + unixTime + GFNF
function generateFactionPassword(avatarUuid, unixTime) {
  return crypto
    .createHash("md5")
    .update(`${String(avatarUuid).trim().toLowerCase()}${unixTime}GFNF`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
}

// ID imutável da facção (hash do nome + unix time de criação/reset) — usado nas alianças
function generateFactionPermId(factionName, unixTime) {
  return crypto
    .createHash("sha256")
    .update(`${String(factionName || "").trim().toLowerCase()}|${unixTime}|SC_PERM_ID`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

function sanitizeFactionName(raw) {
  if (!raw) return "";
  return stripControlChars(raw).replace(/[ç|#<>"]/g, "").trim().slice(0, 32);
}

function sanitizeFactionLogo(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s || s.toUpperCase() === "NONE" || s.toUpperCase() === "CLEAR") return "";
  if (isValidUuid(s)) return s.toLowerCase();
  if (isValidAdLink(s)) return s;
  return null;
}

// --------------------------------------------------------
// MURAL DE NOTÍCIAS (TV CRIME TICKER)
// --------------------------------------------------------
async function pushFactionNews(type, text, meta = {}) {
  const now = getUnixTime();
  if (meta.debounceKey) {
    const last = FACTION_NEWS_DEBOUNCE.get(meta.debounceKey) || 0;
    if ((now - last) < (meta.debounceSec || 90)) return;
    FACTION_NEWS_DEBOUNCE.set(meta.debounceKey, now);
  }

  const cleanParcel  = meta.parcelUuid ? String(meta.parcelUuid).toLowerCase() : "";
  const cleanFacId   = meta.factionId ? String(meta.factionId) : "";
  const cleanFacName = meta.factionName ? String(meta.factionName).toLowerCase() : "";

  // Remove notícias anteriores da MESMA gangue na MESMA parcela
  if (cleanParcel && (cleanFacId || cleanFacName)) {
    FACTION_NEWS = FACTION_NEWS.filter(n => {
      if (String(n.parcelUuid || "").toLowerCase() !== cleanParcel) return true;
      if (cleanFacId && n.factionId && n.factionId === cleanFacId) return false;
      if (!n.factionId && cleanFacName && String(n.text || "").toLowerCase().includes(cleanFacName)) return false;
      return true;
    });
  }

  const item = {
    id: `n_${now}_${crypto.randomBytes(2).toString("hex")}`,
    type: String(type || "INFO"),
    text: String(text || "").slice(0, 220),
    regionName: meta.regionName || "",
    parcelUuid: cleanParcel,
    factionId: cleanFacId,
    time: now
  };

  FACTION_NEWS.unshift(item);
  if (FACTION_NEWS.length > FACTION_NEWS_MAX_ITEMS) {
    FACTION_NEWS = FACTION_NEWS.slice(0, FACTION_NEWS_MAX_ITEMS);
  }
  await dbSet("FACTION_NEWS", JSON.stringify(FACTION_NEWS));
}

// --------------------------------------------------------
// BLACKLIST DE PARCELAS
// --------------------------------------------------------
async function saveFactionBlacklist() {
  await dbSet("FACTION_BLACKLIST", JSON.stringify(Array.from(FACTION_BLACKLIST.values())));
}
function getClientDeviceHash(req) {
  const rawIp = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const ua = String(req.headers["user-agent"] || "").trim();
  if (!rawIp && !ua) return "";
  return crypto.createHash("sha256").update(`${rawIp}|${ua}|SC_DEV`).digest("hex").slice(0, 32);
}

async function saveFactionWebSessions() {
  const now = getUnixTime();
  const valid = [];
  for (const [k, s] of FACTION_WEB_SESSIONS.entries()) {
    if ((s.expiresAt || 0) > now) valid.push(s);
    else FACTION_WEB_SESSIONS.delete(k);
  }
  await dbSet("FACTION_WEB_SESSIONS", JSON.stringify(valid));
}

function buildLeaderFactionPayload(fac) {
  const now = getUnixTime();
  const parcels = [];
  for (const p of FACTION_PARCELS.values()) {
    if (p.factionId === fac.id) {
      parcels.push({
        ...p,
        shieldRemaining: Math.max(0, (p.shieldUntil || 0) - now)
      });
    }
  }
  return {
    ...serializeFactionPublic(fac),
    members: Object.values(fac.members || {}),
    parcels,
    alliance: serializeAllianceForLeader(fac)
  };
}
// --------------------------------------------------------
// CAPTURAS ATIVAS (PISCAR ROSA/ROXO NO MAPA + ALERTA DE ATAQUE)
// --------------------------------------------------------
function reportFailedCapture(cap) {
  if (!cap || !cap.attackerFacName) return;
  const pName = cap.parcelName || "Parcel";
  const reg = cap.regionName || "Unknown Region";
  let text = "";

  if (cap.isNeutral) {
    text = `❌ ${cap.attackerFacName} tried to take control of "${pName}" in ${reg}, but failed!`;
  } else if (cap.isAllySteal && cap.defenderFacName) {
    text = `🛡 ${cap.attackerFacName} tried to steal "${pName}" in ${reg} from ally ${cap.defenderFacName}, but failed!`;
  } else if (cap.defenderFacName) {
    text = `🛡 ${cap.attackerFacName} tried to take control of "${pName}" in ${reg} from ${cap.defenderFacName}, but failed!`;
  } else {
    text = `❌ ${cap.attackerFacName} tried to take control of "${pName}" in ${reg}, but failed!`;
  }

  FACTION_NEWS_DEBOUNCE.delete(`cap_${cap.parcelUuid}_${cap.attackerFacId}`);

  pushFactionNews("CAPTURE_FAILED", text, {
    regionName: reg,
    parcelUuid: cap.parcelUuid || "",
    factionId: cap.attackerFacId || "",
    factionName: cap.attackerFacName || "",
    debounceKey: `fail_${cap.parcelUuid}_${cap.attackerFacId}`,
    debounceSec: 15
  }).catch(() => {});
}

function pruneStaleActiveCaptures() {
  const now = getUnixTime();
  for (const [pUuid, cap] of FACTION_ACTIVE_CAPTURES.entries()) {
    if ((now - (cap.lastPingAt || 0)) > FACTION_CAPTURE_TTL) {
      FACTION_ACTIVE_CAPTURES.delete(pUuid);
      reportFailedCapture(cap);
    }
  }
}
setInterval(pruneStaleActiveCaptures, 15000);

// --------------------------------------------------------
// HELPERS DE LEVEL, XP E ALIANÇAS
// --------------------------------------------------------
function getFactionXpStep(level) {
  return Math.round(50 * Math.pow(1.35, level));
}

function computeFactionLevelInfo(totalXp) {
  const safeTotal = Math.max(0, Number(totalXp) || 0);
  let remaining = safeTotal;
  let level = 0;
  let needed = getFactionXpStep(level);

  while (remaining >= needed && level < 500) {
    remaining -= needed;
    level++;
    needed = getFactionXpStep(level);
  }

  const maxSqm = FACTION_BASE_SQM_LIMIT + (level * FACTION_SQM_PER_LEVEL);
  return {
    level,
    totalXp: Math.round(safeTotal * 100) / 100,
    currentLevelXp: Math.round(remaining * 100) / 100,
    nextLevelXp: needed,
    progressPct: Math.min(100, Math.round((remaining / needed) * 1000) / 10),
    maxSqm
  };
}

function getFactionTerritoryStats(factionId, excludeParcelUuid = "") {
  let parcelCount = 0;
  let totalArea = 0;
  const ex = String(excludeParcelUuid || "").toLowerCase();
  for (const p of FACTION_PARCELS.values()) {
    if (p.factionId === factionId && p.parcelUuid !== ex) {
      parcelCount++;
      totalArea += Number(p.area) || 0;
    }
  }
  return { parcelCount, totalArea };
}

function getFactionByPermId(permId) {
  const facId = FACTION_BY_PERM_ID.get(String(permId || "").toUpperCase());
  return facId ? FACTIONS.get(facId) : null;
}

function getFactionAlliance(facOrPermId) {
  const permId = typeof facOrPermId === "string" ? facOrPermId : facOrPermId?.permId;
  if (!permId) return null;
  const allyId = ALLIANCE_BY_PERM_ID.get(permId);
  return allyId ? (ALLIANCES.get(allyId) || null) : null;
}

function areFactionsAllied(facIdA, facIdB) {
  if (!facIdA || !facIdB || facIdA === facIdB) return false;
  const facA = FACTIONS.get(facIdA);
  const facB = FACTIONS.get(facIdB);
  if (!facA || !facB || !facA.permId || !facB.permId) return false;
  const allyA = ALLIANCE_BY_PERM_ID.get(facA.permId);
  const allyB = ALLIANCE_BY_PERM_ID.get(facB.permId);
  return Boolean(allyA && allyB && allyA === allyB);
}

function getAllianceMemberFactions(fac) {
  if (!fac) return [];
  const ally = getFactionAlliance(fac);
  if (!ally) return [fac];
  const list = [];
  for (const pid of (ally.members || [])) {
    const memberFac = getFactionByPermId(pid);
    if (memberFac) list.push(memberFac);
  }
  return list.length > 0 ? list : [fac];
}

function getAllianceTerritoryStats(fac) {
  const memberFacs = getAllianceMemberFactions(fac);
  let parcelCount = 0;
  let totalArea = 0;
  for (const mf of memberFacs) {
    const st = getFactionTerritoryStats(mf.id);
    parcelCount += st.parcelCount;
    totalArea += st.totalArea;
  }
  return { parcelCount, totalArea, factionCount: memberFacs.length };
}

function rebuildAllianceIndexes() {
  ALLIANCE_BY_PERM_ID.clear();
  for (const ally of ALLIANCES.values()) {
    for (const pid of (ally.members || [])) {
      ALLIANCE_BY_PERM_ID.set(pid, ally.id);
    }
  }
}

async function saveAlliance(ally) {
  ALLIANCES.set(ally.id, ally);
  rebuildAllianceIndexes();
  await dbSet(`alliance_${ally.id}`, JSON.stringify(ally));
}

async function deleteAllianceFromDb(allianceId) {
  ALLIANCES.delete(allianceId);
  rebuildAllianceIndexes();
  await db.query("DELETE FROM kvstore WHERE id=$1", [`alliance_${allianceId}`]);
}

async function saveAllianceInvites() {
  await dbSet("FACTION_ALLIANCE_INVITES", JSON.stringify(ALLIANCE_INVITES));
}

async function removePermIdFromAlliancesAndInvites(permId) {
  if (!permId) return;

  // Limpa convites envolvendo esta facção
  const beforeLen = ALLIANCE_INVITES.length;
  ALLIANCE_INVITES = ALLIANCE_INVITES.filter(inv => inv.fromPermId !== permId && inv.toPermId !== permId);
  if (ALLIANCE_INVITES.length !== beforeLen) {
    await saveAllianceInvites();
  }

  // Remove da aliança atual (se estiver em alguma)
  const ally = getFactionAlliance(permId);
  if (!ally) return;

  ally.members = (ally.members || []).filter(p => p !== permId);
  if (ally.kickVotes) {
    delete ally.kickVotes[permId];
    for (const targetPid of Object.keys(ally.kickVotes)) {
      ally.kickVotes[targetPid].voters = (ally.kickVotes[targetPid].voters || []).filter(v => v !== permId);
      if (ally.kickVotes[targetPid].voters.length === 0) {
        delete ally.kickVotes[targetPid];
      }
    }
  }

  if (ally.members.length < 2) {
    await deleteAllianceFromDb(ally.id);
  } else {
    await saveAlliance(ally);
  }
}

async function grantXpToFaction(facId, xpAmount) {
  if (!facId || xpAmount <= 0) return;
  const liveFac = FACTIONS.get(facId);
  if (!liveFac) return;

  const prevInfo = computeFactionLevelInfo(liveFac.xp || 0);
  liveFac.xp = Math.round(((Number(liveFac.xp) || 0) + xpAmount) * 100) / 100;
  const newInfo = computeFactionLevelInfo(liveFac.xp);
  liveFac.level = newInfo.level;
  liveFac.updatedAt = getUnixTime();
  await saveFaction(liveFac);

  if (newInfo.level > prevInfo.level) {
    if (liveFac.leaderUuid) {
      await addPlayerMessage(
        liveFac.leaderUuid,
        `🎉 [STREET CONQUESTERS] Your faction "${liveFac.name}" reached LEVEL ${newInfo.level}! Territory capacity increased to ${newInfo.maxSqm.toLocaleString("en-US")} sqm.`
      );
    }
    await pushFactionNews(
      "LEVEL_UP",
      `⭐ ${liveFac.name} reached LEVEL ${newInfo.level} (Max turf: ${newInfo.maxSqm.toLocaleString("en-US")} sqm)!`
    );
  }
}

// --------------------------------------------------------
// INTEGRAÇÃO COM VENDA DE CARGA GFN (COM REGRAS DE ALIANÇA)
// --------------------------------------------------------
async function applyFactionCargoEffect(userUuid, parcelUuid, baseCargoValue, currentPrice) {
  const cleanParcel = String(parcelUuid || "").trim().toLowerCase();
  const cleanUser = String(userUuid || "").trim().toLowerCase();
  if (!cleanParcel || currentPrice <= 0) return currentPrice;

  const parcelObj = FACTION_PARCELS.get(cleanParcel);
  if (!parcelObj || !FACTIONS.has(parcelObj.factionId)) {
    return currentPrice; // Território neutro -> sem mudanças
  }

  const ownerFac = FACTIONS.get(parcelObj.factionId);
  const { totalArea: ownerOwnSqm } = getFactionTerritoryStats(ownerFac.id);
  const ownerAlliance = getFactionAlliance(ownerFac);
  const { totalArea: ownerAllianceSqm } = getAllianceTerritoryStats(ownerFac);

  const sellerFacId = FACTION_BY_MEMBER.get(cleanUser);
  const sellerFac = (sellerFacId && FACTIONS.has(sellerFacId)) ? FACTIONS.get(sellerFacId) : null;

  const isSameFaction = Boolean(sellerFac && sellerFac.id === ownerFac.id);
  const isAlliedFaction = Boolean(sellerFac && areFactionsAllied(sellerFac.id, ownerFac.id));

  let finalPrice = currentPrice;
  let xpRatePer1k = FACTION_XP_PER_1K_NEUTRAL;
  let sellerIsOutsideAlliance = false;

  if (isSameFaction) {
    // MESMA FACÇÃO: bônus completo (+1% por 1.000 sqm da própria facção)
    xpRatePer1k = FACTION_XP_PER_1K_ALLY;
    const bonusPct = ownerOwnSqm / 1000.0;
    const bonusAmount = Math.round(currentPrice * (bonusPct / 100.0));
    if (bonusAmount > 0) {
      finalPrice = Math.min(MAX_TRANSACTION, currentPrice + bonusAmount);
      await addPlayerMessage(
        userUuid,
        `🏴 [STREET CONQUESTERS] Friendly territory (${ownerFac.name})! +${bonusPct.toFixed(1)}% faction bonus (+${bonusAmount} F₵) from ${ownerOwnSqm.toLocaleString("en-US")} sqm controlled.`
      );
    }
  } else if (isAlliedFaction) {
    // FACÇÃO ALIADA: território amigo, mas com compensação bem menor (25% do bônus normal)
    xpRatePer1k = FACTION_XP_PER_1K_ALLY;
    const reducedBonusPct = (ownerOwnSqm / 1000.0) * FACTION_ALLY_CARGO_BONUS_MULT;
    const bonusAmount = Math.round(currentPrice * (reducedBonusPct / 100.0));
    if (bonusAmount > 0) {
      finalPrice = Math.min(MAX_TRANSACTION, currentPrice + bonusAmount);
      await addPlayerMessage(
        userUuid,
        `🤝 [STREET CONQUESTERS] Allied territory (${ownerFac.name})! Reduced allied bonus: +${reducedBonusPct.toFixed(2)}% (+${bonusAmount} F₵).`
      );
    } else {
      await addPlayerMessage(
        userUuid,
        `🤝 [STREET CONQUESTERS] Allied territory (${ownerFac.name})! Safe passage (no rival cargo tax).`
      );
    }
  } else if (sellerFac) {
    // FACÇÃO RIVAL (FORA DA ALIANÇA): compara SQM da aliança/facção do vendedor vs dona do terreno
    xpRatePer1k = FACTION_XP_PER_1K_RIVAL;
    sellerIsOutsideAlliance = true;
    const { totalArea: sellerPowerSqm } = getAllianceTerritoryStats(sellerFac);

    if (sellerPowerSqm >= ownerAllianceSqm) {
      await addPlayerMessage(
        userUuid,
        `🛡 [STREET CONQUESTERS] Rival territory (${ownerFac.name}), but your territorial power (${sellerPowerSqm.toLocaleString("en-US")} sqm) neutralized their cargo tax!`
      );
    } else {
      const sqmDiff = ownerAllianceSqm - sellerPowerSqm;
      const penaltyPct = Math.min(FACTION_MAX_RIVAL_PENALTY_PCT, sqmDiff / 1000.0);
      const penaltyAmount = Math.round(currentPrice * (penaltyPct / 100.0));
      if (penaltyAmount > 0) {
        finalPrice = Math.max(0, currentPrice - penaltyAmount);
        await addPlayerMessage(
          userUuid,
          `⚔ [STREET CONQUESTERS] Rival territory (${ownerFac.name})! -${penaltyPct.toFixed(1)}% cargo tax (-${penaltyAmount} F₵) due to territorial disadvantage (${sellerPowerSqm.toLocaleString("en-US")} vs ${ownerAllianceSqm.toLocaleString("en-US")} sqm).`
        );
      }
    }
  } else {
    // VENDEDOR NEUTRO (sem facção): valor da carga normal, XP médio para a dona + split reduzido para aliadas
    xpRatePer1k = FACTION_XP_PER_1K_NEUTRAL;
    sellerIsOutsideAlliance = true;
  }

  // Distribuição de XP:
  // - Dona real da parcela ganha 100% do XP normal
  // - Outras facções da aliança (quando vendedor é de fora da aliança) ganham (XP * 0.5) / totalDeFaccoesNaAlianca
  const safeBase = Math.max(0, Number(baseCargoValue) || 0);
  const xpGain = Math.round(((safeBase / 1000.0) * xpRatePer1k) * 100) / 100;

  if (xpGain > 0) {
    await withLock("FACTION_GLOBAL_LOCK", async () => {
      await grantXpToFaction(ownerFac.id, xpGain);

      if (sellerIsOutsideAlliance && ownerAlliance && Array.isArray(ownerAlliance.members) && ownerAlliance.members.length > 1) {
        const allianceSize = ownerAlliance.members.length;
        const sharedXp = Math.round(((xpGain * 0.5) / allianceSize) * 100) / 100;
        if (sharedXp > 0) {
          for (const allyPermId of ownerAlliance.members) {
            if (allyPermId === ownerFac.permId) continue;
            const allyFac = getFactionByPermId(allyPermId);
            if (allyFac) {
              await grantXpToFaction(allyFac.id, sharedXp);
            }
          }
        }
      }
    });
  }

  return finalPrice;
}

// Logarithmic thermal spectrum: 16 sqm (cold blue #0A2EFF) -> 65,536 sqm (hot red #F50A0A)
function computeParcelThermalColor(areaSqm) {
  const clamped = Math.max(16, Math.min(65536, Number(areaSqm) || 16));
  const t = Math.max(0, Math.min(1, (Math.log2(clamped) - 4.0) / 12.0));
  const hue = 230.0 * (1.0 - t);
  const sat = 0.92;
  const light = 0.50;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0, g = 0, b = 0;

  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Decodes 64x64 bitmask from LSL and extracts exact polygon borders + guaranteed interior center
function buildParcelGeometryFromGrid(gridRowsStr) {
  const grid = Array.from({ length: 64 }, () => new Uint8Array(64));
  let insideCount = 0;

  if (typeof gridRowsStr === "string" && gridRowsStr.trim() !== "") {
    const entries = gridRowsStr.split(";").filter(Boolean);
    for (const entry of entries) {
      const [rowStr, hex16] = entry.split(":");
      const y = parseInt(rowStr, 10);
      if (isNaN(y) || y < 0 || y >= 64 || !hex16 || hex16.length !== 16) continue;

      const hi = parseInt(hex16.slice(0, 8), 16) >>> 0;
      const lo = parseInt(hex16.slice(8, 16), 16) >>> 0;

      for (let x = 0; x < 32; x++) {
        if ((lo >>> x) & 1) { grid[y][x] = 1; insideCount++; }
      }
      for (let x = 32; x < 64; x++) {
        if ((hi >>> (x - 32)) & 1) { grid[y][x] = 1; insideCount++; }
      }
    }
  }

  if (insideCount === 0) {
    return { borders: [], center: { x: 128, y: 128 }, scannedArea: 0 };
  }

  const edgesByStart = new Map();
  const addEdge = (x1, y1, x2, y2) => {
    const k = `${x1},${y1}`;
    if (!edgesByStart.has(k)) edgesByStart.set(k, []);
    edgesByStart.get(k).push({ x1, y1, x2, y2, used: false });
  };

  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (!grid[y][x]) continue;
      if (y === 0 || !grid[y - 1][x]) addEdge(x, y, x + 1, y);
      if (x === 63 || !grid[y][x + 1]) addEdge(x + 1, y, x + 1, y + 1);
      if (y === 63 || !grid[y + 1][x]) addEdge(x + 1, y + 1, x, y + 1);
      if (x === 0 || !grid[y][x - 1]) addEdge(x, y + 1, x, y);
    }
  }

  const borders = [];
  for (const edgeList of edgesByStart.values()) {
    for (const startEdge of edgeList) {
      if (startEdge.used) continue;

      const rawLoop = [];
      let curr = startEdge;
      let guard = 0;

      while (curr && !curr.used && guard < 20000) {
        curr.used = true;
        rawLoop.push([curr.x1, curr.y1]);
        const dxIn = curr.x2 - curr.x1;
        const dyIn = curr.y2 - curr.y1;
        const nextList = edgesByStart.get(`${curr.x2},${curr.y2}`) || [];
        const available = nextList.filter(e => !e.used);

        if (available.length === 0) break;
        if (available.length === 1) {
          curr = available[0];
        } else {
          let best = available[0];
          let bestScore = -99;
          for (const cand of available) {
            const dxOut = cand.x2 - cand.x1;
            const dyOut = cand.y2 - cand.y1;
            const cross = dxIn * dyOut - dyIn * dxOut;
            const score = cross < 0 ? 3 : (cross === 0 ? 2 : 1);
            if (score > bestScore) { bestScore = score; best = cand; }
          }
          curr = best;
        }
        guard++;
      }

      if (rawLoop.length >= 3) {
        const simplified = [];
        const n = rawLoop.length;
        for (let i = 0; i < n; i++) {
          const prev = rawLoop[(i - 1 + n) % n];
          const cur = rawLoop[i];
          const next = rawLoop[(i + 1) % n];
          const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
          if (cross !== 0) {
            simplified.push([cur[0] * 4, cur[1] * 4]);
          }
        }
        if (simplified.length >= 3) borders.push(simplified);
      }
    }
  }

  let sumX = 0, sumY = 0;
  const dist = Array.from({ length: 64 }, () => new Int16Array(64).fill(-1));
  const queue = [];

  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (!grid[y][x]) continue;
      sumX += x;
      sumY += y;
      const isEdge = (x === 0 || x === 63 || y === 0 || y === 63 ||
        !grid[y - 1][x] || !grid[y + 1][x] || !grid[y][x - 1] || !grid[y][x + 1]);
      if (isEdge) {
        dist[y][x] = 1;
        queue.push([x, y]);
      }
    }
  }

  let head = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    const nd = dist[cy][cx] + 1;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < 64 && ny >= 0 && ny < 64 && grid[ny][nx] && dist[ny][nx] === -1) {
        dist[ny][nx] = nd;
        queue.push([nx, ny]);
      }
    }
  }

  const centroidX = sumX / insideCount;
  const centroidY = sumY / insideCount;
  let bestX = 32, bestY = 32, bestDist = -1, bestCentDist = Infinity;

  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (!grid[y][x]) continue;
      const d = dist[y][x];
      const cd = Math.hypot(x - centroidX, y - centroidY);
      if (d > bestDist || (d === bestDist && cd < bestCentDist)) {
        bestDist = d;
        bestCentDist = cd;
        bestX = x;
        bestY = y;
      }
    }
  }

  return {
    borders,
    center: { x: bestX * 4 + 2, y: bestY * 4 + 2 },
    scannedArea: insideCount * 16
  };
}

function rebuildFactionIndexes() {
  FACTION_BY_MEMBER.clear();
  FACTION_BY_LEADER_NAME.clear();
  FACTION_BY_PERM_ID.clear();
  for (const fac of FACTIONS.values()) {
    if (fac.leaderName) {
      FACTION_BY_LEADER_NAME.set(normalizeLegacyName(fac.leaderName).toLowerCase(), fac.id);
    }
    if (fac.permId) {
      FACTION_BY_PERM_ID.set(fac.permId, fac.id);
    }
    for (const mUuid of Object.keys(fac.members || {})) {
      FACTION_BY_MEMBER.set(mUuid.toLowerCase(), fac.id);
    }
  }
}

async function saveFaction(fac) {
  FACTIONS.set(fac.id, fac);
  rebuildFactionIndexes();
  await dbSet(`faction_${fac.id}`, JSON.stringify(fac));
}

async function deleteFactionFromDb(factionId) {
  const existing = FACTIONS.get(factionId);
  const oldPermId = existing ? existing.permId : "";

  FACTIONS.delete(factionId);
  rebuildFactionIndexes();
  await db.query("DELETE FROM kvstore WHERE id=$1", [`faction_${factionId}`]);

  if (oldPermId) {
    await removePermIdFromAlliancesAndInvites(oldPermId);
  }

  for (const [pUuid, pObj] of FACTION_PARCELS.entries()) {
    if (pObj.factionId === factionId) {
      FACTION_PARCELS.delete(pUuid);
      FACTION_ACTIVE_CAPTURES.delete(pUuid);
      await db.query("DELETE FROM kvstore WHERE id=$1", [`faction_parcel_${pUuid}`]);
    }
  }
}

async function saveFactionParcel(parcelObj) {
  FACTION_PARCELS.set(parcelObj.parcelUuid, parcelObj);
  await dbSet(`faction_parcel_${parcelObj.parcelUuid}`, JSON.stringify(parcelObj));
}

async function deleteFactionParcelFromDb(parcelUuid) {
  FACTION_PARCELS.delete(parcelUuid);
  FACTION_ACTIVE_CAPTURES.delete(parcelUuid);
  await db.query("DELETE FROM kvstore WHERE id=$1", [`faction_parcel_${parcelUuid}`]);
}

async function initFactionSystem() {
  if (!DATABASE_URL) return;
  try {
    FACTIONS.clear();
    FACTION_BY_MEMBER.clear();
    FACTION_BY_LEADER_NAME.clear();
    FACTION_BY_PERM_ID.clear();
    FACTION_PARCELS.clear();
    ALLIANCES.clear();
    ALLIANCE_BY_PERM_ID.clear();
    ALLIANCE_INVITES = [];
    FACTION_NEWS = [];
    FACTION_BLACKLIST.clear();
    FACTION_WEB_SESSIONS.clear();
    
    const bootNow = getUnixTime();
    let migratedPermIds = 0;

    // 1. Carrega facções e gera permId imutável para qualquer facção que ainda não tenha
    const fq = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'faction_%' AND id NOT LIKE 'faction_parcel_%'");
    for (const row of fq.rows) {
      try {
        const fac = JSON.parse(row.value);
        if (fac && fac.id) {
          let modified = false;
          if (typeof fac.xp !== "number") { fac.xp = 0; modified = true; }
          fac.level = computeFactionLevelInfo(fac.xp).level;

          if (!fac.permId) {
            fac.permId = generateFactionPermId(fac.name || fac.id, bootNow + migratedPermIds);
            migratedPermIds++;
            modified = true;
          }

          FACTIONS.set(fac.id, fac);
          if (modified) {
            await dbSet(`faction_${fac.id}`, JSON.stringify(fac));
          }
        }
      } catch (e) {}
    }
    rebuildFactionIndexes();

    // 2. Carrega parcelas conquistadas
    const pq = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'faction_parcel_%'");
    for (const row of pq.rows) {
      try {
        const pObj = JSON.parse(row.value);
        if (pObj && pObj.parcelUuid) FACTION_PARCELS.set(pObj.parcelUuid, pObj);
      } catch (e) {}
    }

    // 3. Carrega alianças
    const aq = await db.query("SELECT id, value FROM kvstore WHERE id LIKE 'alliance_%'");
    for (const row of aq.rows) {
      try {
        const ally = JSON.parse(row.value);
        if (ally && ally.id && Array.isArray(ally.members)) {
          // Mantém apenas permIds de facções que ainda existem
          const validMembers = ally.members.filter(pid => FACTION_BY_PERM_ID.has(pid));
          if (validMembers.length >= 2) {
            ally.members = validMembers;
            if (!ally.kickVotes) ally.kickVotes = {};
            ALLIANCES.set(ally.id, ally);
          } else {
            await db.query("DELETE FROM kvstore WHERE id=$1", [row.id]);
          }
        }
      } catch (e) {}
    }
    rebuildAllianceIndexes();

    // 4. Carrega convites de aliança pendentes
    const invRaw = await dbGet("FACTION_ALLIANCE_INVITES");
    if (invRaw) {
      try {
        const parsedInv = JSON.parse(invRaw);
        if (Array.isArray(parsedInv)) {
          ALLIANCE_INVITES = parsedInv.filter(i => FACTION_BY_PERM_ID.has(i.fromPermId) && FACTION_BY_PERM_ID.has(i.toPermId));
        }
      } catch (e) {}
    }

    // 5. Apaga todo o mural de notícias a cada restart/rebuild do servidor
    FACTION_NEWS = [];
    FACTION_NEWS_DEBOUNCE.clear();
    await db.query("DELETE FROM kvstore WHERE id = 'FACTION_NEWS'");

    // 6. Carrega blacklist de parcelas
    const blRaw = await dbGet("FACTION_BLACKLIST");
    if (blRaw) {
      try {
        const parsedBl = JSON.parse(blRaw);
        if (Array.isArray(parsedBl)) {
          for (const entry of parsedBl) {
            if (entry && entry.parcelUuid) {
              FACTION_BLACKLIST.set(String(entry.parcelUuid).toLowerCase(), entry);
            }
          }
        }
      } catch (e) {}
    }
    // 7. Carrega dispositivos lembrados (auto-login de 7 dias)
    const sessRaw = await dbGet("FACTION_WEB_SESSIONS");
    if (sessRaw) {
      try {
        const parsedSess = JSON.parse(sessRaw);
        if (Array.isArray(parsedSess)) {
          for (const s of parsedSess) {
            if (s && s.token && (s.expiresAt || 0) > bootNow) {
              FACTION_WEB_SESSIONS.set(s.token, s);
            }
          }
        }
      } catch (e) {}
    }
    
    console.log(`[STREET-CONQUESTERS] Loaded ${FACTIONS.size} factions (${migratedPermIds} new permIds), ${FACTION_PARCELS.size} parcels, ${ALLIANCES.size} alliances, ${FACTION_BLACKLIST.size} blacklisted.`);
  } catch (e) {
    console.error("Error in initFactionSystem:", e);
  }
}

function serializeFactionPublic(fac) {
  const membersArr = Object.values(fac.members || {});
  const { parcelCount, totalArea } = getFactionTerritoryStats(fac.id);
  const lvl = computeFactionLevelInfo(fac.xp || 0);
  const ally = getFactionAlliance(fac);

  const allies = [];
  if (ally) {
    for (const pid of ally.members) {
      if (pid === fac.permId) continue;
      const other = getFactionByPermId(pid);
      if (other) allies.push({ permId: other.permId, id: other.id, name: other.name, logo: other.logo || "" });
    }
  }

  return {
    id: fac.id,
    permId: fac.permId,
    name: fac.name,
    logo: fac.logo || "",
    leaderUuid: fac.leaderUuid,
    leaderName: fac.leaderName,
    memberCount: membersArr.length,
    parcelCount,
    totalArea,
    level: lvl.level,
    totalXp: lvl.totalXp,
    currentLevelXp: lvl.currentLevelXp,
    nextLevelXp: lvl.nextLevelXp,
    progressPct: lvl.progressPct,
    maxSqm: lvl.maxSqm,
    cargoBonusPct: Math.round((totalArea / 1000.0) * 100) / 100,
    allianceId: ally ? ally.id : "",
    allies,
    createdAt: fac.createdAt
  };
}

function serializeAllianceForLeader(fac) {
  const ally = getFactionAlliance(fac);

  const incomingInvites = ALLIANCE_INVITES
    .filter(inv => inv.toPermId === fac.permId)
    .map(inv => {
      const fromFac = getFactionByPermId(inv.fromPermId);
      return {
        id: inv.id,
        fromPermId: inv.fromPermId,
        fromName: fromFac ? fromFac.name : "Unknown Faction",
        fromLeader: fromFac ? fromFac.leaderName : "",
        createdAt: inv.createdAt
      };
    });

  const outgoingInvites = ALLIANCE_INVITES
    .filter(inv => inv.fromPermId === fac.permId)
    .map(inv => {
      const toFac = getFactionByPermId(inv.toPermId);
      return {
        id: inv.id,
        toPermId: inv.toPermId,
        toName: toFac ? toFac.name : "Unknown Faction",
        createdAt: inv.createdAt
      };
    });

  if (!ally) {
    return {
      inAlliance: false,
      id: "",
      members: [],
      kickVotes: [],
      incomingInvites,
      outgoingInvites
    };
  }

  const membersDetailed = [];
  for (const pid of ally.members) {
    const mf = getFactionByPermId(pid);
    if (!mf) continue;
    const st = getFactionTerritoryStats(mf.id);
    membersDetailed.push({
      permId: mf.permId,
      id: mf.id,
      name: mf.name,
      leaderName: mf.leaderName,
      logo: mf.logo || "",
      level: computeFactionLevelInfo(mf.xp || 0).level,
      totalArea: st.totalArea,
      isSelf: mf.permId === fac.permId
    });
  }

  const otherMembersCount = Math.max(1, ally.members.length - 1);
  const votesNeeded = Math.floor(otherMembersCount / 2) + 1;

  const kickVotesList = [];
  for (const [targetPid, voteObj] of Object.entries(ally.kickVotes || {})) {
    const targetFac = getFactionByPermId(targetPid);
    if (!targetFac) continue;
    const voters = Array.isArray(voteObj.voters) ? voteObj.voters : [];
    kickVotesList.push({
      targetPermId: targetPid,
      targetName: targetFac.name,
      votesCurrent: voters.length,
      votesNeeded,
      iVoted: voters.includes(fac.permId)
    });
  }

  return {
    inAlliance: true,
    id: ally.id,
    createdAt: ally.createdAt,
    members: membersDetailed,
    votesNeeded,
    kickVotes: kickVotesList,
    incomingInvites,
    outgoingInvites
  };
}

// ========================================================
// LSL ENDPOINTS
// ========================================================

// 1. LSL: sync player faction state (inclui permId, aliança e alerta de território sob ataque)
app.get("/faction/player", requireToken, async (req, res) => {
  pruneStaleActiveCaptures();
  const cleanUuid = String(req.query.uuid || "").trim().toLowerCase();
  const cleanName = normalizeLegacyName(req.query.legacyName || "");
  if (!cleanUuid) return res.status(400).json({ status: "ERROR", message: "Missing UUID." });

  const facId = FACTION_BY_MEMBER.get(cleanUuid);
  if (!facId || !FACTIONS.has(facId)) {
    return res.json({ status: "OK", inFaction: 0 });
  }

  const fac = FACTIONS.get(facId);
  const member = fac.members[cleanUuid];
  if (!member) return res.json({ status: "OK", inFaction: 0 });

  if (cleanName && member.legacyName !== cleanName) {
    member.legacyName = cleanName;
    if (fac.leaderUuid === cleanUuid) fac.leaderName = cleanName;
    await saveFaction(fac);
  }

  const { totalArea } = getFactionTerritoryStats(fac.id);
  const lvl = computeFactionLevelInfo(fac.xp || 0);
  const ally = getFactionAlliance(fac);

  // Verifica se algum território desta facção está sendo atacado agora
  let alertRegion = "";
  let alertAttacker = "";
  let alertSlurl = "";
  for (const cap of FACTION_ACTIVE_CAPTURES.values()) {
    if (!cap.isNeutral && cap.defenderFacId === fac.id) {
      alertRegion = cap.regionName || "Unknown";
      alertAttacker = cap.attackerFacName || "Rivals";
      const cx = Math.round(cap.center?.x || 128);
      const cy = Math.round(cap.center?.y || 128);
      alertSlurl = `secondlife://${encodeURIComponent(alertRegion)}/${cx}/${cy}/25`;
      break;
    }
  }

  res.json({
    status: "OK",
    inFaction: 1,
    factionId: fac.id,
    permId: fac.permId,
    factionName: fac.name,
    logo: fac.logo || "",
    role: member.role,
    leaderUuid: fac.leaderUuid,
    leaderName: fac.leaderName,
    memberCount: Object.keys(fac.members || {}).length,
    level: lvl.level,
    currentLevelXp: lvl.currentLevelXp,
    nextLevelXp: lvl.nextLevelXp,
    totalArea,
    maxSqm: lvl.maxSqm,
    allianceId: ally ? ally.id : "",
    allyCount: ally ? Math.max(0, ally.members.length - 1) : 0,
    alertRegion,
    alertAttacker,
    alertSlurl
  });
});

// 2. LSL: create faction (gera permId imutável no momento da criação)
app.post("/faction/create", requireToken, async (req, res) => {
  const { uuid, legacyName, factionName } = req.body;
  const cleanUuid = String(uuid || "").trim().toLowerCase();
  const cleanUser = normalizeLegacyName(legacyName);
  const cleanFacName = sanitizeFactionName(factionName);

  if (!isValidUuid(cleanUuid) || !cleanUser) {
    return res.status(400).json({ status: "ERROR", message: "Invalid avatar data." });
  }
  if (cleanFacName.length < 2) {
    return res.status(400).json({ status: "ERROR", message: "Faction name must be between 2 and 32 characters." });
  }

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    if (FACTION_BY_MEMBER.has(cleanUuid)) {
      return res.json({ status: "ERROR", message: "You already belong to a faction." });
    }
    for (const f of FACTIONS.values()) {
      if (f.name.toLowerCase() === cleanFacName.toLowerCase()) {
        return res.json({ status: "ERROR", message: "A faction with that name already exists." });
      }
    }

    const now = getUnixTime();
    const factionId = `fac_${now}_${crypto.randomBytes(3).toString("hex")}`;
    const permId = generateFactionPermId(cleanFacName, now);
    const password = generateFactionPassword(cleanUuid, now);

    const newFac = {
      id: factionId,
      permId,
      name: cleanFacName,
      logo: "",
      leaderUuid: cleanUuid,
      leaderName: cleanUser,
      password,
      xp: 0,
      level: 0,
      createdAt: now,
      updatedAt: now,
      members: {
        [cleanUuid]: {
          uuid: cleanUuid,
          legacyName: cleanUser,
          role: "leader",
          joinedAt: now
        }
      }
    };

    await saveFaction(newFac);
    const lvl = computeFactionLevelInfo(0);

    res.json({
      status: "OK",
      factionId: newFac.id,
      permId: newFac.permId,
      factionName: newFac.name,
      role: "leader",
      leaderUuid: cleanUuid,
      login: cleanUser,
      password,
      memberCount: 1,
      level: lvl.level,
      currentLevelXp: 0,
      nextLevelXp: lvl.nextLevelXp,
      totalArea: 0,
      maxSqm: lvl.maxSqm
    });
  });
});

// 3. LSL: leader updates faction name, logo or password (permId NUNCA muda)
app.post("/faction/update", requireToken, async (req, res) => {
  const { uuid, factionName, logo, password } = req.body;
  const cleanUuid = String(uuid || "").trim().toLowerCase();

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const facId = FACTION_BY_MEMBER.get(cleanUuid);
    const fac = facId ? FACTIONS.get(facId) : null;
    if (!fac) return res.json({ status: "ERROR", message: "You are not in a faction." });
    if (fac.leaderUuid !== cleanUuid) {
      return res.json({ status: "ERROR", message: "Only the faction leader can update settings." });
    }

    if (factionName !== undefined) {
      const cleanFacName = sanitizeFactionName(factionName);
      if (cleanFacName.length < 2) {
        return res.json({ status: "ERROR", message: "Invalid name (minimum 2 characters)." });
      }
      for (const f of FACTIONS.values()) {
        if (f.id !== fac.id && f.name.toLowerCase() === cleanFacName.toLowerCase()) {
          return res.json({ status: "ERROR", message: "Another faction already uses that name." });
        }
      }
      fac.name = cleanFacName;
      for (const p of FACTION_PARCELS.values()) {
        if (p.factionId === fac.id) {
          p.factionName = fac.name;
          await saveFactionParcel(p);
        }
      }
    }

    if (logo !== undefined) {
      const parsedLogo = sanitizeFactionLogo(logo);
      if (parsedLogo === null) {
        return res.json({ status: "ERROR", message: "Invalid logo. Enter an SL Texture UUID, valid http(s) URL, or NONE to clear." });
      }
      fac.logo = parsedLogo;
      for (const p of FACTION_PARCELS.values()) {
        if (p.factionId === fac.id) {
          p.factionLogo = fac.logo;
          await saveFactionParcel(p);
        }
      }
    }

    if (password !== undefined) {
      const cleanPass = stripControlChars(password).trim();
      if (cleanPass.length < 4 || cleanPass.length > 24) {
        return res.json({ status: "ERROR", message: "Password must be 4 to 24 characters." });
      }
      fac.password = cleanPass;
    }

    fac.updatedAt = getUnixTime();
    await saveFaction(fac);

    res.json({
      status: "OK",
      factionId: fac.id,
      factionName: fac.name,
      logo: fac.logo,
      newPassword: password !== undefined ? fac.password : "",
      memberCount: Object.keys(fac.members).length
    });
  });
});

// 4. LSL: leader deletes faction
app.post("/faction/delete", requireToken, async (req, res) => {
  const cleanUuid = String(req.body.uuid || "").trim().toLowerCase();

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const facId = FACTION_BY_MEMBER.get(cleanUuid);
    const fac = facId ? FACTIONS.get(facId) : null;
    if (!fac) return res.json({ status: "ERROR", message: "You are not in a faction." });
    if (fac.leaderUuid !== cleanUuid) {
      return res.json({ status: "ERROR", message: "Only the faction leader can delete the faction." });
    }

    const oldName = fac.name;
    await deleteFactionFromDb(fac.id);
    res.json({ status: "OK", deletedFaction: oldName });
  });
});

// 5. LSL: non-leader member leaves faction
app.post("/faction/leave", requireToken, async (req, res) => {
  const cleanUuid = String(req.body.uuid || "").trim().toLowerCase();

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const facId = FACTION_BY_MEMBER.get(cleanUuid);
    const fac = facId ? FACTIONS.get(facId) : null;
    if (!fac) return res.json({ status: "ERROR", message: "You are not in a faction." });
    if (fac.leaderUuid === cleanUuid) {
      return res.json({ status: "ERROR", message: "The leader cannot leave the faction. Transfer leadership to another member first." });
    }

    delete fac.members[cleanUuid];
    fac.updatedAt = getUnixTime();
    await saveFaction(fac);
    res.json({ status: "OK", factionName: fac.name });
  });
});

// 6. LSL: member management (Recruit, Kick, Roles & Leadership Transfer)
app.post("/faction/manage", requireToken, async (req, res) => {
  const { actorUuid, targetUuid, targetName, action } = req.body;
  const cleanActor = String(actorUuid || "").trim().toLowerCase();
  const cleanTarget = String(targetUuid || "").trim().toLowerCase();
  const cleanTargetName = normalizeLegacyName(targetName || "");
  const act = String(action || "").toUpperCase().trim();

  if (!isValidUuid(cleanActor) || !isValidUuid(cleanTarget)) {
    return res.status(400).json({ status: "ERROR", message: "Invalid UUID." });
  }
  if (cleanActor === cleanTarget) {
    return res.json({ status: "ERROR", message: "You cannot perform this action on yourself." });
  }

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const facId = FACTION_BY_MEMBER.get(cleanActor);
    const fac = facId ? FACTIONS.get(facId) : null;
    if (!fac || !fac.members[cleanActor]) {
      return res.json({ status: "ERROR", message: "You do not belong to a faction." });
    }

    const actorRole = fac.members[cleanActor].role;
    if (actorRole !== "leader" && actorRole !== "subleader") {
      return res.json({ status: "ERROR", message: "You do not have permission to manage members." });
    }

    const targetFacId = FACTION_BY_MEMBER.get(cleanTarget);
    const targetMember = fac.members[cleanTarget];
    const now = getUnixTime();

    if (actorRole === "subleader" && cleanTarget === fac.leaderUuid) {
      return res.json({ status: "ERROR", message: "Sub-Leaders cannot perform actions against the Leader." });
    }

    if (act === "RECRUIT") {
      if (targetFacId === fac.id) {
        return res.json({ status: "ERROR", message: "This player is already in your faction." });
      }
      if (targetFacId && FACTIONS.has(targetFacId)) {
        return res.json({ status: "ERROR", message: "This player already belongs to another faction." });
      }

      fac.members[cleanTarget] = {
        uuid: cleanTarget,
        legacyName: cleanTargetName || cleanTarget,
        role: "enforcer",
        joinedAt: now
      };
      fac.updatedAt = now;
      await saveFaction(fac);

      return res.json({
        status: "OK",
        action: act,
        factionId: fac.id,
        factionName: fac.name,
        targetUuid: cleanTarget,
        targetName: fac.members[cleanTarget].legacyName,
        memberCount: Object.keys(fac.members).length
      });
    }

    if (!targetMember) {
      return res.json({ status: "ERROR", message: "This player is not a member of your faction." });
    }

    if (act === "KICK") {
      if (cleanTarget === fac.leaderUuid) {
        return res.json({ status: "ERROR", message: "The leader cannot be kicked." });
      }
      const kickedName = targetMember.legacyName;
      delete fac.members[cleanTarget];
      fac.updatedAt = now;
      await saveFaction(fac);

      return res.json({
        status: "OK",
        action: act,
        factionId: fac.id,
        factionName: fac.name,
        targetUuid: cleanTarget,
        targetName: kickedName,
        memberCount: Object.keys(fac.members).length
      });
    }

    if (act === "SET_ENFORCER" || act === "SET_CAPANGA") {
      if (cleanTarget === fac.leaderUuid) {
        return res.json({ status: "ERROR", message: "Cannot demote the leader directly." });
      }
      targetMember.role = "enforcer";
      if (cleanTargetName) targetMember.legacyName = cleanTargetName;
      fac.updatedAt = now;
      await saveFaction(fac);

      return res.json({
        status: "OK",
        action: "SET_ENFORCER",
        factionId: fac.id,
        factionName: fac.name,
        targetUuid: cleanTarget,
        targetName: targetMember.legacyName,
        newRole: "enforcer",
        memberCount: Object.keys(fac.members).length
      });
    }

    if (act === "SET_SUBLEADER") {
      if (actorRole !== "leader") {
        return res.json({ status: "ERROR", message: "Only the leader can promote someone to Sub-Leader." });
      }
      targetMember.role = "subleader";
      if (cleanTargetName) targetMember.legacyName = cleanTargetName;
      fac.updatedAt = now;
      await saveFaction(fac);

      return res.json({
        status: "OK",
        action: act,
        factionId: fac.id,
        factionName: fac.name,
        targetUuid: cleanTarget,
        targetName: targetMember.legacyName,
        newRole: "subleader",
        memberCount: Object.keys(fac.members).length
      });
    }

    if (act === "SET_LEADER") {
      if (actorRole !== "leader") {
        return res.json({ status: "ERROR", message: "Only the current leader can transfer leadership." });
      }

      const finalTargetName = cleanTargetName || targetMember.legacyName;
      const newPassword = generateFactionPassword(cleanTarget, now);

      fac.members[cleanActor].role = "subleader";
      targetMember.role = "leader";
      targetMember.legacyName = finalTargetName;

      fac.leaderUuid = cleanTarget;
      fac.leaderName = finalTargetName;
      fac.password = newPassword;
      fac.updatedAt = now;

      await saveFaction(fac);

      return res.json({
        status: "OK",
        action: act,
        factionId: fac.id,
        factionName: fac.name,
        targetUuid: cleanTarget,
        targetName: finalTargetName,
        newRole: "leader",
        actorNewRole: "subleader",
        newLogin: finalTargetName,
        newPassword,
        memberCount: Object.keys(fac.members).length
      });
    }

    return res.status(400).json({ status: "ERROR", message: "Unknown action." });
  });
});

// 7. LSL: query current parcel status (dono, blacklist, escudo 6h e se é território aliado)
app.get("/faction/parcel-status", requireToken, (req, res) => {
  const parcelUuid = String(req.query.parcelUuid || "").trim().toLowerCase();
  const viewerFactionId = String(req.query.factionId || "").trim();
  if (!parcelUuid) return res.status(400).json({ status: "ERROR" });

  if (FACTION_BLACKLIST.has(parcelUuid)) {
    return res.json({
      status: "OK",
      blacklisted: 1,
      owned: 0,
      factionId: "",
      factionName: "",
      isAlly: 0,
      shielded: 0,
      shieldRemaining: 0,
      shieldText: ""
    });
  }

  const pObj = FACTION_PARCELS.get(parcelUuid);
  if (!pObj || !FACTIONS.has(pObj.factionId)) {
    return res.json({
      status: "OK",
      blacklisted: 0,
      owned: 0,
      factionId: "",
      factionName: "",
      isAlly: 0,
      shielded: 0,
      shieldRemaining: 0,
      shieldText: ""
    });
  }

  const now = getUnixTime();
  const fac = FACTIONS.get(pObj.factionId);
  const shieldRemaining = Math.max(0, (pObj.shieldUntil || 0) - now);
  const isAlly = viewerFactionId ? (areFactionsAllied(viewerFactionId, fac.id) ? 1 : 0) : 0;

  res.json({
    status: "OK",
    blacklisted: 0,
    owned: 1,
    factionId: fac.id,
    ownerPermId: fac.permId,
    factionName: fac.name,
    area: pObj.area,
    colorHex: pObj.colorHex,
    isAlly,
    shielded: shieldRemaining > 0 ? 1 : 0,
    shieldRemaining,
    shieldText: shieldRemaining > 0 ? formatRemainingShort(shieldRemaining) : ""
  });
});

// 7B. LSL: reporta início/progresso/parada de captura (faz mapa piscar rosa/roxo + mural de notícias)
app.post("/faction/capture-ping", requireToken, async (req, res) => {
  pruneStaleActiveCaptures();
  const {
    parcelUuid, parcelName, regionName, regionCorner, area,
    factionId, progress, active, centerX, centerY, gridRows
  } = req.body;

  const cleanParcel = String(parcelUuid || "").trim().toLowerCase();
  const cleanFacId = String(factionId || "").trim();
  if (!isValidUuid(cleanParcel) || !cleanFacId) {
    return res.status(400).json({ status: "ERROR", message: "Invalid capture ping." });
  }

  // Captura cancelada/interrompida pelo jogador (Stop, saiu da parcela, voou, etc.)
  if (active === 0 || active === false || active === "0") {
    const existingCap = FACTION_ACTIVE_CAPTURES.get(cleanParcel);
    if (existingCap && existingCap.attackerFacId === cleanFacId) {
      FACTION_ACTIVE_CAPTURES.delete(cleanParcel);
      reportFailedCapture(existingCap);
    }
    return res.json({ status: "OK", cleared: 1 });
  }

  if (FACTION_BLACKLIST.has(cleanParcel)) {
    return res.json({ status: "BLACKLISTED", message: "This parcel is protected/blacklisted and cannot be conquered." });
  }

  const attackerFac = FACTIONS.get(cleanFacId);
  if (!attackerFac) {
    return res.json({ status: "ERROR", message: "Faction not found." });
  }

  const now = getUnixTime();
  const existingParcel = FACTION_PARCELS.get(cleanParcel);

  // Ignora ping atrasado caso esta facção já tenha acabado de conquistar a parcela
  if (existingParcel && existingParcel.factionId === attackerFac.id) {
    FACTION_ACTIVE_CAPTURES.delete(cleanParcel);
    return res.json({ status: "OK", alreadyOwned: 1 });
  }

  const defenderFac = (existingParcel && FACTIONS.has(existingParcel.factionId))
    ? FACTIONS.get(existingParcel.factionId)
    : null;

  if (existingParcel && (existingParcel.shieldUntil || 0) > now) {
    const rem = existingParcel.shieldUntil - now;
    return res.json({
      status: "SHIELDED",
      shieldRemaining: rem,
      shieldText: formatRemainingShort(rem),
      message: `Territory is protected by a post-conquest shield (${formatRemainingShort(rem)} left).`
    });
  }

  const isNeutral = !defenderFac;
  const isAllySteal = Boolean(defenderFac && areFactionsAllied(attackerFac.id, defenderFac.id));
  const cleanReg = sanitizeRegionName(regionName || existingParcel?.regionName || "Unknown Region");
  const cleanPName = stripControlChars(parcelName || existingParcel?.parcelName || "Parcel").trim().slice(0, 64);
  const finalArea = Math.max(16, parseInt(area, 10) || existingParcel?.area || 16);

  let cornerObj = existingParcel?.regionCorner || { x: 0, y: 0 };
  if (typeof regionCorner === "string" && regionCorner.includes(",")) {
    const cp = regionCorner.split(",");
    cornerObj = { x: parseInt(cp[0], 10) || 0, y: parseInt(cp[1], 10) || 0 };
  }

  const prevCap = FACTION_ACTIVE_CAPTURES.get(cleanParcel);
  const isNewAttack = !prevCap || prevCap.attackerFacId !== attackerFac.id;

  let borders = existingParcel?.borders || prevCap?.borders || [];
  let center = existingParcel?.center || prevCap?.center || {
    x: Math.max(0, Math.min(256, parseFloat(centerX) || 128)),
    y: Math.max(0, Math.min(256, parseFloat(centerY) || 128))
  };

  if (isNeutral && typeof gridRows === "string" && gridRows.trim() !== "" && borders.length === 0) {
    const geom = buildParcelGeometryFromGrid(gridRows);
    if (geom.borders.length > 0) {
      borders = geom.borders;
      center = geom.center;
    }
  }

  FACTION_ACTIVE_CAPTURES.set(cleanParcel, {
    parcelUuid: cleanParcel,
    parcelName: cleanPName,
    regionName: cleanReg,
    regionCorner: cornerObj,
    area: finalArea,
    borders,
    center,
    attackerFacId: attackerFac.id,
    attackerFacName: attackerFac.name,
    defenderFacId: defenderFac ? defenderFac.id : "",
    defenderFacName: defenderFac ? defenderFac.name : "",
    isNeutral,
    isAllySteal,
    progress: Math.max(0, Math.min(100, Math.round((parseFloat(progress) || 0) * 10) / 10)),
    startedAt: prevCap ? prevCap.startedAt : now,
    lastPingAt: now
  });

  if (isNewAttack) {
    FACTION_NEWS_DEBOUNCE.delete(`fail_${cleanParcel}_${attackerFac.id}`);
    const newsMeta = {
      regionName: cleanReg,
      parcelUuid: cleanParcel,
      factionId: attackerFac.id,
      factionName: attackerFac.name,
      debounceKey: `cap_${cleanParcel}_${attackerFac.id}`,
      debounceSec: 15
    };

    if (isNeutral) {
      await pushFactionNews(
        "NEUTRAL_CLAIMING",
        `🏴 ${attackerFac.name} started claiming "${cleanPName}" in ${cleanReg} (${finalArea.toLocaleString("en-US")} sqm)!`,
        newsMeta
      );
    } else if (isAllySteal) {
      await pushFactionNews(
        "ALLY_STEAL_START",
        `🔪 BETRAYAL IN PROGRESS! ${attackerFac.name} is trying to steal "${cleanPName}" in ${cleanReg} from ally ${defenderFac.name}!`,
        newsMeta
      );
    } else {
      await pushFactionNews(
        "UNDER_ATTACK",
        `🚨 TURF UNDER ATTACK! ${attackerFac.name} is attacking ${defenderFac.name}'s turf "${cleanPName}" in ${cleanReg} (${finalArea.toLocaleString("en-US")} sqm)!`,
        newsMeta
      );
    }
  }

  res.json({
    status: "OK",
    isNeutral: isNeutral ? 1 : 0,
    isAllySteal: isAllySteal ? 1 : 0
  });
});

// 8. LSL: register parcel conquest (verifica blacklist, escudo 6h, limite SQM e aplica novo escudo de 6h)
app.post("/faction/conquer", requireToken, async (req, res) => {
  const { factionId, winnerUuid, regionName, regionCorner, parcelUuid, parcelName, area, gridRows } = req.body;
  const cleanParcel = String(parcelUuid || "").trim().toLowerCase();
  const cleanWinner = String(winnerUuid || "").trim().toLowerCase();
  const cleanFacId = String(factionId || "").trim();

  if (!isValidUuid(cleanParcel) || !cleanFacId) {
    return res.status(400).json({ status: "ERROR", message: "Invalid conquest payload." });
  }

  if (FACTION_BLACKLIST.has(cleanParcel)) {
    return res.json({ status: "BLACKLISTED", message: "This parcel is blacklisted and cannot be conquered." });
  }

  await withLock(`FACTION_PARCEL_${cleanParcel}`, async () => {
    const fac = FACTIONS.get(cleanFacId);
    if (!fac) return res.json({ status: "ERROR", message: "Faction not found." });
    if (cleanWinner && !fac.members[cleanWinner]) {
      return res.json({ status: "ERROR", message: "Winner does not belong to this faction." });
    }

    const now = getUnixTime();
    const lastClaim = FACTION_CONQUER_DEBOUNCE.get(cleanParcel);
    if (lastClaim && lastClaim.factionId === cleanFacId && (now - lastClaim.time) < 15) {
      return res.json({ status: "OK", deduplicated: 1, factionName: fac.name });
    }

    const prevParcel = FACTION_PARCELS.get(cleanParcel);
    if (prevParcel && prevParcel.factionId !== cleanFacId && (prevParcel.shieldUntil || 0) > now) {
      const rem = prevParcel.shieldUntil - now;
      return res.json({
        status: "SHIELDED",
        shieldRemaining: rem,
        message: `This territory is shielded for ${formatRemainingShort(rem)}.`
      });
    }

    const geom = buildParcelGeometryFromGrid(gridRows);
    const finalArea = Math.max(16, parseInt(area, 10) || geom.scannedArea || 16);

    // Authoritative Level SQM Limit Check
    const lvl = computeFactionLevelInfo(fac.xp || 0);
    const { totalArea: existingArea } = getFactionTerritoryStats(fac.id, cleanParcel);
    if ((existingArea + finalArea) > lvl.maxSqm) {
      const activeCap = FACTION_ACTIVE_CAPTURES.get(cleanParcel);
      if (activeCap && activeCap.attackerFacId === cleanFacId) {
        FACTION_ACTIVE_CAPTURES.delete(cleanParcel);
        reportFailedCapture(activeCap);
      }
      return res.json({
        status: "SQM_LIMIT",
        message: `Territory limit exceeded! Level ${lvl.level} capacity is ${lvl.maxSqm.toLocaleString("en-US")} sqm (currently using ${existingArea.toLocaleString("en-US")} sqm; this parcel needs ${finalArea.toLocaleString("en-US")} sqm). Level up or abandon a territory on the website.`
      });
    }

    const prevOwnerFac = (prevParcel && prevParcel.factionId !== fac.id && FACTIONS.has(prevParcel.factionId))
      ? FACTIONS.get(prevParcel.factionId)
      : null;
    const wasAllySteal = Boolean(prevOwnerFac && areFactionsAllied(fac.id, prevOwnerFac.id));

    FACTION_CONQUER_DEBOUNCE.set(cleanParcel, { factionId: cleanFacId, time: now });
    FACTION_ACTIVE_CAPTURES.delete(cleanParcel);

    const colorHex = computeParcelThermalColor(finalArea);

    let cornerX = 0, cornerY = 0;
    if (typeof regionCorner === "string" && regionCorner.includes(",")) {
      const cp = regionCorner.split(",");
      cornerX = parseInt(cp[0], 10) || 0;
      cornerY = parseInt(cp[1], 10) || 0;
    }

    const cleanReg = sanitizeRegionName(regionName || "Unknown Region");
    const cleanPName = stripControlChars(parcelName || "Parcel").trim().slice(0, 64);
    const shieldUntil = now + FACTION_SHIELD_SECONDS;

    const parcelObj = {
      parcelUuid: cleanParcel,
      parcelName: cleanPName,
      regionName: cleanReg,
      regionCorner: { x: cornerX, y: cornerY },
      factionId: fac.id,
      factionName: fac.name,
      factionLogo: fac.logo || "",
      area: finalArea,
      colorHex,
      center: geom.center,
      borders: geom.borders,
      conqueredBy: cleanWinner,
      conqueredAt: now,
      shieldUntil
    };

    await saveFactionParcel(parcelObj);
    const updatedStats = getFactionTerritoryStats(fac.id);

    // Publica notícia de conquista bem-sucedida na Street News (substituindo notícias anteriores da mesma gangue nesta parcela)
    FACTION_NEWS_DEBOUNCE.delete(`cap_${cleanParcel}_${fac.id}`);
    FACTION_NEWS_DEBOUNCE.delete(`fail_${cleanParcel}_${fac.id}`);
    const conquerNewsMeta = {
      regionName: cleanReg,
      parcelUuid: cleanParcel,
      factionId: fac.id,
      factionName: fac.name
    };

    if (wasAllySteal && prevOwnerFac) {
      await pushFactionNews(
        "ALLY_STOLEN",
        `🐍 BETRAYAL! ${fac.name} just took control of "${cleanPName}" in ${cleanReg} (${finalArea.toLocaleString("en-US")} sqm) by stealing it from ally ${prevOwnerFac.name}!`,
        conquerNewsMeta
      );
      if (prevOwnerFac.leaderUuid) {
        await addPlayerMessage(
          prevOwnerFac.leaderUuid,
          `🐍 [STREET CONQUESTERS] BETRAYAL! Your ally "${fac.name}" stole your turf "${cleanPName}" in ${cleanReg}! You can leave or vote to kick them on the website.`
        );
      }
    } else if (prevOwnerFac) {
      await pushFactionNews(
        "CONQUERED",
        `🔥 ${fac.name} just took control of "${cleanPName}" in ${cleanReg} (${finalArea.toLocaleString("en-US")} sqm) from ${prevOwnerFac.name}!`,
        conquerNewsMeta
      );
    } else {
      await pushFactionNews(
        "CLAIMED_NEUTRAL",
        `🏴 ${fac.name} just took control of "${cleanPName}" in ${cleanReg} (${finalArea.toLocaleString("en-US")} sqm)!`,
        conquerNewsMeta
      );
    }

    res.json({
      status: "OK",
      parcelUuid: cleanParcel,
      factionName: fac.name,
      area: finalArea,
      totalArea: updatedStats.totalArea,
      maxSqm: lvl.maxSqm,
      colorHex,
      center: geom.center,
      polygonCount: geom.borders.length,
      shieldUntil,
      shieldHours: 6,
      wasAllySteal: wasAllySteal ? 1 : 0
    });
  });
});

// ========================================================
// ADMIN ENDPOINTS — BLACKLIST DE PARCELAS (requireToken)
// ========================================================

app.post("/faction/admin/blacklist-add", requireToken, async (req, res) => {
  const { parcelUuid, regionName, reason } = req.body;
  const cleanParcel = String(parcelUuid || "").trim().toLowerCase();
  if (!isValidUuid(cleanParcel)) {
    return res.status(400).json({ status: "ERROR", message: "Invalid parcel UUID." });
  }

  await withLock(`FACTION_PARCEL_${cleanParcel}`, async () => {
    const entry = {
      parcelUuid: cleanParcel,
      regionName: sanitizeRegionName(regionName || ""),
      reason: stripControlChars(reason || "Protected by Admin").trim().slice(0, 120),
      addedAt: getUnixTime()
    };
    FACTION_BLACKLIST.set(cleanParcel, entry);
    await saveFactionBlacklist();

    // Se alguma facção dominava esta parcela, remove imediatamente
    if (FACTION_PARCELS.has(cleanParcel)) {
      await deleteFactionParcelFromDb(cleanParcel);
    }
    FACTION_ACTIVE_CAPTURES.delete(cleanParcel);

    res.json({ status: "OK", blacklisted: entry, totalBlacklisted: FACTION_BLACKLIST.size });
  });
});

app.post("/faction/admin/blacklist-remove", requireToken, async (req, res) => {
  const cleanParcel = String(req.body.parcelUuid || "").trim().toLowerCase();
  if (!isValidUuid(cleanParcel)) {
    return res.status(400).json({ status: "ERROR", message: "Invalid parcel UUID." });
  }

  const existed = FACTION_BLACKLIST.delete(cleanParcel);
  if (existed) await saveFactionBlacklist();
  res.json({ status: "OK", removed: existed ? 1 : 0, totalBlacklisted: FACTION_BLACKLIST.size });
});

app.get("/faction/admin/blacklist-list", requireToken, (req, res) => {
  res.json({
    status: "OK",
    count: FACTION_BLACKLIST.size,
    parcels: Array.from(FACTION_BLACKLIST.values())
  });
});

// ========================================================
// STREET CONQUESTERS WEBSITE ENDPOINTS
// ========================================================

function authenticateFactionLeader(legacyName, password) {
  const lookup = normalizeLegacyName(legacyName).toLowerCase();
  const pass = String(password || "").trim();
  if (!lookup || !pass) return null;

  const facId = FACTION_BY_LEADER_NAME.get(lookup);
  if (!facId) return null;
  const fac = FACTIONS.get(facId);
  if (!fac || fac.password !== pass) return null;
  return fac;
}

app.post("/faction/web/login", async (req, res) => {
  const { legacyName, password, remember } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) {
    return res.status(401).json({ status: "ERROR", message: "Invalid credentials or you are no longer the faction leader." });
  }

  let sessionToken = "";
  const deviceHash = getClientDeviceHash(req);

  if (remember === true) {
    const now = getUnixTime();
    if (deviceHash) {
      for (const [t, s] of FACTION_WEB_SESSIONS.entries()) {
        if (s.deviceHash === deviceHash) FACTION_WEB_SESSIONS.delete(t);
      }
    }
    sessionToken = crypto.randomBytes(24).toString("hex");
    FACTION_WEB_SESSIONS.set(sessionToken, {
      token: sessionToken,
      deviceHash,
      facId: fac.id,
      leaderUuid: fac.leaderUuid,
      passwordSnapshot: fac.password,
      expiresAt: now + FACTION_REMEMBER_SECONDS
    });
    await saveFactionWebSessions();
  } else if (remember === false && deviceHash) {
    let changed = false;
    for (const [t, s] of FACTION_WEB_SESSIONS.entries()) {
      if (s.deviceHash === deviceHash) {
        FACTION_WEB_SESSIONS.delete(t);
        changed = true;
      }
    }
    if (changed) await saveFactionWebSessions();
  }

  res.json({
    status: "OK",
    sessionToken,
    faction: buildLeaderFactionPayload(fac)
  });
});

app.post("/faction/web/auto-login", async (req, res) => {
  const token = String(req.body?.sessionToken || "").trim();
  const deviceHash = getClientDeviceHash(req);
  const now = getUnixTime();

  let matched = null;
  if (token && FACTION_WEB_SESSIONS.has(token)) {
    const s = FACTION_WEB_SESSIONS.get(token);
    if ((s.expiresAt || 0) > now) matched = s;
  }

  // Fallback pelo dispositivo (funciona mesmo em Google Sites / iframes sem localStorage)
  if (!matched && deviceHash) {
    for (const s of FACTION_WEB_SESSIONS.values()) {
      if (s.deviceHash === deviceHash && (s.expiresAt || 0) > now) {
        if (!matched || s.expiresAt > matched.expiresAt) matched = s;
      }
    }
  }

  if (!matched) {
    return res.json({ status: "NO_SESSION" });
  }

  const fac = FACTIONS.get(matched.facId);
  if (!fac || fac.leaderUuid !== matched.leaderUuid || fac.password !== matched.passwordSnapshot) {
    FACTION_WEB_SESSIONS.delete(matched.token);
    await saveFactionWebSessions();
    return res.json({ status: "NO_SESSION" });
  }

  res.json({
    status: "OK",
    sessionToken: matched.token,
    legacyName: fac.leaderName,
    password: fac.password,
    faction: buildLeaderFactionPayload(fac)
  });
});

app.post("/faction/web/logout", async (req, res) => {
  const token = String(req.body?.sessionToken || "").trim();
  const deviceHash = getClientDeviceHash(req);
  let changed = false;

  if (token && FACTION_WEB_SESSIONS.delete(token)) changed = true;
  if (deviceHash) {
    for (const [t, s] of FACTION_WEB_SESSIONS.entries()) {
      if (s.deviceHash === deviceHash) {
        FACTION_WEB_SESSIONS.delete(t);
        changed = true;
      }
    }
  }

  if (changed) await saveFactionWebSessions();
  res.json({ status: "OK" });
});

app.post("/faction/web/update", async (req, res) => {
  const { legacyName, password, factionName, logo } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    if (factionName !== undefined) {
      const cleanName = sanitizeFactionName(factionName);
      if (cleanName.length < 2) return res.status(400).json({ status: "ERROR", message: "Faction name is too short." });
      for (const f of FACTIONS.values()) {
        if (f.id !== fac.id && f.name.toLowerCase() === cleanName.toLowerCase()) {
          return res.status(400).json({ status: "ERROR", message: "Faction name already in use." });
        }
      }
      fac.name = cleanName;
      for (const p of FACTION_PARCELS.values()) {
        if (p.factionId === fac.id) { p.factionName = fac.name; await saveFactionParcel(p); }
      }
    }

    if (logo !== undefined) {
      const parsedLogo = sanitizeFactionLogo(logo);
      if (parsedLogo === null) return res.status(400).json({ status: "ERROR", message: "Invalid logo format." });
      fac.logo = parsedLogo;
      for (const p of FACTION_PARCELS.values()) {
        if (p.factionId === fac.id) { p.factionLogo = fac.logo; await saveFactionParcel(p); }
      }
    }

    fac.updatedAt = getUnixTime();
    await saveFaction(fac);
    res.json({ status: "OK", faction: serializeFactionPublic(fac) });
  });
});

app.post("/faction/web/manage", async (req, res) => {
  const { legacyName, password, targetUuid, action } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  const cleanTarget = String(targetUuid || "").trim().toLowerCase();
  const act = String(action || "").toUpperCase().trim();

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const member = fac.members[cleanTarget];
    if (!member || cleanTarget === fac.leaderUuid) {
      return res.status(400).json({ status: "ERROR", message: "Invalid target member." });
    }

    const now = getUnixTime();
    if (act === "KICK") {
      delete fac.members[cleanTarget];
    } else if (act === "SET_SUBLEADER") {
      member.role = "subleader";
    } else if (act === "SET_ENFORCER" || act === "SET_CAPANGA") {
      member.role = "enforcer";
    } else if (act === "SET_LEADER") {
      const oldLeader = fac.leaderUuid;
      const newPassword = generateFactionPassword(cleanTarget, now);
      fac.members[oldLeader].role = "subleader";
      member.role = "leader";
      fac.leaderUuid = cleanTarget;
      fac.leaderName = member.legacyName;
      fac.password = newPassword;
      fac.updatedAt = now;
      await saveFaction(fac);
      return res.json({
        status: "OK",
        transferred: true,
        newLeaderLogin: member.legacyName,
        newLeaderPassword: newPassword
      });
    } else {
      return res.status(400).json({ status: "ERROR", message: "Invalid action." });
    }

    fac.updatedAt = now;
    await saveFaction(fac);
    res.json({ status: "OK", members: Object.values(fac.members) });
  });
});

// Leader abandons a conquered parcel via website
app.post("/faction/web/abandon-parcel", async (req, res) => {
  const { legacyName, password, parcelUuid } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  const cleanParcel = String(parcelUuid || "").trim().toLowerCase();
  if (!isValidUuid(cleanParcel)) {
    return res.status(400).json({ status: "ERROR", message: "Invalid parcel UUID." });
  }

  await withLock(`FACTION_PARCEL_${cleanParcel}`, async () => {
    const pObj = FACTION_PARCELS.get(cleanParcel);
    if (!pObj || pObj.factionId !== fac.id) {
      return res.status(404).json({ status: "ERROR", message: "Parcel not found or not controlled by your faction." });
    }

    const abandonedName = `${pObj.regionName} — ${pObj.parcelName || "Parcel"}`;
    await deleteFactionParcelFromDb(cleanParcel);
    res.json({
      status: "OK",
      abandonedParcelUuid: cleanParcel,
      abandonedName,
      faction: serializeFactionPublic(fac)
    });
  });
});

// --------------------------------------------------------
// WEBSITE ENDPOINTS — SISTEMA DE ALIANÇAS (BASEADO NO permId)
// --------------------------------------------------------

// Enviar convite de aliança digitando o nome atual da facção alvo
app.post("/faction/web/alliance/invite", async (req, res) => {
  const { legacyName, password, targetFactionName } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  const searchName = sanitizeFactionName(targetFactionName).toLowerCase();
  if (!searchName) return res.status(400).json({ status: "ERROR", message: "Enter a faction name." });

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    let targetFac = null;
    for (const f of FACTIONS.values()) {
      if (f.name.toLowerCase() === searchName) { targetFac = f; break; }
    }

    if (!targetFac) {
      return res.status(404).json({ status: "ERROR", message: `Faction "${targetFactionName}" not found.` });
    }
    if (targetFac.permId === fac.permId) {
      return res.status(400).json({ status: "ERROR", message: "You cannot form an alliance with your own faction." });
    }

    const myAlly = getFactionAlliance(fac);
    const targetAlly = getFactionAlliance(targetFac);

    if (myAlly && targetAlly && myAlly.id === targetAlly.id) {
      return res.status(400).json({ status: "ERROR", message: "You are already allied with this faction." });
    }
    if (targetAlly) {
      return res.status(400).json({ status: "ERROR", message: `"${targetFac.name}" is already in another alliance.` });
    }

    const dup = ALLIANCE_INVITES.find(i =>
      (i.fromPermId === fac.permId && i.toPermId === targetFac.permId) ||
      (i.fromPermId === targetFac.permId && i.toPermId === fac.permId)
    );
    if (dup) {
      return res.status(400).json({ status: "ERROR", message: "There is already a pending alliance request between these factions." });
    }

    const invite = {
      id: `inv_${getUnixTime()}_${crypto.randomBytes(2).toString("hex")}`,
      fromPermId: fac.permId,
      toPermId: targetFac.permId,
      allianceId: myAlly ? myAlly.id : "",
      createdAt: getUnixTime()
    };

    ALLIANCE_INVITES.push(invite);
    await saveAllianceInvites();

    res.json({
      status: "OK",
      message: `Alliance request sent to "${targetFac.name}".`,
      alliance: serializeAllianceForLeader(fac)
    });
  });
});

// Aceitar ou recusar convite pendente de aliança
app.post("/faction/web/alliance/respond", async (req, res) => {
  const { legacyName, password, inviteId, accept } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const idx = ALLIANCE_INVITES.findIndex(i => i.id === String(inviteId) && i.toPermId === fac.permId);
    if (idx === -1) {
      return res.status(404).json({ status: "ERROR", message: "Alliance request not found or already handled." });
    }

    const inv = ALLIANCE_INVITES[idx];
    ALLIANCE_INVITES.splice(idx, 1);

    if (!accept) {
      await saveAllianceInvites();
      return res.json({ status: "OK", accepted: false, alliance: serializeAllianceForLeader(fac) });
    }

    if (getFactionAlliance(fac)) {
      await saveAllianceInvites();
      return res.status(400).json({ status: "ERROR", message: "You are already in an alliance. Leave it first." });
    }

    const fromFac = getFactionByPermId(inv.fromPermId);
    if (!fromFac) {
      await saveAllianceInvites();
      return res.status(404).json({ status: "ERROR", message: "The inviting faction no longer exists." });
    }

    let ally = getFactionAlliance(fromFac);
    if (ally) {
      if (!ally.members.includes(fac.permId)) ally.members.push(fac.permId);
      await saveAlliance(ally);
      await pushFactionNews("ALLIANCE_JOIN", `🤝 ${fac.name} joined ${fromFac.name}'s street alliance!`);
    } else {
      const now = getUnixTime();
      ally = {
        id: `ally_${now}_${crypto.randomBytes(3).toString("hex")}`,
        members: [fromFac.permId, fac.permId],
        kickVotes: {},
        createdAt: now
      };
      await saveAlliance(ally);
      await pushFactionNews("ALLIANCE_FORMED", `🤝 ALLIANCE FORMED! ${fromFac.name} and ${fac.name} joined forces!`);
    }

    // Remove outros convites recebidos por esta facção (já entrou em uma aliança)
    ALLIANCE_INVITES = ALLIANCE_INVITES.filter(i => i.toPermId !== fac.permId);
    await saveAllianceInvites();

    res.json({
      status: "OK",
      accepted: true,
      alliance: serializeAllianceForLeader(fac)
    });
  });
});

// Cancelar convite enviado
app.post("/faction/web/alliance/cancel-invite", async (req, res) => {
  const { legacyName, password, inviteId } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const before = ALLIANCE_INVITES.length;
    ALLIANCE_INVITES = ALLIANCE_INVITES.filter(i => !(i.id === String(inviteId) && i.fromPermId === fac.permId));
    if (ALLIANCE_INVITES.length !== before) await saveAllianceInvites();
    res.json({ status: "OK", alliance: serializeAllianceForLeader(fac) });
  });
});

// Sair da aliança a qualquer momento
app.post("/faction/web/alliance/leave", async (req, res) => {
  const { legacyName, password } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const ally = getFactionAlliance(fac);
    if (!ally) return res.status(400).json({ status: "ERROR", message: "Your faction is not in an alliance." });

    await removePermIdFromAlliancesAndInvites(fac.permId);
    await pushFactionNews("ALLIANCE_LEAVE", `💔 ${fac.name} left their street alliance.`);

    res.json({ status: "OK", alliance: serializeAllianceForLeader(fac) });
  });
});

// Abrir ou participar de votação para expulsar uma gangue da aliança
app.post("/faction/web/alliance/kick-vote", async (req, res) => {
  const { legacyName, password, targetPermId } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  const cleanTargetPid = String(targetPermId || "").trim().toUpperCase();

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    const ally = getFactionAlliance(fac);
    if (!ally) return res.status(400).json({ status: "ERROR", message: "Your faction is not in an alliance." });

    if (ally.members.length < 3) {
      return res.status(400).json({ status: "ERROR", message: "An alliance with only 2 gangs does not need a vote — simply click Leave Alliance." });
    }
    if (cleanTargetPid === fac.permId) {
      return res.status(400).json({ status: "ERROR", message: "You cannot vote to kick your own faction." });
    }
    if (!ally.members.includes(cleanTargetPid)) {
      return res.status(404).json({ status: "ERROR", message: "Target faction is not in your alliance." });
    }

    if (!ally.kickVotes) ally.kickVotes = {};
    if (!ally.kickVotes[cleanTargetPid]) {
      ally.kickVotes[cleanTargetPid] = { openedBy: fac.permId, openedAt: getUnixTime(), voters: [] };
    }

    const voteObj = ally.kickVotes[cleanTargetPid];
    if (!voteObj.voters.includes(fac.permId)) {
      voteObj.voters.push(fac.permId);
    }

    const otherMembersCount = ally.members.length - 1;
    const votesNeeded = Math.floor(otherMembersCount / 2) + 1;
    const targetFac = getFactionByPermId(cleanTargetPid);
    const targetName = targetFac ? targetFac.name : "Unknown Gang";

    if (voteObj.voters.length >= votesNeeded) {
      await removePermIdFromAlliancesAndInvites(cleanTargetPid);
      await pushFactionNews("ALLIANCE_KICK", `👢 ${targetName} was voted out of their street alliance!`);
      return res.json({
        status: "OK",
        kicked: true,
        targetName,
        alliance: serializeAllianceForLeader(fac)
      });
    }

    await saveAlliance(ally);
    res.json({
      status: "OK",
      kicked: false,
      targetName,
      votesCurrent: voteObj.voters.length,
      votesNeeded,
      alliance: serializeAllianceForLeader(fac)
    });
  });
});

app.post("/faction/web/delete", async (req, res) => {
  const { legacyName, password } = req.body;
  const fac = authenticateFactionLeader(legacyName, password);
  if (!fac) return res.status(401).json({ status: "ERROR", message: "Unauthorized." });

  await withLock("FACTION_GLOBAL_LOCK", async () => {
    await deleteFactionFromDb(fac.id);
    res.json({ status: "OK" });
  });
});

// Mapa público completo: facções, parcelas (+ escudo), alianças, capturas piscando e mural de notícias
app.get("/faction/web/map", (req, res) => {
  pruneStaleActiveCaptures();
  const now = getUnixTime();

  const factions = [];
  for (const fac of FACTIONS.values()) {
    factions.push(serializeFactionPublic(fac));
  }
  factions.sort((a, b) => b.totalArea - a.totalArea || b.level - a.level);

  const parcels = [];
  for (const p of FACTION_PARCELS.values()) {
    const shieldRemaining = Math.max(0, (p.shieldUntil || 0) - now);
    parcels.push({
      ...p,
      shieldRemaining,
      shielded: shieldRemaining > 0
    });
  }

  const alliances = [];
  for (const ally of ALLIANCES.values()) {
    const memberNames = ally.members.map(pid => {
      const mf = getFactionByPermId(pid);
      return mf ? { permId: mf.permId, id: mf.id, name: mf.name } : null;
    }).filter(Boolean);
    if (memberNames.length >= 2) {
      alliances.push({ id: ally.id, members: memberNames });
    }
  }

  res.json({
    status: "OK",
    totalFactions: factions.length,
    totalParcels: parcels.length,
    factions,
    parcels,
    alliances,
    activeCaptures: Array.from(FACTION_ACTIVE_CAPTURES.values()),
    news: FACTION_NEWS
  });
});

app.get("/faction/web/factions", (req, res) => {
  const factions = [];
  for (const fac of FACTIONS.values()) {
    factions.push(serializeFactionPublic(fac));
  }
  factions.sort((a, b) => b.level - a.level || b.memberCount - a.memberCount);
  res.json({ status: "OK", factions });
});

//////////////////////////////////////////////////////////////////////////////////////////

app.get("/", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log("API running on port", PORT));
