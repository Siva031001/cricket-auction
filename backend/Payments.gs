/**
 * Payments.gs — registration fee verification.
 *
 * Implements CONTRACTS-PHASE2.md §1 (payment.list, payment.getScreenshot,
 * payment.verify, payment.reject), §3 (counts) and §4 (audit). Flow rationale is
 * DESIGN.md §6.3; the pool predicate it feeds is DESIGN.md §14.
 *
 * The governing rule (DESIGN.md §12): this application never decides that a
 * payment succeeded. A human compares the UPI reference against a bank statement
 * and clicks. Everything here exists to make that comparison fast and to record
 * who decided what, when.
 *
 * PHASE 2 — payment verification (DESIGN.md §6.3)
 *   payment.list           ADMIN. Filter by PENDING | VERIFIED | REJECTED.
 *   payment.getScreenshot  ADMIN. Returns a data URI via Drive.getAsDataUri.
 *                          Screenshots live in the never-shared private/ folder
 *                          (CONTRACTS.md §9 rule 2), so this route is the only
 *                          way to see one and it must always check the token.
 *   payment.verify         ADMIN. PENDING -> VERIFIED, makes the player eligible
 *                          for the auction pool. Audited as PAYMENT_VERIFIED.
 *   payment.reject         ADMIN. PENDING -> REJECTED with reject_reason.
 *                          Audited as PAYMENT_REJECTED.
 *
 * Three things in this file are load bearing rather than stylistic:
 *
 *   1. payment.getScreenshot never returns a Drive file id or a Drive URL. See
 *      the comment on that function — it is risk #1 in DESIGN.md §16.
 *   2. verify and reject mirror the new status onto the Players row inside the
 *      same lock. The auction pool reads the mirrored column (DESIGN.md §14);
 *      drift between the two is how an unpaid player reaches the auction table.
 *   3. payment.list reads each tab exactly once and joins in memory. A
 *      Repo.filterBy per row re-reads the whole sheet every time, and at 400
 *      players that turns one screen into hundreds of Spreadsheet calls.
 */

/** Rows per page when the caller does not say (CONTRACTS-PHASE2 §1). @const {number} */
const PAYMENT_PAGE_SIZE_DEFAULT = 50;

/** Hard ceiling on page size, so one call cannot ask for the whole sheet. @const {number} */
const PAYMENT_PAGE_SIZE_MAX = 200;

/** Shortest rejection reason accepted (CONTRACTS-PHASE2 §1). @const {number} */
const PAYMENT_REASON_MIN = 3;

/** Longest rejection reason accepted; it has to fit one sheet cell and one screen. @const {number} */
const PAYMENT_REASON_MAX = 200;

/**
 * Escape hatch for filter.paymentStatus meaning "do not filter by status".
 * Needed because omitting the field means PENDING, not "everything" — the queue
 * defaults to the work still to do (CONTRACTS-PHASE2 §1).
 * @const {string}
 */
const PAYMENT_FILTER_ALL = 'ALL';

/**
 * Sort keys payment.list accepts, mapped to the row field they read. All sorts
 * are ascending with serial_no as the tie-break, so 'submitted_at' is the
 * oldest-first default the verification queue wants.
 * @const {!Object<string,string>}
 */
const PAYMENT_SORTS = Object.freeze({
  submitted_at: 'submitted_at',
  serial_no: 'serial_no',
  name: 'name',
  status: 'status',
  amount: 'amount'
});

const Payments = {

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Payments tab name, tolerating a SHEETS constant that has not loaded yet.
   * @return {string} the Payments tab name
   */
  _tab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.PAYMENTS) ? SHEETS.PAYMENTS : 'Payments';
  },

  /**
   * Bump the auction state version if this tournament's auction is live.
   *
   * WHY: verifying or rejecting a payment changes who is eligible for the auction
   * (DESIGN.md §14). The projector and the organiser console poll a cached
   * snapshot keyed on that version (DESIGN.md §7), so without a bump they keep
   * showing a stale verified/eligible count until something else happens to
   * change it. A late verification mid-auction is exactly when that matters —
   * a player is made eligible and the screen still says they are not.
   *
   * Only bumps while AUCTION_LIVE. During registration and verification there is
   * nothing polling, so bumping every time would just churn the counter.
   *
   * Never throws: a cache hiccup must not roll back a payment decision that has
   * already been written and flushed.
   *
   * @param {string} tournamentId tournament the payment belongs to
   * @return {void}
   */
  _bumpIfAuctionLive(tournamentId) {
    try {
      if (!tournamentId) return;
      const tab = (typeof SHEETS !== 'undefined' && SHEETS.TOURNAMENTS) ? SHEETS.TOURNAMENTS : 'Tournaments';
      const row = Repo.findBy(tab, 'tournament_id', tournamentId);
      if (!row) return;

      const live = (typeof ENUM !== 'undefined' && ENUM.TOURNAMENT_STATUS)
        ? ENUM.TOURNAMENT_STATUS.AUCTION_LIVE
        : 'AUCTION_LIVE';

      if (Payments._str(row.status) !== live) return;

      Cache.bumpVersion(tournamentId);
      Cache.invalidate(tournamentId);
    } catch (e) {
      console.error('could not bump auction version for ' + tournamentId + ': ' +
        (e && e.message ? e.message : e));
    }
  },

  /**
   * Players tab name, same tolerance.
   * @return {string} the Players tab name
   */
  _playersTab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.PLAYERS) ? SHEETS.PLAYERS : 'Players';
  },

  /**
   * Trim a value to a string, treating null/undefined/whitespace as ''.
   * @param {*} v any value
   * @return {string} the trimmed string
   */
  _str(v) {
    return Util.isBlank(v) ? '' : String(v).trim();
  },

  /**
   * Load a payment row or fail with NOT_FOUND.
   * @param {*} paymentId the id from the payload
   * @return {!Object} the Payments row, carrying _row
   * @throws {Error} BAD_REQUEST when blank, NOT_FOUND when unknown
   */
  _requirePayment(paymentId) {
    const id = Payments._str(paymentId);
    if (!id) {
      throw Util.AppError(ERR.BAD_REQUEST, 'A payment id is required.');
    }
    const row = Repo.findBy(Payments._tab(), 'payment_id', id);
    if (!row) {
      // The id is caller-controlled text, so it is length-capped before it goes
      // into a message the browser will render.
      throw Util.AppError(ERR.NOT_FOUND,
        'No payment was found with the id "' + id.substring(0, 40) + '".');
    }
    return row;
  },

  /**
   * Load the Players row a payment belongs to.
   *
   * A payment with no player row cannot be verified or rejected, because the
   * mirrored payment_status has nowhere to go. Registration writes both rows in
   * one locked section (Players.register step 11), so this only happens if
   * somebody edited the sheet by hand.
   *
   * @param {!Object} payment the Payments row
   * @return {!Object} the Players row, carrying _row
   * @throws {Error} NOT_FOUND
   */
  _requirePlayer(payment) {
    const playerId = Payments._str(payment.player_id);
    const row = playerId
      ? Repo.findBy(Payments._playersTab(), 'player_id', playerId)
      : null;
    if (!row) {
      throw Util.AppError(ERR.NOT_FOUND,
        'Payment ' + Payments._str(payment.payment_id) + ' has no matching player row, ' +
        'so its status cannot be changed. Please check the Players tab.');
    }
    return row;
  },

  /**
   * Collapse a name to its comparison form: whitespace runs become one space and
   * case is dropped.
   * @param {*} v the raw name
   * @return {string} the normalised name, '' when there is nothing to compare
   */
  _normaliseName(v) {
    return Payments._str(v).replace(/\s+/g, ' ').toLowerCase();
  },

  /**
   * Tournament-wide counts (CONTRACTS-PHASE2 §3).
   *
   * Always the whole tournament, never the current page: the admin needs
   * "42 still pending" while looking at page 1 of 8. verify and reject return
   * this too, so the header updates without a second round trip — at 400 players
   * that saves a full sheet read per click.
   *
   * `eligible` goes through Players.isAuctionEligible (CONTRACTS-PHASE2 §2)
   * rather than re-stating the predicate here. A second copy of that rule is how
   * a rejected player ends up on the projector. It is applied to rows we already
   * hold instead of calling Players.eligibleCount, which would read the Players
   * tab a second time for an answer that is sitting in memory.
   *
   * @param {!Array<!Object>} playerRows every Players row for one tournament
   * @return {{all:number, pending:number, verified:number, rejected:number,
   *           withdrawn:number, eligible:number}} the counts
   */
  _counts(tournamentId, playerRows) {
    // Delegates to the single definition in Players.gs (CONTRACTS-PHASE2 §3).
    //
    // This used to be a second implementation here. It produced identical
    // numbers, which is exactly what makes a duplicated rule dangerous: it
    // agrees right up until someone changes one copy. The counts and the
    // eligibility predicate (§2) decide who reaches the auction, so there is
    // one writer for both.
    //
    // Players.counts filters by tournament itself, so passing rows that are
    // already filtered is safe and saves the extra Repo.readAll.
    return Players.counts(tournamentId, playerRows);
  },

  /**
   * Read every Players row for one tournament in a single getValues().
   * @param {string} tournamentId the tournament
   * @return {!Array<!Object>} the rows
   */
  _playersOf(tournamentId) {
    const all = Repo.readAll(Payments._playersTab());
    const out = [];
    for (let i = 0; i < all.length; i++) {
      if (Payments._str(all[i].tournament_id) === tournamentId) out.push(all[i]);
    }
    return out;
  },

  // ---------------------------------------------------------------------
  // payment.list — CONTRACTS-PHASE2 §1
  // ---------------------------------------------------------------------

  /**
   * The verification queue: one page of payments joined to their players.
   *
   * ONE Repo.readAll(Players) and ONE Repo.readAll(Payments), then join, filter,
   * sort and slice in memory. Never Repo.filterBy per row — each of those calls
   * re-reads the entire tab, and 400 players would make this screen unusable
   * (CONTRACTS-PHASE2 §1).
   *
   * screenshot_file_id is deliberately absent from every row. The screenshot is
   * fetched one at a time through payment.getScreenshot, so a file id has no
   * reason to appear in a bulk response.
   *
   * @param {!Object} payload {tournamentId, filter:{paymentStatus, auctionStatus,
   *     search, withdrawn}, page, pageSize, sort}
   * @param {!Object} session the ADMIN session
   * @return {{rows: !Array<!Object>, page: number, pageSize: number, total: number,
   *           totalPages: number, counts: !Object}} the page and the whole-tournament counts
   * @throws {Error} BAD_REQUEST when tournamentId is missing, FORBIDDEN on scope
   */
  list(payload, session) {
    const p = payload || {};
    const tournamentId = Payments._str(p.tournamentId || p.tournament_id);
    if (!tournamentId) {
      throw Util.AppError(ERR.BAD_REQUEST, 'A tournament id is required.');
    }
    // ADMIN passes straight through; this is here so the check cannot be
    // forgotten if the route is ever widened to ORGANISER.
    Auth.requireTournament(session, tournamentId);

    const filter = (p.filter && typeof p.filter === 'object' && !Array.isArray(p.filter))
      ? p.filter : {};

    // Omitted means PENDING — the queue opens on the work still to do. 'ALL' is
    // the explicit way to ask for every status.
    const wantStatus = Util.isBlank(filter.paymentStatus)
      ? ENUM.PAYMENT_STATUS.PENDING
      : Payments._str(filter.paymentStatus).toUpperCase();
    if (wantStatus !== PAYMENT_FILTER_ALL &&
        !Object.prototype.hasOwnProperty.call(ENUM.PAYMENT_STATUS, wantStatus)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        '"' + wantStatus.substring(0, 30) + '" is not a payment status. Use one of: ' +
        Object.keys(ENUM.PAYMENT_STATUS).join(', ') + ' or ' + PAYMENT_FILTER_ALL + '.');
    }

    const wantAuction = Util.isBlank(filter.auctionStatus)
      ? '' : Payments._str(filter.auctionStatus).toUpperCase();
    if (wantAuction && !Object.prototype.hasOwnProperty.call(ENUM.AUCTION_STATUS, wantAuction)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        '"' + wantAuction.substring(0, 30) + '" is not an auction status. Use one of: ' +
        Object.keys(ENUM.AUCTION_STATUS).join(', ') + '.');
    }

    // Omitted means "both". Only an explicit true/false narrows the list.
    const wantWithdrawn = (filter.withdrawn === true || filter.withdrawn === false)
      ? filter.withdrawn : null;
    const search = Payments._str(filter.search).toLowerCase();

    const sortKey = Object.prototype.hasOwnProperty.call(PAYMENT_SORTS, Payments._str(p.sort))
      ? Payments._str(p.sort) : 'submitted_at';

    const pageSizeRaw = Util.toInt(p.pageSize, PAYMENT_PAGE_SIZE_DEFAULT) || PAYMENT_PAGE_SIZE_DEFAULT;
    const pageSize = Math.min(PAYMENT_PAGE_SIZE_MAX, Math.max(1, pageSizeRaw));
    const pageRaw = Util.toInt(p.page, 1) || 1;
    const page = Math.max(1, pageRaw);

    // --- the two reads, and only these two ---------------------------------
    const playerRows = Payments._playersOf(tournamentId);
    const paymentRows = Repo.readAll(Payments._tab());

    const playerById = {};
    const nameIndex = {};
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      playerById[Payments._str(row.player_id)] = row;
      const key = Payments._normaliseName(row.name);
      if (!key) continue;
      if (!nameIndex[key]) nameIndex[key] = [];
      nameIndex[key].push(row);
    }

    const joined = [];
    for (let i = 0; i < paymentRows.length; i++) {
      const pay = paymentRows[i];
      if (Payments._str(pay.tournament_id) !== tournamentId) continue;

      const player = playerById[Payments._str(pay.player_id)] || null;
      const status = Payments._str(pay.status);

      if (wantStatus !== PAYMENT_FILTER_ALL && status !== wantStatus) continue;
      if (wantAuction && (!player || Payments._str(player.auction_status) !== wantAuction)) continue;
      if (wantWithdrawn !== null && (!player || (player.is_withdrawn === true) !== wantWithdrawn)) continue;

      if (search) {
        const hay = [
          player ? Payments._str(player.serial_no) : '',
          player ? Payments._str(player.name) : '',
          player ? Payments._str(player.mobile) : '',
          Payments._str(pay.upi_ref)
        ].join(' ').toLowerCase();
        if (hay.indexOf(search) === -1) continue;
      }

      joined.push({ pay: pay, player: player });
    }

    const total = joined.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    joined.sort((a, b) => Payments._compare(a, b, sortKey));

    const start = (page - 1) * pageSize;
    // A page past the end returns an empty list rather than an error: the admin
    // may be on page 8 when a filter change shrinks the result to two pages.
    const slice = (start >= total) ? [] : joined.slice(start, start + pageSize);

    const rows = slice.map((entry) => Payments._listRow(entry.pay, entry.player, nameIndex));

    return {
      rows: rows,
      page: page,
      pageSize: pageSize,
      total: total,
      totalPages: totalPages,
      counts: Payments._counts(tournamentId, playerRows)
    };
  },

  /**
   * Comparator for payment.list. Ascending on the chosen key, then serial_no, so
   * the order is stable no matter what Sheets hands back.
   * @param {{pay: !Object, player: ?Object}} a left entry
   * @param {{pay: !Object, player: ?Object}} b right entry
   * @param {string} sortKey one of PAYMENT_SORTS
   * @return {number} negative, zero or positive
   */
  _compare(a, b, sortKey) {
    let av;
    let bv;
    if (sortKey === 'serial_no' || sortKey === 'name') {
      av = a.player ? a.player[sortKey] : null;
      bv = b.player ? b.player[sortKey] : null;
    } else {
      av = a.pay[sortKey];
      bv = b.pay[sortKey];
    }

    let cmp;
    if (sortKey === 'serial_no' || sortKey === 'amount') {
      cmp = Util.toInt(av, 0) - Util.toInt(bv, 0);
    } else if (sortKey === 'submitted_at') {
      // submitted_at is a full UTC instant from Util.nowIso(), so Date.parse is
      // the right tool here — unlike a bare IST date, which must never be parsed
      // directly (CONTRACTS.md §6a).
      cmp = (Date.parse(Payments._str(av)) || 0) - (Date.parse(Payments._str(bv)) || 0);
    } else {
      const as = Payments._str(av).toLowerCase();
      const bs = Payments._str(bv).toLowerCase();
      cmp = (as < bs) ? -1 : (as > bs ? 1 : 0);
    }
    if (cmp !== 0) return cmp;

    const asn = a.player ? Util.toInt(a.player.serial_no, 0) : 0;
    const bsn = b.player ? Util.toInt(b.player.serial_no, 0) : 0;
    return asn - bsn;
  },

  /**
   * Build one payment.list row (CONTRACTS-PHASE2 §1).
   *
   * A payment whose player row is missing is still listed, with blank player
   * fields, rather than silently dropped — an admin who can see the broken row
   * can fix it, and one that vanishes is never noticed.
   *
   * @param {!Object} pay the Payments row
   * @param {?Object} player the joined Players row, or null
   * @param {!Object<string, !Array<!Object>>} nameIndex normalised name -> players
   * @return {!Object} the response row. Never carries screenshot_file_id.
   */
  _listRow(pay, player, nameIndex) {
    const amount = Util.toInt(pay.amount, 0);
    const submittedAt = Payments._str(pay.submitted_at);
    return {
      payment_id: pay.payment_id,
      player_id: pay.player_id,
      serial_no: player ? player.serial_no : null,
      name: player ? player.name : '',
      mobile: player ? player.mobile : '',
      upi_ref: pay.upi_ref,
      amount: amount,
      amount_display: Util.formatINR(amount),
      submitted_at: submittedAt,
      submitted_at_display: Util.formatIST(submittedAt, true),
      status: Payments._str(pay.status),
      photo_thumb_url: player ? Payments._str(player.photo_thumb_url) : '',
      possible_duplicate_of: Payments._duplicateHint(player, nameIndex)
    };
  },

  /**
   * The serial number of another player in the same tournament with the same
   * name, or null.
   *
   * A HINT, NEVER A DECISION (DESIGN.md §15 case 15). A player can register
   * twice from two different mobile numbers and no unique constraint catches it,
   * so the admin needs a nudge at verification time. The app only points; the
   * human decides.
   *
   * Exact match after collapsing whitespace and case — deliberately not fuzzy.
   * "Raj Kumar" and "Rajkumar" are left alone, because in a Chennai tournament a
   * near-match on a common name would produce a false accusation against someone
   * who has done nothing wrong.
   *
   * @param {?Object} player the Players row this payment belongs to
   * @param {!Object<string, !Array<!Object>>} nameIndex normalised name -> players
   * @return {?number} the other player's serial number, or null
   */
  _duplicateHint(player, nameIndex) {
    if (!player) return null;
    const key = Payments._normaliseName(player.name);
    if (!key) return null;
    const others = nameIndex[key] || [];
    if (others.length < 2) return null;

    const selfId = Payments._str(player.player_id);
    let best = null;
    for (let i = 0; i < others.length; i++) {
      if (Payments._str(others[i].player_id) === selfId) continue;
      const serial = Util.toInt(others[i].serial_no, 0);
      // The lowest serial among the OTHERS, so with three same-named players the
      // answer is stable rather than dependent on sheet order. Two duplicates
      // each point at the other, which is what the admin needs to compare them.
      if (best === null || serial < best) best = serial;
    }
    return best;
  },

  // ---------------------------------------------------------------------
  // payment.getScreenshot — CONTRACTS-PHASE2 §1
  // ---------------------------------------------------------------------

  /**
   * The payment proof, as inline bytes.
   *
   * ============================ SECURITY BOUNDARY ============================
   * This is the most sensitive action in the system. The screenshot is a payment
   * proof living in the private/payments Drive folder, which is deliberately
   * never shared (CONTRACTS.md §9 rule 2).
   *
   * THE RESPONSE NEVER CONTAINS THE DRIVE FILE ID OR ANY DRIVE URL. This is not
   * tidiness — it is risk #1 in DESIGN.md §16. A Drive link is unauthenticated:
   * anyone who ends up holding it, through a screenshot of the admin screen, a
   * browser history, a shared log or a copied support email, can read another
   * person's bank payment proof with no token at all. The bytes go out as a
   * data: URI so that possessing the response is the only way to see the image,
   * and possessing the response requires an admin token right now.
   *
   * Three consequences, all deliberate:
   *   - No plural variant. There is no payment.getScreenshots, so one request is
   *     one screenshot and one auditable access.
   *   - The data URI is never put in CacheService. It is both too large for the
   *     100 KB per-key limit and too sensitive to leave lying in a shared cache.
   *   - Auth is checked first, then tournament scope, before Drive is touched.
   * ===========================================================================
   *
   * @param {!Object} payload {paymentId}
   * @param {!Object} session the ADMIN session
   * @return {{dataUri: string, mime: string, bytes: number,
   *           player: {serial_no: *, name: string, mobile: string},
   *           upi_ref: string, amount_display: string}} the image and its context
   * @throws {Error} BAD_REQUEST, NOT_FOUND, FORBIDDEN
   */
  getScreenshot(payload, session) {
    const p = payload || {};

    // 1. The route table already ran Auth.require(token, ['ADMIN']) before this
    //    handler was called. Scope comes next, and it needs the payment row, so
    //    the row is read before anything is returned but after the role check.
    const payment = Payments._requirePayment(p.paymentId || p.payment_id);
    Auth.requireTournament(session, Payments._str(payment.tournament_id));

    const fileId = Payments._str(payment.screenshot_file_id);
    if (!fileId) {
      throw Util.AppError(ERR.NOT_FOUND,
        'Payment ' + Payments._str(payment.payment_id) + ' has no screenshot on file.');
    }

    // 2. Bytes only. `fileId` stays in this function and is never put in the
    //    response object below — see the security note above.
    let dataUri;
    try {
      dataUri = Drive.getAsDataUri(fileId);
    } catch (err) {
      // The Drive id must not reach the browser even in an error message.
      console.error('payment.getScreenshot: Drive read failed for payment ' +
        Payments._str(payment.payment_id) + ': ' + err);
      throw Util.AppError(ERR.NOT_FOUND,
        'The screenshot for payment ' + Payments._str(payment.payment_id) +
        ' could not be opened. It may have been removed from Drive.');
    }

    const player = Repo.findBy(Payments._playersTab(), 'player_id', Payments._str(payment.player_id));

    return {
      dataUri: dataUri,
      mime: Payments._dataUriMime(dataUri),
      bytes: Payments._dataUriBytes(dataUri),
      player: {
        serial_no: player ? player.serial_no : null,
        name: player ? Payments._str(player.name) : '',
        mobile: player ? Payments._str(player.mobile) : ''
      },
      upi_ref: Payments._str(payment.upi_ref),
      amount_display: Util.formatINR(Util.toInt(payment.amount, 0))
    };
  },

  /**
   * The mime type declared inside a data: URI.
   * @param {string} dataUri e.g. "data:image/jpeg;base64,...."
   * @return {string} e.g. "image/jpeg", '' when the URI is not shaped as expected
   */
  _dataUriMime(dataUri) {
    const m = /^data:([^;,]+)[;,]/.exec(String(dataUri || ''));
    return m ? m[1] : '';
  },

  /**
   * Decoded size of a base64 data: URI, in bytes.
   *
   * Computed from the string rather than decoded: the frontend only wants a
   * number to show ("312 KB"), and decoding a multi-megabyte payload a second
   * time to count it would be pure waste.
   *
   * @param {string} dataUri the data URI
   * @return {number} decoded byte count, 0 when it cannot be worked out
   */
  _dataUriBytes(dataUri) {
    const s = String(dataUri || '');
    const comma = s.indexOf(',');
    if (comma === -1) return 0;
    const b64 = s.substring(comma + 1);
    if (!b64) return 0;
    let padding = 0;
    if (b64.charAt(b64.length - 1) === '=') padding++;
    if (b64.charAt(b64.length - 2) === '=') padding++;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - padding);
  },

  // ---------------------------------------------------------------------
  // payment.verify and payment.reject — CONTRACTS-PHASE2 §1
  // ---------------------------------------------------------------------

  /**
   * Mark a payment VERIFIED. The player becomes eligible for the auction pool.
   *
   * Verifying an already-VERIFIED payment is a NO-OP SUCCESS, not an error
   * (DESIGN.md §15 case 4): two admins working the same queue will click the
   * same row, and that is normal, not an exception.
   *
   * Verifying a REJECTED payment is allowed and audited as a reversal. People do
   * change their minds after a second look at the bank statement.
   *
   * @param {!Object} payload {paymentId, note}
   * @param {!Object} session the ADMIN session
   * @return {!Object} {payment_id, player_id, serial_no, status, verified_at_display,
   *     counts, alreadyVerified?, reversedFrom?, mirrorRepaired?}
   * @throws {Error} BAD_REQUEST, NOT_FOUND, FORBIDDEN, SYSTEM_BUSY
   */
  verify(payload, session) {
    return Payments._decide(payload, session, ENUM.PAYMENT_STATUS.VERIFIED);
  },

  /**
   * Mark a payment REJECTED, with a reason.
   *
   * `reason` is mandatory and 3-200 characters. A rejection with no reason
   * cannot be explained to the player who paid, and DESIGN.md §16 risk 6 makes
   * disputes an expected part of the day.
   *
   * REJECTING NEVER DELETES ANYTHING. The Players row, both images and above all
   * the serial number all stay exactly where they are — serials are never reused
   * (DESIGN.md §9). Only payment_status changes.
   *
   * Rejecting an already-REJECTED payment is a no-op success; rejecting a
   * VERIFIED one is allowed and audited as a reversal.
   *
   * @param {!Object} payload {paymentId, reason}
   * @param {!Object} session the ADMIN session
   * @return {!Object} {payment_id, player_id, serial_no, status, reject_reason,
   *     counts, alreadyRejected?, reversedFrom?, mirrorRepaired?}
   * @throws {Error} VALIDATION_FAILED when the reason is missing or too short
   */
  reject(payload, session) {
    return Payments._decide(payload, session, ENUM.PAYMENT_STATUS.REJECTED);
  },

  /**
   * Validate a rejection reason.
   * @param {*} value the raw reason from the payload
   * @return {string} the trimmed reason
   * @throws {Error} VALIDATION_FAILED naming the field and the real limits
   */
  _requireReason(value) {
    const reason = Payments._str(value).replace(/\s+/g, ' ');
    if (!reason) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'A reason is required to reject a payment. The player has to be told why.');
    }
    if (reason.length < PAYMENT_REASON_MIN) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The rejection reason is only ' + reason.length + ' characters. ' +
        'Please write at least ' + PAYMENT_REASON_MIN + ' — the player has to be told why.');
    }
    if (reason.length > PAYMENT_REASON_MAX) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The rejection reason is ' + reason.length + ' characters. ' +
        'The limit is ' + PAYMENT_REASON_MAX + '.');
    }
    return reason;
  },

  /**
   * The shared body of verify and reject (CONTRACTS-PHASE2 §1).
   *
   * Both decisions have exactly the same shape, so they share one implementation
   * — two copies of a locked read-modify-mirror-audit section is how the two
   * paths drift apart.
   *
   * @param {!Object} payload {paymentId, reason?, note?, ua?}
   * @param {!Object} session the ADMIN session
   * @param {string} target ENUM.PAYMENT_STATUS.VERIFIED or .REJECTED
   * @return {!Object} the response described on verify() / reject()
   * @throws {Error} BAD_REQUEST, VALIDATION_FAILED, NOT_FOUND, FORBIDDEN, SYSTEM_BUSY
   */
  _decide(payload, session, target) {
    const p = payload || {};
    const paymentId = Payments._str(p.paymentId || p.payment_id);
    if (!paymentId) {
      throw Util.AppError(ERR.BAD_REQUEST, 'A payment id is required.');
    }

    // The reason is validated before the lock is taken. A missing reason is the
    // commonest mistake here and there is no sense serialising the whole system
    // behind a request that cannot succeed.
    const reason = (target === ENUM.PAYMENT_STATUS.REJECTED)
      ? Payments._requireReason(p.reason) : '';
    const note = Payments._str(p.note).substring(0, PAYMENT_REASON_MAX);
    const ua = Payments._str(p.ua);
    const actor = session ? Payments._str(session.user_id) : '';
    const actorRole = session ? Payments._str(session.role) : '';

    const outcome = Repo.withLock(function () {
      // 1. Re-read inside the lock. The client's copy of the row is never
      //    trusted: another admin may have decided this payment in the seconds
      //    since the queue was drawn, and that decision is the one that counts.
      const payment = Payments._requirePayment(paymentId);
      Auth.requireTournament(session, Payments._str(payment.tournament_id));

      const player = Payments._requirePlayer(payment);
      const prevStatus = Payments._str(payment.status);
      const prevMirror = Payments._str(player.payment_status);

      // 2. Already at the target status -> no-op success, NOT an error
      //    (DESIGN.md §15 case 4). Two admins clicking the same row in a shared
      //    queue is ordinary behaviour and must not produce a scary message.
      if (prevStatus === target) {
        // One exception to "no-op": if the Players mirror somehow disagrees,
        // repair it. A payment that says VERIFIED next to a player that says
        // PENDING is precisely the drift that keeps a paid player out of the
        // auction pool (DESIGN.md §14), and returning "already done" while
        // leaving it broken would hide the fault for ever.
        let repaired = false;
        if (prevMirror !== target) {
          Repo.updateRow(Payments._playersTab(), player._row, { payment_status: target });
          Repo.flush();
          Payments._bumpIfAuctionLive(Payments._str(payment.tournament_id));
          repaired = true;
          console.error('payment mirror repaired: payment ' + paymentId + ' was ' + target +
            ' but player ' + Payments._str(player.player_id) + ' was "' + prevMirror + '".');
        }
        return {
          tournamentId: Payments._str(payment.tournament_id),
          payment: payment,
          player: player,
          prevStatus: prevStatus,
          noop: true,
          repaired: repaired,
          // The admin who decided this the FIRST time, not the one clicking now.
          decidedBy: Payments._str(payment.verified_by),
          verifiedAt: Payments._str(payment.verified_at),
          reason: Payments._str(payment.reject_reason)
        };
      }

      // 3. Moving straight between VERIFIED and REJECTED is allowed, but it is a
      //    reversal of an earlier human decision, so it is flagged and audited
      //    as one rather than recorded as an ordinary first pass.
      const reversedFrom = (prevStatus === ENUM.PAYMENT_STATUS.VERIFIED ||
                            prevStatus === ENUM.PAYMENT_STATUS.REJECTED) ? prevStatus : null;

      const decidedAt = Util.nowIso();
      const patch = {
        status: target,
        // verified_by / verified_at are the "who decided, and when" pair for both
        // outcomes — the status column alongside them says which decision it was.
        // Without this a rejection would only be traceable through the AuditLog.
        verified_by: actor,
        verified_at: decidedAt,
        // A VERIFIED row must not keep an old rejection reason next to it, and a
        // REJECTED row must carry the current one.
        reject_reason: (target === ENUM.PAYMENT_STATUS.REJECTED) ? reason : ''
      };
      Repo.updateRow(Payments._tab(), payment._row, patch);

      // 4. MIRROR THE STATUS ONTO THE PLAYERS ROW, in this same locked section.
      //    The auction pool reads Players.payment_status, not the Payments tab
      //    (DESIGN.md §14, CONTRACTS-PHASE2 §2). If these two ever drift, an
      //    unpaid or rejected player reaches the auction table, or a player who
      //    genuinely paid is turned away in front of an audience. Writing both
      //    inside one lock and flushing before release is what keeps them equal.
      Repo.updateRow(Payments._playersTab(), player._row, { payment_status: target });

      // 5. The audit row. CONTRACTS-PHASE2 §4: actor, both values, timestamp.
      //    This trail is what settles a dispute about whether someone actually
      //    paid (DESIGN.md §42), so it records the mirror as well as the payment
      //    and marks a reversal explicitly — Audit.ACTIONS has no separate
      //    reversal constant, so it lives in the values.
      Audit.log({
        actor: actor,
        role: actorRole,
        action: (target === ENUM.PAYMENT_STATUS.VERIFIED)
          ? Audit.ACTIONS.PAYMENT_VERIFIED : Audit.ACTIONS.PAYMENT_REJECTED,
        tournamentId: Payments._str(payment.tournament_id),
        entityType: 'Payment',
        entityId: paymentId,
        prev: {
          status: prevStatus,
          player_payment_status: prevMirror,
          reject_reason: Payments._str(payment.reject_reason),
          verified_by: Payments._str(payment.verified_by),
          verified_at: Payments._str(payment.verified_at)
        },
        next: {
          status: target,
          player_payment_status: target,
          player_id: Payments._str(player.player_id),
          serial_no: player.serial_no,
          reject_reason: patch.reject_reason,
          verified_by: actor,
          verified_at: decidedAt,
          reversal: reversedFrom !== null,
          reversed_from: reversedFrom,
          note: note
        },
        ua: ua
      });

      // 6. Push both row writes out before the lock is released, so the next
      //    admin's re-read actually sees this decision.
      Repo.flush();

      // 7. Tell any live auction screen that the pool just changed.
      Payments._bumpIfAuctionLive(Payments._str(payment.tournament_id));

      return {
        tournamentId: Payments._str(payment.tournament_id),
        payment: payment,
        player: player,
        prevStatus: prevStatus,
        noop: false,
        decidedBy: actor,
        repaired: false,
        reversedFrom: reversedFrom,
        verifiedAt: decidedAt,
        reason: patch.reject_reason
      };
    });
    // ================================ UNLOCK ================================

    // Counts are gathered after the lock is released. They are a read of the
    // whole tournament and nothing depends on them being atomic with the write,
    // so holding the script-wide lock for them would slow every other admin down
    // for no gain.
    const counts = Payments._counts(outcome.tournamentId, Payments._playersOf(outcome.tournamentId));

    const out = {
      payment_id: Payments._str(outcome.payment.payment_id),
      player_id: Payments._str(outcome.player.player_id),
      serial_no: outcome.player.serial_no,
      status: target,
      counts: counts
    };

    if (target === ENUM.PAYMENT_STATUS.VERIFIED) {
      out.verified_at_display = Util.formatIST(outcome.verifiedAt, true);
      if (outcome.noop) out.alreadyVerified = true;
    } else {
      out.reject_reason = outcome.reason;
      out.rejected_at_display = Util.formatIST(outcome.verifiedAt, true);
      if (outcome.noop) out.alreadyRejected = true;
    }

    // Who made the decision. On a no-op this is the ORIGINAL decider, not the
    // admin who just clicked — that is the whole point of surfacing it. Two
    // admins working the same 400-row queue will land on the same row, and
    // "already verified by Priya at 3:42 PM" tells them what happened, while a
    // bare "already verified" leaves them wondering if they misclicked.
    // Resolved to a display name because a USR_ id means nothing on screen.
    if (outcome.decidedBy) {
      out.decided_by = outcome.decidedBy;
      out.decided_by_name = Payments._displayName(outcome.decidedBy);
    }

    if (outcome.reversedFrom) out.reversedFrom = outcome.reversedFrom;
    if (outcome.repaired) out.mirrorRepaired = true;

    return out;
  },

  /**
   * Resolve a user id to a display name for the UI.
   *
   * Falls back to the id when the row is gone — a disabled or deleted organiser
   * must not make a payment screen fail. Never returns the email: this string is
   * rendered to another admin and the id is enough to trace in the audit log.
   *
   * @param {string} userId the actor id recorded on the payment
   * @return {string} a human-readable name, or the id, or ''
   */
  _displayName(userId) {
    const id = Payments._str(userId);
    if (!id) return '';
    try {
      const tab = (typeof SHEETS !== 'undefined' && SHEETS.USERS) ? SHEETS.USERS : 'Users';
      const row = Repo.findBy(tab, 'user_id', id);
      const name = row ? Payments._str(row.display_name) : '';
      return name || id;
    } catch (e) {
      return id;
    }
  }
};

/**
 * Payment route table.
 *
 * Every action is ADMIN and POST. None is offered on GET: verify and reject
 * write, and getScreenshot would put a payment proof behind a URL that lands in
 * browser history and server logs — the exact leak DESIGN.md §16 risk 1 exists
 * to prevent. payment.list is a POST for the same reason it is everywhere else
 * in this project: the session token travels in the body (CONTRACTS.md §11).
 *
 * There is deliberately no bulk verify (CONTRACTS-PHASE2 §5). "Verify all
 * pending" would defeat the entire point of a human checking each UPI reference
 * against a bank statement.
 *
 * @return {!Object} route table fragment
 */
function PaymentRoutes() {
  return {
    'payment.list': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, filter, page, pageSize, sort}
       * @param {!Object} session ADMIN session
       * @return {!Object} {rows, page, pageSize, total, totalPages, counts}
       */
      handler: (payload, session) => Payments.list(payload, session)
    },

    'payment.getScreenshot': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {paymentId}
       * @param {!Object} session ADMIN session
       * @return {!Object} {dataUri, mime, bytes, player, upi_ref, amount_display}
       */
      handler: (payload, session) => Payments.getScreenshot(payload, session)
    },

    'payment.verify': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {paymentId, note}
       * @param {!Object} session ADMIN session
       * @return {!Object} {payment_id, player_id, serial_no, status, verified_at_display, counts}
       */
      handler: (payload, session) => Payments.verify(payload, session)
    },

    'payment.reject': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {paymentId, reason}
       * @param {!Object} session ADMIN session
       * @return {!Object} {payment_id, player_id, serial_no, status, counts}
       */
      handler: (payload, session) => Payments.reject(payload, session)
    }
  };
}
