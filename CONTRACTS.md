# CONTRACTS — Phase 0 shared interfaces

**Authoritative.** Every file in this repo must match what is written here. If a contract looks wrong, say so — do not silently deviate. Design rationale lives in `DESIGN.md`; this file is the binding interface.

Target: **Google Apps Script (V8 runtime)** backend + **static SPA** frontend.

---

## 1. Language and style rules

1. **`.gs` files are Apps Script, not Node.** No `require`, no `import`, no `module.exports`, no npm packages. Only Apps Script built-ins (`SpreadsheetApp`, `DriveApp`, `CacheService`, `PropertiesService`, `LockService`, `Utilities`, `ContentService`).
2. V8 runtime is on, so `const`/`let`/arrow functions/template literals/destructuring/spread are all fine.
3. **No top-level executable statements** in any `.gs` file except `const` declarations of plain literals. Apps Script concatenates files in an undefined order, so anything that *runs* at load time is a bug. Function declarations are hoisted globally — rely on that instead.
4. Each module is a single global `const` holding an object literal of functions, e.g. `const Util = { ... }`. Exception: `Code.gs`, which declares the bare `doGet` / `doPost` functions Apps Script requires.
5. Every public function gets a JSDoc block with `@param` and `@return`.
6. Money is **always an integer number of whole rupees**. Never a float, never a string, never with a symbol.
7. Timestamps are **always ISO-8601 UTC strings** produced server-side (`Util.nowIso()`). Never trust a client timestamp.
8. Comments explain *why*, not *what*. Match the density already in the file you are editing.

---

## 2. Response envelope

Every API response is exactly one of:

```js
{ ok: true,  data: <any>, v: <number|null> }
{ ok: false, error: { code: "<ERROR_CODE>", message: "<human readable>" } }
```

- `v` is the auction state version for the tournament, or `null` when not applicable.
- `message` is shown directly to a user, so it must be plain English with real numbers in it. Not `"Validation failed"` but `"Team has only ₹40,000 remaining."`
- Build these with `Util.ok(data, v)` and `Util.err(code, message)`. Do not hand-build the object.

---

## 3. Error codes

Declared in `Config.gs` as `const ERR = { ... }`. Use the constant, never a bare string.

| Code | Meaning |
|---|---|
| `BAD_REQUEST` | Malformed body, unknown action, missing required field |
| `UNAUTHORIZED` | No token, expired token, bad credentials |
| `FORBIDDEN` | Valid token, wrong role or wrong tournament |
| `NOT_FOUND` | Entity does not exist |
| `VALIDATION_FAILED` | Field-level validation, `message` names the field |
| `DUPLICATE_MOBILE` | Mobile already registered in this tournament |
| `DUPLICATE_UPI_REF` | UPI reference already used in this tournament |
| `REGISTRATION_CLOSED` | Outside the registration window |
| `AUCTION_NOT_LIVE` | Tournament status is not `AUCTION_LIVE` |
| `AUCTION_CLOSED` | Auction has been closed |
| `PLAYER_NOT_ELIGIBLE` | Payment not `VERIFIED` |
| `PLAYER_NOT_PENDING` | Auction status is not `PENDING` |
| `ALREADY_ASSIGNED` | Player already has a `team_id` |
| `TEAM_FULL` | `players_count >= max_players` |
| `INSUFFICIENT_PURSE` | Amount exceeds remaining purse |
| `INVALID_AMOUNT` | Not a positive integer |
| `SQUAD_BELOW_COUNT` | New `max_players` is below current `players_count` |
| `PURSE_BELOW_SPENT` | New `purse_total` is below `purse_used` |
| `TEAM_NOT_EMPTY` | Cannot delete a team that has players |
| `STALE_STATE` | Client `expectedVersion` did not match |
| `SYSTEM_BUSY` | Could not acquire the lock in time |
| `INTERNAL_ERROR` | Anything unhandled |

---

## 4. Sheet tabs and headers

Tab names are `const SHEETS` in `Config.gs`. Header arrays are `const HEADERS` in `Config.gs`, keyed by tab name.

**Column order below is binding.** `Setup.gs` writes exactly these headers; `Repo.gs` maps rows to objects using them. Object keys are the header strings verbatim.

```
Tournaments      tournament_id, slug, name, description, start_date, end_date,
                 reg_start, reg_end, reg_fee, logo_file_id, photo_file_ids,
                 qr_file_id, upi_id, contact_name, contact_mobile, contact_email,
                 rules, status, drive_folder_id, next_serial, default_purse,
                 default_max_players, display_token, created_at, created_by

Users            user_id, email, display_name, password_hash, salt, role,
                 tournament_id, status, created_at, created_by, last_login_at

Players          player_id, tournament_id, serial_no, name, dob, age_years, role,
                 style, mobile, photo_file_id, photo_thumb_url, payment_status,
                 auction_status, times_called, team_id, sold_amount, sold_at,
                 is_withdrawn, search_blob, registered_at

Payments         payment_id, tournament_id, player_id, upi_ref, amount,
                 screenshot_file_id, status, verified_by, verified_at,
                 reject_reason, submitted_at

Teams            team_id, tournament_id, team_name, owner_name, logo_file_id,
                 purse_total, purse_used, max_players, players_count,
                 created_at, created_by

AuctionResults   auction_id, tournament_id, player_id, serial_no, status, team_id,
                 amount, auction_time, recorded_by, is_current,
                 supersedes_auction_id, note

AuditLog         log_id, timestamp, actor_user_id, actor_role, action,
                 tournament_id, entity_type, entity_id, prev_value, new_value,
                 user_agent

Sessions         token, user_id, role, tournament_id, issued_at, expires_at, revoked

Config           key, value, updated_at
```

### Enumerations (`const ENUM` in `Config.gs`)

```
TOURNAMENT_STATUS  DRAFT | REG_OPEN | REG_CLOSED | AUCTION_LIVE | AUCTION_CLOSED
USER_ROLE          ADMIN | ORGANISER
USER_STATUS        ACTIVE | DISABLED
PLAYER_ROLE        BATSMAN | BOWLER | ALL_ROUNDER
PLAYER_STYLE       LEFT | RIGHT
PAYMENT_STATUS     PENDING | VERIFIED | REJECTED
AUCTION_STATUS     PENDING | SOLD | UNSOLD
RESULT_STATUS      SOLD | UNSOLD | RETURNED_TO_POOL
```

### ID prefixes (`Util.uid(prefix)`)

`TRN_` tournament · `USR_` user · `PLY_` player · `PAY_` payment · `TEM_` team · `AUC_` auction result · `LOG_` audit row

Format: prefix + 12 lowercase base36 characters. Example `PLY_k3m9x1qz7f2a`.

### Booleans in sheets
Stored as the literal strings `TRUE` / `FALSE`. `Repo` converts to/from real booleans for the fields listed in `Config.BOOLEAN_FIELDS`.

---

## 5. `Repo.gs` — the only file allowed to touch `SpreadsheetApp`

No other file may call `SpreadsheetApp`. Everything goes through here. Every returned row object carries a non-enumerable-ish `_row` property (1-based sheet row number, header is row 1).

```js
Repo.readAll(tab)                      // -> Object[]   one getValues() call
Repo.findBy(tab, field, value)         // -> Object|null   first match
Repo.filterBy(tab, criteria)           // -> Object[]   criteria = {field: value, ...}, AND-ed
Repo.append(tab, obj)                  // -> Object   fills missing columns with ''
Repo.appendMany(tab, objs)             // -> Object[]   single setValues() call
Repo.updateRow(tab, rowNumber, patch)  // -> Object   partial update, single range write
Repo.updateBy(tab, field, value, patch)// -> Object|null
Repo.deleteRow(tab, rowNumber)         // -> void
Repo.count(tab, criteria)              // -> number
Repo.nextSerial(tournamentId)          // -> number   CALLER MUST HOLD THE LOCK
Repo.flush()                           // -> void   SpreadsheetApp.flush()
Repo.withLock(fn, waitMs)              // -> any   runs fn inside a script lock
```

Rules:
1. `readAll` reads the whole tab in **one** `getValues()`. Never loop `getRange` per cell.
2. `updateRow` writes **one** contiguous range, not one cell at a time.
3. `Repo.withLock` uses `LockService.getScriptLock()`, default wait 20000 ms, always releases in a `finally`, and throws `Util.AppError(ERR.SYSTEM_BUSY, ...)` on timeout.
4. `nextSerial` reads `Tournaments.next_serial`, returns it, and writes back `+1`. It does **not** take the lock itself — the caller owns the critical section (see `DESIGN.md` §6.2).

---

## 6. `Util.gs`

```js
Util.uid(prefix)                        // -> "PLY_k3m9x1qz7f2a"
Util.nowIso()                           // -> "2026-08-30T11:42:05.123Z"  UTC instant
Util.todayIso()                         // -> "2026-08-30"  IST calendar date
Util.toInt(v, fallback)                 // -> number
Util.toMoney(v)                         // -> integer rupees, throws INVALID_AMOUNT if not a positive int
Util.formatINR(n)                       // -> "₹10,00,000"  Indian digit grouping
Util.randomToken(byteLen)               // -> hex string, uses Utilities.getUuid + computeDigest
Util.sha256Hex(str)                     // -> hex
Util.hmacSha256Hex(key, msg)            // -> hex
Util.hashPassword(plain, salt, pepper)  // -> hex, 1000 iterations of HMAC (DESIGN §5.2)
Util.slugify(str)                       // -> "chennai-premier-league"
Util.ageYears(dobIso, atIso)            // -> integer years
Util.isValidMobileIN(str)               // -> bool, exactly 10 digits, first digit 6-9
Util.isBlank(v)                         // -> bool
Util.safeJsonParse(str, fallback)       // -> any
Util.ok(data, v)                        // -> { ok:true, data, v: v ?? null }
Util.err(code, message)                 // -> { ok:false, error:{code, message} }
Util.AppError(code, message)            // -> Error with .code, meant to be thrown
```

`Util.formatINR` uses Indian grouping (last 3 digits, then pairs): `1000000` → `₹10,00,000`.

### 6a. Time — instants are UTC, calendar dates are IST

Every user of this system is in India, so a calendar date means an **IST** date. An admin who sets a registration deadline of `2026-08-31` means the end of that day in Chennai. Treating it as UTC closes registration at **05:30 IST on the 31st** — the deadline is short by nearly six hours, and it fails silently.

The split:

| Kind | Timezone | Example |
|---|---|---|
| **Instant** — created, verified, sold, session expiry | **UTC**, always | `Util.nowIso()` |
| **Calendar date** — DOB, tournament dates, registration window | **IST** | `Util.todayIso()` |

IST is a fixed **UTC+05:30**. India has never observed daylight saving, so this is plain arithmetic — no timezone database, no DST edge cases, no ambiguous hours. This is deliberately *not* built on `Utilities.formatDate` with the script timezone, because that silently produces wrong dates if `appsscript.json` is ever wrong or the project is copied.

```js
Util.IST_OFFSET_MIN                          // 330, fixed
Util.istDate(isoInstant)                     // -> "YYYY-MM-DD", the IST day that instant falls on
Util.istDayStartUtc(dateStr)                 // "2026-08-31" -> "2026-08-30T18:30:00.000Z"
Util.istDayEndUtc(dateStr)                   // "2026-08-31" -> "2026-08-31T18:29:59.999Z"
Util.isWithinWindow(startIso, endIso, atIso) // -> bool, inclusive; atIso defaults to now
Util.formatIST(isoInstant, withTime)         // -> "31 Aug 2026, 10:42 AM"
```

**Rules:**
1. Store instants as UTC. Never store a local-time string.
2. **Any registration-window or date-range check must go through `Util.isWithinWindow`.** Never compare ISO strings directly, and never use `Date.parse` on a bare date — `Date.parse('2026-08-31')` is UTC midnight, which is the bug this section exists to prevent.
3. A **10-character bound is a bare date and covers the whole IST day**: a start opens at 00:00:00.000 IST, an end closes at 23:59:59.999 IST. A full instant is used exactly as given. A blank bound is unbounded on that side.
4. Display dates to users with `Util.formatIST`, never a raw ISO string.
5. `Util.ageYears` defaults its "as at" date to `Util.todayIso()`, so ages are computed on the Indian calendar day.

---

## 7. `Auth.gs`

```js
Auth.login(email, password, ua)   // -> {token, expiresAt, user:{user_id,display_name,role,tournament_id}}
Auth.logout(token)                // -> void
Auth.resolve(token)               // -> {user_id, role, tournament_id, expires_at} | null
Auth.require(token, allowedRoles) // -> session, throws UNAUTHORIZED / FORBIDDEN
Auth.requireTournament(session, tournamentId)  // -> void, throws FORBIDDEN
Auth.createUser({email, displayName, password, role, tournamentId}, actorUserId) // -> user (no hash returned)
Auth.setPassword(userId, newPlain)             // -> void
Auth.verifyDisplayToken(tournamentId, token)   // -> bool
```

Rules:
1. Password hash per `DESIGN.md` §5.2 — per-user random salt, server pepper from `Config` tab, 1000 HMAC-SHA256 iterations.
2. Session token = 32 random bytes hex. Written to the `Sessions` tab **and** `Cache.putSession`. `resolve` checks cache first, then the sheet.
3. Session lifetime 12 hours. Cache TTL 6 hours (the Apps Script maximum).
4. Never return `password_hash` or `salt` from any function.
5. Lock the account for 15 minutes after 5 consecutive failures. Track attempts in `CacheService`, not the sheet.
6. `Auth.require(token, null)` means "any authenticated user".

---

## 8. `Cache.gs`

Keys are namespaced: `v:<tid>`, `snap:<tid>`, `sess:<token>`, `cfg:<key>`, `login_fail:<email>`.

```js
Cache.getVersion(tournamentId)          // -> number, 0 if unset
Cache.bumpVersion(tournamentId)         // -> number, the new version
Cache.getSnapshot(tournamentId)         // -> Object|null
Cache.putSnapshot(tournamentId, obj)    // -> void, throws if > 95 KB
Cache.invalidate(tournamentId)          // -> void
Cache.getSession(token) / putSession(token, obj) / delSession(token)
Cache.getConfig(key) / putConfig(key, value) / invalidateConfig(key)
Cache.getRaw(key) / putRaw(key, obj, ttlSec) / del(key)
```

Rules:
1. Version counter lives in `PropertiesService.getScriptProperties()` (durable). Snapshots live in `CacheService.getScriptCache()` (volatile, that is fine — a missing snapshot just gets rebuilt).
2. Max TTL 21600 seconds. Max 100 KB per key — `putSnapshot` throws before hitting the limit.
3. All values are JSON stringified. A parse failure returns `null`, never throws.

---

## 9. `Drive.gs`

```js
Drive.ensureRootFolder()                            // -> folderId of "CricketAuction"
Drive.ensureTournamentFolders(tournamentId, slug)   // -> {rootId, publicId, playersId, galleryId, privateId, paymentsId}
Drive.uploadImage(folderId, base64Data, mimeType, filename)  // -> fileId
Drive.thumbUrl(fileId, width)                       // -> "https://drive.google.com/thumbnail?id=..&sz=w320"
Drive.getAsDataUri(fileId)                          // -> "data:image/jpeg;base64,..."
Drive.deleteFile(fileId)                            // -> void
Drive.setPublicRead(fileOrFolderId)                 // -> void
```

Rules — these are security boundaries, not preferences:
1. `public/` and everything under it is shared `ANYONE_WITH_LINK` / `VIEW`.
2. `private/` is **never** shared. Payment screenshots go there and reach the browser only via `Drive.getAsDataUri` behind an admin token check.
3. `uploadImage` validates: mime is `image/jpeg` or `image/png`, decoded size ≤ 5 MB, and the decoded bytes start with a JPEG (`FF D8 FF`) or PNG (`89 50 4E 47`) magic number. Reject with `VALIDATION_FAILED` otherwise. Never trust the client's declared mime type.
4. Folder creation is idempotent — look up by name inside the parent before creating.

---

## 10. `Audit.gs`

```js
Audit.log({actor, role, action, tournamentId, entityType, entityId, prev, next, ua})  // -> void
Audit.ACTIONS  // frozen map of action-name constants
```

`prev` and `next` are objects; `Audit.log` JSON-stringifies them into the sheet. Never throws — an audit failure must not break the operation it is recording. Log the failure with `console.error` and carry on.

Actions: `PAYMENT_VERIFIED`, `PAYMENT_REJECTED`, `TEAM_CREATED`, `TEAM_UPDATED`, `TEAM_DELETED`, `PLAYER_SOLD`, `PLAYER_UNSOLD`, `PLAYER_RETURNED_TO_POOL`, `AUCTION_CORRECTED`, `AUCTION_CLOSED`, `AUCTION_REOPENED`, `REGISTRATION_CLOSED`, `ORGANISER_CREATED`, `LOGIN_SUCCESS`, `LOGIN_FAILED`, `TOURNAMENT_CREATED`, `TOURNAMENT_UPDATED`.

---

## 11. Routing — `Code.gs`

Apps Script requires bare global `doGet(e)` and `doPost(e)`.

**Request shapes**

- `GET  ?action=<name>&<params>` — public reads only
- `POST` body is JSON text with `Content-Type: text/plain;charset=utf-8`:
  ```json
  { "action": "auction.markSold", "token": "abc...", "payload": { ... } }
  ```

**Why text/plain:** Apps Script does not answer CORS preflight. `application/json` triggers a preflight and the call fails. Do not "fix" this by setting a JSON content type. Never send a custom `Authorization` header for the same reason — the token goes in the body.

**Route table.** Because file load order is undefined, routes are collected lazily inside the request, never at load time:

```js
function buildRoutes() {
  return Object.assign({},
    AuthRoutes(), TournamentRoutes(), PlayerRoutes(), PaymentRoutes(),
    TeamRoutes(), AuctionRoutes(), ReportRoutes()
  );
}
```

Every module exposes a global function `XxxRoutes()` returning:

```js
{
  'player.register': { auth: 'PUBLIC', methods: ['POST'], handler: (payload, session, e) => {...} },
  'payment.verify':  { auth: ['ADMIN'], methods: ['POST'], handler: ... }
}
```

`auth` is `'PUBLIC'`, `'ANY'`, or an array of roles.

**Dispatcher responsibilities, in order:**
1. Parse the body. Malformed → `BAD_REQUEST`.
2. Look up the action. Unknown → `BAD_REQUEST`.
3. Check the method is allowed.
4. If not `PUBLIC`, `Auth.require(token, allowedRoles)`.
5. Call the handler inside `try/catch`.
6. `Util.AppError` → its own code and message. Any other throw → `INTERNAL_ERROR` with a **generic** message, and `console.error` the real one. Never leak a stack trace to the browser.
7. Return `ContentService.createTextOutput(JSON.stringify(envelope)).setMimeType(ContentService.MimeType.JSON)`.

`doGet` uses the same table but only allows routes with `auth: 'PUBLIC'` and `'GET'` in `methods`.

---

## 12. Module stubs

For Phase 0, `Tournaments.gs`, `Players.gs`, `Payments.gs`, `Teams.gs`, `Auction.gs` and `Reports.gs` each contain:
- their `XxxRoutes()` function returning `{}` (or the one or two trivially safe routes noted in the task), and
- a `// PHASE N —` comment listing the actions that will land there, taken from `DESIGN.md` §4.1.

They must be syntactically valid and safe to load. No half-written handlers.

---

## 13. `Setup.gs`

```js
function setup()          // idempotent: create tabs, write headers, seed Config, create Drive root
function seedAdmin(email, displayName, password)   // creates the first ADMIN
function resetTestData()  // TEST env only, refuses to run when env is PROD
function rebuildCounters(tournamentId)  // recompute Teams.purse_used / players_count from AuctionResults
```

`setup()` must be safe to run repeatedly: create a tab only if missing, rewrite the header row always (so a schema change is a re-run), never touch data rows.

Config keys seeded: `env` (`TEST` or `PROD`), `pepper` (generated once, never overwritten if present), `max_image_bytes` (5242880), `poll_interval_ms` (2000), `session_hours` (12), `lock_wait_ms` (20000).

---

## 14. `Tests.gs`

```js
function runAllTests()      // entry point, run from the Apps Script editor
function runTest(name)      // run one suite
```

Harness:
```js
T.suite(name, fn)
T.test(name, fn)
T.assert(cond, msg)
T.assertEqual(actual, expected, msg)
T.assertThrows(fn, expectedCode, msg)
T.assertClose(a, b, tolerance, msg)
```

**Safety rule, non-negotiable:** `runAllTests()` reads the `env` key from the `Config` tab and **refuses to run unless it is `TEST`**. Tests write real rows; running them against the live tournament would pollute the audit log with rows that cannot be cleanly removed.

Output a summary to the log: total, passed, failed, and the message for each failure.

---

## 15. Frontend

Plain HTML/CSS/vanilla JS. **No framework, no build step, no npm dependencies** — it must be servable as static files straight from GitHub Pages.

```
frontend/
  index.html          SPA shell
  404.html            redirects deep links into index.html (GitHub Pages trick)
  css/app.css
  js/config.js        API_BASE_URL and constants
  js/api.js           API.call / API.get
  js/router.js        hash-free path router
  js/app.js           bootstrap, mounts a placeholder per route
```

`js/api.js`:
```js
API.call(action, payload)   // -> Promise<data>, rejects with {code, message}
API.get(action, params)     // -> Promise<data>
API.setToken(t) / API.getToken() / API.clearToken()
```
`API.call` POSTs with `Content-Type: text/plain;charset=utf-8` and injects the stored token into the body. On `!ok` it rejects with the `error` object so callers can switch on `code`.

Routes to stub (render a placeholder with the route name, nothing more in Phase 0):
`/register/:tournamentId` · `/admin/login` · `/admin/dashboard` · `/organiser/dashboard` · `/organiser/auction` · `/auction/:tournamentId/display?k=<display_token>`

The projector route carries the tournament's `display_token` as the `k` query parameter (`DESIGN.md` §5.5). It is read-only and grants no actions, so it is an ordinary query param rather than a session token.

**Hosting note.** GitHub Pages can only deploy from the repo root or `/docs` when serving straight from a branch, so `frontend/` is published by `.github/workflows/pages.yml` instead. Repo Settings → Pages → Source must be set to **GitHub Actions**.

Mobile-first CSS (`DESIGN.md` §49) and a dark high-contrast theme for the projector route (§8/§50). Phase 0 only needs the shell and the tokens, not the screens.

---

## 16. What Phase 0 does NOT include

No business logic. No registration, payment, team or auction handlers. Those are Phases 1–4.

Phase 0 is done when: `setup()` builds a working spreadsheet, an admin can log in and get a token, `doPost` routes and rejects correctly, and `runAllTests()` passes against a TEST sheet.
