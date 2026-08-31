#!/usr/bin/env node
/**
 * tools/check.js — static integration checks for a codebase that cannot be run locally.
 *
 * WHY THIS EXISTS
 *   The backend is Google Apps Script. It only truly runs inside Google, against a
 *   real Spreadsheet and real Drive. That makes the usual feedback loop — edit, run,
 *   see the error — unavailable. Worse, the failure modes that matter here are
 *   load-time ones: Apps Script concatenates every .gs file into ONE global scope,
 *   so two files declaring the same top-level name is a fatal
 *   "Identifier 'X' has already been declared" that kills the whole project,
 *   including the web app the tournament depends on.
 *
 *   This script reproduces that concatenation in a Node vm with stubbed Google
 *   services, so those failures surface here instead of at a venue.
 *
 * WHAT IT DOES NOT DO
 *   It does not test behaviour. It cannot — there is no Spreadsheet. Behaviour is
 *   covered by backend/Tests.gs, which runs inside Apps Script against a TEST sheet.
 *   This is the cheap check you run on every edit; that is the real one you run
 *   before deploying.
 *
 * USAGE
 *   node tools/check.js          from the repo root
 *   npm run check
 *
 * Exit code is non-zero if any check fails, so it works in CI.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');

let failures = 0;
let checks = 0;

function ok(msg) { checks++; console.log('  ok    ' + msg); }
function bad(msg) { checks++; failures++; console.log('  FAIL  ' + msg); }
function section(name) { console.log('\n' + name); }

/** Strip comments so scanners do not match filenames or JSDoc type annotations. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}

/**
 * Stubs for the Google services. Utilities is real crypto, because the signed-byte
 * conversion is a genuine source of bugs and we want the real byte ranges.
 * Apps Script returns bytes as signed (-128..127); Node returns unsigned. The
 * mapping below reproduces the Apps Script behaviour deliberately.
 */
function makeContext() {
  const lazy = (name) => new Proxy(function () {}, {
    get: (t, p) => (p === 'toString' ? () => name : lazy(name + '.' + String(p))),
    apply: () => lazy(name + '()'),
    construct: () => lazy(name)
  });
  const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));

  return {
    console, Date, Math, JSON, isNaN, isFinite, parseInt, parseFloat,
    String, Number, Object, Array, Error, RegExp, Infinity, NaN,
    encodeURIComponent, decodeURIComponent, Boolean, Set, Map, Promise,
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_alg, s) => signed(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
      computeHmacSha256Signature: (m, k) => signed(crypto.createHmac('sha256', String(k)).update(String(m)).digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64Decode: (s) => signed(Buffer.from(s, 'base64')),
      base64Encode: (s) => Buffer.from(String(s)).toString('base64'),
      newBlob: (x) => ({ getBytes: () => Buffer.from(String(x)) }),
      formatDate: () => '',
      sleep: () => {}
    },
    SpreadsheetApp: lazy('SpreadsheetApp'),
    DriveApp: lazy('DriveApp'),
    CacheService: lazy('CacheService'),
    PropertiesService: lazy('PropertiesService'),
    LockService: lazy('LockService'),
    ContentService: lazy('ContentService'),
    Session: lazy('Session'),
    HtmlService: lazy('HtmlService'),
    UrlFetchApp: lazy('UrlFetchApp')
  };
}

// ---------------------------------------------------------------------------

function checkBackend() {
  section('Backend — Apps Script concatenation');

  const files = fs.readdirSync(BACKEND).filter((f) => f.endsWith('.gs')).sort();
  if (!files.length) { bad('no .gs files found in backend/'); return null; }

  // 1. Duplicate top-level declarations. Fatal at load time in Apps Script.
  const decl = Object.create(null);
  for (const f of files) {
    const src = fs.readFileSync(path.join(BACKEND, f), 'utf8');
    for (const m of stripComments(src).matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      (decl[m[1]] = decl[m[1]] || []).push(f);
    }
  }
  const dupes = Object.entries(decl).filter(([, fl]) => fl.length > 1);
  if (dupes.length) {
    for (const [n, fl] of dupes) bad(`duplicate global "${n}" in ${fl.join(', ')} — fatal at load`);
  } else {
    ok(`no duplicate globals across ${files.length} files`);
  }

  // 2. Load everything as one script, exactly as Apps Script does.
  const ctx = makeContext();
  vm.createContext(ctx);
  const combined = files.map((f) => fs.readFileSync(path.join(BACKEND, f), 'utf8')).join('\n');
  try {
    vm.runInContext(combined, ctx, { filename: 'ALL.gs' });
    ok('all files load together in one global scope');
  } catch (e) {
    bad('load failed: ' + e.message);
    return null;
  }

  // 3. Required entry points. Apps Script calls these by name.
  const entries = ['doGet', 'doPost', 'buildRoutes', 'setup', 'seedAdmin', 'runAllTests', 'resetTestData'];
  const missingEntries = entries.filter((n) => typeof ctx[n] !== 'function');
  if (missingEntries.length) bad('missing entry points: ' + missingEntries.join(', '));
  else ok('all entry points present: ' + entries.join(', '));

  // 4. Cross-module symbol resolution. A typo like Util.formatIst only shows up
  //    at call time in Apps Script, which could be mid-auction.
  vm.runInContext(
    // EVERY module, not a subset. This list was missing Teams, Payments,
    // Auction, Organisers and Reports, so a call to a function that does not
    // exist on any of them passed silently — which it did: Teams._trashLogo
    // (the real name is _trashQuietly) was caught by reading the code, not by
    // this check. A missing module here is a hole in the only guard against a
    // typo that would otherwise surface mid-auction.
    'globalThis.__mods = {Util, Repo, Cache, Auth, Audit, Drive, Players, Tournaments, ' +
    'Teams, Payments, Auction, Organisers, Reports, ' +
    'SHEETS, HEADERS, ENUM, ERR, ID_PREFIX, DEFAULTS};', ctx
  );
  let missing = 0;
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(BACKEND, f), 'utf8'));
    for (const [name, obj] of Object.entries(ctx.__mods)) {
      if (!obj || typeof obj !== 'object') continue;
      const re = new RegExp('(?<![\\w$.])' + name + '\\.([A-Za-z_$][\\w$]*)', 'g');
      for (const m of src.matchAll(re)) {
        // "Payments.gs" in prose is a FILENAME, not a member reference. Module
        // names double as file names throughout this project, so every mention
        // of a sibling file in a string or a surviving comment would otherwise
        // be reported as a missing function.
        if (m[1] === 'gs') continue;
        if (!(m[1] in obj)) { bad(`${f}: ${name}.${m[1]} does not exist`); missing++; }
      }
    }
  }
  if (!missing) ok('every cross-module reference resolves');

  // 5. Only Repo.gs may touch SpreadsheetApp (CONTRACTS.md §5).
  const offenders = files.filter((f) =>
    f !== 'Repo.gs' && /(?<![\w$.])SpreadsheetApp\./.test(stripComments(fs.readFileSync(path.join(BACKEND, f), 'utf8')))
  );
  if (offenders.length) bad('SpreadsheetApp used outside Repo.gs: ' + offenders.join(', '));
  else ok('only Repo.gs touches SpreadsheetApp');

  // 6. Schema integrity: every HEADERS tab is listed in SHEETS and vice versa.
  const SHEETS = ctx.__mods.SHEETS, HEADERS = ctx.__mods.HEADERS;
  const tabNames = Object.values(SHEETS);
  const headerTabs = Object.keys(HEADERS);
  const noHeaders = tabNames.filter((t) => !headerTabs.includes(t));
  const noTab = headerTabs.filter((t) => !tabNames.includes(t));
  if (noHeaders.length || noTab.length) {
    bad('SHEETS/HEADERS mismatch: no headers for [' + noHeaders + '], no tab for [' + noTab + ']');
  } else {
    ok(`schema consistent: ${tabNames.length} tabs, all with headers`);
  }
  for (const [tab, cols] of Object.entries(HEADERS)) {
    const seen = new Set();
    const dup = cols.filter((c) => seen.size === seen.add(c).size);
    if (dup.length) bad(`${tab} has duplicate columns: ${dup.join(', ')}`);
  }

  return ctx;
}

function checkRoutes(ctx) {
  if (!ctx) return;
  section('Backend — route table');

  let routes;
  try {
    vm.runInContext('globalThis.__routes = buildRoutes();', ctx);
    routes = ctx.__routes;
  } catch (e) {
    bad('buildRoutes() threw: ' + e.message);
    return;
  }

  const names = Object.keys(routes).sort();
  ok(`${names.length} actions registered`);

  // Every route must declare auth and methods, or the dispatcher misbehaves.
  for (const n of names) {
    const r = routes[n];
    if (!r || !r.auth || !Array.isArray(r.methods) || typeof r.handler !== 'function') {
      bad(`route "${n}" is malformed (needs auth, methods[], handler)`);
    }
  }

  // The public surface is a security boundary. Anything public is reachable by
  // anyone on the internet who finds the /exec URL, so the list is pinned here:
  // adding a public action should be a deliberate act that fails this check first.
  const EXPECTED_PUBLIC = [
    'system.ping', 'auth.login',
    // The organiser has no account yet, so there is no session token to send;
    // the one-time join token in the payload is the credential (PHASE3 §1).
    'auth.organiserJoin',
    'tournament.getPublic', 'player.register', 'player.checkMobile',
    // The projector runs unattended on a venue laptop with no operator signed
    // in. Its credential is the tournament's display_token in the query string
    // (PHASE4-7 §4.2). Read-only: it exposes no controls and no personal data.
    'auction.displayState'
  ].sort();
  const actualPublic = names.filter((n) => routes[n] && routes[n].auth === 'PUBLIC').sort();
  const unexpected = actualPublic.filter((n) => !EXPECTED_PUBLIC.includes(n));
  const absent = EXPECTED_PUBLIC.filter((n) => !actualPublic.includes(n));

  if (unexpected.length) {
    bad('UNEXPECTED PUBLIC ACTION(S): ' + unexpected.join(', ') +
        ' — if deliberate, add to EXPECTED_PUBLIC in tools/check.js');
  }
  if (absent.length) bad('expected public action(s) missing: ' + absent.join(', '));
  if (!unexpected.length && !absent.length) {
    ok('public surface is exactly: ' + actualPublic.join(', '));
  }

  console.log('\n  Registered actions:');
  for (const n of names) {
    const r = routes[n];
    const auth = Array.isArray(r.auth) ? r.auth.join('/') : String(r.auth);
    console.log('    ' + n.padEnd(28) + auth.padEnd(18) + (r.methods || []).join(','));
  }
}

function checkFrontend() {
  section('Frontend');

  const jsFiles = [];
  for (const dir of ['js', 'js/pages']) {
    const full = path.join(FRONTEND, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) if (f.endsWith('.js')) jsFiles.push(path.join(dir, f));
  }
  if (!jsFiles.length) { bad('no frontend JS found'); return; }

  // Scripts share one global scope in the browser too — same duplicate risk.
  const decl = Object.create(null);
  for (const f of jsFiles) {
    const src = stripComments(fs.readFileSync(path.join(FRONTEND, f), 'utf8'));
    for (const m of src.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      (decl[m[1]] = decl[m[1]] || []).push(f);
    }
  }
  const dupes = Object.entries(decl).filter(([, fl]) => fl.length > 1);
  if (dupes.length) for (const [n, fl] of dupes) bad(`duplicate frontend global "${n}" in ${fl.join(', ')}`);
  else ok(`no duplicate globals across ${jsFiles.length} frontend files`);

  // XSS guard. Tournament names and player names come from a sheet; the
  // tournament id comes from the URL. Both are untrusted (CONTRACTS.md §15).
  let unsafe = 0;
  for (const f of jsFiles) {
    const src = stripComments(fs.readFileSync(path.join(FRONTEND, f), 'utf8'));
    for (const pattern of ['innerHTML', 'outerHTML', 'document.write', 'eval(']) {
      if (src.includes(pattern)) { bad(`${f}: uses ${pattern} — textContent only`); unsafe++; }
    }
    // Every request must go through API so the text/plain + token-in-body rule
    // is applied in exactly one place.
    if (!f.endsWith('api.js') && /(?<![.\w])fetch\s*\(/.test(src)) {
      bad(`${f}: raw fetch() outside api.js`); unsafe++;
    }
  }
  if (!unsafe) ok('no innerHTML/eval/document.write, no fetch outside api.js');

  // Every script the shell loads must exist, or the page silently half-works.
  const indexPath = path.join(FRONTEND, 'index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    let broken = 0;
    for (const m of html.matchAll(/(?:src|href)="((?!https?:|\/\/)[^"]+)"/g)) {
      if (!fs.existsSync(path.join(FRONTEND, m[1]))) { bad(`index.html references missing ${m[1]}`); broken++; }
    }
    if (!broken) ok('every local file index.html references exists');
  }

  // The placeholder must never reach production; the Pages workflow also checks.
  const cfg = path.join(FRONTEND, 'js/config.js');
  if (fs.existsSync(cfg) && /PASTE_YOUR/.test(fs.readFileSync(cfg, 'utf8'))) {
    console.log('  note  config.js still has the placeholder API_BASE_URL (expected until deploy)');
  }
}

// ---------------------------------------------------------------------------

console.log('Cricket Auction — static checks');
const ctx = checkBackend();
checkRoutes(ctx);
checkFrontend();

console.log('\n' + '-'.repeat(60));
if (failures) {
  console.log(`${checks - failures}/${checks} checks passed, ${failures} FAILED`);
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
console.log('\nReminder: these are static checks. Behaviour is covered by');
console.log('backend/Tests.gs, run from the Apps Script editor against a TEST sheet.');
