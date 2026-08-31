/**
 * Tests.gs — the test runner Apps Script does not give us.
 *
 * Contract: CONTRACTS.md §14. Design rationale: DESIGN.md §18.
 *
 * HOW TO RUN
 *   Apps Script editor -> select `runAllTests` -> Run. Read the execution log.
 *   To run one suite: temporarily select `runTest` and edit the default argument,
 *   or call runTest('Repo') from another function.
 *
 * WHAT THIS FILE MAY TOUCH
 *   Repo.gs owns SpreadsheetApp (CONTRACTS.md §5), so every sheet read or write
 *   here goes through Repo. CacheService / PropertiesService / DriveApp are used
 *   directly in a few places, always to *corrupt* or *clean up* state that the
 *   module under test has no API for. Those spots are commented individually.
 *
 * NO TOP-LEVEL EXECUTABLE STATEMENTS (CONTRACTS.md §1.3). Everything lives inside
 * the two `const` object literals below plus the two bare entry-point functions.
 */

/**
 * Fixture identifiers. Deliberately ugly and prefixed with "zz" so a human
 * scrolling the sheet can tell at a glance that a row is test debris, and so the
 * cleanup pass can find every row it created with a prefix match.
 * @const {!Object<string,string>}
 */
const TEST_FIXTURES = Object.freeze({
  /** Every fixture tournament_id starts with this. Cleanup keys off it. */
  TID_PREFIX: 'TRN_zztest',
  /** The main fixture tournament used by the Repo and Auth suites. */
  TID: 'TRN_zztest000001',
  /** A second tournament, used to prove cross-tournament access is refused. */
  TID_OTHER: 'TRN_zztest000002',
  /** Every fixture user email ends with this. Cleanup keys off it. */
  EMAIL_DOMAIN: '@zztest.invalid',
  /** Fake actor id recorded as created_by / actor on fixture rows. */
  ACTOR: 'USR_zztest000000',
  /** Comfortably over Auth.MIN_PASSWORD_LEN whatever it is set to; 16 chars. */
  PASSWORD: 'TestPassw0rd!234',
  /**
   * Marker for a photo_file_id / screenshot_file_id that was written straight
   * onto a fixture row and never uploaded anywhere.
   *
   * The Phase 2 suites seed hundreds of Players and Payments rows directly,
   * because uploading a real image for each one would take minutes and prove
   * nothing about paging or filtering. Those rows still need a NON-BLANK file id:
   * the whole point of the "screenshot_file_id never leaves the server" tests is
   * to search the serialised response for the literal value, and searching for ''
   * would pass against anything. The prefix lets T.trackDrive tell a placeholder
   * from a real Drive id and skip it, so cleanup does not log a warning per row
   * for files that never existed.
   */
  FAKE_DRIVE_PREFIX: 'zzfakedrive_',
  /** Pepper used for the Util.hashPassword tests. Not the real server pepper. */
  PEPPER: 'zz-test-pepper-not-the-real-one'
});

/**
 * The harness. `T` holds both the assertion API required by CONTRACTS.md §14 and
 * the mutable run state, because Apps Script has no module scope to hide it in.
 *
 * Design note: assertions throw a tagged Error and `T.test` catches it. Results are
 * *collected*, never rethrown out of the run, so one broken assertion does not hide
 * the other eighty.
 */
const T = {

  // ---------------------------------------------------------------------------
  // Run state
  // ---------------------------------------------------------------------------

  /** @type {!Object} Reset by T.reset() at the start of every run. */
  _state: {
    suites: [],        // [{name, fn}]
    results: [],       // [{suite, test, ok, message, ms}]
    current: null,     // name of the suite currently executing
    startedAt: 0,
    driveIds: [],      // {id, kind:'file'|'folder'} created by the Drive suite
    userIds: [],       // fixture user_ids, so Sessions rows can be found
    emails: [],        // fixture emails, so login-failure counters can be cleared
    cacheTids: [],     // tournament ids whose cache/version keys must be purged
    cacheKeys: [],     // individual CacheService keys with no tournament-wide API
    tids: [],          // fixture tournament ids that do NOT carry TID_PREFIX
    seq: 0,            // monotonic counter for unique fixture mobiles / upi refs
    mobileBase: ''     // run-unique middle digits of every fixture mobile number
  },

  /** Wipes run state. Called by both entry points. */
  reset() {
    T._state = {
      suites: [], results: [], current: null, startedAt: 0,
      driveIds: [], userIds: [], emails: [], cacheTids: [], cacheKeys: [], tids: [],
      seq: 0, mobileBase: ''
    };
  },

  /**
   * A run-unique number. Used to mint fixture mobile numbers and UPI references
   * that cannot collide with each other inside one run.
   * @return {number}
   */
  nextSeq() {
    T._state.seq += 1;
    return T._state.seq;
  },

  /**
   * Registers a tournament id for cleanup.
   *
   * Most fixtures pick their own id and start with TEST_FIXTURES.TID_PREFIX, which
   * cleanup finds by prefix match. `tournament.create` mints its own id, so the
   * Tournament suite has to hand it over explicitly or the row, its Drive folders,
   * its audit rows and its version counter would all survive the run.
   *
   * @param {string} tid
   * @return {string} the same tid, so this can wrap an expression.
   */
  trackTid(tid) {
    if (typeof tid === 'string' && tid && T._state.tids.indexOf(tid) === -1) {
      T._state.tids.push(tid);
      T._state.cacheTids.push(tid);
    }
    return tid;
  },

  /**
   * Registers a Drive id for trashing, ignoring duplicates.
   * @param {string} id
   * @param {string} kind 'file' or 'folder'
   */
  trackDrive(id, kind) {
    if (!id || typeof id !== 'string') return;
    // A placeholder id from a seeded row was never uploaded, so there is nothing
    // in Drive to trash and DriveApp would only raise a "file not found" that
    // cleanup would then log once per fixture row.
    if (id.indexOf(TEST_FIXTURES.FAKE_DRIVE_PREFIX) === 0) return;
    for (let i = 0; i < T._state.driveIds.length; i++) {
      if (T._state.driveIds[i].id === id) return;
    }
    T._state.driveIds.push({ id: id, kind: kind });
  },

  /**
   * Registers a raw CacheService key for deletion.
   *
   * Cache.invalidate(tid) only drops the snapshot, on purpose (Cache.gs says so),
   * and Phase 4 keeps two more keys per tournament that no module-level API
   * removes: the projector's current-player pointer and the "this display token
   * has already been checked" flag, whose key contains a hash of the token. A
   * stale display-token flag would let a rotated token keep working for the next
   * five minutes of the next run, which is exactly the behaviour that test is
   * supposed to be able to prove is bounded.
   *
   * @param {string} key the exact cache key
   * @return {string} the same key, so this can wrap an expression.
   */
  trackCacheKey(key) {
    if (typeof key === 'string' && key && T._state.cacheKeys.indexOf(key) === -1) {
      T._state.cacheKeys.push(key);
    }
    return key;
  },

  // ---------------------------------------------------------------------------
  // Safety guard — CONTRACTS.md §14
  // ---------------------------------------------------------------------------

  /**
   * Throws unless the Config tab's `env` key is exactly "TEST".
   *
   * WHY THIS IS NOT OPTIONAL: these tests append real rows to real tabs and call
   * Auth/Drive, which write real AuditLog entries. AuditLog is an append-only
   * evidence trail (DESIGN.md §2.7) — there is no clean way to remove test rows
   * from a live tournament's audit history after the fact, so a stray run against
   * PROD permanently corrupts the record the tournament is judged on. The guard
   * runs before suites are even registered; there is no code path around it.
   *
   * @return {string} the env value, for logging.
   */
  guardTestEnv() {
    let row = null;
    try {
      row = Repo.findBy(SHEETS.CONFIG, 'key', 'env');
    } catch (e) {
      throw new Error(
        'REFUSING TO RUN TESTS: could not read the "env" key from the Config tab (' +
        T._errText(e) + '). Run setup() first.');
    }
    if (!row) {
      throw new Error(
        'REFUSING TO RUN TESTS: the Config tab has no "env" key. ' +
        'Run setup() on a TEST spreadsheet first.');
    }
    const env = String(row.value == null ? '' : row.value).trim();
    if (env !== 'TEST') {
      throw new Error(
        'REFUSING TO RUN TESTS: Config env is "' + env + '", not "TEST". ' +
        'Tests write real rows and real AuditLog entries, and audit rows cannot be ' +
        'cleanly removed from a live tournament. Point this deployment at the TEST ' +
        'spreadsheet (DESIGN.md §17.4) before running.');
    }
    return env;
  },

  // ---------------------------------------------------------------------------
  // Registration and execution
  // ---------------------------------------------------------------------------

  /**
   * Registers a suite. The body is not executed until the runner reaches it.
   * @param {string} name
   * @param {function()} fn body that calls T.test(...) one or more times.
   */
  suite(name, fn) {
    T._state.suites.push({ name: name, fn: fn });
  },

  /**
   * Runs one test and records the outcome. Never throws.
   * @param {string} name
   * @param {function()} fn
   */
  test(name, fn) {
    const suiteName = T._state.current || '<no suite>';
    const t0 = Date.now();
    try {
      fn();
      T._record(suiteName, name, true, '', Date.now() - t0);
    } catch (e) {
      const isAssertion = !!(e && e.__assertion === true);
      const msg = isAssertion ? e.message : 'threw unexpectedly: ' + T._errText(e);
      T._record(suiteName, name, false, msg, Date.now() - t0);
    }
  },

  /** @private */
  _record(suite, test, ok, message, ms) {
    T._state.results.push({ suite: suite, test: test, ok: ok, message: message, ms: ms });
  },

  /**
   * Executes a registered suite. A throw in the suite *body* (fixture setup, say)
   * is recorded as a single failure rather than killing the run, so the remaining
   * suites and — critically — the cleanup pass still happen.
   * @private
   */
  _runSuite(s) {
    T._state.current = s.name;
    try {
      s.fn();
    } catch (e) {
      T._record(s.name, '<suite body>',
        false, 'suite aborted before finishing: ' + T._errText(e), 0);
    }
    T._state.current = null;
  },

  // ---------------------------------------------------------------------------
  // Assertions — CONTRACTS.md §14
  // ---------------------------------------------------------------------------

  /**
   * @param {*} cond
   * @param {string=} msg
   */
  assert(cond, msg) {
    if (!cond) {
      T._fail((msg || 'assert') + ': expected a truthy value, got ' + T._fmt(cond));
    }
  },

  /**
   * Deep equality with a readable diff. Compares arrays and plain objects
   * recursively; Dates by timestamp; NaN equals NaN.
   * @param {*} actual
   * @param {*} expected
   * @param {string=} msg
   */
  assertEqual(actual, expected, msg) {
    if (T._deepEqual(actual, expected)) return;
    const where = T._firstDiff(actual, expected, '');
    T._fail(
      (msg || 'assertEqual') + '\n' +
      '      expected: ' + T._fmt(expected) + '\n' +
      '      actual:   ' + T._fmt(actual) +
      (where ? '\n      first difference ' + where : ''));
  },

  /**
   * Asserts that `fn` throws, and (when expectedCode is given) that the thrown
   * error carries exactly that `.code`.
   *
   * Passing `null` for expectedCode means "must throw something with a `.code`" —
   * used only where CONTRACTS.md does not pin the specific code. Every such call
   * site carries a comment saying so.
   *
   * @param {function()} fn
   * @param {?string} expectedCode an ERR.* constant, or null for "any AppError".
   * @param {string=} msg
   * @return {!Error} the caught error, so the caller can inspect .message.
   */
  assertThrows(fn, expectedCode, msg) {
    const label = msg || 'assertThrows';
    let caught = null;
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
      caught = e;
    }
    if (!threw) {
      T._fail(label + ': expected a throw with code ' +
        (expectedCode || '<any>') + ', but nothing was thrown');
    }
    const actualCode = (caught && caught.code) ? caught.code : null;
    if (expectedCode === null || expectedCode === undefined) {
      if (!actualCode) {
        T._fail(label + ': expected an error carrying a .code, got ' + T._errText(caught));
      }
    } else if (actualCode !== expectedCode) {
      T._fail(label + ': expected code ' + expectedCode + ', got ' +
        (actualCode || '<no .code>') + ' — ' + T._errText(caught));
    }
    return caught;
  },

  /**
   * @param {number} a
   * @param {number} b
   * @param {number} tolerance inclusive
   * @param {string=} msg
   */
  assertClose(a, b, tolerance, msg) {
    if (typeof a !== 'number' || typeof b !== 'number' || isNaN(a) || isNaN(b)) {
      T._fail((msg || 'assertClose') + ': both values must be numbers, got ' +
        T._fmt(a) + ' and ' + T._fmt(b));
    }
    const diff = Math.abs(a - b);
    if (diff > tolerance) {
      T._fail((msg || 'assertClose') + ': |' + a + ' - ' + b + '| = ' + diff +
        ', which exceeds the tolerance of ' + tolerance);
    }
  },

  /** @private Throws the tagged error that T.test recognises as a failed assertion. */
  _fail(message) {
    const e = new Error(message);
    e.__assertion = true;
    throw e;
  },

  // ---------------------------------------------------------------------------
  // Comparison and formatting helpers
  // ---------------------------------------------------------------------------

  /** @private */
  _typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Date) return 'date';
    return typeof v;
  },

  /** @private */
  _deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)) return true;
    const ta = T._typeOf(a);
    const tb = T._typeOf(b);
    if (ta !== tb) return false;
    if (ta === 'date') return a.getTime() === b.getTime();
    if (ta === 'array') {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!T._deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    if (ta === 'object') {
      const ka = Object.keys(a).sort();
      const kb = Object.keys(b).sort();
      if (ka.length !== kb.length) return false;
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return false;
        if (!T._deepEqual(a[ka[i]], b[ka[i]])) return false;
      }
      return true;
    }
    return false;
  },

  /**
   * @private Walks two values in parallel and describes the first place they
   * diverge, e.g. `at .team.purse_used: expected 40000, actual "40000"`.
   */
  _firstDiff(actual, expected, path) {
    if (T._deepEqual(actual, expected)) return null;
    const ta = T._typeOf(actual);
    const te = T._typeOf(expected);
    const at = path ? 'at ' + path : 'at the top level';

    if (ta !== te) {
      return at + ': expected type ' + te + ', got type ' + ta;
    }
    if (ta === 'array') {
      if (actual.length !== expected.length) {
        return at + ': expected an array of length ' + expected.length +
          ', got length ' + actual.length;
      }
      for (let i = 0; i < expected.length; i++) {
        const sub = T._firstDiff(actual[i], expected[i], path + '[' + i + ']');
        if (sub) return sub;
      }
      return null;
    }
    if (ta === 'object') {
      const ke = Object.keys(expected).sort();
      const ka = Object.keys(actual).sort();
      const missing = ke.filter(k => ka.indexOf(k) === -1);
      const extra = ka.filter(k => ke.indexOf(k) === -1);
      if (missing.length) return at + ': missing key(s) ' + missing.join(', ');
      if (extra.length) return at + ': unexpected key(s) ' + extra.join(', ');
      for (let i = 0; i < ke.length; i++) {
        const sub = T._firstDiff(actual[ke[i]], expected[ke[i]], path + '.' + ke[i]);
        if (sub) return sub;
      }
      return null;
    }
    return at + ': expected ' + T._fmt(expected) + ', got ' + T._fmt(actual);
  },

  /** @private Stable, key-sorted, depth- and length-limited rendering. */
  _fmt(v) {
    return T._trunc(T._stable(v, 0), 400);
  },

  /** @private */
  _stable(v, depth) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'string') return JSON.stringify(v);
    if (t === 'function') return 'function ' + (v.name || '<anonymous>');
    if (v instanceof Date) return 'Date(' + v.toISOString() + ')';
    if (depth > 6) return '<deeper than 6 levels>';
    if (Array.isArray(v)) {
      return '[' + v.map(x => T._stable(x, depth + 1)).join(', ') + ']';
    }
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => k + ': ' + T._stable(v[k], depth + 1)).join(', ') + '}';
  },

  /** @private */
  _trunc(s, max) {
    return s.length <= max ? s : s.slice(0, max) + '… (' + s.length + ' chars)';
  },

  /** @private Renders a thrown value, including an AppError's .code. */
  _errText(e) {
    if (e === null || e === undefined) return String(e);
    if (typeof e !== 'object') return String(e);
    const code = e.code ? '[' + e.code + '] ' : '';
    const msg = e.message !== undefined ? e.message : T._fmt(e);
    return code + msg;
  },

  /** @private console.log is what shows up in the Apps Script execution log. */
  _log(line) {
    console.log(line);
  },

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Removes everything the fixtures created. Runs from a `finally`, so it must
   * survive a half-built world: every step is individually try/caught and a
   * failure is logged, never thrown.
   *
   * Rows are deleted bottom-up, because Repo.deleteRow shifts every row below it.
   */
  cleanup() {
    const notes = [];

    // --- Drive ids that only exist on a sheet row -----------------------------
    // Must happen BEFORE the rows are purged: a tournament's folder id, a player's
    // photo id and a payment's screenshot id are only discoverable from the row
    // that is about to be deleted.
    T._collectDriveFixtures(notes);

    // --- Sheet rows -----------------------------------------------------------
    // Collect fixture user ids first: Sessions rows are found by user_id, and the
    // Users rows themselves are gone by the time we would need them.
    const fixtureUserIds = {};
    T._state.userIds.forEach(id => { fixtureUserIds[id] = true; });
    try {
      Repo.readAll(SHEETS.USERS).forEach(u => {
        if (T._isFixtureEmail(u.email) || T._isFixtureTid(u.tournament_id)) {
          fixtureUserIds[u.user_id] = true;
        }
      });
    } catch (e) {
      notes.push('could not scan Users: ' + T._errText(e));
    }

    T._purge(SHEETS.SESSIONS, r =>
      fixtureUserIds[r.user_id] === true || T._isFixtureTid(r.tournament_id), notes);
    T._purge(SHEETS.AUDIT_LOG, r =>
      T._isFixtureTid(r.tournament_id) || fixtureUserIds[r.actor_user_id] === true, notes);
    T._purge(SHEETS.AUCTION_RESULTS, r => T._isFixtureTid(r.tournament_id), notes);
    T._purge(SHEETS.PAYMENTS, r => T._isFixtureTid(r.tournament_id), notes);
    T._purge(SHEETS.PLAYERS, r => T._isFixtureTid(r.tournament_id), notes);
    T._purge(SHEETS.TEAMS, r => T._isFixtureTid(r.tournament_id), notes);
    T._purge(SHEETS.USERS, r =>
      T._isFixtureEmail(r.email) || T._isFixtureTid(r.tournament_id), notes);
    T._purge(SHEETS.TOURNAMENTS, r => T._isFixtureTid(r.tournament_id), notes);

    // --- Login-failure counters ----------------------------------------------
    // Auth tracks these in CacheService (CONTRACTS.md §7.5). Left behind, a fixture
    // email could start the next run already locked out.
    T._state.emails.forEach(email => {
      try { Cache.del('login_fail:' + email); } catch (e) { /* best effort */ }
    });

    // --- Cache and version counters ------------------------------------------
    // Version counters live in ScriptProperties (CONTRACTS.md §8.1) and Cache
    // deliberately has no "delete the version" API — invalidate() must leave it
    // alone. So the cleanup reaches past Cache to the durable store directly.
    T._state.cacheTids.forEach(tid => {
      try { Cache.invalidate(tid); } catch (e) { /* best effort */ }
      // Auction.gs owns this key and offers no API to clear it. Left behind, the
      // next run's projector would open on a player from this one.
      try { Cache.del(AUCTION_CURRENT_PREFIX + tid); } catch (e) { /* best effort */ }
    });
    T._state.cacheKeys.forEach(key => {
      try { Cache.del(key); } catch (e) { /* best effort */ }
    });
    try {
      const props = PropertiesService.getScriptProperties();
      const all = props.getProperties();
      Object.keys(all).forEach(k => {
        if (k.indexOf('v:' + TEST_FIXTURES.TID_PREFIX) === 0 || k.indexOf('v:TRN_zz') === 0) {
          props.deleteProperty(k);
        }
      });
      // Tournaments created by tournament.create carry a normal random id, so the
      // "zz" prefix scan above cannot see them. Delete those counters by name.
      T._state.tids.forEach(tid => {
        try { props.deleteProperty('v:' + tid); } catch (e) { /* best effort */ }
      });
    } catch (e) {
      notes.push('could not purge version counters: ' + T._errText(e));
    }

    // --- Drive ----------------------------------------------------------------
    T._trashDriveFixtures(notes);

    if (notes.length) {
      T._log('CLEANUP WARNINGS:');
      notes.forEach(n => T._log('  - ' + n));
    }
  },

  /**
   * @private Walks the fixture rows and registers every Drive id they point at,
   * so files and folders created through `tournament.create` / `player.register`
   * are trashed even though no test ever saw the raw id.
   *
   * Every step is individually guarded: this runs from cleanup(), which runs from
   * a `finally`, so it must survive a half-built world without throwing.
   */
  _collectDriveFixtures(notes) {
    // Player photos and payment screenshots first, then the tournament root
    // folders, so children are registered before their parent (the order
    // _trashDriveFixtures relies on).
    try {
      Repo.readAll(SHEETS.PLAYERS).forEach(p => {
        if (T._isFixtureTid(p.tournament_id)) T.trackDrive(p.photo_file_id, 'file');
      });
    } catch (e) {
      notes.push('could not scan Players for Drive ids: ' + T._errText(e));
    }
    try {
      Repo.readAll(SHEETS.PAYMENTS).forEach(p => {
        if (T._isFixtureTid(p.tournament_id)) T.trackDrive(p.screenshot_file_id, 'file');
      });
    } catch (e) {
      notes.push('could not scan Payments for Drive ids: ' + T._errText(e));
    }
    try {
      Repo.readAll(SHEETS.TOURNAMENTS).forEach(t => {
        if (!T._isFixtureTid(t.tournament_id)) return;
        T.trackDrive(t.logo_file_id, 'file');
        T.trackDrive(t.qr_file_id, 'file');
        const gallery = Util.safeJsonParse(t.photo_file_ids, []);
        if (Array.isArray(gallery)) gallery.forEach(id => T.trackDrive(id, 'file'));
        // The tournament root goes last: trashing it takes public/, private/ and
        // everything under them with it.
        T.trackDrive(t.drive_folder_id, 'folder');
      });
    } catch (e) {
      notes.push('could not scan Tournaments for Drive ids: ' + T._errText(e));
    }
  },

  /** @private */
  _isFixtureTid(v) {
    if (typeof v !== 'string' || !v) return false;
    if (v.indexOf(TEST_FIXTURES.TID_PREFIX) === 0) return true;
    // Tournaments minted by tournament.create get a normal random id and are
    // registered explicitly by T.trackTid.
    return T._state.tids.indexOf(v) !== -1;
  },

  /** @private */
  _isFixtureEmail(v) {
    return typeof v === 'string' &&
      v.toLowerCase().indexOf(TEST_FIXTURES.EMAIL_DOMAIN) ===
      v.length - TEST_FIXTURES.EMAIL_DOMAIN.length &&
      v.length > TEST_FIXTURES.EMAIL_DOMAIN.length;
  },

  /** @private Deletes matching rows bottom-up so _row numbers stay valid. */
  _purge(tab, predicate, notes) {
    try {
      const rows = Repo.readAll(tab).filter(r => r && predicate(r));
      rows.map(r => r._row)
        .filter(n => typeof n === 'number' && n > 1)
        .sort((a, b) => b - a)
        .forEach(n => Repo.deleteRow(tab, n));
    } catch (e) {
      notes.push('could not purge ' + tab + ': ' + T._errText(e));
    }
  },

  /**
   * @private Trashes folders and files the Drive suite created. Guards the shared
   * "CricketAuction" root explicitly — trashing that would take every tournament's
   * images with it.
   */
  _trashDriveFixtures(notes) {
    if (!T._state.driveIds.length) return;
    let protectedRoot = null;
    try { protectedRoot = Drive.ensureRootFolder(); } catch (e) { /* ignore */ }

    // Files first, then folders in the order they were registered (children before
    // their parent), so nothing is ever addressed after its container is gone.
    const files = T._state.driveIds.filter(d => d && d.kind === 'file');
    const folders = T._state.driveIds.filter(d => d && d.kind === 'folder');
    files.concat(folders).forEach(item => {
      try {
        if (!item || !item.id) return;
        if (protectedRoot && item.id === protectedRoot) {
          notes.push('refused to trash the shared CricketAuction root folder');
          return;
        }
        if (item.kind === 'folder') {
          const f = DriveApp.getFolderById(item.id);
          if (!f.isTrashed()) f.setTrashed(true);
        } else {
          const f = DriveApp.getFileById(item.id);
          // A player photo inside an already-trashed tournament folder is the
          // common case; skipping it keeps the warning list meaningful.
          if (!f.isTrashed()) f.setTrashed(true);
        }
      } catch (e) {
        // Already gone as part of a parent folder is the other common case here.
        notes.push('could not trash Drive ' + item.kind + ' ' + item.id + ': ' + T._errText(e));
      }
    });
  },

  // ---------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------

  /**
   * Logs the summary and returns it, so the editor's return-value pane shows
   * something useful too.
   * @return {!Object}
   */
  report() {
    const res = T._state.results;
    const elapsed = Date.now() - T._state.startedAt;
    const passed = res.filter(r => r.ok).length;
    const failed = res.length - passed;

    T._log('');
    T._log('==================================================================');
    T._log('  CRICKET AUCTION — TEST RUN');
    T._log('==================================================================');
    T._log('  total ' + res.length + '   passed ' + passed + '   failed ' + failed +
      '   elapsed ' + elapsed + ' ms');
    T._log('------------------------------------------------------------------');

    // Per-suite tally, in registration order.
    const order = [];
    const tally = {};
    res.forEach(r => {
      if (!tally[r.suite]) { tally[r.suite] = { pass: 0, fail: 0, ms: 0 }; order.push(r.suite); }
      tally[r.suite][r.ok ? 'pass' : 'fail']++;
      tally[r.suite].ms += r.ms;
    });
    order.forEach(name => {
      const t = tally[name];
      T._log('  ' + (t.fail === 0 ? 'PASS' : 'FAIL') + '  ' + T._pad(name, 12) +
        '  ' + t.pass + '/' + (t.pass + t.fail) + ' passed  (' + t.ms + ' ms)');
    });

    if (failed === 0) {
      T._log('------------------------------------------------------------------');
      T._log('  ALL GREEN');
      T._log('==================================================================');
    } else {
      T._log('------------------------------------------------------------------');
      T._log('  ' + failed + ' FAILURE' + (failed === 1 ? '' : 'S'));
      T._log('------------------------------------------------------------------');
      let n = 0;
      res.filter(r => !r.ok).forEach(r => {
        n++;
        T._log('  ' + n + ') ' + r.suite + ' > ' + r.test);
        String(r.message).split('\n').forEach(line => T._log('     ' + line));
      });
      T._log('==================================================================');
    }

    return {
      total: res.length,
      passed: passed,
      failed: failed,
      elapsedMs: elapsed,
      failures: res.filter(r => !r.ok)
        .map(r => ({ suite: r.suite, test: r.test, message: r.message }))
    };
  },

  /** @private */
  _pad(s, n) {
    let out = String(s);
    while (out.length < n) out += ' ';
    return out;
  }
};


/**
 * Suite definitions and their fixtures.
 *
 * `Suites.defineAll()` registers every suite with T. Suites are registered, not
 * run, at definition time — the runner decides what actually executes.
 */
const Suites = {

  /** Registers every suite, in run order. */
  defineAll() {
    Suites.util();
    Suites.ist();
    Suites.tournament();
    Suites.registration();
    Suites.playerList();
    Suites.paymentVerify();
    Suites.organiser();
    Suites.teams();
    Suites.auction();
    Suites.reports();
    Suites.repo();
    Suites.auth();
    Suites.cache();
    Suites.drive();
  },

  /** @return {!Array<string>} the names, for the "unknown suite" error message. */
  names() {
    return ['Util', 'IST', 'Tournament', 'Registration', 'PlayerList', 'PaymentVerify',
      'Organiser', 'Teams', 'Auction', 'Reports',
      'Repo', 'Auth', 'Cache', 'Drive'];
  },

  // ===========================================================================
  // IST
  //
  // Instants are UTC; calendar dates are IST (CONTRACTS.md §6a). The bug this
  // suite exists to prevent: a registration deadline of "2026-08-31" compared
  // as UTC closes at 05:30 IST on the 31st, silently losing most of the final
  // day. Nothing errors — players just see "Registration Closed".
  // ===========================================================================

  ist() {
    T.suite('IST', function () {

      T.test('IST is a fixed +05:30 with no daylight saving', function () {
        T.assertEqual(Util.IST_OFFSET_MIN, 330, 'India has never observed DST');
      });

      T.test('istDayStartUtc maps IST midnight to the previous UTC evening', function () {
        T.assertEqual(Util.istDayStartUtc('2026-08-31'), '2026-08-30T18:30:00.000Z',
          '00:00 IST on 31 Aug is 18:30Z on 30 Aug');
      });

      T.test('istDayEndUtc closes at the last millisecond of the IST day', function () {
        T.assertEqual(Util.istDayEndUtc('2026-08-31'), '2026-08-31T18:29:59.999Z',
          '23:59:59.999 IST on 31 Aug is 18:29:59.999Z the same day');
      });

      T.test('istDate resolves an instant to the IST calendar day', function () {
        T.assertEqual(Util.istDate('2026-08-30T19:00:00.000Z'), '2026-08-31',
          '00:30 IST on the 31st, even though UTC still says the 30th');
        T.assertEqual(Util.istDate('2026-08-30T18:29:00.000Z'), '2026-08-30',
          'one minute before IST midnight is still the 30th');
        T.assertEqual(Util.istDate('2026-08-30T18:30:00.000Z'), '2026-08-31',
          'the boundary instant itself belongs to the new IST day');
      });

      T.test('REGRESSION: 3am IST on the closing day keeps registration OPEN', function () {
        // This is the exact case that was broken. 03:00 IST on 31 Aug is
        // 21:30Z on 30 Aug, so a naive UTC comparison called it "the 30th"
        // and a deadline of the 31st had not started yet.
        T.assert(Util.isWithinWindow('2026-08-01', '2026-08-31', '2026-08-30T21:30:00.000Z'),
          'a player registering at 3am IST on the deadline day must get through');
      });

      T.test('REGRESSION: 11pm IST on the closing day keeps registration OPEN', function () {
        // The other half of the bug: UTC midnight on the 31st arrives at
        // 05:30 IST, so the whole working day was treated as past the deadline.
        T.assert(Util.isWithinWindow('2026-08-01', '2026-08-31', '2026-08-31T17:30:00.000Z'),
          '11pm IST on the deadline day must still be open');
      });

      T.test('the window closes exactly at IST midnight, not before or after', function () {
        T.assert(Util.isWithinWindow('2026-08-01', '2026-08-31', '2026-08-31T18:29:59.000Z'),
          'one second before IST midnight is open');
        T.assert(!Util.isWithinWindow('2026-08-01', '2026-08-31', '2026-08-31T18:30:01.000Z'),
          'one second after IST midnight is closed');
      });

      T.test('the window opens at IST midnight on the start date', function () {
        T.assert(!Util.isWithinWindow('2026-08-01', '2026-08-31', '2026-07-31T18:29:00.000Z'),
          'before 00:00 IST on 1 Aug is too early');
        T.assert(Util.isWithinWindow('2026-08-01', '2026-08-31', '2026-07-31T18:30:00.000Z'),
          '00:00 IST on 1 Aug is open');
      });

      T.test('a blank bound means unbounded on that side', function () {
        T.assert(Util.isWithinWindow('', '2026-08-31', '2020-01-01T00:00:00.000Z'),
          'no start date means no lower bound');
        T.assert(Util.isWithinWindow('2026-08-01', '', '2099-01-01T00:00:00.000Z'),
          'no end date means no upper bound');
      });

      T.test('full instants are used as given, not widened to whole days', function () {
        T.assert(Util.isWithinWindow('2026-08-01T00:00:00.000Z', '2026-08-01T12:00:00.000Z',
          '2026-08-01T06:00:00.000Z'), 'inside an explicit instant range');
        T.assert(!Util.isWithinWindow('2026-08-01T00:00:00.000Z', '2026-08-01T12:00:00.000Z',
          '2026-08-01T13:00:00.000Z'), 'outside an explicit instant range');
      });

      T.test('a malformed date is rejected rather than silently treated as epoch', function () {
        T.assertThrows(function () { Util.istDayStartUtc('31-08-2026'); },
          ERR.VALIDATION_FAILED, 'dd-mm-yyyy is not accepted');
        T.assertThrows(function () { Util.istDayEndUtc('2026-02-30'); },
          ERR.VALIDATION_FAILED, 'an impossible day must not roll into March');
      });

      T.test('formatIST renders IST wall-clock time for humans', function () {
        T.assertEqual(Util.formatIST('2026-08-31T05:12:00.000Z'), '31 Aug 2026, 10:42 AM',
          '05:12Z is 10:42 IST');
        T.assertEqual(Util.formatIST('2026-08-30T18:30:00.000Z'), '31 Aug 2026, 12:00 AM',
          'IST midnight renders as 12:00 AM on the new day');
        T.assertEqual(Util.formatIST('2026-08-31T06:30:00.000Z'), '31 Aug 2026, 12:00 PM',
          'IST noon renders as 12:00 PM, not 0:00 PM');
        T.assertEqual(Util.formatIST('2026-08-31T05:12:00.000Z', false), '31 Aug 2026',
          'time can be suppressed');
        T.assertEqual(Util.formatIST('not a date'), '',
          'a display helper returns empty rather than throwing');
      });

      T.test('todayIso follows the Indian calendar day', function () {
        const t = Util.todayIso();
        T.assertEqual(t.length, 10, 'date part only');
        T.assertEqual(t, Util.istDate(Util.nowIso()), 'todayIso is the IST date of now');
      });

      T.test('nowIso stays UTC — instants must not drift into local time', function () {
        const n = Util.nowIso();
        T.assert(/Z$/.test(n), 'instants are stored with a Z suffix');
        T.assert(Math.abs(Date.parse(n) - new Date().getTime()) < 5000,
          'nowIso is the real UTC instant, not shifted by the IST offset');
      });
    });
  },

  // ===========================================================================
  // Tournament — CONTRACTS-PHASE1.md §2
  //
  // Every action is reached through buildRoutes(), not through the module object
  // directly. The action NAMES are pinned by the contract; the internal function
  // names are not, so going through the route table is the only way to test the
  // thing that was actually agreed. It also lets each test assert the route's
  // declared auth level, which is where the authorisation contract lives.
  // ===========================================================================

  tournament() {
    T.suite('Tournament', function () {
      const session = Suites._adminSession('trnadmin');

      // Fixtures are built lazily and memoised. If tournament.create is missing or
      // broken, that shows up as a failure in each test that needs it rather than
      // as one "<suite body>" failure that hides the other ten.
      const fx = {};

      /** The one tournament created with real logo/QR/gallery images. */
      function mainTournament() {
        if (!fx.main) {
          fx.main = Suites._createTournament(session, 'main', {
            logo: Suites._imageField('png', 'zz-logo.png'),
            qr: Suites._imageField('png', 'zz-qr.png'),          // QR stays PNG (§1)
            gallery: [Suites._imageField('jpeg', 'zz-gallery-1.jpg')]
          });
        }
        return fx.main;
      }

      /** The row behind mainTournament(), for the fields getPublic must not leak. */
      function mainRow() {
        const t = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', mainTournament().tournament_id);
        T.assert(t !== null, 'tournament.create returned an id with no Tournaments row behind it');
        return t;
      }

      // -----------------------------------------------------------------------
      // Routing
      // -----------------------------------------------------------------------

      T.test('every Phase 1 tournament action is registered with the right exposure',
        function () {
          // CONTRACTS-PHASE1.md §2 pins the action names, the HTTP verbs and who may
          // call them. It does NOT pin how a route spells "ADMIN only" (Code.gs
          // accepts a role array or the string 'ANY'), so the auth assertion checks
          // the meaning via Suites._authAllows rather than a literal.
          const create = Suites._route('tournament.create');
          T.assert(create.methods.indexOf('POST') !== -1, 'tournament.create must accept POST');
          T.assert(create.methods.indexOf('GET') === -1,
            'tournament.create must NOT be reachable over GET — a GET route is callable ' +
            'from a link, with no token');
          T.assert(create.auth !== 'PUBLIC', 'tournament.create must not be PUBLIC');
          T.assert(Suites._authAllows(create.auth, ENUM.USER_ROLE.ADMIN),
            'tournament.create must allow ADMIN, got auth = ' + T._fmt(create.auth));

          ['tournament.update', 'tournament.list', 'tournament.setStatus'].forEach(name => {
            const r = Suites._route(name);
            T.assert(r.methods.indexOf('POST') !== -1, name + ' must accept POST');
            T.assert(r.auth !== 'PUBLIC', name + ' must not be PUBLIC');
            T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN),
              name + ' must allow ADMIN, got auth = ' + T._fmt(r.auth));
          });

          const get = Suites._route('tournament.get');
          T.assert(get.auth !== 'PUBLIC',
            'tournament.get returns the full row and must never be PUBLIC — that is ' +
            'what tournament.getPublic exists for');

          const pub = Suites._route('tournament.getPublic');
          T.assertEqual(pub.auth, 'PUBLIC', 'tournament.getPublic is the public landing page');
          T.assert(pub.methods.indexOf('GET') !== -1, 'getPublic must accept GET');
          T.assert(pub.methods.indexOf('POST') !== -1, 'getPublic must accept POST');
        });

      // -----------------------------------------------------------------------
      // create
      // -----------------------------------------------------------------------

      T.test('create returns a tournament id, a slug, DRAFT status and a registration URL',
        function () {
          const out = mainTournament();
          T.assert(out && typeof out === 'object', 'create must return an object');

          T.assertEqual(out.tournament_id.slice(0, ID_PREFIX.TOURNAMENT.length),
            ID_PREFIX.TOURNAMENT, 'tournament_id prefix (CONTRACTS.md §4)');
          T.assertEqual(out.tournament_id.length, ID_PREFIX.TOURNAMENT.length + 12,
            'tournament_id is the prefix plus 12 chars, got "' + out.tournament_id + '"');

          T.assert(typeof out.slug === 'string' && out.slug.length > 0, 'slug must be present');
          T.assert(/^[a-z0-9-]+$/.test(out.slug),
            'the slug goes into a URL and a Drive folder name: "' + out.slug + '"');

          T.assertEqual(out.status, ENUM.TOURNAMENT_STATUS.DRAFT,
            'a new tournament starts in DRAFT — registration is opened deliberately');

          // CONTRACTS does not pin the URL base (it is per-deployment), so assert the
          // shape: a non-empty string that carries the id the player needs.
          T.assert(typeof out.registrationUrl === 'string' && out.registrationUrl.length > 0,
            'registrationUrl must be present, got ' + T._fmt(out.registrationUrl));
          T.assert(out.registrationUrl.indexOf(out.tournament_id) !== -1,
            'registrationUrl must carry the tournament id, got ' + T._fmt(out.registrationUrl));
          T.assert(typeof out.displayUrl === 'string' && out.displayUrl.length > 0,
            'displayUrl must be present, got ' + T._fmt(out.displayUrl));
          T.assert(out.displayUrl !== out.registrationUrl,
            'the projector URL and the registration URL are different pages');
        });

      T.test('create sets next_serial to 1 and generates a display_token', function () {
        const row = mainRow();
        T.assertEqual(row.next_serial, 1,
          'the first player must be serial 1; anything else means the counter was ' +
          'never initialised and Repo.nextSerial will start from a stale value');
        T.assertEqual(typeof row.next_serial, 'number', 'next_serial is a number');

        T.assert(!Util.isBlank(row.display_token),
          'a projector URL cannot be issued without a display_token');
        T.assert(typeof row.display_token === 'string', 'display_token must be a string');
        T.assert(row.display_token !== row.tournament_id,
          'the display token must not just be the tournament id — the id is public');
        // CONTRACTS does not pin the token length or alphabet, only that one exists,
        // so this asserts "long enough not to be guessable" and nothing more.
        T.assert(String(row.display_token).length >= 16,
          'display_token looks too short to be a token: ' + T._fmt(row.display_token));

        T.assertEqual(row.status, ENUM.TOURNAMENT_STATUS.DRAFT, 'the stored status is DRAFT');
        T.assert(!isNaN(Date.parse(row.created_at)),
          'created_at must be a parseable instant, got ' + T._fmt(row.created_at));
        T.assert(!Util.isBlank(row.drive_folder_id),
          'create must build the Drive folder tree and store its root id');
      });

      T.test('create rejects every field the contract says it must', function () {
        // CONTRACTS-PHASE1.md §2: name 3-80, regStart <= regEnd, regFee >= 0,
        // defaultMaxPlayers >= 1, upiId matches something@something,
        // contactMobile passes Util.isValidMobileIN.
        const before = Repo.count(SHEETS.TOURNAMENTS, {});

        const reject = (tag, overrides, why) => {
          T.assertThrows(
            () => Suites._call('tournament.create', Suites._createPayload(tag, overrides), session),
            ERR.VALIDATION_FAILED, why);
        };

        reject('short', { name: 'ZZ' }, 'a 2-character name is under the 3-char minimum');
        reject('order', { regStart: '2026-08-31', regEnd: '2026-08-01' },
          'regStart after regEnd is a window that can never open');
        reject('fee', { regFee: -1 }, 'a negative registration fee');
        reject('maxp', { defaultMaxPlayers: 0 },
          'defaultMaxPlayers must be at least 1 — 0 pre-fills every team as already full');
        reject('upi', { upiId: 'notaupiid' },
          'a UPI id with no @ cannot be paid to, and it is printed on the QR page');
        reject('mobile', { contactMobile: '12345' },
          'contactMobile must pass Util.isValidMobileIN');

        T.assertEqual(Repo.count(SHEETS.TOURNAMENTS, {}), before,
          'a rejected create must leave no row behind — validation runs before any ' +
          'write (CONTRACTS-PHASE1.md §2)');

        // If it DID leave one behind, the assertion above has already failed; make
        // sure cleanup can still find the debris rather than leaving it on the sheet.
        // Every fixture tournament name in this file starts "ZZ".
        Repo.readAll(SHEETS.TOURNAMENTS).forEach(r => {
          if (typeof r.name === 'string' && r.name.indexOf('ZZ') === 0) {
            T.trackTid(r.tournament_id);
          }
        });
      });

      T.test('two tournaments with the same name get two distinct slugs', function () {
        // A slug is part of the registration URL and of the Drive folder name. Two
        // tournaments sharing one would send half the registrations to the wrong
        // event. CONTRACTS does not pin the disambiguation scheme (a "-2" suffix and
        // a random suffix are both fine), so this asserts distinctness and shape.
        const name = 'ZZ Test Collision Cup';
        const a = Suites._createTournament(session, 'cola', { name: name });
        const b = Suites._createTournament(session, 'colb', { name: name });

        T.assert(a.slug !== b.slug,
          'both tournaments got the slug "' + a.slug + '" — the second registration ' +
          'link would point at the first tournament');
        T.assert(a.tournament_id !== b.tournament_id, 'and the ids must differ too');
        [a.slug, b.slug].forEach(s => {
          T.assert(/^[a-z0-9-]+$/.test(s), 'slug "' + s + '" is not URL-safe');
          T.assert(s.charAt(0) !== '-' && s.charAt(s.length - 1) !== '-',
            'slug "' + s + '" has a leading or trailing hyphen');
        });
      });

      // -----------------------------------------------------------------------
      // getPublic — the DESIGN.md §46 security boundary
      // -----------------------------------------------------------------------

      T.test('getPublic returns ONLY the allow-listed fields', function () {
        // THE MOST IMPORTANT TEST IN THIS SUITE.
        //
        // getPublic is called by an anonymous browser. DESIGN.md §46 and §16 risk #4
        // make it an allow-list built field by field: never the sheet row with keys
        // deleted, because the next column added to the Tournaments tab would then
        // leak by default.
        //
        // The key comparison below is EXACT and copied verbatim from
        // CONTRACTS-PHASE1.md §2. That is deliberate: adding a field to the response
        // must fail this test and force a contract change, not sail through.
        const allowed = [
          'tournament_id', 'name', 'description', 'rules',
          'reg_fee', 'reg_fee_display',
          'logo_url', 'qr_url', 'qr_download_url',
          'gallery_urls',
          'upi_id', 'contact_name', 'contact_mobile',
          'reg_start', 'reg_end',
          'reg_start_display', 'reg_end_display',
          'registration_open', 'registration_message'
        ];

        const row = mainRow();
        const out = Suites._call('tournament.getPublic', { tournamentId: row.tournament_id }, null);
        T.assert(out && typeof out === 'object', 'getPublic must return an object');

        T.assertEqual(Object.keys(out).sort(), allowed.slice().sort(),
          'the getPublic response must be EXACTLY the allow-list in ' +
          'CONTRACTS-PHASE1.md §2. An extra key here is a data leak to an anonymous ' +
          'caller; a missing key breaks the registration page.');

        // Named explicitly as well, so a failure says what leaked rather than just
        // "one extra key". These are the fields DESIGN.md §46 calls out by name.
        const forbidden = [
          'drive_folder_id', 'display_token', 'next_serial', 'created_by',
          'contact_email', 'created_at', 'status', 'slug',
          'logo_file_id', 'qr_file_id', 'photo_file_ids',
          'default_purse', 'default_max_players', 'start_date', 'end_date', '_row',
          'players', 'player_count', 'player_list', 'verified_count', 'serial_no',
          'next_serial_no', 'mobile', 'sheet_id', 'spreadsheet_id'
        ];
        const keys = Object.keys(out);
        forbidden.forEach(k => {
          T.assert(keys.indexOf(k) === -1,
            'getPublic leaked the key "' + k + '". Keys present: ' + keys.join(', '));
        });
        keys.forEach(k => {
          T.assert(k.toLowerCase().indexOf('player') === -1,
            'getPublic must never carry player data or a player count: key "' + k + '"');
        });

        // Key names are only half of it: a value could be nested inside an allowed
        // key. Scan the serialised response for the actual secrets.
        const wire = JSON.stringify(out);
        [['display_token', row.display_token],
         ['drive_folder_id', row.drive_folder_id],
         ['contact_email', row.contact_email],
         ['created_by', row.created_by]].forEach(pair => {
          if (Util.isBlank(pair[1])) return;
          T.assert(wire.indexOf(String(pair[1])) === -1,
            'the value of ' + pair[0] + ' appears somewhere inside the getPublic ' +
            'response, even though the key does not');
        });

        // And the fields the registration page actually needs are right.
        T.assertEqual(out.tournament_id, row.tournament_id, 'tournament_id echoed');
        T.assertEqual(out.reg_fee, row.reg_fee, 'reg_fee is the raw integer');
        T.assertEqual(out.reg_fee_display, Util.formatINR(row.reg_fee),
          'reg_fee_display is the ₹-formatted form of the same number');
        T.assert(Array.isArray(out.gallery_urls), 'gallery_urls must be an array');
        T.assertEqual(typeof out.registration_open, 'boolean',
          'registration_open must be a real boolean, not the string "FALSE"');
        T.assertEqual(typeof out.registration_message, 'string',
          'registration_message must always be a string, "" when open');
      });

      T.test('getPublic registration_open follows the IST window, not the clock', function () {
        // Driven with explicit instants, never the real clock: the window boundaries
        // are IST day boundaries (CONTRACTS.md §6a) and a test that just uses "now"
        // passes at any hour whether or not the code is right.
        const t = Suites._seedTournament('pubwin', {
          status: ENUM.TOURNAMENT_STATUS.REG_OPEN,
          reg_start: '2026-08-01', reg_end: '2026-08-31',
          withFolders: false
        });
        const get = () => Suites._call('tournament.getPublic', { tournamentId: t.tid }, null);

        Suites._withFakeNow('2026-07-20T06:00:00.000Z', function () {
          T.assertEqual(get().registration_open, false, 'eleven days before the window opens');
        });
        Suites._withFakeNow('2026-08-15T06:00:00.000Z', function () {
          T.assertEqual(get().registration_open, true, 'the middle of the window');
        });
        Suites._withFakeNow('2026-09-05T06:00:00.000Z', function () {
          T.assertEqual(get().registration_open, false, 'five days after the window closed');
        });

        // The IST edges, which is where a UTC comparison goes wrong.
        Suites._withFakeNow('2026-07-31T18:30:00.000Z', function () {
          T.assertEqual(get().registration_open, true,
            '00:00 IST on 1 Aug is the first open instant');
        });
        Suites._withFakeNow('2026-08-31T18:29:59.000Z', function () {
          T.assertEqual(get().registration_open, true,
            'one second before IST midnight on the closing day is still open');
        });
        Suites._withFakeNow('2026-08-31T18:30:01.000Z', function () {
          T.assertEqual(get().registration_open, false,
            'one second after IST midnight is closed');
        });
      });

      T.test('getPublic returns each of the three registration_message strings', function () {
        // The exact sentences are pinned by CONTRACTS-PHASE1.md §2 — they are shown
        // to a player, and the date inside them is Util.formatIST(..., false).
        const open = Suites._seedTournament('pubmsg', {
          status: ENUM.TOURNAMENT_STATUS.REG_OPEN,
          reg_start: '2026-08-01', reg_end: '2026-08-31',
          withFolders: false
        });
        const draft = Suites._seedTournament('pubdrf', {
          status: ENUM.TOURNAMENT_STATUS.DRAFT,
          reg_start: '2026-08-01', reg_end: '2026-08-31',
          withFolders: false
        });
        const get = (tid) => Suites._call('tournament.getPublic', { tournamentId: tid }, null);

        Suites._withFakeNow('2026-08-15T06:00:00.000Z', function () {
          const o = get(open.tid);
          T.assertEqual(o.registration_open, true, 'baseline: open');
          T.assertEqual(o.registration_message, '',
            'the message is empty while registration is open');
        });

        Suites._withFakeNow('2026-07-20T06:00:00.000Z', function () {
          T.assertEqual(get(open.tid).registration_message,
            'Registration has not opened yet. It opens on 1 Aug 2026.',
            'the "not yet" branch, with the start date formatted by Util.formatIST');
        });

        Suites._withFakeNow('2026-09-05T06:00:00.000Z', function () {
          T.assertEqual(get(open.tid).registration_message,
            'Registration closed on 31 Aug 2026.',
            'the "closed" branch, with the end date formatted by Util.formatIST');
        });

        Suites._withFakeNow('2026-08-15T06:00:00.000Z', function () {
          const d = get(draft.tid);
          T.assertEqual(d.registration_open, false,
            'registration_open needs status REG_OPEN as well as the window');
          T.assertEqual(d.registration_message,
            'Registration is not open for this tournament.',
            'the any-other-status branch, even though the window itself is open');
        });
      });

      T.test('getPublic on an unknown id gives NOT_FOUND and reveals nothing else',
        function () {
          // Two different unknown ids: one that looks like a real id and one that is
          // obvious rubbish. If the two answers differ, an anonymous caller can probe
          // the id format, and eventually the id space, from the outside.
          const wellFormedId = 'TRN_zzzzzzzzzzzz';
          const malformedId = 'not-a-tournament-id';

          const wellFormed = T.assertThrows(
            () => Suites._call('tournament.getPublic', { tournamentId: wellFormedId }, null),
            ERR.NOT_FOUND, 'a well-formed but unknown tournament id');

          const malformed = T.assertThrows(
            () => Suites._call('tournament.getPublic', { tournamentId: malformedId }, null),
            ERR.NOT_FOUND,
            'a malformed id must be NOT_FOUND too, not VALIDATION_FAILED — a ' +
            'different code tells the caller the id format was at least right');

          // Echoing the id back is fine (the frontend renders with textContent,
          // CONTRACTS-PHASE1.md §4 rule 1). Saying something DIFFERENT about a
          // well-formed id is not, so the two messages are compared with each id
          // blanked out of its own text.
          const template = (msg, id) => String(msg).split(id).join('<id>');
          T.assertEqual(template(malformed.message, malformedId),
            template(wellFormed.message, wellFormedId),
            'both failures must use the same sentence. A different wording for a ' +
            'well-formed id confirms the format and narrows the search.');
        });

      // -----------------------------------------------------------------------
      // setStatus
      // -----------------------------------------------------------------------

      T.test('setStatus allows every legal transition in the contract table', function () {
        const S = ENUM.TOURNAMENT_STATUS;
        const legal = [
          [S.DRAFT, S.REG_OPEN],
          [S.REG_OPEN, S.REG_CLOSED],
          [S.REG_CLOSED, S.REG_OPEN],          // reopening registration is allowed
          [S.REG_CLOSED, S.AUCTION_LIVE],
          [S.REG_OPEN, S.AUCTION_LIVE],        // allowed; warns that reg is still open
          [S.AUCTION_LIVE, S.AUCTION_CLOSED],
          [S.AUCTION_CLOSED, S.AUCTION_LIVE]   // ADMIN only, audited (DESIGN.md §44)
        ];
        const t = Suites._seedTournament('stsok', { withFolders: false });

        legal.forEach(pair => {
          Suites._forceStatus(t.tid, pair[0]);
          let threw = null;
          try {
            Suites._call('tournament.setStatus',
              { tournamentId: t.tid, status: pair[1] }, session);
          } catch (e) {
            threw = e;
          }
          T.assert(threw === null,
            pair[0] + ' -> ' + pair[1] + ' is legal (CONTRACTS-PHASE1.md §2) but was ' +
            'refused: ' + T._errText(threw));

          const after = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', t.tid);
          T.assertEqual(after.status, pair[1],
            pair[0] + ' -> ' + pair[1] + ' returned successfully but the row still ' +
            'says ' + after.status);
        });
      });

      T.test('setStatus rejects illegal transitions with VALIDATION_FAILED', function () {
        const S = ENUM.TOURNAMENT_STATUS;
        // Deliberately not tested: a same-state move (REG_OPEN -> REG_OPEN). The
        // table does not list it and "anything else" would make it illegal, but a
        // harmless no-op is a defensible reading and CONTRACTS does not settle it.
        const illegal = [
          [S.DRAFT, S.REG_CLOSED],
          [S.DRAFT, S.AUCTION_LIVE],
          [S.DRAFT, S.AUCTION_CLOSED],
          [S.REG_OPEN, S.DRAFT],
          [S.REG_CLOSED, S.DRAFT],
          [S.REG_CLOSED, S.AUCTION_CLOSED],
          [S.AUCTION_LIVE, S.DRAFT],
          [S.AUCTION_LIVE, S.REG_OPEN],
          [S.AUCTION_LIVE, S.REG_CLOSED],
          [S.AUCTION_CLOSED, S.DRAFT],
          [S.AUCTION_CLOSED, S.REG_OPEN],
          [S.AUCTION_CLOSED, S.REG_CLOSED]
        ];
        const t = Suites._seedTournament('stsbad', { withFolders: false });

        illegal.forEach(pair => {
          Suites._forceStatus(t.tid, pair[0]);
          const e = T.assertThrows(
            () => Suites._call('tournament.setStatus',
              { tournamentId: t.tid, status: pair[1] }, session),
            ERR.VALIDATION_FAILED, pair[0] + ' -> ' + pair[1] + ' must be refused');
          T.assert(String(e.message).indexOf(pair[0]) !== -1 &&
            String(e.message).indexOf(pair[1]) !== -1,
            'the message must name both states (CONTRACTS-PHASE1.md §2), got "' +
            e.message + '"');

          const after = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', t.tid);
          T.assertEqual(after.status, pair[0],
            'a refused transition must leave the status alone, but it became ' +
            after.status);
        });

        Suites._forceStatus(t.tid, S.DRAFT);
        T.assertThrows(
          () => Suites._call('tournament.setStatus',
            { tournamentId: t.tid, status: 'BANANA' }, session),
          ERR.VALIDATION_FAILED, 'a status that is not in the enum at all');
      });

      // -----------------------------------------------------------------------
      // list
      // -----------------------------------------------------------------------

      T.test('list computes player_count and verified_count per tournament', function () {
        // Tournament isolation (DESIGN.md §39): every row carries a tournament_id and
        // no count may ever spill across the boundary. Tournament A gets three
        // players of which two are VERIFIED; tournament B gets one, unverified.
        const a = Suites._seedTournament('lista', { withFolders: false });
        const b = Suites._seedTournament('listb', { withFolders: false });

        const addPlayer = (tid, name, paymentStatus) => {
          Repo.append(SHEETS.PLAYERS, {
            player_id: Util.uid(ID_PREFIX.PLAYER),
            tournament_id: tid,
            serial_no: Repo.count(SHEETS.PLAYERS, { tournament_id: tid }) + 1,
            name: name,
            role: ENUM.PLAYER_ROLE.BATSMAN,
            style: ENUM.PLAYER_STYLE.RIGHT,
            mobile: Suites._freshMobile(),
            payment_status: paymentStatus,
            auction_status: ENUM.AUCTION_STATUS.PENDING,
            times_called: 0,
            is_withdrawn: false,
            registered_at: Util.nowIso()
          });
        };
        addPlayer(a.tid, 'ZZ List A1', ENUM.PAYMENT_STATUS.VERIFIED);
        addPlayer(a.tid, 'ZZ List A2', ENUM.PAYMENT_STATUS.VERIFIED);
        addPlayer(a.tid, 'ZZ List A3', ENUM.PAYMENT_STATUS.PENDING);
        addPlayer(b.tid, 'ZZ List B1', ENUM.PAYMENT_STATUS.PENDING);

        const list = Suites._call('tournament.list', {}, session);
        T.assert(Array.isArray(list), 'tournament.list must return an array');

        const byId = {};
        list.forEach(r => { byId[r.tournament_id] = r; });
        const ra = byId[a.tid];
        const rb = byId[b.tid];
        T.assert(ra, 'tournament A is missing from the list');
        T.assert(rb, 'tournament B is missing from the list');

        T.assertEqual(ra.player_count, 3, 'tournament A has three players');
        T.assertEqual(ra.verified_count, 2, 'two of A\'s three payments are VERIFIED');
        T.assertEqual(rb.player_count, 1,
          'tournament B has exactly one player — a count of 4 means the pass over ' +
          'Players is not filtering by tournament_id (DESIGN.md §39)');
        T.assertEqual(rb.verified_count, 0, 'B has no verified payments');

        // The row shape is pinned by CONTRACTS-PHASE1.md §2.
        T.assertEqual(Object.keys(ra).sort(), [
          'created_at', 'name', 'player_count', 'reg_end', 'reg_fee', 'reg_start',
          'slug', 'status', 'tournament_id', 'verified_count'
        ], 'the admin list row must be exactly the contracted fields');
      });
    });
  },

  // ===========================================================================
  // Registration — CONTRACTS-PHASE1.md §2 (player.register, player.checkMobile)
  // and §3 (validation). Rationale: DESIGN.md §6.2, §9, §11, §16.
  //
  // These tests upload real images to Drive and write real Players and Payments
  // rows. Everything is scoped to fixture tournaments whose ids start with
  // TEST_FIXTURES.TID_PREFIX, and T.cleanup() removes the rows, the Drive files
  // and the tournament folders even when the suite fails.
  // ===========================================================================

  registration() {
    T.suite('Registration', function () {
      // Tournament ids owned by this suite, for the "no Players row without a
      // Payments row" invariant. Scoped, because the Repo suite deliberately
      // appends bare Players rows that have no payment behind them.
      const regTids = [];

      const fx = {};

      /** Always-open tournament. The window is deliberately wide so these tests
       *  do not depend on the day they are run. */
      function main() {
        if (!fx.main) {
          fx.main = Suites._seedTournament('regmain', {
            status: ENUM.TOURNAMENT_STATUS.REG_OPEN,
            reg_start: '2020-01-01', reg_end: '2099-12-31',
            start_date: '2026-09-05', end_date: '2026-09-20'
          });
          regTids.push(fx.main.tid);
        }
        return fx.main;
      }

      /** A second open tournament, to prove the serial counters are independent. */
      function other() {
        if (!fx.other) {
          fx.other = Suites._seedTournament('regoth', {
            status: ENUM.TOURNAMENT_STATUS.REG_OPEN,
            reg_start: '2020-01-01', reg_end: '2099-12-31',
            start_date: '2026-09-05', end_date: '2026-09-20'
          });
          regTids.push(fx.other.tid);
        }
        return fx.other;
      }

      /** Registration window 1-31 Aug 2026, for the IST boundary tests. */
      function windowed() {
        if (!fx.win) {
          fx.win = Suites._seedTournament('regwin', {
            status: ENUM.TOURNAMENT_STATUS.REG_OPEN,
            reg_start: '2026-08-01', reg_end: '2026-08-31',
            start_date: '2026-09-05', end_date: '2026-09-20'
          });
          regTids.push(fx.win.tid);
        }
        return fx.win;
      }

      // -----------------------------------------------------------------------
      // Routing
      // -----------------------------------------------------------------------

      T.test('player.register and player.checkMobile are PUBLIC POST routes', function () {
        const reg = Suites._route('player.register');
        T.assertEqual(reg.auth, 'PUBLIC', 'a player has no account and no token');
        T.assert(reg.methods.indexOf('POST') !== -1, 'player.register must accept POST');
        T.assert(reg.methods.indexOf('GET') === -1,
          'player.register writes rows and uploads images; a GET route would let it ' +
          'be triggered by a plain link');

        const check = Suites._route('player.checkMobile');
        T.assertEqual(check.auth, 'PUBLIC', 'the courtesy check runs before login');
        T.assert(check.methods.indexOf('POST') !== -1, 'player.checkMobile must accept POST');
        T.assert(check.methods.indexOf('GET') === -1,
          'GET would put a mobile number into browser history and server logs, and ' +
          'make enumeration a matter of pasting URLs');
      });

      // -----------------------------------------------------------------------
      // Serial allocation
      // -----------------------------------------------------------------------

      T.test('the first registration gets serial 1 and the second gets serial 2',
        function () {
          const t = main();
          const first = Suites._register(t.tid);
          T.assertEqual(first.serial_no, 1, 'the first player in a tournament is number 1');
          T.assertEqual(typeof first.serial_no, 'number', 'serial_no is a number');

          const second = Suites._register(t.tid);
          T.assertEqual(second.serial_no, 2, 'the second player is number 2');
          T.assert(first.player_id !== second.player_id, 'two distinct player ids');
          T.assertEqual(first.player_id.slice(0, ID_PREFIX.PLAYER.length), ID_PREFIX.PLAYER,
            'player_id prefix');

          // The response shape is pinned by CONTRACTS-PHASE1.md §2.
          T.assertEqual(Object.keys(second).sort(),
            ['name', 'player_id', 'registered_at_display', 'serial_no', 'tournament_name'],
            'player.register must return exactly the contracted fields');
          T.assertEqual(second.tournament_name, t.row.name, 'the tournament name is echoed');
          T.assert(!Util.isBlank(second.registered_at_display),
            'the confirmation screen prints registered_at_display');
        });

      T.test('serial numbers are per tournament — A and B both start at 1', function () {
        // DESIGN.md §39: every counter is scoped to a tournament. A shared counter
        // would give the second tournament's first player number 4, and every
        // printed sheet and projector card would be wrong.
        const a = main();
        const b = other();

        const firstInB = Suites._register(b.tid);
        T.assertEqual(firstInB.serial_no, 1,
          'the first player in tournament B must be number 1 regardless of how many ' +
          'players tournament A already has');

        const thirdInA = Suites._register(a.tid);
        T.assertEqual(thirdInA.serial_no, 3,
          'tournament A carries on from its own counter, unaffected by B');
      });

      T.test('a serial is never reused after a player is withdrawn', function () {
        // DESIGN.md §9 / schema §2.3: "Serial stays reserved". Reissuing it puts two
        // different people on the same number in the printed list and the auction
        // history, which cannot be untangled afterwards.
        const t = other();
        const withdrawn = Suites._register(t.tid);
        T.assertEqual(withdrawn.serial_no, 2, 'baseline: this is B\'s second player');

        // Phase 1 has no withdraw action (that is Phase 2), so the flag is set
        // directly. The point of the test is the counter, not the action.
        const row = Repo.findBy(SHEETS.PLAYERS, 'player_id', withdrawn.player_id);
        Repo.updateRow(SHEETS.PLAYERS, row._row, { is_withdrawn: true });

        const next = Suites._register(t.tid);
        T.assertEqual(next.serial_no, 3,
          'serial 2 belongs to the withdrawn player forever; the next registration ' +
          'must be 3, not a recycled 2');

        const stillThere = Repo.findBy(SHEETS.PLAYERS, 'player_id', withdrawn.player_id);
        T.assertEqual(stillThere.serial_no, 2,
          'the withdrawn player keeps their serial');
        T.assertEqual(stillThere.is_withdrawn, true, 'and stays flagged as withdrawn');
      });

      // -----------------------------------------------------------------------
      // What gets written
      // -----------------------------------------------------------------------

      T.test('the Players row is written with the contracted starting values', function () {
        const t = main();
        const out = Suites._register(t.tid, {
          name: 'ZZ Defaults Player',
          role: ENUM.PLAYER_ROLE.BOWLER,
          style: ENUM.PLAYER_STYLE.LEFT
        });
        const p = Repo.findBy(SHEETS.PLAYERS, 'player_id', out.player_id);
        T.assert(p !== null, 'register returned a player_id with no Players row behind it');

        T.assertEqual(p.payment_status, ENUM.PAYMENT_STATUS.PENDING,
          'nobody is verified at registration time (DESIGN.md §6.3)');
        T.assertEqual(p.auction_status, ENUM.AUCTION_STATUS.PENDING, 'auction_status');
        T.assertEqual(p.times_called, 0,
          'times_called must be the number 0, not blank — DESIGN.md §6.9 counts on it');
        T.assertEqual(typeof p.times_called, 'number', 'times_called is a number');
        T.assertEqual(p.is_withdrawn, false, 'is_withdrawn starts FALSE');
        T.assertEqual(typeof p.is_withdrawn, 'boolean',
          'a real boolean — the string "FALSE" is truthy and would hide the player');

        T.assertEqual(p.tournament_id, t.tid, 'the row is scoped to the tournament');
        T.assertEqual(p.name, 'ZZ Defaults Player', 'name');
        T.assertEqual(p.role, ENUM.PLAYER_ROLE.BOWLER, 'role');
        T.assertEqual(p.style, ENUM.PLAYER_STYLE.LEFT, 'style');
        T.assert(!Util.isBlank(p.photo_file_id), 'the profile photo must be stored');
        T.assert(!Util.isBlank(p.photo_thumb_url), 'the cached thumbnail URL must be stored');
        T.assert(String(p.photo_thumb_url).indexOf('drive.google.com/thumbnail') !== -1,
          'photo_thumb_url must be a Drive thumbnail URL (DESIGN.md §3), got ' +
          T._fmt(p.photo_thumb_url));
        T.assert(!isNaN(Date.parse(p.registered_at)),
          'registered_at must be a parseable UTC instant, got ' + T._fmt(p.registered_at));
        T.assert(Util.isBlank(p.team_id), 'no team until the auction');
        T.assertEqual(p.sold_amount, null, 'not sold, so sold_amount is empty, not 0');
      });

      T.test('every Players row has a matching PENDING Payments row', function () {
        const t = main();
        const out = Suites._register(t.tid, { upiRef: 'ZZPAYREF' + T.nextSeq() });
        const p = Repo.findBy(SHEETS.PLAYERS, 'player_id', out.player_id);
        const pay = Repo.findBy(SHEETS.PAYMENTS, 'player_id', out.player_id);

        T.assert(pay !== null,
          'a Players row with no Payments row shows up in the admin queue as ' +
          'permanently unverifiable (CONTRACTS-PHASE1.md §2)');
        T.assertEqual(pay.player_id, p.player_id, 'the payment points at the player');
        T.assertEqual(pay.tournament_id, t.tid, 'and carries the tournament id');
        T.assertEqual(pay.status, ENUM.PAYMENT_STATUS.PENDING, 'payments start PENDING');
        T.assertEqual(pay.payment_id.slice(0, ID_PREFIX.PAYMENT.length), ID_PREFIX.PAYMENT,
          'payment_id prefix');
        T.assertEqual(pay.amount, t.row.reg_fee,
          'the amount is copied from reg_fee at submit time, so a later fee change ' +
          'does not rewrite history');
        T.assert(!Util.isBlank(pay.screenshot_file_id), 'the screenshot must be stored');
        T.assert(!isNaN(Date.parse(pay.submitted_at)), 'submitted_at must parse');
        T.assert(Util.isBlank(pay.verified_by), 'nothing is verified yet');
        T.assert(Util.isBlank(pay.verified_at), 'and there is no verified_at');

        // The invariant, over every registration this suite has made so far.
        const paidPlayerIds = {};
        Repo.readAll(SHEETS.PAYMENTS).forEach(r => { paidPlayerIds[r.player_id] = true; });
        Repo.readAll(SHEETS.PLAYERS).forEach(r => {
          if (regTids.indexOf(r.tournament_id) === -1) return;
          T.assert(paidPlayerIds[r.player_id] === true,
            'player ' + r.player_id + ' (serial ' + r.serial_no + ') has no Payments ' +
            'row — the Players row was written before the payment was ready');
        });
      });

      T.test('search_blob is lowercase and contains name, role and style', function () {
        // CONTRACTS-PHASE1.md §3 pins the formula exactly, because Phase 4 search
        // lowercases the query and does a plain substring match against this column.
        const t = main();
        const name = 'ZZ Blob Tester';
        const role = ENUM.PLAYER_ROLE.ALL_ROUNDER;
        const style = ENUM.PLAYER_STYLE.LEFT;
        const out = Suites._register(t.tid, { name: name, role: role, style: style });
        const p = Repo.findBy(SHEETS.PLAYERS, 'player_id', out.player_id);

        T.assertEqual(p.search_blob, (name + ' ' + role + ' ' + style).toLowerCase(),
          'search_blob is exactly (name + " " + role + " " + style).toLowerCase()');
        T.assertEqual(p.search_blob, String(p.search_blob).toLowerCase(),
          'a single capital letter makes every lowercased query miss this player');
        ['zz blob tester', 'all_rounder', 'left'].forEach(needle => {
          T.assert(String(p.search_blob).indexOf(needle) !== -1,
            'search_blob must contain "' + needle + '", got "' + p.search_blob + '"');
        });
      });

      T.test('age_years is computed at the tournament start date and stored', function () {
        // CONTRACTS-PHASE1.md §3: Util.ageYears(dob, tournament.startDate), and the
        // result must be 8-70. The fixture start_date is fixed at 2026-09-05 so the
        // boundary dates below do not move with the real calendar.
        const t = main();
        const seeded = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', t.tid);
        T.assertEqual(seeded.start_date, '2026-09-05',
          'fixture precondition: the ages below are measured against this date');

        const out = Suites._register(t.tid, { dob: '1998-04-12' });
        const p = Repo.findBy(SHEETS.PLAYERS, 'player_id', out.player_id);
        T.assertEqual(p.age_years, 28,
          'born 12 Apr 1998, measured at the 5 Sep 2026 tournament start');
        T.assertEqual(p.age_years, Util.ageYears('1998-04-12', seeded.start_date),
          'age_years must equal Util.ageYears(dob, startDate)');
        T.assertEqual(typeof p.age_years, 'number', 'age_years is stored as a number');

        // Inclusive boundaries.
        const eight = Suites._register(t.tid, { dob: '2018-09-05' });
        T.assertEqual(Repo.findBy(SHEETS.PLAYERS, 'player_id', eight.player_id).age_years, 8,
          'exactly 8 on the start date is allowed');
        const seventy = Suites._register(t.tid, { dob: '1956-09-05' });
        T.assertEqual(Repo.findBy(SHEETS.PLAYERS, 'player_id', seventy.player_id).age_years, 70,
          'exactly 70 on the start date is allowed');

        T.assertThrows(() => Suites._register(t.tid, { dob: '2018-09-06' }),
          ERR.VALIDATION_FAILED, 'one day short of 8 must be refused');
        T.assertThrows(() => Suites._register(t.tid, { dob: '1955-09-04' }),
          ERR.VALIDATION_FAILED, '71 years old must be refused');
        T.assertThrows(() => Suites._register(t.tid, { dob: 'not-a-date' }),
          ERR.VALIDATION_FAILED, 'an unparseable date of birth');
        T.assertThrows(() => Suites._register(t.tid, { dob: '2026-02-30' }),
          ERR.VALIDATION_FAILED, 'an impossible day must not roll forward into March');
      });

      // -----------------------------------------------------------------------
      // Duplicates
      // -----------------------------------------------------------------------

      T.test('a duplicate mobile is rejected with the exact DESIGN §11 message',
        function () {
          const t = main();
          const mobile = Suites._freshMobile();
          Suites._register(t.tid, { mobile: mobile });

          const e = T.assertThrows(() => Suites._register(t.tid, { mobile: mobile }),
            ERR.DUPLICATE_MOBILE, 'the same mobile twice in one tournament');

          // Verbatim from DESIGN.md §11. It is shown to the player, and
          // CONTRACTS-PHASE1.md §3 says the server messages are those strings exactly.
          T.assertEqual(e.message,
            'A registration already exists for this mobile number. ' +
            'Please contact the tournament organiser.',
            'the wording is part of the contract — it tells the player what to do next');

          // Same mobile in a DIFFERENT tournament is fine: uniqueness is per
          // tournament, not global (DESIGN.md §39).
          const inOther = Suites._register(other().tid, { mobile: mobile });
          T.assert(inOther.serial_no > 0,
            'the same person may register for a different tournament');
        });

      T.test('a duplicate upi_ref is rejected with DUPLICATE_UPI_REF', function () {
        const t = main();
        const ref = 'ZZDUPREF' + T.nextSeq();
        Suites._register(t.tid, { upiRef: ref });

        const e = T.assertThrows(() => Suites._register(t.tid, { upiRef: ref }),
          ERR.DUPLICATE_UPI_REF,
          'one UPI reference is one payment; reusing it is how a single fee gets ' +
          'claimed by two registrations');
        T.assertEqual(e.message, 'This UPI reference number has already been used.',
          'verbatim from DESIGN.md §11');
      });

      // -----------------------------------------------------------------------
      // Field validation — CONTRACTS-PHASE1.md §3
      // -----------------------------------------------------------------------

      T.test('every field rule in the contract table is enforced server-side', function () {
        const t = main();
        const before = Repo.count(SHEETS.PLAYERS, { tournament_id: t.tid });
        const reject = (overrides, why) => {
          T.assertThrows(() => Suites._register(t.tid, overrides),
            ERR.VALIDATION_FAILED, why);
        };

        // mobile — Util.isValidMobileIN
        reject({ mobile: '12345' }, 'a five-digit mobile');
        reject({ mobile: '1234567890' }, 'ten digits but a leading 1 is not an Indian mobile');
        reject({ mobile: '98765432100' }, 'eleven digits');
        reject({ mobile: '' }, 'a blank mobile');

        // name — 2-60 chars
        reject({ name: 'Z' }, 'a one-character name');
        reject({ name: '   ' }, 'whitespace is not a name');
        reject({ name: 'Z'.repeat(61) }, '61 characters is over the 60-char limit');

        // role / style — must be in the enum
        reject({ role: 'KEEPER' }, 'WICKET KEEPER is not one of the three roles');
        reject({ role: '' }, 'a blank role');
        reject({ style: 'AMBIDEXTROUS' }, 'style is LEFT or RIGHT only');
        reject({ style: '' }, 'a blank style');
        // Deliberately not tested: whether lowercase "left" is accepted.
        // CONTRACTS-PHASE1.md §3 says only "in ENUM.PLAYER_STYLE"; normalising the
        // case before the check is a defensible reading and asserting either way
        // would be inventing a rule.

        // images — all three are required
        reject({ photo: null }, 'a missing profile photo');
        reject({ photoThumb: null }, 'a missing thumbnail');
        reject({ screenshot: null }, 'a missing payment screenshot');
        reject({ screenshot: { data: '', mime: 'image/jpeg', filename: 'x.jpg' } },
          'an empty screenshot payload');

        // upiRef — 6-35 alphanumeric
        reject({ upiRef: 'ab123' }, 'five characters is under the 6-char minimum');
        reject({ upiRef: 'A'.repeat(36) }, '36 characters is over the 35-char maximum');
        reject({ upiRef: 'ZZ REF 12345' }, 'spaces are not alphanumeric');
        reject({ upiRef: 'ZZ-REF-12345' }, 'hyphens are not alphanumeric');
        reject({ upiRef: '' }, 'a blank UPI reference');

        T.assertEqual(Repo.count(SHEETS.PLAYERS, { tournament_id: t.tid }), before,
          'not one of those rejections may leave a Players row behind');
      });

      // -----------------------------------------------------------------------
      // The IST window — the tests that matter (CONTRACTS.md §6a, DESIGN.md §11)
      // -----------------------------------------------------------------------

      T.test('registration is ACCEPTED all through the closing IST day', function () {
        // A naive UTC comparison fails BOTH of these. Reg window is 1-31 Aug 2026.
        //   03:00 IST on 31 Aug = 2026-08-30T21:30Z — UTC still says "the 30th", so a
        //     deadline-as-UTC-midnight check calls it too early on the last day.
        //   23:00 IST on 31 Aug = 2026-08-31T17:30Z — a check that closed the window
        //     at UTC midnight on the 31st lost the whole Indian working day.
        // Between them they are most of the registrations on deadline night.
        const t = windowed();

        const early = Suites._withFakeNow('2026-08-30T21:30:00.000Z', function () {
          return Suites._register(t.tid);
        });
        T.assert(early && early.serial_no > 0,
          '3am IST on the closing day must get through, got ' + T._fmt(early));

        const late = Suites._withFakeNow('2026-08-31T17:30:00.000Z', function () {
          return Suites._register(t.tid);
        });
        T.assert(late && late.serial_no > early.serial_no,
          '11pm IST on the closing day must get through, got ' + T._fmt(late));

        // 00:00 IST on the opening day is the other edge of the same bug.
        const opening = Suites._withFakeNow('2026-07-31T18:30:00.000Z', function () {
          return Suites._register(t.tid);
        });
        T.assert(opening && opening.serial_no > 0,
          'midnight IST on the opening day is inside the window');
      });

      T.test('registration one second after IST midnight is REJECTED', function () {
        const t = windowed();
        // 2026-08-31T18:30:00.000Z is 00:00 IST on 1 Sep. One second later the
        // window is over. A UTC-midnight check would keep accepting for 5.5 hours.
        Suites._withFakeNow('2026-08-31T18:30:01.000Z', function () {
          T.assertThrows(() => Suites._register(t.tid), ERR.REGISTRATION_CLOSED,
            'one second past IST midnight on the closing day');
        });
        Suites._withFakeNow('2026-09-01T04:00:00.000Z', function () {
          T.assertThrows(() => Suites._register(t.tid), ERR.REGISTRATION_CLOSED,
            '09:30 IST on the day after — comfortably closed');
        });
      });

      T.test('registration before the window opens is REJECTED', function () {
        const t = windowed();
        Suites._withFakeNow('2026-07-31T18:29:59.000Z', function () {
          T.assertThrows(() => Suites._register(t.tid), ERR.REGISTRATION_CLOSED,
            'one second before 00:00 IST on the opening day');
        });
        Suites._withFakeNow('2026-07-01T06:00:00.000Z', function () {
          T.assertThrows(() => Suites._register(t.tid), ERR.REGISTRATION_CLOSED,
            'a month early');
        });
      });

      T.test('registration against a DRAFT or REG_CLOSED tournament is rejected',
        function () {
          // CONTRACTS-PHASE1.md §2 makes registration_open depend on status as well as
          // the window, and §3 gives the window failure the code REGISTRATION_CLOSED.
          // It does not separately name the code for "the window is fine but the
          // status is not", so this accepts either of the two defensible codes and
          // insists only that nothing is written.
          const draft = Suites._seedTournament('regdrf', {
            status: ENUM.TOURNAMENT_STATUS.DRAFT,
            reg_start: '2020-01-01', reg_end: '2099-12-31'
          });
          const closed = Suites._seedTournament('regcls', {
            status: ENUM.TOURNAMENT_STATUS.REG_CLOSED,
            reg_start: '2020-01-01', reg_end: '2099-12-31'
          });
          regTids.push(draft.tid, closed.tid);

          [['DRAFT', draft], ['REG_CLOSED', closed]].forEach(pair => {
            const e = T.assertThrows(() => Suites._register(pair[1].tid), null,
              'a ' + pair[0] + ' tournament must not accept registrations');
            T.assert(e.code === ERR.REGISTRATION_CLOSED || e.code === ERR.VALIDATION_FAILED,
              'expected REGISTRATION_CLOSED (or VALIDATION_FAILED) for a ' + pair[0] +
              ' tournament, got ' + e.code);
            T.assertEqual(Repo.count(SHEETS.PLAYERS, { tournament_id: pair[1].tid }), 0,
              'nothing may be written for a ' + pair[0] + ' tournament');
          });
        });

      // -----------------------------------------------------------------------
      // checkMobile
      // -----------------------------------------------------------------------

      T.test('checkMobile returns {taken} and nothing else', function () {
        // DESIGN.md §16 risk #4: this endpoint is anonymous. Returning a name, a
        // serial or a registered_at turns it into a lookup service for anyone who
        // can guess mobile numbers — and mobile numbers are guessable.
        const t = main();
        const free = Suites._freshMobile();
        const untaken = Suites._call('player.checkMobile',
          { tournamentId: t.tid, mobile: free }, null);
        T.assertEqual(untaken, { taken: false },
          'an unused mobile must return exactly {taken:false}');

        const used = Suites._freshMobile();
        Suites._register(t.tid, { mobile: used, name: 'ZZ Check Mobile' });
        const taken = Suites._call('player.checkMobile',
          { tournamentId: t.tid, mobile: used }, null);
        T.assertEqual(taken, { taken: true },
          'a used mobile must return exactly {taken:true} — no name, no serial');

        T.assertEqual(Object.keys(taken), ['taken'],
          'exactly one key. Present: ' + Object.keys(taken).join(', '));
        ['name', 'player_id', 'serial_no', 'registered_at', 'payment_status', 'player']
          .forEach(k => {
            T.assert(Object.keys(taken).indexOf(k) === -1,
              'checkMobile leaked "' + k + '"');
          });
        T.assert(JSON.stringify(taken).indexOf('ZZ Check Mobile') === -1,
          'the registered player\'s name must not appear anywhere in the response');

        // Scoped to the tournament, like everything else (DESIGN.md §39).
        T.assertEqual(Suites._call('player.checkMobile',
          { tournamentId: other().tid, mobile: used }, null), { taken: false },
          'a mobile used in one tournament is free in another');
      });

      // -----------------------------------------------------------------------
      // Where the files land — DESIGN.md §16 risk #1
      // -----------------------------------------------------------------------

      T.test('the screenshot goes to the private folder and the photo to the public one',
        function () {
          // Risk #1 in DESIGN.md §16, rated High: a Drive link is unauthenticated, so
          // a payment screenshot in a "anyone with the link" folder is readable by
          // anyone who ever sees or guesses the id. It must live under private/.
          const t = main();
          T.assert(t.folders, 'fixture precondition: the tournament has Drive folders');
          T.assert(t.folders.playersId !== t.folders.paymentsId,
            'the public players folder and the private payments folder must be two ' +
            'different folders');

          const out = Suites._register(t.tid, { name: 'ZZ Folder Split' });
          const p = Repo.findBy(SHEETS.PLAYERS, 'player_id', out.player_id);
          const pay = Repo.findBy(SHEETS.PAYMENTS, 'player_id', out.player_id);

          // DriveApp directly: Drive.gs has no "where does this file live" API, and
          // the whole point of the test is to look at the real parent.
          const photoParent = Suites._parentFolderId(p.photo_file_id);
          const shotParent = Suites._parentFolderId(pay.screenshot_file_id);

          T.assertEqual(photoParent, t.folders.playersId,
            'the profile photo belongs in public/players/ — the projector loads it ' +
            'straight from a Drive thumbnail URL');
          T.assertEqual(shotParent, t.folders.paymentsId,
            'the payment screenshot belongs in private/payments/, but it was written ' +
            'to ' + shotParent);
          T.assert(shotParent !== photoParent,
            'the two images must not share a folder');
          T.assert(shotParent !== t.folders.publicId && shotParent !== t.folders.galleryId,
            'the screenshot must be nowhere under public/');
          T.assertEqual(Suites._parentFolderId(t.folders.paymentsId, true), t.folders.privateId,
            'payments/ must sit inside private/');

          // And private/ must not be link-shared. Drive.ensureTournamentFolders never
          // shares it; this catches a future change that does.
          let access = null;
          try {
            access = String(DriveApp.getFolderById(t.folders.privateId).getSharingAccess());
          } catch (e) {
            access = 'unreadable: ' + T._errText(e);
          }
          T.assert(access !== String(DriveApp.Access.ANYONE_WITH_LINK) &&
            access !== String(DriveApp.Access.ANYONE),
            'the private folder must not be link-shared, but its access is ' + access);
        });

      // -----------------------------------------------------------------------
      // The lock boundary — DESIGN.md §6.2
      // -----------------------------------------------------------------------

      T.test('every image upload happens OUTSIDE the script lock', function () {
        // THE THROUGHPUT TEST.
        //
        // DESIGN.md §6.2: uploads take ~2-3 s each. A script lock is global, so
        // holding it across the uploads caps the whole system at roughly 20
        // registrations per minute. Outside the lock the critical section is ~200 ms
        // and the same hardware takes ten times the load. On deadline night that is
        // the difference between working and not.
        //
        // There is no way to observe this from the outside, so the two functions are
        // wrapped for the duration of the test and the call order is recorded. Both
        // are plain object properties, and both are restored in a finally.
        const t = main();
        const order = [];
        const realUpload = Drive.uploadImage;
        const realWithLock = Repo.withLock;

        try {
          Drive.uploadImage = function () {
            order.push('upload');
            return realUpload.apply(Drive, arguments);
          };
          Repo.withLock = function () {
            order.push('lock-enter');
            try {
              return realWithLock.apply(Repo, arguments);
            } finally {
              order.push('lock-exit');
            }
          };
          Suites._register(t.tid, { name: 'ZZ Lock Boundary' });
        } finally {
          Drive.uploadImage = realUpload;
          Repo.withLock = realWithLock;
        }

        const uploads = order.filter(x => x === 'upload').length;
        const firstLock = order.indexOf('lock-enter');
        const lastUpload = order.lastIndexOf('upload');

        T.assert(uploads >= 3,
          'expected at least three uploads (photo, thumb, screenshot), saw ' + uploads +
          '. Call order: ' + order.join(' -> '));
        T.assert(firstLock !== -1,
          'player.register never took the script lock. Serial allocation without the ' +
          'lock hands two simultaneous registrations the same number (DESIGN.md §6.2). ' +
          'Call order: ' + order.join(' -> '));
        T.assert(lastUpload < firstLock,
          'an image upload happened inside the script lock. Every upload must finish ' +
          'before Repo.withLock is entered — holding a global lock for ~3 s of Drive ' +
          'I/O caps the system at ~20 registrations a minute and breaks deadline ' +
          'night (DESIGN.md §6.2). Call order: ' + order.join(' -> '));

        // Say it the other way round too, so the failure message is unambiguous.
        let inside = false;
        let uploadsInside = 0;
        order.forEach(step => {
          if (step === 'lock-enter') inside = true;
          else if (step === 'lock-exit') inside = false;
          else if (step === 'upload' && inside) uploadsInside++;
        });
        T.assertEqual(uploadsInside, 0,
          uploadsInside + ' upload(s) ran between lock-enter and lock-exit. ' +
          'Call order: ' + order.join(' -> '));
      });
    });
  },

  // ===========================================================================
  // PlayerList — CONTRACTS-PHASE2.md §1 (player.list, player.setWithdrawn),
  // §2 (the eligibility predicate) and §3 (counts).
  // Rationale: DESIGN.md §11, §14, §15 case 16, §39.
  //
  // The general register the admin works from. The two failures that matter here
  // do not announce themselves:
  //   - a paging or sort mistake makes a row appear twice or vanish, and nobody
  //     finds out until a player says they were never called;
  //   - a screenshot_file_id in a bulk row hands out an unauthenticated link to
  //     somebody's bank payment proof (DESIGN.md §16 risk 1).
  //
  // Rows are seeded straight onto the sheet rather than registered through
  // player.register. 55 registrations would mean 165 Drive uploads and several
  // minutes, and would prove nothing about paging; registration itself is
  // covered by the Registration suite. Everything still goes through
  // buildRoutes() on the way in — the action names are the contract, the
  // internal function names are not.
  // ===========================================================================

  playerList() {
    T.suite('PlayerList', function () {
      const PS = ENUM.PAYMENT_STATUS;
      const AS = ENUM.AUCTION_STATUS;
      const admin = Suites._adminSession('pladm');

      // Fixtures are built lazily and memoised, so a broken one fails the tests
      // that need it rather than aborting the whole suite body.
      const fx = {};

      /**
       * Eight players with a deliberate spread of statuses. Names, serials and
       * registration instants are all in DIFFERENT orders on purpose: if they
       * agreed, a "sort by name" test would pass against code that sorted by
       * serial and never noticed.
       *
       *   serial  name             payment   auction   withdrawn  registered
       *     1     ZZ Hotel Hari    VERIFIED  PENDING   no         8 Aug
       *     2     ZZ Bravo Bala    PENDING   PENDING   no         6 Aug
       *     3     ZZ Foxtrot ...   REJECTED  PENDING   no         4 Aug
       *     4     ZZ Alpha Anand   VERIFIED  SOLD      no         2 Aug
       *     5     ZZ Golf Ganesh   VERIFIED  UNSOLD    YES        7 Aug
       *     6     ZZ Charlie ...   PENDING   PENDING   YES        5 Aug
       *     7     ZZ Echo Elango   VERIFIED  PENDING   no         3 Aug
       *     8     ZZ Delta Dinesh  REJECTED  PENDING   YES        1 Aug
       *
       * counts: all 8, pending 2, verified 4, rejected 2, withdrawn 3,
       *         eligible 3 (serials 1, 4 and 7).
       */
      function main() {
        if (!fx.main) {
          const t = Suites._seedTournament('pllist', { withFolders: false });
          const roster = Suites._seedRoster(t.tid, [
            { serial_no: 1, name: 'ZZ Hotel Hari', payment_status: PS.VERIFIED,
              registered_at: '2026-08-08T06:00:00.000Z' },
            { serial_no: 2, name: 'ZZ Bravo Bala', payment_status: PS.PENDING,
              registered_at: '2026-08-06T06:00:00.000Z' },
            { serial_no: 3, name: 'ZZ Foxtrot Farook', payment_status: PS.REJECTED,
              registered_at: '2026-08-04T06:00:00.000Z' },
            { serial_no: 4, name: 'ZZ Alpha Anand', payment_status: PS.VERIFIED,
              auction_status: AS.SOLD, team_id: 'TEM_zztestteam1', sold_amount: 40000,
              registered_at: '2026-08-02T06:00:00.000Z' },
            { serial_no: 5, name: 'ZZ Golf Ganesh', payment_status: PS.VERIFIED,
              auction_status: AS.UNSOLD, is_withdrawn: true,
              registered_at: '2026-08-07T06:00:00.000Z' },
            { serial_no: 6, name: 'ZZ Charlie Chandran', payment_status: PS.PENDING,
              is_withdrawn: true, registered_at: '2026-08-05T06:00:00.000Z' },
            { serial_no: 7, name: 'ZZ Echo Elango', payment_status: PS.VERIFIED,
              registered_at: '2026-08-03T06:00:00.000Z' },
            { serial_no: 8, name: 'ZZ Delta Dinesh', payment_status: PS.REJECTED,
              is_withdrawn: true, registered_at: '2026-08-01T06:00:00.000Z' }
          ]);
          fx.main = { tid: t.tid, players: roster.players, payments: roster.payments };
        }
        return fx.main;
      }

      /** 55 players, so the default page of 50 has a real second page behind it. */
      function paged() {
        if (!fx.paged) {
          const t = Suites._seedTournament('plpage', { withFolders: false });
          const specs = [];
          for (let i = 1; i <= 55; i++) {
            specs.push({
              serial_no: i,
              name: 'ZZ Page Player ' + Suites._seqLetters(),
              payment_status: PS.VERIFIED
            });
          }
          Suites._seedRoster(t.tid, specs);
          fx.paged = { tid: t.tid, total: 55 };
        }
        return fx.paged;
      }

      /**
       * Three players whose mobiles, serials and UPI references are PINNED
       * rather than generated. Every search assertion below is an exact set, and
       * a generated 10-digit mobile could happen to contain the serial number
       * another case searches for and turn a green test amber at random.
       */
      function searchable() {
        if (!fx.search) {
          const t = Suites._seedTournament('plsrch', { withFolders: false });
          Suites._seedRoster(t.tid, [
            { serial_no: 101, name: 'ZZ Alpha Nair', mobile: '9800000001',
              upi_ref: 'ZZSEARCHALPHA' },
            { serial_no: 202, name: 'ZZ Bravo Kumar', mobile: '9700000002',
              upi_ref: 'ZZSEARCHBRAVO' },
            { serial_no: 303, name: 'ZZ Charlie Das', mobile: '9600000003',
              upi_ref: 'ZZSEARCHCHARLIE' }
          ]);
          fx.search = { tid: t.tid };
        }
        return fx.search;
      }

      /** A second tournament, to prove nothing leaks across the boundary. */
      function other() {
        if (!fx.other) {
          const t = Suites._seedTournament('plothr', { withFolders: false });
          const roster = Suites._seedRoster(t.tid, [
            { serial_no: 1, name: 'ZZ Other One', payment_status: PS.VERIFIED },
            { serial_no: 2, name: 'ZZ Other Two', payment_status: PS.PENDING }
          ]);
          fx.other = { tid: t.tid, players: roster.players };
        }
        return fx.other;
      }

      /** Three players for the withdrawal tests, one of them already SOLD. */
      function withdrawable() {
        if (!fx.wd) {
          const t = Suites._seedTournament('plwdrw', { withFolders: false });
          const roster = Suites._seedRoster(t.tid, [
            { serial_no: 1, name: 'ZZ Withdraw Me', payment_status: PS.VERIFIED },
            { serial_no: 2, name: 'ZZ Sold Player', payment_status: PS.VERIFIED,
              auction_status: AS.SOLD, team_id: 'TEM_zztestteam2', sold_amount: 40000 },
            { serial_no: 3, name: 'ZZ Audit Me', payment_status: PS.VERIFIED }
          ]);
          fx.wd = { tid: t.tid, players: roster.players };
        }
        return fx.wd;
      }

      /** Serial numbers of a list response, in the order they came back. */
      function serials(res) {
        return res.rows.map(r => r.serial_no);
      }

      // -----------------------------------------------------------------------
      // Routing
      // -----------------------------------------------------------------------

      T.test('player.list and player.setWithdrawn are registered with the right exposure',
        function () {
          const list = Suites._route('player.list');
          T.assert(list.methods.indexOf('POST') !== -1, 'player.list must accept POST');
          T.assert(list.methods.indexOf('GET') === -1,
            'a GET route carries no token in the body (CONTRACTS.md §11), so the whole ' +
            'register would sit behind a link anyone could paste');
          T.assert(list.auth !== 'PUBLIC',
            'player.list is the admin register — DESIGN.md §16 risk 4 is exactly this ' +
            'list being reachable anonymously');
          T.assert(Suites._authAllows(list.auth, ENUM.USER_ROLE.ADMIN),
            'player.list must allow ADMIN, got auth = ' + T._fmt(list.auth));
          T.assert(Suites._authAllows(list.auth, ENUM.USER_ROLE.ORGANISER),
            'CONTRACTS-PHASE2 §1 allows an ORGANISER their OWN tournament, so the role ' +
            'check lets them in and Auth.requireTournament is what scopes them');

          const wd = Suites._route('player.setWithdrawn');
          T.assert(wd.methods.indexOf('POST') !== -1, 'player.setWithdrawn must accept POST');
          T.assert(wd.methods.indexOf('GET') === -1,
            'setWithdrawn writes; a GET route would let a link take a player out of the ' +
            'tournament');
          T.assert(Suites._authAllows(wd.auth, ENUM.USER_ROLE.ADMIN),
            'player.setWithdrawn must allow ADMIN, got auth = ' + T._fmt(wd.auth));
          T.assert(!Suites._authAllows(wd.auth, ENUM.USER_ROLE.ORGANISER),
            'CONTRACTS-PHASE2 §1 marks setWithdrawn ADMIN only. An organiser runs the ' +
            'auction; deciding a paid-up player is out of the tournament is not theirs ' +
            'to do. Got auth = ' + T._fmt(wd.auth));
        });

      // -----------------------------------------------------------------------
      // Paging — DESIGN.md §14 ("paginate the admin player list, 50/page")
      // -----------------------------------------------------------------------

      T.test('paging: 50 rows by default, and the last page is the partial one',
        function () {
          const t = paged();
          const first = Suites._call('player.list', { tournamentId: t.tid }, admin);

          T.assertEqual(first.pageSize, 50,
            'CONTRACTS-PHASE2 §1 and DESIGN.md §14 both pin the default at 50');
          T.assertEqual(first.page, 1, 'paging is 1-based and defaults to the first page');
          T.assertEqual(first.rows.length, 50, 'a full first page');
          T.assertEqual(first.total, 55, 'total is the size of the filtered result set');
          T.assertEqual(first.totalPages, 2, 'ceil(55 / 50)');
          T.assertEqual(first.rows[0].serial_no, 1,
            'the default sort is serial_no ascending (CONTRACTS-PHASE2 §1)');
          T.assertEqual(first.rows[49].serial_no, 50, 'and it runs to 50 on page 1');

          const second = Suites._call('player.list', { tournamentId: t.tid, page: 2 }, admin);
          T.assertEqual(second.page, 2, 'the requested page is echoed');
          T.assertEqual(second.rows.length, 5, 'the last page holds the remaining 5 of 55');
          T.assertEqual(serials(second), [51, 52, 53, 54, 55],
            'and it carries on exactly where page 1 stopped');
          T.assertEqual(second.total, 55, 'total does not change with the page');
          T.assertEqual(second.totalPages, 2, 'nor does totalPages');

          // THE POINT OF A TOTAL ORDER. Two pages of a list sorted on a key with
          // ties can show one row twice and skip another entirely, and nothing
          // errors — the player just never gets called.
          const seen = {};
          first.rows.concat(second.rows).forEach(r => {
            seen[r.serial_no] = (seen[r.serial_no] || 0) + 1;
          });
          T.assertEqual(Object.keys(seen).length, 55,
            'the two pages together must cover all 55 players exactly once');
          Object.keys(seen).forEach(k => {
            T.assertEqual(seen[k], 1, 'serial ' + k + ' appears ' + seen[k] + ' times across ' +
              'the two pages — a row shown twice means another one was skipped');
          });
        });

      T.test('a page past the end returns empty rows with the real totals, not an error',
        function () {
          // The admin may be on page 8 when a filter change shrinks the result to
          // two pages, or holding a bookmark from yesterday. An error there is a
          // dead end; empty rows plus the correct totals let the screen move
          // itself to a page that exists.
          const t = paged();
          let out = null;
          let threw = null;
          try {
            out = Suites._call('player.list', { tournamentId: t.tid, page: 9 }, admin);
          } catch (e) {
            threw = e;
          }
          T.assert(threw === null,
            'an out-of-range page must not throw, got ' + T._errText(threw));
          T.assertEqual(out.rows, [], 'there is nothing on page 9');
          T.assertEqual(out.page, 9, 'the requested page is echoed back');
          T.assertEqual(out.total, 55, 'the real total still comes back');
          T.assertEqual(out.totalPages, 2, 'and the real page count, so the UI can recover');
          T.assertEqual(out.counts.all, 55, 'and the counts are unaffected');
        });

      T.test('pageSize is capped at 200', function () {
        // CONTRACTS-PHASE2 §1: "pageSize: 50, max 200". One call must not be able
        // to ask for the whole sheet.
        const t = paged();
        const huge = Suites._call('player.list',
          { tournamentId: t.tid, pageSize: 5000 }, admin);
        T.assertEqual(huge.pageSize, 200,
          'a request for 5000 rows must be clamped to 200, not honoured');
        T.assertEqual(huge.rows.length, 55, 'only 55 players exist, so 55 come back');
        T.assertEqual(huge.totalPages, 1, 'ceil(55 / 200)');

        const exact = Suites._call('player.list',
          { tournamentId: t.tid, pageSize: 200 }, admin);
        T.assertEqual(exact.pageSize, 200, '200 itself is allowed — the cap is inclusive');

        const small = Suites._call('player.list',
          { tournamentId: t.tid, pageSize: 10, page: 6 }, admin);
        T.assertEqual(small.pageSize, 10, 'a smaller page size is honoured as asked');
        T.assertEqual(small.rows.length, 5, 'page 6 of 55 at 10 per page holds 5');
        T.assertEqual(small.totalPages, 6, 'ceil(55 / 10)');
      });

      // -----------------------------------------------------------------------
      // Filters
      // -----------------------------------------------------------------------

      T.test('each filter narrows the list, and two filters are AND-ed', function () {
        const t = main();
        const q = (filter) => Suites._call('player.list',
          { tournamentId: t.tid, pageSize: 200, filter: filter }, admin);

        T.assertEqual(serials(q({})), [1, 2, 3, 4, 5, 6, 7, 8],
          'no filter means every player in the tournament');

        // paymentStatus
        T.assertEqual(serials(q({ paymentStatus: PS.VERIFIED })), [1, 4, 5, 7], 'VERIFIED only');
        T.assertEqual(serials(q({ paymentStatus: PS.PENDING })), [2, 6], 'PENDING only');
        T.assertEqual(serials(q({ paymentStatus: PS.REJECTED })), [3, 8], 'REJECTED only');

        // auctionStatus
        T.assertEqual(serials(q({ auctionStatus: AS.SOLD })), [4], 'SOLD only');
        T.assertEqual(serials(q({ auctionStatus: AS.UNSOLD })), [5], 'UNSOLD only');
        T.assertEqual(serials(q({ auctionStatus: AS.PENDING })), [1, 2, 3, 6, 7, 8],
          'still to be auctioned');

        // withdrawn — omitted means BOTH, which is not the same as false
        T.assertEqual(serials(q({ withdrawn: true })), [5, 6, 8], 'the ones who pulled out');
        T.assertEqual(serials(q({ withdrawn: false })), [1, 2, 3, 4, 7], 'and the ones who did not');
        T.assertEqual(serials(q({})).length, 8,
          'omitting the withdrawn filter must mean "both", not "false" — otherwise a ' +
          'withdrawn player disappears from the register entirely');

        // AND-ed. This particular pair is the auction pool (CONTRACTS-PHASE2 §2).
        T.assertEqual(serials(q({ paymentStatus: PS.VERIFIED, withdrawn: false })), [1, 4, 7],
          'VERIFIED and not withdrawn must be AND-ed, not OR-ed. OR would return all ' +
          'eight and put a rejected player in front of the auctioneer.');
        T.assertEqual(serials(q({ paymentStatus: PS.VERIFIED, auctionStatus: AS.SOLD })), [4],
          'a second AND-ed pair');
        T.assertEqual(serials(q({ paymentStatus: PS.REJECTED, auctionStatus: AS.SOLD })), [],
          'a pair that matches nobody returns an empty list, not everybody');

        // A value outside the enum is a typo, and a typo must not silently widen
        // the list back out to everyone.
        T.assertThrows(() => q({ paymentStatus: 'PAID' }), ERR.VALIDATION_FAILED,
          '"PAID" is not one of the three payment statuses');
        T.assertThrows(() => q({ auctionStatus: 'BOUGHT' }), ERR.VALIDATION_FAILED,
          '"BOUGHT" is not one of the three auction statuses');
      });

      T.test('search matches serial_no, name, mobile and upi_ref, case-insensitively',
        function () {
          const t = searchable();
          const q = (needle) => Suites._call('player.list',
            { tournamentId: t.tid, pageSize: 200, filter: { search: needle } }, admin);

          T.assertEqual(serials(q('101')), [101],
            'a serial number typed into the search box must find that player');
          T.assertEqual(serials(q('ALPHA NAIR')), [101],
            'an upper-case query must match a mixed-case name — the admin types from a ' +
            'phone screen, not from the sheet');
          T.assertEqual(serials(q('alpha nair')), [101], 'and the lower-case form too');
          T.assertEqual(serials(q('9700000002')), [202],
            'a mobile number is the other thing an admin has to hand');
          T.assertEqual(serials(q('zzsearchcharlie')), [303],
            'a lower-case query must match the upper-case UPI reference stored on the ' +
            'Payments row — matching the bank statement is the whole job (DESIGN.md §12)');
          T.assertEqual(serials(q('ZZSEARCHCHARLIE')), [303], 'and the upper-case form');

          T.assertEqual(serials(q('zz ')), [101, 202, 303],
            'a substring shared by all three finds all three');
          T.assertEqual(serials(q('kumar')), [202],
            'a partial name is enough — the admin usually has part of a word, not all of it');
          T.assertEqual(serials(q('nobodyhasthisname')), [],
            'a search that matches nobody returns an empty list, not everybody');

          const none = Suites._call('player.list',
            { tournamentId: t.tid, filter: { search: '   ' } }, admin);
          T.assertEqual(none.total, 3,
            'a blank search is no search at all, not a search for the empty string');
        });

      // -----------------------------------------------------------------------
      // Sorting
      // -----------------------------------------------------------------------

      T.test('each of the four sort keys orders the page', function () {
        const t = main();
        const q = (sort) => Suites._call('player.list',
          { tournamentId: t.tid, pageSize: 200, sort: sort }, admin);

        T.assertEqual(serials(q('serial_no')), [1, 2, 3, 4, 5, 6, 7, 8], 'serial_no ascending');

        // Alphabetical by name: Alpha(4) Bravo(2) Charlie(6) Delta(8) Echo(7)
        // Foxtrot(3) Golf(5) Hotel(1).
        T.assertEqual(serials(q('name')), [4, 2, 6, 8, 7, 3, 5, 1],
          'name ascending, case-folded');

        // Oldest registration first: 1 Aug(8) 2 Aug(4) 3 Aug(7) 4 Aug(3)
        // 5 Aug(6) 6 Aug(2) 7 Aug(5) 8 Aug(1).
        T.assertEqual(serials(q('registered_at')), [8, 4, 7, 3, 6, 2, 5, 1],
          'registered_at ascending, oldest first');

        // PENDING < REJECTED < VERIFIED alphabetically, with serial_no breaking
        // the ties inside each group.
        T.assertEqual(serials(q('payment_status')), [2, 6, 3, 8, 1, 4, 5, 7],
          'payment_status ascending, ties broken by serial_no');

        // Every sort must be a TOTAL order. If it is not, two rows with the same
        // key can swap places between one page and the next, and the same player
        // is shown twice while another is never shown at all.
        ['serial_no', 'name', 'registered_at', 'payment_status'].forEach(sort => {
          const p1 = Suites._call('player.list',
            { tournamentId: t.tid, pageSize: 3, page: 1, sort: sort }, admin);
          const p2 = Suites._call('player.list',
            { tournamentId: t.tid, pageSize: 3, page: 2, sort: sort }, admin);
          const p3 = Suites._call('player.list',
            { tournamentId: t.tid, pageSize: 3, page: 3, sort: sort }, admin);
          T.assertEqual(serials(p1).concat(serials(p2), serials(p3)), serials(q(sort)),
            'sorted by ' + sort + ', three pages of 3 must reassemble into exactly the ' +
            'same order as one page of 8');
        });
      });

      T.test('an invalid sort key is rejected, not silently ignored', function () {
        // A typo that quietly falls back to a different order is worse than an
        // error: the pages are then cut from an order the caller did not ask for,
        // and rows appear twice or vanish with nothing on screen to say why.
        const t = main();
        ['serial-no', 'seral_no', 'sold_amount', 'mobile', 'name desc', '1', 'true']
          .forEach(bad => {
            const e = T.assertThrows(() => Suites._call('player.list',
              { tournamentId: t.tid, sort: bad }, admin),
              ERR.VALIDATION_FAILED, '"' + bad + '" is not one of the four sort keys');
            T.assert(String(e.message).indexOf('serial_no') !== -1,
              'the message must list the keys that ARE allowed, got "' + e.message + '"');
          });

        // A blank sort is not a typo — it means "use the default".
        const blank = Suites._call('player.list', { tournamentId: t.tid, sort: '' }, admin);
        T.assertEqual(serials(blank), [1, 2, 3, 4, 5, 6, 7, 8],
          'an omitted sort falls back to serial_no, which is the documented default');
      });

      // -----------------------------------------------------------------------
      // Counts — CONTRACTS-PHASE2 §3
      // -----------------------------------------------------------------------

      T.test('counts cover the whole tournament, not the page', function () {
        const t = main();
        const expected = { all: 8, pending: 2, verified: 4, rejected: 2, withdrawn: 3, eligible: 3 };

        const full = Suites._call('player.list', { tournamentId: t.tid, pageSize: 200 }, admin);
        T.assertEqual(Object.keys(full.counts).sort(),
          ['all', 'eligible', 'pending', 'rejected', 'verified', 'withdrawn'],
          'CONTRACTS-PHASE2 §3 pins these six keys exactly');
        T.assertEqual(full.counts, expected, 'the baseline counts for the fixture');

        // THE ACTUAL CONTRACT: the admin needs "42 still pending" while looking
        // at page 1 of 8. A page-scoped count would read "1 pending" here.
        const one = Suites._call('player.list',
          { tournamentId: t.tid, pageSize: 1, page: 3 }, admin);
        T.assertEqual(one.rows.length, 1, 'precondition: exactly one row on this page');
        T.assertEqual(one.total, 8, 'total is the whole filtered set, not the page');
        T.assertEqual(one.counts, expected,
          'a page of 1 must report the SAME tournament-wide counts. Page-scoped counts ' +
          'would make the header say "1 registered" on a 400-player tournament.');

        // Nor may a filter move them: the header has to keep saying how much work
        // is left while the grid shows only one slice of it.
        const filtered = Suites._call('player.list',
          { tournamentId: t.tid, filter: { paymentStatus: PS.REJECTED } }, admin);
        T.assertEqual(filtered.total, 2, 'the filter narrows total');
        T.assertEqual(filtered.counts, expected, 'but never the counts');

        const searched = Suites._call('player.list',
          { tournamentId: t.tid, filter: { search: 'Hotel' } }, admin);
        T.assertEqual(searched.total, 1, 'the search narrows total');
        T.assertEqual(searched.counts, expected, 'but never the counts');
      });

      // -----------------------------------------------------------------------
      // Tournament isolation — DESIGN.md §39
      // -----------------------------------------------------------------------

      T.test('one tournament never sees another tournament\'s players', function () {
        const t = main();
        const o = other();

        const mine = Suites._call('player.list', { tournamentId: t.tid, pageSize: 200 }, admin);
        const theirs = Suites._call('player.list', { tournamentId: o.tid, pageSize: 200 }, admin);

        T.assertEqual(mine.total, 8, 'tournament A has eight players');
        T.assertEqual(theirs.total, 2,
          'tournament B has exactly two — a total of 10 means the pass over Players is ' +
          'not filtering by tournament_id (DESIGN.md §39)');
        T.assertEqual(mine.counts.all, 8, 'and the counts are scoped the same way');
        T.assertEqual(theirs.counts.all, 2, 'B\'s counts must not include A\'s players');

        const mineIds = {};
        mine.rows.forEach(r => { mineIds[r.player_id] = true; });
        theirs.rows.forEach(r => {
          T.assert(mineIds[r.player_id] !== true,
            'player ' + r.player_id + ' appears in both tournaments');
        });

        // The Payments join is the other place a tournament boundary can leak:
        // both tournaments have a serial 1 and a serial 2.
        const theirRefs = {};
        theirs.rows.forEach(r => { theirRefs[r.upi_ref] = true; });
        mine.rows.forEach(r => {
          T.assert(theirRefs[r.upi_ref] !== true,
            'the UPI reference "' + r.upi_ref + '" was joined onto a player from the ' +
            'other tournament — the payment index is not tournament-scoped');
        });
      });

      // -----------------------------------------------------------------------
      // The bulk-response security boundary — DESIGN.md §16 risk 1
      // -----------------------------------------------------------------------

      T.test('screenshot_file_id never appears in a player.list response', function () {
        // CONTRACTS-PHASE2 §1: "Never include screenshot_file_id in a list row."
        // A Drive file id is enough to build an unauthenticated link to somebody's
        // bank payment proof. Screenshots are fetched one at a time behind an
        // admin token; an id has no reason to be in a bulk response of 200 rows.
        const t = main();
        const res = Suites._call('player.list', { tournamentId: t.tid, pageSize: 200 }, admin);
        T.assertEqual(res.rows.length, 8, 'precondition: every fixture row is on this page');

        // The row shape is copied verbatim from CONTRACTS-PHASE2 §1 and compared
        // EXACTLY, so a new field has to change the contract rather than appear
        // by accident.
        T.assertEqual(Object.keys(res.rows[0]).sort(), [
          'age_years', 'auction_status', 'dob', 'is_withdrawn', 'mobile', 'name',
          'payment_id', 'payment_status', 'photo_thumb_url', 'player_id',
          'registered_at', 'registered_at_display', 'role', 'serial_no',
          'sold_amount', 'style', 'team_id', 'upi_ref'
        ], 'a list row must be exactly the CONTRACTS-PHASE2 §1 fields');

        // Keys are only half of it — a value can hide inside an allowed key, so
        // the real assertion is made against the SERIALISED response.
        const wire = JSON.stringify(res);
        const shotIds = Repo.readAll(SHEETS.PAYMENTS)
          .filter(r => String(r.tournament_id) === t.tid)
          .map(r => String(r.screenshot_file_id || ''));
        T.assertEqual(shotIds.length, 8, 'precondition: eight fixture payments');
        shotIds.forEach(id => {
          T.assert(id.length > 0,
            'precondition: the fixture screenshot ids must be non-blank, or this test ' +
            'would pass against anything');
          T.assert(wire.indexOf(id) === -1,
            'the screenshot file id "' + id + '" reached the browser inside a bulk list ' +
            'response. That id is an unauthenticated link to a payment proof ' +
            '(DESIGN.md §16 risk 1).');
        });
        T.assert(wire.indexOf('screenshot') === -1,
          'the word "screenshot" appears in the serialised list response; nothing about ' +
          'the payment proof belongs in a bulk row');
      });

      // -----------------------------------------------------------------------
      // Scope — DESIGN.md §5.4, §39
      // -----------------------------------------------------------------------

      T.test('an ORGANISER sees only their own tournament; an ADMIN sees any', function () {
        const t = main();
        const o = other();
        const organiser = Suites._organiserSession('plorg', t.tid);

        const own = Suites._call('player.list', { tournamentId: t.tid }, organiser);
        T.assertEqual(own.total, 8,
          'an organiser must be able to read their own register (CONTRACTS-PHASE2 §1)');

        T.assertThrows(
          () => Suites._call('player.list', { tournamentId: o.tid }, organiser),
          ERR.FORBIDDEN,
          'one organiser reading another tournament\'s players is the main tenancy leak ' +
          '(DESIGN.md §39, §16 risk 3)');

        T.assertEqual(Suites._call('player.list', { tournamentId: t.tid }, admin).total, 8,
          'ADMIN is global (DESIGN.md §5.4)');
        T.assertEqual(Suites._call('player.list', { tournamentId: o.tid }, admin).total, 2,
          'and may read the second tournament too');

        // Fails closed rather than open when there is no session at all.
        T.assertThrows(() => Suites._call('player.list', { tournamentId: t.tid }, null),
          ERR.UNAUTHORIZED, 'no session means no register');
      });

      // -----------------------------------------------------------------------
      // The eligibility predicate — CONTRACTS-PHASE2 §2
      // -----------------------------------------------------------------------

      T.test('isAuctionEligible is VERIFIED and not withdrawn, and nothing else',
        function () {
          // ONE predicate, written once (CONTRACTS-PHASE2 §2). A second copy in
          // the Phase 4 auction code is how a rejected player ends up on the
          // projector in front of 200 people.
          //
          // The contract names three payment statuses and one boolean, so all six
          // combinations are checked, not just the four that are interesting.
          const cases = [
            [PS.VERIFIED, false, true, 'paid up and still in — the only eligible case'],
            [PS.VERIFIED, true, false, 'paid up but pulled out (DESIGN.md §15 case 16)'],
            [PS.PENDING, false, false, 'nobody has checked the bank statement yet'],
            [PS.PENDING, true, false, 'unchecked and withdrawn'],
            [PS.REJECTED, false, false, 'the payment was refused'],
            [PS.REJECTED, true, false, 'refused and withdrawn']
          ];
          cases.forEach(c => {
            const row = { payment_status: c[0], is_withdrawn: c[1] };
            T.assertEqual(Players.isAuctionEligible(row), c[2],
              c[0] + ' + is_withdrawn=' + c[1] + ': ' + c[3]);
          });

          // A blank status is not VERIFIED, and a row that is not a row is not a
          // player. Both must fail CLOSED — the predicate can only ever keep
          // somebody out by mistake, never let somebody in.
          T.assertEqual(Players.isAuctionEligible({ payment_status: '', is_withdrawn: false }),
            false, 'a blank payment_status must not be treated as verified');
          T.assertEqual(Players.isAuctionEligible(null), false, 'null is not a player');
          T.assertEqual(Players.isAuctionEligible(undefined), false, 'nor is undefined');
          T.assertEqual(Players.isAuctionEligible({}), false, 'nor is an empty object');

          // The sheet stores booleans as the strings TRUE/FALSE (CONTRACTS.md §4).
          // A row read outside Repo's typing still has to be treated as withdrawn.
          T.assertEqual(
            Players.isAuctionEligible({ payment_status: PS.VERIFIED, is_withdrawn: 'TRUE' }),
            false, 'the literal string "TRUE" is truthy and must count as withdrawn');

          // And the same predicate drives the count over the whole tournament.
          const t = main();
          T.assertEqual(Players.eligibleCount(t.tid), 3,
            'serials 1, 4 and 7 are VERIFIED and not withdrawn');
          T.assertEqual(
            Suites._call('player.list', { tournamentId: t.tid }, admin).counts.eligible,
            Players.eligibleCount(t.tid),
            'counts.eligible must be the same number as eligibleCount — two answers to ' +
            'one question is how the pool and the header disagree');
        });

      // -----------------------------------------------------------------------
      // player.setWithdrawn — CONTRACTS-PHASE2 §1, DESIGN.md §9, §15 case 16
      // -----------------------------------------------------------------------

      T.test('setWithdrawn marks the player and keeps the serial reserved for ever',
        function () {
          const f = withdrawable();
          const p = f.players[0];
          const before = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', f.tid);

          const out = Suites._call('player.setWithdrawn',
            { playerId: p.player_id, withdrawn: true, reason: 'ZZ work travel' }, admin);

          T.assertEqual(Object.keys(out).sort(), ['is_withdrawn', 'player_id', 'serial_no'],
            'CONTRACTS-PHASE2 §1 pins the response to exactly these three fields');
          T.assertEqual(out.is_withdrawn, true, 'the new state comes back');
          T.assertEqual(out.serial_no, 1, 'and the serial number, unchanged');
          T.assertEqual(out.player_id, p.player_id, 'and the id that was acted on');

          const row = Repo.findBy(SHEETS.PLAYERS, 'player_id', p.player_id);
          T.assert(row !== null,
            'withdrawing must never delete the row — DESIGN.md §9, nothing is renumbered');
          T.assertEqual(row.is_withdrawn, true, 'the flag is set on the sheet, not just in the reply');
          T.assertEqual(row.serial_no, 1,
            'serial 1 belongs to this person for ever. Reissuing it puts two different ' +
            'people on the same number in the printed list and the auction history.');
          T.assertEqual(row.payment_status, PS.VERIFIED,
            'payment_status mirrors the Payments row and Payments.gs is its only writer; ' +
            'a withdrawal says nothing about whether the money arrived');

          const after = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', f.tid);
          T.assertEqual(after.next_serial, before.next_serial,
            'and the tournament\'s serial counter is never wound back (DESIGN.md §9)');

          // They drop out of the pool without anything being deleted.
          T.assertEqual(Players.isAuctionEligible(row), false,
            'a withdrawn player stops satisfying the §2 predicate');

          // Same call again: a no-op success, not a scary message
          // (DESIGN.md §15 case 4).
          let threw = null;
          let again = null;
          try {
            again = Suites._call('player.setWithdrawn',
              { playerId: p.player_id, withdrawn: true }, admin);
          } catch (e) {
            threw = e;
          }
          T.assert(threw === null,
            'withdrawing an already-withdrawn player must not be an error, got ' +
            T._errText(threw));
          T.assertEqual(again.is_withdrawn, true, 'and the state is reported unchanged');

          // Reinstating is the same call with false — nothing is one-way here.
          const back = Suites._call('player.setWithdrawn',
            { playerId: p.player_id, withdrawn: false }, admin);
          T.assertEqual(back.is_withdrawn, false, 'a withdrawal can be undone');
          T.assertEqual(back.serial_no, 1, 'and the serial is still theirs');
          T.assertEqual(
            Repo.findBy(SHEETS.PLAYERS, 'player_id', p.player_id).is_withdrawn, false,
            'the sheet follows');
        });

      T.test('setWithdrawn refuses a SOLD player with VALIDATION_FAILED', function () {
        // A sale is three facts, not one: the player has a team_id, the team's
        // purse_used went up and its players_count went up. Flipping is_withdrawn
        // here would change one of the three and leave the other two standing —
        // the team keeps paying for a player it no longer has. That has to be
        // unwound through the Phase 7 correction flow (CONTRACTS-PHASE2 §1).
        const f = withdrawable();
        const p = f.players[1];

        const e = T.assertThrows(() => Suites._call('player.setWithdrawn',
          { playerId: p.player_id, withdrawn: true, reason: 'ZZ changed their mind' }, admin),
          ERR.VALIDATION_FAILED, 'a SOLD player must not be withdrawn here');
        T.assert(String(e.message).indexOf('#2') !== -1,
          'the message must name the serial number so the admin knows who it is about, ' +
          'got "' + e.message + '"');

        const row = Repo.findBy(SHEETS.PLAYERS, 'player_id', p.player_id);
        T.assertEqual(row.is_withdrawn, false, 'a refused withdrawal must leave the row alone');
        T.assertEqual(row.auction_status, AS.SOLD, 'the sale itself is untouched');
        T.assertEqual(row.team_id, 'TEM_zztestteam2', 'and the team still owns them');
        T.assertEqual(row.sold_amount, 40000, 'and the money is still recorded');

        T.assertEqual(Suites._auditRows(p.player_id, Audit.ACTIONS.PLAYER_WITHDRAWN).length, 0,
          'a refused withdrawal must not write an audit row for something that did not happen');

        // A bad `withdrawn` value is a refusal too — guessing what the caller
        // meant is how somebody gets withdrawn by accident.
        T.assertThrows(() => Suites._call('player.setWithdrawn',
          { playerId: f.players[2].player_id, withdrawn: 'yes' }, admin),
          ERR.VALIDATION_FAILED, '"yes" is not a boolean');
        T.assertThrows(() => Suites._call('player.setWithdrawn',
          { playerId: 'PLY_zzzzzzzzzzzz', withdrawn: true }, admin),
          ERR.NOT_FOUND, 'an unknown player id');
      });

      T.test('setWithdrawn writes a PLAYER_WITHDRAWN audit row', function () {
        // CONTRACTS-PHASE2 §4 adds this one constant to the frozen Audit.ACTIONS
        // map. The trail is what settles a dispute afterwards (DESIGN.md §42).
        T.assertEqual(Audit.ACTIONS.PLAYER_WITHDRAWN, 'PLAYER_WITHDRAWN',
          'CONTRACTS-PHASE2 §4 requires this constant on Audit.ACTIONS');

        const f = withdrawable();
        const p = f.players[2];
        T.assertEqual(Suites._auditRows(p.player_id, null).length, 0,
          'precondition: nothing has been recorded about this player yet');

        Suites._call('player.setWithdrawn',
          { playerId: p.player_id, withdrawn: true, reason: 'ZZ injured before the auction' },
          admin);

        const rows = Suites._auditRows(p.player_id, Audit.ACTIONS.PLAYER_WITHDRAWN);
        T.assertEqual(rows.length, 1, 'exactly one audit row per withdrawal');
        const row = rows[0];
        T.assertEqual(row.actor_user_id, admin.user_id,
          'the trail has to name who decided (DESIGN.md §42)');
        T.assertEqual(row.actor_role, ENUM.USER_ROLE.ADMIN, 'and in what capacity');
        T.assertEqual(row.entity_type, 'Player', 'the entity type');
        T.assertEqual(row.entity_id, p.player_id, 'the entity id');
        T.assertEqual(row.tournament_id, f.tid, 'and the tournament it belongs to');
        T.assert(!isNaN(Date.parse(row.timestamp)),
          'timestamp must be a parseable instant, got ' + T._fmt(row.timestamp));

        const prev = Util.safeJsonParse(row.prev_value, null);
        const next = Util.safeJsonParse(row.new_value, null);
        T.assert(prev !== null && next !== null,
          'prev and new must both be stored as JSON (CONTRACTS.md §10)');
        T.assertEqual(prev.is_withdrawn, false, 'the audit row carries the previous value');
        T.assertEqual(next.is_withdrawn, true, 'and the new one');
        T.assertEqual(next.serial_no, 3,
          'and the serial, because that is what a later dispute is about');

        // A repeated call changes nothing, so it records nothing.
        Suites._call('player.setWithdrawn', { playerId: p.player_id, withdrawn: true }, admin);
        T.assertEqual(Suites._auditRows(p.player_id, Audit.ACTIONS.PLAYER_WITHDRAWN).length, 1,
          'a no-op must not fill an append-only trail with rows for a change that never ' +
          'happened');
      });
    });
  },

  // ===========================================================================
  // PaymentVerify — CONTRACTS-PHASE2.md §1 (payment.list, payment.getScreenshot,
  // payment.verify, payment.reject), §3 (counts) and §4 (audit).
  // Rationale: DESIGN.md §6.3, §12, §13, §14, §15 cases 4 and 15, §16, §42.
  //
  // The governing rule (DESIGN.md §12): the application never decides that a
  // payment succeeded. A human compares the UPI reference against a bank
  // statement and clicks. Everything here exists to make that comparison fast
  // and to record who decided what, when.
  //
  // Two things in this suite are load bearing rather than thorough:
  //   1. verify and reject must MIRROR payment_status onto the Players row. The
  //      auction pool reads the mirrored column (DESIGN.md §14); asserting only
  //      the Payments row would pass while an unpaid player walked into the
  //      auction.
  //   2. payment.getScreenshot must never return a Drive id or a Drive URL. That
  //      is risk #1 in DESIGN.md §16, and the test for it reads the serialised
  //      response, not the keys.
  // ===========================================================================

  paymentVerify() {
    T.suite('PaymentVerify', function () {
      const PS = ENUM.PAYMENT_STATUS;
      const AS = ENUM.AUCTION_STATUS;
      const admin = Suites._adminSession('pvadm');

      const fx = {};

      /** The workhorse tournament. Every test that mutates state takes a fresh
       *  player and payment out of it, so no test depends on another. */
      function main() {
        if (!fx.main) {
          fx.main = { t: Suites._seedTournament('pvmain', { withFolders: false }), serial: 0 };
        }
        return fx.main;
      }

      /**
       * One brand-new PENDING payment nobody else has touched.
       * @param {Object=} overrides row fields for the seeded player/payment
       * @return {{tid:string, player:!Object, payment:!Object}}
       */
      function freshPayment(overrides) {
        const m = main();
        m.serial += 1;
        const spec = { serial_no: m.serial, name: 'ZZ Pay ' + Suites._seqLetters() };
        const o = overrides || {};
        Object.keys(o).forEach(k => { spec[k] = o[k]; });
        const roster = Suites._seedRoster(m.t.tid, [spec]);
        return { tid: m.t.tid, player: roster.players[0], payment: roster.payments[0] };
      }

      /**
       * Five players with fixed statuses, so the counts a decision returns can be
       * asserted as exact numbers rather than as a shape.
       *   1 PENDING · 2 PENDING · 3 VERIFIED · 4 REJECTED · 5 VERIFIED+withdrawn
       * Baseline: all 5, pending 2, verified 2, rejected 1, withdrawn 1, eligible 1.
       */
      function countable() {
        if (!fx.counts) {
          const t = Suites._seedTournament('pvcnts', { withFolders: false });
          const roster = Suites._seedRoster(t.tid, [
            { serial_no: 1, name: 'ZZ Count One', payment_status: PS.PENDING },
            { serial_no: 2, name: 'ZZ Count Two', payment_status: PS.PENDING },
            { serial_no: 3, name: 'ZZ Count Three', payment_status: PS.VERIFIED },
            { serial_no: 4, name: 'ZZ Count Four', payment_status: PS.REJECTED },
            { serial_no: 5, name: 'ZZ Count Five', payment_status: PS.VERIFIED,
              is_withdrawn: true }
          ]);
          fx.counts = { tid: t.tid, players: roster.players, payments: roster.payments };
        }
        return fx.counts;
      }

      /** Two players with the same name written differently, plus a near miss. */
      function duplicates() {
        if (!fx.dup) {
          const t = Suites._seedTournament('pvdup', { withFolders: false });
          Suites._seedRoster(t.tid, [
            { serial_no: 21, name: 'ZZ Raj Kumar' },
            // Same name once whitespace runs are collapsed and case is folded.
            { serial_no: 22, name: 'zz   raj  kumar' },
            // A NEAR match, which must be left alone.
            { serial_no: 23, name: 'ZZ Rajkumar' }
          ]);
          fx.dup = { tid: t.tid };
        }
        return fx.dup;
      }

      /** Four payments of mixed status and age, for the queue defaults. */
      function queue() {
        if (!fx.queue) {
          const t = Suites._seedTournament('pvque', { withFolders: false });
          Suites._seedRoster(t.tid, [
            { serial_no: 31, name: 'ZZ Queue Newer', payment_status: PS.PENDING,
              submitted_at: '2026-08-05T06:00:00.000Z' },
            { serial_no: 32, name: 'ZZ Queue Older', payment_status: PS.PENDING,
              submitted_at: '2026-08-01T06:00:00.000Z' },
            { serial_no: 33, name: 'ZZ Queue Done', payment_status: PS.VERIFIED,
              submitted_at: '2026-08-02T06:00:00.000Z' },
            { serial_no: 34, name: 'ZZ Queue Refused', payment_status: PS.REJECTED,
              submitted_at: '2026-08-03T06:00:00.000Z' }
          ]);
          fx.queue = { tid: t.tid };
        }
        return fx.queue;
      }

      /** One payment with a REAL image in the private Drive folder. */
      function proof() {
        if (!fx.proof) {
          const t = Suites._seedTournament('pvshot', {});
          T.assert(t.folders,
            'fixture precondition: the tournament needs its Drive folders for this test');
          const fileId = Drive.uploadImage(
            t.folders.paymentsId, Suites._jpegBase64(), DRIVE_MIME_JPEG, 'zz-proof.jpg');
          T.trackDrive(fileId, 'file');
          const roster = Suites._seedRoster(t.tid, [
            { serial_no: 41, name: 'ZZ Proof Owner', mobile: '9500000041',
              upi_ref: 'ZZPROOFUPIREF41', screenshot_file_id: fileId }
          ]);
          fx.proof = {
            tid: t.tid, fileId: fileId,
            player: roster.players[0], payment: roster.payments[0]
          };
        }
        return fx.proof;
      }

      // -----------------------------------------------------------------------
      // Routing
      // -----------------------------------------------------------------------

      T.test('every Phase 2 payment action is ADMIN-only over POST', function () {
        ['payment.list', 'payment.getScreenshot', 'payment.verify', 'payment.reject']
          .forEach(name => {
            const r = Suites._route(name);
            T.assert(r.methods.indexOf('POST') !== -1, name + ' must accept POST');
            T.assert(r.methods.indexOf('GET') === -1,
              name + ' must not be reachable over GET. verify and reject write, and a ' +
              'screenshot behind a GET URL lands in browser history and server logs — ' +
              'the exact leak DESIGN.md §16 risk 1 exists to prevent.');
            T.assert(r.auth !== 'PUBLIC', name + ' must never be PUBLIC');
            T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN),
              name + ' must allow ADMIN, got auth = ' + T._fmt(r.auth));
            T.assert(!Suites._authAllows(r.auth, ENUM.USER_ROLE.ORGANISER),
              name + ' is ADMIN only (CONTRACTS-PHASE2 §1). An organiser runs the ' +
              'auction; whose money arrived is not theirs to decide. Got auth = ' +
              T._fmt(r.auth));
          });
      });

      // -----------------------------------------------------------------------
      // verify and reject — the mirror is the whole point
      // -----------------------------------------------------------------------

      T.test('verify sets status, verifier and time, and MIRRORS onto the Players row',
        function () {
          const f = freshPayment();
          const out = Suites._call('payment.verify',
            { paymentId: f.payment.payment_id, note: 'ZZ matched the bank statement' }, admin);

          T.assertEqual(out.status, PS.VERIFIED, 'the decision comes back');
          T.assertEqual(out.payment_id, f.payment.payment_id, 'the payment id is echoed');
          T.assertEqual(out.player_id, f.player.player_id, 'and the player it belongs to');
          T.assertEqual(out.serial_no, f.player.serial_no, 'and their serial number');
          T.assert(!Util.isBlank(out.verified_at_display),
            'the admin screen prints verified_at_display, got ' + T._fmt(out.verified_at_display));
          T.assert(out.alreadyVerified === undefined,
            'a first verify is not an "already done"');
          T.assert(out.reversedFrom === undefined,
            'PENDING -> VERIFIED is a first decision, not a reversal');

          const pay = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', f.payment.payment_id);
          T.assertEqual(pay.status, PS.VERIFIED, 'the Payments row is updated');
          T.assertEqual(pay.verified_by, admin.user_id,
            'verified_by must be the session user (CONTRACTS-PHASE2 §1 step 4) — this is ' +
            'the field a dispute about who approved the payment turns on');
          T.assert(!isNaN(Date.parse(pay.verified_at)),
            'verified_at must be a parseable UTC instant, got ' + T._fmt(pay.verified_at));

          // ========================= THE ONE THAT MATTERS =======================
          // The auction pool reads the MIRRORED column on the Players row
          // (DESIGN.md §14, CONTRACTS-PHASE2 §2), not the Payments tab. Asserting
          // only the payment row would pass while a paid-up player was turned away
          // at the auction table, or an unpaid one walked in.
          // ======================================================================
          const player = Repo.findBy(SHEETS.PLAYERS, 'player_id', f.player.player_id);
          T.assertEqual(player.payment_status, PS.VERIFIED,
            'the Players mirror still says "' + player.payment_status + '". Payments and ' +
            'Players must be written inside one lock and flushed together ' +
            '(CONTRACTS-PHASE2 §1 step 5).');
          T.assertEqual(Players.isAuctionEligible(player), true,
            'and the §2 predicate must now admit them');

          // Audited (CONTRACTS-PHASE2 §4).
          const rows = Suites._auditRows(f.payment.payment_id, Audit.ACTIONS.PAYMENT_VERIFIED);
          T.assertEqual(rows.length, 1, 'exactly one PAYMENT_VERIFIED row');
          T.assertEqual(rows[0].actor_user_id, admin.user_id, 'naming who decided');
          T.assertEqual(rows[0].tournament_id, f.tid, 'and which tournament');
          const prev = Util.safeJsonParse(rows[0].prev_value, null);
          const next = Util.safeJsonParse(rows[0].new_value, null);
          T.assert(prev !== null && next !== null,
            'prev and new must both be stored as JSON (CONTRACTS.md §10)');
          T.assertEqual(prev.status, PS.PENDING, 'the audit row carries the previous value');
          T.assertEqual(next.status, PS.VERIFIED, 'and the new one');
        });

      T.test('reject mirrors onto the Players row too', function () {
        const f = freshPayment();
        const reason = 'ZZ no matching credit in the bank statement';
        const out = Suites._call('payment.reject',
          { paymentId: f.payment.payment_id, reason: reason }, admin);

        T.assertEqual(out.status, PS.REJECTED, 'the decision comes back');
        T.assertEqual(out.payment_id, f.payment.payment_id, 'the payment id is echoed');
        T.assertEqual(out.serial_no, f.player.serial_no, 'and the serial number');
        T.assert(out.reversedFrom === undefined,
          'PENDING -> REJECTED is a first decision, not a reversal');

        const pay = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', f.payment.payment_id);
        T.assertEqual(pay.status, PS.REJECTED, 'the Payments row is updated');
        T.assertEqual(pay.reject_reason, reason,
          'the reason is stored, because the player has to be told why (DESIGN.md §16 risk 6)');
        T.assertEqual(pay.verified_by, admin.user_id,
          'who decided is recorded for a rejection too, not only for an approval');
        T.assert(!isNaN(Date.parse(pay.verified_at)), 'and when');

        const player = Repo.findBy(SHEETS.PLAYERS, 'player_id', f.player.player_id);
        T.assertEqual(player.payment_status, PS.REJECTED,
          'the Players mirror still says "' + player.payment_status + '". A rejected ' +
          'payment that never reaches the mirror leaves the player in the auction pool ' +
          '(DESIGN.md §14).');
        T.assertEqual(Players.isAuctionEligible(player), false,
          'and the §2 predicate must now refuse them');

        const rows = Suites._auditRows(f.payment.payment_id, Audit.ACTIONS.PAYMENT_REJECTED);
        T.assertEqual(rows.length, 1, 'exactly one PAYMENT_REJECTED row');
        const next = Util.safeJsonParse(rows[0].new_value, null);
        T.assert(next !== null, 'the new value must be stored as JSON');
        T.assertEqual(next.status, PS.REJECTED, 'and it records the decision');
      });

      // -----------------------------------------------------------------------
      // Two admins on one queue — DESIGN.md §15 case 4
      // -----------------------------------------------------------------------

      T.test('a second verify is a silent no-op: one audit row, the first verifier kept',
        function () {
          const f = freshPayment();
          Suites._call('payment.verify', { paymentId: f.payment.payment_id }, admin);
          const firstRow = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', f.payment.payment_id);
          T.assertEqual(firstRow.verified_by, admin.user_id,
            'precondition: the first verifier is on the row');
          const firstAt = String(firstRow.verified_at);

          // A second admin working the same queue. Ordinary behaviour, not an
          // exception (DESIGN.md §15 case 4).
          const second = Suites._adminSession('pvadm2');
          let out = null;
          let threw = null;
          try {
            out = Suites._call('payment.verify', { paymentId: f.payment.payment_id }, second);
          } catch (e) {
            threw = e;
          }
          T.assert(threw === null,
            'two admins clicking the same row must not produce a scary message, got ' +
            T._errText(threw));
          T.assertEqual(out.alreadyVerified, true,
            'CONTRACTS-PHASE2 §1 step 2 pins this flag on the no-op response');
          T.assertEqual(out.status, PS.VERIFIED, 'the existing state comes back');
          T.assert(out.counts && typeof out.counts.eligible === 'number',
            'and the counts come back with it, got ' + T._fmt(out.counts));

          const after = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', f.payment.payment_id);
          T.assertEqual(after.verified_by, admin.user_id,
            'the FIRST verifier must be preserved. Overwriting them rewrites who made the ' +
            'decision, which is the one thing the trail exists to settle (DESIGN.md §42).');
          T.assertEqual(String(after.verified_at), firstAt,
            'and the instant it was decided must not move either');

          T.assertEqual(
            Suites._auditRows(f.payment.payment_id, Audit.ACTIONS.PAYMENT_VERIFIED).length, 1,
            'a no-op must not write a second audit row — nothing happened');
        });

      T.test('a second reject keeps the original reason and writes no second audit row',
        function () {
          const f = freshPayment();
          const original = 'ZZ the UPI reference is not in the statement';
          Suites._call('payment.reject',
            { paymentId: f.payment.payment_id, reason: original }, admin);

          const second = Suites._adminSession('pvadm3');
          let out = null;
          let threw = null;
          try {
            out = Suites._call('payment.reject',
              { paymentId: f.payment.payment_id, reason: 'ZZ a completely different reason' },
              second);
          } catch (e) {
            threw = e;
          }
          T.assert(threw === null,
            'a repeated rejection must not be an error, got ' + T._errText(threw));
          T.assertEqual(out.alreadyRejected, true,
            'the no-op is reported, the same way verify reports alreadyVerified');
          T.assertEqual(out.status, PS.REJECTED, 'the existing state comes back');

          const after = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', f.payment.payment_id);
          T.assertEqual(after.reject_reason, original,
            'the ORIGINAL reason must survive. It is what the player was told, and ' +
            'overwriting it makes the earlier conversation unexplainable.');
          T.assertEqual(after.verified_by, admin.user_id, 'and the original decider');

          T.assertEqual(
            Suites._auditRows(f.payment.payment_id, Audit.ACTIONS.PAYMENT_REJECTED).length, 1,
            'one decision, one audit row');
        });

      // -----------------------------------------------------------------------
      // Reversals
      // -----------------------------------------------------------------------

      T.test('verify after reject, and reject after verify, are recorded as reversals',
        function () {
          // People do change their minds after a second look at the bank
          // statement. That is allowed, but it is a reversal of an earlier human
          // decision and the trail has to say so (CONTRACTS-PHASE2 §1, §4).
          const a = freshPayment();
          Suites._call('payment.verify', { paymentId: a.payment.payment_id }, admin);
          const toRejected = Suites._call('payment.reject',
            { paymentId: a.payment.payment_id, reason: 'ZZ the credit was for another player' },
            admin);

          T.assertEqual(toRejected.reversedFrom, PS.VERIFIED,
            'CONTRACTS-PHASE2 §1: rejecting a VERIFIED payment reports reversedFrom');
          T.assertEqual(toRejected.status, PS.REJECTED, 'and the new state');
          T.assertEqual(
            Repo.findBy(SHEETS.PLAYERS, 'player_id', a.player.player_id).payment_status,
            PS.REJECTED,
            'the mirror must follow the reversal, or the player stays in the pool after ' +
            'their payment was taken back (DESIGN.md §14)');

          const aAudit = Suites._auditRows(a.payment.payment_id, null);
          T.assertEqual(aAudit.length, 2,
            'a reversal is a SECOND audit row, never an edit of the first — the trail is ' +
            'append-only (DESIGN.md §42)');
          T.assertEqual(aAudit[0].action, Audit.ACTIONS.PAYMENT_VERIFIED, 'first the approval');
          T.assertEqual(aAudit[1].action, Audit.ACTIONS.PAYMENT_REJECTED, 'then the reversal');
          const aNext = Util.safeJsonParse(aAudit[1].new_value, null);
          T.assert(aNext !== null, 'the reversal row must carry its new value as JSON');
          T.assertEqual(aNext.reversal, true, 'and be marked as a reversal');
          T.assertEqual(aNext.reversed_from, PS.VERIFIED, 'naming what it reversed');

          const b = freshPayment();
          Suites._call('payment.reject',
            { paymentId: b.payment.payment_id, reason: 'ZZ amount looked wrong at first' }, admin);
          const toVerified = Suites._call('payment.verify',
            { paymentId: b.payment.payment_id }, admin);

          T.assertEqual(toVerified.reversedFrom, PS.REJECTED,
            'verifying a REJECTED payment reports reversedFrom the other way round');
          T.assertEqual(toVerified.status, PS.VERIFIED, 'and the new state');

          const bPlayer = Repo.findBy(SHEETS.PLAYERS, 'player_id', b.player.player_id);
          T.assertEqual(bPlayer.payment_status, PS.VERIFIED, 'the mirror follows again');
          T.assertEqual(Players.isAuctionEligible(bPlayer), true,
            'and the player is back in the pool');

          const bPay = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', b.payment.payment_id);
          T.assertEqual(bPay.reject_reason, '',
            'a VERIFIED row must not keep the old rejection reason sitting next to it — ' +
            'that is the pair of facts a support call reads as a contradiction');
          T.assertEqual(Suites._auditRows(b.payment.payment_id, null).length, 2,
            'two decisions, two rows');
        });

      // -----------------------------------------------------------------------
      // The rejection reason — CONTRACTS-PHASE2 §1, DESIGN.md §16 risk 6
      // -----------------------------------------------------------------------

      T.test('a rejection reason that is missing, blank, too short or too long is refused',
        function () {
          const f = freshPayment();
          const id = f.payment.payment_id;

          [[{}, 'no reason field at all'],
           [{ reason: '' }, 'an empty reason'],
           [{ reason: '   ' }, 'whitespace is not a reason'],
           [{ reason: null }, 'a null reason'],
           [{ reason: 'zz' }, 'two characters is under the 3-char minimum'],
           [{ reason: 'z'.repeat(201) }, '201 characters is over the 200-char maximum']
          ].forEach(pair => {
            const payload = { paymentId: id };
            Object.keys(pair[0]).forEach(k => { payload[k] = pair[0][k]; });
            T.assertThrows(() => Suites._call('payment.reject', payload, admin),
              ERR.VALIDATION_FAILED,
              pair[1] + ' — a rejection nobody can explain to the player who paid ' +
              '(CONTRACTS-PHASE2 §1, DESIGN.md §16 risk 6)');
          });

          // Not one of those may have changed anything.
          const pay = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', id);
          T.assertEqual(pay.status, PS.PENDING, 'the payment must still be PENDING');
          T.assertEqual(pay.reject_reason, '', 'and carry no reason');
          T.assertEqual(pay.verified_by, '', 'and no decider');
          T.assertEqual(
            Repo.findBy(SHEETS.PLAYERS, 'player_id', f.player.player_id).payment_status,
            PS.PENDING, 'nor may the mirror have moved');
          T.assertEqual(Suites._auditRows(id, null).length, 0,
            'nor may a refused rejection be written into the trail');

          // The boundaries themselves are accepted, so the rule is 3..200 and not
          // 4..199.
          const three = freshPayment();
          Suites._call('payment.reject',
            { paymentId: three.payment.payment_id, reason: 'zzz' }, admin);
          T.assertEqual(
            Repo.findBy(SHEETS.PAYMENTS, 'payment_id', three.payment.payment_id).reject_reason,
            'zzz', 'exactly 3 characters is allowed');

          const long = freshPayment();
          const twoHundred = 'z'.repeat(200);
          Suites._call('payment.reject',
            { paymentId: long.payment.payment_id, reason: twoHundred }, admin);
          T.assertEqual(
            Repo.findBy(SHEETS.PAYMENTS, 'payment_id', long.payment.payment_id).reject_reason,
            twoHundred, 'exactly 200 characters is allowed');
        });

      T.test('rejecting deletes nothing — row, serial, photos, screenshot and upi_ref survive',
        function () {
          // CONTRACTS-PHASE2 §1: "Rejecting never deletes anything." The player
          // row, the images and above all the serial number stay (DESIGN.md §9).
          // A rejection is a disputed fact, and the evidence has to outlive it.
          const f = freshPayment();
          const playerBefore = Repo.findBy(SHEETS.PLAYERS, 'player_id', f.player.player_id);
          const payBefore = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', f.payment.payment_id);
          const trnBefore = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', f.tid);
          T.assert(!Util.isBlank(payBefore.screenshot_file_id),
            'precondition: the fixture payment has a screenshot on file');

          Suites._call('payment.reject',
            { paymentId: f.payment.payment_id, reason: 'ZZ could not find this credit' }, admin);

          const playerAfter = Repo.findBy(SHEETS.PLAYERS, 'player_id', f.player.player_id);
          T.assert(playerAfter !== null, 'the Players row must still exist');
          T.assertEqual(playerAfter.serial_no, playerBefore.serial_no,
            'the serial number stays with this person for ever (DESIGN.md §9)');
          T.assertEqual(playerAfter.name, playerBefore.name, 'the name survives');
          T.assertEqual(playerAfter.mobile, playerBefore.mobile, 'the mobile survives');
          T.assertEqual(playerAfter.photo_file_id, playerBefore.photo_file_id,
            'the profile photo is not deleted');
          T.assertEqual(playerAfter.photo_thumb_url, playerBefore.photo_thumb_url,
            'nor is its cached thumbnail URL');
          T.assertEqual(playerAfter.is_withdrawn, false,
            'a rejected payment is not a withdrawal — those are different facts');
          T.assertEqual(playerAfter.auction_status, AS.PENDING,
            'auction_status is not this action\'s to change');
          T.assertEqual(playerAfter.payment_status, PS.REJECTED,
            'only payment_status changes');

          const payAfter = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', f.payment.payment_id);
          T.assert(payAfter !== null, 'the Payments row must still exist');
          T.assertEqual(payAfter.screenshot_file_id, payBefore.screenshot_file_id,
            'the payment proof is the evidence in a dispute and is never deleted');
          T.assertEqual(payAfter.upi_ref, payBefore.upi_ref,
            'the UPI reference stays, so the same one cannot be quietly reused');
          T.assertEqual(payAfter.amount, payBefore.amount, 'the amount stays');
          T.assertEqual(payAfter.submitted_at, payBefore.submitted_at,
            'and when it was submitted');

          const trnAfter = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', f.tid);
          T.assertEqual(trnAfter.next_serial, trnBefore.next_serial,
            'and the serial counter is never wound back');
        });

      // -----------------------------------------------------------------------
      // Counts — CONTRACTS-PHASE2 §3
      // -----------------------------------------------------------------------

      T.test('verify and reject both return the tournament-wide counts', function () {
        // Returned by the decision itself so the admin header updates without a
        // second round trip. At 400 players that saves a full sheet read per click.
        const f = countable();

        const afterVerify = Suites._call('payment.verify',
          { paymentId: f.payments[0].payment_id }, admin);
        T.assertEqual(Object.keys(afterVerify.counts).sort(),
          ['all', 'eligible', 'pending', 'rejected', 'verified', 'withdrawn'],
          'CONTRACTS-PHASE2 §3 pins these six keys exactly');
        T.assertEqual(afterVerify.counts,
          { all: 5, pending: 1, verified: 3, rejected: 1, withdrawn: 1, eligible: 2 },
          'verifying serial 1 moves it from pending to verified and into the pool');

        const afterReject = Suites._call('payment.reject',
          { paymentId: f.payments[1].payment_id, reason: 'ZZ paid the wrong tournament' },
          admin);
        T.assertEqual(afterReject.counts,
          { all: 5, pending: 0, verified: 3, rejected: 2, withdrawn: 1, eligible: 2 },
          'rejecting serial 2 empties the queue without changing the pool');

        // The withdrawn VERIFIED player (serial 5) is counted in `verified` AND in
        // `withdrawn`, and must NOT be counted in `eligible`. That is the whole
        // reason `eligible` is a separate number.
        T.assertEqual(afterReject.counts.eligible, Players.eligibleCount(f.tid),
          'counts.eligible must agree with the single §2 predicate');
        T.assertEqual(afterReject.counts, Players.counts(f.tid),
          'and with a fresh whole-tournament count');

        // Tournament-wide, never page-scoped, and the same object comes back from
        // the list endpoint.
        const listed = Suites._call('payment.list',
          { tournamentId: f.tid, pageSize: 1, filter: { paymentStatus: 'ALL' } }, admin);
        T.assertEqual(listed.rows.length, 1, 'precondition: one row on the page');
        T.assertEqual(listed.counts, afterReject.counts,
          'a page of 1 must report the same tournament-wide counts');
      });

      // -----------------------------------------------------------------------
      // possible_duplicate_of — a hint, never a decision (DESIGN.md §15 case 15)
      // -----------------------------------------------------------------------

      T.test('possible_duplicate_of is an exact name match, never a near one', function () {
        const f = duplicates();
        const res = Suites._call('payment.list',
          { tournamentId: f.tid, pageSize: 200 }, admin);
        T.assertEqual(res.total, 3, 'precondition: all three fixture payments are PENDING');

        const bySerial = {};
        res.rows.forEach(r => { bySerial[r.serial_no] = r; });

        T.assertEqual(bySerial[21].possible_duplicate_of, 22,
          '"ZZ Raj Kumar" and "zz   raj  kumar" are the same name once whitespace runs ' +
          'are collapsed and case is folded. A player can register twice from two ' +
          'different mobile numbers and no unique constraint catches it, so the admin ' +
          'needs the nudge (DESIGN.md §15 case 15).');
        T.assertEqual(bySerial[22].possible_duplicate_of, 21,
          'and it points both ways, so either row can be compared against the other');

        T.assertEqual(bySerial[23].possible_duplicate_of, null,
          '"ZZ Rajkumar" is NOT "ZZ Raj Kumar". CONTRACTS-PHASE2 §1 says exact-match ' +
          'only: a fuzzy match would put a false accusation on screen next to a real ' +
          'person\'s name, and common names are common.');

        // It is a hint. Nothing about it may block or change a decision.
        const out = Suites._call('payment.verify',
          { paymentId: bySerial[21].payment_id }, admin);
        T.assertEqual(out.status, PS.VERIFIED,
          'a duplicate hint must never stop a verification — the app points, the human ' +
          'decides (DESIGN.md §12)');
      });

      // -----------------------------------------------------------------------
      // payment.list — the queue defaults
      // -----------------------------------------------------------------------

      T.test('payment.list defaults to PENDING, oldest first', function () {
        const f = queue();
        const res = Suites._call('payment.list', { tournamentId: f.tid }, admin);

        T.assertEqual(res.total, 2,
          'omitting the filter must mean PENDING — the queue opens on the work still to ' +
          'do (CONTRACTS-PHASE2 §1), not on everything ever submitted');
        T.assertEqual(res.rows.map(r => r.status), [PS.PENDING, PS.PENDING],
          'and nothing already decided is in it');
        T.assertEqual(res.rows.map(r => r.serial_no), [32, 31],
          'oldest first: serial 32 was submitted on 1 Aug, serial 31 on 5 Aug. ' +
          'Newest-first would make the admin work the queue backwards and leave the ' +
          'longest-waiting registration waiting longest.');

        T.assertEqual(res.page, 1, 'the first page');
        T.assertEqual(res.pageSize, 50, 'the default page size');
        T.assertEqual(res.counts.all, 4,
          'counts cover the whole tournament, not the PENDING slice');

        // The row shape is copied verbatim from CONTRACTS-PHASE2 §1.
        T.assertEqual(Object.keys(res.rows[0]).sort(), [
          'amount', 'amount_display', 'mobile', 'name', 'payment_id', 'photo_thumb_url',
          'player_id', 'possible_duplicate_of', 'serial_no', 'status', 'submitted_at',
          'submitted_at_display', 'upi_ref'
        ], 'a queue row must be exactly the contracted fields');
        T.assertEqual(res.rows[0].amount_display, Util.formatINR(res.rows[0].amount),
          'amount_display is the ₹-formatted form of the same integer');

        // And no file id here either — same boundary as player.list.
        const wire = JSON.stringify(res);
        Repo.readAll(SHEETS.PAYMENTS).forEach(r => {
          if (String(r.tournament_id) !== f.tid) return;
          const id = String(r.screenshot_file_id || '');
          if (!id) return;
          T.assert(wire.indexOf(id) === -1,
            'the screenshot file id "' + id + '" reached the browser in the queue response ' +
            '(DESIGN.md §16 risk 1)');
        });

        const all = Suites._call('payment.list',
          { tournamentId: f.tid, filter: { paymentStatus: 'ALL' } }, admin);
        T.assertEqual(all.total, 4,
          '"ALL" is the explicit way to ask for every status, since omitting the field ' +
          'already means PENDING');
      });

      // -----------------------------------------------------------------------
      // THE SECURITY TEST — DESIGN.md §16 risk 1
      // -----------------------------------------------------------------------

      T.test('getScreenshot returns bytes and NEVER a Drive id or a Drive URL', function () {
        // ========================= THE SECURITY TEST =========================
        // Risk #1 in DESIGN.md §16, rated High, and the most sensitive action in
        // the system. The screenshot is a bank payment proof living in the
        // private/payments folder, which is deliberately never shared
        // (CONTRACTS.md §9 rule 2).
        //
        // A DRIVE LINK IS UNAUTHENTICATED. Anyone who ends up holding one — from
        // a photo of this very screen, a browser history, a shared log, a copied
        // support email — can read another person's payment proof with no token
        // at all. So the bytes go out inline as a data: URI and the file id never
        // leaves the server.
        //
        // The assertions below are made against the SERIALISED response, not its
        // keys, so a future refactor that "helpfully" returns a URL, or tucks the
        // id inside an allowed object, fails right here.
        // =====================================================================
        const f = proof();
        const res = Suites._call('payment.getScreenshot',
          { paymentId: f.payment.payment_id }, admin);

        T.assertEqual(Object.keys(res).sort(),
          ['amount_display', 'bytes', 'dataUri', 'mime', 'player', 'upi_ref'],
          'the response must be EXACTLY the CONTRACTS-PHASE2 §1 shape. An extra key here ' +
          'is the leak this test exists to catch.');
        T.assertEqual(Object.keys(res.player).sort(), ['mobile', 'name', 'serial_no'],
          'and the nested player object is exactly {serial_no, name, mobile}');

        T.assert(String(res.dataUri).indexOf('data:image/') === 0,
          'the proof must arrive as inline bytes, got ' + T._trunc(String(res.dataUri), 60));
        T.assertEqual(res.mime, 'image/jpeg', 'the fixture image is a JPEG');
        T.assert(typeof res.bytes === 'number' && res.bytes > 0,
          'bytes must be a positive number so the screen can say "312 KB", got ' +
          T._fmt(res.bytes));
        T.assertEqual(res.player.serial_no, 41,
          'the context the admin checks against the bank statement');
        T.assertEqual(res.upi_ref, 'ZZPROOFUPIREF41',
          'the UPI reference is the thing being compared (DESIGN.md §13)');

        const wire = JSON.stringify(res);

        T.assert(wire.indexOf(f.fileId) === -1,
          'the Drive file id "' + f.fileId + '" is somewhere in the response. Anyone ' +
          'holding it can read this payment proof without a token (DESIGN.md §16 risk 1).');

        ['drive.google.com', 'docs.google.com', 'googleusercontent.com',
         'fileId', 'file_id', 'screenshot_file_id', 'thumbnail?id=', 'uc?id=', 'http']
          .forEach(needle => {
            T.assert(wire.indexOf(needle) === -1,
              'the getScreenshot response contains "' + needle + '". The screenshot must ' +
              'reach the browser ONLY as inline bytes — never as a link, and never as an ' +
              'id a link can be built from.');
          });

        // Not even the folder the proof lives in.
        const trn = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', f.tid);
        T.assert(!Util.isBlank(trn.drive_folder_id),
          'precondition: the fixture tournament has a Drive folder');
        T.assert(wire.indexOf(String(trn.drive_folder_id)) === -1,
          'the tournament\'s Drive folder id is in the response; that is a route to every ' +
          'proof in the tournament, not just this one');

        // CONTRACTS-PHASE2 §1 rule 3 and §5. One request, one screenshot, one
        // auditable access — and no "verify all pending", which would defeat the
        // entire point of a human checking each reference against a statement.
        const actions = Object.keys(buildRoutes());
        T.assert(actions.indexOf('payment.getScreenshots') === -1,
          'payment.getScreenshots must not exist. A batch route turns one auditable ' +
          'access into 400 unlogged ones (CONTRACTS-PHASE2 §1 rule 3).');
        actions.forEach(a => {
          T.assert(!/screenshots/i.test(a),
            'a plural screenshot route is registered: "' + a + '". There is no batch ' +
            'variant by design.');
          T.assert(!(/^payment\./.test(a) && /(bulk|batch|many|multi|verifyall|rejectall)/i.test(a)),
            'a bulk payment route is registered: "' + a + '" (CONTRACTS-PHASE2 §5)');
        });

        // Not asserted, because it is not observable from outside: CONTRACTS-PHASE2
        // §1 rule 4 also forbids putting the data URI in CacheService. There is no
        // documented key to look under, and inventing one would test nothing.
      });

      T.test('getScreenshot is refused to an ORGANISER and to a caller with no token',
        function () {
          // Authentication is the DISPATCHER's job (CONTRACTS.md §11 step 4), not
          // the handler's, so these three come in through the real front door
          // rather than through Suites._call.
          const f = proof();
          const payload = { paymentId: f.payment.payment_id };

          const noToken = Suites._dispatch('payment.getScreenshot', payload, null, 'POST');
          T.assertEqual(noToken.ok, false,
            'an anonymous caller must never receive a payment proof');
          T.assertEqual(noToken.error.code, ERR.UNAUTHORIZED,
            'no token is UNAUTHORIZED (CONTRACTS.md §3)');
          T.assert(JSON.stringify(noToken).indexOf(f.fileId) === -1,
            'and the refusal must not leak the file id either');

          const organiser = Suites._organiserSession('pvorg', f.tid);
          const asOrganiser = Suites._dispatch(
            'payment.getScreenshot', payload, organiser.token, 'POST');
          T.assertEqual(asOrganiser.ok, false,
            'an ORGANISER must be refused even for their OWN tournament: ' +
            'CONTRACTS-PHASE2 §1 rule 1 makes this ADMIN only, and a payment proof is a ' +
            'bank document belonging to a member of the public');
          T.assertEqual(asOrganiser.error.code, ERR.FORBIDDEN,
            'a valid token with the wrong role is FORBIDDEN, not UNAUTHORIZED ' +
            '(CONTRACTS.md §3)');
          T.assert(JSON.stringify(asOrganiser).indexOf(f.fileId) === -1,
            'and this refusal must not leak the file id either');

          // The positive control: the same route through the same door DOES work
          // for an ADMIN, so the two refusals above are not just an action that is
          // broken for everybody.
          const asAdmin = Suites._dispatch('payment.getScreenshot', payload, admin.token, 'POST');
          T.assertEqual(asAdmin.ok, true,
            'an ADMIN must still be able to do the job, got ' + T._fmt(asAdmin.error));
          T.assert(String(asAdmin.data.dataUri).indexOf('data:image/') === 0,
            'and get the bytes back');
          T.assert(JSON.stringify(asAdmin).indexOf(f.fileId) === -1,
            'even the successful response must not carry the file id');
        });

      // -----------------------------------------------------------------------
      // The mirror-repair path — DESIGN.md §14
      // -----------------------------------------------------------------------

      T.test('verify repairs a Players mirror that has drifted out of step', function () {
        // A Payments row that says VERIFIED next to a Players row that still says
        // PENDING is exactly the drift DESIGN.md §14 warns about: the player paid,
        // an admin clicked, and the auction pool never heard about it. Reporting
        // "already verified" and leaving it broken would hide the fault for ever.
        //
        // The drift is created directly through Repo, because no action can
        // produce it — which is the point.
        const f = freshPayment();
        const payRow = Repo.findBy(SHEETS.PAYMENTS, 'payment_id', f.payment.payment_id);
        Repo.updateRow(SHEETS.PAYMENTS, payRow._row, {
          status: PS.VERIFIED,
          verified_by: TEST_FIXTURES.ACTOR,
          verified_at: Util.nowIso()
        });
        Repo.flush();

        const before = Repo.findBy(SHEETS.PLAYERS, 'player_id', f.player.player_id);
        T.assertEqual(before.payment_status, PS.PENDING,
          'precondition: the mirror is broken');
        T.assertEqual(Players.isAuctionEligible(before), false,
          'precondition: a paid-up player is being kept out of the pool by the drift');

        const out = Suites._call('payment.verify', { paymentId: f.payment.payment_id }, admin);
        T.assertEqual(out.alreadyVerified, true,
          'the payment itself really was already VERIFIED, so this is still the ' +
          'no-op branch (CONTRACTS-PHASE2 §1 step 2)');
        T.assertEqual(out.status, PS.VERIFIED, 'and the state comes back');

        const after = Repo.findBy(SHEETS.PLAYERS, 'player_id', f.player.player_id);
        T.assertEqual(after.payment_status, PS.VERIFIED,
          'the mirror must be REPAIRED, not silently left broken. The auction pool reads ' +
          'this column, not the Payments tab (DESIGN.md §14), so leaving it at "' +
          before.payment_status + '" keeps a player who paid out of the auction with ' +
          'nothing on screen to say why.');
        T.assertEqual(Players.isAuctionEligible(after), true,
          'and the player is back in the pool');
        T.assert(out.counts && typeof out.counts.eligible === 'number',
          'the repaired state comes back with the counts, got ' + T._fmt(out.counts));

        // CONTRACTS-PHASE2 does not name a response flag for the repair, so the
        // flag itself is not asserted — only the repaired row, which is what the
        // auction actually reads.

        // Repairing is idempotent: a third call finds them in step and does nothing.
        const again = Suites._call('payment.verify', { paymentId: f.payment.payment_id }, admin);
        T.assertEqual(again.alreadyVerified, true, 'still a no-op');
        T.assertEqual(
          Repo.findBy(SHEETS.PLAYERS, 'player_id', f.player.player_id).payment_status,
          PS.VERIFIED, 'and the mirror stays repaired');
      });

      // -----------------------------------------------------------------------
      // The live-auction version bump — DESIGN.md §7, §14
      // -----------------------------------------------------------------------

      T.test('verifying during a live auction bumps the state version; during registration it does not',
        function () {
          // WHY THIS EXISTS: the projector and the organiser console poll a cached
          // snapshot keyed on the auction state version (DESIGN.md §7). Verifying
          // a payment changes who is eligible (DESIGN.md §14), so without a bump
          // the screen keeps showing a stale pool count while the player stands
          // there waiting to be called. A late verification mid-auction is exactly
          // when that matters.
          const live = Suites._seedTournament('pvlive', {
            withFolders: false, status: ENUM.TOURNAMENT_STATUS.AUCTION_LIVE
          });
          const liveRoster = Suites._seedRoster(live.tid,
            [{ serial_no: 1, name: 'ZZ Late Payer' }]);

          const liveBefore = Cache.getVersion(live.tid);
          T.assertEqual(typeof liveBefore, 'number',
            'precondition: the version is a number, got ' + T._fmt(liveBefore));

          Suites._call('payment.verify',
            { paymentId: liveRoster.payments[0].payment_id }, admin);

          const liveAfter = Cache.getVersion(live.tid);
          T.assert(liveAfter > liveBefore,
            'AUCTION_LIVE: the version must move so the projector refetches the pool. ' +
            'It stayed at ' + liveBefore + '.');

          // The other half. Nothing is polling during registration, so bumping on
          // every verification would just churn the counter for 400 players.
          const reg = Suites._seedTournament('pvreg', {
            withFolders: false, status: ENUM.TOURNAMENT_STATUS.REG_OPEN
          });
          const regRoster = Suites._seedRoster(reg.tid,
            [{ serial_no: 1, name: 'ZZ Early Payer' }]);

          const regBefore = Cache.getVersion(reg.tid);
          Suites._call('payment.verify',
            { paymentId: regRoster.payments[0].payment_id }, admin);

          T.assertEqual(Cache.getVersion(reg.tid), regBefore,
            'REG_OPEN: the version must NOT move. Expected it to stay at ' + regBefore + '.');

          // And the decision itself still landed, so the assertion above is not
          // passing because verify quietly failed.
          T.assertEqual(
            Repo.findBy(SHEETS.PAYMENTS, 'payment_id', regRoster.payments[0].payment_id).status,
            PS.VERIFIED, 'the payment was still verified either way');
        });
    });
  },

  // ===========================================================================
  // Organiser — CONTRACTS-PHASE3.md §1. Rationale: DESIGN.md §5.4, §15, §16 risk 3.
  //
  // This suite is mostly about ONE SECRET: the one-time join token. It exists in
  // exactly one place — the response to organiser.create and organiser.resendLink
  // — and only its SHA-256 digest is ever written down. Three of the tests below
  // are there to make that unfalsifiable rather than merely intended: the stored
  // cell is compared against Util.sha256Hex(token), every cell of every tab is
  // scanned for the plain value, and organiser.list is checked on the serialised
  // wire rather than on its key names.
  //
  // A note on the clock. Auth.newJoinToken / isJoinPending / redeemJoinToken all
  // compare against Date.now() directly, not Util.nowIso(), so Suites._withFakeNow
  // CANNOT move a join-link expiry. An expiry test written with a fake clock would
  // pass whether or not the check exists, which is worse than no test. The expired
  // fixture therefore has its stored join_expires_at moved into the past instead.
  // ===========================================================================

  organiser() {
    T.suite('Organiser', function () {
      const admin = Suites._adminSession('orgadm');
      const fx = {};

      /** The tournament the fixture organisers belong to. */
      function home() {
        if (!fx.home) fx.home = Suites._seedTournament('orghome', { withFolders: false });
        return fx.home;
      }

      /** A second tournament, so "only your own tournament" is testable. */
      function other() {
        if (!fx.other) fx.other = Suites._seedTournament('orgothr', { withFolders: false });
        return fx.other;
      }

      /**
       * Create one organiser through the real action and keep the plain token.
       * @param {string} tag makes the fixture email unique within the run
       * @param {string=} tournamentId defaults to the home tournament
       * @return {{email:string, out:!Object, token:string, row:!Object}}
       */
      function invite(tag, tournamentId) {
        const email = Suites._fixtureEmail(tag);
        const out = Suites._call('organiser.create', {
          tournamentId: tournamentId || home().tid,
          email: email,
          displayName: 'ZZ Organiser ' + tag
        }, admin);
        // organiser.create mints its own user_id, so cleanup has to be told about
        // it before the Users row is the only place it exists.
        T._state.userIds.push(out.user_id);
        return {
          email: email,
          out: out,
          token: Suites._joinToken(out.joinUrl),
          row: Repo.findBy(SHEETS.USERS, 'user_id', out.user_id)
        };
      }

      /** Redeem a join link through the real PUBLIC action. */
      function join(token, password) {
        return Suites._call('auth.organiserJoin',
          { token: token, password: password, ua: 'zz-test-agent' }, null);
      }

      // -----------------------------------------------------------------------
      // Routing
      // -----------------------------------------------------------------------

      T.test('every organiser action is ADMIN-only over POST, and join is PUBLIC POST',
        function () {
          ['organiser.create', 'organiser.list', 'organiser.resendLink', 'organiser.disable']
            .forEach(name => {
              const r = Suites._route(name);
              T.assert(r.methods.indexOf('POST') !== -1, name + ' must accept POST');
              T.assert(r.methods.indexOf('GET') === -1,
                name + ' must not be reachable over GET — organiser.create hands back a ' +
                'one-time credential, and a GET route is callable from a link with no token');
              T.assert(r.auth !== 'PUBLIC', name + ' must never be PUBLIC');
              T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN),
                name + ' must allow ADMIN, got auth = ' + T._fmt(r.auth));
              T.assert(!Suites._authAllows(r.auth, ENUM.USER_ROLE.ORGANISER),
                name + ' is ADMIN only (CONTRACTS-PHASE3 §1). An organiser who could ' +
                'call resendLink could mint a fresh credential for a colleague. Got ' +
                'auth = ' + T._fmt(r.auth));
            });

          const joinRoute = Suites._route('auth.organiserJoin');
          T.assertEqual(joinRoute.auth, 'PUBLIC',
            'auth.organiserJoin has to be PUBLIC: the organiser has no account yet, so ' +
            'there is no session token to authenticate with. The one-time token in the ' +
            'payload is the credential.');
          T.assert(joinRoute.methods.indexOf('POST') !== -1,
            'auth.organiserJoin must accept POST');
          T.assert(joinRoute.methods.indexOf('GET') === -1,
            'auth.organiserJoin must NOT accept GET. On GET the join token would travel ' +
            'in the query string and land in browser history, referrers and server logs ' +
            '(DESIGN.md §5.3).');
        });

      // -----------------------------------------------------------------------
      // The secret — CONTRACTS-PHASE3 §1 rule 2
      // -----------------------------------------------------------------------

      T.test('create stores only the SHA-256 digest; the joinUrl carries the plain token',
        function () {
          const f = invite('mint');
          const token = f.token;

          T.assert(typeof token === 'string' && token.length > 0,
            'the joinUrl must carry a ?k= token, got ' + T._fmt(f.out.joinUrl));
          T.assert(f.out.joinUrl.indexOf(ORGANISER_JOIN_PATH + '?k=') !== -1,
            'the link must point at ' + ORGANISER_JOIN_PATH + ', got ' +
            T._fmt(f.out.joinUrl));
          // 32 random bytes rendered as hex is 64 characters (CONTRACTS-PHASE3 §1).
          T.assert(token.length >= 32,
            'a 32-byte token cannot be this short: ' + token.length + ' characters');

          // ======================= THE ONE THAT MATTERS =======================
          // If the spreadsheet leaks, nothing in it may be redeemable. The stored
          // cell must be the digest of the token and never the token itself.
          // ====================================================================
          T.assertEqual(f.row.join_token_hash, Util.sha256Hex(token),
            'the Users row must store Util.sha256Hex(token). A hash that does not ' +
            'match means either the plain token was written down or the redeem path ' +
            'is hashing something else and no link will ever work.');
          T.assert(f.row.join_token_hash !== token,
            'the stored value must not BE the token');

          T.assertEqual(f.row.role, ENUM.USER_ROLE.ORGANISER, 'the row is an ORGANISER');
          T.assertEqual(f.row.status, ENUM.USER_STATUS.ACTIVE, 'and starts ACTIVE');
          T.assertEqual(f.row.tournament_id, home().tid,
            'locked to exactly one tournament (DESIGN.md §15)');
          T.assertEqual(Util.isBlank(f.row.password_hash), true,
            'there is no password until the link is redeemed — a blank hash can never ' +
            'authenticate, which is what makes the un-redeemed account safe');
          T.assertEqual(Util.isBlank(f.row.salt), true, 'and no salt either');
          T.assertEqual(f.row.join_used_at, '', 'the link is unused');

          // 72 hours (CONTRACTS-PHASE3 §1 rule 4). Measured against the real clock
          // on purpose: newJoinToken() calls Date.now(), so a fake clock would not
          // move this and the assertion would prove nothing.
          const ttlMs = Date.parse(f.out.joinExpiresAt) - Date.now();
          T.assertClose(ttlMs, Auth.JOIN_TOKEN_TTL_HOURS * 3600 * 1000, 5 * 60 * 1000,
            'the link must live ' + Auth.JOIN_TOKEN_TTL_HOURS + ' hours — long enough to ' +
            'survive a weekend, short enough to matter');
          T.assertEqual(f.out.joinExpiresAtDisplay, Util.formatIST(f.out.joinExpiresAt),
            'the admin has to tell somebody when the link dies, so the display form is ' +
            'the IST wording of the same instant');

          T.assertEqual(f.out.email, f.email.toLowerCase(), 'the email is echoed, normalised');
          T.assertEqual(f.out.tournament_id, home().tid, 'and the tournament');

          // Audited, without the secret in it.
          const rows = Suites._auditRows(f.out.user_id, Audit.ACTIONS.ORGANISER_CREATED);
          T.assertEqual(rows.length, 1, 'exactly one ORGANISER_CREATED row');
          T.assertEqual(rows[0].tournament_id, home().tid, 'naming the tournament');
          T.assert(JSON.stringify(rows[0]).indexOf(token) === -1,
            'the audit row must not carry the plain token. The trail records that a ' +
            'link was issued, never the secret that makes it usable.');
        });

      T.test('the plain token appears in NO cell of ANY tab', function () {
        // Broader than checking the Users row: a well-meaning "let us log the link
        // so support can resend it" would put the token in AuditLog or Config, and
        // a check aimed only at Users would not see it.
        const f = invite('nocell');
        const token = f.token;
        let cellsScanned = 0;

        Object.keys(SHEETS).forEach(key => {
          const tab = SHEETS[key];
          let rows = [];
          try {
            rows = Repo.readAll(tab);
          } catch (e) {
            T._fail('could not read the ' + tab + ' tab to scan it: ' + T._errText(e));
          }
          rows.forEach(row => {
            Object.keys(row).forEach(col => {
              const cell = row[col];
              if (typeof cell !== 'string' || !cell) return;
              cellsScanned++;
              T.assert(cell.indexOf(token) === -1,
                'the plain join token is sitting in ' + tab + '.' + col + '. ' +
                'CONTRACTS-PHASE3 §1 rule 2: it exists in the create response and ' +
                'nowhere else, so that a leaked spreadsheet contains nothing redeemable.');
            });
          });
        });

        T.assert(cellsScanned > 0,
          'the scan read no cells at all, so it proved nothing');
      });

      T.test('list returns the contracted fields and never the token or its hash',
        function () {
          const f = invite('listed');
          const rows = Suites._call('organiser.list', { tournamentId: home().tid }, admin);
          T.assert(Array.isArray(rows), 'organiser.list must return an array');

          const mine = rows.filter(r => r.user_id === f.out.user_id);
          T.assertEqual(mine.length, 1, 'the organiser just created must be in the list');

          T.assertEqual(Object.keys(mine[0]).sort(), [
            'created_at', 'display_name', 'email', 'joinPending', 'last_login_at',
            'status', 'user_id'
          ], 'the row shape is pinned by CONTRACTS-PHASE3 §1. An extra key here is how ' +
             'join_token_hash ends up on an admin screen and then in a screenshot.');

          T.assertEqual(mine[0].joinPending, true,
            'joinPending is the one safe fact about a token: it is unused and unexpired');
          T.assertEqual(mine[0].status, ENUM.USER_STATUS.ACTIVE, 'and the account is active');

          // Key names are only half of it — assert on the serialised wire.
          const wire = JSON.stringify(rows);
          T.assert(wire.indexOf(f.token) === -1,
            'the plain join token is somewhere in the organiser.list response');
          T.assert(wire.indexOf(Util.sha256Hex(f.token)) === -1,
            'the join token HASH is in the organiser.list response. It is not directly ' +
            'redeemable, but it is the value an offline search would be run against and ' +
            'CONTRACTS-PHASE3 §1 says never return it.');
          ['join_token_hash', 'password_hash', 'salt', 'join_expires_at']
            .forEach(needle => {
              T.assert(wire.indexOf(needle) === -1,
                'organiser.list carries the key "' + needle + '"');
            });
        });

      T.test('create refuses a duplicate email and an unknown tournament', function () {
        const f = invite('dupe');
        const before = Repo.count(SHEETS.USERS, {});

        T.assertThrows(() => Suites._call('organiser.create', {
          tournamentId: home().tid, email: f.email, displayName: 'ZZ Second Try'
        }, admin), ERR.VALIDATION_FAILED, 'the same email twice');

        T.assertThrows(() => Suites._call('organiser.create', {
          // Case-insensitive: Auth._normEmail lowercases, and two accounts that
          // differ only in case would both match at login.
          tournamentId: home().tid, email: f.email.toUpperCase(), displayName: 'ZZ Shouty'
        }, admin), ERR.VALIDATION_FAILED, 'the same email in capitals');

        T.assertThrows(() => Suites._call('organiser.create', {
          tournamentId: 'TRN_zzzzzzzzzzzz', email: Suites._fixtureEmail('ghost'),
          displayName: 'ZZ Ghost'
        }, admin), ERR.NOT_FOUND,
          'an organiser for a tournament that does not exist is an account nobody can use');

        T.assertThrows(() => Suites._call('organiser.create', {
          tournamentId: home().tid, email: 'not-an-email', displayName: 'ZZ Bad Email'
        }, admin), ERR.VALIDATION_FAILED, 'an address with no @');

        T.assertThrows(() => Suites._call('organiser.create', {
          tournamentId: home().tid, email: Suites._fixtureEmail('noname'), displayName: '  '
        }, admin), ERR.VALIDATION_FAILED, 'a blank display name');

        T.assertEqual(Repo.count(SHEETS.USERS, {}), before,
          'not one of those refusals may leave a Users row behind');
      });

      // -----------------------------------------------------------------------
      // Redeeming — CONTRACTS-PHASE3 §1, auth.organiserJoin
      // -----------------------------------------------------------------------

      T.test('a join link works exactly once', function () {
        const f = invite('once');

        const first = join(f.token, TEST_FIXTURES.PASSWORD);
        T.assert(first && typeof first.token === 'string' && first.token.length > 0,
          'redeeming must return a real session token, got ' + T._fmt(first));
        T.assertEqual(first.user.user_id, f.out.user_id, 'for the right user');
        T.assertEqual(first.user.role, ENUM.USER_ROLE.ORGANISER, 'with the ORGANISER role');
        T.assertEqual(first.user.tournament_id, home().tid, 'scoped to their tournament');
        T.assert(!isNaN(Date.parse(first.expiresAt)),
          'and a parseable expiry, got ' + T._fmt(first.expiresAt));
        Suites._assertNoSecrets(first, 'the organiserJoin response');
        T.assert(JSON.stringify(first).indexOf(f.token) === -1,
          'the join token must not be echoed back in the session response');

        const row = Repo.findBy(SHEETS.USERS, 'user_id', f.out.user_id);
        T.assertEqual(row.join_token_hash, '',
          'the token must be BURNED in the same locked section that sets the password. ' +
          'A token that survives its own use is a permanent back door.');
        T.assert(!Util.isBlank(row.join_used_at),
          'and join_used_at records that it happened, got ' + T._fmt(row.join_used_at));
        T.assert(!Util.isBlank(row.password_hash), 'the password is now set');
        T.assert(!Util.isBlank(row.salt), 'with its own salt');

        // The second attempt with the very same link.
        T.assertThrows(() => join(f.token, 'AnotherPassw0rd!'), ERR.UNAUTHORIZED,
          'the same link a second time must be refused');

        const after = Repo.findBy(SHEETS.USERS, 'user_id', f.out.user_id);
        T.assertEqual(after.password_hash, row.password_hash,
          'and the refused second attempt must not have changed the password');

        // joinPending is now false, which is the only thing the admin list may say.
        const listed = Suites._call('organiser.list', { tournamentId: home().tid }, admin)
          .filter(r => r.user_id === f.out.user_id)[0];
        T.assertEqual(listed.joinPending, false, 'the link is no longer pending');

        // Audited as a join (CONTRACTS-PHASE3 §1 rule 4).
        const joined = Suites._auditRows(f.out.user_id, Audit.ACTIONS.ORGANISER_CREATED)
          .map(r => Util.safeJsonParse(r.new_value, {}))
          .filter(v => v && v.joined === true);
        T.assertEqual(joined.length, 1,
          'exactly one audit row marked joined:true (CONTRACTS-PHASE3 §1 rule 4)');
      });

      T.test('expired, garbage, blank and already-used all give the IDENTICAL message',
        function () {
          // ========================= THE SECURITY TEST =========================
          // A message that distinguishes "already used" from "no such token" tells
          // an attacker which tokens exist. That is the same enumeration oracle
          // Auth.BAD_CREDENTIALS_MSG closes on the login path, and the four
          // branches below must be indistinguishable from outside.
          // =====================================================================

          // Already used.
          const used = invite('used');
          join(used.token, TEST_FIXTURES.PASSWORD);
          const usedErr = T.assertThrows(() => join(used.token, TEST_FIXTURES.PASSWORD),
            ERR.UNAUTHORIZED, 'a link that has already been redeemed');

          // Expired. The stored instant is moved into the past rather than the
          // clock being faked: Auth.redeemJoinToken compares against Date.now(),
          // so Suites._withFakeNow would not move this check and the test would
          // pass whether or not the expiry exists.
          const stale = invite('stale');
          Repo.updateRow(SHEETS.USERS, stale.row._row,
            { join_expires_at: '2020-01-01T00:00:00.000Z' });
          Repo.flush();
          const staleErr = T.assertThrows(() => join(stale.token, TEST_FIXTURES.PASSWORD),
            ERR.UNAUTHORIZED, 'a link that expired in 2020');
          T.assertEqual(
            Util.isBlank(Repo.findBy(SHEETS.USERS, 'user_id', stale.out.user_id).password_hash),
            true, 'and an expired link must not have set a password on the way past');

          // Garbage, and blank.
          const garbageErr = T.assertThrows(
            () => join('zz-this-token-was-never-issued-by-anything', TEST_FIXTURES.PASSWORD),
            ERR.UNAUTHORIZED, 'a token nobody ever issued');
          const blankErr = T.assertThrows(() => join('', TEST_FIXTURES.PASSWORD),
            ERR.UNAUTHORIZED, 'no token at all');

          T.assertEqual(staleErr.message, usedErr.message,
            'expired and already-used must read identically');
          T.assertEqual(garbageErr.message, usedErr.message,
            'unknown and already-used must read identically');
          T.assertEqual(blankErr.message, usedErr.message,
            'blank and already-used must read identically');
          T.assertEqual(usedErr.message, Auth.BAD_JOIN_LINK_MSG,
            'and all four must be the single generic sentence Auth.BAD_JOIN_LINK_MSG, ' +
            'which also has to tell the organiser what to do next');
          T.assert(String(usedErr.message).toLowerCase().indexOf('admin') !== -1,
            'the one message has to name the way out — ask the admin for a new link. ' +
            'Got "' + usedErr.message + '"');
        });

      T.test('a password under the minimum is refused and the link still works after',
        function () {
          const f = invite('weakpw');

          // CONTRACTS-PHASE3 §1 rule 2: identical to Auth.createUser.
          // The number itself is a tournament-owner decision, so this asserts
          // the RULE is applied rather than pinning a value that will change.
          T.assert(Auth.MIN_PASSWORD_LEN >= 1,
            'there is a minimum password length and every check reads it');

          const nine = 'zzShort9!';
          T.assertEqual(nine.length, 9, 'fixture check: the weak password is 9 characters');
          T.assertThrows(() => join(f.token, nine), ERR.VALIDATION_FAILED,
            'nine characters is under the minimum');
          T.assertThrows(() => join(f.token, ''), ERR.VALIDATION_FAILED,
            'and a blank password is not a password');

          // ================== THE HALF THAT IS EASY TO GET WRONG ================
          // The password is validated INSIDE the lock but BEFORE anything is
          // written, so a rejected password must leave the link fully usable. If
          // the token were burned first, one typo would lock the organiser out
          // permanently and the only way back would be an admin resend.
          // ======================================================================
          const mid = Repo.findBy(SHEETS.USERS, 'user_id', f.out.user_id);
          T.assertEqual(mid.join_token_hash, Util.sha256Hex(f.token),
            'the token must survive a rejected password');
          T.assertEqual(mid.join_used_at, '', 'and must not be marked used');
          T.assertEqual(Util.isBlank(mid.password_hash), true, 'and no password was set');

          const ten = 'zzTenChar1';
          T.assertEqual(ten.length, 10, 'fixture check: exactly at the boundary');
          const ok = join(f.token, ten);
          T.assert(ok && ok.token,
            'a password of exactly MIN_PASSWORD_LEN is allowed: the rule is >= not >');

          // And the password that was set is the one that now signs them in.
          const login = Auth.login(f.email, ten, 'zz-test-agent');
          T.assertEqual(login.user.user_id, f.out.user_id,
            'the password chosen at join must be the one that works at login');
        });

      T.test('resendLink invalidates the previous token', function () {
        const f = invite('resend');
        const first = f.token;

        const again = Suites._call('organiser.resendLink', { userId: f.out.user_id }, admin);
        const second = Suites._joinToken(again.joinUrl);
        T.assert(second !== first, 'a resend must mint a NEW token, not repeat the old one');

        const row = Repo.findBy(SHEETS.USERS, 'user_id', f.out.user_id);
        T.assertEqual(row.join_token_hash, Util.sha256Hex(second),
          'the stored digest must be the new token\'s');
        T.assert(row.join_token_hash !== Util.sha256Hex(first),
          'and no longer the old one\'s');

        // The whole point: the link that got lost or forwarded stops working.
        const oldErr = T.assertThrows(() => join(first, TEST_FIXTURES.PASSWORD),
          ERR.UNAUTHORIZED, 'the superseded link must be dead');
        T.assertEqual(oldErr.message, Auth.BAD_JOIN_LINK_MSG,
          'and it must fail with the same generic sentence as everything else');

        const ok = join(second, TEST_FIXTURES.PASSWORD);
        T.assertEqual(ok.user.user_id, f.out.user_id, 'while the new link works');

        T.assertEqual(
          Suites._auditRows(f.out.user_id, Audit.ACTIONS.ORGANISER_LINK_RESENT).length, 1,
          'a resend is audited: it is also the admin\'s password-reset path, so who ' +
          'triggered it has to be answerable (CONTRACTS-PHASE3 §1)');

        // A disabled account must not be handed a working link — that would
        // silently undo the disable.
        Suites._call('organiser.disable', { userId: f.out.user_id }, admin);
        T.assertThrows(() => Suites._call('organiser.resendLink',
          { userId: f.out.user_id }, admin), ERR.VALIDATION_FAILED,
          're-enabling has to be a deliberate, separate decision');
      });

      // -----------------------------------------------------------------------
      // disable — CONTRACTS-PHASE3 §1
      // -----------------------------------------------------------------------

      T.test('disable revokes live sessions, blocks login and kills an outstanding link',
        function () {
          const f = invite('kill');
          const session = join(f.token, TEST_FIXTURES.PASSWORD);
          const token = session.token;

          T.assert(Auth.resolve(token) !== null,
            'precondition: the session must be live before it is revoked');
          T.assertEqual(Suites._dispatch('auth.me', {}, token, 'POST').ok, true,
            'precondition: and usable through the real dispatcher');

          const out = Suites._call('organiser.disable', { userId: f.out.user_id }, admin);
          T.assertEqual(out.status, ENUM.USER_STATUS.DISABLED, 'the status comes back');
          T.assert(out.sessions_revoked >= 1,
            'at least the session created at join must be revoked, got ' +
            T._fmt(out.sessions_revoked));

          const row = Repo.findBy(SHEETS.USERS, 'user_id', f.out.user_id);
          T.assert(row !== null,
            'the row is never deleted — the audit trail references actor_user_id and a ' +
            'deleted user turns every row that names them into an unresolvable id');
          T.assertEqual(row.status, ENUM.USER_STATUS.DISABLED, 'and it says DISABLED');
          T.assertEqual(row.join_token_hash, '',
            'any outstanding join link is voided too: an unredeemed link on a disabled ' +
            'account is a way back in');

          // ==================== THE ONE THAT MATTERS ==========================
          // Status alone is not enough. Auth.resolve reads the Sessions row, not
          // the Users row, so a live token would keep working for up to twelve
          // more hours — most of an auction.
          // ====================================================================
          T.assertEqual(Auth.resolve(token), null,
            'the existing session must stop resolving the instant the account is ' +
            'disabled, not when its twelve hours run out');

          const refused = Suites._dispatch('auth.me', {}, token, 'POST');
          T.assertEqual(refused.ok, false, 'and the dispatcher must refuse it');
          T.assertEqual(refused.error.code, ERR.UNAUTHORIZED,
            'a dead token is UNAUTHORIZED (CONTRACTS.md §3)');

          const loginErr = T.assertThrows(
            () => Auth.login(f.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent'),
            ERR.UNAUTHORIZED, 'and signing in again must not work either');
          T.assertEqual(loginErr.message, Auth.BAD_CREDENTIALS_MSG,
            'a disabled account gets the same sentence as a wrong password — saying ' +
            '"this account is disabled" confirms the address exists');

          T.assertEqual(
            Suites._auditRows(f.out.user_id, Audit.ACTIONS.ORGANISER_DISABLED).length, 1,
            'exactly one ORGANISER_DISABLED row');

          // Safe to call twice.
          let threw = null;
          try {
            Suites._call('organiser.disable', { userId: f.out.user_id }, admin);
          } catch (e) {
            threw = e;
          }
          T.assert(threw === null,
            'disabling an already-disabled account is not an error, got ' + T._errText(threw));
        });

      // -----------------------------------------------------------------------
      // Scope — DESIGN.md §5.4, the boundary Auth.requireTournament defends
      // -----------------------------------------------------------------------

      T.test('an organiser can only reach their own tournament', function () {
        const f = invite('scope');
        const session = join(f.token, TEST_FIXTURES.PASSWORD);
        const token = session.token;
        const mine = home().tid;
        const theirs = other().tid;

        // Through the real front door, because that is where the role check lives.
        const own = Suites._dispatch('team.list', { tournamentId: mine }, token, 'POST');
        T.assertEqual(own.ok, true,
          'an organiser must be able to work in their own tournament, got ' +
          T._fmt(own.error));

        const across = Suites._dispatch('team.list', { tournamentId: theirs }, token, 'POST');
        T.assertEqual(across.ok, false,
          'reading another tournament\'s teams must be refused. Auth.requireTournament ' +
          'is the only thing standing between one organiser and another organiser\'s ' +
          'data (DESIGN.md §5.4).');
        T.assertEqual(across.error.code, ERR.FORBIDDEN,
          'a valid token pointed at the wrong tournament is FORBIDDEN, not UNAUTHORIZED ' +
          '(CONTRACTS.md §3)');
        T.assert(JSON.stringify(across).indexOf(theirs) === -1 ||
          String(across.error.message).indexOf('team') === -1,
          'the refusal must not describe the other tournament\'s contents');

        // Blank scope fails closed, rather than matching everything.
        const blank = Suites._dispatch('team.list', { tournamentId: '' }, token, 'POST');
        T.assertEqual(blank.ok, false, 'a missing tournament id must fail, not fall through');

        // And the ADMIN-only surface stays shut to them.
        ['organiser.list', 'organiser.create', 'organiser.resendLink', 'organiser.disable']
          .forEach(action => {
            const res = Suites._dispatch(action, { tournamentId: mine }, token, 'POST');
            T.assertEqual(res.ok, false, action + ' must be refused to an organiser');
            T.assertEqual(res.error.code, ERR.FORBIDDEN,
              action + ' with a valid organiser token is FORBIDDEN');
          });
      });
    });
  },

  // ===========================================================================
  // Teams — CONTRACTS-PHASE3.md §2, §3, §4. Rationale: DESIGN.md §6.4, §17, §31.
  //
  // Two ideas run through the whole suite.
  //
  //   1. NOTHING IS FROZEN. Purse, squad size and name all stay changeable, and
  //      the only rejections are the ones that would make existing data
  //      contradictory. So every guard test also asserts the exact boundary value
  //      is ALLOWED — a rule of "not below X" that quietly means "below or equal
  //      to X" blocks a legitimate correction mid-auction.
  //
  //   2. purse_used AND players_count ARE A CACHE. AuctionResults is the truth
  //      (DESIGN.md §2.6). Phase 3 only ever writes zeros, so the fixtures that
  //      need a non-zero counter set it through Repo directly and say so — going
  //      through an action would mean running a Phase 4 sale to test a Phase 3
  //      guard.
  // ===========================================================================

  teams() {
    T.suite('Teams', function () {
      const admin = Suites._adminSession('tmadm');
      const fx = {};

      /** A tournament carrying the seeded defaults: purse 1000000, squad 14. */
      function defaults() {
        if (!fx.defaults) fx.defaults = Suites._seedTournament('tmdef', { withFolders: false });
        return fx.defaults;
      }

      // -----------------------------------------------------------------------
      // Routing
      // -----------------------------------------------------------------------

      T.test('team actions are POST-only, with delete and recount reserved to ADMIN',
        function () {
          ['team.create', 'team.createBatch', 'team.list', 'team.squad', 'team.update']
            .forEach(name => {
              const r = Suites._route(name);
              T.assert(r.methods.indexOf('POST') !== -1, name + ' must accept POST');
              T.assert(r.methods.indexOf('GET') === -1, name + ' must not be offered on GET');
              T.assert(r.auth !== 'PUBLIC', name + ' must never be PUBLIC');
              T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN),
                name + ' must allow ADMIN, got auth = ' + T._fmt(r.auth));
              T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ORGANISER),
                name + ' must allow ORGANISER — building the 8 teams is the organiser\'s ' +
                'job (CONTRACTS-PHASE3 §2). Got auth = ' + T._fmt(r.auth));
            });

          ['team.delete', 'team.recount'].forEach(name => {
            const r = Suites._route(name);
            T.assert(r.methods.indexOf('POST') !== -1, name + ' must accept POST');
            T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN),
              name + ' must allow ADMIN, got auth = ' + T._fmt(r.auth));
            T.assert(!Suites._authAllows(r.auth, ENUM.USER_ROLE.ORGANISER),
              name + ' is ADMIN only: a delete cannot be undone from the UI and a ' +
              'recount overwrites live counters. Got auth = ' + T._fmt(r.auth));
          });
        });

      // -----------------------------------------------------------------------
      // create — CONTRACTS-PHASE3 §2
      // -----------------------------------------------------------------------

      T.test('create falls back to the tournament defaults, and takes explicit values',
        function () {
          const t = defaults();
          const trn = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', t.tid);
          T.assertEqual(trn.default_purse, 1000000, 'fixture check: the tournament default purse');
          T.assertEqual(trn.default_max_players, 14, 'fixture check: the default squad size');

          const fell = Suites._call('team.create',
            { tournamentId: t.tid, teamName: 'ZZ Falls Back' }, admin);
          T.assertEqual(fell.purse_total, 1000000,
            'an omitted purseTotal must take default_purse — that is what the column is ' +
            'for, so an organiser creating 8 equal-purse teams types the figure once ' +
            '(DESIGN.md §6.4)');
          T.assertEqual(fell.max_players, 14, 'and an omitted maxPlayers takes the default');
          T.assertEqual(fell.purse_used, 0, 'a new team has spent nothing');
          T.assertEqual(fell.players_count, 0, 'and bought nobody');
          T.assertEqual(fell.team_id.slice(0, ID_PREFIX.TEAM.length), ID_PREFIX.TEAM,
            'team_id prefix (CONTRACTS.md §4)');

          const given = Suites._call('team.create', {
            tournamentId: t.tid, teamName: '  ZZ   Explicit  Team  ',
            ownerName: 'ZZ Owner', purseTotal: 750000, maxPlayers: 12
          }, admin);
          T.assertEqual(given.purse_total, 750000, 'an explicit purse wins over the default');
          T.assertEqual(given.max_players, 12, 'and an explicit squad size');
          T.assertEqual(given.team_name, 'ZZ Explicit Team',
            'whitespace runs are collapsed for storage, but the organiser\'s own ' +
            'capitalisation is kept — only the matching is normalised');
          T.assertEqual(given.owner_name, 'ZZ Owner', 'the optional owner is stored');

          const row = Repo.findBy(SHEETS.TEAMS, 'team_id', given.team_id);
          T.assertEqual(row.purse_used, 0, 'the stored counters start at zero');
          T.assertEqual(row.players_count, 0, 'both of them');
          T.assertEqual(row.tournament_id, t.tid, 'and the row is scoped to the tournament');

          T.assertEqual(Suites._auditRows(given.team_id, Audit.ACTIONS.TEAM_CREATED).length, 1,
            'exactly one TEAM_CREATED row');

          // The field-level rules from CONTRACTS-PHASE3 §2.
          [[{ teamName: 'Z' }, 'a one-character name is under the 2-char minimum'],
           [{ teamName: 'Z'.repeat(41) }, '41 characters is over the 40-char maximum'],
           [{ teamName: '   ' }, 'whitespace is not a name'],
           [{ teamName: 'ZZ Zero Squad', maxPlayers: 0 }, 'a squad size of 0'],
           [{ teamName: 'ZZ Frac Squad', maxPlayers: '12.7' }, 'a fractional squad size']
          ].forEach(pair => {
            const payload = { tournamentId: t.tid };
            Object.keys(pair[0]).forEach(k => { payload[k] = pair[0][k]; });
            T.assertThrows(() => Suites._call('team.create', payload, admin),
              ERR.VALIDATION_FAILED, pair[1]);
          });
          [[{ teamName: 'ZZ Free Team', purseTotal: 0 }, 'a purse of zero'],
           [{ teamName: 'ZZ Debt Team', purseTotal: -1 }, 'a negative purse']
          ].forEach(pair => {
            const payload = { tournamentId: t.tid };
            Object.keys(pair[0]).forEach(k => { payload[k] = pair[0][k]; });
            T.assertThrows(() => Suites._call('team.create', payload, admin),
              ERR.INVALID_AMOUNT, pair[1]);
          });
        });

      T.test('a name that differs only by case or whitespace is a duplicate', function () {
        // Two teams whose names differ by a stray space are indistinguishable on a
        // projector screen, so they must not both exist (CONTRACTS-PHASE3 §2).
        const t = Suites._seedTournament('tmdupe', { withFolders: false });
        Suites._call('team.create',
          { tournamentId: t.tid, teamName: 'Chennai Warriors' }, admin);
        const before = Repo.count(SHEETS.TEAMS, { tournament_id: t.tid });

        ['Chennai Warriors', 'chennai warriors', 'CHENNAI WARRIORS',
         'Chennai  Warriors', '  Chennai Warriors  '].forEach(name => {
          const e = T.assertThrows(() => Suites._call('team.create',
            { tournamentId: t.tid, teamName: name }, admin),
            ERR.VALIDATION_FAILED, '"' + name + '" is the same team');
          T.assert(String(e.message).indexOf('Chennai Warriors') !== -1,
            'the message has to name the team that clashes so the organiser can see ' +
            'which one, got "' + e.message + '"');
        });

        // A near miss is a different team and must go through.
        Suites._call('team.create',
          { tournamentId: t.tid, teamName: 'ChennaiWarriors' }, admin);

        T.assertEqual(Repo.count(SHEETS.TEAMS, { tournament_id: t.tid }), before + 1,
          'five refusals and one genuine create must leave exactly one new row');

        // Uniqueness is PER TOURNAMENT, not global.
        const elsewhere = Suites._seedTournament('tmdupe2', { withFolders: false });
        let threw = null;
        try {
          Suites._call('team.create',
            { tournamentId: elsewhere.tid, teamName: 'Chennai Warriors' }, admin);
        } catch (e) {
          threw = e;
        }
        T.assert(threw === null,
          'the same team name in a DIFFERENT tournament is fine, got ' + T._errText(threw));
      });

      // -----------------------------------------------------------------------
      // createBatch — the main path, and the all-or-nothing rule
      // -----------------------------------------------------------------------

      T.test('a batch with a duplicate at position 7 writes NOTHING', function () {
        // ======================= THE ONE THAT MATTERS =========================
        // Half a batch is worse than none: the organiser then has to work out
        // which of their 8 names got through before retrying. The whole batch is
        // validated before any of it is written (CONTRACTS-PHASE3 §2).
        // ======================================================================
        const t = Suites._seedTournament('tmbatch', { withFolders: false });
        const count = () => Repo.count(SHEETS.TEAMS, { tournament_id: t.tid });
        T.assertEqual(count(), 0, 'fixture check: the tournament starts with no teams');

        // Case 1: the clash is inside the batch itself, at position 7.
        const selfClash = ['ZZ Batch One', 'ZZ Batch Two', 'ZZ Batch Three', 'ZZ Batch Four',
          'ZZ Batch Five', 'ZZ Batch Six', 'zz  batch   two', 'ZZ Batch Eight'];
        const e1 = T.assertThrows(() => Suites._call('team.createBatch',
          { tournamentId: t.tid, names: selfClash, purseTotal: 500000, maxPlayers: 13 }, admin),
          ERR.VALIDATION_FAILED, 'names 2 and 7 are the same team');
        T.assert(String(e1.message).indexOf('7') !== -1,
          'the message must say WHICH position is wrong, got "' + e1.message + '"');
        T.assertEqual(count(), 0,
          'a duplicate at position 7 must not leave 6 teams created. The row count is ' +
          'still the only honest way to check that.');

        // Case 2: the clash is against a team that already exists — a different
        // code path, because that check happens inside the lock.
        Suites._call('team.create', { tournamentId: t.tid, teamName: 'ZZ Batch Seven' }, admin);
        T.assertEqual(count(), 1, 'one team now exists');

        const existingClash = selfClash.slice();
        existingClash[6] = 'zz batch  seven';
        const e2 = T.assertThrows(() => Suites._call('team.createBatch',
          { tournamentId: t.tid, names: existingClash, purseTotal: 500000, maxPlayers: 13 },
          admin), ERR.VALIDATION_FAILED, 'name 7 collides with an existing team');
        T.assert(String(e2.message).indexOf('7') !== -1,
          'the message must name the position, got "' + e2.message + '"');
        T.assertEqual(count(), 1,
          'the clash was found in pass 2, inside the lock, and still nothing was written');

        // Case 3: a clean batch of 8 goes through in one go.
        const clean = ['ZZ Ok One', 'ZZ Ok Two', 'ZZ Ok Three', 'ZZ Ok Four',
          'ZZ Ok Five', 'ZZ Ok Six', 'ZZ Ok Seven', 'ZZ Ok Eight'];
        const out = Suites._call('team.createBatch',
          { tournamentId: t.tid, names: clean, purseTotal: 500000, maxPlayers: 13 }, admin);
        T.assertEqual(out.created.length, 8, 'all 8 come back');
        T.assertEqual(out.created.map(c => c.team_name), clean,
          'in the order they were typed');
        T.assertEqual(count(), 9, 'and 8 rows were added to the 1 already there');
        out.created.forEach(c => {
          T.assertEqual(c.purse_total, 500000, 'the shared purse is applied to every team');
          T.assertEqual(c.max_players, 13, 'and the shared squad size');
          T.assertEqual(c.purse_used, 0, 'counters start at zero');
          T.assertEqual(c.players_count, 0, 'both of them');
        });

        // One audit row PER TEAM, not one for the batch: the trail is read by
        // entity_id when somebody asks who set a team's purse (DESIGN.md §42).
        out.created.forEach(c => {
          T.assertEqual(Suites._auditRows(c.team_id, Audit.ACTIONS.TEAM_CREATED).length, 1,
            'team ' + c.team_name + ' needs its own TEAM_CREATED row');
        });

        // An empty list is a mistake, not an expensive no-op.
        T.assertThrows(() => Suites._call('team.createBatch',
          { tournamentId: t.tid, names: [] }, admin), ERR.VALIDATION_FAILED,
          'an empty names list');
        T.assertEqual(count(), 9, 'and it changed nothing');
      });

      // -----------------------------------------------------------------------
      // update — every guard in CONTRACTS-PHASE3 §2, plus both boundaries
      // -----------------------------------------------------------------------

      T.test('lowering the squad below players_count is refused, the exact count allowed',
        function () {
          const t = Suites._seedTournament('tmsquad', { withFolders: false });
          // The counters are set through Repo on purpose. Phase 3 only ever writes
          // zeros; Phase 4 maintains them inside the sale lock. This test is about
          // the guard, not about the sale that would produce the number.
          const team = Suites._seedTeam(t.tid, {
            team_name: 'Chennai Warriors', purse_total: 1000000, purse_used: 400000,
            max_players: 13, players_count: 12
          });

          const e = T.assertThrows(() => Suites._call('team.update',
            { teamId: team.team_id, maxPlayers: 11 }, admin),
            ERR.SQUAD_BELOW_COUNT, 'a limit of 11 with 12 players already bought');
          T.assert(String(e.message).indexOf('12') !== -1 &&
            String(e.message).indexOf('11') !== -1 &&
            String(e.message).indexOf('Chennai Warriors') !== -1,
            'the message must name the team, the current count and the value that was ' +
            'refused (DESIGN.md §6.4), got "' + e.message + '"');

          let after = Repo.findBy(SHEETS.TEAMS, 'team_id', team.team_id);
          T.assertEqual(after.max_players, 13, 'a refused change must leave the row alone');
          T.assertEqual(after.players_count, 12, 'and must not touch the counter either');

          // The boundary itself. "Not below players_count" has to mean exactly that.
          const ok = Suites._call('team.update',
            { teamId: team.team_id, maxPlayers: 12 }, admin);
          T.assertEqual(ok.max_players, 12,
            'a squad size EQUAL to the current count is legal: the team is full, not ' +
            'over-full. Refusing it would block a legitimate 13 -> 12 correction.');
          T.assertEqual(ok.slots_remaining, 0, 'and the team now has no slots left');
          T.assertEqual(ok.changed.max_players, { from: 13, to: 12 },
            'the response says what moved, so the confirmation can state the effect');

          // Raising is always free, including past the original value.
          const raised = Suites._call('team.update',
            { teamId: team.team_id, maxPlayers: 15 }, admin);
          T.assertEqual(raised.max_players, 15, 'raising a squad size is never guarded');

          after = Repo.findBy(SHEETS.TEAMS, 'team_id', team.team_id);
          T.assertEqual(after.max_players, 15, 'and the row followed');
          T.assertEqual(
            Suites._auditRows(team.team_id, Audit.ACTIONS.TEAM_UPDATED).length, 2,
            'two accepted changes, two audit rows — and the refusal wrote none');
        });

      T.test('lowering the purse below purse_used is refused, the exact spend allowed',
        function () {
          const t = Suites._seedTournament('tmpurse', { withFolders: false });
          const team = Suites._seedTeam(t.tid, {
            team_name: 'Madurai Kings', purse_total: 1000000, purse_used: 400000,
            max_players: 13, players_count: 4
          });

          const e = T.assertThrows(() => Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 399999 }, admin),
            ERR.PURSE_BELOW_SPENT, 'one rupee below what is already spent');
          T.assert(String(e.message).indexOf(Util.formatINR(400000)) !== -1,
            'the message must name the amount already spent (CONTRACTS-PHASE3 §2), got "' +
            e.message + '"');

          let after = Repo.findBy(SHEETS.TEAMS, 'team_id', team.team_id);
          T.assertEqual(after.purse_total, 1000000, 'a refused change must leave the row alone');
          T.assertEqual(after.purse_used, 400000, 'and must not touch the spend');

          const ok = Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 400000 }, admin);
          T.assertEqual(ok.purse_total, 400000,
            'a purse EXACTLY equal to what has been spent is legal — the team simply has ' +
            'nothing left, which is a real state and not a contradiction');
          T.assertEqual(ok.purse_remaining, 0, 'and nothing remains');
          T.assertEqual(ok.per_slot_remaining, 0,
            'with 9 slots and no money, the honest per-slot figure is 0');

          const raised = Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 2000000 }, admin);
          T.assertEqual(raised.purse_total, 2000000, 'raising a purse is never guarded');

          // A rename must still be unique, and a no-op is a no-op.
          Suites._seedTeam(t.tid, { team_name: 'ZZ Taken Name' });
          T.assertThrows(() => Suites._call('team.update',
            { teamId: team.team_id, teamName: 'zz  taken   name' }, admin),
            ERR.VALIDATION_FAILED, 'a rename onto an existing name');

          const same = Suites._call('team.update',
            { teamId: team.team_id, teamName: 'Madurai Kings' }, admin);
          T.assertEqual(same.changed, {},
            'saving the form without changing anything is a no-op success, not an error ' +
            '(DESIGN.md §15) — and nothing is audited, because nothing happened');

          after = Repo.findBy(SHEETS.TEAMS, 'team_id', team.team_id);
          T.assertEqual(after.purse_total, 2000000, 'the last accepted value stands');
          T.assertEqual(
            Suites._auditRows(team.team_id, Audit.ACTIONS.TEAM_UPDATED).length, 2,
            'two real changes, two rows: the refusals and the no-op wrote none');
        });

      // -----------------------------------------------------------------------
      // list — per_slot_remaining is the number that matters (DESIGN.md §6.5a)
      // -----------------------------------------------------------------------

      T.test('per_slot_remaining is floor(remaining / slots), and null for a full squad',
        function () {
          const t = Suites._seedTournament('tmslots', { withFolders: false });
          Suites._seedTeam(t.tid, {
            team_name: 'ZZ A Normal', purse_total: 1000000, purse_used: 400000,
            max_players: 13, players_count: 3
          });
          Suites._seedTeam(t.tid, {
            team_name: 'ZZ B Full', purse_total: 1000000, purse_used: 900000,
            max_players: 5, players_count: 5
          });
          Suites._seedTeam(t.tid, {
            team_name: 'ZZ C Broke', purse_total: 500000, purse_used: 500000,
            max_players: 10, players_count: 4
          });
          Suites._seedTeam(t.tid, {
            team_name: 'ZZ D Rounding', purse_total: 100, purse_used: 0,
            max_players: 3, players_count: 0
          });

          const res = Suites._call('team.list', { tournamentId: t.tid }, admin);
          const byName = {};
          res.teams.forEach(r => { byName[r.team_name] = r; });
          T.assertEqual(res.teams.length, 4, 'all four teams come back');

          const normal = byName['ZZ A Normal'];
          T.assertEqual(normal.purse_remaining, 600000, '1000000 - 400000');
          T.assertEqual(normal.slots_remaining, 10, '13 - 3');
          T.assertEqual(normal.per_slot_remaining, 60000, '600000 / 10');
          T.assertEqual(normal.per_slot_remaining_display, Util.formatINR(60000),
            'the display form is the same number, ₹-formatted');
          T.assertEqual(normal.purse_remaining_display, Util.formatINR(600000),
            'and so is purse_remaining_display');

          const full = byName['ZZ B Full'];
          T.assertEqual(full.slots_remaining, 0, 'a full squad has no slots left');
          T.assertEqual(full.per_slot_remaining, null,
            'null, not 0. "Nothing left to spend per slot" and "no slots left to spend ' +
            'on" are different facts and the dashboard renders them differently.');
          T.assertEqual(full.per_slot_remaining_display, '',
            'and the display form is blank, so the page decides how to word it');

          const broke = byName['ZZ C Broke'];
          T.assertEqual(broke.purse_remaining, 0, 'a team spent to exactly zero');
          T.assertEqual(broke.slots_remaining, 6, 'still has slots to fill');
          T.assertEqual(broke.per_slot_remaining, 0,
            'so per_slot_remaining is 0 — the honest number, and the one that tells the ' +
            'organiser this team is in trouble (DESIGN.md §6.5a)');
          T.assertEqual(broke.per_slot_remaining_display, Util.formatINR(0),
            'and it still renders, because 0 is a value');

          T.assertEqual(byName['ZZ D Rounding'].per_slot_remaining, 33,
            'floor(100 / 3) = 33, never 33.33 — money is whole rupees (CONTRACTS.md §1.6)');

          T.assertEqual(res.totals, {
            teams: 4,
            purse_total: 1000000 + 1000000 + 500000 + 100,
            purse_used: 400000 + 900000 + 500000 + 0,
            purse_remaining: 600000 + 100000 + 0 + 100,
            players_count: 3 + 5 + 4 + 0,
            slots_total: 13 + 5 + 10 + 3,
            slots_remaining: 10 + 0 + 6 + 3
          }, 'the totals row is the sum of the columns above it');

          T.assertEqual(Object.keys(res.teams[0]).sort(), [
            'logo_url', 'max_players', 'owner_name', 'per_slot_remaining',
            'per_slot_remaining_display', 'players_count', 'purse_remaining',
            'purse_remaining_display', 'purse_total', 'purse_total_display', 'purse_used',
            'purse_used_display', 'slots_remaining', 'team_id', 'team_name'
          ], 'the dashboard row shape is pinned by CONTRACTS-PHASE3 §2');
        });

      // -----------------------------------------------------------------------
      // delete — CONTRACTS-PHASE3 §2
      // -----------------------------------------------------------------------

      T.test('delete is refused while the team has players, and allowed when empty',
        function () {
          const t = Suites._seedTournament('tmdel', { withFolders: false });
          const occupied = Suites._seedTeam(t.tid, {
            team_name: 'ZZ Has Players', purse_used: 300000, players_count: 2
          });
          const empty = Suites._seedTeam(t.tid, { team_name: 'ZZ Is Empty' });
          const drifted = Suites._seedTeam(t.tid, { team_name: 'ZZ Drifted' });

          const e = T.assertThrows(() => Suites._call('team.delete',
            { teamId: occupied.team_id }, admin), ERR.TEAM_NOT_EMPTY,
            'deleting a team with a squad would orphan those players and charge their ' +
            'money against nothing');
          T.assert(String(e.message).indexOf('2') !== -1,
            'the message must say how many players are in the way, got "' + e.message + '"');
          T.assert(Repo.findBy(SHEETS.TEAMS, 'team_id', occupied.team_id) !== null,
            'and the row must still be there');

          // The second guard: the cached counter says zero but AuctionResults —
          // the truth — says otherwise. A delete cannot be undone from the UI, so
          // the extra read is worth it.
          Suites._seedResult(t.tid, {
            team_id: drifted.team_id, status: ENUM.RESULT_STATUS.SOLD, amount: 90000,
            serial_no: 1, is_current: true
          });
          T.assertEqual(Repo.findBy(SHEETS.TEAMS, 'team_id', drifted.team_id).players_count, 0,
            'fixture check: the cached counter has drifted to zero');
          const e2 = T.assertThrows(() => Suites._call('team.delete',
            { teamId: drifted.team_id }, admin), ERR.TEAM_NOT_EMPTY,
            'a team whose counter says empty but whose auction record says otherwise');
          T.assert(String(e2.message).toLowerCase().indexOf('recount') !== -1,
            'and the message has to point at the fix, got "' + e2.message + '"');

          const out = Suites._call('team.delete', { teamId: empty.team_id }, admin);
          T.assertEqual(out.deleted, true, 'an empty team deletes');
          T.assertEqual(out.team_name, 'ZZ Is Empty', 'and says which one');
          T.assertEqual(Repo.findBy(SHEETS.TEAMS, 'team_id', empty.team_id), null,
            'the row is gone');

          const audit = Suites._auditRows(empty.team_id, Audit.ACTIONS.TEAM_DELETED);
          T.assertEqual(audit.length, 1, 'exactly one TEAM_DELETED row');
          const prev = Util.safeJsonParse(audit[0].prev_value, null);
          T.assert(prev !== null && prev.team_name === 'ZZ Is Empty',
            'and it carries the whole row, because after this there is nothing left to ' +
            'look up (DESIGN.md §42)');
        });

      // -----------------------------------------------------------------------
      // recount — CONTRACTS-PHASE3 §3
      // -----------------------------------------------------------------------

      T.test('recount rebuilds the counters from AuctionResults, ignoring superseded rows',
        function () {
          const t = Suites._seedTournament('tmrecnt', { withFolders: false });
          const one = Suites._seedTeam(t.tid, {
            team_name: 'ZZ Recount One', purse_total: 2000000,
            purse_used: 999999, players_count: 9        // deliberately wrong
          });
          const two = Suites._seedTeam(t.tid, {
            team_name: 'ZZ Recount Two', purse_total: 2000000,
            purse_used: 0, players_count: 0             // deliberately wrong the other way
          });
          const untouched = Suites._seedTeam(t.tid, { team_name: 'ZZ Recount Three' });

          Suites._seedResult(t.tid, { team_id: one.team_id, serial_no: 1, amount: 100000 });
          Suites._seedResult(t.tid, { team_id: one.team_id, serial_no: 2, amount: 250000 });
          // ==================== THE ONE THAT MATTERS =========================
          // A superseded row is history, not a live fact. A Phase 7 correction
          // wrote a new current row and flipped this one, so replaying only the
          // current rows is what reproduces the state the corrections left behind
          // (DESIGN.md §2.6, §6.7). Counting it would put ₹9,00,000 back.
          // ===================================================================
          Suites._seedResult(t.tid, {
            team_id: one.team_id, serial_no: 2, amount: 900000, is_current: false
          });
          Suites._seedResult(t.tid, { team_id: two.team_id, serial_no: 3, amount: 50000 });
          // Not a sale, so it moves no money and fills no slot.
          Suites._seedResult(t.tid, {
            serial_no: 4, status: ENUM.RESULT_STATUS.UNSOLD, amount: '', team_id: ''
          });
          // Another tournament's sale must never be counted here (DESIGN.md §39).
          const elsewhere = Suites._seedTournament('tmrecnt2', { withFolders: false });
          Suites._seedResult(elsewhere.tid, {
            team_id: one.team_id, serial_no: 5, amount: 777777
          });

          const report = Suites._call('team.recount', { tournamentId: t.tid }, admin);

          T.assertEqual(report.sold_rows_counted, 3,
            'three current SOLD rows in this tournament: the superseded one, the UNSOLD ' +
            'one and the other tournament\'s must all be skipped');
          T.assertEqual(report.teams_checked, 3, 'every team in the tournament is checked');
          T.assertEqual(report.teams_changed, 2, 'two of the three had drifted');

          const after = {};
          Repo.readAll(SHEETS.TEAMS).forEach(r => {
            if (r.tournament_id === t.tid) after[r.team_name] = r;
          });
          T.assertEqual(after['ZZ Recount One'].purse_used, 350000,
            '100000 + 250000, with the superseded 900000 ignored');
          T.assertEqual(after['ZZ Recount One'].players_count, 2, 'and two slots filled');
          T.assertEqual(after['ZZ Recount Two'].purse_used, 50000, 'the second team\'s sale');
          T.assertEqual(after['ZZ Recount Two'].players_count, 1, 'and its one slot');
          T.assertEqual(after['ZZ Recount Three'].purse_used, 0,
            'a team with no sales rebuilds to zero, not to whatever it happened to say');

          const changed = {};
          report.changes.forEach(c => { changed[c.team_name] = c; });
          T.assertEqual(changed['ZZ Recount One'].purse_used, { from: 999999, to: 350000 },
            'the report says what moved, so the admin can see the damage');
          T.assertEqual(changed['ZZ Recount One'].players_count, { from: 9, to: 2 },
            'for both counters');
          T.assert(!changed['ZZ Recount Three'],
            'a team that was already right must not be listed as changed');

          // Audited per team, because a counter moving is a change to that team's
          // row and has to be answerable by entity_id later (DESIGN.md §42).
          T.assertEqual(
            Suites._auditRows(one.team_id, Audit.ACTIONS.TEAM_UPDATED).length, 1,
            'the first team gets its own TEAM_UPDATED row');
          T.assertEqual(
            Suites._auditRows(untouched.team_id, Audit.ACTIONS.TEAM_UPDATED).length, 0,
            'and the unchanged team gets none — nothing happened to it');

          // Idempotent. Running it twice must not keep "fixing" things.
          const again = Suites._call('team.recount', { tournamentId: t.tid }, admin);
          T.assertEqual(again.teams_changed, 0, 'a second recount changes nothing');
          T.assertEqual(again.sold_rows_counted, 3, 'and counts the same rows');
        });

      // -----------------------------------------------------------------------
      // Who may change what — CONTRACTS-PHASE3 §2, DESIGN.md §6.4
      // -----------------------------------------------------------------------

      T.test('ORGANISER may write until the first sale; ADMIN may write at any time',
        function () {
          const t = Suites._seedTournament('tmperm', { withFolders: false });
          const organiser = Suites._organiserSession('tmorg', t.tid);

          // Before any sale: the organiser owns this job.
          const built = Suites._call('team.createBatch',
            { tournamentId: t.tid, names: ['ZZ Perm One', 'ZZ Perm Two'],
              purseTotal: 500000, maxPlayers: 13 }, organiser);
          T.assertEqual(built.created.length, 2,
            'an organiser must be able to build the teams — that is the whole point of ' +
            'the batch form (CONTRACTS-PHASE3 §2)');
          const team = built.created[0];

          const edited = Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 600000 }, organiser);
          T.assertEqual(edited.purse_total, 600000, 'and adjust one afterwards');

          // The first SOLD result is the cut-off, not the auction going live:
          // before anything is sold there is no existing data a change could
          // contradict. Seeded directly — Phase 4 is what normally writes it.
          Suites._seedResult(t.tid, {
            team_id: team.team_id, serial_no: 1, amount: 100000,
            status: ENUM.RESULT_STATUS.SOLD, is_current: true
          });
          T.assertEqual(Teams.hasAnySale(t.tid), true, 'fixture check: a sale now stands');

          const e = T.assertThrows(() => Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 700000 }, organiser),
            ERR.FORBIDDEN, 'after the first sale an organiser must be refused');
          T.assert(String(e.message).toLowerCase().indexOf('admin') !== -1,
            'and told who can do it instead, got "' + e.message + '"');
          T.assertThrows(() => Suites._call('team.create',
            { tournamentId: t.tid, teamName: 'ZZ Perm Three' }, organiser),
            ERR.FORBIDDEN, 'creating a team is refused too');

          T.assertEqual(
            Repo.findBy(SHEETS.TEAMS, 'team_id', team.team_id).purse_total, 600000,
            'and the refused change left the row alone');

          // ADMIN, any time, including mid-auction (DESIGN.md §6.4).
          const byAdmin = Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 700000 }, admin);
          T.assertEqual(byAdmin.purse_total, 700000,
            'an admin may still make the same change — adding a 9th team or raising a ' +
            'squad size mid-auction is explicitly allowed');
          const added = Suites._call('team.create',
            { tournamentId: t.tid, teamName: 'ZZ Perm Nine' }, admin);
          T.assert(added.team_id, 'and may add a team after the first sale');

          // A superseded sale is not a sale. Retiring the only current SOLD row
          // puts the organiser back in charge, which is what makes hasAnySale the
          // right question rather than "does any SOLD row exist".
          const soldRow = Repo.readAll(SHEETS.AUCTION_RESULTS)
            .filter(r => r.tournament_id === t.tid && r.is_current === true)[0];
          T.assert(soldRow, 'fixture check: the current SOLD row is findable');
          Repo.updateRow(SHEETS.AUCTION_RESULTS, soldRow._row, { is_current: false });
          Repo.flush();
          T.assertEqual(Teams.hasAnySale(t.tid), false,
            'a corrected-away sale is history, not a live fact');
          const reopened = Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 800000 }, organiser);
          T.assertEqual(reopened.purse_total, 800000, 'so the organiser may write again');

          // And once the auction is CLOSED, every organiser write stops, even
          // with no sale on record (DESIGN.md §6.8).
          Suites._forceStatus(t.tid, ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED);
          T.assertThrows(() => Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 900000 }, organiser),
            ERR.AUCTION_CLOSED,
            'after the auction closes every organiser write is refused — this is the ' +
            'one case hasAnySale cannot see');
          const stillAdmin = Suites._call('team.update',
            { teamId: team.team_id, purseTotal: 900000 }, admin);
          T.assertEqual(stillAdmin.purse_total, 900000,
            'while an admin can still fix things after the close');
        });
    });
  },

  // ===========================================================================
  // Auction — CONTRACTS-PHASE4-7.md §4. Rationale: DESIGN.md §6.5–§6.9, §7, §15,
  // §28, §29, §43, §44.
  //
  // THE MOST IMPORTANT SUITE IN THIS FILE. Everything below runs live, in front
  // of an audience, with money attached.
  //
  // Three things are being defended, and each has tests of its own:
  //
  //   1. THE §4.1 ORDER. Nine checks, in one order, each with its own code. The
  //      order is not cosmetic: TEAM_FULL has to be reported before
  //      INSUFFICIENT_PURSE, or an organiser whose squad is complete is shown a
  //      confusing message about money (DESIGN.md §15 case 8).
  //   2. THE PURSE ARITHMETIC. Every counter on a Teams row is a cache of the
  //      append-only AuctionResults tab. The sweep at the end of this suite
  //      re-derives every one of them from that truth and compares.
  //   3. NOTHING IS EVER DELETED. A correction appends a superseding row and
  //      flips is_current on the old one (DESIGN.md §2.6, §43).
  //
  // WHAT THIS SUITE CANNOT DO: provoke real concurrency. A single Apps Script
  // execution is single-threaded, so the double-sale test below is SEQUENTIAL —
  // it proves the re-read and the version check, which are two of the three
  // defences, but it cannot prove the lock. The real test is 10 parallel
  // markSold calls at one player through UrlFetchApp.fetchAll against a DEPLOYED
  // URL. That is KNOWN-ISSUES.md item 8, and it has to be run after deploying
  // and before the auction.
  // ===========================================================================

  auction() {
    T.suite('Auction', function () {
      const admin = Suites._adminSession('aucadm');
      const AS = ENUM.AUCTION_STATUS;
      const RS = ENUM.RESULT_STATUS;
      const PS = ENUM.PAYMENT_STATUS;
      const fx = {};

      /** Every tournament this suite creates, for the invariant sweep at the end. */
      const worlds = [];

      /**
       * A tournament with teams and an eligible roster, ready to auction.
       * @param {string} tag short and unique; becomes part of the tournament id
       * @param {Object=} opts {status, teams: [teamSpec], players: number}
       * @return {!Object} {tid, row, teams, team (by name), players, bySerial}
       */
      function liveWorld(tag, opts) {
        const o = opts || {};
        const t = Suites._seedTournament(tag, {
          withFolders: false,
          status: o.status || ENUM.TOURNAMENT_STATUS.AUCTION_LIVE
        });
        worlds.push(t.tid);

        const teams = Suites._seedTeams(t.tid, o.teams || [
          { team_name: 'ZZ Alpha', purse_total: 1000000, max_players: 13 },
          { team_name: 'ZZ Bravo', purse_total: 1000000, max_players: 13 }
        ]);
        const byName = {};
        teams.forEach(x => { byName[x.team_name] = x; });

        const specs = [];
        const n = (o.players === undefined) ? 6 : o.players;
        for (let i = 1; i <= n; i++) {
          specs.push({
            serial_no: i,
            name: 'ZZ Auc ' + Suites._seqLetters(),
            payment_status: PS.VERIFIED
          });
        }
        const roster = Suites._seedRoster(t.tid, specs);
        return {
          tid: t.tid, row: t.row, teams: teams, team: byName,
          players: roster.players, bySerial: roster.bySerial
        };
      }

      /** The version a well-behaved client would have just polled. */
      function ver(tid) {
        return Cache.getVersion(tid);
      }

      /** Record a sale through the real action, at the current version. */
      function sell(tid, playerId, teamId, amount, session) {
        return Suites._call('auction.markSold', {
          tournamentId: tid, playerId: playerId, teamId: teamId,
          amount: amount, expectedVersion: ver(tid)
        }, session || admin);
      }

      /** Fresh Teams row from the sheet, never a cached copy. */
      function team(teamId) {
        const row = Repo.findBy(SHEETS.TEAMS, 'team_id', teamId);
        T.assert(row !== null, 'fixture team ' + teamId + ' has no row');
        return row;
      }

      /** Fresh Players row from the sheet. */
      function player(playerId) {
        const row = Repo.findBy(SHEETS.PLAYERS, 'player_id', playerId);
        T.assert(row !== null, 'fixture player ' + playerId + ' has no row');
        return row;
      }

      /** Every AuctionResults row for one player, in sheet (append) order. */
      function results(tid, playerId) {
        return Repo.readAll(SHEETS.AUCTION_RESULTS).filter(r =>
          r.tournament_id === tid && r.player_id === playerId);
      }

      /** The one standing result row for a player. */
      function current(tid, playerId) {
        const live = results(tid, playerId).filter(r => r.is_current === true);
        T.assertEqual(live.length, 1,
          'exactly one AuctionResults row per player may carry is_current = TRUE ' +
          '(DESIGN.md §2.6); this player has ' + live.length);
        return live[0];
      }

      /**
       * Everything about a tournament that a refused write must not change,
       * serialised so a failure prints a readable diff.
       */
      function frozen(tid) {
        const rows = tab => Repo.readAll(tab)
          .filter(r => r.tournament_id === tid)
          .map(r => JSON.stringify(r));
        return {
          v: Cache.getVersion(tid),
          players: rows(SHEETS.PLAYERS),
          teams: rows(SHEETS.TEAMS),
          results: rows(SHEETS.AUCTION_RESULTS)
        };
      }

      // ---- fixtures ---------------------------------------------------------

      /** The plain two-team world used by the happy path. */
      function main() {
        if (!fx.main) fx.main = liveWorld('aucmain');
        return fx.main;
      }

      /** A tournament that is NOT live, for the AUCTION_NOT_LIVE branch. */
      function notLive() {
        if (!fx.notLive) {
          fx.notLive = liveWorld('aucnotl', {
            status: ENUM.TOURNAMENT_STATUS.REG_OPEN,
            teams: [{ team_name: 'ZZ Waiting', purse_total: 1000000, max_players: 5 }],
            players: 1
          });
        }
        return fx.notLive;
      }

      /**
       * One world carrying a player in every state §4.1 rejects.
       *
       *   #1 eligible and PENDING — the control
       *   #2 payment still PENDING          -> PLAYER_NOT_ELIGIBLE
       *   #3 verified but withdrawn         -> PLAYER_NOT_ELIGIBLE
       *   #4 marked UNSOLD by the fixture   -> PLAYER_NOT_PENDING
       *   #5 PENDING but holding a team_id  -> ALREADY_ASSIGNED
       *   #6 sold, to fill "ZZ Full"        -> makes TEAM_FULL reachable
       *   #7 spare, for the exact-purse boundary
       *
       * ZZ Full is given a purse of ₹1,000 AND one slot, and #6 spends all of it.
       * That is what makes the "TEAM_FULL before INSUFFICIENT_PURSE" test able to
       * say something: both conditions are true at once.
       *
       * Player #5 is deliberately inconsistent — PENDING with a team_id is a state
       * no action can produce. It is invisible to the invariant sweep by
       * construction: it has no AuctionResults row and its status is not SOLD.
       */
      function guards() {
        if (fx.guards) return fx.guards;
        const w = liveWorld('aucgrd', {
          teams: [
            { team_name: 'ZZ Full', purse_total: 1000, max_players: 1 },
            { team_name: 'ZZ Poor', purse_total: 1000, max_players: 5 },
            { team_name: 'ZZ Rich', purse_total: 1000000, max_players: 5 }
          ],
          players: 0
        });
        const roster = Suites._seedRoster(w.tid, [
          { serial_no: 1, name: 'ZZ Guard Good', payment_status: PS.VERIFIED },
          { serial_no: 2, name: 'ZZ Guard Unpaid', payment_status: PS.PENDING },
          { serial_no: 3, name: 'ZZ Guard Gone', payment_status: PS.VERIFIED,
            is_withdrawn: true },
          { serial_no: 4, name: 'ZZ Guard Called', payment_status: PS.VERIFIED },
          { serial_no: 5, name: 'ZZ Guard Held', payment_status: PS.VERIFIED,
            team_id: w.team['ZZ Rich'].team_id },
          { serial_no: 6, name: 'ZZ Guard Filler', payment_status: PS.VERIFIED },
          { serial_no: 7, name: 'ZZ Guard Spare', payment_status: PS.VERIFIED }
        ]);

        // Fill ZZ Full and empty its purse in one real sale.
        sell(w.tid, roster.bySerial[6].player.player_id, w.team['ZZ Full'].team_id, 1000);
        // And put #4 beyond PENDING the only way the system allows.
        Suites._call('auction.markUnsold', {
          tournamentId: w.tid, playerId: roster.bySerial[4].player.player_id,
          expectedVersion: ver(w.tid)
        }, admin);

        fx.guards = { w: w, bySerial: roster.bySerial };
        return fx.guards;
      }

      // -----------------------------------------------------------------------
      // Routing
      // -----------------------------------------------------------------------

      T.test('every auction action is registered with the right exposure', function () {
        ['auction.getBySerial', 'auction.search', 'auction.markSold', 'auction.markUnsold',
         'auction.returnToPool', 'auction.state', 'auction.summary', 'auction.history']
          .forEach(name => {
            const r = Suites._route(name);
            T.assert(r.methods.indexOf('POST') !== -1, name + ' must accept POST');
            T.assert(r.methods.indexOf('GET') === -1, name + ' must not be offered on GET');
            T.assert(r.auth !== 'PUBLIC', name + ' must never be PUBLIC');
            T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ORGANISER) &&
              Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN),
              name + ' must allow both ORGANISER and ADMIN — the organiser is the one ' +
              'running the auction. Got auth = ' + T._fmt(r.auth));
          });

        ['auction.close', 'auction.reopen'].forEach(name => {
          const r = Suites._route(name);
          T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN),
            name + ' must allow ADMIN');
          T.assert(!Suites._authAllows(r.auth, ENUM.USER_ROLE.ORGANISER),
            name + ' is ADMIN only (DESIGN.md §6.8) — closing stops every organiser ' +
            'write and only an admin may reopen. Got auth = ' + T._fmt(r.auth));
        });

        const correct = Suites._route('auction.correct');
        T.assert(Suites._authAllows(correct.auth, ENUM.USER_ROLE.ADMIN),
          'auction.correct must allow ADMIN');
        T.assert(Suites._authAllows(correct.auth, ENUM.USER_ROLE.ORGANISER),
          'auction.correct must let an ORGANISER through the route so the handler can ' +
          'apply the §4.2 rule properly — a flat ADMIN-only here would block fixing a ' +
          'typo thirty seconds after making it');

        const display = Suites._route('auction.displayState');
        T.assertEqual(display.auth, 'PUBLIC',
          'the projector runs unattended on a venue laptop with nobody signed in; its ' +
          'credential is the tournament display token (DESIGN.md §5.5)');
        T.assert(display.methods.indexOf('GET') !== -1, 'displayState must accept GET');
        T.assert(display.methods.indexOf('POST') !== -1, 'and POST');

        // No write action may ever become public.
        const routes = buildRoutes();
        Object.keys(routes).forEach(name => {
          if (name.indexOf('auction.') !== 0) return;
          if (name === 'auction.displayState') return;
          T.assert(routes[name].auth !== 'PUBLIC',
            'auction action "' + name + '" is PUBLIC. displayState is the only one that ' +
            'may be, and tools/check.js pins that list deliberately.');
        });
      });

      // -----------------------------------------------------------------------
      // The happy path
      // -----------------------------------------------------------------------

      T.test('a sale leaves player, team and AuctionResults mutually consistent',
        function () {
          const w = main();
          const p = w.bySerial[1].player;
          const alpha = w.team['ZZ Alpha'];
          const before = ver(w.tid);

          const out = Suites._call('auction.markSold', {
            tournamentId: w.tid, playerId: p.player_id, teamId: alpha.team_id,
            amount: 125000, expectedVersion: before, note: 'ZZ first sale'
          }, admin);

          // ---- the response
          T.assertEqual(out.player.auction_status, AS.SOLD, 'the card comes back SOLD');
          T.assertEqual(out.player.sold_amount, 125000, 'at the price that was typed');
          T.assertEqual(out.player.team_name, 'ZZ Alpha', 'naming the buyer');
          T.assertEqual(out.team.purse_used, 125000, 'the team summary carries the new spend');
          T.assertEqual(out.team.players_count, 1, 'and the new count');
          T.assertEqual(out.team.purse_remaining, 875000, '1000000 - 125000');
          T.assertEqual(out.result.status, RS.SOLD, 'and the result row that was written');
          T.assertEqual(out.warnings, [],
            '§4.7: the first sale triggers nothing, because there is no history to ' +
            'compare against yet. That is correct, not a gap.');
          T.assertEqual(out.v, before + 1,
            'step 15 bumps the version exactly once so the projector refetches');

          // ---- the Players row
          const row = player(p.player_id);
          T.assertEqual(row.auction_status, AS.SOLD, 'the Players row says SOLD');
          T.assertEqual(row.team_id, alpha.team_id, 'and carries the buying team');
          T.assertEqual(row.sold_amount, 125000, 'and the amount');
          T.assert(!isNaN(Date.parse(row.sold_at)),
            'sold_at must be a parseable UTC instant, got ' + T._fmt(row.sold_at));

          // ---- the Teams row
          const t = team(alpha.team_id);
          T.assertEqual(t.purse_used, 125000,
            'the counter is maintained inside the sale lock, never recomputed by ' +
            'scanning Players (CONTRACTS-PHASE3 §3)');
          T.assertEqual(t.players_count, 1, 'and so is the slot count');

          // ---- the AuctionResults row, which is the truth the other two mirror
          const all = results(w.tid, p.player_id);
          T.assertEqual(all.length, 1, 'one sale, one result row');
          const res = all[0];
          T.assertEqual(res.is_current, true, 'and it is the standing answer');
          T.assertEqual(res.status, RS.SOLD, 'recorded as SOLD');
          T.assertEqual(res.team_id, alpha.team_id, 'against the right team');
          T.assertEqual(res.amount, 125000, 'for the right money');
          T.assertEqual(res.serial_no, 1,
            'with the serial denormalised onto it, so a report never has to join back');
          T.assertEqual(res.recorded_by, admin.user_id, 'and who recorded it');
          T.assertEqual(res.supersedes_auction_id, '', 'a first sale supersedes nothing');
          T.assertEqual(res.auction_id, out.result.auction_id,
            'the id in the response is the id on the sheet');

          // ---- the three agree with each other
          T.assertEqual(row.sold_amount, res.amount, 'player and result agree on the money');
          T.assertEqual(row.team_id, res.team_id, 'and on the buyer');
          T.assertEqual(t.purse_used, res.amount, 'and the team counter is that one sale');

          // ---- audited with prev and next
          const audit = Suites._auditRows(p.player_id, Audit.ACTIONS.PLAYER_SOLD);
          T.assertEqual(audit.length, 1, 'exactly one PLAYER_SOLD row');
          const prev = Util.safeJsonParse(audit[0].prev_value, null);
          const next = Util.safeJsonParse(audit[0].new_value, null);
          T.assert(prev !== null && next !== null,
            'prev and new must both be stored as JSON (CONTRACTS.md §10)');
          T.assertEqual(prev.auction_status, AS.PENDING, 'the previous state');
          T.assertEqual(prev.team_purse_used, 0, 'and the previous purse');
          T.assertEqual(next.sold_amount, 125000, 'the new amount');
          T.assertEqual(next.team_purse_used, 125000, 'and the new purse');
        });

      T.test('an advisory warning is returned but never blocks the sale', function () {
        // §4.7 and DESIGN.md §6.5a. Prices here are genuinely unpredictable, so a
        // hard limit would eventually refuse a legitimate bid in front of an
        // audience. Every one of these is a tick-box, not a wall.
        const w = liveWorld('aucwarn', {
          teams: [{ team_name: 'ZZ Cautious', purse_total: 100000, max_players: 5 }],
          players: 2
        });
        const t = w.team['ZZ Cautious'];

        // 30000 is 30% of the team's total purse, over the 25% threshold.
        const out = sell(w.tid, w.bySerial[1].player.player_id, t.team_id, 30000);
        T.assertEqual(out.player.auction_status, AS.SOLD,
          'the sale must go through. A genuinely huge bid for a genuinely great ' +
          'player always has to be recordable.');
        T.assert(Array.isArray(out.warnings), 'warnings must be an array');
        const codes = out.warnings.map(x => x.code);
        T.assert(codes.indexOf(AUCTION_WARN.LARGE_SHARE_OF_PURSE) !== -1,
          '30% of the total purse must raise LARGE_SHARE_OF_PURSE, got ' + T._fmt(codes));
        out.warnings.forEach(x => {
          T.assert(typeof x.message === 'string' && x.message.length > 0,
            'every warning needs a sentence the organiser can read, got ' + T._fmt(x));
        });
        T.assertEqual(team(t.team_id).purse_used, 30000,
          'and the money really moved');
      });

      // -----------------------------------------------------------------------
      // The §4.1 validations
      // -----------------------------------------------------------------------

      T.test('markSold runs every §4.1 check, each with its own error code', function () {
        const g = guards();
        const w = g.w;
        const good = g.bySerial[1].player;
        const rich = w.team['ZZ Rich'].team_id;
        const attempt = (payload) => {
          const body = {
            tournamentId: w.tid, playerId: good.player_id, teamId: rich,
            amount: 5000, expectedVersion: ver(w.tid)
          };
          Object.keys(payload || {}).forEach(k => { body[k] = payload[k]; });
          return () => Suites._call('auction.markSold', body, admin);
        };

        // Step 1 — the version check, the third defence against a stale tab.
        T.assertThrows(attempt({ expectedVersion: undefined }), ERR.VALIDATION_FAILED,
          'expectedVersion is required: without it the stale-tab defence is opt-out');
        T.assertThrows(attempt({ expectedVersion: ver(w.tid) + 1 }), ERR.STALE_STATE,
          'a version the auction has not reached yet');
        T.assertThrows(attempt({ expectedVersion: ver(w.tid) - 1 }), ERR.STALE_STATE,
          'a version the auction has already left behind');

        // Step 3 — the auction has to be live.
        const idle = notLive();
        T.assertThrows(() => Suites._call('auction.markSold', {
          tournamentId: idle.tid, playerId: idle.bySerial[1].player.player_id,
          teamId: idle.team['ZZ Waiting'].team_id, amount: 5000,
          expectedVersion: ver(idle.tid)
        }, admin), ERR.AUCTION_NOT_LIVE,
          'a tournament still taking registrations cannot record a sale');

        // Step 2's re-read only finds what exists.
        T.assertThrows(attempt({ playerId: 'PLY_zzzzzzzzzzzz' }), ERR.NOT_FOUND,
          'a player id that is not in this tournament');
        T.assertThrows(attempt({ playerId: '' }), ERR.VALIDATION_FAILED,
          'a blank player id');
        T.assertThrows(attempt({ teamId: 'TEM_zzzzzzzzzzzz' }), ERR.NOT_FOUND,
          'a team id that is not in this tournament');

        // Step 4 — eligibility, via the single Players.isAuctionEligible rule.
        const unpaidErr = T.assertThrows(
          attempt({ playerId: g.bySerial[2].player.player_id }), ERR.PLAYER_NOT_ELIGIBLE,
          'a player whose payment is still PENDING');
        T.assert(String(unpaidErr.message).indexOf('PENDING') !== -1,
          'the message must show the payment status so the organiser can act on it ' +
          '(DESIGN.md §15 case 19), got "' + unpaidErr.message + '"');
        const goneErr = T.assertThrows(
          attempt({ playerId: g.bySerial[3].player.player_id }), ERR.PLAYER_NOT_ELIGIBLE,
          'a VERIFIED player who has withdrawn is still not eligible — that is exactly ' +
          'why step 4 must call Players.isAuctionEligible and not re-implement it');
        T.assert(String(goneErr.message).toLowerCase().indexOf('withdraw') !== -1,
          'and say so, got "' + goneErr.message + '"');

        // Step 5 — the second defence against a double sale.
        T.assertThrows(attempt({ playerId: g.bySerial[4].player.player_id }),
          ERR.PLAYER_NOT_PENDING, 'a player already marked UNSOLD');

        // Step 6 — belt and braces: PENDING while holding a team_id is a fault.
        T.assertThrows(attempt({ playerId: g.bySerial[5].player.player_id }),
          ERR.ALREADY_ASSIGNED, 'a PENDING player who already carries a team_id');

        // Step 7 — positive whole rupees, and nothing more (DESIGN.md §6.5a).
        [0, -1, '12.5', '', '₹5000', '5,000', 'abc'].forEach(bad => {
          T.assertThrows(attempt({ amount: bad }), ERR.INVALID_AMOUNT,
            'an amount of ' + T._fmt(bad) + ' is not a positive whole number of rupees');
        });

        // Step 8 — the squad.
        const fullErr = T.assertThrows(
          attempt({ teamId: w.team['ZZ Full'].team_id, amount: 100 }), ERR.TEAM_FULL,
          'a team that already has all its players');
        T.assert(String(fullErr.message).indexOf('ZZ Full') !== -1,
          'the message must name the team, got "' + fullErr.message + '"');

        // Step 9 — then the money.
        const poor = w.team['ZZ Poor'].team_id;
        const shortErr = T.assertThrows(
          attempt({ teamId: poor, amount: 5000 }), ERR.INSUFFICIENT_PURSE,
          'a bid of 5000 against a remaining purse of 1000');
        T.assert(String(shortErr.message).indexOf(Util.formatINR(1000)) !== -1,
          'the message has to carry the real number (CONTRACTS.md §2), got "' +
          shortErr.message + '"');

        // Nothing above may have moved anything.
        T.assertEqual(player(good.player_id).auction_status, AS.PENDING,
          'the control player must still be PENDING after all those refusals');
        T.assertEqual(team(poor).purse_used, 0, 'and the poor team must have spent nothing');

        // The boundary: exactly the remaining purse is ALLOWED (<=, never <;
        // DESIGN.md §15 case 6).
        const exact = sell(w.tid, g.bySerial[7].player.player_id, poor, 1000);
        T.assertEqual(exact.team.purse_remaining, 0,
          'a bid equal to the remaining purse must go through and leave zero');
        T.assertEqual(exact.player.auction_status, AS.SOLD, 'and the player is sold');
      });

      T.test('TEAM_FULL is reported before INSUFFICIENT_PURSE when both apply', function () {
        // DESIGN.md §15 case 8 and §4.1 step order. ZZ Full has ONE slot and a
        // purse of ₹1,000, and the fixture already spent all of it on one player,
        // so a further bid of ₹5,000 breaks both rules at once. The organiser has
        // to be told the accurate thing — there is no slot — rather than a
        // confusing message about money they could in principle add.
        const g = guards();
        const full = g.w.team['ZZ Full'];

        const row = team(full.team_id);
        T.assertEqual(row.players_count, row.max_players,
          'fixture check: the team is full (' + row.players_count + '/' + row.max_players + ')');
        T.assertEqual(row.purse_total - row.purse_used, 0,
          'fixture check: and its purse is exhausted too');

        const e = T.assertThrows(() => Suites._call('auction.markSold', {
          tournamentId: g.w.tid, playerId: g.bySerial[1].player.player_id,
          teamId: full.team_id, amount: 5000, expectedVersion: ver(g.w.tid)
        }, admin), ERR.TEAM_FULL,
          'both TEAM_FULL and INSUFFICIENT_PURSE are true; §4.1 puts the squad check ' +
          'first, so TEAM_FULL is the answer');
        T.assert(String(e.message).toLowerCase().indexOf('purse') === -1,
          'and the message must not talk about money at all, got "' + e.message + '"');
      });

      // -----------------------------------------------------------------------
      // Double sale — SEQUENTIAL. See the suite header and KNOWN-ISSUES item 8.
      // -----------------------------------------------------------------------

      T.test('markSold twice for one player: exactly one sale, counters moved once',
        function () {
          // ================== WHAT THIS TEST CAN AND CANNOT PROVE ==============
          // Apps Script runs one execution single-threaded, so these two calls are
          // SEQUENTIAL and the script lock is never actually contended. What is
          // proven here is defences 2 and 3 of §4.1: the re-read inside the lock
          // (the second caller sees SOLD) and the version check (a tab that has
          // not polled since the first sale is refused).
          //
          // Defence 1, the lock itself, cannot be provoked from here. The real
          // test is 10 parallel markSold calls at one player through
          // UrlFetchApp.fetchAll against a DEPLOYED /exec URL — KNOWN-ISSUES.md
          // item 8, to be run after deploying and before the auction.
          // ====================================================================
          const w = liveWorld('aucdbl', {
            teams: [{ team_name: 'ZZ Once', purse_total: 1000000, max_players: 13 }],
            players: 2
          });
          const only = w.team['ZZ Once'];

          // --- the two tabs both polled at the same version -------------------
          const shared = ver(w.tid);
          const a = w.bySerial[1].player;
          const first = Suites._call('auction.markSold', {
            tournamentId: w.tid, playerId: a.player_id, teamId: only.team_id,
            amount: 200000, expectedVersion: shared
          }, admin);
          T.assertEqual(first.player.auction_status, AS.SOLD, 'the first call wins');

          T.assertThrows(() => Suites._call('auction.markSold', {
            tournamentId: w.tid, playerId: a.player_id, teamId: only.team_id,
            amount: 200000, expectedVersion: shared
          }, admin), ERR.STALE_STATE,
            'the second tab is still holding the version it polled before the first ' +
            'sale, so the version check refuses it before anything else is looked at');

          // --- and again with a client that DID refresh in between -------------
          const b = w.bySerial[2].player;
          Suites._call('auction.markSold', {
            tournamentId: w.tid, playerId: b.player_id, teamId: only.team_id,
            amount: 300000, expectedVersion: ver(w.tid)
          }, admin);
          T.assertThrows(() => Suites._call('auction.markSold', {
            tournamentId: w.tid, playerId: b.player_id, teamId: only.team_id,
            amount: 300000, expectedVersion: ver(w.tid)
          }, admin), ERR.PLAYER_NOT_PENDING,
            'with a fresh version the version check passes, and the RE-READ is what ' +
            'catches it: the row on the sheet already says SOLD');

          // --- the arithmetic moved exactly once per player --------------------
          const t = team(only.team_id);
          T.assertEqual(t.purse_used, 500000,
            '200000 + 300000 and not a rupee more. A double sale would show 700000 or ' +
            '800000 here.');
          T.assertEqual(t.players_count, 2, 'two slots filled, not three or four');

          [a, b].forEach(p => {
            const rows = results(w.tid, p.player_id);
            T.assertEqual(rows.length, 1,
              'one sale must leave one AuctionResults row, got ' + rows.length);
            T.assertEqual(rows.filter(r => r.is_current === true).length, 1,
              'and exactly one of them is_current');
          });

          T.assertEqual(Suites._auditRows(a.player_id, Audit.ACTIONS.PLAYER_SOLD).length, 1,
            'and one PLAYER_SOLD audit row, not two');
        });

      T.test('a stale expectedVersion gives STALE_STATE and changes absolutely nothing',
        function () {
          const w = liveWorld('aucstal', {
            teams: [{ team_name: 'ZZ Stale', purse_total: 1000000, max_players: 13 }],
            players: 2
          });
          const t = w.team['ZZ Stale'];
          // Move the version at least once, so "stale" means a real earlier value
          // rather than the initial 0.
          sell(w.tid, w.bySerial[1].player.player_id, t.team_id, 111000);

          const before = frozen(w.tid);
          T.assert(before.v > 0, 'fixture check: the version has moved, got ' + before.v);

          const e = T.assertThrows(() => Suites._call('auction.markSold', {
            tournamentId: w.tid, playerId: w.bySerial[2].player.player_id,
            teamId: t.team_id, amount: 222000, expectedVersion: before.v - 1
          }, admin), ERR.STALE_STATE, 'a version one behind the live one');
          T.assert(String(e.message).indexOf(String(before.v)) !== -1,
            'the message must tell the client which version it needs to refresh to, ' +
            'got "' + e.message + '"');

          T.assertEqual(frozen(w.tid), before,
            'a STALE_STATE refusal must leave Players, Teams, AuctionResults and the ' +
            'version itself byte-for-byte as they were. The check runs first, before ' +
            'anything is even read for writing.');
        });

      // -----------------------------------------------------------------------
      // Purse arithmetic
      // -----------------------------------------------------------------------

      T.test('purse arithmetic is exact across 15 sequential sales', function () {
        const w = liveWorld('aucbulk', {
          teams: [{ team_name: 'ZZ Bulk', purse_total: 5000000, max_players: 20 }],
          players: 15
        });
        const t = w.team['ZZ Bulk'];
        let expected = 0;
        const amounts = [];

        for (let i = 1; i <= 15; i++) {
          // Deliberately uneven, so a rounding or truncation bug cannot hide
          // behind tidy round numbers.
          const amount = 1000 * (3 + i * 7) + i;
          amounts.push(amount);
          expected += amount;

          const out = sell(w.tid, w.bySerial[i].player.player_id, t.team_id, amount);
          T.assertEqual(out.team.purse_used, expected,
            'after sale ' + i + ' the running total must be ' + expected);
          T.assertEqual(out.team.players_count, i, 'and the slot count must be ' + i);
          T.assertEqual(out.team.purse_remaining, 5000000 - expected,
            'and remaining must be total minus spent, with no drift');
        }

        const row = team(t.team_id);
        T.assertEqual(row.purse_used, expected, 'the stored counter matches the sum');
        T.assertEqual(row.players_count, 15, 'and so does the count');

        // ==================== THE CROSS-CHECK THAT MATTERS ===================
        // The Teams counters are a cache. AuctionResults is the truth. Fifteen
        // additions to a cached number is exactly where a drift of one rupee
        // would first appear, and nothing on any screen would show it.
        // =====================================================================
        const sold = Repo.readAll(SHEETS.AUCTION_RESULTS).filter(r =>
          r.tournament_id === w.tid && r.is_current === true && r.status === RS.SOLD);
        T.assertEqual(sold.length, 15, 'fifteen current SOLD rows');
        const truth = sold.reduce((sum, r) => sum + Util.toInt(r.amount, 0), 0);
        T.assertEqual(row.purse_used, truth,
          'purse_used must equal the sum of the current SOLD rows in AuctionResults ' +
          '(DESIGN.md §2.6). It says ' + row.purse_used + ' and the truth is ' + truth + '.');
        T.assertEqual(sold.map(r => Util.toInt(r.amount, 0)).sort((x, y) => x - y),
          amounts.slice().sort((x, y) => x - y),
          'and every individual amount was recorded exactly as typed');

        // The summary reports the same money, also derived from AuctionResults.
        const summary = Suites._call('auction.summary', { tournamentId: w.tid }, admin);
        T.assertEqual(summary.total_spent, expected,
          'auction.summary totals from AuctionResults, not from the Teams cache');
        T.assertEqual(summary.sold, 15, 'and counts fifteen sold players');
        T.assertEqual(summary.total_spent_display, Util.formatINR(expected),
          'with the ₹-formatted form of the same integer');
      });

      // -----------------------------------------------------------------------
      // Correction — §4.3, DESIGN.md §6.7, §43. A correction NEVER deletes.
      // -----------------------------------------------------------------------

      T.test('correcting A to B refunds A, charges B, and supersedes the old row',
        function () {
          const w = liveWorld('auccorr', {
            teams: [
              { team_name: 'ZZ From', purse_total: 1000000, max_players: 13 },
              { team_name: 'ZZ To', purse_total: 1000000, max_players: 13 }
            ],
            players: 2
          });
          const from = w.team['ZZ From'];
          const to = w.team['ZZ To'];
          const p = w.bySerial[1].player;

          sell(w.tid, p.player_id, from.team_id, 200000);
          const oldRow = current(w.tid, p.player_id);
          T.assertEqual(team(from.team_id).purse_used, 200000, 'fixture check: A was charged');

          const out = Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: p.player_id, newStatus: AS.SOLD,
            teamId: to.team_id, amount: 150000, expectedVersion: ver(w.tid),
            note: 'ZZ wrong team called out'
          }, admin);

          // ---- A is put back exactly as it was
          const a = team(from.team_id);
          T.assertEqual(a.purse_used, 0, 'the old team is refunded in full');
          T.assertEqual(a.players_count, 0, 'and its slot is freed');

          // ---- B is charged the new amount, not the old one
          const b = team(to.team_id);
          T.assertEqual(b.purse_used, 150000, 'the new team is charged the corrected price');
          T.assertEqual(b.players_count, 1, 'and fills one slot');

          // ---- history: the old row survives, flagged, and is pointed at
          const rows = results(w.tid, p.player_id);
          T.assertEqual(rows.length, 2,
            'a correction APPENDS. Two rows, not one edited one — the old row is the ' +
            'evidence that settles an argument afterwards (DESIGN.md §43).');
          const retired = rows.filter(r => r.auction_id === oldRow.auction_id)[0];
          T.assertEqual(retired.is_current, false, 'the old row is no longer current');
          T.assertEqual(retired.amount, 200000,
            'and NOTHING in it is rewritten — it still records what was announced at ' +
            'the time');
          T.assertEqual(retired.team_id, from.team_id, 'including which team it was');

          const fresh = current(w.tid, p.player_id);
          T.assertEqual(fresh.supersedes_auction_id, oldRow.auction_id,
            'the new row points back at the one it replaced');
          T.assertEqual(fresh.status, RS.SOLD, 'it is still a sale');
          T.assertEqual(fresh.team_id, to.team_id, 'to the new team');
          T.assertEqual(fresh.amount, 150000, 'for the new amount');
          T.assertEqual(fresh.auction_id, out.result.auction_id, 'and the response says so');

          // ---- the Players row follows the standing result
          const row = player(p.player_id);
          T.assertEqual(row.team_id, to.team_id, 'the player now belongs to B');
          T.assertEqual(row.sold_amount, 150000, 'at the corrected price');
          T.assertEqual(row.auction_status, AS.SOLD, 'and is still SOLD');

          // ---- audited with both values
          const audit = Suites._auditRows(p.player_id, Audit.ACTIONS.AUCTION_CORRECTED);
          T.assertEqual(audit.length, 1, 'exactly one AUCTION_CORRECTED row');
          const prev = Util.safeJsonParse(audit[0].prev_value, null);
          const next = Util.safeJsonParse(audit[0].new_value, null);
          T.assert(prev !== null && next !== null, 'with both values as JSON');
          T.assertEqual(prev.team_id, from.team_id, 'the team it was');
          T.assertEqual(prev.sold_amount, 200000, 'and the money it was');
          T.assertEqual(next.team_id, to.team_id, 'the team it is');
          T.assertEqual(next.sold_amount, 150000, 'and the money it is');

          // Correcting only the amount, on the same team, must not read as a
          // second player at a second full price.
          Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: p.player_id, newStatus: AS.SOLD,
            teamId: to.team_id, amount: 175000, expectedVersion: ver(w.tid)
          }, admin);
          const again = team(to.team_id);
          T.assertEqual(again.purse_used, 175000,
            'a same-team amount change is one net write, not a reversal and a fresh ' +
            'sale that happen to cancel out');
          T.assertEqual(again.players_count, 1, 'and the slot count must not double');
        });

      T.test('a correction that would overspend or overfill is refused, and nothing moves',
        function () {
          // §4.3 rule 5: re-validate everything from §4.1 against the NEW team and
          // amount. A correction is typed under pressure, right after a mistake,
          // so it is more likely to overspend than a fresh sale, not less.
          const w = liveWorld('auccbad', {
            teams: [
              { team_name: 'ZZ Holder', purse_total: 1000000, max_players: 13 },
              { team_name: 'ZZ Tiny', purse_total: 1000, max_players: 5 },
              { team_name: 'ZZ OneSlot', purse_total: 1000000, max_players: 1 }
            ],
            players: 3
          });
          const holder = w.team['ZZ Holder'];
          const tiny = w.team['ZZ Tiny'];
          const oneSlot = w.team['ZZ OneSlot'];

          sell(w.tid, w.bySerial[1].player.player_id, holder.team_id, 200000);
          sell(w.tid, w.bySerial[2].player.player_id, oneSlot.team_id, 50000);
          const p = w.bySerial[1].player;
          const before = frozen(w.tid);

          T.assertThrows(() => Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: p.player_id, newStatus: AS.SOLD,
            teamId: tiny.team_id, amount: 200000, expectedVersion: ver(w.tid)
          }, admin), ERR.INSUFFICIENT_PURSE,
            'moving a ₹2,00,000 player onto a team with ₹1,000 must be refused');

          T.assertThrows(() => Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: p.player_id, newStatus: AS.SOLD,
            teamId: oneSlot.team_id, amount: 100000, expectedVersion: ver(w.tid)
          }, admin), ERR.TEAM_FULL,
            'moving a player onto a team whose only slot is taken must be refused');

          T.assertThrows(() => Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: p.player_id, newStatus: AS.SOLD,
            teamId: holder.team_id, amount: 0, expectedVersion: ver(w.tid)
          }, admin), ERR.INVALID_AMOUNT, 'and a correction to zero rupees is still zero');

          T.assertThrows(() => Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: p.player_id, newStatus: 'BANANA',
            teamId: holder.team_id, amount: 1000, expectedVersion: ver(w.tid)
          }, admin), ERR.VALIDATION_FAILED, 'a status that is not one of the three');

          T.assertThrows(() => Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: w.bySerial[3].player.player_id,
            newStatus: AS.SOLD, teamId: holder.team_id, amount: 1000,
            expectedVersion: ver(w.tid)
          }, admin), ERR.NOT_FOUND,
            'there is nothing to correct for a player who was never called');

          T.assertEqual(frozen(w.tid), before,
            'NOT ONE of those refusals may have reversed the original sale on the way ' +
            'in. The reversal is computed first but only written after every check has ' +
            'passed, and this is the assertion that keeps it that way.');
        });

      T.test('correcting back to PENDING clears team_id, sold_amount and sold_at',
        function () {
          const w = liveWorld('auccpen', {
            teams: [{ team_name: 'ZZ Undo', purse_total: 1000000, max_players: 13 }],
            players: 1
          });
          const t = w.team['ZZ Undo'];
          const p = w.bySerial[1].player;

          sell(w.tid, p.player_id, t.team_id, 175000);
          const soldRow = player(p.player_id);
          T.assertEqual(soldRow.team_id, t.team_id, 'fixture check: the sale landed');
          T.assert(!Util.isBlank(soldRow.sold_at), 'fixture check: with a timestamp');
          const oldResult = current(w.tid, p.player_id);

          Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: p.player_id, newStatus: AS.PENDING,
            expectedVersion: ver(w.tid), note: 'ZZ the sale never happened'
          }, admin);

          const row = player(p.player_id);
          T.assertEqual(row.auction_status, AS.PENDING, 'the player is back in the pool');
          T.assertEqual(row.team_id, '',
            'team_id must be cleared — a PENDING player holding a team is the exact ' +
            'state §4.1 step 6 rejects as a data fault');
          T.assertEqual(Util.isBlank(row.sold_amount), true,
            'sold_amount must be cleared, not left at 175000. Money spent against ' +
            'nobody is what every report would then show.');
          T.assertEqual(row.sold_at, '', 'and so must sold_at');

          const t2 = team(t.team_id);
          T.assertEqual(t2.purse_used, 0, 'the team is refunded');
          T.assertEqual(t2.players_count, 0, 'and its slot freed');

          const fresh = current(w.tid, p.player_id);
          T.assertEqual(fresh.status, RS.RETURNED_TO_POOL,
            'the standing history row records the player going back to the pool');
          T.assertEqual(fresh.supersedes_auction_id, oldResult.auction_id,
            'pointing at the sale it undid');
          T.assertEqual(Util.isBlank(fresh.amount), true,
            'and carrying no amount, because no money changed hands');
          T.assertEqual(results(w.tid, p.player_id).length, 2,
            'the sale itself is still on the sheet — nothing is ever deleted');

          // And the player can be sold again afterwards, which is the whole point.
          const resold = sell(w.tid, p.player_id, t.team_id, 90000);
          T.assertEqual(resold.player.auction_status, AS.SOLD, 'a re-sale goes through');
          T.assertEqual(team(t.team_id).purse_used, 90000,
            'and charges only the new price');
        });

      // -----------------------------------------------------------------------
      // Unsold, back to the pool, then sold — DESIGN.md §6.6
      // -----------------------------------------------------------------------

      T.test('markUnsold -> returnToPool -> markSold, with the history rows right',
        function () {
          // §23 of the requirement says an unsold player "might get sold after
          // sometime". returnToPool is the only control that makes that possible.
          const w = liveWorld('aucpool', {
            teams: [{ team_name: 'ZZ Later', purse_total: 1000000, max_players: 13 }],
            players: 1
          });
          const t = w.team['ZZ Later'];
          const p = w.bySerial[1].player;

          // Bring them to the table first, so times_called is realistic.
          Suites._call('auction.getBySerial',
            { tournamentId: w.tid, serialNo: 1 }, admin);
          const calledOnce = Util.toInt(player(p.player_id).times_called, 0);
          T.assertEqual(calledOnce, 1, 'fixture check: called once');

          const unsold = Suites._call('auction.markUnsold', {
            tournamentId: w.tid, playerId: p.player_id, expectedVersion: ver(w.tid)
          }, admin);
          T.assertEqual(unsold.player.auction_status, AS.UNSOLD, 'nobody bid');
          T.assertEqual(team(t.team_id).purse_used, 0,
            'an unsold player costs nothing and fills no slot');
          T.assertEqual(team(t.team_id).players_count, 0, 'neither counter moves');

          // A sold player cannot be returned to the pool this way.
          const returned = Suites._call('auction.returnToPool', {
            tournamentId: w.tid, playerId: p.player_id, expectedVersion: ver(w.tid)
          }, admin);
          T.assertEqual(returned.player.auction_status, AS.PENDING,
            'and back in the pool they go');
          T.assertEqual(Util.toInt(player(p.player_id).times_called, 0), calledOnce,
            'times_called must NOT be reset. They have been to the table, so they ' +
            'belong in "awaiting re-auction", not back in "not called" (DESIGN.md §6.9).');

          T.assertThrows(() => Suites._call('auction.returnToPool', {
            tournamentId: w.tid, playerId: p.player_id, expectedVersion: ver(w.tid)
          }, admin), ERR.VALIDATION_FAILED,
            'returning a player who is already in the pool is a no-op the organiser ' +
            'should be told about, not a second history row');

          const resold = sell(w.tid, p.player_id, t.team_id, 65000);
          T.assertEqual(resold.player.auction_status, AS.SOLD, 'and they sell second time');

          // ---- the history, newest first (§4.2)
          const hist = Suites._call('auction.history', { tournamentId: w.tid }, admin);
          const mine = hist.rows.filter(r => r.player_id === p.player_id);
          T.assertEqual(mine.map(r => r.status), [RS.SOLD, RS.RETURNED_TO_POOL, RS.UNSOLD],
            'three events, newest first — every one of them kept');
          T.assertEqual(mine.map(r => r.is_current), [true, false, false],
            'and only the last is the standing answer');
          T.assertEqual(mine[0].amount, 65000, 'the sale carries the money');
          T.assertEqual(mine[1].amount, null,
            'a return to the pool carries none — blank and zero are different facts');
          T.assertEqual(mine[2].amount, null, 'and neither does an unsold call');
          T.assertEqual(mine[1].supersedes_auction_id, '',
            'a return to the pool is a NEW event, not a correction of the UNSOLD row. ' +
            'That row remains a true record of what happened at the time, so §4.3 ' +
            'reserves supersedes_auction_id for corrections.');
          T.assertEqual(mine[0].name, player(p.player_id).name,
            'and the history names the player without a second lookup per row');

          // The trail carries one row per event.
          T.assertEqual(
            Suites._auditRows(p.player_id, Audit.ACTIONS.PLAYER_UNSOLD).length, 1,
            'one PLAYER_UNSOLD row');
          T.assertEqual(
            Suites._auditRows(p.player_id, Audit.ACTIONS.PLAYER_RETURNED_TO_POOL).length, 1,
            'one PLAYER_RETURNED_TO_POOL row');
          T.assertEqual(
            Suites._auditRows(p.player_id, Audit.ACTIONS.PLAYER_SOLD).length, 1,
            'one PLAYER_SOLD row');

          // And a SOLD player is sent through Correct instead, with a message
          // that says so.
          const e = T.assertThrows(() => Suites._call('auction.returnToPool', {
            tournamentId: w.tid, playerId: p.player_id, expectedVersion: ver(w.tid)
          }, admin), ERR.ALREADY_ASSIGNED,
            'quietly clearing a SOLD player here would leave the money spent against ' +
            'nobody');
          T.assert(String(e.message).toLowerCase().indexOf('correct') !== -1,
            'and the message must point at the action that does reverse a sale, got "' +
            e.message + '"');
        });

      // -----------------------------------------------------------------------
      // times_called — DESIGN.md §6.9, the number the four labels rest on
      // -----------------------------------------------------------------------

      T.test('times_called rises on getBySerial and never on search', function () {
        const w = liveWorld('aucshow', {
          teams: [{ team_name: 'ZZ Watch', purse_total: 1000000, max_players: 13 }],
          players: 2
        });
        const p = w.bySerial[1].player;
        T.assertEqual(Util.toInt(player(p.player_id).times_called, 0), 0,
          'fixture check: nobody has been called yet');

        const first = Suites._call('auction.getBySerial',
          { tournamentId: w.tid, serialNo: 1 }, admin);
        T.assertEqual(first.revealed, true, 'an eligible player is revealed');
        T.assertEqual(first.player.times_called, 1, 'and counted as called once');
        T.assertEqual(Util.toInt(player(p.player_id).times_called, 0), 1,
          'on the sheet, not only in the response');

        Suites._call('auction.getBySerial', { tournamentId: w.tid, serialNo: 1 }, admin);
        T.assertEqual(Util.toInt(player(p.player_id).times_called, 0), 2,
          'calling them back a second time counts again');

        // ==================== THE DISTINCTION THAT MATTERS ===================
        // Searching to check a name is not the same as bringing somebody to the
        // auction table. The whole "not called" number in the reports — roughly
        // 300 of 400 players — depends on search staying read-only.
        // =====================================================================
        const before = Util.toInt(player(p.player_id).times_called, 0);
        const found = Suites._call('auction.search',
          { tournamentId: w.tid, q: player(p.player_id).name }, admin);
        T.assert(found.total >= 1, 'the search must actually find them, got ' +
          T._fmt(found.total));
        Suites._call('auction.search', { tournamentId: w.tid, q: '1' }, admin);
        Suites._call('auction.search', { tournamentId: w.tid, role: ENUM.PLAYER_ROLE.BATSMAN },
          admin);
        T.assertEqual(Util.toInt(player(p.player_id).times_called, 0), before,
          'three searches must leave times_called at ' + before + '. A search that ' +
          'counted as a call would turn every "not called" player into "awaiting ' +
          're-auction" and the reports would stop meaning anything.');

        // An ineligible player is looked up but never revealed, and never counted.
        const blocked = Suites._seedRoster(w.tid, [
          { serial_no: 9, name: 'ZZ Show Unpaid', payment_status: PS.PENDING }
        ]);
        const look = Suites._call('auction.getBySerial',
          { tournamentId: w.tid, serialNo: 9 }, admin);
        T.assertEqual(look.revealed, false,
          'a player whose payment is not verified must not reach the big screen');
        T.assert(String(look.message).length > 0,
          'but the organiser is told why, so they can act on it (DESIGN.md §15 case 19)');
        T.assertEqual(
          Util.toInt(player(blocked.players[0].player_id).times_called, 0), 0,
          'and looking them up does not count as calling them');

        // A serial nobody used.
        const e = T.assertThrows(() => Suites._call('auction.getBySerial',
          { tournamentId: w.tid, serialNo: 4242 }, admin), ERR.NOT_FOUND,
          'a serial that is not in this tournament');
        T.assert(String(e.message).indexOf('4242') !== -1,
          'the message must repeat the number they typed (DESIGN.md §15 case 18), got "' +
          e.message + '"');
      });

      // -----------------------------------------------------------------------
      // all_teams_full — the advisory that tells the organiser when to stop
      // -----------------------------------------------------------------------

      T.test('all_teams_full flips true only when the very last slot fills', function () {
        const w = liveWorld('aucfull', {
          teams: [
            { team_name: 'ZZ Solo One', purse_total: 1000000, max_players: 1 },
            { team_name: 'ZZ Solo Two', purse_total: 1000000, max_players: 1 }
          ],
          players: 4
        });
        const summary = () => Suites._call('auction.summary', { tournamentId: w.tid }, admin);

        let s = summary();
        T.assertEqual(s.teams_total, 2, 'two teams');
        T.assertEqual(s.teams_full, 0, 'neither full yet');
        T.assertEqual(s.all_teams_full, false, 'so the banner stays off');
        T.assertEqual(s.banner, '', 'and there is no sentence to show');

        sell(w.tid, w.bySerial[1].player.player_id, w.team['ZZ Solo One'].team_id, 10000);
        s = summary();
        T.assertEqual(s.teams_full, 1, 'one team is now full');
        T.assertEqual(s.all_teams_full, false,
          'ONE full team is not all of them. Flipping here would tell the organiser to ' +
          'close the auction with half the squads empty.');

        sell(w.tid, w.bySerial[2].player.player_id, w.team['ZZ Solo Two'].team_id, 20000);
        s = summary();
        T.assertEqual(s.teams_full, 2, 'both teams are full');
        T.assertEqual(s.all_teams_full, true, 'and only now does the advisory turn on');
        T.assert(s.banner.indexOf('2 teams are full') !== -1,
          'the banner says how many teams, got "' + s.banner + '"');
        T.assert(s.banner.indexOf(String(s.not_called)) !== -1,
          'and how many players were never called — the number that makes it an ' +
          'explainable ending rather than an abandoned auction (DESIGN.md §6.9)');

        // The four honest labels partition the eligible pool.
        T.assertEqual(s.sold + s.unsold + s.awaiting_reauction + s.not_called, s.eligible,
          'sold + unsold + awaiting + not_called must equal the eligible pool, or one ' +
          'of the four is double-counting');
        T.assertEqual(s.sold, 2, 'two sold');
        T.assertEqual(s.not_called, 2, 'and two nobody ever reached');

        // Advisory only — nothing about it stops a further sale being attempted,
        // and the failure is the ordinary TEAM_FULL, not a special "auction over".
        T.assertThrows(() => sell(w.tid, w.bySerial[3].player.player_id,
          w.team['ZZ Solo One'].team_id, 10000), ERR.TEAM_FULL,
          'the banner is advisory; the real refusal is still the §4.1 squad check');
      });

      // -----------------------------------------------------------------------
      // Closing — DESIGN.md §6.8, §15 case 20
      // -----------------------------------------------------------------------

      T.test('after close every organiser write is refused, reads work, ADMIN can correct',
        function () {
          const w = liveWorld('aucshut', {
            teams: [{ team_name: 'ZZ Shut', purse_total: 1000000, max_players: 13 }],
            players: 3
          });
          const t = w.team['ZZ Shut'];
          const organiser = Suites._organiserSession('aucorg', w.tid);
          const sold = w.bySerial[1].player;

          sell(w.tid, sold.player_id, t.team_id, 120000);

          const closed = Suites._call('auction.close',
            { tournamentId: w.tid, expectedVersion: ver(w.tid), note: 'ZZ done' }, admin);
          T.assertEqual(closed.status, ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED,
            'the auction closes');
          T.assertEqual(closed.alreadyClosed, false, 'first time');
          T.assertEqual(closed.summary.sold, 1, 'and the closing summary counts the sale');
          T.assertEqual(closed.summary.total_spent, 120000, 'and the money');
          T.assertEqual(
            Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', w.tid).status,
            ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED, 'the row followed');
          T.assertEqual(
            Suites._auditRows(w.tid, Audit.ACTIONS.AUCTION_CLOSED).length, 1,
            'exactly one AUCTION_CLOSED row');

          // ---- every organiser WRITE is refused, with the code that says why
          const spare = w.bySerial[2].player;
          T.assertThrows(() => Suites._call('auction.markSold', {
            tournamentId: w.tid, playerId: spare.player_id, teamId: t.team_id,
            amount: 50000, expectedVersion: ver(w.tid)
          }, organiser), ERR.AUCTION_CLOSED, 'markSold after the close');
          T.assertThrows(() => Suites._call('auction.markUnsold', {
            tournamentId: w.tid, playerId: spare.player_id, expectedVersion: ver(w.tid)
          }, organiser), ERR.AUCTION_CLOSED, 'markUnsold after the close');
          T.assertThrows(() => Suites._call('auction.returnToPool', {
            tournamentId: w.tid, playerId: spare.player_id, expectedVersion: ver(w.tid)
          }, organiser), ERR.AUCTION_CLOSED, 'returnToPool after the close');
          T.assertThrows(() => Suites._call('auction.getBySerial',
            { tournamentId: w.tid, serialNo: 2 }, organiser), ERR.AUCTION_CLOSED,
            'getBySerial too — it writes times_called and puts a face on the projector');
          T.assertThrows(() => Suites._call('team.create',
            { tournamentId: w.tid, teamName: 'ZZ Too Late' }, organiser),
            ERR.AUCTION_CLOSED, 'and a team change is an organiser write as well');
          T.assertThrows(() => Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: sold.player_id, newStatus: AS.SOLD,
            teamId: t.team_id, amount: 100000, expectedVersion: ver(w.tid)
          }, organiser), ERR.AUCTION_CLOSED,
            '§4.2: an organiser may correct only until the auction is closed');

          T.assertEqual(player(spare.player_id).auction_status, AS.PENDING,
            'and not one of those refusals changed anything');

          // ---- reads keep working, because the report is written afterwards
          const summary = Suites._call('auction.summary', { tournamentId: w.tid }, organiser);
          T.assertEqual(summary.status, ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED,
            'the summary still reads, and says the auction is closed');
          T.assertEqual(summary.sold, 1, 'with the numbers intact');
          T.assert(Suites._call('auction.search', { tournamentId: w.tid }, organiser).total >= 3,
            'search still reads');
          T.assert(Suites._call('auction.history', { tournamentId: w.tid }, organiser).total >= 1,
            'and so does the history');
          T.assert(typeof Suites._call('auction.state',
            { tournamentId: w.tid, v: -1 }, organiser).v === 'number',
            'and the poll');
          T.assert(Suites._call('team.list', { tournamentId: w.tid }, organiser).teams.length >= 1,
            'and the team dashboard');

          // ---- ADMIN can still fix a mistake, which is when most are noticed
          const fixed = Suites._call('auction.correct', {
            tournamentId: w.tid, playerId: sold.player_id, newStatus: AS.SOLD,
            teamId: t.team_id, amount: 100000, expectedVersion: ver(w.tid),
            note: 'ZZ typo found after the close'
          }, admin);
          T.assertEqual(fixed.result.status, RS.SOLD, 'the correction goes through');
          T.assertEqual(team(t.team_id).purse_used, 100000,
            'and the purse is corrected to the new figure');

          // Closing twice is not an error worth a scary message.
          const again = Suites._call('auction.close',
            { tournamentId: w.tid, expectedVersion: ver(w.tid) }, admin);
          T.assertEqual(again.alreadyClosed, true, 'a second close is a no-op');

          // Only an admin may reopen, and it is audited (DESIGN.md §6.8).
          const reopened = Suites._call('auction.reopen',
            { tournamentId: w.tid, expectedVersion: ver(w.tid), reason: 'ZZ one more lot' },
            admin);
          T.assertEqual(reopened.status, ENUM.TOURNAMENT_STATUS.AUCTION_LIVE,
            'an admin can reopen');
          T.assertEqual(
            Suites._auditRows(w.tid, Audit.ACTIONS.AUCTION_REOPENED).length, 1,
            'and reopening is audited — it re-enables every organiser write');
          const back = sell(w.tid, spare.player_id, t.team_id, 40000, organiser);
          T.assertEqual(back.player.auction_status, AS.SOLD,
            'after which the organiser can work again');
        });

      // -----------------------------------------------------------------------
      // The projector feed — §4.2, DESIGN.md §8, §16 risk 7
      // -----------------------------------------------------------------------

      T.test('displayState needs the right token and carries no personal data',
        function () {
          const w = liveWorld('aucdisp', {
            teams: [{ team_name: 'ZZ Screen', purse_total: 1000000, max_players: 13 }],
            players: 2
          });
          const token = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', w.tid).display_token;
          T.assert(!Util.isBlank(token), 'fixture check: the tournament has a display token');
          // Auction.gs caches a verified token for five minutes under a key of its
          // own; cleanup has to be told about it or the next run starts trusting a
          // token this one issued.
          T.trackCacheKey(AUCTION_DTOK_PREFIX + w.tid + ':' + Util.sha256Hex(token));

          // Put somebody on the screen so `current` is not null.
          Suites._call('auction.getBySerial', { tournamentId: w.tid, serialNo: 1 }, admin);
          const p = player(w.bySerial[1].player.player_id);
          const pay = Repo.findBy(SHEETS.PAYMENTS, 'player_id', p.player_id);
          T.assert(pay !== null, 'fixture check: the player has a payment row');

          // ---- the gate
          [['', 'no token at all'],
           ['zz-not-the-display-token', 'a token that was never issued'],
           [token + 'x', 'the right token with one extra character'],
           [String(token).toUpperCase(), 'the right token in the wrong case']
          ].forEach(pair => {
            if (pair[0] === String(token)) return;
            T.assertThrows(() => Suites._call('auction.displayState',
              { tournamentId: w.tid, k: pair[0] }, null), ERR.UNAUTHORIZED, pair[1]);
          });

          // A valid token for the WRONG tournament must not open this one.
          const otherToken = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', main().tid)
            .display_token;
          T.assertThrows(() => Suites._call('auction.displayState',
            { tournamentId: w.tid, k: otherToken }, null), ERR.UNAUTHORIZED,
            'another tournament\'s display token');

          // ---- the feed itself
          const out = Suites._call('auction.displayState',
            { tournamentId: w.tid, k: token, v: -1 }, null);
          T.assertEqual(out.same, false, 'a client with no version gets the full snapshot');
          T.assert(out.current !== null, 'and the player who was called is on it');
          T.assertEqual(out.current.serial_no, 1, 'the right one');
          T.assertEqual(out.current.name, p.name, 'by name');
          T.assert(Array.isArray(out.teams) && out.teams.length === 1,
            'with the team strip, got ' + T._fmt(out.teams));

          // ==================== THE SECURITY TEST ==============================
          // This goes to a screen in a public hall. The payload is built field by
          // field from the snapshot rather than spread, so that a field added to
          // the snapshot later cannot be published by accident. The assertions
          // below are made against the SERIALISED response, so a value nested
          // inside an allowed key fails here too.
          // =====================================================================
          const wire = JSON.stringify(out);
          ['mobile', 'upi_ref', 'payment_status', 'player_id', 'team_id',
           'is_withdrawn', 'photo_file_id', 'screenshot_file_id', 'dob']
            .forEach(needle => {
              T.assert(wire.indexOf(needle) === -1,
                'the projector feed carries "' + needle + '". A hall full of people can ' +
                'photograph that screen.');
            });
          [['mobile number', p.mobile],
           ['UPI reference', pay.upi_ref],
           ['payment status', 'VERIFIED']].forEach(pair => {
            if (Util.isBlank(pair[1])) return;
            T.assert(wire.indexOf(String(pair[1])) === -1,
              'the ' + pair[0] + ' "' + pair[1] + '" appears in the projector feed even ' +
              'though its key does not');
          });

          // photo_url is the 1024px projector variant; photo_thumb_url (320px)
          // stays as the fallback. Neither identifies a person beyond the photo
          // the audience is already looking at.
          T.assertEqual(Object.keys(out.current).sort(), [
            'age_years', 'auction_status', 'name', 'photo_thumb_url', 'photo_url',
            'role', 'serial_no', 'sold_amount_display', 'style', 'team_name'
          ], 'the projector card is exactly what §4.5 says the screen shows');

          // per_slot_remaining_display is deliberately gone: it divided the
          // remaining purse by empty slots, implying a per-player price, and
          // every player here sells for a different amount (DESIGN.md §6.5a).
          T.assertEqual(Object.keys(out.teams[0]).sort(), [
            'max_players', 'players_count', 'purse_remaining_display', 'team_name'
          ], 'and a team strip entry is exactly the four fields it renders');

          // The tournament NAME reaches the projector; its id must not be the
          // thing an audience reads.
          T.assert(!Util.isBlank(out.tournament_name),
            'the projector feed carries the tournament name');

          // The 2-second poll: unchanged means ~30 bytes and no snapshot at all.
          const same = Suites._call('auction.displayState',
            { tournamentId: w.tid, k: token, v: out.v }, null);
          T.assertEqual(same, { v: out.v, same: true },
            'an unchanged poll must answer with nothing but the version. Two clients ' +
            'polling every 2 s for three hours is ~10,800 requests (§4.5).');
        });

      // -----------------------------------------------------------------------
      // THE INVARIANT SWEEP — everything this suite did, re-derived from scratch
      // -----------------------------------------------------------------------

      T.test('INVARIANT SWEEP: every counter, every player row and every is_current flag',
        function () {
          // Each test above checks its own arithmetic. This one re-derives ALL of
          // it from the append-only truth, across every tournament the suite
          // touched, and is the test that would catch a sale that quietly worked
          // twice or a correction that reversed a purse it should not have.
          T.assert(worlds.length >= 8,
            'the sweep is only meaningful if the suite actually built its worlds; it ' +
            'found ' + worlds.length);

          const allPlayers = Repo.readAll(SHEETS.PLAYERS);
          const allTeams = Repo.readAll(SHEETS.TEAMS);
          const allResults = Repo.readAll(SHEETS.AUCTION_RESULTS);

          worlds.forEach(tid => {
            const rows = allResults.filter(r => r.tournament_id === tid);

            // --- 1. exactly one is_current row per player that has any history
            const seen = {};
            rows.forEach(r => {
              const id = String(r.player_id);
              if (!seen[id]) seen[id] = { total: 0, current: 0 };
              seen[id].total++;
              if (r.is_current === true) seen[id].current++;
            });
            Object.keys(seen).forEach(id => {
              T.assertEqual(seen[id].current, 1,
                tid + ' player ' + id + ' has ' + seen[id].current + ' rows flagged ' +
                'is_current out of ' + seen[id].total + '. Exactly one row per player ' +
                'may be the standing answer (DESIGN.md §2.6) — any other number and ' +
                'the reports, the counters and the projector will each pick a ' +
                'different one.');
            });

            // --- 2. every team counter equals its AuctionResults truth
            const truth = {};
            rows.forEach(r => {
              if (r.is_current !== true) return;
              if (String(r.status) !== RS.SOLD) return;
              const id = String(r.team_id);
              if (!truth[id]) truth[id] = { spent: 0, players: 0 };
              truth[id].spent += Util.toInt(r.amount, 0);
              truth[id].players += 1;
            });
            allTeams.filter(t => t.tournament_id === tid).forEach(t => {
              const want = truth[String(t.team_id)] || { spent: 0, players: 0 };
              T.assertEqual(Util.toInt(t.purse_used, 0), want.spent,
                tid + ' team "' + t.team_name + '": purse_used is ' + t.purse_used +
                ' but the current SOLD rows add up to ' + want.spent + '. The counter ' +
                'is a cache of AuctionResults and it has drifted.');
              T.assertEqual(Util.toInt(t.players_count, 0), want.players,
                tid + ' team "' + t.team_name + '": players_count is ' + t.players_count +
                ' but ' + want.players + ' current SOLD rows point at it');
              T.assert(Util.toInt(t.purse_used, 0) <= Util.toInt(t.purse_total, 0),
                tid + ' team "' + t.team_name + '" has spent more than its purse');
              T.assert(Util.toInt(t.players_count, 0) <= Util.toInt(t.max_players, 0),
                tid + ' team "' + t.team_name + '" holds more players than its squad size');
            });

            // --- 3. every Players row agrees with its own standing result row
            const byPlayer = {};
            rows.forEach(r => { if (r.is_current === true) byPlayer[String(r.player_id)] = r; });
            allPlayers.filter(p => p.tournament_id === tid).forEach(p => {
              const r = byPlayer[String(p.player_id)];

              // A player the system says is SOLD must have a sale behind them.
              if (String(p.auction_status) === AS.SOLD) {
                T.assert(r && String(r.status) === RS.SOLD,
                  tid + ' player #' + p.serial_no + ' is SOLD on the Players tab with no ' +
                  'current SOLD row behind them. Their money is charged against nothing.');
              }
              if (!r) return;

              if (String(r.status) === RS.SOLD) {
                T.assertEqual(String(p.auction_status), AS.SOLD,
                  tid + ' player #' + p.serial_no + ': the standing result is a sale but ' +
                  'the Players row says ' + p.auction_status);
                T.assertEqual(String(p.team_id), String(r.team_id),
                  tid + ' player #' + p.serial_no + ' points at a different team from ' +
                  'their own sale row');
                T.assertEqual(Util.toInt(p.sold_amount, 0), Util.toInt(r.amount, 0),
                  tid + ' player #' + p.serial_no + ': the Players row says ' +
                  p.sold_amount + ' and the sale row says ' + r.amount);
                T.assert(!Util.isBlank(p.sold_at),
                  tid + ' player #' + p.serial_no + ' is sold with no sold_at');
              } else if (String(r.status) === RS.UNSOLD) {
                T.assertEqual(String(p.auction_status), AS.UNSOLD,
                  tid + ' player #' + p.serial_no + ': the standing result is UNSOLD but ' +
                  'the Players row says ' + p.auction_status);
                T.assertEqual(String(p.team_id || ''), '',
                  tid + ' player #' + p.serial_no + ' is unsold but holds a team_id');
              } else {
                T.assertEqual(String(p.auction_status), AS.PENDING,
                  tid + ' player #' + p.serial_no + ': the standing result returned them ' +
                  'to the pool but the Players row says ' + p.auction_status);
                T.assertEqual(String(p.team_id || ''), '',
                  tid + ' player #' + p.serial_no + ' is back in the pool but still holds ' +
                  'a team_id — that is money spent against nobody');
                T.assertEqual(Util.isBlank(p.sold_amount), true,
                  tid + ' player #' + p.serial_no + ' is back in the pool but still ' +
                  'carries sold_amount ' + T._fmt(p.sold_amount));
              }
            });

            // --- 4. a superseding row always points at a real row of the same player
            rows.filter(r => !Util.isBlank(r.supersedes_auction_id)).forEach(r => {
              const target = rows.filter(x =>
                String(x.auction_id) === String(r.supersedes_auction_id))[0];
              T.assert(target,
                tid + ' result ' + r.auction_id + ' supersedes ' +
                r.supersedes_auction_id + ', which is not in this tournament');
              T.assertEqual(String(target.player_id), String(r.player_id),
                tid + ' result ' + r.auction_id + ' supersedes a row about a DIFFERENT ' +
                'player');
              T.assertEqual(target.is_current, false,
                tid + ' result ' + target.auction_id + ' has been superseded but is ' +
                'still flagged is_current');
            });
          });
        });
    });
  },

  // ===========================================================================
  // Reports — CONTRACTS-PHASE4-7.md PHASE 6 and PHASE 7 item 1.
  // Rationale: DESIGN.md §6.9 (the four labels), §10, §35, §42, §45.
  //
  // A CSV export is only worth anything if the person who receives it can open
  // it in Excel and sum a column. Four separate things silently break that, and
  // each has its own test below: a currency symbol turning a numeric column into
  // text, a 10-digit mobile becoming 9.87654E+09, a comma inside a name shifting
  // every later column on that row, and a missing BOM rendering Tamil names as
  // mojibake.
  //
  // Every parse assertion goes through Suites._parseCsv, a real RFC 4180 reader
  // written for this suite. Splitting on commas would pass on a file that Excel
  // cannot read, which is precisely the bug being hunted.
  // ===========================================================================

  reports() {
    T.suite('Reports', function () {
      const admin = Suites._adminSession('rptadm');
      const PS = ENUM.PAYMENT_STATUS;
      const AS = ENUM.AUCTION_STATUS;
      const fx = {};

      /**
       * One tournament carrying every shape the exports have to survive: a name
       * with a comma, a name with a double quote, a Tamil name, all four auction
       * outcomes, an empty team, and a superseded result row.
       */
      function world() {
        if (fx.world) return fx.world;
        const t = Suites._seedTournament('rptmain', {
          withFolders: false, status: ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED, reg_fee: 500
        });
        const kings = Suites._seedTeam(t.tid, {
          team_name: 'ZZ Kings', purse_total: 1000000, max_players: 3,
          purse_used: 375000, players_count: 2
        });
        const queens = Suites._seedTeam(t.tid, {
          team_name: 'ZZ Queens', purse_total: 800000, max_players: 3,
          purse_used: 75000, players_count: 1
        });
        const jokers = Suites._seedTeam(t.tid, {
          team_name: 'ZZ Jokers', purse_total: 600000, max_players: 3
        });

        const roster = Suites._seedRoster(t.tid, [
          // A comma in a name is not exotic. One of 400 people will have one, and
          // an unquoted field shifts every later column on that row.
          { serial_no: 1, name: 'ZZ Comma, Player', payment_status: PS.VERIFIED,
            auction_status: AS.SOLD, team_id: kings.team_id, sold_amount: 125000,
            sold_at: '2026-08-30T18:40:00.000Z', times_called: 1 },
          // A double quote has to be escaped by doubling it (RFC 4180).
          { serial_no: 2, name: 'ZZ "Quote" Player', payment_status: PS.VERIFIED,
            auction_status: AS.SOLD, team_id: kings.team_id, sold_amount: 250000,
            sold_at: '2026-08-30T18:45:00.000Z', times_called: 1 },
          // Names may be in any script (KNOWN-ISSUES, decisions recorded). Without
          // the BOM this one is mojibake in Excel on Windows.
          { serial_no: 3, name: 'ராஜ் குமார்', payment_status: PS.VERIFIED,
            auction_status: AS.SOLD, team_id: queens.team_id, sold_amount: 75000,
            sold_at: '2026-08-30T18:50:00.000Z', times_called: 2 },
          { serial_no: 4, name: 'ZZ Nobody Bid', payment_status: PS.VERIFIED,
            auction_status: AS.UNSOLD, times_called: 1 },
          { serial_no: 5, name: 'ZZ Back In Pool', payment_status: PS.VERIFIED,
            auction_status: AS.PENDING, times_called: 3 },
          { serial_no: 6, name: 'ZZ Never Reached', payment_status: PS.VERIFIED,
            auction_status: AS.PENDING, times_called: 0 },
          { serial_no: 7, name: 'ZZ Unpaid', payment_status: PS.PENDING, times_called: 0 }
        ]);

        // History, including one superseded row so report.final has a correction
        // to show and dashboard.adminStats has one to count.
        const superseded = Suites._seedResult(t.tid, {
          player_id: roster.bySerial[1].player.player_id, serial_no: 1,
          team_id: kings.team_id, amount: 900000, is_current: false,
          auction_time: '2026-08-30T18:35:00.000Z', recorded_by: admin.user_id
        });
        Suites._seedResult(t.tid, {
          player_id: roster.bySerial[1].player.player_id, serial_no: 1,
          team_id: kings.team_id, amount: 125000,
          auction_time: '2026-08-30T18:40:00.000Z', recorded_by: admin.user_id,
          supersedes_auction_id: superseded.auction_id, note: 'ZZ extra zero'
        });
        Suites._seedResult(t.tid, {
          player_id: roster.bySerial[2].player.player_id, serial_no: 2,
          team_id: kings.team_id, amount: 250000,
          auction_time: '2026-08-30T18:45:00.000Z', recorded_by: admin.user_id
        });
        Suites._seedResult(t.tid, {
          player_id: roster.bySerial[3].player.player_id, serial_no: 3,
          team_id: queens.team_id, amount: 75000,
          auction_time: '2026-08-30T18:50:00.000Z', recorded_by: admin.user_id
        });
        Suites._seedResult(t.tid, {
          player_id: roster.bySerial[4].player.player_id, serial_no: 4,
          status: ENUM.RESULT_STATUS.UNSOLD, amount: '',
          auction_time: '2026-08-30T18:55:00.000Z', recorded_by: admin.user_id
        });

        fx.world = {
          tid: t.tid, slug: t.slug,
          teams: { kings: kings, queens: queens, jokers: jokers },
          players: roster.players, bySerial: roster.bySerial
        };
        return fx.world;
      }

      /** Run an export and hand back the envelope, the decoded text and the grid. */
      function csv(action, session) {
        const out = Suites._call(action, { tournamentId: world().tid }, session || admin);
        T.assertEqual(out.mime, REPORT_MIME_CSV, action + ' must declare the CSV mime type');
        T.assert(typeof out.base64 === 'string' && out.base64.length > 0,
          action + ' must return base64 content, got ' + T._fmt(out.base64));
        const text = Suites._decodeCsv(out.base64);
        // The BOM is asserted separately; it is stripped here so the first header
        // cell compares as plain text.
        const body = (text.charAt(0) === REPORT_BOM) ? text.slice(1) : text;
        return { out: out, text: text, grid: Suites._parseCsv(body) };
      }

      /** A grid row indexed by its header, so a column move fails loudly. */
      function byHeader(grid) {
        const head = grid[0];
        return grid.slice(1).map(cells => {
          const row = {};
          head.forEach((h, i) => { row[h] = (i < cells.length) ? cells[i] : undefined; });
          row._cells = cells;
          return row;
        });
      }

      // -----------------------------------------------------------------------
      // Routing
      // -----------------------------------------------------------------------

      T.test('exports are POST-only for ADMIN and ORGANISER; stats and audit are ADMIN',
        function () {
          ['report.players', 'report.teams', 'report.auction', 'report.final']
            .forEach(name => {
              const r = Suites._route(name);
              T.assert(r.methods.indexOf('POST') !== -1, name + ' must accept POST');
              T.assert(r.methods.indexOf('GET') === -1,
                name + ' must not be offered on GET — the player export carries 400 ' +
                'mobile numbers and a GET URL is callable from a link with no token');
              T.assert(r.auth !== 'PUBLIC', name + ' must never be PUBLIC');
              T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN) &&
                Suites._authAllows(r.auth, ENUM.USER_ROLE.ORGANISER),
                name + ' must allow both roles: an organiser running the auction needs ' +
                'the team sheet in their hand, and it is their own tournament\'s data. ' +
                'Got auth = ' + T._fmt(r.auth));
            });

          ['dashboard.adminStats', 'audit.list'].forEach(name => {
            const r = Suites._route(name);
            T.assert(r.methods.indexOf('POST') !== -1, name + ' must accept POST');
            T.assert(Suites._authAllows(r.auth, ENUM.USER_ROLE.ADMIN),
              name + ' must allow ADMIN');
            T.assert(!Suites._authAllows(r.auth, ENUM.USER_ROLE.ORGANISER),
              name + ' is ADMIN only. adminStats reports across every tournament when ' +
              'no id is given, and the audit trail is evidence about the organisers ' +
              'themselves. Got auth = ' + T._fmt(r.auth));
          });

          // An organiser really can export their own tournament, through the real
          // front door, and really cannot export somebody else's.
          const w = world();
          const organiser = Suites._organiserSession('rptorg', w.tid);
          const mine = Suites._dispatch('report.players', { tournamentId: w.tid },
            organiser.token, 'POST');
          T.assertEqual(mine.ok, true,
            'an organiser must be able to export their own tournament, got ' +
            T._fmt(mine.error));
          const elsewhere = Suites._seedTournament('rptelse', { withFolders: false });
          const theirs = Suites._dispatch('report.players', { tournamentId: elsewhere.tid },
            organiser.token, 'POST');
          T.assertEqual(theirs.ok, false, 'and nobody else\'s');
          T.assertEqual(theirs.error.code, ERR.FORBIDDEN,
            'a valid token pointed at another tournament is FORBIDDEN');
        });

      // -----------------------------------------------------------------------
      // RFC 4180 round trip — the test the naive split would pass
      // -----------------------------------------------------------------------

      T.test('every CSV parses back exactly, including comma, quote and Tamil names',
        function () {
          const w = world();
          const files = {
            players: csv('report.players'),
            teams: csv('report.teams'),
            auction: csv('report.auction'),
            final: csv('report.final')
          };

          Object.keys(files).forEach(kind => {
            T.assertEqual(files[kind].text.charAt(0), REPORT_BOM,
              'the ' + kind + ' export must start with a UTF-8 BOM. Without it Excel on ' +
              'Windows guesses the code page and every non-Latin name comes out as ' +
              'mojibake — and names are explicitly allowed in any script.');
            T.assert(files[kind].text.indexOf(REPORT_EOL) !== -1,
              'the ' + kind + ' export must use CRLF line endings (RFC 4180)');
            T.assert(files[kind].grid.length > 1,
              'the ' + kind + ' export has no data rows at all');
          });

          // ---- report.players: the column list is fixed by the requirement
          const players = files.players;
          T.assertEqual(players.grid[0], [
            'Serial No', 'Name', 'DOB', 'Role', 'Style', 'Mobile', 'Payment Reference',
            'Payment Status', 'Auction Status', 'Team', 'Purchase Amount'
          ], 'the Player List columns are copied verbatim from CONTRACTS-PHASE4-7 PHASE 6');
          T.assertEqual(players.grid.length, 8, 'one header row and seven players');
          T.assertEqual(players.out.rows, 7, 'and the envelope says so too');

          players.grid.forEach((cells, i) => {
            T.assertEqual(cells.length, 11,
              'row ' + i + ' of the player export has ' + cells.length + ' fields, not ' +
              '11. A field written without quoting is exactly how every later column ' +
              'on a row ends up shifted by one.');
          });

          const rows = byHeader(players.grid);
          const bySerial = {};
          rows.forEach(r => { bySerial[r['Serial No']] = r; });

          T.assertEqual(bySerial['1'].Name, 'ZZ Comma, Player',
            'a name containing a comma must come back BYTE FOR BYTE. If this fails, ' +
            'the Team and Purchase Amount columns on that row are one place out and no ' +
            'total in the workbook is right.');
          T.assertEqual(bySerial['2'].Name, 'ZZ "Quote" Player',
            'a name containing a double quote must come back unchanged — the quotes are ' +
            'doubled inside the field and undoubled on the way out');
          T.assertEqual(bySerial['3'].Name, 'ராஜ் குமார்',
            'and a Tamil name must survive the UTF-8 round trip intact');

          // The raw text has to be quoted the way RFC 4180 says, not merely
          // parseable by a forgiving reader.
          T.assert(players.text.indexOf('"ZZ Comma, Player"') !== -1,
            'the comma name must be wrapped in quotes in the file itself');
          T.assert(players.text.indexOf('"ZZ ""Quote"" Player"') !== -1,
            'and the quote name must have its quotes doubled');

          // ---- report.teams and report.auction keep their shape too
          T.assertEqual(files.teams.grid[0], [
            'Team', 'Player', 'Purchase Amount', 'Total Players', 'Total Spent',
            'Remaining Purse'
          ], 'the Team Report columns');
          files.teams.grid.forEach((cells, i) => {
            T.assertEqual(cells.length, 6, 'team row ' + i + ' must have 6 fields');
          });

          T.assertEqual(files.auction.grid[0], [
            'Serial No', 'Player', 'Status', 'Team', 'Purchase Amount', 'Auction Time'
          ], 'the Auction Report columns');
          files.auction.grid.forEach((cells, i) => {
            T.assertEqual(cells.length, 6, 'auction row ' + i + ' must have 6 fields');
          });

          // The awkward names appear, correctly, in every file that lists players.
          [files.teams, files.auction, files.final].forEach(f => {
            const flat = f.grid.map(cells => cells.join(' ')).join(' ');
            ['ZZ Comma, Player', 'ZZ "Quote" Player', 'ராஜ் குமார்'].forEach(name => {
              T.assert(flat.indexOf(name) !== -1,
                'the name "' + name + '" did not survive the round trip in ' +
                f.out.filename);
            });
          });

          T.assert(files.players.out.filename.indexOf(w.slug) === 0,
            'the filename starts with the tournament slug, got ' +
            T._fmt(files.players.out.filename));
        });

      // -----------------------------------------------------------------------
      // Excel: money and mobiles
      // -----------------------------------------------------------------------

      T.test('money columns are bare integers — no rupee symbol, no thousands separator',
        function () {
          // ONE currency symbol makes the whole column TEXT, and every SUM in the
          // workbook then returns 0 with nothing on screen to say why. Util.formatINR
          // is for screens; it must never reach a CSV numeric column.
          const files = ['report.players', 'report.teams', 'report.auction', 'report.final']
            .map(a => csv(a));

          files.forEach(f => {
            T.assert(f.text.indexOf('₹') === -1,
              f.out.filename + ' contains a ₹ symbol. That turns the money column into ' +
              'text in Excel and silently breaks every total in the sheet.');
          });

          const money = (grid, header) => {
            const rows = byHeader(grid);
            return rows.map(r => r[header]);
          };

          money(files[0].grid, 'Purchase Amount').forEach(cell => {
            T.assert(/^[0-9]*$/.test(cell),
              'a Purchase Amount cell must be bare digits or empty, got ' + T._fmt(cell));
          });
          ['Purchase Amount', 'Total Spent', 'Remaining Purse', 'Total Players']
            .forEach(header => {
              money(files[1].grid, header).forEach(cell => {
                T.assert(/^[0-9]*$/.test(cell),
                  'the ' + header + ' column must be bare digits, got ' + T._fmt(cell));
              });
            });
          money(files[2].grid, 'Purchase Amount').forEach(cell => {
            T.assert(/^[0-9]*$/.test(cell),
              'the auction report Purchase Amount must be bare digits, got ' + T._fmt(cell));
          });

          // The values are right, not merely well-shaped.
          const rows = byHeader(files[0].grid);
          const bySerial = {};
          rows.forEach(r => { bySerial[r['Serial No']] = r; });
          T.assertEqual(bySerial['1']['Purchase Amount'], '125000',
            'the exact integer, with no grouping — 1,25,000 would be four cells');
          T.assertEqual(bySerial['2']['Purchase Amount'], '250000', 'and the next one');
          T.assertEqual(bySerial['6']['Purchase Amount'], '',
            'a player who was never sold gets an EMPTY cell, not a 0. SUM ignores an ' +
            'empty cell, which is what "not sold" should contribute.');
        });

      T.test('mobile numbers and UPI references carry the ="..." Excel wrapper', function () {
        // Without it a 10-digit mobile is read as a number and shown as 9.87654E+09,
        // and Excel will reinterpret an alphanumeric UPI reference like 1234E5 as
        // scientific notation too.
        const w = world();
        const f = csv('report.players');
        const rows = byHeader(f.grid);
        const bySerial = {};
        rows.forEach(r => { bySerial[r['Serial No']] = r; });

        w.players.forEach(p => {
          const cell = bySerial[String(p.serial_no)];
          T.assert(cell, 'serial ' + p.serial_no + ' is missing from the export');
          T.assertEqual(cell.Mobile, '="' + p.mobile + '"',
            'the Mobile cell must be the ="..." formula form, got ' + T._fmt(cell.Mobile));
        });

        const payments = Repo.readAll(SHEETS.PAYMENTS).filter(r => r.tournament_id === w.tid);
        const refByPlayer = {};
        payments.forEach(r => { refByPlayer[r.player_id] = r.upi_ref; });
        w.players.forEach(p => {
          const ref = refByPlayer[p.player_id];
          if (Util.isBlank(ref)) return;
          T.assertEqual(bySerial[String(p.serial_no)]['Payment Reference'], '="' + ref + '"',
            'the UPI reference needs the same protection as the mobile number');
        });

        // And in the file itself the quotes are doubled, so the cell survives a
        // reader that is stricter than Excel.
        T.assert(f.text.indexOf('"=""') !== -1,
          'the ="..." wrapper must itself be quoted and its quotes doubled in the file');
      });

      // -----------------------------------------------------------------------
      // The four honest labels — DESIGN.md §6.9
      // -----------------------------------------------------------------------

      T.test('all four auction labels land on the right rows', function () {
        // All 400 players paid the fee, and roughly 300 are never called. "Not
        // called" has to be a visible, explainable outcome, and "nobody bid on
        // you" is a different sentence from "your number never came up".
        const files = { players: csv('report.players'), auction: csv('report.auction') };

        [['players', 'Auction Status'], ['auction', 'Status']].forEach(pair => {
          const rows = byHeader(files[pair[0]].grid);
          const bySerial = {};
          rows.forEach(r => { bySerial[r['Serial No']] = r; });
          const label = s => bySerial[String(s)][pair[1]];

          T.assertEqual(label(1), REPORT_LABEL.SOLD,
            pair[0] + ': a bought player reads "' + REPORT_LABEL.SOLD + '"');
          T.assertEqual(label(4), REPORT_LABEL.UNSOLD,
            pair[0] + ': UNSOLD means they came to the table and nobody bid');
          T.assertEqual(label(5), REPORT_LABEL.AWAITING,
            pair[0] + ': PENDING with times_called = 3 is "' + REPORT_LABEL.AWAITING +
            '" — they were returned to the pool and may still sell (DESIGN.md §6.6)');
          T.assertEqual(label(6), REPORT_LABEL.NOT_CALLED,
            pair[0] + ': PENDING with times_called = 0 is "' + REPORT_LABEL.NOT_CALLED +
            '". Reporting that as "Pending" hides the single most common outcome ' +
            'behind a word that sounds like a delay.');
          T.assertEqual(label(7), REPORT_LABEL.NOT_CALLED,
            pair[0] + ': an unpaid player was never in the pool, so they were never ' +
            'called either');

          // The raw statuses must not appear anywhere in the column.
          rows.forEach(r => {
            T.assert([REPORT_LABEL.SOLD, REPORT_LABEL.UNSOLD, REPORT_LABEL.AWAITING,
              REPORT_LABEL.NOT_CALLED].indexOf(r[pair[1]]) !== -1,
              pair[0] + ' row for serial ' + r['Serial No'] + ' has the status "' +
              r[pair[1]] + '", which is not one of the four labels of DESIGN.md §6.9');
          });
        });

        // The payment column is a separate fact, and a withdrawal is annotated
        // rather than hidden.
        const pRows = byHeader(files.players.grid);
        const byS = {};
        pRows.forEach(r => { byS[r['Serial No']] = r; });
        T.assertEqual(byS['1']['Payment Status'], 'Verified', 'a verified payment');
        T.assertEqual(byS['7']['Payment Status'], 'Pending', 'and one still waiting');
        T.assertEqual(byS['1'].Team, 'ZZ Kings', 'the Team column names the buyer');
        T.assertEqual(byS['6'].Team, '', 'and is empty for a player nobody bought');
      });

      // -----------------------------------------------------------------------
      // The team report has to add up to itself
      // -----------------------------------------------------------------------

      T.test('team report totals equal the sum of the player rows above them', function () {
        // The totals are derived from the rows in THIS FILE, not read off
        // Teams.purse_used, so the file is internally consistent whatever the
        // cached counters say. A reader who sums the column and gets a different
        // number from the Total Spent cell has no way to tell which one to trust.
        const f = csv('report.teams');
        const rows = byHeader(f.grid);

        const groups = {};
        const order = [];
        rows.forEach(r => {
          const name = r.Team;
          if (!groups[name]) { groups[name] = []; order.push(name); }
          groups[name].push(r);
        });

        T.assertEqual(order, ['ZZ Jokers', 'ZZ Kings', 'ZZ Queens'],
          'every team appears, sorted by name — a team that bought nobody must still ' +
          'get a row, because a team silently missing is a worse error than a blank cell');

        const purses = { 'ZZ Jokers': 600000, 'ZZ Kings': 1000000, 'ZZ Queens': 800000 };
        order.forEach(name => {
          const group = groups[name];
          let summed = 0;
          let players = 0;
          group.forEach(r => {
            if (r.Player !== '') {
              players++;
              summed += Util.toInt(r['Purchase Amount'], 0);
            }
          });

          group.forEach(r => {
            T.assertEqual(Util.toInt(r['Total Spent'], 0), summed,
              name + ': Total Spent says ' + r['Total Spent'] + ' but the Purchase ' +
              'Amount cells above it add up to ' + summed);
            T.assertEqual(Util.toInt(r['Total Players'], 0), players,
              name + ': Total Players says ' + r['Total Players'] + ' but ' + players +
              ' player rows are listed');
            T.assertEqual(Util.toInt(r['Remaining Purse'], 0), purses[name] - summed,
              name + ': Remaining Purse must be the purse minus what this file says ' +
              'was spent');
            T.assertEqual(r['Total Spent'], group[0]['Total Spent'],
              name + ': the team-level columns repeat on every row of the team, so a ' +
              'reader who sorts the sheet by Purchase Amount does not lose which ' +
              'totals belong to which team');
          });
        });

        T.assertEqual(groups['ZZ Kings'].length, 2, 'Kings bought two players');
        T.assertEqual(Util.toInt(groups['ZZ Kings'][0]['Total Spent'], 0), 375000,
          '125000 + 250000');
        T.assertEqual(groups['ZZ Jokers'].length, 1, 'the empty team gets exactly one row');
        T.assertEqual(groups['ZZ Jokers'][0].Player, '', 'with no player on it');
        T.assertEqual(groups['ZZ Jokers'][0]['Total Spent'], '0', 'and nothing spent');
        T.assertEqual(groups['ZZ Jokers'][0]['Remaining Purse'], '600000',
          'so its whole purse remains');
      });

      // -----------------------------------------------------------------------
      // The filename date is the IST calendar day
      // -----------------------------------------------------------------------

      T.test('the export filename is stamped with the IST day, not the UTC one', function () {
        // A report generated at 12:15 AM in Chennai must not be filed under
        // yesterday's date. This one genuinely needs a pinned clock: with the real
        // one the test would pass at any hour outside the 00:00-05:30 IST window
        // whether the code went through Util.todayIso or not.
        const w = world();
        Suites._withFakeNow('2026-08-30T19:00:00.000Z', function () {
          const out = Suites._call('report.players', { tournamentId: w.tid }, admin);
          T.assertEqual(out.filename, w.slug + '-players-2026-08-31.csv',
            '19:00Z on 30 Aug is 00:30 IST on the 31st, so the file belongs to the 31st');
        });
        Suites._withFakeNow('2026-08-30T18:29:00.000Z', function () {
          const out = Suites._call('report.teams', { tournamentId: w.tid }, admin);
          T.assertEqual(out.filename, w.slug + '-teams-2026-08-30.csv',
            'one minute before IST midnight is still the 30th');
        });

        // And the times inside the file are IST wall clock, not the stored UTC.
        const auction = csv('report.auction');
        const rows = byHeader(auction.grid);
        const first = rows.filter(r => r['Serial No'] === '1')[0];
        T.assertEqual(first['Auction Time'], Util.formatIST('2026-08-30T18:40:00.000Z', true),
          'the sale was recorded at 18:40Z, which is 12:10 AM on the 31st in Chennai — ' +
          'a raw UTC instant in a report is both unreadable and wrong-looking to ' +
          'everybody who was in the hall');
      });

      // -----------------------------------------------------------------------
      // audit.list — CONTRACTS-PHASE4-7 PHASE 7 item 1
      // -----------------------------------------------------------------------

      T.test('audit.list pages, filters and honours an IST date range', function () {
        const t = Suites._seedTournament('rptaud', { withFolders: false });
        const other = TEST_FIXTURES.ACTOR;
        const A = Audit.ACTIONS;

        // Written directly, with chosen instants. Provoking seven real audit rows
        // through seven real actions would take three tabs of fixtures and would
        // still not let a test pin the timestamps, which is the whole point here.
        const seeded = [
          { action: A.TEAM_CREATED, actor_user_id: admin.user_id, entity_id: 'TEM_zzaud1',
            timestamp: '2026-08-29T10:00:00.000Z' },
          { action: A.TEAM_CREATED, actor_user_id: admin.user_id, entity_id: 'TEM_zzaud2',
            timestamp: '2026-08-30T10:00:00.000Z' },
          { action: A.TEAM_UPDATED, actor_user_id: other, entity_id: 'TEM_zzaud1',
            timestamp: '2026-08-30T12:00:00.000Z' },
          // 18:45Z on 30 Aug is 00:15 IST on the 31st. This row is the IST test.
          // Not a round hour, deliberately: a stored instant that happens to be
          // local midnight in the spreadsheet's own timezone comes back out of
          // Repo as a bare date, which would fail this for the wrong reason.
          { action: A.PLAYER_SOLD, actor_user_id: admin.user_id, entity_id: 'PLY_zzaud1',
            timestamp: '2026-08-30T18:45:00.000Z',
            prev_value: '{"auction_status":"PENDING"}',
            new_value: '{"auction_status":"SOLD","sold_amount":125000}' },
          { action: A.PLAYER_SOLD, actor_user_id: other, entity_id: 'PLY_zzaud2',
            timestamp: '2026-08-31T10:00:00.000Z' },
          { action: A.PAYMENT_VERIFIED, actor_user_id: admin.user_id, entity_id: 'PAY_zzaud1',
            timestamp: '2026-09-01T10:00:00.000Z' },
          { action: A.PAYMENT_REJECTED, actor_user_id: admin.user_id, entity_id: 'PAY_zzaud2',
            timestamp: '2026-09-02T10:00:00.000Z' }
        ];
        seeded.forEach(s => Suites._seedAudit(t.tid, s));
        const list = (payload) => {
          const body = { tournamentId: t.tid };
          Object.keys(payload || {}).forEach(k => { body[k] = payload[k]; });
          return Suites._call('audit.list', body, admin);
        };

        // ---- newest first, and the page maths
        const all = list({ pageSize: 200 });
        T.assertEqual(all.total, 7, 'all seven fixture rows are in scope');
        T.assertEqual(all.rows.map(r => r.entity_id),
          ['PAY_zzaud2', 'PAY_zzaud1', 'PLY_zzaud2', 'PLY_zzaud1', 'TEM_zzaud1',
           'TEM_zzaud2', 'TEM_zzaud1'],
          'newest first — the admin opens the trail on what just happened');
        T.assertEqual(all.actions,
          ['PAYMENT_REJECTED', 'PAYMENT_VERIFIED', 'PLAYER_SOLD', 'TEAM_CREATED',
           'TEAM_UPDATED'],
          'the action menu is scoped to the tournament and sorted, so a filter never ' +
          'empties the dropdown it was chosen from');

        const p1 = list({ pageSize: 3, page: 1 });
        T.assertEqual(p1.rows.length, 3, 'three rows on page one');
        T.assertEqual(p1.total, 7, 'out of seven');
        T.assertEqual(p1.totalPages, 3, 'over three pages');
        T.assertEqual(p1.pageSize, 3, 'and the page size is echoed');
        const p3 = list({ pageSize: 3, page: 3 });
        T.assertEqual(p3.rows.length, 1, 'the last page holds the remainder');
        T.assertEqual(p3.rows[0].entity_id, 'TEM_zzaud1', 'the oldest row');
        const p9 = list({ pageSize: 3, page: 9 });
        T.assertEqual(p9.rows, [],
          'a page past the end is an empty list, not an error: the admin may be on ' +
          'page 8 when a filter change shrinks the result to two pages');
        T.assertEqual(p9.total, 7, 'and the totals still describe the whole result');
        T.assertEqual(list({ pageSize: 5000 }).pageSize, REPORT_AUDIT_PAGE_MAX,
          'the page size is capped, so one call cannot pull the whole tab');
        T.assertEqual(list({}).pageSize, REPORT_AUDIT_PAGE_DEFAULT,
          'and defaults when the caller says nothing');

        // ---- filters
        T.assertEqual(list({ action: A.PLAYER_SOLD, pageSize: 200 }).total, 2,
          'filtering by action');
        T.assertEqual(list({ action: 'player_sold', pageSize: 200 }).total, 2,
          'and it is case-insensitive');
        T.assertThrows(() => list({ action: 'BANANA' }), ERR.VALIDATION_FAILED,
          'an action that is not in the frozen Audit.ACTIONS map');

        T.assertEqual(list({ entityId: 'TEM_zzaud1', pageSize: 200 }).total, 2,
          'filtering by entity, which is how "who changed this team?" is answered');

        T.assertEqual(list({ actor: admin.user_id, pageSize: 200 }).total, 5,
          'filtering by actor id');
        T.assertEqual(list({ actor: 'rptadm', pageSize: 200 }).total, 5,
          'and by a fragment of the actor\'s name or email, because nobody remembers ' +
          'a USR_ id');
        T.assertEqual(list({ actor: other, pageSize: 200 }).total, 2,
          'the other actor\'s rows');

        // ---- the IST date range (CONTRACTS.md §6a rule 2)
        const from31 = list({ from: '2026-08-31', pageSize: 200 });
        T.assertEqual(from31.total, 4,
          'a bare "2026-08-31" starts at 00:00 IST, which is 18:30Z on the 30th. The ' +
          'row at 18:45Z on 30 Aug happened at 00:15 IST on the 31st and MUST be in. ' +
          'Comparing as UTC would drop it and lose most of the day.');
        T.assert(from31.rows.map(r => r.entity_id).indexOf('PLY_zzaud1') !== -1,
          'and that is the row in question');
        T.assertEqual(list({ to: '2026-08-31', pageSize: 200 }).total, 5,
          'a bare "to" date covers the whole IST day, ending at 18:29:59.999Z');
        T.assertEqual(list({ from: '2026-08-31', to: '2026-08-31', pageSize: 200 }).total, 2,
          'and both together select exactly one IST day');
        T.assertEqual(
          list({ from: '2026-08-31', to: '2026-08-31', action: A.PLAYER_SOLD,
                 pageSize: 200 }).total, 2,
          'filters combine');

        T.assertThrows(() => list({ from: '2026-09-02', to: '2026-08-01' }),
          ERR.VALIDATION_FAILED,
          'bounds the wrong way round return nothing, which looks like a data problem; ' +
          'say what actually happened instead');
        T.assertThrows(() => list({ from: '31-08-2026' }), ERR.VALIDATION_FAILED,
          'dd-mm-yyyy is not a date this system accepts');
        T.assertThrows(() => list({ from: '2026-02-30' }), ERR.VALIDATION_FAILED,
          'and an impossible day must not roll silently into March');

        // ---- the row shape
        const row = all.rows.filter(r => r.entity_id === 'PLY_zzaud1')[0];
        T.assertEqual(Object.keys(row).sort(), [
          'action', 'action_display', 'actor_name', 'actor_role', 'actor_user_id',
          'entity_id', 'entity_type', 'log_id', 'new_value', 'prev_value',
          'timestamp', 'timestamp_display', 'tournament_id', 'user_agent'
        ], 'the audit row shape');
        T.assertEqual(row.new_value, { auction_status: 'SOLD', sold_amount: 125000 },
          'prev_value and new_value are parsed back into objects so the screen can ' +
          'render a field-by-field diff');
        T.assertEqual(row.prev_value, { auction_status: 'PENDING' }, 'both of them');
        T.assertEqual(row.actor_name, 'ZZ rptadm',
          'the trail resolves the actor to a readable name rather than a USR_ id');
        T.assertEqual(row.timestamp_display, Util.formatIST(row.timestamp, true),
          'and renders the instant in IST');
      });

      T.test('NO route in this module writes to AuditLog', function () {
        // ======================= THE ONE THAT MATTERS =========================
        // The AuditLog tab is append-only evidence. It is what settles "the
        // organiser says I never paid" three months after the tournament
        // (DESIGN.md §42), and evidence that can be edited from the same admin
        // screen that is being disputed is not evidence.
        //
        // Reporting reads history; it does not make history. An export is a read,
        // and Audit.ACTIONS has no export action — so running every route in this
        // module must leave the trail byte-for-byte unchanged.
        // ======================================================================
        const w = world();
        const before = Repo.readAll(SHEETS.AUDIT_LOG).map(r => JSON.stringify(r));

        Suites._call('report.players', { tournamentId: w.tid }, admin);
        Suites._call('report.teams', { tournamentId: w.tid }, admin);
        Suites._call('report.auction', { tournamentId: w.tid }, admin);
        Suites._call('report.final', { tournamentId: w.tid }, admin);
        Suites._call('dashboard.adminStats', { tournamentId: w.tid }, admin);
        Suites._call('audit.list', { tournamentId: w.tid, pageSize: 200 }, admin);

        const after = Repo.readAll(SHEETS.AUDIT_LOG).map(r => JSON.stringify(r));
        T.assertEqual(after.length, before.length,
          'the AuditLog grew by ' + (after.length - before.length) + ' row(s) while ' +
          'nothing but reports ran');
        T.assertEqual(after, before,
          'and not one existing row may have been rewritten either');

        // There must be no route anywhere that could edit or remove a row.
        const actions = Object.keys(buildRoutes());
        actions.forEach(a => {
          T.assert(!/^audit\./.test(a) || a === 'audit.list',
            'the only audit route may be audit.list; found "' + a + '"');
          T.assert(!/(audit).*(update|delete|edit|clear|remove|write|purge)/i.test(a),
            'a route that could change the audit trail is registered: "' + a + '"');
        });

        // adminStats is a read too, and it reports the counter drift rather than
        // papering over it (DESIGN.md §35).
        const stats = Suites._call('dashboard.adminStats', { tournamentId: w.tid }, admin);
        T.assertEqual(stats.scope, 'TOURNAMENT', 'scoped to the one tournament');
        T.assertEqual(stats.tournaments.length, 1, 'one block comes back');
        const block = stats.tournaments[0];
        T.assertEqual(block.auction.sold, 3, 'three sold players');
        T.assertEqual(block.auction.unsold, 1, 'one nobody bid on');
        T.assertEqual(block.auction.awaiting_reauction, 1, 'one waiting for a re-auction');
        T.assertEqual(block.auction.not_called, 1,
          'and one never called — the unpaid player is not in the pool at all, so ' +
          'counting them here would inflate the number the banner quotes');
        T.assertEqual(
          block.auction.sold + block.auction.unsold + block.auction.awaiting_reauction +
          block.auction.not_called, block.registrations.eligible,
          'the four labels must partition the eligible pool exactly');
        T.assertEqual(block.purse.spent, 450000, '125000 + 250000 + 75000');
        T.assertEqual(block.purse.counters_match, true,
          'the fixture counters agree with the player rows, so adminStats says so');
        T.assertEqual(block.auction.corrections, 1,
          'and the one superseded row is counted as a correction');
      });
    });
  },

  // ===========================================================================
  // Util
  // ===========================================================================

  util() {
    T.suite('Util', function () {

      T.test('formatINR uses Indian digit grouping', function () {
        T.assertEqual(Util.formatINR(500), '₹500', 'three digits get no separator');
        T.assertEqual(Util.formatINR(75000), '₹75,000', 'five digits: one separator');
        T.assertEqual(Util.formatINR(1000000), '₹10,00,000',
          'one million is ten lakh, grouped 2-2-3 not 3-3-3');
        T.assertEqual(Util.formatINR(0), '₹0', 'zero still renders');
      });

      T.test('formatINR handles the lakh and crore boundaries', function () {
        T.assertEqual(Util.formatINR(1000), '₹1,000', 'one thousand');
        T.assertEqual(Util.formatINR(100000), '₹1,00,000', 'one lakh');
        T.assertEqual(Util.formatINR(10000000), '₹1,00,00,000', 'one crore');
      });

      T.test('toMoney rejects anything that is not a positive whole rupee count', function () {
        // Money is always an integer number of whole rupees (CONTRACTS.md §1.6).
        T.assertThrows(() => Util.toMoney(0), ERR.INVALID_AMOUNT, 'zero is not positive');
        T.assertThrows(() => Util.toMoney(-1), ERR.INVALID_AMOUNT, 'negative');
        T.assertThrows(() => Util.toMoney(-75000), ERR.INVALID_AMOUNT, 'large negative');
        T.assertThrows(() => Util.toMoney(1.5), ERR.INVALID_AMOUNT, 'float');
        T.assertThrows(() => Util.toMoney(75000.01), ERR.INVALID_AMOUNT, 'paise are not a thing here');
        T.assertThrows(() => Util.toMoney('abc'), ERR.INVALID_AMOUNT, 'non-numeric string');
        T.assertThrows(() => Util.toMoney(null), ERR.INVALID_AMOUNT, 'null');
        T.assertThrows(() => Util.toMoney(undefined), ERR.INVALID_AMOUNT, 'undefined');
      });

      T.test('toMoney accepts a positive integer and its string form', function () {
        T.assertEqual(Util.toMoney(75000), 75000, 'number in, number out');
        T.assertEqual(Util.toMoney('75000'), 75000,
          'a numeric string from a form field is coerced, not rejected');
        T.assertEqual(typeof Util.toMoney('75000'), 'number',
          'the return type is number, never string');
      });

      T.test('uid returns the contracted prefix and a 12-char base36 suffix', function () {
        const id = Util.uid(ID_PREFIX.PLAYER);
        T.assertEqual(id.slice(0, ID_PREFIX.PLAYER.length), ID_PREFIX.PLAYER, 'prefix');
        const suffix = id.slice(ID_PREFIX.PLAYER.length);
        T.assertEqual(suffix.length, 12, 'suffix length (CONTRACTS.md §4): ' + id);
        T.assert(/^[0-9a-z]{12}$/.test(suffix),
          'suffix must be lowercase base36, got "' + suffix + '"');
        T.assertEqual(id.length, ID_PREFIX.PLAYER.length + 12, 'total length');
      });

      T.test('uid honours every id prefix', function () {
        Object.keys(ID_PREFIX).forEach(k => {
          const p = ID_PREFIX[k];
          const id = Util.uid(p);
          T.assertEqual(id.slice(0, p.length), p, 'prefix for ID_PREFIX.' + k);
        });
      });

      T.test('1000 uid calls produce 1000 distinct values', function () {
        // A collision here means two players share an id, which silently merges
        // two registrations. Worth the 1000 iterations.
        const seen = {};
        let dupe = null;
        for (let i = 0; i < 1000; i++) {
          const id = Util.uid(ID_PREFIX.PLAYER);
          if (seen[id]) { dupe = id; break; }
          seen[id] = true;
        }
        T.assert(dupe === null, 'duplicate id generated: ' + dupe);
        T.assertEqual(Object.keys(seen).length, 1000, 'distinct ids generated');
      });

      T.test('ageYears when the birthday has already passed this year', function () {
        T.assertEqual(Util.ageYears('1990-01-15', '2026-08-30'), 36,
          'born January, measured in August');
      });

      T.test('ageYears when the birthday has not been reached yet', function () {
        T.assertEqual(Util.ageYears('1990-12-15', '2026-08-30'), 35,
          'born December, measured in August — must NOT round up');
      });

      T.test('ageYears on the day itself and the day before', function () {
        T.assertEqual(Util.ageYears('2000-08-30', '2026-08-30'), 26, 'exactly on the birthday');
        T.assertEqual(Util.ageYears('2000-08-31', '2026-08-30'), 25, 'one day short');
      });

      T.test('ageYears handles a 29-February date of birth', function () {
        // 29 Feb is the classic off-by-one: naive date maths rolls it to 1 March
        // (or 28 Feb) and shifts the age by a year.
        T.assertEqual(Util.ageYears('2000-02-29', '2026-03-01'), 26,
          'past 1 March in a non-leap year the leapling is unambiguously 26');
        T.assertEqual(Util.ageYears('2000-02-29', '2024-02-29'), 24,
          'exact leap-day birthday in a leap year');
        T.assertEqual(Util.ageYears('2000-02-29', '2026-01-31'), 25,
          'before February the leapling is still 25');

        // CONTRACTS.md does not say whether a leapling "has a birthday" on 28 Feb
        // in a non-leap year, so assert only what is certain: a whole number, and
        // one of the two defensible answers.
        const edge = Util.ageYears('2000-02-29', '2026-02-28');
        T.assert(edge === 25 || edge === 26,
          'leap-day age on 28 Feb of a non-leap year must be 25 or 26, got ' + edge);
        T.assertEqual(edge, Math.floor(edge), 'ageYears must return a whole number');
      });

      T.test('isValidMobileIN accepts a real Indian mobile number', function () {
        T.assertEqual(Util.isValidMobileIN('9876543210'), true, '10 digits starting 9');
        T.assertEqual(Util.isValidMobileIN('6000000000'), true, 'leading 6 is valid');
        T.assertEqual(Util.isValidMobileIN('7123456789'), true, 'leading 7 is valid');
        T.assertEqual(Util.isValidMobileIN('8123456789'), true, 'leading 8 is valid');
      });

      T.test('isValidMobileIN rejects bad numbers', function () {
        T.assertEqual(Util.isValidMobileIN('1234567890'), false,
          'leading 1 is not an Indian mobile prefix');
        T.assertEqual(Util.isValidMobileIN('5876543210'), false, 'leading 5 is invalid');
        T.assertEqual(Util.isValidMobileIN('98765432'), false, 'too short (8 digits)');
        T.assertEqual(Util.isValidMobileIN('98765432100'), false, 'too long (11 digits)');
        T.assertEqual(Util.isValidMobileIN('98765abcde'), false, 'letters');
        T.assertEqual(Util.isValidMobileIN(''), false, 'empty');
      });

      T.test('hashPassword is deterministic for the same salt and pepper', function () {
        const a = Util.hashPassword('correct horse battery', 'salt-aaa', TEST_FIXTURES.PEPPER);
        const b = Util.hashPassword('correct horse battery', 'salt-aaa', TEST_FIXTURES.PEPPER);
        T.assertEqual(a, b, 'same inputs must give the same hash, or nobody can ever log in');
      });

      T.test('hashPassword changes when the salt changes', function () {
        const a = Util.hashPassword('correct horse battery', 'salt-aaa', TEST_FIXTURES.PEPPER);
        const b = Util.hashPassword('correct horse battery', 'salt-bbb', TEST_FIXTURES.PEPPER);
        T.assert(a !== b, 'a different salt must give a different hash (both were ' + a + ')');
      });

      T.test('hashPassword changes when the password changes', function () {
        const a = Util.hashPassword('password-one', 'salt-aaa', TEST_FIXTURES.PEPPER);
        const b = Util.hashPassword('password-two', 'salt-aaa', TEST_FIXTURES.PEPPER);
        T.assert(a !== b, 'a different password must give a different hash');
      });

      T.test('hashPassword returns 64 lowercase hex characters', function () {
        const h = Util.hashPassword('correct horse battery', 'salt-aaa', TEST_FIXTURES.PEPPER);
        T.assertEqual(h.length, 64, 'SHA-256 hex is 64 chars, got "' + h + '"');
        T.assert(/^[0-9a-f]{64}$/.test(h), 'must be lowercase hex, got "' + h + '"');
      });

      T.test('sha256Hex("abc") matches the published SHA-256 vector', function () {
        // This is the signed-byte trap. Utilities.computeDigest returns Java bytes
        // in the range -128..127; converting one with toString(16) without masking
        // to & 0xFF yields things like "ffffffba" instead of "ba". Any hex byte
        // above 0x7F is wrong, and this vector starts with 0xba.
        T.assertEqual(
          Util.sha256Hex('abc'),
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
          'known SHA-256 of "abc" — a mismatch here almost certainly means the ' +
          'signed-byte-to-hex conversion is missing a & 0xFF mask');
      });

      T.test('sha256Hex of the empty string matches the published vector', function () {
        T.assertEqual(
          Util.sha256Hex(''),
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'known SHA-256 of ""');
      });

      T.test('sha256Hex always returns 64 hex chars, never a short byte', function () {
        // A byte that is < 0x10 renders as one hex char without padStart, which
        // shortens the digest and silently breaks password comparison.
        for (let i = 0; i < 40; i++) {
          const h = Util.sha256Hex('probe-' + i);
          T.assertEqual(h.length, 64, 'digest length for input "probe-' + i + '" was ' + h.length);
          T.assert(/^[0-9a-f]{64}$/.test(h), 'non-hex output for "probe-' + i + '": ' + h);
        }
      });

      T.test('slugify lowercases and hyphenates', function () {
        T.assertEqual(Util.slugify('Chennai Premier League'), 'chennai-premier-league',
          'spaces and capitals');
        T.assertEqual(Util.slugify('T20 Cup 2026'), 't20-cup-2026', 'digits survive');
      });

      T.test('slugify strips punctuation and collapses repeated separators', function () {
        T.assertEqual(Util.slugify('  Royal   Challengers!!  '), 'royal-challengers',
          'leading/trailing space, repeated inner spaces, trailing punctuation');
        T.assertEqual(Util.slugify('Mumbai -- Indians'), 'mumbai-indians',
          'repeated separators collapse to one hyphen');
        T.assertEqual(Util.slugify("St. Joseph's XI"), 'st-joseph-s-xi',
          'dots and apostrophes become separators, not silent deletions');
      });

      T.test('slugify never emits a leading, trailing or doubled hyphen', function () {
        // The slug goes into a URL and a Drive folder name, so these are structural.
        const inputs = ['---Hello---', '!!!', 'A  &  B', '  spaced  out  ', '2026!!'];
        inputs.forEach(s => {
          const out = Util.slugify(s);
          T.assert(out.indexOf('--') === -1, 'doubled hyphen in slugify("' + s + '") = "' + out + '"');
          T.assert(out.charAt(0) !== '-', 'leading hyphen in slugify("' + s + '") = "' + out + '"');
          T.assert(out.charAt(out.length - 1) !== '-',
            'trailing hyphen in slugify("' + s + '") = "' + out + '"');
          T.assert(/^[a-z0-9-]*$/.test(out),
            'slugify("' + s + '") = "' + out + '" contains characters outside [a-z0-9-]');
        });
      });
    });
  },

  // ===========================================================================
  // Repo
  // ===========================================================================

  repo() {
    T.suite('Repo', function () {
      // --- fixture -----------------------------------------------------------
      // A tournament row is needed by the nextSerial tests. Registering the tid
      // here means cleanup finds it even if a later test throws.
      T._state.cacheTids.push(TEST_FIXTURES.TID);
      Repo.append(SHEETS.TOURNAMENTS, {
        tournament_id: TEST_FIXTURES.TID,
        slug: 'zz-test-harness',
        name: 'ZZ Test Harness',
        status: ENUM.TOURNAMENT_STATUS.DRAFT,
        next_serial: 1,
        default_purse: 1000000,
        default_max_players: 14,
        created_at: Util.nowIso(),
        created_by: TEST_FIXTURES.ACTOR
      });

      T.test('append then findBy round-trips every field type', function () {
        const id = Util.uid(ID_PREFIX.PLAYER);
        Repo.append(SHEETS.PLAYERS, {
          player_id: id,
          tournament_id: TEST_FIXTURES.TID,
          name: 'Round Trip',
          role: ENUM.PLAYER_ROLE.BATSMAN,
          style: '',                       // empty string
          mobile: '9876543210',
          sold_amount: 75000,              // number
          times_called: 0,                 // number zero, must not become null
          is_withdrawn: false,             // boolean
          payment_status: ENUM.PAYMENT_STATUS.PENDING,
          auction_status: ENUM.AUCTION_STATUS.PENDING,
          registered_at: Util.nowIso()
        });

        const got = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);
        T.assert(got !== null, 'findBy returned null for a row that was just appended');
        T.assertEqual(got.player_id, id, 'string field');
        T.assertEqual(got.name, 'Round Trip', 'string field with a space');
        T.assertEqual(got.mobile, '9876543210',
          'a leading-digit-safe string; a 10-digit mobile must not come back as a number');
        T.assertEqual(got.sold_amount, 75000, 'number field');
        T.assertEqual(got.times_called, 0, 'a real zero must survive as 0, not null');
        T.assertEqual(got.is_withdrawn, false, 'boolean field');
        T.assertEqual(got.style, '', 'empty non-numeric cell stays an empty string');
      });

      T.test('booleans round-trip as real booleans, not the strings TRUE/FALSE', function () {
        // Sheets stores them as the literal text TRUE/FALSE (CONTRACTS.md §4).
        // If Repo hands back the string, `if (player.is_withdrawn)` is true for
        // "FALSE" and withdrawn players re-enter the auction.
        const idT = Util.uid(ID_PREFIX.PLAYER);
        const idF = Util.uid(ID_PREFIX.PLAYER);
        Repo.append(SHEETS.PLAYERS, {
          player_id: idT, tournament_id: TEST_FIXTURES.TID,
          name: 'Bool True', is_withdrawn: true
        });
        Repo.append(SHEETS.PLAYERS, {
          player_id: idF, tournament_id: TEST_FIXTURES.TID,
          name: 'Bool False', is_withdrawn: false
        });

        const t = Repo.findBy(SHEETS.PLAYERS, 'player_id', idT);
        const f = Repo.findBy(SHEETS.PLAYERS, 'player_id', idF);

        T.assertEqual(typeof t.is_withdrawn, 'boolean', 'true must be a boolean, got ' +
          T._fmt(t.is_withdrawn));
        T.assertEqual(typeof f.is_withdrawn, 'boolean', 'false must be a boolean, got ' +
          T._fmt(f.is_withdrawn));
        T.assertEqual(t.is_withdrawn, true, 'true value');
        T.assertEqual(f.is_withdrawn, false, 'false value');
        T.assert(f.is_withdrawn !== 'FALSE',
          'the string "FALSE" is truthy in JavaScript — this must be a real boolean');
      });

      T.test('numeric fields come back as numbers', function () {
        const id = Util.uid(ID_PREFIX.PLAYER);
        Repo.append(SHEETS.PLAYERS, {
          player_id: id, tournament_id: TEST_FIXTURES.TID,
          name: 'Numeric', serial_no: 42, sold_amount: 125000, age_years: 27
        });
        const got = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);
        T.assertEqual(typeof got.serial_no, 'number', 'serial_no type');
        T.assertEqual(typeof got.sold_amount, 'number', 'sold_amount type');
        T.assertEqual(typeof got.age_years, 'number', 'age_years type');
        T.assertEqual(got.serial_no, 42, 'serial_no value');
        T.assertEqual(got.sold_amount, 125000, 'sold_amount value');
        // Purse maths on a string concatenates instead of adding.
        T.assertEqual(got.sold_amount + 1000, 126000,
          'arithmetic on the returned value must add, not concatenate');
      });

      T.test('an empty numeric cell comes back as null, not 0', function () {
        // This distinction is load-bearing: sold_amount 0 means "sold for nothing",
        // sold_amount null means "not sold". Collapsing them corrupts every report.
        const id = Util.uid(ID_PREFIX.PLAYER);
        Repo.append(SHEETS.PLAYERS, {
          player_id: id, tournament_id: TEST_FIXTURES.TID, name: 'No Numbers'
          // serial_no, sold_amount, age_years deliberately omitted
        });
        const got = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);
        T.assertEqual(got.sold_amount, null, 'unsold player sold_amount');
        T.assertEqual(got.serial_no, null, 'unallocated serial_no');
        T.assertEqual(got.age_years, null, 'missing age_years');
        T.assert(got.sold_amount !== 0, 'an empty cell must not become the number 0');
      });

      T.test('updateRow does a partial update and leaves other columns untouched', function () {
        const id = Util.uid(ID_PREFIX.PLAYER);
        Repo.append(SHEETS.PLAYERS, {
          player_id: id, tournament_id: TEST_FIXTURES.TID,
          name: 'Partial Update', role: ENUM.PLAYER_ROLE.BOWLER,
          mobile: '9123456789', times_called: 2,
          auction_status: ENUM.AUCTION_STATUS.PENDING, is_withdrawn: false
        });
        const before = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);

        Repo.updateRow(SHEETS.PLAYERS, before._row, {
          auction_status: ENUM.AUCTION_STATUS.SOLD,
          sold_amount: 90000
        });

        const after = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);
        T.assertEqual(after.auction_status, ENUM.AUCTION_STATUS.SOLD, 'patched field 1');
        T.assertEqual(after.sold_amount, 90000, 'patched field 2');
        T.assertEqual(after.name, 'Partial Update', 'untouched string');
        T.assertEqual(after.role, ENUM.PLAYER_ROLE.BOWLER, 'untouched enum');
        T.assertEqual(after.mobile, '9123456789', 'untouched mobile');
        T.assertEqual(after.times_called, 2, 'untouched number');
        T.assertEqual(after.is_withdrawn, false, 'untouched boolean');
        T.assertEqual(after.tournament_id, TEST_FIXTURES.TID, 'untouched tournament_id');
      });

      T.test('updateRow returns the updated object', function () {
        const id = Util.uid(ID_PREFIX.PLAYER);
        Repo.append(SHEETS.PLAYERS, {
          player_id: id, tournament_id: TEST_FIXTURES.TID, name: 'Return Value'
        });
        const row = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);
        const out = Repo.updateRow(SHEETS.PLAYERS, row._row, { name: 'Renamed' });
        T.assert(out && typeof out === 'object', 'updateRow must return the row object');
        T.assertEqual(out.name, 'Renamed', 'returned object reflects the patch');
      });

      T.test('filterBy ANDs multiple criteria', function () {
        const idSold = Util.uid(ID_PREFIX.PLAYER);
        const idPending = Util.uid(ID_PREFIX.PLAYER);
        Repo.append(SHEETS.PLAYERS, {
          player_id: idSold, tournament_id: TEST_FIXTURES.TID, name: 'Filter Sold',
          auction_status: ENUM.AUCTION_STATUS.SOLD,
          payment_status: ENUM.PAYMENT_STATUS.VERIFIED
        });
        Repo.append(SHEETS.PLAYERS, {
          player_id: idPending, tournament_id: TEST_FIXTURES.TID, name: 'Filter Pending',
          auction_status: ENUM.AUCTION_STATUS.PENDING,
          payment_status: ENUM.PAYMENT_STATUS.VERIFIED
        });

        const both = Repo.filterBy(SHEETS.PLAYERS, {
          tournament_id: TEST_FIXTURES.TID,
          payment_status: ENUM.PAYMENT_STATUS.VERIFIED,
          auction_status: ENUM.AUCTION_STATUS.SOLD
        });
        const ids = both.map(p => p.player_id);
        T.assert(ids.indexOf(idSold) !== -1, 'the matching row must be returned');
        T.assert(ids.indexOf(idPending) === -1,
          'a row matching two of three criteria must NOT be returned — criteria are AND-ed');
        both.forEach(p => {
          T.assertEqual(p.auction_status, ENUM.AUCTION_STATUS.SOLD,
            'every returned row satisfies every criterion');
          T.assertEqual(p.tournament_id, TEST_FIXTURES.TID, 'tournament scope respected');
        });
      });

      T.test('filterBy with no match returns an empty array, not null', function () {
        const out = Repo.filterBy(SHEETS.PLAYERS, {
          tournament_id: TEST_FIXTURES.TID,
          name: 'zz-no-such-player-' + Util.uid(ID_PREFIX.PLAYER)
        });
        T.assertEqual(out, [], 'no match must give []');
      });

      T.test('findBy with no match returns null', function () {
        const out = Repo.findBy(SHEETS.PLAYERS, 'player_id', 'PLY_zznotarealid');
        T.assertEqual(out, null, 'no match must give null');
      });

      T.test('readAll on an empty tab returns [] and not [undefined]', function () {
        // The classic bug: a header-only tab has lastRow() === 1, so
        // getRange(2, 1, lastRow() - 1, n) asks for 0 rows and either throws or
        // yields a single undefined element. Callers then crash on row.player_id.
        //
        // PRECONDITION: nothing writes AuctionResults until Phase 4 (DESIGN.md
        // §19), and cleanup removes any fixture rows, so on a TEST sheet this tab
        // is header-only. If this assertion ever fails with a non-empty array,
        // check that first before blaming Repo.
        T.assertEqual(Repo.readAll(SHEETS.AUCTION_RESULTS), [],
          'AuctionResults has no Phase 0 writer, so readAll must return exactly []');
      });

      T.test('readAll never returns a hole for any tab', function () {
        Object.keys(SHEETS).forEach(k => {
          const tab = SHEETS[k];
          const rows = Repo.readAll(tab);
          T.assert(Array.isArray(rows),
            'readAll("' + tab + '") must return an array, got ' + T._fmt(rows));
          for (let i = 0; i < rows.length; i++) {
            T.assert(rows[i] !== undefined && rows[i] !== null,
              'readAll("' + tab + '") element ' + i + ' is ' + T._fmt(rows[i]) +
              ' — the row range is off by one');
            T.assert(typeof rows[i] === 'object',
              'readAll("' + tab + '") element ' + i + ' is not an object, got ' +
              T._fmt(rows[i]));
            T.assert(typeof rows[i]._row === 'number' && rows[i]._row >= 2,
              'readAll("' + tab + '") element ' + i + ' has a bad _row: ' +
              T._fmt(rows[i]._row));
          }
        });
      });

      T.test('_row is correct and usable for a follow-up updateRow', function () {
        const id = Util.uid(ID_PREFIX.PLAYER);
        Repo.append(SHEETS.PLAYERS, {
          player_id: id, tournament_id: TEST_FIXTURES.TID, name: 'Row Pointer'
        });
        const got = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);
        T.assertEqual(typeof got._row, 'number', '_row must be a number, got ' + T._fmt(got._row));
        T.assert(got._row >= 2, '_row must be >= 2 because row 1 is the header, got ' + got._row);

        // Round-trip through _row: the pointer must address this row and no other.
        Repo.updateRow(SHEETS.PLAYERS, got._row, { name: 'Row Pointer Updated' });
        const again = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);
        T.assertEqual(again.name, 'Row Pointer Updated', 'the update landed on the right row');
        T.assertEqual(again._row, got._row, '_row is stable across reads');

        // And the row above/below must be unharmed if one exists.
        const all = Repo.readAll(SHEETS.PLAYERS);
        const byRow = {};
        all.forEach(r => { byRow[r._row] = r; });
        T.assertEqual(Object.keys(byRow).length, all.length,
          'every row must have a distinct _row — duplicates mean the mapping is off by one');
      });

      T.test('append returns the object it wrote, with a usable _row', function () {
        const id = Util.uid(ID_PREFIX.PLAYER);
        const written = Repo.append(SHEETS.PLAYERS, {
          player_id: id, tournament_id: TEST_FIXTURES.TID, name: 'Append Return'
        });
        T.assert(written && typeof written === 'object', 'append must return the row object');
        T.assertEqual(written.player_id, id, 'returned player_id');
        T.assertEqual(typeof written._row, 'number', 'returned _row is a number');
        const found = Repo.findBy(SHEETS.PLAYERS, 'player_id', id);
        T.assertEqual(found._row, written._row, 'the returned _row matches what findBy sees');
      });

      T.test('count honours criteria', function () {
        const before = Repo.count(SHEETS.PLAYERS, { tournament_id: TEST_FIXTURES.TID });
        Repo.append(SHEETS.PLAYERS, {
          player_id: Util.uid(ID_PREFIX.PLAYER),
          tournament_id: TEST_FIXTURES.TID, name: 'Counted'
        });
        const after = Repo.count(SHEETS.PLAYERS, { tournament_id: TEST_FIXTURES.TID });
        T.assertEqual(after, before + 1, 'count must go up by exactly one');
        T.assertEqual(typeof after, 'number', 'count returns a number');
      });

      T.test('nextSerial increments and never repeats', function () {
        // The caller owns the lock (CONTRACTS.md §5.4), so take it here.
        const serials = Repo.withLock(function () {
          const out = [];
          for (let i = 0; i < 5; i++) out.push(Repo.nextSerial(TEST_FIXTURES.TID));
          return out;
        }, 20000);

        T.assertEqual(serials.length, 5, 'five calls, five serials');
        serials.forEach((s, i) => {
          T.assertEqual(typeof s, 'number', 'serial ' + i + ' must be a number, got ' + T._fmt(s));
        });
        for (let i = 1; i < serials.length; i++) {
          T.assertEqual(serials[i], serials[i - 1] + 1,
            'serials must be strictly consecutive: got ' + T._fmt(serials));
        }
        const distinct = {};
        serials.forEach(s => { distinct[s] = true; });
        T.assertEqual(Object.keys(distinct).length, 5,
          'a repeated serial means two players share a number: ' + T._fmt(serials));
      });

      T.test('nextSerial persists the increment to the sheet', function () {
        const before = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', TEST_FIXTURES.TID);
        const issued = Repo.withLock(() => Repo.nextSerial(TEST_FIXTURES.TID), 20000);
        const after = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', TEST_FIXTURES.TID);
        T.assertEqual(issued, before.next_serial, 'nextSerial returns the current counter value');
        T.assertEqual(after.next_serial, before.next_serial + 1,
          'the counter must be written back +1, or a restart reissues the same serial');
      });

      T.test('withLock returns the inner function value', function () {
        T.assertEqual(Repo.withLock(() => 'inner-value', 20000), 'inner-value', 'string');
        T.assertEqual(Repo.withLock(() => 42, 20000), 42, 'number');
        T.assertEqual(Repo.withLock(() => ({ a: 1, b: [2, 3] }), 20000), { a: 1, b: [2, 3] },
          'object, deep-compared');
      });

      T.test('withLock RELEASES the lock when the inner function throws', function () {
        // THE MOST IMPORTANT TEST IN THIS FILE.
        // If withLock returns early on a throw without hitting its `finally`, the
        // script lock stays held for its full 6-minute lifetime and every
        // subsequent auction action fails with SYSTEM_BUSY. The auction stops. In
        // front of an audience. This must never regress.
        const boom = Util.AppError(ERR.VALIDATION_FAILED, 'deliberate failure inside the lock');
        const thrown = T.assertThrows(
          () => Repo.withLock(() => { throw boom; }, 20000),
          ERR.VALIDATION_FAILED,
          'withLock must propagate the inner error unchanged, not swallow it');
        T.assertEqual(thrown.message, 'deliberate failure inside the lock',
          'the original message must survive the lock wrapper');

        // Re-acquire immediately with a SHORT wait. If the lock leaked, this either
        // returns nothing or burns the full wait and throws SYSTEM_BUSY. The elapsed
        // check is the real assertion: a leaked lock cannot be fast.
        const t0 = Date.now();
        const second = Repo.withLock(() => 'lock-was-free', 3000);
        const elapsed = Date.now() - t0;
        T.assertEqual(second, 'lock-was-free',
          'the lock must be free immediately after an inner throw');
        T.assert(elapsed < 3000,
          're-acquiring took ' + elapsed + ' ms against a 3000 ms wait — the lock was ' +
          'held, meaning withLock did not release it in a finally');

        // And a third time, with a nested throw, to prove it is not a one-off.
        T.assertThrows(
          () => Repo.withLock(() => { throw Util.AppError(ERR.TEAM_FULL, 'again'); }, 20000),
          ERR.TEAM_FULL, 'second deliberate failure');
        T.assertEqual(Repo.withLock(() => 'still-free', 3000), 'still-free',
          'the lock must still be free after a second inner throw');
      });

      T.test('withLock releases the lock after a plain (non-AppError) throw', function () {
        // A TypeError from a genuine bug must not leak the lock either.
        T.assertThrows(
          () => Repo.withLock(() => { throw new TypeError('undefined is not a function'); }, 20000),
          null,   // CONTRACTS.md does not give a code for a raw JS error; any throw is correct.
          'a raw TypeError must propagate out of withLock');
        T.assertEqual(Repo.withLock(() => 'free-after-typeerror', 3000), 'free-after-typeerror',
          'the lock must be free after a non-AppError throw');
      });
    });
  },

  // ===========================================================================
  // Auth
  // ===========================================================================

  auth() {
    T.suite('Auth', function () {
      // --- fixtures ----------------------------------------------------------
      // A second tournament is needed to prove an organiser is refused elsewhere.
      T._state.cacheTids.push(TEST_FIXTURES.TID_OTHER);
      if (!Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', TEST_FIXTURES.TID)) {
        Repo.append(SHEETS.TOURNAMENTS, {
          tournament_id: TEST_FIXTURES.TID, slug: 'zz-test-harness',
          name: 'ZZ Test Harness', status: ENUM.TOURNAMENT_STATUS.DRAFT,
          next_serial: 1, created_at: Util.nowIso(), created_by: TEST_FIXTURES.ACTOR
        });
      }
      Repo.append(SHEETS.TOURNAMENTS, {
        tournament_id: TEST_FIXTURES.TID_OTHER, slug: 'zz-test-other',
        name: 'ZZ Test Other', status: ENUM.TOURNAMENT_STATUS.DRAFT,
        next_serial: 1, created_at: Util.nowIso(), created_by: TEST_FIXTURES.ACTOR
      });

      // A fresh email per test keeps the 5-strikes lockout (CONTRACTS.md §7.5)
      // from bleeding between tests.
      const mail = (tag) => Suites._fixtureEmail(tag);

      const admin = Suites._makeUser(mail('admin'), 'ZZ Admin', ENUM.USER_ROLE.ADMIN, null);
      const organiser = Suites._makeUser(
        mail('org'), 'ZZ Organiser', ENUM.USER_ROLE.ORGANISER, TEST_FIXTURES.TID);

      T.test('createUser then login succeeds and returns a token', function () {
        const out = Auth.login(admin.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        T.assert(out && typeof out === 'object', 'login must return an object');
        T.assertEqual(typeof out.token, 'string', 'token must be a string');
        T.assert(out.token.length >= 32,
          'a 32-byte token is 64 hex chars; got ' + out.token.length + ' chars');
        T.assert(out.expiresAt, 'login must return expiresAt');
        T.assert(out.user && out.user.user_id, 'login must return the user object');
        T.assertEqual(out.user.role, ENUM.USER_ROLE.ADMIN, 'role echoed back');
        T.assertEqual(out.user.display_name, 'ZZ Admin', 'display_name echoed back');
      });

      T.test('the session expires 12 hours out', function () {
        const out = Auth.login(admin.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        const expiry = new Date(out.expiresAt).getTime();
        T.assert(!isNaN(expiry), 'expiresAt must parse as a date, got ' + T._fmt(out.expiresAt));
        const expected = Date.now() + DEFAULTS.session_hours * 3600 * 1000;
        // 90 s of slack absorbs clock skew and the round trip.
        T.assertClose(expiry, expected, 90000,
          'session lifetime must be ' + DEFAULTS.session_hours + ' hours (CONTRACTS.md §7.3)');
      });

      T.test('login with a wrong password fails with UNAUTHORIZED', function () {
        const e = T.assertThrows(
          () => Auth.login(admin.email, 'WrongPassword!!9', 'zz-test-agent'),
          ERR.UNAUTHORIZED, 'wrong password');
        T.assert(e.message && e.message.length > 0, 'the error must carry a message');
      });

      T.test('an unknown email fails with the SAME message as a wrong password', function () {
        // Account enumeration: if "no such user" and "wrong password" differ, an
        // attacker learns which admin emails exist by reading the error text.
        // Use throwaway emails so neither account trips the 5-strikes lockout.
        const victim = Suites._makeUser(
          mail('enum'), 'ZZ Enum', ENUM.USER_ROLE.ADMIN, null);

        const wrongPass = T.assertThrows(
          () => Auth.login(victim.email, 'DefinitelyWrong!9', 'zz-test-agent'),
          ERR.UNAUTHORIZED, 'wrong password for a real account');

        const unknownEmail = T.assertThrows(
          () => Auth.login(mail('ghost'), TEST_FIXTURES.PASSWORD, 'zz-test-agent'),
          ERR.UNAUTHORIZED, 'unknown email');

        T.assertEqual(unknownEmail.code, wrongPass.code,
          'both failures must use the same error code');
        T.assertEqual(unknownEmail.message, wrongPass.message,
          'both failures must use the IDENTICAL message. A different message for an ' +
          'unknown email leaks which accounts exist.');
      });

      T.test('resolve returns null for a blank token', function () {
        T.assertEqual(Auth.resolve(''), null, 'empty string');
        T.assertEqual(Auth.resolve(null), null, 'null');
        T.assertEqual(Auth.resolve(undefined), null, 'undefined');
        T.assertEqual(Auth.resolve('   '), null, 'whitespace only');
      });

      T.test('resolve returns null for a garbage token', function () {
        T.assertEqual(Auth.resolve('not-a-real-token'), null, 'obvious garbage');
        T.assertEqual(
          Auth.resolve('0000000000000000000000000000000000000000000000000000000000000000'),
          null, 'well-formed but never issued');
      });

      T.test('resolve returns null for a revoked token', function () {
        const user = Suites._makeUser(mail('revoke'), 'ZZ Revoke', ENUM.USER_ROLE.ADMIN, null);
        const out = Auth.login(user.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        T.assert(Auth.resolve(out.token) !== null, 'the token must resolve before logout');

        Auth.logout(out.token);
        T.assertEqual(Auth.resolve(out.token), null,
          'a logged-out token must not resolve — if it does, logout only cleared the ' +
          'sheet and left the cached session alive');
      });

      T.test('resolve returns the session fields for a live token', function () {
        const out = Auth.login(organiser.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        const s = Auth.resolve(out.token);
        T.assert(s !== null, 'a fresh token must resolve');
        T.assertEqual(s.user_id, organiser.user_id, 'user_id');
        T.assertEqual(s.role, ENUM.USER_ROLE.ORGANISER, 'role');
        T.assertEqual(s.tournament_id, TEST_FIXTURES.TID, 'tournament_id');
        T.assert(s.expires_at, 'expires_at present');
      });

      T.test('require throws FORBIDDEN for a disallowed role', function () {
        const out = Auth.login(organiser.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        T.assertThrows(() => Auth.require(out.token, [ENUM.USER_ROLE.ADMIN]),
          ERR.FORBIDDEN, 'an ORGANISER must not pass an ADMIN-only check');
      });

      T.test('require passes for an allowed role and returns the session', function () {
        const out = Auth.login(organiser.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        const s = Auth.require(out.token, [ENUM.USER_ROLE.ORGANISER]);
        T.assert(s && s.user_id === organiser.user_id, 'require must return the session');

        const both = Auth.require(out.token, [ENUM.USER_ROLE.ADMIN, ENUM.USER_ROLE.ORGANISER]);
        T.assertEqual(both.role, ENUM.USER_ROLE.ORGANISER, 'a role list containing the role passes');

        // CONTRACTS.md §7.6: null means "any authenticated user".
        const any = Auth.require(out.token, null);
        T.assertEqual(any.user_id, organiser.user_id, 'require(token, null) allows any role');
      });

      T.test('require throws UNAUTHORIZED for a missing or bad token', function () {
        T.assertThrows(() => Auth.require('', [ENUM.USER_ROLE.ADMIN]),
          ERR.UNAUTHORIZED, 'empty token');
        T.assertThrows(() => Auth.require('garbage', null),
          ERR.UNAUTHORIZED, 'garbage token — must be UNAUTHORIZED, not FORBIDDEN');
      });

      T.test('requireTournament refuses an ORGANISER another tournament', function () {
        const out = Auth.login(organiser.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        const s = Auth.resolve(out.token);
        T.assertThrows(() => Auth.requireTournament(s, TEST_FIXTURES.TID_OTHER),
          ERR.FORBIDDEN,
          'an organiser reaching into another tournament is the main tenancy leak');
      });

      T.test('requireTournament allows an ORGANISER their own tournament', function () {
        const out = Auth.login(organiser.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        const s = Auth.resolve(out.token);
        let threw = null;
        try { Auth.requireTournament(s, TEST_FIXTURES.TID); } catch (e) { threw = e; }
        T.assert(threw === null,
          'an organiser must be allowed their own tournament, but got ' + T._errText(threw));
      });

      T.test('requireTournament allows an ADMIN any tournament', function () {
        const out = Auth.login(admin.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        const s = Auth.resolve(out.token);
        let threw = null;
        try {
          Auth.requireTournament(s, TEST_FIXTURES.TID);
          Auth.requireTournament(s, TEST_FIXTURES.TID_OTHER);
        } catch (e) { threw = e; }
        T.assert(threw === null,
          'ADMIN is global (DESIGN.md §5.4) and must pass for any tournament, but got ' +
          T._errText(threw));
      });

      T.test('createUser rejects a password under the minimum', function () {
        T.assertThrows(() => Auth.createUser({
          email: mail('shortpw'), displayName: 'ZZ Short', password: 'short123',  // 8 chars
          role: ENUM.USER_ROLE.ADMIN, tournamentId: null
        }, TEST_FIXTURES.ACTOR), ERR.VALIDATION_FAILED, '8-character password');

        T.assertThrows(() => Auth.createUser({
          email: mail('shortpw9'), displayName: 'ZZ Short', password: '123456789', // 9 chars
          role: ENUM.USER_ROLE.ADMIN, tournamentId: null
        }, TEST_FIXTURES.ACTOR), ERR.VALIDATION_FAILED, '9-character password, the boundary');
      });

      T.test('createUser rejects an ORGANISER with no tournamentId', function () {
        // An organiser with no tournament scope is an accidental global admin.
        T.assertThrows(() => Auth.createUser({
          email: mail('orgnotid'), displayName: 'ZZ Scopeless',
          password: TEST_FIXTURES.PASSWORD, role: ENUM.USER_ROLE.ORGANISER, tournamentId: null
        }, TEST_FIXTURES.ACTOR), ERR.VALIDATION_FAILED, 'null tournamentId');

        T.assertThrows(() => Auth.createUser({
          email: mail('orgnotid2'), displayName: 'ZZ Scopeless',
          password: TEST_FIXTURES.PASSWORD, role: ENUM.USER_ROLE.ORGANISER
        }, TEST_FIXTURES.ACTOR), ERR.VALIDATION_FAILED, 'omitted tournamentId');
      });

      T.test('createUser never returns password_hash or salt', function () {
        const email = mail('nosecret');
        T._state.emails.push(email);
        const user = Auth.createUser({
          email: email, displayName: 'ZZ No Secret', password: TEST_FIXTURES.PASSWORD,
          role: ENUM.USER_ROLE.ADMIN, tournamentId: null
        }, TEST_FIXTURES.ACTOR);
        T._state.userIds.push(user.user_id);

        Suites._assertNoSecrets(user, 'the object returned by createUser');
      });

      T.test('login never returns password_hash or salt', function () {
        const out = Auth.login(admin.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        Suites._assertNoSecrets(out, 'the login envelope');
        Suites._assertNoSecrets(out.user, 'login().user');
      });

      T.test('resolve never returns password_hash or salt', function () {
        const out = Auth.login(admin.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
        Suites._assertNoSecrets(Auth.resolve(out.token), 'the resolved session');
      });

      T.test('setPassword changes the password and the old one stops working', function () {
        const user = Suites._makeUser(mail('setpw'), 'ZZ SetPw', ENUM.USER_ROLE.ADMIN, null);
        const newPassword = 'BrandNewPassw0rd!';
        Auth.setPassword(user.user_id, newPassword);

        const out = Auth.login(user.email, newPassword, 'zz-test-agent');
        T.assert(out.token, 'the new password must work');
        T.assertThrows(() => Auth.login(user.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent'),
          ERR.UNAUTHORIZED, 'the old password must stop working');
      });

      T.test('the stored Users row does hold a hash and a salt, and never the plaintext',
        function () {
          const user = Suites._makeUser(mail('stored'), 'ZZ Stored', ENUM.USER_ROLE.ADMIN, null);
          const row = Repo.findBy(SHEETS.USERS, 'user_id', user.user_id);
          T.assert(row !== null, 'the user row must exist in the sheet');
          T.assert(row.password_hash && String(row.password_hash).length === 64,
            'password_hash must be 64 hex chars, got ' + T._fmt(row.password_hash));
          T.assert(row.salt && String(row.salt).length >= 16,
            'salt must be present and non-trivial, got ' + T._fmt(row.salt));
          T.assert(String(row.password_hash).indexOf(TEST_FIXTURES.PASSWORD) === -1,
            'the plaintext password must never appear in the sheet');
          T.assert(String(row.salt) !== String(row.password_hash),
            'salt and hash must not be the same value');
        });
    });
  },

  // ===========================================================================
  // Cache
  // ===========================================================================

  cache() {
    T.suite('Cache', function () {
      // A run-unique tournament id, because the version counter is durable
      // (ScriptProperties, CONTRACTS.md §8.1) and "starts at 0" would otherwise
      // only be true on the very first run.
      const tid = Suites._freshCacheTid();

      T.test('getVersion starts at 0 for an unseen tournament', function () {
        T.assertEqual(Cache.getVersion(tid), 0,
          'an unseen tournament must report version 0, not null or undefined');
        T.assertEqual(typeof Cache.getVersion(tid), 'number', 'the version is a number');
      });

      T.test('bumpVersion increments and returns the new value', function () {
        const t = Suites._freshCacheTid();
        T.assertEqual(Cache.getVersion(t), 0, 'baseline');
        T.assertEqual(Cache.bumpVersion(t), 1, 'first bump returns 1');
        T.assertEqual(Cache.getVersion(t), 1, 'and getVersion agrees');
        T.assertEqual(Cache.bumpVersion(t), 2, 'second bump returns 2');
        T.assertEqual(Cache.bumpVersion(t), 3, 'third bump returns 3');
        T.assertEqual(Cache.getVersion(t), 3, 'final read');
      });

      T.test('version counters are per tournament', function () {
        const a = Suites._freshCacheTid();
        const b = Suites._freshCacheTid();
        Cache.bumpVersion(a);
        Cache.bumpVersion(a);
        T.assertEqual(Cache.getVersion(a), 2, 'tournament A bumped twice');
        T.assertEqual(Cache.getVersion(b), 0,
          'tournament B must be untouched — a shared counter would make every ' +
          'projector re-poll on every other tournament change');
      });

      T.test('putSnapshot / getSnapshot round-trip a nested object', function () {
        const t = Suites._freshCacheTid();
        const snap = {
          v: 7,
          tournament: { id: t, name: 'ZZ Cache Test', status: ENUM.TOURNAMENT_STATUS.AUCTION_LIVE },
          teams: [
            { team_id: 'TEM_a', name: 'Alpha', purse_used: 120000, full: false, players: [] },
            { team_id: 'TEM_b', name: 'Beta', purse_used: 0, full: true, players: ['PLY_x', 'PLY_y'] }
          ],
          current: null,
          counts: { sold: 3, unsold: 1, pending: 396 }
        };
        Cache.putSnapshot(t, snap);
        T.assertEqual(Cache.getSnapshot(t), snap,
          'the snapshot must survive the JSON round trip exactly, nesting and all');
      });

      T.test('getSnapshot returns null when nothing is cached', function () {
        T.assertEqual(Cache.getSnapshot(Suites._freshCacheTid()), null,
          'a missing snapshot is normal — it just gets rebuilt (CONTRACTS.md §8.1)');
      });

      T.test('putSnapshot throws when the payload exceeds the size cap', function () {
        const t = Suites._freshCacheTid();
        // CacheService hard-limits a value to 100 KB; putSnapshot must refuse
        // before that so the failure is a clear error, not a silent cache miss.
        const oversized = { players: [] };
        const chunk = 'x'.repeat(1024);
        for (let i = 0; i < 200; i++) {           // ~200 KB, comfortably over
          oversized.players.push({ id: 'PLY_' + i, blob: chunk });
        }
        T.assert(JSON.stringify(oversized).length > DEFAULTS.max_snapshot_bytes,
          'the fixture must actually exceed the cap of ' + DEFAULTS.max_snapshot_bytes + ' bytes');

        // CONTRACTS.md §8.2 says "throws" but does not name the code, so assert the
        // strongest thing that is specified: it throws an AppError with a real code.
        const e = T.assertThrows(() => Cache.putSnapshot(t, oversized), null,
          'an oversized snapshot must be rejected, not silently dropped');
        T.assert(Object.keys(ERR).indexOf(e.code) !== -1,
          'the thrown code must be one of the declared ERR constants, got ' + T._fmt(e.code));
        T.assertEqual(Cache.getSnapshot(t), null,
          'nothing must be stored when the payload is rejected');
      });

      T.test('putSnapshot accepts a payload just under the cap', function () {
        const t = Suites._freshCacheTid();
        const ok = { blob: 'y'.repeat(50000) };   // ~50 KB, well inside 95 KB
        Cache.putSnapshot(t, ok);
        T.assertEqual(Cache.getSnapshot(t), ok, 'a normal-sized snapshot must go through');
      });

      T.test('a corrupt cache value returns null rather than throwing', function () {
        const t = Suites._freshCacheTid();
        // Corrupt the raw entry directly. Cache has no API for writing invalid
        // JSON, and the point is exactly what happens when something else does —
        // a truncated write or a stale value from an older schema.
        CacheService.getScriptCache().put('snap:' + t, '{"teams": [ this is not json',
          DEFAULTS.cache_ttl_sec);

        let out;
        let threw = null;
        try { out = Cache.getSnapshot(t); } catch (e) { threw = e; }
        T.assert(threw === null,
          'a parse failure must return null, never throw (CONTRACTS.md §8.3) — got ' +
          T._errText(threw));
        T.assertEqual(out, null, 'a corrupt snapshot reads as null');
      });

      T.test('a corrupt raw value returns null rather than throwing', function () {
        const key = 'cfg:zz_test_corrupt_' + Util.uid(ID_PREFIX.LOG);
        CacheService.getScriptCache().put(key, 'not-json-at-all', 600);
        let out;
        let threw = null;
        try { out = Cache.getRaw(key); } catch (e) { threw = e; }
        T.assert(threw === null, 'getRaw must not throw on bad JSON — got ' + T._errText(threw));
        T.assertEqual(out, null, 'corrupt raw value reads as null');
        try { Cache.del(key); } catch (e) { /* best effort */ }
      });

      T.test('invalidate clears the snapshot but leaves the version counter intact',
        function () {
          const t = Suites._freshCacheTid();
          Cache.bumpVersion(t);
          Cache.bumpVersion(t);
          Cache.bumpVersion(t);
          Cache.putSnapshot(t, { hello: 'world', teams: [1, 2, 3] });
          T.assertEqual(Cache.getVersion(t), 3, 'baseline version');
          T.assert(Cache.getSnapshot(t) !== null, 'baseline snapshot present');

          Cache.invalidate(t);

          T.assertEqual(Cache.getSnapshot(t), null, 'invalidate must drop the snapshot');
          T.assertEqual(Cache.getVersion(t), 3,
            'invalidate must NOT reset the version. Clients poll on the version; ' +
            'resetting it to 0 makes every client think it is already up to date and ' +
            'the projector freezes on stale data.');
        });

      T.test('session cache round-trips and deletes', function () {
        const token = 'zztesttoken' + Util.uid(ID_PREFIX.LOG);
        const session = {
          user_id: TEST_FIXTURES.ACTOR, role: ENUM.USER_ROLE.ORGANISER,
          tournament_id: TEST_FIXTURES.TID, expires_at: Util.nowIso()
        };
        Cache.putSession(token, session);
        T.assertEqual(Cache.getSession(token), session, 'session round-trip');
        Cache.delSession(token);
        T.assertEqual(Cache.getSession(token), null, 'delSession must clear it');
      });

      T.test('config cache round-trips and invalidates', function () {
        const key = 'zz_test_cfg_' + Util.uid(ID_PREFIX.LOG);
        Cache.putConfig(key, 'some-value');
        T.assertEqual(Cache.getConfig(key), 'some-value', 'config round-trip');
        Cache.invalidateConfig(key);
        T.assertEqual(Cache.getConfig(key), null, 'invalidateConfig must clear it');
      });
    });
  },

  // ===========================================================================
  // Drive
  // ===========================================================================

  drive() {
    T.suite('Drive', function () {
      // Every test below that touches Google Drive is prefixed [DRIVE WRITE].
      // Everything created is registered in T._state.driveIds and trashed by
      // T.cleanup(), which runs even if this suite fails.

      T.test('thumbUrl builds the expected URL string', function () {
        T.assertEqual(
          Drive.thumbUrl('FILE123', 320),
          'https://drive.google.com/thumbnail?id=FILE123&sz=w320',
          'the exact form from CONTRACTS.md §9');
        T.assertEqual(
          Drive.thumbUrl('FILE123', 1600),
          'https://drive.google.com/thumbnail?id=FILE123&sz=w1600',
          'the enlarged-photo width from DESIGN.md §3');
        T.assertEqual(
          Drive.thumbUrl('abc-DEF_123', 800),
          'https://drive.google.com/thumbnail?id=abc-DEF_123&sz=w800',
          'file ids contain hyphens and underscores and must not be mangled');
      });

      T.test('uploadImage rejects a bad mime type', function () {
        const png = Suites._pngBase64();
        T.assertThrows(() => Drive.uploadImage('FOLDER', png, 'image/gif', 'x.gif'),
          ERR.VALIDATION_FAILED, 'image/gif is not allowed');
        T.assertThrows(() => Drive.uploadImage('FOLDER', png, 'application/pdf', 'x.pdf'),
          ERR.VALIDATION_FAILED, 'application/pdf is not allowed');
        T.assertThrows(() => Drive.uploadImage('FOLDER', png, 'text/html', 'x.html'),
          ERR.VALIDATION_FAILED, 'text/html would be an XSS vector if it were stored');
        T.assertThrows(() => Drive.uploadImage('FOLDER', png, '', 'x'),
          ERR.VALIDATION_FAILED, 'empty mime type');
      });

      T.test('uploadImage rejects empty data', function () {
        T.assertThrows(() => Drive.uploadImage('FOLDER', '', 'image/png', 'x.png'),
          ERR.VALIDATION_FAILED, 'empty string');
        T.assertThrows(() => Drive.uploadImage('FOLDER', null, 'image/png', 'x.png'),
          ERR.VALIDATION_FAILED, 'null');
        T.assertThrows(() => Drive.uploadImage('FOLDER', undefined, 'image/png', 'x.png'),
          ERR.VALIDATION_FAILED, 'undefined');
      });

      T.test('uploadImage rejects an oversized payload', function () {
        // 7,200,000 base64 chars decode to 5.4 MB, over the 5 MB cap. Built from
        // 'A' so it is still valid base64 and the size check is what fires, not a
        // decode error.
        const oversized = 'A'.repeat(7200000);
        T.assert(oversized.length / 4 * 3 > DEFAULTS.max_image_bytes,
          'the fixture must actually exceed max_image_bytes (' +
          DEFAULTS.max_image_bytes + ')');
        T.assertThrows(() => Drive.uploadImage('FOLDER', oversized, 'image/png', 'big.png'),
          ERR.VALIDATION_FAILED, 'a 6 MB image must be refused');
      });

      T.test('uploadImage rejects PNG bytes declared as image/jpeg', function () {
        // CONTRACTS.md §9.3: never trust the client's declared mime type.
        T.assertThrows(
          () => Drive.uploadImage('FOLDER', Suites._pngBase64(), 'image/jpeg', 'liar.jpg'),
          ERR.VALIDATION_FAILED,
          'PNG magic number 89 50 4E 47 with a declared mime of image/jpeg must be refused');
      });

      T.test('uploadImage rejects JPEG bytes declared as image/png', function () {
        // The mirror case. 0xFF is byte -1 once Utilities.base64Decode hands back
        // Java signed bytes, so a magic-number check written as `bytes[0] === 0xFF`
        // is always false and silently passes everything. This test is the one that
        // catches that.
        T.assertThrows(
          () => Drive.uploadImage('FOLDER', Suites._jpegBase64(), 'image/png', 'liar.png'),
          ERR.VALIDATION_FAILED,
          'JPEG magic number FF D8 FF with a declared mime of image/png must be refused. ' +
          'If this passes, the magic-number check is comparing signed bytes against ' +
          'unsigned literals and never matches.');
      });

      T.test('uploadImage rejects bytes that are neither JPEG nor PNG', function () {
        // A ZIP file renamed to .png — the classic upload-a-payload attempt.
        // 'PK\x03\x04' = [80, 75, 3, 4].
        const zip = Utilities.base64Encode([80, 75, 3, 4, 20, 0, 0, 0, 8, 0]);
        T.assertThrows(() => Drive.uploadImage('FOLDER', zip, 'image/png', 'notreally.png'),
          ERR.VALIDATION_FAILED, 'a ZIP header must be refused');

        // And a nearly-right PNG header, one byte off.
        const almost = Utilities.base64Encode([-119, 80, 78, 70, 13, 10, 26, 10]);
        T.assertThrows(() => Drive.uploadImage('FOLDER', almost, 'image/png', 'almost.png'),
          ERR.VALIDATION_FAILED, 'a one-byte-wrong PNG signature must be refused');
      });

      T.test('[DRIVE WRITE] ensureTournamentFolders returns the full folder set', function () {
        const first = Drive.ensureTournamentFolders(TEST_FIXTURES.TID, 'zz-test-harness');
        Suites._trackFolders(first);

        ['rootId', 'publicId', 'playersId', 'galleryId', 'privateId', 'paymentsId']
          .forEach(k => {
            T.assert(first[k] && typeof first[k] === 'string',
              'ensureTournamentFolders must return a string ' + k + ', got ' + T._fmt(first[k]));
          });

        const ids = [first.publicId, first.playersId, first.galleryId,
          first.privateId, first.paymentsId];
        const distinct = {};
        ids.forEach(id => { distinct[id] = true; });
        T.assertEqual(Object.keys(distinct).length, ids.length,
          'the five sub-folders must be five different folders, got ' + T._fmt(ids));
      });

      T.test('[DRIVE WRITE] ensureTournamentFolders is idempotent', function () {
        // Folder creation must look up by name before creating (CONTRACTS.md §9.4).
        // If it does not, a second registration creates a duplicate "players"
        // folder and half the photos land somewhere nothing reads from.
        const first = Drive.ensureTournamentFolders(TEST_FIXTURES.TID, 'zz-test-harness');
        Suites._trackFolders(first);
        const second = Drive.ensureTournamentFolders(TEST_FIXTURES.TID, 'zz-test-harness');
        Suites._trackFolders(second);

        T.assertEqual(second, first,
          'calling ensureTournamentFolders twice must return the identical folder ids — ' +
          'different ids mean duplicate folders were created');
      });

      T.test('[DRIVE WRITE] ensureRootFolder is idempotent', function () {
        const a = Drive.ensureRootFolder();
        const b = Drive.ensureRootFolder();
        T.assertEqual(a, b, 'the shared CricketAuction root must be found, not recreated');
        // Deliberately NOT tracked for cleanup: it is shared with real tournaments.
      });

      T.test('[DRIVE WRITE] uploadImage stores a valid PNG and thumbUrl points at it',
        function () {
          const folders = Drive.ensureTournamentFolders(TEST_FIXTURES.TID, 'zz-test-harness');
          Suites._trackFolders(folders);

          const fileId = Drive.uploadImage(
            folders.playersId, Suites._pngBase64(), 'image/png', 'zz-test-1x1.png');
          T._state.driveIds.push({ id: fileId, kind: 'file' });

          T.assert(fileId && typeof fileId === 'string',
            'uploadImage must return a file id, got ' + T._fmt(fileId));
          T.assertEqual(Drive.thumbUrl(fileId, 320),
            'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w320',
            'the returned id must slot straight into thumbUrl');

          const dataUri = Drive.getAsDataUri(fileId);
          T.assert(typeof dataUri === 'string' && dataUri.indexOf('data:image/png;base64,') === 0,
            'getAsDataUri must return a png data URI, got ' +
            T._trunc(String(dataUri), 80));
        });

      T.test('[DRIVE WRITE] uploadImage stores a valid JPEG', function () {
        const folders = Drive.ensureTournamentFolders(TEST_FIXTURES.TID, 'zz-test-harness');
        Suites._trackFolders(folders);

        const fileId = Drive.uploadImage(
          folders.playersId, Suites._jpegBase64(), 'image/jpeg', 'zz-test.jpg');
        T._state.driveIds.push({ id: fileId, kind: 'file' });
        T.assert(fileId && typeof fileId === 'string',
          'a genuine JPEG declared as image/jpeg must be accepted, got ' + T._fmt(fileId));
      });

      T.test('[DRIVE WRITE] deleteFile removes an uploaded file', function () {
        const folders = Drive.ensureTournamentFolders(TEST_FIXTURES.TID, 'zz-test-harness');
        Suites._trackFolders(folders);
        const fileId = Drive.uploadImage(
          folders.playersId, Suites._pngBase64(), 'image/png', 'zz-test-delete-me.png');

        let threw = null;
        try { Drive.deleteFile(fileId); } catch (e) { threw = e; }
        T.assert(threw === null, 'deleteFile must not throw: ' + T._errText(threw));

        // CONTRACTS.md §9 does not say whether "delete" means trash or permanent
        // removal, so accept either: the file is trashed, or it is gone entirely.
        let stillLive = false;
        try {
          stillLive = !DriveApp.getFileById(fileId).isTrashed();
        } catch (e) {
          stillLive = false;   // unretrievable == deleted, which is also correct
        }
        T.assert(!stillLive,
          'after deleteFile the file must be trashed or gone, but it is still live: ' + fileId);
      });
    });
  },

  // ===========================================================================
  // Shared fixture helpers
  // ===========================================================================

  /**
   * @private Look up an action in the real route table.
   *
   * Phase 1 handlers are reached this way rather than through the module object,
   * because CONTRACTS-PHASE1.md §2 pins the ACTION names and CONTRACTS.md §11 pins
   * the handler signature, while the internal function names are nobody's contract.
   *
   * @param {string} action e.g. 'tournament.create'
   * @return {{auth: (string|!Array<string>), methods: !Array<string>, handler: !Function}}
   */
  _route(action) {
    let routes = null;
    try {
      routes = buildRoutes();
    } catch (e) {
      T._fail('buildRoutes() threw: ' + T._errText(e));
    }
    if (!Object.prototype.hasOwnProperty.call(routes, action)) {
      T._fail('the action "' + action + '" is not registered. CONTRACTS-PHASE1.md §2 ' +
        'requires it. Registered actions: ' + Object.keys(routes).sort().join(', '));
    }
    const route = routes[action];
    T.assert(route && typeof route.handler === 'function',
      'route "' + action + '" has no handler function');
    T.assert(Array.isArray(route.methods),
      'route "' + action + '" must declare a methods array (CONTRACTS.md §11)');
    return route;
  },

  /**
   * @private Call an action's handler directly, the way dispatch() would.
   *
   * Authentication is dispatch's job, not the handler's, so the session is passed
   * in ready-made. The route's declared auth level is asserted separately, in the
   * routing test of each suite.
   *
   * @param {string} action
   * @param {!Object} payload
   * @param {?Object} session resolved session, or null for a PUBLIC action.
   * @return {*} whatever the handler returns
   */
  _call(action, payload, session) {
    return Suites._route(action).handler(payload || {}, session || null, null);
  },

  /**
   * @private Does a route's auth spec admit this role?
   *
   * Code.gs accepts either a role array or one of the strings 'PUBLIC' / 'ANY',
   * and CONTRACTS.md §11 does not force one spelling, so both are understood here
   * rather than asserting a literal that would fail for a correct implementation.
   *
   * @param {string|!Array<string>} spec the route's `auth` value
   * @param {string} role an ENUM.USER_ROLE member
   * @return {boolean}
   */
  _authAllows(spec, role) {
    if (spec === 'ANY') return true;
    if (spec === 'PUBLIC') return true;
    if (Array.isArray(spec)) return spec.indexOf(role) !== -1;
    return String(spec) === role;
  },

  /**
   * @private A logged-in ADMIN session, for the actions that need one.
   * @param {string} tag makes the fixture email unique within the run.
   * @return {!Object} the resolved session, with `token` attached
   */
  _adminSession(tag) {
    const user = Suites._makeUser(
      Suites._fixtureEmail(tag), 'ZZ ' + tag, ENUM.USER_ROLE.ADMIN, null);
    const login = Auth.login(user.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
    const session = Auth.resolve(login.token);
    if (!session) {
      T._fail('could not build an ADMIN session: Auth.resolve returned null for a ' +
        'token that Auth.login had just issued');
    }
    // dispatch() leaves the raw token on the session (Code.gs, auth.logout).
    session.token = login.token;
    return session;
  },

  /**
   * @private An ORGANISER session scoped to exactly one tournament.
   *
   * The same shape as _adminSession, separate because Auth.createUser refuses an
   * ORGANISER with no tournamentId (an organiser with no scope is an accidental
   * global admin) and because the Phase 2 tests need both roles side by side.
   *
   * @param {string} tag makes the fixture email unique within the run.
   * @param {string} tournamentId the one tournament this organiser may see.
   * @return {!Object} the resolved session, with `token` attached
   */
  _organiserSession(tag, tournamentId) {
    const user = Suites._makeUser(
      Suites._fixtureEmail(tag), 'ZZ ' + tag, ENUM.USER_ROLE.ORGANISER, tournamentId);
    const login = Auth.login(user.email, TEST_FIXTURES.PASSWORD, 'zz-test-agent');
    const session = Auth.resolve(login.token);
    if (!session) {
      T._fail('could not build an ORGANISER session: Auth.resolve returned null for a ' +
        'token that Auth.login had just issued');
    }
    session.token = login.token;
    return session;
  },

  /**
   * @private Go through the REAL dispatcher, authentication included.
   *
   * Suites._call skips authentication deliberately: CONTRACTS.md §11 makes it
   * dispatch's job, not the handler's, and passing a ready-made session keeps
   * every other test focused on behaviour. The few tests that are ABOUT
   * authentication have to come in through the front door instead, because that
   * is where the role check actually lives.
   *
   * @param {string} action e.g. 'payment.getScreenshot'
   * @param {!Object} payload the request payload
   * @param {?string} token a session token, or null for "no token at all"
   * @param {string=} method 'POST' by default
   * @return {!Object} the CONTRACTS.md §2 envelope. dispatch never throws.
   */
  _dispatch(action, payload, token, method) {
    const envelope = dispatch(action, payload || {}, token || null, method || 'POST', null);
    T.assert(envelope && typeof envelope === 'object' && typeof envelope.ok === 'boolean',
      'dispatch must return a CONTRACTS.md §2 envelope, got ' + T._fmt(envelope));
    if (envelope.ok === false) {
      T.assert(envelope.error && envelope.error.code,
        'a failed envelope must carry error.code (CONTRACTS.md §2), got ' + T._fmt(envelope));
    }
    return envelope;
  },

  /**
   * @private Every AuditLog row about one entity, in the order they were written.
   *
   * The trail is append-only (DESIGN.md §42), so "how many rows" and "in what
   * order" are both assertable facts: a reversal must add a row rather than edit
   * the first one, and a no-op must add nothing at all.
   *
   * @param {string} entityId a player_id or payment_id
   * @param {?string} action an Audit.ACTIONS value, or null for "any action"
   * @return {!Array<!Object>} the matching rows, oldest first
   */
  _auditRows(entityId, action) {
    const want = (entityId === null || entityId === undefined) ? '' : String(entityId).trim();
    return Repo.readAll(SHEETS.AUDIT_LOG).filter(function (r) {
      const id = (r.entity_id === null || r.entity_id === undefined) ? '' : String(r.entity_id).trim();
      if (id !== want) return false;
      return !action || String(r.action).trim() === action;
    });
  },

  /**
   * @private Build (but do not write) one Players row.
   *
   * The Phase 2 suites need hundreds of players and care about paging, filtering
   * and mirroring, not about registration. Going through player.register would
   * mean three Drive uploads each and several minutes for a run, and would prove
   * nothing that the Registration suite does not already prove.
   *
   * photo_file_id carries TEST_FIXTURES.FAKE_DRIVE_PREFIX so it is non-blank —
   * the "no file id in a bulk response" assertions search the serialised wire
   * for the literal value, and searching for '' would pass against anything.
   *
   * @param {string} tournamentId the tournament this player belongs to
   * @param {!Object} spec the fields worth varying; everything else is defaulted
   * @return {!Object} a Players row object
   */
  _playerRow(tournamentId, spec) {
    const s = spec || {};
    const serial = Util.toInt(s.serial_no, 0);
    const name = s.name || ('ZZ Seed ' + Suites._seqLetters());
    const role = s.role || ENUM.PLAYER_ROLE.BATSMAN;
    const style = s.style || ENUM.PLAYER_STYLE.RIGHT;
    const photoId = TEST_FIXTURES.FAKE_DRIVE_PREFIX + 'photo' + T.nextSeq();
    return {
      player_id: s.player_id || Util.uid(ID_PREFIX.PLAYER),
      tournament_id: tournamentId,
      serial_no: serial,
      name: name,
      dob: s.dob || '1998-04-12',
      age_years: (s.age_years === undefined) ? 28 : s.age_years,
      role: role,
      style: style,
      mobile: s.mobile || Suites._freshMobile(),
      photo_file_id: photoId,
      photo_thumb_url: Drive.thumbUrl(photoId, 320),
      payment_status: s.payment_status || ENUM.PAYMENT_STATUS.PENDING,
      auction_status: s.auction_status || ENUM.AUCTION_STATUS.PENDING,
      // Defaults to 0, which is what every pre-Phase-4 caller relies on. The
      // Reports suite sets it explicitly because the difference between
      // "Awaiting re-auction" and "Not called" is nothing but this number
      // (DESIGN.md §6.9).
      times_called: Util.toInt(s.times_called, 0),
      team_id: s.team_id || '',
      // Blank, not 0: "never sold" and "sold for nothing" are different facts.
      sold_amount: (s.sold_amount === undefined) ? '' : s.sold_amount,
      sold_at: s.sold_at || '',
      is_withdrawn: s.is_withdrawn === true,
      search_blob: (name + ' ' + role + ' ' + style).toLowerCase(),
      registered_at: s.registered_at || Util.nowIso()
    };
  },

  /**
   * @private Build (but do not write) the Payments row for a seeded player.
   *
   * `status` MIRRORS the player's payment_status by default. Payments.gs is the
   * only writer of both in production and it writes them inside one lock
   * (CONTRACTS-PHASE2 §1 step 5), so a fixture that started them out of step
   * would be testing a state the system cannot produce. `payment_row_status` is
   * the deliberate escape hatch for the one test that breaks the mirror on
   * purpose.
   *
   * @param {string} tournamentId the tournament
   * @param {!Object} playerRow the player this payment belongs to
   * @param {!Object} spec the same spec object the player was built from
   * @return {!Object} a Payments row object
   */
  _paymentRow(tournamentId, playerRow, spec) {
    const s = spec || {};
    return {
      payment_id: s.payment_id || Util.uid(ID_PREFIX.PAYMENT),
      tournament_id: tournamentId,
      player_id: playerRow.player_id,
      upi_ref: s.upi_ref || Suites._freshUpiRef(),
      amount: (s.amount === undefined) ? 500 : s.amount,
      screenshot_file_id: (s.screenshot_file_id === undefined)
        ? TEST_FIXTURES.FAKE_DRIVE_PREFIX + 'shot' + T.nextSeq()
        : s.screenshot_file_id,
      status: s.payment_row_status || s.payment_status || ENUM.PAYMENT_STATUS.PENDING,
      verified_by: s.verified_by || '',
      verified_at: s.verified_at || '',
      reject_reason: s.reject_reason || '',
      submitted_at: s.submitted_at || playerRow.registered_at
    };
  },

  /**
   * @private Seed a whole roster: one Players row and one Payments row per spec,
   * in two setValues() calls rather than two per player.
   *
   * Every fixture tournament here carries TEST_FIXTURES.TID_PREFIX, so the
   * existing T.cleanup() purge finds and deletes both tabs' rows by
   * tournament_id without any extra bookkeeping.
   *
   * @param {string} tournamentId the tournament
   * @param {!Array<!Object>} specs one spec per player
   * @return {{players: !Array<!Object>, payments: !Array<!Object>,
   *           bySerial: !Object}} the written rows, with _row set
   */
  _seedRoster(tournamentId, specs) {
    const list = specs || [];
    if (!list.length) return { players: [], payments: [], bySerial: {} };

    const players = Repo.appendMany(SHEETS.PLAYERS,
      list.map(s => Suites._playerRow(tournamentId, s)));
    const payments = Repo.appendMany(SHEETS.PAYMENTS,
      players.map((p, i) => Suites._paymentRow(tournamentId, p, list[i])));

    const bySerial = {};
    players.forEach((p, i) => {
      bySerial[p.serial_no] = { player: p, payment: payments[i] };
    });
    return { players: players, payments: payments, bySerial: bySerial };
  },

  /**
   * @private Write one Teams row directly, bypassing team.create.
   *
   * Used wherever a team is scenery, and — more importantly — wherever a fixture
   * needs a NON-ZERO purse_used or players_count. Phase 3 only ever writes zeros
   * (CONTRACTS-PHASE3 §3) and Phase 4 maintains the counters inside the sale
   * lock, so the only way to test a Phase 3 guard against "12 players already
   * bought" without running twelve sales is to write the number.
   *
   * Every call site that does that says so. The Auction suite deliberately does
   * NOT: its counters have to stay derivable from AuctionResults, because the
   * invariant sweep at the end of that suite re-derives every one of them.
   *
   * @param {string} tournamentId the tournament
   * @param {Object=} spec row fields worth varying; everything else is defaulted
   * @return {!Object} the written row, with _row set
   */
  _seedTeam(tournamentId, spec) {
    const s = spec || {};
    return Repo.append(SHEETS.TEAMS, {
      team_id: s.team_id || Util.uid(ID_PREFIX.TEAM),
      tournament_id: tournamentId,
      team_name: s.team_name || ('ZZ Team ' + Suites._seqLetters()),
      owner_name: s.owner_name || '',
      logo_file_id: '',
      purse_total: (s.purse_total === undefined) ? 1000000 : s.purse_total,
      purse_used: (s.purse_used === undefined) ? 0 : s.purse_used,
      max_players: (s.max_players === undefined) ? 13 : s.max_players,
      players_count: (s.players_count === undefined) ? 0 : s.players_count,
      created_at: s.created_at || Util.nowIso(),
      created_by: TEST_FIXTURES.ACTOR
    });
  },

  /**
   * @private Seed several teams in order.
   * @param {string} tournamentId the tournament
   * @param {!Array<!Object>} specs one spec per team
   * @return {!Array<!Object>} the written rows
   */
  _seedTeams(tournamentId, specs) {
    return (specs || []).map(s => Suites._seedTeam(tournamentId, s));
  },

  /**
   * @private Write one AuctionResults row directly.
   *
   * The tab is append-only and Phase 4 is its only real writer, so this exists
   * for the two things that need history without a sale: proving that
   * Teams.recomputeCounters ignores a superseded row, and giving a report a
   * correction to display.
   *
   * `is_current` defaults to TRUE, because a lone seeded row is normally meant
   * to be the standing answer. Pass `is_current: false` for a superseded one.
   *
   * @param {string} tournamentId the tournament
   * @param {Object=} spec row fields
   * @return {!Object} the written row, with _row set
   */
  _seedResult(tournamentId, spec) {
    const s = spec || {};
    return Repo.append(SHEETS.AUCTION_RESULTS, {
      auction_id: s.auction_id || Util.uid(ID_PREFIX.AUCTION),
      tournament_id: tournamentId,
      player_id: s.player_id || '',
      serial_no: Util.toInt(s.serial_no, 0),
      status: s.status || ENUM.RESULT_STATUS.SOLD,
      team_id: s.team_id || '',
      // Blank, not 0, for a non-sale — the same rule Auction._appendResult follows.
      amount: (s.amount === undefined) ? '' : s.amount,
      auction_time: s.auction_time || Util.nowIso(),
      recorded_by: s.recorded_by || TEST_FIXTURES.ACTOR,
      is_current: s.is_current !== false,
      supersedes_auction_id: s.supersedes_auction_id || '',
      note: s.note || ''
    });
  },

  /**
   * @private Write one AuditLog row directly.
   *
   * Only the audit VIEWER tests use this. Provoking a spread of actions, actors
   * and timestamps through real operations would take several tabs of fixtures
   * and would still not let a test pin the instants, which is exactly what an
   * IST date-range test has to do.
   *
   * The row carries a fixture tournament_id, so the existing cleanup purge finds
   * it — an audit row is the one kind of debris that cannot be tidied later.
   *
   * @param {string} tournamentId the tournament
   * @param {Object=} spec row fields
   * @return {!Object} the written row, with _row set
   */
  _seedAudit(tournamentId, spec) {
    const s = spec || {};
    return Repo.append(SHEETS.AUDIT_LOG, {
      log_id: s.log_id || Util.uid(ID_PREFIX.LOG),
      timestamp: s.timestamp || Util.nowIso(),
      actor_user_id: s.actor_user_id || TEST_FIXTURES.ACTOR,
      actor_role: s.actor_role || ENUM.USER_ROLE.ADMIN,
      action: s.action || Audit.ACTIONS.TEAM_CREATED,
      tournament_id: tournamentId,
      entity_type: s.entity_type || 'Team',
      entity_id: s.entity_id || '',
      prev_value: (s.prev_value === undefined) ? '' : s.prev_value,
      new_value: (s.new_value === undefined) ? '' : s.new_value,
      user_agent: s.user_agent || 'zz-test-agent'
    });
  },

  /**
   * @private Pull the one-time token out of an organiser joinUrl.
   *
   * The plain token exists in exactly one place — this URL — so every organiser
   * test has to read it back out of the link the way the organiser's browser
   * would (CONTRACTS-PHASE3 §1).
   *
   * @param {string} joinUrl the joinUrl from organiser.create / resendLink
   * @return {string} the decoded token
   */
  _joinToken(joinUrl) {
    const s = (joinUrl === null || joinUrl === undefined) ? '' : String(joinUrl);
    const at = s.indexOf('?k=');
    if (at === -1) {
      T._fail('the joinUrl must carry the one-time token as "?k=", got ' + T._fmt(joinUrl));
    }
    return decodeURIComponent(s.slice(at + 3));
  },

  /**
   * @private Decode a base64 CSV export back into text.
   * @param {string} base64 the `base64` field of an export envelope
   * @return {string} the file contents, BOM included
   */
  _decodeCsv(base64) {
    return Utilities.newBlob(Utilities.base64Decode(String(base64))).getDataAsString('UTF-8');
  },

  /**
   * @private A real RFC 4180 reader, written here on purpose.
   *
   * WHY NOT text.split(','): the whole point of the export tests is that a name
   * containing a comma, a double quote or a newline does not shift the columns
   * after it. A naive split would happily pass on a file Excel cannot read,
   * which is the one bug these tests exist to catch. So the parser handles the
   * three things the format actually specifies: fields wrapped in quotes,
   * embedded quotes doubled, and CRLF row terminators.
   *
   * The BOM is NOT stripped here — a caller that wants to assert it is present
   * needs to see it.
   *
   * @param {string} text the CSV document
   * @return {!Array<!Array<string>>} rows of fields
   */
  _parseCsv(text) {
    const s = (text === null || text === undefined) ? '' : String(text);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    while (i < s.length) {
      const ch = s.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          // A doubled quote inside a quoted field is one literal quote.
          if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' && s.charAt(i + 1) === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; i += 2; continue;
      }
      if (ch === '\n' || ch === '\r') {
        row.push(field); rows.push(row); row = []; field = ''; i++; continue;
      }
      field += ch; i++;
    }
    // A document that ends with its terminator leaves nothing pending, and must
    // not produce a phantom empty row.
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  },

  /**
   * @private A valid `tournament.create` payload. Overrides are applied on top,
   * including explicit nulls, so a rejection test can spoil exactly one field.
   * @param {string} tag
   * @param {Object=} overrides
   * @return {!Object}
   */
  _createPayload(tag, overrides) {
    const p = {
      name: 'ZZ Test Tournament ' + tag,
      description: 'Fixture tournament written by Tests.gs. Safe to delete.',
      startDate: '2026-09-05',
      endDate: '2026-09-20',
      regStart: '2026-08-01',
      regEnd: '2026-08-31',
      regFee: 500,
      upiId: 'zztest@okbank',
      contactName: 'ZZ Contact',
      contactMobile: '9876543210',
      contactEmail: 'zz.contact' + TEST_FIXTURES.EMAIL_DOMAIN,
      rules: 'Fixture rules. No real tournament uses these.',
      defaultPurse: 1000000,
      defaultMaxPlayers: 14,
      logo: null,
      qr: null,
      gallery: []
    };
    const o = overrides || {};
    Object.keys(o).forEach(k => { p[k] = o[k]; });
    return p;
  },

  /**
   * @private Create a tournament through the real action and register its id for
   * cleanup. The id is minted by the action and does not carry TID_PREFIX, so
   * T.trackTid is the only thing standing between this row and a permanent
   * resident of the TEST sheet.
   * @return {!Object} the action's return value
   */
  _createTournament(session, tag, overrides) {
    const out = Suites._call('tournament.create', Suites._createPayload(tag, overrides), session);
    if (out && out.tournament_id) T.trackTid(out.tournament_id);
    return out;
  },

  /**
   * @private Write a Tournaments row directly, bypassing tournament.create.
   *
   * Used wherever the tournament is scenery rather than the thing under test: it
   * is faster, it lets a test pin the status and the registration window exactly,
   * and it keeps the Registration suite from failing for a reason that belongs to
   * the Tournament suite.
   *
   * The id carries TEST_FIXTURES.TID_PREFIX, so the existing cleanup finds it.
   *
   * @param {string} tag short, unique within a run; becomes part of the id.
   * @param {Object=} overrides row fields, plus `withFolders:false` to skip Drive.
   * @return {{tid:string, slug:string, folders:?Object, row:!Object}}
   */
  _seedTournament(tag, overrides) {
    const o = overrides || {};
    const tid = TEST_FIXTURES.TID_PREFIX + tag;
    const slug = 'zz-test-' + tag;

    let folders = null;
    if (o.withFolders !== false) {
      folders = Drive.ensureTournamentFolders(tid, slug);
      Suites._trackFolders(folders);
    }
    T._state.cacheTids.push(tid);

    const row = {
      tournament_id: tid,
      slug: slug,
      name: 'ZZ Test ' + tag,
      description: 'Fixture tournament written by Tests.gs. Safe to delete.',
      start_date: o.start_date || '2026-09-05',
      end_date: o.end_date || '2026-09-20',
      reg_start: (o.reg_start === undefined) ? '2020-01-01' : o.reg_start,
      reg_end: (o.reg_end === undefined) ? '2099-12-31' : o.reg_end,
      reg_fee: (o.reg_fee === undefined) ? 500 : o.reg_fee,
      logo_file_id: '',
      photo_file_ids: '[]',
      qr_file_id: '',
      upi_id: 'zztest@okbank',
      contact_name: 'ZZ Contact',
      contact_mobile: '9876543210',
      contact_email: 'zz.contact' + TEST_FIXTURES.EMAIL_DOMAIN,
      rules: 'Fixture rules.',
      status: o.status || ENUM.TOURNAMENT_STATUS.REG_OPEN,
      drive_folder_id: folders ? folders.rootId : '',
      next_serial: (o.next_serial === undefined) ? 1 : o.next_serial,
      default_purse: 1000000,
      default_max_players: 14,
      display_token: 'zzdisplaytoken' + tag + Util.uid(ID_PREFIX.LOG).slice(4),
      created_at: Util.nowIso(),
      created_by: TEST_FIXTURES.ACTOR
    };

    const existing = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', tid);
    if (existing) {
      // Debris from a run that died before cleanup. Left alone, its Players rows
      // would make "the first registration is serial 1" fail for the wrong reason,
      // its Teams rows would make every team name a duplicate, and its
      // AuctionResults rows would put money into counters this run never spent.
      T._purge(SHEETS.AUCTION_RESULTS, r => r.tournament_id === tid, []);
      T._purge(SHEETS.PAYMENTS, r => r.tournament_id === tid, []);
      T._purge(SHEETS.PLAYERS, r => r.tournament_id === tid, []);
      T._purge(SHEETS.TEAMS, r => r.tournament_id === tid, []);
      Repo.updateRow(SHEETS.TOURNAMENTS, existing._row, row);
    } else {
      Repo.append(SHEETS.TOURNAMENTS, row);
    }
    return { tid: tid, slug: slug, folders: folders, row: row };
  },

  /**
   * @private Set a fixture tournament's status without going through setStatus,
   * so a transition test can start from any state including an illegal one.
   */
  _forceStatus(tournamentId, status) {
    const row = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', tournamentId);
    if (!row) T._fail('fixture tournament ' + tournamentId + ' has no row');
    Repo.updateRow(SHEETS.TOURNAMENTS, row._row, { status: status });
  },

  /**
   * @private An image field in the CONTRACTS-PHASE1.md §1 transport shape.
   * @param {string} kind 'png' or 'jpeg'
   * @param {string} filename
   * @return {{data:string, mime:string, filename:string}}
   */
  _imageField(kind, filename) {
    const isPng = (kind === 'png');
    return {
      data: isPng ? Suites._pngBase64() : Suites._jpegBase64(),
      mime: isPng ? DRIVE_MIME_PNG : DRIVE_MIME_JPEG,
      filename: filename
    };
  },

  /**
   * @private A valid Indian mobile number nobody else will use — not in this run,
   * and not in the previous one either.
   *
   * The run-unique middle block matters: player.checkMobile is rate-limited to 20
   * calls per 10 minutes PER NUMBER, so a fixed sequence like 9000000001 would
   * mean the second run inside ten minutes trips a limiter it never called.
   *
   * @return {string} 10 digits starting with 9
   */
  _freshMobile() {
    if (!T._state.mobileBase) {
      T._state.mobileBase =
        ('00000' + (parseInt(Util.uid(ID_PREFIX.PLAYER).slice(-6), 36) % 100000)).slice(-5);
    }
    return '9' + T._state.mobileBase + ('0000' + T.nextSeq()).slice(-4);
  },

  /**
   * @private A valid UPI reference (6-35 alphanumeric) unique within this run.
   * @return {string}
   */
  _freshUpiRef() {
    return 'ZZTESTUPI' + ('000000' + T.nextSeq()).slice(-6);
  },

  /**
   * @private A run-unique suffix made of LETTERS ONLY.
   *
   * CONTRACTS-PHASE1.md §3 restricts a player name to letters, spaces, dots and
   * apostrophes, so a fixture name cannot be disambiguated with a counter digit —
   * "ZZ Player 7" would be rejected by the very rule under test and every
   * registration in this suite would fail for the wrong reason.
   *
   * @return {string} e.g. "AQ"
   */
  _seqLetters() {
    let n = T.nextSeq();
    let out = '';
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26);
    } while (n > 0);
    return out;
  },

  /**
   * @private A complete, valid `player.register` payload. Overrides are applied
   * on top, including explicit nulls, so one field can be spoiled at a time.
   */
  _regPayload(tournamentId, overrides) {
    const p = {
      tournamentId: tournamentId,
      name: 'ZZ Player ' + Suites._seqLetters(),
      dob: '1998-04-12',
      role: ENUM.PLAYER_ROLE.ALL_ROUNDER,
      style: ENUM.PLAYER_STYLE.RIGHT,
      mobile: Suites._freshMobile(),
      upiRef: Suites._freshUpiRef(),
      photo: Suites._imageField('jpeg', 'zz-photo.jpg'),
      photoThumb: Suites._imageField('jpeg', 'zz-thumb.jpg'),
      screenshot: Suites._imageField('jpeg', 'zz-screenshot.jpg')
    };
    const o = overrides || {};
    Object.keys(o).forEach(k => { p[k] = o[k]; });
    return p;
  },

  /** @private Register a player through the real action. */
  _register(tournamentId, overrides) {
    return Suites._call('player.register', Suites._regPayload(tournamentId, overrides), null);
  },

  /**
   * @private Run `fn` with the clock pinned to an explicit instant.
   *
   * The registration window is an IST-day question (CONTRACTS.md §6a) and the two
   * failure modes only show up between 00:00 and 05:30 IST. A test that used the
   * real clock would pass at any other hour whether the code was right or wrong,
   * so the instant has to be chosen, not observed.
   *
   * Two seams are patched, because CONTRACTS pins both and an implementation may
   * use either: Util.nowIso (CONTRACTS.md §1.7 — every timestamp comes from here)
   * and the default `atIso` of Util.isWithinWindow (CONTRACTS.md §6a rule 2 —
   * every window check goes through it). An explicit atIso is left alone.
   *
   * If a window test fails while the IST suite passes, the likely cause is code
   * calling `new Date()` directly instead of going through Util.
   *
   * Both are plain properties on a plain object and both are restored in a finally.
   *
   * @param {string} isoInstant e.g. '2026-08-30T21:30:00.000Z' (03:00 IST on 31 Aug)
   * @param {function():*} fn
   * @return {*} whatever fn returns
   */
  _withFakeNow(isoInstant, fn) {
    const realNowIso = Util.nowIso;
    const realIsWithinWindow = Util.isWithinWindow;
    Util.nowIso = function () {
      return isoInstant;
    };
    Util.isWithinWindow = function (startIso, endIso, atIso) {
      const at = (atIso === undefined || atIso === null || atIso === '') ? isoInstant : atIso;
      return realIsWithinWindow.call(Util, startIso, endIso, at);
    };
    try {
      return fn();
    } finally {
      Util.nowIso = realNowIso;
      Util.isWithinWindow = realIsWithinWindow;
    }
  },

  /**
   * @private The id of the folder a Drive item sits in.
   *
   * DriveApp directly, on purpose: Drive.gs has no "where does this live" API and
   * the whole point of the caller is to look at the real parent, not at what the
   * code believes it wrote.
   *
   * @param {string} id file id, or folder id when isFolder is true
   * @param {boolean=} isFolder
   * @return {?string} the first parent's id, or null when there is none
   */
  _parentFolderId(id, isFolder) {
    if (Util.isBlank(id)) return null;
    const parents = isFolder
      ? DriveApp.getFolderById(id).getParents()
      : DriveApp.getFileById(id).getParents();
    return parents.hasNext() ? parents.next().getId() : null;
  },

  /**
   * @private A fixture email that is unique per run, so leftovers from an aborted
   * previous run cannot collide with this one. Registered for cleanup.
   * @param {string} tag
   * @return {string}
   */
  _fixtureEmail(tag) {
    const email = 'zz.' + tag + '.' + Util.uid(ID_PREFIX.USER).slice(4, 10).toLowerCase() +
      TEST_FIXTURES.EMAIL_DOMAIN;
    T._state.emails.push(email);
    return email;
  },

  /**
   * @private Creates a fixture user and registers it for cleanup.
   * @return {!Object} the created user, plus `email` for convenience.
   */
  _makeUser(email, displayName, role, tournamentId) {
    const user = Auth.createUser({
      email: email,
      displayName: displayName,
      password: TEST_FIXTURES.PASSWORD,
      role: role,
      tournamentId: tournamentId
    }, TEST_FIXTURES.ACTOR);
    T._state.userIds.push(user.user_id);
    user.email = user.email || email;
    return user;
  },

  /**
   * @private Asserts that a secret never leaks out of an Auth return value.
   * Checks key *presence*, not just truthiness, because `salt: ''` is still a leak
   * of the field's existence and will start carrying a value the day someone
   * "fixes" the blank.
   */
  _assertNoSecrets(obj, label) {
    T.assert(obj && typeof obj === 'object', label + ' must be an object, got ' + T._fmt(obj));
    const forbidden = ['password_hash', 'salt', 'password', 'pepper'];
    const keys = Object.keys(obj);
    forbidden.forEach(k => {
      T.assert(keys.indexOf(k) === -1,
        label + ' must not contain the key "' + k + '". Keys present: ' + keys.join(', '));
    });
    // One level down, because {user: {...}} is the usual shape.
    keys.forEach(k => {
      const v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.keys(v).forEach(inner => {
          T.assert(forbidden.indexOf(inner) === -1,
            label + '.' + k + ' must not contain the key "' + inner + '"');
        });
      }
    });
  },

  /**
   * @private A tournament id nobody has used before, registered so cleanup can
   * delete its durable version counter.
   * @return {string}
   */
  _freshCacheTid() {
    const tid = 'TRN_zzcache' + Util.uid(ID_PREFIX.LOG).slice(4, 9).toLowerCase();
    T._state.cacheTids.push(tid);
    return tid;
  },

  /**
   * @private Registers folders returned by ensureTournamentFolders for trashing.
   * Trashing the tournament root takes the children with it, but the children are
   * registered too in case the root is ever the shared one and gets skipped.
   */
  _trackFolders(folders) {
    if (!folders) return;
    const known = {};
    T._state.driveIds.forEach(d => { known[d.id] = true; });
    ['paymentsId', 'privateId', 'playersId', 'galleryId', 'publicId', 'rootId']
      .forEach(k => {
        const id = folders[k];
        if (id && !known[id]) {
          known[id] = true;
          T._state.driveIds.push({ id: id, kind: 'folder' });
        }
      });
  },

  /**
   * @private A real 1x1 transparent PNG. Magic number 89 50 4E 47 0D 0A 1A 0A.
   * @return {string} base64
   */
  _pngBase64() {
    return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA' +
      '60e6kgAAAABJRU5ErkJggg==';
  },

  /**
   * @private A minimal JPEG. Built from a signed byte array on purpose: 0xFF is
   * -1 in Java's signed byte range, which is exactly the value Drive.uploadImage
   * will see back out of Utilities.base64Decode.
   * @return {string} base64
   */
  _jpegBase64() {
    const bytes = [
      -1, -40,                                    // FF D8   SOI
      -1, -32, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, // FF E0   APP0 "JFIF"
      0, 1, 0, 1, 0, 0,
      -1, -37, 0, 67, 0,                          // FF DB   DQT
      -1, -39                                     // FF D9   EOI
    ];
    return Utilities.base64Encode(bytes);
  }
};


/**
 * Entry point. Select this in the Apps Script editor and press Run.
 *
 * Refuses to run unless the Config tab's `env` is exactly "TEST" — see
 * T.guardTestEnv() for why that is not negotiable.
 *
 * @return {!Object} {total, passed, failed, elapsedMs, failures}
 */
function runAllTests() {
  const env = T.guardTestEnv();   // must be the first thing that happens
  T.reset();
  T._state.startedAt = Date.now();
  T._log('Running the full suite against env=' + env + ' at ' + new Date().toISOString());

  try {
    Suites.defineAll();
    T._state.suites.forEach(s => T._runSuite(s));
  } finally {
    // Cleanup runs even when a suite blows up, so a failed run does not leave the
    // TEST sheet full of debris that breaks the next one.
    T.cleanup();
  }
  return T.report();
}

/**
 * Runs a single suite by name, e.g. runTest('Repo').
 *
 * Subject to the same env guard as runAllTests — there is no "just this one
 * suite" exemption, because every suite writes rows.
 *
 * @param {string} suiteName one of Util, IST, Tournament, Registration,
 *     PlayerList, PaymentVerify, Organiser, Teams, Auction, Reports, Repo, Auth,
 *     Cache, Drive.
 * @return {!Object} {total, passed, failed, elapsedMs, failures}
 */
function runTest(suiteName) {
  const env = T.guardTestEnv();   // must be the first thing that happens
  T.reset();
  T._state.startedAt = Date.now();

  Suites.defineAll();
  const match = T._state.suites.filter(s => s.name === suiteName);
  if (!match.length) {
    throw new Error('Unknown suite "' + suiteName + '". Available: ' +
      Suites.names().join(', '));
  }
  T._log('Running suite "' + suiteName + '" against env=' + env +
    ' at ' + new Date().toISOString());

  try {
    match.forEach(s => T._runSuite(s));
  } finally {
    T.cleanup();
  }
  return T.report();
}
