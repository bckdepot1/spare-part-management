# Spare Part Management

ระบบจัดการอะไหล่ (รับเข้า / จ่ายออก / อนุมัติ / คลังอุปกรณ์ / ผู้ใช้งาน) — implemented from the
Claude Design prototype `Spare Part Management.dc.html`.

Plain HTML + CSS + JavaScript frontend, no build step. Data lives in **Supabase** (hosted
Postgres + Auth), so every signed-in user — on any device — shares the same stock, log and
account list. Hosting is meant for **Cloudflare Pages** (or any static host).

## First-time setup

1. **Database**: follow [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md) — create a free Supabase
   project, run the two SQL files in `db/`, create the three demo accounts, then fill in
   [`config.js`](config.js) with your project's URL and anon key.
2. **Run locally**: any static file server works, e.g.

   ```bash
   python -m http.server 5173
   ```

   Then open <http://localhost:5173>.
3. **Deploy**: follow [`DEPLOY.md`](DEPLOY.md) to push this repo to GitHub and connect it to
   Cloudflare Pages (free, auto-deploys on every push).

Until `config.js` is filled in, the app shows a Thai explanation instead of the login screen.

## Demo accounts

Created in Supabase during setup (see `SUPABASE_SETUP.md` step 4) — passwords are whatever you
set when creating each user in the Supabase dashboard, there's no default anymore:

| User | Role |
| --- | --- |
| `admin` | Admin |
| `supervisor` | Supervisor |
| `operator` | Operator |

## Permissions

| | Operator | Supervisor | Admin |
| --- | --- | --- | --- |
| ขอรับเข้า / ขอเบิก | ✔ (รออนุมัติ) | ✔ (ตัด Stock ทันที) | ✔ (ตัด Stock ทันที) |
| อนุมัติ / ปฏิเสธรายการ | — | ✔ | ✔ |
| แก้ไขค่า Min / Max | — | ✔ | ✔ |
| อนุมัติบัญชีผู้สมัครใหม่ | — | ✔ | ✔ |
| กำหนดสิทธิ์ / ลบผู้ใช้งาน | — | — | ✔ |

New sign-ups are created as `operator` with status `pending` and cannot log in until a Supervisor
or Admin approves them. Every one of these rules is enforced twice: the UI hides what a role
shouldn't see, and the matching Postgres function (`db/schema.sql`) re-checks the caller's role
before writing anything — so a user can't grant themselves access by calling the API directly.

## Files

| Path | Contents |
| --- | --- |
| `index.html` | Page shell — fonts, stylesheet, script tags |
| `styles.css` | All styling; palette and metrics ported from the design |
| `app.js` | State, actions, Supabase calls and rendering |
| `config.js` | Supabase project URL + anon key — fill in during setup |
| `assets/logo.svg` | Logo / favicon |
| `db/schema.sql` | Tables, Row Level Security, and the RPC functions every write goes through |
| `db/seed_stock.sql` | The 143-item master part list, generated from `data/parts.js` |
| `db/promote_seed_users.sql` | Promotes the 3 demo accounts to their real role after creation |
| `data/parts.js` | Original source list (no longer loaded by the app — kept as the seed source) |
| `SUPABASE_SETUP.md` | Step-by-step database setup |
| `DEPLOY.md` | Step-by-step Cloudflare Pages deployment |

## How it works

One `state` object holds everything currently on screen. Mutations go through `setState()`/
`render()`, which rebuilds the active view from scratch and then restores keyboard focus, caret
position and scroll offsets — so filtering a table while typing does not interrupt the field.
Views are built with a tagged template (`html`) that HTML-escapes every interpolated value, which
matters here because part codes contain `"` characters (`Gasket 150 3"`).

**Auth**: Supabase Auth needs an email; the login screen only ever shows a short username. The
frontend logs in with a synthetic address `<username>@login.spareapart.internal` — it never has to
be a real inbox, it just satisfies the email format check. The corresponding `profiles` table
holds the app-facing fields (name, role, `active`/`pending`/`rejected` status) and is created
automatically by a trigger when someone signs up.

**Writes**: nothing writes to `stock`, `transactions` or `profiles` directly — Row Level Security
only grants `SELECT`. Every action (submit a movement, approve/reject, edit Min/Max, change a
role, approve a new account) calls a Postgres function via `supabase.rpc(...)`. Each function
re-verifies the caller's role and status itself before touching anything, so permission logic
lives in one place instead of being trusted to the browser.

**Realtime**: after login the app subscribes to Postgres changes on all three tables, so if one
person approves a request or receives stock, everyone else's open tab updates automatically
without a refresh.

## Notes on the port from the original design prototype

- **Dates use the local calendar day.** `toISOString()` in UTC+7 reports the previous day until
  07:00 local time; dates are formatted from local date components instead.
- **Min/Max commit on blur**, not on every keystroke, so the confirmation toast fires once per
  edit instead of once per digit.
- **Approving an outbound request is rejected if stock has since dropped below the requested
  quantity** — enforced in `approve_transaction()` in `db/schema.sql`.
- **The chart caps at 120 columns**, so an accidentally wide date range cannot render thousands of
  bars.
- **Passwords are no longer visible to anyone, including Admin.** The original design's user table
  showed plaintext passwords in an admin-only column; Supabase Auth hashes and stores passwords
  itself and never exposes them, so that column was removed rather than ported.
- **The logo is a gear-in-a-box SVG mark** matching the app's subject (spare parts / inventory),
  not the original raster logo, which didn't survive the design-file transfer intact.

## Export

**Export Excel** on the ประวัติ/Log page writes the currently filtered rows to a UTF-8 CSV (with
BOM, so Excel reads Thai correctly) named `log_YYYY-MM-DD.csv`.
