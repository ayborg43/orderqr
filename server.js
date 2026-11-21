import http from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? "/tmp/orderqr-data" : path.join(ROOT, "data"));
const STORE_FILE = path.join(DATA_DIR, "store.json");

/* Multi-restaurant platform. Every restaurant ("tenant") lives under its own
   slug and owns its menu, tables, orders, settings and staff logins. The
   platform starts empty: the first restaurant is created via /signup. */
const LEGACY_DEMO_SLUG = "the-corner-table"; // pre-production demo tenant, removed on boot
const STATIONS = ["Grill", "Kitchen", "Drinks", "Dessert"];
const DIETARY = ["vegan", "vegetarian", "gluten-free", "spicy"];
const RESERVED_SLUGS = new Set(["api", "r", "signup", "guest", "kitchen", "admin", "qr", "fonts", "app", "ui", "index", "www", "static", "assets", "login", "superadmin", "restaurant", "restaurants", "health", "status", "help", "support"]);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const seedMenu = [
  { id: "smash-burger", name: "Smash Burger", desc: "Double smashed patty, pickles, house sauce, brioche bun.", price: 16.5, category: "Mains", station: "Grill", dietary: [], available: true,
    modifierGroups: [
      { id: "cook", name: "Cooking preference", required: true, options: [{ id: "rare", name: "Rare", delta: 0 }, { id: "medium", name: "Medium", delta: 0 }, { id: "well", name: "Well done", delta: 0 }] },
      { id: "extras", name: "Extras", required: false, options: [{ id: "cheese", name: "Extra cheese", delta: 1.5 }, { id: "bacon", name: "Beef bacon", delta: 2.5 }, { id: "egg", name: "Fried egg", delta: 1.0 }] }] },
  { id: "grilled-salmon", name: "Grilled Salmon", desc: "Charred lemon, herb oil, seasonal greens.", price: 24.0, category: "Mains", station: "Grill", dietary: ["gluten-free"], available: true,
    modifierGroups: [{ id: "cook", name: "Cooking preference", required: true, options: [{ id: "medium", name: "Medium", delta: 0 }, { id: "well", name: "Well done", delta: 0 }] }] },
  { id: "mushroom-risotto", name: "Mushroom Risotto", desc: "Arborio rice, wild mushrooms, parmesan, truffle oil.", price: 19.0, category: "Mains", station: "Kitchen", dietary: ["vegetarian", "gluten-free"], available: true, modifierGroups: [] },
  { id: "green-bowl", name: "Green Goddess Bowl", desc: "Quinoa, avocado, edamame, tahini dressing.", price: 14.5, category: "Mains", station: "Kitchen", dietary: ["vegan", "gluten-free"], available: true,
    modifierGroups: [{ id: "extras", name: "Extras", required: false, options: [{ id: "halloumi", name: "Grilled halloumi", delta: 3.0 }, { id: "tofu", name: "Extra tofu", delta: 2.0 }] }] },
  { id: "tomato-soup", name: "Roasted Tomato Soup", desc: "Slow-roasted tomatoes, basil, sourdough crisp.", price: 9.0, category: "Starters", station: "Kitchen", dietary: ["vegan"], available: true, modifierGroups: [] },
  { id: "burrata", name: "Burrata & Heirloom Tomato", desc: "Creamy burrata, basil oil, aged balsamic.", price: 12.0, category: "Starters", station: "Kitchen", dietary: ["vegetarian", "gluten-free"], available: true, modifierGroups: [] },
  { id: "spicy-wings", name: "Spicy Chicken Wings", desc: "Chilli glaze, sesame, spring onion. Serves 2.", price: 11.5, category: "Starters", station: "Grill", dietary: ["spicy"], available: true,
    modifierGroups: [{ id: "heat", name: "Heat level", required: true, options: [{ id: "mild", name: "Mild", delta: 0 }, { id: "hot", name: "Hot", delta: 0 }, { id: "extra", name: "Extra hot", delta: 0 }] }] },
  { id: "fries", name: "Hand-Cut Fries", desc: "Sea salt, rosemary, aioli.", price: 6.5, category: "Sides", station: "Kitchen", dietary: ["vegan"], available: true, modifierGroups: [] },
  { id: "fresh-lemonade", name: "Fresh Lemonade", desc: "Pressed lemons, mint, lightly sweetened.", price: 5.0, category: "Drinks", station: "Drinks", dietary: ["vegan", "gluten-free"], available: true,
    modifierGroups: [{ id: "size", name: "Size", required: true, options: [{ id: "regular", name: "Regular", delta: 0 }, { id: "large", name: "Large", delta: 1.5 }] }] },
  { id: "iced-tea", name: "Peach Iced Tea", desc: "Cold-brew black tea, peach, lemon.", price: 5.5, category: "Drinks", station: "Drinks", dietary: ["vegan", "gluten-free"], available: true, modifierGroups: [] },
  { id: "flat-white", name: "Flat White", desc: "Double shot, velvety steamed milk.", price: 4.5, category: "Drinks", station: "Drinks", dietary: ["vegetarian", "gluten-free"], available: true, modifierGroups: [] },
  { id: "choc-fondant", name: "Chocolate Fondant", desc: "Warm fondant, vanilla bean ice cream.", price: 9.5, category: "Desserts", station: "Dessert", dietary: ["vegetarian"], available: true, modifierGroups: [] },
  { id: "fruit-sorbet", name: "Seasonal Fruit Sorbet", desc: "Ask staff for today's flavour.", price: 7.0, category: "Desserts", station: "Dessert", dietary: ["vegan", "gluten-free"], available: false, modifierGroups: [] },
];

const clone = (x) => JSON.parse(JSON.stringify(x));
const money = (n) => Math.round(n * 100) / 100;
// Each table has a secret key that is printed inside its QR code, so only someone
// who has scanned that table can order, call staff, or see its bill. Tables that
// predate keys have none and keep working until a manager issues a new code.
const newKey = () => crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x").slice(0, 10);
const makeTables = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: `Table ${i + 1}`, key: newKey() }));
// `cardSurchargePct` is the optional service charge (the app takes no card payments).
// It starts at 0: restaurants opt in. `v: 2` marks settings that use this default.
const defaultSettings = () => ({ cardSurchargePct: 0, holidaySurchargePct: 10, holidayMode: false, v: 2 });
function newRestaurant({ slug, name, tables = 10, sampleMenu = true }) {
  return {
    slug, name, createdAt: new Date().toISOString(),
    tables: makeTables(tables), menu: sampleMenu ? clone(seedMenu) : [],
    orders: [], assistRequests: [], settings: defaultSettings(), seq: 1000, staff: [], sessions: {},
  };
}

/* --- Passwords: scrypt with a per-account salt --- */
const b64url = (s) => Buffer.from(s).toString("base64url");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Hashing runs off the main thread, so a burst of logins cannot stall every other request.
const scrypt = (pw, salt) => new Promise((resolve, reject) => crypto.scrypt(String(pw), salt, 32, (e, key) => (e ? reject(e) : resolve(key.toString("base64url")))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("base64url");
  return `scrypt$${salt}$${await scrypt(pw, salt)}`;
}
async function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  return safeEq(await scrypt(pw, salt), hash);
}
const DUMMY_HASH = await hashPassword("not-a-real-password"); // keeps unknown-user logins as slow as real ones

/* --- Store: one JSON document { restaurants: { [slug]: restaurant } } --- */
function migrate(raw) {
  if (raw && raw.restaurants) return raw;
  // v1 stored a single restaurant at the top level; it keeps its own name/slug.
  const { restaurantName, ...settings } = raw?.settings || {};
  const name = restaurantName || "Restaurant";
  const slug = slugify(name) || "restaurant";
  return { restaurants: { [slug]: {
    slug, name, createdAt: new Date().toISOString(),
    tables: raw?.tables || makeTables(12), menu: raw?.menu || clone(seedMenu), orders: raw?.orders || [],
    assistRequests: raw?.assistRequests || [], settings: { ...defaultSettings(), ...settings }, seq: raw?.seq || 1000, staff: [],
  } } };
}

/* Persistence. Postgres when DATABASE_URL is set (Dokploy), otherwise a JSON file
   (local dev, tests, Vercel).

   Postgres layout: a restaurant's settings, menu, tables, staff and so on are one
   small JSONB row, and every order is its own row, so a new order is one tiny
   upsert however much data exists. Only what changed is written, and rows are
   never deleted just because this process does not know about them. A Postgres
   advisory lock keeps a second instance from running on the same database at the
   same time (it waits until the first one stops), so two processes can never
   overwrite each other. A failed write is reported to the caller (503) and kept
   dirty, then retried every few seconds. */
const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_LOCK_KEY = 727274;
let pool = null, lockClient = null;
class StorageError extends Error {}
let dirtySeq = 0, fileDirty = false;
const dirty = { rests: new Map(), orders: new Map(), deleted: new Map() };
const orderSeq = (o) => parseInt(String(o.id).replace(/\D/g, ""), 10) || 0;
const markRest = (rest) => { fileDirty = true; dirty.rests.set(rest.slug, ++dirtySeq); };
const markOrder = (rest, o) => { fileDirty = true; dirty.orders.set(`${rest.slug}|${o.id}`, { slug: rest.slug, o, v: ++dirtySeq }); };
const markDeleted = (slug) => {
  fileDirty = true; dirty.deleted.set(slug, ++dirtySeq); dirty.rests.delete(slug);
  for (const k of [...dirty.orders.keys()]) if (k.startsWith(slug + "|")) dirty.orders.delete(k);
};
const hasDirty = () => (pool ? dirty.rests.size + dirty.orders.size + dirty.deleted.size > 0 : fileDirty);
const markAllDirty = () => { for (const rest of Object.values(store.restaurants)) { markRest(rest); for (const o of rest.orders || []) markOrder(rest, o); } };
const persist = (rest, order) => { if (rest) markRest(rest); if (order) markOrder(rest, order); return saveStore(); };

async function initDb() {
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  // An idle client dropping (database restart, network blip) must not crash the process.
  pool.on("error", (e) => console.error("Postgres pool error:", e.message));
  await pool.query(`CREATE TABLE IF NOT EXISTS restaurants (
    slug TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    slug TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (slug, id))`);
  await pool.query("CREATE INDEX IF NOT EXISTS orders_slug_seq ON orders (slug, seq)");
  // Single writer: hold this lock for the life of the process.
  lockClient = await pool.connect();
  lockClient.on("error", (e) => { console.error("Lost the database lock connection:", e.message); process.exit(1); });
  const got = (await lockClient.query("SELECT pg_try_advisory_lock($1) AS ok", [DB_LOCK_KEY])).rows[0].ok;
  if (!got) {
    console.log("Another instance holds the database lock; waiting for it to stop...");
    await lockClient.query("SELECT pg_advisory_lock($1)", [DB_LOCK_KEY]);
    console.log("Database lock acquired.");
  }
}
let importedFromFile = false;
async function loadFromDb() {
  const { rows } = await pool.query("SELECT data FROM restaurants");
  if (!rows.length) {
    // First boot on an empty DB: import the legacy JSON store once, if present.
    if (existsSync(STORE_FILE)) {
      try {
        const raw = migrate(JSON.parse(await readFile(STORE_FILE, "utf8")));
        console.log(`Imported ${Object.keys(raw.restaurants).length} restaurant(s) from ${STORE_FILE} into Postgres`);
        importedFromFile = true;
        return raw;
      } catch (e) { console.error(`Could not import ${STORE_FILE} (${e.message}); starting fresh`); }
    }
    return { restaurants: {} };
  }
  const restaurants = {}, embedded = [];
  for (const r of rows) {
    const rest = r.data;
    // Older rows kept every order inside the restaurant document; move them to the orders table.
    if (Array.isArray(rest.orders) && rest.orders.length) embedded.push(rest);
    const legacy = Array.isArray(rest.orders) ? rest.orders : [];
    rest.orders = []; rest._legacyOrders = legacy;
    restaurants[rest.slug] = rest;
  }
  const { rows: orderRows } = await pool.query("SELECT slug, data FROM orders ORDER BY slug, seq");
  for (const r of orderRows) restaurants[r.slug]?.orders.push(r.data);
  for (const rest of Object.values(restaurants)) {
    const have = new Set(rest.orders.map((o) => o.id));
    for (const o of rest._legacyOrders) if (!have.has(o.id)) { rest.orders.push(o); markOrder(rest, o); }
    if (rest._legacyOrders.length) { rest.orders.sort((x, y) => orderSeq(x) - orderSeq(y)); markRest(rest); }
    delete rest._legacyOrders;
  }
  if (embedded.length) console.log(`Moved embedded orders of ${embedded.length} restaurant(s) into the orders table`);
  return { restaurants };
}
async function flushDb() {
  if (!hasDirty()) return;
  const snap = { rests: new Map(dirty.rests), orders: new Map(dirty.orders), deleted: new Map(dirty.deleted) };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const slug of snap.deleted.keys()) {
      await client.query("DELETE FROM orders WHERE slug = $1", [slug]);
      await client.query("DELETE FROM restaurants WHERE slug = $1", [slug]);
    }
    for (const slug of snap.rests.keys()) {
      const rest = store.restaurants[slug]; if (!rest) continue;
      const { orders, ...doc } = rest;
      await client.query(
        "INSERT INTO restaurants (slug, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (slug) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
        [slug, JSON.stringify(doc)]);
    }
    for (const { slug, o } of snap.orders.values()) {
      await client.query(
        "INSERT INTO orders (slug, id, seq, data, updated_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (slug, id) DO UPDATE SET data = EXCLUDED.data, seq = EXCLUDED.seq, updated_at = now()",
        [slug, o.id, orderSeq(o), JSON.stringify(o)]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
  // Clear only what was written: anything changed again during the write stays dirty.
  for (const [k, v] of snap.rests) if (dirty.rests.get(k) === v) dirty.rests.delete(k);
  for (const [k, v] of snap.orders) if (dirty.orders.get(k)?.v === v.v) dirty.orders.delete(k);
  for (const [k, v] of snap.deleted) if (dirty.deleted.get(k) === v) dirty.deleted.delete(k);
}
async function flushFile() {
  fileDirty = false;
  try {
    const tmp = `${STORE_FILE}.tmp`;
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(tmp, JSON.stringify(store));
    await rename(tmp, STORE_FILE);
  } catch (e) { fileDirty = true; throw e; }
}

let store;
async function loadStore() {
  if (DATABASE_URL) {
    await initDb();
    store = await loadFromDb();
  } else {
    await mkdir(DATA_DIR, { recursive: true });
    if (existsSync(STORE_FILE)) {
      try { store = migrate(JSON.parse(await readFile(STORE_FILE, "utf8"))); }
      catch (e) {
        // Never silently discard data: keep the unreadable file next to the new one.
        const backup = `${STORE_FILE}.corrupt-${Date.now()}`;
        try { await rename(STORE_FILE, backup); console.error(`store.json unreadable (${e.message}); moved to ${backup}`); } catch {}
      }
    }
    fileDirty = true;
  }
  if (!store) store = { restaurants: {} };
  if (importedFromFile) markAllDirty();
  // Production cleanup: the pre-launch demo tenant is deleted, never recreated.
  if (store.restaurants[LEGACY_DEMO_SLUG]) {
    delete store.restaurants[LEGACY_DEMO_SLUG]; markDeleted(LEGACY_DEMO_SLUG);
    console.log(`Removed legacy demo restaurant (${LEGACY_DEMO_SLUG})`);
  }
  for (const rest of Object.values(store.restaurants)) {
    rest.sessions ||= {};
    // The old default silently added a 1.5% "card surcharge" to every order, but the app takes no
    // card payments. Restaurants that still have exactly that default are reset to no charge once.
    if (rest.settings && rest.settings.v !== 2) {
      if (rest.settings.cardSurchargePct === 1.5) rest.settings.cardSurchargePct = 0;
      rest.settings.v = 2; markRest(rest);
    }
    // Normalise older payment states to the manual-collection flow.
    for (const o of rest.orders || []) {
      if (o.payment?.state === "pay-at-counter") { o.payment.state = "awaiting-collection"; markOrder(rest, o); }
      if (o.payment?.state === "paid-demo") { o.payment = { state: "paid", method: "manual", confirmedAt: o.createdAt }; markOrder(rest, o); }
    }
  }
  await saveStore();
  // Writes that failed (database hiccup) are retried in the background until they land.
  setInterval(() => { if (hasDirty()) saveStore().catch(() => {}); }, 5000).unref();
}
let saveChain = Promise.resolve();
function saveStore() {
  // Serialized writes, awaited by every request that changes data (serverless
  // functions may freeze right after responding). Rejects with StorageError so
  // callers never report success for data that was not stored.
  const run = saveChain.then(async () => {
    try { if (pool) await flushDb(); else await flushFile(); }
    catch (e) { console.error("store write failed:", e.message); throw new StorageError(e.message); }
  });
  saveChain = run.catch(() => {});
  return run;
}

// --- live events (SSE), kept apart per restaurant ---
const clients = new Map(); // slug -> Set<res>  (staff screens)
const tableClients = new Map(); // "slug|tableId" -> Set<res>  (guests watching their own table)
function broadcast(slug, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const set = clients.get(slug);
  if (set) for (const res of set) { try { res.write(msg); } catch { set.delete(res); } }
  // Guests only learn that one of their table's orders changed; they re-fetch it themselves.
  if (event === "order" && data?.tableId) {
    const tset = tableClients.get(`${slug}|${data.tableId}`);
    if (tset) { const m = `event: order\ndata: ${JSON.stringify({ id: data.id, status: data.status })}\n\n`; for (const res of tset) { try { res.write(m); } catch { tset.delete(res); } } }
  }
}
// Open an event stream. Pings keep idle connections alive through proxies (Traefik, nginx).
function openStream(req, res, set) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`retry: 3000\nevent: ready\ndata: {}\n\n`);
  set.add(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
  req.on("close", () => { clearInterval(ping); set.delete(res); });
}

const STATUSES = ["Received", "Preparing", "Ready", "Served", "Cancelled"];

function priceOrder(rest, rawItems) {
  const items = [];
  if (!Array.isArray(rawItems)) return { error: "Basket is empty" };
  if (rawItems.length > 40) return { error: "That order is too large. Please split it into smaller orders." };
  if (rawItems.reduce((n, r) => n + (Math.max(1, parseInt(r?.qty, 10) || 1)), 0) > 200) return { error: "That order is too large. Please split it into smaller orders." };
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") return { error: "Invalid basket item" };
    const menuItem = rest.menu.find((m) => m.id === raw.menuItemId);
    if (!menuItem) return { error: `Unknown item: ${String(raw.menuItemId).slice(0, 60)}` };
    if (!menuItem.available) return { error: `Sold out: ${menuItem.name}`, soldOut: menuItem.id };
    const qty = Math.max(1, Math.min(20, parseInt(raw.qty, 10) || 1));
    let unit = menuItem.price;
    const chosen = [];
    const wanted = new Set(Array.isArray(raw.modifiers) ? raw.modifiers.map(String) : []);
    for (const group of menuItem.modifierGroups || []) {
      const picked = group.options.filter((o) => wanted.has(o.id));
      if (group.required && picked.length !== 1) return { error: `Choose ${group.name} for ${menuItem.name}` };
      for (const opt of picked) { unit += opt.delta; chosen.push({ group: group.name, name: opt.name, delta: opt.delta }); }
    }
    items.push({ menuItemId: menuItem.id, name: menuItem.name, station: menuItem.station, qty, unitPrice: money(unit), modifiers: chosen, note: String(raw.note || "").slice(0, 200), lineTotal: money(unit * qty) });
  }
  if (!items.length) return { error: "Basket is empty" };
  const subtotal = money(items.reduce((s, i) => s + i.lineTotal, 0));
  const st = rest.settings, surcharges = [];
  if (st.cardSurchargePct) surcharges.push({ name: `Service charge (${st.cardSurchargePct}%)`, amount: money(subtotal * st.cardSurchargePct / 100) });
  if (st.holidayMode && st.holidaySurchargePct) surcharges.push({ name: `Public holiday surcharge (${st.holidaySurchargePct}%)`, amount: money(subtotal * st.holidaySurchargePct / 100) });
  const total = money(subtotal + surcharges.reduce((s, x) => s + x.amount, 0));
  return { items, subtotal, surcharges, total };
}

/* No payment in the app at all: a waiter collects the money in person, staff
   confirm collection on the site, and only then can the guest open that
   order's invoice and receipt. New orders start "awaiting-collection". */

/* --- Staff authentication ---------------------------------------------------
   Signed, stateless session cookie (HMAC) per restaurant, so it works on
   serverless too and a login for one restaurant never opens another. In
   production without SESSION_SECRET a random secret is generated at boot, so
   cookies cannot be forged (they just expire on restart). */
/* Fail fast on weak production config (long-lived servers; Vercel keeps the
   boot-time random secret fallback since it is configured per deployment). */
if (IS_PROD && !process.env.VERCEL) {
  const missing = [];
  if (!process.env.SESSION_SECRET) missing.push("SESSION_SECRET");
  if (!process.env.PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL");
  if (missing.length) { console.error(`Refusing to start in production: missing ${missing.join(", ")}`); process.exit(1); }
}
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PROD ? crypto.randomBytes(32).toString("hex") : "dev-only-change-me-in-production");
if (IS_PROD && !process.env.SESSION_SECRET) console.warn("SESSION_SECRET is not set: staff sessions will not survive restarts or span instances.");
const SESSION_MS = 12 * 60 * 60 * 1000;
const signPayload = (payload) => crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
const cookieName = (slug) => `qr_staff_${slug}`;
// A session is bound to the account it was issued for: the fingerprint covers the restaurant's
// creation time, the username and the password hash. Resetting the password, removing the account,
// or deleting and re-registering the address therefore ends every old session at once.
const fingerprint = (rest, acct) => crypto.createHash("sha256").update(`${rest.createdAt}|${String(acct.username).toLowerCase()}|${acct.hash}`).digest("base64url").slice(0, 22);
function makeSession(acct, rest) {
  const payload = b64url(JSON.stringify({ u: acct.username, r: acct.role, s: rest.slug, f: fingerprint(rest, acct), exp: Date.now() + SESSION_MS }));
  return `${payload}.${signPayload(payload)}`;
}
function staffFromReq(req, rest) {
  const prefix = cookieName(rest.slug) + "=";
  const raw = String(req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(prefix));
  if (!raw) return null;
  const [payload, sig] = raw.slice(prefix.length).split(".");
  if (!payload || !sig || !safeEq(sig, signPayload(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!(s.u && s.r && s.s === rest.slug && s.exp > Date.now())) return null;
    const acct = rest.staff.find((a) => a.username.toLowerCase() === String(s.u).toLowerCase());
    if (!acct || acct.role !== s.r || !safeEq(s.f || "", fingerprint(rest, acct))) return null;
    return { username: acct.username, role: acct.role };
  } catch { return null; }
}
function sessionCookie(req, slug, value, maxAgeSec) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${cookieName(slug)}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
function requireStaff(req, res, rest, roles) {
  const staff = staffFromReq(req, rest);
  if (!staff) { json(res, 401, { error: "Staff sign-in required", code: "AUTH_REQUIRED" }); return null; }
  if (roles && !roles.includes(staff.role)) { json(res, 403, { error: "Your staff role cannot do this", code: "FORBIDDEN" }); return null; }
  return staff;
}
// Client address: only trust X-Forwarded-For where a platform proxy sets it
// (Vercel, or TRUST_PROXY=1 behind Dokploy/Traefik/nginx). Otherwise a proxy
// would bucket every guest under one IP for the throttles below.
const TRUST_PROXY = !!process.env.VERCEL || /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");
const clientIp = (req) => (TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket?.remoteAddress || "?";
// Login throttle: 8 failures per IP and restaurant per 5 minutes.
const loginFails = new Map();
const failKey = (ip, slug) => `${slug}|${ip}`;
function loginThrottled(ip, slug) { const rec = loginFails.get(failKey(ip, slug)); return rec && rec.count >= 8 && rec.until > Date.now(); }
function noteLoginFail(ip, slug) {
  if (loginFails.size > 5000) loginFails.clear();
  const k = failKey(ip, slug), rec = loginFails.get(k) || { count: 0, until: 0 };
  rec.count += 1; rec.until = Date.now() + 5 * 60 * 1000; loginFails.set(k, rec);
}
// Signup throttle: 5 new restaurants per IP per hour.
const signups = new Map();
const recentSignups = (ip) => (signups.get(ip) || []).filter((t) => Date.now() - t < 3600e3);
const SIGNUP_LIMIT = parseInt(process.env.SIGNUP_PER_HOUR, 10) || 5; // per address per hour
const signupThrottled = (ip) => recentSignups(ip).length >= SIGNUP_LIMIT;
function noteSignup(ip) { if (signups.size > 5000) signups.clear(); signups.set(ip, [...recentSignups(ip), Date.now()]); }

// Sliding-window style counters for anonymous (guest) endpoints. true = limit exceeded.
const buckets = new Map();
function rateHit(key, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > 20000) for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n > limit;
}
const json = (res, code, body, headers) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const tooMany = (res, msg, retry = 60) => json(res, 429, { error: msg }, { "Retry-After": String(retry) });
async function bodyJson(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 100_000) { const e = new Error("Request too large"); e.status = 413; throw e; } }
  try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

/* --- Validation helpers --- */
const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
function slugProblem(slug) {
  if (typeof slug !== "string" || slug.length < 3 || slug.length > 40 || !SLUG_RE.test(slug)) return "Use 3–40 letters, numbers and single hyphens.";
  if (RESERVED_SLUGS.has(slug)) return "That address is reserved. Try another.";
  if (store.restaurants[slug]) return "That address is already taken.";
  return null;
}
function cleanDish(b, partial) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("name")) { const v = String(b.name ?? "").trim(); if (!v || v.length > 80) return { error: "Dish name is required (up to 80 characters)." }; out.name = v; }
  if (!partial || has("desc")) out.desc = String(b.desc ?? "").trim().slice(0, 200);
  if (!partial || has("price")) { const v = Number(b.price); if (!Number.isFinite(v) || v < 0 || v > 1e7) return { error: "Enter a price between 0 and 10,000,000." }; out.price = money(v); }
  if (!partial || has("category")) { const v = String(b.category ?? "").trim(); if (!v || v.length > 30) return { error: "Category is required (up to 30 characters)." }; out.category = v; }
  if (!partial || has("station")) { if (!STATIONS.includes(b.station)) return { error: `Station must be one of: ${STATIONS.join(", ")}.` }; out.station = b.station; }
  if (!partial || has("dietary")) out.dietary = (Array.isArray(b.dietary) ? b.dietary : []).filter((d) => DIETARY.includes(d)).filter((d, i, a) => a.indexOf(d) === i);
  if (has("available")) out.available = !!b.available;
  return { value: out };
}
const pct = (v) => Number.isFinite(v) && v >= 0 && v <= 100;

async function createRestaurant(req, res) {
  const ip = clientIp(req);
  if (signupThrottled(ip)) return json(res, 429, { error: "Too many restaurants created from this address. Try again later." });
  const b = await bodyJson(req);
  const name = String(b.name || "").trim();
  if (name.length < 2 || name.length > 60) return json(res, 400, { error: "Restaurant name must be 2–60 characters.", field: "name" });
  const slug = String(b.slug || slugify(name)).trim().toLowerCase();
  const problem = slugProblem(slug);
  if (problem) return json(res, store.restaurants[slug] ? 409 : 400, { error: problem, field: "slug" });
  // Usernames are taken exactly as typed: no silent trimming, and no whitespace at all.
  const username = String(b.username || "");
  if (/\s/.test(username)) return json(res, 400, { error: "Username can’t contain spaces.", field: "username" });
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return json(res, 400, { error: "Use 3–32 letters, numbers, dots, dashes or underscores.", field: "username" });
  if (/^kitchen(-screen)?$/i.test(username)) return json(res, 400, { error: "That username is kept for the kitchen screen.", field: "username" });
  const password = String(b.password || "");
  if (password.length < 8 || password.length > 200) return json(res, 400, { error: "Password must be at least 8 characters.", field: "password" });
  const kitchenPassword = String(b.kitchenPassword || "");
  if (kitchenPassword && (kitchenPassword.length < 8 || kitchenPassword.length > 200)) return json(res, 400, { error: "Kitchen password must be at least 8 characters.", field: "kitchenPassword" });
  if (kitchenPassword && kitchenPassword === password) return json(res, 400, { error: "Use a different password from your own.", field: "kitchenPassword" });
  let tables = 10; // default when left blank
  if (b.tables !== undefined && b.tables !== null && b.tables !== "") {
    tables = Number(b.tables);
    if (!Number.isInteger(tables) || tables < 1 || tables > 60) return json(res, 400, { error: "Enter a whole number from 1 to 60.", field: "tables" });
  }
  const rest = newRestaurant({ slug, name, tables, sampleMenu: b.sampleMenu !== false });
  rest.staff.push({ username, role: "manager", hash: await hashPassword(password) });
  if (kitchenPassword) rest.staff.push({ username: "kitchen", role: "kitchen", hash: await hashPassword(kitchenPassword) });
  if (store.restaurants[slug]) return json(res, 409, { error: "That address is already taken.", field: "slug" }); // lost a race while hashing
  store.restaurants[slug] = rest; noteSignup(ip);
  try { await persist(rest); }
  catch (e) { delete store.restaurants[slug]; markDeleted(slug); throw e; } // never keep a restaurant that was not stored
  res.writeHead(201, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, slug, makeSession(rest.staff[0], rest), SESSION_MS / 1000) });
  res.end(JSON.stringify({ slug, name, adminUrl: `/r/${slug}/admin`, kitchenUser: kitchenPassword ? "kitchen" : null }));
}

/* --- Printable invoice / receipt (guest opens after payment is confirmed) --- */
const htmlEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const docMoney = (n) => "₦" + Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function docLocked(res, msg) {
  res.writeHead(403, { "Content-Type": "text/html" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available yet</title><style>body{margin:0;background:#faf7e9;color:#1a221d;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;margin:14vh auto;padding:0 1.25rem}h1{letter-spacing:-.02em}</style><main><h1>Not available yet</h1><p>${htmlEsc(msg)}</p></main>`);
}
function docPage(rest, o, kind) {
  const isReceipt = kind === "receipt";
  const rows = o.items.map((i) => `<tr><td>${i.qty} × ${htmlEsc(i.name)}${i.modifiers?.length ? `<br><small>${i.modifiers.map((m) => htmlEsc(m.name)).join(", ")}</small>` : ""}</td><td class="n">${docMoney(i.unitPrice)}</td><td class="n">${docMoney(i.lineTotal)}</td></tr>`).join("");
  const sur = (o.surcharges || []).map((s) => `<tr><td colspan="2">${htmlEsc(s.name)}</td><td class="n">${docMoney(s.amount)}</td></tr>`).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isReceipt ? "RECEIPT" : "INVOICE"} ${htmlEsc(o.id)} — ${htmlEsc(rest.name)}</title>
<style>body{margin:0;background:#fff;color:#1a221d;font:15px/1.5 system-ui,sans-serif}main{max-width:36rem;margin:2rem auto;padding:0 1.25rem}h1{letter-spacing:.08em;margin:.2rem 0}.paid{display:inline-block;border:2px solid #0e3727;color:#0e3727;font-weight:800;letter-spacing:.1em;padding:.15rem .6rem;border-radius:.4rem;transform:rotate(-3deg)}table{width:100%;border-collapse:collapse;margin:1rem 0}td,th{padding:.4rem .2rem;border-bottom:1px solid #e5e0cf;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}.tot td{font-weight:800;font-size:1.05rem;border-top:2px solid #1a221d}button{padding:.6rem 1.2rem;border-radius:999px;border:0;background:#0e3727;color:#fff;font-weight:700;cursor:pointer}@media print{button{display:none}}</style>
<main><p>${htmlEsc(rest.name)}</p><h1>${isReceipt ? "RECEIPT" : "INVOICE"}</h1>
<p>Order <b>${htmlEsc(o.id)}</b> · ${htmlEsc(o.tableLabel)}<br>Ordered ${new Date(o.createdAt).toLocaleString()}<br><span class="paid">PAID</span></p>
<table><tr><th>Item</th><th class="n">Each</th><th class="n">Total</th></tr>${rows}
<tr><td colspan="2">Subtotal</td><td class="n">${docMoney(o.subtotal)}</td></tr>${sur}
<tr class="tot"><td colspan="2">Total ${isReceipt ? "paid" : ""}</td><td class="n">${docMoney(o.total)}</td></tr></table>
${isReceipt ? `<p>Payment collected in person by your waiter and confirmed ${o.payment.confirmedAt ? "on " + new Date(o.payment.confirmedAt).toLocaleString() : ""}. Thank you.</p>` : `<p>Payment for this order has been collected in person and confirmed. This invoice records the amount paid.</p>`}
<button onclick="window.print()">Print / save as PDF</button></main>`;
}

/* --- Super admin: one platform operator, env credentials, own cookie --------
   Sees and moderates every restaurant, but is not a restaurant session and
   no restaurant session opens it. Unconfigured (no env) means disabled. */
const SUPERADMIN = { username: process.env.SUPERADMIN_USER || "", password: process.env.SUPERADMIN_PASSWORD || "" };
const SA_COOKIE = "qr_superadmin";
// Bound to the current super admin password: rotating it in the environment ends every session.
const superFingerprint = () => crypto.createHmac("sha256", SESSION_SECRET).update("superadmin|" + SUPERADMIN.password).digest("base64url").slice(0, 22);
function superFromReq(req) {
  if (!SUPERADMIN.username || !SUPERADMIN.password) return null;
  const raw = String(req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(SA_COOKIE + "="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(SA_COOKIE.length + 1).split(".");
  if (!payload || !sig || !safeEq(sig, signPayload(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return s.u === SUPERADMIN.username && s.r === "superadmin" && s.exp > Date.now() && safeEq(s.f || "", superFingerprint()) ? { username: s.u, role: "superadmin" } : null;
  } catch { return null; }
}
const superCookie = (req, value, maxAgeSec) => `${SA_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;
function requireSuper(req, res) {
  const sa = superFromReq(req);
  if (!sa) { json(res, 401, { error: "Super admin sign-in required", code: "AUTH_REQUIRED" }); return null; }
  return sa;
}
const restSummary = (rest) => {
  const paid = rest.orders.filter((o) => o.payment?.state === "paid");
  return {
    slug: rest.slug, name: rest.name, createdAt: rest.createdAt,
    tables: rest.tables.length, menuItems: rest.menu.length, staff: rest.staff.map((a) => ({ username: a.username, role: a.role })),
    orders: rest.orders.length, awaitingCollection: rest.orders.filter((o) => o.payment?.state === "awaiting-collection" && o.status !== "Cancelled").length,
    collected: money(paid.reduce((s, o) => s + o.total, 0)), openAssists: rest.assistRequests.filter((r) => !r.done).length,
    lastOrderAt: rest.orders.length ? rest.orders[rest.orders.length - 1].createdAt : null,
  };
};
async function handleSuperadmin(req, res, url) {
  const p = url.pathname;
  if (req.method === "POST" && p === "/api/superadmin/auth/login") {
    if (!SUPERADMIN.username || !SUPERADMIN.password) return json(res, 503, { error: "Super admin is not configured. Set SUPERADMIN_USER and SUPERADMIN_PASSWORD." });
    const ip = clientIp(req);
    if (loginThrottled(ip, "__platform__")) return json(res, 429, { error: "Too many failed sign-ins. Try again in a few minutes." });
    const b = await bodyJson(req);
    const ok = safeEq(String(b.username || ""), SUPERADMIN.username) & safeEq(String(b.password || ""), SUPERADMIN.password);
    if (!ok) { noteLoginFail(ip, "__platform__"); return json(res, 401, { error: "Wrong username or password" }); }
    loginFails.delete(failKey(ip, "__platform__"));
    const payload = b64url(JSON.stringify({ u: SUPERADMIN.username, r: "superadmin", f: superFingerprint(), exp: Date.now() + SESSION_MS }));
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": superCookie(req, `${payload}.${signPayload(payload)}`, SESSION_MS / 1000) });
    return res.end(JSON.stringify({ user: SUPERADMIN.username, role: "superadmin" }));
  }
  if (req.method === "POST" && p === "/api/superadmin/auth/logout") {
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": superCookie(req, "", 0) });
    return res.end(JSON.stringify({ ok: true }));
  }
  const sa = requireSuper(req, res); if (!sa) return;
  if (req.method === "GET" && p === "/api/superadmin/auth/me") return json(res, 200, { user: sa.username, role: sa.role });
  if (req.method === "GET" && p === "/api/superadmin/overview") {
    const restaurants = Object.values(store.restaurants).map(restSummary).sort((a, b) => a.name.localeCompare(b.name));
    return json(res, 200, {
      restaurants,
      totals: {
        restaurants: restaurants.length, orders: restaurants.reduce((s, r) => s + r.orders, 0),
        collected: money(restaurants.reduce((s, r) => s + r.collected, 0)),
        awaitingCollection: restaurants.reduce((s, r) => s + r.awaitingCollection, 0),
        openAssists: restaurants.reduce((s, r) => s + r.openAssists, 0),
      },
    });
  }
  const rm = p.match(/^\/api\/superadmin\/restaurants\/([a-z0-9-]+)(\/.*)?$/);
  if (!rm) return json(res, 404, { error: "Not found" });
  const rest = Object.prototype.hasOwnProperty.call(store.restaurants, rm[1]) ? store.restaurants[rm[1]] : null;
  if (!rest) return json(res, 404, { error: "Restaurant not found", code: "NO_RESTAURANT" });
  const sub = rm[2] || "/";
  if (req.method === "GET" && sub === "/") {
    return json(res, 200, { ...restSummary(rest), settings: rest.settings, orders: rest.orders.slice().reverse().slice(0, 50), tablesList: rest.tables });
  }
  if (req.method === "DELETE" && sub === "/") {
    const b = await bodyJson(req);
    if (b.confirm !== rest.slug) return json(res, 400, { error: `Type the restaurant address (${rest.slug}) to confirm deletion.` });
    delete store.restaurants[rest.slug]; clients.delete(rest.slug); markDeleted(rest.slug);
    await saveStore();
    return json(res, 200, { ok: true, deleted: rest.slug });
  }
  const reset = sub.match(/^\/staff\/([^/]+)\/reset-password$/);
  if (req.method === "POST" && reset) {
    const acct = rest.staff.find((a) => a.username.toLowerCase() === decodeURIComponent(reset[1]).toLowerCase());
    if (!acct) return json(res, 404, { error: "Staff account not found" });
    const b = await bodyJson(req);
    if (String(b.password || "").length < 8 || String(b.password).length > 200) return json(res, 400, { error: "Password must be at least 8 characters." });
    acct.hash = await hashPassword(b.password); // also ends that account's existing sessions
    await persist(rest);
    return json(res, 200, { ok: true, username: acct.username, role: acct.role });
  }
  const confirm = sub.match(/^\/orders\/([\w-]+)\/confirm-payment$/);
  if (req.method === "POST" && confirm) {
    const o = rest.orders.find((x) => x.id === confirm[1]);
    if (!o) return json(res, 404, { error: "Order not found" });
    if (o.status === "Cancelled") return json(res, 400, { error: "A cancelled order cannot be marked paid" });
    if (o.payment.state !== "paid") {
      o.payment = { state: "paid", method: "manual", confirmedAt: new Date().toISOString(), confirmedBy: `superadmin:${sa.username}` };
      await persist(rest, o); broadcast(rest.slug, "order", o);
    }
    return json(res, 200, { order: o });
  }
  return json(res, 404, { error: "Not found" });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p.startsWith("/api/superadmin/")) return handleSuperadmin(req, res, url);
  if (req.method === "POST" && p === "/api/restaurants") return createRestaurant(req, res);
  if (req.method === "GET" && p === "/api/restaurants/check") {
    const slug = String(url.searchParams.get("slug") || "").toLowerCase();
    const problem = slugProblem(slug);
    return json(res, 200, { slug, available: !problem, reason: problem });
  }
  const m = p.match(/^\/api\/r\/([a-z0-9-]+)(\/.*)?$/);
  if (!m) return json(res, 404, { error: "Not found" });
  const rest = Object.prototype.hasOwnProperty.call(store.restaurants, m[1]) ? store.restaurants[m[1]] : null;
  if (!rest) return json(res, 404, { error: "Restaurant not found", code: "NO_RESTAURANT" });
  return handleRestaurantApi(req, res, url, rest, m[2] || "/");
}

/* --- Guests: sessions, secret table keys, public order view --- */
const SESSION_IDLE_MS = 2 * 3600e3, SESSION_MAX_MS = 12 * 3600e3;
const FINAL = new Set(["Served", "Cancelled"]);
const orderToken = () => crypto.randomBytes(12).toString("hex");
// A table's "visit": orders belong to it until the table sits idle for 2 hours, the visit passes
// 12 hours, or staff clear the table. A new diner therefore never sees the previous diner's orders or bill.
function currentSession(rest, tableId) {
  const s = rest.sessions?.[tableId], now = Date.now();
  return s && now - s.lastAt <= SESSION_IDLE_MS && now - s.startedAt <= SESSION_MAX_MS ? s : null;
}
function openSession(rest, tableId) {
  rest.sessions ||= {};
  const now = Date.now();
  const s = currentSession(rest, tableId) || (rest.sessions[tableId] = { id: crypto.randomBytes(6).toString("hex"), startedAt: now, lastAt: now });
  s.lastAt = now; return s;
}
function touchSession(rest, o) { const s = rest.sessions?.[o.tableId]; if (s && s.id === o.sessionId) s.lastAt = Date.now(); }
function tableFor(rest, id, key) {
  const t = rest.tables.find((x) => x.id === String(id || ""));
  if (!t) return null;
  if (t.key && !safeEq(String(key || ""), t.key)) return null;
  return t;
}
// What a guest may see about an order: no staff names, idempotency keys or history.
const publicOrder = (o) => ({
  id: o.id, tableId: o.tableId, tableLabel: o.tableLabel, status: o.status, createdAt: o.createdAt,
  items: o.items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice, lineTotal: i.lineTotal, note: i.note, modifiers: (i.modifiers || []).map((m) => ({ group: m.group, name: m.name })) })),
  subtotal: o.subtotal, surcharges: o.surcharges, total: o.total,
  payment: { state: o.payment?.state, confirmedAt: o.payment?.confirmedAt }, token: o.token,
});
function guestOrders(rest, tableId) {
  const s = currentSession(rest, tableId);
  return s ? rest.orders.filter((o) => o.tableId === tableId && o.sessionId === s.id).reverse().map(publicOrder) : [];
}
function notifyTable(slug, tableId) {
  const set = tableClients.get(`${slug}|${tableId}`);
  if (set) for (const res of set) { try { res.write(`event: order\ndata: {}\n\n`); } catch { set.delete(res); } }
}

async function handleRestaurantApi(req, res, url, rest, p) {
  const slug = rest.slug, staffOnly = (roles) => requireStaff(req, res, rest, roles), ip = clientIp(req);
  if (req.method === "GET" && p === "/") return json(res, 200, { slug, name: rest.name });

  // --- auth ---
  if (req.method === "POST" && p === "/auth/login") {
    if (loginThrottled(ip, slug)) return tooMany(res, "Too many failed sign-ins. Try again in a few minutes.", 300);
    const b = await bodyJson(req);
    const acct = rest.staff.find((a) => a.username.toLowerCase() === String(b.username || "").trim().toLowerCase());
    const ok = (await checkPassword(b.password || "", acct ? acct.hash : DUMMY_HASH)) && !!acct;
    if (!ok) { noteLoginFail(ip, slug); return json(res, 401, { error: "Wrong username or password" }); }
    loginFails.delete(failKey(ip, slug));
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, slug, makeSession(acct, rest), SESSION_MS / 1000) });
    return res.end(JSON.stringify({ user: acct.username, role: acct.role }));
  }
  if (req.method === "POST" && p === "/auth/logout") {
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, slug, "", 0) });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === "GET" && p === "/auth/me") {
    const staff = staffFromReq(req, rest);
    return staff ? json(res, 200, { user: staff.username, role: staff.role }) : json(res, 401, { error: "Staff sign-in required", code: "AUTH_REQUIRED" });
  }

  // --- guest-facing reads ---
  if (req.method === "GET" && p === "/menu") return json(res, 200, { restaurant: rest.name, slug, items: rest.menu, settings: rest.settings });
  // A guest proves they scanned the table by presenting its key; only id and label come back.
  if (req.method === "GET" && p === "/table") {
    const t = tableFor(rest, url.searchParams.get("table"), url.searchParams.get("k"));
    return t ? json(res, 200, { table: { id: t.id, label: t.label } }) : json(res, 404, { error: "This QR code doesn’t match a table." });
  }

  if (req.method === "POST" && p === "/orders/preview") {
    if (rateHit(`prev:${ip}`, 120, 60e3)) return tooMany(res, "Slow down a little and try again.");
    const b = await bodyJson(req); const priced = priceOrder(rest, b.items);
    return priced.error ? json(res, 400, priced) : json(res, 200, priced);
  }

  if (req.method === "POST" && p === "/orders") {
    const b = await bodyJson(req);
    const table = tableFor(rest, b.tableId, b.k);
    if (!table) return json(res, 400, { error: "Invalid table. Please scan the QR code on your table again." });
    if (b.idempotencyKey) {
      const dup = rest.orders.find((o) => o.idempotencyKey === b.idempotencyKey && o.tableId === table.id);
      if (dup) return json(res, 200, { order: publicOrder(dup), duplicate: true });
    }
    const priced = priceOrder(rest, b.items);
    if (priced.error) return json(res, 400, priced);
    // Anonymous endpoint: keep one table or one address from burying the kitchen.
    const cur = currentSession(rest, table.id);
    if (cur && rest.orders.filter((o) => o.sessionId === cur.id && !FINAL.has(o.status)).length >= 15) return tooMany(res, "This table already has many open orders. Please ask your waiter.", 120);
    if (rateHit(`ord:${slug}:${table.id}`, 6, 10 * 60e3) || rateHit(`ordip:${slug}:${ip}`, 30, 3600e3)) return tooMany(res, "You’re ordering very quickly. Please wait a few minutes, or ask your waiter.", 300);
    const sess = openSession(rest, table.id);
    const order = {
      id: `ORD-${++rest.seq}`, tableId: table.id, tableLabel: table.label, sessionId: sess.id, token: orderToken(),
      items: priced.items, subtotal: priced.subtotal, surcharges: priced.surcharges, total: priced.total,
      status: "Received", payment: { state: "awaiting-collection" },
      idempotencyKey: b.idempotencyKey ? String(b.idempotencyKey).slice(0, 80) : null, createdAt: new Date().toISOString(),
      history: [{ status: "Received", at: new Date().toISOString() }],
    };
    rest.orders.push(order); await persist(rest, order);
    broadcast(slug, "order", order);
    return json(res, 201, { order: publicOrder(order) });
  }

  const orderMatch = p.match(/^\/orders\/([\w-]+)$/);
  if (req.method === "GET" && p === "/orders") {
    const tableId = url.searchParams.get("table");
    if (tableId) {
      // Guest view: only this table's current visit, and only after proving the QR was scanned.
      const t = tableFor(rest, tableId, url.searchParams.get("k"));
      if (!t) return json(res, 400, { error: "Invalid table" });
      return json(res, 200, { orders: guestOrders(rest, t.id) });
    }
    // Staff view, paged so the screens never download every order ever placed:
    //   scope=open   unfinished orders (kitchen)
    //   scope=recent open orders plus the last 24 hours (admin default)
    //   before=N     orders older than ORD-N, newest first (admin "load older")
    if (!staffOnly()) return;
    const scope = url.searchParams.get("scope") || "recent";
    const before = parseInt(url.searchParams.get("before"), 10) || 0;
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 200));
    const open = (o) => !FINAL.has(o.status);
    let list, hasMore = false;
    if (scope === "open") list = rest.orders.filter(open).reverse();
    else if (before) { const older = rest.orders.filter((o) => orderSeq(o) < before).reverse(); hasMore = older.length > limit; list = older.slice(0, limit); }
    else {
      const cutoff = Date.now() - 24 * 3600e3;
      const recent = rest.orders.filter((o) => open(o) || Date.parse(o.createdAt) >= cutoff).reverse();
      list = recent.slice(0, limit); hasMore = recent.length > limit || rest.orders.length > recent.length;
    }
    return json(res, 200, { orders: list, hasMore, total: rest.orders.length });
  }
  if (req.method === "GET" && orderMatch) {
    if (!staffOnly()) return;
    const o = rest.orders.find((x) => x.id === orderMatch[1]);
    return o ? json(res, 200, { order: o }) : json(res, 404, { error: "Order not found" });
  }
  if (req.method === "PATCH" && orderMatch) {
    if (!staffOnly()) return;
    const o = rest.orders.find((x) => x.id === orderMatch[1]);
    if (!o) return json(res, 404, { error: "Order not found" });
    const b = await bodyJson(req);
    if (!STATUSES.includes(b.status)) return json(res, 400, { error: "Invalid status" });
    o.status = b.status; o.history.push({ status: b.status, at: new Date().toISOString() }); touchSession(rest, o);
    await persist(rest, o); broadcast(slug, "order", o);
    return json(res, 200, { order: o });
  }

  // --- manual payment collection (waiter collects in person) ---
  const confirmMatch = p.match(/^\/orders\/([\w-]+)\/confirm-payment$/);
  if (req.method === "POST" && confirmMatch) {
    const staff = staffOnly(); if (!staff) return;
    const o = rest.orders.find((x) => x.id === confirmMatch[1]);
    if (!o) return json(res, 404, { error: "Order not found" });
    if (o.status === "Cancelled") return json(res, 400, { error: "A cancelled order cannot be marked paid" });
    if (o.payment.state !== "paid") {
      o.payment = { state: "paid", method: "manual", confirmedAt: new Date().toISOString(), confirmedBy: staff.username }; touchSession(rest, o);
      await persist(rest, o); broadcast(slug, "order", o);
    }
    return json(res, 200, { order: o });
  }
  // Invoice / receipt: opened from the guest's own order card via its private token, once collection is confirmed.
  const docMatch = p.match(/^\/orders\/([\w-]+)\/(invoice|receipt)$/);
  if (req.method === "GET" && docMatch) {
    const o = rest.orders.find((x) => x.id === docMatch[1]);
    if (!o || !o.token || !safeEq(String(url.searchParams.get("t") || ""), o.token)) return docLocked(res, "This link isn’t valid. Open it from your order on the menu page.");
    if (o.payment.state !== "paid") return docLocked(res, "Available once your waiter has collected payment and staff confirm it here.");
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "private, no-store" });
    return res.end(docPage(rest, o, docMatch[2]));
  }

  // --- assistance requests ---
  if (req.method === "POST" && p === "/assist") {
    const b = await bodyJson(req);
    const table = tableFor(rest, b.tableId, b.k);
    if (!table) return json(res, 400, { error: "Invalid table" });
    const openReq = rest.assistRequests.find((r) => r.tableId === table.id && !r.done);
    if (openReq) return json(res, 200, { request: openReq, already: true }); // one open call per table
    if (rateHit(`as:${slug}:${ip}`, 20, 3600e3)) return tooMany(res, "Staff have been called several times already. Please wave to a team member.", 300);
    const day = Date.now() - 24 * 3600e3;
    rest.assistRequests = rest.assistRequests.filter((r) => !r.done || Date.parse(r.at) > day).slice(-300);
    const reqObj = { id: crypto.randomUUID(), tableId: table.id, tableLabel: table.label, at: new Date().toISOString(), done: false };
    rest.assistRequests.push(reqObj); await persist(rest); broadcast(slug, "assist", reqObj);
    return json(res, 201, { request: reqObj });
  }
  if (req.method === "GET" && p === "/assist") { if (!staffOnly()) return; return json(res, 200, { requests: rest.assistRequests.filter((r) => !r.done).slice().reverse() }); }
  const assistDone = p.match(/^\/assist\/([\w-]+)\/done$/);
  if (req.method === "POST" && assistDone) {
    if (!staffOnly()) return;
    const r = rest.assistRequests.find((x) => x.id === assistDone[1]);
    if (!r) return json(res, 404, { error: "Request not found" });
    r.done = true; await persist(rest); broadcast(slug, "assist", r); return json(res, 200, { ok: true });
  }

  // --- menu management (manager) ---
  if (req.method === "POST" && p === "/menu") {
    if (!staffOnly(["manager"])) return;
    if (rest.menu.length >= 300) return json(res, 400, { error: "Menu is full (300 dishes)." });
    const c = cleanDish(await bodyJson(req), false); if (c.error) return json(res, 400, c);
    const base = slugify(c.value.name) || "dish"; let id = base, n = 2;
    while (rest.menu.some((m) => m.id === id)) id = `${base}-${n++}`;
    const item = { id, available: true, modifierGroups: [], ...c.value };
    rest.menu.push(item); await persist(rest); broadcast(slug, "menu", item);
    return json(res, 201, { item });
  }
  const menuItem = p.match(/^\/menu\/([\w-]+)$/);
  if (menuItem && (req.method === "PATCH" || req.method === "DELETE")) {
    if (!staffOnly(["manager"])) return;
    const item = rest.menu.find((m) => m.id === menuItem[1]);
    if (!item) return json(res, 404, { error: "Item not found" });
    if (req.method === "DELETE") { rest.menu = rest.menu.filter((m) => m !== item); await persist(rest); broadcast(slug, "menu", { id: item.id, deleted: true }); return json(res, 200, { ok: true }); }
    const c = cleanDish(await bodyJson(req), true); if (c.error) return json(res, 400, c);
    Object.assign(item, c.value); await persist(rest); broadcast(slug, "menu", item);
    return json(res, 200, { item });
  }
  const menuAvail = p.match(/^\/menu\/([\w-]+)\/availability$/);
  if (req.method === "PATCH" && menuAvail) {
    if (!staffOnly(["manager"])) return;
    const item = rest.menu.find((m) => m.id === menuAvail[1]);
    if (!item) return json(res, 404, { error: "Item not found" });
    const b = await bodyJson(req); item.available = !!b.available;
    await persist(rest); broadcast(slug, "menu", item); return json(res, 200, { item });
  }

  // --- tables (manager) ---
  if (req.method === "GET" && p === "/tables") { if (!staffOnly(["manager"])) return; return json(res, 200, { tables: rest.tables }); }
  if (req.method === "POST" && p === "/tables") {
    if (!staffOnly(["manager"])) return;
    if (rest.tables.length >= 100) return json(res, 400, { error: "A restaurant can have up to 100 tables." });
    const b = await bodyJson(req);
    const nextId = String(rest.tables.reduce((mx, t) => Math.max(mx, parseInt(t.id, 10) || 0), 0) + 1);
    const label = String(b.label || "").trim().slice(0, 30) || `Table ${nextId}`;
    const table = { id: nextId, label, key: newKey() }; rest.tables.push(table); await persist(rest);
    return json(res, 201, { table });
  }
  const tableMatch = p.match(/^\/tables\/([\w-]+)$/);
  if (tableMatch && req.method === "DELETE") {
    if (!staffOnly(["manager"])) return;
    const before = rest.tables.length; rest.tables = rest.tables.filter((t) => t.id !== tableMatch[1]);
    if (rest.tables.length === before) return json(res, 404, { error: "Table not found" });
    delete rest.sessions?.[tableMatch[1]];
    await persist(rest); return json(res, 200, { ok: true });
  }
  // New secret for a table's QR code (also upgrades older keyless tables). The old printed code stops working.
  const rotate = p.match(/^\/tables\/([\w-]+)\/rotate-key$/);
  if (req.method === "POST" && rotate) {
    if (!staffOnly(["manager"])) return;
    const t = rest.tables.find((x) => x.id === rotate[1]); if (!t) return json(res, 404, { error: "Table not found" });
    t.key = newKey(); delete rest.sessions?.[t.id]; await persist(rest); notifyTable(slug, t.id);
    return json(res, 200, { table: t });
  }
  // End the current visit: the next diner starts with an empty order list and bill.
  const closeTable = p.match(/^\/tables\/([\w-]+)\/close$/);
  if (req.method === "POST" && closeTable) {
    if (!staffOnly()) return;
    const t = rest.tables.find((x) => x.id === closeTable[1]); if (!t) return json(res, 404, { error: "Table not found" });
    delete rest.sessions?.[t.id]; await persist(rest); notifyTable(slug, t.id);
    return json(res, 200, { ok: true });
  }

  // --- settings (manager) ---
  if (req.method === "PATCH" && p === "/settings") {
    if (!staffOnly(["manager"])) return;
    const b = await bodyJson(req), st = rest.settings;
    if (b.restaurantName !== undefined) {
      const n = String(b.restaurantName).trim();
      if (n.length < 2 || n.length > 60) return json(res, 400, { error: "Restaurant name must be 2–60 characters." });
      rest.name = n;
    }
    if (b.cardSurchargePct !== undefined && !pct(b.cardSurchargePct)) return json(res, 400, { error: "Service charge must be between 0 and 100." });
    if (b.holidaySurchargePct !== undefined && !pct(b.holidaySurchargePct)) return json(res, 400, { error: "Holiday surcharge must be between 0 and 100." });
    if (typeof b.holidayMode === "boolean") st.holidayMode = b.holidayMode;
    if (b.cardSurchargePct !== undefined) st.cardSurchargePct = b.cardSurchargePct;
    if (b.holidaySurchargePct !== undefined) st.holidaySurchargePct = b.holidaySurchargePct;
    await persist(rest); broadcast(slug, "settings", st); return json(res, 200, { settings: st, restaurant: rest.name });
  }

  if (req.method === "GET" && p === "/events") {
    if (!staffOnly()) return;
    if (!clients.has(slug)) clients.set(slug, new Set());
    return openStream(req, res, clients.get(slug));
  }
  // Guest live feed for one table: pushes {id,status} whenever one of its orders changes.
  if (req.method === "GET" && p === "/table-events") {
    const table = tableFor(rest, url.searchParams.get("table"), url.searchParams.get("k"));
    if (!table) return json(res, 400, { error: "Invalid table" });
    const key = `${slug}|${table.id}`;
    if (!tableClients.has(key)) tableClients.set(key, new Set());
    const set = tableClients.get(key);
    if (set.size >= 30) return json(res, 429, { error: "Too many open connections for this table" });
    return openStream(req, res, set);
  }
  return json(res, 404, { error: "Not found" });
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const notFoundPage = (res, what = "Page") => {
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><style>body{margin:0;background:#faf7e9;color:#1a221d;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:32rem;margin:14vh auto;padding:0 1.25rem}h1{font-size:2.25rem;letter-spacing:-.03em;line-height:1.1;margin:0 0 .75rem}p{color:#5b665f;margin:0 0 1.5rem}a.b{display:inline-flex;align-items:center;min-height:46px;padding:0 22px;border-radius:999px;background:#0e3727;color:#fff;font-weight:700;text-decoration:none}</style><main><h1>${what} not found</h1><p>Check the address, or head back to the home page.</p><a class="b" href="/">Go to the home page</a></main>`);
};
async function serveStatic(req, res, url) {
  const p = url.pathname;
  let file;
  const rm = p.match(/^\/r\/([a-z0-9-]+)(?:\/(guest|kitchen|admin))?\/?$/);
  if (rm) {
    if (!Object.prototype.hasOwnProperty.call(store.restaurants, rm[1])) return notFoundPage(res, "Restaurant");
    file = `${rm[2] || "restaurant"}.html`;
  } else {
    file = p === "/" ? "index.html" : p.slice(1);
    // Only /signup, /login and /superadmin are bare top-level pages; /guest etc. are gone.
    if (!path.extname(file)) { if (!["/signup", "/login", "/superadmin"].includes(p)) return notFoundPage(res); file += ".html"; }
  }
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !existsSync(full)) return notFoundPage(res);
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
  res.end(await readFile(full));
}

await loadStore();
let shuttingDown = false;
export async function appHandler(req, res) {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); } catch { res.writeHead(400); return res.end("Bad request"); }
  try {
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      if (shuttingDown) return json(res, 503, { status: "shutting-down" });
      if (pool) {
        try { await Promise.race([pool.query("SELECT 1"), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))]); }
        catch { return json(res, 503, { status: "database-unavailable" }); }
      }
      return json(res, 200, { status: "ok" });
    }
    if (url.pathname === "/qr" || url.pathname === "/api/qr") {
      // QR SVG for a table, for managers only: the code carries the table's secret key, so it must
      // not be fetchable by anyone who merely knows the restaurant and table number.
      // It points at the public site a phone can open (PUBLIC_BASE_URL, or on Vercel the production domain),
      // never at whatever host served this image.
      const slug = String(url.searchParams.get("r") || "").toLowerCase();
      const rest = Object.prototype.hasOwnProperty.call(store.restaurants, slug) ? store.restaurants[slug] : null;
      if (!rest) return notFoundPage(res, "Restaurant");
      const staff = staffFromReq(req, rest);
      if (!staff || staff.role !== "manager") return json(res, 401, { error: "Manager sign-in required", code: "AUTH_REQUIRED" });
      const table = rest.tables.find((t) => t.id === String(url.searchParams.get("table") || ""));
      if (!table) return notFoundPage(res, "Table");
      const envBase = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      const publicBase = envBase || (process.env.VERCEL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || "chopdesk.propertypadi.com"}`
        : url.origin);
      const target = `${publicBase}/r/${slug}/guest?table=${encodeURIComponent(table.id)}${table.key ? `&k=${encodeURIComponent(table.key)}` : ""}`;
      try {
        const QRCode = (await import("qrcode")).default;
        const svg = await QRCode.toString(target, { type: "svg", margin: 1, width: 240 });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "private, no-store" }); return res.end(svg);
      } catch { res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "private, no-store" }); return res.end(`<p>QR package not installed. Table link:</p><p><a href="${htmlEsc(target)}">${htmlEsc(target)}</a></p>`); }
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof StorageError) return json(res, 503, { error: "We couldn’t save that just now. Please try again in a moment.", code: "STORAGE" });
    if (!e?.status) console.error(e);
    if (!res.headersSent) json(res, e?.status || 500, { error: e?.status ? e.message : "Something went wrong. Please try again." });
  }
}
export default appHandler;

// Local run (`npm start`): long-lived server. On Vercel this file is imported
// by api/[...path].js as a serverless function instead, so do not listen there.
if (!process.env.VERCEL) {
  const server = http.createServer(appHandler);
  server.listen(PORT, () => console.log(`Chopdesk running at http://localhost:${PORT}`));
  // Graceful stop (docker stop / redeploy): refuse new work, close live streams, flush pending writes, release the DB.
  // Node as a container's main process ignores SIGTERM unless it handles it, which means a 10s wait and a hard kill.
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true; console.log(`${sig} received: shutting down`);
    const hard = setTimeout(() => process.exit(1), 8000); hard.unref();
    server.close(); server.closeIdleConnections?.();
    for (const set of [...clients.values(), ...tableClients.values()]) for (const res of set) { try { res.end(); } catch {} }
    try {
      await saveChain; if (hasDirty()) await saveStore();
      // Hand the single-writer lock back before closing the pool, or pool.end() waits on it forever.
      if (lockClient) { await lockClient.query("SELECT pg_advisory_unlock($1)", [DB_LOCK_KEY]).catch(() => {}); lockClient.release(); }
      await pool?.end();
    } catch (e) { console.error("shutdown flush failed:", e.message); }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
