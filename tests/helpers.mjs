import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The platform starts empty (no seeded restaurant), so each test server gets
// a restaurant through the real signup flow: sample menu, 12 tables, and the
// manager/kitchen logins the suites use.
export const REST = "test-restaurant";
export const DEMO = REST; // legacy alias used across the suites

export async function startServer(port, { env = {}, store } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "orderqr-test-"));
  if (store) writeFileSync(path.join(dir, "store.json"), JSON.stringify(store));
  const proc = spawn("node", ["server.js"], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env }, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  if (!up) { proc.kill(); throw new Error("server did not start"); }
  // 201 on first boot; 409 when a restart on the same DB already has it.
  await fetch(`${base}/api/restaurants`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Restaurant", slug: REST, username: "admin", password: "admin123", kitchenPassword: "kitchen123", tables: 12, sampleMenu: true }),
  });
  // Every table has a secret key (printed in its QR code). Guests must present it, so the suites fetch the keys as the manager.
  const login = await fetch(`${base}/api/r/${REST}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const tables = (await (await fetch(`${base}/api/r/${REST}/tables`, { headers: { Cookie: cookie } })).json().catch(() => ({}))).tables || [];
  const keys = Object.fromEntries(tables.map((t) => [t.id, t.key]));
  return {
    base, dir, stop: () => proc.kill(), cookie, keys,
    k: (id) => ({ tableId: String(id), k: keys[String(id)] }),            // body fields for a guest at that table
    q: (id) => `table=${id}${keys[String(id)] ? `&k=${keys[String(id)]}` : ""}`, // query string for the same
  };
}

export function client(base) {
  return async (method, p, { body, cookie } = {}) => {
    const r = await fetch(base + p, {
      method, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get("set-cookie") || "", location: r.headers.get("location") || "" };
  };
}
export const cookieOf = (setCookie) => setCookie.split(";")[0];
