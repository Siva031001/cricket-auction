# CONTRACTS — Phase 3 (Organiser Access & Team Management)

Extends `CONTRACTS.md`, `-PHASE1`, `-PHASE2`. All still bind. Rationale: `DESIGN.md` §5.4, §6.4, §6.5b, §15, §16, §17, §31.

Phase 3 scope: giving an organiser scoped access to one tournament, and letting them create and adjust the 8 teams the auction will fill.

**Confirmed setup:** 8 teams, 12 or 13 players each, equal purse. Squad size is **per team**, not one global number.

---

## 1. Organiser access

New file `backend/Organisers.gs`. Organiser actions were pencilled into `Tournaments.gs` in Phase 0; that file is now 1100+ lines and this is a separate concern, so it moves. Update the Phase 0 stub comment there to point here.

Organisers never self-register. An admin creates them, and each is locked to exactly one tournament (`DESIGN.md` §15).

### `organiser.create` — ADMIN, POST

```js
payload = { tournamentId, email, displayName }
→ { user_id, email, display_name, tournament_id, joinUrl, joinExpiresAt, joinExpiresAtDisplay }
```

1. Creates a `Users` row: `role = 'ORGANISER'`, `status = 'ACTIVE'`, `tournament_id` set, **no password yet**.
2. Mints a **one-time join token**: 32 random bytes, stored hashed (`Util.sha256Hex`) — never in plain text. If the sheet leaks, the tokens in it must not be usable.
3. `joinUrl` = `<frontend_base_url>/organiser/join?k=<token>`. The plain token exists only in this one response.
4. Token expires after **72 hours**. Long enough to survive a weekend, short enough to matter.
5. Audited as `ORGANISER_CREATED`.

Reject a duplicate email (case-insensitive) with `VALIDATION_FAILED`.

### `organiser.list` — ADMIN, POST
`{tournamentId}` → `[{user_id, email, display_name, status, created_at, last_login_at, joinPending}]`
`joinPending` is true while the token is unused and unexpired. **Never return the token or its hash.**

### `organiser.resendLink` — ADMIN, POST
Mints a fresh token, invalidating the old one, and returns a new `joinUrl`. Needed because links get lost. Audited.

### `organiser.disable` — ADMIN, POST
`{userId}` → sets `status = 'DISABLED'` and revokes every session for that user. Audited. Does not delete the row — the audit trail references it.

### `auth.organiserJoin` — PUBLIC, POST

```js
payload = { token, password }
→ { token: <session token>, expiresAt, user: {user_id, display_name, role, tournament_id} }
```

Exchanges the one-time join token for a real session and sets the password.

1. Hash the supplied token, look it up. Not found, already used, or expired → `UNAUTHORIZED` with **one generic message** for all three. Distinguishing them tells an attacker which tokens exist.
2. Password rules identical to `Auth.createUser`: minimum 10 characters.
3. **Burn the token** in the same locked section that sets the password. A token that survives its own use is a permanent back door.
4. Audited as `ORGANISER_CREATED` with a `joined: true` marker.

Add `ORGANISER_DISABLED` and `ORGANISER_LINK_RESENT` to the frozen `Audit.ACTIONS` map.

### Where organiser tokens live

Add a `Config`-independent tab? No. Reuse `Users` with three new columns:

```
join_token_hash, join_expires_at, join_used_at
```

Append them to the `Users` header in `Config.gs`. `setup()` rewrites the header row on every run, so this is a re-run, not a migration.

---

## 2. Teams

`backend/Teams.gs`.

### `team.create` — ORGANISER or ADMIN, POST

```js
payload = { tournamentId, teamName, ownerName, purseTotal, maxPlayers, logo }
→ { team_id, team_name, purse_total, max_players, purse_used: 0, players_count: 0 }
```

`purseTotal` and `maxPlayers` default to the tournament's `default_purse` / `default_max_players` when omitted — that is what those fields are for (`DESIGN.md` §6.4).

Validation: `teamName` 2–40 chars and unique per tournament (case-insensitive, whitespace-collapsed); `purseTotal > 0`; `maxPlayers >= 1`.

### `team.createBatch` — ORGANISER or ADMIN, POST

```js
payload = { tournamentId, names: [...], purseTotal, maxPlayers }
→ { created: [...] }
```

Creating 8 teams one at a time is 8 round trips at ~1.5s each. This takes the names and applies the same purse and squad size to all of them, in one locked section. Names must be unique within the batch as well as against existing teams — validate the whole batch before writing any of it, so a duplicate at position 7 does not leave 6 teams created.

### `team.list` — ORGANISER or ADMIN, POST

The team dashboard (`DESIGN.md` §17).

```js
→ {
  teams: [ {team_id, team_name, owner_name, logo_url,
            purse_total, purse_used, purse_remaining,
            purse_total_display, purse_used_display, purse_remaining_display,
            players_count, max_players, slots_remaining,
            per_slot_remaining, per_slot_remaining_display} ],
  totals: { teams, purse_total, purse_used, purse_remaining,
            players_count, slots_total, slots_remaining }
}
```

`per_slot_remaining` is `floor(purse_remaining / slots_remaining)`, or `null` when the squad is full. Because prices are unpredictable (`DESIGN.md` §6.5a), this is the number that actually tells an organiser whether a team is in trouble — surface it rather than making them divide in their head mid-auction.

### `team.squad` — ORGANISER or ADMIN, POST

`{teamId}` → the team plus its players (`DESIGN.md` §31):

```js
{ team: {...}, players: [{serial_no, name, role, style, photo_thumb_url,
                          sold_amount, sold_amount_display, sold_at_display}],
  total_players, total_spent, total_spent_display, purse_remaining_display }
```

Sorted by `sold_at`. One `Repo.readAll(Players)`.

### `team.update` — ORGANISER (before the first sale) or ADMIN (any time), POST

Everything stays changeable (`DESIGN.md` §6.4). Run inside `Repo.withLock` so a squad-size change cannot race a sale. Guards — reject only what would make existing data contradictory:

| Change | Guard | Error |
|---|---|---|
| Raise `maxPlayers` | none | — |
| Lower `maxPlayers` | not below `players_count` | `SQUAD_BELOW_COUNT`, message naming the current count |
| Raise `purseTotal` | none | — |
| Lower `purseTotal` | not below `purse_used` | `PURSE_BELOW_SPENT`, message naming the amount spent |
| Rename | still unique | `VALIDATION_FAILED` |

Audited as `TEAM_UPDATED` with prev/next. If the tournament is `AUCTION_LIVE`, bump the auction version so the projector refreshes.

### `team.delete` — ADMIN, POST
Only while `players_count === 0`, else `TEAM_NOT_EMPTY` — deleting a team with players would orphan them and leave their purse spent against nothing. Audited as `TEAM_DELETED`.

### Who may change what

- **ORGANISER**: create, update, list, squad — freely, until the tournament has any `SOLD` result.
- **ADMIN**: everything, any time, including mid-auction.
- Both go through `Auth.requireTournament`.

Helper: `Teams.hasAnySale(tournamentId)` — true if any `AuctionResults` row for the tournament has `is_current = TRUE` and `status = 'SOLD'`. In Phase 3 that tab is empty, so it always returns false; write it correctly now so Phase 4 does not have to retrofit the permission rule.

---

## 3. Counters

`purse_used` and `players_count` on `Teams` are a **cache**. The append-only `AuctionResults` tab is the truth (`DESIGN.md` §2.6).

- Phase 4 maintains them inside the sale lock.
- `Setup.rebuildCounters(tournamentId)` already recomputes them from `AuctionResults` and stays the recovery path.
- Phase 3 only ever writes zeros at creation. **Never derive a counter by scanning `Players` at read time** — that is a second definition of the same number and it will disagree with Phase 4's.

Add `Teams.recomputeCounters(tournamentId)` returning what changed, and expose it as `team.recount` (ADMIN, POST) so drift is fixable from the UI at 11pm without opening the Apps Script editor.

---

## 4. Validation guard worth having

At team creation, if `purse_total` is small relative to `max_players`, the team may be unable to fill its squad. With unpredictable prices there is no exact threshold, so **do not block** — but `team.list` exposing `per_slot_remaining` gives the organiser the honest number, continuously, which is better than a guess at creation time.

---

## 5. Frontend

| Route | Module | File |
|---|---|---|
| `/organiser/join` | `OrganiserJoinPage` | `js/pages/organiser-join.js` |
| `/organiser/dashboard` | `OrganiserDashboardPage` | `js/pages/organiser-dashboard.js` |
| `/admin/organisers` | `AdminOrganisersPage` | `js/pages/admin-organisers.js` |

Same conventions as Phase 1 §4. Each owns its CSS file.

1. **`/organiser/join`** — reads `?k=`, asks for a password twice, calls `auth.organiserJoin`, stores the session, goes to the dashboard. Show the expiry clearly. A used or expired link must explain what to do next: ask the admin to resend.
2. **Organiser dashboard** — the team dashboard from `DESIGN.md` §17, plus create/edit. Show `per_slot_remaining` per team.
3. **Batch team creation** should be the default path: one form, 8 name fields, shared purse and squad size. Creating 8 teams individually is the slow path, not the main one.
4. **Admin organisers page** — create, list, resend link, disable. The join link is shown **once** with a Copy button and a plain warning that it will not be shown again.

---

## 6. Out of scope

The auction itself, purse arithmetic on sale, projector mode, reports. `AuctionResults` stays empty until Phase 4.
