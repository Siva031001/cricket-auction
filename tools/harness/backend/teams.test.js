/**
 * Phase 3 team management harness.
 * In-memory fakes for SpreadsheetApp / DriveApp / CacheService /
 * PropertiesService / LockService (lifted from /tmp/pay_test.js), then the real
 * .gs files on top.
 */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const DIR = '/Users/raja.t/cricket-auction/backend';

// ------------------------------------------------------------------ fake sheet
let lockHeld = false;
let lockWaits = 0, lockReleases = 0;
const writeLog = [];            // {tab, row, lockHeld}
let flushes = 0, flushesUnderLock = 0;
const readLog = [];             // {tab} — one entry per getValues over a data range

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
        if (r >= 2) readLog.push({ tab: name, rows: nr });
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
  flush: () => { flushes++; if (lockHeld) flushesUnderLock++; }
};

// ------------------------------------------------------------------ fake Drive
const driveFiles = {};   // id -> {mime, bytes}
const driveTrashed = [];
let driveUploads = 0;
let folderCalls = 0;
const DriveApp = {
  getFileById: (id) => {
    const f = driveFiles[id];
    if (!f) throw new Error('No item with the given ID could be found: ' + id);
    return {
      getId: () => id,
      getBlob: () => ({ getContentType: () => f.mime, getBytes: () => f.bytes }),
      setTrashed: () => { driveTrashed.push(id); },
      setSharing: () => {}
    };
  },
  getFolderById: (id) => {
    if (String(id).indexOf('FOLDER') !== 0) throw new Error('not a folder');
    return {
      getId: () => id,
      setSharing: () => {},
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: (n) => DriveApp.getFolderById('FOLDER_' + n),
      createFile: () => {
        driveUploads++;
        const fid = 'LOGO_' + driveUploads;
        driveFiles[fid] = { mime: 'image/png', bytes: [] };
        return { getId: () => fid };
      }
    };
  },
  getRootFolder: () => ({ getId: () => 'ROOT' }),
  getFoldersByName: () => ({ hasNext: () => false }),
  createFolder: (n) => DriveApp.getFolderById('FOLDER_' + n),
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
  Object, Array, Error, RegExp, Infinity, NaN, Buffer, Set, Map, Promise,
  encodeURIComponent, decodeURIComponent, Boolean,
  SpreadsheetApp, DriveApp, CacheService, PropertiesService, LockService, Utilities, ContentService,
  Session: { getActiveUser: () => ({ getEmail: () => '' }) }
};
vm.createContext(ctx);

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.gs') && f !== 'Tests.gs').sort();
vm.runInContext(files.map((f) => fs.readFileSync(DIR + '/' + f, 'utf8')).join('\n'), ctx, { filename: 'ALL.gs' });

const G = vm.runInContext(
  '({Repo,Util,ENUM,ERR,SHEETS,HEADERS,Teams,Audit,Auth,Cache,Drive,dispatch,buildRoutes})', ctx);

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
  try { fn(); } catch (e) {
    if (e.code !== code) throw new Error('expected ' + code + ' got ' + e.code + ' (' + e.message + ')');
    return e;
  }
  throw new Error('expected throw ' + code + ', nothing thrown');
}

// ------------------------------------------------------------------ fixtures
Object.keys(G.HEADERS).forEach((tab) => { sheets[tab] = makeSheet(tab, G.HEADERS[tab].slice()); });

const TID = 'TRN_main00000001';          // defaults set, REG_CLOSED
const TID2 = 'TRN_other0000002';         // organiser has no access
const TID3 = 'TRN_nodef00000003';        // no defaults
const TID4 = 'TRN_live00000004';         // AUCTION_LIVE
const TID5 = 'TRN_closed000005';         // AUCTION_CLOSED

function addTournament(id, extra) {
  vm.runInContext('Repo.append(SHEETS.TOURNAMENTS, ' + JSON.stringify(Object.assign({
    tournament_id: id, slug: 'slug-' + id, name: 'Cup ' + id, status: 'REG_CLOSED',
    next_serial: 1, reg_fee: 500, default_purse: 500000, default_max_players: 12,
    drive_folder_id: 'FOLDER_root', created_at: '2026-08-01T00:00:00.000Z'
  }, extra || {})) + ');', ctx);
}
addTournament(TID);
addTournament(TID2);
addTournament(TID3, { default_purse: '', default_max_players: '' });
addTournament(TID4, { status: 'AUCTION_LIVE' });
addTournament(TID5, { status: 'AUCTION_CLOSED' });

const admin = { user_id: 'USR_admin', role: 'ADMIN', tournament_id: '', token: 'tok-a' };
const org = { user_id: 'USR_org', role: 'ORGANISER', tournament_id: TID, token: 'tok-o' };
const org4 = { user_id: 'USR_org4', role: 'ORGANISER', tournament_id: TID4, token: 'tok-o4' };
const org5 = { user_id: 'USR_org5', role: 'ORGANISER', tournament_id: TID5, token: 'tok-o5' };

const T = G.Teams;
const teamRows = () => G.Repo.readAll('Teams');
const auditRows = () => G.Repo.readAll('AuditLog');
const teamsOf = (tid) => teamRows().filter((r) => r.tournament_id === tid);

console.log('\n=== Phase 3 teams: create ===');

let created1;
t('create uses tournament defaults when purse/squad omitted', () => {
  created1 = T.create({ tournamentId: TID, teamName: 'Chennai Warriors' }, org);
  eq(created1.purse_total, 500000, 'purse');
  eq(created1.max_players, 12, 'squad');
  eq(created1.purse_used, 0, 'purse_used');
  eq(created1.players_count, 0, 'players_count');
  eq(created1.team_name, 'Chennai Warriors');
  ok(/^TEM_[0-9a-z]{12}$/.test(created1.team_id), 'id shape: ' + created1.team_id);
});

t('create with explicit purse and squad overrides the defaults', () => {
  const c = T.create({
    tournamentId: TID, teamName: 'Madurai Kings', ownerName: 'R. Selvam',
    purseTotal: 600000, maxPlayers: 13
  }, org);
  eq(c.purse_total, 600000);
  eq(c.max_players, 13);
  eq(c.owner_name, 'R. Selvam');
});

t('create writes zeros for both counters on the sheet', () => {
  const row = teamRows().find((r) => r.team_name === 'Chennai Warriors');
  eq(row.purse_used, 0);
  eq(row.players_count, 0);
  eq(row.tournament_id, TID);
  eq(row.created_by, 'USR_org');
  ok(row.created_at.endsWith('Z'), 'created_at is a UTC instant: ' + row.created_at);
});

t('create audits TEAM_CREATED with next values', () => {
  const rows = auditRows().filter((r) => r.action === 'TEAM_CREATED' && r.entity_id === created1.team_id);
  eq(rows.length, 1);
  eq(rows[0].entity_type, 'Team');
  eq(rows[0].tournament_id, TID);
  eq(rows[0].prev_value, '');
  const next = JSON.parse(rows[0].new_value);
  eq(next.purse_total, 500000);
  eq(next.players_count, 0);
});

t('duplicate name — exact', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'Chennai Warriors' }, org), G.ERR.VALIDATION_FAILED);
});
t('duplicate name — different case', () => {
  const e = throwsCode(() => T.create({ tournamentId: TID, teamName: 'chennai warriors' }, org), G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('Chennai Warriors') !== -1, 'names the existing team: ' + e.message);
});
t('duplicate name — extra internal whitespace', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'Chennai   Warriors' }, org), G.ERR.VALIDATION_FAILED);
});
t('duplicate name — leading/trailing whitespace', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: '  Chennai Warriors  ' }, org), G.ERR.VALIDATION_FAILED);
});
t('a duplicate in one tournament is fine in another', () => {
  const c = T.create({ tournamentId: TID2, teamName: 'Chennai Warriors' }, admin);
  eq(c.team_name, 'Chennai Warriors');
});

t('name shorter than 2 characters is refused', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'A' }, org), G.ERR.VALIDATION_FAILED);
});
t('name longer than 40 characters is refused', () => {
  const e = throwsCode(() => T.create({ tournamentId: TID, teamName: 'X'.repeat(41) }, org), G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('41') !== -1, 'names the real length: ' + e.message);
});
t('name of exactly 40 characters is accepted', () => {
  const c = T.create({ tournamentId: TID, teamName: 'Y'.repeat(40) }, org);
  eq(c.team_name.length, 40);
});
t('name with a leading symbol is refused', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: '<script>' }, org), G.ERR.VALIDATION_FAILED);
});
t('name with digits and an ampersand is accepted', () => {
  const c = T.create({ tournamentId: TID, teamName: 'Salem 11 & Co.' }, org);
  eq(c.team_name, 'Salem 11 & Co.');
});
t('missing name is refused', () => {
  throwsCode(() => T.create({ tournamentId: TID }, org), G.ERR.VALIDATION_FAILED);
});

t('purse of zero is refused', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'Zero Purse', purseTotal: 0 }, org), G.ERR.INVALID_AMOUNT);
});
t('negative purse is refused', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'Neg Purse', purseTotal: -5 }, org), G.ERR.INVALID_AMOUNT);
});
t('decimal purse is refused rather than rounded', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'Dec Purse', purseTotal: '500000.50' }, org), G.ERR.INVALID_AMOUNT);
});
t('purse error message names the field', () => {
  const e = throwsCode(() => T.create({ tournamentId: TID, teamName: 'Bad Purse', purseTotal: 'abc' }, org), G.ERR.INVALID_AMOUNT);
  ok(e.message.indexOf('purse') !== -1, e.message);
});
t('squad size of zero is refused', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'No Slots', maxPlayers: 0 }, org), G.ERR.VALIDATION_FAILED);
});
t('decimal squad size is refused rather than truncated', () => {
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'Frac Squad', maxPlayers: '12.7' }, org), G.ERR.VALIDATION_FAILED);
});
t('squad size of 1 is accepted', () => {
  const c = T.create({ tournamentId: TID, teamName: 'Solo XI', maxPlayers: 1 }, org);
  eq(c.max_players, 1);
});

t('no default and no value — purse error explains both fixes', () => {
  const e = throwsCode(() => T.create({ tournamentId: TID3, teamName: 'Nodef A' }, admin), G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('default purse') !== -1, e.message);
});
t('no default squad size and no value is refused', () => {
  const e = throwsCode(
    () => T.create({ tournamentId: TID3, teamName: 'Nodef B', purseTotal: 100000 }, admin),
    G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('default squad size') !== -1, e.message);
});

t('unknown tournament is NOT_FOUND', () => {
  throwsCode(() => T.create({ tournamentId: 'TRN_nope', teamName: 'Ghost' }, admin), G.ERR.NOT_FOUND);
});
t('missing tournament id is VALIDATION_FAILED', () => {
  throwsCode(() => T.create({ teamName: 'Ghost' }, admin), G.ERR.VALIDATION_FAILED);
});

t('nothing was written by any of the refused creates', () => {
  const names = teamsOf(TID).map((r) => r.team_name).sort();
  eq(JSON.stringify(names), JSON.stringify([
    'Chennai Warriors', 'Madurai Kings', 'Salem 11 & Co.', 'Solo XI', 'Y'.repeat(40)
  ].sort()));
});

t('a malformed logo object is refused before anything is written', () => {
  const before = teamsOf(TID).length;
  throwsCode(() => T.create({ tournamentId: TID, teamName: 'Logo Bad', logo: { mime: 'image/png' } }, org),
    G.ERR.VALIDATION_FAILED);
  eq(teamsOf(TID).length, before);
});

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]).toString('base64');

t('a real PNG logo is uploaded and comes back as a thumbnail url', () => {
  const before = driveUploads;
  const c = T.create({
    tournamentId: TID, teamName: 'Logo Good',
    logo: { data: PNG_B64, mime: 'image/png', filename: 'crest.png' }
  }, org);
  eq(driveUploads, before + 1, 'exactly one Drive upload');
  ok(/^https:\/\/drive\.google\.com\/thumbnail\?id=LOGO_/.test(c.logo_url), c.logo_url);
  const row = G.Repo.findBy('Teams', 'team_id', c.team_id);
  ok(row.logo_file_id.indexOf('LOGO_') === 0, row.logo_file_id);
});

t('a logo whose bytes are not really an image is refused', () => {
  const before = teamsOf(TID).length;
  throwsCode(() => T.create({
    tournamentId: TID, teamName: 'Logo Fake',
    logo: { data: Buffer.from('<svg onload=alert(1)>').toString('base64'), mime: 'image/png' }
  }, org), G.ERR.VALIDATION_FAILED);
  eq(teamsOf(TID).length, before);
});

t('an obvious duplicate name never reaches Drive', () => {
  const before = driveUploads;
  throwsCode(() => T.create({
    tournamentId: TID, teamName: 'logo good',
    logo: { data: PNG_B64, mime: 'image/png' }
  }, org), G.ERR.VALIDATION_FAILED);
  eq(driveUploads, before, 'no orphan file uploaded for a name we already knew was taken');
});

t('deleting a team trashes its logo', () => {
  const c = T.create({
    tournamentId: TID, teamName: 'Logo Doomed',
    logo: { data: PNG_B64, mime: 'image/png' }
  }, org);
  const fileId = G.Repo.findBy('Teams', 'team_id', c.team_id).logo_file_id;
  T.remove({ teamId: c.team_id }, admin);
  ok(driveTrashed.indexOf(fileId) !== -1, 'logo trashed: ' + JSON.stringify(driveTrashed));
});

console.log('\n=== Phase 3 teams: createBatch ===');

const EIGHT = ['Alpha XI', 'Bravo XI', 'Charlie XI', 'Delta XI',
               'Echo XI', 'Foxtrot XI', 'Golf XI', 'Hotel XI'];

t('batch of 8 with a duplicate at position 7 writes nothing', () => {
  const before = teamsOf(TID2).length;
  const withDupe = EIGHT.slice();
  withDupe[6] = 'alpha  xi';           // same as position 1 once normalised
  const e = throwsCode(() => T.createBatch({
    tournamentId: TID2, names: withDupe, purseTotal: 500000, maxPlayers: 12
  }, admin), G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('1 and 7') !== -1, 'names both positions: ' + e.message);
  eq(teamsOf(TID2).length, before, 'no partial write');
});

t('batch of 8 succeeds and writes all 8', () => {
  const before = teamsOf(TID2).length;
  const out = T.createBatch({ tournamentId: TID2, names: EIGHT, purseTotal: 500000, maxPlayers: 12 }, admin);
  eq(out.created.length, 8);
  eq(teamsOf(TID2).length, before + 8);
  out.created.forEach((c) => { eq(c.purse_used, 0); eq(c.players_count, 0); eq(c.purse_total, 500000); });
});

t('batch appended in one setValues call', () => {
  const teamWrites = writeLog.filter((w) => w.tab === 'Teams');
  // The 8-row append is a single setValues, which the fake records as 8 log
  // entries with consecutive rows written under the lock.
  const last8 = teamWrites.slice(-8);
  eq(last8.length, 8);
  last8.forEach((w) => ok(w.lockHeld, 'batch append happened under the lock'));
  for (let i = 1; i < last8.length; i++) eq(last8[i].row, last8[i - 1].row + 1, 'contiguous rows');
});

t('batch clashing with an existing team writes nothing', () => {
  const before = teamsOf(TID2).length;
  const e = throwsCode(() => T.createBatch({
    tournamentId: TID2, names: ['New One', 'ALPHA XI', 'New Two'], purseTotal: 500000, maxPlayers: 12
  }, admin), G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('Alpha XI') !== -1, 'names the existing team: ' + e.message);
  eq(teamsOf(TID2).length, before, 'no partial write');
});

t('batch uses tournament defaults when purse/squad omitted', () => {
  const out = T.createBatch({ tournamentId: TID, names: ['Batch Def A', 'Batch Def B'] }, org);
  eq(out.created.length, 2);
  eq(out.created[0].purse_total, 500000);
  eq(out.created[0].max_players, 12);
});

t('batch with an empty list is refused', () => {
  throwsCode(() => T.createBatch({ tournamentId: TID, names: [] }, org), G.ERR.VALIDATION_FAILED);
});
t('batch with a non-array names field is refused', () => {
  throwsCode(() => T.createBatch({ tournamentId: TID, names: 'Alpha XI' }, org), G.ERR.VALIDATION_FAILED);
});
t('batch with an invalid name at position 3 writes nothing', () => {
  const before = teamsOf(TID).length;
  const e = throwsCode(() => T.createBatch({
    tournamentId: TID, names: ['Good One', 'Good Two', 'X']
  }, org), G.ERR.VALIDATION_FAILED);
  ok(e.message.indexOf('Team name 3') !== -1, e.message);
  eq(teamsOf(TID).length, before);
});
t('batch over the size cap is refused', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push('Cap Team ' + i);
  throwsCode(() => T.createBatch({ tournamentId: TID, names: many }, org), G.ERR.VALIDATION_FAILED);
});
t('batch writes one audit row per team', () => {
  const rows = auditRows().filter((r) => r.action === 'TEAM_CREATED' && r.tournament_id === TID2);
  eq(rows.length, 9, '8 batch + 1 single Chennai Warriors');
});

console.log('\n=== Phase 3 teams: list and per_slot_remaining ===');

t('list returns every team of the tournament, and only those', () => {
  const out = T.list({ tournamentId: TID2 }, admin);
  eq(out.teams.length, 9);
  out.teams.forEach((t2) => ok(t2.team_id.indexOf('TEM_') === 0));
});

t('per_slot_remaining = floor(purse_remaining / slots_remaining)', () => {
  // 500000 purse, 12 slots, nothing spent -> floor(500000/12) = 41666
  const out = T.list({ tournamentId: TID2 }, admin);
  const alpha = out.teams.find((x) => x.team_name === 'Alpha XI');
  eq(alpha.purse_remaining, 500000);
  eq(alpha.slots_remaining, 12);
  eq(alpha.per_slot_remaining, 41666);
  eq(alpha.per_slot_remaining_display, '₹41,666');
  eq(alpha.purse_remaining_display, '₹5,00,000');
});

t('per_slot_remaining reflects a partly spent purse', () => {
  // Hand-set the cached counters the way Phase 4 will, then read them back.
  const row = G.Repo.findBy('Teams', 'team_name', 'Bravo XI');
  vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + row._row + ', {purse_used: 125000, players_count: 3});', ctx);
  const out = T.list({ tournamentId: TID2 }, admin);
  const bravo = out.teams.find((x) => x.team_name === 'Bravo XI');
  eq(bravo.purse_used, 125000);
  eq(bravo.purse_remaining, 375000);
  eq(bravo.slots_remaining, 9);
  eq(bravo.per_slot_remaining, 41666);      // floor(375000/9)
  eq(bravo.players_count, 3);
});

t('per_slot_remaining is null when the squad is full', () => {
  const row = G.Repo.findBy('Teams', 'team_name', 'Charlie XI');
  vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + row._row + ', {purse_used: 400000, players_count: 12});', ctx);
  const out = T.list({ tournamentId: TID2 }, admin);
  const c = out.teams.find((x) => x.team_name === 'Charlie XI');
  eq(c.slots_remaining, 0);
  eq(c.per_slot_remaining, null);
  eq(c.per_slot_remaining_display, '');
  eq(c.purse_remaining, 100000, 'money left over on a full squad is still reported');
});

t('a zero-slot team (max_players already reached at 0 spare) is null, not a divide by zero', () => {
  const c = T.create({ tournamentId: TID, teamName: 'One Slot', purseTotal: 100000, maxPlayers: 1 }, org);
  const row = G.Repo.findBy('Teams', 'team_id', c.team_id);
  vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + row._row + ', {players_count: 1, purse_used: 100000});', ctx);
  const out = T.list({ tournamentId: TID }, org);
  const one = out.teams.find((x) => x.team_id === c.team_id);
  eq(one.slots_remaining, 0);
  eq(one.per_slot_remaining, null);
  eq(one.purse_remaining, 0);
});

t('an over-full squad clamps slots_remaining at zero', () => {
  const row = G.Repo.findBy('Teams', 'team_name', 'Delta XI');
  vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + row._row + ', {players_count: 14});', ctx);
  const out = T.list({ tournamentId: TID2 }, admin);
  const d = out.teams.find((x) => x.team_name === 'Delta XI');
  eq(d.slots_remaining, 0);
  eq(d.per_slot_remaining, null);
});

t('totals add up across the tournament', () => {
  const out = T.list({ tournamentId: TID2 }, admin);
  let pt = 0, pu = 0, pc = 0, st = 0, sr = 0;
  out.teams.forEach((x) => {
    pt += x.purse_total; pu += x.purse_used; pc += x.players_count;
    st += x.max_players; sr += x.slots_remaining;
  });
  eq(out.totals.teams, out.teams.length);
  eq(out.totals.purse_total, pt);
  eq(out.totals.purse_used, pu);
  eq(out.totals.purse_remaining, pt - pu);
  eq(out.totals.players_count, pc);
  eq(out.totals.slots_total, st);
  eq(out.totals.slots_remaining, sr);
});

t('list reads the Teams tab exactly once', () => {
  readLog.length = 0;
  T.list({ tournamentId: TID2 }, admin);
  eq(readLog.filter((r) => r.tab === 'Teams').length, 1);
});

t('list never reads the Players tab', () => {
  readLog.length = 0;
  T.list({ tournamentId: TID2 }, admin);
  eq(readLog.filter((r) => r.tab === 'Players').length, 0, 'counters must not come from a Players scan');
});

t('list is ordered by creation time', () => {
  const out = T.list({ tournamentId: TID2 }, admin);
  const rows = teamsOf(TID2);
  const byCreated = rows.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  eq(out.teams[0].team_name, byCreated[0].team_name);
});

t('list on an unknown tournament is NOT_FOUND', () => {
  throwsCode(() => T.list({ tournamentId: 'TRN_nope' }, admin), G.ERR.NOT_FOUND);
});

console.log('\n=== Phase 3 teams: squad ===');

const SQUAD_TEAM = G.Repo.findBy('Teams', 'team_name', 'Bravo XI');
function addPlayer(n, name, teamId, soldAt, amount) {
  vm.runInContext('Repo.append(SHEETS.PLAYERS, ' + JSON.stringify({
    player_id: 'PLY_' + n, tournament_id: TID2, serial_no: n, name: name, dob: '1995-01-01',
    age_years: 30, role: 'BATSMAN', style: 'RIGHT', mobile: '90000000' + String(n).padStart(2, '0'),
    photo_file_id: 'p' + n, photo_thumb_url: 'https://drive.google.com/thumbnail?id=p' + n,
    payment_status: 'VERIFIED', auction_status: 'SOLD', times_called: 1, team_id: teamId,
    sold_amount: amount, sold_at: soldAt, is_withdrawn: false, search_blob: name.toLowerCase(),
    registered_at: '2026-08-20T04:00:00.000Z'
  }) + ');', ctx);
}
// Deliberately appended out of chronological order.
addPlayer(31, 'Third Buy', SQUAD_TEAM.team_id, '2026-09-01T12:00:00.000Z', 25000);
addPlayer(11, 'First Buy', SQUAD_TEAM.team_id, '2026-09-01T10:00:00.000Z', 75000);
addPlayer(21, 'Second Buy', SQUAD_TEAM.team_id, '2026-09-01T11:00:00.000Z', 25000);
addPlayer(41, 'Not Ours', 'TEM_someoneelse', '2026-09-01T09:00:00.000Z', 90000);

t('squad lists only that team, sorted by sold_at', () => {
  const out = T.squad({ teamId: SQUAD_TEAM.team_id }, admin);
  eq(out.players.length, 3);
  eq(out.players.map((p) => p.name).join(','), 'First Buy,Second Buy,Third Buy');
  eq(out.players[0].sold_amount, 75000);
  eq(out.players[0].sold_amount_display, '₹75,000');
  eq(out.players[0].sold_at_display, '1 Sep 2026, 3:30 PM');   // 10:00Z -> IST
  eq(out.players[0].photo_thumb_url, 'https://drive.google.com/thumbnail?id=p11');
});

t('squad totals come from the cached counters, not a Players sum', () => {
  const out = T.squad({ teamId: SQUAD_TEAM.team_id }, admin);
  // The row says 125000 / 3, and the players happen to sum to 125000 / 3 too.
  eq(out.total_spent, 125000);
  eq(out.total_players, 3);
  eq(out.total_spent_display, '₹1,25,000');
  eq(out.purse_remaining_display, '₹3,75,000');
  eq(out.counters_stale, false);
});

t('squad flags drift instead of hiding it', () => {
  vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + SQUAD_TEAM._row + ', {players_count: 5});', ctx);
  const out = T.squad({ teamId: SQUAD_TEAM.team_id }, admin);
  eq(out.total_players, 5, 'still reports the cached number');
  eq(out.players.length, 3);
  eq(out.counters_stale, true);
  vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + SQUAD_TEAM._row + ', {players_count: 3});', ctx);
});

t('squad reads the Players tab exactly once', () => {
  readLog.length = 0;
  T.squad({ teamId: SQUAD_TEAM.team_id }, admin);
  eq(readLog.filter((r) => r.tab === 'Players').length, 1);
});

t('squad of an unknown team is NOT_FOUND', () => {
  throwsCode(() => T.squad({ teamId: 'TEM_nope' }, admin), G.ERR.NOT_FOUND);
});

t('an empty squad comes back as an empty list, not an error', () => {
  const echo = G.Repo.findBy('Teams', 'team_name', 'Echo XI');
  const out = T.squad({ teamId: echo.team_id }, admin);
  eq(out.players.length, 0);
  eq(out.total_players, 0);
  eq(out.counters_stale, false);
});

console.log('\n=== Phase 3 teams: update guards ===');

const UP = G.Repo.findBy('Teams', 'team_name', 'Chennai Warriors');
vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + UP._row + ', {players_count: 12, purse_used: 425000});', ctx);

t('lowering max_players below players_count is SQUAD_BELOW_COUNT', () => {
  const e = throwsCode(() => T.update({ teamId: UP.team_id, maxPlayers: 11 }, admin), G.ERR.SQUAD_BELOW_COUNT);
  eq(e.message, 'Chennai Warriors already has 12 players. You cannot set the limit to 11.');
});

t('lowering max_players to exactly players_count is allowed', () => {
  T.update({ teamId: UP.team_id, maxPlayers: 15 }, admin);       // raise first
  const out = T.update({ teamId: UP.team_id, maxPlayers: 12 }, admin);
  eq(out.max_players, 12, '12 == players_count, so the floor is not crossed');
  eq(out.changed.max_players.from, 15);
  eq(out.changed.max_players.to, 12);
  eq(out.slots_remaining, 0);
});

t('raising max_players is always allowed', () => {
  const out = T.update({ teamId: UP.team_id, maxPlayers: 13 }, admin);
  eq(out.max_players, 13);
  eq(out.slots_remaining, 1);
  eq(out.per_slot_remaining, 75000, 'floor((500000-425000)/1)');
  eq(out.changed.max_players.from, 12);
  eq(out.changed.max_players.to, 13);
});

t('lowering purse_total below purse_used is PURSE_BELOW_SPENT', () => {
  const e = throwsCode(() => T.update({ teamId: UP.team_id, purseTotal: 400000 }, admin), G.ERR.PURSE_BELOW_SPENT);
  eq(e.message, 'Chennai Warriors has already spent ₹4,25,000. You cannot set the purse to ₹4,00,000.');
});

t('lowering purse_total to exactly purse_used is allowed', () => {
  const out = T.update({ teamId: UP.team_id, purseTotal: 425000 }, admin);
  eq(out.purse_total, 425000);
  eq(out.purse_remaining, 0);
  eq(out.per_slot_remaining, 0);
});

t('raising purse_total is always allowed', () => {
  const out = T.update({ teamId: UP.team_id, purseTotal: 500000 }, admin);
  eq(out.purse_total, 500000);
  eq(out.purse_remaining, 75000);
});

t('rename to an existing name is refused', () => {
  throwsCode(() => T.update({ teamId: UP.team_id, teamName: 'Madurai Kings' }, admin), G.ERR.VALIDATION_FAILED);
});
t('rename that only differs by case from another team is refused', () => {
  throwsCode(() => T.update({ teamId: UP.team_id, teamName: 'madurai   kings' }, admin), G.ERR.VALIDATION_FAILED);
});
t('renaming a team to its own name is a no-op, not a duplicate error', () => {
  const out = T.update({ teamId: UP.team_id, teamName: 'Chennai Warriors' }, admin);
  eq(out.team_name, 'Chennai Warriors');
  eq(Object.keys(out.changed).length, 0);
});
t('rename to a free name works', () => {
  const out = T.update({ teamId: UP.team_id, teamName: 'Chennai Super Warriors' }, admin);
  eq(out.team_name, 'Chennai Super Warriors');
  eq(out.changed.team_name.from, 'Chennai Warriors');
  // put it back for the later tests
  T.update({ teamId: UP.team_id, teamName: 'Chennai Warriors' }, admin);
});

t('update with no fields at all is refused', () => {
  throwsCode(() => T.update({ teamId: UP.team_id }, admin), G.ERR.VALIDATION_FAILED);
});
t('update of an unknown team is NOT_FOUND', () => {
  throwsCode(() => T.update({ teamId: 'TEM_nope', maxPlayers: 13 }, admin), G.ERR.NOT_FOUND);
});
t('update never writes purse_used or players_count', () => {
  const row = G.Repo.findBy('Teams', 'team_id', UP.team_id);
  eq(row.purse_used, 425000, 'counters untouched by an update');
  eq(row.players_count, 12);
});

t('a rejected update writes nothing and audits nothing', () => {
  const teamWritesBefore = writeLog.filter((w) => w.tab === 'Teams').length;
  const auditBefore = auditRows().length;
  throwsCode(() => T.update({ teamId: UP.team_id, maxPlayers: 2 }, admin), G.ERR.SQUAD_BELOW_COUNT);
  eq(writeLog.filter((w) => w.tab === 'Teams').length, teamWritesBefore);
  eq(auditRows().length, auditBefore);
});

t('a no-op update audits nothing', () => {
  const before = auditRows().length;
  T.update({ teamId: UP.team_id, maxPlayers: 13 }, admin);   // already 13
  eq(auditRows().length, before);
});

t('update audits TEAM_UPDATED with prev and next', () => {
  T.update({ teamId: UP.team_id, ownerName: 'S. Raman' }, admin);
  const rows = auditRows().filter((r) => r.action === 'TEAM_UPDATED' && r.entity_id === UP.team_id);
  const last = rows[rows.length - 1];
  eq(JSON.parse(last.prev_value).owner_name, '');
  eq(JSON.parse(last.new_value).owner_name, 'S. Raman');
});

t('update holds the script lock for the whole write', () => {
  const before = writeLog.filter((w) => w.tab === 'Teams').length;
  const waitsBefore = lockWaits, releasesBefore = lockReleases, flushBefore = flushesUnderLock;
  T.update({ teamId: UP.team_id, ownerName: 'S. Raman Jr' }, admin);
  const writes = writeLog.filter((w) => w.tab === 'Teams').slice(before);
  ok(writes.length >= 1, 'the row was written');
  writes.forEach((w) => ok(w.lockHeld, 'write happened while the lock was held'));
  eq(lockWaits, waitsBefore + 1);
  eq(lockReleases, releasesBefore + 1);
  eq(flushesUnderLock, flushBefore + 1, 'flushed before the lock was released');
  eq(lockHeld, false, 'lock released afterwards');
});

t('the lock is released even when a guard throws', () => {
  const releasesBefore = lockReleases;
  throwsCode(() => T.update({ teamId: UP.team_id, maxPlayers: 1 }, admin), G.ERR.SQUAD_BELOW_COUNT);
  eq(lockReleases, releasesBefore + 1);
  eq(lockHeld, false);
});

console.log('\n=== Phase 3 teams: delete ===');

t('delete is refused while the team has players', () => {
  const e = throwsCode(() => T.remove({ teamId: UP.team_id }, admin), G.ERR.TEAM_NOT_EMPTY);
  ok(e.message.indexOf('12 players') !== -1, e.message);
});

t('delete removes an empty team and audits it', () => {
  const victim = T.create({ tournamentId: TID, teamName: 'Doomed XI' }, org);
  const before = teamsOf(TID).length;
  const out = T.remove({ teamId: victim.team_id }, admin);
  eq(out.deleted, true);
  eq(out.team_name, 'Doomed XI');
  eq(teamsOf(TID).length, before - 1);
  eq(G.Repo.findBy('Teams', 'team_id', victim.team_id), null);
  const rows = auditRows().filter((r) => r.action === 'TEAM_DELETED' && r.entity_id === victim.team_id);
  eq(rows.length, 1);
  eq(JSON.parse(rows[0].prev_value).team_name, 'Doomed XI');
  eq(rows[0].new_value, '');
});

t('delete is refused when AuctionResults disagrees with a zero players_count', () => {
  const ghost = T.create({ tournamentId: TID, teamName: 'Ghost XI' }, org);
  vm.runInContext('Repo.append(SHEETS.AUCTION_RESULTS, ' + JSON.stringify({
    auction_id: 'AUC_ghost1', tournament_id: TID, player_id: 'PLY_g1', serial_no: 99,
    status: 'SOLD', team_id: ghost.team_id, amount: 50000,
    auction_time: '2026-09-01T10:00:00.000Z', recorded_by: 'USR_admin', is_current: true,
    supersedes_auction_id: '', note: ''
  }) + ');', ctx);
  const e = throwsCode(() => T.remove({ teamId: ghost.team_id }, admin), G.ERR.TEAM_NOT_EMPTY);
  ok(e.message.indexOf('recount') !== -1, e.message);
  ok(G.Repo.findBy('Teams', 'team_id', ghost.team_id) !== null, 'still there');
});

t('delete of an unknown team is NOT_FOUND', () => {
  throwsCode(() => T.remove({ teamId: 'TEM_nope' }, admin), G.ERR.NOT_FOUND);
});
t('delete without a team id is VALIDATION_FAILED', () => {
  throwsCode(() => T.remove({}, admin), G.ERR.VALIDATION_FAILED);
});

console.log('\n=== Phase 3 teams: permissions ===');

t('an organiser cannot create in another tournament', () => {
  throwsCode(() => T.create({ tournamentId: TID2, teamName: 'Trespass XI' }, org), G.ERR.FORBIDDEN);
});
t('an organiser cannot list another tournament', () => {
  throwsCode(() => T.list({ tournamentId: TID2 }, org), G.ERR.FORBIDDEN);
});
t('an organiser cannot batch-create in another tournament', () => {
  throwsCode(() => T.createBatch({ tournamentId: TID2, names: ['A One', 'B Two'] }, org), G.ERR.FORBIDDEN);
});
t('an organiser cannot see another tournament\'s squad', () => {
  throwsCode(() => T.squad({ teamId: SQUAD_TEAM.team_id }, org), G.ERR.FORBIDDEN);
});
t('an organiser cannot update another tournament\'s team', () => {
  throwsCode(() => T.update({ teamId: SQUAD_TEAM.team_id, maxPlayers: 13 }, org), G.ERR.FORBIDDEN);
});
t('an admin may touch any tournament', () => {
  const out = T.list({ tournamentId: TID }, admin);
  ok(out.teams.length > 0);
});

t('hasAnySale is false while AuctionResults has no current SOLD row for the tournament', () => {
  eq(T.hasAnySale(TID2), false);
  eq(T.hasAnySale(''), false);
});
t('hasAnySale is true once a current SOLD row exists', () => {
  eq(T.hasAnySale(TID), true, 'the Ghost XI row above is a current SOLD row');
});
t('hasAnySale ignores superseded rows', () => {
  vm.runInContext('Repo.append(SHEETS.AUCTION_RESULTS, ' + JSON.stringify({
    auction_id: 'AUC_old1', tournament_id: TID2, player_id: 'PLY_o1', serial_no: 98,
    status: 'SOLD', team_id: 'TEM_whatever', amount: 10000,
    auction_time: '2026-09-01T09:00:00.000Z', recorded_by: 'USR_admin', is_current: false,
    supersedes_auction_id: '', note: 'reversed'
  }) + ');', ctx);
  eq(T.hasAnySale(TID2), false, 'a superseded sale is history, not a live sale');
});
t('hasAnySale ignores UNSOLD rows', () => {
  vm.runInContext('Repo.append(SHEETS.AUCTION_RESULTS, ' + JSON.stringify({
    auction_id: 'AUC_uns1', tournament_id: TID2, player_id: 'PLY_u1', serial_no: 97,
    status: 'UNSOLD', team_id: '', amount: '',
    auction_time: '2026-09-01T09:30:00.000Z', recorded_by: 'USR_admin', is_current: true,
    supersedes_auction_id: '', note: ''
  }) + ');', ctx);
  eq(T.hasAnySale(TID2), false);
});

t('an organiser is refused once the tournament has a sale, admin is not', () => {
  const e = throwsCode(() => T.create({ tournamentId: TID, teamName: 'Late XI' }, org), G.ERR.FORBIDDEN);
  ok(e.message.indexOf('admin') !== -1, e.message);
  throwsCode(() => T.update({ teamId: UP.team_id, maxPlayers: 14 }, org), G.ERR.FORBIDDEN);
  // The admin path still works.
  const out = T.update({ teamId: UP.team_id, maxPlayers: 14 }, admin);
  eq(out.max_players, 14);
});

t('an organiser may still read after a sale', () => {
  const out = T.list({ tournamentId: TID }, org);
  ok(out.teams.length > 0);
  const s = T.squad({ teamId: UP.team_id }, org);
  eq(s.total_players, 12);
});

t('an organiser is refused after the auction is closed', () => {
  throwsCode(() => T.create({ tournamentId: TID5, teamName: 'Too Late XI' }, org5), G.ERR.AUCTION_CLOSED);
});
t('an admin may still create after the auction is closed', () => {
  const c = T.create({ tournamentId: TID5, teamName: 'Admin Late XI' }, admin);
  eq(c.team_name, 'Admin Late XI');
});

console.log('\n=== Phase 3 teams: auction version bump ===');

t('creating a team while AUCTION_LIVE bumps the version', () => {
  const before = G.Cache.getVersion(TID4);
  T.create({ tournamentId: TID4, teamName: 'Live XI' }, org4);
  eq(G.Cache.getVersion(TID4), before + 1);
});
t('updating a team while AUCTION_LIVE bumps the version', () => {
  const live = G.Repo.findBy('Teams', 'team_name', 'Live XI');
  const before = G.Cache.getVersion(TID4);
  T.update({ teamId: live.team_id, maxPlayers: 13 }, admin);
  eq(G.Cache.getVersion(TID4), before + 1);
});
t('changing a team in a tournament that is not live does not bump', () => {
  const before = G.Cache.getVersion(TID);
  T.update({ teamId: UP.team_id, ownerName: 'No Bump' }, admin);
  eq(G.Cache.getVersion(TID), before);
});

console.log('\n=== Phase 3 teams: recomputeCounters ===');

t('recompute over an empty AuctionResults produces zeros', () => {
  // TID3 has no results at all; give it a team with junk counters.
  const c = T.create({ tournamentId: TID3, teamName: 'Drifted XI', purseTotal: 300000, maxPlayers: 10 }, admin);
  const row = G.Repo.findBy('Teams', 'team_id', c.team_id);
  vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + row._row + ', {purse_used: 99999, players_count: 7});', ctx);

  const report = T.recomputeCounters(TID3);
  eq(report.sold_rows_counted, 0);
  eq(report.teams_checked, 1);
  eq(report.teams_changed, 1);
  eq(report.changes[0].purse_used.from, 99999);
  eq(report.changes[0].purse_used.to, 0);
  eq(report.changes[0].players_count.to, 0);
  const after = G.Repo.findBy('Teams', 'team_id', c.team_id);
  eq(after.purse_used, 0);
  eq(after.players_count, 0);
});

t('recompute is a no-op the second time', () => {
  const report = T.recomputeCounters(TID3);
  eq(report.teams_changed, 0);
  eq(report.changes.length, 0);
});

t('recompute rebuilds the right numbers from seeded AuctionResults', () => {
  const a = T.create({ tournamentId: TID3, teamName: 'Recount A', purseTotal: 500000, maxPlayers: 12 }, admin);
  const b = T.create({ tournamentId: TID3, teamName: 'Recount B', purseTotal: 500000, maxPlayers: 12 }, admin);
  const seed = [
    { id: 'r1', team: a.team_id, amt: 40000, cur: true, st: 'SOLD' },
    { id: 'r2', team: a.team_id, amt: 60000, cur: true, st: 'SOLD' },
    { id: 'r3', team: a.team_id, amt: 90000, cur: false, st: 'SOLD' },   // superseded
    { id: 'r4', team: b.team_id, amt: 15000, cur: true, st: 'SOLD' },
    { id: 'r5', team: b.team_id, amt: 0, cur: true, st: 'UNSOLD' },      // not a sale
    { id: 'r6', team: '', amt: 5000, cur: true, st: 'SOLD' }             // orphan
  ];
  seed.forEach((s, i) => {
    vm.runInContext('Repo.append(SHEETS.AUCTION_RESULTS, ' + JSON.stringify({
      auction_id: 'AUC_' + s.id, tournament_id: TID3, player_id: 'PLY_' + s.id, serial_no: i + 1,
      status: s.st, team_id: s.team, amount: s.amt,
      auction_time: '2026-09-01T1' + i + ':00:00.000Z', recorded_by: 'USR_admin',
      is_current: s.cur, supersedes_auction_id: '', note: ''
    }) + ');', ctx);
  });

  const report = T.recomputeCounters(TID3);
  eq(report.sold_rows_counted, 4, '3 current SOLD with a team + 1 blank-team SOLD');
  eq(report.teams_changed, 2);
  eq(report.orphan_team_ids.length, 1);
  ok(report.orphan_team_ids[0].indexOf('AUC_r6') !== -1, report.orphan_team_ids[0]);

  const ra = G.Repo.findBy('Teams', 'team_id', a.team_id);
  const rb = G.Repo.findBy('Teams', 'team_id', b.team_id);
  eq(ra.purse_used, 100000, 'superseded row excluded');
  eq(ra.players_count, 2);
  eq(rb.purse_used, 15000, 'UNSOLD row excluded');
  eq(rb.players_count, 1);
});

t('recompute reports a SOLD row pointing at a team that no longer exists', () => {
  vm.runInContext('Repo.append(SHEETS.AUCTION_RESULTS, ' + JSON.stringify({
    auction_id: 'AUC_orph', tournament_id: TID3, player_id: 'PLY_orph', serial_no: 77,
    status: 'SOLD', team_id: 'TEM_deletedteam', amount: 7000,
    auction_time: '2026-09-01T20:00:00.000Z', recorded_by: 'USR_admin', is_current: true,
    supersedes_auction_id: '', note: ''
  }) + ');', ctx);
  const report = T.recomputeCounters(TID3);
  ok(report.orphan_team_ids.indexOf('TEM_deletedteam') !== -1, JSON.stringify(report.orphan_team_ids));
});

t('recompute holds the lock and needs a tournament id', () => {
  const waits = lockWaits;
  T.recomputeCounters(TID3);
  eq(lockWaits, waits + 1);
  throwsCode(() => T.recomputeCounters(''), G.ERR.VALIDATION_FAILED);
});

t('team.recount audits every corrected team', () => {
  const c = T.create({ tournamentId: TID3, teamName: 'Recount C', purseTotal: 500000, maxPlayers: 12 }, admin);
  const row = G.Repo.findBy('Teams', 'team_id', c.team_id);
  vm.runInContext('Repo.updateRow(SHEETS.TEAMS, ' + row._row + ', {purse_used: 12345, players_count: 4});', ctx);
  const before = auditRows().filter((r) => r.action === 'TEAM_UPDATED').length;
  const report = T.recount({ tournamentId: TID3 }, admin);
  eq(report.teams_changed, 1);
  const rows = auditRows().filter((r) => r.action === 'TEAM_UPDATED' && r.entity_id === c.team_id);
  eq(rows.length, 1);
  eq(JSON.parse(rows[0].prev_value).purse_used, 12345);
  eq(JSON.parse(rows[0].new_value).reason, 'RECOUNT_FROM_AUCTION_RESULTS');
  eq(auditRows().filter((r) => r.action === 'TEAM_UPDATED').length, before + 1);
});

t('team.recount on an unknown tournament is NOT_FOUND', () => {
  throwsCode(() => T.recount({ tournamentId: 'TRN_nope' }, admin), G.ERR.NOT_FOUND);
});

console.log('\n=== Phase 3 teams: routing ===');

const routes = vm.runInContext('buildRoutes()', ctx);
t('all seven team actions are registered, POST only', () => {
  ['team.create', 'team.createBatch', 'team.list', 'team.squad', 'team.update',
   'team.delete', 'team.recount'].forEach((n) => {
    ok(routes[n], 'missing route ' + n);
    eq(JSON.stringify(routes[n].methods), '["POST"]', n);
    ok(typeof routes[n].handler === 'function', n);
  });
});
t('delete and recount are ADMIN only; the rest allow ORGANISER', () => {
  eq(JSON.stringify(routes['team.delete'].auth), '["ADMIN"]');
  eq(JSON.stringify(routes['team.recount'].auth), '["ADMIN"]');
  ['team.create', 'team.createBatch', 'team.list', 'team.squad', 'team.update'].forEach((n) => {
    eq(JSON.stringify(routes[n].auth), '["ORGANISER","ADMIN"]', n);
  });
});
t('no team action is PUBLIC', () => {
  Object.keys(routes).filter((n) => n.indexOf('team.') === 0)
    .forEach((n) => ok(routes[n].auth !== 'PUBLIC', n));
});

t('dispatch wraps a handler result in the ok envelope', () => {
  vm.runInContext('Repo.append(SHEETS.SESSIONS, ' + JSON.stringify({
    token: 'tok-a', user_id: 'USR_admin', role: 'ADMIN', tournament_id: '',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 36e5).toISOString(), revoked: false
  }) + ');', ctx);
  const res = vm.runInContext(
    'dispatch("team.list", {tournamentId: ' + JSON.stringify(TID2) + '}, "tok-a", "POST", null)', ctx);
  eq(res.ok, true, JSON.stringify(res));
  ok(Array.isArray(res.data.teams));
  ok(res.data.totals !== undefined);
});

t('dispatch turns a guard into the right error envelope', () => {
  const res = vm.runInContext(
    'dispatch("team.update", {teamId: ' + JSON.stringify(UP.team_id) + ', maxPlayers: 1}, "tok-a", "POST", null)', ctx);
  eq(res.ok, false);
  eq(res.error.code, 'SQUAD_BELOW_COUNT');
  ok(res.error.message.indexOf('12 players') !== -1, res.error.message);
});

t('team.list is not reachable over GET', () => {
  eq(routes['team.list'].methods.indexOf('GET'), -1);
});

// ------------------------------------------------------------------ summary
console.log('\n' + '-'.repeat(60));
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
