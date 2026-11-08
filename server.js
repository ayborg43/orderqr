import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.VERCEL ? "/tmp/orderqr-data" : path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

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

function seedStore() {
  return {
    tables: Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), label: `Table ${i + 1}` })),
    menu: seedMenu,
    orders: [],
    assistRequests: [],
    settings: { cardSurchargePct: 1.5, holidaySurchargePct: 10, holidayMode: false, restaurantName: "The Corner Table" },
    seq: 1000,
  };
}

let store;
async function loadStore() {
  await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(STORE_FILE)) {
    try { store = JSON.parse(await readFile(STORE_FILE, "utf8")); return; } catch { /* reseed below */ }
  }
  store = seedStore();
  await saveStore();
}
let saveChain = Promise.resolve();
function saveStore() {
  // Serialized direct write: on serverless the process may freeze after the
  // response, so a debounced write could be lost.
  saveChain = saveChain.then(() => writeFile(STORE_FILE, JSON.stringify(store, null, 2))).catch(() => {});
  return saveChain;
}

// --- live events (SSE) ---
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
}

const STATUSES = ["Received", "Preparing", "Ready", "Served", "Cancelled"];
const money = (n) => Math.round(n * 100) / 100;

function priceOrder(rawItems) {
  const items = [];
  for (const raw of rawItems || []) {
    const menuItem = store.menu.find((m) => m.id === raw.menuItemId);
    if (!menuItem) return { error: `Unknown item: ${raw.menuItemId}` };
    if (!menuItem.available) return { error: `Sold out: ${menuItem.name}`, soldOut: menuItem.id };
    const qty = Math.max(1, Math.min(20, parseInt(raw.qty, 10) || 1));
    let unit = menuItem.price;
    const chosen = [];
    for (const group of menuItem.modifierGroups || []) {
      const picked = (raw.modifiers || []).filter((id) => group.options.some((o) => o.id === id));
      if (group.required && picked.length !== 1) return { error: `Choose ${group.name} for ${menuItem.name}` };
      for (const id of picked) { const opt = group.options.find((o) => o.id === id); unit += opt.delta; chosen.push({ group: group.name, name: opt.name, delta: opt.delta }); }
    }
    items.push({ menuItemId: menuItem.id, name: menuItem.name, station: menuItem.station, qty, unitPrice: money(unit), modifiers: chosen, note: String(raw.note || "").slice(0, 200), lineTotal: money(unit * qty) });
  }
  if (!items.length) return { error: "Basket is empty" };
  const subtotal = money(items.reduce((s, i) => s + i.lineTotal, 0));
  const surcharges = [];
  if (store.settings.cardSurchargePct) surcharges.push({ name: `Card surcharge (${store.settings.cardSurchargePct}%)`, amount: money(subtotal * store.settings.cardSurchargePct / 100) });
  if (store.settings.holidayMode && store.settings.holidaySurchargePct) surcharges.push({ name: `Public holiday surcharge (${store.settings.holidaySurchargePct}%)`, amount: money(subtotal * store.settings.holidaySurchargePct / 100) });
  const total = money(subtotal + surcharges.reduce((s, x) => s + x.amount, 0));
  return { items, subtotal, surcharges, total };
}

function demoPay(cardNumber) {
  const num = String(cardNumber || "").replace(/\D/g, "");
  if (num === "4000000000000002") return { ok: false, reason: "Card declined (demo). Order was not sent to the kitchen — try 4242 4242 4242 4242." };
  if (num.length < 12) return { ok: false, reason: "Enter a demo card: 4242 4242 4242 4242 approves, 4000 0000 0000 0002 declines." };
  return { ok: true, last4: num.slice(-4) };
}

/* --- Staff authentication -------------------------------------------------
   Signed, stateless session cookie (HMAC) so it works on serverless too.
   Accounts come from env; the defaults exist only so the local demo runs —
   set MANAGER_PASSWORD / KITCHEN_PASSWORD / SESSION_SECRET in production. */
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-me-in-production";
const STAFF_ACCOUNTS = [
  { username: process.env.MANAGER_USER || "admin", password: process.env.MANAGER_PASSWORD || "admin123", role: "manager" },
  { username: process.env.KITCHEN_USER || "kitchen", password: process.env.KITCHEN_PASSWORD || "kitchen123", role: "kitchen" },
];
const SESSION_MS = 12 * 60 * 60 * 1000;
const b64url = (s) => Buffer.from(s).toString("base64url");
const signPayload = (payload) => crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function makeSession({ username, role }) {
  const payload = b64url(JSON.stringify({ u: username, r: role, exp: Date.now() + SESSION_MS }));
  return `${payload}.${signPayload(payload)}`;
}
function staffFromReq(req) {
  const raw = String(req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith("qr_staff="));
  if (!raw) return null;
  const [payload, sig] = raw.slice("qr_staff=".length).split(".");
  if (!payload || !sig || !safeEq(sig, signPayload(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return s.u && s.r && s.exp > Date.now() ? { username: s.u, role: s.r } : null;
  } catch { return null; }
}
function sessionCookie(req, value, maxAgeSec) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `qr_staff=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
function requireStaff(req, res, roles) {
  const staff = staffFromReq(req);
  if (!staff) { json(res, 401, { error: "Staff sign-in required", code: "AUTH_REQUIRED" }); return null; }
  if (roles && !roles.includes(staff.role)) { json(res, 403, { error: "Your staff role cannot do this", code: "FORBIDDEN" }); return null; }
  return staff;
}
// Basic login throttle: 8 failures per IP per 5 minutes.
const loginFails = new Map();
function loginThrottled(ip) {
  const rec = loginFails.get(ip);
  return rec && rec.count >= 8 && rec.until > Date.now();
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, until: 0 };
  rec.count += 1; rec.until = Date.now() + 5 * 60 * 1000;
  loginFails.set(ip, rec);
}

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
async function bodyJson(req) { let s = ""; for await (const c of req) s += c; try { return JSON.parse(s || "{}"); } catch { return {}; } }
const publicOrder = (o) => o;

async function handleApi(req, res, url) {
  const p = url.pathname;
  // --- auth routes ---
  if (req.method === "POST" && p === "/api/auth/login") {
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
    if (loginThrottled(ip)) return json(res, 429, { error: "Too many failed sign-ins. Try again in a few minutes." });
    const b = await bodyJson(req);
    const acct = STAFF_ACCOUNTS.find((a) => safeEq(a.username, b.username || "") && safeEq(a.password, b.password || ""));
    if (!acct) { noteLoginFail(ip); return json(res, 401, { error: "Wrong username or password" }); }
    loginFails.delete(ip);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, makeSession(acct), SESSION_MS / 1000) });
    return res.end(JSON.stringify({ user: acct.username, role: acct.role }));
  }
  if (req.method === "POST" && p === "/api/auth/logout") {
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, "", 0) });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === "GET" && p === "/api/auth/me") {
    const staff = staffFromReq(req);
    return staff ? json(res, 200, { user: staff.username, role: staff.role }) : json(res, 401, { error: "Staff sign-in required", code: "AUTH_REQUIRED" });
  }
  if (req.method === "GET" && p === "/api/menu") return json(res, 200, { restaurant: store.settings.restaurantName, items: store.menu, settings: store.settings });
  if (req.method === "GET" && p === "/api/tables") return json(res, 200, { tables: store.tables });

  if (req.method === "POST" && p === "/api/orders/preview") {
    const b = await bodyJson(req); const priced = priceOrder(b.items);
    return priced.error ? json(res, 400, priced) : json(res, 200, priced);
  }

  if (req.method === "POST" && p === "/api/orders") {
    const b = await bodyJson(req);
    const table = store.tables.find((t) => t.id === String(b.tableId));
    if (!table) return json(res, 400, { error: "Invalid table. Please scan the QR code on your table again." });
    if (b.idempotencyKey) {
      const dup = store.orders.find((o) => o.idempotencyKey === b.idempotencyKey);
      if (dup) return json(res, 200, { order: publicOrder(dup), duplicate: true });
    }
    const priced = priceOrder(b.items);
    if (priced.error) return json(res, 400, priced);
    const pay = demoPay(b.payment?.cardNumber);
    const order = {
      id: `ORD-${++store.seq}`, tableId: table.id, tableLabel: table.label,
      items: priced.items, subtotal: priced.subtotal, surcharges: priced.surcharges, total: priced.total,
      status: pay.ok ? "Received" : "PaymentFailed", payment: pay.ok ? { state: "paid-demo", last4: pay.last4 } : { state: "declined", reason: pay.reason },
      idempotencyKey: b.idempotencyKey || null, createdAt: new Date().toISOString(),
      history: [{ status: pay.ok ? "Received" : "PaymentFailed", at: new Date().toISOString() }],
    };
    store.orders.push(order); await saveStore();
    if (pay.ok) broadcast("order", order); else broadcast("payment_failed", order);
    return json(res, pay.ok ? 201 : 402, pay.ok ? { order } : { error: pay.reason, order });
  }

  const orderMatch = p.match(/^\/api\/orders\/([\w-]+)$/);
  if (req.method === "GET" && orderMatch) {
    const o = store.orders.find((x) => x.id === orderMatch[1]);
    return o ? json(res, 200, { order: o }) : json(res, 404, { error: "Order not found" });
  }
  if (req.method === "GET" && p === "/api/orders") {
    const tableId = url.searchParams.get("table");
    if (!tableId && !requireStaff(req, res)) return;
    const list = store.orders.filter((o) => !tableId || o.tableId === tableId).slice().reverse();
    return json(res, 200, { orders: list });
  }
  if (req.method === "PATCH" && orderMatch) {
    if (!requireStaff(req, res)) return;
    const o = store.orders.find((x) => x.id === orderMatch[1]);
    if (!o) return json(res, 404, { error: "Order not found" });
    const b = await bodyJson(req);
    if (!STATUSES.includes(b.status)) return json(res, 400, { error: "Invalid status" });
    o.status = b.status; o.history.push({ status: b.status, at: new Date().toISOString() });
    await saveStore(); broadcast("order", o);
    return json(res, 200, { order: o });
  }

  if (req.method === "POST" && p === "/api/assist") {
    const b = await bodyJson(req);
    const table = store.tables.find((t) => t.id === String(b.tableId));
    if (!table) return json(res, 400, { error: "Invalid table" });
    const reqObj = { id: crypto.randomUUID(), tableId: table.id, tableLabel: table.label, at: new Date().toISOString(), done: false };
    store.assistRequests.push(reqObj); await saveStore(); broadcast("assist", reqObj);
    return json(res, 201, { request: reqObj });
  }
  if (req.method === "GET" && p === "/api/assist") { if (!requireStaff(req, res)) return; return json(res, 200, { requests: store.assistRequests.filter((r) => !r.done).slice().reverse() }); }
  const assistDone = p.match(/^\/api\/assist\/([\w-]+)\/done$/);
  if (req.method === "POST" && assistDone) {
    if (!requireStaff(req, res)) return;
    const r = store.assistRequests.find((x) => x.id === assistDone[1]); if (r) r.done = true;
    await saveStore(); broadcast("assist", r); return json(res, 200, { ok: true });
  }

  const menuAvail = p.match(/^\/api\/menu\/([\w-]+)\/availability$/);
  if (req.method === "PATCH" && menuAvail) {
    if (!requireStaff(req, res, ["manager"])) return;
    const item = store.menu.find((m) => m.id === menuAvail[1]);
    if (!item) return json(res, 404, { error: "Item not found" });
    const b = await bodyJson(req); item.available = !!b.available;
    await saveStore(); broadcast("menu", item); return json(res, 200, { item });
  }
  if (req.method === "PATCH" && p === "/api/settings") {
    if (!requireStaff(req, res, ["manager"])) return;
    const b = await bodyJson(req);
    if (typeof b.holidayMode === "boolean") store.settings.holidayMode = b.holidayMode;
    if (Number.isFinite(b.cardSurchargePct)) store.settings.cardSurchargePct = b.cardSurchargePct;
    if (Number.isFinite(b.holidaySurchargePct)) store.settings.holidaySurchargePct = b.holidaySurchargePct;
    await saveStore(); broadcast("settings", store.settings); return json(res, 200, { settings: store.settings });
  }

  if (req.method === "GET" && p === "/api/events") {
    if (!requireStaff(req, res)) return;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: ready\ndata: {}\n\n`); clients.add(res);
    req.on("close", () => clients.delete(res)); return;
  }
  return json(res, 404, { error: "Not found" });
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
async function serveStatic(req, res, url) {
  let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!path.extname(file)) file += ".html";
  const full = path.join(ROOT, "public", path.normalize(file));
  if (!full.startsWith(path.join(ROOT, "public")) || !existsSync(full)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
  res.end(await readFile(full));
}

await loadStore();
export async function appHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/qr" || url.pathname === "/api/qr") {
      // QR SVG for a table link, using optional `qrcode` package; falls back to text page.
      // The code must point at the public site a phone can open — never at the
      // host that happened to serve this image (localhost, a preview deploy,
      // or an http:// origin). PUBLIC_BASE_URL wins; on Vercel fall back to
      // the production domain; locally use the request origin (LAN demos).
      const envBase = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      const publicBase = envBase || (process.env.VERCEL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || "orderqr-omega.vercel.app"}`
        : url.origin);
      const target = `${publicBase}/guest?table=${encodeURIComponent(url.searchParams.get("table") || "")}`;
      try {
        const QRCode = (await import("qrcode")).default;
        const svg = await QRCode.toString(target, { type: "svg", margin: 1, width: 240 });
        res.writeHead(200, { "Content-Type": "image/svg+xml" }); return res.end(svg);
      } catch { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(`<p>QR package not installed. Table link:</p><p><a href="${target}">${target}</a></p>`); }
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
}
export default appHandler;

// Local run (`npm start`): long-lived server. On Vercel this file is imported
// by api/[...path].js as a serverless function instead, so do not listen there.
if (!process.env.VERCEL) {
  http.createServer(appHandler).listen(PORT, () => console.log(`QR Restaurant running at http://localhost:${PORT}`));
}

