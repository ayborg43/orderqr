import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, client, DEMO } from "./helpers.mjs";

// Runs only when a throwaway Postgres is provided, e.g.:
//   TEST_DATABASE_URL=postgres://orderqr:orderqr@localhost:5433/orderqr_test npm test
const DB = process.env.TEST_DATABASE_URL;

test("orders persist in Postgres and survive a restart on the same DB", { skip: !DB && "TEST_DATABASE_URL not set" }, async () => {
  const s1 = await startServer(3221, { env: { DATABASE_URL: DB } });
  try {
    const api = client(s1.base);
    const placed = await api("POST", `/api/r/${DEMO}/orders`, {
      body: { tableId: "5", idempotencyKey: "db-test-1", items: [{ menuItemId: "fries", qty: 1, modifiers: [] }], payment: { cardNumber: "4242 4242 4242 4242" } },
    });
    assert.equal(placed.status, 201);
  } finally { s1.stop(); }

  // Fresh process, same database, different data dir: data must come from Postgres.
  const s2 = await startServer(3222, { env: { DATABASE_URL: DB } });
  try {
    const api = client(s2.base);
    const list = await api("GET", `/api/r/${DEMO}/orders?table=5`);
    assert.equal(list.body.orders.length, 1);
    assert.equal(list.body.orders[0].id, "ORD-1001");
  } finally { s2.stop(); }
});
