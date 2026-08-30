# CONTRACTS — Phases 4–7 (Auction, Projector, Offline, Reports, Audit)

Extends all previous contract files. Rationale: `DESIGN.md` §6.5–§6.9, §7, §8, §16, §19, §21–§34, §42–§45.

---

# PHASE 4 — The Auction

`backend/Auction.gs`. This is the highest-risk code in the project. It runs live, in front of an audience, with money attached, and a mistake is visible to everyone in the hall.

## 4.1 The critical section

**Every state-changing auction action runs inside `Repo.withLock`, re-reads from the sheet, and validates there.** Never trust a value the client sent. `DESIGN.md` §6.5 gives the exact order for `markSold`:

```
LOCK
  1. version check     : expectedVersion matches?        else STALE_STATE
  2. re-read player row from the sheet
  3. tournament status == AUCTION_LIVE?                  else AUCTION_NOT_LIVE
  4. Players.isAuctionEligible(player)?                  else PLAYER_NOT_ELIGIBLE
  5. player.auction_status == PENDING?                   else PLAYER_NOT_PENDING
  6. player.team_id is empty?                            else ALREADY_ASSIGNED
  7. amount is a positive whole rupee number?            else INVALID_AMOUNT
  8. team.players_count < team.max_players?              else TEAM_FULL
  9. amount <= team.purse_total - team.purse_used?       else INSUFFICIENT_PURSE
 10. append AuctionResults row (SOLD, is_current TRUE)
 11. update Players  : auction_status, team_id, sold_amount, sold_at
 12. update Teams    : purse_used += amount, players_count += 1
 13. append AuditLog : PLAYER_SOLD, prev and next
 14. Repo.flush()
 15. Cache.bumpVersion(), rebuild snapshot
UNLOCK
```

Order matters: check `TEAM_FULL` **before** `INSUFFICIENT_PURSE` so a full team gets the accurate message rather than a confusing one about money.

**Step 4 must call `Players.isAuctionEligible`.** Do not re-implement `payment_status === 'VERIFIED' && !is_withdrawn` here. A second copy of that rule is how a rejected player reaches the projector (`CONTRACTS-PHASE2.md` §2).

Three independent things prevent a double sale: the lock serialises writes, the re-read at step 2 makes the second caller see `SOLD`, and the version check at step 1 stops a stale tab acting on old information. Keep all three.

## 4.2 Actions

| Action | Auth | Notes |
|---|---|---|
| `auction.getBySerial` | ORGANISER/ADMIN | `{tournamentId, serialNo}` → the player card. Increments `times_called` (see 4.4). |
| `auction.search` | ORGANISER/ADMIN | By serial, name, role, style (`DESIGN.md` §32). Uses `search_blob`. Read-only — never increments `times_called`. |
| `auction.markSold` | ORGANISER/ADMIN | §4.1. `{tournamentId, playerId, teamId, amount, expectedVersion}` |
| `auction.markUnsold` | ORGANISER/ADMIN | Same shape minus team/purse checks. |
| `auction.returnToPool` | ORGANISER/ADMIN | `UNSOLD → PENDING` (`DESIGN.md` §6.6). Appends `RETURNED_TO_POOL`. This action exists because §23 of the requirement says an unsold player may sell later and no other control allows it. |
| `auction.correct` | ADMIN (ORGANISER before auction close) | §4.3 |
| `auction.state` | ORGANISER/ADMIN | The poll. §4.5 |
| `auction.displayState` | PUBLIC + display token | Projector feed. Same snapshot, no controls. |
| `auction.summary` | ORGANISER/ADMIN | §4.6 |
| `auction.history` | ORGANISER/ADMIN | Full `AuctionResults` for the tournament, newest first, including superseded rows. |
| `auction.close` | ADMIN | `AUCTION_LIVE → AUCTION_CLOSED`. After this every organiser write returns `AUCTION_CLOSED`. |
| `auction.reopen` | ADMIN | Audited as `AUCTION_REOPENED`. |

`auction.displayState` is the **second** public action added since Phase 0. Add it to `EXPECTED_PUBLIC` in `tools/check.js`.

## 4.3 Correction — never delete

`DESIGN.md` §43. A correction appends; it never edits history.

1. Inside the lock, reverse the current result's effect on the team (`purse_used -= old_amount`, `players_count -= 1`).
2. Apply the new one.
3. Append a new `AuctionResults` row with `supersedes_auction_id` pointing at the old one, and set the old row's `is_current = FALSE`.
4. Audit `AUCTION_CORRECTED` with both values.
5. Re-validate everything from §4.1 against the *new* team and amount — a correction can overspend a purse just as easily as a fresh sale.

Correcting to `PENDING` (undoing a sale entirely) must also clear `team_id`, `sold_amount` and `sold_at` on the player.

## 4.4 `times_called`

`DESIGN.md` §6.9. With 400 players and ~100 slots, roughly 300 players are never called. `times_called` is what separates "never came up" from "came up and nobody bid".

`auction.getBySerial` increments it. `auction.search` does not — searching to check a name is not the same as bringing someone to the table.

## 4.5 `auction.state` — the poll

This is what makes the projector feel live, and it is a performance contract, not a feature.

```js
payload = { tournamentId, v }        // v = the version the client already has
→ { v, same: true }                  // unchanged: ~30 bytes, NO spreadsheet read
→ { v, ...snapshot }                 // changed: from CacheService, still no spreadsheet read
```

**A poll that finds no change must not open the Spreadsheet.** Opening one costs ~500 ms; reading `CacheService` costs ~10 ms. Two clients polling every 2 s for three hours is ~10,800 requests — at 500 ms each that is wasted quota and a visibly laggy screen.

Snapshot shape (`DESIGN.md` §7.3), kept under 95 KB:

```js
{ v, status,
  current: {serial_no, name, role, style, age_years, photo_thumb_url, auction_status,
            team_name, sold_amount_display} | null,
  teams: [{team_id, team_name, purse_remaining, purse_remaining_display,
           players_count, max_players, per_slot_remaining_display}],
  summary: {eligible, sold, unsold, pending_called, not_called, total_spent_display} }
```

Rebuild the snapshot inside the same lock that bumped the version, so a poll can never see a version newer than the snapshot it fetches.

## 4.6 Summary

`DESIGN.md` §27 plus §6.9's four honest labels:

```js
{ eligible, sold, unsold, awaiting_reauction, not_called,
  total_spent, total_spent_display, teams_full, teams_total,
  all_teams_full }        // true -> the advisory banner
```

`all_teams_full` drives the "All 8 teams are full. 298 players were not called. You can close the auction." banner. Advisory only — the admin still clicks close.

## 4.7 Sold-amount guards

Prices are unpredictable (`DESIGN.md` §6.5a), so there is **no rule on the amount** beyond "positive whole rupees". Instead return advisory flags the UI escalates on. Never block:

```js
warnings: [ {code, message} ]
```

- `LARGE_SHARE_OF_PURSE` — over 25% of the team's total purse
- `FAR_ABOVE_RECENT` — over 5× the highest sale so far in this tournament
- `SQUAD_AT_RISK` — leaves less per remaining slot than the cheapest sale so far

The first few sales trigger nothing; there is no history yet. That is correct.

---

# PHASE 5 — Projector Mode

`frontend/js/pages/display.js` + `frontend/css/display.css`. Route `/auction/:tournamentId/display?k=<display_token>`.

Read-only. It calls `auction.displayState` and nothing else. `DESIGN.md` §8 and §19 of the requirement.

1. **Photo left ~45%, details right ~55%.** Player name `clamp(48px, 7vw, 140px)`. Serial number very large.
2. **Background `#0B0F14`, near-white text, contrast ≥ 12:1.** Assume a bright hall and a washed-out projector.
3. **Assume 1024×768 and ~15% edge crop.** Keep everything inside a safe margin.
4. **System fonts only.** No web font — one less thing to fail at the venue.
5. Status pills carry colour **and** a word **and** a shape: PENDING amber `#B45309` ●, SOLD green `#15803D` ✓, UN-SOLD slate `#475569` ✕.
6. `F` toggles fullscreen, `R` forces a refresh. No other controls visible.
7. **Pre-warm images.** On load, fetch every eligible player's thumbnail once so revealing #27 is instant, not a 400 ms wait in front of an audience.
8. **Never freeze silently.** On poll failure, back off 2 s → 15 s and show an amber "reconnecting" dot. A frozen-but-plausible screen is worse than a visible warning.
9. Reveal transition ~200 ms fade. No spinning or bouncing — it reads as lag on a projector.

---

# PHASE 5.5 — Offline Resilience

`frontend/js/offline.js`. `DESIGN.md` §16. The venue's internet will fail at some point and the auction cannot stop.

1. **`Offline.downloadPack(tournamentId)`** — before the auction, cache every eligible player and their thumbnails into IndexedDB (fall back to localStorage for the JSON only).
2. **Detect failure**: three consecutive poll failures switch to offline mode.
3. **In offline mode** the organiser can still display players and record SOLD/UNSOLD locally, with a permanent, unmissable banner: *"OFFLINE — results are not yet saved."*
4. **On reconnect**, replay the queue in order, each through the normal `markSold` path so full server-side validation still applies. Anything the server rejects is surfaced to the organiser for a decision — never silently dropped, never silently forced.
5. The queue survives a page reload. A browser crash mid-auction must not lose recorded sales.
6. **This is a safety net, not a mode anyone should plan to use.** The UI must always say a paper backup is the real fallback.

---

# PHASE 6 — Reports & Export

`backend/Reports.gs`. `DESIGN.md` §45.

Three CSVs, columns exactly as the requirement lists:

| Action | Contents |
|---|---|
| `report.players` | Serial No, Name, DOB, Role, Style, Mobile, Payment Reference, Payment Status, Auction Status, Team, Purchase Amount |
| `report.teams` | Team, Player, Purchase Amount, Total Players, Total Spent, Remaining Purse |
| `report.auction` | Serial No, Player, Status, Team, Purchase Amount, Auction Time |

Plus `dashboard.adminStats` (`DESIGN.md` §35).

Two details that decide whether the file is usable:

1. **No `₹`, no thousands separators.** Export plain integers. A currency symbol turns the column into text and breaks every total in Excel.
2. **Mobile numbers as `="9876543210"`.** Otherwise Excel strips the leading digit patterns and reformats long numbers into scientific notation.

Auction status uses the four honest labels from `DESIGN.md` §6.9 — **Sold / Unsold / Awaiting re-auction / Not called** — not the three raw statuses. All 400 paid a fee; "not called" must be a visible outcome, not a blank cell.

Return `{filename, mime, base64}`; the browser triggers the download. Generate as a string server-side; a 400-row export is well under 2 s.

---

# PHASE 7 — Audit & Finalisation

1. **`audit.list`** — ADMIN, paged, filterable by action, actor and date range. Read-only, newest first. The `AuditLog` tab is append-only evidence and must never be edited or deleted through any action.
2. **`auction.close` / `auction.reopen`** — Phase 4 §4.2. Closing blocks all organiser writes; only an admin can reopen, and it is audited.
3. **Final tournament report** — `report.final`, combining the admin stats, all team squads and the full auction history into one export.
4. Frontend: `js/pages/admin-audit.js` and a correction dialog on the auction console.

---

## Cross-cutting rules for every phase above

1. Only `Repo.gs` touches `SpreadsheetApp`.
2. Money is whole integer rupees. Display via `Util.formatINR` / `UI.money`.
3. Instants UTC via `Util.nowIso`; calendar dates IST; windows via `Util.isWithinWindow` (`CONTRACTS.md` §6a).
4. `textContent` only on the frontend, never `innerHTML`. All traffic through `API`.
5. Every state change is audited with prev and next values.
6. Handlers return plain data; the dispatcher wraps it in `Util.ok`.
7. One `Repo.readAll` per tab per request. Never `Repo.filterBy` in a loop.
8. New PUBLIC actions must be added to `EXPECTED_PUBLIC` in `tools/check.js`, deliberately.
