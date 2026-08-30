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
| Frontend | Static files in `frontend/` | Git push. GitHub Pages serves them. **No build step.** |

---

## 2. Repository layout

```
cricket-auction/
├── backend/            Apps Script (.gs) source. Pushed with clasp.
├── frontend/           Static SPA. Served by GitHub Pages. No build.
├── docs/               Notes and screenshots. Nothing here is executed.
├── DESIGN.md           The why: analysis, trade-offs, risks, phases.
├── CONTRACTS.md        The what: binding interfaces every file must match.
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
| `Tournaments.gs` | **Phase 1 stub.** `TournamentRoutes()`. |
| `Players.gs` | **Phase 1 stub.** `PlayerRoutes()` — registration and validation. |
| `Payments.gs` | **Phase 2 stub.** `PaymentRoutes()` — verify and reject. |
| `Teams.gs` | **Phase 3 stub.** `TeamRoutes()` — teams, purse, squad size. |
| `Auction.gs` | **Phase 4 stub.** `AuctionRoutes()` — the locked critical section. |
| `Reports.gs` | **Phase 6 stub.** `ReportRoutes()` — CSV export. |
| `Tests.gs` | `runAllTests()` / `runTest(name)` and the `T.*` assertion harness. Run from the editor. |
| `appsscript.json` | The Apps Script manifest: V8 runtime, timezone, OAuth scopes, Web App access settings. Pushed by clasp along with the `.gs` files. |

Each stub returns `{}` (or the one or two trivially safe routes it owns) and carries a `// PHASE N —` comment listing the actions that will land there. They are syntactically valid and safe to load, with no half-written handlers.

### 2.2 `frontend/` — static files, no framework

```
frontend/
  index.html          SPA shell
  404.html            redirects deep links into index.html (GitHub Pages trick)
  css/app.css         mobile-first, plus the dark projector theme
  js/config.js        API_BASE_URL (the /exec URL) and constants
  js/api.js           API.call / API.get / setToken / getToken / clearToken
  js/router.js        hash-free path router
  js/app.js           bootstrap, mounts a placeholder per route
```

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

## 4. Current status

**Phase 0 is complete. Phases 1–8 are pending.**

Phase 0 is scaffolding only: `setup()`, auth, routing, tests. There is **no business logic yet** — no registration, payment, team or auction handlers.

Phase 0 is done when all four of these are true:

1. `setup()` builds a working spreadsheet.
2. An admin can log in and get a token.
3. `doPost` routes correctly, and rejects unknown actions, bad methods and bad roles.
4. `runAllTests()` passes against a TEST sheet.

### Build order (DESIGN.md §19)

| Phase | Content | Note |
|---|---|---|
| 0 | Repo, Sheets, Drive, Apps Script skeleton, auth, `Tests.gs` | Foundation |
| 1 | Tournament creation, registration link, QR, player registration, photo upload, serial numbers | Spec Phase 1 |
| 2 | Admin list, payment verify/reject, verified pool | Spec Phase 2 |
| 3 | Organiser access, teams, purse, team dashboard | Spec Phase 3 |
| 4 | Auction core — serial lookup, display, sold/unsold, purse, counts, **plus the concurrency test** | Spec Phase 4. Do not move on until the concurrency test passes. |
| 5 | Projector mode | Spec Phase 5 |
| **5.5** | **Offline resilience pack** | Addition — see DESIGN.md §16 |
| 6 | Reports and CSV export | Spec Phase 6 |
| 7 | Audit log UI, corrections, auction close, final report | Spec Phase 7 |
| 8 | Dress rehearsal and fixes | New |

---

## 5. Where to read next

| You want | Read |
|---|---|
| Why it is built this way — trade-offs, risks, quota maths, edge cases | `DESIGN.md` |
| The exact interfaces: sheet columns, error codes, function signatures, route shape | `CONTRACTS.md` |
| How to set it up, deploy it, test it, and run it on tournament day | `RUNBOOK.md` |

`CONTRACTS.md` is authoritative. If a contract looks wrong, say so — do not silently deviate.
