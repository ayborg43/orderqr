import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, client, cookieOf, DEMO } from "./helpers.mjs";

// Runs only when a throwaway Postgres server is provided, for example:
//   docker run -d --name chopdesk-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test
// Each test creates its own empty database on that server.
const DB = process.env.TEST_DATABASE_URL;
const skip = !DB && "TEST_DATABASE_URL not set";

async function freshDb() {
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: DB }); await admin.connect();
  const name = "chopdesk_t_" + crypto.randomBytes(5).toString("hex");
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const url = new URL(DB); url.pathname = "/" + name;
  const open = async () => { const c = new pg.Client({ connectionString: url.toString() }); await c.connect(); return c; };
  return { url: url.toString(), open };
}
const hashSync = (pw) => `scrypt$salt$${crypto.scryptSync(pw, "salt", 32).toString("base64url")}`;

test("orders persist in Postgres, one row each, and survive a restart", { skip }, async () => {
  const db = await freshDb();
  const s1 = await startServer(3221, { env: { DATABASE_URL: db.url } });
  try {
    const api = client(s1.base);
    const placed = await api("POST", `/api/r/${DEMO}/orders`, { body: { ...s1.k("5"), idempotencyKey: "db-test-1", items: [{ menuItemId: "fries", qty: 1, modifiers: [] }] } });
    assert.equal(placed.status, 201);
    await api("POST", `/api/r/${DEMO}/orders`, { body: { ...s1.k("6"), idempotencyKey: "db-test-2", items: [{ menuItemId: "fries", qty: 2 }] } });
    await api("PATCH", `/api/r/${DEMO}/orders/${placed.body.order.id}`, { cookie: s1.cookie, body: { status: "Preparing" } });
    const c = await db.open();
    try {
      const rows = (await c.query("SELECT id, data->>'status' AS status FROM orders WHERE slug = $1 ORDER BY seq", [DEMO])).rows;
      assert.deepEqual(rows.map((r) => [r.id, r.status]), [["ORD-1001", "Preparing"], ["ORD-1002", "Received"]]);
      const doc = (await c.query("SELECT data FROM restaurants WHERE slug = $1", [DEMO])).rows[0].data;
      assert.equal(doc.orders, undefined, "orders live in their own table, not inside the restaurant row");
      assert.equal(doc.seq, 1002);
    } finally { await c.end(); }
  } finally { s1.stop(); }

  // Fresh process, same database, different data dir: everything must come from Postgres.
  await new Promise((r) => setTimeout(r, 400));
  const s2 = await startServer(3222, { env: { DATABASE_URL: db.url } });
  try {
    const api = client(s2.base);
    const list = await api("GET", `/api/r/${DEMO}/orders?scope=open`, { cookie: (await api("POST", `/api/r/${DEMO}/auth/login`, { body: { username: "admin", password: "admin123" } })).cookie.split(";")[0] });
    assert.deepEqual(list.body.orders.map((o) => o.id), ["ORD-1002", "ORD-1001"]);
    assert.equal(list.body.orders[1].status, "Preparing", "the status change survived the restart");
  } finally { s2.stop(); }
});

test("a second instance waits for the first instead of overwriting its data", { skip }, async () => {
  const db = await freshDb();
  const s1 = await startServer(3223, { env: { DATABASE_URL: db.url } });
  const api = client(s1.base);
  await api("POST", `/api/r/${DEMO}/orders`, { body: { ...s1.k("1"), idempotencyKey: "lock-1", items: [{ menuItemId: "fries", qty: 1 }] } });
  // Start a second process on the same database. It must not serve (or write) while the first is alive.
  const dir = mkdtempSync(path.join(tmpdir(), "lock-"));
  const p2 = spawn("node", ["server.js"], { env: { ...process.env, PORT: "3224", DATA_DIR: dir, DATABASE_URL: db.url }, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 2000));
    let up = true; try { await fetch("http://localhost:3224/health"); } catch { up = false; }
    assert.equal(up, false, "the second instance is still waiting for the lock");
    // The first instance keeps working meanwhile.
    assert.equal((await api("POST", `/api/r/${DEMO}/orders`, { body: { ...s1.k("2"), idempotencyKey: "lock-2", items: [{ menuItemId: "fries", qty: 1 }] } })).status, 201);
    // When the first one stops, the second takes over with every order intact.
    s1.stop();
    let health = null;
    for (let i = 0; i < 50 && !health; i++) { try { health = await fetch("http://localhost:3224/health"); } catch { await new Promise((r) => setTimeout(r, 200)); } }
    assert.equal(health?.status, 200, "the second instance took over");
    const c2 = client("http://localhost:3224");
    const login = await c2("POST", `/api/r/${DEMO}/auth/login`, { body: { username: "admin", password: "admin123" } });
    const orders = await c2("GET", `/api/r/${DEMO}/orders?scope=open`, { cookie: cookieOf(login.cookie) });
    assert.equal(orders.body.orders.length, 2, "nothing was lost in the handover");
  } finally { p2.kill(); s1.stop(); }
});

test("restaurants that keep their orders inside the row are upgraded to one row per order", { skip }, async () => {
  const db = await freshDb();
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: db.url }); await c.connect();
  await c.query("CREATE TABLE restaurants (slug TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const order = (n) => ({ id: `ORD-${n}`, tableId: "1", tableLabel: "Table 1", items: [], subtotal: 5, surcharges: [], total: 5, status: "Received", payment: { state: "awaiting-collection" }, createdAt: new Date().toISOString(), history: [] });
  const legacy = { slug: "old-format", name: "Old Format", createdAt: "2026-01-01T00:00:00.000Z", tables: [{ id: "1", label: "Table 1" }], menu: [], orders: [order(1001), order(1002), order(1003)], assistRequests: [], settings: { cardSurchargePct: 0, holidaySurchargePct: 10, holidayMode: false, v: 2 }, seq: 1003, staff: [{ username: "boss", role: "manager", hash: hashSync("boss-pass-1") }] };
  await c.query("INSERT INTO restaurants (slug, data) VALUES ($1, $2)", ["old-format", JSON.stringify(legacy)]);
  const s = await startServer(3225, { env: { DATABASE_URL: db.url } });
  try {
    const api = client(s.base);
    const ck = cookieOf((await api("POST", "/api/r/old-format/auth/login", { body: { username: "boss", password: "boss-pass-1" } })).cookie);
    assert.deepEqual((await api("GET", "/api/r/old-format/orders?scope=open", { cookie: ck })).body.orders.map((o) => o.id), ["ORD-1003", "ORD-1002", "ORD-1001"]);
    const n = (await c.query("SELECT count(*)::int AS n FROM orders WHERE slug = 'old-format'")).rows[0].n;
    assert.equal(n, 3, "each embedded order became its own row");
    assert.equal((await c.query("SELECT data FROM restaurants WHERE slug = 'old-format'")).rows[0].data.orders, undefined);
  } finally { s.stop(); await c.end(); }
});

test("deleting one restaurant never touches the others in the database", { skip }, async () => {
  const db = await freshDb();
  const s = await startServer(3226, { env: { DATABASE_URL: db.url, SUPERADMIN_USER: "root", SUPERADMIN_PASSWORD: "platform-secret-1", SESSION_SECRET: "db-secret" } });
  try {
    const api = client(s.base);
    const sa = cookieOf((await api("POST", "/api/superadmin/auth/login", { body: { username: "root", password: "platform-secret-1" } })).cookie);
    await api("POST", "/api/restaurants", { body: { name: "Doomed Diner", username: "doomed", password: "password-123" } });
    await api("POST", `/api/r/${DEMO}/orders`, { body: { ...s.k("1"), items: [{ menuItemId: "fries", qty: 1 }] } });
    assert.equal((await api("DELETE", "/api/superadmin/restaurants/doomed-diner", { cookie: sa, body: { confirm: "doomed-diner" } })).status, 200);
    const c = await db.open();
    try {
      assert.deepEqual((await c.query("SELECT slug FROM restaurants ORDER BY slug")).rows.map((r) => r.slug), [DEMO]);
      assert.equal((await c.query("SELECT count(*)::int AS n FROM orders WHERE slug = $1", [DEMO])).rows[0].n, 1);
    } finally { await c.end(); }
  } finally { s.stop(); }
});
