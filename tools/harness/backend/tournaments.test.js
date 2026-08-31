/**
 * Node verification harness for backend/Tournaments.gs.
 *
 * Loads every .gs (except Tests.gs) into a vm context with in-memory stand-ins
 * for SpreadsheetApp, DriveApp, CacheService, PropertiesService and Utilities,
 * then exercises the Phase 1 tournament handlers for real.
 */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const DIR = '/Users/raja.t/cricket-auction/backend';

// ---------------------------------------------------------------- clock
let NOW = Date.parse('2026-07-15T06:00:00.000Z');
class MockDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
MockDate.parse = Date.parse;
MockDate.UTC = Date.UTC;
const setNow = (iso) => { NOW = Date.parse(iso); };

// ------------------------------------------------------- in-memory spreadsheet
const SHEET_DATA = {};        // tab -> array of row arrays (row 1 = header)
const READ_CALLS = {};        // tab -> number of getValues() calls
function makeSheet(name) {
  const grid = SHEET_DATA[name] = SHEET_DATA[name] || [];
  let maxRows = 1000, maxCols = 40;
  const at = (r, c) => {
    while (grid.length < r) grid.push([]);
    const row = grid[r - 1];
    while (row.length < c) row.push('');
    return row;
  };
  return {
    getName: () => name,
    getLastRow: () => {
      let last = 0;
      for (let i = 0; i < grid.length; i++) {
        if ((grid[i] || []).some(v => v !== '' && v !== null && v !== undefined)) last = i + 1;
      }
      return last;
    },
    getMaxRows: () => maxRows,
    getMaxColumns: () => maxCols,
    insertRowsAfter: (after, n) => { maxRows += n; },
    insertColumnsAfter: (after, n) => { maxCols += n; },
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        READ_CALLS[name] = (READ_CALLS[name] || 0) + 1;
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = at(r + i, c + nc - 1);
          out.push(row.slice(c - 1, c - 1 + nc).map(v => (v === undefined ? '' : v)));
        }
        return out;
      },
      setValues: (vals) => {
        for (let i = 0; i < vals.length; i++) {
          const row = at(r + i, c + nc - 1);
          for (let j = 0; j < vals[i].length; j++) row[c - 1 + j] = vals[i][j];
        }
      },
      clearContent: () => {}
    })
  };
}
const SHEETS_BY_NAME = {};
const SpreadsheetAppStub = {
  getActiveSpreadsheet: () => ({
    getSpreadsheetTimeZone: () => 'Asia/Kolkata',
    getSheetByName: (n) => SHEETS_BY_NAME[n] || null,
    insertSheet: (n) => (SHEETS_BY_NAME[n] = makeSheet(n)),
    getSheets: () => Object.values(SHEETS_BY_NAME)
  }),
  flush: () => {}
};

// ------------------------------------------------------------ in-memory Drive
let driveSeq = 0;
const FILES = {};             // id -> {name, mime, parent, trashed, bytes}
function makeFolder(name, parentId) {
  const id = 'fld_' + (++driveSeq);
  const f = {
    _id: id, _name: name, _parent: parentId, _children: {},
    getId: () => id,
    getName: () => name,
    getParents: () => {
      let done = !parentId;
      return { hasNext: () => !done, next: () => { done = true; return FOLDERS[parentId]; } };
    },
    getFoldersByName: (n) => {
      const hit = f._children[n];
      let done = !hit;
      return { hasNext: () => !done, next: () => { done = true; return hit; } };
    },
    createFolder: (n) => { const c = makeFolder(n, id); f._children[n] = c; return c; },
    createFile: (blob) => {
      const fid = 'file_' + (++driveSeq);
      FILES[fid] = { name: blob._name, mime: blob._mime, parent: id, trashed: false };
      return { getId: () => fid };
    },
    setSharing: () => {}
  };
  FOLDERS[id] = f;
  return f;
}
const FOLDERS = {};
const DRIVE_ROOT = makeFolder('MyDrive', null);
const DriveAppStub = {
  getRootFolder: () => DRIVE_ROOT,
  getFoldersByName: (n) => DRIVE_ROOT.getFoldersByName(n),
  createFolder: (n) => { const c = makeFolder(n, DRIVE_ROOT._id); DRIVE_ROOT._children[n] = c; return c; },
  getFolderById: (id) => { if (!FOLDERS[id]) throw new Error('no folder ' + id); return FOLDERS[id]; },
  getFileById: (id) => {
    if (!FILES[id]) throw new Error('no file ' + id);
    return { getId: () => id, setTrashed: (t) => { FILES[id].trashed = t; }, setSharing: () => {} };
  },
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
  Permission: { VIEW: 'VIEW' }
};

// ------------------------------------------------------- cache and properties
const CACHE = new Map(), PROPS = new Map();
const CacheServiceStub = {
  getScriptCache: () => ({
    get: (k) => (CACHE.has(k) ? CACHE.get(k) : null),
    put: (k, v) => CACHE.set(k, v),
    remove: (k) => CACHE.delete(k)
  })
};
const PropertiesServiceStub = {
  getScriptProperties: () => ({
    getProperty: (k) => (PROPS.has(k) ? PROPS.get(k) : null),
    setProperty: (k, v) => PROPS.set(k, v),
    deleteProperty: (k) => PROPS.delete(k)
  })
};

// ------------------------------------------------------------------- context
const ctx = {
  console, Date: MockDate, Math, JSON, isNaN, isFinite, parseInt, parseFloat,
  String, Number, Object, Array, Error, RegExp, Infinity, NaN, Boolean,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => b > 127 ? b - 256 : b),
    computeHmacSha256Signature: (m, k) => Array.from(crypto.createHmac('sha256', String(k)).update(String(m)).digest()).map(b => b > 127 ? b - 256 : b),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    base64Decode: s => Array.from(Buffer.from(s, 'base64')).map(b => b > 127 ? b - 256 : b),
    base64Encode: s => Buffer.from(s).toString('base64'),
    newBlob: (bytes, mime, name) => ({ _mime: mime, _name: name, getBytes: () => bytes, getContentType: () => mime }),
    formatDate: (d, tz, fmt) => {
      // Repo._dateToIso only needs these two patterns, in IST.
      const ms = d.getTime() + 330 * 60000;
      const x = new Date(ms);
      if (fmt === 'HH:mm:ss.SSS') return x.toISOString().substring(11, 23);
      return x.toISOString().substring(0, 10);
    },
    sleep: () => {}
  },
  SpreadsheetApp: SpreadsheetAppStub,
  DriveApp: DriveAppStub,
  CacheService: CacheServiceStub,
  PropertiesService: PropertiesServiceStub,
  LockService: { getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }) },
  ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }), MimeType: { JSON: 'JSON' } },
  Session: {}
};
vm.createContext(ctx);
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.gs') && f !== 'Tests.gs').sort();
vm.runInContext(files.map(f => fs.readFileSync(DIR + '/' + f, 'utf8')).join('\n'), ctx, { filename: 'ALL.gs' });
vm.runInContext('globalThis.__x = {Util,Repo,Cache,Auth,Audit,Drive,Tournaments,SHEETS,HEADERS,ENUM,ERR,TournamentRoutes,buildRoutes};', ctx);
const X = ctx.__x;

// Create the tabs and their headers, the way setup() would.
Object.keys(X.HEADERS).forEach((tab) => {
  SHEETS_BY_NAME[tab] = makeSheet(tab);
  X.Repo.ensureTab(tab);
});

// ------------------------------------------------------------------- harness
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  pass  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((m || '') + '\n        got      ' + JSON.stringify(a) + '\n        expected ' + JSON.stringify(b));
  }
}
function ok(c, m) { if (!c) throw new Error('assert failed: ' + m); }
function throwsWith(fn, code, substrings, m) {
  let e = null;
  try { fn(); } catch (err) { e = err; }
  if (!e) throw new Error((m || '') + ': nothing thrown');
  if (code && e.code !== code) throw new Error((m || '') + ': code was ' + e.code + ' (' + e.message + '), expected ' + code);
  (substrings || []).forEach((s) => {
    if (e.message.indexOf(s) === -1) throw new Error((m || '') + ': message "' + e.message + '" does not contain "' + s + '"');
  });
  return e;
}

// A 1x1 PNG and a 1x1 JPEG, so Drive.uploadImage's magic-number check passes.
const PNG_B64 = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,13]).toString('base64');
const JPG_B64 = Buffer.from([0xFF,0xD8,0xFF,0xE0,0,0x10,0x4A,0x46]).toString('base64');
const png = (n) => ({ data: PNG_B64, mime: 'image/png', filename: n });
const jpg = (n) => ({ data: JPG_B64, mime: 'image/jpeg', filename: n });

const ADMIN = { user_id: 'USR_admin000001', role: 'ADMIN', tournament_id: '' };
const base = () => ({
  name: 'Chennai Premier League', description: 'A local T20 auction.', rules: 'Be nice.',
  startDate: '2026-09-10', endDate: '2026-09-20',
  regStart: '2026-08-01', regEnd: '2026-08-31',
  regFee: 500, upiId: 'cpl@okhdfcbank', contactName: 'Raja T',
  contactMobile: '9876543210', contactEmail: 'Raja@Example.COM',
  defaultPurse: 100000, defaultMaxPlayers: 13,
  logo: png('logo.png'), qr: png('qr.png'), gallery: [jpg('g1.jpg'), jpg('g2.jpg')]
});

console.log('\n=== A. tournament.create ===');
let T1 = null;
t('creates a tournament and returns the contract shape', () => {
  T1 = X.Tournaments.create(base(), ADMIN);
  eq(Object.keys(T1).sort(), ['displayUrl', 'registrationUrl', 'slug', 'status', 'streamUrl', 'tournament_id', 'watchUrl'], 'response keys');
  ok(/^TRN_[a-z0-9]{12}$/.test(T1.tournament_id), 'id shape: ' + T1.tournament_id);
  eq(T1.slug, 'chennai-premier-league', 'slug');
  eq(T1.status, 'DRAFT', 'status');
});
t('row: next_serial 1, DRAFT, 32-hex display_token, drive folder, created_by', () => {
  const r = X.Repo.findBy('Tournaments', 'tournament_id', T1.tournament_id);
  eq(r.next_serial, 1, 'next_serial');
  eq(r.status, 'DRAFT', 'status');
  ok(/^[0-9a-f]{32}$/.test(r.display_token), 'display_token is 16 bytes hex: ' + r.display_token);
  ok(!!r.drive_folder_id, 'drive_folder_id set');
  eq(r.created_by, ADMIN.user_id, 'created_by');
  eq(r.contact_email, 'raja@example.com', 'email normalised');
  eq(r.reg_fee, 500, 'reg_fee');
  eq(r.default_purse, 100000, 'default_purse');
  eq(JSON.parse(r.photo_file_ids).length, 2, 'gallery ids stored as JSON array');
});
t('the Drive tree exists with public/gallery/players and private/payments', () => {
  const r = X.Repo.findBy('Tournaments', 'tournament_id', T1.tournament_id);
  const root = FOLDERS[r.drive_folder_id];
  ok(!!root, 'root folder');
  eq(root._name, T1.tournament_id + ' - chennai-premier-league', 'folder name');
  ok(!!root._children.public && !!root._children.private, 'public + private');
  ok(!!root._children.public._children.gallery, 'gallery');
  ok(!!root._children.private._children.payments, 'payments');
});
t('the QR keeps its original mime — it is not re-encoded to JPEG', () => {
  const r = X.Repo.findBy('Tournaments', 'tournament_id', T1.tournament_id);
  eq(FILES[r.qr_file_id].mime, 'image/png', 'qr stored mime');
});
t('TOURNAMENT_CREATED is audited and never carries the display_token', () => {
  const logs = X.Repo.filterBy('AuditLog', { action: 'TOURNAMENT_CREATED', entity_id: T1.tournament_id });
  eq(logs.length, 1, 'one audit row');
  eq(logs[0].actor_user_id, ADMIN.user_id, 'actor');
  const r = X.Repo.findBy('Tournaments', 'tournament_id', T1.tournament_id);
  ok(logs[0].new_value.indexOf(r.display_token) === -1, 'display_token not in the audit row');
});
let T2 = null;
t('a colliding name gets a unique slug', () => {
  T2 = X.Tournaments.create(base(), ADMIN);
  ok(T2.slug !== T1.slug, 'slugs differ: ' + T1.slug + ' vs ' + T2.slug);
  ok(T2.slug.indexOf('chennai-premier-league-') === 0, 'suffixed: ' + T2.slug);
});
t('registrationUrl / displayUrl fall back to a path when frontend_base_url is unset', () => {
  eq(T1.registrationUrl, '/register/' + T1.tournament_id, 'registrationUrl path');
  ok(T1.displayUrl.indexOf('/projector/' + T1.tournament_id + '?k=') === 0, 'displayUrl path: ' + T1.displayUrl);
  ok(T1.streamUrl.indexOf('/stream/' + T1.tournament_id + '?k=') === 0, 'streamUrl path: ' + T1.streamUrl);
  ok(T1.watchUrl.indexOf('/watch/' + T1.tournament_id + '?k=') === 0, 'watchUrl path: ' + T1.watchUrl);
  ok(T1.streamUrl.indexOf(T1.displayUrl.split('?k=')[1]) !== -1, 'streamUrl carries the same token as displayUrl');
  ok(T1.watchUrl.indexOf(T1.displayUrl.split('?k=')[1]) !== -1, 'watchUrl carries the same token as displayUrl');
});
t('registrationUrl / displayUrl use the Config frontend_base_url when present', () => {
  X.Repo.append('Config', { key: 'frontend_base_url', value: 'https://example.org/cricket/', updated_at: '' });
  X.Cache.invalidateConfig('frontend_base_url');
  const T = X.Tournaments.create(Object.assign(base(), { name: 'Base URL Cup' }), ADMIN);
  eq(T.registrationUrl, 'https://example.org/cricket/register/' + T.tournament_id, 'absolute registrationUrl');
  ok(T.displayUrl.indexOf('https://example.org/cricket/projector/') === 0, 'absolute displayUrl');
  ok(T.streamUrl.indexOf('https://example.org/cricket/stream/') === 0, 'absolute streamUrl');
  ok(T.watchUrl.indexOf('https://example.org/cricket/watch/') === 0, 'absolute watchUrl');
  // Put it back so the rest of the suite sees the path-only behaviour.
  X.Repo.updateBy('Config', 'key', 'frontend_base_url', { value: '' });
  X.Cache.invalidateConfig('frontend_base_url');
});
t('regFee 0 is accepted (a free tournament is legal)', () => {
  const T = X.Tournaments.create(Object.assign(base(), { name: 'Free Cup', regFee: 0 }), ADMIN);
  eq(X.Repo.findBy('Tournaments', 'tournament_id', T.tournament_id).reg_fee, 0, 'reg_fee 0');
});

console.log('\n=== B. create validation rejections ===');
const rej = (label, over, code, bits) =>
  t(label, () => throwsWith(() => X.Tournaments.create(Object.assign(base(), over), ADMIN), code || X.ERR.VALIDATION_FAILED, bits, label));
rej('name shorter than 3', { name: 'CP' }, null, ['tournament name', '3 and 80']);
rej('name longer than 80', { name: 'x'.repeat(81) }, null, ['3 and 80', '81']);
rej('name missing', { name: '' }, null, ['required']);
rej('regEnd before regStart', { regStart: '2026-08-31', regEnd: '2026-08-01' }, null, ['Registration ends before it opens', '31 Aug 2026', '1 Aug 2026']);
rej('endDate before startDate', { startDate: '2026-09-20', endDate: '2026-09-10' }, null, ['ends before it starts']);
rej('regFee negative', { regFee: -5 }, null, ['registration fee', '0 or more']);
rej('regFee is a decimal', { regFee: '500.50' }, null, ['registration fee']);
rej('defaultPurse 0', { defaultPurse: 0 }, null, ['purse', 'greater than zero']);
rej('defaultPurse negative', { defaultPurse: -1 }, null, ['purse']);
rej('defaultMaxPlayers 0', { defaultMaxPlayers: 0 }, null, ['squad size', 'at least 1']);
rej('defaultMaxPlayers not a number', { defaultMaxPlayers: 'ten' }, null, ['squad size', 'whole number']);
rej('upiId with no @', { upiId: 'cplokhdfcbank' }, null, ['name@bank']);
rej('upiId with a space', { upiId: 'cpl @hdfc' }, null, ['name@bank']);
rej('mobile too short', { contactMobile: '98765' }, null, ['10 digits']);
rej('mobile starting with 5', { contactMobile: '5876543210' }, null, ['6, 7, 8 or 9']);
rej('date that does not exist', { regEnd: '2026-02-30' }, null, ['not a real date']);
rej('date in the wrong format', { regStart: '01-08-2026' }, null, ['YYYY-MM-DD']);
rej('contactEmail malformed', { contactEmail: 'not-an-email' }, null, ['email address']);
rej('gallery is not a list', { gallery: 'nope' }, null, ['list of images']);
rej('gallery over the per-request cap', { gallery: new Array(13).fill(jpg('g.jpg')) }, null, ['at most 12', 'has 13']);
rej('logo present but empty', { logo: { mime: 'image/png' } }, null, ['logo image is missing its data']);
rej('logo is a GIF', { logo: { data: JPG_B64, mime: 'image/gif', filename: 'x.gif' } }, null, ['JPG and PNG']);
rej('logo mime lies about its bytes', { logo: { data: JPG_B64, mime: 'image/png', filename: 'x.png' } }, null, ['contents are']);
t('null logo/qr/gallery are accepted as "no image"', () => {
  const T = X.Tournaments.create(Object.assign(base(), { name: 'No Images Cup', logo: null, qr: null, gallery: null }), ADMIN);
  const r = X.Repo.findBy('Tournaments', 'tournament_id', T.tournament_id);
  eq(r.logo_file_id, '', 'no logo');
  eq(r.qr_file_id, '', 'no qr');
  eq(r.photo_file_ids, '[]', 'no gallery');
});
t('a bad field is rejected before anything reaches Drive', () => {
  const before = Object.keys(FILES).length;
  throwsWith(() => X.Tournaments.create(Object.assign(base(), { name: 'ok name', contactMobile: '123' }), ADMIN),
    X.ERR.VALIDATION_FAILED, [], 'bad mobile');
  eq(Object.keys(FILES).length, before, 'no files uploaded');
});

console.log('\n=== C. tournament.getPublic — the allow-list ===');
const PUBLIC_KEYS = ['tournament_id','name','description','rules','reg_fee','reg_fee_display',
  'logo_url','qr_url','qr_download_url','gallery_urls','upi_id','contact_name','contact_mobile',
  'reg_start','reg_end','reg_start_display','reg_end_display','registration_open','registration_message'];
t('returns exactly the 19 contract fields, no more', () => {
  const pub = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  eq(Object.keys(pub).sort(), PUBLIC_KEYS.slice().sort(), 'public key set');
});
t('leaks no forbidden key name', () => {
  const pub = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  ['drive_folder_id','display_token','next_serial','created_by','created_at','contact_email',
   'status','slug','default_purse','default_max_players','logo_file_id','qr_file_id',
   'photo_file_ids','start_date','end_date','_row','player_count','verified_count'].forEach((k) => {
    ok(!(k in pub), 'must not expose key ' + k);
  });
});
t('leaks no forbidden VALUE anywhere in the serialised response', () => {
  const r = X.Repo.findBy('Tournaments', 'tournament_id', T1.tournament_id);
  const text = JSON.stringify(X.Tournaments.getPublic({ tournamentId: T1.tournament_id }));
  [['display_token', r.display_token], ['drive_folder_id', r.drive_folder_id],
   ['contact_email', r.contact_email], ['created_by', r.created_by]].forEach(([label, v]) => {
    ok(String(v).length > 0 && text.indexOf(String(v)) === -1, 'value of ' + label + ' leaked: ' + v);
  });
});
t('a column added to the sheet in a later phase does NOT appear (allow-list, not deny-list)', () => {
  // Simulate Phase 5 appending a sensitive column by writing it onto the row
  // object the handler will read. A spread-and-delete implementation would leak it.
  const tab = SHEETS_BY_NAME['Tournaments'];
  const realHeaders = X.HEADERS['Tournaments'];
  const origMap = X.Repo._mapRow;
  X.Repo._mapRow = function (row, headers, typing, rowNumber) {
    const o = origMap.call(X.Repo, row, headers, typing, rowNumber);
    o.bank_account_no = '00112233445566';   // the future column
    return o;
  };
  try {
    const pub = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
    ok(!('bank_account_no' in pub), 'future column leaked into getPublic');
    ok(JSON.stringify(pub).indexOf('00112233445566') === -1, 'future column value leaked');
  } finally { X.Repo._mapRow = origMap; }
  void tab; void realHeaders;
});
t('gallery_urls and qr urls are Drive thumbnails, qr_download is larger', () => {
  const pub = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  eq(pub.gallery_urls.length, 2, 'two gallery urls');
  ok(pub.gallery_urls[0].indexOf('https://drive.google.com/thumbnail?id=') === 0, 'thumb url');
  ok(/sz=w800$/.test(pub.qr_url), 'qr_url w800: ' + pub.qr_url);
  ok(/sz=w1600$/.test(pub.qr_download_url), 'qr_download_url w1600: ' + pub.qr_download_url);
});
t('reg_fee_display uses Indian grouping', () => {
  const T = X.Tournaments.create(Object.assign(base(), { name: 'Big Fee Cup', regFee: 1000000 }), ADMIN);
  eq(X.Tournaments.getPublic({ tournamentId: T.tournament_id }).reg_fee_display, '₹10,00,000', 'formatINR');
});
t('accepts the snake_case id that arrives from a GET query string', () => {
  eq(X.Tournaments.getPublic({ tournament_id: T1.tournament_id }).tournament_id, T1.tournament_id, 'GET spelling');
});
t('unknown id is NOT_FOUND, blank id is VALIDATION_FAILED', () => {
  throwsWith(() => X.Tournaments.getPublic({ tournamentId: 'TRN_doesnotexist' }), X.ERR.NOT_FOUND, ['No tournament'], 'unknown');
  throwsWith(() => X.Tournaments.getPublic({}), X.ERR.VALIDATION_FAILED, ['tournament id is required'], 'blank');
});

console.log('\n=== D. registration_open and the three messages ===');
const setWindow = (tid, status, s, e) =>
  X.Repo.updateBy('Tournaments', 'tournament_id', tid, { status: status, reg_start: s, reg_end: e });
t('DRAFT -> "Registration is not open for this tournament."', () => {
  setWindow(T1.tournament_id, 'DRAFT', '2026-08-01', '2026-08-31');
  setNow('2026-08-10T06:00:00.000Z');
  const p = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  eq(p.registration_open, false, 'closed');
  eq(p.registration_message, 'Registration is not open for this tournament.', 'message');
});
['REG_CLOSED', 'AUCTION_LIVE', 'AUCTION_CLOSED'].forEach((st) => {
  t(st + ' inside the window still says "not open for this tournament"', () => {
    setWindow(T1.tournament_id, st, '2026-08-01', '2026-08-31');
    setNow('2026-08-10T06:00:00.000Z');
    const p = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
    eq(p.registration_open, false, 'closed');
    eq(p.registration_message, 'Registration is not open for this tournament.', 'message');
  });
});
t('REG_OPEN before the window -> "has not opened yet. It opens on 1 Aug 2026."', () => {
  setWindow(T1.tournament_id, 'REG_OPEN', '2026-08-01', '2026-08-31');
  setNow('2026-07-20T06:00:00.000Z');
  const p = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  eq(p.registration_open, false, 'closed');
  eq(p.registration_message, 'Registration has not opened yet. It opens on 1 Aug 2026.', 'message');
});
t('REG_OPEN after the window -> "Registration closed on 31 Aug 2026."', () => {
  setNow('2026-09-05T06:00:00.000Z');
  const p = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  eq(p.registration_open, false, 'closed');
  eq(p.registration_message, 'Registration closed on 31 Aug 2026.', 'message');
});
t('REG_OPEN inside the window -> open, empty message', () => {
  setNow('2026-08-10T06:00:00.000Z');
  const p = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  eq(p.registration_open, true, 'open');
  eq(p.registration_message, '', 'no message');
  eq(p.reg_start_display, '1 Aug 2026', 'reg_start_display');
  eq(p.reg_end_display, '31 Aug 2026', 'reg_end_display');
});
t('IST boundary: 23:30 IST on the last day is still OPEN (18:00Z)', () => {
  setNow('2026-08-31T18:00:00.000Z');   // 2026-08-31 23:30 IST
  eq(X.Tournaments.getPublic({ tournamentId: T1.tournament_id }).registration_open, true, 'still open');
});
t('IST boundary: 00:01 IST on 1 Sep is CLOSED (18:31Z on 31 Aug)', () => {
  setNow('2026-08-31T18:31:00.000Z');   // 2026-09-01 00:01 IST
  const p = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  eq(p.registration_open, false, 'closed');
  eq(p.registration_message, 'Registration closed on 31 Aug 2026.', 'message');
});
t('IST boundary: 06:00 IST on the last day is NOT closed (the UTC-midnight bug)', () => {
  setNow('2026-08-31T00:30:00.000Z');   // 2026-08-31 06:00 IST
  eq(X.Tournaments.getPublic({ tournamentId: T1.tournament_id }).registration_open, true,
    'a UTC comparison would have closed this at 05:30 IST');
});
t('IST boundary: 00:05 IST on the first day is already OPEN', () => {
  setNow('2026-07-31T18:35:00.000Z');   // 2026-08-01 00:05 IST
  eq(X.Tournaments.getPublic({ tournamentId: T1.tournament_id }).registration_open, true, 'open at IST midnight');
});
t('an unreadable stored window fails closed rather than throwing', () => {
  X.Repo.updateBy('Tournaments', 'tournament_id', T1.tournament_id, { reg_start: 'not-a-date', reg_end: 'nope' });
  const p = X.Tournaments.getPublic({ tournamentId: T1.tournament_id });
  eq(p.registration_open, false, 'closed');
  eq(p.registration_message, 'Registration is not open for this tournament.', 'message');
  setWindow(T1.tournament_id, 'DRAFT', '2026-08-01', '2026-08-31');
  setNow('2026-07-15T06:00:00.000Z');
});

console.log('\n=== E. tournament.setStatus ===');
function freshDraft(name) {
  const T = X.Tournaments.create(Object.assign(base(), { name: name }), ADMIN);
  return T.tournament_id;
}
const LEGAL = [
  ['DRAFT', 'REG_OPEN'], ['REG_OPEN', 'REG_CLOSED'], ['REG_CLOSED', 'REG_OPEN'],
  ['REG_CLOSED', 'AUCTION_LIVE'], ['REG_OPEN', 'AUCTION_LIVE'],
  ['AUCTION_LIVE', 'AUCTION_CLOSED'], ['AUCTION_CLOSED', 'AUCTION_LIVE']
];
LEGAL.forEach(([from, to]) => {
  t('legal: ' + from + ' -> ' + to, () => {
    const tid = freshDraft('Status ' + from + ' ' + to);
    X.Repo.updateBy('Tournaments', 'tournament_id', tid, { status: from });
    const res = X.Tournaments.setStatus({ tournamentId: tid, status: to }, ADMIN);
    eq(res.status, to, 'returned status');
    eq(res.prev_status, from, 'returned prev_status');
    eq(X.Repo.findBy('Tournaments', 'tournament_id', tid).status, to, 'row updated');
    const logs = X.Repo.filterBy('AuditLog', { entity_id: tid });
    ok(logs.length >= 2, 'the change was audited');
    const last = logs[logs.length - 1];
    eq(JSON.parse(last.prev_value).status, from, 'audit prev');
    eq(JSON.parse(last.new_value).status, to, 'audit next');
  });
});
const ILLEGAL = [
  ['DRAFT', 'REG_CLOSED'], ['DRAFT', 'AUCTION_LIVE'], ['DRAFT', 'AUCTION_CLOSED'], ['DRAFT', 'DRAFT'],
  ['REG_OPEN', 'DRAFT'], ['REG_OPEN', 'AUCTION_CLOSED'], ['REG_OPEN', 'REG_OPEN'],
  ['REG_CLOSED', 'DRAFT'], ['REG_CLOSED', 'AUCTION_CLOSED'],
  ['AUCTION_LIVE', 'DRAFT'], ['AUCTION_LIVE', 'REG_OPEN'], ['AUCTION_LIVE', 'REG_CLOSED'],
  ['AUCTION_CLOSED', 'DRAFT'], ['AUCTION_CLOSED', 'REG_OPEN'], ['AUCTION_CLOSED', 'REG_CLOSED']
];
ILLEGAL.forEach(([from, to]) => {
  t('illegal: ' + from + ' -> ' + to + ' is rejected naming both', () => {
    const tid = freshDraft('Bad ' + from + ' ' + to);
    X.Repo.updateBy('Tournaments', 'tournament_id', tid, { status: from });
    throwsWith(() => X.Tournaments.setStatus({ tournamentId: tid, status: to }, ADMIN),
      X.ERR.VALIDATION_FAILED, [from, to], from + '->' + to);
    eq(X.Repo.findBy('Tournaments', 'tournament_id', tid).status, from, 'row unchanged');
  });
});
t('an unknown status word is rejected and lists the real ones', () => {
  const tid = freshDraft('Bogus Status Cup');
  throwsWith(() => X.Tournaments.setStatus({ tournamentId: tid, status: 'LIVE' }, ADMIN),
    X.ERR.VALIDATION_FAILED, ['not a tournament status', 'AUCTION_CLOSED'], 'bogus');
  throwsWith(() => X.Tournaments.setStatus({ tournamentId: tid, status: '' }, ADMIN),
    X.ERR.VALIDATION_FAILED, ['new status is required'], 'blank');
  throwsWith(() => X.Tournaments.setStatus({ tournamentId: 'TRN_nope', status: 'REG_OPEN' }, ADMIN),
    X.ERR.NOT_FOUND, [], 'unknown tournament');
});
t('REG_OPEN -> AUCTION_LIVE returns a warning; the others do not', () => {
  const a = freshDraft('Warn Cup');
  X.Repo.updateBy('Tournaments', 'tournament_id', a, { status: 'REG_OPEN' });
  const warned = X.Tournaments.setStatus({ tournamentId: a, status: 'AUCTION_LIVE' }, ADMIN);
  ok(warned.warning.indexOf('registration is still open') !== -1, 'warning text: ' + warned.warning);
  const b = freshDraft('Quiet Cup');
  X.Repo.updateBy('Tournaments', 'tournament_id', b, { status: 'REG_CLOSED' });
  eq(X.Tournaments.setStatus({ tournamentId: b, status: 'AUCTION_LIVE' }, ADMIN).warning, '', 'no warning');
});
t('the closing / reopening moves use their own audit actions', () => {
  const tid = freshDraft('Audit Action Cup');
  X.Repo.updateBy('Tournaments', 'tournament_id', tid, { status: 'REG_OPEN' });
  const seen = [];
  const lastAction = () => {
    const l = X.Repo.filterBy('AuditLog', { entity_id: tid });
    return l[l.length - 1].action;
  };
  X.Tournaments.setStatus({ tournamentId: tid, status: 'REG_CLOSED' }, ADMIN); seen.push(lastAction());
  X.Tournaments.setStatus({ tournamentId: tid, status: 'AUCTION_LIVE' }, ADMIN); seen.push(lastAction());
  X.Tournaments.setStatus({ tournamentId: tid, status: 'AUCTION_CLOSED' }, ADMIN); seen.push(lastAction());
  X.Tournaments.setStatus({ tournamentId: tid, status: 'AUCTION_LIVE' }, ADMIN); seen.push(lastAction());
  eq(seen, ['REGISTRATION_CLOSED', 'TOURNAMENT_UPDATED', 'AUCTION_CLOSED', 'AUCTION_REOPENED'], 'audit actions');
});

console.log('\n=== F. tournament.list ===');
t('counts come from ONE Players read, not one per tournament', () => {
  const tids = X.Repo.readAll('Tournaments').map(r => r.tournament_id);
  ok(tids.length >= 5, 'several tournaments exist: ' + tids.length);
  const rows = [];
  for (let i = 0; i < 7; i++) {
    rows.push({ player_id: 'PLY_a' + i, tournament_id: tids[0], payment_status: i < 3 ? 'VERIFIED' : 'PENDING' });
  }
  for (let i = 0; i < 4; i++) {
    rows.push({ player_id: 'PLY_b' + i, tournament_id: tids[1], payment_status: i < 1 ? 'VERIFIED' : 'REJECTED' });
  }
  X.Repo.appendMany('Players', rows);

  READ_CALLS['Players'] = 0;
  const out = X.Tournaments.list({}, ADMIN);
  eq(READ_CALLS['Players'], 1, 'exactly one getValues() on Players for ' + tids.length + ' tournaments');

  const byId = {};
  out.forEach(o => { byId[o.tournament_id] = o; });
  eq([byId[tids[0]].player_count, byId[tids[0]].verified_count], [7, 3], 'counts for tournament 1');
  eq([byId[tids[1]].player_count, byId[tids[1]].verified_count], [4, 1], 'counts for tournament 2');
  eq([byId[tids[2]].player_count, byId[tids[2]].verified_count], [0, 0], 'a tournament with no players');
});
t('list returns exactly the contract fields and nothing sensitive', () => {
  const row = X.Tournaments.list({}, ADMIN)[0];
  eq(Object.keys(row).sort(),
    ['created_at','name','player_count','reg_end','reg_fee','reg_start','slug','status','tournament_id','verified_count'].sort(),
    'list row keys');
});
t('list is newest first', () => {
  const out = X.Tournaments.list({}, ADMIN);
  for (let i = 1; i < out.length; i++) {
    ok(Date.parse(out[i - 1].created_at) >= Date.parse(out[i].created_at), 'ordering at index ' + i);
  }
});

console.log('\n=== G. tournament.get ===');
t('ADMIN gets the whole row plus derived urls, without _row', () => {
  const g = X.Tournaments.get({ tournamentId: T1.tournament_id }, ADMIN);
  ok(!('_row' in g), '_row dropped');
  X.HEADERS['Tournaments'].forEach(h => ok(h in g, 'has column ' + h));
  ok(!!g.display_token, 'admin does see the display_token');
  ok(Array.isArray(g.photo_file_ids), 'gallery parsed to an array');
  ok(g.displayUrl.indexOf('k=' + g.display_token) !== -1, 'displayUrl carries the token');
  ok(g.streamUrl.indexOf('k=' + g.display_token) !== -1, 'streamUrl carries the token');
  ok(g.watchUrl.indexOf('k=' + g.display_token) !== -1, 'watchUrl carries the token');
});
t('ORGANISER of another tournament is FORBIDDEN', () => {
  const org = { user_id: 'USR_org1', role: 'ORGANISER', tournament_id: T2.tournament_id };
  throwsWith(() => X.Tournaments.get({ tournamentId: T1.tournament_id }, org), X.ERR.FORBIDDEN, [], 'cross-tournament');
  eq(X.Tournaments.get({ tournamentId: T2.tournament_id }, org).tournament_id, T2.tournament_id, 'own tournament ok');
});

console.log('\n=== H. tournament.update ===');
let U = null;
t('only supplied keys change', () => {
  U = X.Tournaments.create(Object.assign(base(), { name: 'Update Cup' }), ADMIN).tournament_id;
  const before = X.Repo.findBy('Tournaments', 'tournament_id', U);
  const res = X.Tournaments.update({ tournamentId: U, name: 'Update Cup 2027', regFee: 750 }, ADMIN);
  eq(res.changed.sort(), ['name', 'reg_fee'], 'changed list');
  const after = X.Repo.findBy('Tournaments', 'tournament_id', U);
  eq(after.name, 'Update Cup 2027', 'name changed');
  eq(after.reg_fee, 750, 'fee changed');
  eq(after.contact_mobile, before.contact_mobile, 'mobile untouched');
  eq(after.slug, before.slug, 'slug is not churned by a rename');
  eq(after.status, before.status, 'status untouched');
  eq(after.next_serial, before.next_serial, 'next_serial untouched');
});
t('a null or absent image leaves the existing one alone', () => {
  const before = X.Repo.findBy('Tournaments', 'tournament_id', U);
  X.Tournaments.update({ tournamentId: U, logo: null, qr: null, description: 'edited' }, ADMIN);
  const after = X.Repo.findBy('Tournaments', 'tournament_id', U);
  eq(after.logo_file_id, before.logo_file_id, 'logo kept');
  eq(after.qr_file_id, before.qr_file_id, 'qr kept');
  eq(FILES[after.logo_file_id].trashed, false, 'old logo not trashed');
});
t('a new image replaces the old one and trashes it', () => {
  const before = X.Repo.findBy('Tournaments', 'tournament_id', U);
  X.Tournaments.update({ tournamentId: U, logo: jpg('new-logo.jpg') }, ADMIN);
  const after = X.Repo.findBy('Tournaments', 'tournament_id', U);
  ok(after.logo_file_id !== before.logo_file_id, 'logo replaced');
  eq(FILES[after.logo_file_id].mime, 'image/jpeg', 'new mime kept as sent');
  eq(FILES[before.logo_file_id].trashed, true, 'old logo trashed');
});
t('a replacement QR keeps PNG rather than being re-encoded', () => {
  X.Tournaments.update({ tournamentId: U, qr: png('new-qr.png') }, ADMIN);
  eq(FILES[X.Repo.findBy('Tournaments', 'tournament_id', U).qr_file_id].mime, 'image/png', 'qr mime');
});
t('removeLogo / removeQr clear exactly one image each', () => {
  const before = X.Repo.findBy('Tournaments', 'tournament_id', U);
  X.Tournaments.update({ tournamentId: U, removeLogo: true }, ADMIN);
  let after = X.Repo.findBy('Tournaments', 'tournament_id', U);
  eq(after.logo_file_id, '', 'logo cleared');
  eq(after.qr_file_id, before.qr_file_id, 'qr untouched');
  X.Tournaments.update({ tournamentId: U, removeQr: true }, ADMIN);
  after = X.Repo.findBy('Tournaments', 'tournament_id', U);
  eq(after.qr_file_id, '', 'qr cleared');
});
t('a supplied gallery replaces the whole set', () => {
  X.Tournaments.update({ tournamentId: U, gallery: [jpg('a.jpg')] }, ADMIN);
  eq(JSON.parse(X.Repo.findBy('Tournaments', 'tournament_id', U).photo_file_ids).length, 1, 'one gallery image');
  X.Tournaments.update({ tournamentId: U, removeGallery: true }, ADMIN);
  eq(X.Repo.findBy('Tournaments', 'tournament_id', U).photo_file_ids, '[]', 'gallery cleared');
});
t('uploading and removing the same image in one call is rejected', () => {
  throwsWith(() => X.Tournaments.update({ tournamentId: U, logo: png('l.png'), removeLogo: true }, ADMIN),
    X.ERR.VALIDATION_FAILED, ['Choose one'], 'logo conflict');
});
t('the audit row records prev and next for the changed keys only', () => {
  X.Tournaments.update({ tournamentId: U, contactName: 'New Contact' }, ADMIN);
  const logs = X.Repo.filterBy('AuditLog', { action: 'TOURNAMENT_UPDATED', entity_id: U });
  const last = logs[logs.length - 1];
  eq(JSON.parse(last.prev_value), { contact_name: 'Raja T' }, 'prev');
  eq(JSON.parse(last.new_value), { contact_name: 'New Contact' }, 'next');
});
t('a date change is re-checked against the stored value on the other side', () => {
  throwsWith(() => X.Tournaments.update({ tournamentId: U, regStart: '2026-09-30' }, ADMIN),
    X.ERR.VALIDATION_FAILED, ['Registration would end before it opens'], 'inverted window');
  throwsWith(() => X.Tournaments.update({ tournamentId: U, endDate: '2026-01-01' }, ADMIN),
    X.ERR.VALIDATION_FAILED, ['would end before it starts'], 'inverted tournament dates');
  X.Tournaments.update({ tournamentId: U, regStart: '2026-08-05', regEnd: '2026-08-20' }, ADMIN);
  const r = X.Repo.findBy('Tournaments', 'tournament_id', U);
  eq([r.reg_start, r.reg_end], ['2026-08-05', '2026-08-20'], 'both dates moved together');
});
t('update re-runs every field validation', () => {
  [['name', 'ab'], ['upiId', 'bad'], ['contactMobile', '111'], ['defaultPurse', 0],
   ['defaultMaxPlayers', 0], ['regFee', -1], ['regStart', '2026-13-01']].forEach(([k, v]) => {
    const patch = { tournamentId: U }; patch[k] = v;
    throwsWith(() => X.Tournaments.update(patch, ADMIN), X.ERR.VALIDATION_FAILED, [], 'update ' + k);
  });
});
t('an empty update and an unknown id are both rejected', () => {
  throwsWith(() => X.Tournaments.update({ tournamentId: U }, ADMIN), X.ERR.VALIDATION_FAILED, ['Nothing was sent'], 'empty');
  throwsWith(() => X.Tournaments.update({ tournamentId: 'TRN_nope', name: 'x y z' }, ADMIN), X.ERR.NOT_FOUND, [], 'unknown');
});
t('update cannot set the status (that is setStatus only)', () => {
  const before = X.Repo.findBy('Tournaments', 'tournament_id', U).status;
  X.Tournaments.update({ tournamentId: U, status: 'AUCTION_LIVE', description: 'x' }, ADMIN);
  eq(X.Repo.findBy('Tournaments', 'tournament_id', U).status, before, 'status untouched by update');
});

console.log('\n=== I. routing ===');
t('TournamentRoutes wires all six actions with the right auth and methods', () => {
  const r = X.TournamentRoutes();
  eq(Object.keys(r).sort(),
    ['tournament.create','tournament.get','tournament.getPublic','tournament.list',
     'tournament.setStatus','tournament.update'].sort(), 'action names');
  eq(r['tournament.create'].auth, ['ADMIN'], 'create auth');
  eq(r['tournament.update'].auth, ['ADMIN'], 'update auth');
  eq(r['tournament.list'].auth, ['ADMIN'], 'list auth');
  eq(r['tournament.setStatus'].auth, ['ADMIN'], 'setStatus auth');
  eq(r['tournament.get'].auth, ['ADMIN', 'ORGANISER'], 'get auth');
  eq(r['tournament.getPublic'].auth, 'PUBLIC', 'getPublic auth');
  ['create','update','list','get','setStatus'].forEach((a) => {
    eq(r['tournament.' + a].methods, ['POST'], a + ' is POST only');
  });
  eq(r['tournament.getPublic'].methods.slice().sort(), ['GET', 'POST'], 'getPublic is GET and POST');
  Object.keys(r).forEach(k => ok(typeof r[k].handler === 'function', k + ' has a handler'));
});
t('buildRoutes() merges the tournament actions in without collisions', () => {
  const all = X.buildRoutes();
  ['tournament.create','tournament.update','tournament.list','tournament.get',
   'tournament.setStatus','tournament.getPublic'].forEach(a => ok(a in all, a + ' reachable'));
});
t('the getPublic route handler ignores any token/session it is handed', () => {
  const r = X.TournamentRoutes()['tournament.getPublic'];
  const out = r.handler({ tournamentId: T1.tournament_id }, null, {});
  eq(Object.keys(out).sort(), PUBLIC_KEYS.slice().sort(), 'same allow-list through the route');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
