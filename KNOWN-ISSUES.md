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

### 9. Harnesses live in `/tmp` and will be lost
Agents built extensive Node harnesses (`/tmp/pay_test.js`, `/tmp/players_test.js`, `/tmp/teams_test.js`, `/tmp/org_test.js`, front-end DOM stubs). They are the only way to test this code without Google.

`tools/check.js` is committed and covers structure. The behavioural harnesses should be pulled into `tools/` too.

### 10. Stale assertion in a shared harness
`/tmp/pay_test.js` pins `Audit.ACTIONS` at 18 entries; there are now 20 (`PLAYER_WITHDRAWN`, `ORGANISER_DISABLED`, `ORGANISER_LINK_RESENT`). Harness problem, not a code defect.

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
