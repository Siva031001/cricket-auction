# Known issues and deferred work

Things that are real, understood, and not yet done. Kept here so they survive the build.

Last updated: 2026-08-30.

---

## Must do before the tournament

### 1. Verify EXIF photo rotation on a real phone
**Status:** untested, cannot be tested here.

`frontend/js/image.js` rotates portrait photos using the JPEG SOF marker compared against the decoded size. Node has no `<canvas>`, so only the *call shape* is verified — not that the output actually looks right.

If this is wrong, **every portrait iPhone photo appears sideways on the projector** in front of the audience.

**Test:** take a portrait photo on an iPhone and an Android, register with each, and look at the result on the auction display. Do this before the dress rehearsal, not during it.

### 2. Set `frontend_base_url` in the Config tab
**Status:** seeded empty by `setup()`, deliberately.

The Sheet exists before the website does, so `setup()` cannot know the URL. Until it is set, the registration and projector links the admin copies come back as bare paths like `/register/TRN_xxx` and are not shareable. See `RUNBOOK.md` part 1 step 7a.

### 3. Decide who owns the Google account
**Status:** open question, asked twice, unanswered.

That account holds 400 people's personal data and their payment screenshots, and its 15 GB Drive is shared with Gmail. It should not be a personal account someone might lose access to or fill up.

### 4. Registration cap
**Status:** open question, unanswered.

8 teams × 12–13 = ~100 slots. 400 registrations means **roughly 300 people pay ₹500 and are never called** (`DESIGN.md` §6.9a). Options were: cap registrations, say so on the registration page, or accept it and word the fee as a participation fee.

Adding `max_registrations` is one field and one check. The cheapest option — one sentence on the registration page — costs nothing and prevents every argument on the day.

---

## Functional gaps

### 5. Team logo cannot be changed after creation
`team.create` accepts a logo; `team.update` does not. A Drive upload cannot happen inside the auction lock, and the workaround (upload before the lock, write the id inside it, sweep orphans) was out of scope for Phase 3.

Cosmetic only. The fix is the pattern `Players.register` already uses.

### 5a. Counter drift is now repairable from the UI — RESOLVED
The reports screen detected drift between the cached team totals and the auction history, but only told the admin to "run team.recount" — an action name, not something they could do. It now carries a **Repair the stored totals** button that calls the action and reloads.

The moment this is noticed is likely to be the evening before the auction. Telling someone to open the Apps Script editor then is not a repair path.

### 6. No bulk verify, by design
`CONTRACTS-PHASE2.md` §5. A "verify all pending" button would defeat the point of a human checking each UPI reference against a bank statement. If it is ever wanted, it needs a decision, not a convenience button.

### 7. `player.checkMobile` rate limit is per number
20 calls per 10 minutes for a given mobile. That stops repeated probing of one number, but not enumeration across many. Acceptable: the endpoint returns only `{taken: true|false}` and no personal data.

---

## Test coverage limits

### 8. Real concurrency is untested
`DESIGN.md` §18.2 wants 10 parallel `markSold` calls at one player and 50 parallel registrations. Both need `UrlFetchApp.fetchAll` against a **deployed** URL — a single Apps Script execution is single-threaded and cannot provoke the race.

What exists instead: the lock-boundary test (upload order), the simulated double-sale test, and `Repo.withLock` releasing on a throw. Those are proxies, not proof.

**Run the real test after deploying, before the auction.** This is the one that matters most.

### 9. Harnesses preserved — RESOLVED
All 18 behavioural harnesses are in `tools/harness/`, runnable with `node tools/test.js` (~1650 assertions). `tools/check.js` covers structure (11 checks). `npm test` runs both. All committed.

### 10. Stale harness assertion — RESOLVED
The payments harness pinned `Audit.ACTIONS` at a count of 18; there are now 20. Replaced with an exact-set comparison, which is both stabler (legitimate additions do not break it spuriously) and stronger (it names what changed).

### 10a. Offline replay re-fetches the auction version — RESOLVED
**Two agents found this independently, which is why it is written down.**

`auction.markSold` requires `expectedVersion` and rejects a stale one with `STALE_STATE` (§4.1 step 1). That check is what stops a stale browser tab acting on old data, and it must stay.

But a sale recorded offline captures a version that is guaranteed stale by the time the connection returns. Replaying it verbatim means **every queued sale fails**.

So `Offline.sync(callFn)` takes an injected callback precisely so the caller can attach the *current* version to each item as it replays. `offline.js` classifies `STALE_STATE` as a hard stop with a specific hint, and warns at `enqueue` time if a payload already contains `expectedVersion`.

`OrganiserAuctionPage._syncCall` fetches the current version immediately before each replayed item. Guarded by mutation test M3 in `tools/harness/frontend/organiser-auction.test.js`: replaying the captured version instead of a fresh one makes the suite fail. No bypass was added on either side — the lock and the re-read still block a double sale.


### 13. Can Drive thumbnail URLs be read as bytes from the deployed origin?
**Status:** unknown, and it decides whether offline photos work at all.

`Offline.downloadPack` caches player photos so the display keeps working without internet. But `photo_thumb_url` points at `drive.google.com/thumbnail`, and reading a cross-origin image's *bytes* needs a CORS header Drive does not reliably send. An `<img>` renders fine; `fetch(...).blob()` may not.

`offline.js` therefore takes an injected `imageFn` rather than fetching directly, and refuses with `NO_IMAGE_FETCHER` instead of silently caching nothing.

**Test in a browser against the real deployment.** If the bytes are unreadable, the fallback is to route images through the Apps Script API as base64 — slower, but it works.

### 14. Offline pack: wired, with one honest limitation
The **Download offline pack** control now exists on the auction console, with progress, pack status, and a partial pack reported as PARTIAL rather than ready.

Still open, and it is item 13: photograph bytes may not be readable from Drive cross-origin. When they are not, the console says so plainly — the pack holds player details only, names and serials work offline, pictures do not. It never claims a pack is ready when the photos are missing.

**The display snapshot still carries no roster.** `display.js` pre-warms each thumbnail the first time that player appears, which is best-effort. Adding `roster: [{photo_thumb_url}]` to the `auction.displayState` snapshot would make the "instant reveal" guarantee complete.

### 17. Two harness assertions were passing for the wrong reason — RESOLVED
Worth recording, because both are the failure mode that makes a test suite worthless:

1. **Mutation M8** in `organiser-auction.test.js` spliced in code that did not parse. A `SyntaxError` made the mutant look detected while proving nothing — *any* test would have "caught" it. Now a semantically-wrong-but-runnable mutation.
2. **The setup-warning assertion** in `router-smoke.test.js` counted `.banner--error` after visiting a route that had no page module, so it was detecting the missing-module error panel, not a setup warning. The harness never rendered one. It now renders the warning and asserts it survives navigation.

A test that passes against broken code is worse than no test.

### 15. Withdrawn players in the player export
The 11 CSV columns are fixed by the requirement and none carries withdrawal, so Payment Status renders as `Verified (withdrawn)`. A 12th column would be cleaner if the format can change.

### 16. CSV formula injection is deliberately not neutralised
`_csvCell` does not escape a leading `=`, `+`, `-` or `@`, because `_excelText` emits a real formula on purpose for mobile numbers. Names and UPI references are validated at entry so none can begin with one. Worth revisiting if validation ever loosens.

---

## Deployment

### 11. GitHub Pages Source must be "GitHub Actions"
Pages cannot serve a `frontend/` folder from a branch. `.github/workflows/pages.yml` publishes it instead. The workflow also fails the build if `API_BASE_URL` is still the placeholder.

### 12. The deployment trap
Editing code does not change what `/exec` serves. You must use **Manage deployments → edit the existing deployment → Version: New version**. Creating a *new* deployment gives a *new URL* and the frontend keeps calling the old code. `RUNBOOK.md` part 2.

---

## Decisions recorded, not open

- **Purse is equal across teams; sold prices are unpredictable.** No price rule is enforced — only advisory typo warnings (`DESIGN.md` §6.5a).
- **Squad size is per team** (12 or 13), changeable at any time including mid-auction (`DESIGN.md` §6.4).
- **Serial numbers are never reused**, including after withdrawal (`DESIGN.md` §9).
- **Rejecting a payment deletes nothing.** Only `payment_status` changes.
- **The audit log is append-only.** No action anywhere edits or deletes an audit row.
- **Player names accept any script**, including Tamil and Devanagari, with combining marks.
