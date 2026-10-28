> **Out of date.** This is the hand-off from the first build, before the five roles, the customer-service helpdesk and the customer-systems connector (it still lists 10 accounts and the old `admin / manager / agent` roles).
> The source of truth is [README.md](README.md); to move or deploy the project see [DEPLOYMENT.md](DEPLOYMENT.md). The design notes below are kept for reference.

# Autostrad CRM

Fleet and customer relationship management for **Autostrad Rent a Car** (UAE): bookings, live trips, fleet,
customers (with document verification), corporate leads, invoices with 5% VAT, fines and Salik, maintenance,
branches and team. Branded from the Figma file *Autostrad Car Share — Mobile App*
(`9OvuTxvJoe0J9SD8LOZMrj`, node `47-1205`).

**Status: complete and running locally.** API + web app, seeded demo data, roles, EN UI.

---

## 1. Run it

```bash
cd /Users/usama/Desktop/clients/arc-crm
npm run setup     # installs server + web dependencies and seeds the database (first time only)
npm run dev       # API http://localhost:4000 · web http://localhost:5173 (Vite proxies /api to the API)
```

Open **http://localhost:5173**. All 10 seeded accounts share the password `autostrad123`:

| Email | Role | Sees |
|---|---|---|
| `admin@autostrad.ae` | admin | everything |
| `khalid@autostrad.ae`, `rania@autostrad.ae`, `omar.d@autostrad.ae` | manager | everything except Team and Settings |
| `samir@autostrad.ae`, `leena@autostrad.ae`, `dana@autostrad.ae`, `yousef@autostrad.ae`, `hassan@autostrad.ae` | agent | bookings, trips, fleet, customers, leads, tasks |
| `mariam@autostrad.ae` | finance | bookings, trips, fleet, customers, fines, invoices, tasks |

`npm run seed` regenerates the demo data (**destructive**). The seed is relative to today, so run it again
whenever you want fresh dates, including five live car-share trips. In dev, the login page offers a
"fill in the demo login" shortcut (hidden in production builds).

Ports: the API listens on `API_PORT` (default **4000**), deliberately not on the generic `PORT`, so a dev runner
that sets `PORT` for the web app can never move the API. Vite uses 5173 and proxies `/api` to `API_PORT`.

> **Moving the folder between machines or operating systems?** `better-sqlite3` is a native module. If the API
> fails with a `dlopen` / "not a valid mach-o file" error, run `npm --prefix server rebuild better-sqlite3`.

---

## 2. What is in it

| Screen | Highlights |
|---|---|
| **Dashboard** | Gulf-time greeting, 8 KPI tiles that link to the filtered list, revenue trend, fleet status, revenue by product, category and branch, vehicles on the road now, latest bookings, expiring documents, lead pipeline. |
| **Bookings** | Status tabs with live counts, filters, price calculated from vehicle rate and period (+5% VAT), mark paid, cancel (refund flag), related trips / invoices / fines. |
| **Trips** | Live and completed drives. **End trip** closes it and frees the vehicle. |
| **Fleet** | Table or cards, fuel / charge bars, insurance and registration expiry warnings, send to workshop / mark available. |
| **Maintenance** | A job in progress puts the vehicle in the workshop; completing it releases the vehicle. |
| **Fines & Salik** | Pick a booking and the vehicle and customer fill in; admin fee defaults (AED 50 fine / 0 toll); mark recovered or disputed. |
| **Customers** | Verification queue (verify / reject), tier and segment, licence expiry warning, related bookings, invoices and fines. |
| **Corporate leads** | Kanban board (drag cards between stages) or table; linked tasks. |
| **Tasks** | Calls, meetings and follow-ups, with overdue highlighting. |
| **Invoices** | Tabs by status, VAT split, mark paid, send. |
| **Branches / Team / Settings** | Branch cards with fleet availability and Arabic names; staff accounts with passwords; company profile, TRN, VAT and fee defaults. |

Everywhere: global search (**⌘K / Ctrl+K**) across bookings, customers, vehicles, invoices and leads; notification bell built
from live alerts; CSV export of the current filter; deep links such as `/customers?verification_status=pending` or
`/bookings?open=12`; collapsible sidebar; works on phones.

**Roles are enforced in the UI only** (menu and routes). The API only checks that you are signed in.
Add server-side checks before exposing it to real users.

---

## 3. Brand

Logos live in `web/public/brand/`:

| File | Use |
|---|---|
| `logo.svg` | Navy wordmark, transparent. Light backgrounds. |
| `logo-light.svg` | White wordmark, transparent. Navy sidebar and dark heroes (used in the app). |
| `mark.png` | Pin with steering wheel and UAE flag. Avatars, loading screen, collapsed sidebar. |
| `favicon.png` | Tab icon. |
| `logo.png`, `logo-light.png` | **Legacy exports with an opaque background. Do not use; use the SVGs.** |

Tokens (`web/src/theme.css`): navy `#174371`, blue `#2E86CE`, sky `#3DB2E2`, page `#EAF3FC`; status pills for ok / info / warn / danger;
Figtree font; Lucide icons. Primary buttons are the kit's navy→blue gradient with a circular arrow badge.

---

## 4. Code map

```
arc-crm/
├── package.json            root: `npm run dev` starts both servers
├── .claude/launch.json     one-click start for the Claude desktop preview
├── server/                 Express 4 (ESM) + better-sqlite3 + JWT
│   ├── src/db.js           schema
│   ├── src/crud.js         generic REST resource (list / counts / get / create / update / delete, hooks)
│   ├── src/index.js        auth, resources, numbering, vehicle-status sync
│   ├── src/routes/stats.js dashboard, lookups, global search
│   ├── src/seed.js         deterministic demo data
│   └── data/autostrad.db   SQLite file (git-ignored)
└── web/                    Vite + React 18 + react-router 6 + recharts + lucide-react
    └── src/
        ├── theme.css       design tokens and components
        ├── api.js · auth.jsx · toast.jsx
        ├── lib/            format (AED, Gulf time) · formValues · options · csv
        ├── components/     Layout · CrudPage · RecordForm · DataTable · Modal · GlobalSearch · ui · cells
        ├── config/         one config per resource: fleet.jsx · people.jsx · operations.jsx · shared.js
        └── pages/          Dashboard · Login · Settings · resources.jsx
```

### Adding or changing a screen

Almost every list screen is `CrudPage` driven by a config object in `web/src/config/`:

```js
export const vehicles = {
  resource: 'vehicles', title: 'Fleet', singular: 'vehicle', plural: 'vehicles',
  layouts: ['table', 'cards'],                       // also 'board' (needs config.board)
  tabs:    { field: 'status', options: [...] },       // status tabs with live counts (/_counts)
  filters: [{ key: 'category', label: 'Category', options: [...] }],
  columns: [{ key, label, sortable, align, wrap, render(row), export(row) }],
  stats:   [...],                                     // tiles above the list, fed by /stats/dashboard
  actions: (row) => [{ key, label, short, icon, tone, when(row), patch(row), confirm, success }],
  related: [{ title, resource, by: 'vehicle_id', page: '/bookings', row(r) }],
  form: { defaults(), compute(values, changedKey, { options, mode }), fields: [...] },
};
```

Add the route in `web/src/App.jsx`, a one-line page in `pages/resources.jsx` and a nav item in `components/Layout.jsx`.
Form field types: `text email tel number date datetime select relation textarea password`, plus `section` headings.

---

## 5. Data model (`server/src/db.js`)

| Table | Key columns |
|---|---|
| `branches` | name, name_ar, emirate, address, phone, manager, opening_hours, status |
| `users` | name, email, password_hash, role (`admin\|manager\|agent\|finance`), job_title, phone, branch_id, status |
| `vehicles` | plate, make, model, year, category, transmission, fuel_type, color, branch_id, **status** (`available\|on_trip\|reserved\|maintenance`), odometer, fuel_level, daily_rate, monthly_rate, carshare_rate, next_service_km, insurance_expiry, registration_expiry, vin |
| `customers` | name, phone, email, nationality, emirates_id, license_no, license_expiry, **verification_status** (`verified\|pending\|rejected`), tier (`Standard\|Silver\|Gold\|Platinum`), segment (`Individual\|Corporate`), wallet_balance, trips_count, lifetime_value, join_date, notes, status |
| `bookings` | ref (`AST-1000xx`, auto), customer_id, vehicle_id, **product_line** (`Daily\|Flexi Monthly\|Car Share\|Corporate Lease`), pickup_branch_id, dropoff_branch_id, start_at, end_at, **status** (`upcoming\|active\|completed\|cancelled`), base_amount, extras_amount, vat_amount, total_amount, payment_status (`paid\|unpaid\|refunded`), payment_method, source |
| `trips` | booking_id, customer_id, vehicle_id, started_at, ended_at, distance_km, duration_min, start_fuel, end_fuel, fare, rating, **status** (`live\|completed`) |
| `invoices` | number (`INV-2026-00xx`, auto), customer_id, booking_id, issue_date, due_date, subtotal, vat, total, **status** (`paid\|sent\|overdue\|draft`), method, paid_at |
| `leads` | company, contact_name, email, phone, source, **stage** (`New\|Qualified\|Proposal\|Negotiation\|Won\|Lost`), fleet_size, est_value, owner_id, next_action, next_action_date, notes |
| `maintenance` | vehicle_id, type, description, scheduled_date, completed_date, odometer, cost, vendor, status (`scheduled\|in_progress\|completed`) |
| `fines` | type (`Traffic Fine\|Salik Toll`), reference, vehicle_id, customer_id, booking_id, issued_at, location, amount, admin_fee, status (`recovered\|unrecovered\|disputed`), authority |
| `activities` | type, subject, related_type, related_id, user_id, due_at, done |
| `settings` | key/value (company_name, company_name_ar, tagline, trn, vat_rate, currency, default_branch, fine_admin_fee, salik_admin_fee, support_email, support_phone) |

Seeded: 8 branches, 10 users, 54 vehicles, 68 customers, 185 bookings, 165 trips (5 live), 160 invoices, 20 leads, 34 maintenance jobs, 46 fines.
Timestamps are stored in UTC (`YYYY-MM-DD HH:MM:SS`); the app shows and edits them in Gulf time (UTC+4).

---

## 6. API

Base `/api`. Everything except `POST /auth/login` and `GET /health` needs `Authorization: Bearer <token>` (JWT, 12 h).

```
POST /auth/login {email,password} -> {token, user}      GET /auth/me      GET /health
```

Resources `branches vehicles customers bookings trips invoices leads maintenance fines team activities` share one contract:

```
GET    /:resource?q=&<anyColumn>=&sort=&dir=asc|desc&limit=&offset=   -> { data, total }
GET    /:resource/_counts?field=status&q=&<otherFilters>=            -> { counts: {value: n}, total }   (tab counts)
GET    /:resource/:id          POST /:resource          PUT /:resource/:id          DELETE /:resource/:id
```

* Lists are pre-joined with display names (`customer_name`, `vehicle_name`, `plate`, `branch_name`, `owner_name`, …).
* Errors come back as `{ error }` with a readable message (duplicate plate, missing field, record in use…).
* `POST /bookings` and `POST /invoices` generate the reference / number when empty.
* Trips and maintenance keep the vehicle's status in step: a live trip means `on_trip`, an in-progress job means `maintenance`;
  ending or completing them releases the vehicle.
* `POST /team` needs a `password` (min 8 chars); `PUT /team/:id` changes it only when one is sent.

```
GET /stats/dashboard   fleet, kpis, revenueTrend, byProductLine, byCategory, branchPerformance,
                       recentBookings, liveTripList, expiring, pipeline
GET /stats/options     branches, vehicles, customers, users, leads, bookings   (for pickers)
GET /stats/search?q=   top matches across bookings, customers, vehicles, invoices, leads
GET /settings   PUT /settings {key: value}
```

---

## 7. Gotchas

* **DB path** is `server/data/autostrad.db` (override with `ARC_DB_PATH`). WAL is attempted and silently falls back on filesystems that refuse it.
* `JWT_SECRET` defaults to a development value. Set it, restrict CORS and add server-side role checks before any real deployment.
* The seed is destructive and relative to the current date; the PRNG seed is fixed, so the demo data is reproducible apart from the dates.
* Vehicle status is driven by trips and maintenance (see above). Keep that rule if you add new ways to change them.
