/**
 * Players.gs — player registration, validation and the admin player list.
 *
 * Implements CONTRACTS-PHASE1.md §2 (player.register, player.checkMobile) and §3
 * (registration validation). Flow rationale is DESIGN.md §6.2; the user-facing
 * messages are DESIGN.md §11 verbatim and must stay that way — players read them.
 *
 * PHASE 1 — registration (DESIGN.md §6.2, §11)
 *   player.checkMobile     PUBLIC. Returns {taken: true|false}. Rate-limited.
 *   player.register        PUBLIC. Photo and payment screenshot arrive as base64
 *                          in the JSON body. Allocates the serial number inside
 *                          the script lock (Repo.nextSerial, §6.2) and creates
 *                          the matching PENDING row in Payments.
 *                          Returns the serial number.
 *
 * PHASE 2 — admin review (CONTRACTS-PHASE2.md §1, §2, §3)
 *   player.list            ADMIN, or ORGANISER for their own tournament. Paged,
 *                          filterable by payment_status, auction_status and the
 *                          withdrawn flag, and searchable across serial_no,
 *                          name, mobile and upi_ref. One Repo.readAll per tab.
 *   player.setWithdrawn    ADMIN. Marks a player as pulled out. The serial number
 *                          stays reserved for ever (DESIGN.md §9, §15 case 16).
 *
 *   Players.isAuctionEligible / Players.eligibleCount / Players.counts
 *                          The single definition of the verified pool
 *                          (CONTRACTS-PHASE2.md §2) and the tournament-wide
 *                          counts object (§3). Phase 4's auction and Payments.gs
 *                          both call these rather than re-deriving the rule.
 *
 * ONE FIELD, ONE WRITER: payment_status on the Players row is a MIRROR of the
 * Payments row and is maintained by Payments.gs alone. This file reads it and
 * never writes it — two writers for one field is how the auction pool ends up
 * disagreeing with the payment queue.
 */

/**
 * Cache namespace for the player.checkMobile rate limiter.
 * Not one of the CONTRACTS §8 prefixes because it is local to this module.
 * @const {string}
 */
const PLAYER_MOBILE_CHECK_PREFIX = 'mobcheck:';

/** Rate-limit window for player.checkMobile, in seconds (10 minutes). @const {number} */
const PLAYER_MOBILE_CHECK_WINDOW_SEC = 600;

/** Calls allowed per mobile number per window (CONTRACTS-PHASE1 §2). @const {number} */
const PLAYER_MOBILE_CHECK_MAX = 20;

/**
 * Name shape from CONTRACTS-PHASE1 §3: letters, spaces, dots, apostrophes and
 * hyphens, starting with a letter. Deliberately no digits — a serial number typed
 * into the name field is the commonest form filling mistake and it corrupts
 * search_blob.
 *
 * \p{L} matches a letter in ANY script, not just A-Z. \p{M} matches combining
 * marks, which Tamil and Devanagari need for vowel signs and the virama — without
 * it "ராஜ் குமார்" is rejected even though \p{L} covers the base letters. This is
 * a Chennai tournament; an ASCII-only pattern would turn away players writing
 * their own name in their own script.
 *
 * The `u` flag is required for \p{...} to be interpreted as a property escape.
 * @const {!RegExp}
 */
const PLAYER_NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'\-]*$/u;

/** Bare calendar date. DOB is a date, never an instant (CONTRACTS §6a). @const {!RegExp} */
const PLAYER_DOB_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** UPI reference: 6-35 alphanumerics (CONTRACTS-PHASE1 §3). @const {!RegExp} */
const PLAYER_UPI_REF_PATTERN = /^[A-Za-z0-9]{6,35}$/;

/** Youngest age accepted at the tournament start date. @const {number} */
const PLAYER_MIN_AGE = 8;

/** Oldest age accepted at the tournament start date. @const {number} */
const PLAYER_MAX_AGE = 70;

/** Longest a player name may be, in characters. @const {number} */
const PLAYER_NAME_MAX = 60;

/** Shortest a player name may be, in characters. @const {number} */
const PLAYER_NAME_MIN = 2;

/**
 * The player-facing validation messages, copied verbatim from DESIGN.md §11.
 *
 * These strings are rendered straight into the registration form, so they are
 * part of the contract, not an implementation detail. Do not reword them.
 * ROLE, STYLE and UPI_REF_FORMAT have no §11 wording (the table leaves them "—"),
 * so they follow the same plain-English style as the rest.
 *
 * @const {!Object<string,string>}
 */
const PLAYER_MSG = Object.freeze({
  NAME: 'Please enter your full name.',
  DOB: 'Please check the date of birth.',
  ROLE: 'Please choose a playing role.',
  STYLE: 'Please choose a playing style.',
  MOBILE: 'Enter a 10-digit mobile number.',
  MOBILE_DUPLICATE: 'A registration already exists for this mobile number. Please contact the tournament organiser.',
  UPI_REF_FORMAT: 'Please enter the UPI reference number from your payment app. It is 6 to 35 letters or numbers.',
  UPI_REF_DUPLICATE: 'This UPI reference number has already been used.',
  PHOTO: 'Please upload a clear photo.',
  SCREENSHOT: 'Please upload your payment screenshot.',
  WINDOW: 'Registration is closed for this tournament.',
  NO_TOURNAMENT: 'That tournament was not found. Please check the registration link.',
  TOO_MANY_CHECKS: 'Too many checks for this number. Please wait a few minutes and try again.'
});

/** Rows per page when the caller does not ask (CONTRACTS-PHASE2 §1). @const {number} */
const PLAYER_LIST_DEFAULT_PAGE_SIZE = 50;

/**
 * Hard ceiling on pageSize (CONTRACTS-PHASE2 §1). A caller asking for 5000 rows
 * is asking for a payload the browser has to render and Apps Script has to
 * serialise; 200 is the largest page that still keeps the screen usable.
 * @const {number}
 */
const PLAYER_LIST_MAX_PAGE_SIZE = 200;

/**
 * The four sort keys CONTRACTS-PHASE2 §1 allows. Anything else is rejected
 * rather than silently falling back, because a typo that quietly reorders a
 * paged list makes rows appear twice or not at all.
 * @const {!Array<string>}
 */
const PLAYER_LIST_SORTS = Object.freeze(['serial_no', 'name', 'registered_at', 'payment_status']);

/** Longest withdrawal reason kept on the audit row, in characters. @const {number} */
const PLAYER_WITHDRAW_REASON_MAX = 200;

const Players = {

  // ---------------------------------------------------------------------------
  // player.register — CONTRACTS-PHASE1 §2, DESIGN.md §6.2
  // ---------------------------------------------------------------------------

  /**
   * Register one player: validate, upload three images, allocate a serial number
   * and write the Players + Payments rows.
   *
   * THE EXECUTION ORDER BELOW IS THE CONTRACT (CONTRACTS-PHASE1 §2). The twelve
   * numbered steps and, above all, where the lock opens and closes, are load
   * bearing. See the comment at the lock boundary before changing anything.
   *
   * @param {!Object} payload {tournamentId, name, dob, role, style, mobile, upiRef,
   *     photo, photoThumb, screenshot}. Each image is {data, mime, filename} with
   *     `data` base64 and no `data:` prefix (CONTRACTS-PHASE1 §1).
   * @return {{player_id: string, serial_no: number, name: string,
   *           tournament_name: string, registered_at_display: string}} confirmation
   * @throws {!Error} VALIDATION_FAILED, DUPLICATE_MOBILE, DUPLICATE_UPI_REF,
   *     REGISTRATION_CLOSED, NOT_FOUND or SYSTEM_BUSY
   */
  register(payload) {
    const p = payload || {};
    const tournamentId = String(p.tournamentId === null || p.tournamentId === undefined ? '' : p.tournamentId).trim();
    let step = 'start';

    try {
      // ===================================================================
      // OUTSIDE THE LOCK — the slow ~2-3s part (CONTRACTS-PHASE1 §2 steps 1-5)
      // ===================================================================

      // Step 1/2 — load the tournament, then validate every field. The
      // tournament comes first because the age check needs its start_date.
      step = 'load-tournament';
      const tournament = Players._requireTournament(tournamentId);

      step = 'validate';
      const clean = Players._validate(p, tournament);

      // Step 2 (cont.) — status and window. Courtesy only; step 6 decides.
      step = 'window-precheck';
      Players._requireRegistrationOpen(tournament);

      // Step 3 — cheap duplicate pre-check, so the common mistake fails in
      // milliseconds instead of after a three-second upload. NOT authoritative.
      step = 'duplicate-precheck';
      if (Players._isMobileTaken(tournamentId, clean.mobile)) {
        throw Util.AppError(ERR.DUPLICATE_MOBILE, PLAYER_MSG.MOBILE_DUPLICATE);
      }
      if (Players._isUpiRefTaken(tournamentId, clean.upiRef)) {
        throw Util.AppError(ERR.DUPLICATE_UPI_REF, PLAYER_MSG.UPI_REF_DUPLICATE);
      }

      // Ids are minted here rather than inside the lock so the Drive filenames
      // can carry them. Util.uid is SHA-256 over two UUIDs, so two simultaneous
      // registrations will not collide even though nothing is serialising them.
      const playerId = Util.uid(ID_PREFIX.PLAYER);
      const paymentId = Util.uid(ID_PREFIX.PAYMENT);

      step = 'folders';
      const folders = Drive.ensureTournamentFolders(tournament.tournament_id, tournament.slug);

      // Step 4 — photo and thumbnail go to the PUBLIC players folder. They are
      // shown on the projector and in the admin list, so they need a link that
      // works without a token.
      step = 'upload-photo';
      const photoFileId = Drive.uploadImage(
        folders.playersId, clean.photo.data, clean.photo.mime,
        playerId + '-photo' + Players._ext(clean.photo.mime));

      step = 'upload-thumb';
      const thumbFileId = Drive.uploadImage(
        folders.playersId, clean.photoThumb.data, clean.photoThumb.mime,
        playerId + '-thumb' + Players._ext(clean.photoThumb.mime));

      // Step 5 — the payment screenshot goes to the PRIVATE payments folder.
      // This is risk #1 in DESIGN.md §16: a Drive link is unauthenticated, so a
      // screenshot in a public folder is a payment proof on a guessable URL.
      // It reaches a browser only through Drive.getAsDataUri behind an admin
      // token. Never move this upload to folders.playersId.
      step = 'upload-screenshot';
      const screenshotFileId = Drive.uploadImage(
        folders.paymentsId, clean.screenshot.data, clean.screenshot.mime,
        paymentId + '-payment' + Players._ext(clean.screenshot.mime));

      // ===================================================================
      // LOCK BOUNDARY — everything above ran unlocked ON PURPOSE.
      //
      // The three uploads take ~2-3 seconds. Holding the script-wide lock for
      // that long would cap the WHOLE system at roughly 20 registrations per
      // minute, and DESIGN.md §13 shows that breaking on deadline night is the
      // one place 400 players actually bites. Locked, this section is ~200 ms,
      // which is about ten times the safe throughput (DESIGN.md §6.2).
      //
      // Only what genuinely has to be serialised goes inside: the authoritative
      // re-checks, the serial allocation and the two row writes.
      // ===================================================================
      step = 'locked-section';
      const written = Repo.withLock(function () {
        // Re-read the tournament. The row on disk may have changed while the
        // images were uploading, and the copy loaded in step 2 is now stale.
        const fresh = Players._requireTournament(tournamentId);

        // Step 6 — re-check the window. An organiser can flip the status to
        // REG_CLOSED, or the IST deadline can pass, during those 3 seconds.
        Players._requireRegistrationOpen(fresh);

        // Steps 7 and 8 — re-check both duplicates. This is NOT a redundant
        // copy of step 3 and must not be "optimised" away. Two players can be
        // uploading at the same instant with the same mobile number or the same
        // UPI reference; neither one saw the other in the unlocked pre-check.
        // Only this check, inside the lock, decides (DESIGN.md §6.2).
        if (Players._isMobileTaken(tournamentId, clean.mobile)) {
          throw Util.AppError(ERR.DUPLICATE_MOBILE, PLAYER_MSG.MOBILE_DUPLICATE);
        }
        if (Players._isUpiRefTaken(tournamentId, clean.upiRef)) {
          throw Util.AppError(ERR.DUPLICATE_UPI_REF, PLAYER_MSG.UPI_REF_DUPLICATE);
        }

        // If either re-check just failed, the three files uploaded above are now
        // orphaned in Drive with no row pointing at them. That is the accepted
        // trade (DESIGN.md §6.2): deleting them here would put three more Drive
        // round-trips inside the lock, which is exactly what the split exists to
        // avoid. A weekly sweep removes files with no matching row.

        // Step 9 — serial allocation. Repo.nextSerial deliberately does not lock
        // itself; the caller owns the critical section (CONTRACTS §5.4). Read
        // then write without this lock hands two players the same number.
        const serialNo = Repo.nextSerial(tournamentId);

        // One server-side instant shared by both rows, so the player row and its
        // payment row can never disagree about when the registration happened.
        const registeredAt = Util.nowIso();

        // Step 10 — the Players row.
        Repo.append(SHEETS.PLAYERS, {
          player_id: playerId,
          tournament_id: tournamentId,
          serial_no: serialNo,
          name: clean.name,
          dob: clean.dob,
          age_years: clean.ageYears,
          role: clean.role,
          style: clean.style,
          mobile: clean.mobile,
          photo_file_id: photoFileId,
          photo_thumb_url: Drive.thumbUrl(thumbFileId, DRIVE_DEFAULT_THUMB_WIDTH),
          payment_status: ENUM.PAYMENT_STATUS.PENDING,
          auction_status: ENUM.AUCTION_STATUS.PENDING,
          times_called: 0,
          team_id: '',
          sold_amount: '',
          sold_at: '',
          is_withdrawn: false,
          search_blob: clean.searchBlob,
          registered_at: registeredAt
        });

        // Step 11 — the Payments row, in the SAME locked section. A Players row
        // without its Payments row would sit in the admin queue for ever as a
        // registration that can never be verified or rejected.
        Repo.append(SHEETS.PAYMENTS, {
          payment_id: paymentId,
          tournament_id: tournamentId,
          player_id: playerId,
          upi_ref: clean.upiRef,
          amount: Players._regFee(fresh),
          screenshot_file_id: screenshotFileId,
          status: ENUM.PAYMENT_STATUS.PENDING,
          verified_by: '',
          verified_at: '',
          reject_reason: '',
          submitted_at: registeredAt
        });

        // Step 12 — push both writes out before the lock is released, so the
        // next registration's re-check actually sees this one.
        Repo.flush();

        return { serial_no: serialNo, registered_at: registeredAt };
      });
      // =============================== UNLOCK ============================

      // A successful registration is ordinary business, not a security event, so
      // it is deliberately NOT written to the AuditLog (CONTRACTS §10 has no
      // action for it). The Players row is itself the record.
      return {
        player_id: playerId,
        serial_no: written.serial_no,
        name: clean.name,
        tournament_name: tournament.name,
        registered_at_display: Util.formatIST(written.registered_at, true)
      };
    } catch (err) {
      // Debuggable without being a data leak: the tournament id, the step and
      // the error code are enough to find the problem in Stackdriver. Never log
      // the name, mobile, UPI reference or any image bytes.
      const code = (err && err.code) ? err.code : 'INTERNAL_ERROR';
      const detail = (err && err.isAppError) ? '' : ' detail=' + ((err && err.message) ? err.message : String(err));
      console.log('player.register failed: tournament=' + tournamentId +
        ' step=' + step + ' code=' + code + detail);
      throw err;
    }
  },

  // ---------------------------------------------------------------------------
  // player.checkMobile — CONTRACTS-PHASE1 §2
  // ---------------------------------------------------------------------------

  /**
   * Is this mobile number already registered in this tournament?
   *
   * A courtesy for the form so it can warn before the player picks and uploads
   * two photos. It is NOT a guarantee — the authoritative check runs inside the
   * lock in register().
   *
   * The response is `{taken}` and nothing else, ever. Returning the name, the
   * serial or even a registration date would turn a public endpoint into a
   * lookup service for "is this person playing".
   *
   * @param {!Object} payload {tournamentId, mobile}
   * @return {{taken: boolean}} whether the number is already used
   * @throws {!Error} VALIDATION_FAILED on a bad number, BAD_REQUEST when rate limited
   */
  checkMobile(payload) {
    const p = payload || {};
    const tournamentId = String(p.tournamentId === null || p.tournamentId === undefined ? '' : p.tournamentId).trim();
    if (Util.isBlank(tournamentId)) {
      throw Util.AppError(ERR.BAD_REQUEST, 'No tournament was given. Please open the registration link again.');
    }

    const mobile = String(p.mobile === null || p.mobile === undefined ? '' : p.mobile).trim();
    if (!Util.isValidMobileIN(mobile)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.MOBILE);
    }

    // Rate limit AFTER the format check, so a typo does not burn an allowance,
    // and BEFORE the sheet read, so a flood costs no Spreadsheet quota.
    Players._rateLimitMobileCheck(mobile);

    // The tournament row is deliberately not loaded. This endpoint needs to stay
    // cheap, and an unknown tournament simply answers "not taken" and then fails
    // properly at register() time with NOT_FOUND.
    return { taken: Players._isMobileTaken(tournamentId, mobile) };
  },

  /**
   * Fixed-window rate limiter for player.checkMobile: PLAYER_MOBILE_CHECK_MAX
   * calls per PLAYER_MOBILE_CHECK_WINDOW_SEC, keyed on the mobile number.
   *
   * WHY THIS EXISTS: without it, `{taken: true|false}` is an enumeration oracle.
   * Indian mobile numbers are a small, dense keyspace, so anyone could walk it
   * and learn exactly who has registered for a tournament — a privacy leak out
   * of an endpoint that returns a single boolean.
   *
   * @param {string} mobile validated 10-digit number
   * @return {void}
   * @throws {!Error} BAD_REQUEST once the allowance for this number is spent
   */
  _rateLimitMobileCheck(mobile) {
    const key = PLAYER_MOBILE_CHECK_PREFIX + mobile;
    const now = Date.now();

    let entry = Cache.getRaw(key);
    if (!entry || typeof entry !== 'object' || !(Number(entry.resetAt) > now)) {
      entry = { n: 0, resetAt: now + PLAYER_MOBILE_CHECK_WINDOW_SEC * 1000 };
    }
    entry.n = Util.toInt(entry.n, 0) + 1;

    // Write back with the REMAINING window, never a fresh full one. Refreshing
    // the TTL on every call would keep extending a block that has already
    // started, so an honest player who hit the limit could never get out of it.
    const remainingSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    Cache.putRaw(key, entry, remainingSec);

    if (entry.n > PLAYER_MOBILE_CHECK_MAX) {
      // BAD_REQUEST rather than SYSTEM_BUSY on purpose: the frontend auto-retries
      // SYSTEM_BUSY (DESIGN.md §13), which would fight the limiter.
      throw Util.AppError(ERR.BAD_REQUEST, PLAYER_MSG.TOO_MANY_CHECKS);
    }
  },

  // ---------------------------------------------------------------------------
  // Validation — CONTRACTS-PHASE1 §3, messages from DESIGN.md §11
  // ---------------------------------------------------------------------------

  /**
   * Validate and normalise every registration field.
   *
   * Everything is re-checked here even though the browser checked it too: the
   * browser can be bypassed and the /exec URL is public (DESIGN.md §11).
   *
   * @param {!Object} p the raw payload
   * @param {!Object} tournament the Tournaments row, for start_date
   * @return {{name: string, dob: string, ageYears: number, role: string,
   *           style: string, mobile: string, upiRef: string, searchBlob: string,
   *           photo: !Object, photoThumb: !Object, screenshot: !Object}} clean fields
   * @throws {!Error} VALIDATION_FAILED with the DESIGN.md §11 message
   */
  _validate(p, tournament) {
    // Collapse runs of whitespace so "Raj   Kumar" and "Raj Kumar" are one name
    // and search_blob stays comparable.
    const name = String(p.name === null || p.name === undefined ? '' : p.name).trim().replace(/\s+/g, ' ');
    if (name.length < PLAYER_NAME_MIN || name.length > PLAYER_NAME_MAX ||
        !PLAYER_NAME_PATTERN.test(name)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.NAME);
    }

    const dob = String(p.dob === null || p.dob === undefined ? '' : p.dob).trim();
    if (!PLAYER_DOB_PATTERN.test(dob)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.DOB);
    }

    // Age is computed at the tournament START date, not today: a junior category
    // must be decided by the age on the day they play, and the answer must not
    // change between registering and the tournament. Util.ageYears compares
    // calendar dates, so no timezone can shift it (CONTRACTS §6a).
    let ageYears;
    try {
      ageYears = Util.ageYears(dob, tournament.start_date);
    } catch (e) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.DOB);
    }
    if (ageYears < PLAYER_MIN_AGE || ageYears > PLAYER_MAX_AGE) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.DOB);
    }

    const role = String(p.role === null || p.role === undefined ? '' : p.role).trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(ENUM.PLAYER_ROLE, role)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.ROLE);
    }

    const style = String(p.style === null || p.style === undefined ? '' : p.style).trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(ENUM.PLAYER_STYLE, style)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.STYLE);
    }

    const mobile = String(p.mobile === null || p.mobile === undefined ? '' : p.mobile).trim();
    if (!Util.isValidMobileIN(mobile)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.MOBILE);
    }

    const upiRef = String(p.upiRef === null || p.upiRef === undefined ? '' : p.upiRef).trim();
    if (!PLAYER_UPI_REF_PATTERN.test(upiRef)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, PLAYER_MSG.UPI_REF_FORMAT);
    }

    // Presence and shape only. Drive.uploadImage does the real work — declared
    // mime, decoded size and magic number (CONTRACTS §9.3) — and its messages
    // are already player-facing.
    const photo = Players._requireImage(p.photo, PLAYER_MSG.PHOTO);
    const photoThumb = Players._requireImage(p.photoThumb, PLAYER_MSG.PHOTO);
    const screenshot = Players._requireImage(p.screenshot, PLAYER_MSG.SCREENSHOT);

    return {
      name: name,
      dob: dob,
      ageYears: ageYears,
      role: ENUM.PLAYER_ROLE[role],
      style: ENUM.PLAYER_STYLE[style],
      mobile: mobile,
      upiRef: upiRef,
      // Phase 4 search reads this one column instead of three (CONTRACTS-PHASE1 §3).
      searchBlob: (name + ' ' + ENUM.PLAYER_ROLE[role] + ' ' + ENUM.PLAYER_STYLE[style]).toLowerCase(),
      photo: photo,
      photoThumb: photoThumb,
      screenshot: screenshot
    };
  },

  /**
   * Check that an image field is present and shaped like {data, mime}.
   * @param {*} img candidate image object from the payload
   * @param {string} message the DESIGN.md §11 message to show if it is not
   * @return {{data: string, mime: string, filename: (string|undefined)}} the image
   * @throws {!Error} VALIDATION_FAILED
   */
  _requireImage(img, message) {
    if (!img || typeof img !== 'object' || Array.isArray(img) ||
        Util.isBlank(img.data) || Util.isBlank(img.mime)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, message);
    }
    return img;
  },

  /**
   * File extension for a validated image mime type.
   * @param {string} mime declared mime type
   * @return {string} ".png" or ".jpg"
   */
  _ext(mime) {
    return (mime === DRIVE_MIME_PNG) ? '.png' : '.jpg';
  },

  // ---------------------------------------------------------------------------
  // Tournament, window and duplicate lookups
  // ---------------------------------------------------------------------------

  /**
   * Load a tournament row or fail with a message the player can act on.
   * @param {string} tournamentId tournament id from the registration link
   * @return {!Object} the Tournaments row
   * @throws {!Error} NOT_FOUND
   */
  _requireTournament(tournamentId) {
    if (Util.isBlank(tournamentId)) {
      throw Util.AppError(ERR.NOT_FOUND, PLAYER_MSG.NO_TOURNAMENT);
    }
    const t = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', tournamentId);
    if (!t) {
      throw Util.AppError(ERR.NOT_FOUND, PLAYER_MSG.NO_TOURNAMENT);
    }
    return t;
  },

  /**
   * Registration must be both switched on and inside its dates.
   *
   * The window goes through Util.isWithinWindow, never a string compare and
   * never Date.parse on a bare date: reg_end "2026-08-31" means the end of that
   * day in India, and treating it as UTC would close registration at 05:30 IST
   * and silently lose most of the final day (CONTRACTS §6a).
   *
   * @param {!Object} tournament the Tournaments row
   * @return {void}
   * @throws {!Error} REGISTRATION_CLOSED
   */
  _requireRegistrationOpen(tournament) {
    if (tournament.status !== ENUM.TOURNAMENT_STATUS.REG_OPEN) {
      throw Util.AppError(ERR.REGISTRATION_CLOSED, PLAYER_MSG.WINDOW);
    }
    if (!Util.isWithinWindow(tournament.reg_start, tournament.reg_end)) {
      throw Util.AppError(ERR.REGISTRATION_CLOSED, PLAYER_MSG.WINDOW);
    }
  },

  /**
   * Is this mobile number already on a Players row in this tournament?
   *
   * Withdrawn players count as taken. Their serial stays reserved (DESIGN.md §9)
   * and letting the same number register again would hide the first attempt from
   * the organiser, who is the person meant to sort it out.
   *
   * @param {string} tournamentId tournament id
   * @param {string} mobile 10-digit number
   * @return {boolean} true when already registered
   */
  _isMobileTaken(tournamentId, mobile) {
    return Repo.filterBy(SHEETS.PLAYERS, {
      tournament_id: tournamentId,
      mobile: mobile
    }).length > 0;
  },

  /**
   * Is this UPI reference already on a Payments row in this tournament?
   *
   * Compared case-insensitively: a bank reference "AB12CD" and "ab12cd" are the
   * same transaction, and a plain equality check would let the same payment
   * screenshot be reused for two registrations.
   *
   * @param {string} tournamentId tournament id
   * @param {string} upiRef the reference the player typed
   * @return {boolean} true when already used
   */
  _isUpiRefTaken(tournamentId, upiRef) {
    const wanted = String(upiRef).trim().toUpperCase();
    const rows = Repo.filterBy(SHEETS.PAYMENTS, { tournament_id: tournamentId });
    for (let i = 0; i < rows.length; i++) {
      const existing = rows[i].upi_ref;
      if (existing === null || existing === undefined) continue;
      if (String(existing).trim().toUpperCase() === wanted) return true;
    }
    return false;
  },

  /**
   * The registration fee to copy onto the Payments row, in whole rupees.
   *
   * Util.toMoney rejects zero, but CONTRACTS-PHASE1 §2 allows `regFee >= 0`, so a
   * free tournament is legal and is passed through as 0. Anything else — a
   * negative, a decimal, a stray currency symbol typed into the sheet — goes
   * through Util.toMoney and is rejected rather than silently rounded.
   *
   * @param {!Object} tournament the Tournaments row
   * @return {number} the fee in whole rupees, possibly 0
   * @throws {!Error} INVALID_AMOUNT when reg_fee is not a whole non-negative number
   */
  _regFee(tournament) {
    const raw = tournament.reg_fee;
    if (Util.isBlank(raw) || Util.toInt(raw, -1) === 0) return 0;
    return Util.toMoney(raw);
  },

  // ---------------------------------------------------------------------------
  // The verified pool — CONTRACTS-PHASE2 §2
  // ---------------------------------------------------------------------------

  /**
   * Is this player in the auction pool?
   *
   * The predicate is exactly CONTRACTS-PHASE2 §2:
   *     payment_status === 'VERIFIED' && is_withdrawn !== true
   *
   * ===========================================================================
   * WARNING — THIS IS THE ONLY COPY OF THIS RULE. DO NOT WRITE A SECOND ONE.
   *
   * Phase 4's auction, the projector feed and every report must call this
   * function rather than re-testing the two columns themselves. A second copy
   * that drifts by one condition is how a rejected or withdrawn player ends up
   * on the projector in front of a hall of 200 people, and the two copies will
   * drift, because the payment rules change and the auction code does not get
   * re-read when they do.
   * ===========================================================================
   *
   * The withdrawn side goes through Players._isWithdrawn rather than a bare
   * `!== true`, so a row read outside Repo's boolean typing — where the sheet
   * hands back the literal string "TRUE" — still counts as withdrawn. That is
   * strictly stricter than the contract, never looser: it can only keep someone
   * out of the pool, never let them in.
   *
   * @param {!Object} playerRow a Players row
   * @return {boolean} true when the player may be auctioned
   */
  isAuctionEligible(playerRow) {
    if (!playerRow || typeof playerRow !== 'object') return false;
    return Players._str(playerRow.payment_status).toUpperCase() === ENUM.PAYMENT_STATUS.VERIFIED &&
      !Players._isWithdrawn(playerRow);
  },

  /**
   * How many players in this tournament are auction-eligible.
   *
   * Derived from Players.counts so there is one pass over the sheet and one
   * definition of the predicate.
   *
   * @param {string} tournamentId the tournament
   * @return {number} the size of the verified pool
   */
  eligibleCount(tournamentId) {
    return Players.counts(tournamentId).eligible;
  },

  /**
   * The CONTRACTS-PHASE2 §3 counts object for a whole tournament.
   *
   * ALWAYS TOURNAMENT-WIDE, NEVER PAGE-SCOPED. The admin needs "42 still
   * pending" while looking at page 1 of 8, so these numbers are deliberately
   * unaffected by the filter, the search and the page the caller asked for.
   *
   * `preloadedRows` lets a caller that has just done its own
   * Repo.readAll(Players) hand the rows straight over instead of paying for a
   * second full read. Payments.gs uses this on every verify and reject, which
   * at 400 players is one saved sheet read per click. Rows for other
   * tournaments in the array are ignored, so passing an unfiltered readAll is
   * safe (DESIGN.md §39 — every row carries its tournament_id).
   *
   * pending + verified + rejected can be less than `all` if a row somehow
   * carries a blank payment_status; that is reported honestly rather than
   * folded into one of the three buckets.
   *
   * @param {string} tournamentId the tournament
   * @param {!Array<!Object>=} preloadedRows Players rows already in memory
   * @return {{all: number, pending: number, verified: number, rejected: number,
   *           withdrawn: number, eligible: number}} the counts
   */
  counts(tournamentId, preloadedRows) {
    const id = Players._str(tournamentId);
    const rows = Array.isArray(preloadedRows) ? preloadedRows : Repo.readAll(SHEETS.PLAYERS);
    const out = { all: 0, pending: 0, verified: 0, rejected: 0, withdrawn: 0, eligible: 0 };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || Players._str(row.tournament_id) !== id) continue;

      // Every registration counts, withdrawn ones included: `all` is a record of
      // what arrived, and `withdrawn` is the separate number that says how many
      // of them pulled out.
      out.all++;

      const status = Players._str(row.payment_status).toUpperCase();
      if (status === ENUM.PAYMENT_STATUS.PENDING) out.pending++;
      else if (status === ENUM.PAYMENT_STATUS.VERIFIED) out.verified++;
      else if (status === ENUM.PAYMENT_STATUS.REJECTED) out.rejected++;

      if (Players._isWithdrawn(row)) out.withdrawn++;
      if (Players.isAuctionEligible(row)) out.eligible++;
    }
    return out;
  },

  // ---------------------------------------------------------------------------
  // player.list — CONTRACTS-PHASE2 §1
  // ---------------------------------------------------------------------------

  /**
   * The admin player list: filtered, sorted, paged, with tournament-wide counts.
   *
   * ============================ PERFORMANCE CONTRACT =========================
   * EXACTLY ONE Repo.readAll(Players) AND ONE Repo.readAll(Payments) PER CALL.
   * Everything after that — the tournament filter, the four field filters, the
   * search, the sort and the page slice — happens in memory.
   *
   * Never reach for Repo.filterBy, Repo.findBy or Repo.count inside a loop here.
   * Each of those re-reads the ENTIRE sheet through getValues(). One per row at
   * 400 players is 160,000 rows of reads to render 50, and the screen becomes
   * unusable long before the 6-minute execution limit stops it (DESIGN.md §14).
   * The Payments read exists only because upi_ref and payment_id live on the
   * Payments row; it is one read for the whole page, not one per player.
   * ===========================================================================
   *
   * @param {!Object} payload {tournamentId, filter:{paymentStatus, auctionStatus,
   *     search, withdrawn}, page, pageSize, sort, sortDir}
   * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
   * @return {{rows: !Array<!Object>, page: number, pageSize: number,
   *           total: number, totalPages: number, counts: !Object}} the page
   * @throws {!Error} VALIDATION_FAILED, FORBIDDEN, NOT_FOUND
   */
  list(payload, session) {
    const p = payload || {};
    const tournamentId = Players._str(p.tournamentId || p.tournament_id);
    if (!tournamentId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }

    // The only thing standing between one organiser and another organiser's
    // players. Checked before anything is read (Auth.gs header, DESIGN.md §39).
    Auth.requireTournament(session, tournamentId);

    // An unknown id must say so. Returning an empty list would look identical to
    // a tournament where nobody has registered yet, and the admin would go
    // hunting for missing players instead of fixing a typo. The Tournaments tab
    // holds a handful of rows, so this read is not the one that costs anything.
    Players._requireTournamentForAdmin(tournamentId);

    // --- 1. Read the request ------------------------------------------------
    const filter = (p.filter && typeof p.filter === 'object' && !Array.isArray(p.filter)) ? p.filter : {};
    const paymentStatus = Players._optionalEnum(filter.paymentStatus, ENUM.PAYMENT_STATUS, 'payment status');
    const auctionStatus = Players._optionalEnum(filter.auctionStatus, ENUM.AUCTION_STATUS, 'auction status');
    const search = Players._str(filter.search).toLowerCase();

    // Omitted means "both". Only an explicitly supplied value narrows the list,
    // so `withdrawn: false` ("hide the ones who pulled out") is a real filter and
    // is not confused with "no filter at all".
    const hasWithdrawn = Object.prototype.hasOwnProperty.call(filter, 'withdrawn') &&
      filter.withdrawn !== null && filter.withdrawn !== undefined && filter.withdrawn !== '';
    const wantWithdrawn = hasWithdrawn
      ? Players._requireBoolean(filter.withdrawn, 'The withdrawn filter')
      : null;

    const sort = Players._str(p.sort).toLowerCase() || PLAYER_LIST_SORTS[0];
    if (PLAYER_LIST_SORTS.indexOf(sort) === -1) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        '"' + Players._str(p.sort).substring(0, 30) + '" is not a sort order. Use one of: ' +
        PLAYER_LIST_SORTS.join(', ') + '.');
    }
    const descending = Players._str(p.sortDir).toLowerCase() === 'desc';

    const pageSize = Math.min(PLAYER_LIST_MAX_PAGE_SIZE,
      Math.max(1, Util.toInt(p.pageSize, PLAYER_LIST_DEFAULT_PAGE_SIZE) || PLAYER_LIST_DEFAULT_PAGE_SIZE));
    const page = Math.max(1, Util.toInt(p.page, 1) || 1);

    // --- 2. The two reads ---------------------------------------------------
    const allPlayers = Repo.readAll(SHEETS.PLAYERS);
    const paymentByPlayer = Players._paymentIndex(tournamentId, Repo.readAll(SHEETS.PAYMENTS));

    const mine = [];
    for (let i = 0; i < allPlayers.length; i++) {
      if (Players._str(allPlayers[i].tournament_id) === tournamentId) mine.push(allPlayers[i]);
    }

    // Computed from the whole tournament and from the rows already in hand, so
    // the header still reads "42 pending" while the grid shows only VERIFIED.
    const counts = Players.counts(tournamentId, mine);

    // --- 3. Filter in memory ------------------------------------------------
    const filtered = mine.filter((row) => {
      if (paymentStatus && Players._str(row.payment_status).toUpperCase() !== paymentStatus) return false;
      if (auctionStatus && Players._str(row.auction_status).toUpperCase() !== auctionStatus) return false;
      if (wantWithdrawn !== null && Players._isWithdrawn(row) !== wantWithdrawn) return false;
      if (search && !Players._matchesSearch(row, paymentByPlayer[Players._str(row.player_id)], search)) return false;
      return true;
    });

    // --- 4. Sort, then slice ------------------------------------------------
    filtered.sort(Players._comparator(sort, descending));

    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;

    // A page past the end is not an error — the admin may be holding a bookmark
    // from before a filter narrowed the list. slice() past the end gives [], and
    // the correct total and totalPages come back with it so the screen can move
    // itself to a page that exists.
    const slice = (start >= total) ? [] : filtered.slice(start, start + pageSize);

    const rows = slice.map((row) => Players._listRow(row, paymentByPlayer[Players._str(row.player_id)]));

    return {
      rows: rows,
      page: page,
      pageSize: pageSize,
      total: total,
      totalPages: totalPages,
      counts: counts
    };
  },

  /**
   * Build one row of the list response.
   *
   * ============================ SECURITY BOUNDARY ============================
   * Assembled FIELD BY FIELD from an explicit allow-list, never by spreading the
   * sheet row. Two things depend on that:
   *
   *   1. screenshot_file_id IS NEVER IN A LIST ROW. The payment screenshot is a
   *      proof of payment in the never-shared private/ Drive folder, and a Drive
   *      file id is enough to build an unauthenticated link to it (DESIGN.md §16
   *      risk 1). Screenshots are fetched one at a time, behind an admin token,
   *      through payment.getScreenshot — so a file id has no reason whatsoever to
   *      appear in a bulk response of 200 rows.
   *   2. Any column a later phase appends to Players or Payments stays invisible
   *      until somebody deliberately adds a line here. With a spread, it would
   *      leak by default and leak silently.
   *
   * Do not replace this with Object.assign or a spread.
   * ===========================================================================
   *
   * @param {!Object} row a Players row
   * @param {?Object} payment the matching Payments row, or undefined
   * @return {!Object} the CONTRACTS-PHASE2 §1 row shape
   */
  _listRow(row, payment) {
    const registeredAt = Players._str(row.registered_at);
    const pay = payment || {};
    return {
      serial_no: Util.toInt(row.serial_no, 0),
      player_id: Players._str(row.player_id),
      name: Players._str(row.name),
      dob: Players._str(row.dob),
      age_years: Util.toInt(row.age_years, 0),
      role: Players._str(row.role),
      style: Players._str(row.style),
      mobile: Players._str(row.mobile),
      upi_ref: Players._str(pay.upi_ref),
      payment_status: Players._str(row.payment_status),
      auction_status: Players._str(row.auction_status),
      team_id: Players._str(row.team_id),
      // null, not 0: "never sold" and "sold for nothing" are different facts.
      sold_amount: Util.isBlank(row.sold_amount) ? null : Util.toInt(row.sold_amount, 0),
      is_withdrawn: Players._isWithdrawn(row),
      registered_at: registeredAt,
      registered_at_display: Util.formatIST(registeredAt, true),
      photo_thumb_url: Players._str(row.photo_thumb_url),
      payment_id: Players._str(pay.payment_id)
    };
  },

  /**
   * Index this tournament's Payments rows by player_id.
   *
   * Scoped to the tournament before indexing, so a player id that somehow
   * appeared in two tournaments could never pull the wrong tournament's UPI
   * reference into the list (DESIGN.md §39).
   *
   * Phase 1 writes exactly one Payments row per player inside the same locked
   * section as the Players row, so a second row for the same player is a data
   * fault rather than a normal state. The first one wins and the list still
   * renders; the duplicate shows up in the payment queue where a human can see it.
   *
   * @param {string} tournamentId the tournament
   * @param {!Array<!Object>} paymentRows every Payments row, already read once
   * @return {!Object<string,!Object>} player_id -> Payments row
   */
  _paymentIndex(tournamentId, paymentRows) {
    const out = {};
    for (let i = 0; i < paymentRows.length; i++) {
      const row = paymentRows[i];
      if (Players._str(row.tournament_id) !== tournamentId) continue;
      const key = Players._str(row.player_id);
      if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = row;
    }
    return out;
  },

  /**
   * Free-text search across the four fields CONTRACTS-PHASE2 §1 names:
   * serial_no, name, mobile and upi_ref.
   *
   * Substring, case-insensitive. Substring rather than exact because the admin
   * is usually typing from a screenshot or a phone screen and has part of a
   * number, not all of it. search_blob is deliberately NOT used: it carries
   * name + role + style, so searching it would match every all-rounder when the
   * admin typed "all".
   *
   * @param {!Object} row a Players row
   * @param {?Object} payment the matching Payments row, or undefined
   * @param {string} needle the search text, already lowercased and trimmed
   * @return {boolean} true when any of the four fields contains the needle
   */
  _matchesSearch(row, payment, needle) {
    const pay = payment || {};
    const fields = [
      Players._str(row.serial_no),
      Players._str(row.name),
      Players._str(row.mobile),
      Players._str(pay.upi_ref)
    ];
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].toLowerCase().indexOf(needle) !== -1) return true;
    }
    return false;
  },

  /**
   * Comparator for one of the four PLAYER_LIST_SORTS keys.
   *
   * Every comparison falls back to serial_no ascending, which is unique within a
   * tournament. That makes the order total, so two players with the same name or
   * the same payment status can never swap places between page 1 and page 2 and
   * cause a row to be shown twice or skipped entirely.
   *
   * registered_at is a full UTC instant from Util.nowIso(), so Date.parse is the
   * right tool for it — unlike a bare IST calendar date, which must never be
   * parsed directly (CONTRACTS.md §6a rule 2).
   *
   * @param {string} sort one of PLAYER_LIST_SORTS
   * @param {boolean} descending reverse the primary key only
   * @return {function(!Object, !Object): number} an Array.prototype.sort comparator
   */
  _comparator(sort, descending) {
    const direction = descending ? -1 : 1;
    return function (a, b) {
      let d = 0;
      if (sort === 'serial_no') {
        d = Util.toInt(a.serial_no, 0) - Util.toInt(b.serial_no, 0);
      } else if (sort === 'registered_at') {
        d = (Date.parse(Players._str(a.registered_at)) || 0) - (Date.parse(Players._str(b.registered_at)) || 0);
      } else if (sort === 'name') {
        d = Players._compareText(Players._str(a.name), Players._str(b.name));
      } else {
        d = Players._compareText(Players._str(a.payment_status), Players._str(b.payment_status));
      }
      if (d !== 0) return d * direction;
      return Util.toInt(a.serial_no, 0) - Util.toInt(b.serial_no, 0);
    };
  },

  /**
   * Case-insensitive text compare returning -1, 0 or 1.
   *
   * Lowercased rather than sorted by code point, so "anand" does not come after
   * "Zahir". Deliberately not localeCompare: Apps Script's implementation of it
   * is not dependable across runtimes, and the ordering only has to be stable
   * and roughly alphabetical, not linguistically correct for every script.
   *
   * @param {string} a left value
   * @param {string} b right value
   * @return {number} -1, 0 or 1
   */
  _compareText(a, b) {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  },

  // ---------------------------------------------------------------------------
  // player.setWithdrawn — CONTRACTS-PHASE2 §1, DESIGN.md §15 case 16
  // ---------------------------------------------------------------------------

  /**
   * Mark a player as withdrawn, or put them back.
   *
   * THE SERIAL NUMBER STAYS RESERVED FOR EVER. Nothing here renumbers anyone and
   * nothing ever hands serial 27 to a second person (DESIGN.md §9, §15 case 16).
   * The row, the photos and the payment record all stay exactly where they are;
   * one boolean changes. A withdrawn player simply stops satisfying the §2
   * eligibility predicate, so they drop out of the auction pool and off the
   * projector without anything being deleted.
   *
   * @param {!Object} payload {playerId, withdrawn, reason}
   * @param {!Object} session the ADMIN session
   * @return {{player_id: string, serial_no: number, is_withdrawn: boolean}} the new state
   * @throws {!Error} VALIDATION_FAILED, NOT_FOUND, SYSTEM_BUSY
   */
  setWithdrawn(payload, session) {
    const p = payload || {};
    const playerId = Players._str(p.playerId || p.player_id);
    if (!playerId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A player id is required.');
    }

    const withdrawn = Players._requireBoolean(p.withdrawn, 'The withdrawn flag');

    // Optional, unlike payment.reject's reason, which CONTRACTS-PHASE2 §1 marks
    // REQUIRED. A withdrawal is usually the player's own decision relayed by
    // phone, so there is often nothing to record beyond the fact of it.
    const reason = Players._str(p.reason);
    if (reason.length > PLAYER_WITHDRAW_REASON_MAX) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The reason must be ' + PLAYER_WITHDRAW_REASON_MAX + ' characters or fewer. This one is ' +
        reason.length + '.');
    }

    return Repo.withLock(function () {
      // Re-read inside the lock. The copy any caller is looking at on screen may
      // be seconds old, and a sale could have landed in between — which is the
      // one thing this function must not paper over.
      const row = Repo.findBy(SHEETS.PLAYERS, 'player_id', playerId);
      if (!row) {
        throw Util.AppError(ERR.NOT_FOUND,
          'No player was found with the id "' + playerId.substring(0, 40) + '".');
      }

      const serialNo = Util.toInt(row.serial_no, 0);

      // ===================================================================
      // A SOLD PLAYER IS NOT WITHDRAWN HERE, EVER.
      //
      // A sale is three facts, not one: the player has a team_id, the team's
      // purse_used went up by the sold amount, and the team's players_count went
      // up by one. Flipping is_withdrawn here would change exactly one of the
      // three and leave the other two standing — the team would keep paying for
      // a player it no longer has, its purse would stay short for the rest of
      // the auction, and its squad count would block a replacement signing.
      // Nothing would report an error; the money would just be wrong.
      //
      // Unwinding a sale is the Phase 7 correction flow, which reverses all
      // three together inside the auction lock and writes the superseding
      // AuctionResults row. Send the admin there.
      // ===================================================================
      if (Players._str(row.auction_status).toUpperCase() === ENUM.AUCTION_STATUS.SOLD) {
        throw Util.AppError(ERR.VALIDATION_FAILED,
          'Player #' + serialNo + ' has already been sold, so this cannot be changed here. ' +
          'Use the auction correction screen instead — it also gives the team back its money ' +
          'and its squad place, which withdrawing the player would not.');
      }

      const was = Players._isWithdrawn(row);

      // Already in the requested state: a no-op success, not an error. Two admins
      // clicking the same button must not produce a scary message (DESIGN.md §15
      // case 4). Nothing is written and nothing is audited, because nothing
      // happened.
      if (was === withdrawn) {
        return { player_id: Players._str(row.player_id), serial_no: serialNo, is_withdrawn: withdrawn };
      }

      Repo.updateRow(SHEETS.PLAYERS, row._row, { is_withdrawn: withdrawn });

      // payment_status is deliberately untouched. It mirrors the Payments row and
      // Payments.gs is its only writer; a withdrawal says nothing about whether
      // the money arrived, and the fee question is settled off-system.
      Audit.log({
        actor: session ? session.user_id : '',
        role: session ? session.role : '',
        action: Audit.ACTIONS.PLAYER_WITHDRAWN,
        tournamentId: Players._str(row.tournament_id),
        entityType: 'Player',
        entityId: Players._str(row.player_id),
        prev: { is_withdrawn: was },
        next: { is_withdrawn: withdrawn, serial_no: serialNo, reason: reason },
        ua: Players._str(p.ua)
      });

      // Push the write out before the lock is released, so the next caller's
      // re-read actually sees it (CONTRACTS.md §5 rule 3).
      Repo.flush();

      return { player_id: Players._str(row.player_id), serial_no: serialNo, is_withdrawn: withdrawn };
    });
  },

  // ---------------------------------------------------------------------------
  // Shared helpers for the Phase 2 handlers
  // ---------------------------------------------------------------------------

  /**
   * Trim any value to a string, treating null, undefined and whitespace as ''.
   * The same normalisation the registration path applies inline.
   * @param {*} v any value
   * @return {string} the trimmed string
   */
  _str(v) {
    return (v === null || v === undefined) ? '' : String(v).trim();
  },

  /**
   * Has this player pulled out?
   *
   * Repo hands back a real boolean for is_withdrawn because the column is in
   * Config.BOOLEAN_FIELDS, but a row assembled anywhere else can still carry the
   * literal "TRUE" the sheet stores. Both are honoured, so a withdrawn player is
   * never treated as active by accident.
   *
   * @param {!Object} row a Players row
   * @return {boolean} true when withdrawn
   */
  _isWithdrawn(row) {
    const v = row ? row.is_withdrawn : false;
    if (v === true) return true;
    return String(v === null || v === undefined ? '' : v).trim().toUpperCase() === 'TRUE';
  },

  /**
   * Validate an optional enum filter value.
   * @param {*} value the supplied value; blank means "no filter"
   * @param {!Object<string,string>} allowed the ENUM map to check against
   * @param {string} label field name for the error message, e.g. "payment status"
   * @return {string} the upper-cased value, or '' when no filter was asked for
   * @throws {!Error} VALIDATION_FAILED listing the allowed values
   */
  _optionalEnum(value, allowed, label) {
    const s = Players._str(value).toUpperCase();
    if (!s) return '';
    if (!Object.prototype.hasOwnProperty.call(allowed, s)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        '"' + s.substring(0, 30) + '" is not a ' + label + '. Use one of: ' +
        Object.keys(allowed).join(', ') + '.');
    }
    return s;
  },

  /**
   * Require a real boolean.
   *
   * The strings "true" and "false" are accepted too: payloads are hand-built by
   * the frontend and a checkbox value arrives as text often enough that
   * rejecting it would be a bug report rather than a safety feature. Everything
   * else — including 1, 0, "yes" and "" — is refused, because guessing what a
   * caller meant is how a player gets withdrawn by accident.
   *
   * @param {*} value the supplied value
   * @param {string} label field name for the error message
   * @return {boolean} the boolean
   * @throws {!Error} VALIDATION_FAILED
   */
  _requireBoolean(value, label) {
    if (value === true || value === false) return value;
    const s = Players._str(value).toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    throw Util.AppError(ERR.VALIDATION_FAILED, label + ' must be true or false.');
  },

  /**
   * Load a tournament row for an admin screen, or fail with NOT_FOUND.
   *
   * Separate from Players._requireTournament because that one's message is
   * written for a player holding a registration link ("Please check the
   * registration link"), which is nonsense on an admin console.
   *
   * @param {string} tournamentId the tournament id from the payload
   * @return {!Object} the Tournaments row
   * @throws {!Error} NOT_FOUND
   */
  _requireTournamentForAdmin(tournamentId) {
    const row = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', tournamentId);
    if (!row) {
      // Caller-controlled text, so it is length-capped before it reaches a
      // message the browser will render.
      throw Util.AppError(ERR.NOT_FOUND,
        'No tournament was found with the id "' + tournamentId.substring(0, 40) + '".');
    }
    return row;
  }
};

/**
 * Player route table.
 *
 * Both Phase 1 actions are PUBLIC POST — a player has no account and never logs
 * in (DESIGN.md §5.1). Neither is offered on GET: both write or probe, and a GET
 * would put the mobile number into browser history and server logs.
 *
 * The two Phase 2 actions are the opposite: authenticated, POST only, and every
 * one of them re-checks tournament scope inside the handler as well as here.
 *
 * @return {!Object} route table fragment
 */
function PlayerRoutes() {
  return {
    'player.checkMobile': {
      auth: 'PUBLIC',
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, mobile}
       * @return {{taken: boolean}} whether the number is already registered
       */
      handler: (payload) => Players.checkMobile(payload)
    },

    'player.register': {
      auth: 'PUBLIC',
      methods: ['POST'],
      /**
       * @param {!Object} payload the registration form plus three base64 images
       * @return {!Object} {player_id, serial_no, name, tournament_name, registered_at_display}
       */
      handler: (payload) => Players.register(payload)
    },

    'player.list': {
      // ORGANISER is allowed, but only for their own tournament: the role check
      // here lets them in, and Auth.requireTournament inside Players.list is what
      // stops them reading another tournament's players (DESIGN.md §39).
      auth: ['ADMIN', 'ORGANISER'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, filter, page, pageSize, sort}
       * @param {!Object} session ADMIN or ORGANISER session
       * @return {!Object} {rows, page, pageSize, total, totalPages, counts}
       */
      handler: (payload, session) => Players.list(payload, session)
    },

    'player.setWithdrawn': {
      // ADMIN only. An organiser runs the auction; deciding that a paid-up player
      // is out of the tournament is not theirs to do (CONTRACTS-PHASE2 §1).
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {playerId, withdrawn, reason}
       * @param {!Object} session ADMIN session
       * @return {!Object} {player_id, serial_no, is_withdrawn}
       */
      handler: (payload, session) => Players.setWithdrawn(payload, session)
    }
  };
}
