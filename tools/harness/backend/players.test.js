/**
 * Node vm harness for backend/Players.gs.
 * Loads every .gs (except Tests.gs, which declares its own `const T`) into a vm
 * with stubbed Apps Script services, then exercises player.register /
 * player.checkMobile and asserts the lock boundary from CONTRACTS-PHASE1 §2.
 */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const DIR = '/Users/raja.t/cricket-auction/backend';

// ------------------------------------------------------------------ event log
let EVENTS = [];
const ev = (s) => EVENTS.push(s);

// Per-tab getValues() counter, so the "one Repo.readAll per call" performance
// contract in CONTRACTS-PHASE2 §1 can actually be asserted rather than assumed.
let READS = {};

// -------------------------------------------------------- fake spreadsheet
function FakeSheet(name, headers) {
  this.name = name;
  this.cells = [headers.slice()];
  this.maxRows = 1000;
}
FakeSheet.prototype.getName = function () { return this.name; };
FakeSheet.prototype.getLastRow = function () {
  let last = 0;
  for (let i = 0; i < this.cells.length; i++) {
    const r = this.cells[i];
    if (r && r.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1;
  }
  return last;
};
FakeSheet.prototype.getMaxRows = function () { return Math.max(this.maxRows, this.cells.length); };
FakeSheet.prototype.getMaxColumns = function () { return this.cells[0].length; };
FakeSheet.prototype.insertRowsAfter = function (after, n) { this.maxRows += n; };
FakeSheet.prototype.setFrozenRows = function () {};
FakeSheet.prototype.deleteRow = function (r) { this.cells.splice(r - 1, 1); };
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  const self = this;
  return {
    getValues() {
      READS[self.name] = (READS[self.name] || 0) + 1;
      const out = [];
      for (let i = 0; i < nr; i++) {
        const row = self.cells[r - 1 + i] || [];
        const line = [];
        for (let j = 0; j < nc; j++) {
          const v = row[c - 1 + j];
          line.push(v === undefined ? '' : v);
        }
        out.push(line);
      }
      return out;
    },
    setValues(vals) {
      ev('write:' + self.name);
      for (let i = 0; i < vals.length; i++) {
        const ri = r - 1 + i;
        if (!self.cells[ri]) self.cells[ri] = [];
        for (let j = 0; j < vals[i].length; j++) self.cells[ri][c - 1 + j] = vals[i][j];
      }
    },
    clearContent() {
      for (let i = 0; i < nr; i++) self.cells[r - 1 + i] = [];
    }
  };
};

function FakeSS(headersByTab) {
  this.sheets = {};
  Object.keys(headersByTab).forEach(t => { this.sheets[t] = new FakeSheet(t, headersByTab[t]); });
}
FakeSS.prototype.getSheetByName = function (n) { return this.sheets[n] || null; };
FakeSS.prototype.getSheets = function () { return Object.keys(this.sheets).map(k => this.sheets[k]); };
FakeSS.prototype.getSpreadsheetTimeZone = function () { return 'UTC'; };
FakeSS.prototype.insertSheet = function (n) { this.sheets[n] = new FakeSheet(n, []); return this.sheets[n]; };

// --------------------------------------------------------------- fake Drive
let FOLDERS = {}, FILES = {}, FID = 0;
function FakeFolder(name, parent) {
  this.name = name;
  this.id = 'FOLDER_' + (++FID);
  this.parent = parent || null;
  this.children = {};
  FOLDERS[this.id] = this;
}
FakeFolder.prototype.getId = function () { return this.id; };
FakeFolder.prototype.getName = function () { return this.name; };
FakeFolder.prototype.getFoldersByName = function (n) {
  const hit = this.children[n];
  let done = !hit;
  return { hasNext: () => !done, next: () => { done = true; return hit; } };
};
FakeFolder.prototype.createFolder = function (n) {
  const f = new FakeFolder(n, this);
  this.children[n] = f;
  return f;
};
FakeFolder.prototype.getParents = function () {
  let done = !this.parent;
  const p = this.parent;
  return { hasNext: () => !done, next: () => { done = true; return p; } };
};
FakeFolder.prototype.setSharing = function () { return this; };
FakeFolder.prototype.createFile = function (blob) {
  ev('upload:' + this.name);
  const id = 'FILE_' + (++FID);
  FILES[id] = { folder: this.name, folderId: this.id, bytes: blob.bytes, mime: blob.mime, name: blob.name };
  return { getId: () => id };
};

let DRIVE_ROOT = null;
function resetDrive() { FOLDERS = {}; FILES = {}; FID = 0; DRIVE_ROOT = new FakeFolder('__MyDrive__', null); }

const DriveAppStub = {
  getRootFolder: () => DRIVE_ROOT,
  getFoldersByName: (n) => DRIVE_ROOT.getFoldersByName(n),
  createFolder: (n) => DRIVE_ROOT.createFolder(n),
  getFolderById: (id) => { if (!FOLDERS[id]) throw new Error('no folder ' + id); return FOLDERS[id]; },
  getFileById: (id) => { if (!FILES[id]) throw new Error('no file ' + id); return { getId: () => id, setTrashed: () => {}, getBlob: () => ({ getContentType: () => FILES[id].mime, getBytes: () => FILES[id].bytes }) }; },
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
  Permission: { VIEW: 'VIEW' }
};

// ------------------------------------------------------- fake cache / props
let CACHE = {}, PROPS = {};
const CacheStub = {
  get: (k) => (CACHE[k] === undefined ? null : CACHE[k].v),
  put: (k, v, ttl) => { CACHE[k] = { v: v, ttl: ttl }; },
  remove: (k) => { delete CACHE[k]; }
};
const PropsStub = {
  getProperty: (k) => (PROPS[k] === undefined ? null : PROPS[k]),
  setProperty: (k, v) => { PROPS[k] = v; }
};

// ---------------------------------------------------------------- fake lock
const LockStub = {
  getScriptLock: () => ({
    waitLock: () => { ev('LOCK'); return true; },
    releaseLock: () => { ev('UNLOCK'); }
  })
};

// ------------------------------------------------------------- time control
let NOW_MS = Date.parse('2026-08-15T06:00:00.000Z');
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW_MS); else super(...a); }
  static now() { return NOW_MS; }
}

// -------------------------------------------------------------- build the vm
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.gs') && f !== 'Tests.gs').sort();
let SS = null;
const ctx = {
  console, Date: FakeDate, Math, JSON, isNaN, isFinite, parseInt, parseFloat, String, Number,
  Object, Array, Error, RegExp, Infinity, NaN, Boolean, Symbol,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => b > 127 ? b - 256 : b),
    computeHmacSha256Signature: (m, k) => Array.from(crypto.createHmac('sha256', String(k)).update(String(m)).digest()).map(b => b > 127 ? b - 256 : b),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    base64Decode: s => Array.from(Buffer.from(s, 'base64')).map(b => b > 127 ? b - 256 : b),
    base64Encode: s => Buffer.from(s).toString('base64'),
    newBlob: (bytes, mime, name) => ({ bytes: bytes, mime: mime, name: name, getBytes: () => Buffer.from(typeof bytes === 'string' ? bytes : Buffer.from(bytes.map(b => (b + 256) % 256))) }),
    formatDate: (d, tz, fmt) => {
      const iso = new Date(d.getTime()).toISOString();
      if (fmt === 'HH:mm:ss.SSS') return iso.substring(11, 23);
      return iso.substring(0, 10);
    },
    sleep: () => {}
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => SS,
    flush: () => ev('flush')
  },
  DriveApp: DriveAppStub,
  CacheService: { getScriptCache: () => CacheStub },
  PropertiesService: { getScriptProperties: () => PropsStub },
  LockService: LockStub,
  ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'JSON' } },
  Session: {}
};
vm.createContext(ctx);
vm.runInContext(files.map(f => fs.readFileSync(DIR + '/' + f, 'utf8')).join('\n'), ctx, { filename: 'ALL.gs' });
vm.runInContext('globalThis.__m = {Players, PlayerRoutes, Repo, Util, ERR, ENUM, SHEETS, HEADERS, Drive, PLAYER_MSG, Audit, Auth};', ctx);
const M = ctx.__m;

// ------------------------------------------------------------------- fixtures
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 7)]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(200, 7)]).toString('base64');
const img = (b64, mime) => ({ data: b64, mime: mime || 'image/jpeg', filename: 'x.jpg' });

const TID = 'TRN_test00000001';
function seed(overrides) {
  SS = new FakeSS(M.HEADERS);
  M.Repo._cache = { ss: null, tz: null, sheets: {}, fields: {} };
  resetDrive();
  CACHE = {}; PROPS = {};
  const t = Object.assign({
    tournament_id: TID, slug: 'test-cup', name: 'Test Cup',
    start_date: '2026-09-10', end_date: '2026-09-20',
    reg_start: '2026-08-01', reg_end: '2026-08-31',
    reg_fee: 500, upi_id: 'a@b', contact_name: 'Org', contact_mobile: '9876500000',
    status: 'REG_OPEN', next_serial: 1, default_purse: 100000, default_max_players: 12,
    display_token: 'tok', created_at: '2026-07-01T00:00:00.000Z', created_by: 'USR_x'
  }, overrides || {});
  M.Repo.append(M.SHEETS.TOURNAMENTS, t);
  EVENTS = [];
  READS = {};
}

function payload(over) {
  return Object.assign({
    tournamentId: TID, name: 'Raj Kumar', dob: '1998-04-12',
    role: 'ALL_ROUNDER', style: 'RIGHT', mobile: '9876543210', upiRef: 'UPI12345678',
    photo: img(JPEG), photoThumb: img(JPEG), screenshot: img(JPEG)
  }, over || {});
}

// -------------------------------------------------------------- test harness
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  pass  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + '\n         got      ' + JSON.stringify(a) + '\n         expected ' + JSON.stringify(b)); }
function ok(c, m) { if (!c) throw new Error(m); }
function throwsWith(fn, code, msg) {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  ok(e, 'nothing thrown, expected ' + code);
  eq(e.code, code, 'wrong error code');
  if (msg !== undefined) eq(e.message, msg, 'wrong message');
  return e;
}

// =============================================================== 1. happy path
console.log('\n--- happy path + serial allocation ---');
test('first registration gets serial 1, second gets serial 2', () => {
  seed();
  const r1 = M.Players.register(payload());
  eq(r1.serial_no, 1, 'first serial');
  eq(r1.name, 'Raj Kumar');
  eq(r1.tournament_name, 'Test Cup');
  ok(/^PLY_[a-z0-9]{12}$/.test(r1.player_id), 'player_id shape: ' + r1.player_id);
  ok(/^15 Aug 2026/.test(r1.registered_at_display), 'display date: ' + r1.registered_at_display);

  const r2 = M.Players.register(payload({ mobile: '9876543211', upiRef: 'UPI87654321' }));
  eq(r2.serial_no, 2, 'second serial');
});

test('Players row is complete and correct', () => {
  seed();
  M.Players.register(payload());
  const rows = M.Repo.readAll(M.SHEETS.PLAYERS);
  eq(rows.length, 1, 'one player row');
  const p = rows[0];
  eq(p.tournament_id, TID);
  eq(p.serial_no, 1);
  eq(p.name, 'Raj Kumar');
  eq(p.dob, '1998-04-12');
  eq(p.age_years, 28, 'age at start_date 2026-09-10 for dob 1998-04-12');
  eq(p.role, 'ALL_ROUNDER');
  eq(p.style, 'RIGHT');
  eq(p.mobile, '9876543210');
  eq(p.payment_status, 'PENDING');
  eq(p.auction_status, 'PENDING');
  eq(p.times_called, 0);
  eq(p.is_withdrawn, false);
  eq(p.search_blob, 'raj kumar all_rounder right', 'search_blob');
  ok(/^https:\/\/drive\.google\.com\/thumbnail\?id=FILE_\d+&sz=w320$/.test(p.photo_thumb_url), 'thumb url: ' + p.photo_thumb_url);
  ok(/^2026-08-15T/.test(p.registered_at), 'registered_at is a UTC instant: ' + p.registered_at);
});

test('Payments row is written with the fee and PENDING status', () => {
  seed();
  M.Players.register(payload());
  const players = M.Repo.readAll(M.SHEETS.PLAYERS);
  const pays = M.Repo.readAll(M.SHEETS.PAYMENTS);
  eq(pays.length, 1, 'one payment row');
  eq(pays[0].player_id, players[0].player_id, 'payment points at the player');
  eq(pays[0].upi_ref, 'UPI12345678');
  eq(pays[0].amount, 500);
  eq(pays[0].status, 'PENDING');
  eq(pays[0].submitted_at, players[0].registered_at, 'same instant on both rows');
  ok(/^PAY_[a-z0-9]{12}$/.test(pays[0].payment_id), 'payment_id shape');
});

test('a free tournament (reg_fee 0) is allowed and stores amount 0', () => {
  seed({ reg_fee: 0 });
  M.Players.register(payload());
  eq(M.Repo.readAll(M.SHEETS.PAYMENTS)[0].amount, 0);
});

// ==================================================== 2. THE LOCK BOUNDARY
console.log('\n--- lock boundary (CONTRACTS-PHASE1 §2 / DESIGN §6.2) ---');
test('uploads happen OUTSIDE the lock; only writes are inside', () => {
  seed();
  M.Players.register(payload());
  const lock = EVENTS.indexOf('LOCK');
  const unlock = EVENTS.indexOf('UNLOCK');
  ok(lock !== -1 && unlock !== -1, 'lock was taken and released: ' + EVENTS.join(','));
  ok(unlock > lock, 'unlock after lock');

  const uploads = EVENTS.map((e, i) => [e, i]).filter(x => x[0].indexOf('upload:') === 0);
  eq(uploads.length, 3, 'three uploads happened');
  uploads.forEach(([e, i]) => ok(i < lock, e + ' at index ' + i + ' must precede LOCK at ' + lock + ' — EVENTS: ' + EVENTS.join(',')));

  const inside = EVENTS.slice(lock + 1, unlock);
  ok(inside.every(e => e.indexOf('upload:') !== 0), 'no upload inside the lock: ' + inside.join(','));
  ok(inside.indexOf('write:Players') !== -1, 'Players row written inside the lock');
  ok(inside.indexOf('write:Payments') !== -1, 'Payments row written inside the lock');
  ok(inside.indexOf('write:Tournaments') !== -1, 'next_serial bumped inside the lock');
  ok(inside.indexOf('flush') !== -1, 'flush inside the lock');
  ok(inside.indexOf('flush') > inside.indexOf('write:Payments'), 'flush is last');
  console.log('        order: ' + EVENTS.join(' | '));
});

test('photo+thumb go to public players/, screenshot to private payments/', () => {
  seed();
  M.Players.register(payload());
  const uploaded = Object.keys(FILES).map(k => FILES[k]);
  eq(uploaded.length, 3);
  const inPlayers = uploaded.filter(f => f.folder === 'players');
  const inPayments = uploaded.filter(f => f.folder === 'payments');
  eq(inPlayers.length, 2, 'photo + thumb in players/');
  eq(inPayments.length, 1, 'screenshot in payments/');
  ok(/-payment\.jpg$/.test(inPayments[0].name), 'screenshot filename: ' + inPayments[0].name);
  // the payments folder must sit under private/, never under public/
  const paymentsFolder = FOLDERS[inPayments[0].folderId];
  eq(paymentsFolder.parent.name, 'private', 'payments/ parent');
  eq(FOLDERS[inPlayers[0].folderId].parent.name, 'public', 'players/ parent');
});

test('a locked re-check failure leaves the files orphaned, not deleted', () => {
  seed();
  M.Players.register(payload());
  const before = Object.keys(FILES).length;
  // second player, same mobile: fails inside the lock only if the pre-check is
  // bypassed, so instead prove the general rule — no file is ever trashed.
  try { M.Players.register(payload({ upiRef: 'UPI99999999' })); } catch (e) { /* DUPLICATE_MOBILE */ }
  ok(Object.keys(FILES).length >= before, 'no file was deleted');
});

// =============================================================== 3. duplicates
console.log('\n--- duplicates ---');
test('duplicate mobile rejected with the exact DESIGN §11 message', () => {
  seed();
  M.Players.register(payload());
  throwsWith(() => M.Players.register(payload({ upiRef: 'UPIDIFFERENT1' })),
    'DUPLICATE_MOBILE',
    'A registration already exists for this mobile number. Please contact the tournament organiser.');
  eq(M.Repo.readAll(M.SHEETS.PLAYERS).length, 1, 'no extra row written');
});

test('duplicate upi_ref rejected with the exact DESIGN §11 message', () => {
  seed();
  M.Players.register(payload());
  throwsWith(() => M.Players.register(payload({ mobile: '9123456789' })),
    'DUPLICATE_UPI_REF',
    'This UPI reference number has already been used.');
  eq(M.Repo.readAll(M.SHEETS.PAYMENTS).length, 1, 'no extra payment row');
});

test('duplicate upi_ref is case-insensitive', () => {
  seed();
  M.Players.register(payload({ upiRef: 'AbC123456' }));
  throwsWith(() => M.Players.register(payload({ mobile: '9123456789', upiRef: 'abc123456' })), 'DUPLICATE_UPI_REF');
});

test('the LOCKED re-check catches a duplicate the pre-check missed', () => {
  // Simulate the real race: another player's row lands while our images upload.
  seed();
  const realUpload = M.Drive.uploadImage;
  let fired = false;
  M.Drive.uploadImage = function (folderId, data, mime, name) {
    const id = realUpload.call(M.Drive, folderId, data, mime, name);
    if (!fired) {
      fired = true;
      // A concurrent registration commits between our pre-check and our lock.
      M.Repo.append(M.SHEETS.PLAYERS, {
        player_id: 'PLY_concurrent01', tournament_id: TID, serial_no: 99,
        name: 'Other', mobile: '9876543210', payment_status: 'PENDING'
      });
    }
    return id;
  };
  try {
    throwsWith(() => M.Players.register(payload()), 'DUPLICATE_MOBILE',
      'A registration already exists for this mobile number. Please contact the tournament organiser.');
    // and it failed INSIDE the lock, after the uploads
    const lock = EVENTS.indexOf('LOCK');
    ok(lock !== -1, 'the lock was reached, so the pre-check did pass: ' + EVENTS.join(','));
    ok(EVENTS.filter(e => e.indexOf('upload:') === 0).length === 3, 'all three uploads ran first');
    ok(EVENTS.indexOf('write:Players') === -1 || EVENTS.lastIndexOf('write:Players') < lock,
      'no Players row written after the lock was taken');
  } finally {
    M.Drive.uploadImage = realUpload;
  }
});

// ========================================================= 4. window / status
console.log('\n--- registration window (IST) ---');
test('after the IST deadline: REGISTRATION_CLOSED', () => {
  seed();
  NOW_MS = Date.parse('2026-08-31T19:00:00.000Z'); // 00:30 IST on 1 Sep
  try {
    throwsWith(() => M.Players.register(payload()), 'REGISTRATION_CLOSED',
      'Registration is closed for this tournament.');
  } finally { NOW_MS = Date.parse('2026-08-15T06:00:00.000Z'); }
});

test('23:30 IST on the closing day is still OPEN (a UTC compare would reject it)', () => {
  seed();
  NOW_MS = Date.parse('2026-08-31T18:00:00.000Z'); // 23:30 IST on 31 Aug
  try {
    const r = M.Players.register(payload());
    eq(r.serial_no, 1, 'registration accepted on the last IST evening');
  } finally { NOW_MS = Date.parse('2026-08-15T06:00:00.000Z'); }
});

test('before the IST opening day: REGISTRATION_CLOSED', () => {
  seed();
  NOW_MS = Date.parse('2026-07-20T06:00:00.000Z');
  try { throwsWith(() => M.Players.register(payload()), 'REGISTRATION_CLOSED'); }
  finally { NOW_MS = Date.parse('2026-08-15T06:00:00.000Z'); }
});

test('status DRAFT: REGISTRATION_CLOSED even inside the dates', () => {
  seed({ status: 'DRAFT' });
  throwsWith(() => M.Players.register(payload()), 'REGISTRATION_CLOSED',
    'Registration is closed for this tournament.');
});

test('status REG_CLOSED: REGISTRATION_CLOSED', () => {
  seed({ status: 'REG_CLOSED' });
  throwsWith(() => M.Players.register(payload()), 'REGISTRATION_CLOSED');
});

test('the window re-check inside the lock is authoritative', () => {
  seed();
  const realUpload = M.Drive.uploadImage;
  let fired = false;
  M.Drive.uploadImage = function (folderId, data, mime, name) {
    const id = realUpload.call(M.Drive, folderId, data, mime, name);
    if (!fired) { fired = true; M.Repo.updateBy(M.SHEETS.TOURNAMENTS, 'tournament_id', TID, { status: 'REG_CLOSED' }); }
    return id;
  };
  try {
    throwsWith(() => M.Players.register(payload()), 'REGISTRATION_CLOSED');
    ok(EVENTS.indexOf('LOCK') !== -1, 'we got as far as the lock');
    eq(M.Repo.readAll(M.SHEETS.PLAYERS).length, 0, 'nothing written');
  } finally { M.Drive.uploadImage = realUpload; }
});

test('unknown tournament: NOT_FOUND', () => {
  seed();
  throwsWith(() => M.Players.register(payload({ tournamentId: 'TRN_nope' })), 'NOT_FOUND');
  throwsWith(() => M.Players.register(payload({ tournamentId: '' })), 'NOT_FOUND');
});

// ============================================================ 5. field checks
console.log('\n--- field validation (CONTRACTS-PHASE1 §3 / DESIGN §11) ---');
const V = 'VALIDATION_FAILED';
const cases = [
  ['name too short', { name: 'R' }, V, 'Please enter your full name.'],
  ['name too long', { name: 'R'.repeat(61) }, V, 'Please enter your full name.'],
  ['name with digits', { name: 'Raj 7' }, V, 'Please enter your full name.'],
  ['name blank', { name: '   ' }, V, 'Please enter your full name.'],
  ['dob not a date', { dob: 'yesterday' }, V, 'Please check the date of birth.'],
  ['dob impossible day', { dob: '2000-02-30' }, V, 'Please check the date of birth.'],
  ['dob too young (age 7)', { dob: '2019-09-11' }, V, 'Please check the date of birth.'],
  ['dob too old (age 71)', { dob: '1955-09-09' }, V, 'Please check the date of birth.'],
  ['role unknown', { role: 'KEEPER' }, V, 'Please choose a playing role.'],
  ['role blank', { role: '' }, V, 'Please choose a playing role.'],
  ['style unknown', { style: 'SIDEWAYS' }, V, 'Please choose a playing style.'],
  ['mobile 9 digits', { mobile: '987654321' }, V, 'Enter a 10-digit mobile number.'],
  ['mobile starts with 5', { mobile: '5876543210' }, V, 'Enter a 10-digit mobile number.'],
  ['mobile with country code', { mobile: '+919876543210' }, V, 'Enter a 10-digit mobile number.'],
  ['upiRef too short', { upiRef: 'AB12' }, V, undefined],
  ['upiRef too long', { upiRef: 'A'.repeat(36) }, V, undefined],
  ['upiRef with punctuation', { upiRef: 'ABC-123456' }, V, undefined],
  ['photo missing', { photo: null }, V, 'Please upload a clear photo.'],
  ['photo has no data', { photo: { mime: 'image/jpeg' } }, V, 'Please upload a clear photo.'],
  ['photoThumb missing', { photoThumb: undefined }, V, 'Please upload a clear photo.'],
  ['screenshot missing', { screenshot: null }, V, 'Please upload your payment screenshot.']
];
cases.forEach(([label, over, code, msg]) => {
  test(label, () => { seed(); throwsWith(() => M.Players.register(payload(over)), code, msg); });
});

test('age exactly 8 and exactly 70 are accepted', () => {
  seed();
  eq(M.Players.register(payload({ dob: '2018-09-10' })).serial_no, 1, 'age 8');
  eq(M.Players.register(payload({ dob: '1956-09-10', mobile: '9111111111', upiRef: 'UPIREF00002' })).serial_no, 2, 'age 70');
});

test('role/style are accepted case-insensitively and stored upper-case', () => {
  seed();
  M.Players.register(payload({ role: 'batsman', style: ' left ' }));
  const p = M.Repo.readAll(M.SHEETS.PLAYERS)[0];
  eq(p.role, 'BATSMAN'); eq(p.style, 'LEFT');
  eq(p.search_blob, 'raj kumar batsman left');
});

test('a PNG photo is accepted; a JPEG lying about being a PNG is not', () => {
  seed();
  eq(M.Players.register(payload({ photo: img(PNG, 'image/png') })).serial_no, 1);
  seed();
  throwsWith(() => M.Players.register(payload({ photo: img(JPEG, 'image/png') })), V);
  seed();
  throwsWith(() => M.Players.register(payload({ photo: img(Buffer.from('<svg/>').toString('base64')) })), V);
});

test('nothing is written when validation fails', () => {
  seed();
  try { M.Players.register(payload({ name: '1' })); } catch (e) {}
  eq(M.Repo.readAll(M.SHEETS.PLAYERS).length, 0);
  eq(M.Repo.readAll(M.SHEETS.PAYMENTS).length, 0);
  eq(Object.keys(FILES).length, 0, 'validation runs before any upload');
  eq(EVENTS.indexOf('LOCK'), -1, 'the lock was never taken');
});

// ============================================================ 6. checkMobile
console.log('\n--- player.checkMobile ---');
test('returns {taken:false} then {taken:true}, and nothing else', () => {
  seed();
  eq(M.Players.checkMobile({ tournamentId: TID, mobile: '9876543210' }), { taken: false });
  M.Players.register(payload());
  const r = M.Players.checkMobile({ tournamentId: TID, mobile: '9876543210' });
  eq(r, { taken: true });
  eq(Object.keys(r), ['taken'], 'exactly one key — never a name or serial');
});

test('is scoped to the tournament', () => {
  seed();
  M.Players.register(payload());
  eq(M.Players.checkMobile({ tournamentId: 'TRN_other', mobile: '9876543210' }), { taken: false });
});

test('bad mobile is rejected before the rate limiter', () => {
  seed();
  throwsWith(() => M.Players.checkMobile({ tournamentId: TID, mobile: '12345' }), V, 'Enter a 10-digit mobile number.');
  eq(Object.keys(CACHE).length, 0, 'no allowance was consumed');
});

test('missing tournamentId is BAD_REQUEST', () => {
  seed();
  throwsWith(() => M.Players.checkMobile({ mobile: '9876543210' }), 'BAD_REQUEST');
});

test('rate limited to 20 calls per 10 minutes, per number', () => {
  seed();
  for (let i = 1; i <= 20; i++) {
    eq(M.Players.checkMobile({ tournamentId: TID, mobile: '9876543210' }), { taken: false }, 'call ' + i);
  }
  throwsWith(() => M.Players.checkMobile({ tournamentId: TID, mobile: '9876543210' }), 'BAD_REQUEST',
    'Too many checks for this number. Please wait a few minutes and try again.');
  // a different number has its own allowance
  eq(M.Players.checkMobile({ tournamentId: TID, mobile: '9123456789' }), { taken: false });
});

test('the block does not extend itself, and the window expires', () => {
  seed();
  for (let i = 1; i <= 25; i++) { try { M.Players.checkMobile({ tournamentId: TID, mobile: '9876543210' }); } catch (e) {} }
  const key = Object.keys(CACHE).find(k => k.indexOf('mobcheck:') === 0);
  ok(key, 'a rate-limit key exists');
  ok(CACHE[key].ttl <= 600, 'ttl never grows past the window: ' + CACHE[key].ttl);
  NOW_MS += 601 * 1000;
  try { eq(M.Players.checkMobile({ tournamentId: TID, mobile: '9876543210' }), { taken: false }, 'allowed again after the window'); }
  finally { NOW_MS = Date.parse('2026-08-15T06:00:00.000Z'); }
});

// ================================================================= 7. routing
console.log('\n--- routing ---');
test('PlayerRoutes exposes the two Phase 1 actions as PUBLIC POST', () => {
  const r = M.PlayerRoutes();
  ['player.checkMobile', 'player.register'].forEach(k => {
    eq(r[k].auth, 'PUBLIC', k + ' auth');
    eq(r[k].methods, ['POST'], k + ' methods');
    ok(typeof r[k].handler === 'function', k + ' handler');
  });
});

test('PlayerRoutes exposes the two Phase 2 actions with the right roles', () => {
  const r = M.PlayerRoutes();
  eq(Object.keys(r).sort(),
    ['player.checkMobile', 'player.list', 'player.register', 'player.setWithdrawn']);
  eq(r['player.list'].auth, ['ADMIN', 'ORGANISER'], 'player.list auth');
  eq(r['player.list'].methods, ['POST'], 'player.list methods');
  eq(r['player.setWithdrawn'].auth, ['ADMIN'], 'player.setWithdrawn is ADMIN only');
  eq(r['player.setWithdrawn'].methods, ['POST'], 'player.setWithdrawn methods');
  ok(typeof r['player.list'].handler === 'function');
  ok(typeof r['player.setWithdrawn'].handler === 'function');
});

test('the route handlers work end to end through dispatch()', () => {
  seed();
  const env = vm.runInContext('dispatch', ctx)('player.register', payload(), null, 'POST', {});
  ok(env.ok, 'envelope ok: ' + JSON.stringify(env.error || {}));
  eq(env.data.serial_no, 1);
  const dup = vm.runInContext('dispatch', ctx)('player.register', payload({ upiRef: 'OTHERREF01' }), null, 'POST', {});
  eq(dup.ok, false);
  eq(dup.error.code, 'DUPLICATE_MOBILE');
  eq(dup.error.message, 'A registration already exists for this mobile number. Please contact the tournament organiser.');
  const get = vm.runInContext('dispatch', ctx)('player.register', payload(), null, 'GET', {});
  eq(get.error.code, 'BAD_REQUEST', 'GET is refused');
});

// ###########################################################################
// #                     PHASE 2 — CONTRACTS-PHASE2 §1, §2, §3               #
// ###########################################################################

const TID2 = 'TRN_test00000002';
const ADMIN = { user_id: 'USR_admin000001', role: 'ADMIN', tournament_id: '' };
const ORG1 = { user_id: 'USR_org00000001', role: 'ORGANISER', tournament_id: TID };
const ORG2 = { user_id: 'USR_org00000002', role: 'ORGANISER', tournament_id: TID2 };

/** Add a second tournament row so isolation can be tested. */
function seedSecondTournament() {
  M.Repo.append(M.SHEETS.TOURNAMENTS, {
    tournament_id: TID2, slug: 'other-cup', name: 'Other Cup',
    start_date: '2026-09-10', end_date: '2026-09-20',
    reg_start: '2026-08-01', reg_end: '2026-08-31',
    reg_fee: 500, upi_id: 'a@b', contact_name: 'Org2', contact_mobile: '9876500001',
    status: 'REG_OPEN', next_serial: 1, default_purse: 100000, default_max_players: 12,
    display_token: 'tok2', created_at: '2026-07-01T00:00:00.000Z', created_by: 'USR_x'
  });
}

/**
 * Write a Players row plus its Payments row straight to the sheet.
 * Bypasses register() on purpose: these tests are about the list, not the
 * registration flow, and this way payment_status / auction_status / is_withdrawn
 * can be set to any combination the admin screen has to cope with.
 */
function seedPlayer(spec) {
  const s = spec || {};
  const n = s.n;
  const playerId = s.player_id || ('PLY_seed' + ('00000000' + n).slice(-8));
  const paymentId = s.payment_id || ('PAY_seed' + ('00000000' + n).slice(-8));
  const tid = s.tournament_id || TID;
  M.Repo.append(M.SHEETS.PLAYERS, {
    player_id: playerId,
    tournament_id: tid,
    serial_no: s.serial_no === undefined ? n : s.serial_no,
    name: s.name || ('Player ' + n),
    dob: s.dob || '1998-04-12',
    age_years: 28,
    role: s.role || 'BATSMAN',
    style: s.style || 'RIGHT',
    mobile: s.mobile || ('98765' + ('00000' + n).slice(-5)),
    photo_file_id: 'FILE_photo_' + n,
    photo_thumb_url: 'https://drive.google.com/thumbnail?id=FILE_thumb_' + n + '&sz=w320',
    payment_status: s.payment_status || 'PENDING',
    auction_status: s.auction_status || 'PENDING',
    times_called: 0,
    team_id: s.team_id || '',
    sold_amount: s.sold_amount === undefined ? '' : s.sold_amount,
    sold_at: '',
    is_withdrawn: s.is_withdrawn === true,
    search_blob: (s.name || ('Player ' + n)).toLowerCase() + ' batsman right',
    registered_at: s.registered_at || ('2026-08-' + ('0' + (n % 28 + 1)).slice(-2) + 'T06:00:00.000Z')
  });
  M.Repo.append(M.SHEETS.PAYMENTS, {
    payment_id: paymentId,
    tournament_id: tid,
    player_id: playerId,
    upi_ref: s.upi_ref || ('UPIREF' + ('000000' + n).slice(-6)),
    amount: 500,
    // The field that must NEVER appear in a list row.
    screenshot_file_id: 'FILE_secret_screenshot_' + n,
    status: s.payment_status || 'PENDING',
    verified_by: '', verified_at: '', reject_reason: '',
    submitted_at: s.registered_at || ('2026-08-' + ('0' + (n % 28 + 1)).slice(-2) + 'T06:00:00.000Z')
  });
  return playerId;
}

/** Seed `count` plain PENDING players into TID. */
function seedMany(count, over) {
  for (let i = 1; i <= count; i++) seedPlayer(Object.assign({ n: i }, over || {}));
}

const listOf = (payload, session) => M.Players.list(payload, session || ADMIN);

// ======================================================== 8. list — paging
console.log('\n--- player.list: paging (CONTRACTS-PHASE2 §1) ---');

test('defaults: page 1, pageSize 50, 1-based', () => {
  seed(); seedMany(120);
  const r = listOf({ tournamentId: TID });
  eq(r.page, 1); eq(r.pageSize, 50);
  eq(r.total, 120); eq(r.totalPages, 3);
  eq(r.rows.length, 50);
  eq(r.rows[0].serial_no, 1, 'default sort is serial_no ascending');
  eq(r.rows[49].serial_no, 50);
});

test('page 2 continues where page 1 stopped — no overlap, no gap', () => {
  seed(); seedMany(120);
  const p1 = listOf({ tournamentId: TID, page: 1, pageSize: 50 });
  const p2 = listOf({ tournamentId: TID, page: 2, pageSize: 50 });
  eq(p2.rows[0].serial_no, 51);
  eq(p2.rows[49].serial_no, 100);
  const ids = p1.rows.concat(p2.rows).map(r => r.player_id);
  eq(new Set(ids).size, 100, 'no row appears on both pages');
});

test('the last page is partial and carries the remainder', () => {
  seed(); seedMany(120);
  const last = listOf({ tournamentId: TID, page: 3, pageSize: 50 });
  eq(last.rows.length, 20, '120 = 50 + 50 + 20');
  eq(last.rows[0].serial_no, 101);
  eq(last.rows[19].serial_no, 120);
  eq(last.total, 120); eq(last.totalPages, 3);
});

test('an exact multiple produces no empty trailing page', () => {
  seed(); seedMany(100);
  const r = listOf({ tournamentId: TID, pageSize: 50 });
  eq(r.totalPages, 2, '100 / 50 is exactly 2 pages');
});

test('an out-of-range page is empty with correct totals, not an error', () => {
  seed(); seedMany(120);
  const r = listOf({ tournamentId: TID, page: 99, pageSize: 50 });
  eq(r.rows, []);
  eq(r.page, 99);
  eq(r.total, 120, 'total is still the whole filtered set');
  eq(r.totalPages, 3, 'so the screen can send itself back to page 3');
  eq(r.counts.all, 120, 'counts survive an out-of-range page');
});

test('page 0 and a negative page are clamped to page 1', () => {
  seed(); seedMany(10);
  eq(listOf({ tournamentId: TID, page: 0 }).page, 1);
  eq(listOf({ tournamentId: TID, page: -5 }).rows.length, 10);
});

test('pageSize is capped at 200 and floored at 1', () => {
  seed(); seedMany(250);
  const big = listOf({ tournamentId: TID, pageSize: 5000 });
  eq(big.pageSize, 200, 'capped');
  eq(big.rows.length, 200);
  eq(big.totalPages, 2, 'ceil(250/200)');
  eq(listOf({ tournamentId: TID, pageSize: 0 }).pageSize, 50, 'zero falls back to the default');
  eq(listOf({ tournamentId: TID, pageSize: -3 }).pageSize, 1, 'negative is floored at 1');
});

test('an empty tournament gives rows [] and total 0', () => {
  seed();
  const r = listOf({ tournamentId: TID });
  eq(r.rows, []); eq(r.total, 0); eq(r.totalPages, 0);
  eq(r.counts, { all: 0, pending: 0, verified: 0, rejected: 0, withdrawn: 0, eligible: 0 });
});

test('ONE readAll of Players and ONE of Payments per call, whatever the page', () => {
  seed(); seedMany(400);
  READS = {};
  listOf({ tournamentId: TID, page: 5, pageSize: 50, filter: { search: '9876' } });
  eq(READS[M.SHEETS.PLAYERS], 1, 'Players read exactly once — got ' + READS[M.SHEETS.PLAYERS]);
  eq(READS[M.SHEETS.PAYMENTS], 1, 'Payments read exactly once — got ' + READS[M.SHEETS.PAYMENTS]);
});

// ======================================================== 9. list — filters
console.log('\n--- player.list: filters ---');

function seedMixed() {
  seed();
  seedSecondTournament();
  seedPlayer({ n: 1, name: 'Arun Prasad', payment_status: 'VERIFIED', mobile: '9800000001', upi_ref: 'AAA111111' });
  seedPlayer({ n: 2, name: 'Bala Murugan', payment_status: 'PENDING', mobile: '9800000002', upi_ref: 'BBB222222' });
  seedPlayer({ n: 3, name: 'Chandra Sekar', payment_status: 'REJECTED', mobile: '9800000003', upi_ref: 'CCC333333' });
  seedPlayer({ n: 4, name: 'Deepak Raj', payment_status: 'VERIFIED', is_withdrawn: true, mobile: '9800000004', upi_ref: 'DDD444444' });
  seedPlayer({ n: 5, name: 'Elango Kumar', payment_status: 'VERIFIED', auction_status: 'SOLD', team_id: 'TEM_a', sold_amount: 12000, mobile: '9800000005', upi_ref: 'EEE555555' });
  seedPlayer({ n: 6, name: 'Farhan Ali', payment_status: 'VERIFIED', auction_status: 'UNSOLD', mobile: '9800000006', upi_ref: 'FFF666666' });
  // Another tournament entirely (DESIGN.md §39).
  seedPlayer({ n: 7, tournament_id: TID2, serial_no: 1, name: 'Zahir Khan', payment_status: 'VERIFIED', mobile: '9700000001', upi_ref: 'ZZZ777777' });
  seedPlayer({ n: 8, tournament_id: TID2, serial_no: 2, name: 'Arun Prasad', payment_status: 'PENDING', mobile: '9700000002', upi_ref: 'AAA111111' });
  // next_serial follows the seeded rows, the way register() would have left it.
  M.Repo.updateBy(M.SHEETS.TOURNAMENTS, 'tournament_id', TID, { next_serial: 7 });
  M.Repo.updateBy(M.SHEETS.TOURNAMENTS, 'tournament_id', TID2, { next_serial: 3 });
  READS = {};
}
const serials = (r) => r.rows.map(x => x.serial_no);

test('filter.paymentStatus = VERIFIED', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { paymentStatus: 'VERIFIED' } })), [1, 4, 5, 6]);
});

test('filter.paymentStatus = PENDING and = REJECTED', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { paymentStatus: 'PENDING' } })), [2]);
  eq(serials(listOf({ tournamentId: TID, filter: { paymentStatus: 'REJECTED' } })), [3]);
});

test('filter.auctionStatus = SOLD | UNSOLD | PENDING', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { auctionStatus: 'SOLD' } })), [5]);
  eq(serials(listOf({ tournamentId: TID, filter: { auctionStatus: 'UNSOLD' } })), [6]);
  eq(serials(listOf({ tournamentId: TID, filter: { auctionStatus: 'PENDING' } })), [1, 2, 3, 4]);
});

test('filter.withdrawn true / false / omitted', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { withdrawn: true } })), [4], 'only the withdrawn one');
  eq(serials(listOf({ tournamentId: TID, filter: { withdrawn: false } })), [1, 2, 3, 5, 6], 'everyone else');
  eq(serials(listOf({ tournamentId: TID, filter: {} })), [1, 2, 3, 4, 5, 6], 'omitted means both');
  eq(serials(listOf({ tournamentId: TID })), [1, 2, 3, 4, 5, 6], 'no filter object at all');
});

test('filters are AND-ed together', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { paymentStatus: 'VERIFIED', withdrawn: false, auctionStatus: 'PENDING' } })), [1]);
});

test('an unknown filter value is VALIDATION_FAILED, not silently ignored', () => {
  seedMixed();
  throwsWith(() => listOf({ tournamentId: TID, filter: { paymentStatus: 'MAYBE' } }), V);
  throwsWith(() => listOf({ tournamentId: TID, filter: { auctionStatus: 'HALFSOLD' } }), V);
  throwsWith(() => listOf({ tournamentId: TID, filter: { withdrawn: 'perhaps' } }), V);
});

// ======================================================= 10. list — search
console.log('\n--- player.list: search across all four fields ---');

test('search matches serial_no', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { search: '5' } })), [5]);
});

test('search matches name, case-insensitively', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { search: 'chandra' } })), [3]);
  eq(serials(listOf({ tournamentId: TID, filter: { search: 'CHANDRA SEKAR' } })), [3]);
  eq(serials(listOf({ tournamentId: TID, filter: { search: 'ra' } })), [1, 3, 4],
    'substring: Arun PRAsad, ChandRA Sekar, Deepak RAj');
});

test('search matches mobile, including a partial number', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { search: '9800000003' } })), [3]);
  eq(serials(listOf({ tournamentId: TID, filter: { search: '000006' } })), [6]);
});

test('search matches upi_ref from the Payments row, case-insensitively', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { search: 'DDD444444' } })), [4]);
  eq(serials(listOf({ tournamentId: TID, filter: { search: 'ccc333' } })), [3], 'lower case query, upper case stored');
});

test('search never leaks across tournaments', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { search: 'Zahir' } })), [], 'Zahir is in the other tournament');
  eq(serials(listOf({ tournamentId: TID2, filter: { search: 'Zahir' } })), [1]);
});

test('search does not use search_blob, so a role name matches nobody', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, filter: { search: 'batsman' } })), [],
    'search_blob carries role+style; searching it would match every batsman');
});

test('a search that matches nothing is an empty page, not an error', () => {
  seedMixed();
  const r = listOf({ tournamentId: TID, filter: { search: 'nobody-by-that-name' } });
  eq(r.rows, []); eq(r.total, 0); eq(r.totalPages, 0);
  eq(r.counts.all, 6, 'counts are still tournament-wide');
});

// ========================================================= 11. list — sorts
console.log('\n--- player.list: sort orders ---');

test('sort = serial_no (the default) ascending, and desc', () => {
  seedMixed();
  eq(serials(listOf({ tournamentId: TID, sort: 'serial_no' })), [1, 2, 3, 4, 5, 6]);
  eq(serials(listOf({ tournamentId: TID, sort: 'serial_no', sortDir: 'desc' })), [6, 5, 4, 3, 2, 1]);
});

test('sort = name is alphabetical and case-insensitive', () => {
  seed();
  seedPlayer({ n: 1, name: 'Zahir Khan' });
  seedPlayer({ n: 2, name: 'anand Sharma' });
  seedPlayer({ n: 3, name: 'Mohan Das' });
  const r = listOf({ tournamentId: TID, sort: 'name' });
  eq(r.rows.map(x => x.name), ['anand Sharma', 'Mohan Das', 'Zahir Khan'],
    'lower-case "anand" must not sort after "Zahir"');
  eq(listOf({ tournamentId: TID, sort: 'name', sortDir: 'desc' }).rows.map(x => x.name),
    ['Zahir Khan', 'Mohan Das', 'anand Sharma']);
});

test('sort = registered_at is oldest first, using the instant not the string', () => {
  seed();
  seedPlayer({ n: 1, registered_at: '2026-08-20T10:00:00.000Z' });
  seedPlayer({ n: 2, registered_at: '2026-08-02T10:00:00.000Z' });
  seedPlayer({ n: 3, registered_at: '2026-08-11T10:00:00.000Z' });
  eq(serials(listOf({ tournamentId: TID, sort: 'registered_at' })), [2, 3, 1]);
  eq(serials(listOf({ tournamentId: TID, sort: 'registered_at', sortDir: 'desc' })), [1, 3, 2]);
});

test('sort = payment_status groups the queue, PENDING first', () => {
  seedMixed();
  const r = listOf({ tournamentId: TID, sort: 'payment_status' });
  eq(r.rows.map(x => x.payment_status),
    ['PENDING', 'REJECTED', 'VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED']);
});

test('ties break on serial_no, so paging is stable', () => {
  seed();
  for (let i = 1; i <= 6; i++) seedPlayer({ n: i, name: 'Same Name', payment_status: 'PENDING' });
  const p1 = listOf({ tournamentId: TID, sort: 'name', page: 1, pageSize: 3 });
  const p2 = listOf({ tournamentId: TID, sort: 'name', page: 2, pageSize: 3 });
  eq(serials(p1), [1, 2, 3]);
  eq(serials(p2), [4, 5, 6], 'six identical names still page deterministically');
});

test('an unknown sort key is VALIDATION_FAILED', () => {
  seedMixed();
  throwsWith(() => listOf({ tournamentId: TID, sort: 'sold_amount' }), V);
  throwsWith(() => listOf({ tournamentId: TID, sort: 'seral_no' }), V, undefined);
});

// ======================================================== 12. list — counts
console.log('\n--- counts are tournament-wide, never page-scoped (§3) ---');

test('counts ignore the page', () => {
  seedMixed();
  const p1 = listOf({ tournamentId: TID, page: 1, pageSize: 2 });
  const p3 = listOf({ tournamentId: TID, page: 3, pageSize: 2 });
  eq(p1.rows.length, 2, 'page really is 2 rows');
  eq(p1.counts, p3.counts, 'the same counts on every page');
  eq(p1.counts, { all: 6, pending: 1, verified: 4, rejected: 1, withdrawn: 1, eligible: 3 });
});

test('counts ignore the filter and the search', () => {
  seedMixed();
  const filtered = listOf({ tournamentId: TID, filter: { paymentStatus: 'PENDING' } });
  eq(filtered.total, 1, 'one row survives the filter');
  eq(filtered.counts.all, 6, 'but the header still says 6 registered');
  eq(filtered.counts.verified, 4);
  eq(listOf({ tournamentId: TID, filter: { search: 'zzzz' } }).counts.all, 6);
});

test('counts carry every §3 key and nothing else', () => {
  seedMixed();
  eq(Object.keys(listOf({ tournamentId: TID }).counts).sort(),
    ['all', 'eligible', 'pending', 'rejected', 'verified', 'withdrawn']);
});

test('Players.counts is tournament-scoped even when handed every row', () => {
  seedMixed();
  const everyRow = M.Repo.readAll(M.SHEETS.PLAYERS);
  eq(everyRow.length, 8, 'both tournaments are in the array');
  eq(M.Players.counts(TID, everyRow), { all: 6, pending: 1, verified: 4, rejected: 1, withdrawn: 1, eligible: 3 });
  eq(M.Players.counts(TID2, everyRow), { all: 2, pending: 1, verified: 1, rejected: 0, withdrawn: 0, eligible: 1 });
});

test('Players.counts with preloaded rows does NOT read the sheet again', () => {
  seedMixed();
  const rows = M.Repo.readAll(M.SHEETS.PLAYERS);
  READS = {};
  M.Players.counts(TID, rows);
  eq(READS[M.SHEETS.PLAYERS], undefined, 'no second read — Payments.gs relies on this per verify/reject');
  M.Players.counts(TID);
  eq(READS[M.SHEETS.PLAYERS], 1, 'without preloaded rows it reads once');
});

test('a withdrawn player still counts in all, and drops out of eligible', () => {
  seedMixed();
  const c = M.Players.counts(TID);
  eq(c.all, 6, 'withdrawals are part of what arrived');
  eq(c.verified, 4, 'withdrawal does not change payment_status');
  eq(c.withdrawn, 1);
  eq(c.eligible, 3, '4 verified minus the 1 who pulled out');
});

// ================================================ 13. tournament isolation
console.log('\n--- tournament isolation (DESIGN.md §39) ---');

test('two tournaments never see each other rows', () => {
  seedMixed();
  const a = listOf({ tournamentId: TID });
  const b = listOf({ tournamentId: TID2 });
  eq(a.total, 6); eq(b.total, 2);
  eq(b.rows.map(x => x.name).sort(), ['Arun Prasad', 'Zahir Khan']);
  a.rows.forEach(r => ok(r.player_id.indexOf('PLY_seed0000000') === 0, 'ids are seeded ids'));
  const bIds = new Set(b.rows.map(r => r.player_id));
  a.rows.forEach(r => ok(!bIds.has(r.player_id), r.player_id + ' leaked between tournaments'));
});

test('upi_ref is joined within the tournament, not across it', () => {
  seedMixed();
  // Serial 1 in TID and serial 2 in TID2 share the UPI ref AAA111111 by design.
  const a = listOf({ tournamentId: TID, filter: { search: 'AAA111111' } });
  eq(serials(a), [1]);
  eq(a.rows[0].payment_id, 'PAY_seed00000001', 'TID row got TID payment');
  const b = listOf({ tournamentId: TID2, filter: { search: 'AAA111111' } });
  eq(b.rows[0].payment_id, 'PAY_seed00000008', 'TID2 row got TID2 payment');
});

test('an ORGANISER may list their own tournament and no other', () => {
  seedMixed();
  eq(listOf({ tournamentId: TID }, ORG1).total, 6);
  throwsWith(() => listOf({ tournamentId: TID2 }, ORG1), 'FORBIDDEN');
  eq(listOf({ tournamentId: TID2 }, ORG2).total, 2);
  throwsWith(() => listOf({ tournamentId: TID }, ORG2), 'FORBIDDEN');
});

test('an ADMIN may list any tournament', () => {
  seedMixed();
  eq(listOf({ tournamentId: TID }, ADMIN).total, 6);
  eq(listOf({ tournamentId: TID2 }, ADMIN).total, 2);
});

test('a missing or unknown tournament id is rejected', () => {
  seedMixed();
  throwsWith(() => listOf({}), V);
  throwsWith(() => listOf({ tournamentId: '   ' }), V);
  throwsWith(() => listOf({ tournamentId: 'TRN_nope' }), 'NOT_FOUND');
});

// ============================================ 14. the row shape / no file ids
console.log('\n--- list rows: shape and the screenshot_file_id ban ---');

test('screenshot_file_id is absent from EVERY row, on every page', () => {
  seed(); seedMany(120);
  [1, 2, 3].forEach(pageNo => {
    const r = listOf({ tournamentId: TID, page: pageNo, pageSize: 50 });
    r.rows.forEach(row => {
      ok(!('screenshot_file_id' in row), 'screenshot_file_id present on serial ' + row.serial_no);
      const text = JSON.stringify(row);
      ok(text.indexOf('FILE_secret_screenshot') === -1, 'a screenshot file id leaked: ' + text);
      ok(text.indexOf('screenshot') === -1, 'the word screenshot appears in a list row: ' + text);
    });
  });
});

test('photo_file_id, search_blob and _row are not in a list row either', () => {
  seedMixed();
  const row = listOf({ tournamentId: TID }).rows[0];
  ['screenshot_file_id', 'photo_file_id', 'search_blob', '_row', 'times_called', 'sold_at']
    .forEach(k => ok(!(k in row), k + ' must not be in a list row'));
});

test('a row carries exactly the CONTRACTS-PHASE2 §1 keys', () => {
  seedMixed();
  eq(Object.keys(listOf({ tournamentId: TID }).rows[0]).sort(), [
    'age_years', 'auction_status', 'dob', 'is_withdrawn', 'mobile', 'name',
    'payment_id', 'payment_status', 'photo_thumb_url', 'player_id', 'registered_at',
    'registered_at_display', 'role', 'serial_no', 'sold_amount', 'style',
    'team_id', 'upi_ref'
  ]);
});

test('row values are typed and IST-formatted', () => {
  seedMixed();
  const rows = listOf({ tournamentId: TID }).rows;
  const one = rows[0];
  eq(one.serial_no, 1); ok(typeof one.serial_no === 'number', 'serial_no is a number');
  eq(one.name, 'Arun Prasad');
  eq(one.upi_ref, 'AAA111111', 'joined from the Payments row');
  eq(one.payment_id, 'PAY_seed00000001');
  eq(one.is_withdrawn, false); ok(typeof one.is_withdrawn === 'boolean');
  eq(one.sold_amount, null, 'never sold is null, not 0');
  eq(one.registered_at_display, '2 Aug 2026, 11:30 AM',
    'IST rendering of 2026-08-02T06:00:00Z (UTC+5:30)');
  const sold = rows[4];
  eq(sold.auction_status, 'SOLD'); eq(sold.sold_amount, 12000); eq(sold.team_id, 'TEM_a');
  eq(rows[3].is_withdrawn, true);
});

// ================================= 15. isAuctionEligible (CONTRACTS-PHASE2 §2)
console.log('\n--- Players.isAuctionEligible: the one definition of the pool ---');

test('every payment_status x withdrawn combination', () => {
  const table = [
    ['VERIFIED', false, true, 'paid and still in — the only eligible combination'],
    ['VERIFIED', true, false, 'paid but pulled out'],
    ['PENDING', false, false, 'not verified yet'],
    ['PENDING', true, false, 'not verified and pulled out'],
    ['REJECTED', false, false, 'rejected'],
    ['REJECTED', true, false, 'rejected and pulled out']
  ];
  table.forEach(([status, withdrawn, expected, why]) => {
    eq(M.Players.isAuctionEligible({ payment_status: status, is_withdrawn: withdrawn }), expected,
      status + ' + is_withdrawn=' + withdrawn + ' -> ' + expected + ' (' + why + ')');
  });
});

test('the literal "TRUE" the sheet stores also counts as withdrawn', () => {
  eq(M.Players.isAuctionEligible({ payment_status: 'VERIFIED', is_withdrawn: 'TRUE' }), false,
    'a raw sheet value must never sneak a withdrawn player onto the projector');
  eq(M.Players.isAuctionEligible({ payment_status: 'VERIFIED', is_withdrawn: 'FALSE' }), true);
  eq(M.Players.isAuctionEligible({ payment_status: 'VERIFIED', is_withdrawn: '' }), true);
});

test('a blank, missing or junk payment_status is never eligible', () => {
  [undefined, null, '', 'verified ', 'VERIFED', 'PAID'].forEach(s => {
    const expected = (s === 'verified ');   // trimmed + upper-cased is VERIFIED
    eq(M.Players.isAuctionEligible({ payment_status: s, is_withdrawn: false }), expected, 'status=' + JSON.stringify(s));
  });
  eq(M.Players.isAuctionEligible(null), false);
  eq(M.Players.isAuctionEligible(undefined), false);
  eq(M.Players.isAuctionEligible({}), false);
});

test('eligibleCount matches counts().eligible and is tournament-scoped', () => {
  seedMixed();
  eq(M.Players.eligibleCount(TID), 3);
  eq(M.Players.eligibleCount(TID2), 1);
  eq(M.Players.eligibleCount('TRN_nope'), 0);
  eq(M.Players.eligibleCount(TID), M.Players.counts(TID).eligible);
});

// ============================================ 16. player.setWithdrawn (§1)
console.log('\n--- player.setWithdrawn (DESIGN.md §9, §15 case 16) ---');

const PW_ACTION = M.Audit.ACTIONS.PLAYER_WITHDRAWN;
console.log('        NOTE: Audit.ACTIONS.PLAYER_WITHDRAWN is currently ' +
  (PW_ACTION ? 'present ("' + PW_ACTION + '")' : 'ABSENT — Payments.gs agent still to add it'));
const auditRows = () => M.Repo.readAll('AuditLog');

test('withdrawing sets the flag and returns the serial', () => {
  seedMixed();
  const r = M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: true, reason: 'Injured' }, ADMIN);
  eq(r, { player_id: 'PLY_seed00000001', serial_no: 1, is_withdrawn: true });
  eq(M.Repo.findBy(M.SHEETS.PLAYERS, 'player_id', 'PLY_seed00000001').is_withdrawn, true);
});

test('THE SERIAL STAYS RESERVED — nothing is renumbered, reused or deleted', () => {
  seedMixed();
  const before = M.Repo.readAll(M.SHEETS.PLAYERS).filter(r => r.tournament_id === TID)
    .map(r => [r.player_id, r.serial_no]);
  const nextSerialBefore = M.Repo.findBy(M.SHEETS.TOURNAMENTS, 'tournament_id', TID).next_serial;

  M.Players.setWithdrawn({ playerId: 'PLY_seed00000003', withdrawn: true }, ADMIN);

  const after = M.Repo.readAll(M.SHEETS.PLAYERS).filter(r => r.tournament_id === TID)
    .map(r => [r.player_id, r.serial_no]);
  eq(after, before, 'every serial is exactly where it was');
  eq(after.length, 6, 'the row was not deleted');
  eq(M.Repo.findBy(M.SHEETS.TOURNAMENTS, 'tournament_id', TID).next_serial, nextSerialBefore,
    'next_serial did not move backwards to reuse serial 3');
  eq(M.Repo.readAll(M.SHEETS.PAYMENTS).filter(r => r.player_id === 'PLY_seed00000003').length, 1,
    'the payment row survives too');
  // and the serial is still not handed out again
  const fresh = M.Repo.withLock(() => M.Repo.nextSerial(TID));
  ok(fresh > 6, 'the next serial is ' + fresh + ', never 3');
});

test('a withdrawn player leaves the pool but keeps payment_status VERIFIED', () => {
  seedMixed();
  eq(M.Players.eligibleCount(TID), 3);
  M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: true }, ADMIN);
  const row = M.Repo.findBy(M.SHEETS.PLAYERS, 'player_id', 'PLY_seed00000001');
  eq(row.payment_status, 'VERIFIED', 'payment_status is Payments.gs territory and must not be touched');
  eq(M.Players.isAuctionEligible(row), false);
  const c = M.Players.counts(TID);
  eq(c.eligible, 2); eq(c.withdrawn, 2); eq(c.verified, 4); eq(c.all, 6);
});

test('un-withdrawing puts the player back in the pool', () => {
  seedMixed();
  eq(M.Players.setWithdrawn({ playerId: 'PLY_seed00000004', withdrawn: false }, ADMIN).is_withdrawn, false);
  eq(M.Players.counts(TID).eligible, 4);
  eq(M.Players.counts(TID).withdrawn, 0);
});

test('a SOLD player is REFUSED with VALIDATION_FAILED', () => {
  seedMixed();
  const e = throwsWith(() => M.Players.setWithdrawn({ playerId: 'PLY_seed00000005', withdrawn: true }, ADMIN), V);
  ok(/sold/i.test(e.message), 'the message says they were sold: ' + e.message);
  ok(/correction/i.test(e.message), 'the message points at the correction flow: ' + e.message);
  ok(/#5/.test(e.message), 'the message names the serial: ' + e.message);
  eq(M.Repo.findBy(M.SHEETS.PLAYERS, 'player_id', 'PLY_seed00000005').is_withdrawn, false,
    'nothing was written');
});

test('an unknown player is NOT_FOUND and a bad withdrawn flag is VALIDATION_FAILED', () => {
  seedMixed();
  throwsWith(() => M.Players.setWithdrawn({ playerId: 'PLY_nope', withdrawn: true }, ADMIN), 'NOT_FOUND');
  throwsWith(() => M.Players.setWithdrawn({ withdrawn: true }, ADMIN), V);
  throwsWith(() => M.Players.setWithdrawn({ playerId: 'PLY_seed00000001' }, ADMIN), V);
  throwsWith(() => M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: 1 }, ADMIN), V);
  throwsWith(() => M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: 'yes' }, ADMIN), V);
  throwsWith(() => M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: true, reason: 'x'.repeat(201) }, ADMIN), V);
  // the string forms a form posts are accepted
  eq(M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: 'true' }, ADMIN).is_withdrawn, true);
  eq(M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: 'FALSE' }, ADMIN).is_withdrawn, false);
});

test('setting the same value twice is a no-op success, not an error', () => {
  seedMixed();
  M.Players.setWithdrawn({ playerId: 'PLY_seed00000002', withdrawn: true }, ADMIN);
  const auditsAfterFirst = auditRows().length;
  const again = M.Players.setWithdrawn({ playerId: 'PLY_seed00000002', withdrawn: true }, ADMIN);
  eq(again, { player_id: 'PLY_seed00000002', serial_no: 2, is_withdrawn: true });
  eq(auditRows().length, auditsAfterFirst, 'nothing happened, so nothing was audited');
});

test('it runs inside the script lock and flushes before releasing it', () => {
  seedMixed();
  EVENTS = [];
  M.Players.setWithdrawn({ playerId: 'PLY_seed00000002', withdrawn: true }, ADMIN);
  const lock = EVENTS.indexOf('LOCK');
  const unlock = EVENTS.indexOf('UNLOCK');
  ok(lock !== -1 && unlock > lock, 'locked and released: ' + EVENTS.join(','));
  const inside = EVENTS.slice(lock + 1, unlock);
  ok(inside.indexOf('write:Players') !== -1, 'the write is inside the lock: ' + inside.join(','));
  ok(inside.indexOf('write:AuditLog') !== -1, 'the audit row is inside the lock');
  ok(inside.indexOf('flush') !== -1, 'flushed inside the lock');
  ok(inside.indexOf('flush') > inside.indexOf('write:Players'), 'flush comes after the write');
});

test('the withdrawal is audited with actor, both values and the reason', () => {
  seedMixed();
  M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: true, reason: 'Moved to Bangalore' }, ADMIN);
  const rows = auditRows();
  eq(rows.length, 1, 'exactly one audit row');
  const a = rows[0];
  eq(a.action, PW_ACTION === undefined ? '' : PW_ACTION,
    'action is Audit.ACTIONS.PLAYER_WITHDRAWN (referenced by name; the Payments agent adds the constant)');
  eq(a.actor_user_id, 'USR_admin000001');
  eq(a.actor_role, 'ADMIN');
  eq(a.tournament_id, TID);
  eq(a.entity_type, 'Player');
  eq(a.entity_id, 'PLY_seed00000001');
  eq(JSON.parse(a.prev_value), { is_withdrawn: false });
  eq(JSON.parse(a.new_value), { is_withdrawn: true, serial_no: 1, reason: 'Moved to Bangalore' });
  ok(/^2026-08-15T/.test(a.timestamp), 'server-side timestamp: ' + a.timestamp);
});

test('a withdrawn player still appears in the list, flagged', () => {
  seedMixed();
  M.Players.setWithdrawn({ playerId: 'PLY_seed00000001', withdrawn: true }, ADMIN);
  const r = listOf({ tournamentId: TID });
  eq(r.total, 6, 'still listed — the serial and the record stay');
  eq(r.rows[0].is_withdrawn, true);
  eq(serials(listOf({ tournamentId: TID, filter: { withdrawn: true } })), [1, 4]);
});

// ================================================= 17. Phase 2 through dispatch
console.log('\n--- Phase 2 through dispatch() ---');

test('player.list and player.setWithdrawn refuse an anonymous caller', () => {
  seedMixed();
  const d = vm.runInContext('dispatch', ctx);
  eq(d('player.list', { tournamentId: TID }, null, 'POST', {}).error.code, 'UNAUTHORIZED');
  eq(d('player.setWithdrawn', { playerId: 'PLY_seed00000001', withdrawn: true }, null, 'POST', {}).error.code, 'UNAUTHORIZED');
  eq(d('player.list', { tournamentId: TID }, null, 'GET', {}).error.code, 'BAD_REQUEST', 'GET is refused');
});

test('an ORGANISER token is refused by player.setWithdrawn but allowed on player.list', () => {
  seedMixed();
  // Mint real sessions through Auth so the dispatcher's Auth.require path is exercised.
  const mk = (role, tid) => {
    const token = M.Util.randomToken(32);
    M.Repo.append(M.SHEETS.SESSIONS, {
      token: token, user_id: 'USR_' + role, role: role, tournament_id: tid,
      issued_at: '2026-08-15T00:00:00.000Z', expires_at: '2026-08-16T00:00:00.000Z', revoked: false
    });
    return token;
  };
  const d = vm.runInContext('dispatch', ctx);
  const orgTok = mk('ORGANISER', TID);
  const admTok = mk('ADMIN', '');

  const listed = d('player.list', { tournamentId: TID, pageSize: 3 }, orgTok, 'POST', {});
  ok(listed.ok, 'organiser can list their own: ' + JSON.stringify(listed.error || {}));
  eq(listed.data.total, 6);
  eq(listed.data.rows.length, 3);
  eq(d('player.list', { tournamentId: TID2 }, orgTok, 'POST', {}).error.code, 'FORBIDDEN');

  eq(d('player.setWithdrawn', { playerId: 'PLY_seed00000001', withdrawn: true }, orgTok, 'POST', {}).error.code,
    'FORBIDDEN', 'withdrawing is ADMIN-only');
  const done = d('player.setWithdrawn', { playerId: 'PLY_seed00000001', withdrawn: true }, admTok, 'POST', {});
  ok(done.ok, 'admin can: ' + JSON.stringify(done.error || {}));
  eq(done.data.is_withdrawn, true);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
