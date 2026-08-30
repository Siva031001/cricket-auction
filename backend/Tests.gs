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
  /** Passwords must be >= 10 chars (CONTRACTS.md §7); this one is 16. */
  PASSWORD: 'TestPassw0rd!234',
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
    cacheTids: []      // tournament ids whose cache/version keys must be purged
  },

  /** Wipes run state. Called by both entry points. */
  reset() {
    T._state = {
      suites: [], results: [], current: null, startedAt: 0,
      driveIds: [], userIds: [], emails: [], cacheTids: []
    };
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
    });
    try {
      const props = PropertiesService.getScriptProperties();
      const all = props.getProperties();
      Object.keys(all).forEach(k => {
        if (k.indexOf('v:' + TEST_FIXTURES.TID_PREFIX) === 0 || k.indexOf('v:TRN_zz') === 0) {
          props.deleteProperty(k);
        }
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

  /** @private */
  _isFixtureTid(v) {
    return typeof v === 'string' && v.indexOf(TEST_FIXTURES.TID_PREFIX) === 0;
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
          DriveApp.getFolderById(item.id).setTrashed(true);
        } else {
          DriveApp.getFileById(item.id).setTrashed(true);
        }
      } catch (e) {
        // Already trashed as part of a parent folder is the common case here.
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
      T._log('  ' + (t.fail === 0 ? 'PASS' : 'FAIL') + '  ' + T._pad(name, 10) +
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

  /** Registers every Phase 0 suite, in run order. */
  defineAll() {
    Suites.util();
    Suites.ist();
    Suites.repo();
    Suites.auth();
    Suites.cache();
    Suites.drive();
  },

  /** @return {!Array<string>} the names, for the "unknown suite" error message. */
  names() {
    return ['Util', 'IST', 'Repo', 'Auth', 'Cache', 'Drive'];
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

      T.test('createUser rejects a password under 10 characters', function () {
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
 * @param {string} suiteName one of Util, Repo, Auth, Cache, Drive.
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
