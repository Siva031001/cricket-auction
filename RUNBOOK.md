# RUNBOOK

How to set this system up, deploy it, test it, and run it on tournament day.

Assume no prior knowledge of Apps Script or clasp. Follow the numbered steps in order. Where a step says "copy this", the command is meant to be pasted as-is.

**Contents**

1. [Part 1 — One-time setup](#part-1--one-time-setup)
2. [Part 2 — The deployment trap (read this)](#part-2--the-deployment-trap-read-this)
3. [Part 3 — TEST vs PROD](#part-3--test-vs-prod)
4. [Part 4 — Running the tests](#part-4--running-the-tests)
5. [Part 5 — Tournament-day checklist](#part-5--tournament-day-checklist)
6. [Part 6 — Troubleshooting](#part-6--troubleshooting)

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
npx clasp push
```

Answer yes if it asks to overwrite the manifest. Now refresh the Apps Script editor tab. You should see all the `.gs` files from `backend/`.

### 1.7 Run `setup()`

1. In the Apps Script editor, open `Setup.gs`.
2. In the function dropdown at the top, select **`setup`**.
3. Click **Run**.
4. The first run shows an authorisation dialog. Click **Review permissions**, pick the dedicated account, then on the "Google hasn't verified this app" screen click **Advanced → Go to (project name) (unsafe)**, then **Allow**. This is normal for your own private script.
5. Watch the execution log at the bottom. It should report the tabs it created.

`setup()` is idempotent: it creates a tab only if it is missing, rewrites the header row every time, and never touches data rows. So it is safe to re-run after a schema change.

It seeds these `Config` keys:

| Key | Value |
|---|---|
| `env` | `TEST` or `PROD` |
| `pepper` | generated once, never overwritten if already present |
| `max_image_bytes` | `5242880` |
| `poll_interval_ms` | `2000` |
| `session_hours` | `12` |
| `lock_wait_ms` | `20000` |

**Set `env` to `PROD` on the live sheet.** Open the `Config` tab and check the value. See Part 3 for why this matters.

It also creates the Drive root folder `CricketAuction`.

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
5. **Delete `seedAdminOnce` and run `clasp push` again.** Do not leave a password sitting in the source.

Password rule: at least 10 characters. The account locks for 15 minutes after 5 failed logins.

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

### 1.10 Put the `/exec` URL in the frontend

Open `frontend/js/config.js` and set:

```js
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycb...../exec';
```

Use the `/exec` URL, not the `/dev` one. `/dev` only works while you are logged in as the owner.

### 1.11 Create the GitHub repo and enable Pages

1. Create a **public** repo on GitHub (Pages is free on public repos).
2. Push this repository to it.
3. In the repo, go to **Settings → Pages**.
4. Under "Build and deployment", set **Source: Deploy from a branch**, **Branch: `main`**, **Folder: `/frontend`**. If your Pages setup does not offer a `/frontend` folder option, either move the frontend to `/docs` and select that, or add a Pages workflow that publishes `frontend/`.
5. Save. Wait a minute or two, then open the URL GitHub shows, usually `https://<user>.github.io/<repo>/`.
6. Confirm `frontend/404.html` is present. GitHub Pages returns it for any unknown path, and it redirects into `index.html` so deep links like `/register/TRN_xxx` work.

There is no build step. GitHub Pages serves the files exactly as they are in the repo.

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

## Part 4 — Running the tests

Tests run inside the Apps Script editor, not on your laptop. There is no `npm test`.

1. Open the **TEST** Apps Script project (Extensions → Apps Script from the TEST sheet).
2. Confirm the TEST sheet's `Config` tab has `env` = `TEST`. If it does not, the run will stop immediately and tell you so.
3. Open `Tests.gs`.
4. In the function dropdown at the top, select **`runAllTests`**.
5. Click **Run**.
6. Open the **Execution log** panel at the bottom of the editor.

You are looking for a summary line with the total, the passed count and the failed count, followed by a message for each failure. A clean run means zero failures.

To run one suite instead of everything, add a small wrapper and run that:

```js
function runOne() { runTest('auction'); }
```

Notes:

- A run can take a minute or two. The Apps Script execution limit is 6 minutes per run; if you get near it, run suites individually.
- If you changed code, `clasp push` first. The editor runs the editor copy, so tests do **not** need a re-deployment — only the `/exec` URL does.
- Call `resetTestData()` if the TEST sheet gets cluttered.

---

## Part 5 — Tournament-day checklist

### The week before

1. **Verify every payment.** Do not leave this to the morning. Only players with `payment_status = VERIFIED` can enter the auction pool. Work the payment queue down to zero PENDING.
2. **Do a dress rehearsal** with about 20 fake players on the real projector, ideally in the real hall.
3. **Test the projector at its real resolution.** Assume 1024×768, not 1080p, and assume about 15% of the edges get cut off.

### The morning of

4. **Confirm all teams are created.** Check the count, the team names, each team's `purse_total` and each team's `max_players` (12 or 13 — it is per team, not global). Fix them now, not mid-auction.
5. **Confirm registration is closed** and the payment queue is empty.

### Just before you start

6. **Put the tournament into `AUCTION_LIVE`.** Admin → tournament → set status. Until this is set, every sale is rejected with `AUCTION_NOT_LIVE`.
7. **Open the projector URL:**
   `https://<your-pages-site>/auction/<tournament-id>/display?k=<display_token>`
   Then **press `F` for fullscreen**. The projector page has no visible controls. Keyboard only: `F` = fullscreen, `R` = force refresh.
8. **Pre-warm the image cache.** Leave the projector page open for a couple of minutes before you start so it fetches every verified player's 320px thumbnail into browser cache. Revealing player #27 is then instant instead of a 400 ms wait in front of an audience.
9. **Check the backup hotspot.** Have a phone hotspot ready and tested. Tether the projector laptop rather than putting it on the venue Wi-Fi. Venue internet failure is the risk most likely to actually bite you.
10. **Keep a paper sheet.** Serial, player name, team, amount, one line per sale. This is the legal backup and it is what you fall back on if everything electronic dies. Do this regardless of how well the software is working.

### During

11. Read the confirmation line before every sale. It shows the consequence — for example "Leaves ₹4,75,000 for 3 slots". This one second is your best protection against an extra zero.
12. An amber banner on a bid is a warning, not a block. Tick and proceed if the amount is genuinely correct.
13. If the "all teams are full" banner appears, that is the **normal** ending. With 400 players and about 100 slots, roughly 300 players are never called. Admin still clicks CLOSE deliberately.

### After

14. `auction.close` sets the status to `AUCTION_CLOSED`. Only an Admin can reopen, and reopening is audited.
15. Export the three CSVs and open them in Excel before you leave the venue.

---

## Part 6 — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser console: `blocked by CORS policy` / `No 'Access-Control-Allow-Origin'` on a POST | The request is not a *simple* request, so the browser sent an `OPTIONS` preflight — and Apps Script never answers preflight. Almost always: `Content-Type` was set to `application/json`, or a custom header like `Authorization` was added. | In `frontend/js/api.js`, the content type must be exactly `text/plain;charset=utf-8` and there must be **no** other headers. The session token goes in the JSON body, not in a header. |
| CORS error on a page that used to work | Someone "tidied up" `api.js`, or a redirect is being followed to a different origin. | Check `api.js` first. Then confirm `API_BASE_URL` ends in `/exec` and is the full URL with no trailing slash added. |
| Your fix works in the editor but the site behaves like the old code | **The deployment trap.** `clasp push` updated the editor copy only. The `/exec` URL still serves the old frozen version. | **Deploy → Manage deployments → edit the existing deployment → Version: New version → Deploy.** Do not create a new deployment; that gives a new URL. See Part 2. |
| Some users see new behaviour, others see old | You created a second deployment at some point, and two `/exec` URLs are live. | In **Manage deployments**, find the URL that matches `frontend/js/config.js`, update that one, and archive the stray deployment. |
| "Please sign in again" appears mid-session | The session token expired. Sessions last 12 hours. (The cache copy lasts 6 hours, the Apps Script maximum, but the sheet copy is authoritative, so a cold cache alone does not log you out.) | Log in again. On tournament day, log the organiser in fresh that morning so the 12-hour window covers the whole event. |
| Login fails repeatedly, then keeps failing with a correct password | The account is locked for 15 minutes after 5 consecutive failures. | Wait 15 minutes, or run `Auth.setPassword(userId, newPlain)` from the editor. |
| `SYSTEM_BUSY` returned to the user | Lock contention. Someone else holds the script lock and 20 seconds passed. Usually a registration rush, or two organisers acting at the same instant. | Retry once after 2–5 seconds. If it happens constantly during registration, stagger the deadline instead of announcing one hard hour. |
| Two organisers both clicked sell, one got `PLAYER_NOT_PENDING` | Working as designed. The lock serialised the writes and the second caller re-read the row and saw it was already sold. | Nothing to fix. Refresh and carry on. |
| `STALE_STATE` | The tab was acting on an old version of the auction state. | Refresh the page and redo the action. |
| Player photos show as broken images on the dashboard or projector | The `public/` folder sharing was never applied, so `drive.google.com/thumbnail?id=...` returns nothing to an anonymous browser. | Open Drive, find `CricketAuction/<tournament>/public/`, set sharing to **Anyone with the link → Viewer**. It propagates to files inside. Then hard-refresh. `Drive.setPublicRead()` does this in code; if a folder was created by hand it will have been missed. |
| Payment screenshots do not load for the admin | Correct behaviour if you tried a Drive link — `private/` is never shared. | Screenshots only reach the browser through the `payment.getScreenshot` action, which requires an admin token and returns base64. Make sure you are logged in as ADMIN. |
| `setup()` throws, or cannot find the spreadsheet | The Apps Script project is **not bound** to the Sheet. A standalone script has no active spreadsheet. | Delete the standalone project. Open the Sheet, then **Extensions → Apps Script**, and `clasp push` into that new script ID. Update `.clasp.json`. |
| `setup()` throws on the very first run only | Scopes were never authorised. The first run of anything touching Sheets or Drive needs consent. | Run `setup` from the editor, click **Review permissions**, then **Advanced → Go to (project) (unsafe) → Allow**. Run it again. |
| `runAllTests()` refuses to start | The `Config` tab's `env` value is not `TEST`. This is the interlock from Part 3. | Confirm you opened the **TEST** project. If you did, set `env` to `TEST` in that sheet's `Config` tab. Never change PROD's `env` to make tests run. |
| Uploads start failing partway through registration | Drive storage full. 15 GB is shared with Gmail and Photos. | This is why step 1.1 says use a dedicated account. Clear space, or move to a dedicated account before go-live. |
| Deep links like `/register/TRN_xxx` give a GitHub 404 | `frontend/404.html` is missing, or Pages is serving from the wrong folder. | Confirm `404.html` exists and redirects into `index.html`, and that Pages is publishing the `frontend/` folder. |
| The projector froze on a plausible-looking screen | Polling failed and backed off. There should be an amber "reconnecting" dot. | Check the network, then press `R` on the projector to force a refresh. State lives on the server, so nothing is lost. |
