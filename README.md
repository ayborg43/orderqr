# QR Restaurant Ordering (MVP)

One-restaurant QR table ordering demo: guests scan a table code, order and pay
(demo payments), orders appear live on a kitchen display, staff manage it in admin.
See [SPEC.md](SPEC.md) for scope, flows and acceptance checks.

## Run

```bash
npm install   # optional: enables QR images for table cards (app works without it)
npm start     # http://localhost:3000
```

Open http://localhost:3000 in a browser and follow the demo script on the home page.

- Guest: `/guest?table=5` · Kitchen: `/kitchen` · Admin: `/admin`
- Demo cards: `4242 4242 4242 4242` approves, `4000 0000 0000 0002` declines. No real money moves.
- Data persists to `data/store.json` (delete it to re-seed the demo menu).

## Deploy on Vercel

Import the GitHub repo as-is (no build command, no framework preset). `public/`
is served statically, [vercel.json](vercel.json) maps `/guest`, `/kitchen`,
`/admin` to their pages, and `api/[...path].js` runs the same app logic as a
serverless function for all `/api/*` calls.

Demo limitation on Vercel: order data is kept in the function's `/tmp`
(best-effort, per instance), so orders can reset on a cold start. For real use,
move the store to a database (e.g. Vercel Postgres / Upstash) — or host the
long-lived server (`npm start`) on Render/Railway/Fly instead.

## Test

```bash
npm test
```
