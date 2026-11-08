import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEMO = "the-corner-table";

// Starts a throwaway server on its own temp data directory, so tests never touch
// data/store.json and every run starts from the same state.
export async function startServer(port, { env = {}, store } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "orderqr-test-"));
  if (store) writeFileSync(path.join(dir, "store.json"), JSON.stringify(store));
  const proc = spawn("node", ["server.js"], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env }, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${base}/api/r/${DEMO}/tables`)).ok; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  if (!up) { proc.kill(); throw new Error("server did not start"); }
  return { base, dir, stop: () => proc.kill() };
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
