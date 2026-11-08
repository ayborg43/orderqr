import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import QRCode from "qrcode";

const PORT = 3197;
const base = `http://localhost:${PORT}`;
let proc;

// Rebuild the module matrix from the SVG our /qr endpoint returns.
function matrixFromSvg(svg) {
  const size = Number(svg.match(/viewBox="0 0 (\d+) /)[1]);
  const path = svg.match(/<path stroke="#000000" d="([^"]+)"/)[1];
  const grid = Array.from({ length: size }, () => Array(size).fill(0));
  const re = /M(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)h(\d+)|m(\d+(?:\.\d+)?) 0h(\d+)/g;
  let x = 0, y = 0, m;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) { x = Number(m[1]); y = Math.floor(Number(m[2])); }
    else x += Number(m[4]);
    const len = Number(m[3] ?? m[5]);
    for (let i = 0; i < len; i++) grid[y][x + i] = 1;
    x += len;
  }
  return grid;
}
function matrixFromText(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const s = qr.modules.size, size = s + 2;
  const grid = Array.from({ length: size }, () => Array(size).fill(0));
  for (let r = 0; r < s; r++) for (let c = 0; c < s; c++) grid[r + 1][c + 1] = qr.modules.data[r * s + c] ? 1 : 0;
  return grid;
}
const encodes = async (table, expectedUrl) => {
  const r = await fetch(`${base}/qr?table=${table}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /image\/svg\+xml/);
  const svg = await r.text();
  assert.deepEqual(matrixFromSvg(svg), matrixFromText(expectedUrl));
};

before(async () => {
  proc = spawn("node", ["server.js"], { env: { ...process.env, PORT: String(PORT), PUBLIC_BASE_URL: "https://orderqr-omega.vercel.app" }, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(base + "/api/tables"); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error("server did not start");
});
after(() => proc?.kill());

test("table QR encodes the canonical production guest URL (https, not request host)", async () => {
  await encodes("5", "https://orderqr-omega.vercel.app/guest?table=5");
  await encodes("12", "https://orderqr-omega.vercel.app/guest?table=12");
});
