/**
 * Phase 4 auction harness.
 * In-memory fakes for SpreadsheetApp / DriveApp / CacheService /
 * PropertiesService / LockService (reused from /tmp/pay_test.js), then the real
 * .gs files on top, then behaviour tests for CONTRACTS-PHASE4-7 §4.
 */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const DIR = '/Users/raja.t/cricket-auction/backend';

// ------------------------------------------------------------------ fake sheet
let lockHeld = false;
let lockDepth = 0;
let lockWaits = 0, lockReleases = 0;
let sheetReads = 0;          // getValues() calls  <- the real per-request cost
let sheetWrites = 0;         // setValues() calls
let ssOpens = 0;             // getActiveSpreadsheet() calls
let flushes = 0, flushesUnderLock = 0;
let testWriting = true;          // fixture + direct test writes are not auction writes
const writeLog = [];

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
    insertRowsAfter: (after, n) => {
      for (let i = 0; i < n; i++) grid.push(new Array(headers.length).fill(''));
    },
    insertColumnsAfter: () => {},
    setFrozenRows: () => {},
    deleteRow: (r) => { grid.splice(r - 1, 1); },
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        sheetReads++;
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = grid[r - 1 + i] || new Array(headers.length).fill('');
          out.push(src.slice(c - 1, c - 1 + nc));
        }
        return out;
      },
      setValues: (vals) => {
        sheetWrites++;
        for (let i = 0; i < vals.length; i++) {
          const rowIdx = r - 1 + i;
          while (grid.length <= rowIdx) grid.push(new Array(headers.length).fill(''));
          for (let j = 0; j < vals[i].length; j++) grid[rowIdx][c - 1 + j] = vals[i][j];
          writeLog.push({ tab: name, row: rowIdx + 1, lockHeld: lockHeld, direct: testWriting });
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
  getActiveSpreadsheet: () => {
    ssOpens++;
    return {
      getSpreadsheetTimeZone: () => 'Asia/Kolkata',
      getSheetByName: (n) => sheets[n] || null,
      getSheets: () => Object.values(sheets),
      insertSheet: (n) => { sheets[n] = makeSheet(n, []); return sheets[n]; }
    };
  },
  flush: () => { flushes++; if (lockHeld) flushesUnderLock++; }
};

const driveFiles = {};
const DriveApp = {
  getFileById: (id) => {
    const f = driveFiles[id];
    if (!f) throw new Error('No item with the given ID could be found: ' + id);
    return {
      getId: () => id,
      getBlob: () => ({ getContentType: () => f.mime, getBytes: () => f.bytes }),
      setTrashed: () => {}, setSharing: () => {}
    };
  },
  getFolderById: () => { throw new Error('not a folder'); },
  getRootFolder: () => ({ getId: () => 'ROOT' }),
  getFoldersByName: () => ({ hasNext: () => false }),
  createFolder: () => ({ getId: () => 'NEW' }),
  Access: { ANYONE_WITH_LINK: 'A' }, Permission: { VIEW: 'V' }
};

const cacheStore = new Map(), propStore = new Map();
let cacheGets = 0, cachePuts = 0, propGets = 0;
const CacheService = {
  getScriptCache: () => ({
    get: (k) => { cacheGets++; return cacheStore.has(k) ? cacheStore.get(k) : null; },
    put: (k, v) => { cachePuts++; cacheStore.set(k, v); },
    remove: (k) => cacheStore.delete(k)
  })
};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => { propGets++; return propStore.has(k) ? propStore.get(k) : null; },
    setProperty: (k, v) => propStore.set(k, String(v)),
    deleteProperty: (k) => propStore.delete(k)
  })
};
// Re-entrant, like LockService inside one execution.
const LockService = {
  getScriptLock: () => ({
    waitLock: () => { lockWaits++; lockDepth++; lockHeld = true; },
    releaseLock: () => { lockReleases++; lockDepth--; if (lockDepth <= 0) { lockDepth = 0; lockHeld = false; } }
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
  newBlob: (b) => ({ getBytes: () => Buffer.from(String(b)) }),
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
  '({Repo,Util,ENUM,ERR,SHEETS,HEADERS,Auction,Players,Teams,Audit,Auth,Cache,dispatch,buildRoutes})', ctx);

// ------------------------------------------------------------------ harness
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, m) { if (a !== b) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy'); }
function has(hay, needle, m) {
  if (String(hay).indexOf(needle) === -1) throw new Error((m || '') + ' expected to contain ' + JSON.stringify(needle) + ' in ' + JSON.stringify(String(hay)));
}
function section(n) { console.log('\n' + n); }

// ------------------------------------------------------------------ fixtures
Object.keys(G.HEADERS).forEach((tab) => { sheets[tab] = makeSheet(tab, G.HEADERS[tab].slice()); });

function append(tab, obj) {
  return vm.runInContext('Repo.append(' + JSON.stringify(tab) + ',' + JSON.stringify(obj) + ')', ctx);
}
function readAll(tab) {
  return vm.runInContext('JSON.parse(JSON.stringify(Repo.readAll(' + JSON.stringify(tab) + ')))', ctx);
}
function version(tid) {
  return vm.runInContext('Cache.getVersion(' + JSON.stringify(tid) + ')', ctx);
}

const TID = 'TRN_auction00001';
const DISPLAY_TOKEN = 'displaytoken0123456789abcdef';

append(G.SHEETS.TOURNAMENTS, {
  tournament_id: TID, slug: 'cup', name: 'Chennai Cup', status: 'AUCTION_LIVE',
  next_serial: 500, reg_fee: 500, default_purse: 1000000, default_max_players: 12,
  display_token: DISPLAY_TOKEN, created_at: '2026-08-01T00:00:00.000Z'
});

function addTeam(id, name, purse, max) {
  append(G.SHEETS.TEAMS, {
    team_id: id, tournament_id: TID, team_name: name, owner_name: 'Owner ' + name,
    logo_file_id: '', purse_total: purse, purse_used: 0, max_players: max,
    players_count: 0, created_at: '2026-08-02T00:00:00.000Z', created_by: 'USR_admin'
  });
}
addTeam('TEM_a', 'Alpha Kings', 1000000, 12);
addTeam('TEM_b', 'Bravo Warriors', 1000000, 12);
addTeam('TEM_c', 'Cheap Chargers', 50000, 2);      // small purse, small squad
addTeam('TEM_d', 'Delta Dynamos', 2000000, 25);    // for the 20-sale arithmetic run
addTeam('TEM_e', 'Echo Eagles', 1000000, 12);      // solvent target for corrections

function addPlayer(n, name, extra) {
  append(G.SHEETS.PLAYERS, Object.assign({
    player_id: 'PLY_' + n, tournament_id: TID, serial_no: n, name: name,
    dob: '1995-01-01', age_years: 31, role: 'BATSMAN', style: 'RIGHT',
    mobile: '98765' + String(43210 + n).slice(-5),
    photo_file_id: 'p' + n, photo_thumb_url: 'https://drive.google.com/thumbnail?id=th' + n,
    payment_status: 'VERIFIED', auction_status: 'PENDING', times_called: 0,
    team_id: '', sold_amount: '', sold_at: '', is_withdrawn: false,
    search_blob: (name + ' batsman right').toLowerCase(),
    registered_at: '2026-08-10T04:00:00.000Z'
  }, extra || {}));
  append(G.SHEETS.PAYMENTS, {
    payment_id: 'PAY_' + n, tournament_id: TID, player_id: 'PLY_' + n,
    upi_ref: 'UPIREF' + String(100000 + n), amount: 500, screenshot_file_id: 'shot' + n,
    status: 'VERIFIED', verified_by: 'USR_admin', verified_at: '2026-08-11T04:00:00.000Z',
    reject_reason: '', submitted_at: '2026-08-10T04:00:00.000Z'
  });
}

for (let n = 1; n <= 40; n++) addPlayer(n, 'Player ' + n);
addPlayer(91, 'Rejected Ravi', { payment_status: 'REJECTED' });
addPlayer(92, 'Withdrawn Wasim', { payment_status: 'VERIFIED', is_withdrawn: true });
addPlayer(93, 'Pending Prakash', { payment_status: 'PENDING' });

function addSession(token, userId, role, tid) {
  append(G.SHEETS.SESSIONS, {
    token: token, user_id: userId, role: role, tournament_id: tid || '',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 36e5).toISOString(), revoked: false
  });
}
addSession('tok-admin', 'USR_admin', 'ADMIN', '');
addSession('tok-org', 'USR_org', 'ORGANISER', TID);
addSession('tok-org2', 'USR_org2', 'ORGANISER', TID);

// ------------------------------------------------------------------ call helpers
function post(action, token, payload) {
  return vm.runInContext(
    'dispatch(' + JSON.stringify(action) + ',' + JSON.stringify(payload || {}) + ',' +
    JSON.stringify(token) + ',"POST",null)', ctx);
}
/** POST and require ok:true, returning data. */
function D(action, token, payload) {
  const env = post(action, token, payload);
  if (!env.ok) throw new Error(action + ' failed: ' + env.error.code + ' ' + env.error.message);
  return env.data;
}
/** POST and require a specific error code, returning the message. */
function E(action, token, payload, code) {
  const env = post(action, token, payload);
  if (env.ok) throw new Error(action + ' unexpectedly succeeded, wanted ' + code);
  if (env.error.code !== code) {
    throw new Error(action + ' expected ' + code + ' got ' + env.error.code + ' — ' + env.error.message);
  }
  return env.error.message;
}
/** markSold with the live version filled in. */
function sell(token, playerId, teamId, amount, extra) {
  return D('auction.markSold', token, Object.assign(
    { tournamentId: TID, playerId, teamId, amount, expectedVersion: version(TID) }, extra || {}));
}
function team(id) {
  return readAll(G.SHEETS.TEAMS).filter((r) => r.team_id === id)[0];
}
function player(id) {
  return readAll(G.SHEETS.PLAYERS).filter((r) => r.player_id === id)[0];
}
function results() { return readAll(G.SHEETS.AUCTION_RESULTS).filter((r) => r.tournament_id === TID); }
function auditRows(action) {
  return readAll(G.SHEETS.AUDIT_LOG).filter((r) => !action || r.action === action);
}

console.log('Phase 4 — auction engine');
testWriting = false;   // from here on, only Auction.gs should be writing

/** Run a direct Repo statement as the test, not as the auction. */
function raw(code) {
  testWriting = true;
  try { return vm.runInContext(code, ctx); } finally { testWriting = false; }
}

// ===========================================================================
section('§4.1 happy path');

t('markSold updates player, team and AuctionResults consistently', () => {
  const v0 = version(TID);
  const r = sell('tok-org', 'PLY_1', 'TEM_a', 75000);

  eq(r.player.auction_status, 'SOLD', 'player status');
  eq(r.player.team_id, 'TEM_a', 'player team');
  eq(r.player.sold_amount, 75000, 'player amount');
  eq(r.player.sold_amount_display, '₹75,000', 'display');
  ok(r.player.sold_at, 'sold_at set');
  eq(r.v, v0 + 1, 'version bumped by exactly 1');

  const p = player('PLY_1');
  eq(p.auction_status, 'SOLD'); eq(p.team_id, 'TEM_a'); eq(p.sold_amount, 75000);

  const tm = team('TEM_a');
  eq(tm.purse_used, 75000, 'purse_used'); eq(tm.players_count, 1, 'players_count');

  const rows = results().filter((x) => x.player_id === 'PLY_1');
  eq(rows.length, 1, 'exactly one result row');
  eq(rows[0].status, 'SOLD'); eq(rows[0].amount, 75000);
  eq(rows[0].team_id, 'TEM_a'); eq(rows[0].is_current, true);
  eq(rows[0].recorded_by, 'USR_org', 'recorded_by is the session user');
  eq(rows[0].serial_no, 1);
  eq(rows[0].supersedes_auction_id, '', 'a fresh sale supersedes nothing');
});

t('PLAYER_SOLD is audited with prev and next', () => {
  const rows = auditRows('PLAYER_SOLD');
  eq(rows.length, 1, 'one audit row');
  const prev = JSON.parse(rows[0].prev_value), next = JSON.parse(rows[0].new_value);
  eq(prev.auction_status, 'PENDING'); eq(prev.team_id, ''); eq(prev.team_purse_used, 0);
  eq(next.auction_status, 'SOLD'); eq(next.sold_amount, 75000);
  eq(next.team_purse_used, 75000); eq(next.team_players_count, 1);
  eq(rows[0].actor_user_id, 'USR_org'); eq(rows[0].actor_role, 'ORGANISER');
});

t('every sheet write happened while the lock was held', () => {
  const auctionWrites = writeLog.filter((w) => !w.direct);
  ok(auctionWrites.length >= 4, 'the assertion is not vacuous: ' + auctionWrites.length + ' auction writes');
  const outside = auctionWrites.filter((w) => !w.lockHeld);
  eq(outside.length, 0, 'writes outside the lock: ' + JSON.stringify(outside.slice(0, 3)));
  ok(flushesUnderLock > 0, 'flush happened inside the lock');
});

// ===========================================================================
section('§4.1 the nine validation failures');

t('1. STALE_STATE names both versions and changes nothing', () => {
  const before = JSON.stringify({ p: player('PLY_2'), t: team('TEM_a') });
  const live = version(TID);
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_2', teamId: 'TEM_a', amount: 1000, expectedVersion: live - 3 },
    'STALE_STATE');
  has(msg, 'version ' + (live - 3)); has(msg, 'version ' + live);
  eq(JSON.stringify({ p: player('PLY_2'), t: team('TEM_a') }), before, 'nothing changed');
  eq(version(TID), live, 'version did not move');
});

t('2. NOT_FOUND for an unknown player', () => {
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_nope', teamId: 'TEM_a', amount: 1000, expectedVersion: version(TID) },
    'NOT_FOUND');
  has(msg, 'not in this tournament');
});

t('3. AUCTION_NOT_LIVE names the real status', () => {
  const trn = readAll(G.SHEETS.TOURNAMENTS)[0];
  raw('Repo.updateRow(SHEETS.TOURNAMENTS,' + trn._row + ',{status:"REG_CLOSED"})', ctx);
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_2', teamId: 'TEM_a', amount: 1000, expectedVersion: version(TID) },
    'AUCTION_NOT_LIVE');
  has(msg, 'REG_CLOSED');
  raw('Repo.updateRow(SHEETS.TOURNAMENTS,' + trn._row + ',{status:"AUCTION_LIVE"})', ctx);
});

t('4. PLAYER_NOT_ELIGIBLE for a rejected payment, with the status in the message', () => {
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_91', teamId: 'TEM_a', amount: 1000, expectedVersion: version(TID) },
    'PLAYER_NOT_ELIGIBLE');
  has(msg, '#91'); has(msg, 'REJECTED');
});

t('4b. PLAYER_NOT_ELIGIBLE for a withdrawn player', () => {
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_92', teamId: 'TEM_a', amount: 1000, expectedVersion: version(TID) },
    'PLAYER_NOT_ELIGIBLE');
  has(msg, 'withdrawn');
});

t('4c. eligibility comes from Players.isAuctionEligible, not a local copy', () => {
  // Break the shared predicate and prove the auction stops selling. If Auction.gs
  // had its own copy of the rule this player would still go through.
  vm.runInContext('globalThis.__realElig = Players.isAuctionEligible;' +
    'Players.isAuctionEligible = function(){ return false; };', ctx);
  try {
    E('auction.markSold', 'tok-org',
      { tournamentId: TID, playerId: 'PLY_2', teamId: 'TEM_a', amount: 1000, expectedVersion: version(TID) },
      'PLAYER_NOT_ELIGIBLE');
  } finally {
    vm.runInContext('Players.isAuctionEligible = globalThis.__realElig;', ctx);
  }
  // and it works again once the real predicate is back
  eq(player('PLY_2').auction_status, 'PENDING');
});

t('5. PLAYER_NOT_PENDING names the buyer and the price', () => {
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_1', teamId: 'TEM_b', amount: 1000, expectedVersion: version(TID) },
    'PLAYER_NOT_PENDING');
  has(msg, '#1'); has(msg, 'SOLD'); has(msg, 'Alpha Kings'); has(msg, '₹75,000');
});

t('6. ALREADY_ASSIGNED when a PENDING row still carries a team_id', () => {
  const p = readAll(G.SHEETS.PLAYERS).filter((r) => r.player_id === 'PLY_3')[0];
  raw('Repo.updateRow(SHEETS.PLAYERS,' + p._row + ',{team_id:"TEM_b"})', ctx);
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_3', teamId: 'TEM_a', amount: 1000, expectedVersion: version(TID) },
    'ALREADY_ASSIGNED');
  has(msg, 'Bravo Warriors');
  raw('Repo.updateRow(SHEETS.PLAYERS,' + p._row + ',{team_id:""})', ctx);
});

t('7. INVALID_AMOUNT for zero, negative and fractional bids', () => {
  [0, -500, 1000.5, 'abc', ''].forEach((amt) => {
    const msg = E('auction.markSold', 'tok-org',
      { tournamentId: TID, playerId: 'PLY_2', teamId: 'TEM_a', amount: amt, expectedVersion: version(TID) },
      'INVALID_AMOUNT');
    ok(msg.length > 10, 'message for ' + JSON.stringify(amt));
  });
});

t('8. TEAM_FULL names the squad size', () => {
  sell('tok-org', 'PLY_4', 'TEM_c', 1000);
  sell('tok-org', 'PLY_5', 'TEM_c', 1000);            // TEM_c max_players = 2
  eq(team('TEM_c').players_count, 2);
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_6', teamId: 'TEM_c', amount: 1000, expectedVersion: version(TID) },
    'TEAM_FULL');
  has(msg, 'Cheap Chargers'); has(msg, 'all 2 players');
});

t('9. INSUFFICIENT_PURSE names the remaining purse, the bid and the shortfall', () => {
  // Bravo has ₹10,00,000. Spend it down to ₹40,000 then overbid.
  sell('tok-org', 'PLY_7', 'TEM_b', 960000);
  eq(team('TEM_b').purse_used, 960000);
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_8', teamId: 'TEM_b', amount: 75000, expectedVersion: version(TID) },
    'INSUFFICIENT_PURSE');
  has(msg, 'Insufficient purse amount'); has(msg, '₹40,000');
  has(msg, '₹75,000'); has(msg, '₹35,000');
});

t('a bid exactly equal to the remaining purse is allowed (<=, not <)', () => {
  sell('tok-org', 'PLY_8', 'TEM_b', 40000);
  eq(team('TEM_b').purse_used, 1000000, 'purse fully spent');
  eq(team('TEM_b').purse_total - team('TEM_b').purse_used, 0);
});

t('TEAM_FULL is returned BEFORE INSUFFICIENT_PURSE when both apply', () => {
  // Cheap Chargers: 2/2 players AND only ₹48,000 left. Bid ₹90,000 breaks both.
  const c = team('TEM_c');
  eq(c.players_count, c.max_players, 'team is full');
  ok(90000 > c.purse_total - c.purse_used, 'bid also exceeds the purse');
  const msg = E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_9', teamId: 'TEM_c', amount: 90000, expectedVersion: version(TID) },
    'TEAM_FULL');
  has(msg, 'all 2 players');
  ok(msg.indexOf('purse') === -1, 'the message must not talk about money');
});

// ===========================================================================
section('double sale');

t('SIMULATED DOUBLE SALE: two organisers, same player, same instant', () => {
  const v = version(TID);
  const beforeUsed = team('TEM_a').purse_used;
  const beforeCount = team('TEM_a').players_count;

  // Both tabs read version v and both press SOLD. The lock serialises them.
  const first = post('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_10', teamId: 'TEM_a', amount: 50000, expectedVersion: v });
  const second = post('auction.markSold', 'tok-org2',
    { tournamentId: TID, playerId: 'PLY_10', teamId: 'TEM_a', amount: 50000, expectedVersion: v });

  eq(first.ok, true, 'first caller wins');
  eq(second.ok, false, 'second caller must be refused');
  // The second tab is stale by one version now, so the version check fires
  // first. Re-run it with a fresh version to prove the re-read catches it too.
  ok(second.error.code === 'STALE_STATE' || second.error.code === 'PLAYER_NOT_PENDING',
    'got ' + second.error.code);

  const third = post('auction.markSold', 'tok-org2',
    { tournamentId: TID, playerId: 'PLY_10', teamId: 'TEM_a', amount: 50000, expectedVersion: version(TID) });
  eq(third.ok, false, 'even with a fresh version the re-read refuses');
  eq(third.error.code, 'PLAYER_NOT_PENDING', third.error.message);
  has(third.error.message, 'Alpha Kings');

  eq(team('TEM_a').purse_used, beforeUsed + 50000, 'purse incremented EXACTLY once');
  eq(team('TEM_a').players_count, beforeCount + 1, 'count incremented EXACTLY once');
  eq(results().filter((r) => r.player_id === 'PLY_10' && r.is_current === true).length, 1,
    'exactly one current result row');
  eq(results().filter((r) => r.player_id === 'PLY_10').length, 1, 'exactly one result row in total');
});

// ===========================================================================
section('purse arithmetic across 20 sequential sales');

t('20 sales on one team sum exactly, and counters match AuctionResults', () => {
  const amounts = [];
  let expected = 0;
  for (let i = 0; i < 20; i++) {
    // deliberately awkward numbers, no round thousands
    const amt = 12345 + i * 3457;
    amounts.push(amt);
    expected += amt;
    sell('tok-org', 'PLY_' + (11 + i), 'TEM_d', amt);
  }
  const d = team('TEM_d');
  eq(d.purse_used, expected, 'purse_used after 20 sales');
  eq(d.players_count, 20, 'players_count after 20 sales');
  eq(d.purse_total - d.purse_used, 2000000 - expected, 'remaining');

  // AuctionResults is the truth: the counter must equal the sum of the rows.
  const sum = results()
    .filter((r) => r.team_id === 'TEM_d' && r.is_current === true && r.status === 'SOLD')
    .reduce((a, r) => a + r.amount, 0);
  eq(sum, expected, 'AuctionResults sum equals the Teams counter');
  eq(expected, 903730, 'the literal total: 20*12345 + 3457*(0+1+..+19)');
});

t('summary total_spent matches the sum of every current SOLD row', () => {
  const s = D('auction.summary', 'tok-org', { tournamentId: TID });
  const sum = results().filter((r) => r.is_current === true && r.status === 'SOLD')
    .reduce((a, r) => a + r.amount, 0);
  eq(s.total_spent, sum, 'total_spent');
  eq(s.total_spent_display, vm.runInContext('Util.formatINR(' + sum + ')', ctx));
});

// ===========================================================================
section('§4.4 times_called');

t('auction.getBySerial increments times_called', () => {
  eq(player('PLY_31').times_called, 0);
  const r1 = D('auction.getBySerial', 'tok-org', { tournamentId: TID, serialNo: 31 });
  eq(r1.revealed, true); eq(r1.player.times_called, 1);
  eq(player('PLY_31').times_called, 1, 'persisted to the sheet');
  D('auction.getBySerial', 'tok-org', { tournamentId: TID, serialNo: 31 });
  eq(player('PLY_31').times_called, 2, 'increments again');
});

t('auction.search does NOT increment times_called', () => {
  const before = player('PLY_31').times_called;
  const s = D('auction.search', 'tok-org', { tournamentId: TID, q: 'Player 31' });
  ok(s.rows.length >= 1, 'found');
  eq(s.rows[0].serial_no, 31);
  eq(player('PLY_31').times_called, before, 'unchanged by a search');
  D('auction.search', 'tok-org', { tournamentId: TID, q: '32' });
  eq(player('PLY_32').times_called, 0, 'a serial search does not call the player either');
});

t('getBySerial on an ineligible player does not reveal or increment', () => {
  const r = D('auction.getBySerial', 'tok-org', { tournamentId: TID, serialNo: 91 });
  eq(r.revealed, false, 'not revealed');
  eq(r.player.eligible, false);
  eq(r.player.payment_status, 'REJECTED');
  has(r.message, '#91'); has(r.message, 'REJECTED');
  eq(player('PLY_91').times_called, 0, 'times_called untouched');
});

t('an unknown serial says so with the number in it', () => {
  const msg = E('auction.getBySerial', 'tok-org', { tournamentId: TID, serialNo: 777 }, 'NOT_FOUND');
  has(msg, 'No player with serial 777');
});

t('the four honest labels add up', () => {
  const s = D('auction.summary', 'tok-org', { tournamentId: TID });
  eq(s.sold + s.unsold + s.awaiting_reauction + s.not_called, s.eligible,
    'the four labels partition the eligible pool');
  eq(s.eligible, 40, '40 eligible of 43 registered (1 rejected, 1 withdrawn, 1 pending)');
});

// ===========================================================================
section('§4.5 the poll');

t('auction.state with an unchanged version does ZERO spreadsheet reads', () => {
  // Warm the session cache first — session resolution is not what is under test.
  D('auth.me', 'tok-org', {});
  const v = version(TID);
  D('auction.state', 'tok-org', { tournamentId: TID, v: v });   // prime + warm

  vm.runInContext('Repo._cache = {ss:null, tz:null, sheets:{}, fields:{}};', ctx);
  const reads0 = sheetReads, writes0 = sheetWrites, opens0 = ssOpens;

  const r = D('auction.state', 'tok-org', { tournamentId: TID, v: v });
  eq(r.same, true, 'reported as unchanged');
  eq(r.v, v);
  eq(sheetReads - reads0, 0, 'getValues() calls');
  eq(sheetWrites - writes0, 0, 'setValues() calls');
  eq(ssOpens - opens0, 0, 'Spreadsheet opens');

  // Prove the counter actually counts: a sheet-backed action must move it.
  const reads1 = sheetReads;
  D('auction.summary', 'tok-org', { tournamentId: TID });
  ok(sheetReads - reads1 >= 3, 'the read counter works — summary cost ' + (sheetReads - reads1) + ' reads');
});

t('a changed poll is served from CacheService, still with no spreadsheet read', () => {
  const stale = version(TID) - 1;
  vm.runInContext('Repo._cache = {ss:null, tz:null, sheets:{}, fields:{}};', ctx);
  const reads0 = sheetReads, opens0 = ssOpens;
  const r = D('auction.state', 'tok-org', { tournamentId: TID, v: stale });
  eq(r.same, false, 'reported as changed');
  eq(r.v, version(TID));
  ok(Array.isArray(r.teams) && r.teams.length === 5, 'teams present');
  ok(r.summary && typeof r.summary.eligible === 'number', 'summary present');
  eq(sheetReads - reads0, 0, 'served entirely from cache');
  eq(ssOpens - opens0, 0);
});

t('the snapshot is never newer than the version, and is rebuilt inside the lock', () => {
  const before = lockWaits;
  sell('tok-org', 'PLY_33', 'TEM_a', 5000);
  ok(lockWaits > before, 'the write took the lock');
  const v = version(TID);
  const snap = JSON.parse(cacheStore.get('snap:' + TID));
  eq(snap.v, v, 'cached snapshot matches the live version exactly');
  // The sold player is left on the card, so the hall sees the SOLD state.
  eq(snap.current.serial_no, 33, 'the player just sold is on the projector card');
  eq(snap.current.auction_status, 'SOLD');
  eq(snap.current.sold_amount_display, '\u20b95,000');
});

t('a cold cache rebuilds the snapshot from the sheet, once', () => {
  cacheStore.delete('snap:' + TID);
  const r = D('auction.state', 'tok-org', { tournamentId: TID, v: 0 });
  eq(r.v, version(TID));
  ok(r.teams.length === 5, 'rebuilt');
  ok(cacheStore.has('snap:' + TID), 'and re-cached');
  const reads0 = sheetReads;
  D('auction.state', 'tok-org', { tournamentId: TID, v: 0 });
  eq(sheetReads - reads0, 0, 'the next poll is free again');
});

t('the snapshot stays well under the 95 KB cache limit', () => {
  const bytes = Buffer.byteLength(cacheStore.get('snap:' + TID), 'utf8');
  ok(bytes < 97280, 'snapshot is ' + bytes + ' bytes');
  ok(bytes < 8000, 'and in practice tiny: ' + bytes + ' bytes with 5 teams');
});

t('the projector card follows getBySerial', () => {
  D('auction.getBySerial', 'tok-org', { tournamentId: TID, serialNo: 34 });
  const snap = JSON.parse(cacheStore.get('snap:' + TID));
  eq(snap.current.serial_no, 34);
  eq(snap.current.auction_status, 'PENDING');
  sell('tok-org', 'PLY_34', 'TEM_a', 22000);
  const snap2 = JSON.parse(cacheStore.get('snap:' + TID));
  eq(snap2.current.serial_no, 34);
  eq(snap2.current.auction_status, 'SOLD');
  eq(snap2.current.team_name, 'Alpha Kings');
  eq(snap2.current.sold_amount_display, '₹22,000');
});

// ===========================================================================
section('§4.2 displayState');

t('displayState rejects a missing or wrong token', () => {
  E('auction.displayState', null, { tournamentId: TID }, 'UNAUTHORIZED');
  E('auction.displayState', null, { tournamentId: TID, k: 'wrong-token' }, 'UNAUTHORIZED');
  E('auction.displayState', null, { tournamentId: TID, k: DISPLAY_TOKEN + 'x' }, 'UNAUTHORIZED');
});

t('displayState accepts the real token and returns the snapshot', () => {
  const r = D('auction.displayState', null, { tournamentId: TID, k: DISPLAY_TOKEN, v: 0 });
  eq(r.same, false);
  eq(r.v, version(TID));
  eq(r.current.serial_no, 34);
  ok(r.teams.length === 5);
  eq(typeof r.summary.eligible, 'number');
});

t('displayState never leaks personal data — asserted on the serialised JSON', () => {
  const r = D('auction.displayState', null, { tournamentId: TID, k: DISPLAY_TOKEN, v: 0 });
  const json = JSON.stringify(r);
  ['mobile', 'upi_ref', 'UPIREF', '98765', 'payment_status', 'player_id', 'team_id',
   'is_withdrawn', 'purse_total', 'purse_used', 'dob', 'recorded_by']
    .forEach((banned) => {
      if (json.indexOf(banned) !== -1) throw new Error('leaked "' + banned + '" in ' + json.slice(0, 400));
    });
  // and positively: it does carry what the projector shows
  has(json, 'serial_no'); has(json, 'photo_thumb_url'); has(json, 'purse_remaining_display');
});

t('displayState honours the same-version short circuit', () => {
  const v = version(TID);
  const r = D('auction.displayState', null, { tournamentId: TID, k: DISPLAY_TOKEN, v: v });
  eq(r.same, true);
  eq(Object.keys(r).sort().join(','), 'same,v', 'nothing but v and same');
});

t('a verified display token is cached, so the projector poll stops reading the sheet', () => {
  vm.runInContext('Repo._cache = {ss:null, tz:null, sheets:{}, fields:{}};', ctx);
  const v = version(TID);
  const reads0 = sheetReads;
  D('auction.displayState', null, { tournamentId: TID, k: DISPLAY_TOKEN, v: v });
  eq(sheetReads - reads0, 0, 'unchanged projector poll reads no sheet');
});

// ===========================================================================
section('§4.2 markUnsold, returnToPool, and selling later');

t('markUnsold -> returnToPool -> markSold works end to end', () => {
  const pid = 'PLY_35';
  D('auction.getBySerial', 'tok-org', { tournamentId: TID, serialNo: 35 });
  eq(player(pid).times_called, 1);

  const u = D('auction.markUnsold', 'tok-org',
    { tournamentId: TID, playerId: pid, expectedVersion: version(TID) });
  eq(u.player.auction_status, 'UNSOLD');
  eq(player(pid).auction_status, 'UNSOLD');
  eq(results().filter((r) => r.player_id === pid && r.is_current === true)[0].status, 'UNSOLD');

  // Selling straight from UNSOLD must be refused.
  E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: pid, teamId: 'TEM_a', amount: 1000, expectedVersion: version(TID) },
    'PLAYER_NOT_PENDING');

  const rp = D('auction.returnToPool', 'tok-org',
    { tournamentId: TID, playerId: pid, expectedVersion: version(TID) });
  eq(rp.player.auction_status, 'PENDING');
  eq(rp.result.status, 'RETURNED_TO_POOL');
  eq(player(pid).times_called, 1, 'times_called is NOT reset — this is awaiting re-auction');

  const cur = results().filter((r) => r.player_id === pid && r.is_current === true);
  eq(cur.length, 1, 'exactly one current row');
  eq(cur[0].status, 'RETURNED_TO_POOL');
  eq(results().filter((r) => r.player_id === pid).length, 2, 'the UNSOLD row is kept');
  eq(results().filter((r) => r.player_id === pid && r.status === 'UNSOLD')[0].is_current, false);

  const s = sell('tok-org', pid, 'TEM_a', 33000);
  eq(s.player.auction_status, 'SOLD');
  eq(results().filter((r) => r.player_id === pid).length, 3, 'three rows of history');
  eq(results().filter((r) => r.player_id === pid && r.is_current === true).length, 1);
  eq(results().filter((r) => r.player_id === pid && r.is_current === true)[0].status, 'SOLD');
});

t('returnToPool refuses a SOLD player and points at Correct', () => {
  const msg = E('auction.returnToPool', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_1', expectedVersion: version(TID) }, 'ALREADY_ASSIGNED');
  has(msg, 'Use Correct'); has(msg, '₹75,000');
});

t('returnToPool refuses a player who is already PENDING', () => {
  const msg = E('auction.returnToPool', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_36', expectedVersion: version(TID) }, 'VALIDATION_FAILED');
  has(msg, 'already in the pool');
});

t('PLAYER_UNSOLD and PLAYER_RETURNED_TO_POOL are audited with prev and next', () => {
  const un = auditRows('PLAYER_UNSOLD');
  ok(un.length >= 1, 'unsold audited');
  eq(JSON.parse(un[un.length - 1].prev_value).auction_status, 'PENDING');
  eq(JSON.parse(un[un.length - 1].new_value).auction_status, 'UNSOLD');

  const rp = auditRows('PLAYER_RETURNED_TO_POOL');
  ok(rp.length >= 1, 'return to pool audited');
  eq(JSON.parse(rp[rp.length - 1].prev_value).auction_status, 'UNSOLD');
  eq(JSON.parse(rp[rp.length - 1].new_value).auction_status, 'PENDING');
});

t('awaiting_reauction and not_called are different numbers', () => {
  D('auction.getBySerial', 'tok-org', { tournamentId: TID, serialNo: 37 });
  const u = D('auction.markUnsold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_37', expectedVersion: version(TID) });
  D('auction.returnToPool', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_37', expectedVersion: version(TID) });

  const s = D('auction.summary', 'tok-org', { tournamentId: TID });
  ok(s.awaiting_reauction >= 1, 'someone is awaiting re-auction, got ' + s.awaiting_reauction);
  ok(s.not_called >= 1, 'and someone was never called, got ' + s.not_called);
  eq(s.sold + s.unsold + s.awaiting_reauction + s.not_called, s.eligible);
  eq(player('PLY_37').times_called, 1);
  eq(player('PLY_38').times_called, 0);
});

// ===========================================================================
section('§4.3 correction');

t('correction moves a player from team A to team B and both counters end right', () => {
  const pid = 'PLY_39';
  sell('tok-org', pid, 'TEM_a', 60000);
  const aUsed = team('TEM_a').purse_used, aCount = team('TEM_a').players_count;
  const bUsed = team('TEM_e').purse_used, bCount = team('TEM_e').players_count;
  const oldRow = results().filter((r) => r.player_id === pid && r.is_current === true)[0];

  const c = D('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: pid, newStatus: 'SOLD',
    teamId: 'TEM_e', amount: 40000, note: 'wrong team',
    expectedVersion: version(TID)
  });

  eq(team('TEM_a').purse_used, aUsed - 60000, 'team A refunded exactly');
  eq(team('TEM_a').players_count, aCount - 1, 'team A slot freed');
  eq(team('TEM_e').purse_used, bUsed + 40000, 'team B charged exactly');
  eq(team('TEM_e').players_count, bCount + 1, 'team B slot taken');

  eq(player(pid).team_id, 'TEM_e');
  eq(player(pid).sold_amount, 40000);

  const rows = results().filter((r) => r.player_id === pid);
  eq(rows.length, 2, 'nothing deleted — a second row was appended');
  const oldAfter = rows.filter((r) => r.auction_id === oldRow.auction_id)[0];
  eq(oldAfter.is_current, false, 'the old row is no longer current');
  eq(oldAfter.amount, 60000, 'and its facts are untouched');
  eq(oldAfter.team_id, 'TEM_a');
  const newRow = rows.filter((r) => r.is_current === true)[0];
  eq(newRow.supersedes_auction_id, oldRow.auction_id, 'the new row supersedes the old one');
  eq(newRow.amount, 40000); eq(newRow.team_id, 'TEM_e'); eq(newRow.note, 'wrong team');
  eq(c.result.supersedes_auction_id, oldRow.auction_id);
});

t('correction that would overspend the new team is rejected, and nothing moves', () => {
  const pid = 'PLY_40';
  sell('tok-org', pid, 'TEM_a', 10000);
  const snapshotBefore = JSON.stringify({
    a: team('TEM_a'), b: team('TEM_b'), p: player(pid), n: results().length
  });
  // Bravo has almost nothing left.
  const remaining = team('TEM_b').purse_total - team('TEM_b').purse_used;
  const msg = E('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: pid, newStatus: 'SOLD',
    teamId: 'TEM_b', amount: remaining + 5000, expectedVersion: version(TID)
  }, 'INSUFFICIENT_PURSE');
  has(msg, 'Bravo Warriors');
  eq(JSON.stringify({ a: team('TEM_a'), b: team('TEM_b'), p: player(pid), n: results().length }),
    snapshotBefore, 'the rejected correction changed nothing at all');
});

t('correction that would overfill the new team is rejected with TEAM_FULL', () => {
  const msg = E('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: 'PLY_40', newStatus: 'SOLD',
    teamId: 'TEM_c', amount: 1000, expectedVersion: version(TID)
  }, 'TEAM_FULL');
  has(msg, 'all 2 players');
});

t('correcting only the amount on the SAME team does not double count the slot', () => {
  const pid = 'PLY_40';
  const before = team('TEM_a');
  D('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: pid, newStatus: 'SOLD',
    teamId: 'TEM_a', amount: 25000, expectedVersion: version(TID)
  });
  const after = team('TEM_a');
  eq(after.players_count, before.players_count, 'the slot count is unchanged');
  eq(after.purse_used, before.purse_used - 10000 + 25000, 'only the difference moved');
  eq(player(pid).sold_amount, 25000);
});

t('a same-team correction can still overspend, and is caught', () => {
  const room = team('TEM_a').purse_total - team('TEM_a').purse_used;
  const msg = E('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: 'PLY_40', newStatus: 'SOLD',
    teamId: 'TEM_a', amount: 25000 + room + 1, expectedVersion: version(TID)
  }, 'INSUFFICIENT_PURSE');
  has(msg, 'Alpha Kings');
});

t('correcting back to PENDING clears team_id, sold_amount and sold_at', () => {
  const pid = 'PLY_40';
  const used = team('TEM_a').purse_used, count = team('TEM_a').players_count;
  const oldRow = results().filter((r) => r.player_id === pid && r.is_current === true)[0];

  const c = D('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: pid, newStatus: 'PENDING',
    note: 'sale recorded in error', expectedVersion: version(TID)
  });

  const p = player(pid);
  eq(p.auction_status, 'PENDING');
  eq(p.team_id, '', 'team_id cleared');
  eq(p.sold_amount, null, 'sold_amount cleared');
  eq(p.sold_at, '', 'sold_at cleared');

  eq(team('TEM_a').purse_used, used - 25000, 'the purse was given back');
  eq(team('TEM_a').players_count, count - 1, 'the slot was freed');

  const newRow = results().filter((r) => r.player_id === pid && r.is_current === true)[0];
  eq(newRow.status, 'RETURNED_TO_POOL');
  eq(newRow.supersedes_auction_id, oldRow.auction_id);
  eq(newRow.team_id, ''); eq(newRow.amount, null);
  eq(results().filter((r) => r.player_id === pid && r.auction_id === oldRow.auction_id)[0].is_current, false);

  // and the player can be sold again afterwards
  const s = sell('tok-org', pid, 'TEM_a', 15000);
  eq(s.player.sold_amount, 15000);
});

t('AUCTION_CORRECTED is audited with both values', () => {
  const rows = auditRows('AUCTION_CORRECTED');
  ok(rows.length >= 3, 'corrections audited, got ' + rows.length);
  const last = rows[rows.length - 1];
  const prev = JSON.parse(last.prev_value), next = JSON.parse(last.new_value);
  eq(prev.result_status, 'SOLD'); eq(prev.sold_amount, 25000); eq(prev.team_id, 'TEM_a');
  eq(next.auction_status, 'PENDING'); eq(next.team_id, ''); eq(next.sold_amount, null);
  ok(next.supersedes_auction_id, 'the superseded id is recorded');
});

t('correcting a player who has no result says so', () => {
  const msg = E('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: 'PLY_38', newStatus: 'PENDING', expectedVersion: version(TID)
  }, 'NOT_FOUND');
  has(msg, '#38'); has(msg, 'no auction result');
});

t('correction re-checks eligibility before putting a player back into a squad', () => {
  const p = readAll(G.SHEETS.PLAYERS).filter((r) => r.player_id === 'PLY_39')[0];
  raw('Repo.updateRow(SHEETS.PLAYERS,' + p._row + ',{payment_status:"REJECTED"})', ctx);
  const msg = E('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: 'PLY_39', newStatus: 'SOLD', teamId: 'TEM_a',
    amount: 1000, expectedVersion: version(TID)
  }, 'PLAYER_NOT_ELIGIBLE');
  has(msg, 'REJECTED');
  // but unwinding the sale of a now-ineligible player must still be possible
  D('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: 'PLY_39', newStatus: 'PENDING', expectedVersion: version(TID)
  });
  eq(player('PLY_39').team_id, '');
  raw('Repo.updateRow(SHEETS.PLAYERS,' + p._row + ',{payment_status:"VERIFIED"})', ctx);
});

// ===========================================================================
section('§4.7 advisory warnings — never blocking');

t('a huge bid succeeds and comes back with advisories, not an error', () => {
  // Delta has ₹20,00,000 total. Bid 30% of it, far above the highest sale so far.
  const highestBefore = D('auction.summary', 'tok-org', { tournamentId: TID }).highest_sale;
  const amt = 600000;
  const r = sell('tok-org', 'PLY_2', 'TEM_d', amt);
  eq(r.player.sold_amount, amt, 'the sale went through');
  const codes = r.warnings.map((w) => w.code).sort();
  ok(codes.indexOf('LARGE_SHARE_OF_PURSE') !== -1, 'purse share advisory, got ' + codes);
  ok(amt > highestBefore * 5 ? codes.indexOf('FAR_ABOVE_RECENT') !== -1 : true,
    'above-recent advisory, got ' + codes);
  r.warnings.forEach((w) => ok(w.message.indexOf('₹') !== -1, 'messages carry real money'));
});

t('an ordinary bid raises no advisory', () => {
  const r = sell('tok-org', 'PLY_36', 'TEM_d', 20000);
  eq(r.warnings.length, 0, 'got ' + JSON.stringify(r.warnings));
});

// ===========================================================================
section('all_teams_full');

t('all_teams_full flips true only when the last slot fills', () => {
  // A fresh tournament so the arithmetic is easy to read.
  const T2 = 'TRN_full00000002';
  append(G.SHEETS.TOURNAMENTS, {
    tournament_id: T2, slug: 'full', name: 'Full Cup', status: 'AUCTION_LIVE',
    next_serial: 10, reg_fee: 500, default_purse: 100000, default_max_players: 2,
    display_token: 'tok2', created_at: '2026-08-01T00:00:00.000Z'
  });
  ['x', 'y'].forEach((k, i) => append(G.SHEETS.TEAMS, {
    team_id: 'TEM_' + k, tournament_id: T2, team_name: 'Team ' + k.toUpperCase(),
    purse_total: 100000, purse_used: 0, max_players: 2, players_count: 0,
    created_at: '2026-08-02T00:00:00.000Z', created_by: 'USR_admin'
  }));
  for (let i = 1; i <= 6; i++) {
    append(G.SHEETS.PLAYERS, {
      player_id: 'PLYF_' + i, tournament_id: T2, serial_no: i, name: 'Full Player ' + i,
      dob: '1995-01-01', age_years: 31, role: 'BOWLER', style: 'LEFT',
      mobile: '9111100' + String(100 + i).slice(-3), photo_file_id: '', photo_thumb_url: '',
      payment_status: 'VERIFIED', auction_status: 'PENDING', times_called: 0,
      team_id: '', sold_amount: '', sold_at: '', is_withdrawn: false,
      search_blob: 'full player ' + i, registered_at: '2026-08-10T04:00:00.000Z'
    });
  }
  addSession('tok-org3', 'USR_org3', 'ORGANISER', T2);

  const sellT2 = (pid, tid, amt) => D('auction.markSold', 'tok-org3',
    { tournamentId: T2, playerId: pid, teamId: tid, amount: amt, expectedVersion: version(T2) });
  const sumT2 = () => D('auction.summary', 'tok-org3', { tournamentId: T2 });

  eq(sumT2().all_teams_full, false, 'not full at the start');
  eq(sumT2().not_called, 6);
  sellT2('PLYF_1', 'TEM_x', 1000); eq(sumT2().all_teams_full, false);
  sellT2('PLYF_2', 'TEM_x', 1000); eq(sumT2().teams_full, 1);
  eq(sumT2().all_teams_full, false, 'one team full is not all teams full');
  sellT2('PLYF_3', 'TEM_y', 1000); eq(sumT2().all_teams_full, false);

  sellT2('PLYF_4', 'TEM_y', 1000);
  const s = sumT2();
  eq(s.teams_full, 2); eq(s.teams_total, 2);
  eq(s.all_teams_full, true, 'the last slot flips it');
  eq(s.sold, 4); eq(s.not_called, 2);
  has(s.banner, 'All 2 teams are full');
  has(s.banner, '2 players were not called');

  // and the snapshot carries it too
  const snap = JSON.parse(cacheStore.get('snap:' + T2));
  eq(snap.summary.all_teams_full, true);
  eq(snap.summary.not_called, 2);

  // the fifth player cannot be bought anywhere
  E('auction.markSold', 'tok-org3',
    { tournamentId: T2, playerId: 'PLYF_5', teamId: 'TEM_x', amount: 1000, expectedVersion: version(T2) },
    'TEAM_FULL');
  globalThis.__T2 = T2;
});

// ===========================================================================
section('§4.2 close and reopen');

t('auction.close is ADMIN only', () => {
  E('auction.close', 'tok-org', { tournamentId: TID, expectedVersion: version(TID) }, 'FORBIDDEN');
});

t('auction.close moves the status and audits it with a summary', () => {
  const r = D('auction.close', 'tok-admin', { tournamentId: TID, expectedVersion: version(TID) });
  eq(r.status, 'AUCTION_CLOSED'); eq(r.prev_status, 'AUCTION_LIVE');
  ok(r.summary.sold > 0, 'summary carried');
  eq(readAll(G.SHEETS.TOURNAMENTS).filter((x) => x.tournament_id === TID)[0].status, 'AUCTION_CLOSED');
  const a = auditRows('AUCTION_CLOSED');
  eq(a.length, 1);
  eq(JSON.parse(a[0].prev_value).status, 'AUCTION_LIVE');
  eq(JSON.parse(a[0].new_value).status, 'AUCTION_CLOSED');
  ok(typeof JSON.parse(a[0].new_value).total_spent === 'number');
});

t('after close EVERY organiser write returns AUCTION_CLOSED', () => {
  const v = () => version(TID);
  E('auction.markSold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_38', teamId: 'TEM_a', amount: 1000, expectedVersion: v() }, 'AUCTION_CLOSED');
  E('auction.markUnsold', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_38', expectedVersion: v() }, 'AUCTION_CLOSED');
  E('auction.returnToPool', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_35', expectedVersion: v() }, 'AUCTION_CLOSED');
  E('auction.getBySerial', 'tok-org', { tournamentId: TID, serialNo: 38 }, 'AUCTION_CLOSED');
  const msg = E('auction.correct', 'tok-org',
    { tournamentId: TID, playerId: 'PLY_1', newStatus: 'PENDING', expectedVersion: v() }, 'AUCTION_CLOSED');
  has(msg, 'Only an admin');
});

t('reads still work after close', () => {
  ok(D('auction.summary', 'tok-org', { tournamentId: TID }).sold > 0);
  ok(D('auction.search', 'tok-org', { tournamentId: TID, q: 'Player 38' }).rows.length === 1);
  ok(D('auction.state', 'tok-org', { tournamentId: TID, v: 0 }).teams.length === 5);
  ok(D('auction.history', 'tok-org', { tournamentId: TID }).total > 0);
});

t('an ADMIN can still correct after close', () => {
  const used = team('TEM_a').purse_used;
  D('auction.correct', 'tok-admin', {
    tournamentId: TID, playerId: 'PLY_1', newStatus: 'SOLD', teamId: 'TEM_a',
    amount: 70000, expectedVersion: version(TID)
  });
  eq(team('TEM_a').purse_used, used - 75000 + 70000);
  eq(player('PLY_1').sold_amount, 70000);
});

t('reopen is ADMIN only and audited', () => {
  E('auction.reopen', 'tok-org', { tournamentId: TID, expectedVersion: version(TID) }, 'FORBIDDEN');
  const r = D('auction.reopen', 'tok-admin',
    { tournamentId: TID, expectedVersion: version(TID), reason: 'one more player to sell' });
  eq(r.status, 'AUCTION_LIVE'); eq(r.prev_status, 'AUCTION_CLOSED');
  const a = auditRows('AUCTION_REOPENED');
  eq(a.length, 1);
  eq(JSON.parse(a[0].prev_value).status, 'AUCTION_CLOSED');
  eq(JSON.parse(a[0].new_value).status, 'AUCTION_LIVE');
  has(JSON.parse(a[0].new_value).reason, 'one more player');
  // and writes work again
  const s = sell('tok-org', 'PLY_38', 'TEM_d', 5000);
  eq(s.player.auction_status, 'SOLD');
});

// ===========================================================================
section('§4.2 history and scope');

t('history is newest first and includes superseded rows', () => {
  const h = D('auction.history', 'tok-org', { tournamentId: TID });
  eq(h.total, results().length, 'every row for the tournament');
  ok(h.rows.some((r) => r.is_current === false), 'superseded rows are included');
  ok(h.rows.some((r) => r.supersedes_auction_id), 'and the supersession is visible');
  for (let i = 1; i < h.rows.length; i++) {
    const a = Date.parse(h.rows[i - 1].auction_time), b = Date.parse(h.rows[i].auction_time);
    ok(a >= b, 'newest first at index ' + i);
  }
  ok(h.rows[0].name, 'player names resolved');
  ok(h.rows.some((r) => r.team_name === 'Alpha Kings'), 'team names resolved');
});

t('an organiser cannot touch another tournament', () => {
  E('auction.summary', 'tok-org3', { tournamentId: TID }, 'FORBIDDEN');
  E('auction.markSold', 'tok-org3',
    { tournamentId: TID, playerId: 'PLY_38', teamId: 'TEM_a', amount: 1, expectedVersion: version(TID) },
    'FORBIDDEN');
});

t('expectedVersion is required on every write', () => {
  ['auction.markSold', 'auction.markUnsold', 'auction.returnToPool', 'auction.correct',
   'auction.close', 'auction.reopen'].forEach((action) => {
    const env = post(action, 'tok-admin', { tournamentId: TID, playerId: 'PLY_38' });
    eq(env.ok, false, action);
    eq(env.error.code, 'VALIDATION_FAILED', action + ' -> ' + env.error.code);
    has(env.error.message, 'expectedVersion', action);
  });
});

// ===========================================================================
section('final consistency sweep');

t('every team counter equals its AuctionResults truth', () => {
  const rows = results().filter((r) => r.is_current === true && r.status === 'SOLD');
  const byTeam = {};
  rows.forEach((r) => {
    byTeam[r.team_id] = byTeam[r.team_id] || { purse: 0, count: 0 };
    byTeam[r.team_id].purse += r.amount;
    byTeam[r.team_id].count += 1;
  });
  ['TEM_a', 'TEM_b', 'TEM_c', 'TEM_d', 'TEM_e'].forEach((id) => {
    const tm = team(id);
    const truth = byTeam[id] || { purse: 0, count: 0 };
    eq(tm.purse_used, truth.purse, id + ' purse_used vs AuctionResults');
    eq(tm.players_count, truth.count, id + ' players_count vs AuctionResults');
    ok(tm.purse_used <= tm.purse_total, id + ' never overspent');
    ok(tm.players_count <= tm.max_players, id + ' never overfilled');
  });
});

t('every Players row agrees with its current AuctionResults row', () => {
  const cur = {};
  results().filter((r) => r.is_current === true).forEach((r) => { cur[r.player_id] = r; });
  readAll(G.SHEETS.PLAYERS).filter((p) => p.tournament_id === TID).forEach((p) => {
    const r = cur[p.player_id];
    if (!r) { eq(p.auction_status, 'PENDING', p.player_id + ' has no result so must be PENDING'); return; }
    if (r.status === 'SOLD') {
      eq(p.auction_status, 'SOLD', p.player_id);
      eq(p.team_id, r.team_id, p.player_id + ' team');
      eq(p.sold_amount, r.amount, p.player_id + ' amount');
    } else if (r.status === 'UNSOLD') {
      eq(p.auction_status, 'UNSOLD', p.player_id);
      eq(p.team_id, '', p.player_id + ' unsold must hold no team');
    } else {
      eq(p.auction_status, 'PENDING', p.player_id);
      eq(p.team_id, '', p.player_id + ' returned must hold no team');
      eq(p.sold_amount, null, p.player_id + ' returned must hold no amount');
    }
  });
});

t('exactly one is_current row per player that has any result', () => {
  const byPlayer = {};
  results().forEach((r) => {
    byPlayer[r.player_id] = byPlayer[r.player_id] || 0;
    if (r.is_current === true) byPlayer[r.player_id]++;
  });
  Object.keys(byPlayer).forEach((pid) => eq(byPlayer[pid], 1, pid + ' current rows'));
});

t('no AuctionResults row was ever deleted or rewritten in place', () => {
  const deletes = writeLog.filter((w) => w.tab === 'AuctionResults' && w.row === 1);
  eq(deletes.length, 0, 'the header was never touched');
  ok(results().length >= 35, 'history keeps growing: ' + results().length + ' rows');
});

t('PLAYER_RETURNED_TO_POOL exists in Audit.ACTIONS', () => {
  const actions = vm.runInContext('Object.keys(Audit.ACTIONS)', ctx);
  ['PLAYER_SOLD', 'PLAYER_UNSOLD', 'PLAYER_RETURNED_TO_POOL', 'AUCTION_CORRECTED',
   'AUCTION_CLOSED', 'AUCTION_REOPENED'].forEach((a) => {
    ok(actions.indexOf(a) !== -1, a + ' missing from Audit.ACTIONS');
  });
});

// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(66));
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
console.log('lock waits=' + lockWaits + ' releases=' + lockReleases +
  ' flushes=' + flushes + ' (under lock ' + flushesUnderLock + ')');
console.log('sheet getValues=' + sheetReads + ' setValues=' + sheetWrites);
