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
   slug and owns its menu, tables, orders, settings and staff logins. The demo
   restaurant below always exists so the landing page has something to try. */
const DEMO_SLUG = "the-corner-table";
const DEMO_NAME = "The Corner Table";
const STATIONS = ["Grill", "Kitchen", "Drinks", "Dessert"];
const DIETARY = ["vegan", "vegetarian", "gluten-free", "spicy"];
const RESERVED_SLUGS = new Set(["api", "r", "signup", "guest", "kitchen", "admin", "qr", "fonts", "app", "ui", "index", "www", "static", "assets", "login", "restaurant", "restaurants", "health", "status", "help", "support"]);
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
const makeTables = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: `Table ${i + 1}` }));
const defaultSettings = () => ({ cardSurchargePct: 1.5, holidaySurchargePct: 10, holidayMode: false });
function newRestaurant({ slug, name, tables = 10, sampleMenu = true }) {
  return {
    slug, name, createdAt: new Date().toISOString(),
    tables: makeTables(tables), menu: sampleMenu ? clone(seedMenu) : [],
    orders: [], assistRequests: [], settings: defaultSettings(), seq: 1000, staff: [],
  };
}

/* --- Passwords: scrypt with a per-account salt --- */
const b64url = (s) => Buffer.from(s).toString("base64url");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("base64url");
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 32).toString("base64url")}`;
}
function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  return safeEq(crypto.scryptSync(String(pw), salt, 32).toString("base64url"), hash);
}
const DUMMY_HASH = hashPassword("not-a-real-password"); // keeps unknown-user logins as slow as real ones

/* --- Store: one JSON document { restaurants: { [slug]: restaurant } } --- */
const MANAGER = { username: process.env.MANAGER_USER || "admin", password: process.env.MANAGER_PASSWORD || "admin123" };
const KITCHEN = { username: process.env.KITCHEN_USER || "kitchen", password: process.env.KITCHEN_PASSWORD || "kitchen123" };

function migrate(raw) {
  if (raw && raw.restaurants) return raw;
  // v1 stored a single restaurant at the top level; it becomes the demo tenant.
  const { restaurantName, ...settings } = raw?.settings || {};
  return { restaurants: { [DEMO_SLUG]: {
    slug: DEMO_SLUG, name: restaurantName || DEMO_NAME, createdAt: new Date().toISOString(),
    tables: raw?.tables || makeTables(12), menu: raw?.menu || clone(seedMenu), orders: raw?.orders || [],
    assistRequests: raw?.assistRequests || [], settings: { ...defaultSettings(), ...settings }, seq: raw?.seq || 1000, staff: [],
  } } };
}
function ensureDemo() {
  const demo = store.restaurants[DEMO_SLUG] || (store.restaurants[DEMO_SLUG] = newRestaurant({ slug: DEMO_SLUG, name: DEMO_NAME, tables: 12 }));
  // The public demo's logins follow the environment (defaults only for local use).
  demo.staff = [
    { username: MANAGER.username, role: "manager", hash: hashPassword(MANAGER.password) },
    { username: KITCHEN.username, role: "kitchen", hash: hashPassword(KITCHEN.password) },
  ];
}

let store;
async function loadStore() {
  await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(STORE_FILE)) {
    try { store = migrate(JSON.parse(await readFile(STORE_FILE, "utf8"))); }
    catch (e) {
      // Never silently discard data: keep the unreadable file next to the new one.
      const backup = `${STORE_FILE}.corrupt-${Date.now()}`;
      try { await rename(STORE_FILE, backup); console.error(`store.json unreadable (${e.message}); moved to ${backup}`); } catch {}
    }
  }
  if (!store) store = { restaurants: {} };
  ensureDemo();
  await saveStore();
}
let saveChain = Promise.resolve();
function saveStore() {
  // Serialized, atomic write (temp file + rename). On serverless the process may
  // freeze after the response, so writes are awaited rather than debounced.
  saveChain = saveChain.then(async () => {
    const tmp = `${STORE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(store));
    await rename(tmp, STORE_FILE);
  }).catch((e) => console.error("store write failed:", e.message));
  return saveChain;
}

// --- live events (SSE), kept apart per restaurant ---
const clients = new Map(); // slug -> Set<res>
function broadcast(slug, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const set = clients.get(slug); if (!set) return;
  for (const res of set) { try { res.write(msg); } catch { set.delete(res); } }
}

const STATUSES = ["Received", "Preparing", "Ready", "Served", "Cancelled"];

function priceOrder(rest, rawItems) {
  const items = [];
  if (!Array.isArray(rawItems)) return { error: "Basket is empty" };
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
  if (st.cardSurchargePct) surcharges.push({ name: `Card surcharge (${st.cardSurchargePct}%)`, amount: money(subtotal * st.cardSurchargePct / 100) });
  if (st.holidayMode && st.holidaySurchargePct) surcharges.push({ name: `Public holiday surcharge (${st.holidaySurchargePct}%)`, amount: money(subtotal * st.holidaySurchargePct / 100) });
  const total = money(subtotal + surcharges.reduce((s, x) => s + x.amount, 0));
  return { items, subtotal, surcharges, total };
}

function demoPay(cardNumber) {
  const num = String(cardNumber || "").replace(/\D/g, "");
  if (num === "4000000000000002") return { ok: false, reason: "Card declined (demo). Order was not sent to the kitchen — try 4242 4242 4242 4242." };
  if (num.length < 12) return { ok: false, reason: "Enter a demo card: 4242 4242 4242 4242 approves, 4000 0000 0000 0002 declines." };
  return { ok: true, last4: num.slice(-4) };
}

/* --- Staff authentication ---------------------------------------------------
   Signed, stateless session cookie (HMAC) per restaurant, so it works on
   serverless too and a login for one restaurant never opens another. In
   production without SESSION_SECRET a random secret is generated at boot, so
   cookies cannot be forged (they just expire on restart). */
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PROD ? crypto.randomBytes(32).toString("hex") : "dev-only-change-me-in-production");
if (IS_PROD && !process.env.SESSION_SECRET) console.warn("SESSION_SECRET is not set: staff sessions will not survive restarts or span instances.");
const SESSION_MS = 12 * 60 * 60 * 1000;
const signPayload = (payload) => crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
const cookieName = (slug) => `qr_staff_${slug}`;
function makeSession({ username, role }, slug) {
  const payload = b64url(JSON.stringify({ u: username, r: role, s: slug, exp: Date.now() + SESSION_MS }));
  return `${payload}.${signPayload(payload)}`;
}
function staffFromReq(req, slug) {
  const prefix = cookieName(slug) + "=";
  const raw = String(req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(prefix));
  if (!raw) return null;
  const [payload, sig] = raw.slice(prefix.length).split(".");
  if (!payload || !sig || !safeEq(sig, signPayload(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return s.u && s.r && s.s === slug && s.exp > Date.now() ? { username: s.u, role: s.r } : null;
  } catch { return null; }
}
function sessionCookie(req, slug, value, maxAgeSec) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${cookieName(slug)}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
function requireStaff(req, res, slug, roles) {
  const staff = staffFromReq(req, slug);
  if (!staff) { json(res, 401, { error: "Staff sign-in required", code: "AUTH_REQUIRED" }); return null; }
  if (roles && !roles.includes(staff.role)) { json(res, 403, { error: "Your staff role cannot do this", code: "FORBIDDEN" }); return null; }
  return staff;
}
// Client address: only trust X-Forwarded-For where a platform proxy sets it.
const clientIp = (req) => (process.env.VERCEL ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket?.remoteAddress || "?";
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
const signupThrottled = (ip) => recentSignups(ip).length >= 5;
function noteSignup(ip) { if (signups.size > 5000) signups.clear(); signups.set(ip, [...recentSignups(ip), Date.now()]); }

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
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
  const username = String(b.username || "").trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return json(res, 400, { error: "Username must be 3–32 letters, numbers, dots, dashes or underscores.", field: "username" });
  const password = String(b.password || "");
  if (password.length < 8 || password.length > 200) return json(res, 400, { error: "Password must be at least 8 characters.", field: "password" });
  const kitchenPassword = String(b.kitchenPassword || "");
  if (kitchenPassword && (kitchenPassword.length < 8 || kitchenPassword.length > 200)) return json(res, 400, { error: "Kitchen password must be at least 8 characters.", field: "kitchenPassword" });
  const tables = Math.max(1, Math.min(60, parseInt(b.tables, 10) || 10));
  const rest = newRestaurant({ slug, name, tables, sampleMenu: b.sampleMenu !== false });
  rest.staff.push({ username, role: "manager", hash: hashPassword(password) });
  if (kitchenPassword) rest.staff.push({ username: username.toLowerCase() === "kitchen" ? "kitchen-screen" : "kitchen", role: "kitchen", hash: hashPassword(kitchenPassword) });
  store.restaurants[slug] = rest; noteSignup(ip);
  await saveStore();
  res.writeHead(201, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, slug, makeSession({ username, role: "manager" }, slug), SESSION_MS / 1000) });
  res.end(JSON.stringify({ slug, name, adminUrl: `/r/${slug}/admin`, kitchenUser: kitchenPassword ? rest.staff[1].username : null }));
}

async function handleApi(req, res, url) {
  const p = url.pathname;
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

async function handleRestaurantApi(req, res, url, rest, p) {
  const slug = rest.slug, staffOnly = (roles) => requireStaff(req, res, slug, roles);
  if (req.method === "GET" && p === "/") return json(res, 200, { slug, name: rest.name, demo: slug === DEMO_SLUG });

  // --- auth ---
  if (req.method === "POST" && p === "/auth/login") {
    const ip = clientIp(req);
    if (loginThrottled(ip, slug)) return json(res, 429, { error: "Too many failed sign-ins. Try again in a few minutes." });
    const b = await bodyJson(req);
    const acct = rest.staff.find((a) => a.username.toLowerCase() === String(b.username || "").trim().toLowerCase());
    const ok = checkPassword(b.password || "", acct ? acct.hash : DUMMY_HASH) && !!acct;
    if (!ok) { noteLoginFail(ip, slug); return json(res, 401, { error: "Wrong username or password" }); }
    loginFails.delete(failKey(ip, slug));
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, slug, makeSession(acct, slug), SESSION_MS / 1000) });
    return res.end(JSON.stringify({ user: acct.username, role: acct.role }));
  }
  if (req.method === "POST" && p === "/auth/logout") {
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, slug, "", 0) });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === "GET" && p === "/auth/me") {
    const staff = staffFromReq(req, slug);
    return staff ? json(res, 200, { user: staff.username, role: staff.role }) : json(res, 401, { error: "Staff sign-in required", code: "AUTH_REQUIRED" });
  }

  // --- guest-facing reads ---
  if (req.method === "GET" && p === "/menu") return json(res, 200, { restaurant: rest.name, slug, items: rest.menu, settings: rest.settings });
  if (req.method === "GET" && p === "/tables") return json(res, 200, { tables: rest.tables });

  if (req.method === "POST" && p === "/orders/preview") {
    const b = await bodyJson(req); const priced = priceOrder(rest, b.items);
    return priced.error ? json(res, 400, priced) : json(res, 200, priced);
  }

  if (req.method === "POST" && p === "/orders") {
    const b = await bodyJson(req);
    const table = rest.tables.find((t) => t.id === String(b.tableId));
    if (!table) return json(res, 400, { error: "Invalid table. Please scan the QR code on your table again." });
    if (b.idempotencyKey) {
      const dup = rest.orders.find((o) => o.idempotencyKey === b.idempotencyKey && o.tableId === table.id);
      if (dup) return json(res, 200, { order: dup, duplicate: true });
    }
    const priced = priceOrder(rest, b.items);
    if (priced.error) return json(res, 400, priced);
    const pay = demoPay(b.payment?.cardNumber);
    const order = {
      id: `ORD-${++rest.seq}`, tableId: table.id, tableLabel: table.label,
      items: priced.items, subtotal: priced.subtotal, surcharges: priced.surcharges, total: priced.total,
      status: pay.ok ? "Received" : "PaymentFailed", payment: pay.ok ? { state: "paid-demo", last4: pay.last4 } : { state: "declined", reason: pay.reason },
      idempotencyKey: b.idempotencyKey || null, createdAt: new Date().toISOString(),
      history: [{ status: pay.ok ? "Received" : "PaymentFailed", at: new Date().toISOString() }],
    };
    rest.orders.push(order); await saveStore();
    if (pay.ok) broadcast(slug, "order", order); else broadcast(slug, "payment_failed", order);
    return json(res, pay.ok ? 201 : 402, pay.ok ? { order } : { error: pay.reason, order });
  }

  const orderMatch = p.match(/^\/orders\/([\w-]+)$/);
  if (req.method === "GET" && orderMatch) {
    const o = rest.orders.find((x) => x.id === orderMatch[1]);
    return o ? json(res, 200, { order: o }) : json(res, 404, { error: "Order not found" });
  }
  if (req.method === "GET" && p === "/orders") {
    const tableId = url.searchParams.get("table");
    if (!tableId && !staffOnly()) return;
    const list = rest.orders.filter((o) => !tableId || o.tableId === tableId).slice().reverse();
    return json(res, 200, { orders: list });
  }
  if (req.method === "PATCH" && orderMatch) {
    if (!staffOnly()) return;
    const o = rest.orders.find((x) => x.id === orderMatch[1]);
    if (!o) return json(res, 404, { error: "Order not found" });
    const b = await bodyJson(req);
    if (!STATUSES.includes(b.status)) return json(res, 400, { error: "Invalid status" });
    o.status = b.status; o.history.push({ status: b.status, at: new Date().toISOString() });
    await saveStore(); broadcast(slug, "order", o);
    return json(res, 200, { order: o });
  }

  // --- assistance requests ---
  if (req.method === "POST" && p === "/assist") {
    const b = await bodyJson(req);
    const table = rest.tables.find((t) => t.id === String(b.tableId));
    if (!table) return json(res, 400, { error: "Invalid table" });
    const reqObj = { id: crypto.randomUUID(), tableId: table.id, tableLabel: table.label, at: new Date().toISOString(), done: false };
    rest.assistRequests.push(reqObj); await saveStore(); broadcast(slug, "assist", reqObj);
    return json(res, 201, { request: reqObj });
  }
  if (req.method === "GET" && p === "/assist") { if (!staffOnly()) return; return json(res, 200, { requests: rest.assistRequests.filter((r) => !r.done).slice().reverse() }); }
  const assistDone = p.match(/^\/assist\/([\w-]+)\/done$/);
  if (req.method === "POST" && assistDone) {
    if (!staffOnly()) return;
    const r = rest.assistRequests.find((x) => x.id === assistDone[1]);
    if (!r) return json(res, 404, { error: "Request not found" });
    r.done = true; await saveStore(); broadcast(slug, "assist", r); return json(res, 200, { ok: true });
  }

  // --- menu management (manager) ---
  if (req.method === "POST" && p === "/menu") {
    if (!staffOnly(["manager"])) return;
    if (rest.menu.length >= 300) return json(res, 400, { error: "Menu is full (300 dishes)." });
    const c = cleanDish(await bodyJson(req), false); if (c.error) return json(res, 400, c);
    const base = slugify(c.value.name) || "dish"; let id = base, n = 2;
    while (rest.menu.some((m) => m.id === id)) id = `${base}-${n++}`;
    const item = { id, available: true, modifierGroups: [], ...c.value };
    rest.menu.push(item); await saveStore(); broadcast(slug, "menu", item);
    return json(res, 201, { item });
  }
  const menuItem = p.match(/^\/menu\/([\w-]+)$/);
  if (menuItem && (req.method === "PATCH" || req.method === "DELETE")) {
    if (!staffOnly(["manager"])) return;
    const item = rest.menu.find((m) => m.id === menuItem[1]);
    if (!item) return json(res, 404, { error: "Item not found" });
    if (req.method === "DELETE") { rest.menu = rest.menu.filter((m) => m !== item); await saveStore(); broadcast(slug, "menu", { id: item.id, deleted: true }); return json(res, 200, { ok: true }); }
    const c = cleanDish(await bodyJson(req), true); if (c.error) return json(res, 400, c);
    Object.assign(item, c.value); await saveStore(); broadcast(slug, "menu", item);
    return json(res, 200, { item });
  }
  const menuAvail = p.match(/^\/menu\/([\w-]+)\/availability$/);
  if (req.method === "PATCH" && menuAvail) {
    if (!staffOnly(["manager"])) return;
    const item = rest.menu.find((m) => m.id === menuAvail[1]);
    if (!item) return json(res, 404, { error: "Item not found" });
    const b = await bodyJson(req); item.available = !!b.available;
    await saveStore(); broadcast(slug, "menu", item); return json(res, 200, { item });
  }

  // --- tables (manager) ---
  if (req.method === "POST" && p === "/tables") {
    if (!staffOnly(["manager"])) return;
    if (rest.tables.length >= 100) return json(res, 400, { error: "A restaurant can have up to 100 tables." });
    const b = await bodyJson(req);
    const nextId = String(rest.tables.reduce((mx, t) => Math.max(mx, parseInt(t.id, 10) || 0), 0) + 1);
    const label = String(b.label || "").trim().slice(0, 30) || `Table ${nextId}`;
    const table = { id: nextId, label }; rest.tables.push(table); await saveStore();
    return json(res, 201, { table });
  }
  const tableMatch = p.match(/^\/tables\/([\w-]+)$/);
  if (tableMatch && req.method === "DELETE") {
    if (!staffOnly(["manager"])) return;
    const before = rest.tables.length; rest.tables = rest.tables.filter((t) => t.id !== tableMatch[1]);
    if (rest.tables.length === before) return json(res, 404, { error: "Table not found" });
    await saveStore(); return json(res, 200, { ok: true });
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
    if (b.cardSurchargePct !== undefined && !pct(b.cardSurchargePct)) return json(res, 400, { error: "Card surcharge must be between 0 and 100." });
    if (b.holidaySurchargePct !== undefined && !pct(b.holidaySurchargePct)) return json(res, 400, { error: "Holiday surcharge must be between 0 and 100." });
    if (typeof b.holidayMode === "boolean") st.holidayMode = b.holidayMode;
    if (b.cardSurchargePct !== undefined) st.cardSurchargePct = b.cardSurchargePct;
    if (b.holidaySurchargePct !== undefined) st.holidaySurchargePct = b.holidaySurchargePct;
    await saveStore(); broadcast(slug, "settings", st); return json(res, 200, { settings: st, restaurant: rest.name });
  }

  if (req.method === "GET" && p === "/events") {
    if (!staffOnly()) return;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: ready\ndata: {}\n\n`);
    if (!clients.has(slug)) clients.set(slug, new Set());
    clients.get(slug).add(res);
    req.on("close", () => clients.get(slug)?.delete(res)); return;
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
  // Pre-multi-restaurant links (printed QR codes, bookmarks) open the demo restaurant.
  if (p === "/guest" || p === "/kitchen" || p === "/admin") { res.writeHead(302, { Location: `/r/${DEMO_SLUG}${p}${url.search}` }); return res.end(); }
  let file;
  const rm = p.match(/^\/r\/([a-z0-9-]+)(?:\/(guest|kitchen|admin))?\/?$/);
  if (rm) {
    if (!Object.prototype.hasOwnProperty.call(store.restaurants, rm[1])) return notFoundPage(res, "Restaurant");
    file = `${rm[2] || "restaurant"}.html`;
  } else {
    file = p === "/" ? "index.html" : p.slice(1);
    if (!path.extname(file)) file += ".html";
  }
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !existsSync(full)) return notFoundPage(res);
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
  res.end(await readFile(full));
}

await loadStore();
export async function appHandler(req, res) {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); } catch { res.writeHead(400); return res.end("Bad request"); }
  try {
    if (url.pathname === "/qr" || url.pathname === "/api/qr") {
      // QR SVG for a table link, using optional `qrcode` package; falls back to text page.
      // The code must point at the public site a phone can open — never at the
      // host that happened to serve this image (localhost, a preview deploy,
      // or an http:// origin). PUBLIC_BASE_URL wins; on Vercel fall back to
      // the production domain; locally use the request origin (LAN demos).
      const slug = String(url.searchParams.get("r") || DEMO_SLUG).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(store.restaurants, slug)) return notFoundPage(res, "Restaurant");
      const envBase = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      const publicBase = envBase || (process.env.VERCEL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || "orderqr-omega.vercel.app"}`
        : url.origin);
      const target = `${publicBase}/r/${slug}/guest?table=${encodeURIComponent(url.searchParams.get("table") || "")}`;
      try {
        const QRCode = (await import("qrcode")).default;
        const svg = await QRCode.toString(target, { type: "svg", margin: 1, width: 240 });
        res.writeHead(200, { "Content-Type": "image/svg+xml" }); return res.end(svg);
      } catch { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(`<p>QR package not installed. Table link:</p><p><a href="${target.replace(/[<>"&]/g, "")}">${target.replace(/[<>"&]/g, "")}</a></p>`); }
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    if (!e?.status) console.error(e);
    if (!res.headersSent) json(res, e?.status || 500, { error: e?.status ? e.message : "Something went wrong. Please try again." });
  }
}
export default appHandler;

// Local run (`npm start`): long-lived server. On Vercel this file is imported
// by api/[...path].js as a serverless function instead, so do not listen there.
if (!process.env.VERCEL) {
  http.createServer(appHandler).listen(PORT, () => console.log(`OrderQR running at http://localhost:${PORT}`));
}
