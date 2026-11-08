import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, client, cookieOf, DEMO } from "./helpers.mjs";

const API = `/api/r/${DEMO}`;
let srv, req, staffCookie = "";
const post = (p, b) => req("POST", API + p, { body: b });
const patch = (p, b) => req("PATCH", API + p, { body: b, cookie: staffCookie });

before(async () => {
  srv = await startServer(3199);
  req = client(srv.base);
  // Staff sign-in (manager): availability and status changes require it.
  const login = await req("POST", `${API}/auth/login`, { body: { username: "admin", password: "admin123" } });
  if (login.status !== 200) throw new Error("staff login failed in test setup");
  staffCookie = cookieOf(login.cookie);
});
after(() => srv?.stop());

test("approved demo order is priced, surcharged and idempotent", async () => {
  const payload = { tableId: "5", idempotencyKey: "test-key-1", payment: { cardNumber: "4242 4242 4242 4242" },
    items: [{ menuItemId: "smash-burger", qty: 1, modifiers: ["medium", "cheese"], note: "no onion" }, { menuItemId: "fresh-lemonade", qty: 1, modifiers: ["regular"] }] };
  const first = await post("/orders", payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.order.tableId, "5");
  assert.equal(first.body.order.subtotal, 23); // (16.5+1.5) + 5
  assert.ok(first.body.order.total > first.body.order.subtotal, "card surcharge applied");
  assert.equal(first.body.order.items[0].note, "no onion");
  const dup = await post("/orders", payload);
  assert.equal(dup.body.order.id, first.body.order.id);
  assert.equal(dup.body.duplicate, true);
});

test("declined demo card creates no kitchen order", async () => {
  const r = await post("/orders", { tableId: "5", idempotencyKey: "test-key-2", payment: { cardNumber: "4000 0000 0000 0002" }, items: [{ menuItemId: "fries", qty: 1, modifiers: [] }] });
  assert.equal(r.status, 402);
  assert.equal(r.body.order.status, "PaymentFailed");
});

test("invalid table and missing required modifier are rejected", async () => {
  assert.equal((await post("/orders", { tableId: "999", payment: { cardNumber: "4242" }, items: [{ menuItemId: "fries", qty: 1 }] })).status, 400);
  assert.equal((await post("/orders", { tableId: "5", payment: { cardNumber: "424242424242" }, items: [{ menuItemId: "smash-burger", qty: 1, modifiers: [] }] })).status, 400);
});

test("malformed baskets are rejected with 400, not a server error", async () => {
  const pay = { cardNumber: "424242424242" };
  assert.equal((await post("/orders", { tableId: "5", payment: pay, items: [null] })).status, 400);
  assert.equal((await post("/orders", { tableId: "5", payment: pay, items: "fries" })).status, 400);
  assert.equal((await post("/orders/preview", { items: [42] })).status, 400);
});

test("a duplicated modifier id is only charged once", async () => {
  const r = await post("/orders/preview", { items: [{ menuItemId: "smash-burger", qty: 1, modifiers: ["medium", "cheese", "cheese", "cheese"] }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.subtotal, 18); // 16.5 + one extra cheese (1.5)
});

test("sold-out item is rejected at submit and status can advance", async () => {
  await patch("/menu/fries/availability", { available: false });
  const r = await post("/orders", { tableId: "5", payment: { cardNumber: "424242424242" }, items: [{ menuItemId: "fries", qty: 1 }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /Sold out/);
  await patch("/menu/fries/availability", { available: true });
  const ok = await post("/orders", { tableId: "6", idempotencyKey: "test-key-3", payment: { cardNumber: "424242424242" }, items: [{ menuItemId: "fries", qty: 1 }] });
  const adv = await patch(`/orders/${ok.body.order.id}`, { status: "Preparing" });
  assert.equal(adv.body.order.status, "Preparing");
});

test("settings reject out-of-range percentages", async () => {
  assert.equal((await patch("/settings", { cardSurchargePct: -90 })).status, 400);
  assert.equal((await patch("/settings", { holidaySurchargePct: 100000 })).status, 400);
  assert.equal((await patch("/settings", { cardSurchargePct: 2.5 })).status, 200);
  assert.equal((await patch("/settings", { cardSurchargePct: 1.5 })).status, 200);
});

test("a malformed Host header does not crash the server", async () => {
  const net = await import("node:net");
  await new Promise((resolve) => {
    const s = net.connect(3199, "localhost", () => s.write("GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n"));
    s.on("data", () => {}); s.on("close", resolve); s.on("error", resolve);
  });
  assert.equal((await req("GET", `${API}/tables`)).status, 200);
});
