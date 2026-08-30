/**
 * Util.gs — pure helpers with no Spreadsheet, Drive or Cache dependency.
 *
 * Contract: CONTRACTS.md §6.
 *
 * Nothing in here touches an Apps Script service other than `Utilities`, so every
 * function is cheap and safe to call from anywhere, including inside a lock.
 */
const Util = {

  // ---------------------------------------------------------------------------
  // Identifiers and time
  // ---------------------------------------------------------------------------

  /**
   * Build an entity id: a prefix plus 12 lowercase base36 characters.
   *
   * Derived from two UUIDs run through SHA-256 rather than Math.random(), because
   * Math.random() in Apps Script is not seeded per-execution in a way we can rely
   * on and two near-simultaneous registrations must never collide.
   *
   * @param {string} prefix One of the ID_PREFIX values, e.g. "PLY_".
   * @return {string} e.g. "PLY_k3m9x1qz7f2a".
   */
  uid: function (prefix) {
    const p = Util.isBlank(prefix) ? '' : String(prefix);

    // 15 hex chars = three 20-bit chunks. 2^20 < 36^4, so each chunk always fits
    // in exactly 4 base36 characters once zero-padded. 3 x 4 = the 12 we want.
    const hex = Util.sha256Hex(Utilities.getUuid() + '|' + Utilities.getUuid());
    let out = '';
    for (let i = 0; i < 3; i++) {
      const chunk = parseInt(hex.substring(i * 5, i * 5 + 5), 16);
      out += ('0000' + chunk.toString(36)).slice(-4);
    }
    return p + out;
  },

  /**
   * Current instant as an ISO-8601 UTC string with milliseconds.
   * Every timestamp written to a sheet comes from here — client clocks are never
   * trusted (CONTRACTS.md §1.7).
   *
   * @return {string} e.g. "2026-08-30T11:42:05.123Z".
   */
  nowIso: function () {
    return new Date().toISOString();
  },

  // ---------------------------------------------------------------------------
  // Indian Standard Time
  //
  // Instants are stored in UTC (nowIso). Calendar dates are an IST question,
  // because everyone using this app is in India: an admin who sets a
  // registration deadline of "2026-08-31" means the end of that day in Chennai,
  // not 05:30 that morning.
  //
  // IST is a fixed UTC+05:30. India has never observed daylight saving, so this
  // is plain arithmetic with no timezone database and no DST edge cases.
  //
  // Deliberately NOT using Utilities.formatDate with the script timezone: that
  // depends on appsscript.json being set correctly, and silently produces wrong
  // dates if the project is ever copied with a different manifest. Arithmetic
  // cannot drift.
  // ---------------------------------------------------------------------------

  /** Minutes IST runs ahead of UTC. Fixed forever — India has no DST. */
  IST_OFFSET_MIN: 330,

  /**
   * Today's date in IST, date part only.
   *
   * Between 00:00 and 05:30 IST this differs from the UTC date, which is
   * exactly the window where a UTC-based deadline would close a day early.
   *
   * @return {string} e.g. "2026-08-30".
   */
  todayIso: function () {
    return Util.istDate(Util.nowIso());
  },

  /**
   * The IST calendar date an instant falls on.
   *
   * @param {string} isoInstant ISO-8601 instant, e.g. "2026-08-30T20:15:00.000Z".
   * @return {string} IST date as "YYYY-MM-DD", e.g. "2026-08-31".
   */
  istDate: function (isoInstant) {
    const ms = Date.parse(isoInstant);
    if (isNaN(ms)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Could not read the date "' + isoInstant + '".');
    }
    return new Date(ms + Util.IST_OFFSET_MIN * 60000).toISOString().substring(0, 10);
  },

  /**
   * The UTC instant at which an IST calendar day begins (00:00:00.000 IST).
   *
   * @param {string} dateStr "YYYY-MM-DD".
   * @return {string} ISO-8601 UTC instant. "2026-08-31" -> "2026-08-30T18:30:00.000Z".
   */
  istDayStartUtc: function (dateStr) {
    const p = Util.parseDateParts_(dateStr);
    if (!p) throw Util.AppError(ERR.VALIDATION_FAILED, 'Could not read the date "' + dateStr + '".');
    const ms = Date.UTC(p.y, p.m - 1, p.d, 0, 0, 0, 0) - Util.IST_OFFSET_MIN * 60000;
    return new Date(ms).toISOString();
  },

  /**
   * The last UTC instant of an IST calendar day (23:59:59.999 IST).
   *
   * This is what makes an inclusive deadline behave the way a human means it:
   * "registration closes 31 Aug" stays open all of 31 August in India.
   *
   * @param {string} dateStr "YYYY-MM-DD".
   * @return {string} ISO-8601 UTC instant. "2026-08-31" -> "2026-08-31T18:29:59.999Z".
   */
  istDayEndUtc: function (dateStr) {
    const p = Util.parseDateParts_(dateStr);
    if (!p) throw Util.AppError(ERR.VALIDATION_FAILED, 'Could not read the date "' + dateStr + '".');
    const ms = Date.UTC(p.y, p.m - 1, p.d, 23, 59, 59, 999) - Util.IST_OFFSET_MIN * 60000;
    return new Date(ms).toISOString();
  },

  /**
   * Is an instant inside an inclusive window?
   *
   * Date-only bounds are widened to whole IST days: a start of "2026-08-01"
   * opens at IST midnight, an end of "2026-08-31" closes at 23:59:59.999 IST.
   * Full instants are used as given. A blank bound means unbounded on that side.
   *
   * Used for the registration window (DESIGN.md §48) — the authoritative check
   * runs server-side at submit time, never in the browser.
   *
   * @param {string} startIso Date or instant. Blank for no lower bound.
   * @param {string} endIso Date or instant. Blank for no upper bound.
   * @param {string=} atIso Instant to test. Defaults to now.
   * @return {boolean} True when atIso falls inside the window.
   */
  isWithinWindow: function (startIso, endIso, atIso) {
    const at = atIso ? Date.parse(atIso) : Date.now();
    if (isNaN(at)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Could not read the date "' + atIso + '".');
    }

    // A 10-character bound is a bare date and means the whole IST day.
    const lo = Util.isBlank(startIso)
      ? -Infinity
      : Date.parse(String(startIso).length === 10 ? Util.istDayStartUtc(startIso) : startIso);
    const hi = Util.isBlank(endIso)
      ? Infinity
      : Date.parse(String(endIso).length === 10 ? Util.istDayEndUtc(endIso) : endIso);

    if (isNaN(lo) || isNaN(hi)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'The date range is not valid.');
    }
    return at >= lo && at <= hi;
  },

  /**
   * Human-readable IST rendering for screens and reports.
   *
   * @param {string} isoInstant ISO-8601 instant.
   * @param {boolean=} withTime Include the time. Default true.
   * @return {string} e.g. "31 Aug 2026, 10:42 AM" or "31 Aug 2026".
   */
  formatIST: function (isoInstant, withTime) {
    const ms = Date.parse(isoInstant);
    if (isNaN(ms)) return '';
    const d = new Date(ms + Util.IST_OFFSET_MIN * 60000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const datePart = d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    if (withTime === false) return datePart;

    let h = d.getUTCHours();
    const suffix = h < 12 ? 'AM' : 'PM';
    h = h % 12;
    if (h === 0) h = 12;
    const mm = ('0' + d.getUTCMinutes()).slice(-2);
    return datePart + ', ' + h + ':' + mm + ' ' + suffix;
  },

  // ---------------------------------------------------------------------------
  // Numbers and money
  // ---------------------------------------------------------------------------

  /**
   * Coerce anything to a whole number, falling back when it is not numeric.
   * Truncates towards zero; never throws.
   *
   * @param {*} v Value to coerce. Strings may carry spaces or commas.
   * @param {number=} fallback Returned when v is blank or not a finite number. Default 0.
   * @return {number} A whole number.
   */
  toInt: function (v, fallback) {
    const fb = (typeof fallback === 'number' && isFinite(fallback)) ? Math.trunc(fallback) : 0;
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return fb;

    const n = (typeof v === 'number') ? v : Number(String(v).trim().replace(/,/g, ''));
    if (!isFinite(n)) return fb;
    return Math.trunc(n);
  },

  /**
   * Validate and normalise a money value.
   *
   * Money in this system is always a positive whole number of rupees
   * (CONTRACTS.md §1.6). Floats, zero, negatives, blanks and anything with a
   * currency symbol or decimal point are rejected rather than rounded, because a
   * silently rounded bid corrupts the purse arithmetic.
   *
   * @param {number|string} v Amount in rupees.
   * @return {number} The amount as a positive integer.
   * @throws {!Error} Util.AppError(ERR.INVALID_AMOUNT) if v is not a positive integer.
   */
  toMoney: function (v) {
    const shown = String(v);

    if (v === null || v === undefined || v === '' || typeof v === 'boolean') {
      throw Util.AppError(ERR.INVALID_AMOUNT, 'Amount is required and must be a whole number of rupees greater than zero.');
    }

    let n;
    if (typeof v === 'number') {
      n = v;
    } else {
      const s = String(v).trim();
      // Digits only. This deliberately rejects "1e3", "1.0", "+5", "1,000" and "₹500":
      // an amount arriving in any of those shapes means the caller did not normalise it.
      if (!/^[0-9]+$/.test(s)) {
        throw Util.AppError(ERR.INVALID_AMOUNT, 'Amount "' + shown + '" is not a whole number of rupees.');
      }
      n = Number(s);
    }

    if (!isFinite(n) || Math.floor(n) !== n) {
      throw Util.AppError(ERR.INVALID_AMOUNT, 'Amount "' + shown + '" must be a whole number of rupees, not a decimal.');
    }
    if (n <= 0) {
      throw Util.AppError(ERR.INVALID_AMOUNT, 'Amount must be greater than zero, got ' + n + '.');
    }
    if (n > Number.MAX_SAFE_INTEGER) {
      throw Util.AppError(ERR.INVALID_AMOUNT, 'Amount "' + shown + '" is too large.');
    }
    return n;
  },

  /**
   * Format rupees with Indian digit grouping: last three digits, then pairs.
   *
   * Apps Script's toLocaleString does not reliably honour "en-IN", so the grouping
   * is done by hand. 1000000 -> "₹10,00,000", 75000 -> "₹75,000", 500 -> "₹500".
   *
   * @param {number|string} n Amount in whole rupees. Non-numeric input formats as ₹0.
   * @return {string} e.g. "₹10,00,000". Negatives come back as "-₹1,000".
   */
  formatINR: function (n) {
    let num = (typeof n === 'number') ? n : Number(String(n === null || n === undefined ? '' : n).trim().replace(/,/g, ''));
    if (!isFinite(num)) num = 0;
    num = Math.round(num);

    const negative = num < 0;
    const digits = String(Math.abs(num));

    let grouped;
    if (digits.length <= 3) {
      grouped = digits;
    } else {
      const last3 = digits.slice(-3);
      const rest = digits.slice(0, -3);
      // Comma before every pair counted from the right of `rest`.
      grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
    }

    return (negative ? '-₹' : '₹') + grouped;
  },

  // ---------------------------------------------------------------------------
  // Hashing and tokens
  // ---------------------------------------------------------------------------

  /**
   * Convert an Apps Script byte array to a lowercase hex string.
   *
   * Utilities.computeDigest and computeHmacSha256Signature return *signed* bytes
   * (-128..127). Calling toString(16) on a negative byte yields "-1f" and quietly
   * produces a wrong, unstable hash — hence the (b + 256) % 256 normalisation and
   * the two-character zero pad.
   *
   * @param {!Array<number>} bytes Signed byte array from Utilities.
   * @return {string} Lowercase hex, two characters per byte.
   */
  bytesToHex: function (bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = (bytes[i] + 256) % 256;
      hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return hex;
  },

  /**
   * SHA-256 of a UTF-8 string.
   *
   * @param {string} str Input.
   * @return {string} 64-character lowercase hex digest.
   */
  sha256Hex: function (str) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(str === null || str === undefined ? '' : str),
      Utilities.Charset.UTF_8
    );
    return Util.bytesToHex(bytes);
  },

  /**
   * HMAC-SHA256 of a message under a key, both UTF-8 strings.
   *
   * @param {string} key Secret key.
   * @param {string} msg Message.
   * @return {string} 64-character lowercase hex MAC.
   */
  hmacSha256Hex: function (key, msg) {
    const bytes = Utilities.computeHmacSha256Signature(
      String(msg === null || msg === undefined ? '' : msg),
      String(key === null || key === undefined ? '' : key),
      Utilities.Charset.UTF_8
    );
    return Util.bytesToHex(bytes);
  },

  /**
   * Hash a password for storage (DESIGN.md §5.2).
   *
   * key = pepper + salt, then DEFAULTS.hash_iterations rounds of HMAC-SHA256 with
   * each round's hex output fed in as the next round's message. The iteration
   * count is the only brute-force cost we have — Apps Script has no bcrypt.
   *
   * @param {string} plain The plaintext password.
   * @param {string} salt Per-user random hex salt from the Users row.
   * @param {string} pepper Server-wide secret from the Config tab.
   * @return {string} 64-character lowercase hex hash.
   */
  hashPassword: function (plain, salt, pepper) {
    const key = String(pepper === null || pepper === undefined ? '' : pepper) +
                String(salt === null || salt === undefined ? '' : salt);

    let digest = String(plain === null || plain === undefined ? '' : plain);
    const rounds = DEFAULTS.hash_iterations;
    for (let i = 0; i < rounds; i++) {
      digest = Util.hmacSha256Hex(key, digest);
    }
    return digest;
  },

  /**
   * Generate a cryptographically-awkward-to-guess random hex token.
   *
   * Apps Script has no crypto.randomBytes, so entropy comes from Utilities.getUuid()
   * (a type-4 UUID, ~122 random bits each). Several UUIDs plus the clock are
   * concatenated and run through SHA-256 to whiten the result, and blocks are
   * chained with a counter when more than 32 bytes are asked for.
   *
   * @param {number=} byteLen How many bytes of token. Default 32 (a session token).
   * @return {string} Lowercase hex string, byteLen * 2 characters long.
   * @throws {!Error} Util.AppError(ERR.VALIDATION_FAILED) if byteLen is not positive.
   */
  randomToken: function (byteLen) {
    const n = (byteLen === undefined || byteLen === null) ? 32 : Util.toInt(byteLen, 0);
    if (n <= 0) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'randomToken needs a positive byte length, got ' + byteLen + '.');
    }

    let hex = '';
    let block = 0;
    while (hex.length < n * 2) {
      const seed = block + '|' + Utilities.getUuid() + '|' + Utilities.getUuid() +
                   '|' + Utilities.getUuid() + '|' + new Date().getTime();
      hex += Util.sha256Hex(seed);
      block++;
    }
    return hex.substring(0, n * 2);
  },

  // ---------------------------------------------------------------------------
  // Strings, dates, validation
  // ---------------------------------------------------------------------------

  /**
   * Turn a name into a URL-safe slug.
   *
   * @param {string} str e.g. "Chennai Premier League 2026!".
   * @return {string} e.g. "chennai-premier-league-2026". Empty string if nothing survives.
   */
  slugify: function (str) {
    if (Util.isBlank(str)) return '';
    return String(str)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')   // any run of non-alphanumerics becomes one dash
      .replace(/^-+|-+$/g, '');
  },

  /**
   * Whole years between a date of birth and a reference date.
   *
   * Subtracting years is not enough: someone born 2000-12-31 is 25, not 26, on
   * 2026-08-30 because the birthday has not happened yet this year. Both dates are
   * compared as plain calendar dates, so time zones cannot shift the answer.
   *
   * @param {string} dobIso Date of birth, "YYYY-MM-DD" or a full ISO timestamp.
   * @param {string=} atIso Reference date, same formats. Defaults to today (UTC).
   * @return {number} Age in whole years, never negative.
   * @throws {!Error} Util.AppError(ERR.VALIDATION_FAILED) if either date is unparseable.
   */
  ageYears: function (dobIso, atIso) {
    const dob = Util.parseDateParts_(dobIso);
    if (!dob) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Date of birth "' + dobIso + '" is not a valid date. Use YYYY-MM-DD.');
    }

    const at = (atIso === undefined || atIso === null || atIso === '')
      ? Util.parseDateParts_(Util.todayIso())
      : Util.parseDateParts_(atIso);
    if (!at) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Reference date "' + atIso + '" is not a valid date. Use YYYY-MM-DD.');
    }

    let years = at.y - dob.y;
    if (at.m < dob.m || (at.m === dob.m && at.d < dob.d)) years--;
    return years < 0 ? 0 : years;
  },

  /**
   * Parse the calendar-date part of an ISO string. Internal helper.
   *
   * @param {string|!Date} v "YYYY-MM-DD", a full ISO timestamp, or a Date.
   * @return {?{y: number, m: number, d: number}} Null if unparseable or not a real date.
   */
  parseDateParts_: function (v) {
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
    }
    if (Util.isBlank(v)) return null;

    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
    if (!m) return null;

    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

    // Reject impossible days like 2026-02-30, which Date would roll into March.
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;

    return { y: y, m: mo, d: d };
  },

  /**
   * Is this a valid Indian mobile number? Exactly 10 digits starting 6-9,
   * no country code, no spaces.
   *
   * @param {string} str Candidate number.
   * @return {boolean} True if valid.
   */
  isValidMobileIN: function (str) {
    if (Util.isBlank(str)) return false;
    return /^[6-9][0-9]{9}$/.test(String(str).trim());
  },

  /**
   * Is the value empty for our purposes? Null, undefined, or whitespace only.
   * Note that 0 and false are NOT blank.
   *
   * @param {*} v Value to test.
   * @return {boolean} True if blank.
   */
  isBlank: function (v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    return String(v).trim() === '';
  },

  /**
   * JSON.parse that never throws. Used on sheet cells and request bodies, where
   * a bad value should degrade rather than take down the request.
   *
   * @param {string} str Candidate JSON text.
   * @param {*=} fallback Returned on any parse failure. Default null.
   * @return {*} The parsed value or the fallback.
   */
  safeJsonParse: function (str, fallback) {
    const fb = (fallback === undefined) ? null : fallback;
    if (Util.isBlank(str)) return fb;
    try {
      const parsed = JSON.parse(String(str));
      return (parsed === undefined) ? fb : parsed;
    } catch (e) {
      return fb;
    }
  },

  // ---------------------------------------------------------------------------
  // Response envelope (CONTRACTS.md §2)
  // ---------------------------------------------------------------------------

  /**
   * Build a success envelope.
   *
   * @param {*} data Payload for the client.
   * @param {number=} v Auction state version, or omitted when not applicable.
   * @return {{ok: boolean, data: *, v: ?number}} The envelope.
   */
  ok: function (data, v) {
    return {
      ok: true,
      data: (data === undefined) ? null : data,
      v: (v === undefined || v === null) ? null : v
    };
  },

  /**
   * Build a failure envelope. The message is shown to a user verbatim, so it must
   * be plain English with real numbers in it.
   *
   * @param {string} code One of the ERR constants.
   * @param {string} message Human-readable explanation.
   * @return {{ok: boolean, error: {code: string, message: string}}} The envelope.
   */
  err: function (code, message) {
    return {
      ok: false,
      error: {
        code: code || ERR.INTERNAL_ERROR,
        message: (message === null || message === undefined) ? '' : String(message)
      }
    };
  },

  /**
   * Create (but do not throw) an Error carrying an ERR code.
   *
   * The dispatcher checks `.isAppError` to decide whether the message is safe to
   * show a user; anything else becomes a generic INTERNAL_ERROR. Returning rather
   * than throwing keeps the call site readable: `throw Util.AppError(...)`.
   *
   * @param {string} code One of the ERR constants.
   * @param {string} message Human-readable explanation.
   * @return {!Error} Error with `.code` and `.isAppError = true`.
   */
  AppError: function (code, message) {
    const resolvedCode = code || ERR.INTERNAL_ERROR;
    const e = new Error((message === null || message === undefined || message === '') ? resolvedCode : String(message));
    e.name = 'AppError';
    e.code = resolvedCode;
    e.isAppError = true;
    return e;
  }
};
