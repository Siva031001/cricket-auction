/**
 * Verification harness for frontend/js/pages/admin-audit.js and
 * frontend/js/pages/admin-reports.js — the Phase 6/7 admin screens.
 *
 * Same approach as tools/harness/frontend/admin-players.test.js: a tiny DOM,
 * the REAL frontend/js/ui.js loaded from disk, stubs for API / Router / App,
 * then assertions. Nothing test-shaped ships in frontend/ — the project has
 * no build step and no npm runtime deps.
 *
 * Run:  node tools/test.js reports
 *       node tools/harness/frontend/admin-reports.test.js
 *
 * tools/test.js runs every harness with cwd = backend/, so every path here is
 * resolved from __dirname rather than from the process cwd.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..', '..', '..', 'frontend');

/* ==================================================================== *
 * 1. Minimal DOM
 * ==================================================================== */

function TextNode(text) { this.nodeType = 3; this._text = String(text); }
Object.defineProperty(TextNode.prototype, 'textContent', {
  get() { return this._text; },
  set(v) { this._text = String(v); }
});

function El(tag) {
  this.nodeType = 1;
  this.tagName = String(tag).toUpperCase();
  this.children = [];
  this.attributes = {};
  this.dataset = {};
  this.style = {};
  this._own = '';
  this._listeners = {};
  this.value = '';
  this.checked = false;
  this.disabled = false;
  this.hidden = false;
  this.className = '';
}

Object.defineProperty(El.prototype, 'textContent', {
  get() { return this._own + this.children.map((c) => c.textContent).join(''); },
  set(v) { this.children = []; this._own = String(v); }
});

El.prototype.appendChild = function (node) {
  if (!node) throw new Error('appendChild(null) on <' + this.tagName + '>');
  this.children.push(node);
  node.parentNode = this;
  return node;
};
El.prototype.removeChild = function (node) {
  const i = this.children.indexOf(node);
  if (i >= 0) this.children.splice(i, 1);
  node.parentNode = null;
  return node;
};
El.prototype.insertBefore = function (node) { return this.appendChild(node); };
El.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
El.prototype.removeAttribute = function (k) { delete this.attributes[k]; };
El.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
};
El.prototype.hasAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attributes, k);
};
El.prototype.addEventListener = function (type, fn) {
  (this._listeners[type] = this._listeners[type] || []).push(fn);
};
El.prototype.removeEventListener = function () {};
El.prototype.dispatch = function (type, ev) {
  (this._listeners[type] || []).slice().forEach((fn) => fn(ev || { preventDefault() {} }));
};
El.prototype.click = function () {
  if (this.disabled) return;
  this.dispatch('click', { preventDefault() {}, stopPropagation() {} });
};
El.prototype.focus = function () { global.document.activeElement = this; };
El.prototype.select = function () {};
El.prototype.scrollIntoView = function () {};
El.prototype.querySelectorAll = function (sel) {
  const want = String(sel).toUpperCase();
  return all(this).filter((e) => e.tagName === want);
};

function all(root) {
  const out = [];
  (function walk(n) {
    (n.children || []).forEach((c) => {
      if (c.nodeType !== 1) return;
      out.push(c);
      walk(c);
    });
  })(root);
  return out;
}
function byTag(root, tag) { return all(root).filter((e) => e.tagName === tag.toUpperCase()); }
function byClass(root, cls) {
  return all(root).filter((e) => String(e.className).split(/\s+/).indexOf(cls) !== -1);
}
function oneByClass(root, cls) { return byClass(root, cls)[0] || null; }

const log = {
  navigations: [], apiCalls: [], anchors: [], blobs: [], objectUrls: [], revoked: []
};

global.document = {
  title: '',
  body: new El('body'),
  activeElement: null,
  createElement: (t) => {
    const el = new El(t);
    if (el.tagName === 'A') log.anchors.push(el);
    return el;
  },
  createTextNode: (t) => new TextNode(t),
  getElementById: () => null,
  execCommand: () => true,
  addEventListener() {},
  removeEventListener() {}
};

/* The download path: Blob + object URL + a synthetic <a download> click.
   Every one of them is recorded so the assertions can check that the bytes
   the server sent are the bytes that reach the file, unmodified. */
function Blob(parts, opts) {
  this.parts = parts || [];
  this.type = String((opts || {}).type || '');
  this.size = this.parts.reduce((n, p) => n + ((p && p.length) || 0), 0);
  log.blobs.push(this);
}
global.Blob = Blob;

global.window = {
  location: { origin: 'https://example.github.io', pathname: '/', search: '' },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  navigator: { userAgent: 'HarnessAgent/1.0', clipboard: null },
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  URL: {
    createObjectURL: (blob) => {
      log.objectUrls.push(blob);
      return 'blob:harness/' + log.objectUrls.length;
    },
    revokeObjectURL: (url) => { log.revoked.push(url); }
  },
  localStorage: (() => {
    const m = {};
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: (k) => { delete m[k]; }
    };
  })()
};

/* ==================================================================== *
 * 2. Stubs for the modules other agents own
 * ==================================================================== */

global.CONFIG = { BASE_PATH: '/cricket-auction', TOKEN_KEY: 'ca.session.token' };

/* App as app.js actually exposes it: the tournament selection lives in the
   URL as ?t=, read through App.currentTournamentId and written into every
   internal link by App.adminPath. adminNav is the shared admin bar. */
const APP_HELPERS = {
  TOURNAMENT_PARAM: 't',
  currentTournamentId: (ctx) => String(((ctx && ctx.query) || {}).t || ''),
  adminPath: (p, id) => (id
    ? p + (p.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(id)
    : p),
  tournamentName: (id) => (id === 'TRN_1' ? 'Summer Cup' : ''),
  adminNav: (activeKey) => {
    const nav = new El('nav');
    nav.className = 'admin-nav';
    nav.setAttribute('data-active', String(activeKey));
    return nav;
  }
};

global.App = Object.assign({ root: new El('div'), intendedPath: null }, APP_HELPERS);
global.Router = {
  href: (p) => '/cricket-auction' + p,
  navigate: (to, opts) => { log.navigations.push({ to, opts: opts || {} }); }
};

const responses = {};
function respond(action, fn) { (responses[action] = responses[action] || []).push(fn); }
/** Same reply for every call to this action. */
function always(action, fn) { responses[action] = { always: fn }; }

global.API = {
  _token: null,
  setToken(t) { API._token = t; },
  getToken() { return API._token; },
  clearToken() { API._token = null; },
  call(action, payload, opts) {
    log.apiCalls.push({ action, payload, opts });
    const queue = responses[action];
    if (queue && queue.always) return Promise.resolve().then(() => queue.always(payload));
    if (!queue || !queue.length) {
      return Promise.reject({ code: 'INTERNAL_ERROR', message: 'harness: no stub for ' + action });
    }
    return Promise.resolve().then(() => queue.shift()(payload));
  }
};

/* ==================================================================== *
 * 3. Load the real ui.js and the two pages under test
 * ==================================================================== */

function load(relPath, globalName) {
  const src = fs.readFileSync(path.join(FRONTEND, relPath), 'utf8');
  new Function(src + '\n;globalThis.' + globalName + ' = ' + globalName + ';')();
}

load('js/ui.js', 'UI');
load('js/pages/admin-audit.js', 'AdminAuditPage');
load('js/pages/admin-reports.js', 'AdminReportsPage');

// Nothing on either screen opens a modal, but if one is ever added it must
// not block the harness.
UI._answer = true;
UI.confirmDialog = function () { return Promise.resolve(UI._answer); };

/* ==================================================================== *
 * 4. Test plumbing
 * ==================================================================== */

let passed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { passed += 1; return true; }
  failures.push(msg);
  console.log('  FAIL  ' + msg);
  return false;
}
function eq(actual, expected, msg) {
  return ok(actual === expected,
    msg + '  (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected) + ')');
}
function has(hay, needle, msg) {
  return ok(String(hay).indexOf(needle) !== -1, msg + '  (missing "' + needle +
    '" in: ' + JSON.stringify(String(hay).slice(0, 300)) + ')');
}
function lacks(hay, needle, msg) {
  return ok(String(hay).indexOf(needle) === -1, msg + '  (unexpectedly found "' + needle + '")');
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush(n) { for (let i = 0; i < (n || 8); i += 1) await tick(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reset() {
  log.navigations.length = 0;
  log.apiCalls.length = 0;
  log.anchors.length = 0;
  log.blobs.length = 0;
  log.objectUrls.length = 0;
  log.revoked.length = 0;
  Object.keys(responses).forEach((k) => delete responses[k]);
  API._token = 'TOK';
  UI._answer = true;
  App.root = new El('div');
  Object.assign(App, APP_HELPERS);
  document.body = new El('body');
  AdminReportsPage.REVOKE_DELAY_MS = 0;   // so the revoke can be observed
}

function callsTo(action) { return log.apiCalls.filter((c) => c.action === action); }
function lastCall(action) { const c = callsTo(action); return c[c.length - 1]; }
function findButton(root, label) {
  return byTag(root, 'BUTTON').find((b) => b.textContent.indexOf(label) !== -1) || null;
}
/** The before/after cell of one BODY row. The header cell shares the class. */
function changesCell(index) {
  const row = byClass(App.root, 'audit-row')[index || 0];
  if (!row) return null;
  return row.children.filter((c) => c.tagName === 'TD' || c.tagName === 'TH')[4] || null;
}
function findLink(root, label) {
  return byTag(root, 'A').find((a) => a.textContent.indexOf(label) !== -1) || null;
}
function ctx(pathName, query) {
  return { path: pathName, params: {}, query: query || {}, pattern: pathName };
}

/* ==================================================================== *
 * 5. Fixtures
 * ==================================================================== */

const HOSTILE = '<img src=x onerror="alert(1)">Bobby </td><script>drop()</script>';

function auditRow(over) {
  return Object.assign({
    log_id: 'AUD_1',
    timestamp: '2026-08-30T13:15:00.000Z',
    timestamp_display: '30 Aug 2026, 6:45 PM',
    actor_user_id: 'USR_1',
    actor_name: 'Priya Nair',
    actor_role: 'ADMIN',
    action: 'PLAYER_SOLD',
    action_display: 'Player sold',
    tournament_id: 'TRN_1',
    entity_type: 'PLAYER',
    entity_id: 'PLY_27',
    prev_value: {
      auction_status: 'PENDING', team_id: '', sold_amount: 0, times_called: 1
    },
    new_value: {
      auction_status: 'SOLD', team_id: 'TEAM_2', sold_amount: 125000, times_called: 1
    },
    user_agent: 'Mozilla/5.0'
  }, over || {});
}

function auditResponse(over) {
  return Object.assign({
    rows: [auditRow()],
    page: 1,
    pageSize: 50,
    total: 1,
    totalPages: 1,
    // TEAM_DELETED is in here on purpose: the "no delete control" assertion
    // must not trip over the name of an action in a filter dropdown.
    actions: ['AUCTION_CORRECTED', 'PAYMENT_REJECTED', 'PAYMENT_VERIFIED',
      'PLAYER_SOLD', 'TEAM_DELETED', 'LOGIN_SUCCESS']
  }, over || {});
}

const TOURNAMENTS = [
  { tournament_id: 'TRN_1', name: 'Summer Cup', player_count: 400, verified_count: 340 },
  { tournament_id: 'TRN_2', name: 'Winter Shield', player_count: 12, verified_count: 4 }
];

/** One dashboard.adminStats tournament block. */
function statsBlock(over) {
  const base = {
    tournament_id: 'TRN_1',
    slug: 'summer-cup',
    name: 'Summer Cup',
    status: 'AUCTION_LIVE',
    status_display: 'Auction live',
    registrations: { all: 400, pending: 42, verified: 340, rejected: 18, withdrawn: 5, eligible: 335 },
    fees: {
      reg_fee: 500, reg_fee_display: '₹500',
      collected: 170000, collected_display: '₹1,70,000',
      expected: 170000, expected_display: '₹1,70,000'
    },
    teams: {
      total: 8, full: 3, all_teams_full: false,
      slots_total: 104, slots_filled: 100, slots_remaining: 4
    },
    auction: {
      sold: 100, unsold: 27, awaiting_reauction: 8, not_called: 200,
      results_recorded: 135, corrections: 2
    },
    purse: {
      total: 8000000, total_display: '₹80,00,000',
      spent: 5250000, spent_display: '₹52,50,000',
      remaining: 2750000, remaining_display: '₹27,50,000',
      highest_sale: 425000, highest_sale_display: '₹4,25,000',
      highest_sale_player: 'Anand Kumar',
      average_sale: 52500, average_sale_display: '₹52,500',
      spent_recorded_on_teams: 5250000,
      counters_match: true
    }
  };
  const out = JSON.parse(JSON.stringify(base));
  Object.keys(over || {}).forEach((k) => {
    out[k] = (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
      ? Object.assign(out[k] || {}, over[k])
      : over[k];
  });
  return out;
}

function statsResponse(block) {
  return {
    scope: 'TOURNAMENT',
    generated_at: '2026-08-30T13:20:00.000Z',
    generated_at_display: '30 Aug 2026, 6:50 PM',
    tournaments: [block || statsBlock()],
    totals: {}
  };
}

/* The four exports. A real BOM + CRLF + bare-integer money column, so the
   assertions can prove the bytes are passed through untouched. */
function csvFor(kind) {
  return '﻿Serial No,Name,Purchase Amount\r\n27,"Kumar, Anand",125000\r\n' +
    '# ' + kind + '\r\n';
}
function exportFor(kind, rows) {
  return {
    filename: 'summer-cup-' + kind + '-2026-08-30.csv',
    mime: 'text/csv;charset=utf-8',
    base64: Buffer.from(csvFor(kind), 'utf8').toString('base64'),
    rows: rows === undefined ? 400 : rows
  };
}

/** Render the audit log with one stubbed page and wait for the paint. */
async function renderAudit(data, query) {
  always('audit.list', () => data);
  always('tournament.list', () => TOURNAMENTS);
  AdminAuditPage.render(ctx('/admin/audit', Object.assign({ t: 'TRN_1' }, query || {})));
  await flush();
}

/** Render the reports screen with one stubbed stats block. */
async function renderReports(block, query) {
  always('dashboard.adminStats', () => statsResponse(block));
  AdminReportsPage.render(ctx('/admin/reports', Object.assign({ t: 'TRN_1' }, query || {})));
  await flush();
}

/* ==================================================================== *
 * 6. AUDIT — tests
 * ==================================================================== */

async function testAuditTable() {
  console.log('\n[1] the audit table: five columns, IST time, actor, action, record');
  reset();
  await renderAudit(auditResponse());

  eq(document.body.dataset.route, 'admin-audit', 'body data-route is admin-audit');

  const table = byTag(App.root, 'TABLE')[0];
  ok(!!table, 'a real <table> is rendered');

  const headCells = byTag(byTag(table, 'THEAD')[0], 'TH');
  eq(headCells.length, 5, 'five header cells');
  eq(headCells.filter((th) => th.scope === 'col').length, 5, 'every header cell is th scope="col"');
  const labels = headCells.map((th) => th.textContent);
  ['Time (IST)', 'Actor', 'Action', 'Record', 'Before → after']
    .forEach((w, i) => eq(labels[i], w, 'column ' + i + ' is "' + w + '"'));

  const rows = byClass(App.root, 'audit-row');
  eq(rows.length, 1, 'one body row');

  const cells = rows[0].children.filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
  eq(cells.length, 5, 'five body cells');
  eq(cells[0].tagName, 'TH', 'the time is the row header');
  eq(cells[0].scope, 'row', 'the row header has scope="row"');

  // The server pre-formats the instant in IST; the browser never re-parses it.
  has(cells[0].textContent, '30 Aug 2026, 6:45 PM', 'the time comes from timestamp_display');
  lacks(cells[0].textContent, '2026-08-30T13:15', 'the raw UTC instant is not shown');
  has(cells[0].textContent, 'AUD_1', 'the entry reference is quotable');

  has(cells[1].textContent, 'Priya Nair', 'the actor is named, not just an id');
  has(cells[1].textContent, 'USR_1', 'the actor id is there too');
  has(cells[2].textContent, 'Player sold', 'the action in words');
  has(cells[2].textContent, 'PLAYER_SOLD', 'and the raw enum, so a complaint and the screen agree');
  has(cells[3].textContent, 'Player', 'the record type');
  has(cells[3].textContent, 'PLY_27', 'the record id');

  // The append-only sentence — the thing that gives the log its value.
  const page = App.root.textContent;
  has(page, 'Append-only', 'the page says the log is append-only');
  has(page, 'no edit or delete control', 'and says so in those words');

  // The shared admin nav is claimed by the page, not left to app.js.
  eq(byTag(App.root, 'NAV').length, 1, 'the shared admin nav is mounted once');
  eq(byTag(App.root, 'NAV')[0].getAttribute('data-active'), 'audit', 'with the audit tab marked');
}

async function testBeforeAfterReadable() {
  console.log('\n[2] before/after is a field-by-field diff, never a JSON blob');
  reset();
  await renderAudit(auditResponse());

  const cell = changesCell();
  if (!ok(!!cell, 'the changes cell exists')) return;
  const text = cell.textContent;

  const changes = byClass(cell, 'audit-change');
  eq(changes.length, 4, 'one line per field (status, team, amount, times called)');

  has(text, 'Auction status', 'the field name is humanised, not "auction_status"');
  has(text, 'PENDING', 'the value before');
  has(text, 'SOLD', 'the value after');
  has(text, 'Sold amount', 'the money field is named');
  has(text, '₹1,25,000', 'money is rendered through UI.money, with Indian grouping');
  has(text, '₹0', 'and so is the zero it came from');
  has(text, 'Team id', 'the team field is named');
  has(text, 'TEAM_2', 'the new team id');
  has(text, '(empty)', 'a blank before-value says so rather than showing nothing');

  // It must not be a raw dump.
  lacks(text, '{', 'no JSON brace anywhere in the rendered diff');
  lacks(text, '"auction_status"', 'no quoted JSON key');
  lacks(text, 'auction_status', 'not even the raw snake_case key');

  // Changed fields come first; the unchanged one is last and marked as such.
  const moved = byClass(cell, 'audit-change--moved');
  const same = byClass(cell, 'audit-change--same');
  eq(moved.length, 3, 'three fields actually moved');
  if (eq(same.length, 1, 'the unchanged field is marked, not hidden')) {
    has(same[0].textContent, 'Times called', 'the unchanged field is times_called');
  }
  if (changes.length === 4) {
    has(changes[3].textContent, 'Times called', 'and it sorts below the ones that changed');
  } else {
    ok(false, 'the changed fields sort above the unchanged one');
  }

  // A create (no prev_value) reads as a set, not as a broken diff.
  reset();
  await renderAudit(auditResponse({
    rows: [auditRow({
      action: 'TEAM_CREATED', action_display: 'Team created',
      entity_type: 'TEAM', entity_id: 'TEAM_2',
      prev_value: null,
      new_value: { team_name: 'Chennai Warriors', purse_total: 1000000, max_players: 13 }
    })]
  }));
  const created = changesCell().textContent;
  has(created, 'Team name', 'a create still lists its fields');
  has(created, 'Chennai Warriors', 'with the value that was set');
  has(created, '₹10,00,000', 'purse_total is money and is grouped');
  has(created, '13', 'max_players is a plain count, not money');
  lacks(created, '₹13', 'a count is never formatted as money');

  // A nested object is flattened, not summarised away.
  reset();
  await renderAudit(auditResponse({
    rows: [auditRow({
      action: 'AUCTION_CORRECTED', action_display: 'Auction corrected',
      prev_value: { team: { team_name: 'Chennai Warriors', purse_used: 400000 } },
      new_value: { team: { team_name: 'Chennai Warriors', purse_used: 525000 } }
    })]
  }));
  const nested = changesCell().textContent;
  has(nested, 'Team › Purse used', 'a nested field keeps its path');
  has(nested, '₹4,00,000', 'the nested value before');
  has(nested, '₹5,25,000', 'the nested value after');

  // An unparseable payload the server passed through as a raw string still
  // renders as something a human can read.
  reset();
  await renderAudit(auditResponse({
    rows: [auditRow({ prev_value: null, new_value: '{"truncated":' })]
  }));
  has(changesCell().textContent, '{"truncated":',
    'a raw unparsed payload is shown rather than dropped');
}

async function testKeyActionsHighlighted() {
  console.log('\n[3] the four dispute actions are marked with a word, not a colour');
  reset();
  await renderAudit(auditResponse({
    rows: [
      auditRow({ log_id: 'A1', action: 'PAYMENT_VERIFIED', action_display: 'Payment verified' }),
      auditRow({ log_id: 'A2', action: 'PAYMENT_REJECTED', action_display: 'Payment rejected' }),
      auditRow({ log_id: 'A3', action: 'PLAYER_SOLD', action_display: 'Player sold' }),
      auditRow({ log_id: 'A4', action: 'AUCTION_CORRECTED', action_display: 'Auction corrected' }),
      auditRow({ log_id: 'A5', action: 'LOGIN_SUCCESS', action_display: 'Login success' })
    ],
    total: 5, totalPages: 1
  }));

  const marked = byClass(App.root, 'audit-row--key');
  eq(marked.length, 4, 'exactly the four dispute actions are marked');

  const flags = byClass(App.root, 'audit-flag');
  eq(flags.length, 4, 'each carries a visible word, not only a class');
  flags.forEach((f, i) => eq(f.textContent, 'Dispute evidence', 'flag ' + i + ' says what it means'));

  const plain = byClass(App.root, 'audit-row').filter(
    (r) => String(r.className).indexOf('audit-row--key') === -1);
  eq(plain.length, 1, 'an ordinary action is not marked');
  lacks(plain[0].textContent, 'Dispute evidence', 'and carries no flag');
}

async function testNoEditOrDeleteControl() {
  console.log('\n[4] there is no edit and no delete control anywhere in the audit DOM');
  reset();
  await renderAudit(auditResponse());

  const controls = byTag(App.root, 'BUTTON')
    .concat(byTag(App.root, 'A'))
    .concat(byTag(App.root, 'INPUT').filter(
      (i) => ['submit', 'button', 'reset', 'image'].indexOf(String(i.type)) !== -1));

  ok(controls.length > 0, 'the page does have controls (so the test is not vacuous)');

  const mutating = /\b(edit|delete|remove|erase|amend|revise|correct|overwrite|clear the log)\b/i;
  const offenders = controls.filter((c) => mutating.test(c.textContent) ||
    mutating.test(String(c.getAttribute('aria-label') || '')) ||
    mutating.test(String(c.getAttribute('title') || '')));
  eq(offenders.length, 0, 'no control on the page is labelled edit, delete or amend' +
    (offenders.length ? ' (found: ' + offenders.map((o) => o.textContent).join(' | ') + ')' : ''));

  // The action dropdown legitimately CONTAINS the word "deleted" (TEAM_DELETED
  // is an audited action). That is a filter value, not a control, and the
  // check above must not have been weakened to let it through.
  const options = byTag(App.root, 'OPTION').map((o) => o.textContent);
  ok(options.indexOf('Team deleted') !== -1,
    'the TEAM_DELETED filter option is present, so the check above is discriminating');

  // Stronger still: the page can only ever ask the server to READ.
  const READ_ONLY = ['audit.list', 'tournament.list'];
  const writes = log.apiCalls.filter((c) => READ_ONLY.indexOf(c.action) === -1);
  eq(writes.length, 0, 'the page calls nothing but reads' +
    (writes.length ? ' (called: ' + writes.map((w) => w.action).join(', ') + ')' : ''));

  // And no form that could post one.
  eq(byTag(App.root, 'FORM').length, 0, 'no form anywhere on the audit screen');
}

async function testHostileText() {
  console.log('\n[5] a hostile actor name and a hostile reason render as literal text');
  reset();
  await renderAudit(auditResponse({
    rows: [auditRow({
      actor_name: HOSTILE,
      action: 'PAYMENT_REJECTED',
      action_display: 'Payment rejected',
      prev_value: { status: 'PENDING' },
      new_value: { status: 'REJECTED', reason: HOSTILE }
    })]
  }));

  const name = oneByClass(App.root, 'audit-actor__name');
  ok(!!name, 'the actor name span exists');
  eq(name.textContent, HOSTILE, 'the whole hostile string is the text of one node');
  eq(name.children.length, 0, 'no child elements were created from the actor name');

  const reasonCell = changesCell();
  has(reasonCell.textContent, HOSTILE, 'the hostile reason is shown verbatim');
  const reasonSpan = byClass(reasonCell, 'audit-change__new')
    .find((s) => s.textContent.indexOf('Bobby') !== -1);
  if (ok(!!reasonSpan, 'the reason has its own value cell')) {
    eq(reasonSpan.children.length, 0, 'and no elements were parsed out of it');
  }

  eq(byTag(App.root, 'SCRIPT').length, 0, 'no script element anywhere');
  eq(byTag(App.root, 'IMG').length, 0, 'no img element was created from the payload');
  const row = byClass(App.root, 'audit-row')[0];
  eq(byTag(row, 'TD').length + byTag(row, 'TH').length, 5,
    'the "</td>" in the string did not create extra cells');
}

async function testAuditFiltersRoundTrip() {
  console.log('\n[6] every audit filter round-trips to the server');
  reset();
  await renderAudit(auditResponse({ page: 1, total: 400, totalPages: 8 }));

  let call = lastCall('audit.list');
  eq(call.payload.tournamentId, 'TRN_1', 'the ?t= selection is sent');
  eq(call.payload.page, 1, 'first request asks for page 1');
  eq(call.payload.pageSize, 50, 'page size is pinned to 50');
  eq(Object.prototype.hasOwnProperty.call(call.payload, 'action'), false,
    'a blank filter is omitted, never sent as an empty string');

  const selects = byTag(App.root, 'SELECT');
  const action = selects.find((s) => s.name === 'audit-action');
  const tournament = selects.find((s) => s.name === 'audit-tournament');
  ok(!!action && !!tournament, 'the action and tournament dropdowns are rendered');

  // The action list offered is the one the server said it saw in scope.
  const actionLabels = byTag(action, 'OPTION').map((o) => o.textContent);
  eq(actionLabels[0], 'Any action', 'a real "any" option, not a placeholder');
  ok(actionLabels.indexOf('Player sold') !== -1, 'the actions the server saw are offered');
  ok(actionLabels.indexOf('Auction corrected') !== -1, 'including the correction action');

  action.value = 'PLAYER_SOLD';
  action.dispatch('change');
  await flush();
  eq(lastCall('audit.list').payload.action, 'PLAYER_SOLD', 'the action filter is sent');
  eq(lastCall('audit.list').payload.page, 1, 'changing a filter returns to page 1');

  // The tournament dropdown was filled from tournament.list.
  const tournamentLabels = byTag(tournament, 'OPTION').map((o) => o.textContent);
  eq(tournamentLabels[0], 'All tournaments', 'across-all-tournaments is a real option');
  ok(tournamentLabels.indexOf('Winter Shield') !== -1, 'every tournament is listed by name');

  tournament.value = 'TRN_2';
  tournament.dispatch('change');
  await flush();
  eq(lastCall('audit.list').payload.tournamentId, 'TRN_2', 'the tournament filter is sent');

  tournament.value = '';
  tournament.dispatch('change');
  await flush();
  eq(Object.prototype.hasOwnProperty.call(lastCall('audit.list').payload, 'tournamentId'), false,
    '"All tournaments" omits the id entirely, which the server reads as every tournament');

  // Dates go out as bare YYYY-MM-DD; the server widens each to a whole IST day.
  const inputs = byTag(App.root, 'INPUT');
  const from = inputs.find((i) => i.name === 'audit-from');
  const to = inputs.find((i) => i.name === 'audit-to');
  ok(!!from && !!to, 'both date fields are rendered');
  eq(from.type, 'date', 'the from field is a real date input');

  from.value = '2026-08-01';
  from.dispatch('change');
  await flush();
  eq(lastCall('audit.list').payload.from, '2026-08-01', 'the from date is sent verbatim');

  to.value = '2026-08-31';
  to.dispatch('change');
  await flush();
  eq(lastCall('audit.list').payload.to, '2026-08-31', 'the to date is sent verbatim');
  eq(lastCall('audit.list').payload.from, '2026-08-01', 'and the from date travels with it');

  // The server owns the "from is after to" message; the page shows its words.
  responses['audit.list'] = [() => {
    throw {
      code: 'VALIDATION_FAILED',
      message: 'The from date (2026-09-01) is after the to date (2026-08-31).'
    };
  }];
  from.value = '2026-09-01';
  from.dispatch('change');
  await flush();
  has(oneByClass(App.root, 'admin__errors').textContent,
    'is after the to date', 'the server\'s own explanation is shown');
}

async function testAuditDebounce() {
  console.log('\n[7] rapid typing in the actor box collapses into ONE server call');
  reset();
  await renderAudit(auditResponse());

  const before = callsTo('audit.list').length;
  const input = byTag(App.root, 'INPUT').find((i) => i.name === 'audit-actor');
  ok(!!input, 'the actor box is rendered');
  eq(input.type, 'search', 'it is a search input');

  'priya'.split('').forEach((ch, i) => {
    input.value = 'priya'.slice(0, i + 1);
    input.dispatch('input');
  });

  eq(callsTo('audit.list').length - before, 0, 'no request fired while the admin was still typing');

  await sleep(AdminAuditPage.FILTER_DEBOUNCE_MS + 150);
  await flush();

  eq(callsTo('audit.list').length - before, 1, 'five keystrokes produced exactly one request');
  eq(lastCall('audit.list').payload.actor, 'priya', 'the request carries the final text');
  eq(lastCall('audit.list').payload.page, 1, 'a new search starts at page 1');

  // A keystroke that leaves the value unchanged must not refetch.
  const after = callsTo('audit.list').length;
  input.dispatch('input');
  await sleep(AdminAuditPage.FILTER_DEBOUNCE_MS + 150);
  await flush();
  eq(callsTo('audit.list').length, after, 'an unchanged value does not refetch');

  // Enter does not wait out the debounce.
  input.value = 'ravi';
  input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await flush();
  eq(lastCall('audit.list').payload.actor, 'ravi', 'Enter searches immediately');
  eq(callsTo('audit.list').length, after + 1, 'and only once');
}

async function testAuditPaging() {
  console.log('\n[8] paging is server-side and sends a page number, never "everything"');
  reset();
  await renderAudit(auditResponse({ page: 1, total: 400, totalPages: 8 }));

  const next = findButton(App.root, 'Next page');
  const prev = findButton(App.root, 'Previous page');
  ok(!!next && !!prev, 'both pager buttons are rendered');
  eq(prev.disabled, true, 'previous is disabled on page 1');
  eq(next.disabled, false, 'next is enabled on page 1 of 8');

  always('audit.list', () => auditResponse({ page: 2, total: 400, totalPages: 8 }));
  next.click();
  await flush();
  eq(lastCall('audit.list').payload.page, 2, 'next asks the server for page 2');
  eq(lastCall('audit.list').payload.pageSize, 50, 'page size is still 50');

  findButton(App.root, 'Previous page').click();
  await flush();
  eq(lastCall('audit.list').payload.page, 1, 'previous asks for page 1');

  has(oneByClass(App.root, 'audit-pager__status').textContent, 'of 400',
    'the pager states the whole filtered total');
  eq(oneByClass(App.root, 'audit-pager__status').getAttribute('aria-live'), 'polite',
    'the result count is announced');

  callsTo('audit.list').forEach((c, i) => {
    eq(c.payload.pageSize, 50, 'call ' + i + ' keeps pageSize 50');
    ok(typeof c.payload.page === 'number' && c.payload.page >= 1,
      'call ' + i + ' sends a page number');
  });
}

async function testAuditEmptyStates() {
  console.log('\n[9] audit empty states: nothing logged, nothing matched, page past the end');
  reset();

  // (a) nothing recorded for the tournament that is selected. This is NOT a
  //     failed search — no filter was set — so it must not be worded as one.
  await renderAudit(auditResponse({ rows: [], total: 0, totalPages: 1, actions: [] }));
  eq(byTag(App.root, 'TABLE').length, 0, 'no empty table is drawn');
  has(App.root.textContent, 'This tournament has no audit entries yet',
    'a fresh tournament is told it has no entries, not that a filter matched nothing');
  lacks(App.root.textContent, 'No audit entry matches these filters',
    'arriving with a tournament selected is not a failed search');
  has(App.root.textContent, 'nothing can be removed', 'and it repeats that nothing is deletable');

  // Sign-ins belong to no tournament, so there is a way to widen the scope.
  const widen = findButton(App.root, 'Look across all tournaments');
  ok(!!widen, 'a way out to the whole log');
  widen.click();
  await flush();
  eq(Object.prototype.hasOwnProperty.call(lastCall('audit.list').payload, 'tournamentId'), false,
    'widening drops the tournament from the payload');
  has(App.root.textContent, 'The audit log has no entries yet',
    'with no tournament selected the wording covers the whole log');

  // (b) filters match nothing
  reset();
  always('tournament.list', () => TOURNAMENTS);
  responses['audit.list'] = { always: () => auditResponse({ rows: [], total: 0, totalPages: 1 }) };
  AdminAuditPage.render(ctx('/admin/audit', { t: 'TRN_1' }));
  await flush();
  const actor = byTag(App.root, 'INPUT').find((i) => i.name === 'audit-actor');
  actor.value = 'nobody';
  actor.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await flush();

  has(App.root.textContent, 'No audit entry matches these filters', 'the no-match message');
  has(App.root.textContent, 'nobody', 'it repeats what was asked for');
  has(App.root.textContent, 'Nothing has been hidden', 'and says the log is not hiding anything');
  const clear = findButton(App.root, 'Clear the filters');
  ok(!!clear, 'a way out of a filter that matches nothing');

  always('audit.list', () => auditResponse());
  clear.click();
  await flush();
  eq(Object.prototype.hasOwnProperty.call(lastCall('audit.list').payload, 'actor'), false,
    'clearing drops the actor from the payload');
  eq(byTag(App.root, 'INPUT').find((i) => i.name === 'audit-actor').value, '',
    'and empties the actor box');

  // (c) page past the end
  reset();
  await renderAudit(auditResponse({ rows: [], page: 9, total: 400, totalPages: 8 }));
  has(App.root.textContent, 'Page 9 does not exist', 'the out-of-range page is named exactly');
  has(App.root.textContent, '400 entries on 8 pages', 'and the real size of the list');
  const go = findButton(App.root, 'Go to page 1');
  ok(!!go, 'a button back to a page that exists');
  go.click();
  await flush();
  eq(lastCall('audit.list').payload.page, 1, 'it asks the server for page 1');
}

async function testAuditSessionExpiry() {
  console.log('\n[10] an expired session clears the token and goes to sign in');
  reset();
  respond('audit.list', () => { throw { code: 'UNAUTHORIZED', message: 'Session expired.' }; });
  respond('tournament.list', () => TOURNAMENTS);
  AdminAuditPage.render(ctx('/admin/audit', { t: 'TRN_1' }));
  await flush();

  eq(API.getToken(), null, 'token cleared');
  ok(log.navigations.length >= 1, 'a navigation happened');
  eq(log.navigations[0].to, '/admin/login', 'to the login screen');
  eq(log.navigations[0].opts.replace, true, 'as a replace, so Back does not bounce');
  eq(oneByClass(App.root, 'admin__errors').textContent, '',
    'no error banner is painted over a page that is being replaced');

  reset();
  API._token = null;
  AdminAuditPage.render(ctx('/admin/audit', { t: 'TRN_1' }));
  await flush();
  eq(log.apiCalls.length, 0, 'no call is made without a token');
  eq(log.navigations[0].to, '/admin/login', 'straight to sign in');
}

/* ==================================================================== *
 * 7. REPORTS — tests
 * ==================================================================== */

async function testFourAuctionLabels() {
  console.log('\n[11] all FOUR honest auction labels appear, including "Not called"');
  reset();
  await renderReports();

  eq(document.body.dataset.route, 'admin-reports', 'body data-route is admin-reports');

  const tiles = byClass(App.root, 'reports-tile');
  const pairs = tiles.map((t) => ({
    label: (byClass(t, 'reports-tile__label')[0] || {}).textContent,
    value: (byClass(t, 'reports-tile__value')[0] || {}).textContent
  }));
  const find = (label) => pairs.find((p) => p.label === label) || null;

  ['Sold', 'Unsold', 'Awaiting re-auction', 'Not called'].forEach((label) => {
    const tile = find(label);
    ok(!!tile, 'the "' + label + '" tile is rendered');
  });
  eq((find('Sold') || {}).value, '100', 'sold count');
  eq((find('Unsold') || {}).value, '27', 'unsold count');
  eq((find('Awaiting re-auction') || {}).value, '8', 'awaiting re-auction count');
  eq((find('Not called') || {}).value, '200', '200 players were never called, and it is visible');

  // "Not called" is not a footnote: it is one of the headline tiles.
  const headlines = byClass(App.root, 'reports-tile--headline').map((t) => t.textContent);
  ok(headlines.some((t) => t.indexOf('Not called') !== -1),
    '"Not called" is a headline number, not buried');
  has(App.root.textContent, 'Everyone paid the fee',
    'the page explains why "Not called" has to be shown');

  // The numbers an organiser actually asks for.
  eq((find('Registered') || {}).value, '400', 'registered');
  eq((find('Payment verified') || {}).value, '340', 'verified');
  eq((find('Payment pending') || {}).value, '42', 'pending');
  eq((find('Payment rejected') || {}).value, '18', 'rejected');
  eq((find('Teams') || {}).value, '8', 'teams');
  eq((find('Eligible for the auction') || {}).value, '335', 'eligible');

  // Money through UI.money — the same Indian grouping the server uses.
  eq((find('Total auction value') || {}).value, '₹52,50,000', 'total auction value');
  eq((find('Highest sale') || {}).value, '₹4,25,000', 'highest sale');
  eq((find('Registration fees collected') || {}).value, '₹1,70,000', 'fees collected');

  has(App.root.textContent, '30 Aug 2026, 6:50 PM', 'when the numbers were counted');
  eq(byTag(App.root, 'NAV')[0].getAttribute('data-active'), 'reports',
    'the shared admin nav marks the reports tab');
}

async function testDownloads() {
  console.log('\n[12] each download button calls its own action and saves the returned file');
  reset();
  await renderReports();

  const expected = [
    { label: 'Player List', action: 'report.players', kind: 'players' },
    { label: 'Team Report', action: 'report.teams', kind: 'teams' },
    { label: 'Auction Report', action: 'report.auction', kind: 'auction' },
    { label: 'Final Report', action: 'report.final', kind: 'final' }
  ];

  eq(byClass(App.root, 'reports-download').length, 4, 'four download cards');

  has(App.root.textContent, 'opens in Excel', 'the note says the CSV opens in Excel');
  has(App.root.textContent, 'plain whole numbers',
    'and that money columns are plain numbers so totals work');
  has(App.root.textContent, 'no ₹ sign', 'and that there is no currency symbol in the file');

  for (const spec of expected) {
    const btn = findButton(App.root, spec.label);
    if (!ok(!!btn, 'the "' + spec.label + '" button exists')) continue;

    const before = log.blobs.length;
    always(spec.action, () => exportFor(spec.kind, 400));
    btn.click();
    await flush(12);

    const call = lastCall(spec.action);
    ok(!!call, spec.label + ' calls ' + spec.action);
    eq(call.payload.tournamentId, 'TRN_1', spec.label + ' is scoped to the tournament');

    eq(log.blobs.length, before + 1, spec.label + ' builds exactly one Blob');
    const blob = log.blobs[log.blobs.length - 1];
    eq(blob.type, 'text/csv;charset=utf-8', spec.label + ' uses the mime the server returned');

    // The bytes must be the server's bytes: BOM intact, CRLF intact, the
    // comma inside a quoted name intact, and the money column still a bare
    // integer. Post-processing any of that breaks Excel.
    const bytes = blob.parts[0];
    ok(bytes instanceof Uint8Array, spec.label + ' passes raw bytes to the Blob');
    const decoded = Buffer.from(bytes).toString('utf8');
    eq(decoded, csvFor(spec.kind), spec.label + ' saves the server bytes unmodified');
    eq(bytes[0], 0xEF, spec.label + ' keeps the UTF-8 BOM as the first byte');
    has(decoded, ',125000\r\n', spec.label + ' leaves the money column a bare integer');
    lacks(decoded, '₹', spec.label + ' adds no currency symbol to the file');

    const anchor = log.anchors.filter((a) => a.download)[log.anchors.filter((a) => a.download).length - 1];
    ok(!!anchor, spec.label + ' creates an <a download>');
    eq(anchor.download, 'summer-cup-' + spec.kind + '-2026-08-30.csv',
      spec.label + ' names the file exactly as the server did');
    eq(anchor.href, log.objectUrls.length ? 'blob:harness/' + log.objectUrls.length : '',
      spec.label + ' points the link at the object URL');
    eq(anchor.parentNode, null, spec.label + ' removes the anchor again');

    has(oneByClass(App.root, 'reports-downloads__status').textContent,
      'summer-cup-' + spec.kind, spec.label + ' says which file was saved');
    has(oneByClass(App.root, 'reports-downloads__status').textContent, '400 rows',
      spec.label + ' says how many rows it carried');
  }

  eq(log.objectUrls.length, 4, 'four object URLs were created');
  await sleep(10);
  await flush();
  eq(log.revoked.length, 4, 'and every one of them is revoked afterwards');

  // A failed export says so and does not leave a half-download behind.
  const blobsBefore = log.blobs.length;
  responses['report.players'] = [() => {
    throw { code: 'NOT_FOUND', message: 'No tournament was found with the id "TRN_1".' };
  }];
  findButton(App.root, 'Player List').click();
  await flush(12);
  eq(log.blobs.length, blobsBefore, 'a failed export builds no Blob');
  has(oneByClass(App.root, 'admin__errors').textContent, 'No tournament was found',
    'and the server\'s reason is shown');
  has(oneByClass(App.root, 'reports-downloads__status').textContent, 'was not downloaded',
    'the status region says plainly that nothing was saved');
}

async function testCountersWarning() {
  console.log('\n[13] the counters_match warning shows when false and not when true');

  // (a) counters agree — no warning at all.
  reset();
  await renderReports(statsBlock());
  eq(byClass(App.root, 'reports-drift').length, 0,
    'no drift warning when the counters agree');
  lacks(App.root.textContent, 'disagree with the auction history',
    'and no scary sentence anywhere');

  // (b) counters disagree — a loud, explained warning.
  reset();
  await renderReports(statsBlock({
    purse: { spent: 5250000, spent_recorded_on_teams: 5400000, counters_match: false }
  }));

  const warn = oneByClass(App.root, 'reports-drift');
  ok(!!warn, 'the drift warning is rendered');
  eq(warn.getAttribute('role'), 'alert', 'it interrupts, because a wrong purse is a live problem');

  const text = warn.textContent;
  has(text, 'disagree with the auction history', 'it says what is wrong');
  has(text, '₹52,50,000', 'it quotes the figure derived from the sales');
  has(text, '₹54,00,000', 'and the figure cached on the teams');
  has(text, '₹1,50,000', 'and the size of the gap');
  has(text, 'audit log', 'and points at the log that catches this drift');

  // The repair must be REACHABLE, not merely mentioned. This used to assert the
  // prose contained the string "team.recount" — an action name an admin cannot
  // do anything with. The warning now carries a button that calls the action, so
  // the test asserts the button, which is the thing that actually repairs it.
  const fix = oneByClass(warn, 'reports-drift__fix');
  ok(!!fix, 'the warning carries a repair control, not just an instruction');
  eq(fix.tagName, 'BUTTON', 'the repair is a button the admin can press');
  has(fix.textContent, 'Repair', 'and it says what it does');

  // It sits in a live region so it is announced, not just drawn.
  const region = oneByClass(App.root, 'reports-warnings');
  eq(region.getAttribute('aria-live'), 'polite', 'the warning region is announced');

  // Refreshing back to healthy counters clears it.
  always('dashboard.adminStats', () => statsResponse(statsBlock()));
  findButton(App.root, 'Refresh the numbers').click();
  await flush(12);
  eq(byClass(App.root, 'reports-drift').length, 0, 'the warning clears once the counters agree');
}

async function testReportsEdgeCases() {
  console.log('\n[14] no players, auction not started, no tournament chosen');

  // (a) nobody has registered
  reset();
  await renderReports(statsBlock({
    registrations: { all: 0, pending: 0, verified: 0, rejected: 0, withdrawn: 0, eligible: 0 },
    teams: { total: 0, full: 0, slots_total: 0, slots_filled: 0, slots_remaining: 0 },
    auction: { sold: 0, unsold: 0, awaiting_reauction: 0, not_called: 0, results_recorded: 0, corrections: 0 },
    purse: { total: 0, spent: 0, remaining: 0, highest_sale: 0, average_sale: 0, spent_recorded_on_teams: 0 },
    fees: { collected: 0 }
  }));
  has(App.root.textContent, 'No players have registered', 'the empty tournament says so');
  has(App.root.textContent, 'column headings and nothing else',
    'and is honest about what the exports will contain');
  ok(!!findButton(App.root, 'Player List'), 'the exports are still offered');
  const zero = byClass(App.root, 'reports-tile')
    .find((t) => t.textContent.indexOf('Total auction value') !== -1);
  if (ok(!!zero, 'the total auction value tile is rendered')) {
    has(zero.textContent, '₹0', 'the money tile reads ₹0, not a dash');
  }

  // (b) players registered, auction not started
  reset();
  await renderReports(statsBlock({
    teams: { slots_filled: 0 },
    auction: { sold: 0, unsold: 0, awaiting_reauction: 0, not_called: 335, results_recorded: 0 },
    purse: { spent: 0, remaining: 8000000, highest_sale: 0, average_sale: 0, spent_recorded_on_teams: 0 }
  }));
  has(App.root.textContent, 'The auction has not started yet', 'it says the auction has not started');
  has(App.root.textContent, '335 eligible players',
    'and explains that they all count as "Not called" for now');
  const notCalled = byClass(App.root, 'reports-tile')
    .find((t) => t.textContent.indexOf('Not called') !== -1);
  if (ok(!!notCalled, 'the "Not called" tile is rendered before the auction starts')) {
    has(notCalled.textContent, '335', 'every eligible player is counted as not called');
  }

  // (c) the server has no block for this tournament
  reset();
  always('dashboard.adminStats', () => ({ scope: 'TOURNAMENT', tournaments: [], totals: {} }));
  AdminReportsPage.render(ctx('/admin/reports', { t: 'TRN_GONE' }));
  await flush();
  has(App.root.textContent, 'There are no numbers for this tournament',
    'a missing block is explained, not drawn as dashes');

  // (d) no tournament chosen at all: ask, never guess.
  reset();
  respond('tournament.list', () => TOURNAMENTS);
  AdminReportsPage.render(ctx('/admin/reports', {}));
  await flush();
  eq(callsTo('dashboard.adminStats').length, 0, 'no stats call without a tournament');
  has(App.root.textContent, 'Choose the tournament', 'it asks which tournament');
  const link = findLink(App.root, 'Summer Cup');
  ok(!!link, 'the tournament is offered as a link');
  eq(link.href, '/cricket-auction/admin/reports?t=TRN_1', 'the link carries the id as ?t=');

  // (e) a shell without the App helpers still works.
  reset();
  delete App.currentTournamentId;
  delete App.adminPath;
  delete App.tournamentName;
  delete App.adminNav;
  await renderReports(statsBlock(), {});
  AdminReportsPage.render(ctx('/admin/reports', { t: 'TRN_1' }));
  await flush();
  eq(lastCall('dashboard.adminStats').payload.tournamentId, 'TRN_1',
    '?t= still works without the App helpers');
  eq(byTag(App.root, 'NAV').length, 0, 'and no nav is invented when App.adminNav is absent');
  reset();
}

async function testAccessibility() {
  console.log('\n[15] real tables, real labels, live regions on both screens');
  reset();
  await renderAudit(auditResponse());

  const table = byTag(App.root, 'TABLE')[0];
  ok(byTag(table, 'CAPTION').length === 1, 'the audit table has a caption');
  has(byTag(table, 'CAPTION')[0].textContent, 'cannot be edited or deleted',
    'the caption states the append-only rule for a screen reader too');

  const labels = byTag(App.root, 'LABEL');
  ok(labels.length >= 5, 'every filter has a real <label>');
  labels.forEach((l, i) => {
    const forId = l.getAttribute('for');
    ok(!!forId, 'label ' + i + ' has a for attribute');
    ok(all(App.root).some((e) => e.id === forId), 'label ' + i + ' points at a real control');
  });

  eq(oneByClass(App.root, 'audit-table-box').getAttribute('aria-live'), 'polite',
    'the audit results are announced when they change');
  eq(oneByClass(App.root, 'admin__errors').getAttribute('aria-live'), 'assertive',
    'errors interrupt');

  const scroll = oneByClass(App.root, 'audit-table__scroll');
  eq(scroll.getAttribute('tabindex'), '0', 'the scroll region is keyboard reachable');
  eq(scroll.getAttribute('role'), 'region', 'and announced as a region');

  reset();
  await renderReports();
  eq(oneByClass(App.root, 'reports-stats-box').getAttribute('aria-live'), 'polite',
    'the stats region is announced');
  eq(oneByClass(App.root, 'reports-downloads__status').getAttribute('role'), 'status',
    'the download status is a status region');
  ok(byTag(App.root, 'H1').length === 1, 'exactly one h1');
  ok(byTag(App.root, 'H2').length >= 5, 'each stat group and the downloads have an h2');
}

/* ==================================================================== *
 * 8. Mutation tests — prove the assertions above can actually fail
 * ==================================================================== */

/**
 * Break something, run a probe that must FAIL, then restore and run the same
 * probe, which must now PASS. An assertion that cannot fail is not a test.
 *
 * @param {string} name what is being mutated
 * @param {function(): void} mutate
 * @param {function(): void} restore
 * @param {function(): !Promise<boolean>} probe resolves true when the
 *        behaviour under test is correct
 */
async function mutation(name, mutate, restore, probe) {
  mutate();
  let broken;
  try {
    broken = await probe();
  } catch (e) {
    broken = false;                 // a throw is also a detected regression
  }
  restore();
  const healthy = await probe();
  ok(broken === false, 'MUTATION "' + name + '" is detected (the probe fails when broken)');
  ok(healthy === true, 'MUTATION "' + name + '" restored (the probe passes again)');
}

async function testMutations() {
  console.log('\n[16] mutation tests — each assertion below can actually fail');

  /* (1) Remove "Not called" from the reports groups. The four-honest-labels
         assertion must go red: this is the whole point of DESIGN.md §6.9. */
  const realGroups = AdminReportsPage.GROUPS;
  await mutation(
    'reports drops the "Not called" tile',
    () => {
      AdminReportsPage.GROUPS = realGroups.map((g) => Object.assign({}, g, {
        tiles: g.tiles.filter((t) => t.label !== 'Not called')
      }));
    },
    () => { AdminReportsPage.GROUPS = realGroups; },
    async () => {
      reset();
      await renderReports();
      const labels = byClass(App.root, 'reports-tile__label').map((e) => e.textContent);
      return ['Sold', 'Unsold', 'Awaiting re-auction', 'Not called']
        .every((l) => labels.indexOf(l) !== -1);
    }
  );

  /* (2) Render the before/after values as a raw JSON blob. The "readable
         diff" assertion must go red. */
  const realChanges = AdminAuditPage._changes;
  await mutation(
    'audit renders prev/new as raw JSON',
    () => {
      AdminAuditPage._changes = function (prev, next) {
        const box = document.createElement('div');
        box.className = 'audit-changes';
        box.textContent = JSON.stringify(prev) + ' -> ' + JSON.stringify(next);
        return box;
      };
    },
    () => { AdminAuditPage._changes = realChanges; },
    async () => {
      reset();
      await renderAudit(auditResponse());
      const text = changesCell().textContent;
      return text.indexOf('{') === -1 &&
        text.indexOf('Auction status') !== -1 &&
        text.indexOf('₹1,25,000') !== -1;
    }
  );

  /* (3) Fire the actor search on every keystroke. The debounce assertion must
         go red — ten keystrokes would be ten full sheet reads. */
  const realCancel = AdminAuditPage._cancelDebounce;
  const debounceMs = AdminAuditPage.FILTER_DEBOUNCE_MS;
  await mutation(
    'audit search stops cancelling the pending timer',
    () => { AdminAuditPage._cancelDebounce = function () {}; },
    () => { AdminAuditPage._cancelDebounce = realCancel; },
    async () => {
      reset();
      await renderAudit(auditResponse());
      const before = callsTo('audit.list').length;
      const input = byTag(App.root, 'INPUT').find((i) => i.name === 'audit-actor');
      'priya'.split('').forEach((ch, i) => {
        input.value = 'priya'.slice(0, i + 1);
        input.dispatch('input');
      });
      // Still inside the debounce window: nothing may have been sent yet.
      const during = callsTo('audit.list').length - before;
      await sleep(debounceMs + 150);
      await flush();
      const total = callsTo('audit.list').length - before;
      return during === 0 && total === 1;
    }
  );

  /* (4) Add an "Edit entry" control to the audit rows. The append-only
         assertion must go red. */
  const realRow = AdminAuditPage._row;
  await mutation(
    'audit grows an "Edit entry" button',
    () => {
      AdminAuditPage._row = function (row) {
        const tr = realRow.call(AdminAuditPage, row);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Edit entry';
        tr.appendChild(btn);
        return tr;
      };
    },
    () => { AdminAuditPage._row = realRow; },
    async () => {
      reset();
      await renderAudit(auditResponse());
      const controls = byTag(App.root, 'BUTTON').concat(byTag(App.root, 'A'));
      const mutating = /\b(edit|delete|remove|erase|amend|revise)\b/i;
      return controls.length > 0 && !controls.some((c) => mutating.test(c.textContent));
    }
  );

  /* (5) Hide the counters_match warning. It must be detected: silent drift in
         purse totals is exactly what must not be swallowed. */
  const realWarn = AdminReportsPage._paintWarnings;
  await mutation(
    'reports swallows the counters_match warning',
    () => { AdminReportsPage._paintWarnings = function () {}; },
    () => { AdminReportsPage._paintWarnings = realWarn; },
    async () => {
      reset();
      await renderReports(statsBlock({
        purse: { spent: 5250000, spent_recorded_on_teams: 5400000, counters_match: false }
      }));
      const warn = oneByClass(App.root, 'reports-drift');
      // Probes the warning AND its repair button — hiding either one leaves the
      // admin with a purse figure they cannot trust and no way to fix it.
      return !!warn && !!oneByClass(warn, 'reports-drift__fix');
    }
  );

  reset();
}

/* ==================================================================== *
 * 9. Run
 * ==================================================================== */

(async function run() {
  console.log('admin-audit.js + admin-reports.js — harness');

  await testAuditTable();
  await testBeforeAfterReadable();
  await testKeyActionsHighlighted();
  await testNoEditOrDeleteControl();
  await testHostileText();
  await testAuditFiltersRoundTrip();
  await testAuditDebounce();
  await testAuditPaging();
  await testAuditEmptyStates();
  await testAuditSessionExpiry();
  await testFourAuctionLabels();
  await testDownloads();
  await testCountersWarning();
  await testReportsEdgeCases();
  await testAccessibility();
  await testMutations();

  console.log('\n' + '-'.repeat(64));
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' FAILED');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(passed + '/' + passed + ' assertions passed');
})();
