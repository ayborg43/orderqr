import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3198;
const base = `http://localhost:${PORT}`;
let proc;
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get("set-cookie") || "" });
const req = (method, p, { body, cookie } = {}) => fetch(base + p, {
  method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(j);
const login = (username, password) => req("POST", "/api/auth/login", { body: { username, password } });
const sessionCookie = (setCookie) => setCookie.split(";")[0];

before(async () => {
  proc = spawn("node", ["server.js"], { env: { ...process.env, PORT: String(PORT), MANAGER_USER: "boss", MANAGER_PASSWORD: "boss-pass", KITCHEN_USER: "cook", KITCHEN_PASSWORD: "cook-pass", SESSION_SECRET: "test-secret" }, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(base + "/api/tables"); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error("server did not start");
});
after(() => proc?.kill());

test("staff endpoints reject anonymous callers", async () => {
  assert.equal((await req("GET", "/api/orders")).status, 401);
  assert.equal((await req("PATCH", "/api/orders/ORD-1", { body: { status: "Preparing" } })).status, 401);
  assert.equal((await req("PATCH", "/api/menu/fries/availability", { body: { available: false } })).status, 401);
  assert.equal((await req("PATCH", "/api/settings", { body: { cardSurchargePct: 2 } })).status, 401);
  assert.equal((await req("GET", "/api/assist")).status, 401);
  assert.equal((await req("GET", "/api/auth/me")).status, 401);
});

test("wrong password is rejected and does not set a session", async () => {
  const r = await login("boss", "wrong");
  assert.equal(r.status, 401);
  assert.ok(!r.cookie.includes("qr_staff=") || r.cookie.includes("qr_staff=;"), "no session cookie on failed login");
});

test("manager can sign in, is identified, and can use manager endpoints", async () => {
  const r = await login("boss", "boss-pass");
  assert.equal(r.status, 200);
  assert.equal(r.body.user, "boss");
  assert.equal(r.body.role, "manager");
  assert.match(r.cookie, /qr_staff=/);
  assert.match(r.cookie, /HttpOnly/i);
  const cookie = sessionCookie(r.cookie);
  const me = await req("GET", "/api/auth/me", { cookie });
  assert.equal(me.status, 200); assert.equal(me.body.role, "manager");
  assert.equal((await req("GET", "/api/orders", { cookie })).status, 200);
  assert.equal((await req("PATCH", "/api/settings", { cookie, body: { cardSurchargePct: 1.5 } })).status, 200);
  // logout clears the session cookie
  const out = await req("POST", "/api/auth/logout", { cookie });
  assert.equal(out.status, 200);
  assert.match(out.cookie, /qr_staff=;/);
});

test("kitchen role can advance orders but cannot change settings or availability", async () => {
  const r = await login("cook", "cook-pass");
  assert.equal(r.status, 200); assert.equal(r.body.role, "kitchen");
  const cookie = sessionCookie(r.cookie);
  assert.equal((await req("GET", "/api/orders", { cookie })).status, 200);
  assert.equal((await req("PATCH", "/api/orders/ORD-999999", { cookie, body: { status: "Preparing" } })).status, 404); // authorised, order missing
  assert.equal((await req("PATCH", "/api/settings", { cookie, body: { cardSurchargePct: 9 } })).status, 403);
  assert.equal((await req("PATCH", "/api/menu/fries/availability", { cookie, body: { available: false } })).status, 403);
});

test("a forged session cookie is rejected", async () => {
  const forged = "qr_staff=" + Buffer.from(JSON.stringify({ u: "boss", r: "manager", exp: Date.now() + 1e6 })).toString("base64url") + ".forgedsignature";
  assert.equal((await req("GET", "/api/orders", { cookie: forged })).status, 401);
});

test("guest surface stays public", async () => {
  assert.equal((await req("GET", "/api/menu")).status, 200);
  assert.equal((await req("GET", "/api/tables")).status, 200);
  assert.equal((await req("GET", "/api/orders?table=5")).status, 200);
  const order = await req("POST", "/api/orders", { body: { tableId: "5", idempotencyKey: "auth-test-" + Date.now(), payment: { cardNumber: "4242 4242 4242 4242" }, items: [{ menuItemId: "fries", qty: 1, modifiers: [] }] } });
  assert.equal(order.status, 201);
});
