/**
 * Tournaments.gs — tournament CRUD, public tournament info, and the organiser
 * accounts that belong to a tournament.
 *
 * PHASE 1 — tournament setup and the public registration landing page
 *   tournament.getPublic   PUBLIC, GET+POST. Name, photos, fee, QR, rules and
 *                          whether registration is open. Nothing else (§46).
 *   tournament.create      ADMIN. Creates the row, Drive folders and display_token.
 *   tournament.update      ADMIN.
 *   tournament.list        ADMIN.
 *   tournament.get         ADMIN. Full row, unlike getPublic.
 *   tournament.setStatus   ADMIN. DRAFT | REG_OPEN | REG_CLOSED | AUCTION_LIVE |
 *                          AUCTION_CLOSED. Also how registration gets closed.
 *
 * PHASE 3 — organiser access: MOVED OUT of this file.
 *   organiser.create / list / resendLink / disable now live in Organisers.gs,
 *   and auth.organiserJoin is in AuthRoutes() in Code.gs.
 *   They were pencilled in here during Phase 0. This file passed 1100 lines and
 *   an organiser is a separate concern from a tournament, so they moved
 *   (CONTRACTS-PHASE3.md §1). Nothing organiser-related belongs here.
 *
 * Two things in this file are security boundaries rather than preferences:
 *
 *   1. tournament.getPublic is served to anonymous callers. Its response is
 *      assembled field by field from a literal allow-list — see the comment on
 *      Tournaments.getPublic.
 *   2. Registration windows are IST calendar days (CONTRACTS.md §6a). Every
 *      window question in this file goes through Util.isWithinWindow and every
 *      date shown to a human goes through Util.formatIST. Comparing the ISO
 *      strings directly, or calling Date.parse on a bare date, silently closes
 *      a "31 Aug" deadline at 05:30 IST on the 31st.
 */

/**
 * The complete legal status graph (CONTRACTS-PHASE1.md §2). Any move not listed
 * here is rejected. Kept as a table rather than a chain of ifs so the rule is
 * readable next to the contract it implements.
 *
 * REG_CLOSED -> REG_OPEN reopens registration; REG_OPEN -> AUCTION_LIVE is legal
 * but warns; AUCTION_CLOSED -> AUCTION_LIVE is the admin-only reopen of DESIGN §44.
 *
 * @const {!Object<string, !Array<string>>}
 */
const TOURNAMENT_STATUS_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(['REG_OPEN']),
  REG_OPEN: Object.freeze(['REG_CLOSED', 'AUCTION_LIVE']),
  REG_CLOSED: Object.freeze(['REG_OPEN', 'AUCTION_LIVE']),
  AUCTION_LIVE: Object.freeze(['AUCTION_CLOSED']),
  AUCTION_CLOSED: Object.freeze(['AUCTION_LIVE'])
});

/**
 * Config tab key holding the origin the SPA is served from, e.g.
 * "https://example.github.io/cricket-auction". Setup.gs seeds it; the backend
 * never hardcodes a host, because the same Apps Script deployment is used from
 * GitHub Pages, a custom domain and localhost during development.
 * @const {string}
 */
const CONFIG_KEY_FRONTEND_BASE_URL = 'frontend_base_url';

/** Thumbnail width for the logo and the on-screen QR (DESIGN.md §3). @const {number} */
const TOURNAMENT_IMAGE_WIDTH = 800;

/** Wider rendition behind "Download QR Code" — a bigger QR scans more reliably. @const {number} */
const TOURNAMENT_QR_DOWNLOAD_WIDTH = 1600;

/**
 * Most gallery images one create/update call may carry. Each one is a base64
 * blob that has to be decoded and written to Drive inside a single request, and
 * Apps Script kills an execution at 6 minutes. A clear rejection beats a timeout.
 * @const {number}
 */
const TOURNAMENT_MAX_GALLERY_IMAGES = 12;

const Tournaments = {

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Tab name, tolerating a SHEETS constant that has not loaded yet.
   * @return {string} the Tournaments tab name
   */
  _tab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.TOURNAMENTS) ? SHEETS.TOURNAMENTS : 'Tournaments';
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
   * Load a tournament row or fail with NOT_FOUND.
   * @param {string} tournamentId the id from the payload
   * @return {!Object} the row object, carrying _row
   * @throws {Error} VALIDATION_FAILED when blank, NOT_FOUND when unknown
   */
  _require(tournamentId) {
    const id = Tournaments._str(tournamentId);
    if (!id) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }
    const row = Repo.findBy(Tournaments._tab(), 'tournament_id', id);
    if (!row) {
      // The id is caller-controlled text, so it is length-capped before it goes
      // into a message the browser will render.
      throw Util.AppError(ERR.NOT_FOUND, 'No tournament was found with the id "' + id.substring(0, 40) + '".');
    }
    return row;
  },

  /**
   * Validate a bare IST calendar date.
   *
   * The 10-character form is required rather than accepted-and-parsed: a full
   * instant in reg_start would change what Util.isWithinWindow means for the
   * whole day (CONTRACTS.md §6a rule 3).
   *
   * @param {*} value the supplied value
   * @param {string} label field name for the error message, e.g. "Start date"
   * @return {string} the date as "YYYY-MM-DD"
   * @throws {Error} VALIDATION_FAILED when the shape is wrong or the day does not exist
   */
  _requireDate(value, label) {
    const s = Tournaments._str(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        label + ' must be a date written as YYYY-MM-DD. Got "' + s.substring(0, 30) + '".');
    }
    try {
      // Throws on a day that does not exist, e.g. 2026-02-30, which a plain
      // regex would happily accept and Date would roll forward into March.
      Util.istDayStartUtc(s);
    } catch (e) {
      throw Util.AppError(ERR.VALIDATION_FAILED, label + ' "' + s + '" is not a real date.');
    }
    return s;
  },

  /**
   * Is fromDate on or before toDate, as IST calendar days?
   *
   * Asked through Util.isWithinWindow rather than by comparing the two strings,
   * so there is exactly one place in the codebase that knows how an IST day maps
   * onto a UTC instant. Reads as: "does the first moment of fromDate fall inside
   * the window fromDate..toDate?" — true only when the range is not inverted.
   *
   * @param {string} fromDate "YYYY-MM-DD"
   * @param {string} toDate "YYYY-MM-DD"
   * @return {boolean} true when the range runs forwards
   */
  _datesInOrder(fromDate, toDate) {
    return Util.isWithinWindow(fromDate, toDate, Util.istDayStartUtc(fromDate));
  },

  /**
   * Validate a rupee amount arriving from a client.
   *
   * Util.toMoney is the strict integer check, but it rejects zero, because a
   * zero bid or a zero purse is always a bug. A registration fee of zero is not:
   * a free tournament is a real thing the contract allows (regFee >= 0). So zero
   * is short-circuited here and everything else goes through toMoney.
   *
   * @param {*} value the supplied amount
   * @param {string} label field name for the error message
   * @param {boolean} allowZero true for reg_fee, false for default_purse
   * @return {number} whole rupees
   * @throws {Error} VALIDATION_FAILED naming the field
   */
  _requireMoney(value, label, allowZero) {
    const raw = Tournaments._str(value);
    if (allowZero && /^0+$/.test(raw)) return 0;
    try {
      return Util.toMoney(value);
    } catch (e) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        label + ' must be a whole number of rupees ' +
        (allowZero ? '(0 or more)' : 'greater than zero') +
        '. Got "' + raw.substring(0, 20) + '".');
    }
  },

  /**
   * Validate a whole-number count.
   * @param {*} value the supplied value
   * @param {string} label field name for the error message
   * @param {number} min smallest acceptable value
   * @return {number} the integer
   * @throws {Error} VALIDATION_FAILED naming the field and the limit
   */
  _requireCount(value, label, min) {
    const raw = Tournaments._str(value);
    if (!/^[0-9]+$/.test(raw)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        label + ' must be a whole number. Got "' + raw.substring(0, 20) + '".');
    }
    const n = Util.toInt(raw, -1);
    if (n < min) {
      throw Util.AppError(ERR.VALIDATION_FAILED, label + ' must be at least ' + min + '. Got ' + n + '.');
    }
    return n;
  },

  /**
   * Validate the free-text fields that are only length-checked.
   * @param {*} value the supplied value
   * @param {string} label field name for the error message
   * @param {number} min minimum characters
   * @param {number} max maximum characters
   * @param {boolean} required true when blank is not allowed
   * @return {string} the trimmed value
   * @throws {Error} VALIDATION_FAILED naming the field and the real lengths
   */
  _requireText(value, label, min, max, required) {
    const s = Tournaments._str(value);
    if (!s) {
      if (required) throw Util.AppError(ERR.VALIDATION_FAILED, label + ' is required.');
      return '';
    }
    if (s.length < min || s.length > max) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        label + ' must be between ' + min + ' and ' + max + ' characters. This one is ' + s.length + '.');
    }
    return s;
  },

  /**
   * Validate a UPI virtual payment address: something@something, no spaces.
   * Deliberately loose — banks and PSPs invent new handle suffixes constantly and
   * a strict list would reject a valid payee.
   * @param {*} value the supplied value
   * @return {string} the trimmed UPI id
   * @throws {Error} VALIDATION_FAILED
   */
  _requireUpiId(value) {
    const s = Tournaments._str(value);
    if (!/^[^\s@]{2,50}@[^\s@]{2,30}$/.test(s)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The UPI ID must look like name@bank. Got "' + s.substring(0, 30) + '".');
    }
    return s;
  },

  /**
   * Validate an Indian mobile number.
   * @param {*} value the supplied value
   * @return {string} the 10-digit number
   * @throws {Error} VALIDATION_FAILED
   */
  _requireMobile(value) {
    const s = Tournaments._str(value);
    if (!Util.isValidMobileIN(s)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The contact mobile must be 10 digits starting 6, 7, 8 or 9. Got "' + s.substring(0, 20) + '".');
    }
    return s;
  },

  /**
   * Validate an optional contact email.
   * @param {*} value the supplied value
   * @return {string} the trimmed email, or '' when not supplied
   * @throws {Error} VALIDATION_FAILED
   */
  _optionalEmail(value) {
    const s = Tournaments._str(value);
    if (!s) return '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 120) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The contact email does not look like an email address. Got "' + s.substring(0, 40) + '".');
    }
    return s.toLowerCase();
  },

  /**
   * Is this payload key carrying an image?
   * @param {*} img candidate value
   * @return {boolean} true when it is an object with data on it
   */
  _isImage(img) {
    return !!img && typeof img === 'object' && !Array.isArray(img) && !Util.isBlank(img.data);
  },

  /**
   * Upload one image and return its Drive file id.
   *
   * The declared mime is passed to Drive.uploadImage untouched. That matters most
   * for the QR: re-encoding a PNG QR code as JPEG introduces compression
   * artefacts around the finder patterns and can make it unscannable
   * (CONTRACTS-PHASE1.md §1). Nothing in this file converts an image.
   *
   * Drive.uploadImage does the real validation — declared mime, decoded size and
   * magic number — so the client's claim is never trusted.
   *
   * @param {string} folderId destination Drive folder
   * @param {{data: string, mime: string, filename: (string|undefined)}} img the image
   * @param {string} label field name for the error message, e.g. "logo"
   * @param {string} fallbackName filename to use when the client sent none
   * @return {string} the new Drive file id
   * @throws {Error} VALIDATION_FAILED
   */
  _uploadImage(folderId, img, label, fallbackName) {
    if (!Tournaments._isImage(img)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The ' + label + ' image is missing its data. Please pick the file again.');
    }
    const mime = Tournaments._str(img.mime);
    if (!mime) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The ' + label + ' image did not say what type it is. Please pick the file again.');
    }
    const filename = Tournaments._str(img.filename) || fallbackName;
    return Drive.uploadImage(folderId, String(img.data), mime, filename);
  },

  /**
   * Validate and upload a gallery array.
   * @param {string} galleryFolderId destination Drive folder
   * @param {!Array} gallery array of image objects, possibly empty
   * @return {!Array<string>} Drive file ids in the order supplied
   * @throws {Error} VALIDATION_FAILED
   */
  _uploadGallery(galleryFolderId, gallery) {
    if (!Array.isArray(gallery)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'The gallery must be a list of images.');
    }
    if (gallery.length > TOURNAMENT_MAX_GALLERY_IMAGES) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'You can upload at most ' + TOURNAMENT_MAX_GALLERY_IMAGES + ' gallery photos at a time. ' +
        'This request has ' + gallery.length + '.');
    }
    const ids = [];
    for (let i = 0; i < gallery.length; i++) {
      ids.push(Tournaments._uploadImage(
        galleryFolderId, gallery[i], 'gallery photo ' + (i + 1), 'gallery-' + (i + 1) + '.jpg'));
    }
    return ids;
  },

  /**
   * Move a superseded image to the Drive trash.
   *
   * Best effort on purpose: the sheet has already stopped pointing at the file,
   * so a Drive hiccup here must not fail the update the admin just made. Trashed
   * rather than hard deleted, so a mistaken "remove logo" is recoverable.
   *
   * @param {string} fileId Drive file id, may be blank
   * @return {void}
   */
  _trashQuietly(fileId) {
    const id = Tournaments._str(fileId);
    if (!id) return;
    try {
      Drive.deleteFile(id);
    } catch (e) {
      console.error('Could not trash the replaced image ' + id + ': ' + e);
    }
  },

  /**
   * Read the stored gallery column, which is a JSON array of Drive ids.
   * @param {!Object} row a Tournaments row
   * @return {!Array<string>} the ids, [] when the cell is blank or corrupt
   */
  _galleryIds(row) {
    const raw = row.photo_file_ids;
    if (Array.isArray(raw)) return raw;
    const parsed = Util.safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  },

  /**
   * The origin the SPA is served from, without a trailing slash.
   *
   * Read from the Config tab key 'frontend_base_url', which Setup.gs seeds. It is
   * NOT hardcoded: the registration link points at the static frontend, not at
   * the Apps Script /exec URL, and that frontend lives on a different host in
   * development, on GitHub Pages in test and possibly on a custom domain in
   * production. When the key is missing the caller gets a root-relative path
   * ("/register/TRN_x"), which still works when the frontend is same-origin.
   *
   * A Config read failure degrades to '' rather than failing the whole request.
   *
   * @return {string} e.g. "https://example.github.io/cricket-auction", or ''
   */
  _frontendBase() {
    let base = '';
    try {
      base = Tournaments._str(Cache.getConfig(CONFIG_KEY_FRONTEND_BASE_URL));
    } catch (e) {
      console.error('Could not read ' + CONFIG_KEY_FRONTEND_BASE_URL + ' from Config: ' + e);
      base = '';
    }
    return base.replace(/\/+$/, '');
  },

  /**
   * Public registration link for a tournament.
   * @param {string} tournamentId the tournament
   * @return {string} absolute URL, or the path alone when no base is configured
   */
  _registrationUrl(tournamentId) {
    return Tournaments._frontendBase() + '/register/' + encodeURIComponent(tournamentId);
  },

  /**
   * Projector link. Carries the display_token as ?k= (DESIGN.md §5.5), so it is
   * only ever handed to an ADMIN or ORGANISER — never to getPublic.
   * @param {string} tournamentId the tournament
   * @param {string} displayToken the read-only projector token
   * @return {string} absolute URL, or the path alone when no base is configured
   */
  _displayUrl(tournamentId, displayToken) {
    return Tournaments._frontendBase() + '/auction/' + encodeURIComponent(tournamentId) +
      '/display?k=' + encodeURIComponent(Tournaments._str(displayToken));
  },

  /**
   * Work out whether registration is open, and why not when it is closed.
   *
   * Open requires BOTH a status of REG_OPEN and now falling inside the window.
   * Status alone is not enough: an admin who opened registration in June and then
   * forgot about it must not still be taking entries in September.
   *
   * Which side of a closed window we are on is decided by asking
   * Util.isWithinWindow again with one bound dropped, rather than by comparing
   * date strings — see the file header.
   *
   * The three messages are verbatim from CONTRACTS-PHASE1.md §2.
   *
   * @param {!Object} row a Tournaments row
   * @return {{open: boolean, message: string}} the registration state
   */
  _registrationState(row) {
    const status = Tournaments._str(row.status);
    const regStart = Tournaments._str(row.reg_start);
    const regEnd = Tournaments._str(row.reg_end);

    if (status !== ENUM.TOURNAMENT_STATUS.REG_OPEN) {
      return { open: false, message: 'Registration is not open for this tournament.' };
    }

    try {
      if (Util.isWithinWindow(regStart, regEnd)) {
        return { open: true, message: '' };
      }
      // Not inside the window. Unbounded-on-the-right tells us whether it has
      // started; if it has, then we are past the end.
      const hasStarted = Util.isWithinWindow(regStart, '');
      if (!hasStarted) {
        return {
          open: false,
          message: 'Registration has not opened yet. It opens on ' + Util.formatIST(regStart, false) + '.'
        };
      }
      return { open: false, message: 'Registration closed on ' + Util.formatIST(regEnd, false) + '.' };
    } catch (e) {
      // Unreadable dates in the sheet must not 500 a public page. Fail closed.
      console.error('Bad registration window on ' + row.tournament_id + ': ' + e);
      return { open: false, message: 'Registration is not open for this tournament.' };
    }
  },

  /**
   * A slug that no other tournament is already using.
   *
   * The slug is cosmetic — every URL keys off tournament_id — but it names the
   * Drive folder, and two folders called "summer-cup" is exactly the kind of mess
   * nobody untangles at 11pm. Collisions are broken with a short suffix taken
   * from the tournament's own id, which is already unique.
   *
   * @param {string} name the tournament name
   * @param {string} tournamentId the id just generated for this tournament
   * @param {!Array<!Object>} existingRows every current Tournaments row
   * @return {string} a slug unique across the sheet
   */
  _uniqueSlug(name, tournamentId, existingRows) {
    const taken = {};
    for (let i = 0; i < existingRows.length; i++) {
      taken[Tournaments._str(existingRows[i].slug).toLowerCase()] = true;
    }

    const base = Util.slugify(name) || 'tournament';
    if (!taken[base]) return base;

    // The last four characters of the id: short enough to stay readable in a
    // folder name, and unique because the id is.
    const suffix = Tournaments._str(tournamentId).slice(-4).toLowerCase();
    const withSuffix = base + '-' + suffix;
    if (!taken[withSuffix]) return withSuffix;

    let n = 2;
    while (taken[withSuffix + '-' + n]) n++;
    return withSuffix + '-' + n;
  },

  // ---------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------

  /**
   * Create a tournament: Drive tree, images, display token, then the row.
   *
   * Order matters. Everything is validated before a single Drive call, because a
   * rejected field after four uploads leaves four orphaned files and makes the
   * admin re-pick every image. Uploads then happen before the row is written, so
   * a failed upload leaves no half-built tournament in the sheet — at worst an
   * empty folder tree, which ensureTournamentFolders will reuse on the retry.
   *
   * @param {!Object} payload see CONTRACTS-PHASE1.md §2
   * @param {!Object} session the ADMIN session
   * @return {{tournament_id: string, slug: string, status: string,
   *           registrationUrl: string, displayUrl: string}}
   * @throws {Error} VALIDATION_FAILED on any bad field
   */
  create(payload, session) {
    const p = payload || {};

    // --- 1. Validate everything first -----------------------------------
    const name = Tournaments._requireText(p.name, 'The tournament name', 3, 80, true);
    const description = Tournaments._requireText(p.description, 'The description', 0, 4000, false);
    const rules = Tournaments._requireText(p.rules, 'The rules', 0, 8000, false);

    const startDate = Tournaments._requireDate(p.startDate, 'The tournament start date');
    const endDate = Tournaments._requireDate(p.endDate, 'The tournament end date');
    if (!Tournaments._datesInOrder(startDate, endDate)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The tournament ends before it starts: ' + Util.formatIST(startDate, false) +
        ' to ' + Util.formatIST(endDate, false) + '.');
    }

    const regStart = Tournaments._requireDate(p.regStart, 'The registration start date');
    const regEnd = Tournaments._requireDate(p.regEnd, 'The registration end date');
    if (!Tournaments._datesInOrder(regStart, regEnd)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'Registration ends before it opens: ' + Util.formatIST(regStart, false) +
        ' to ' + Util.formatIST(regEnd, false) + '.');
    }

    const regFee = Tournaments._requireMoney(p.regFee, 'The registration fee', true);
    const defaultPurse = Tournaments._requireMoney(p.defaultPurse, 'The default team purse', false);
    const defaultMaxPlayers = Tournaments._requireCount(p.defaultMaxPlayers, 'The default squad size', 1);

    const upiId = Tournaments._requireUpiId(p.upiId);
    const contactName = Tournaments._requireText(p.contactName, 'The contact name', 2, 80, true);
    const contactMobile = Tournaments._requireMobile(p.contactMobile);
    const contactEmail = Tournaments._optionalEmail(p.contactEmail);

    const gallery = (p.gallery === null || p.gallery === undefined) ? [] : p.gallery;
    if (!Array.isArray(gallery)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'The gallery must be a list of images.');
    }
    if (p.logo !== null && p.logo !== undefined && !Tournaments._isImage(p.logo)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'The logo image is missing its data. Please pick the file again.');
    }
    if (p.qr !== null && p.qr !== undefined && !Tournaments._isImage(p.qr)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'The QR image is missing its data. Please pick the file again.');
    }

    // --- 2. Identity and slug -------------------------------------------
    const tab = Tournaments._tab();
    const tournamentId = Util.uid(ID_PREFIX.TOURNAMENT);
    const slug = Tournaments._uniqueSlug(name, tournamentId, Repo.readAll(tab));

    // --- 3. Drive tree, then the images ---------------------------------
    const folders = Drive.ensureTournamentFolders(tournamentId, slug);

    const logoFileId = Tournaments._isImage(p.logo)
      ? Tournaments._uploadImage(folders.publicId, p.logo, 'logo', 'logo')
      : '';
    // The QR keeps whatever type the organiser uploaded. See _uploadImage.
    const qrFileId = Tournaments._isImage(p.qr)
      ? Tournaments._uploadImage(folders.publicId, p.qr, 'QR', 'qr')
      : '';
    const galleryIds = Tournaments._uploadGallery(folders.galleryId, gallery);

    // --- 4. Write the row -----------------------------------------------
    const row = {
      tournament_id: tournamentId,
      slug: slug,
      name: name,
      description: description,
      start_date: startDate,
      end_date: endDate,
      reg_start: regStart,
      reg_end: regEnd,
      reg_fee: regFee,
      logo_file_id: logoFileId,
      photo_file_ids: JSON.stringify(galleryIds),
      qr_file_id: qrFileId,
      upi_id: upiId,
      contact_name: contactName,
      contact_mobile: contactMobile,
      contact_email: contactEmail,
      rules: rules,
      status: ENUM.TOURNAMENT_STATUS.DRAFT,
      drive_folder_id: folders.rootId,
      next_serial: 1,
      default_purse: defaultPurse,
      default_max_players: defaultMaxPlayers,
      // 16 bytes = 32 hex characters. Not a session token: it grants read-only
      // access to the projector feed and nothing else (DESIGN.md §5.5).
      display_token: Util.randomToken(16),
      created_at: Util.nowIso(),
      created_by: session ? session.user_id : ''
    };
    Repo.append(tab, row);

    // --- 5. Audit --------------------------------------------------------
    Audit.log({
      actor: session ? session.user_id : '',
      role: session ? session.role : '',
      action: Audit.ACTIONS.TOURNAMENT_CREATED,
      tournamentId: tournamentId,
      entityType: 'Tournament',
      entityId: tournamentId,
      prev: null,
      // display_token is deliberately not audited — the audit log is read by
      // more people than should be able to open the projector.
      next: {
        name: name, slug: slug, status: row.status,
        reg_start: regStart, reg_end: regEnd, reg_fee: regFee,
        default_purse: defaultPurse, default_max_players: defaultMaxPlayers
      },
      ua: Tournaments._str(p.ua)
    });

    return {
      tournament_id: tournamentId,
      slug: slug,
      status: row.status,
      registrationUrl: Tournaments._registrationUrl(tournamentId),
      displayUrl: Tournaments._displayUrl(tournamentId, row.display_token)
    };
  },

  /**
   * Update a tournament. Only the keys actually supplied change.
   *
   * Absent and null both mean "leave this alone" — that is what lets the admin
   * edit form post back without re-uploading a 200 KB logo on every save. Images
   * are cleared with the explicit removeLogo / removeQr / removeGallery flags.
   *
   * The status is NOT settable here; that goes through setStatus, which owns the
   * transition table.
   *
   * @param {!Object} payload {tournamentId, ...any subset of the create fields}
   * @param {!Object} session the ADMIN session
   * @return {!Object} {tournament_id, slug, changed: string[]}
   * @throws {Error} NOT_FOUND, VALIDATION_FAILED
   */
  update(payload, session) {
    const p = payload || {};
    const existing = Tournaments._require(p.tournamentId);
    const has = (key) => Object.prototype.hasOwnProperty.call(p, key) && p[key] !== null && p[key] !== undefined;

    const patch = {};

    // --- Text ------------------------------------------------------------
    if (has('name')) patch.name = Tournaments._requireText(p.name, 'The tournament name', 3, 80, true);
    if (has('description')) patch.description = Tournaments._requireText(p.description, 'The description', 0, 4000, false);
    if (has('rules')) patch.rules = Tournaments._requireText(p.rules, 'The rules', 0, 8000, false);
    if (has('contactName')) patch.contact_name = Tournaments._requireText(p.contactName, 'The contact name', 2, 80, true);
    if (has('upiId')) patch.upi_id = Tournaments._requireUpiId(p.upiId);
    if (has('contactMobile')) patch.contact_mobile = Tournaments._requireMobile(p.contactMobile);
    if (has('contactEmail')) patch.contact_email = Tournaments._optionalEmail(p.contactEmail);

    // The slug is not recomputed when the name changes. It names the Drive folder
    // and appears in nothing a player sees, so churning it would only decouple
    // the folder from the row for no gain.

    // --- Numbers ---------------------------------------------------------
    if (has('regFee')) patch.reg_fee = Tournaments._requireMoney(p.regFee, 'The registration fee', true);
    if (has('defaultPurse')) patch.default_purse = Tournaments._requireMoney(p.defaultPurse, 'The default team purse', false);
    if (has('defaultMaxPlayers')) patch.default_max_players = Tournaments._requireCount(p.defaultMaxPlayers, 'The default squad size', 1);

    // --- Dates -----------------------------------------------------------
    // Each pair is re-checked against the value that will actually be stored,
    // not just against what was supplied: moving reg_start past an unchanged
    // reg_end has to fail too.
    if (has('startDate')) patch.start_date = Tournaments._requireDate(p.startDate, 'The tournament start date');
    if (has('endDate')) patch.end_date = Tournaments._requireDate(p.endDate, 'The tournament end date');
    if (has('regStart')) patch.reg_start = Tournaments._requireDate(p.regStart, 'The registration start date');
    if (has('regEnd')) patch.reg_end = Tournaments._requireDate(p.regEnd, 'The registration end date');

    if (has('startDate') || has('endDate')) {
      const s = patch.start_date || Tournaments._str(existing.start_date);
      const e = patch.end_date || Tournaments._str(existing.end_date);
      if (s && e && !Tournaments._datesInOrder(s, e)) {
        throw Util.AppError(ERR.VALIDATION_FAILED,
          'The tournament would end before it starts: ' + Util.formatIST(s, false) +
          ' to ' + Util.formatIST(e, false) + '.');
      }
    }
    if (has('regStart') || has('regEnd')) {
      const s = patch.reg_start || Tournaments._str(existing.reg_start);
      const e = patch.reg_end || Tournaments._str(existing.reg_end);
      if (s && e && !Tournaments._datesInOrder(s, e)) {
        throw Util.AppError(ERR.VALIDATION_FAILED,
          'Registration would end before it opens: ' + Util.formatIST(s, false) +
          ' to ' + Util.formatIST(e, false) + '.');
      }
    }

    // --- Images ------------------------------------------------------------
    const wantsRemoveLogo = p.removeLogo === true;
    const wantsRemoveQr = p.removeQr === true;
    const wantsRemoveGallery = p.removeGallery === true;
    if (wantsRemoveLogo && has('logo')) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Choose one: either upload a new logo or remove the current one.');
    }
    if (wantsRemoveQr && has('qr')) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Choose one: either upload a new QR image or remove the current one.');
    }
    if (wantsRemoveGallery && has('gallery')) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Choose one: either upload new gallery photos or remove the current ones.');
    }

    const oldLogoId = Tournaments._str(existing.logo_file_id);
    const oldQrId = Tournaments._str(existing.qr_file_id);
    const oldGalleryIds = Tournaments._galleryIds(existing);
    const trashAfterWrite = [];

    const touchesDrive = has('logo') || has('qr') || has('gallery');
    if (touchesDrive) {
      // Idempotent, and it repairs the tree if somebody deleted a folder.
      const folders = Drive.ensureTournamentFolders(existing.tournament_id, Tournaments._str(existing.slug));

      if (has('logo')) {
        patch.logo_file_id = Tournaments._uploadImage(folders.publicId, p.logo, 'logo', 'logo');
        if (oldLogoId) trashAfterWrite.push(oldLogoId);
      }
      if (has('qr')) {
        patch.qr_file_id = Tournaments._uploadImage(folders.publicId, p.qr, 'QR', 'qr');
        if (oldQrId) trashAfterWrite.push(oldQrId);
      }
      if (has('gallery')) {
        // A supplied gallery replaces the whole set, including [] meaning "none".
        const ids = Tournaments._uploadGallery(folders.galleryId, p.gallery);
        patch.photo_file_ids = JSON.stringify(ids);
        for (let i = 0; i < oldGalleryIds.length; i++) trashAfterWrite.push(oldGalleryIds[i]);
      }
    }

    if (wantsRemoveLogo) {
      patch.logo_file_id = '';
      if (oldLogoId) trashAfterWrite.push(oldLogoId);
    }
    if (wantsRemoveQr) {
      patch.qr_file_id = '';
      if (oldQrId) trashAfterWrite.push(oldQrId);
    }
    if (wantsRemoveGallery) {
      patch.photo_file_ids = JSON.stringify([]);
      for (let i = 0; i < oldGalleryIds.length; i++) trashAfterWrite.push(oldGalleryIds[i]);
    }

    const changed = Object.keys(patch);
    if (!changed.length) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Nothing was sent to change.');
    }

    // --- Write, then audit prev/next for exactly the changed columns -------
    const prev = {};
    const next = {};
    for (let i = 0; i < changed.length; i++) {
      const key = changed[i];
      prev[key] = existing[key];
      next[key] = patch[key];
    }

    Repo.updateRow(Tournaments._tab(), existing._row, patch);

    // Only once the sheet no longer references them.
    for (let i = 0; i < trashAfterWrite.length; i++) Tournaments._trashQuietly(trashAfterWrite[i]);

    Audit.log({
      actor: session ? session.user_id : '',
      role: session ? session.role : '',
      action: Audit.ACTIONS.TOURNAMENT_UPDATED,
      tournamentId: existing.tournament_id,
      entityType: 'Tournament',
      entityId: existing.tournament_id,
      prev: prev,
      next: next,
      ua: Tournaments._str(p.ua)
    });

    return {
      tournament_id: existing.tournament_id,
      slug: Tournaments._str(existing.slug),
      changed: changed
    };
  },

  /**
   * List every tournament with its registration counts.
   *
   * The counts come from ONE Repo.readAll(Players) and an in-memory group-by.
   * Calling Repo.filterBy per tournament would re-read the entire Players tab
   * once per tournament — with 400 players and 6 tournaments that is 2,400 rows
   * of getValues() to produce 12 numbers, and it is the classic way an Apps
   * Script list page ends up taking 30 seconds.
   *
   * @param {!Object} payload unused
   * @param {!Object} session the ADMIN session
   * @return {!Array<!Object>} newest first
   */
  list(payload, session) {
    const rows = Repo.readAll(Tournaments._tab());
    if (!rows.length) return [];

    const players = Repo.readAll(Tournaments._playersTab());
    const counts = {};
    for (let i = 0; i < players.length; i++) {
      const tid = Tournaments._str(players[i].tournament_id);
      if (!tid) continue;
      let c = counts[tid];
      if (!c) {
        c = { total: 0, verified: 0 };
        counts[tid] = c;
      }
      // Every registration counts, including withdrawn ones: the admin list is a
      // record of what arrived, and a withdrawal is shown on the player screen.
      c.total++;
      if (Tournaments._str(players[i].payment_status) === ENUM.PAYMENT_STATUS.VERIFIED) c.verified++;
    }

    const out = rows.map((r) => {
      const c = counts[Tournaments._str(r.tournament_id)] || { total: 0, verified: 0 };
      return {
        tournament_id: r.tournament_id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        reg_start: r.reg_start,
        reg_end: r.reg_end,
        reg_fee: Util.toInt(r.reg_fee, 0),
        player_count: c.total,
        verified_count: c.verified,
        created_at: r.created_at
      };
    });

    // created_at is a full UTC instant from Util.nowIso(), so Date.parse is the
    // right tool here — unlike a bare IST date, which must never be parsed
    // directly (CONTRACTS.md §6a).
    out.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
    return out;
  },

  /**
   * The full tournament row, for the admin edit screen and the organiser console.
   *
   * ADMIN sees every tournament; Auth.requireTournament confines an ORGANISER to
   * their own. Unlike getPublic this is not an allow-list — the caller is
   * authenticated and scoped, so the whole row is theirs to see. `_row` is
   * dropped because it is Repo plumbing, not data.
   *
   * @param {!Object} payload {tournamentId}
   * @param {!Object} session ADMIN or ORGANISER session
   * @return {!Object} the row plus derived urls
   * @throws {Error} NOT_FOUND, FORBIDDEN
   */
  get(payload, session) {
    const p = payload || {};
    const id = Tournaments._str(p.tournamentId || p.tournament_id);
    Auth.requireTournament(session, id);

    const row = Tournaments._require(id);
    const out = {};
    Object.keys(row).forEach((key) => {
      if (key !== '_row') out[key] = row[key];
    });

    // The JSON column is handed over as the array it logically is, and the two
    // links are built here so the frontend never has to know the URL shapes.
    const galleryIds = Tournaments._galleryIds(row);
    out.photo_file_ids = galleryIds;
    out.logo_url = Tournaments._str(row.logo_file_id)
      ? Drive.thumbUrl(row.logo_file_id, TOURNAMENT_IMAGE_WIDTH) : '';
    out.qr_url = Tournaments._str(row.qr_file_id)
      ? Drive.thumbUrl(row.qr_file_id, TOURNAMENT_IMAGE_WIDTH) : '';
    out.gallery_urls = galleryIds.map((fid) => Drive.thumbUrl(fid, TOURNAMENT_IMAGE_WIDTH));
    out.reg_fee_display = Util.formatINR(Util.toInt(row.reg_fee, 0));
    out.registrationUrl = Tournaments._registrationUrl(row.tournament_id);
    out.displayUrl = Tournaments._displayUrl(row.tournament_id, row.display_token);
    return out;
  },

  /**
   * Move a tournament to another status, enforcing the transition table.
   *
   * @param {!Object} payload {tournamentId, status}
   * @param {!Object} session the ADMIN session
   * @return {{tournament_id: string, status: string, prev_status: string, warning: string}}
   * @throws {Error} NOT_FOUND, VALIDATION_FAILED naming both statuses
   */
  setStatus(payload, session) {
    const p = payload || {};
    const row = Tournaments._require(p.tournamentId);

    const from = Tournaments._str(row.status);
    const to = Tournaments._str(p.status).toUpperCase();

    if (!to) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A new status is required.');
    }
    if (!Object.prototype.hasOwnProperty.call(ENUM.TOURNAMENT_STATUS, to)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        '"' + to.substring(0, 30) + '" is not a tournament status. Use one of: ' +
        Object.keys(ENUM.TOURNAMENT_STATUS).join(', ') + '.');
    }

    const allowed = Object.prototype.hasOwnProperty.call(TOURNAMENT_STATUS_TRANSITIONS, from)
      ? TOURNAMENT_STATUS_TRANSITIONS[from] : [];
    if (allowed.indexOf(to) === -1) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'This tournament is ' + (from || 'in an unknown state') + ' and cannot move to ' + to + '. ' +
        (allowed.length
          ? 'From ' + from + ' you can only move to ' + allowed.join(' or ') + '.'
          : 'There is no move out of ' + from + '.'));
    }

    Repo.updateRow(Tournaments._tab(), row._row, { status: to });

    // Registration closing, auction closing and the admin-only auction reopen all
    // have their own audit actions (CONTRACTS.md §10), and reviewing "who reopened
    // the auction" is a lot easier when it is not buried in TOURNAMENT_UPDATED.
    let action = Audit.ACTIONS.TOURNAMENT_UPDATED;
    if (from === ENUM.TOURNAMENT_STATUS.REG_OPEN && to === ENUM.TOURNAMENT_STATUS.REG_CLOSED) {
      action = Audit.ACTIONS.REGISTRATION_CLOSED;
    } else if (to === ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED) {
      action = Audit.ACTIONS.AUCTION_CLOSED;
    } else if (from === ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED && to === ENUM.TOURNAMENT_STATUS.AUCTION_LIVE) {
      action = Audit.ACTIONS.AUCTION_REOPENED;
    }

    Audit.log({
      actor: session ? session.user_id : '',
      role: session ? session.role : '',
      action: action,
      tournamentId: row.tournament_id,
      entityType: 'Tournament',
      entityId: row.tournament_id,
      prev: { status: from },
      next: { status: to },
      ua: Tournaments._str(p.ua)
    });

    // Legal, but almost never intended: players can keep registering into a
    // tournament whose auction has already begun, and a serial handed out
    // mid-auction will never be called.
    const warning = (from === ENUM.TOURNAMENT_STATUS.REG_OPEN && to === ENUM.TOURNAMENT_STATUS.AUCTION_LIVE)
      ? 'The auction is live but registration is still open, so new players can keep signing up. ' +
        'Set the status to REG_CLOSED first if that is not what you want.'
      : '';

    return {
      tournament_id: row.tournament_id,
      status: to,
      prev_status: from,
      warning: warning
    };
  },

  /**
   * Everything an anonymous visitor may see about a tournament.
   *
   * ============================ SECURITY BOUNDARY ============================
   * DESIGN.md §46 and §16 risk 4. This response is served to anyone who guesses
   * or is given a tournament id, with no token of any kind.
   *
   * The object below is built FIELD BY FIELD from an explicit allow-list. It is
   * deliberately NOT `const out = {...row}; delete out.display_token;` — with a
   * deny-list, every column a later phase appends to the Tournaments tab leaks
   * publicly by default, and it leaks silently, because nothing fails. With this
   * allow-list a new column is invisible until somebody deliberately adds a line
   * here. Adding a spread or an Object.assign to this function undoes that.
   *
   * Never exposed: drive_folder_id, display_token (it opens the projector feed),
   * next_serial (it counts registrations), created_by, contact_email, status,
   * any player row or count, any admin or organiser identity, any sheet id.
   * ===========================================================================
   *
   * There is no session parameter on purpose: this handler has no authenticated
   * caller and must never behave differently for one.
   *
   * @param {!Object} payload {tournamentId}
   * @return {!Object} the public view
   * @throws {Error} NOT_FOUND
   */
  getPublic(payload) {
    const p = payload || {};
    // GET puts query parameters straight into the payload, so both spellings
    // arrive in practice.
    const row = Tournaments._require(p.tournamentId || p.tournament_id);

    const reg = Tournaments._registrationState(row);
    const regFee = Util.toInt(row.reg_fee, 0);
    const logoId = Tournaments._str(row.logo_file_id);
    const qrId = Tournaments._str(row.qr_file_id);
    const regStart = Tournaments._str(row.reg_start);
    const regEnd = Tournaments._str(row.reg_end);

    return {
      tournament_id: Tournaments._str(row.tournament_id),
      name: Tournaments._str(row.name),
      description: Tournaments._str(row.description),
      rules: Tournaments._str(row.rules),

      reg_fee: regFee,
      reg_fee_display: Util.formatINR(regFee),

      logo_url: logoId ? Drive.thumbUrl(logoId, TOURNAMENT_IMAGE_WIDTH) : '',
      qr_url: qrId ? Drive.thumbUrl(qrId, TOURNAMENT_IMAGE_WIDTH) : '',
      // Bigger rendition for "Download QR Code" (DESIGN.md §8): a saved QR that
      // another app has to scan off a screenshot needs the extra pixels.
      qr_download_url: qrId ? Drive.thumbUrl(qrId, TOURNAMENT_QR_DOWNLOAD_WIDTH) : '',
      gallery_urls: Tournaments._galleryIds(row).map((fid) => Drive.thumbUrl(fid, TOURNAMENT_IMAGE_WIDTH)),

      upi_id: Tournaments._str(row.upi_id),
      contact_name: Tournaments._str(row.contact_name),
      contact_mobile: Tournaments._str(row.contact_mobile),

      reg_start: regStart,
      reg_end: regEnd,
      reg_start_display: Util.formatIST(regStart, false),
      reg_end_display: Util.formatIST(regEnd, false),

      registration_open: reg.open,
      registration_message: reg.message
    };
  }
};

/**
 * Tournament route table.
 *
 * Built inside a function, never at load time: Apps Script concatenates .gs
 * files in an undefined order (CONTRACTS.md §11).
 *
 * tournament.getPublic is the only entry reachable by GET, because it is the
 * only public read here — a registration link has to work from a plain browser
 * address bar with no JavaScript-set body.
 *
 * @return {!Object} route table fragment
 */
function TournamentRoutes() {
  return {
    'tournament.create': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload create fields
       * @param {!Object} session ADMIN session
       * @return {!Object} {tournament_id, slug, status, registrationUrl, displayUrl}
       */
      handler: (payload, session) => Tournaments.create(payload, session)
    },

    'tournament.update': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, ...changes}
       * @param {!Object} session ADMIN session
       * @return {!Object} {tournament_id, slug, changed}
       */
      handler: (payload, session) => Tournaments.update(payload, session)
    },

    'tournament.list': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload unused
       * @param {!Object} session ADMIN session
       * @return {!Array<!Object>} tournaments with counts
       */
      handler: (payload, session) => Tournaments.list(payload, session)
    },

    'tournament.get': {
      auth: ['ADMIN', 'ORGANISER'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ADMIN or ORGANISER session
       * @return {!Object} the full row
       */
      handler: (payload, session) => Tournaments.get(payload, session)
    },

    'tournament.setStatus': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, status}
       * @param {!Object} session ADMIN session
       * @return {!Object} {tournament_id, status, prev_status, warning}
       */
      handler: (payload, session) => Tournaments.setStatus(payload, session)
    },

    'tournament.getPublic': {
      auth: 'PUBLIC',
      methods: ['GET', 'POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @return {!Object} the allow-listed public view
       */
      handler: (payload) => Tournaments.getPublic(payload)
    }
  };
}
