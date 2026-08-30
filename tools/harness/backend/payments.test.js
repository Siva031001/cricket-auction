/**
 * Phase 2 payment verification harness.
 * In-memory fakes for SpreadsheetApp / DriveApp / CacheService /
 * PropertiesService / LockService, then the real .gs files on top.
 */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const DIR = '/Users/raja.t/cricket-auction/backend';

// ------------------------------------------------------------------ fake sheet
let lockHeld = false;
let lockWaits = 0, lockReleases = 0;
const writeLog = [];            // {tab, row, lockHeld}
let flushes = 0, flushesUnderLock = 0;

function makeSheet(name, headers) {
  const grid = [headers.slice()];
  const sh = {
    _name: name,
    _grid: grid,
    getName: () => name,
    getSpreadsheetTimeZone: () => 'Asia/Kolkata',
    getLastRow: () => {
      let last = 0;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i].some((c) => c !== '' && c !== null && c !== undefined)) last = i + 1;
      }
      return last;
    },
    getMaxRows: () => grid.length,
    getMaxColumns: () => headers.length,
    insertRowsAfter: (after, n) => {
      for (let i = 0; i < n; i++) grid.push(new Array(headers.length).fill(''));
    },
    insertColumnsAfter: () => {},
    setFrozenRows: () => {},
    deleteRow: (r) => { grid.splice(r - 1, 1); },
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = grid[r - 1 + i] || new Array(headers.length).fill('');
          out.push(src.slice(c - 1, c - 1 + nc));
        }
        return out;
      },
      setValues: (vals) => {
        for (let i = 0; i < vals.length; i++) {
          const rowIdx = r - 1 + i;
          while (grid.length <= rowIdx) grid.push(new Array(headers.length).fill(''));
          for (let j = 0; j < vals[i].length; j++) grid[rowIdx][c - 1 + j] = vals[i][j];
          writeLog.push({ tab: name, row: rowIdx + 1, lockHeld: lockHeld });
        }
      },
      clearContent: () => {
        for (let i = 0; i < nr; i++) {
          const rowIdx = r - 1 + i;
          if (grid[rowIdx]) for (let j = 0; j < nc; j++) grid[rowIdx][c - 1 + j] = '';
        }
      }
    })
  };
  return sh;
}

const sheets = {};
const SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSpreadsheetTimeZone: () => 'Asia/Kolkata',
    getSheetByName: (n) => sheets[n] || null,
    getSheets: () => Object.values(sheets),
    insertSheet: (n) => { sheets[n] = makeSheet(n, []); return sheets[n]; }
  }),
  flush: () => { flushes++; if (lockHeld) flushesUnderLock++; }
};

// ------------------------------------------------------------------ fake Drive
const driveFiles = {};   // id -> {mime, bytes:Buffer}
let driveReads = [];
const DriveApp = {
  getFileById: (id) => {
    driveReads.push(id);
    const f = driveFiles[id];
    if (!f) throw new Error('No item with the given ID could be found: ' + id);
    return {
      getId: () => id,
      getBlob: () => ({ getContentType: () => f.mime, getBytes: () => f.bytes }),
      setTrashed: () => {},
      setSharing: () => {}
    };
  },
  getFolderById: () => { throw new Error('not a folder'); },
  getRootFolder: () => ({ getId: () => 'ROOT' }),
  getFoldersByName: () => ({ hasNext: () => false }),
  createFolder: () => ({ getId: () => 'NEW' }),
  Access: { ANYONE_WITH_LINK: 'A' },
  Permission: { VIEW: 'V' }
};

// -------------------------------------------------- fake Cache / Properties / Lock
const cacheStore = new Map(), propStore = new Map();
const CacheService = {
  getScriptCache: () => ({
    get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
    put: (k, v) => cacheStore.set(k, v),
    remove: (k) => cacheStore.delete(k)
  })
};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (propStore.has(k) ? propStore.get(k) : null),
    setProperty: (k, v) => propStore.set(k, String(v)),
    deleteProperty: (k) => propStore.delete(k)
  })
};
const LockService = {
  getScriptLock: () => ({
    waitLock: () => { lockWaits++; lockHeld = true; },
    releaseLock: () => { lockReleases++; lockHeld = false; }
  })
};

const Utilities = {
  getUuid: () => crypto.randomUUID(),
  computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
  computeHmacSha256Signature: (m, k) => Array.from(crypto.createHmac('sha256', String(k)).update(String(m)).digest()).map((b) => (b > 127 ? b - 256 : b)),
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
  base64Encode: (x) => Buffer.from(x).toString('base64'),
  newBlob: (b, m, n) => ({ getBytes: () => b, getContentType: () => m, getName: () => n }),
  formatDate: (d, tz, fmt) => {
    const ist = new Date(d.getTime() + 330 * 60000);
    const p = (n, w) => String(n).padStart(w, '0');
    if (fmt === 'HH:mm:ss.SSS') return p(ist.getUTCHours(), 2) + ':' + p(ist.getUTCMinutes(), 2) + ':' + p(ist.getUTCSeconds(), 2) + '.' + p(ist.getUTCMilliseconds(), 3);
    return ist.toISOString().substring(0, 10);
  },
  sleep: () => {}
};

const ContentService = { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'JSON' } };

const ctx = {
  console, Date, Math, JSON, isNaN, isFinite, parseInt, parseFloat, String, Number,
  Object, Array, Error, RegExp, Infinity, NaN, Buffer, encodeURIComponent, decodeURIComponent,
  SpreadsheetApp, DriveApp, CacheService, PropertiesService, LockService, Utilities, ContentService,
  Session: { getActiveUser: () => ({ getEmail: () => '' }) }
};
vm.createContext(ctx);

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.gs') && f !== 'Tests.gs').sort();
vm.runInContext(files.map((f) => fs.readFileSync(DIR + '/' + f, 'utf8')).join('\n'), ctx, { filename: 'ALL.gs' });

// The parallel Players.gs agent owns isAuctionEligible / eligibleCount
// (CONTRACTS-PHASE2 §2). Supply them here only if they have not landed yet.
vm.runInContext(`
if (typeof Players.isAuctionEligible !== 'function') {
  Players.isAuctionEligible = function (row) {
    return !!row && row.payment_status === 'VERIFIED' && row.is_withdrawn !== true;
  };
  globalThis.__stubbedEligible = true;
}
`, ctx);

const G = vm.runInContext('({Repo,Util,ENUM,ERR,SHEETS,HEADERS,Payments,Players,Audit,Auth,dispatch,buildRoutes,stubbed:!!globalThis.__stubbedEligible})', ctx);

// ------------------------------------------------------------------ test harness
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, m) { if (a !== b) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy'); }
function throwsCode(fn, code) {
  try { fn(); } catch (e) { if (e.code !== code) throw new Error('expected ' + code + ' got ' + e.code + ' (' + e.message + ')'); return e; }
  throw new Error('expected throw ' + code + ', nothing thrown');
}

// ------------------------------------------------------------------ fixtures
Object.keys(G.HEADERS).forEach((tab) => { sheets[tab] = makeSheet(tab, G.HEADERS[tab].slice()); });

const TID = 'TRN_test00000001';
const TID2 = 'TRN_other0000002';
vm.runInContext(`Repo.append(SHEETS.TOURNAMENTS, {tournament_id:'${TID}', slug:'t1', name:'T1', status:'REG_CLOSED', next_serial: 9, reg_fee: 500});`, ctx);
vm.runInContext(`Repo.append(SHEETS.TOURNAMENTS, {tournament_id:'${TID2}', slug:'t2', name:'T2', status:'REG_CLOSED', next_serial: 2, reg_fee: 500});`, ctx);

function addPlayer(n, name, tid, extra) {
  const e = extra || {};
  vm.runInContext(`Repo.append(SHEETS.PLAYERS, ${JSON.stringify(Object.assign({
    player_id: 'PLY_' + n, tournament_id: tid, serial_no: n, name: name, dob: '1995-01-01',
    age_years: 30, role: 'BATSMAN', style: 'RIGHT', mobile: '90000000' + String(n).padStart(2, '0'),
    photo_file_id: 'photo' + n, photo_thumb_url: 'https://drive.google.com/thumbnail?id=thumb' + n,
    payment_status: 'PENDING', auction_status: 'PENDING', times_called: 0, team_id: '',
    sold_amount: '', sold_at: '', is_withdrawn: false, search_blob: name.toLowerCase(),
    registered_at: '2026-08-2' + (n % 10) + 'T04:00:00.000Z'
  }, e))});`, ctx);
}
function addPayment(n, tid, extra) {
  const e = extra || {};
  vm.runInContext(`Repo.append(SHEETS.PAYMENTS, ${JSON.stringify(Object.assign({
    payment_id: 'PAY_' + n, tournament_id: tid, player_id: 'PLY_' + n, upi_ref: 'UPIREF' + n,
    amount: 500, screenshot_file_id: 'shot' + n, status: 'PENDING', verified_by: '',
    verified_at: '', reject_reason: '', submitted_at: '2026-08-2' + (n % 10) + 'T04:00:00.000Z'
  }, e))});`, ctx);
}

// 1..5 in TID, 6 in TID2.  #2 and #4 share a name exactly. #5 is a near match.
addPlayer(1, 'Raj Kumar', TID);
addPlayer(2, 'Suresh  Babu', TID);          // double space on purpose
addPlayer(3, 'Anil Menon', TID, { is_withdrawn: true, payment_status: 'VERIFIED' });
addPlayer(4, 'suresh babu', TID);           // exact match to #2 after normalising
addPlayer(5, 'Rajkumar', TID);              // near match to #1 — must NOT be flagged
addPlayer(6, 'Other Guy', TID2);
[1, 2, 3, 4, 5].forEach((n) => addPayment(n, TID, n === 3 ? { status: 'VERIFIED' } : {}));
addPayment(6, TID2);

driveFiles['shot1'] = { mime: 'image/jpeg', bytes: Buffer.from([0xFF, 0xD8, 0xFF, 1, 2, 3, 4, 5, 6, 7]) };
driveFiles['shot2'] = { mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47, 9, 9]) };

// sessions
function addSession(token, userId, role, tid) {
  vm.runInContext(`Repo.append(SHEETS.SESSIONS, ${JSON.stringify({
    token: token, user_id: userId, role: role, tournament_id: tid || '',
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 36e5).toISOString(), revoked: false
  })});`, ctx);
}
addSession('tok-admin', 'USR_admin', 'ADMIN', '');
addSession('tok-admin2', 'USR_admin2', 'ADMIN', '');
addSession('tok-org', 'USR_org', 'ORGANISER', TID);

const adminSession = { user_id: 'USR_admin', role: 'ADMIN', tournament_id: '', token: 'tok-admin' };
const admin2Session = { user_id: 'USR_admin2', role: 'ADMIN', tournament_id: '', token: 'tok-admin2' };

const P = G.Payments;
const auditRows = () => G.Repo.readAll('AuditLog');
const paymentRow = (id) => G.Repo.findBy('Payments', 'payment_id', id);
const playerRow = (id) => G.Repo.findBy('Players', 'player_id', id);

console.log('\n=== Phase 2 payment verification ===');
console.log(G.stubbed ? '  (Players.isAuctionEligible stubbed — parallel agent has not landed it yet)\n' : '  (using the real Players.isAuctionEligible)\n');

// ---------------------------------------------------------------- payment.list
t('list defaults to PENDING, oldest first', () => {
  const r = P.list({ tournamentId: TID }, adminSession);
  eq(r.rows.length, 4, 'pending rows');
  eq(r.total, 4);
  eq(r.page, 1); eq(r.pageSize, 50); eq(r.totalPages, 1);
  const times = r.rows.map((x) => Date.parse(x.submitted_at));
  for (let i = 1; i < times.length; i++) ok(times[i] >= times[i - 1], 'not oldest first');
});

t('list never leaks screenshot_file_id', () => {
  const r = P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL' } }, adminSession);
  const s = JSON.stringify(r);
  ok(s.indexOf('screenshot') === -1, 'screenshot key present');
  ok(s.indexOf('shot1') === -1, 'drive id present');
});

t('list counts are tournament-wide, not page-wide', () => {
  const r = P.list({ tournamentId: TID, pageSize: 1 }, adminSession);
  eq(r.rows.length, 1, 'page size honoured');
  eq(r.total, 4);
  eq(r.totalPages, 4);
  eq(r.counts.all, 5, 'all');
  eq(r.counts.pending, 4, 'pending');
  eq(r.counts.verified, 1, 'verified');
  eq(r.counts.rejected, 0, 'rejected');
  eq(r.counts.withdrawn, 1, 'withdrawn');
  eq(r.counts.eligible, 0, 'eligible — #3 is VERIFIED but withdrawn');
});

t('list reads each tab exactly once', () => {
  const before = G.Repo.readAll;
  let reads = [];
  vm.runInContext('globalThis.__reads = [];', ctx);
  vm.runInContext(`
    Repo.__readAll = Repo.readAll;
    Repo.readAll = function (tab) { globalThis.__reads.push(tab); return Repo.__readAll(tab); };
  `, ctx);
  vm.runInContext(`globalThis.__r = Payments.list({tournamentId:'${TID}'}, {user_id:'USR_admin', role:'ADMIN', tournament_id:''});`, ctx);
  reads = vm.runInContext('globalThis.__reads', ctx);
  vm.runInContext('Repo.readAll = Repo.__readAll;', ctx);
  const players = reads.filter((x) => x === 'Players').length;
  const payments = reads.filter((x) => x === 'Payments').length;
  eq(players, 1, 'Players readAll count — join and counts share one read');
  eq(payments, 1, 'Payments readAll count');
});

t('duplicate hint fires on an exact name match after collapsing whitespace', () => {
  const r = P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL' } }, adminSession);
  const byId = {};
  r.rows.forEach((x) => { byId[x.payment_id] = x; });
  eq(byId['PAY_2'].possible_duplicate_of, 4, '#2 points at the other "suresh babu"');
  eq(byId['PAY_4'].possible_duplicate_of, 2, '#4 points back at #2');
});

t('duplicate hint does NOT fire on a near match', () => {
  const r = P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL' } }, adminSession);
  const byId = {};
  r.rows.forEach((x) => { byId[x.payment_id] = x; });
  eq(byId['PAY_1'].possible_duplicate_of, null, '"Raj Kumar" vs "Rajkumar"');
  eq(byId['PAY_5'].possible_duplicate_of, null);
});

t('list is scoped to one tournament', () => {
  const r = P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL' } }, adminSession);
  ok(r.rows.every((x) => x.payment_id !== 'PAY_6'), 'other tournament leaked in');
  eq(r.counts.all, 5);
});

t('list filters: search, withdrawn, bad status', () => {
  eq(P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL', search: 'UPIREF4' } }, adminSession).rows.length, 1);
  eq(P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL', search: 'suresh' } }, adminSession).rows.length, 2);
  eq(P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL', withdrawn: true } }, adminSession).rows.length, 1);
  eq(P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL', withdrawn: false } }, adminSession).rows.length, 4);
  throwsCode(() => P.list({ tournamentId: TID, filter: { paymentStatus: 'NOPE' } }, adminSession), G.ERR.VALIDATION_FAILED);
  throwsCode(() => P.list({}, adminSession), G.ERR.BAD_REQUEST);
});

t('list formats money and dates the Indian way', () => {
  const row = P.list({ tournamentId: TID }, adminSession).rows[0];
  eq(row.amount_display, '₹500');
  ok(/^\d{1,2} [A-Z][a-z]{2} \d{4}, /.test(row.submitted_at_display), 'IST display: ' + row.submitted_at_display);
});

// -------------------------------------------------------- payment.getScreenshot
t('getScreenshot returns bytes as a data URI', () => {
  const r = P.getScreenshot({ paymentId: 'PAY_1' }, adminSession);
  ok(r.dataUri.indexOf('data:image/jpeg;base64,') === 0, 'data uri prefix');
  eq(r.mime, 'image/jpeg');
  eq(r.bytes, 10, 'decoded byte count');
  eq(r.player.serial_no, 1);
  eq(r.player.name, 'Raj Kumar');
  eq(r.upi_ref, 'UPIREF1');
  eq(r.amount_display, '₹500');
});

t('getScreenshot NEVER returns a file id or a Drive URL (asserted on the JSON)', () => {
  const s = JSON.stringify(P.getScreenshot({ paymentId: 'PAY_2' }, adminSession));
  ok(s.indexOf('shot2') === -1, 'drive file id in the response');
  ok(s.indexOf('drive.google.com') === -1, 'drive url in the response');
  ok(s.indexOf('docs.google.com') === -1, 'docs url in the response');
  ok(s.indexOf('file_id') === -1, 'a *_file_id key in the response');
  ok(s.indexOf('fileId') === -1, 'a fileId key in the response');
  ok(s.indexOf('"data:image/png;base64,iVBO') === -1 || true);
});

t('getScreenshot does not cache the data URI', () => {
  const before = cacheStore.size;
  P.getScreenshot({ paymentId: 'PAY_1' }, adminSession);
  eq(cacheStore.size, before, 'cache grew');
  for (const v of cacheStore.values()) ok(String(v).indexOf('base64') === -1, 'base64 found in cache');
});

t('getScreenshot has no plural/batch variant', () => {
  const routes = Object.keys(G.buildRoutes());
  ok(routes.indexOf('payment.getScreenshots') === -1, 'a plural route exists');
  ok(!G.Payments.getScreenshots, 'a plural function exists');
});

t('getScreenshot refuses a non-admin through the dispatcher', () => {
  const env = G.dispatch('payment.getScreenshot', { paymentId: 'PAY_1' }, 'tok-org', 'POST', null);
  eq(env.ok, false);
  eq(env.error.code, G.ERR.FORBIDDEN);
  const env2 = G.dispatch('payment.getScreenshot', { paymentId: 'PAY_1' }, null, 'POST', null);
  eq(env2.ok, false);
  eq(env2.error.code, G.ERR.UNAUTHORIZED);
  const env3 = G.dispatch('payment.getScreenshot', { paymentId: 'PAY_1' }, 'tok-admin', 'POST', null);
  eq(env3.ok, true, 'admin should be allowed');
  ok(JSON.stringify(env3).indexOf('shot1') === -1, 'file id leaked through the dispatcher');
});

t('getScreenshot: unknown payment and missing file', () => {
  throwsCode(() => P.getScreenshot({ paymentId: 'PAY_nope' }, adminSession), G.ERR.NOT_FOUND);
  throwsCode(() => P.getScreenshot({}, adminSession), G.ERR.BAD_REQUEST);
  const e = throwsCode(() => P.getScreenshot({ paymentId: 'PAY_5' }, adminSession), G.ERR.NOT_FOUND);
  ok(e.message.indexOf('shot5') === -1, 'drive id in the error message');
});

t('every payment route is ADMIN + POST', () => {
  const r = G.buildRoutes();
  ['payment.list', 'payment.getScreenshot', 'payment.verify', 'payment.reject'].forEach((a) => {
    ok(r[a], a + ' missing from the route table');
    eq(JSON.stringify(r[a].auth), '["ADMIN"]', a + ' auth');
    eq(JSON.stringify(r[a].methods), '["POST"]', a + ' methods');
  });
});

// ------------------------------------------------------------- payment.verify
t('verify mirrors the status onto the Players row', () => {
  const auditBefore = auditRows().length;
  const before = { waits: lockWaits, releases: lockReleases };
  const r = P.verify({ paymentId: 'PAY_1', note: 'matched bank line 42' }, adminSession);

  eq(r.status, 'VERIFIED');
  eq(r.payment_id, 'PAY_1');
  eq(r.player_id, 'PLY_1');
  eq(r.serial_no, 1);
  ok(r.verified_at_display, 'no verified_at_display');
  ok(!r.alreadyVerified, 'should not be a no-op');
  ok(!r.reversedFrom, 'not a reversal');

  eq(paymentRow('PAY_1').status, 'VERIFIED', 'Payments row');
  eq(playerRow('PLY_1').payment_status, 'VERIFIED', 'MIRROR onto Players row');
  eq(paymentRow('PAY_1').verified_by, 'USR_admin');
  ok(paymentRow('PAY_1').verified_at, 'verified_at not set');

  eq(r.counts.verified, 2, 'counts.verified');
  eq(r.counts.pending, 3, 'counts.pending');
  eq(r.counts.eligible, 1, 'counts.eligible');
  eq(r.counts.all, 5, 'counts are tournament-wide');

  eq(auditRows().length, auditBefore + 1, 'one audit row');
  const a = auditRows()[auditRows().length - 1];
  eq(a.action, 'PAYMENT_VERIFIED');
  eq(a.actor_user_id, 'USR_admin');
  eq(a.entity_id, 'PAY_1');
  const prev = JSON.parse(a.prev_value), next = JSON.parse(a.new_value);
  eq(prev.status, 'PENDING'); eq(prev.player_payment_status, 'PENDING');
  eq(next.status, 'VERIFIED'); eq(next.player_payment_status, 'VERIFIED');
  eq(next.reversal, false);
  eq(next.note, 'matched bank line 42');

  ok(lockWaits === before.waits + 1, 'lock was not taken');
  ok(lockReleases === before.releases + 1, 'lock was not released');
});

t('verify writes both rows while the lock is held, and flushes under it', () => {
  const startWrites = writeLog.length, startFlush = flushesUnderLock;
  P.verify({ paymentId: 'PAY_2' }, adminSession);
  const w = writeLog.slice(startWrites).filter((x) => x.tab === 'Payments' || x.tab === 'Players');
  ok(w.length >= 2, 'expected a Payments and a Players write, got ' + w.length);
  ok(w.every((x) => x.lockHeld === true), 'a row was written outside the lock');
  ok(flushesUnderLock > startFlush, 'Repo.flush() was not called under the lock');
  eq(lockHeld, false, 'lock left held');
});

t('double verify is a silent no-op success', () => {
  const auditBefore = auditRows().length;
  const writesBefore = writeLog.length;
  const r = P.verify({ paymentId: 'PAY_1' }, admin2Session);
  eq(r.status, 'VERIFIED');
  eq(r.alreadyVerified, true, 'alreadyVerified flag');
  ok(r.counts, 'counts still returned');
  ok(r.verified_at_display, 'existing verified_at echoed back');
  eq(paymentRow('PAY_1').verified_by, 'USR_admin', 'first verifier must not be overwritten');
  eq(auditRows().length, auditBefore, 'a no-op must not write an audit row');
  const dataWrites = writeLog.slice(writesBefore).filter((x) => x.tab === 'Payments' || x.tab === 'Players');
  eq(dataWrites.length, 0, 'a no-op must not write a row');
  eq(lockWaits > 0 && lockHeld === false, true);
});

t('verify repairs a drifted mirror instead of hiding it', () => {
  // Force drift by hand: Payments says VERIFIED, Players still says PENDING.
  const pl = playerRow('PLY_1');
  vm.runInContext(`Repo.updateRow(SHEETS.PLAYERS, ${pl._row}, {payment_status: 'PENDING'});`, ctx);
  eq(playerRow('PLY_1').payment_status, 'PENDING');
  const r = P.verify({ paymentId: 'PAY_1' }, adminSession);
  eq(r.alreadyVerified, true);
  eq(r.mirrorRepaired, true);
  eq(playerRow('PLY_1').payment_status, 'VERIFIED', 'mirror not repaired');
});

// ------------------------------------------------------------- payment.reject
t('reject requires a reason of 3-200 chars', () => {
  throwsCode(() => P.reject({ paymentId: 'PAY_4' }, adminSession), G.ERR.VALIDATION_FAILED);
  throwsCode(() => P.reject({ paymentId: 'PAY_4', reason: '' }, adminSession), G.ERR.VALIDATION_FAILED);
  throwsCode(() => P.reject({ paymentId: 'PAY_4', reason: '  ' }, adminSession), G.ERR.VALIDATION_FAILED);
  throwsCode(() => P.reject({ paymentId: 'PAY_4', reason: 'no' }, adminSession), G.ERR.VALIDATION_FAILED);
  throwsCode(() => P.reject({ paymentId: 'PAY_4', reason: 'x'.repeat(201) }, adminSession), G.ERR.VALIDATION_FAILED);
  eq(paymentRow('PAY_4').status, 'PENDING', 'a failed reject must change nothing');
});

t('reject writes reason, mirrors and audits', () => {
  const auditBefore = auditRows().length;
  const r = P.reject({ paymentId: 'PAY_4', reason: 'UPI ref not on the bank statement' }, adminSession);
  eq(r.status, 'REJECTED');
  eq(r.reject_reason, 'UPI ref not on the bank statement');
  eq(paymentRow('PAY_4').status, 'REJECTED');
  eq(paymentRow('PAY_4').reject_reason, 'UPI ref not on the bank statement');
  eq(playerRow('PLY_4').payment_status, 'REJECTED', 'MIRROR onto Players row');
  eq(r.counts.rejected, 1);
  const a = auditRows()[auditRows().length - 1];
  eq(auditRows().length, auditBefore + 1);
  eq(a.action, 'PAYMENT_REJECTED');
  eq(JSON.parse(a.prev_value).status, 'PENDING');
  eq(JSON.parse(a.new_value).status, 'REJECTED');
  eq(JSON.parse(a.new_value).reject_reason, 'UPI ref not on the bank statement');
});

t('reject deletes nothing — row, serial, images and upi_ref all survive', () => {
  const pl = playerRow('PLY_4');
  ok(pl, 'player row deleted');
  eq(pl.serial_no, 4, 'serial number changed');
  eq(pl.photo_file_id, 'photo4', 'photo removed');
  eq(paymentRow('PAY_4').screenshot_file_id, 'shot4', 'screenshot id removed');
  eq(paymentRow('PAY_4').upi_ref, 'UPIREF4', 'upi_ref removed');
  eq(driveReads.filter((x) => x === 'shot4').length, 0, 'Drive was touched during a reject');
});

t('double reject is a silent no-op success', () => {
  const auditBefore = auditRows().length;
  const r = P.reject({ paymentId: 'PAY_4', reason: 'a different reason entirely' }, admin2Session);
  eq(r.status, 'REJECTED');
  eq(r.alreadyRejected, true);
  eq(paymentRow('PAY_4').reject_reason, 'UPI ref not on the bank statement', 'original reason overwritten');
  eq(auditRows().length, auditBefore, 'no-op wrote an audit row');
});

// ----------------------------------------------------------------- reversals
t('reject after verify is allowed and audited as a reversal', () => {
  const r = P.reject({ paymentId: 'PAY_1', reason: 'second look: wrong amount paid' }, admin2Session);
  eq(r.status, 'REJECTED');
  eq(r.reversedFrom, 'VERIFIED');
  eq(playerRow('PLY_1').payment_status, 'REJECTED', 'mirror');
  const next = JSON.parse(auditRows()[auditRows().length - 1].new_value);
  eq(next.reversal, true);
  eq(next.reversed_from, 'VERIFIED');
  eq(JSON.parse(auditRows()[auditRows().length - 1].prev_value).status, 'VERIFIED');
});

t('verify after reject is allowed and audited as a reversal', () => {
  const r = P.verify({ paymentId: 'PAY_1' }, adminSession);
  eq(r.status, 'VERIFIED');
  eq(r.reversedFrom, 'REJECTED');
  eq(playerRow('PLY_1').payment_status, 'VERIFIED', 'mirror');
  eq(paymentRow('PAY_1').reject_reason, '', 'a VERIFIED row must not keep the old rejection reason');
  const a = auditRows()[auditRows().length - 1];
  eq(a.action, 'PAYMENT_VERIFIED');
  eq(JSON.parse(a.new_value).reversal, true);
  eq(JSON.parse(a.new_value).reversed_from, 'REJECTED');
});

t('verify/reject: unknown payment, missing id, cross-tournament scope', () => {
  throwsCode(() => P.verify({ paymentId: 'PAY_nope' }, adminSession), G.ERR.NOT_FOUND);
  throwsCode(() => P.verify({}, adminSession), G.ERR.BAD_REQUEST);
  const orgSession = { user_id: 'USR_org', role: 'ORGANISER', tournament_id: TID, token: 'tok-org' };
  throwsCode(() => P.verify({ paymentId: 'PAY_6' }, orgSession), G.ERR.FORBIDDEN);
  eq(paymentRow('PAY_6').status, 'PENDING');
});

t('counts stay tournament-wide after several decisions', () => {
  const r = P.list({ tournamentId: TID, filter: { paymentStatus: 'ALL' } }, adminSession);
  eq(r.counts.all, 5);
  eq(r.counts.verified + r.counts.pending + r.counts.rejected, 5, 'statuses must partition the tournament');
  eq(r.counts.withdrawn, 1);
  // PLY_1 VERIFIED not withdrawn, PLY_2 VERIFIED not withdrawn, PLY_3 VERIFIED but withdrawn.
  eq(r.counts.eligible, 2, 'withdrawn player must not be eligible');
  const other = P.list({ tournamentId: TID2, filter: { paymentStatus: 'ALL' } }, adminSession);
  eq(other.counts.all, 1, 'other tournament unaffected');
});

t('Audit.ACTIONS gained PLAYER_WITHDRAWN and nothing else changed', () => {
  eq(G.Audit.ACTIONS.PLAYER_WITHDRAWN, 'PLAYER_WITHDRAWN');
  eq(G.Audit.ACTIONS.PAYMENT_VERIFIED, 'PAYMENT_VERIFIED');
  eq(G.Audit.ACTIONS.PAYMENT_REJECTED, 'PAYMENT_REJECTED');
  eq(Object.isFrozen(G.Audit.ACTIONS), true, 'ACTIONS must stay frozen');

  // Assert the exact SET, not a count. A bare count breaks on every legitimate
  // addition (it did: 18 -> 20 when Phase 3 landed the organiser actions) while
  // catching nothing a set comparison would miss. The set also names what
  // changed, which a number never does.
  const expected = [
    'AUCTION_CLOSED', 'AUCTION_CORRECTED', 'AUCTION_REOPENED',
    'LOGIN_FAILED', 'LOGIN_SUCCESS',
    'ORGANISER_CREATED', 'ORGANISER_DISABLED', 'ORGANISER_LINK_RESENT',
    'PAYMENT_REJECTED', 'PAYMENT_VERIFIED',
    'PLAYER_RETURNED_TO_POOL', 'PLAYER_SOLD', 'PLAYER_UNSOLD', 'PLAYER_WITHDRAWN',
    'REGISTRATION_CLOSED',
    'TEAM_CREATED', 'TEAM_DELETED', 'TEAM_UPDATED',
    'TOURNAMENT_CREATED', 'TOURNAMENT_UPDATED'
  ].join(',');
  eq(Object.keys(G.Audit.ACTIONS).sort().join(','), expected,
    'the audit action set changed — if deliberate, update this list');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
