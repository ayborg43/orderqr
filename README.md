# Chopdesk: multi-restaurant QR ordering

Any number of restaurants can use the platform. Each restaurant signs up, gets its
own address (`/r/<name>`), menu, tables, QR codes and staff logins, and runs its own
kitchen display and admin dashboard. Guests scan a table code, place an order, a waiter collects
payment in person, and orders appear live on that restaurant's kitchen display.
See [SPEC.md](SPEC.md) for scope, flows and acceptance checks.

## Run

```bash
npm install   # optional: enables QR images for table cards (app works without it)
npm start     # http://localhost:3000
```

Open http://localhost:3000 and **create a restaurant** (`/signup`). The platform
starts empty — there is no demo restaurant and there are no default logins.

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
- **Super admin.** Set `SUPERADMIN_USER` / `SUPERADMIN_PASSWORD` and open `/superadmin`:
  one platform login (its own cookie, never a restaurant session) that sees every
  restaurant, order and collected total, confirms collections, resets any staff
  password, and deletes restaurants (type-the-address confirmation). Unset = disabled.
- **No default accounts.** Every login is created at signup for that restaurant only.
  The pre-launch demo tenant (`the-corner-table`) is deleted automatically on boot.
- **Payments.** There is no payment in the app: a waiter collects the money in
  person, any staff member confirms collection in admin or the kitchen display,
  and only then can the guest open that order's invoice and receipt (printable
  pages, saveable as PDF) from their order on the guest page.
- **Service charge.** Optional and **0% by default** (it was a silent 1.5% "card
  surcharge" before, though the app takes no card payments; restaurants still on exactly
  that old default are reset to 0 once on boot). Managers can set it in admin, and it is
  itemised as "Service charge" on the guest basket and bills.
- **Table QR codes are secret.** Each table has its own key, printed inside its QR code
  (`/r/<slug>/guest?table=5&k=KEY`). Guests need it to order, call staff, watch their
  order or see their bill, so someone who only knows a restaurant and a table number
  cannot. Only a signed-in manager can fetch the QR images (`/qr`), because they carry
  the key. A manager can issue a new code per table ("New QR": the printed card stops
  working) or "Clear table" (the next diner starts with an empty order list and bill).
  Tables created before keys existed have none and keep working until a manager clicks
  "Secure QR" on them and reprints the card.
- **A table's visit.** Guests only see the orders of the table's current visit, which
  ends when the table is cleared, sits idle for 2 hours, or passes 12 hours. A guest
  never sees a previous diner's orders or bill. Invoice and receipt links carry the
  order's own private token, and order lookup by number is staff-only.
- **Abuse limits** on the public endpoints: 6 orders per table per 10 minutes, 30 per
  address per hour, 15 unfinished orders per table, 40 lines / 200 portions per order,
  one open staff call per table. Sign-ups default to 5 per address per hour
  (`SIGNUP_PER_HOUR`).
- **Sessions** are bound to the account they were issued for: resetting a password,
  or deleting and re-registering an address, ends every old session. (Sessions issued
  before this change stop working once, so staff sign in again after the upgrade.)
- In production (`NODE_ENV=production`) the server refuses to start without
  `SESSION_SECRET` and `PUBLIC_BASE_URL`.
- Data persists to Postgres when `DATABASE_URL` is set, otherwise to
  `data/store.json` (override the folder with `DATA_DIR`). A store from the
  single-restaurant version is upgraded in place under its own name.
- **Staff order lists are paged.** The kitchen loads only unfinished orders; admin loads
  unfinished orders plus the last 24 hours and has a "Load older orders" button.

## Deploy on Dokploy (recommended)

The app ships a [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml). Data lives in **Postgres** (a small JSONB row per restaurant for settings, menu, tables and staff, plus **one row per order**, so a new order is a single tiny write however much history exists): the compose file runs a `db` service on the `orderqr-db-data` volume, the app connects via `DATABASE_URL`, and `GET /health` backs the container healthcheck. On first boot an empty database imports the legacy `data/store.json` once (from the kept `orderqr-data` volume); after that Postgres is the source of truth. Without `DATABASE_URL` (local dev, tests, Vercel) the app falls back to the JSON file store. An older database that kept orders inside the restaurant row is upgraded automatically on boot.

**Run one instance.** The app keeps its data in memory and writes changes through, so it holds a Postgres advisory lock: a second instance on the same database waits (and does not serve) until the first stops, instead of overwriting its data. A rolling deploy therefore hands over cleanly. If the database connection drops, the app exits and Docker's `restart: unless-stopped` brings it back once Postgres is up; a write that fails is answered with a 503 (never reported as success), kept, and retried every few seconds, and `/health` returns 503 while the database is unreachable. On `docker stop` / redeploy the app finishes pending writes, releases the lock and exits in under a second.

**Backups (required before real restaurants use it).** Nothing backs the database up by default. In Dokploy enable scheduled backups for the Postgres service (or schedule `pg_dump -Fc` from the host to storage off the server), and test a restore once. The `orderqr-db-data` volume is the only copy of the data.

**Option A — Compose (full setup):** in Dokploy create a **Compose** service from this repo (`docker-compose.yml`), then under **Domains** add your domain for service `app`, port `3000`, HTTPS on. Set the variables from [.env.example](.env.example) in the **Environment** tab — `SESSION_SECRET` and `POSTGRES_PASSWORD` are required (letters/numbers only for the latter; it is embedded in `DATABASE_URL`), and `PUBLIC_BASE_URL` must be `https://chopdesk.propertypadi.com` before printing QR codes. Deploy; check `https://chopdesk.propertypadi.com/health` returns `{"status":"ok"}`.

**Option B — Application/Dockerfile:** create an **Application**, build type **Dockerfile**, container port `3000`, same env vars plus `DATABASE_URL` pointing at a Postgres you provision (e.g. a Dokploy database service), and mount a volume at `/app/data` if you want the one-time `store.json` import.

`TRUST_PROXY=1` is set by the image/compose so login/signup throttling sees real guest IPs behind Traefik, not the proxy's. Local check without Dokploy: `docker compose up -d --build` then add a temporary `ports: ["3000:3000"]` mapping (omitted by default — Dokploy itself uses host :3000 and routes via Traefik).

## Deploy on Vercel

Set `PUBLIC_BASE_URL=https://chopdesk.propertypadi.com` in the Vercel project so table QR codes always encode that production guest URL (the code falls back to the production domain on Vercel, and to the request origin for local/LAN demos).

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
