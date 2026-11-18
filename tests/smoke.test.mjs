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

test("an order is priced, surcharged, marked awaiting-collection and idempotent", async () => {
  const payload = { tableId: "5", idempotencyKey: "test-key-1",
    items: [{ menuItemId: "smash-burger", qty: 1, modifiers: ["medium", "cheese"], note: "no onion" }, { menuItemId: "fresh-lemonade", qty: 1, modifiers: ["regular"] }] };
  const first = await post("/orders", payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.order.tableId, "5");
  assert.equal(first.body.order.subtotal, 23); // (16.5+1.5) + 5
  assert.ok(first.body.order.total > first.body.order.subtotal, "surcharge applied");
  assert.equal(first.body.order.payment.state, "awaiting-collection");
  assert.equal(first.body.order.status, "Received");
  assert.equal(first.body.order.items[0].note, "no onion");
  const dup = await post("/orders", payload);
  assert.equal(dup.body.order.id, first.body.order.id);
  assert.equal(dup.body.duplicate, true);
});

test("card details are ignored: orders never take payment online", async () => {
  const r = await post("/orders", { tableId: "5", idempotencyKey: "test-key-2", payment: { cardNumber: "4000 0000 0000 0002" }, items: [{ menuItemId: "fries", qty: 1, modifiers: [] }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.order.payment.state, "awaiting-collection");
});

test("invalid table and missing required modifier are rejected", async () => {
  assert.equal((await post("/orders", { tableId: "999", items: [{ menuItemId: "fries", qty: 1 }] })).status, 400);
  assert.equal((await post("/orders", { tableId: "5", items: [{ menuItemId: "smash-burger", qty: 1, modifiers: [] }] })).status, 400);
});

test("malformed baskets are rejected with 400, not a server error", async () => {
  assert.equal((await post("/orders", { tableId: "5", items: [null] })).status, 400);
  assert.equal((await post("/orders", { tableId: "5", items: "fries" })).status, 400);
  assert.equal((await post("/orders/preview", { items: [42] })).status, 400);
});

test("a duplicated modifier id is only charged once", async () => {
  const r = await post("/orders/preview", { items: [{ menuItemId: "smash-burger", qty: 1, modifiers: ["medium", "cheese", "cheese", "cheese"] }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.subtotal, 18); // 16.5 + one extra cheese (1.5)
});

test("sold-out item is rejected at submit and status can advance", async () => {
  await patch("/menu/fries/availability", { available: false });
  const r = await post("/orders", { tableId: "5", items: [{ menuItemId: "fries", qty: 1 }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /Sold out/);
  await patch("/menu/fries/availability", { available: true });
  const ok = await post("/orders", { tableId: "6", idempotencyKey: "test-key-3", items: [{ menuItemId: "fries", qty: 1 }] });
  const adv = await patch(`/orders/${ok.body.order.id}`, { status: "Preparing" });
  assert.equal(adv.body.order.status, "Preparing");
});

test("waiter-collected payment unlocks guest invoice and receipt", async () => {
  const placed = await post("/orders", { tableId: "7", idempotencyKey: "pay-flow-1", items: [{ menuItemId: "fries", qty: 2 }] });
  assert.equal(placed.status, 201);
  const id = placed.body.order.id;
  assert.equal(placed.body.order.payment.state, "awaiting-collection");
  // No documents before the waiter collects and staff confirm.
  for (const doc of ["invoice", "receipt"]) {
    const r = await fetch(`${srv.base}${API}/orders/${id}/${doc}?table=7`);
    assert.equal(r.status, 403, doc + " locked before payment");
  }
  // Guests cannot confirm their own payment; staff can.
  assert.equal((await post(`/orders/${id}/confirm-payment`, {})).status, 401);
  const confirmed = await req("POST", `${API}/orders/${id}/confirm-payment`, { cookie: staffCookie });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.order.payment.state, "paid");
  assert.ok(confirmed.body.order.payment.confirmedAt);
  // Both documents now open for that table, and only that table.
  for (const doc of ["invoice", "receipt"]) {
    const r = await fetch(`${srv.base}${API}/orders/${id}/${doc}?table=7`);
    assert.equal(r.status, 200, doc);
    const html = await r.text();
    assert.match(html, new RegExp(doc.toUpperCase()));
    assert.match(html, /Hand-Cut Fries/);
    assert.match(html, /PAID|Paid/);
    assert.equal((await fetch(`${srv.base}${API}/orders/${id}/${doc}?table=9`)).status, 403, doc + " wrong table");
  }
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

test("guests get a live push when staff change their table's order status", async () => {
  const placed = await post("/orders", { tableId: "7", idempotencyKey: "live-1", items: [{ menuItemId: "fries", qty: 1 }] });
  assert.equal(placed.status, 201);
  const id = placed.body.order.id;
  const ac = new AbortController();
  const res = await fetch(`${srv.base}${API}/table-events?table=7`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  const until = async (re) => { const t = Date.now(); while (!re.test(buf)) { if (Date.now() - t > 4000) throw new Error("no event: " + re + " in " + JSON.stringify(buf)); const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
  try {
    await until(/event: ready/);
    await patch(`/orders/${id}`, { status: "Preparing" });
    await until(new RegExp(`"id":"${id}","status":"Preparing"`));
    // Another table's changes are not delivered here.
    const other = await post("/orders", { tableId: "8", idempotencyKey: "live-2", items: [{ menuItemId: "fries", qty: 1 }] });
    buf = ""; await patch(`/orders/${other.body.order.id}`, { status: "Ready" });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!buf.includes(other.body.order.id), "table 7 must not see table 8's orders");
  } finally { ac.abort(); }
});

test("the live feed rejects unknown tables and API responses are never cached", async () => {
  assert.equal((await fetch(`${srv.base}${API}/table-events?table=999`)).status, 400);
  assert.equal((await fetch(`${srv.base}${API}/menu`)).headers.get("cache-control"), "no-store");
});
