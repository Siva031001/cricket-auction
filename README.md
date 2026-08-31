# Cricket Tournament Auction Management System

A zero-cost system for running a cricket tournament player auction. Everything runs on free Google infrastructure: a Google Apps Script Web App for the API, a Google Sheet for the data, Google Drive for the images, and GitHub Pages for the static frontend. There are no paid services anywhere in the design, and that is a hard requirement, not a preference.

**Status: feature-complete.** All phases (0–8) are built. What is left is deployment and two open questions — see [§8](#8-current-status).

---

## 1. What this system does

If you have never seen this before, read this section first. There are four kinds of people involved.

| # | Who | What they do |
|---|---|---|
| 1 | **Admin** | Creates the tournament: dates, entry fee, UPI ID, QR code, rules. Gets back a public registration link. |
| 2 | **Player** | Opens that link on their phone. Pays the fee **by UPI, outside this system**, and uploads a screenshot of the payment. Gets a serial number. |
| 3 | **Admin** | Opens each payment one at a time, compares the UPI reference against a bank statement, and clicks Verify or Reject. **The app never decides that a payment succeeded — a human does.** |
| 4 | **Organiser** | Creates the 8 teams, each with a purse and a squad size. |
| 5 | **Everyone** | On auction day a **physical lottery** draws a serial number. The organiser types it into a console, the player appears on a projector, the room bids by voice, and the organiser records SOLD (team + amount) or UNSOLD. |

Money never moves through this system. It only records who paid, who was verified, and who was sold to whom for how much.

---

## 2. The scale that shaped the design

Two numbers drive almost every design decision.

| Number | Value |
|---|---|
| Registered players | **400** |
| Teams × squad size | **8 × 12–13 = about 100 slots** |

The consequence is uncomfortable and it is deliberately visible in the software: **roughly 300 players pay the fee and are never called at all.** The auction ends when the teams are full, not when the players run out.

So the system does not report three statuses, it reports four:

| State | Report label |
|---|---|
| `PENDING`, `times_called = 0` | **Not called** |
| `PENDING`, `times_called > 0` | **Awaiting re-auction** |
| `UNSOLD` | **Unsold** |
| `SOLD` | **Sold** |

And the auction console shows an advisory banner the moment every team is full: *"All 8 teams are full. 298 players were not called. You can close the auction."* Advisory only — an admin still clicks close.

Full reasoning: `DESIGN.md` §6.9 and §6.9a. The fairness decision itself is still open — `KNOWN-ISSUES.md` item 4.

---

## 3. Architecture

```
  Player phone            Admin laptop         Organiser laptop      Projector browser
        |                       |                     |                     |
        +-----------------------+----------+----------+---------------------+
                                           |
                             GitHub Pages (static HTML/CSS/JS)
                                    free, CDN, HTTPS
                                           |
                                    fetch() JSON over HTTPS
                                           |
                          Google Apps Script Web App  (doGet / doPost)
                          - all authorisation lives here
                          - LockService for the auction
                          - CacheService for hot reads
                                           |
                        +------------------+------------------+
                        |                                     |
                Google Sheets                          Google Drive
             (9 tabs, structured data)          (photos, QR, screenshots)
```

The browser **never** touches the Spreadsheet. It only calls the Apps Script API.

The 9 tabs are `Tournaments`, `Users`, `Players`, `Payments`, `Teams`, `AuctionResults`, `AuditLog`, `Sessions`, `Config`.

Two deployment facts to keep straight:

| Part | Where it lives | How it ships |
|---|---|---|
| Backend | `.gs` files in `backend/`, in an Apps Script project **bound to** the Google Sheet | `clasp push`, then re-deploy the existing Web App (see RUNBOOK Part 2) |
| Frontend | Static files in `frontend/` | Git push to `main`. `.github/workflows/pages.yml` publishes it to GitHub Pages (see §9). **No build step.** |

---

## 4. Repository layout

```
cricket-auction/
├── backend/            Apps Script (.gs) source. Pushed with clasp.
├── frontend/           Static SPA. Served by GitHub Pages. No build.
├── tools/              Node checks and behavioural harnesses. Dev only.
├── .github/workflows/pages.yml   Publishes frontend/ to GitHub Pages. See §9.
├── DESIGN.md           The why: analysis, trade-offs, risks, phases.
├── CONTRACTS*.md       The what: binding interfaces every file must match.
├── RUNBOOK.md          The how: set it up, deploy it, run a whole tournament.
├── AUCTION-DAY.md      The one-page operations card for the event itself.
├── KNOWN-ISSUES.md     What is not done, and what is untestable from here.
├── .clasp.json.example Template. Copy to .clasp.json and fill in the script ID.
└── package.json        clasp plus four shortcuts. Zero runtime dependencies.
```

### 4.1 `backend/` — one file per concern

17 `.gs` files plus the manifest. Apps Script concatenates them all into **one global scope**, so there is no `require` and no `import`.

| File | What it does |
|---|---|
| `Config.gs` | Frozen constants only: `SHEETS`, `HEADERS`, `ENUM`, `ERR`, `ID_PREFIX`, `BOOLEAN_FIELDS`, `NUMERIC_FIELDS`, `DEFAULTS`. No logic, nothing runs at load time. |
| `Util.gs` | Ids, ISO timestamps, IST date helpers, money as whole rupees, `formatINR`, hashing, validation, and the `ok` / `err` / `AppError` envelope builders. |
| `Repo.gs` | The **only** file allowed to call `SpreadsheetApp`. Row read/write, `nextSerial`, `flush`, and `withLock`. |
| `Setup.gs` | `setup()`, `seedAdmin()`, `resetTestData()`, `rebuildCounters()`. Run by hand from the editor. |
| `Auth.gs` | Login, session tokens, password hashing, role and tournament-scope checks. |
| `Audit.gs` | `Audit.log(...)` writes an `AuditLog` row. Never throws — an audit failure must not break the action it records. |
| `Cache.gs` | `CacheService` and `PropertiesService` wrappers: state version, auction snapshot, sessions, config, login-failure counters. |
| `Drive.gs` | Folder tree, image upload with server-side type and size checks, thumbnail URLs, `public/` sharing and the never-shared `private/` folder. |
| `Code.gs` | The bare global `doGet(e)` / `doPost(e)`, `buildRoutes()`, the auth routes, and the dispatcher. No stack trace ever reaches the response. |
| `Tournaments.gs` | Tournament CRUD, the public landing-page feed, status transitions, and the registration / projector links. |
| `Players.gs` | Player registration and validation, `player.checkMobile`, the admin player list, withdrawal, and `isAuctionEligible`. |
| `Payments.gs` | The verification queue, the one-at-a-time screenshot fetch, verify, reject, and the mirrored `payment_status` on `Players`. |
| `Organisers.gs` | Organiser accounts and their one-time, 72-hour join links. The plain token exists only in the create/resend response. |
| `Teams.gs` | Teams, purse, squad size, batch creation, the team dashboard numbers, and `team.recount`. |
| `Auction.gs` | The live auction. Every state change runs inside `Repo.withLock`, re-reads from the sheet, and validates there. Highest-risk file in the project. |
| `Reports.gs` | The three CSV exports, the final report, the admin dashboard numbers, and the audit viewer. **Never writes a row.** |
| `Tests.gs` | `runAllTests()` / `runTest(name)` and the `T.*` assertion harness. Run from the Apps Script editor. Refuses unless `env` is `TEST`. |
| `appsscript.json` | The manifest: V8 runtime, timezone, OAuth scopes, Web App access. Pushed by clasp with the `.gs` files. |

**48 actions are registered, of which exactly 7 are PUBLIC:** `auction.displayState`, `auth.login`, `auth.organiserJoin`, `player.checkMobile`, `player.register`, `system.ping`, `tournament.getPublic`. That list is pinned in `tools/check.js` — see §7.

### 4.2 `frontend/` — static files, no framework

No bundler, no transpiler, no CDN script tag, no web font. Files are served exactly as committed.

**Shell and shared libraries** (`frontend/js/`):

| File | What it does |
|---|---|
| `config.js` | `API_BASE_URL` (the `/exec` URL), `BASE_PATH`, and every other hardcoded value. |
| `api.js` | The only file that calls `fetch`. `API.call` / `API.get` / `setToken` / `getToken` / `clearToken`. |
| `router.js` | Path-based SPA router. Real URLs, no hashes. |
| `app.js` | Bootstrap, the route table, the admin nav, and the auth guard. |
| `ui.js` | `UI` — form fields, banners, buttons, money formatting, progress, dialogs. |
| `image.js` | `ImageTool` — canvas resize before upload. 1024 px longest side, JPEG 0.8, plus a 320 px thumbnail. |
| `offline.js` | `Offline` — the venue-internet safety net. IndexedDB pack of players and photos, offline queue, ordered replay. |

Plus `index.html` (the shell), `404.html` (bounces deep links into `index.html`) and `css/app.css` (shared, mobile-first).

**Pages** (`frontend/js/pages/`), each with its own CSS file:

| Route | Module / file | CSS |
|---|---|---|
| `/register/:tournamentId` | `RegisterPage` — `register.js` | `register.css` |
| `/admin/login` | `AdminLoginPage` — `admin-login.js` | `admin.css` |
| `/admin/dashboard` | `AdminTournamentPage` — `admin-tournament.js` | `admin.css` |
| `/admin/payments` | `AdminPaymentsPage` — `admin-payments.js` | `payments.css` |
| `/admin/players` | `AdminPlayersPage` — `admin-players.js` | `players.css` |
| `/admin/organisers` | `AdminOrganisersPage` — `admin-organisers.js` | `admin.css` |
| `/admin/reports` | `AdminReportsPage` — `admin-reports.js` | `reports.css` |
| `/admin/audit` | `AdminAuditPage` — `admin-audit.js` | `admin.css` |
| `/organiser/join` | `OrganiserJoinPage` — `organiser-join.js` | `organiser.css` |
| `/organiser/dashboard` | `OrganiserDashboardPage` — `organiser-dashboard.js` | `organiser.css` |
| `/organiser/auction` | `OrganiserAuctionPage` — `organiser-auction.js` | `auction.css` |
| `/auction/:tournamentId/display` | `DisplayPage` — `display.js` | `display.css` |
| `/projector/:tournamentId` | `DisplayPage` — `display.js` (alias, preferred going forward) | `display.css` |
| `/stream/:tournamentId` | `StreamPage` — `stream.js` (OBS Browser Source overlay) | `stream.css` |
| `/watch/:tournamentId` | `WatchPage` — `watch.js` (public viewer) | `watch.css` |

Two frontend rules that are easy to break (`CONTRACTS-PHASE1.md` §4):

1. **One owner per file.** Each page owns its page file and its CSS file. `index.html` and `css/app.css` are shared and belong to the integration owner only.
2. **`textContent`, never `innerHTML`.** A tournament name comes from the sheet and a tournament id comes from the URL. Both are untrusted.

**The UPI QR image stays PNG.** It is never re-encoded as JPEG, because JPEG artefacts can make a QR code unscannable. Every other image is resized to JPEG.

### 4.3 `tools/` — how the code is checked without Google

| Path | What it is |
|---|---|
| `tools/check.js` | Static checks. Loads every `.gs` into a Node `vm` with stubbed Google services, reproducing Apps Script's single-global-scope concatenation. |
| `tools/test.js` | The behavioural harness runner. Discovers and runs everything under `tools/harness/`. |
| `tools/harness/backend/` | 7 harnesses: `auction`, `organisers`, `payments`, `players`, `reports`, `teams`, `tournaments`. Real `.gs` code against in-memory fakes for Sheets, Drive, Cache, Properties and Lock. |
| `tools/harness/frontend/` | 11 harnesses: `admin-payments`, `admin-players`, `admin-reports`, `admin-tournament`, `display`, `offline`, `organiser`, `organiser-auction`, `register`, `router-smoke`, `ui-image`. Real page code against `fakedom.js`. |

Node never runs in production. These exist only because Apps Script cannot be run on a laptop.

---

## 5. How to verify

Three levels, cheapest first. **None of them replaces the one below it.**

### 5.1 `npm run check` — static, about a second

```bash
npm run check          # = node tools/check.js
```

What it proves:

1. No duplicate top-level globals across the 17 backend files (this is a fatal load error in Apps Script, not a warning).
2. Every file loads together in one global scope.
3. All entry points exist: `doGet`, `doPost`, `buildRoutes`, `setup`, `seedAdmin`, `runAllTests`, `resetTestData`.
4. Every cross-module symbol resolves.
5. **Only `Repo.gs` touches `SpreadsheetApp`.**
6. The schema is consistent: 9 tabs, all with headers.
7. The route table builds, and the **PUBLIC action list is exactly the 7 pinned in `EXPECTED_PUBLIC`**.
8. Frontend: no duplicate globals across the 19 files, no `innerHTML` / `eval` / `document.write`, no `fetch` outside `api.js`, and every file `index.html` references actually exists.

**What it does not do: it does not test behaviour.** There is no Spreadsheet, so nothing here proves a purse subtracts correctly.

Observed on the current tree: **11 of 11 checks pass.** It also prints a `note` that `config.js` still holds the placeholder API URL — expected until you deploy.

### 5.2 `npm test` — behavioural, a few seconds

```bash
npm test               # = node tools/check.js && node tools/test.js
```

Runs everything in §5.1, then the behavioural harnesses. Observed on the current tree:

| | Result |
|---|---|
| Harnesses | **18** (7 backend, 11 frontend) |
| Assertions | **about 1600** |
| Wall time | under 10 seconds |

At the moment this was written, 17 of the 18 passed; `frontend/organiser-auction` was still being written. Re-run it — the runner prints the live totals and it is the numbers on your screen that count, not these.

These load the real `.gs` and real page code into Node with faked Google services and a fake DOM, and exercise real behaviour: purse arithmetic, lock ordering, duplicate detection, paging maths, XSS escaping, CSV encoding, offline replay classification.

**What it does not do:**

- It does not prove **real concurrency**. A Node fake serialises everything anyway. See `KNOWN-ISSUES.md` item 8.
- It does not prove **real Google behaviour** — real `LockService` timing, real Drive sharing, real quota limits, real `<canvas>` EXIF rotation (`KNOWN-ISSUES.md` item 1), or whether Drive thumbnail bytes are readable cross-origin (item 13).

Run a subset with `node tools/test.js auction`.

### 5.3 `backend/Tests.gs` — the real suite

Run from the Apps Script editor, against a **TEST** sheet:

1. Open the TEST Apps Script project.
2. Select `runAllTests` in the function dropdown.
3. Click **Run** and read the Execution log.

This is the only suite that runs against a real Spreadsheet, real Drive and real `LockService`.

**It refuses to run unless the `Config` tab's `env` key is exactly `TEST`.** The guard is on the data, not the code, because the same code is pushed to both projects — only the Sheet knows which world it is in. Tests write real rows, and every write appends an `AuditLog` row that cannot be cleanly removed. See `RUNBOOK.md` Part 3.

### 5.4 Still not covered by any of the three

The real concurrency test — parallel `markSold` calls at one player, against a **deployed** URL. `KNOWN-ISSUES.md` item 8, and `RUNBOOK.md` Part 4b. This is the one that actually proves two browsers cannot sell the same player twice. Run it before the auction.

---

## 6. Standing architectural rules

Each of these is a boundary, not a style preference. Each has one reason.

| # | Rule | Why |
|---|---|---|
| 1 | **Only `Repo.gs` may touch `SpreadsheetApp`.** | Concurrency and schema are then reviewable in one file instead of seventeen — and one `getValues()` per tab is 10–100× faster than looping `getRange`. |
| 2 | **The session token goes in the POST body, with `Content-Type: text/plain;charset=utf-8`.** | Apps Script does not answer CORS preflight (`OPTIONS`), so the request must stay a *simple* one. `application/json` or any custom header (e.g. `Authorization`) triggers preflight and the call fails. |
| 3 | **`textContent`, never `innerHTML`.** | Player and tournament names come from untrusted input; `innerHTML` would make them executable. |
| 4 | **Money is whole integer rupees.** | Floating-point paise would make purse totals drift, and every displayed figure disagree with the sheet. Display via `Util.formatINR` / `UI.money`. |
| 5 | **Instants are UTC; calendar dates are IST.** | A deadline of `2026-08-31` read as UTC closes registration at 05:30 IST and silently loses most of the last day. All window checks go through `Util.isWithinWindow`. |
| 6 | **Every state change is audited, with prev and next.** | The `AuditLog` is append-only evidence — it is what settles "did that player actually pay?" months later. |
| 7 | **A new PUBLIC action must be added to `EXPECTED_PUBLIC` in `tools/check.js`, deliberately.** | The `/exec` URL is public and anonymous. Making the public surface widen only by an explicit edit means it can never widen by accident. |

Two more, from the contracts: handlers return plain data and the dispatcher wraps it in `Util.ok`; and one `Repo.readAll` per tab per request — never `Repo.filterBy` in a loop.

On timing (rule 5): IST is a fixed +05:30 offset and India has never used daylight saving, so this is plain arithmetic — no timezone database, no DST edge cases. Full signatures in `CONTRACTS.md` §6a.

---

## 7. The public surface, pinned

`tools/check.js` holds `EXPECTED_PUBLIC`. If the route table's PUBLIC set stops matching it exactly, the check **fails** — in both directions. An unexpected public action is named; a missing one is named too.

The seven, and why each is public:

| Action | Credential |
|---|---|
| `system.ping` | none — a smoke test that returns nothing |
| `tournament.getPublic` | none — the registration landing page. Tournament fields only; never a player list, never a count |
| `player.register` | none — players have no login at all |
| `player.checkMobile` | none — returns only `{taken: true\|false}`, rate limited per number |
| `auth.login` | the password itself |
| `auth.organiserJoin` | the one-time join token in the payload; the organiser has no session yet |
| `auction.displayState` | the tournament's `display_token` in the query string. Read-only, no controls, no personal data |

"Who has access: Anyone" on the Web App deployment sounds alarming and is fine: every action re-checks the token, the role and the tournament scope on the server. The URL being public knowledge is expected, not a breach.

---

## 8. Current status

**All phases are built.** What remains is deployment and two open questions.

| Phase | Content | Status |
|---|---|---|
| 0 | Repo, Sheets, Drive, Apps Script skeleton, auth, `Tests.gs` | **Done** |
| 1 | Tournament creation, registration link, QR, player registration, photo upload, serial numbers | **Done** |
| 2 | Admin list, payment verify/reject, verified pool | **Done** |
| 3 | Organiser access, teams, purse, team dashboard | **Done** |
| 4 | Auction core — serial lookup, display, sold/unsold, purse, counts | **Done** (the concurrency test itself is still outstanding — §5.4) |
| 5 | Projector mode | **Done** |
| 5.5 | Offline resilience pack (`DESIGN.md` §16) | **Done** |
| 6 | Reports and CSV export | **Done** |
| 7 | Audit log UI, corrections, auction close, final report | **Done** |
| 8 | Dress rehearsal and fixes | **Pending — this is a real-world activity, not code** |

### What is left

1. **Deploy it.** `RUNBOOK.md` Parts 1, 2 and 4b: push, deploy, run `backend/Tests.gs` against the TEST sheet, then run the real concurrency test against the deployed URL.
2. **Two open questions** (`KNOWN-ISSUES.md` items 3 and 4), both needing a decision from the tournament owner, not code:
   - **Who owns the Google account?** It holds 400 people's personal data and their payment screenshots.
   - **Registration cap.** 400 registrations against ~100 slots. Cap it, say so on the registration page, or word the fee as a participation fee.
3. **Verified-on-real-hardware items**, also in `KNOWN-ISSUES.md`: EXIF photo rotation on a real phone (item 1), and whether Drive thumbnail bytes are readable cross-origin for the offline pack (item 13).

Read `KNOWN-ISSUES.md` in full before go-live. It is honest and it is short.

---

## 9. Hosting the frontend on GitHub Pages

The static site is published by `.github/workflows/pages.yml`, not by a branch deployment.

**Repo Settings → Pages → Source must be set to "GitHub Actions".**

Why: GitHub Pages can only serve from the repository root or `/docs` when deploying straight from a branch. Our site lives in `frontend/`, so a branch deployment cannot see it. The workflow uploads that one folder instead, which keeps `backend/` and `frontend/` side by side in the repo. There is still no build step — the files are served exactly as committed. The workflow also fails the deploy if `frontend/js/config.js` still holds the placeholder API URL.

`frontend/404.html` handles deep links: Pages returns it for any unknown path, and it bounces into `index.html` so `/register/TRN_xxx` works when typed, scanned or reloaded.

---

## 10. Where to read next

| You want | Read |
|---|---|
| Why it is built this way — trade-offs, risks, quota maths, edge cases | `DESIGN.md` |
| The exact interfaces: sheet columns, error codes, function signatures, route shape | `CONTRACTS.md`, then `-PHASE1`, `-PHASE2`, `-PHASE3`, `-PHASE4-7` |
| How to set it up, deploy it, verify it, and run a whole tournament | `RUNBOOK.md` |
| The auction day itself — the printable operations card | `AUCTION-DAY.md` |
| What is not done, and what cannot be tested from a laptop | `KNOWN-ISSUES.md` |

`CONTRACTS.md` is authoritative and each phase file extends it. If a contract looks wrong, say so — do not silently deviate.
