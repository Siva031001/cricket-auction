# Cricket Tournament Auction Management System — Design & Analysis

Source requirement: `~/Downloads/Cricket Tournament Auction Management System.docx` (58 sections).
This document answers section 58 ("Before Coding"). No code has been written yet.

---

## 0. Summary in one page

**Verdict: the zero-cost plan works.** For up to ~500 players, ~10 operator devices and one live auction at a time, Google Apps Script + Sheets + Drive is enough. Cost is ₹0.

**Six decisions I am recommending:**

| # | Decision | Why |
|---|---|---|
| 1 | Frontend on **GitHub Pages**, backend on **Apps Script** | Clean URLs like `/register/<id>`, page loads in ~0.3s instead of ~2s. Both free. |
| 2 | **Own token login**, not Google login | Apps Script cannot reliably tell you who an anonymous visitor is. Players must not log in at all. |
| 3 | Player photos served from **Drive public thumbnail URLs**; payment screenshots served **only through the API** | Photos need to be fast on a projector. Payment proofs are private and must never sit on a guessable public link. |
| 4 | **Append-only `AuctionResults`** table is the truth; team purse/count are cached numbers | Corrections and disputes need history. Counters can always be rebuilt from history. |
| 5 | Every sale runs inside **`LockService` + a version check** | Stops the same player being sold twice from two browser windows. |
| 6 | Auction polling reads a **CacheService snapshot**, not the Sheet | Opening a Spreadsheet costs ~0.5s. Reading cache costs ~10ms. This is what makes the dashboard feel instant. |

**Four real risks** (detail in §16): venue internet failure, Drive's 15 GB being shared with Gmail, Apps Script deployment mistakes pushing stale code, and payment-screenshot leakage. All have mitigations below.

**Confirmed scale:** 400 players per tournament. That is inside the free-tier limits with room to spare (§13). **Bid model:** every team starts with the same purse; sold prices vary by player and cannot be predicted, so no price rule is enforced (§6.4, §6.5a).

**Three gaps in the requirement** I am flagging:

1. Section 23 says an unsold player "might get sold after sometime", but no control exists to make that happen (§33). Added a `UN-SOLD → PENDING` return-to-pool action (§6.6).
2. With 400 players and only ~100 team slots (8 teams × 12–13), **75% of players will never be called at all**. The three statuses in §21 cannot tell "never called" apart from "waiting to be re-auctioned", and the summary in §27 would report ~260 PENDING with no explanation. Fixed with a `times_called` counter (§6.9). The fairness side of this is yours to decide — see §6.9a.
3. Nothing guards against a typo in the purchase amount. One extra zero during a live auction destroys a team's purse and is only fixable through a correction. Added a consequence line on every confirm, plus three data-driven typo warnings (§6.5a).

---

## 1. Recommended architecture

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

### 1.1 Why split the frontend off Apps Script

Apps Script can serve HTML itself (`HtmlService`). I am not recommending it as the primary option:

| | Apps Script HtmlService | GitHub Pages + Apps Script API |
|---|---|---|
| URLs | `?page=register&t=abc` only | `/register/abc` — as the spec asks |
| First page load | ~1.5–2.5s (runs a script) | ~0.2–0.4s (static CDN file) |
| Runs inside sandbox iframe | Yes — fullscreen and some APIs get awkward | No |
| Projector mode | Works but fights the iframe | Clean |
| Setup effort | One deployment | One deployment + one free repo |
| Cost | ₹0 | ₹0 |

**Fallback:** if a GitHub account is not acceptable, everything below still works with `HtmlService`. Only the routing and the load time change. Keep the API layer identical so switching later is cheap.

### 1.2 The CORS detail (important, easy to get wrong)

Apps Script does not answer `OPTIONS` preflight requests. So the browser must send **simple requests** only:

- Send every write as `POST` with header `Content-Type: text/plain;charset=utf-8`.
- Put the real JSON in the body. Parse it server-side with `JSON.parse(e.postData.contents)`.
- Do **not** set `Content-Type: application/json` — that triggers preflight and the call fails.
- Do **not** send custom headers like `Authorization`. Put the session token **in the JSON body**.

---

## 2. Google Sheets schema

One spreadsheet, 9 tabs. Row 1 is the header. `tournament_id` is on every row (§39).

Types: `str`, `int`, `money` (integer paise or rupees — see note), `bool` (TRUE/FALSE), `iso` (ISO-8601 UTC string), `json` (stringified).

**Money note:** store all amounts as **whole rupees, as integers**. No decimals, no currency symbol, no commas. Format for display only in the browser. This avoids float rounding in purse maths.

### 2.1 `Tournaments`

| Column | Type | Notes |
|---|---|---|
| tournament_id | str | `TRN_` + 12 random chars. Primary key. |
| slug | str | URL-safe, e.g. `chennai-premier-league` |
| name | str | |
| description | str | |
| start_date / end_date | iso | Tournament dates |
| reg_start / reg_end | iso | Registration window (§48) |
| reg_fee | money | |
| logo_file_id | str | Drive ID |
| photo_file_ids | json | Array of Drive IDs |
| qr_file_id | str | UPI QR image |
| upi_id | str | e.g. `name@bank` |
| contact_name / contact_mobile / contact_email | str | |
| rules | str | Long text |
| status | str | `DRAFT` / `REG_OPEN` / `REG_CLOSED` / `AUCTION_LIVE` / `AUCTION_CLOSED` |
| drive_folder_id | str | Root folder for this tournament |
| next_serial | int | Next player serial to hand out. Starts at 1. |
| default_purse | money | Same for all teams. Pre-fills team creation (§6.4). |
| default_max_players | int | Pre-fills team creation (§6.4) |
| display_token | str | Read-only token for the projector URL |
| created_at / created_by | iso / str | |

### 2.2 `Users`

| Column | Type | Notes |
|---|---|---|
| user_id | str | `USR_...` |
| email | str | Login ID. Lowercased. Unique. |
| display_name | str | |
| password_hash | str | Hex. See §5.2. |
| salt | str | 32 random hex chars, per user |
| role | str | `ADMIN` or `ORGANISER` |
| tournament_id | str | Empty for ADMIN. Organisers are scoped to one tournament (§15). |
| status | str | `ACTIVE` / `DISABLED` |
| created_at / created_by | iso / str | |
| last_login_at | iso | |

### 2.3 `Players`

| Column | Type | Notes |
|---|---|---|
| player_id | str | `PLY_...` |
| tournament_id | str | |
| serial_no | int | Unique per tournament, starts at 1, never reused (§9) |
| name | str | |
| dob | iso | Date only |
| age_years | int | Computed at registration, stored (projector shows Age, §19) |
| role | str | `BATSMAN` / `BOWLER` / `ALL_ROUNDER` |
| style | str | `LEFT` / `RIGHT` |
| mobile | str | 10 digits, no country code |
| photo_file_id | str | Drive ID, public folder |
| photo_thumb_url | str | Cached `drive.google.com/thumbnail?...` URL |
| payment_status | str | `PENDING` / `VERIFIED` / `REJECTED` — denormalised from `Payments` for fast filtering |
| auction_status | str | `PENDING` / `SOLD` / `UNSOLD` (§21) |
| times_called | int | 0 = never brought to the auction table. See §6.9. |
| team_id | str | Empty unless SOLD |
| sold_amount | money | Empty unless SOLD |
| sold_at | iso | |
| is_withdrawn | bool | Serial stays reserved (§9) |
| search_blob | str | Lowercased `name + role + style` for cheap search (§32) |
| registered_at | iso | |

### 2.4 `Payments`

| Column | Type | Notes |
|---|---|---|
| payment_id | str | `PAY_...` |
| tournament_id / player_id | str | |
| upi_ref | str | Unique per tournament (§47) |
| amount | money | Copied from `reg_fee` at submit time |
| screenshot_file_id | str | Drive ID in the **private** folder |
| status | str | `PENDING` / `VERIFIED` / `REJECTED` |
| verified_by | str | user_id (§13) |
| verified_at | iso | |
| reject_reason | str | |
| submitted_at | iso | |

### 2.5 `Teams`

| Column | Type | Notes |
|---|---|---|
| team_id | str | `TEM_...` |
| tournament_id | str | |
| team_name | str | Unique per tournament |
| owner_name | str | Optional |
| logo_file_id | str | Optional |
| purse_total | money | §16 |
| purse_used | money | **Cached.** Rebuildable from `AuctionResults`. |
| max_players | int | |
| players_count | int | **Cached.** Rebuildable. |
| created_at / created_by | iso / str | |

### 2.6 `AuctionResults` — append only, never edited

| Column | Type | Notes |
|---|---|---|
| auction_id | str | `AUC_...` |
| tournament_id / player_id | str | |
| serial_no | int | Denormalised for reports |
| status | str | `SOLD` / `UNSOLD` / `RETURNED_TO_POOL` |
| team_id | str | Empty unless SOLD |
| amount | money | Empty unless SOLD |
| auction_time | iso | |
| recorded_by | str | user_id |
| is_current | bool | Only one TRUE row per player |
| supersedes_auction_id | str | Set when this row is a correction (§43) |
| note | str | Reason for correction |

A correction never deletes. It writes a new row, flips the old row's `is_current` to FALSE, and points back at it. This is what settles arguments after the event.

### 2.7 `AuditLog` (§42)

`log_id, timestamp, actor_user_id, actor_role, action, tournament_id, entity_type, entity_id, prev_value(json), new_value(json), user_agent`

Actions logged: `PAYMENT_VERIFIED`, `PAYMENT_REJECTED`, `TEAM_CREATED`, `TEAM_UPDATED`, `PLAYER_SOLD`, `PLAYER_UNSOLD`, `PLAYER_RETURNED_TO_POOL`, `AUCTION_CORRECTED`, `AUCTION_CLOSED`, `AUCTION_REOPENED`, `REGISTRATION_CLOSED`, `ORGANISER_CREATED`, `LOGIN_SUCCESS`, `LOGIN_FAILED`.

### 2.8 `Sessions`

`token, user_id, role, tournament_id, issued_at, expires_at, revoked(bool)`

Kept in the Sheet **and** mirrored into `CacheService` so the common case (validate a token) never opens the Spreadsheet. Cache is the fast path; Sheet is the durable copy for when cache is cold.

### 2.9 `Config`

`key, value, updated_at` — server secret pepper, image size caps, poll interval, feature flags.

### 2.10 Relationships

```
Tournaments 1 ── n Players        (tournament_id)
Tournaments 1 ── n Teams
Tournaments 1 ── n Users          (organisers only)
Players     1 ── 1 Payments       (player_id)
Players     1 ── n AuctionResults (one row is_current = TRUE)
Teams       1 ── n Players        (via Players.team_id, only when SOLD)
```

---

## 3. Google Drive folder structure

```
CricketAuction/                                 (root, owned by the app account)
└── TRN_ab12cd34ef56 - chennai-premier-league/
    ├── public/                                 SHARED: "Anyone with the link" → Viewer
    │   ├── logo.jpg
    │   ├── qr.png
    │   ├── gallery/
    │   └── players/
    │       ├── PLY_xxx.jpg                     ~1024px, ~150 KB
    │       └── PLY_xxx_thumb.jpg               ~320px, ~25 KB
    └── private/                                NOT SHARED. App account only.
        └── payments/
            └── PAY_xxx.jpg
```

**Serving images:**

| Image | How it reaches the browser | Why |
|---|---|---|
| Player photo (dashboard) | `https://drive.google.com/thumbnail?id=<ID>&sz=w320` | Cached by Google's CDN. Instant. |
| Player photo (enlarged, §20) | `...&sz=w1600` | Only fetched when the organiser clicks "View Large Photo" (§38) |
| Tournament logo / QR | `...&sz=w800` | Public anyway |
| **Payment screenshot** | **API only** — `payment.getScreenshot` returns base64, admin token required | A Drive link is unauthenticated. Anyone with the ID sees it. Payment proofs must not be guessable. |

**Pre-warm the projector.** Before the auction starts, the display page should fetch all verified players' `w320` thumbnails once so they sit in browser cache. Then revealing player #27 is instant, not a 400ms network wait in front of an audience.

---

## 4. Apps Script API design

One entry point each for read and write.

- `GET  /exec?action=<name>&...` — public reads only (tournament info, projector state)
- `POST /exec` with body `{"action": "...", "token": "...", "payload": {...}}` — everything else

Every response has the same shape:

```json
{ "ok": true,  "data": {...}, "v": 41 }
{ "ok": false, "error": { "code": "INSUFFICIENT_PURSE", "message": "Team has only ₹40,000 remaining." } }
```

`v` is the auction state version — see §7.

### 4.1 Action list

**Public — no token**

| Action | Notes |
|---|---|
| `tournament.getPublic` | Name, photo, fee, QR, rules, whether registration is open. Nothing else (§46). |
| `player.checkMobile` | Returns `{taken: true/false}`. Rate-limited. |
| `player.register` | Multipart-ish: photo + screenshot as base64 in the JSON body. Returns serial number. |
| `auction.displayState` | Needs `display_token`. Read-only projector feed. |

**Auth**

`auth.login` · `auth.logout` · `auth.me` · `auth.organiserLink` (one-time token → session)

**Admin**

`tournament.create` · `tournament.update` · `tournament.list` · `tournament.get` · `tournament.setStatus`
`player.list` (paged, filterable) · `payment.list` · `payment.getScreenshot` · `payment.verify` · `payment.reject`
`organiser.create` · `organiser.list` · `organiser.disable`
`auction.close` · `auction.reopen` · `dashboard.adminStats` (§35) · `report.export`

**Organiser**

`team.create` · `team.update` · `team.list` · `team.squad`
`auction.getBySerial` · `auction.search` · `auction.markSold` · `auction.markUnsold` · `auction.returnToPool` · `auction.correct` · `auction.state` · `auction.summary` · `auction.history`

### 4.2 File layout in the Apps Script project

```
Code.gs          doGet / doPost, routing, error envelope
Auth.gs          login, tokens, role checks
Repo.gs          the only file that touches SpreadsheetApp
Cache.gs         CacheService wrappers, state version, snapshot build
Tournaments.gs
Players.gs       registration + validation
Payments.gs      verify / reject
Teams.gs
Auction.gs       the locked critical section
Drive.gs         upload, thumbnail URLs, folder creation
Audit.gs
Reports.gs       CSV generation
Util.gs          ids, dates, money, hashing
Tests.gs         see §18
```

**Rule:** only `Repo.gs` may call `SpreadsheetApp`. Everything else goes through it. This is what makes the concurrency and caching behaviour reviewable in one place.

---

## 5. Authentication and access model

### 5.1 Why not Google login

The player registration page must work with **no login at all** (§60). That forces the web app to deploy as *Execute as: Me / Who has access: Anyone*. Under that setting `Session.getActiveUser()` returns empty for outside visitors. So Google identity is not available. We issue our own tokens.

### 5.2 Password storage

Apps Script has no bcrypt. Plan:

1. Per-user random `salt` (32 hex chars) in the `Users` row.
2. A server-side `pepper` in `Config` (never leaves the backend).
3. `hash = HMAC-SHA256(key = pepper + salt, message = password)`, 1,000 iterations, hex encoded.

**Honest limitation:** this is weaker than bcrypt against an offline attack. It is acceptable here because the hash lives in a private Spreadsheet that only the app's Google account can open — there is no public surface to steal it from. If admin accounts are ever more sensitive than this, move admins to Google Sign-In on a second, login-required deployment.

### 5.3 Sessions

- On login: 32-byte random token, stored in `Sessions` and in `CacheService` (TTL 6 h, the cache maximum). Session expiry 12 h.
- Token travels in the JSON body, never in a URL or a header.
- Every write action re-checks: token valid → role allowed → `tournament_id` matches the record being touched.

### 5.4 Organiser access (§15)

Admin generates a one-time link: `/organiser/join?t=<one-time-token>`. Opening it once exchanges the token for a real session and sets a password. The one-time token is then burned. Organisers can only ever see their own `tournament_id`.

### 5.5 Projector access

`/auction/<tournament-id>/display?k=<display_token>` — read-only. It can render the auction but has no action endpoints. Rotatable from the admin screen if the token leaks.

### 5.6 The rule that matters

Every single action re-validates role and tournament scope **on the server**. Hiding a button is not authorisation (§56).

---

## 6. Workflows

### 6.1 Tournament creation
Admin logs in → fills form → server creates the Drive folder tree, sets `public/` sharing, uploads logo/QR, writes the `Tournaments` row with `status = DRAFT`, `next_serial = 1` → returns the registration link. Admin flips to `REG_OPEN` when ready.

### 6.2 Player registration
```
Open /register/<id>
  → server checks reg window; if closed, show "Registration Closed" and stop
  → page shows name, photo, fee, QR, rules
  → player pays in their own UPI app, screenshots it
  → fills form; browser resizes both images (canvas, max 1024px, JPEG 0.8)
  → POST player.register

    OUTSIDE THE LOCK  (slow work, ~2-3s)
      validate all fields
      cheap pre-check: mobile already used? upi_ref already used?   → fail early
      upload photo + thumb   → public/players/
      upload screenshot      → private/payments/

    LOCK  (fast, ~200ms)
      re-check reg window                    (authoritative)
      re-check duplicate mobile              (authoritative)
      re-check duplicate upi_ref             (authoritative)
      serial = Tournaments.next_serial ; next_serial += 1
      write Players row  (payment_status = PENDING, auction_status = PENDING,
                          times_called = 0)
      write Payments row
      SpreadsheetApp.flush()
    UNLOCK

  → return serial number → confirmation screen, downloadable
```

**Why the split.** Serial allocation must be inside the lock or two simultaneous registrations get the same number. But image uploads must be *outside* it — they take ~2–3 seconds, and holding a script-wide lock that long limits the whole system to roughly 20 registrations per minute. Outside the lock, the locked section drops to ~200 ms and the same hardware handles ten times the load. This matters on deadline night (§13).

**Cost of the split.** If the lock's authoritative re-check rejects a registration (someone else used that mobile number in the two seconds while images were uploading), the uploaded files are already in Drive with no row pointing at them. That is rare and harmless. A weekly sweep deletes any file with no matching row. Trading a few orphan files for 10× throughput is the right way round.

**Never skip the re-check.** The cheap pre-check before upload is a courtesy to the user, not a guarantee. Only the check inside the lock decides.

### 6.3 Payment verification (§12, §13)
Admin opens the payment queue (filter = PENDING) → picks a player → sees serial, name, mobile, UPI ref, amount, date, and the screenshot (fetched via API, not a Drive link) → checks it against the bank statement themselves → clicks VERIFY or REJECT (reject needs a reason) → server updates `Payments` and mirrors `payment_status` onto `Players`, records `verified_by` + `verified_at`, writes an audit row.

Only `payment_status = VERIFIED` players enter the auction pool (§14).

### 6.4 Team creation and changes (§16)

**Confirmed setup:** 8 teams, 12 or 13 players each, equal purse. Note that 12 *or* 13 means squad size is **per team**, not one global number — the schema already stores `max_players` on each team row.

**Creation.** `default_purse` and `default_max_players` on the tournament pre-fill the form. Creating 8 teams means typing 8 names and adjusting the odd squad size. Both fields stay editable per team.

Validate: name unique per tournament, purse > 0, max_players ≥ 1.

**Changes — this must stay flexible, so it does.** Nothing is frozen at creation. The only hard rules are the ones that would make existing data contradictory:

| Change | Allowed | Guard |
|---|---|---|
| Raise `max_players` (12 → 13) | Any time, including mid-auction | None |
| Lower `max_players` | Any time | Not below the team's current `players_count`. Message: *"Chennai Warriors already has 12 players. You cannot set the limit to 11."* |
| Raise `purse` | Any time | None |
| Lower `purse` | Any time | Not below `purse_used`. Message names the figure already spent. |
| Rename a team | Any time | Name still unique |
| Add a 9th team | Any time, including mid-auction | None |
| Delete a team | Only while `players_count = 0` | Otherwise the sold players would be orphaned. Release them first. |

**Who can change what:**

- **Organiser** — freely, until the tournament's first `SOLD` result exists.
- **Admin** — any time, including mid-auction.

Every change writes an `AuditLog` row with the previous and new value (§42), and mid-auction changes show a confirmation stating the effect: *"Raising Chennai Warriors to 13 players. They will have 1 slot left and ₹4,75,000."*

All of this runs inside the same lock as the auction (§6.5), so a squad-size change cannot race a sale.

**Why an equal purse matters here.** Because prices are unpredictable (§6.5a), the purse is a real constraint — a team genuinely can overspend early and be unable to fill its squad. Equal purses make that a fair test of judgement rather than an accident of budget. It also makes the team dashboard directly comparable: every "remaining" figure is measured from the same starting point.

### 6.5 Auction — the critical path (§28, §29)

```
markSold(player_id, team_id, amount, expectedVersion)

  LOCK  (LockService.getScriptLock, waitLock 20s)
  ├─ if state version != expectedVersion  → STALE_STATE, tell the client to refresh
  ├─ re-read player row from the Sheet (never trust the client's copy)
  ├─ tournament.status == AUCTION_LIVE ?          else AUCTION_NOT_LIVE
  ├─ player.payment_status == VERIFIED ?          else PLAYER_NOT_ELIGIBLE
  ├─ player.auction_status == PENDING ?           else PLAYER_NOT_PENDING
  ├─ player.team_id is empty ?                    else ALREADY_ASSIGNED
  ├─ amount is a positive integer ?               else INVALID_AMOUNT
  ├─ team.players_count < team.max_players ?      else TEAM_FULL
  ├─ amount <= (purse_total - purse_used) ?       else INSUFFICIENT_PURSE
  ├─ append AuctionResults (SOLD, is_current = TRUE)
  ├─ update Players: auction_status, team_id, sold_amount, sold_at
  ├─ update Teams:   purse_used += amount, players_count += 1
  ├─ append AuditLog
  ├─ SpreadsheetApp.flush()
  ├─ bump state version, rebuild the cached snapshot
  UNLOCK
  → return the new state
```

Two things stop a double sale: the lock serialises the writes, and the re-read inside the lock means the second caller sees `auction_status = SOLD` and is rejected with `PLAYER_NOT_PENDING`. The version check is the third layer — it stops a stale tab from acting on old information even when the action would otherwise be legal.

`markUnsold` is the same shape, minus the team and purse checks.

### 6.5a Purchase amount — genuinely variable

**Confirmed:** the sold price depends on the player's performance and cannot be predicted. There is no standard price, no base price and no increment rule. The organiser types whatever the physical auction settled at, and the app records it (§33).

So there is **no validation on the amount beyond "positive whole rupees"**. Any rule would eventually block a legitimate sale in front of an audience, which is far worse than recording an odd number.

Two safety nets that work without knowing the price in advance:

**1. Always show the consequence before committing.**

> Sell **Raj Kumar (#27)** to **Chennai Warriors** for **₹75,000**?
> Leaves **₹4,75,000** for **3 slots** — ₹1,58,333 per slot.

No judgement, just the arithmetic. The organiser reads it in a second and catches their own mistake. This is the single most valuable guard, and it costs nothing.

**2. Escalate only on the two patterns that are almost always typos.**

Since prices vary, "unusual" has to be measured against the tournament's own data, not a fixed number:

| Trigger | Why it is suspicious | Response |
|---|---|---|
| Amount > 25% of the team's **total** purse | A single player rarely takes a quarter of the budget | Amber banner, tick to proceed |
| Amount > 5× the **highest sale so far** in this tournament | Classic extra-zero | Amber banner, tick to proceed |
| Amount leaves fewer rupees per remaining slot than the **lowest sale so far** | The team probably cannot fill its squad | Amber banner, tick to proceed |

All three are computed from live tournament data, so they get more accurate as the auction goes on. The first few sales trigger nothing, which is correct — there is no history to compare against yet.

**Never blocked.** Every one of these is a tick-box, not a wall. A genuinely huge bid for a genuinely great player must always go through.

### 6.6 Re-auction of unsold players (§23) — my addition
`returnToPool(player_id)` moves `UNSOLD → PENDING`, appends a `RETURNED_TO_POOL` row, and audits it. Without this, section 23's "might get sold after sometime" is impossible. The unsold list on the organiser screen gets a **Return to pool** button next to each player.

### 6.7 Correction (§43)
Admin (or organiser before the auction is closed) opens a sold player → CORRECT → change team and/or amount, or revert to PENDING. Server reverses the old row's effect on the team (purse and count), applies the new one, appends a superseding `AuctionResults` row, and audits both values. All inside the same lock.

### 6.8 Closing (§44)
`auction.close` sets `AUCTION_CLOSED`. After that, every organiser write returns `AUCTION_CLOSED`. Only Admin can reopen, and reopening is audited.

### 6.9 400 players vs ~100 slots — the counting problem

This is the biggest practical consequence of your numbers, and the requirement document does not account for it.

**The arithmetic:** 8 teams × 12–13 players = **96 to 104 slots** for **400 registered players**. Even if every registration is verified, roughly **300 players — 75% — will never be called to the auction table at all**. The auction ends when the teams are full, not when the players run out.

Two things break if this is ignored:

1. **The summary in §27 becomes misleading.** It would read `SOLD 100 / UN-SOLD 40 / PENDING 260`. A player who was called and got no bid, and a player nobody ever looked at, are both invisible in that number — but they are very different things to explain afterwards.

2. **Nothing tells the organiser when to stop.** With no signal, the organiser keeps drawing lottery numbers for players who cannot be bought.

The fix is small. Add `times_called` (int) to `Players`, incremented each time the player is displayed on the auction screen. The four states then read clearly:

| State | Meaning | Report label |
|---|---|---|
| `PENDING`, `times_called = 0` | Never brought to the table | **Not called** |
| `PENDING`, `times_called > 0` | Returned to the pool, waiting for a re-auction (§6.6) | **Awaiting re-auction** |
| `UNSOLD` | Called, nobody bid | **Unsold** |
| `SOLD` | Bought | **Sold** |

And two behaviours:

- **All-teams-full banner.** The moment every team hits `max_players`, the auction dashboard shows: *"All 8 teams are full. 298 players were not called. You can close the auction."* Advisory, not forced — Admin still clicks CLOSE.
- **Reports label the difference.** The Auction Report (§45) uses the four labels above, not the three raw statuses. All 400 paid the fee, so "not called" needs to be a visible, explainable outcome rather than a blank cell.

**Timing:** ~100 sales at even 60 seconds each is under 2 hours, which is very manageable. The pool never runs out, so auction length is set by the slot count, not by the 400.

### 6.9a The 75% problem is not a software problem

I can label it accurately, but I cannot make it fair. Worth deciding before you advertise the fee:

- **400 × ₹500 = ₹2,00,000 collected.** About **₹1,50,000 of that comes from players who will never be called**, because the lottery will fill all 8 squads long before their number comes up.
- Whoever the lottery draws early gets a chance. Everyone else pays and watches.

Three ways to handle it, none of which need code beyond what is already planned:

| Option | What changes |
|---|---|
| **Cap registrations** | Add `max_registrations` to `Tournaments` (e.g. 150). Registration auto-closes when hit. One extra field and one check in §6.2. |
| **Say it upfront** | Put "About 100 of 400 registered players will be selected" on the registration page (§5). Costs nothing, prevents every argument. |
| **Accept it** | If the fee is genuinely an entry/participation fee rather than an auction fee, this is fine — just make sure the wording says so. |

**My recommendation: option 2 at minimum**, whatever else you choose. One sentence on the registration page is the cheapest dispute-prevention available. Tell me if you want `max_registrations` and I will add it to Phase 1.

---

## 7. Concurrency and live updates (§41)

### 7.1 Lock
`LockService.getScriptLock()` — script-wide, so it protects across every user and every device. `waitLock(20000)`. Always release in a `finally`. Keep the locked section short: no image work, no report generation inside a lock.

### 7.2 State version
A single integer in `PropertiesService` per tournament, e.g. `auction_v_TRN_xxx`. Every write that changes the auction bumps it.

### 7.3 The snapshot
After each bump, rebuild one small JSON object and put it in `CacheService`:

```json
{
  "v": 42,
  "current": { "serial": 27, "name": "Raj Kumar", "role": "ALL_ROUNDER",
               "style": "RIGHT", "age": 26, "thumb": "...", "status": "PENDING" },
  "teams": [ { "name": "Chennai Warriors", "remaining": 550000, "count": 7, "max": 12 } ],
  "summary": { "verified": 100, "sold": 72, "unsold": 18, "pending": 10 }
}
```

Keep it under 100 KB — that is the per-key CacheService limit. With 12 teams it will be around 3 KB.

### 7.4 Polling
Projector and organiser poll `auction.state?v=<last>` every **2 seconds**.

- Unchanged → `{"ok":true,"v":42,"same":true}` — about 30 bytes, and the Spreadsheet is never opened.
- Changed → the full snapshot from cache. Still no Spreadsheet read.

Typical unchanged poll is ~80–150 ms. That is what makes it feel live.

**Why not push?** Apps Script has no WebSocket and no server-sent events. 2-second polling is the correct answer here, not a compromise.

**Back-off:** on any error, double the interval up to 15s, and show an amber "reconnecting" dot on screen. Never let the projector silently freeze on stale data — a frozen-but-plausible screen is worse than a visible warning.

---

## 8. Projector mode (§19, §50)

Route: `/auction/<tournament-id>/display?k=<display_token>`

| Element | Treatment |
|---|---|
| Layout | Photo left ~45% of width, details right ~55% (§19) |
| Player name | `clamp(48px, 7vw, 140px)`, bold, uppercase |
| Serial number | Very large, top of the details column |
| Role / style / age | ~4vw, generous line spacing |
| Status pill | Large, colour + **text + icon** |
| Controls | Hidden. Keyboard only: `F` fullscreen, `R` force refresh. |
| Contrast | Near-black `#0B0F14` background, near-white text. Ratio ≥ 12:1. |
| Fonts | System sans. No web font — one less thing to fail at the venue. |
| Reveal | Short fade, ~200 ms. No spinning or bouncing; it reads as lag on a projector. |

**Status colours (§51)** — chosen to survive a washed-out projector and to work for red-green colour blindness. Colour is never the only signal; each pill has a word and a shape.

| Status | Background | Text | Shape |
|---|---|---|---|
| PENDING | Amber `#B45309` | White | ● dot |
| SOLD | Green `#15803D` | White | ✓ tick |
| UN-SOLD | Slate `#475569` | White | ✕ cross |

I deliberately did not use red for UN-SOLD. On a dim projector red-on-dark loses legibility, and red reads as "error" rather than "not sold this round".

**Projector reality checks:**
- Test at the venue's actual resolution, and assume it is 1024×768, not 1080p.
- Assume ~15% of the edges will be cut off. Keep all content inside a safe margin.
- Assume the room is bright. Ratio 12:1, not 4.5:1.

---

## 9. Image strategy (§38)

**In the browser, before upload:** draw to a `<canvas>`, resize so the longest side is ≤1024px, export JPEG at quality 0.8. Typical result 100–200 KB from a 4 MB phone photo. Also produce a 320px thumbnail. Upload both.

**Why client-side:** it saves ~95% of upload time on mobile data, avoids Apps Script's 6-minute runtime doing image work, and keeps Drive usage low.

**Limits enforced on the server too** (never trust the client): accept `image/jpeg` and `image/png` only, reject above 5 MB decoded, verify the base64 actually decodes to an image header.

**Storage estimate:** 400 players × (150 KB photo + 25 KB thumb + 200 KB payment screenshot) ≈ **150 MB**. Against 15 GB free, this is not a constraint.

---

## 10. Reports and export (§45)

Three CSVs: Player List, Team Report, Auction Report — columns exactly as the spec lists them.

Generate server-side as a string, return base64, let the browser trigger the download. For a 400-row export this takes under 2 seconds.

Two details:
1. **Excel and the ₹ sign** — export plain integers with no symbol and no thousands separators. Adding `₹` turns the column into text and breaks totals in Excel.
2. **Mobile numbers** — prefix with `="..."` or Excel eats the leading zero and reformats long numbers into scientific notation.

---

## 11. Validation rules (§47)

| Field | Rule | Message |
|---|---|---|
| Name | 2–60 chars, letters/spaces/dots | "Please enter your full name." |
| DOB | Valid date, age between 8 and 70 at tournament start | "Please check the date of birth." |
| Role | One of the three | — |
| Style | One of the two | — |
| Mobile | Exactly 10 digits, first digit 6–9 (India) | "Enter a 10-digit mobile number." |
| Mobile (duplicate) | Unique within the tournament | "A registration already exists for this mobile number. Please contact the tournament organiser." |
| Profile photo | JPEG/PNG, ≤5 MB, required | "Please upload a clear photo." |
| Payment screenshot | JPEG/PNG, ≤5 MB, required | "Please upload your payment screenshot." |
| UPI reference | 6–35 chars, alphanumeric, unique within the tournament | "This UPI reference number has already been used." |
| Registration window | `now` inside `reg_start`..`reg_end`, evaluated as whole **IST** days | "Registration is closed for this tournament." |

**Dates are IST, instants are UTC.** A deadline of `2026-08-31` means the end of that day in India (23:59:59 IST), not UTC midnight — treating it as UTC would close registration at 05:30 IST and lose most of the final day. All window checks go through `Util.isWithinWindow`; see `CONTRACTS.md` §6a.

Every rule runs **twice** — once in the browser for instant feedback, once on the server because the browser can be bypassed.

---

## 12. Mobile-first registration page (§49)

- Single column, one question block at a time, big tap targets (≥48px).
- QR shown large with a **Download QR Code** button (§8), plus a "copy UPI ID" button as a fallback for players whose app cannot scan a screenshot.
- Image inputs use `capture` hints so the camera opens directly.
- Show an upload progress bar. On a 3G connection a 150 KB upload still takes a few seconds and silence makes people press submit twice.
- **Disable the submit button on first press** and show "Submitting…". Double submission is the single most common cause of duplicate registrations.
- Confirmation screen shows the serial number very large, with a "Save as image" button.

---

## 13. Zero-cost feasibility — the numbers

Quotas for a **free consumer (gmail.com) account**. Google changes these; re-check <https://developers.google.com/apps-script/guides/services/quotas> before the event.

| Limit | Value | Do we hit it? |
|---|---|---|
| Script runtime per execution | 6 min | No. Longest call is a CSV export, ~2s. |
| Simultaneous executions | 30 | No. ~10 devices × 1 poll each. |
| Trigger total runtime | 90 min/day | **Not applicable** — web app requests do not count against this. Only time-based triggers do. |
| `UrlFetch` calls | 20,000/day | We make none. |
| Properties store | 500 KB total, 9 KB per value | Fine — we store small counters. |
| Cache per key | 100 KB, max 6 h | Fine — snapshot ~3 KB. |
| Drive storage | 15 GB (shared with Gmail + Photos) | ~150 MB for 400 players. **1% used.** |
| Sheet cells | 10,000,000 | 400 players × ~27 columns ≈ 10,800. **0.1% used.** |
| POST payload | 50 MB | Largest request ~600 KB. |
| GitHub Pages | 1 GB site, 100 GB/month bandwidth | Not close. |

**Verdict: comfortably free at 400 players.** Storage and cell counts are barely touched. The binding limit is concurrency, not size.

**The one place 400 could bite:** the 30-simultaneous-execution cap, if a large share of 400 players all register in the final hour before the deadline. 400 registrations spread over two weeks is nothing; 200 in one evening is a real risk, because each registration holds the script lock while it uploads two images.

Three mitigations, in order of value:

1. **Do not announce a single hard deadline hour.** Stagger it, or close registration at midday rather than midnight.
2. **Move image uploads outside the lock.** Upload first, then take the lock only for the serial-number allocation and the two row writes. This cuts the locked section from ~3s to ~200ms and raises the safe throughput roughly tenfold. Worth doing regardless — it is a small change in Phase 1.
3. **Queue and retry.** On `SYSTEM_BUSY`, the browser retries after 2–5 seconds with a "Please wait, submitting…" message rather than failing.

With mitigation 2 in place, 400 registrations in one evening is fine.

---

## 14. Performance plan (§54)

| Technique | Effect |
|---|---|
| Never open the Spreadsheet on a poll | Saves ~500 ms per request, and that is the whole game |
| Read whole ranges with `getValues()` once, not cell by cell | 10–100× faster than looping `getRange` |
| Cache tournament config for 6 h | Config almost never changes |
| Batch writes with `setValues()` on a range | One write beats twenty |
| `SpreadsheetApp.flush()` before releasing the lock | Guarantees the next caller sees the write |
| 320px thumbnails on the dashboard, 1600px only on demand | ~85% less image data |
| Pre-warm projector image cache | Reveal is instant |
| Paginate the admin player list (50/page) | Keeps the payload small |

**Target numbers:** unchanged poll under 200 ms; `markSold` under 1.5 s; registration submit under 5 s on mobile data.

---

## 15. Edge cases

Concurrency
1. Two organisers sell the same player at once → lock + re-read; second gets `PLAYER_NOT_PENDING`.
2. Two players register at the same instant → serial allocation is inside the lock.
3. Stale tab acts on old data → version check returns `STALE_STATE`.
4. Two admins verify the same payment → second sees status already `VERIFIED`, treated as a no-op, not an error.
5. Lock timeout at 20s → return `SYSTEM_BUSY` and tell the client to retry once.

Money and counts
6. Purse exactly equal to the bid → allowed (`<=`, not `<`).
7. Bid of ₹0 or negative → rejected.
8. Team at max players → rejected before the purse check, so the message is the accurate one.
9. Correction that would push purse negative → rejected, with the shortfall in the message.
10. Team spends everything early and cannot fill its squad → warn, do not block.

Registration
11. Deadline passes while a form is open → server re-checks at submit; clear message.
12. Same mobile, second attempt → the exact message from §47.
13. Same UPI reference reused → rejected.
14. Photo upload succeeds, screenshot fails → nothing written, player retries; orphan file swept later.
15. Player registers twice with two different numbers → cannot be detected automatically. Admin catches it at verification. Payment queue should group by name similarity as a hint.
16. Player withdraws after verification → mark `is_withdrawn`; serial stays reserved (§9); excluded from the pool.

Auction
17. Unsold player comes back later → `returnToPool` (§6.6).
18. Serial typed that does not exist → "No player with serial 27 in this tournament."
19. Serial exists but payment is not verified → "Player #27 is not verified for auction." Show the payment status so the organiser can act.
20. Auction closed, organiser still has a tab open → every write returns `AUCTION_CLOSED`.
21. Zero teams created → block starting the auction.
22. All players processed → summary screen instead of the player card.
23. **All teams full while ~300 players are still uncalled** → advisory banner, not an error. This is the *normal* ending at 400 players and ~100 slots, not an exception (§6.9).
23a. **Squad size raised mid-auction** (12 → 13) → allowed, audited, runs inside the auction lock so it cannot race a sale (§6.4).
23b. **Squad size lowered below players already bought** → rejected with the current count in the message (§6.4).

Operations
24. **Internet drops at the venue** → see §16.
25. Projector disconnects mid-auction → it recovers on the next successful poll; state lives on the server.
26. Browser refreshed mid-auction → no state in the browser, so nothing is lost.
27. Clock differences between devices → all timestamps are generated server-side, never client-side.
28. **Registration rush on the deadline evening** → lock split (§6.2) plus `SYSTEM_BUSY` retry. Proven by the burst test in §18.

---

## 16. Security risks and mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Payment screenshots leak via a guessable Drive link | **High** | Private folder, never shared. Served as base64 through an admin-token-checked action only. |
| 2 | Spreadsheet accidentally shared | **High** | Owned by a dedicated account. Never "Anyone with the link". Check sharing before go-live. |
| 3 | Organiser token forwarded to the wrong person | Medium | One-time join link, scoped to one tournament, revocable, expires. All actions audited. |
| 4 | Player data scraped via the public endpoint | Medium | `tournament.getPublic` returns tournament fields only. Never a player list (§46). |
| 5 | Registration spam / bot floods | Medium | Rate limit per IP hash in cache; duplicate mobile and UPI-ref checks; admin can bulk-reject. |
| 6 | Weak admin password | Medium | Enforce ≥10 chars. Lock the account for 15 min after 5 failures. Log every attempt. |
| 7 | Display token leaks → public sees the auction | Low | It is read-only, and the auction is public anyway. Rotatable. |
| 8 | Someone finds the `/exec` URL and calls actions directly | Medium | Every action re-checks token, role and tournament scope server-side. The URL being known is expected, not a breach. |
| 9 | Malicious file upload | Low | Type and size checked server-side. Files are never executed, only served as images. |
| 10 | 15 GB Drive shared with Gmail | Medium | **Use a dedicated Google account** for this app. Do not use a personal account whose Gmail is already near full. |
| 11 | Stale deployment serves old code | Medium | See the deployment note in §17.3. |
| 12 | **Venue internet failure** | **High** | See below. |

### The venue internet problem

This is the risk most likely to actually bite, and it is not in the requirement document. A live auction in a hall with 200 people cannot pause for a dead Wi-Fi connection.

Mitigation, and I recommend building it as a small extra phase:

1. Before the auction, the organiser clicks **Download offline pack** — all verified players and their thumbnails into `localStorage` / IndexedDB.
2. If polling fails 3 times in a row, the app switches to **offline mode**: it can still display players and record SOLD/UNSOLD locally, with a visible "OFFLINE — results not yet saved" banner.
3. When the connection returns, queued results sync in order, each still passing full server-side validation. Anything the server rejects is shown to the organiser for a decision.
4. Independently: keep a **paper sheet** as the legal backup. Recommend this to the organiser regardless of what the software does.

Also practical: a phone hotspot as backup, and the projector laptop tethered rather than on venue Wi-Fi.

---

## 17. Deployment

### 17.1 One-time setup
1. Create a **dedicated Google account** (not a personal one).
2. Create the Spreadsheet `CricketAuction-DB` with the 9 tabs from §2.
3. Create the Drive root folder `CricketAuction`.
4. Create an Apps Script project bound to the Spreadsheet.
5. Set `Config` values: pepper secret, image caps, poll interval.
6. Run the `setup()` function once — it creates headers, indexes and the first admin user.
7. Deploy: **New deployment → Web app → Execute as: Me → Who has access: Anyone**. Copy the `/exec` URL.
8. Create a public GitHub repo, enable Pages, put the `/exec` URL in the frontend config.
9. Add `404.html` that redirects into the SPA router, so `/register/<id>` works on GitHub Pages.

### 17.2 Day-to-day
Use `clasp` (free, `npm i -g @google/clasp`) to push code from the local folder. Keep the whole project in git — the Apps Script editor has no real version history.

### 17.3 The deployment trap
Editing the code does **not** change what `/exec` serves. You must go to **Manage deployments → edit the existing deployment → Version: New version → Deploy**. If you instead create a *new deployment* you get a *new URL*, and the frontend keeps calling the old code. This catches almost everyone once. Write it in the runbook.

### 17.4 Environments
Two Spreadsheets and two deployments: `TEST` and `PROD`. Never test against the live tournament data — it writes audit rows you cannot cleanly remove.

---

## 18. Testing strategy

Apps Script has no test runner, so:

1. **`Tests.gs`** — plain functions with a small `assert()` helper, run from the editor against the TEST spreadsheet. Cover: serial allocation, all eight `markSold` validations, purse maths, correction reversal, duplicate mobile, duplicate UPI ref, registration window.

2. **Concurrency test (the important one)** — a script that fires 10 parallel `UrlFetchApp.fetchAll()` calls at `markSold` for the *same* player. Assert exactly 1 success and 9 `PLAYER_NOT_PENDING`. Run the same shape against `player.register` and assert 10 distinct consecutive serials. If this test does not pass, nothing else matters.

3. **Load check** — two runs. (a) 10 simulated pollers for 10 minutes; p95 latency under 300 ms. (b) **Registration burst**: 50 parallel `player.register` calls with real image payloads. Assert 50 distinct consecutive serials, zero duplicates, zero lost registrations. This is the deadline-night scenario from §13 and it is the test that proves the lock split in §6.2 actually works.

4. **Manual checklist** — registration on a real phone on mobile data, projector at 1024×768 viewed from 15 metres, verify/reject flow, full auction of 20 dummy players, a correction, close and reopen, all three exports opened in Excel.

5. **Dress rehearsal** — one full run with ~20 fake players a week before the tournament, on the real projector, in the real hall if possible. This finds problems no unit test will.

---

## 19. Build order

The requirement's 7 phases are sound. I am adding one and reordering slightly, so that the highest-risk piece is proven early rather than last.

| Phase | Content | Note |
|---|---|---|
| 0 | Repo, Sheets, Drive, Apps Script skeleton, auth, `Tests.gs` | Foundation |
| 1 | Tournament creation, registration link, QR, player registration, photo upload, serial numbers | Spec Phase 1 |
| 2 | Admin list, payment verify/reject, verified pool | Spec Phase 2 |
| 3 | Organiser access, teams, purse, team dashboard | Spec Phase 3 |
| 4 | Auction core — serial lookup, display, sold/unsold, purse, counts, **plus the concurrency test** | Spec Phase 4. Do not move on until the concurrency test passes. |
| 5 | Projector mode | Spec Phase 5 |
| **5.5** | **Offline resilience pack** | **My addition — see §16** |
| 6 | Reports and CSV export | Spec Phase 6 |
| 7 | Audit log UI, corrections, auction close, final report | Spec Phase 7 |
| 8 | Dress rehearsal and fixes | New |

---

## 20. Open questions for the tournament owner

Two are now answered. The rest change the build but do not block starting.

1. ~~**Scale**~~ — **Answered: 400 players per tournament.** Comfortably free (§13). Drove the fixes in §6.2, §6.9 and §13.
2. **One tournament or many at once?** The schema supports many (§39). If it is only ever one at a time, some admin screens get simpler.
3. ~~**Minimum bid / bid increment**~~ — **Answered: none.** Sold prices vary by player performance and are unpredictable, so no price rule is enforced. Every team starts with the same purse (`default_purse`), which makes the purse a real and fair constraint (§6.4, §6.5a).
4. ~~**How many teams, and how many players per team?**~~ — **Answered: 8 teams, 12 or 13 players each, must stay changeable.** Squad size is stored per team and is editable at any time, including mid-auction (§6.4). This gives ~100 slots, which drove §6.9 and §6.9a.
4a. **Do you want a registration cap?** With ~100 slots, 400 registrations means 300 people pay and never get called. Adding `max_registrations` is one field and one check (§6.9a). Say yes and it goes into Phase 1.
5. **Team squad rules** — any minimum-players rule, or role quotas (e.g. at least 3 bowlers)? Currently only a maximum is enforced.
6. **Registration refunds** — if a payment is rejected, does the app need to track a refund? With 400 registrations at ₹500 that is ₹2,00,000 collected, so rejections may need a paper trail beyond the audit log.
7. **Who owns the Google account?** It holds all 400 players' data and payment screenshots. It should not be a personal account someone might lose access to.
8. **Venue internet** — wired, Wi-Fi, or hotspot? This decides how much of Phase 5.5 is needed.
