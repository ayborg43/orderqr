import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, client, cookieOf, REST } from "./helpers.mjs";

let srv, req, saCookie;
const SA = { username: "owner", password: "super-secret-1" };

before(async () => {
  srv = await startServer(3188, { env: { SUPERADMIN_USER: SA.username, SUPERADMIN_PASSWORD: SA.password, SESSION_SECRET: "test-secret" } });
  req = client(srv.base);
});
after(() => srv?.stop());

test("super admin login is separate and rejects wrong credentials", async () => {
  assert.equal((await req("POST", "/api/superadmin/auth/login", { body: { username: SA.username, password: "wrong" } })).status, 401);
  const ok = await req("POST", "/api/superadmin/auth/login", { body: SA });
  assert.equal(ok.status, 200);
  assert.match(ok.cookie, /qr_superadmin=/);
  saCookie = cookieOf(ok.cookie);
  assert.equal((await req("GET", "/api/superadmin/auth/me", { cookie: saCookie })).body.role, "superadmin");
});

test("restaurant staff sessions never open the super admin, and vice versa", async () => {
  const staff = await req("POST", `/api/r/${REST}/auth/login`, { body: { username: "admin", password: "admin123" } });
  const staffCookie = cookieOf(staff.cookie);
  assert.equal((await req("GET", "/api/superadmin/overview", { cookie: staffCookie })).status, 401);
  assert.equal((await req("GET", "/api/superadmin/overview")).status, 401);
  assert.equal((await req("GET", `/api/r/${REST}/orders`, { cookie: saCookie })).status, 401, "super admin cookie is not a restaurant session");
});

test("overview sees every restaurant with order and collection totals", async () => {
  await req("POST", `/api/r/${REST}/orders`, { body: { tableId: "3", idempotencyKey: "sa-1", items: [{ menuItemId: "fries", qty: 1 }] } });
  const ov = await req("GET", "/api/superadmin/overview", { cookie: saCookie });
  assert.equal(ov.status, 200);
  const rest = ov.body.restaurants.find((r) => r.slug === REST);
  assert.ok(rest, "test restaurant listed");
  assert.equal(rest.orders, 1);
  assert.equal(rest.awaitingCollection, 1);
  assert.equal(ov.body.totals.restaurants, ov.body.restaurants.length);
});

test("super admin can confirm collection and reset a staff password", async () => {
  const orders = await req("GET", `/api/r/${REST}/orders?table=3`);
  const id = orders.body.orders[0].id;
  const confirmed = await req("POST", `/api/superadmin/restaurants/${REST}/orders/${id}/confirm-payment`, { cookie: saCookie });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.order.payment.state, "paid");

  const reset = await req("POST", `/api/superadmin/restaurants/${REST}/staff/admin/reset-password`, { cookie: saCookie, body: { password: "brand-new-pass-1" } });
  assert.equal(reset.status, 200);
  assert.equal((await req("POST", `/api/r/${REST}/auth/login`, { body: { username: "admin", password: "admin123" } })).status, 401, "old password dead");
  assert.equal((await req("POST", `/api/r/${REST}/auth/login`, { body: { username: "admin", password: "brand-new-pass-1" } })).status, 200, "new password works");
  assert.equal((await req("POST", `/api/superadmin/restaurants/${REST}/staff/admin/reset-password`, { cookie: saCookie, body: { password: "short" } })).status, 400);
  assert.equal((await req("POST", `/api/superadmin/restaurants/${REST}/staff/ghost/reset-password`, { cookie: saCookie, body: { password: "long-enough-1" } })).status, 404);
});

test("super admin can delete a restaurant and it is gone everywhere", async () => {
  const made = await req("POST", "/api/restaurants", { body: { name: "Doomed Diner", username: "doom", password: "doomed-pass-1", tables: 2 } });
  assert.equal(made.status, 201);
  // Wrong confirmation slug refuses.
  assert.equal((await req("DELETE", "/api/superadmin/restaurants/doomed-diner", { cookie: saCookie, body: { confirm: "nope" } })).status, 400);
  assert.equal((await req("DELETE", "/api/superadmin/restaurants/doomed-diner", { cookie: saCookie, body: { confirm: "doomed-diner" } })).status, 200);
  assert.equal((await req("GET", "/api/r/doomed-diner/")).status, 404);
  const ov = await req("GET", "/api/superadmin/overview", { cookie: saCookie });
  assert.ok(!ov.body.restaurants.some((r) => r.slug === "doomed-diner"));
});

test("the super admin page is served at /superadmin", async () => {
  assert.equal((await fetch(srv.base + "/superadmin")).status, 200);
});
