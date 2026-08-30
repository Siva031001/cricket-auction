# CONTRACTS — Phase 1 (Tournament & Registration)

Extends `CONTRACTS.md`. Everything in that file still binds. Design rationale is in `DESIGN.md` §5–§12, §38, §46–§49.

Phase 1 scope: tournament creation, the public registration link, the registration page, photo and payment-screenshot upload, and serial number allocation.

---

## 1. Image transport

Images travel as base64 inside the JSON body. There is no multipart upload — Apps Script would need a preflight for that.

```js
// An image field anywhere in a payload has exactly this shape:
{ "data": "<base64, no data: prefix>", "mime": "image/jpeg", "filename": "photo.jpg" }
```

**The browser resizes before upload. This is not optional** (`DESIGN.md` §38): a 4 MB phone photo becomes ~150 KB, which is the difference between a 3-second submit and a 40-second one on mobile data.

| Variant | Longest side | Quality | Typical size |
|---|---|---|---|
| `photo` | 1024 px | JPEG 0.8 | 100–200 KB |
| `photoThumb` | 320 px | JPEG 0.8 | ~25 KB |
| `screenshot` | 1024 px | JPEG 0.8 | ~150 KB |
| `logo`, `qr`, gallery items | 1024 px | JPEG 0.8 (PNG kept as PNG) | varies |

The **QR image must stay PNG** — re-encoding a QR code as JPEG introduces artefacts that can make it unscannable.

The server re-validates every image regardless (`Drive.uploadImage`: declared mime, decoded size, magic number). The client resize is for speed; the server check is for safety. Never rely on the client.

---

## 2. New actions

### `tournament.create` — ADMIN, POST

```js
payload = {
  name, description, startDate, endDate,        // "YYYY-MM-DD"
  regStart, regEnd,                             // "YYYY-MM-DD", IST days (CONTRACTS §6a)
  regFee,                                       // integer rupees
  upiId, contactName, contactMobile, contactEmail, rules,
  defaultPurse, defaultMaxPlayers,              // integers, pre-fill team creation
  logo:    {data,mime,filename} | null,
  qr:      {data,mime,filename} | null,
  gallery: [{data,mime,filename}, ...]          // may be empty
}
→ { tournament_id, slug, status:'DRAFT', registrationUrl, displayUrl }
```

Creates the Drive folder tree, uploads the images, generates `display_token`, sets `next_serial = 1` and `status = 'DRAFT'`.

Validation: `name` 3–80 chars; `regStart <= regEnd`; `startDate <= endDate`; `regFee >= 0`; `defaultPurse > 0`; `defaultMaxPlayers >= 1`; `upiId` matches `something@something`; `contactMobile` passes `Util.isValidMobileIN`.

### `tournament.update` — ADMIN, POST
Same fields, all optional, plus `tournamentId`. Only supplied keys change. Images are replaced only when a new one is sent; passing `null` leaves the existing image alone (use `removeLogo: true` etc. to clear). Audited as `TOURNAMENT_UPDATED` with prev/next.

### `tournament.list` — ADMIN, POST
`→ [{tournament_id, name, slug, status, reg_start, reg_end, reg_fee, player_count, verified_count, created_at}]`
Counts come from one `Repo.readAll(Players)` pass, not one query per tournament.

### `tournament.get` — ADMIN or ORGANISER, POST
Full row **minus** nothing for ADMIN. For ORGANISER, `Auth.requireTournament` applies first.

### `tournament.setStatus` — ADMIN, POST
`{tournamentId, status}`. Legal moves only:

```
DRAFT → REG_OPEN
REG_OPEN → REG_CLOSED
REG_CLOSED → REG_OPEN        (reopening registration is allowed)
REG_CLOSED → AUCTION_LIVE
REG_OPEN → AUCTION_LIVE      (allowed; warns that registration is still open)
AUCTION_LIVE → AUCTION_CLOSED
AUCTION_CLOSED → AUCTION_LIVE  (ADMIN only, audited — DESIGN §44)
```
Anything else → `VALIDATION_FAILED` naming both states. Audited.

### `tournament.getPublic` — PUBLIC, GET and POST

**This is a security boundary (`DESIGN.md` §46).** The response is an allow-list, built field by field. Never spread the sheet row and delete keys — a future column would leak by default.

```js
payload = { tournamentId }
→ {
  tournament_id, name, description, rules,
  reg_fee, reg_fee_display,                 // 500, "₹500"
  logo_url, qr_url, qr_download_url,        // Drive thumbnail URLs
  gallery_urls: [],
  upi_id, contact_name, contact_mobile,
  reg_start, reg_end,                       // for display
  reg_start_display, reg_end_display,       // Util.formatIST(..., false)
  registration_open,                        // boolean, Util.isWithinWindow + status
  registration_message                      // '' when open, else the reason
}
```

**Must never appear:** any player data or count, `drive_folder_id`, `display_token`, `next_serial`, `created_by`, `contact_email`, any admin or organiser identity, any sheet id.

`registration_open` is true only when `status === 'REG_OPEN'` **and** `Util.isWithinWindow(reg_start, reg_end)`. When false, `registration_message` is one of:
- `"Registration has not opened yet. It opens on 1 Aug 2026."`
- `"Registration closed on 31 Aug 2026."`
- `"Registration is not open for this tournament."` (any other status)

### `player.checkMobile` — PUBLIC, POST
`{tournamentId, mobile}` → `{taken: boolean}`

A courtesy check so the form can warn before the player uploads two images. **It is not a guarantee** — the authoritative check runs inside the lock at submit time. Rate-limit to 20 calls per 10 minutes per mobile via `CacheService`, so it cannot be used to enumerate who has registered.

### `player.register` — PUBLIC, POST

```js
payload = {
  tournamentId, name, dob, role, style, mobile, upiRef,
  photo:      {data,mime,filename},
  photoThumb: {data,mime,filename},
  screenshot: {data,mime,filename}
}
→ { player_id, serial_no, name, tournament_name, registered_at_display }
```

**Execution order is mandatory** (`DESIGN.md` §6.2). Getting this wrong caps throughput at ~20 registrations/minute and breaks deadline night:

```
OUTSIDE THE LOCK  (~2-3s)
  1. validate every field (§3 below)
  2. load the tournament; check status and window
  3. cheap pre-check: mobile taken? upi_ref taken?      -> fail early
  4. upload photo + thumb   -> public/players/
  5. upload screenshot      -> private/payments/

LOCK  (~200ms, Repo.withLock)
  6. re-check the registration window        (authoritative)
  7. re-check duplicate mobile               (authoritative)
  8. re-check duplicate upi_ref              (authoritative)
  9. serial = Repo.nextSerial(tournamentId)
 10. append Players row  (payment_status PENDING, auction_status PENDING,
                          times_called 0, is_withdrawn FALSE)
 11. append Payments row (status PENDING)
 12. Repo.flush()
UNLOCK
```

Steps 6–8 are **not** optional just because steps 2–3 already checked. Two players can upload concurrently; only the locked re-check decides. If a re-check fails here, the uploaded files are orphaned — that is accepted and swept later (`DESIGN.md` §6.2).

Never write the `Players` row before the `Payments` row is ready — a player row with no payment row would appear in the admin list as permanently unverifiable.

---

## 3. Registration validation

Runs in the browser for feedback and on the server for real. Server messages are the ones in `DESIGN.md` §11 verbatim — they are shown to players.

| Field | Rule | Error code |
|---|---|---|
| name | 2–60 chars, letters in **any script**, plus spaces/dots/apostrophes/hyphens. Pattern `/^\p{L}[\p{L}\p{M} .'\-]*$/u` | `VALIDATION_FAILED` |
| dob | valid date, age 8–70 at `startDate` | `VALIDATION_FAILED` |
| role | in `ENUM.PLAYER_ROLE` | `VALIDATION_FAILED` |
| style | in `ENUM.PLAYER_STYLE` | `VALIDATION_FAILED` |
| mobile | `Util.isValidMobileIN` | `VALIDATION_FAILED` |
| mobile | unique in tournament | `DUPLICATE_MOBILE` |
| upiRef | 6–35 chars, alphanumeric | `VALIDATION_FAILED` |
| upiRef | unique in tournament | `DUPLICATE_UPI_REF` |
| photo, photoThumb, screenshot | present, valid image | `VALIDATION_FAILED` |
| window | open now | `REGISTRATION_CLOSED` |

`search_blob` is written as `(name + ' ' + role + ' ' + style).toLowerCase()` for Phase 4 search.
`age_years` is computed server-side with `Util.ageYears(dob, tournament.startDate)` and stored.

---

## 4. Frontend structure

New files. **Each agent owns its own page file and its own CSS file — nobody edits another's.**

```
frontend/
  index.html            <- owned by the integration agent only
  css/app.css           <- owned by the integration agent only
  css/register.css      <- registration page
  css/admin.css         <- admin pages
  js/image.js           <- ImageTool
  js/ui.js              <- UI
  js/pages/register.js  <- RegisterPage
  js/pages/admin-login.js      <- AdminLoginPage
  js/pages/admin-tournament.js <- AdminTournamentPage
```

Route bindings (the router patterns already exist from Phase 0):

| Route | Page module |
|---|---|
| `/register/:tournamentId` | `RegisterPage` |
| `/admin/login` | `AdminLoginPage` |
| `/admin/dashboard` | `AdminTournamentPage` — list / create / edit, switched by `?view=` |

`AdminTournamentPage` has no route of its own. It *is* the admin dashboard for Phase 1; Phase 2 adds the payment queue alongside it.

Page module convention, matching the Phase 0 shell:

```js
const RegisterPage = {
  /** @param {Object} ctx router context {path, params, query, pattern} */
  render: function (ctx) { /* clears and fills App.root */ }
};
```

Rules carried over from Phase 0 and still binding:
1. **`textContent`, never `innerHTML`.** A tournament name comes from the sheet and a tournament id comes from the URL; both are untrusted.
2. Vanilla JS only. No framework, no build step, no CDN, no web font.
3. Set `document.body.dataset.route` so CSS can scope itself.
4. Every network call goes through `API`; never call `fetch` directly.

### `js/image.js` — `ImageTool`

```js
ImageTool.fromFile(file, {maxEdge, quality, keepPng})  // -> Promise<{data, mime, filename, width, height, bytes}>
ImageTool.pair(file)   // -> Promise<{photo, photoThumb}>  1024 + 320 in one decode
ImageTool.previewUrl(file)  // -> object URL for an <img>, caller revokes
```
Uses `<canvas>`. Must honour EXIF orientation, or portrait photos from iPhones display sideways on the projector — use `createImageBitmap(file, {imageOrientation:'from-image'})` with a documented fallback for older Safari. Returns base64 **without** the `data:` prefix.

### `js/ui.js` — `UI`

```js
UI.field({label, name, type, required, hint, options})  // -> {wrap, input, setError, clearError}
UI.banner(kind, message)     // kind: 'error' | 'success' | 'info'
UI.button(label, onClick, {variant, busyLabel})
UI.spinner(label)
UI.progress()                // -> {el, set(pct), done()}
UI.money(paise)              // -> "₹500", uses the same Indian grouping as the server
UI.confirmDialog({title, body, confirmLabel})  // -> Promise<boolean>
```
All built with `document.createElement`. Tap targets ≥ 48 px (`DESIGN.md` §49).

---

## 5. Registration page behaviour

Non-negotiable details, each one from a real failure mode in `DESIGN.md` §12:

1. **Disable submit on first press** and show "Submitting…". Double submission is the most common cause of duplicate registrations.
2. **Show upload progress.** On 3G a 150 KB upload takes seconds; silence makes people press submit again.
3. **QR shown large**, with a **Download QR Code** button and a **copy UPI ID** fallback for players whose app cannot scan a saved image (`DESIGN.md` §8).
4. **Registration closed** state renders instead of the form, using `registration_message`. Never render a form the server will reject.
5. **Confirmation screen** shows the serial number very large, with a "Save as image" button (`DESIGN.md` §10).
6. On `DUPLICATE_MOBILE` or `DUPLICATE_UPI_REF`, keep every field filled in. Making someone re-enter everything and re-pick two photos after one error is the fastest way to lose a registration.
7. Image inputs use `accept="image/*"` and show a thumbnail preview once chosen.

---

## 6. Out of scope for Phase 1

Payment verification, the admin player list, teams, and the auction. Admin gets login plus tournament create/list/edit only — enough to produce a registration link and watch registrations arrive.
