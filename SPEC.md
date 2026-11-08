# OrderQR: Spec & Plan (MVP)

## 1. Scope (agreed)

- **Multiple restaurants** on one platform (multi-tenant), each a single location, dine-in only for v1.
  Every restaurant has its own address, menu, tables, orders, settings and staff logins (see §4a).
- **Demo payment only** — no real gateway, no real money. Demo cards simulate approve/decline.
- References: Nomni QR ordering (guest experience) + LynnC table-to-kitchen guide (operations).

Out of scope for v1: real payments (Stripe etc.), third-party POS, kitchen printers,
multi-branch, loyalty, delivery/takeaway, native apps. Each is a later phase (§7).

## 2. Users & surfaces

| Surface | User | URL |
|---|---|---|
| Guest ordering | Diner (phone, no download/login) | `/r/<slug>/guest?table=5` |
| Kitchen display (KDS) | Kitchen staff (tablet/monitor) | `/r/<slug>/kitchen` |
| Admin dashboard | Manager / front-of-house | `/r/<slug>/admin` |
| Restaurant overview | Anyone | `/r/<slug>` |
| Sign-up | Restaurant owner | `/signup` |
| Landing | Anyone | `/` explains the platform, links to sign-up and the demo restaurant |

## 3. Core flow

```
Table QR scan → menu (branch menu) → item + modifiers → basket review
→ re-validate availability → demo payment → order confirmed (order no.)
→ kitchen stations (KDS) → status updates → guest sees progress → served
→ guest may order again on same table session → bill view (orders total)
```

## 4. Functional requirements (MVP)

### Guest
- G1. QR/link resolves to a **table**; invalid table shows a clear error, never an untied order.
- G2. Menu grouped by category, with search and dietary filters (vegan, vegetarian, gluten-free, spicy).
- G3. Each item: name, description, price, availability. Sold-out items visible but not orderable.
- G4. Modifiers per item: required groups (e.g. size, cooking preference) must be chosen;
  optional extras add price; per-item kitchen note. Selections stay attached to that item.
- G5. Basket shows quantities, modifiers, line totals, subtotal, surcharges, total.
- G6. On submit, availability is **re-checked server-side**; a newly sold-out item is flagged, not ordered.
- G7. Duplicate submit (double-tap / retry) with same idempotency key returns the same order — no duplicate.
- G8. Demo checkout: card form; `4242 4242 4242 4242` approves, `4000 0000 0000 0002` declines.
  Declined payment keeps the order out of the kitchen and explains why.
- G9. Confirmation shows order number + live status (Received → Preparing → Ready → Served).
- G10. Same table can place follow-up orders; guest can view the table's bill (all orders + total).
- G11. "Call staff" button records an assistance request visible to staff surfaces.

### Kitchen (KDS)
- K1. New paid orders appear in near-real time (server-sent events, polling fallback).
- K2. Items routed by **station** (Grill / Kitchen / Drinks / Dessert); station filter views.
- K3. Staff advance order status; guest view reflects it. Cancel path for "kitchen cannot fulfil".

### Admin
- A1. Live order list with table, status, payment state; filter by status.
- A2. Toggle any menu item sold-out / available; change reflects to guests immediately.
- A3. Tables list with guest link + printable table card per table (QR when `qrcode` pkg present, link always).
- A4. Settings: card surcharge % and public-holiday surcharge % toggles applied at checkout and itemised.
- A5. Staff-assistance requests list, clearable.

### 4a. Multi-restaurant
- M1. A restaurant signs up with a name, a unique address (slug: 3–40 lowercase letters, numbers, single hyphens; reserved words refused), a manager login, a table count and an optional kitchen login.
- M2. All data (menu, tables, orders, settings, assistance requests, staff) is scoped to one restaurant; no API call can read or change another restaurant's data.
- M3. A staff session is signed for one restaurant; it is rejected anywhere else, including after re-labelling the cookie.
- M4. Managers add, edit, remove and mark-sold-out dishes, add or remove tables, rename the restaurant and set surcharges. Kitchen staff cannot.
- M5. Each table QR code encodes `<public base>/r/<slug>/guest?table=<id>`; unknown restaurants return 404.
- M6. Passwords are stored as salted scrypt hashes; sign-up is rate limited per address; logins are throttled per address and restaurant.
- M7. A demo restaurant (`the-corner-table`) always exists. Old single-restaurant URLs and stores keep working.

## 5. Non-functional

- N1. Works on mobile browsers, no install, no guest account.
- N2. Every order keeps: id, table, items+modifiers, amounts, payment state, timestamps, status history (audit).
- N3. Failed kitchen/admin connection must surface an error, never silently drop an order (orders persist to disk).
- N4. Single-process demo deployment; data in `data/store.json` (created on first run, seeded menu).

## 6. Tech (chosen for zero-friction demo)

- **Node 24, no web framework** (`node:http`), static files in `public/`, JSON file store, SSE for live updates.
- Only optional dependency: `qrcode` (QR SVG for table cards). App runs without it (links still work).
- Start: `npm start` → `http://localhost:3000`. Tests: `npm test` (API smoke test, Node built-in test runner).

Data model: `restaurants{ [slug]: { slug, name, createdAt, staff[{username,role,hash}], tables[{id,label}],
menu[{id,name,desc,price,category,station,dietary[],available,modifierGroups[]}],
orders[{id,tableId,items[],subtotal,surcharges,total,status,payment:{state,last4},idempotencyKey,createdAt,history[]}],
settings{cardSurchargePct,holidaySurchargePct,holidayMode}, assistRequests[], seq } }`.
API: public and staff routes live under `/api/r/<slug>/...`; `POST /api/restaurants` signs a restaurant up and
`GET /api/restaurants/check?slug=` tests an address.

## 7. Later phases (not built)

1. A database instead of the JSON file (required before real restaurants rely on a serverless deployment), plus password reset and more staff accounts per restaurant.
2. Real payment gateway + refunds / split bill; a per-restaurant currency. 3. Named POS integration + ESC/POS printers.
4. Multi-branch per restaurant; modifier-group editing in admin. 5. Loyalty, takeaway/delivery, PWA venue app. 6. Arabic/English i18n + RTL.

## 8. Acceptance checks (demo script)

Scan Table 5 → order burger (medium, +extra cheese, note "no onion") + drink → pay approved card →
order appears on KDS under correct stations → advance to Ready → guest sees Ready → order again (dessert) →
admin marks drink sold-out → guest can no longer add it → pay with decline card → no kitchen ticket, clear message →
double-submit same checkout → only one order. Automated equivalent: `npm test`.
