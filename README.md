# Cricket Tournament Auction Management System

A zero-cost system for running a cricket tournament player auction. Players register on their phone, pay the entry fee by UPI and upload a payment screenshot. An admin verifies each payment. On auction day an organiser looks up a player by serial number, and records who bought them and for how much, while a projector screen shows the same player live to the hall. Everything runs on free Google infrastructure: a Google Apps Script Web App for the API, a Google Sheet for the data, Google Drive for the images, and GitHub Pages for the static frontend. Target scale is 400 players, 8 teams of 12–13 players, and one live auction at a time. There are no paid services anywhere in the design, and that is a hard requirement, not a preference.

---

## 1. Architecture

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

Two deployment facts to keep straight:

| Part | Where it lives | How it ships |
|---|---|---|
| Backend | `.gs` files in `backend/`, in an Apps Script project **bound to** the Google Sheet | `clasp push`, then re-deploy the existing Web App (see RUNBOOK Part 2) |
| Frontend | Static files in `frontend/` | Git push to `main`. `.github/workflows/pages.yml` publishes it to GitHub Pages (see §6). **No build step.** |

---

## 2. Repository layout

```
cricket-auction/
├── backend/            Apps Script (.gs) source. Pushed with clasp.
├── frontend/           Static SPA. Served by GitHub Pages. No build.
├── docs/               Notes and screenshots. Nothing here is executed.
├── .github/
│   └── workflows/
│       └── pages.yml   Publishes frontend/ to GitHub Pages. See §6.
├── DESIGN.md           The why: analysis, trade-offs, risks, phases.
├── CONTRACTS.md        The what: binding interfaces every file must match.
├── CONTRACTS-PHASE1.md Phase 1 additions: tournaments, registration, images.
├── RUNBOOK.md          The how: deploy it, test it, run it on the day.
├── .clasp.json.example Template. Copy to .clasp.json and fill in the script ID.
└── package.json        clasp only. The app has zero runtime dependencies.
```

### 2.1 `backend/` — one file per concern

| File | What it does |
|---|---|
| `Config.gs` | Frozen constants only: `SHEETS`, `HEADERS`, `ENUM`, `ERR`, `ID_PREFIX`, `BOOLEAN_FIELDS`, `NUMERIC_FIELDS`, `DEFAULTS`. No logic. |
| `Util.gs` | Ids, ISO timestamps, money as whole rupees, `formatINR`, hashing, validation helpers, and the `ok` / `err` / `AppError` envelope builders. |
| `Repo.gs` | The **only** file allowed to call `SpreadsheetApp`. Row read/write, `nextSerial`, and `withLock`. |
| `Setup.gs` | `setup()`, `seedAdmin()`, `resetTestData()`, `rebuildCounters()`. Run by hand from the editor. |
| `Auth.gs` | Login, session tokens, password hashing, role and tournament-scope checks. |
| `Audit.gs` | `Audit.log(...)` writes an `AuditLog` row. Never throws — an audit failure must not break the action it records. |
| `Cache.gs` | `CacheService` and `PropertiesService` wrappers: state version, auction snapshot, sessions, config. |
| `Drive.gs` | Folder tree, image upload with server-side type and size checks, thumbnail URLs, public/private sharing. |
| `Code.gs` | The bare global `doGet(e)` / `doPost(e)` Apps Script requires, plus the dispatcher and error envelope. |
| `Tournaments.gs` | **Phase 1.** `TournamentRoutes()` — `tournament.create`, `update`, `list`, `get`, `setStatus`, `getPublic`. |
| `Players.gs` | **Phase 1.** `PlayerRoutes()` — `player.register` and `player.checkMobile`, with the lock order from `CONTRACTS-PHASE1.md` §2. |
| `Payments.gs` | **Phase 2 stub.** `PaymentRoutes()` — verify and reject. |
| `Teams.gs` | **Phase 3 stub.** `TeamRoutes()` — teams, purse, squad size. |
| `Auction.gs` | **Phase 4 stub.** `AuctionRoutes()` — the locked critical section. |
| `Reports.gs` | **Phase 6 stub.** `ReportRoutes()` — CSV export. |
| `Tests.gs` | `runAllTests()` / `runTest(name)` and the `T.*` assertion harness. Run from the editor. |
| `appsscript.json` | The Apps Script manifest: V8 runtime, timezone, OAuth scopes, Web App access settings. Pushed by clasp along with the `.gs` files. |

Each **stub** returns `{}` (or the one or two trivially safe routes it owns) and carries a `// PHASE N —` comment listing the actions that will land there. They are syntactically valid and safe to load, with no half-written handlers. `Tournaments.gs` and `Players.gs` are no longer stubs — they are the Phase 1 code.

### 2.2 `frontend/` — static files, no framework

```
frontend/
  index.html          SPA shell
  404.html            redirects deep links into index.html (GitHub Pages trick)
  css/app.css         mobile-first, plus the dark projector theme
  css/register.css    registration page only
  css/admin.css       admin pages only
  js/config.js        API_BASE_URL (the /exec URL), BASE_PATH and constants
  js/api.js           API.call / API.get / setToken / getToken / clearToken
  js/router.js        hash-free path router
  js/app.js           bootstrap, mounts a page per route
  js/image.js         ImageTool — canvas resize before upload
  js/ui.js            UI — form fields, banners, buttons, progress, dialogs
  js/pages/register.js           RegisterPage
  js/pages/admin-login.js        AdminLoginPage
  js/pages/admin-tournament.js   AdminTournamentPage
```

Two frontend rules from `CONTRACTS-PHASE1.md` §4 that are easy to break:

1. **One owner per file.** Each page has its own page file and its own CSS file. `index.html` and `css/app.css` are shared and are edited by the integration owner only.
2. **`textContent`, never `innerHTML`.** A tournament name comes from the sheet and a tournament id comes from the URL. Both are untrusted.

`js/image.js` resizes photos in the browser before upload — 1024 px longest side, JPEG quality 0.8, plus a 320 px thumbnail. A 4 MB phone photo becomes about 150 KB. The server re-validates every image anyway (`Drive.uploadImage` checks the declared mime, the decoded size and the magic number). The client resize is for speed; the server check is for safety.

**The UPI QR image stays PNG.** It is never re-encoded as JPEG, because JPEG artefacts can make a QR code unscannable.

---

## 3. Two rules that are not negotiable

### 3.1 Only `Repo.gs` may touch `SpreadsheetApp`

No other `.gs` file calls `SpreadsheetApp` at all. Every read and write goes through `Repo`.

Why:

1. **Concurrency is reviewable in one place.** The auction depends on a script lock plus `SpreadsheetApp.flush()` before release. If ten files could write rows, you would have to audit all ten to know the auction is safe. With one file you read one file.
2. **Speed.** Opening a Spreadsheet costs about 500 ms. `Repo.readAll` does exactly one `getValues()` for a whole tab and `Repo.updateRow` writes one contiguous range. Looping `getRange` per cell is 10–100× slower and is the classic way an Apps Script app becomes unusable.
3. **Schema in one place.** `Repo` maps a row array to an object using `HEADERS` from `Config.gs`. Column order changes in one file, not everywhere.

### 3.2 The token goes in the POST body, and the content type must be `text/plain`

Every write is a `POST` to the `/exec` URL with:

- header `Content-Type: text/plain;charset=utf-8`
- body: `{"action": "auction.markSold", "token": "abc...", "payload": { ... }}`

Why: **Apps Script does not answer CORS preflight (`OPTIONS`) requests.** So the browser must send a *simple* request. Two things turn a simple request into a preflighted one:

| Do not do this | What happens |
|---|---|
| `Content-Type: application/json` | Browser sends an `OPTIONS` preflight. Apps Script does not answer it. The call fails with a CORS error. |
| A custom header, e.g. `Authorization: Bearer ...` | Same. Any non-standard header triggers preflight. |

That is why the session token travels **in the JSON body**, never in a header and never in a URL. The server parses the body with `JSON.parse(e.postData.contents)`. If you ever see a CORS error in the console, the first thing to check is that nobody "tidied up" the content type to `application/json`.

---

## 4. Time handling

**Instants are UTC. Calendar dates are IST.**

| Kind | Timezone | Examples |
|---|---|---|
| Instant — created, verified, sold, session expiry | UTC, always | `Util.nowIso()` |
| Calendar date — DOB, tournament dates, registration window | IST (UTC+05:30) | `Util.todayIso()` |

IST is a fixed +05:30 offset. India has never used daylight saving, so this is plain arithmetic — no timezone database, no DST edge cases.

**Every registration-window and date-range check goes through `Util.isWithinWindow`.** Never compare ISO strings directly and never call `Date.parse` on a bare date.

Why it matters: a deadline of `2026-08-31` treated as UTC closes registration at **05:30 IST on the 31st**, silently losing most of the final day. Treated as an IST day it closes at 23:59:59.999 IST, which is what the admin meant.

Full rules and function signatures: `CONTRACTS.md` §6a.

---

## 5. Current status

**Phases 0 and 1 are complete. Phases 2–8 are pending.**

### What works now

An admin can sign in, create a tournament (dates, fee, UPI ID, QR image, logo, rules, contact details), and get a public registration link plus a projector link. A player opens that link on a phone, sees the fee and a large scannable QR code, pays in their own UPI app, fills in name, date of birth, role, style, mobile and UPI reference, uploads a profile photo and a payment screenshot, and gets back a serial number on a confirmation screen. Photos are resized in the browser before upload, serial numbers are allocated inside a script lock so two people submitting at the same instant cannot get the same number, and duplicate mobile numbers and duplicate UPI references are rejected. **Payment verification, the admin player list, teams and the auction are not built yet** — every registration sits at `payment_status = PENDING`.

### Build order (DESIGN.md §19)

| Phase | Content | Status |
|---|---|---|
| 0 | Repo, Sheets, Drive, Apps Script skeleton, auth, `Tests.gs` | **Done** |
| 1 | Tournament creation, registration link, QR, player registration, photo upload, serial numbers | **Done** |
| 2 | Admin list, payment verify/reject, verified pool | Pending |
| 3 | Organiser access, teams, purse, team dashboard | Pending |
| 4 | Auction core — serial lookup, display, sold/unsold, purse, counts, **plus the concurrency test** | Pending. Do not move on until the concurrency test passes. |
| 5 | Projector mode | Pending |
| **5.5** | **Offline resilience pack** | Pending — see DESIGN.md §16 |
| 6 | Reports and CSV export | Pending |
| 7 | Audit log UI, corrections, auction close, final report | Pending |
| 8 | Dress rehearsal and fixes | Pending |

Phase 0 was scaffolding: `setup()`, auth, routing, tests. Phase 1 added the first business logic — see `CONTRACTS-PHASE1.md` for the exact scope.

---

## 6. Hosting the frontend on GitHub Pages

The static site is published by `.github/workflows/pages.yml`, not by a branch deployment.

**Repo Settings → Pages → Source must be set to "GitHub Actions".**

Why: GitHub Pages can only serve from the repository root or from `/docs` when deploying straight from a branch. Our site lives in `frontend/`, so a branch deployment cannot see it. The workflow uploads that one folder instead, which keeps `backend/` and `frontend/` side by side in the repo. There is still no build step — the files are served exactly as committed. The workflow also fails the deploy if `frontend/js/config.js` still holds the placeholder API URL.

`frontend/404.html` handles deep links: Pages returns it for any unknown path, and it bounces into `index.html` so `/register/TRN_xxx` works when typed, scanned or reloaded.

---

## 7. Where to read next

| You want | Read |
|---|---|
| Why it is built this way — trade-offs, risks, quota maths, edge cases | `DESIGN.md` |
| The exact interfaces: sheet columns, error codes, function signatures, route shape | `CONTRACTS.md` |
| Phase 1 specifics: image transport, tournament and registration actions, page behaviour | `CONTRACTS-PHASE1.md` |
| How to set it up, deploy it, test it, and run it on tournament day | `RUNBOOK.md` |

`CONTRACTS.md` is authoritative, and `CONTRACTS-PHASE1.md` extends it. If a contract looks wrong, say so — do not silently deviate.
