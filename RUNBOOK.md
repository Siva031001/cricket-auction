# RUNBOOK

How to set this system up, deploy it, verify it, and run a whole tournament with it.

Assume no prior knowledge of Apps Script or clasp. Follow the numbered steps in order. Where a step says "copy this", the command is meant to be pasted as-is.

**Contents**

1. [Part 1 — One-time setup](#part-1--one-time-setup)
2. [Part 2 — The deployment trap (read this)](#part-2--the-deployment-trap-read-this)
3. [Part 3 — TEST vs PROD](#part-3--test-vs-prod)
4. [Part 4 — Verifying the build](#part-4--verifying-the-build)
5. [Part 5 — Pre-deployment verification checklist](#part-5--pre-deployment-verification-checklist)
6. [Part 6 — The tournament lifecycle, end to end](#part-6--the-tournament-lifecycle-end-to-end)
7. [Part 7 — Registration, step by step](#part-7--registration-step-by-step)
8. [Part 8 — Tournament-day checklist](#part-8--tournament-day-checklist)
9. [Part 9 — Troubleshooting](#part-9--troubleshooting)

The auction hour itself has its own printable card: **`AUCTION-DAY.md`**. This runbook gets you to the point where that card takes over.

---

## Part 1 — One-time setup

You do this once. Budget about an hour the first time.

### 1.1 Create a dedicated Google account

**Do not use your personal Google account.** Create a fresh one, for example `myclubauction@gmail.com`.

Why this matters:

1. A free Google account gets **15 GB of Drive storage, and Gmail, Drive and Google Photos all share it**. If your personal account already has 14 GB of email and holiday photos, this app will hit the storage wall in the middle of registration, and uploads will start failing.
2. This account will hold 400 players' personal details and **their payment screenshots**. That should not sit in someone's private mailbox.
3. If the person who owns the personal account leaves the club or loses the password, the tournament data goes with them.

The app needs about 150 MB for 400 players, so on a dedicated account storage is a non-issue.

Log in as this new account for every remaining step in Part 1.

### 1.2 Create the Google Sheet

1. Go to <https://sheets.google.com> and create a new blank spreadsheet.
2. Rename it `CricketAuction-DB-PROD`.
3. Leave it empty. Do **not** create the tabs by hand — `setup()` does that, and it does it in the exact column order the code expects.
4. Check the sharing setting: click **Share** and make sure it says **Restricted**. It must never be "Anyone with the link".

### 1.3 Create the Apps Script project, bound to that Sheet

This is important: the script must be **container-bound** to the Sheet, not a standalone script. A bound script can reach its own spreadsheet with `SpreadsheetApp.getActive()`; a standalone one cannot, and `setup()` will fail.

1. With the Sheet open, click **Extensions → Apps Script**.
2. A new editor tab opens with an empty `Code.gs`. This project is now bound to the Sheet.
3. Click **Project Settings** (the gear icon on the left).
4. Tick **Show "appsscript.json" manifest file in editor**.
5. Copy the **Script ID** shown on that page. You need it in step 1.5.

### 1.4 Install clasp

clasp is Google's command-line tool for pushing local `.gs` files into an Apps Script project. It is free.

```bash
# from the repo root
npm install
```

That installs clasp as a local dev dependency. If you would rather have it globally:

```bash
npm install -g @google/clasp
```

Then log in. This opens a browser window — sign in as the **dedicated account from step 1.1**, not your personal one.

```bash
npx clasp login
```

### 1.5 Point clasp at your script

```bash
cp .clasp.json.example .clasp.json
```

Open `.clasp.json` and replace `PASTE_YOUR_SCRIPT_ID_HERE` with the Script ID you copied in step 1.3.

`.clasp.json` is in `.gitignore` on purpose — it holds your real script ID. The `.example` file is what gets committed.

### 1.6 Push the code

```bash
npm run push          # runs tools/check.js first, then clasp push
```

`npm run push` refuses to push if the static checks fail. That is deliberate — a duplicate global is a fatal load error that takes the whole web app down. Use `npx clasp push` directly only if you know why you are bypassing it.

Answer yes if it asks to overwrite the manifest. Now refresh the Apps Script editor tab. You should see all 17 `.gs` files from `backend/`.

### 1.7 Run `setup()`

1. In the Apps Script editor, open `Setup.gs`.
2. In the function dropdown at the top, select **`setup`**.
3. Click **Run**.
4. The first run shows an authorisation dialog. Click **Review permissions**, pick the dedicated account, then on the "Google hasn't verified this app" screen click **Advanced → Go to (project name) (unsafe)**, then **Allow**. This is normal for your own private script.
5. Watch the execution log at the bottom. It should report the tabs it created.

`setup()` is idempotent: it creates a tab only if it is missing, rewrites the header row every time, and never touches data rows. So it is safe to re-run after a schema change.

It creates the 9 tabs — `Tournaments`, `Users`, `Players`, `Payments`, `Teams`, `AuctionResults`, `AuditLog`, `Sessions`, `Config` — and seeds these `Config` keys:

| Key | Seeded value |
|---|---|
| `env` | `TEST` (change it to `PROD` on the live sheet) |
| `max_image_bytes` | `5242880` |
| `poll_interval_ms` | `2000` |
| `session_hours` | `12` |
| `lock_wait_ms` | `20000` |
| `frontend_base_url` | **empty on purpose** — see 1.7a |

**`env` is seeded as `TEST`. Set it to `PROD` on the live sheet.** Open the `Config` tab and check the value. See Part 3 for why this matters.

It also creates the Drive root folder `CricketAuction`.

### 1.7a Fill in the `frontend_base_url` key

`setup()` seeds this key empty, because it cannot know your Pages address until step 1.11. Fill it in by hand.

1. Open the `Config` tab.
2. Find the row with key `frontend_base_url`.
3. Set the value to your GitHub Pages site root, with **no trailing slash**, for example:

```
https://myclub.github.io/cricket-auction
```

Why it matters: three links are built from this value —

| Link | Returned by | Shape |
|---|---|---|
| Registration link | `tournament.create` / `tournament.get` as `registrationUrl` | `<base>/register/<tournamentId>` |
| Projector link | `tournament.create` / `tournament.get` as `displayUrl` | `<base>/projector/<tournamentId>?k=<display_token>` |
| Organiser join link | `organiser.create` / `organiser.resendLink` as `joinUrl` | `<base>/organiser/join?k=<token>` |

The admin dashboard also shows an **OBS overlay link** (`<base>/stream/<tournamentId>?k=<display_token>`)
and a **public viewer link** (`<base>/watch/<tournamentId>?k=<display_token>`). These reuse the same
`display_token` as the projector link — the frontend builds them locally, the backend does not return
them separately. All four public/broadcast links share one flat shape: `/<page>/<tournamentId>?k=<key>`.
The older `/auction/<tournamentId>/display?k=<display_token>` path still works (it is an alias for the
same page) but new links are generated as `/projector/<tournamentId>?k=...` going forward.

If it is unset or blank you get **path-only links** like `/register/TRN_abc` — which look fine in the admin screen but are useless when pasted into WhatsApp.

Come back and do this step after step 1.11 if you do not know the address yet. Nothing else depends on it.

### 1.8 Run `seedAdmin()`

This creates the first ADMIN user. There is no sign-up screen, so this is the only way in.

1. In the editor, open `Setup.gs`.
2. Temporarily add a tiny wrapper at the bottom so you can pass arguments (the Run button cannot pass them):

```js
function seedAdminOnce() {
  seedAdmin('admin@example.com', 'Tournament Admin', 'a-long-password-here');
}
```

3. Select **`seedAdminOnce`** in the dropdown and click **Run**.
4. Check the `Users` tab: one row, role `ADMIN`, `tournament_id` empty.
5. **Delete `seedAdminOnce` and run `npm run push` again.** Do not leave a password sitting in the source.

Password rule: at least 10 characters. The account locks for 15 minutes after 5 failed logins.

Create any further admins through the app, not through `seedAdmin()`.

### 1.9 Deploy as a Web App

1. In the editor, click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Fill in:

| Field | Value | Why |
|---|---|---|
| Description | `PROD v1` | So you can tell deployments apart later |
| Execute as | **Me** (the dedicated account) | The script must open the Sheet and Drive as the owner |
| Who has access | **Anyone** | Players register with no login at all. This is required, not optional. |

4. Click **Deploy**, authorise if asked.
5. Copy the **Web app URL**. It ends in `/exec`. It looks like:

```
https://script.google.com/macros/s/AKfycb.....................abc/exec
```

"Who has access: Anyone" sounds alarming. It is fine: every action re-checks the token, the role and the tournament scope on the server. The URL being public knowledge is expected, not a breach.

Also note the **deployment id** now, from **Deploy → Manage deployments** or `npx clasp deployments`. Every future deploy reuses it:

```bash
npm run deploy -- <deploymentId>
```

Using the same id every time is the whole point — see Part 2.

### 1.10 Put the `/exec` URL in the frontend

Open `frontend/js/config.js` and set:

```js
API_BASE_URL: 'https://script.google.com/macros/s/AKfycb...../exec',
```

Use the `/exec` URL, not the `/dev` one. `/dev` only works while you are logged in as the owner.

Check `BASE_PATH` in the same file while you are there. GitHub Pages project sites are served from a sub-path, so it must match your repo name — `'/cricket-auction'` by default. If you rename the repo, change it here **and** in the copy inside `frontend/404.html`. If you host at a domain root, set it to `''`.

### 1.11 Create the GitHub repo and enable Pages

1. Create a **public** repo on GitHub (Pages is free on public repos).
2. Push this repository to it, on the `main` branch.
3. In the repo, go to **Settings → Pages**.
4. Under "Build and deployment", set **Source: GitHub Actions**.

   This is not optional. Pages can only serve from the repo root or `/docs` when deploying straight from a branch, and our site lives in `frontend/`. The workflow at `.github/workflows/pages.yml` uploads that folder instead. It runs on every push to `main` that touches `frontend/`, and you can also run it by hand from the **Actions** tab.
5. Watch the **Actions** tab for the first run. If it fails with "config.js still has the placeholder API_BASE_URL", go back to step 1.10.
6. Open the URL GitHub shows, usually `https://<user>.github.io/<repo>/`.
7. Confirm `frontend/404.html` is present. GitHub Pages returns it for any unknown path, and it redirects into `index.html` so deep links like `/register/TRN_xxx` work.
8. Put that site root into the `frontend_base_url` Config key (step 1.7a).

There is no build step. GitHub Pages serves the files exactly as they are in the repo.

### 1.12 Create the first organiser

Do this **after** a tournament exists (Part 6 step 1), because an organiser is locked to exactly one tournament for the life of the account. Organisers never sign up for themselves.

1. Sign in as admin and go to `/admin/organisers`.
2. Pick the tournament, enter the organiser's **email** and **display name**, and create.
3. The screen shows a **one-time join link**, once:

```
https://myclub.github.io/cricket-auction/organiser/join?k=<token>
```

Five facts about that link, all of which matter:

| # | Fact |
|---|---|
| 1 | **It is shown exactly once.** The plain token appears only in this one response. Only its SHA-256 digest is stored, so nobody — including you — can recover it from the sheet. Copy it now. |
| 2 | **It expires after 72 hours.** Long enough to survive a weekend, short enough to matter. The expiry is shown next to the link. |
| 3 | **It is one-time.** Opening it burns the token in the same locked section that sets the password. |
| 4 | **Resending invalidates the old one.** `organiser.resendLink` (the **Resend link** button) mints a fresh token and the previous link stops working immediately. Use it whenever a link is lost or expired. |
| 5 | **The organiser sets their own password** on that page — minimum 10 characters, entered twice. You never know or set it. |

4. Send the link to the organiser directly. They open it, set a password, and land on the organiser dashboard with a real session.
5. To revoke access, use **Disable**. It sets `status = DISABLED` and revokes every session for that user immediately. It never deletes the row — the audit trail references it.

Repeat for each organiser. There is no limit, but each one is scoped to one tournament.

---

## Part 2 — The deployment trap (read this)

**Editing the code does NOT change what your `/exec` URL serves.**

This catches almost everyone at least once, usually late at night, usually the day before the tournament. Read this part twice.

### What actually happens

A Web App deployment is pinned to a **version** — a frozen snapshot of the code. `clasp push` only updates the *editor* copy. The deployment keeps serving the old snapshot until you explicitly point it at a new version.

So after every code change you must do **two** things:

```
1. clasp push          -> updates the editor copy
2. re-deploy           -> makes the /exec URL serve it
```

### The correct way to re-deploy

1. In the Apps Script editor, click **Deploy → Manage deployments**.
2. Find your **existing** deployment (the one whose URL is in `frontend/js/config.js`).
3. Click the **pencil / Edit** icon on that row.
4. In the **Version** dropdown, choose **New version**.
5. Optionally type a description, for example `fix purse rounding`.
6. Click **Deploy**.

The URL does **not** change. That is the whole point.

From the command line the equivalent is `npm run deploy -- <deploymentId>`, using the **same** deployment id every time.

### The wrong way, and what it looks like

If you instead click **Deploy → New deployment**, Apps Script creates a **second, separate deployment with a brand new `/exec` URL**. Your old URL still exists and still serves the **old code**. The frontend is still pointed at the old URL. So:

- You change the code.
- You "deploy".
- You test in the browser.
- Nothing changes.
- You change the code again, deploy again, still nothing.

Everything looks broken, and the fix you already wrote looks like it does not work.

### Side-by-side

| | Manage deployments → Edit → New version | New deployment |
|---|---|---|
| URL | **Same** | **Different** |
| Frontend keeps working | Yes | No — still calls the old code |
| Use this | **Always, for every update** | Only once, at first setup (step 1.9) |

### The 30-second check

After re-deploying, in the browser console on your Pages site:

```js
fetch(API_BASE_URL + '?action=tournament.getPublic&tournamentId=TRN_xxx')
  .then(r => r.json()).then(console.log)
```

If you see behaviour from the code you just wrote, the deployment took. If not, go back to **Manage deployments** and check you edited the deployment whose URL matches `frontend/js/config.js`.

**Rule of thumb: you should create a new deployment exactly twice in this project's life — once for TEST and once for PROD. Every other deploy is an edit of an existing one.**

---

## Part 3 — TEST vs PROD

You run two of everything.

| | TEST | PROD |
|---|---|---|
| Google Sheet | `CricketAuction-DB-TEST` | `CricketAuction-DB-PROD` |
| Apps Script project | bound to the TEST sheet | bound to the PROD sheet |
| Web App deployment | its own `/exec` URL | its own `/exec` URL |
| `Config` tab `env` key | `TEST` | `PROD` |

To create the TEST side, repeat steps 1.2, 1.3, 1.6, 1.7, 1.8 and 1.9 with a second Sheet, and set `env` to `TEST` in its `Config` tab. Keep a second clasp config (swap `.clasp.json`, or use `clasp push --project .clasp.test.json` if you prefer separate files).

### The `env` key is a safety interlock

Two functions read `Config.env` and refuse to run unless it says `TEST`:

| Function | Refuses unless `env` is `TEST` | Why |
|---|---|---|
| `runAllTests()` | Yes | Tests write real rows. Against the live sheet they would create fake players, fake teams and fake sales, and every one of those writes an `AuditLog` row. |
| `resetTestData()` | Yes | It deletes data rows. Against the live sheet that is the whole tournament. |

The reason the guard is on the **data** and not on the code: the same code is pushed to both projects. Only the Sheet knows which world it is. So the check has to read the Sheet.

The audit log is the specific thing you cannot undo. Sales and payments can be corrected — corrections are a first-class feature and they append a superseding row. But a fake audit row cannot be cleanly removed without also destroying the evidence trail that settles disputes after the event. Never test against PROD.

**Before go-live, open the PROD `Config` tab and confirm `env` reads `PROD`.**

---

## Part 4 — Verifying the build

There are **four** levels of verification, cheapest first. Each one covers something the one before it cannot.

### 4a. `npm run check` — static, about a second

```bash
npm run check          # = node tools/check.js
```

Reproduces Apps Script's single-global-scope concatenation in a Node `vm` with stubbed Google services, and checks:

1. No duplicate top-level globals across the 17 backend files (in Apps Script this is a fatal load error that kills the whole project).
2. All files load together; all entry points present (`doGet`, `doPost`, `buildRoutes`, `setup`, `seedAdmin`, `runAllTests`, `resetTestData`).
3. Every cross-module symbol resolves.
4. Only `Repo.gs` touches `SpreadsheetApp`.
5. Schema consistent: 9 tabs, all with headers.
6. The route table builds — currently **48 actions** — and the PUBLIC set is exactly the 7 pinned in `EXPECTED_PUBLIC`.
7. Frontend: no duplicate globals, no `innerHTML` / `eval` / `document.write`, no `fetch` outside `api.js`, and every file `index.html` references exists.

**It does not test behaviour.** There is no Spreadsheet, so nothing here proves a purse subtracts correctly.

It prints a `note` while `config.js` still has the placeholder API URL. That is expected until step 1.10.

### 4b. `npm test` — behavioural, a few seconds

```bash
npm test               # = node tools/check.js && node tools/test.js
```

Runs the static checks, then the behavioural harnesses — **18 of them** (7 backend, 11 frontend), about **1600 assertions**. They load the real `.gs` and real page code into Node against in-memory fakes for Sheets, Drive, Cache, Properties and Lock, plus a fake DOM. They cover purse arithmetic, lock ordering, duplicate detection, paging maths, XSS escaping, CSV encoding and offline replay classification.

Run one group with `node tools/test.js auction`.

**It does not prove real concurrency, and it does not prove real Google behaviour.** The fakes are single-threaded.

### 4c. `backend/Tests.gs` — the real suite

Runs inside the Apps Script editor, against a real Spreadsheet, real Drive and real `LockService`.

1. Open the **TEST** Apps Script project (Extensions → Apps Script from the TEST sheet).
2. Confirm the TEST sheet's `Config` tab has `env` = `TEST`. **If it does not, the run stops immediately and tells you so.** This is the interlock from Part 3.
3. Open `Tests.gs`.
4. In the function dropdown, select **`runAllTests`**.
5. Click **Run**.
6. Open the **Execution log** panel at the bottom.

You are looking for a summary line with the total, the passed count and the failed count, followed by a message for each failure. A clean run means zero failures.

To run one suite instead of everything, add a small wrapper and run that:

```js
function runOne() { runTest('auction'); }
```

Notes:

- A run can take a minute or two. The Apps Script execution limit is 6 minutes per run; if you get near it, run suites individually.
- If you changed code, `npm run push` first. The editor runs the editor copy, so tests do **not** need a re-deployment — only the `/exec` URL does.
- Call `resetTestData()` if the TEST sheet gets cluttered.

### 4d. The concurrency test — the one that matters

`KNOWN-ISSUES.md` item 8, `DESIGN.md` §18.2.

**Nothing above proves that two browsers cannot sell the same player twice.** A single Apps Script execution is single-threaded and a Node fake serialises everything, so neither can provoke the race. The only way to provoke it is to fire genuinely parallel HTTP requests at a **deployed** URL.

Write a throwaway function in the **TEST** Apps Script project that uses `UrlFetchApp.fetchAll()` against the deployed **TEST** `/exec` URL:

| Test | Fire | Assert |
|---|---|---|
| Double sale | 10 parallel `auction.markSold` for the **same** player | Exactly **1** success. The other 9 fail with `PLAYER_NOT_PENDING` (or `STALE_STATE`). |
| Serial allocation | 10 parallel `player.register` | 10 **distinct, consecutive** serial numbers. |
| Registration burst | 50 parallel `player.register` with real image payloads | 50 distinct consecutive serials, zero duplicates, zero lost registrations. |

Three independent mechanisms are supposed to make this pass: the script lock serialises writes, the re-read inside the lock makes the second caller see `SOLD`, and the `expectedVersion` check stops a stale tab acting on old information. This test is what shows all three are actually wired up in the deployed code.

**If this test does not pass, nothing else matters.** Run it after deploying and before the auction. Delete the function afterwards.

---

## Part 5 — Pre-deployment verification checklist

Do these four in this order. Do not skip ahead — each one only makes sense if the previous one is green.

| # | Step | Command / place | Pass condition |
|---|---|---|---|
| 1 | **Run the local suite** | `npm test` from the repo root | Every harness passes, 0 failed assertions, static checks all green |
| 2 | **Deploy** | `npm run push`, then **Deploy → Manage deployments → edit the existing one → Version: New version** (Part 2) | The 30-second check in Part 2 shows your new code |
| 3 | **Run the real suite** | `runAllTests` in the **TEST** Apps Script editor (Part 4c) | Zero failures in the execution log |
| 4 | **Run the concurrency test** | `UrlFetchApp.fetchAll()` against the deployed **TEST** `/exec` URL (Part 4d) | 1 success and 9 rejections; distinct consecutive serials |

**Step 4 is the one that actually proves two browsers cannot sell the same player twice.** Steps 1–3 are proxies: they test the logic, not the race. A green `npm test` and a green `runAllTests` with a failing step 4 means the auction is not safe to run.

Then, before go-live on PROD:

5. PROD `Config` tab: `env` reads `PROD`.
6. PROD `Config` tab: `frontend_base_url` is your real Pages root, no trailing slash.
7. The PROD Sheet's sharing is **Restricted**.
8. `frontend/js/config.js` points at the **PROD** `/exec` URL, and the Pages Actions run is green.
9. `KNOWN-ISSUES.md` items 1 and 13 tested on real hardware: a portrait iPhone photo appears the right way up on the projector, and **Download offline pack** on the auction console actually caches photos.

---

## Part 6 — The tournament lifecycle, end to end

This is the whole job, in order. Each step points at the part that explains it; nothing is repeated here.

| # | Step | Who | Where | Detail |
|---|---|---|---|---|
| 1 | **Create the tournament** | Admin | `/admin/dashboard` | Part 7.2. Starts in `DRAFT`. Creates the Drive folders, uploads the images, sets the serial counter to 1. |
| 2 | **Open registration** | Admin | `/admin/dashboard` | Part 7.5. Set status to `REG_OPEN`, then share the link (Part 7.6). Players cannot register while it is `DRAFT`, even inside the window. |
| 3 | **Watch registrations arrive** | Admin | `/admin/players` | Part 7.8. Every registration lands as `payment_status = PENDING`. |
| 4 | **Verify payments** | Admin | `/admin/payments` | §6.1 below. Work the queue to zero pending. Only `VERIFIED` and not-withdrawn players can enter the auction. |
| 5 | **Close registration** | Admin | `/admin/dashboard` | Part 7.9. Set status to `REG_CLOSED`. |
| 6 | **Create the organiser** | Admin | `/admin/organisers` | Step 1.12. One-time join link, 72 hours, shown once. |
| 7 | **Create the teams** | Organiser | `/organiser/dashboard` | §6.2 below. 8 teams, equal purse, squad size 12 or 13. |
| 8 | **Go live** | Admin | `/admin/dashboard` | Set status to `AUCTION_LIVE`. Until this is set, every sale is rejected with `AUCTION_NOT_LIVE`. |
| 9 | **Run the auction** | Organiser | `/organiser/auction` and the projector | **`AUCTION-DAY.md`** — the printable card. Part 8 is the checklist that gets you to the door. |
| 10 | **Close the auction** | Admin | auction console | `auction.close` sets `AUCTION_CLOSED`. Every organiser write then returns `AUCTION_CLOSED`. Only an admin can reopen, and reopening is audited. |
| 11 | **Export** | Admin | `/admin/reports` | §6.3 below. Four downloads. Open them in Excel before you leave the venue. |

### 6.1 Verifying payments (step 4)

The screen the tournament lives or dies on. Sit with a bank statement and work the queue at `/admin/payments`.

1. Rows default to **PENDING, oldest first**.
2. Open a row. The screenshot loads **only then** — one at a time, through `payment.getScreenshot`, which requires an admin token and returns base64. There is no batch endpoint by design. Click the screenshot to zoom.
3. Compare the **UPI reference** against the bank statement. It is rendered large and monospaced with a Copy button because that is the comparison being made, character by character.
4. **Verify** or **Reject**. A rejection **requires a reason**, 3–200 characters.
5. The queue advances to the next pending item automatically, and the header keeps a running count.

Points that catch people out:

- **The app never decides a payment succeeded.** A human does. There is deliberately no "verify all pending" button (`KNOWN-ISSUES.md` item 6).
- **`possible_duplicate_of` is a hint, not an accusation.** It flags another player in the same tournament with an exactly matching name: *"Serial #88 has the same name. Check before verifying."* You decide.
- **Two admins clicking Verify on the same row is a no-op success**, not an error.
- **Verifying something already rejected (or vice versa) is allowed** and recorded as a reversal. There is no separate undo button, because an undo would hide what happened.
- **Rejecting deletes nothing.** The player row, the images and the serial number all stay. Serial numbers are never reused. Only `payment_status` changes.
- Keyboard: `V` verify, `R` reject, `J`/`K` or arrows to move.

To withdraw a player who pulls out after verifying, use the withdraw action on `/admin/players`. The serial number stays reserved forever. A player who is already `SOLD` cannot be withdrawn — that has to go through the correction flow.

### 6.2 Creating the teams (step 7)

At `/organiser/dashboard`. An admin can also do this at any time.

1. **Use batch creation.** One form, 8 name fields, one shared purse and one shared squad size. Creating teams one at a time is 8 round trips at about 1.5 s each.
2. Purse and squad size default to the tournament's `default_purse` and `default_max_players` if you leave them blank.
3. Team names must be unique within the tournament, 2–40 characters. The whole batch is validated before anything is written, so a duplicate at position 7 does not leave 6 teams created.
4. **Squad size is per team**, not one global number. 12 for some teams and 13 for others is normal and supported.
5. The dashboard shows **per-slot remaining** for each team — `purse_remaining / slots_remaining`. That is the number that tells you whether a team is in trouble; do not make an organiser divide in their head mid-auction.

Changing a team later:

| Change | Allowed? |
|---|---|
| Raise `maxPlayers` or `purseTotal` | Always |
| Lower `maxPlayers` below `players_count` | Refused — `SQUAD_BELOW_COUNT` |
| Lower `purseTotal` below `purse_used` | Refused — `PURSE_BELOW_SPENT` |
| Rename | Allowed if still unique |
| Delete | Admin only, and only while the team has 0 players — else `TEAM_NOT_EMPTY` |

An **organiser** may create and edit teams freely until the tournament has its first `SOLD` result. After that, only an **admin** can, including mid-auction. Every change is audited.

**Team logos cannot be changed after creation** (`KNOWN-ISSUES.md` item 5). Get them right the first time.

### 6.3 Exporting (step 11)

At `/admin/reports`. Four downloads:

| Report | Columns |
|---|---|
| **Player list** | Serial No, Name, DOB, Role, Style, Mobile, Payment Reference, Payment Status, Auction Status, Team, Purchase Amount |
| **Team report** | Team, Player, Purchase Amount, Total Players, Total Spent, Remaining Purse |
| **Auction report** | Serial No, Player, Status, Team, Purchase Amount, Auction Time |
| **Final report** | The admin stats, every team squad and the full auction history in one file |

Two things about the CSVs that are deliberate:

1. **Amounts are plain integers** — no `₹`, no thousands separators. A currency symbol turns the column into text and breaks every total in Excel.
2. **Mobile numbers come out as `="9876543210"`.** Without that, Excel shows `9.87654E+09`.

Auction status uses the four honest labels — **Sold / Unsold / Awaiting re-auction / Not called** — not the three raw statuses. All 400 players paid a fee, so "not called" has to be a visible outcome rather than a blank cell.

Files start with a UTF-8 BOM so Tamil and Devanagari names render correctly in Excel on Windows, and use CRLF line endings.

---

## Part 7 — Registration, step by step

The detail behind lifecycle steps 1, 2, 3 and 5. No developer knowledge needed.

### 7.1 Sign in as admin

1. Open your Pages site and go to `/admin/login`, for example `https://myclub.github.io/cricket-auction/admin/login`.
2. Enter the admin email and password from step 1.8.
3. You stay signed in for **12 hours**. After that you sign in again. That is normal, not a fault.

### 7.2 Create the tournament

Fill in every field. Here is what each one is for.

| Field | What it is for | Rule |
|---|---|---|
| Name | Shown at the top of the registration page and on the projector | 3–80 characters |
| Description | Short blurb under the name on the registration page | Free text |
| Start date / End date | The dates the tournament is played. **Also used to work out each player's age**, which is computed at the start date. | Start must not be after End |
| Registration start / Registration end | The window in which players may register. IST calendar days — see 7.4. | Start must not be after End |
| Registration fee | Rupees each player pays. Shown as `₹500` on the page. | Whole rupees, 0 or more |
| UPI ID | Where the money goes. Shown on the page with a "copy" button, as a fallback for players whose app cannot scan a saved QR image. | Must look like `name@bank` |
| Contact name / Contact mobile | Shown publicly so a stuck player can call someone | Mobile must be a valid 10-digit Indian number |
| Contact email | For your records only. **It is never shown to players.** | — |
| Rules | Long text, shown on the registration page | Free text |
| Default purse | Pre-fills the purse when the organiser creates teams (§6.2) | Must be more than 0 |
| Default max players | Pre-fills the squad size when the organiser creates teams (§6.2) | 1 or more |
| Logo | Tournament logo | Image, optional |
| UPI QR | The QR code players scan to pay | **PNG — see 7.3** |
| Gallery | Extra photos for the registration page | May be empty |

On save the server creates the Drive folder tree, uploads the images, sets the serial counter to 1, mints the `display_token` for the projector link, and puts the tournament in **`DRAFT`**. Nothing is public yet.

### 7.3 Upload the UPI QR as a PNG

**Save the QR from your bank or UPI app as a PNG and upload that PNG.**

The system deliberately keeps QR images as PNG and never re-encodes them as JPEG. JPEG compression smudges the sharp black-and-white edges a QR code is made of, and a smudged QR can fail to scan on a player's phone. Every other image (photos, logo, gallery) is resized and saved as JPEG, because for a photograph that is invisible and saves 95% of the upload time.

Two practical points:

1. Use a **screenshot or export at a decent size** — at least about 500×500 pixels. A tiny QR blown up on a phone screen scans badly.
2. Check it yourself. Open the registration page on a phone and scan the QR with a different phone before you share the link.

### 7.4 Set the registration window

Registration dates are **IST calendar days**.

- An end date of **31 August** keeps registration open until **23:59:59 IST on 31 August**.
- A start date of **1 August** opens it at **00:00:00 IST on 1 August**.

You do not need to add a buffer day. The last day is a whole day.

### 7.5 Open registration

The tournament starts in `DRAFT`. Players cannot register while it is in `DRAFT`, even if today is inside the window.

1. Open the tournament in the admin screen.
2. Set the status to **`REG_OPEN`**.

The legal status moves are:

```
DRAFT          -> REG_OPEN
REG_OPEN       -> REG_CLOSED
REG_CLOSED     -> REG_OPEN        (reopening is allowed)
REG_CLOSED     -> AUCTION_LIVE
REG_OPEN       -> AUCTION_LIVE    (allowed, but it warns that registration is still open)
AUCTION_LIVE   -> AUCTION_CLOSED
AUCTION_CLOSED -> AUCTION_LIVE    (admin only, and audited)
```

Anything else is refused and names both states. Every change is written to the audit log.

### 7.6 Copy and share the registration link

The admin screen shows the link. It looks like:

```
https://myclub.github.io/cricket-auction/register/TRN_k3m9x1qz7f2a
```

1. Copy it.
2. Share it in the club WhatsApp group, or turn it into a QR code for a poster.

If the link starts with `/register/...` instead of `https://...`, the `frontend_base_url` Config key is missing. Go back to step 1.7a.

The link is public on purpose. There is no login for players. It exposes only what `tournament.getPublic` allows: name, description, rules, fee, logo, QR, gallery, UPI ID, contact name and mobile, and the registration dates. It never exposes any player data, any player count, your contact email, the Drive folder, the projector token or any sheet id.

The **projector link** on the same screen carries the `display_token` as `?k=`. Treat it as a low-value secret: it is read-only and the auction is public anyway, but do not put it on a poster.

### 7.7 What the player sees

1. Fee and a large QR code, with a **Download QR Code** button and a **copy UPI ID** button.
2. They pay in their own UPI app and take a screenshot.
3. They fill in name, date of birth, playing role, batting/bowling style, mobile number and the UPI reference number from their payment.
4. They pick a profile photo and the payment screenshot. Both are resized in their browser before upload, and a progress bar is shown.
5. They press submit once — the button disables itself and says "Submitting…".
6. They get a confirmation screen with their **serial number in very large type** and a "Save as image" button.

If registration is not open, the page shows a "Registration Closed" message instead of the form, and says why — not open yet, closed on a date, or not open for this tournament.

Serial numbers are allocated inside the script lock, so two people submitting at the same instant cannot get the same number. Duplicate mobile numbers and duplicate UPI references within one tournament are rejected.

### 7.8 Watch registrations arrive

`/admin/players` is the general register: 50 rows a page, filters for payment status, auction status and withdrawn, and a search box covering serial, name, mobile and UPI reference. The header carries the counts — total, pending, verified, rejected, eligible.

Every registration is written with `payment_status = PENDING`. It stays there until an admin verifies it (§6.1).

You can also open the Google Sheet directly and look at the `Players` and `Payments` tabs. **Read only — never edit rows by hand**, or the serial counter and the audit trail stop agreeing with each other.

### 7.9 Close registration

When the window ends, set the status to **`REG_CLOSED`**. The window alone already stops new registrations, but setting the status makes it explicit and audited, and it is what you check on the morning of the auction.

---

## Part 8 — Tournament-day checklist

The auction hour itself is **`AUCTION-DAY.md`** — print that. This part is everything before the first lottery number is drawn.

### The week before

1. **Confirm registration is closed.** The tournament status should be `REG_CLOSED`, not `REG_OPEN`. A tournament left in `REG_OPEN` will still accept registrations if today is inside the window.
2. **Export and check the player list.** Pull the player list and read it. Look for duplicate names, obviously wrong dates of birth, missing photos and anyone who paid but never appeared. Fixing this the week before is easy; fixing it in the hall is not.
3. **Verify every payment.** Do not leave this to the morning. Only players with `payment_status = VERIFIED` and not withdrawn can enter the auction pool. Work the payment queue down to zero PENDING (§6.1).
4. **Do a dress rehearsal** with about 20 fake players on the real projector, ideally in the real hall.
5. **Test the projector at its real resolution.** Assume 1024×768, not 1080p, and assume about 15% of the edges get cut off.
6. **Test a portrait phone photo end to end** — iPhone and Android — and check it is the right way up on the projector (`KNOWN-ISSUES.md` item 1).

### The morning of

7. **Confirm all teams are created.** Check the count, the team names, each team's `purse_total` and each team's `max_players` (12 or 13 — it is per team, not global). Fix them now, not mid-auction.
8. **Confirm registration is closed** and the payment queue is empty.
9. **Log the organiser in fresh this morning** so the 12-hour session covers the whole event.

### Just before you start

10. **Put the tournament into `AUCTION_LIVE`.** Admin → tournament → set status. Until this is set, every sale is rejected with `AUCTION_NOT_LIVE`.
11. **Open the projector URL:**
    `https://<your-pages-site>/projector/<tournament-id>?k=<display_token>`
    Then **press `F` for fullscreen**. The projector page has no visible controls. Keyboard only: `F` = fullscreen, `R` = force refresh.
12. **Download the offline pack**, on good wifi, not venue wifi. It caches every eligible player and their photos into IndexedDB, and it is what keeps the console usable when the venue internet dies. Takes a minute. `AUCTION-DAY.md` lists this as a button on the auction console. **As the code stands, the console reads the pack (`Offline.getPlayer`, `Offline.getPlayers`) but never calls `Offline.downloadPack`, so there is no button yet.** Until one is wired up, run it once from the browser console on `/organiser/auction`: `Offline.downloadPack(tournamentId).then(console.log)`. Check `Offline.isPackReady(tournamentId)` returns true afterwards.
13. **Pre-warm the image cache.** Leave the projector page open for a couple of minutes before you start. Revealing player #27 is then instant instead of a 400 ms wait in front of an audience.
14. **Check the backup hotspot.** Have a phone hotspot ready and tested. **Tether the organiser laptop to the hotspot, not the venue Wi-Fi** — the projector can be on either, but the console is the one that must not drop.
15. **Keep a paper sheet.** Serial, player name, team, amount, one line per sale. This is the legal backup and it is what you fall back on if everything electronic dies. Do this regardless of how well the software is working.
16. **Check both screens show the same team purses** before the first player.

### During, and after

From here, use **`AUCTION-DAY.md`**. The three things worth repeating:

- **Read the confirmation line before every sale.** It shows the consequence — "Leaves ₹4,75,000 for 3 slots". One second, and it is your best protection against an extra zero.
- **An amber banner is a warning, not a block.** Tick and proceed if the amount is genuinely correct.
- **The "all teams are full" banner is the normal ending**, not an error. With 400 players and about 100 slots, roughly 300 are never called. Say that out loud to the room before you start. An admin still clicks CLOSE deliberately.

After the last sale: close the auction, download all four reports, check the team totals against your paper, and save the exports somewhere other than the laptop (§6.3).

---

## Part 9 — Troubleshooting

### 9.1 Setup, deployment and CORS

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser console: `blocked by CORS policy` / `No 'Access-Control-Allow-Origin'` on a POST | The request is not a *simple* request, so the browser sent an `OPTIONS` preflight — and Apps Script never answers preflight. Almost always: `Content-Type` was set to `application/json`, or a custom header like `Authorization` was added. | In `frontend/js/api.js`, the content type must be exactly `text/plain;charset=utf-8` and there must be **no** other headers. The session token goes in the JSON body, not in a header. |
| CORS error on a page that used to work | Someone "tidied up" `api.js`, or a redirect is being followed to a different origin. | Check `api.js` first. Then confirm `API_BASE_URL` ends in `/exec` and is the full URL with no trailing slash added. |
| Your fix works in the editor but the site behaves like the old code | **The deployment trap.** `clasp push` updated the editor copy only. The `/exec` URL still serves the old frozen version. | **Deploy → Manage deployments → edit the existing deployment → Version: New version → Deploy.** Do not create a new deployment; that gives a new URL. See Part 2. |
| Some users see new behaviour, others see old | You created a second deployment at some point, and two `/exec` URLs are live. | In **Manage deployments**, find the URL that matches `frontend/js/config.js`, update that one, and archive the stray deployment. |
| `setup()` throws, or cannot find the spreadsheet | The Apps Script project is **not bound** to the Sheet. A standalone script has no active spreadsheet. | Delete the standalone project. Open the Sheet, then **Extensions → Apps Script**, and `clasp push` into that new script ID. Update `.clasp.json`. |
| `setup()` throws on the very first run only | Scopes were never authorised. The first run of anything touching Sheets or Drive needs consent. | Run `setup` from the editor, click **Review permissions**, then **Advanced → Go to (project) (unsafe) → Allow**. Run it again. |
| `runAllTests()` refuses to start | The `Config` tab's `env` value is not `TEST`. This is the interlock from Part 3. | Confirm you opened the **TEST** project. If you did, set `env` to `TEST` in that sheet's `Config` tab. Never change PROD's `env` to make tests run. |
| `npm run check` fails with "duplicate global" | Two `.gs` files declare the same top-level name. In Apps Script this is a fatal load error that takes down the whole web app, including registration. | Rename one. Never push past this check. |
| The registration link gives a GitHub 404 | Three possible causes. (1) `frontend/404.html` is missing, so Pages cannot bounce the deep link into `index.html`. (2) Pages **Source** is not set to "GitHub Actions", so `frontend/` is not being published at all. (3) `BASE_PATH` in `frontend/js/config.js` does not match the repo name. | Confirm `404.html` exists. Set **Settings → Pages → Source: GitHub Actions** and check the run in the **Actions** tab. Then confirm `BASE_PATH` matches the repo name, in **both** `frontend/js/config.js` and the copy inside `frontend/404.html`. |
| The registration link the admin copies starts with `/register/...` instead of `https://...` | The `frontend_base_url` key is missing or blank in the `Config` tab, so the server can only build a path, not a full URL. | Set `frontend_base_url` in the `Config` tab to your Pages site root, no trailing slash. See step 1.7a. This affects the projector link and the organiser join link too. |
| Uploads start failing partway through registration | Drive storage full. 15 GB is shared with Gmail and Photos. | This is why step 1.1 says use a dedicated account. Clear space, or move to a dedicated account before go-live. |

### 9.2 Accounts and sessions

| Symptom | Likely cause | Fix |
|---|---|---|
| "Please sign in again" appears mid-session | The session token expired. Sessions last 12 hours (`session_hours`). (The cache copy lasts 6 hours, the Apps Script maximum, but the sheet copy is authoritative, so a cold cache alone does not log you out.) | Log in again. On tournament day, log the organiser in fresh that morning so the 12-hour window covers the whole event. |
| The admin is signed out again and again | Sessions last **12 hours**. A session started yesterday evening is gone this morning. | Sign in again. This is expected behaviour, not a bug. If it happens within a few minutes rather than hours, check that the browser is not clearing `localStorage` — the token is stored under `ca.session.token`. |
| Login fails repeatedly, then keeps failing with a correct password | The account is locked for 15 minutes after 5 consecutive failures. | Wait 15 minutes, or run `Auth.setPassword(userId, newPlain)` from the editor. |
| **Organiser join link says it is expired, invalid or already used** | One of three things, and the message is deliberately the same for all three so it cannot be used to probe which tokens exist: the link is past its **72 hours**, it has already been opened once (the token is burned when the password is set), or a **later resend invalidated it**. | Admin: `/admin/organisers` → **Resend link**. That mints a fresh token, invalidates the previous one, and shows the new link **once**. Send it directly to the organiser, not through a chain of forwards. See step 1.12. |
| Organiser cannot see the tournament, or gets `FORBIDDEN` | Each organiser is locked to exactly **one** tournament for the life of the account. They are looking at a different one. | Create a separate organiser account for the other tournament. Scope cannot be changed after creation. |
| An organiser needs to be removed | — | `/admin/organisers` → **Disable**. Sets `status = DISABLED` and revokes every session immediately. The row is never deleted, because the audit trail references it. |

### 9.3 Registration and images

| Symptom | Likely cause | Fix |
|---|---|---|
| The registration page shows "Registration Closed" when it should be open | Two possible causes. (1) The tournament status is still `DRAFT`. The window alone is not enough — status must be `REG_OPEN`. (2) The window dates are wrong: `reg_start` is in the future or `reg_end` is in the past. | Open the tournament in the admin screen. Set the status to `REG_OPEN`. Check `reg_start` and `reg_end`. These are **IST calendar days** — an end date of 31 August runs to 23:59:59 IST on the 31st, so a page that closed at 05:30 that morning means a date was compared as UTC somewhere. |
| Photo upload fails, or takes 30+ seconds | The image is too large and the browser-side resize is not running, so the full 4 MB phone photo is being uploaded. Usual causes: a JavaScript error stopped `js/image.js` loading, or the browser blocks `<canvas>` reads (some privacy modes and older Safari). | Open the browser console on the registration page and look for an error from `image.js`. A working resize turns a 4 MB photo into 100–200 KB. As a stop-gap, ask the player to pick a smaller photo — the server rejects anything over 5 MB decoded (`max_image_bytes`). Also check `Drive.uploadImage` did not reject the mime type: only `image/jpeg` and `image/png` are accepted. |
| Portrait photos appear sideways on the projector | EXIF rotation. `js/image.js` rotates using the JPEG SOF marker, and this cannot be verified without a real phone (`KNOWN-ISSUES.md` item 1). | Test with a real iPhone and a real Android **before** the dress rehearsal. If it is wrong, the fix is in `ImageTool`, not in the backend. |
| Player sees "A registration already exists for this mobile number" | That mobile number is already used in this tournament. Mobile numbers are unique per tournament (`DUPLICATE_MOBILE`). Either they registered already, or two people are sharing one phone number. | Check the `Players` tab for that number. If it is a genuine second person, they need their own number. If it is a mistake or a withdrawn entry, an admin has to sort it out on the sheet side — there is no self-service fix. The form keeps every field filled in after this error, so the player only has to change the number, not re-pick their photos. |
| The QR code will not scan | The QR was uploaded in a format that got re-encoded as JPEG, or the source image was too low resolution to start with. | Re-upload the QR as a **PNG** at 500×500 pixels or larger. PNG is kept as PNG on purpose — see Part 7.3. Then scan it yourself from the live registration page with a second phone before sharing the link again. |
| Player photos show as broken images on the dashboard or projector | The `public/` folder sharing was never applied, so `drive.google.com/thumbnail?id=...` returns nothing to an anonymous browser. | Open Drive, find `CricketAuction/<tournament>/public/`, set sharing to **Anyone with the link → Viewer**. It propagates to files inside. Then hard-refresh. `Drive.setPublicRead()` does this in code; if a folder was created by hand it will have been missed. |
| Payment screenshots do not load for the admin | Correct behaviour if you tried a Drive link — `private/` is never shared. | Screenshots only reach the browser through the `payment.getScreenshot` action, which requires an admin token and returns base64. Make sure you are logged in as ADMIN. |

### 9.4 The auction

| Symptom | Likely cause | Fix |
|---|---|---|
| Every sale is rejected with `AUCTION_NOT_LIVE` | The tournament status is not `AUCTION_LIVE`. | Admin → tournament → set status to `AUCTION_LIVE`. Part 8 step 10. |
| Every organiser write returns `AUCTION_CLOSED` | The auction has been closed. This is intended: closing freezes organiser writes. | Only an **admin** can reopen (`auction.reopen`), and reopening is audited. |
| The projector shows an amber **"reconnecting"** dot | A poll failed and the page backed off (2 s → 15 s). The screen is showing the last known state and telling you so, rather than freezing on a plausible-looking screen. | Usually recovers on its own. If it persists, switch that laptop to the hotspot, then press **`R`** on the projector to force a refresh. State lives on the server, so nothing is lost. |
| The projector is frozen on an old player, with no dot | The poll is stuck. | Press **`R`**. If that does nothing, reload the projector URL and press **`F`** again. |
| The console says the screen was out of date — `STALE_STATE` | The tab acted on a version of the auction state older than the server's. Another device (the other laptop, an admin, a correction) changed something in between. This check is deliberate: it is one of three things stopping a stale tab selling an already-sold player. | The screen refreshes itself. **Check the player's current status before redoing anything** — the earlier change may already be the one you wanted. Then redo the action. |
| Two organisers both clicked sell, one got `PLAYER_NOT_PENDING` | Working as designed. The lock serialised the writes and the second caller re-read the row and saw it was already sold. | Nothing to fix. Refresh and carry on. |
| A sale is rejected with `INSUFFICIENT_PURSE` | The amount is more than `purse_total - purse_used` for that team. | Read out the real remaining figure. The bid comes down, or another team takes the player. An admin can raise `purse_total` if the rules allow — it can be raised freely, and can only be lowered to at most `purse_used`. |
| A sale is rejected with `TEAM_FULL` | `players_count` has reached `max_players` for that team. Checked **before** the purse, so you get the accurate reason rather than a confusing one about money. | That team is done. An admin can raise `max_players` mid-auction if the rules allow. |
| A sale is rejected with `INVALID_AMOUNT` | The amount is not a positive whole number of rupees. | Re-enter it. There are no paise and no decimals anywhere in this system. |
| An amber warning appears on the amount | Advisory only, never a block: `LARGE_SHARE_OF_PURSE` (over 25% of the team's purse), `FAR_ABOVE_RECENT` (over 5× the biggest sale so far), or `SQUAD_AT_RISK` (leaves less per remaining slot than the cheapest sale so far). | Check the number. Tick the box and proceed only if it is genuinely right. An extra zero is the most expensive mistake available. |
| A result was recorded wrongly | Human error. | Use **Correct** (admin, or organiser before the auction closes). It never deletes: it reverses the old row's effect on the team, appends a superseding `AuctionResults` row, and audits both values. Correcting back to `PENDING` also clears the player's team, amount and sold time. |
| **Team purse totals look wrong** | `purse_used` and `players_count` on `Teams` are a **cache**. The append-only `AuctionResults` tab is the truth. They can drift if something was edited by hand on the sheet. `/admin/reports` detects this and shows a banner naming the gap. | Run **`team.recount`** (ADMIN) for that tournament. It recomputes both counters from `AuctionResults` and reports what changed. **There is no button for it yet** — call it from the browser console while signed in as admin: `API.call('team.recount', {tournamentId: 'TRN_xxx'}).then(console.log)`. From the Apps Script editor, `Setup.rebuildCounters(tournamentId)` does the same thing. Never fix a counter by typing into the sheet. |
| `SYSTEM_BUSY` returned to the user | Lock contention. Someone else holds the script lock and 20 seconds passed (`lock_wait_ms`). Usually a registration rush, or two organisers acting at the same instant. | Retry once after 2–5 seconds. If it happens constantly during registration, stagger the deadline instead of announcing one hard hour. |
| The "all teams are full" banner appeared while hundreds of players are uncalled | **This is the normal ending.** 8 teams × 12–13 = about 100 slots against 400 registrations. | Nothing to fix. Admin still clicks CLOSE deliberately. Say this to the room before the auction starts, not after. |

### 9.5 Offline mode and the venue internet

| Symptom | Likely cause | Fix |
|---|---|---|
| **OFFLINE** banner on the console | Three consecutive polls failed. The console has switched to offline mode. | **Keep going.** Sales are recorded locally and survive a page reload. **Also write every sale on paper** — the queue is a convenience, the paper is the record. |
| **The offline queue did not replay** when the connection came back | Replay stops at the first *hard* error rather than skipping it, so one bad item blocks the rest. The hard codes are `NETWORK`, `NOT_CONFIGURED`, `SYSTEM_BUSY`, `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL_ERROR`, `BAD_REQUEST` and `STALE_STATE`. | Read the code the console shows. `UNAUTHORIZED` → sign in again and resume. `SYSTEM_BUSY` or `NETWORK` → the item is still valid, retry. `STALE_STATE` → see the next row. **Nothing is silently dropped and nothing is silently forced through.** Every rejected item is shown to you for a decision — do not skip that screen. |
| Replay fails on every item with `STALE_STATE` | A sale recorded offline captures an auction version that is guaranteed stale by the time the connection returns. Replaying it verbatim fails the version check on every item (`KNOWN-ISSUES.md` item 10a). | This is already handled: nothing is queued with an `expectedVersion` at all, and the console's replay callback (`OrganiserAuctionPage._syncCall`) fetches the **current** version immediately before each individual call — not once per run, because every applied item bumps it. If you still see this on every item, that callback is broken; re-enter the queued sales by hand from your paper sheet and fix the wiring afterwards. It is not a validation bypass: the script lock and the in-lock re-read still prevent a double sale. |
| **Download offline pack** would fail with `NO_IMAGE_FETCHER` | `Offline` refuses to cache nothing silently. It needs an image fetcher injected via `Offline.setTransport({imageFn})`, because `API.getBytes(url)` does not exist (`KNOWN-ISSUES.md` item 14). | The pack still caches the player *data*; only the photos are missing. The projector fetches photos over the network as usual, which is fine as long as there is a connection. Pass `{imagesOptional: true}` to accept a text-only pack on purpose, or inject an `imageFn` before calling `downloadPack`. |
| The offline pack downloads but photos never appear offline | Drive thumbnail bytes may not be readable cross-origin — an `<img>` renders fine but `fetch(...).blob()` may be blocked (`KNOWN-ISSUES.md` item 13, still unverified). | Test this in a browser against the real deployment **before** the day. If the bytes are unreadable, the fallback is routing images through the Apps Script API as base64. |
| Everything is broken at once | — | **Carry on with paper.** Serial, name, team, amount, one line each. Enter the results afterwards. The auction does not stop. |

### 9.6 Reports and CSV

| Symptom | Likely cause | Fix |
|---|---|---|
| **Mobile numbers are mangled** — `9.87654E+09`, or a leading digit is gone | Excel reformatted a long number. | The export already emits `="9876543210"` to prevent this. If you are seeing scientific notation, you are looking at a file that was re-saved by something else, or the cell was retyped. Re-download from `/admin/reports` and open the original. |
| **The CSV opens as one single column** | The spreadsheet app did not detect the comma separator — common in Excel on a locale where the list separator is `;`. | In Excel use **Data → From Text/CSV** and pick comma as the delimiter, instead of double-clicking the file. Google Sheets and LibreOffice detect it correctly. Do not "fix" it by changing the separator in `Reports.gs` — the columns are fixed by the requirement. |
| Tamil or Devanagari names show as garbage | Encoding. | The file already starts with a UTF-8 BOM for exactly this reason. If it still fails, open it with **Data → From Text/CSV** and choose UTF-8 explicitly. |
| Totals in Excel come out as text, or as zero | Something added a `₹` or a thousands separator to the amount column. | Amounts are exported as plain integers on purpose. Re-download the original file. |
| A player shows as `Verified (withdrawn)` in the Payment Status column | Known and deliberate. The 11 columns are fixed by the requirement and none of them carries withdrawal, so it is folded into that cell (`KNOWN-ISSUES.md` item 15). | Nothing to fix unless the column format can change. |
| A report screen is empty or the download does nothing | Reports are read-only and tournament-scoped. Either the wrong tournament is selected, or there is genuinely no data yet. | Check the tournament selector in the admin nav. Every action here is tournament-scoped, and running a report against the wrong tournament is easy to do. |
