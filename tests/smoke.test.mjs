import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3199;
const base = `http://localhost:${PORT}`;
let proc;
const j = async (r) => ({ status: r.status, body: await r.json() });
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(j);
let staffCookie = "";
const patch = (p, b) => fetch(base + p, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: staffCookie }, body: JSON.stringify(b) }).then(j);

before(async () => {
  proc = spawn("node", ["server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(base + "/api/tables"); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  // Staff sign-in (manager) — availability and status changes now require it.
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
  if (!login.ok) throw new Error("staff login failed in test setup");
  staffCookie = (login.headers.get("set-cookie") || "").split(";")[0];
});
after(() => proc?.kill());

test("approved demo order is priced, surcharged and idempotent", async () => {
  const payload = { tableId: "5", idempotencyKey: "test-key-1", payment: { cardNumber: "4242 4242 4242 4242" },
    items: [{ menuItemId: "smash-burger", qty: 1, modifiers: ["medium", "cheese"], note: "no onion" }, { menuItemId: "fresh-lemonade", qty: 1, modifiers: ["regular"] }] };
  const first = await post("/api/orders", payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.order.tableId, "5");
  assert.equal(first.body.order.subtotal, 23); // (16.5+1.5) + 5
  assert.ok(first.body.order.total > first.body.order.subtotal, "card surcharge applied");
  assert.equal(first.body.order.items[0].note, "no onion");
  const dup = await post("/api/orders", payload);
  assert.equal(dup.body.order.id, first.body.order.id);
  assert.equal(dup.body.duplicate, true);
});

test("declined demo card creates no kitchen order", async () => {
  const r = await post("/api/orders", { tableId: "5", idempotencyKey: "test-key-2", payment: { cardNumber: "4000 0000 0000 0002" }, items: [{ menuItemId: "fries", qty: 1, modifiers: [] }] });
  assert.equal(r.status, 402);
  assert.equal(r.body.order.status, "PaymentFailed");
});

test("invalid table and missing required modifier are rejected", async () => {
  assert.equal((await post("/api/orders", { tableId: "999", payment: { cardNumber: "4242" }, items: [{ menuItemId: "fries", qty: 1 }] })).status, 400);
  assert.equal((await post("/api/orders", { tableId: "5", payment: { cardNumber: "424242424242" }, items: [{ menuItemId: "smash-burger", qty: 1, modifiers: [] }] })).status, 400);
});

test("sold-out item is rejected at submit and status can advance", async () => {
  await patch("/api/menu/fries/availability", { available: false });
  const r = await post("/api/orders", { tableId: "5", payment: { cardNumber: "424242424242" }, items: [{ menuItemId: "fries", qty: 1 }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /Sold out/);
  await patch("/api/menu/fries/availability", { available: true });
  const ok = await post("/api/orders", { tableId: "6", idempotencyKey: "test-key-3", payment: { cardNumber: "424242424242" }, items: [{ menuItemId: "fries", qty: 1 }] });
  const adv = await patch(`/api/orders/${ok.body.order.id}`, { status: "Preparing" });
  assert.equal(adv.body.order.status, "Preparing");
});
