/**
 * Phase 6 reports & exports harness.
 * In-memory fakes for SpreadsheetApp / DriveApp / CacheService /
 * PropertiesService / LockService (same shape as /tmp/pay_test.js and
 * /tmp/players_test.js), then the real .gs files on top.
 */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const DIR = '/Users/raja.t/cricket-auction/backend';

// ------------------------------------------------------------------ fake sheet
let lockHeld = false;
const writeLog = [];            // {tab, row}
let flushes = 0;

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
          writeLog.push({ tab: name, row: rowIdx + 1 });
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
  flush: () => { flushes++; }
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
  getScriptLock: () => ({ waitLock: () => { lockHeld = true; }, releaseLock: () => { lockHeld = false; } })
};

const Utilities = {
  getUuid: () => crypto.randomUUID(),
  computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
  computeHmacSha256Signature: (m, k) => Array.from(crypto.createHmac('sha256', String(k)).update(String(m)).digest()).map((b) => (b > 127 ? b - 256 : b)),
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
  // Apps Script's two-arg form encodes the string as UTF-8. Buffer.from does the
  // same by default, which is what makes the BOM + Tamil assertions meaningful.
  base64Encode: (x) => Buffer.from(String(x), 'utf8').toString('base64'),
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
  Object, Array, Error, RegExp, Infinity, NaN, Buffer, Set, Map, Promise,
  encodeURIComponent, decodeURIComponent, Boolean,
  SpreadsheetApp, DriveApp, CacheService, PropertiesService, LockService, Utilities, ContentService,
  Session: { getActiveUser: () => ({ getEmail: () => '' }) }
};
vm.createContext(ctx);

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.gs') && f !== 'Tests.gs').sort();
vm.runInContext(files.map((f) => fs.readFileSync(DIR + '/' + f, 'utf8')).join('\n'), ctx, { filename: 'ALL.gs' });

const G = vm.runInContext(
  '({Repo,Util,ENUM,ERR,SHEETS,HEADERS,Reports,Players,Audit,Auth,buildRoutes,REPORT_LABEL})', ctx);

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

// ------------------------------------------------------------------ CSV parser
/** A strict RFC 4180 reader, written independently of the producer. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false, started = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; started = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; started = true; i++; continue; }
    if (c === '\r' || c === '\n') {
      const skip = (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
      row.push(field); rows.push(row); row = []; field = ''; started = false; i += skip; continue;
    }
    field += c; started = true; i++;
  }
  if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Decode an export envelope back into {text, rows}. */
function decode(exp) {
  const text = Buffer.from(exp.base64, 'base64').toString('utf8');
  return { text: text, grid: parseCsv(text.replace(/^﻿/, '')) };
}

// ------------------------------------------------------------------ fixtures
Object.keys(G.HEADERS).forEach((tab) => { sheets[tab] = makeSheet(tab, G.HEADERS[tab].slice()); });

const TID = 'TRN_rep00000001';
const TID2 = 'TRN_rep00000002';
const append = (tab, obj) =>
  vm.runInContext(`Repo.append(${JSON.stringify(tab)}, ${JSON.stringify(obj)});`, ctx);

append('Tournaments', {
  tournament_id: TID, slug: 'chennai-premier-league', name: 'Chennai Premier League',
  status: 'AUCTION_CLOSED', reg_fee: 500, next_serial: 9,
  start_date: '2026-09-01', end_date: '2026-09-05'
});
append('Tournaments', {
  tournament_id: TID2, slug: 'madurai-cup', name: 'Madurai Cup',
  status: 'REG_OPEN', reg_fee: 300, next_serial: 2
});

append('Users', { user_id: 'USR_admin', email: 'admin@example.com', display_name: 'Priya Nair', role: 'ADMIN', tournament_id: '', status: 'ACTIVE' });
append('Users', { user_id: 'USR_org', email: 'org@example.com', display_name: 'Ravi Organiser', role: 'ORGANISER', tournament_id: TID, status: 'ACTIVE' });

// Teams. "Alpha, Kings" has a comma on purpose — a team name reaches the file too.
append('Teams', { team_id: 'TEM_a', tournament_id: TID, team_name: 'Alpha, Kings', owner_name: 'A', purse_total: 100000, purse_used: 65000, max_players: 2, players_count: 2 });
append('Teams', { team_id: 'TEM_b', tournament_id: TID, team_name: 'Beta Bulls', owner_name: 'B', purse_total: 100000, purse_used: 30000, max_players: 3, players_count: 1 });
append('Teams', { team_id: 'TEM_c', tournament_id: TID, team_name: 'Gamma Giants', owner_name: 'C', purse_total: 100000, purse_used: 0, max_players: 3, players_count: 0 });
append('Teams', { team_id: 'TEM_x', tournament_id: TID2, team_name: 'Other Team', purse_total: 50000, purse_used: 0, max_players: 5, players_count: 0 });

const TAMIL = 'முருகன் செல்வம்';
const P = [
  // serial, name, payment, auction, times_called, team, amount, sold_at, withdrawn
  [1, 'Kumar, Raj', 'VERIFIED', 'SOLD', 1, 'TEM_a', 25000, '2026-09-01T05:00:00.000Z', false],
  [2, 'Ravi "Rocket" Shankar', 'VERIFIED', 'SOLD', 1, 'TEM_a', 40000, '2026-09-01T05:10:00.000Z', false],
  [3, TAMIL, 'VERIFIED', 'UNSOLD', 1, '', '', '', false],
  [4, 'Arun Kumar', 'VERIFIED', 'PENDING', 2, '', '', '', false],
  [5, 'Deepa Nair', 'VERIFIED', 'PENDING', 0, '', '', '', false],
  [6, 'Suresh Babu', 'PENDING', 'PENDING', 0, '', '', '', false],
  [7, 'Gone Away', 'VERIFIED', 'PENDING', 0, '', '', '', true],
  [8, 'Vikram Singh', 'VERIFIED', 'SOLD', 1, 'TEM_b', 30000, '2026-09-01T05:20:00.000Z', false]
];
P.forEach(([serial, name, pay, auc, called, team, amount, soldAt, withdrawn]) => {
  append('Players', {
    player_id: 'PLY_' + serial, tournament_id: TID, serial_no: serial, name: name,
    dob: '1995-01-0' + (serial % 9 || 1), age_years: 31, role: serial % 3 === 0 ? 'ALL_ROUNDER' : 'BATSMAN',
    style: serial % 2 ? 'RIGHT' : 'LEFT', mobile: '98765432' + String(serial).padStart(2, '0'),
    photo_file_id: 'p' + serial, photo_thumb_url: '', payment_status: pay, auction_status: auc,
    times_called: called, team_id: team, sold_amount: amount, sold_at: soldAt,
    is_withdrawn: withdrawn, search_blob: String(name).toLowerCase(),
    registered_at: '2026-08-20T04:00:00.000Z'
  });
  append('Payments', {
    payment_id: 'PAY_' + serial, tournament_id: TID, player_id: 'PLY_' + serial,
    // A UPI ref Excel would happily read as scientific notation.
    upi_ref: serial === 1 ? '1234567890123456' : 'UPIREF00' + serial,
    amount: 500, screenshot_file_id: 's' + serial,
    status: pay === 'VERIFIED' ? 'VERIFIED' : 'PENDING',
    verified_by: pay === 'VERIFIED' ? 'USR_admin' : '', verified_at: pay === 'VERIFIED' ? '2026-08-25T06:00:00.000Z' : '',
    reject_reason: '', submitted_at: '2026-08-20T04:05:00.000Z'
  });
});
append('Players', {
  player_id: 'PLY_9', tournament_id: TID2, serial_no: 1, name: 'Elsewhere Guy',
  dob: '1990-01-01', payment_status: 'VERIFIED', auction_status: 'PENDING', times_called: 0,
  mobile: '9000000000', is_withdrawn: false, registered_at: '2026-08-20T04:00:00.000Z'
});

// AuctionResults: #1 was first sold to Beta for 10000, then corrected to Alpha
// for 25000. The superseded row must survive into report.final.
append('AuctionResults', { auction_id: 'AUC_old1', tournament_id: TID, player_id: 'PLY_1', serial_no: 1, status: 'SOLD', team_id: 'TEM_b', amount: 10000, auction_time: '2026-09-01T04:55:00.000Z', recorded_by: 'USR_org', is_current: false, supersedes_auction_id: '', note: '' });
append('AuctionResults', { auction_id: 'AUC_1', tournament_id: TID, player_id: 'PLY_1', serial_no: 1, status: 'SOLD', team_id: 'TEM_a', amount: 25000, auction_time: '2026-09-01T05:00:00.000Z', recorded_by: 'USR_org', is_current: true, supersedes_auction_id: 'AUC_old1', note: 'typo in team' });
append('AuctionResults', { auction_id: 'AUC_2', tournament_id: TID, player_id: 'PLY_2', serial_no: 2, status: 'SOLD', team_id: 'TEM_a', amount: 40000, auction_time: '2026-09-01T05:10:00.000Z', recorded_by: 'USR_org', is_current: true, supersedes_auction_id: '', note: '' });
append('AuctionResults', { auction_id: 'AUC_3', tournament_id: TID, player_id: 'PLY_3', serial_no: 3, status: 'UNSOLD', team_id: '', amount: '', auction_time: '2026-09-01T05:15:00.000Z', recorded_by: 'USR_org', is_current: true, supersedes_auction_id: '', note: '' });
append('AuctionResults', { auction_id: 'AUC_4', tournament_id: TID, player_id: 'PLY_4', serial_no: 4, status: 'RETURNED_TO_POOL', team_id: '', amount: '', auction_time: '2026-09-01T05:18:00.000Z', recorded_by: 'USR_admin', is_current: true, supersedes_auction_id: '', note: 'back to pool' });
append('AuctionResults', { auction_id: 'AUC_8', tournament_id: TID, player_id: 'PLY_8', serial_no: 8, status: 'SOLD', team_id: 'TEM_b', amount: 30000, auction_time: '2026-09-01T05:20:00.000Z', recorded_by: 'USR_org', is_current: true, supersedes_auction_id: '', note: '' });

// AuditLog fixtures — deliberately out of chronological order in the sheet.
const AUDIT = [
  ['LOG_1', '2026-08-25T06:00:00.000Z', 'USR_admin', 'ADMIN', 'PAYMENT_VERIFIED', TID, 'PAYMENT', 'PAY_1'],
  ['LOG_2', '2026-08-26T06:00:00.000Z', 'USR_admin', 'ADMIN', 'PAYMENT_REJECTED', TID, 'PAYMENT', 'PAY_6'],
  ['LOG_3', '2026-09-01T05:00:00.000Z', 'USR_org', 'ORGANISER', 'PLAYER_SOLD', TID, 'PLAYER', 'PLY_1'],
  ['LOG_4', '2026-09-01T05:10:00.000Z', 'USR_org', 'ORGANISER', 'PLAYER_SOLD', TID, 'PLAYER', 'PLY_2'],
  ['LOG_5', '2026-09-01T05:15:00.000Z', 'USR_org', 'ORGANISER', 'PLAYER_UNSOLD', TID, 'PLAYER', 'PLY_3'],
  ['LOG_6', '2026-09-01T05:30:00.000Z', 'USR_admin', 'ADMIN', 'AUCTION_CORRECTED', TID, 'PLAYER', 'PLY_1'],
  ['LOG_7', '2026-09-01T06:00:00.000Z', 'USR_admin', 'ADMIN', 'AUCTION_CLOSED', TID, 'TOURNAMENT', TID],
  ['LOG_8', '2026-08-30T06:00:00.000Z', 'USR_admin', 'ADMIN', 'TOURNAMENT_CREATED', TID2, 'TOURNAMENT', TID2]
];
// Shuffle-ish: insert in a jumbled order so "newest first" is a real assertion.
[2, 0, 6, 4, 1, 7, 3, 5].forEach((i) => {
  const [id, ts, actor, role, action, tid, etype, eid] = AUDIT[i];
  append('AuditLog', {
    log_id: id, timestamp: ts, actor_user_id: actor, actor_role: role, action: action,
    tournament_id: tid, entity_type: etype, entity_id: eid,
    prev_value: action === 'PLAYER_SOLD' ? '{"auction_status":"PENDING"}' : '',
    new_value: action === 'PLAYER_SOLD' ? '{"auction_status":"SOLD"}' : 'not json at all',
    user_agent: 'Mozilla/5.0'
  });
});

const admin = { user_id: 'USR_admin', role: 'ADMIN', tournament_id: '', token: 'tok-admin' };
const organiser = { user_id: 'USR_org', role: 'ORGANISER', tournament_id: TID, token: 'tok-org' };
const otherOrganiser = { user_id: 'USR_o2', role: 'ORGANISER', tournament_id: TID2, token: 'tok-o2' };
const R = G.Reports;

/** Run fn with Repo.readAll instrumented; returns {result, reads}. */
function countReads(expr) {
  vm.runInContext(`
    globalThis.__reads = [];
    Repo.__readAll = Repo.readAll;
    Repo.readAll = function (tab) { globalThis.__reads.push(tab); return Repo.__readAll(tab); };
  `, ctx);
  const before = writeLog.length;
  const result = vm.runInContext(expr, ctx);
  const reads = vm.runInContext('globalThis.__reads', ctx);
  vm.runInContext('Repo.readAll = Repo.__readAll;', ctx);
  return { result: result, reads: reads, writes: writeLog.length - before };
}
function tally(reads) {
  const out = {};
  reads.forEach((r) => { out[r] = (out[r] || 0) + 1; });
  return out;
}

console.log('\n=== Phase 6 reports & exports ===\n');

// ------------------------------------------------------------- report.players
const players = R.players({ tournamentId: TID }, admin);
const playersCsv = decode(players);

t('players: envelope shape and descriptive filename', () => {
  eq(players.mime, 'text/csv;charset=utf-8');
  eq(players.rows, 8, 'one row per registered player');
  ok(/^chennai-premier-league-players-\d{4}-\d{2}-\d{2}\.csv$/.test(players.filename), 'filename ' + players.filename);
  eq(players.filename.indexOf(G.Util.todayIso()) > -1, true, 'IST date in filename');
});

t('players: file starts with a UTF-8 BOM', () => {
  eq(playersCsv.text.charCodeAt(0), 0xFEFF, 'first char is U+FEFF');
  const bytes = Buffer.from(players.base64, 'base64');
  eq(bytes[0], 0xEF); eq(bytes[1], 0xBB); eq(bytes[2], 0xBF);
});

t('players: header row is exactly the contracted columns', () => {
  eq(playersCsv.grid[0].join('|'),
    'Serial No|Name|DOB|Role|Style|Mobile|Payment Reference|Payment Status|Auction Status|Team|Purchase Amount');
});

t('players: every row has 11 fields (no column shift from a comma)', () => {
  playersCsv.grid.forEach((row, i) => eq(row.length, 11, 'row ' + i + ' width'));
  eq(playersCsv.grid.length, 9, 'header + 8 players');
});

t('players: a name containing a comma round-trips exactly', () => {
  eq(playersCsv.grid[1][1], 'Kumar, Raj');
  ok(playersCsv.text.indexOf('"Kumar, Raj"') > -1, 'field was quoted in the raw file');
});

t('players: a name containing a double quote round-trips exactly', () => {
  eq(playersCsv.grid[2][1], 'Ravi "Rocket" Shankar');
  ok(playersCsv.text.indexOf('"Ravi ""Rocket"" Shankar"') > -1, 'quotes doubled in the raw file');
});

t('players: a Tamil name round-trips exactly', () => {
  eq(playersCsv.grid[3][1], TAMIL);
});

t('players: mobile numbers carry the ="..." wrapper', () => {
  eq(playersCsv.grid[1][5], '="9876543201"');
  ok(playersCsv.text.indexOf('"=""9876543201"""') > -1, 'formula field is CSV-quoted');
  playersCsv.grid.slice(1).forEach((row, i) => ok(/^="\d{10}"$/.test(row[5]), 'row ' + (i + 1) + ' mobile ' + row[5]));
});

t('players: UPI references are protected the same way', () => {
  eq(playersCsv.grid[1][6], '="1234567890123456"', 'a 16-digit ref must not become 1.23457E+15');
  playersCsv.grid.slice(1).forEach((row, i) => ok(/^="[A-Za-z0-9]+"$/.test(row[6]), 'row ' + (i + 1) + ' upi ' + row[6]));
});

t('players: money columns are bare integers — no symbol, no separators', () => {
  playersCsv.grid.slice(1).forEach((row, i) => {
    ok(/^\d*$/.test(row[10]), 'row ' + (i + 1) + ' purchase amount "' + row[10] + '"');
    ok(row[10].indexOf('₹') === -1, 'rupee symbol leaked');
    ok(row[10].indexOf(',') === -1, 'thousands separator leaked');
  });
  eq(playersCsv.grid[1][10], '25000');
  eq(playersCsv.grid[2][10], '40000');
  eq(playersCsv.grid[3][10], '', 'unsold player has an empty amount, not a zero');
});

t('players: no rupee symbol anywhere in the file', () => {
  eq(playersCsv.text.indexOf('₹'), -1);
});

t('players: all four honest labels appear, on the right rows', () => {
  const byName = {};
  playersCsv.grid.slice(1).forEach((row) => { byName[row[1]] = row; });
  eq(byName['Kumar, Raj'][8], 'Sold');
  eq(byName[TAMIL][8], 'Unsold');
  eq(byName['Arun Kumar'][8], 'Awaiting re-auction', 'PENDING with times_called 2');
  eq(byName['Deepa Nair'][8], 'Not called', 'PENDING with times_called 0');
  const labels = new Set(playersCsv.grid.slice(1).map((r) => r[8]));
  ['Sold', 'Unsold', 'Awaiting re-auction', 'Not called'].forEach((l) => ok(labels.has(l), 'missing label ' + l));
  ok(!labels.has('PENDING') && !labels.has('Pending'), 'raw status leaked into the report');
});

t('players: withdrawal stays visible in the payment column', () => {
  const row = playersCsv.grid.slice(1).find((r) => r[1] === 'Gone Away');
  eq(row[7], 'Verified (withdrawn)');
});

t('players: dates render in IST, not raw ISO', () => {
  eq(playersCsv.grid[1][2], '1 Jan 1995');
  ok(playersCsv.text.indexOf('T05:00:00.000Z') === -1, 'a raw instant leaked into the file');
});

t('players: team names with a comma survive too', () => {
  eq(playersCsv.grid[1][9], 'Alpha, Kings');
});

t('players reads each tab exactly once', () => {
  const c = countReads(`Reports.players({tournamentId:'${TID}'}, {user_id:'USR_admin', role:'ADMIN', tournament_id:''})`);
  const n = tally(c.reads);
  eq(n.Players, 1, 'Players');
  eq(n.Payments, 1, 'Payments');
  eq(n.Teams, 1, 'Teams');
  eq(n.Tournaments, 1, 'Tournaments');
  eq(c.writes, 0, 'a report must not write');
});

// --------------------------------------------------------------- report.teams
const teams = R.teams({ tournamentId: TID }, admin);
const teamsCsv = decode(teams);

t('teams: header row is exactly the contracted columns', () => {
  eq(teamsCsv.grid[0].join('|'), 'Team|Player|Purchase Amount|Total Players|Total Spent|Remaining Purse');
});

t('teams: an empty team still appears', () => {
  const gamma = teamsCsv.grid.slice(1).filter((r) => r[0] === 'Gamma Giants');
  eq(gamma.length, 1);
  eq(gamma[0][1], '', 'no player');
  eq(gamma[0][3], '0'); eq(gamma[0][4], '0'); eq(gamma[0][5], '100000');
});

t('teams: totals equal the sum of the player rows', () => {
  const byTeam = {};
  teamsCsv.grid.slice(1).forEach((r) => {
    byTeam[r[0]] = byTeam[r[0]] || { sum: 0, count: 0, total: r[4], remaining: r[5], stated: r[3] };
    if (r[1]) { byTeam[r[0]].sum += Number(r[2] || 0); byTeam[r[0]].count++; }
  });
  Object.keys(byTeam).forEach((name) => {
    const b = byTeam[name];
    eq(Number(b.total), b.sum, name + ' Total Spent vs sum of rows');
    eq(Number(b.stated), b.count, name + ' Total Players vs row count');
  });
  eq(byTeam['Alpha, Kings'].sum, 65000);
  eq(Number(byTeam['Alpha, Kings'].remaining), 100000 - 65000);
  eq(byTeam['Beta Bulls'].sum, 30000);
  eq(Number(byTeam['Beta Bulls'].remaining), 70000);
});

t('teams: money columns stay bare integers', () => {
  teamsCsv.grid.slice(1).forEach((r, i) => {
    [2, 4, 5].forEach((c) => ok(/^-?\d*$/.test(r[c]), 'row ' + i + ' col ' + c + ' = "' + r[c] + '"'));
  });
});

t('teams: only sold players appear, three teams covered', () => {
  eq(teams.rows, 2 + 1 + 1, 'Alpha 2 + Beta 1 + Gamma placeholder 1');
  eq(teamsCsv.grid.length, 5);
});

t('teams reads each tab exactly once', () => {
  const c = countReads(`Reports.teams({tournamentId:'${TID}'}, {user_id:'USR_admin', role:'ADMIN', tournament_id:''})`);
  const n = tally(c.reads);
  eq(n.Players, 1); eq(n.Teams, 1); eq(n.Tournaments, 1);
  eq(n.Payments, undefined, 'teams report must not read Payments at all');
  eq(c.writes, 0);
});

// ------------------------------------------------------------- report.auction
const auction = R.auction({ tournamentId: TID }, admin);
const auctionCsv = decode(auction);

t('auction: header row is exactly the contracted columns', () => {
  eq(auctionCsv.grid[0].join('|'), 'Serial No|Player|Status|Team|Purchase Amount|Auction Time');
});

t('auction: EVERY registered player appears, called or not', () => {
  eq(auction.rows, 8);
  eq(auctionCsv.grid.length, 9);
});

t('auction: the four labels, with "Not called" clearly present', () => {
  const byName = {};
  auctionCsv.grid.slice(1).forEach((r) => { byName[r[1]] = r; });
  eq(byName['Deepa Nair'][2], 'Not called');
  eq(byName['Arun Kumar'][2], 'Awaiting re-auction');
  eq(byName[TAMIL][2], 'Unsold');
  eq(byName['Vikram Singh'][2], 'Sold');
  eq(byName['Deepa Nair'][5], '', 'never called means no auction time');
});

t('auction: called players come first, in chronological order', () => {
  const called = auctionCsv.grid.slice(1).filter((r) => r[5]);
  const never = auctionCsv.grid.slice(1).filter((r) => !r[5]);
  // #4 was called and returned to the pool, so it has a time even though it is
  // "Awaiting re-auction" — that is exactly the distinction times_called makes.
  eq(called.length, 5, 'sold x3 + unsold x1 + returned-to-pool x1 have a time');
  eq(called[0][1], 'Kumar, Raj');
  eq(called[4][1], 'Vikram Singh');
  eq(auctionCsv.grid.slice(1, 6).map((r) => r[1]).join(','), called.map((r) => r[1]).join(','));
  eq(never.map((r) => Number(r[0])).join(','), '5,6,7', 'uncalled sorted by serial');
});

t('auction: times are IST, not UTC ISO', () => {
  eq(auctionCsv.grid[1][5], '1 Sep 2026, 10:30 AM', '05:00Z is 10:30 IST');
});

t('auction: the superseded correction row is NOT in this report', () => {
  const raj = auctionCsv.grid.slice(1).filter((r) => r[1] === 'Kumar, Raj');
  eq(raj.length, 1, 'one row per player, final state only');
  eq(raj[0][4], '25000', 'the corrected amount, not the original 10000');
  eq(raj[0][3], 'Alpha, Kings');
});

t('auction reads each tab exactly once', () => {
  const c = countReads(`Reports.auction({tournamentId:'${TID}'}, {user_id:'USR_admin', role:'ADMIN', tournament_id:''})`);
  const n = tally(c.reads);
  eq(n.Players, 1); eq(n.Teams, 1); eq(n.AuctionResults, 1); eq(n.Tournaments, 1);
  eq(c.writes, 0);
});

// --------------------------------------------------------------- report.final
const finalExp = R.final({ tournamentId: TID }, admin);
const finalCsv = decode(finalExp);

t('final: one file with the three sections', () => {
  const flat = finalCsv.grid.map((r) => r[0]);
  ok(flat.indexOf('SUMMARY') > -1, 'SUMMARY section');
  ok(flat.indexOf('TEAM SQUADS') > -1, 'TEAM SQUADS section');
  ok(flat.some((c) => c.indexOf('AUCTION HISTORY') === 0), 'AUCTION HISTORY section');
  ok(/^chennai-premier-league-final-\d{4}-\d{2}-\d{2}\.csv$/.test(finalExp.filename), finalExp.filename);
  eq(finalCsv.text.charCodeAt(0), 0xFEFF, 'BOM');
});

t('final: summary carries the four labels and bare-integer money', () => {
  const map = {};
  finalCsv.grid.forEach((r) => { if (r.length >= 2) map[r[0]] = r[1]; });
  eq(map['Sold'], '3');
  eq(map['Unsold'], '1');
  eq(map['Awaiting re-auction'], '1');
  eq(map['Not called'], '1', 'eligible and never called: #5 only (#6 unpaid, #7 withdrawn)');
  eq(map['Registrations'], '8');
  eq(map['Eligible for the auction'], '6', 'verified and not withdrawn: 1,2,3,4,5,8');
  eq(map['Total spent'], '95000');
  ok(/^\d+$/.test(map['Fees collected']), 'fees collected "' + map['Fees collected'] + '"');
  eq(map['Fees collected'], '3500', '7 verified payments x 500 — the withdrawn player still paid');
  eq(map['Corrections recorded'], '1');
  eq(map['Highest sale'], '40000');
  eq(map['Highest sale player'], 'Ravi "Rocket" Shankar');
});

t('final: auction history keeps the superseded row, newest first', () => {
  const start = finalCsv.grid.findIndex((r) => r[0].indexOf('AUCTION HISTORY') === 0);
  const header = finalCsv.grid[start + 1];
  eq(header[0], 'Auction Time'); eq(header[7], 'Current'); eq(header[8], 'Supersedes');
  const body = finalCsv.grid.slice(start + 2).filter((r) => r.length === header.length);
  eq(body.length, 6, 'all six results including the superseded one');
  const superseded = body.filter((r) => r[7] === 'No');
  eq(superseded.length, 1);
  eq(superseded[0][5], '10000', 'the original amount survives');
  const corrected = body.filter((r) => r[8] === 'AUC_old1');
  eq(corrected.length, 1);
  eq(corrected[0][9], 'typo in team');
  // newest first
  eq(body[0][2], 'Vikram Singh');
  eq(body[body.length - 1][2], 'Kumar, Raj');
});

t('final: recorded_by is a readable name, not a user id', () => {
  ok(finalCsv.text.indexOf('Ravi Organiser') > -1, 'display name used');
  ok(finalCsv.text.indexOf('USR_org') === -1, 'raw user id leaked');
});

t('final: RETURNED_TO_POOL renders as an event, not a resting label', () => {
  ok(finalCsv.text.indexOf('Returned to pool') > -1);
});

t('final reads each tab exactly once', () => {
  const c = countReads(`Reports.final({tournamentId:'${TID}'}, {user_id:'USR_admin', role:'ADMIN', tournament_id:''})`);
  const n = tally(c.reads);
  eq(n.Tournaments, 1); eq(n.Players, 1); eq(n.Payments, 1);
  eq(n.Teams, 1); eq(n.AuctionResults, 1); eq(n.Users, 1);
  eq(c.writes, 0);
});

// --------------------------------------------------------- dashboard.adminStats
t('adminStats: one tournament, four honest labels sum to eligible', () => {
  const s = R.adminStats({ tournamentId: TID }, admin);
  eq(s.scope, 'TOURNAMENT');
  eq(s.tournaments.length, 1);
  const b = s.tournaments[0];
  eq(b.registrations.all, 8);
  eq(b.registrations.eligible, 6, 'verified and not withdrawn: 1,2,3,4,5,8');
  eq(b.auction.sold + b.auction.unsold + b.auction.awaiting_reauction + b.auction.not_called,
    b.registrations.eligible, 'the four labels must partition the eligible pool');
  eq(b.purse.spent, 95000);
  eq(b.purse.spent_display, '₹95,000', 'the DISPLAY string may carry the symbol');
  eq(b.purse.counters_match, true, 'derived spend matches Teams.purse_used');
  eq(b.teams.slots_total, 8);
  eq(b.teams.slots_filled, 3);
  eq(b.teams.all_teams_full, false);
  eq(b.auction.corrections, 1);
});

t('adminStats: across all tournaments, with totals', () => {
  const s = R.adminStats({}, admin);
  eq(s.scope, 'ALL');
  eq(s.tournaments.length, 2);
  eq(s.totals.tournaments, 2);
  eq(s.totals.registrations.all, 9);
  eq(s.totals.purse.spent, 95000);
  eq(s.totals.teams.total, 4);
});

t('adminStats reads each tab exactly once', () => {
  const c = countReads(`Reports.adminStats({}, {user_id:'USR_admin', role:'ADMIN', tournament_id:''})`);
  const n = tally(c.reads);
  eq(n.Tournaments, 1); eq(n.Players, 1); eq(n.Payments, 1); eq(n.Teams, 1); eq(n.AuctionResults, 1);
  eq(c.writes, 0);
});

t('adminStats: unknown tournament is NOT_FOUND', () => {
  throwsCode(() => R.adminStats({ tournamentId: 'TRN_nope' }, admin), G.ERR.NOT_FOUND);
});

// -------------------------------------------------------------------- audit.list
t('audit.list: newest first, paged', () => {
  const r = R.auditList({ pageSize: 3 }, admin);
  eq(r.total, 8);
  eq(r.totalPages, 3);
  eq(r.page, 1);
  eq(r.rows.length, 3);
  eq(r.rows.map((x) => x.log_id).join(','), 'LOG_7,LOG_6,LOG_5');
  const p2 = R.auditList({ pageSize: 3, page: 2 }, admin);
  eq(p2.rows.map((x) => x.log_id).join(','), 'LOG_4,LOG_3,LOG_8');
  const p3 = R.auditList({ pageSize: 3, page: 3 }, admin);
  eq(p3.rows.map((x) => x.log_id).join(','), 'LOG_2,LOG_1');
  const p9 = R.auditList({ pageSize: 3, page: 9 }, admin);
  eq(p9.rows.length, 0, 'a page past the end is empty, not an error');
  eq(p9.total, 8);
});

t('audit.list: page size is clamped', () => {
  eq(R.auditList({ pageSize: 99999 }, admin).pageSize, 200, 'ceiling');
  eq(R.auditList({ pageSize: 0 }, admin).pageSize, 50, 'zero means "not supplied"');
  eq(R.auditList({}, admin).pageSize, 50, 'default');
  // Same floor as payment.list / player.list: a negative size clamps to 1.
  eq(R.auditList({ pageSize: -4 }, admin).pageSize, 1, 'floor');
  eq(R.auditList({ page: -3 }, admin).page, 1);
});

t('audit.list: filter by tournament', () => {
  const r = R.auditList({ tournamentId: TID }, admin);
  eq(r.total, 7);
  ok(r.rows.every((x) => x.tournament_id === TID));
});

t('audit.list: filter by action', () => {
  const r = R.auditList({ action: 'PLAYER_SOLD' }, admin);
  eq(r.total, 2);
  eq(r.rows.map((x) => x.log_id).join(','), 'LOG_4,LOG_3');
  eq(R.auditList({ action: 'player_sold' }, admin).total, 2, 'case insensitive');
});

t('audit.list: an unknown action is rejected, not silently empty', () => {
  const e = throwsCode(() => R.auditList({ action: 'DELETE_EVERYTHING' }, admin), G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('PLAYER_SOLD') > -1, 'message lists the valid actions');
});

t('audit.list: filter by actor — id, email or display name', () => {
  eq(R.auditList({ actor: 'USR_org' }, admin).total, 3);
  eq(R.auditList({ actor: 'ravi organiser' }, admin).total, 3, 'by display name');
  eq(R.auditList({ actor: 'admin@example.com' }, admin).total, 5, 'by email');
  eq(R.auditList({ actor: 'nobody' }, admin).total, 0);
});

t('audit.list: date range covers whole IST days', () => {
  // LOG_1 is 2026-08-25T06:00Z = 25 Aug 11:30 IST.
  eq(R.auditList({ from: '2026-08-25', to: '2026-08-25' }, admin).total, 1);
  eq(R.auditList({ from: '2026-08-26' }, admin).total, 7);
  eq(R.auditList({ to: '2026-08-26' }, admin).total, 2);
  eq(R.auditList({ from: '2026-09-01', to: '2026-09-01' }, admin).total, 5);
  // 2026-09-01T06:00Z is 11:30 IST on the 1st, so a bare "to" of the 1st keeps
  // it. A UTC-midnight reading would have dropped everything after 05:30 IST.
  ok(R.auditList({ to: '2026-09-01' }, admin).rows.some((x) => x.log_id === 'LOG_7'),
    'a bare end date must cover the whole IST day');
});

t('audit.list: filters combine', () => {
  const r = R.auditList({ tournamentId: TID, action: 'PLAYER_SOLD', actor: 'USR_org', from: '2026-09-01' }, admin);
  eq(r.total, 2);
  const one = R.auditList({ entityId: 'PLY_1' }, admin);
  eq(one.total, 2, 'PLAYER_SOLD + AUCTION_CORRECTED on the same player');
});

t('audit.list: a bad date bound is a clear error', () => {
  throwsCode(() => R.auditList({ from: 'yesterday' }, admin), G.ERR.VALIDATION_FAILED);
  const bad = throwsCode(() => R.auditList({ from: '2026-02-30' }, admin), G.ERR.VALIDATION_FAILED);
  ok(bad.message.indexOf('From date') === 0, 'the message names the field: ' + bad.message);
  throwsCode(() => R.auditList({ to: '2026-13-01' }, admin), G.ERR.VALIDATION_FAILED);
  const e = throwsCode(() => R.auditList({ from: '2026-09-02', to: '2026-09-01' }, admin), G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('after') > -1, e.message);
});

t('audit.list: row shape is useful — names, IST time, parsed JSON', () => {
  const row = R.auditList({ action: 'PLAYER_SOLD', pageSize: 1 }, admin).rows[0];
  eq(row.actor_name, 'Ravi Organiser');
  eq(row.actor_role, 'ORGANISER');
  eq(row.action_display, 'Player sold');
  eq(row.timestamp, '2026-09-01T05:10:00.000Z', 'the instant stays UTC');
  eq(row.timestamp_display, '1 Sep 2026, 10:40 AM', 'rendered IST');
  eq(row.new_value.auction_status, 'SOLD', 'JSON parsed back into an object');
  eq(row.prev_value.auction_status, 'PENDING');
  const other = R.auditList({ action: 'AUCTION_CLOSED' }, admin).rows[0];
  eq(other.new_value, 'not json at all', 'unparseable payload survives as text');
});

t('audit.list: the action menu is scoped but not narrowed by the other filters', () => {
  const r = R.auditList({ tournamentId: TID, action: 'PLAYER_SOLD' }, admin);
  eq(r.actions.join(','),
    'AUCTION_CLOSED,AUCTION_CORRECTED,PAYMENT_REJECTED,PAYMENT_VERIFIED,PLAYER_SOLD,PLAYER_UNSOLD');
});

t('audit.list reads two tabs, once each, and writes nothing', () => {
  const c = countReads(`Reports.auditList({}, {user_id:'USR_admin', role:'ADMIN', tournament_id:''})`);
  const n = tally(c.reads);
  eq(n.AuditLog, 1);
  eq(n.Users, 1);
  eq(Object.keys(n).length, 2, 'read tabs: ' + Object.keys(n).join(','));
  eq(c.writes, 0, 'the audit trail is append-only evidence — no write path');
});

t('audit.list: the AuditLog sheet is byte-identical after every read path', () => {
  const before = JSON.stringify(sheets.AuditLog._grid);
  R.auditList({}, admin);
  R.auditList({ action: 'PLAYER_SOLD', page: 2 }, admin);
  R.players({ tournamentId: TID }, admin);
  R.final({ tournamentId: TID }, admin);
  R.adminStats({}, admin);
  eq(JSON.stringify(sheets.AuditLog._grid), before);
});

t('no route in this module writes to AuditLog', () => {
  // The whole point of PHASE 7 item 1: there must be no edit/delete action.
  const routes = vm.runInContext('ReportRoutes()', ctx);
  const names = Object.keys(routes).sort();
  eq(names.join(','), 'audit.list,dashboard.adminStats,report.auction,report.final,report.players,report.teams');
  const src = fs.readFileSync(DIR + '/Reports.gs', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ['Repo.append', 'Repo.appendMany', 'Repo.updateRow', 'Repo.updateBy', 'Repo.deleteRow',
    'Repo.clearDataRows', 'Repo.nextSerial', 'Audit.log'].forEach((call) => {
    eq(src.indexOf(call), -1, 'Reports.gs must never call ' + call);
  });
});

// ------------------------------------------------------------------ auth scope
t('an organiser can export their own tournament', () => {
  const r = R.players({ tournamentId: TID }, organiser);
  eq(r.rows, 8);
});

t('an organiser cannot export someone else\'s tournament', () => {
  throwsCode(() => R.players({ tournamentId: TID }, otherOrganiser), G.ERR.FORBIDDEN);
  throwsCode(() => R.teams({ tournamentId: TID }, otherOrganiser), G.ERR.FORBIDDEN);
  throwsCode(() => R.auction({ tournamentId: TID }, otherOrganiser), G.ERR.FORBIDDEN);
  throwsCode(() => R.final({ tournamentId: TID }, otherOrganiser), G.ERR.FORBIDDEN);
});

t('a missing or unknown tournament id is a clear error', () => {
  // For an ADMIN the scope check passes, so the missing id surfaces as
  // VALIDATION_FAILED from _gather.
  throwsCode(() => R.players({}, admin), G.ERR.VALIDATION_FAILED);
  throwsCode(() => R.players({ tournamentId: '' }, admin), G.ERR.VALIDATION_FAILED);
  throwsCode(() => R.players({ tournamentId: 'TRN_nope' }, admin), G.ERR.NOT_FOUND);
  // For an ORGANISER a blank id can never be their own tournament, so the
  // scope boundary fires first — which is the safer of the two answers.
  throwsCode(() => R.players({}, organiser), G.ERR.FORBIDDEN);
});

t('routes are ADMIN+ORGANISER for reports, ADMIN for stats and audit', () => {
  const routes = vm.runInContext('ReportRoutes()', ctx);
  ['report.players', 'report.teams', 'report.auction', 'report.final'].forEach((n) => {
    eq(routes[n].auth.join('/'), 'ADMIN/ORGANISER', n);
    eq(routes[n].methods.join(','), 'POST', n);
  });
  eq(routes['dashboard.adminStats'].auth.join('/'), 'ADMIN');
  eq(routes['audit.list'].auth.join('/'), 'ADMIN');
  Object.keys(routes).forEach((n) => ok(routes[n].auth !== 'PUBLIC', n + ' must not be public'));
});

// ------------------------------------------------------------------ edge cases
t('csv helper: leading and trailing spaces are preserved by quoting', () => {
  const cell = vm.runInContext(`Reports._csvCell('  padded  ')`, ctx);
  eq(cell, '"  padded  "');
  eq(parseCsv(cell + '\r\n')[0][0], '  padded  ');
});

t('csv helper: an embedded newline stays inside one field', () => {
  const cell = vm.runInContext(`Reports._csvCell('two\\nlines')`, ctx);
  const grid = parseCsv('a,' + cell + ',b\r\n');
  eq(grid.length, 1, 'one logical row');
  eq(grid[0].length, 3);
  eq(grid[0][1], 'two\nlines');
});

t('money helper never emits a symbol or a separator', () => {
  eq(vm.runInContext('Reports._money(1000000)', ctx), '1000000');
  eq(vm.runInContext('Reports._money(0)', ctx), '0');
  eq(vm.runInContext(`Reports._money('')`, ctx), '');
  eq(vm.runInContext('Reports._money(null)', ctx), '');
  eq(vm.runInContext(`Util.formatINR(1000000)`, ctx), '₹10,00,000', 'formatINR is still the display path');
});

t('excel text helper cannot be escaped out of', () => {
  eq(vm.runInContext(`Reports._excelText('12"34')`, ctx), '"=""1234"""');
  eq(parseCsv(vm.runInContext(`Reports._excelText('12"34')`, ctx))[0][0], '="1234"');
  eq(vm.runInContext(`Reports._excelText('')`, ctx), '', 'a blank mobile stays blank, not =""');
});

t('a tournament with no players still exports a valid file', () => {
  const e = R.players({ tournamentId: TID2 }, admin);
  const d = decode(e);
  eq(d.text.charCodeAt(0), 0xFEFF);
  eq(d.grid.length, 2, 'header + the one player in TID2');
  const teamsOnly = R.teams({ tournamentId: TID2 }, admin);
  eq(decode(teamsOnly).grid.length, 2, 'header + the one empty team');
  eq(e.filename.indexOf('madurai-cup-players-'), 0);
});

t('base64 decodes back to exactly the string that was built', () => {
  const again = R.players({ tournamentId: TID }, admin);
  eq(Buffer.from(again.base64, 'base64').toString('utf8'), playersCsv.text);
  ok(playersCsv.text.indexOf('\r\n') > -1, 'CRLF line endings');
  ok(playersCsv.text.endsWith('\r\n'), 'file ends with a terminator');
});

// ------------------------------------------------------------------ summary
console.log('\n' + '-'.repeat(60));
if (fail) {
  console.log(`${pass}/${pass + fail} passed, ${fail} FAILED`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(`${pass}/${pass} passed`);
