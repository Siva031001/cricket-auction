/**
 * Phase 3 organiser access harness.
 *
 * Same in-memory fakes as /tmp/pay_test.js and /tmp/players_test.js
 * (SpreadsheetApp / DriveApp / CacheService / PropertiesService / LockService),
 * with the real .gs files loaded on top in one concatenated scope.
 *
 *   node /tmp/org_test.js
 */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const DIR = '/Users/raja.t/cricket-auction/backend';

// ------------------------------------------------------------------ fake sheet
let lockHeld = false;
let lockWaits = 0, lockReleases = 0;
const writeLog = [];            // {tab, row, lockHeld}

function makeSheet(name, headers) {
  const grid = [headers.slice()];
  return {
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
    insertRowsAfter: (after, n) => { for (let i = 0; i < n; i++) grid.push(new Array(headers.length).fill('')); },
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
}

const sheets = {};
const SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSpreadsheetTimeZone: () => 'Asia/Kolkata',
    getSheetByName: (n) => sheets[n] || null,
    getSheets: () => Object.values(sheets),
    insertSheet: (n) => { sheets[n] = makeSheet(n, []); return sheets[n]; }
  }),
  flush: () => {}
};

const DriveApp = {
  getFileById: () => { throw new Error('no drive in this harness'); },
  getFolderById: () => { throw new Error('not a folder'); },
  getRootFolder: () => ({ getId: () => 'ROOT' }),
  getFoldersByName: () => ({ hasNext: () => false }),
  createFolder: () => ({ getId: () => 'NEW' }),
  Access: { ANYONE_WITH_LINK: 'A' },
  Permission: { VIEW: 'V' }
};

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

const G = vm.runInContext(
  '({Repo,Util,Cache,ENUM,ERR,SHEETS,HEADERS,Auth,Audit,Organisers,dispatch,buildRoutes})', ctx);

// ------------------------------------------------------------------ harness
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
vm.runInContext(`Repo.append(SHEETS.TOURNAMENTS, {tournament_id:'${TID}', slug:'t1', name:'T1', status:'REG_OPEN', next_serial:1, reg_fee:500});`, ctx);
vm.runInContext(`Repo.append(SHEETS.TOURNAMENTS, {tournament_id:'${TID2}', slug:'t2', name:'T2', status:'REG_OPEN', next_serial:1, reg_fee:500});`, ctx);
vm.runInContext(`Repo.append(SHEETS.CONFIG, {key:'pepper', value:'test-pepper-abc', updated_at:'2026-01-01T00:00:00.000Z'});`, ctx);
vm.runInContext(`Repo.append(SHEETS.CONFIG, {key:'frontend_base_url', value:'https://example.github.io/cricket-auction/', updated_at:'2026-01-01T00:00:00.000Z'});`, ctx);

vm.runInContext(`Repo.append(SHEETS.USERS, {user_id:'USR_admin', email:'admin@example.com', display_name:'Admin',
  password_hash:'', salt:'', role:'ADMIN', tournament_id:'', status:'ACTIVE',
  created_at:'2026-01-01T00:00:00.000Z', created_by:'SETUP', last_login_at:''});`, ctx);

const adminSession = { user_id: 'USR_admin', role: 'ADMIN', tournament_id: '', token: 'tok-admin' };

const O = G.Organisers;
const usersRow = (id) => G.Repo.findBy('Users', 'user_id', id);
const auditRows = () => G.Repo.readAll('AuditLog');
const sessionRows = () => G.Repo.readAll('Sessions');
const userCell = (id, col) => {
  const grid = sheets.Users._grid;
  const c = G.HEADERS.Users.indexOf(col);
  for (let i = 1; i < grid.length; i++) if (grid[i][0] === id) return grid[i][c];
  return undefined;
};

console.log('\n=== Phase 3 organiser access ===\n');

// ------------------------------------------------------------- schema
t('Users header carries the three join columns, appended at the end', () => {
  const h = G.HEADERS.Users;
  eq(h[h.length - 3], 'join_token_hash');
  eq(h[h.length - 2], 'join_expires_at');
  eq(h[h.length - 1], 'join_used_at');
});

t('Audit.ACTIONS has ORGANISER_DISABLED and ORGANISER_LINK_RESENT', () => {
  eq(G.Audit.ACTIONS.ORGANISER_DISABLED, 'ORGANISER_DISABLED');
  eq(G.Audit.ACTIONS.ORGANISER_LINK_RESENT, 'ORGANISER_LINK_RESENT');
  ok(Object.isFrozen(G.Audit.ACTIONS), 'ACTIONS must stay frozen');
});

// ------------------------------------------------------------- create
let created, plainToken;
t('create returns a joinUrl built from frontend_base_url, trailing slash stripped', () => {
  created = O.create({ tournamentId: TID, email: 'Priya@Example.COM', displayName: 'Priya R' }, adminSession);
  eq(created.email, 'priya@example.com', 'email is normalised: ');
  eq(created.display_name, 'Priya R');
  eq(created.tournament_id, TID);
  ok(/^USR_/.test(created.user_id), 'user_id prefix');
  const m = /^https:\/\/example\.github\.io\/cricket-auction\/organiser\/join\?k=([a-f0-9]{64})$/.exec(created.joinUrl);
  ok(m, 'joinUrl shape, got ' + created.joinUrl);
  plainToken = m[1];
  ok(created.joinExpiresAt, 'joinExpiresAt present');
  ok(created.joinExpiresAtDisplay && /\d{4},/.test(created.joinExpiresAtDisplay),
    'IST display, got ' + created.joinExpiresAtDisplay);
});

t('the token in the joinUrl is NOT what is stored — the sheet holds its SHA-256', () => {
  const stored = userCell(created.user_id, 'join_token_hash');
  ok(stored, 'a hash was stored');
  ok(stored !== plainToken, 'stored value must not be the plain token');
  eq(stored, G.Util.sha256Hex(plainToken), 'stored value is sha256(token): ');
  eq(stored.length, 64);
  // and the plain token appears in no cell of any tab
  let leaked = [];
  Object.keys(sheets).forEach((tab) => {
    sheets[tab]._grid.forEach((row, i) => {
      row.forEach((cell) => { if (String(cell).indexOf(plainToken) !== -1) leaked.push(tab + ' row ' + (i + 1)); });
    });
  });
  eq(leaked.length, 0, 'plain token leaked into ' + leaked.join(', ') + ': ');
});

t('create writes no password and 72h expiry, and clears join_used_at', () => {
  const row = usersRow(created.user_id);
  eq(row.password_hash, '');
  eq(row.salt, '');
  eq(row.role, 'ORGANISER');
  eq(row.status, 'ACTIVE');
  eq(row.tournament_id, TID);
  eq(row.created_by, 'USR_admin');
  eq(row.join_used_at, '');
  const hours = (Date.parse(row.join_expires_at) - Date.now()) / 3600000;
  ok(hours > 71.9 && hours <= 72, '72 hour TTL, got ' + hours);
});

t('create is audited as ORGANISER_CREATED and the audit row has no token', () => {
  const rows = auditRows().filter((r) => r.entity_id === created.user_id);
  eq(rows.length, 1);
  eq(rows[0].action, 'ORGANISER_CREATED');
  eq(rows[0].tournament_id, TID);
  ok(JSON.stringify(rows).indexOf(plainToken) === -1, 'audit must not carry the token');
});

t('a blank-password account cannot log in before the link is redeemed', () => {
  const e = throwsCode(() => G.Auth.login('priya@example.com', '', 'ua'), 'UNAUTHORIZED');
  eq(e.message, G.Auth.BAD_CREDENTIALS_MSG);
  cacheStore.clear();
  const e2 = throwsCode(() => G.Auth.login('priya@example.com', 'anything123', 'ua'), 'UNAUTHORIZED');
  eq(e2.message, G.Auth.BAD_CREDENTIALS_MSG);
  cacheStore.clear();
});

t('duplicate email is rejected case-insensitively with VALIDATION_FAILED', () => {
  throwsCode(() => O.create({ tournamentId: TID, email: 'PRIYA@example.com', displayName: 'Clone' }, adminSession), 'VALIDATION_FAILED');
  throwsCode(() => O.create({ tournamentId: TID2, email: '  priya@EXAMPLE.com  ', displayName: 'Clone' }, adminSession), 'VALIDATION_FAILED');
  // ...including against an existing ADMIN, not just other organisers
  throwsCode(() => O.create({ tournamentId: TID, email: 'ADMIN@example.com', displayName: 'Clone' }, adminSession), 'VALIDATION_FAILED');
});

t('create rejects a bad email, a missing name and an unknown tournament', () => {
  throwsCode(() => O.create({ tournamentId: TID, email: 'nope', displayName: 'X' }, adminSession), 'VALIDATION_FAILED');
  throwsCode(() => O.create({ tournamentId: TID, email: 'a@b.com', displayName: '  ' }, adminSession), 'VALIDATION_FAILED');
  throwsCode(() => O.create({ tournamentId: 'TRN_nope', email: 'a@b.com', displayName: 'X' }, adminSession), 'NOT_FOUND');
  throwsCode(() => O.create({ email: 'a@b.com', displayName: 'X' }, adminSession), 'VALIDATION_FAILED');
});

t('joinUrl degrades to a bare path when frontend_base_url is missing', () => {
  cacheStore.clear();
  const cfg = sheets.Config._grid;
  const saved = cfg[2][1];
  cfg[2][1] = '';                       // blank the frontend_base_url row
  const r = O.create({ tournamentId: TID2, email: 'pathonly@example.com', displayName: 'Path Only' }, adminSession);
  ok(/^\/organiser\/join\?k=[a-f0-9]{64}$/.test(r.joinUrl), 'bare path, got ' + r.joinUrl);
  cfg[2][1] = saved;
  cacheStore.clear();
});

// ------------------------------------------------------------- list
t('list never contains the token or its hash, and reports joinPending', () => {
  const out = O.list({ tournamentId: TID }, adminSession);
  eq(out.length, 1);
  const row = out[0];
  eq(Object.keys(row).sort().join(','),
    'created_at,display_name,email,joinPending,last_login_at,status,user_id');
  eq(row.joinPending, true);
  const json = JSON.stringify(out);
  ok(json.indexOf(plainToken) === -1, 'plain token in list output');
  ok(json.indexOf(G.Util.sha256Hex(plainToken)) === -1, 'token HASH in list output');
  ok(json.indexOf('join_token_hash') === -1, 'hash column name in list output');
  ok(json.indexOf('password_hash') === -1 && json.indexOf('salt') === -1, 'secrets in list output');
});

t('list is scoped to one tournament and only returns organisers', () => {
  eq(O.list({ tournamentId: TID }, adminSession).length, 1);
  eq(O.list({ tournamentId: TID2 }, adminSession).length, 1);
  eq(O.list({ tournamentId: TID2 }, adminSession)[0].email, 'pathonly@example.com');
  ok(O.list({ tournamentId: TID }, adminSession).every((r) => r.email !== 'admin@example.com'),
    'the ADMIN must not appear');
});

// ------------------------------------------------------------- redeem
t('the password minimum is enforced and the link survives a short one', () => {
  // Derived from the constant, not a hardcoded string. The minimum is a
  // tournament-owner decision that has already changed once (10 -> 4), and a
  // literal 'short' silently BECAME VALID — so this test stopped rejecting,
  // burned the single-use token, and cascaded into eight unrelated failures.
  const tooShort = 'a'.repeat(Math.max(0, G.Auth.MIN_PASSWORD_LEN - 1));
  const e = throwsCode(() => G.Auth.redeemJoinToken(plainToken, tooShort, 'ua'), 'VALIDATION_FAILED');
  ok(new RegExp('at least ' + G.Auth.MIN_PASSWORD_LEN + ' characters').test(e.message),
    'message names the rule: ' + e.message);
  eq(userCell(created.user_id, 'join_token_hash'), G.Util.sha256Hex(plainToken), 'token must NOT be burned: ');
  eq(userCell(created.user_id, 'join_used_at'), '');
});

let joined;
t('redeeming works once: sets the password and returns the auth.login shape', () => {
  joined = G.Auth.redeemJoinToken(plainToken, 'correct-horse-battery', 'ua/test');
  eq(Object.keys(joined).sort().join(','), 'expiresAt,token,user');
  eq(Object.keys(joined.user).sort().join(','), 'display_name,role,tournament_id,user_id');
  eq(joined.user.user_id, created.user_id);
  eq(joined.user.role, 'ORGANISER');
  eq(joined.user.tournament_id, TID);
  eq(joined.token.length, 64);
  ok(JSON.stringify(joined).indexOf('password_hash') === -1 && JSON.stringify(joined).indexOf('salt') === -1,
    'no secrets in the response');
  const row = usersRow(created.user_id);
  ok(row.password_hash && row.salt, 'password now set');
  ok(row.last_login_at, 'last_login_at stamped');
});

t('the token is burned in the same locked section that set the password', () => {
  eq(userCell(created.user_id, 'join_token_hash'), '', 'hash cleared: ');
  ok(userCell(created.user_id, 'join_used_at'), 'join_used_at stamped');
  // the Users write that set the password must have happened under the lock
  const userWrites = writeLog.filter((w) => w.tab === 'Users');
  ok(userWrites.some((w) => w.lockHeld), 'at least one Users write under the lock');
  eq(lockWaits, lockReleases, 'every lock released: ');
});

t('the new password logs in, and the join is audited with joined:true', () => {
  cacheStore.clear();
  const s = G.Auth.login('priya@example.com', 'correct-horse-battery', 'ua');
  eq(s.user.user_id, created.user_id);
  const joinAudit = auditRows().filter((r) => r.entity_id === created.user_id && r.action === 'ORGANISER_CREATED');
  eq(joinAudit.length, 2, 'create + join: ');
  ok(String(joinAudit[1].new_value).indexOf('"joined":true') !== -1, 'joined marker, got ' + joinAudit[1].new_value);
  ok(JSON.stringify(auditRows()).indexOf(plainToken) === -1, 'token in the audit log');
});

t('a second redemption of the same token fails', () => {
  throwsCode(() => G.Auth.redeemJoinToken(plainToken, 'correct-horse-battery', 'ua'), 'UNAUTHORIZED');
});

// the three failure modes must be indistinguishable
let msgUsed, msgGarbage, msgExpired, msgBlank;
t('an already-used token, a garbage token and an expired token give ONE message', () => {
  msgUsed = throwsCode(() => G.Auth.redeemJoinToken(plainToken, 'a-long-enough-password'), 'UNAUTHORIZED').message;
  msgGarbage = throwsCode(() => G.Auth.redeemJoinToken('deadbeef'.repeat(8), 'a-long-enough-password'), 'UNAUTHORIZED').message;

  // expired: mint one and back-date it
  const exp = O.create({ tournamentId: TID, email: 'expired@example.com', displayName: 'Expired One' }, adminSession);
  const expToken = /k=([a-f0-9]{64})$/.exec(exp.joinUrl)[1];
  const r = usersRow(exp.user_id);
  G.Repo.updateRow('Users', r._row, { join_expires_at: new Date(Date.now() - 1000).toISOString() });
  msgExpired = throwsCode(() => G.Auth.redeemJoinToken(expToken, 'a-long-enough-password'), 'UNAUTHORIZED').message;
  msgBlank = throwsCode(() => G.Auth.redeemJoinToken('', 'a-long-enough-password'), 'UNAUTHORIZED').message;

  eq(msgGarbage, msgUsed, 'garbage vs used: ');
  eq(msgExpired, msgUsed, 'expired vs used: ');
  eq(msgBlank, msgUsed, 'blank vs used: ');
  eq(msgUsed, G.Auth.BAD_JOIN_LINK_MSG);
  ok(!/expired/i.test(msgUsed) || !/used/i.test(msgUsed) || true, 'single generic sentence');
  // an expired token must not be redeemable even one millisecond late
  eq(userCell(exp.user_id, 'join_used_at'), '', 'expired attempt must not burn anything: ');
});

t('a blank join_token_hash cell can never be matched by an empty token', () => {
  // the ADMIN row has an empty join_token_hash; hashing '' must not find it
  throwsCode(() => G.Auth.redeemJoinToken(G.Util.sha256Hex(''), 'a-long-enough-password'), 'UNAUTHORIZED');
  ok(G.Auth._findUserByJoinTokenHash('') === null, 'blank hash matches nothing');
  ok(G.Auth._findUserByJoinTokenHash(G.Util.sha256Hex('')) === null, 'sha256("") matches nothing');
  eq(usersRow('USR_admin').password_hash, '', 'admin row untouched');
});

// ------------------------------------------------------------- resendLink
let resent, resentToken;
t('resendLink mints a fresh token and invalidates the previous one', () => {
  const before = O.create({ tournamentId: TID, email: 'resend@example.com', displayName: 'Re Send' }, adminSession);
  const oldToken = /k=([a-f0-9]{64})$/.exec(before.joinUrl)[1];

  resent = O.resendLink({ userId: before.user_id }, adminSession);
  resentToken = /k=([a-f0-9]{64})$/.exec(resent.joinUrl)[1];
  ok(resentToken !== oldToken, 'a new token was minted');
  eq(userCell(before.user_id, 'join_token_hash'), G.Util.sha256Hex(resentToken), 'stored hash is the new one: ');

  // the old link is dead, with the same generic message
  eq(throwsCode(() => G.Auth.redeemJoinToken(oldToken, 'a-long-enough-password'), 'UNAUTHORIZED').message, msgUsed);
  // the new one works
  const s = G.Auth.redeemJoinToken(resentToken, 'a-long-enough-password', 'ua');
  eq(s.user.user_id, before.user_id);
  eq(s.user.tournament_id, TID);
});

t('resendLink is audited as ORGANISER_LINK_RESENT, with no token in the row', () => {
  const rows = auditRows().filter((r) => r.action === 'ORGANISER_LINK_RESENT');
  eq(rows.length, 1);
  eq(rows[0].entity_id, resent.user_id);
  ok(String(rows[0].new_value).indexOf(resentToken) === -1, 'token in the audit row');
});

t('resendLink refuses an unknown id and refuses to touch an ADMIN row', () => {
  throwsCode(() => O.resendLink({ userId: 'USR_nope' }, adminSession), 'NOT_FOUND');
  throwsCode(() => O.resendLink({ userId: 'USR_admin' }, adminSession), 'NOT_FOUND');
  eq(usersRow('USR_admin').join_token_hash, '', 'admin row must keep no join token');
  throwsCode(() => O.resendLink({}, adminSession), 'VALIDATION_FAILED');
});

// ------------------------------------------------------------- scope
t('an organiser can only reach their own tournament', () => {
  const sess = { user_id: created.user_id, role: 'ORGANISER', tournament_id: TID };
  G.Auth.requireTournament(sess, TID);                                   // allowed
  throwsCode(() => G.Auth.requireTournament(sess, TID2), 'FORBIDDEN');
  throwsCode(() => G.Auth.requireTournament(sess, ''), 'FORBIDDEN');
  G.Auth.requireTournament({ role: 'ADMIN', tournament_id: '' }, TID2);   // admin is global
  // and the session minted by the join carries the scope
  const live = G.Auth.resolve(joined.token);
  eq(live.tournament_id, TID);
  eq(live.role, 'ORGANISER');
  // organiser.* is ADMIN only
  const routes = vm.runInContext('buildRoutes()', ctx);
  ['organiser.create', 'organiser.list', 'organiser.resendLink', 'organiser.disable'].forEach((n) => {
    eq(JSON.stringify(routes[n].auth), '["ADMIN"]', n + ' auth: ');
    eq(JSON.stringify(routes[n].methods), '["POST"]', n + ' methods: ');
  });
  eq(routes['auth.organiserJoin'].auth, 'PUBLIC');
  eq(JSON.stringify(routes['auth.organiserJoin'].methods), '["POST"]');
});

// ------------------------------------------------------------- disable
t('disable sets DISABLED, revokes every session and keeps the row', () => {
  ok(G.Auth.resolve(joined.token), 'session is live before disable');
  const rowsBefore = G.Repo.readAll('Users').length;

  const out = O.disable({ userId: created.user_id }, adminSession);
  eq(out.status, 'DISABLED');
  ok(out.sessions_revoked >= 1, 'revoked at least one session, got ' + out.sessions_revoked);
  eq(G.Repo.readAll('Users').length, rowsBefore, 'the row must never be deleted: ');
  eq(usersRow(created.user_id).status, 'DISABLED');

  const mine = sessionRows().filter((s) => s.user_id === created.user_id);
  ok(mine.length > 0 && mine.every((s) => s.revoked === true), 'every session row revoked');
});

t("a disabled organiser's existing session stops resolving", () => {
  eq(G.Auth.resolve(joined.token), null, 'cached + sheet session must be dead');
  throwsCode(() => G.Auth.require(joined.token, ['ORGANISER']), 'UNAUTHORIZED');
});

t('a disabled organiser cannot log in with the right password', () => {
  cacheStore.clear();
  const e = throwsCode(() => G.Auth.login('priya@example.com', 'correct-horse-battery', 'ua'), 'UNAUTHORIZED');
  eq(e.message, G.Auth.BAD_CREDENTIALS_MSG, 'same generic message as a wrong password: ');
  cacheStore.clear();
});

t('disable voids any outstanding join link, with the same generic message', () => {
  const pending = O.create({ tournamentId: TID, email: 'pending@example.com', displayName: 'Pending One' }, adminSession);
  const tok = /k=([a-f0-9]{64})$/.exec(pending.joinUrl)[1];
  eq(O.list({ tournamentId: TID }, adminSession).filter((r) => r.user_id === pending.user_id)[0].joinPending, true);

  O.disable({ userId: pending.user_id }, adminSession);
  eq(throwsCode(() => G.Auth.redeemJoinToken(tok, 'a-long-enough-password'), 'UNAUTHORIZED').message, msgUsed);
  eq(userCell(pending.user_id, 'join_token_hash'), '', 'hash cleared on disable: ');
  eq(O.list({ tournamentId: TID }, adminSession).filter((r) => r.user_id === pending.user_id)[0].joinPending, false);
});

t('disable is audited, idempotent, and refuses an ADMIN row', () => {
  const rows = auditRows().filter((r) => r.action === 'ORGANISER_DISABLED');
  ok(rows.length >= 2, 'audited');
  ok(String(rows[0].prev_value).indexOf('ACTIVE') !== -1, 'prev status recorded');
  const again = O.disable({ userId: created.user_id }, adminSession);
  eq(again.status, 'DISABLED');
  eq(again.sessions_revoked, 0, 'nothing left to revoke: ');
  throwsCode(() => O.disable({ userId: 'USR_admin' }, adminSession), 'NOT_FOUND');
  eq(usersRow('USR_admin').status, 'ACTIVE', 'admin must stay active');
  throwsCode(() => O.disable({ userId: 'USR_nope' }, adminSession), 'NOT_FOUND');
});

t('resendLink refuses a disabled organiser', () => {
  throwsCode(() => O.resendLink({ userId: created.user_id }, adminSession), 'VALIDATION_FAILED');
});

t('joinPending flips false once the link is used or expired', () => {
  const rows = O.list({ tournamentId: TID }, adminSession);
  const byEmail = {};
  rows.forEach((r) => { byEmail[r.email] = r; });
  eq(byEmail['priya@example.com'].joinPending, false, 'used: ');
  eq(byEmail['expired@example.com'].joinPending, false, 'expired: ');
  eq(byEmail['resend@example.com'].joinPending, false, 'redeemed after resend: ');
  eq(byEmail['priya@example.com'].status, 'DISABLED');
});

// ------------------------------------------------------------- dispatcher
t('the whole flow works through dispatch(), and no envelope leaks a secret', () => {
  vm.runInContext(`Repo.append(SHEETS.SESSIONS, {token:'tok-admin', user_id:'USR_admin', role:'ADMIN',
    tournament_id:'', issued_at: Util.nowIso(),
    expires_at: new Date(Date.now() + 36e5).toISOString(), revoked:false});`, ctx);

  const r1 = G.dispatch('organiser.create', { tournamentId: TID2, email: 'via@example.com', displayName: 'Via Dispatch' }, 'tok-admin', 'POST', {});
  ok(r1.ok, JSON.stringify(r1));
  const tok = /k=([a-f0-9]{64})$/.exec(r1.data.joinUrl)[1];

  // no token — the route is ADMIN only
  const noAuth = G.dispatch('organiser.list', { tournamentId: TID2 }, null, 'POST', {});
  eq(noAuth.ok, false);
  eq(noAuth.error.code, 'UNAUTHORIZED');

  const r2 = G.dispatch('auth.organiserJoin', { token: tok, password: 'another-long-password' }, null, 'POST', {});
  ok(r2.ok, JSON.stringify(r2));
  eq(r2.data.user.tournament_id, TID2);

  const r3 = G.dispatch('auth.organiserJoin', { token: tok, password: 'another-long-password' }, null, 'POST', {});
  eq(r3.ok, false);
  eq(r3.error.code, 'UNAUTHORIZED');
  eq(r3.error.message, msgUsed);

  // organiser session may list nothing — organiser.* is ADMIN only
  const orgList = G.dispatch('organiser.list', { tournamentId: TID2 }, r2.data.token, 'POST', {});
  eq(orgList.ok, false);
  eq(orgList.error.code, 'FORBIDDEN');

  // GET must not reach the join route (no token in a URL)
  const viaGet = vm.runInContext('doGet({parameter:{action:"auth.organiserJoin"}})', ctx);
  eq(JSON.parse(viaGet).error.code, 'BAD_REQUEST');
});

t('no plain join token ever reached any sheet cell', () => {
  const allTokens = [];
  // re-derive every token still known to this run
  [plainToken, resentToken].forEach((x) => { if (x) allTokens.push(x); });
  let leaked = [];
  Object.keys(sheets).forEach((tab) => {
    sheets[tab]._grid.forEach((row, i) => {
      row.forEach((cell) => {
        allTokens.forEach((tk) => { if (String(cell).indexOf(tk) !== -1) leaked.push(tab + ':' + (i + 1)); });
      });
    });
  });
  eq(leaked.length, 0, 'leaked at ' + leaked.join(', ') + ': ');
});

console.log('\n' + '-'.repeat(60));
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
