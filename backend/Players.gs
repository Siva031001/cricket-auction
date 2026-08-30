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
 * PHASE 2 — admin review
 *   player.list            ADMIN. Paged and filterable by payment_status,
 *                          auction_status, team and free-text search_blob.
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
  }
};

/**
 * Player route table. Both Phase 1 actions are PUBLIC POST — a player has no
 * account and never logs in (DESIGN.md §5.1).
 *
 * Neither is offered on GET: both write or probe, and a GET would put the mobile
 * number into browser history and server logs.
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
    }
  };
}
