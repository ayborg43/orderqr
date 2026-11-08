import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startServer, client, cookieOf, DEMO } from "./helpers.mjs";

let srv, req;
const signup = (body) => req("POST", "/api/restaurants", { body });
const A = { name: "Lagos Grill House", username: "ayo", password: "correct-horse-1", kitchenPassword: "kitchen-pass-1", tables: 4 };
const B = { name: "Abuja Suya Spot", username: "bola", password: "battery-staple-2", tables: 6, sampleMenu: false };
let ckA, ckB, ckKitchenA;
const card = { cardNumber: "4242 4242 4242 4242" };

before(async () => {
  srv = await startServer(3196);
  req = client(srv.base);
});
after(() => srv?.stop());

test("signup creates a restaurant with its own address, tables, menu and a manager session", async () => {
  const a = await signup(A);
  assert.equal(a.status, 201);
  assert.equal(a.body.slug, "lagos-grill-house");
  assert.equal(a.body.adminUrl, "/r/lagos-grill-house/admin");
  assert.match(a.cookie, /qr_staff_lagos-grill-house=/);
  ckA = cookieOf(a.cookie);
  assert.equal((await req("GET", "/api/r/lagos-grill-house/tables")).body.tables.length, 4);
  assert.ok((await req("GET", "/api/r/lagos-grill-house/menu")).body.items.length > 5, "sample menu");
  assert.equal((await req("GET", "/api/r/lagos-grill-house/", {})).body.name, "Lagos Grill House");
  assert.equal((await req("GET", "/api/r/lagos-grill-house/auth/me", { cookie: ckA })).body.role, "manager");

  const b = await signup(B);
  assert.equal(b.status, 201);
  ckB = cookieOf(b.cookie);
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/menu")).body.items.length, 0, "empty menu when sample is off");
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/tables")).body.tables.length, 6);
});

test("signup validates name, address, username and passwords", async () => {
  assert.equal((await signup({ ...A, name: "X" })).status, 400);
  assert.equal((await signup({ ...A, slug: "lagos-grill-house" })).status, 409, "address already taken");
  assert.equal((await signup({ ...A, name: "Another", slug: "admin" })).status, 400, "reserved address");
  assert.equal((await signup({ ...A, name: "Another", slug: "Bad Slug!" })).status, 400);
  assert.equal((await signup({ ...A, name: "Another", slug: "good-one", username: "a b" })).status, 400);
  assert.equal((await signup({ ...A, name: "Another", slug: "good-two", password: "short" })).status, 400);
  assert.equal((await req("GET", "/api/restaurants/check?slug=lagos-grill-house")).body.available, false);
  assert.equal((await req("GET", "/api/restaurants/check?slug=brand-new-place")).body.available, true);
});

test("passwords are stored hashed, never in plain text", () => {
  const raw = readFileSync(path.join(srv.dir, "store.json"), "utf8");
  assert.ok(!raw.includes(A.password) && !raw.includes(B.password) && !raw.includes(A.kitchenPassword));
  assert.match(raw, /scrypt\$/);
});

test("a manager session only works for its own restaurant", async () => {
  assert.equal((await req("GET", "/api/r/lagos-grill-house/orders", { cookie: ckA })).status, 200);
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/orders", { cookie: ckA })).status, 401, "A's cookie must not open B");
  assert.equal((await req("GET", `/api/r/${DEMO}/orders`, { cookie: ckA })).status, 401, "A's cookie must not open the demo");
  assert.equal((await req("GET", "/api/r/lagos-grill-house/orders", { cookie: ckB })).status, 401, "B's cookie must not open A");
  // Re-labelling a cookie for another restaurant fails: the slug is signed into the session.
  const relabelled = ckA.replace("qr_staff_lagos-grill-house", "qr_staff_abuja-suya-spot");
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/orders", { cookie: relabelled })).status, 401);
  // Credentials are per restaurant too.
  assert.equal((await req("POST", "/api/r/abuja-suya-spot/auth/login", { body: { username: "ayo", password: A.password } })).status, 401);
});

test("orders, tickets and assist requests stay inside their restaurant", async () => {
  const o = await req("POST", "/api/r/lagos-grill-house/orders", { body: { tableId: "2", idempotencyKey: "iso-1", payment: card, items: [{ menuItemId: "fries", qty: 2 }] } });
  assert.equal(o.status, 201);
  assert.equal(o.body.order.id, "ORD-1001", "order numbers start at 1001 per restaurant");
  assert.equal((await req("GET", "/api/r/lagos-grill-house/orders", { cookie: ckA })).body.orders.length, 1);
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/orders", { cookie: ckB })).body.orders.length, 0);
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/orders/ORD-1001")).status, 404, "B cannot read A's order");
  // The same idempotency key in another restaurant is a different order.
  const o2 = await req("POST", `/api/r/${DEMO}/orders`, { body: { tableId: "2", idempotencyKey: "iso-1", payment: card, items: [{ menuItemId: "fries", qty: 1 }] } });
  assert.equal(o2.status, 201); assert.notEqual(o2.body.duplicate, true);
  // Assist
  assert.equal((await req("POST", "/api/r/lagos-grill-house/assist", { body: { tableId: "1" } })).status, 201);
  assert.equal((await req("GET", "/api/r/lagos-grill-house/assist", { cookie: ckA })).body.requests.length, 1);
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/assist", { cookie: ckB })).body.requests.length, 0);
  // B's table ids come from B's own list.
  assert.equal((await req("POST", "/api/r/abuja-suya-spot/orders", { body: { tableId: "5", payment: card, items: [{ menuItemId: "fries", qty: 1 }] } })).status, 400, "B has no menu, so no item can be ordered");
});

test("managers edit their own menu, and other restaurants never see it", async () => {
  const add = await req("POST", "/api/r/abuja-suya-spot/menu", { cookie: ckB, body: { name: "Beef Suya", desc: "Spiced, grilled, with onions.", price: 3500, category: "Mains", station: "Grill", dietary: ["spicy"] } });
  assert.equal(add.status, 201);
  assert.equal(add.body.item.id, "beef-suya");
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/menu")).body.items.length, 1);
  assert.ok(!(await req("GET", "/api/r/lagos-grill-house/menu")).body.items.some((i) => i.id === "beef-suya"));
  // A guest can order B's dish at B only.
  assert.equal((await req("POST", "/api/r/abuja-suya-spot/orders", { body: { tableId: "5", payment: card, items: [{ menuItemId: "beef-suya", qty: 2 }] } })).status, 201);
  assert.equal((await req("POST", "/api/r/lagos-grill-house/orders", { body: { tableId: "1", payment: card, items: [{ menuItemId: "beef-suya", qty: 1 }] } })).status, 400);
  // Edit and delete
  assert.equal((await req("PATCH", "/api/r/abuja-suya-spot/menu/beef-suya", { cookie: ckB, body: { price: 4000, name: "Beef Suya (large)" } })).body.item.price, 4000);
  const dup = await req("POST", "/api/r/abuja-suya-spot/menu", { cookie: ckB, body: { name: "Beef Suya", price: 100, category: "Mains", station: "Grill" } });
  assert.equal(dup.body.item.id, "beef-suya-2", "ids stay unique inside a restaurant");
  assert.equal((await req("DELETE", "/api/r/abuja-suya-spot/menu/beef-suya-2", { cookie: ckB })).status, 200);
  assert.equal((await req("PATCH", "/api/r/lagos-grill-house/menu/fries", { cookie: ckB, body: { price: 1 } })).status, 401, "B cannot edit A's menu");
});

test("dish input is validated", async () => {
  const bad = (body) => req("POST", "/api/r/abuja-suya-spot/menu", { cookie: ckB, body });
  const ok = { name: "Jollof", price: 2500, category: "Mains", station: "Kitchen" };
  assert.equal((await bad({ ...ok, name: "" })).status, 400);
  assert.equal((await bad({ ...ok, price: -5 })).status, 400);
  assert.equal((await bad({ ...ok, price: "free" })).status, 400);
  assert.equal((await bad({ ...ok, station: "Moon" })).status, 400);
  assert.equal((await bad({ ...ok, category: "" })).status, 400);
  assert.equal((await bad(ok)).status, 201);
});

test("kitchen staff cannot manage the menu; a kitchen login is created when a password is given", async () => {
  const k = await req("POST", "/api/r/lagos-grill-house/auth/login", { body: { username: "kitchen", password: A.kitchenPassword } });
  assert.equal(k.status, 200); assert.equal(k.body.role, "kitchen");
  ckKitchenA = cookieOf(k.cookie);
  assert.equal((await req("GET", "/api/r/lagos-grill-house/orders", { cookie: ckKitchenA })).status, 200);
  assert.equal((await req("POST", "/api/r/lagos-grill-house/menu", { cookie: ckKitchenA, body: { name: "Z", price: 1, category: "Mains", station: "Grill" } })).status, 403);
  assert.equal((await req("POST", "/api/r/abuja-suya-spot/auth/login", { body: { username: "kitchen", password: A.kitchenPassword } })).status, 401, "B has no kitchen login");
});

test("tables can be added and removed by the manager", async () => {
  const add = await req("POST", "/api/r/abuja-suya-spot/tables", { cookie: ckB, body: {} });
  assert.equal(add.status, 201); assert.equal(add.body.table.id, "7");
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/tables")).body.tables.length, 7);
  assert.equal((await req("DELETE", "/api/r/abuja-suya-spot/tables/7", { cookie: ckB })).status, 200);
  assert.equal((await req("DELETE", "/api/r/abuja-suya-spot/tables/7", { cookie: ckB })).status, 404);
  assert.equal((await req("GET", "/api/r/lagos-grill-house/tables")).body.tables.length, 4, "A unaffected");
});

test("the restaurant name can be changed without touching other restaurants", async () => {
  const r = await req("PATCH", "/api/r/abuja-suya-spot/settings", { cookie: ckB, body: { restaurantName: "Abuja Suya & Grill" } });
  assert.equal(r.status, 200);
  assert.equal((await req("GET", "/api/r/abuja-suya-spot/")).body.name, "Abuja Suya & Grill");
  assert.equal((await req("GET", "/api/r/lagos-grill-house/")).body.name, "Lagos Grill House");
  assert.equal((await req("PATCH", "/api/r/abuja-suya-spot/settings", { cookie: ckB, body: { restaurantName: "x" } })).status, 400);
});

test("unknown restaurants return 404 and pages are routed per restaurant", async () => {
  assert.equal((await req("GET", "/api/r/nope/menu")).status, 404);
  for (const [p, status] of [["/r/lagos-grill-house", 200], ["/r/lagos-grill-house/guest", 200], ["/r/lagos-grill-house/kitchen", 200], ["/r/lagos-grill-house/admin", 200], ["/r/nope", 404], ["/r/nope/admin", 404], ["/signup", 200]]) {
    assert.equal((await fetch(srv.base + p)).status, status, p);
  }
  const old = await req("GET", "/guest?table=3");
  assert.equal(old.status, 302);
  assert.equal(old.location, `/r/${DEMO}/guest?table=3`);
});

test("signups are rate limited per address", async () => {
  // Two restaurants were created above; five per hour are allowed.
  for (let i = 0; i < 3; i++) assert.equal((await signup({ name: `Bulk Place ${i}`, username: "bulk", password: "bulk-password-1" })).status, 201);
  assert.equal((await signup({ name: "One Too Many", username: "bulk", password: "bulk-password-1" })).status, 429);
});

test("the platform starts with the demo restaurant and upgrades a single-restaurant store", async () => {
  const legacy = { tables: [{ id: "1", label: "Table 1" }], menu: [{ id: "tea", name: "Tea", desc: "", price: 5, category: "Drinks", station: "Drinks", dietary: [], available: true, modifierGroups: [] }],
    orders: [{ id: "ORD-1001", tableId: "1", tableLabel: "Table 1", items: [], subtotal: 5, surcharges: [], total: 5, status: "Received", payment: { state: "paid-demo", last4: "4242" }, createdAt: new Date().toISOString(), history: [] }],
    assistRequests: [], settings: { cardSurchargePct: 0, holidaySurchargePct: 10, holidayMode: false, restaurantName: "Old Name" }, seq: 1001 };
  const s2 = await startServer(3195, { store: legacy });
  try {
    const c2 = client(s2.base);
    const info = await c2("GET", `/api/r/${DEMO}/`);
    assert.equal(info.body.name, "Old Name"); assert.equal(info.body.demo, true);
    assert.equal((await c2("GET", `/api/r/${DEMO}/menu`)).body.items[0].id, "tea");
    const login = await c2("POST", `/api/r/${DEMO}/auth/login`, { body: { username: "admin", password: "admin123" } });
    assert.equal(login.status, 200);
    assert.equal((await c2("GET", `/api/r/${DEMO}/orders`, { cookie: cookieOf(login.cookie) })).body.orders.length, 1, "existing orders survive the upgrade");
  } finally { s2.stop(); }
});
