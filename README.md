# OrderQR: multi-restaurant QR ordering

Any number of restaurants can use the platform. Each restaurant signs up, gets its
own address (`/r/<name>`), menu, tables, QR codes and staff logins, and runs its own
kitchen display and admin dashboard. Guests scan a table code, order and pay (demo
payments), and orders appear live on that restaurant's kitchen display.
See [SPEC.md](SPEC.md) for scope, flows and acceptance checks.

## Run

```bash
npm install   # optional: enables QR images for table cards (app works without it)
npm start     # http://localhost:3000
```

Open http://localhost:3000 and either **create a restaurant** (`/signup`) or try the
built-in demo restaurant, **The Corner Table**.

| Surface | URL |
|---|---|
| Platform home | `/` |
| Create a restaurant | `/signup` |
| Restaurant overview | `/r/<slug>` |
| Guest ordering | `/r/<slug>/guest?table=5` |
| Kitchen display | `/r/<slug>/kitchen` |
| Admin dashboard | `/r/<slug>/admin` |

- **Tenancy.** Menu, tables, orders, settings, assistance requests and staff accounts
  all belong to one restaurant. A staff session is signed for one restaurant only, so
  signing in to one never opens another. Order numbers start at `ORD-1001` per restaurant.
- **Signing up.** Choose a name, address, manager username and password (8+ characters),
  the number of tables, and optionally a kitchen-screen password. Passwords are stored
  as salted scrypt hashes. Managers edit the menu (add, edit, remove dishes, mark sold
  out), add or remove tables, rename the restaurant and set surcharges. Kitchen staff
  run orders and assistance requests. A manager can also open the kitchen screen.
- **Demo restaurant.** `/r/the-corner-table` always exists. Its logins are manager
  `admin / admin123` and kitchen `kitchen / kitchen123`; override them with
  `MANAGER_USER` / `MANAGER_PASSWORD` and `KITCHEN_USER` / `KITCHEN_PASSWORD`.
- **Old links.** `/guest`, `/kitchen` and `/admin` redirect to the demo restaurant, so
  printed QR codes from the single-restaurant version keep working.
- Set a strong `SESSION_SECRET` in production. Without it, production generates a random
  secret at boot (sessions then end on every restart and don't span instances).
- Demo cards: `4242 4242 4242 4242` approves, `4000 0000 0000 0002` declines. No real money moves.
- Data persists to `data/store.json` (override the folder with `DATA_DIR`). A store
  from the single-restaurant version is upgraded in place: it becomes the demo restaurant.

## Deploy on Dokploy (recommended)

The app ships a [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml); data survives redeploys on the `orderqr-data` volume, and `GET /health` backs the container healthcheck.

**Option A — Compose (full setup):** in Dokploy create a **Compose** service from this repo (`docker-compose.yml`), then under **Domains** add your domain for service `app`, port `3000`, HTTPS on. Set the variables from [.env.example](.env.example) in the **Environment** tab — `SESSION_SECRET` is required (generate a long random value) and `PUBLIC_BASE_URL` must be your `https://…` domain before printing QR codes. Deploy; check `https://<domain>/health` returns `{"status":"ok"}`.

**Option B — Application/Dockerfile:** create an **Application**, build type **Dockerfile**, container port `3000`, same env vars, and mount a volume at `/app/data` (Dokploy → Advanced → Volumes) so `store.json` persists.

`TRUST_PROXY=1` is set by the image/compose so login/signup throttling sees real guest IPs behind Traefik, not the proxy's. Change the demo logins (`MANAGER_PASSWORD` / `KITCHEN_PASSWORD`) before going live. Local check without Dokploy: `docker compose up -d --build` → http://localhost:3000.

## Deploy on Vercel

Set `PUBLIC_BASE_URL=https://orderqr-omega.vercel.app` in the Vercel project so table QR codes always encode that production guest URL (the code falls back to the production domain on Vercel, and to the request origin for local/LAN demos).

Import the GitHub repo as-is (no build command, no framework preset). `public/`
is served statically, [vercel.json](vercel.json) maps the `/r/<slug>/...` pages and
`/signup`, and `api/[...path].js` runs the same app logic as a serverless function for
all `/api/*` calls.

**Not ready for real restaurants on Vercel yet.** Data is kept in the function's `/tmp`
(best-effort, per instance), so restaurants, menus and orders can disappear on a cold
start, and live updates are not shared between instances. Before real restaurants rely
on it, move the store to a database (e.g. Vercel Postgres / Upstash) or host the
long-lived server (`npm start`) on Render/Railway/Fly with a persistent disk.

## Test

```bash
npm test
```

Tests start their own server on a temporary data folder, so they never touch
`data/store.json` and can be run repeatedly.
