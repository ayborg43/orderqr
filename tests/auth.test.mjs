import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, client, cookieOf, DEMO } from "./helpers.mjs";

const API = `/api/r/${DEMO}`;
const COOKIE = `qr_staff_${DEMO}`;
let srv, req;
const login = (username, password) => req("POST", `${API}/auth/login`, { body: { username, password } });

before(async () => {
  srv = await startServer(3198, { env: { SESSION_SECRET: "test-secret" } });
  req = client(srv.base);
});
after(() => srv?.stop());

test("staff endpoints reject anonymous callers", async () => {
  assert.equal((await req("GET", `${API}/orders`)).status, 401);
  assert.equal((await req("PATCH", `${API}/orders/ORD-1`, { body: { status: "Preparing" } })).status, 401);
  assert.equal((await req("PATCH", `${API}/menu/fries/availability`, { body: { available: false } })).status, 401);
  assert.equal((await req("POST", `${API}/menu`, { body: { name: "X" } })).status, 401);
  assert.equal((await req("PATCH", `${API}/settings`, { body: { cardSurchargePct: 2 } })).status, 401);
  assert.equal((await req("GET", `${API}/assist`)).status, 401);
  assert.equal((await req("GET", `${API}/events`)).status, 401);
  assert.equal((await req("GET", `${API}/auth/me`)).status, 401);
});

test("wrong password is rejected and does not set a session", async () => {
  const r = await login("admin", "wrong");
  assert.equal(r.status, 401);
  assert.ok(!r.cookie.includes(`${COOKIE}=`), "no session cookie on failed login");
});

test("manager can sign in, is identified, and can use manager endpoints", async () => {
  const r = await login("admin", "admin123");
  assert.equal(r.status, 200);
  assert.equal(r.body.user, "admin");
  assert.equal(r.body.role, "manager");
  assert.match(r.cookie, new RegExp(`${COOKIE}=`));
  assert.match(r.cookie, /HttpOnly/i);
  const cookie = cookieOf(r.cookie);
  const me = await req("GET", `${API}/auth/me`, { cookie });
  assert.equal(me.status, 200); assert.equal(me.body.role, "manager");
  assert.equal((await req("GET", `${API}/orders`, { cookie })).status, 200);
  assert.equal((await req("PATCH", `${API}/settings`, { cookie, body: { cardSurchargePct: 1.5 } })).status, 200);
  const out = await req("POST", `${API}/auth/logout`, { cookie });
  assert.equal(out.status, 200);
  assert.match(out.cookie, new RegExp(`${COOKIE}=;`));
});

test("kitchen role can advance orders but cannot change settings, menu or tables", async () => {
  const r = await login("kitchen", "kitchen123");
  assert.equal(r.status, 200); assert.equal(r.body.role, "kitchen");
  const cookie = cookieOf(r.cookie);
  assert.equal((await req("GET", `${API}/orders`, { cookie })).status, 200);
  assert.equal((await req("PATCH", `${API}/orders/ORD-999999`, { cookie, body: { status: "Preparing" } })).status, 404); // authorised, order missing
  assert.equal((await req("PATCH", `${API}/settings`, { cookie, body: { cardSurchargePct: 9 } })).status, 403);
  assert.equal((await req("PATCH", `${API}/menu/fries/availability`, { cookie, body: { available: false } })).status, 403);
  assert.equal((await req("POST", `${API}/tables`, { cookie, body: {} })).status, 403);
});

test("a forged session cookie is rejected", async () => {
  const forged = `${COOKIE}=` + Buffer.from(JSON.stringify({ u: "admin", r: "manager", s: DEMO, exp: Date.now() + 1e6 })).toString("base64url") + ".forgedsignature";
  assert.equal((await req("GET", `${API}/orders`, { cookie: forged })).status, 401);
});

test("existing staff can reach a login page from the home page", async () => {
  const home = await (await fetch(srv.base + "/")).text();
  assert.match(home, /href="\/login"/, "home page links to /login");
  assert.equal((await fetch(srv.base + "/login")).status, 200);
  assert.equal((await fetch(srv.base + "/login?r=" + DEMO)).status, 200);
});

test("guest surface stays public", async () => {
  assert.equal((await req("GET", `${API}/menu`)).status, 200);
  assert.equal((await req("GET", `${API}/tables`)).status, 200);
  assert.equal((await req("GET", `${API}/orders?table=5`)).status, 200);
  const order = await req("POST", `${API}/orders`, { body: { tableId: "5", idempotencyKey: "auth-test-" + Date.now(), items: [{ menuItemId: "fries", qty: 1 }] } });
  assert.equal(order.status, 201);
});
