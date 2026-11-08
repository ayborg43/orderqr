import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { startServer } from "./helpers.mjs";

const PORT = 3197;
const base = `http://localhost:${PORT}`;
let srv;

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
  const r = await fetch(`${base}/qr?${table}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /image\/svg\+xml/);
  const svg = await r.text();
  assert.deepEqual(matrixFromSvg(svg), matrixFromText(expectedUrl));
};

before(async () => {
  srv = await startServer(PORT, { env: { PUBLIC_BASE_URL: "https://orderqr-omega.vercel.app" } });
});
after(() => srv?.stop());

test("table QR encodes the canonical production guest URL (https, not request host)", async () => {
  await encodes("r=the-corner-table&table=5", "https://orderqr-omega.vercel.app/r/the-corner-table/guest?table=5");
  await encodes("r=the-corner-table&table=12", "https://orderqr-omega.vercel.app/r/the-corner-table/guest?table=12");
});

test("a QR without a restaurant falls back to the demo restaurant", async () => {
  await encodes("table=5", "https://orderqr-omega.vercel.app/r/the-corner-table/guest?table=5");
});

test("each restaurant's QR points at its own address; unknown restaurants get none", async () => {
  const c = await fetch(`${base}/api/restaurants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Kano Kitchen", username: "kano", password: "long-enough-pass" }) });
  assert.equal(c.status, 201);
  await encodes("r=kano-kitchen&table=3", "https://orderqr-omega.vercel.app/r/kano-kitchen/guest?table=3");
  assert.equal((await fetch(`${base}/qr?r=ghost-place&table=1`)).status, 404);
});
