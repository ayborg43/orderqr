import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, client, cookieOf, REST } from "./helpers.mjs";

const API = `/api/r/${REST}`;
const SA = { username: "root", password: "platform-secret-1" };
let srv, req, saCookie;

before(async () => {
  srv = await startServer(3230, { env: { SUPERADMIN_USER: SA.username, SUPERADMIN_PASSWORD: SA.password, SESSION_SECRET: "hardening-secret", SIGNUP_PER_HOUR: "100" } });
  req = client(srv.base);
  saCookie = cookieOf((await req("POST", "/api/superadmin/auth/login", { body: SA })).cookie);
});
after(() => srv?.stop());

const signup = (name, username = "owner", extra = {}) => req("POST", "/api/restaurants", { body: { name, username, password: "password-123", tables: 4, ...extra } });
const keysOf = async (slug, cookie) => Object.fromEntries((await req("GET", `/api/r/${slug}/tables`, { cookie })).body.tables.map((t) => [t.id, t.key]));
const fries = (extra = {}) => ({ items: [{ menuItemId: "fries", qty: 1 }], ...extra });

/* A restaurant document as the server stores it, for tests that need old or special data. */
const hashSync = (pw) => { const salt = "testsalt"; return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString("base64url")}`; };
const mkRest = (slug, o = {}) => ({
  slug, name: slug, createdAt: "2026-01-01T00:00:00.000Z",
  tables: [{ id: "1", label: "Table 1", key: "key1" }, { id: "2", label: "Table 2", key: "key2" }],
  menu: [{ id: "fries", name: "Fries", desc: "", price: 5, category: "Sides", station: "Kitchen", dietary: [], available: true, modifierGroups: [] }],
  orders: [], assistRequests: [], settings: { cardSurchargePct: 0, holidaySurchargePct: 10, holidayMode: false, v: 2 }, seq: 1000,
  staff: [{ username: "boss", role: "manager", hash: hashSync("boss-pass-1") }], sessions: {}, ...o,
});
const mkOrder = (n, o = {}) => ({
  id: `ORD-${n}`, tableId: "1", tableLabel: "Table 1", sessionId: "s1", token: `tok${n}`, items: [{ menuItemId: "fries", name: "Fries", station: "Kitchen", qty: 1, unitPrice: 5, modifiers: [], note: "", lineTotal: 5 }],
  subtotal: 5, surcharges: [], total: 5, status: "Received", payment: { state: "awaiting-collection" }, idempotencyKey: null,
  createdAt: new Date().toISOString(), history: [{ status: "Received", at: new Date().toISOString() }], ...o,
});

/* ---------- 1. sessions are bound to the account ---------- */
test("deleting and re-registering an address does not hand the old owner's session to the new owner", async () => {
  const first = await signup("Victim Cafe", "oldowner");
  assert.equal(first.status, 201);
  const oldCookie = cookieOf(first.cookie);
  assert.equal((await req("GET", "/api/r/victim-cafe/orders", { cookie: oldCookie })).status, 200);
  assert.equal((await req("DELETE", "/api/superadmin/restaurants/victim-cafe", { cookie: saCookie, body: { confirm: "victim-cafe" } })).status, 200);
  assert.equal((await signup("Victim Cafe", "newowner")).status, 201);
  assert.equal((await req("GET", "/api/r/victim-cafe/orders", { cookie: oldCookie })).status, 401, "old session must not open the new restaurant");
  // Same username, same password: still a different restaurant, still rejected.
  assert.equal((await req("GET", "/api/r/victim-cafe/auth/me", { cookie: oldCookie })).status, 401);
});

test("a password reset ends that account's existing sessions", async () => {
  const s = await signup("Reset Grill", "chef");
  const cookie = cookieOf(s.cookie);
  assert.equal((await req("GET", "/api/r/reset-grill/auth/me", { cookie })).status, 200);
  assert.equal((await req("POST", "/api/superadmin/restaurants/reset-grill/staff/chef/reset-password", { cookie: saCookie, body: { password: "brand-new-pass-9" } })).status, 200);
  assert.equal((await req("GET", "/api/r/reset-grill/auth/me", { cookie })).status, 401, "the old cookie is dead");
  const again = await req("POST", "/api/r/reset-grill/auth/login", { body: { username: "chef", password: "brand-new-pass-9" } });
  assert.equal(again.status, 200);
  assert.equal((await req("GET", "/api/r/reset-grill/auth/me", { cookie: cookieOf(again.cookie) })).status, 200);
});

test("rotating the platform password ends super admin sessions", async () => {
  const s2 = await startServer(3231, { env: { SUPERADMIN_USER: SA.username, SUPERADMIN_PASSWORD: SA.password, SESSION_SECRET: "hardening-secret" } });
  const c2 = client(s2.base);
  const ck = cookieOf((await c2("POST", "/api/superadmin/auth/login", { body: SA })).cookie);
  assert.equal((await c2("GET", "/api/superadmin/overview", { cookie: ck })).status, 200);
  s2.stop();
  // Same secret, new password: the old cookie must not work.
  const s3 = await startServer(3232, { env: { SUPERADMIN_USER: SA.username, SUPERADMIN_PASSWORD: "rotated-password-2", SESSION_SECRET: "hardening-secret" } });
  try { assert.equal((await client(s3.base)("GET", "/api/superadmin/overview", { cookie: ck })).status, 401); } finally { s3.stop(); }
});

/* ---------- 2. no surprise charge ---------- */
test("a new restaurant charges nothing extra by default", async () => {
  const s = await signup("Plain Prices");
  const ck = cookieOf(s.cookie), keys = await keysOf("plain-prices", ck);
  const o = await req("POST", "/api/r/plain-prices/orders", { body: { tableId: "1", k: keys["1"], ...fries() } });
  assert.equal(o.status, 201);
  assert.deepEqual(o.body.order.surcharges, []);
  assert.equal(o.body.order.total, o.body.order.subtotal);
});

test("an old restaurant stuck on the silent 1.5% default is reset to no charge once; a chosen value is kept", async () => {
  const stale = (slug, pct) => mkRest(slug, { settings: { cardSurchargePct: pct, holidaySurchargePct: 10, holidayMode: false } }); // no `v` marker: pre-fix data
  const s = await startServer(3233, { store: { restaurants: { "stale-default": stale("stale-default", 1.5), "chose-five": stale("chose-five", 5) } } });
  try {
    const c = client(s.base);
    assert.equal((await c("GET", "/api/r/stale-default/menu")).body.settings.cardSurchargePct, 0);
    assert.equal((await c("GET", "/api/r/chose-five/menu")).body.settings.cardSurchargePct, 5);
  } finally { s.stop(); }
});

/* ---------- 3. guest privacy ---------- */
test("guests see only the current visit, never other diners' orders, and nothing about staff", async () => {
  const s = await signup("Privacy Place");
  const ck = cookieOf(s.cookie), K = await keysOf("privacy-place", ck);
  const g = (id) => ({ tableId: id, k: K[id] });
  const first = await req("POST", "/api/r/privacy-place/orders", { body: { ...g("1"), ...fries() } });
  const id = first.body.order.id;
  await req("POST", `/api/r/privacy-place/orders/${id}/confirm-payment`, { cookie: ck });
  const mine = await req("GET", `/api/r/privacy-place/orders?table=1&k=${K["1"]}`);
  assert.equal(mine.body.orders.length, 1);
  const raw = JSON.stringify(mine.body);
  assert.ok(!/confirmedBy|idempotencyKey|history|"owner"/.test(raw), "no staff names, keys or history in the guest view: " + raw);
  assert.ok(mine.body.orders[0].token, "the guest gets the private token for the invoice link");
  // Staff clear the table: the next diner starts empty, and the old order is still on record for staff.
  assert.equal((await req("POST", `/api/r/privacy-place/tables/1/close`, { cookie: ck })).status, 200);
  assert.equal((await req("GET", `/api/r/privacy-place/orders?table=1&k=${K["1"]}`)).body.orders.length, 0);
  assert.equal((await req("GET", `/api/r/privacy-place/orders?scope=open`, { cookie: ck })).body.orders.length, 1);
  const next = await req("POST", "/api/r/privacy-place/orders", { body: { ...g("1"), ...fries() } });
  assert.equal((await req("GET", `/api/r/privacy-place/orders?table=1&k=${K["1"]}`)).body.orders.map((o) => o.id).join(), next.body.order.id);
  // Other tables are separate visits.
  assert.equal((await req("GET", `/api/r/privacy-place/orders?table=2&k=${K["2"]}`)).body.orders.length, 0);
});

test("a table needs its secret key; a new QR code retires the old one", async () => {
  const s = await signup("Key Keeper");
  const ck = cookieOf(s.cookie), K = await keysOf("key-keeper", ck);
  const q = (id, k) => `table=${id}${k ? `&k=${k}` : ""}`;
  assert.equal((await req("GET", `/api/r/key-keeper/table?${q("1")}`)).status, 404, "no key");
  assert.equal((await req("GET", `/api/r/key-keeper/table?${q("1", "wrongkey")}`)).status, 404, "wrong key");
  assert.equal((await req("GET", `/api/r/key-keeper/table?${q("1", K["1"])}`)).status, 200);
  assert.equal((await req("POST", "/api/r/key-keeper/orders", { body: { tableId: "1", ...fries() } })).status, 400, "ordering without the key");
  assert.equal((await req("POST", "/api/r/key-keeper/assist", { body: { tableId: "1", k: "nope" } })).status, 400);
  assert.equal((await req("GET", `/api/r/key-keeper/orders?${q("1")}`)).status, 400, "reading the bill without the key");
  assert.equal((await req("GET", `/api/r/key-keeper/table-events?${q("1")}`)).status, 400);
  // Keys are never listed to the public.
  assert.ok(!JSON.stringify((await req("GET", "/api/r/key-keeper/menu")).body).includes(K["1"]));
  assert.equal((await req("GET", "/api/r/key-keeper/tables")).status, 401);
  // Rotation
  const rot = await req("POST", "/api/r/key-keeper/tables/1/rotate-key", { cookie: ck });
  assert.equal(rot.status, 200); assert.notEqual(rot.body.table.key, K["1"]);
  assert.equal((await req("GET", `/api/r/key-keeper/table?${q("1", K["1"])}`)).status, 404, "old printed code is dead");
  assert.equal((await req("GET", `/api/r/key-keeper/table?${q("1", rot.body.table.key)}`)).status, 200);
  assert.equal((await req("POST", "/api/r/key-keeper/tables/1/rotate-key")).status, 401, "managers only");
});

test("an order record can only be read by staff, and visits expire after two idle hours", async () => {
  const old = Date.now() - 3 * 3600e3;
  const rest = mkRest("old-visit", {
    sessions: { 1: { id: "s1", startedAt: old, lastAt: old }, 2: { id: "s2", startedAt: Date.now() - 600e3, lastAt: Date.now() - 60e3 } },
    orders: [mkOrder(1001), mkOrder(1002, { tableId: "2", tableLabel: "Table 2", sessionId: "s2" })],
  });
  const s = await startServer(3234, { store: { restaurants: { "old-visit": rest } } });
  try {
    const c = client(s.base);
    assert.equal((await c("GET", "/api/r/old-visit/orders?table=1&k=key1")).body.orders.length, 0, "table 1's visit went idle");
    assert.equal((await c("GET", "/api/r/old-visit/orders?table=2&k=key2")).body.orders.length, 1, "table 2's visit is live");
    assert.equal((await c("GET", "/api/r/old-visit/orders/ORD-1001")).status, 401, "sequential order numbers are not a public lookup");
    // A new order at the idle table opens a fresh visit instead of reviving the old one.
    const placed = await c("POST", "/api/r/old-visit/orders", { body: { tableId: "1", k: "key1", ...fries() } });
    assert.equal(placed.status, 201);
    assert.equal((await c("GET", "/api/r/old-visit/orders?table=1&k=key1")).body.orders.map((o) => o.id).join(), placed.body.order.id);
  } finally { s.stop(); }
});

test("invoice and receipt links need the order's own token", async () => {
  const s = await signup("Paper Trail");
  const ck = cookieOf(s.cookie), K = await keysOf("paper-trail", ck);
  const o = (await req("POST", "/api/r/paper-trail/orders", { body: { tableId: "1", k: K["1"], ...fries() } })).body.order;
  await req("POST", `/api/r/paper-trail/orders/${o.id}/confirm-payment`, { cookie: ck });
  const doc = (qs) => fetch(`${srv.base}/api/r/paper-trail/orders/${o.id}/receipt${qs}`);
  assert.equal((await doc(`?t=${o.token}`)).status, 200);
  assert.equal((await doc("")).status, 403);
  assert.equal((await doc("?table=1")).status, 403);
  assert.equal((await doc("?t=" + "0".repeat(o.token.length))).status, 403);
});

/* ---------- 4. limits on anonymous endpoints ---------- */
test("one table cannot flood the kitchen: orders are rate limited and capped", async () => {
  const s = await signup("Flood Test");
  const ck = cookieOf(s.cookie), K = await keysOf("flood-test", ck);
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await req("POST", "/api/r/flood-test/orders", { body: { tableId: "1", k: K["1"], ...fries() } })).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 201, 429, 429], "6 orders per table per 10 minutes");
  assert.equal((await req("POST", "/api/r/flood-test/orders", { body: { tableId: "2", k: K["2"], ...fries() } })).status, 201, "another table is unaffected");
  const big = await req("POST", "/api/r/flood-test/orders", { body: { tableId: "3", k: K["3"], items: Array.from({ length: 41 }, () => ({ menuItemId: "fries", qty: 1 })) } });
  assert.equal(big.status, 400); assert.match(big.body.error, /too large/i);
  const heavy = await req("POST", "/api/r/flood-test/orders", { body: { tableId: "3", k: K["3"], items: Array.from({ length: 11 }, () => ({ menuItemId: "fries", qty: 20 })) } });
  assert.equal(heavy.status, 400, "more than 200 portions in one order");
});

test("a table with many unfinished orders is told to ask the waiter", async () => {
  const now = Date.now();
  const rest = mkRest("busy-table", { sessions: { 1: { id: "s1", startedAt: now - 1e5, lastAt: now - 1e3 } }, orders: Array.from({ length: 15 }, (_, i) => mkOrder(1001 + i)), seq: 1015 });
  const s = await startServer(3235, { store: { restaurants: { "busy-table": rest } } });
  try {
    const r = await client(s.base)("POST", "/api/r/busy-table/orders", { body: { tableId: "1", k: "key1", ...fries() } });
    assert.equal(r.status, 429); assert.match(r.body.error, /waiter/i);
  } finally { s.stop(); }
});

test("calling staff twice is one request, not two", async () => {
  const s = await signup("Bell Test");
  const ck = cookieOf(s.cookie), K = await keysOf("bell-test", ck);
  const call = () => req("POST", "/api/r/bell-test/assist", { body: { tableId: "1", k: K["1"] } });
  assert.equal((await call()).status, 201);
  const again = await call();
  assert.equal(again.status, 200); assert.equal(again.body.already, true);
  assert.equal((await req("GET", "/api/r/bell-test/assist", { cookie: ck })).body.requests.length, 1);
});

/* ---------- 6. staff order lists are paged ---------- */
test("kitchen gets only open orders; admin gets open plus the last day, and can page back", async () => {
  const day = 24 * 3600e3, orders = [];
  for (let i = 1; i <= 60; i++) orders.push(mkOrder(1000 + i, { status: "Served", createdAt: new Date(Date.now() - 3 * day + i * 1000).toISOString() })); // old, finished
  orders.push(mkOrder(1061, { status: "Preparing", createdAt: new Date(Date.now() - 2 * day).toISOString() })); // old but still open
  orders.push(mkOrder(1062, { status: "Served" }), mkOrder(1063, { status: "Received" })); // today
  const s = await startServer(3236, { store: { restaurants: { "long-history": mkRest("long-history", { orders, seq: 1063 }) } } });
  try {
    const c = client(s.base);
    const ck = cookieOf((await c("POST", "/api/r/long-history/auth/login", { body: { username: "boss", password: "boss-pass-1" } })).cookie);
    const open = await c("GET", "/api/r/long-history/orders?scope=open", { cookie: ck });
    assert.deepEqual(open.body.orders.map((o) => o.id), ["ORD-1063", "ORD-1061"], "only unfinished orders, newest first");
    const recent = await c("GET", "/api/r/long-history/orders?scope=recent", { cookie: ck });
    assert.deepEqual(recent.body.orders.map((o) => o.id), ["ORD-1063", "ORD-1062", "ORD-1061"]);
    assert.equal(recent.body.hasMore, true); assert.equal(recent.body.total, 63);
    const page1 = await c("GET", "/api/r/long-history/orders?before=1061&limit=25", { cookie: ck });
    assert.equal(page1.body.orders.length, 25); assert.equal(page1.body.orders[0].id, "ORD-1060"); assert.equal(page1.body.hasMore, true);
    const page3 = await c("GET", "/api/r/long-history/orders?before=1011&limit=25", { cookie: ck });
    assert.equal(page3.body.orders.length, 10); assert.equal(page3.body.hasMore, false);
    assert.equal((await c("GET", "/api/r/long-history/orders?scope=open")).status, 401);
  } finally { s.stop(); }
});

/* ---------- 5. storage failures are never reported as success ---------- */
test("when the store cannot be written the guest gets a 503, and a retry does not double-order", async () => {
  const s = await startServer(3237);
  const c = client(s.base);
  try {
    const body = { ...s.k("4"), idempotencyKey: "retry-1", ...fries() };
    chmodSync(s.dir, 0o500); // read-only: writes now fail
    const failed = await c("POST", `${API}/orders`, { body });
    assert.equal(failed.status, 503); assert.equal(failed.body.code, "STORAGE");
    chmodSync(s.dir, 0o700);
    const retry = await c("POST", `${API}/orders`, { body });
    assert.ok([200, 201].includes(retry.status), "retry succeeds: " + retry.status);
    const staff = await c("GET", `${API}/orders?scope=open`, { cookie: s.cookie });
    assert.equal(staff.body.orders.filter((o) => o.idempotencyKey === "retry-1").length, 1, "exactly one order");
    // Make sure it really lands on disk once writes work again.
    await c("PATCH", `${API}/orders/${staff.body.orders[0].id}`, { cookie: s.cookie, body: { status: "Preparing" } });
    const file = JSON.parse(readFileSync(path.join(s.dir, "store.json"), "utf8"));
    assert.equal(file.restaurants[REST].orders.filter((o) => o.idempotencyKey === "retry-1").length, 1);
  } finally { try { chmodSync(s.dir, 0o700); } catch {} s.stop(); }
});

test("SIGTERM flushes and exits cleanly instead of hanging until it is killed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "term-"));
  const proc = spawn("node", ["server.js"], { env: { ...process.env, PORT: "3238", DATA_DIR: dir }, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; proc.stdout.on("data", (d) => { out += d; });
  for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:3238/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  const t0 = Date.now();
  const code = await new Promise((resolve) => { proc.on("exit", (c) => resolve(c)); proc.kill("SIGTERM"); });
  assert.equal(code, 0); assert.ok(Date.now() - t0 < 4000, "exited promptly");
  assert.match(out, /shutting down/);
});

test("health reports ok and nothing else is exposed there", async () => {
  const r = await fetch(`${srv.base}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: "ok" });
});

/* ======================= round two: proxy, transport, headers, caps, time zone ======================= */
import http from "node:http";

// A raw request: no automatic decompression, so the tests see exactly what the server sent.
const raw = (port, p, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: "localhost", port, path: p, method, headers }, (res) => {
    const chunks = []; res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  r.on("error", reject); r.end();
});

test("login and signup limits use the address our proxy saw, not what the visitor typed", async () => {
  const s = await startServer(3243, { env: { TRUST_PROXY: "1", SIGNUP_PER_HOUR: "100" } });
  try {
    const probe = async (xff, n) => { const out = []; for (let i = 0; i < n; i++) out.push((await fetch(`${s.base}/api/r/${REST}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": xff(i) }, body: JSON.stringify({ username: "admin", password: "wrong" + i }) })).status); return out; };
    // The visitor rotates the first entry; the proxy appends the real address (9.9.9.9) at the end. Still one client.
    const rotating = await probe((i) => `fake-${i}, 9.9.9.9`, 10);
    assert.deepEqual(rotating, [401, 401, 401, 401, 401, 401, 401, 401, 429, 429], "throttled after 8 failures despite the rotating prefix");
    // A different real client has its own allowance.
    assert.equal((await probe(() => "fake, 8.8.8.8", 1))[0], 401);
  } finally { s.stop(); }
});

test("with two proxy hops (TRUST_PROXY=2) the entry two from the right is the client", async () => {
  const s = await startServer(3244, { env: { TRUST_PROXY: "2" } });
  try {
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await fetch(`${s.base}/api/r/${REST}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `spoof-${i}, 5.5.5.5, 10.0.0.1` }, body: JSON.stringify({ username: "admin", password: "bad" + i }) })).status);
    assert.equal(statuses[8], 429); assert.equal(statuses[9], 429);
  } finally { s.stop(); }
});

test("without TRUST_PROXY the forwarded header is ignored entirely", async () => {
  const s = await startServer(3245);
  try {
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await fetch(`${s.base}/api/r/${REST}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `1.2.3.${i}` }, body: JSON.stringify({ username: "admin", password: "bad" + i }) })).status);
    assert.equal(statuses[8], 429, "rotating the header does not buy extra attempts");
  } finally { s.stop(); }
});

test("idle keep-alive connections outlive Node's 5 second default (proxies reuse them)", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = () => new Promise((resolve, reject) => { const r = http.get({ host: "localhost", port: 3230, path: "/health", agent }, (res) => { res.resume(); res.on("end", () => resolve(r.reusedSocket)); }); r.on("error", reject); });
  try {
    assert.equal(await get(), false);
    await new Promise((r) => setTimeout(r, 6500));
    assert.equal(await get(), true, "the same connection was still open after 6.5s idle, so a proxy would not hit a closed socket");
  } finally { agent.destroy(); }
});

test("every response carries security headers; HSTS only over https", async () => {
  for (const p of ["/", "/signup", "/app.css", `/r/${REST}/guest`, "/api/r/" + REST + "/menu", "/no-such-page", `/r/ghost/admin`]) {
    const r = await raw(3230, p);
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/, p);
    assert.match(r.headers["content-security-policy"], /default-src 'self'/, p);
    assert.equal(r.headers["x-frame-options"], "DENY", p);
    assert.equal(r.headers["x-content-type-options"], "nosniff", p);
    assert.equal(r.headers["referrer-policy"], "same-origin", p);
    assert.match(r.headers["permissions-policy"], /camera=\(\)/, p);
    assert.equal(r.headers["strict-transport-security"], undefined, p + " over plain http");
  }
  const https = await raw(3230, "/", { headers: { "X-Forwarded-Proto": "https" } });
  assert.match(https.headers["strict-transport-security"], /max-age=\d+/);
  assert.match((await raw(3230, `/r/${REST}/admin`)).headers["x-robots-tag"], /noindex/);
  assert.match((await raw(3230, `/api/r/${REST}/menu`)).headers["x-robots-tag"], /noindex/);
  assert.equal((await raw(3230, "/")).headers["x-robots-tag"], undefined, "the home page can be indexed");
});

test("static files are compressed, cached and revalidated", async () => {
  const plain = await raw(3230, "/app.css", { headers: { "Accept-Encoding": "identity" } });
  const br = await raw(3230, "/app.css", { headers: { "Accept-Encoding": "br, gzip" } });
  const gz = await raw(3230, "/app.css", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(plain.status, 200); assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(br.headers["content-encoding"], "br"); assert.equal(gz.headers["content-encoding"], "gzip");
  const { gunzipSync, brotliDecompressSync } = await import("node:zlib");
  assert.equal(gunzipSync(gz.body).toString(), plain.body.toString(), "gzip round-trips");
  assert.equal(brotliDecompressSync(br.body).toString(), plain.body.toString(), "brotli round-trips");
  assert.ok(gz.body.length < plain.body.length / 3, `gzip is at least 3x smaller (${plain.body.length} -> ${gz.body.length})`);
  assert.equal(plain.headers["cache-control"], "public, max-age=600");
  assert.equal(plain.headers["vary"], "Accept-Encoding");
  // Revalidation: same ETag means a 304 with no body.
  const again = await raw(3230, "/app.css", { headers: { "If-None-Match": plain.headers.etag } });
  assert.equal(again.status, 304); assert.equal(again.body.length, 0);
  assert.equal((await raw(3230, "/", {})).headers["cache-control"], "no-cache", "pages always revalidate so deploys show up at once");
  assert.match((await raw(3230, "/fonts/bricolage-grotesque-latin.woff2")).headers["cache-control"], /immutable/);
  assert.equal((await raw(3230, "/app.css", { method: "HEAD" })).body.length, 0);
  assert.equal((await raw(3230, "/app.css", { method: "POST" })).status, 405);
});

test("favicon, robots and link-preview basics exist", async () => {
  const ico = await raw(3230, "/favicon.ico");
  assert.equal(ico.status, 200); assert.match(ico.headers["content-type"], /svg/);
  const robots = await raw(3230, "/robots.txt");
  assert.equal(robots.status, 200); assert.match(robots.body.toString(), /Disallow: \/r\//);
  assert.match((await raw(3230, "/")).body.toString(), /property="og:title"/);
});

test("large JSON replies are gzipped, small ones are not", async () => {
  const menu = await raw(3230, `/api/r/${REST}/menu`, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(menu.headers["content-encoding"], "gzip");
  const { gunzipSync } = await import("node:zlib");
  assert.ok(JSON.parse(gunzipSync(menu.body).toString()).items.length > 5);
  assert.equal((await raw(3230, `/api/r/${REST}/menu`, { headers: { "Accept-Encoding": "identity" } })).headers["content-encoding"], undefined);
  assert.equal((await raw(3230, "/health", { headers: { "Accept-Encoding": "gzip" } })).headers["content-encoding"], undefined, "tiny replies are sent as is");
});

test("one address cannot hold unlimited live connections open", async () => {
  const s = await startServer(3246, { env: { STREAMS_PER_IP_RESTAURANT: "3", STREAMS_PER_IP: "50" } });
  const acs = [];
  try {
    const open = async (id) => { const ac = new AbortController(); acs.push(ac); const r = await fetch(`${s.base}/api/r/${REST}/table-events?${s.q(id)}`, { signal: ac.signal }); return { r, ac }; };
    const a = await open("1"), b = await open("2"), c = await open("3");
    assert.deepEqual([a.r.status, b.r.status, c.r.status], [200, 200, 200]);
    const refused = await open("4");
    assert.equal(refused.r.status, 429); assert.match((await refused.r.json()).error, /Too many live connections/);
    a.ac.abort(); await new Promise((r) => setTimeout(r, 300));
    assert.equal((await open("5")).r.status, 200, "a slot is free again once a stream closes");
  } finally { acs.forEach((a) => a.abort()); s.stop(); }
});

test("receipts print times in Lagos time, not the server's", async () => {
  const when = "2026-03-01T23:30:00.000Z"; // 00:30 on 2 March in Lagos (UTC+1)
  const rest = mkRest("late-night", { orders: [mkOrder(1001, { createdAt: when, payment: { state: "paid", method: "manual", confirmedAt: when, confirmedBy: "boss" } })], seq: 1001 });
  const s = await startServer(3247, { store: { restaurants: { "late-night": rest } }, env: { TZ: "UTC" } });
  try {
    const r = await fetch(`${s.base}/api/r/late-night/orders/ORD-1001/receipt?t=tok1001`);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /2 Mar 2026, 00:30 WAT/, "Lagos wall-clock time with its zone");
    assert.ok(!/1 Mar 2026, 23:30/.test(html), "not the UTC time");
  } finally { s.stop(); }
});

/* ======================= round three: lockout, cross-origin writes, revoked streams ======================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rawPost = (port, p, { headers = {}, body = "{}" } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: "localhost", port, path: p, method: "POST", headers: { "Content-Length": Buffer.byteLength(body), ...headers } }, (res) => {
    const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  r.on("error", reject); r.end(body);
});

test("many addresses guessing one account get it locked, without revealing which accounts exist", async () => {
  const s = await startServer(3248, { env: { TRUST_PROXY: "1", LOGIN_LOCK_MS: "1500" } });
  try {
    const attempt = (user, pass, i) => fetch(`${s.base}/api/r/${REST}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${i}` }, body: JSON.stringify({ username: user, password: pass }) }).then((r) => r.status);
    const first = []; for (let i = 1; i <= 12; i++) first.push(await attempt("admin", "wrong" + i, i)); // a different address every time
    assert.deepEqual(first, [401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 429, 429], "locked after 10 failures from any addresses");
    assert.equal(await attempt("admin", "admin123", 50), 429, "even the right password is refused while locked");
    assert.equal(await attempt("kitchen", "kitchen123", 51), 200, "other accounts are unaffected");
    const ghost = []; for (let i = 60; i < 72; i++) ghost.push(await attempt("nobody", "x" + i, i));
    assert.deepEqual(ghost.slice(10), [429, 429], "an account that does not exist locks the same way, so the reply leaks nothing");
    await sleep(1700);
    assert.equal(await attempt("admin", "admin123", 80), 200, "it unlocks after the window");
    const more = []; for (let i = 90; i < 99; i++) more.push(await attempt("admin", "bad" + i, i));
    assert.ok(more.every((c) => c === 401), "a successful sign-in resets the count");
  } finally { s.stop(); }
});

test("the platform login locks the same way", async () => {
  const s = await startServer(3249, { env: { TRUST_PROXY: "1", LOGIN_LOCK_MS: "1500", SUPERADMIN_USER: "root", SUPERADMIN_PASSWORD: "platform-secret-1", SESSION_SECRET: "x-secret" } });
  try {
    const attempt = (pass, i) => fetch(`${s.base}/api/superadmin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${i}` }, body: JSON.stringify({ username: "root", password: pass }) }).then((r) => r.status);
    for (let i = 1; i <= 10; i++) assert.equal(await attempt("nope" + i, i), 401);
    assert.equal(await attempt("platform-secret-1", 40), 429);
    await sleep(1700);
    assert.equal(await attempt("platform-secret-1", 41), 200);
  } finally { s.stop(); }
});

test("state-changing requests from another origin are refused, own pages and plain tools are not", async () => {
  const body = JSON.stringify({ items: [{ menuItemId: "fries", qty: 1 }] });
  const post = (headers) => rawPost(3230, `${API}/orders/preview`, { headers: { "Content-Type": "application/json", ...headers }, body });
  assert.equal((await post({})).status, 200, "curl-style call with no browser headers");
  assert.equal((await post({ "Sec-Fetch-Site": "same-origin" })).status, 200);
  assert.equal((await post({ "Sec-Fetch-Site": "none" })).status, 200);
  assert.equal((await post({ Origin: "http://localhost:3230" })).status, 200, "Origin equal to our own host");
  for (const h of [{ "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.propertypadi.com" }, { Origin: "null" }, { "Sec-Fetch-Site": "same-origin", Origin: "https://evil.example" }]) {
    const r = await post(h);
    assert.equal(r.status, 403, JSON.stringify(h)); assert.equal(JSON.parse(r.body).code, "CROSS_SITE");
  }
  // The dangerous case: a manager's cookie attached to a request that another site triggered.
  const placed = await req("POST", `${API}/orders`, { body: { ...srv.k("9"), items: [{ menuItemId: "fries", qty: 1 }] } });
  const id = placed.body.order.id;
  const attack = await rawPost(3230, `${API}/orders/${id}/confirm-payment`, { headers: { Cookie: srv.cookie, "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } });
  assert.equal(attack.status, 403);
  assert.equal((await req("GET", `${API}/orders?scope=open`, { cookie: srv.cookie })).body.orders.find((o) => o.id === id).payment.state, "awaiting-collection", "nothing changed");
  const real = await rawPost(3230, `${API}/orders/${id}/confirm-payment`, { headers: { Cookie: srv.cookie, "Sec-Fetch-Site": "same-origin", Origin: "http://localhost:3230" } });
  assert.equal(real.status, 200, "the same call from our own page works");
  // Reads from other origins stay allowed (links opened from elsewhere).
  const get = await new Promise((resolve, reject) => http.get({ host: "localhost", port: 3230, path: "/", headers: { "Sec-Fetch-Site": "cross-site" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject));
  assert.equal(get, 200);
});

test("the configured public address counts as our own origin even if the proxy rewrites Host", async () => {
  const s = await startServer(3252, { env: { PUBLIC_BASE_URL: "https://orders.example.com" } });
  try {
    const body = JSON.stringify({ items: [{ menuItemId: "fries", qty: 1 }] });
    const ok = await rawPost(3252, `${API}/orders/preview`, { headers: { "Content-Type": "application/json", Origin: "https://orders.example.com", Host: "internal-container:3000" }, body });
    assert.equal(ok.status, 200);
    const bad = await rawPost(3252, `${API}/orders/preview`, { headers: { "Content-Type": "application/json", Origin: "https://evil.example", Host: "internal-container:3000" }, body });
    assert.equal(bad.status, 403);
  } finally { s.stop(); }
});

test("live feeds close when staff access is revoked or a table's code is replaced", async () => {
  const closed = async (res, ms = 3000) => {
    const reader = res.body.getReader(), t = Date.now();
    try { for (;;) { const r = await Promise.race([reader.read(), sleep(ms).then(() => ({ timeout: true }))]); if (r.timeout) return false; if (r.done) return true; } } catch { return true; }
  };
  const s = await signup("Revoked Feed", "feeder");
  const mgr = cookieOf(s.cookie), K = await keysOf("revoked-feed", mgr);
  // 1. a staff screen's stream ends when that restaurant's staff password is reset
  const staff = await fetch(`${srv.base}/api/r/revoked-feed/events`, { headers: { Cookie: mgr } });
  assert.equal(staff.status, 200);
  const staffClosed = closed(staff);
  await sleep(200);
  assert.equal((await req("POST", "/api/r/revoked-feed/tables/1/rotate-key", { cookie: mgr })).status, 200);
  await req("POST", "/api/superadmin/restaurants/revoked-feed/staff/feeder/reset-password", { cookie: saCookie, body: { password: "after-reset-pass-1" } });
  assert.equal(await staffClosed, true, "the stream was closed");
  assert.equal((await fetch(`${srv.base}/api/r/revoked-feed/events`, { headers: { Cookie: mgr } })).status, 401, "and the old session cannot reopen it");
  // 2. a guest's stream ends when the table's QR code is replaced
  const mgr2 = cookieOf((await req("POST", "/api/r/revoked-feed/auth/login", { body: { username: "feeder", password: "after-reset-pass-1" } })).cookie);
  const key2 = (await keysOf("revoked-feed", mgr2))["2"];
  const guest = await fetch(`${srv.base}/api/r/revoked-feed/table-events?table=2&k=${key2}`);
  assert.equal(guest.status, 200);
  const guestClosed = closed(guest);
  await sleep(200);
  await req("POST", "/api/r/revoked-feed/tables/2/rotate-key", { cookie: mgr2 });
  assert.equal(await guestClosed, true, "the guest feed for the old code was closed");
  assert.equal((await fetch(`${srv.base}/api/r/revoked-feed/table-events?table=2&k=${key2}`)).status, 400, "the old code cannot reconnect");
  // 3. deleting the restaurant ends every stream
  const staff2 = await fetch(`${srv.base}/api/r/revoked-feed/events`, { headers: { Cookie: mgr2 } });
  const staff2Closed = closed(staff2);
  await sleep(200);
  assert.equal((await req("DELETE", "/api/superadmin/restaurants/revoked-feed", { cookie: saCookie, body: { confirm: "revoked-feed" } })).status, 200);
  assert.equal(await staff2Closed, true);
});
