# CONTRACTS — Phase 2 (Payment Verification)

Extends `CONTRACTS.md` and `CONTRACTS-PHASE1.md`. Both still bind. Rationale: `DESIGN.md` §11–§14, §16, §42.

Phase 2 scope: the admin player list, manual payment verification and rejection, and the verified player pool that Phase 4's auction draws from.

**The governing rule (`DESIGN.md` §12):** the application never decides that a payment succeeded. A human compares the UPI reference against a bank statement and clicks. Everything here exists to make that comparison fast and to record who decided what, when.

---

## 1. New actions

### `player.list` — ADMIN (or ORGANISER for their own tournament), POST

```js
payload = {
  tournamentId,
  filter: {                         // all optional, AND-ed
    paymentStatus,                  // 'PENDING' | 'VERIFIED' | 'REJECTED'
    auctionStatus,                  // 'PENDING' | 'SOLD' | 'UNSOLD'
    search,                         // matches serial_no, name, mobile, upi_ref
    withdrawn                       // boolean; omitted means "both"
  },
  page: 1,                          // 1-based
  pageSize: 50,                     // max 200
  sort: 'serial_no'                 // serial_no | name | registered_at | payment_status
}
→ {
  rows: [ {serial_no, player_id, name, dob, age_years, role, style, mobile,
           upi_ref, payment_status, auction_status, team_id, sold_amount,
           is_withdrawn, registered_at, registered_at_display,
           photo_thumb_url, payment_id} ],
  page, pageSize, total, totalPages,
  counts: { all, pending, verified, rejected, withdrawn }
}
```

`counts` covers the whole tournament, not the current page — the admin needs "42 still pending" while looking at page 1 of 8.

**One `Repo.readAll(Players)` per call.** Filter, sort and slice in memory. Never call `Repo.filterBy` per row or per page; each call re-reads the entire sheet and 400 players would make the screen unusable.

**Never include `screenshot_file_id` in a list row.** The screenshot is fetched one at a time through the action below, so a file id has no reason to be in a bulk response.

### `payment.list` — ADMIN, POST

The verification queue. Same shape as `player.list` but defaults to `paymentStatus: 'PENDING'`, sorted oldest first, and returns the payment-centric fields from `DESIGN.md` §13:

```js
→ {
  rows: [ {payment_id, player_id, serial_no, name, mobile, upi_ref, amount,
           amount_display, submitted_at, submitted_at_display, status,
           photo_thumb_url, possible_duplicate_of} ],
  page, pageSize, total, totalPages, counts
}
```

`possible_duplicate_of` is a **hint, never a decision** (`DESIGN.md` §15 case 15). A player can register twice from two different mobile numbers, which no unique constraint catches. Set it to the serial number of another player in the same tournament whose name matches case-insensitively after collapsing whitespace, or `null`. Exact-match only — fuzzy matching would produce false accusations against people with common names. The admin decides; the app only points.

### `payment.getScreenshot` — ADMIN, POST

```js
payload = { paymentId }
→ { dataUri, mime, bytes, player: {serial_no, name, mobile}, upi_ref, amount_display }
```

**This is the most sensitive action in the system.** The screenshot is a payment proof living in the private Drive folder that is never shared. It reaches a browser only here, only for an authenticated ADMIN, and only one at a time.

Rules, all load-bearing:
1. `Auth.require(token, ['ADMIN'])` first, then confirm the payment belongs to a tournament this admin may see.
2. Return the bytes as a `data:` URI via `Drive.getAsDataUri`. **Never return the Drive file id or any Drive URL** — a Drive link is unauthenticated, so anyone holding it could read the proof. This is risk #1 in `DESIGN.md` §16.
3. Never batch. There is no `payment.getScreenshots` plural. One request, one screenshot, one audit-able access.
4. Do not cache the data URI in `CacheService` — it is both too large and too sensitive.

### `payment.verify` — ADMIN, POST

```js
payload = { paymentId, note }        // note optional
→ { payment_id, player_id, serial_no, status:'VERIFIED', verified_at_display, counts }
```

Inside `Repo.withLock`:
1. Re-read the payment row.
2. If already `VERIFIED` → **no-op success**, not an error (`DESIGN.md` §15 case 4). Two admins clicking the same row must not produce a scary message. Return the existing state with `alreadyVerified: true`.
3. If `REJECTED` → allowed, but it is a reversal: audit it as such and include `reversedFrom: 'REJECTED'` in the response.
4. Set `status`, `verified_by` (the session user), `verified_at` (`Util.nowIso()`).
5. **Mirror `payment_status = 'VERIFIED'` onto the `Players` row.** The auction pool reads that mirrored field (`DESIGN.md` §14); leaving the two out of step is how an unpaid player reaches the auction table.
6. `Audit.log` `PAYMENT_VERIFIED` with prev and next.
7. `Repo.flush()`.

### `payment.reject` — ADMIN, POST

```js
payload = { paymentId, reason }      // reason REQUIRED, 3-200 chars
→ { payment_id, player_id, serial_no, status:'REJECTED', counts }
```

Same locked shape. `reason` is mandatory — a rejection with no reason is unexplainable to the player who paid, and `DESIGN.md` §16 risk 6 makes disputes an expected part of the day. Missing or too-short reason → `VALIDATION_FAILED`.

Rejecting an already-`VERIFIED` payment is allowed but is a reversal: audit it, mirror the change onto `Players`, and include `reversedFrom: 'VERIFIED'`.

**Rejecting never deletes anything.** The player row, the images and the serial number all stay (`DESIGN.md` §9 — serials are never reused). Only `payment_status` changes.

### `player.setWithdrawn` — ADMIN, POST

```js
payload = { playerId, withdrawn, reason }
→ { player_id, serial_no, is_withdrawn }
```

A player who pulls out after verifying. Sets `is_withdrawn`; the serial number stays reserved forever (`DESIGN.md` §9, §15 case 16). Refuse with `VALIDATION_FAILED` if the player is already `SOLD` — that has to be unwound through the Phase 7 correction flow, not quietly here. Audited.

---

## 2. The verified pool

After Phase 2, exactly one predicate defines auction eligibility:

```
payment_status === 'VERIFIED' && is_withdrawn !== true
```

Expose it as a single helper so Phase 4 cannot drift from it:

```js
Players.isAuctionEligible(playerRow)   // -> boolean
Players.eligibleCount(tournamentId)    // -> number
```

Write it once, here. A second copy of this rule in the auction code is how a rejected player ends up on the projector.

---

## 3. Counts object

Returned by `player.list`, `payment.list`, `payment.verify` and `payment.reject`, always for the whole tournament:

```js
{ all, pending, verified, rejected, withdrawn, eligible }
```

`eligible` uses the §2 predicate. Verify and reject return it so the admin screen can update its header without a second round trip — at 400 players that saves a full sheet read per click.

---

## 4. Audit

Every verify, reject, reversal and withdrawal writes an `AuditLog` row with the actor, both values and a timestamp. `Audit.ACTIONS` already has `PAYMENT_VERIFIED` and `PAYMENT_REJECTED`.

`player.setWithdrawn` has no existing constant. Add `PLAYER_WITHDRAWN` to the frozen `Audit.ACTIONS` map — that is the only permitted edit to `Audit.gs` in this phase.

This trail is what settles a dispute about whether someone actually paid (`DESIGN.md` §42). It is append-only and must never be rewritten.

---

## 5. Out of scope for Phase 2

Teams, purse, the auction and reports. No bulk verify — "verify all pending" would defeat the entire point of a human checking each UPI reference against a bank statement. If it is ever requested, it needs a separate decision, not a convenience button.
