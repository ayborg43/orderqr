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
// The QR carries the table's secret key, so only a signed-in manager of that restaurant can fetch it.
const encodes = async (query, expectedUrl, cookie = srv.cookie) => {
  const r = await fetch(`${base}/qr?${query}`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /image\/svg\+xml/);
  const svg = await r.text();
  assert.deepEqual(matrixFromSvg(svg), matrixFromText(expectedUrl));
};

before(async () => {
  srv = await startServer(PORT, { env: { PUBLIC_BASE_URL: "https://chopdesk.propertypadi.com" } });
});
after(() => srv?.stop());

test("table QR encodes the canonical production guest URL and the table's secret key", async () => {
  await encodes("r=test-restaurant&table=5", `https://chopdesk.propertypadi.com/r/test-restaurant/guest?table=5&k=${srv.keys["5"]}`);
  await encodes("r=test-restaurant&table=12", `https://chopdesk.propertypadi.com/r/test-restaurant/guest?table=12&k=${srv.keys["12"]}`);
});

test("QR codes are manager-only, and unknown restaurants or tables get none", async () => {
  assert.equal((await fetch(`${base}/qr?r=test-restaurant&table=5`)).status, 401, "anonymous visitors cannot read a table key");
  assert.equal((await fetch(`${base}/qr?table=5`, { headers: { Cookie: srv.cookie } })).status, 404);
  assert.equal((await fetch(`${base}/qr?r=test-restaurant&table=99`, { headers: { Cookie: srv.cookie } })).status, 404);
  assert.equal((await fetch(`${base}/qr?r=ghost-place&table=1`, { headers: { Cookie: srv.cookie } })).status, 404);
});

test("each restaurant's QR points at its own address and only its own manager can fetch it", async () => {
  const c = await fetch(`${base}/api/restaurants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Kano Kitchen", username: "kano", password: "long-enough-pass" }) });
  assert.equal(c.status, 201);
  const kano = (c.headers.get("set-cookie") || "").split(";")[0];
  const keys = Object.fromEntries((await (await fetch(`${base}/api/r/kano-kitchen/tables`, { headers: { Cookie: kano } })).json()).tables.map((t) => [t.id, t.key]));
  await encodes("r=kano-kitchen&table=3", `https://chopdesk.propertypadi.com/r/kano-kitchen/guest?table=3&k=${keys["3"]}`, kano);
  assert.equal((await fetch(`${base}/qr?r=kano-kitchen&table=3`, { headers: { Cookie: srv.cookie } })).status, 401, "another restaurant's manager cannot fetch it");
});
