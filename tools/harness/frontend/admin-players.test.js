/**
 * Verification harness for frontend/js/pages/admin-players.js.
 *
 * Lives outside the repo on purpose: the project has no build step and no npm
 * runtime deps, so nothing test-shaped may ship in frontend/. Same approach as
 * /tmp/admin-harness/run.js (the admin-tournament.js harness): a tiny DOM, real
 * frontend/js/ui.js, stubs for API / Router / App, then assertions.
 *
 * Run:  node /tmp/players-harness/run.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = '/Users/raja.t/cricket-auction/frontend';

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
    n.children.forEach((c) => {
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

global.document = {
  title: '',
  body: new El('body'),
  activeElement: null,
  createElement: (t) => new El(t),
  createTextNode: (t) => new TextNode(t),
  execCommand: () => true,
  addEventListener() {},
  removeEventListener() {}
};

global.window = {
  location: { origin: 'https://example.github.io', pathname: '/', search: '' },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  navigator: { userAgent: 'HarnessAgent/1.0', clipboard: null },
  URL: { revokeObjectURL() {} },
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

const log = { navigations: [], apiCalls: [], confirms: [] };

global.CONFIG = { BASE_PATH: '/cricket-auction', TOKEN_KEY: 'ca.session.token' };

/* App as the integration agent's app.js actually exposes it: the tournament
   selection lives in the URL as ?t=, read through App.currentTournamentId and
   written into every internal link by App.adminPath. */
const APP_HELPERS = {
  TOURNAMENT_PARAM: 't',
  currentTournamentId: (ctx) => String(((ctx && ctx.query) || {}).t || ''),
  adminPath: (path, id) => (id
    ? path + (path.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(id)
    : path),
  tournamentName: (id) => (id === 'TRN_1' ? 'Summer Cup' : '')
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
 * 3. Load the real ui.js and the page under test
 * ==================================================================== */

function load(relPath, globalName) {
  const src = fs.readFileSync(path.join(FRONTEND, relPath), 'utf8');
  new Function(src + '\n;globalThis.' + globalName + ' = ' + globalName + ';')();
}

load('js/ui.js', 'UI');
load('js/pages/admin-players.js', 'AdminPlayersPage');

// Only the modal is stubbed; every other UI.* used by the page is the real one.
UI._answer = true;
UI.confirmDialog = function (cfg) {
  log.confirms.push(cfg);
  return Promise.resolve(UI._answer);
};

/* ==================================================================== *
 * 4. Test plumbing
 * ==================================================================== */

let passed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { passed += 1; return; }
  failures.push(msg);
  console.log('  FAIL  ' + msg);
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + '  (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected) + ')');
}
function has(hay, needle, msg) {
  ok(String(hay).indexOf(needle) !== -1, msg + '  (missing "' + needle + '" in: ' +
    JSON.stringify(String(hay).slice(0, 240)) + ')');
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush(n) { for (let i = 0; i < (n || 8); i += 1) await tick(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reset() {
  log.navigations.length = 0;
  log.apiCalls.length = 0;
  log.confirms.length = 0;
  Object.keys(responses).forEach((k) => delete responses[k]);
  API._token = 'TOK';
  UI._answer = true;
  App.root = new El('div');
  Object.assign(App, APP_HELPERS);
  document.body = new El('body');
}

function listCalls() { return log.apiCalls.filter((c) => c.action === 'player.list'); }
function lastList() { const c = listCalls(); return c[c.length - 1]; }
function findButton(root, label) {
  return byTag(root, 'BUTTON').find((b) => b.textContent.indexOf(label) !== -1) || null;
}
function findLink(root, label) {
  return byTag(root, 'A').find((a) => a.textContent.indexOf(label) !== -1) || null;
}
function rowsOf(root) { return byClass(root, 'players-row'); }
/** Direct cell children of a row: the row header plus every td. */
function cellsOf(tr) {
  return tr.children.filter((c) => c.nodeType === 1 && (c.tagName === 'TH' || c.tagName === 'TD'));
}

/* ==================================================================== *
 * 5. Fixtures
 * ==================================================================== */

const HOSTILE = '<img src=x onerror="alert(1)">Bobby </td><script>drop()</script>';

function player(over) {
  return Object.assign({
    serial_no: 27,
    player_id: 'PLY_1',
    name: 'Anand Kumar',
    dob: '2001-04-12',
    age_years: 25,
    role: 'ALL_ROUNDER',
    style: 'LEFT',
    mobile: '9876543210',
    upi_ref: 'UPI12345678',
    payment_status: 'VERIFIED',
    auction_status: 'PENDING',
    team_id: '',
    sold_amount: null,
    is_withdrawn: false,
    registered_at: '2026-08-01T06:30:00.000Z',
    registered_at_display: '1 Aug 2026, 12:00',
    photo_thumb_url: 'https://drive.google.com/thumbnail?id=abc',
    payment_id: 'PAY_1'
  }, over || {});
}

function listResponse(over) {
  return Object.assign({
    rows: [player()],
    page: 1,
    pageSize: 50,
    total: 1,
    totalPages: 1,
    counts: { all: 400, pending: 42, verified: 340, rejected: 18, withdrawn: 5, eligible: 335 }
  }, over || {});
}

function ctx(query) {
  return { path: '/admin/players', params: {}, query: query || {}, pattern: '/admin/players' };
}

/** Render the register with one stubbed page of rows and wait for the paint. */
async function renderWith(data, query) {
  always('player.list', () => data);
  AdminPlayersPage.render(ctx(Object.assign({ t: 'TRN_1' }, query || {})));
  await flush();
}

/* ==================================================================== *
 * 6. Tests
 * ==================================================================== */

async function testColumnsAndCells() {
  console.log('\n[1] ten columns plus actions, every value as text');
  reset();
  await renderWith(listResponse());

  eq(document.body.dataset.route, 'admin-players', 'body data-route is admin-players');

  const table = byTag(App.root, 'TABLE')[0];
  ok(!!table, 'a real <table> is rendered');

  const headCells = byTag(byTag(table, 'THEAD')[0], 'TH');
  eq(headCells.length, 11, 'header has 10 data columns plus Actions');
  eq(headCells.filter((th) => th.scope === 'col').length, 11, 'every header cell is th scope="col"');

  const labels = headCells.map((th) => th.textContent.replace(/[▲▼↕]/g, '')
    .replace(/\s*\(.*\)\s*$/, '').trim());
  const want = ['Serial No', 'Name', 'DOB', 'Role', 'Style', 'Mobile', 'UPI Reference',
    'Payment Status', 'Registration Date', 'Auction Status', 'Actions'];
  want.forEach((w, i) => eq(labels[i], w, 'column ' + i + ' is "' + w + '"'));

  const rows = rowsOf(App.root);
  eq(rows.length, 1, 'one body row');

  const cells = cellsOf(rows[0]);
  eq(cells.length, 11, 'body row has 10 data cells plus the actions cell');
  eq(cells[0].tagName, 'TH', 'serial number is the row header');
  eq(cells[0].scope, 'row', 'row header has scope="row"');

  eq(cells[0].textContent, '27', 'serial');
  has(cells[1].textContent, 'Anand Kumar', 'name');
  has(cells[2].textContent, '2001-04-12', 'DOB printed verbatim, never re-parsed');
  has(cells[2].textContent, 'Age 25', 'age from the server');
  eq(cells[3].textContent, 'All rounder', 'role label');
  eq(cells[4].textContent, 'Left handed', 'style label');
  eq(cells[5].textContent, '9876543210', 'mobile');
  eq(cells[6].textContent, 'UPI12345678', 'UPI reference');
  has(cells[7].textContent, 'Verified', 'payment status word');
  eq(cells[8].textContent, '1 Aug 2026, 12:00', 'registration date from *_display');
  has(cells[9].textContent, 'Pending', 'auction status word');
  has(cells[10].textContent, 'Withdraw', 'actions cell has the withdraw action');

  // Thumbnail, lazily loaded.
  const img = byTag(rows[0], 'IMG')[0];
  ok(!!img, 'photo thumbnail rendered');
  eq(img.getAttribute('loading'), 'lazy', 'thumbnail is loading="lazy"');
  eq(img.src, 'https://drive.google.com/thumbnail?id=abc', 'thumbnail src is the server URL');

  // The private file id must never appear anywhere on this screen.
  ok(App.root.textContent.indexOf('screenshot_file_id') === -1,
    'no screenshot_file_id anywhere on the page');
}

async function testStatusIsAWordNotAColour() {
  console.log('\n[2] status pills carry a word, not only a colour');
  reset();
  await renderWith(listResponse({
    rows: [
      player({ player_id: 'P1', serial_no: 1, payment_status: 'PENDING', auction_status: 'PENDING' }),
      player({ player_id: 'P2', serial_no: 2, payment_status: 'VERIFIED', auction_status: 'SOLD' }),
      player({ player_id: 'P3', serial_no: 3, payment_status: 'REJECTED', auction_status: 'UNSOLD' })
    ],
    total: 3, totalPages: 1
  }));

  const pills = byClass(App.root, 'status');
  eq(pills.length, 6, 'two pills per row');
  pills.forEach((p, i) => ok(p.textContent.trim().length > 0, 'pill ' + i + ' has text'));

  const words = pills.map((p) => p.textContent);
  ['Pending', 'Verified', 'Rejected', 'Sold', 'Un-sold'].forEach((w) => {
    ok(words.indexOf(w) !== -1, 'the word "' + w + '" is rendered');
  });

  // The modifier class is the colour+shape; the word above is the signal.
  ok(pills.some((p) => p.className.indexOf('status--verified') !== -1), 'verified modifier applied');
  ok(pills.some((p) => p.className.indexOf('status--rejected') !== -1), 'rejected modifier applied');
  ok(pills.some((p) => p.className.indexOf('status--sold') !== -1), 'sold modifier applied');
  ok(pills.some((p) => p.className.indexOf('status--unsold') !== -1), 'unsold modifier applied');
}

async function testHostileName() {
  console.log('\n[3] a hostile player name renders as literal text');
  reset();
  await renderWith(listResponse({ rows: [player({ name: HOSTILE })] }));

  const row = rowsOf(App.root)[0];
  const value = byClass(row, 'players-name__value')[0];
  ok(!!value, 'name span exists');
  eq(value.textContent, HOSTILE, 'the whole hostile string is the text of one node');
  eq(value.children.length, 0, 'no child elements were created from the name');

  // The only <img> in the row is our own thumbnail; no element was parsed out
  // of the name, and no <script> exists anywhere.
  const imgs = byTag(row, 'IMG');
  eq(imgs.length, 1, 'exactly one img (the thumbnail) in the row');
  eq(imgs[0].src, 'https://drive.google.com/thumbnail?id=abc', 'that img is the thumbnail, not one from the name');
  eq(byTag(App.root, 'SCRIPT').length, 0, 'no script element anywhere');
  eq(byTag(row, 'TD').length + byTag(row, 'TH').length, 10 + 1,
    'the "</td>" in the name did not create extra cells');

  // A missing/hostile photo URL is never put in an attribute.
  reset();
  await renderWith(listResponse({ rows: [player({ photo_thumb_url: 'javascript:alert(1)' })] }));
  eq(byTag(App.root, 'IMG').length, 0, 'a non-http photo URL is not rendered as an image');
}

async function testCountsHeader() {
  console.log('\n[4] the counts summary renders in the header');
  reset();
  await renderWith(listResponse());

  const box = byClass(App.root, 'players-counts')[0];
  ok(!!box, 'counts list rendered');
  const text = box.textContent;

  has(text, 'Eligible for auction', 'eligible is labelled as the auction number');
  has(text, '335', 'eligible value');
  has(text, 'Registered in total', 'total label');
  has(text, '400', 'total value');
  has(text, 'Payment pending', 'pending label');
  has(text, '42', 'pending value');
  has(text, 'Payment verified', 'verified label');
  has(text, '340', 'verified value');
  has(text, 'Payment rejected', 'rejected label');
  has(text, '18', 'rejected value');

  const headline = byClass(App.root, 'players-count--headline')[0];
  ok(!!headline, 'eligible is the headline tile');
  has(headline.textContent, 'Eligible for auction', 'headline is the eligible tile');
}

async function testServerSidePaging() {
  console.log('\n[5] paging is server-side, 50 a page, and sends a page number');
  reset();
  await renderWith(listResponse({ rows: [player()], page: 1, total: 400, totalPages: 8 }));

  let call = lastList();
  eq(call.payload.tournamentId, 'TRN_1', 'tournament id from the query string');
  eq(call.payload.page, 1, 'first request asks for page 1');
  eq(call.payload.pageSize, 50, 'page size is 50');
  eq(call.payload.sort, 'serial_no', 'default sort');

  const next = findButton(App.root, 'Next page');
  ok(!!next, 'next page button rendered');
  eq(next.disabled, false, 'next is enabled on page 1 of 8');
  const prev = findButton(App.root, 'Previous page');
  eq(prev.disabled, true, 'previous is disabled on page 1');

  always('player.list', () => listResponse({ rows: [player()], page: 2, total: 400, totalPages: 8 }));
  next.click();
  await flush();

  call = lastList();
  eq(call.payload.page, 2, 'next page asks the server for page 2');
  eq(call.payload.pageSize, 50, 'page size is still 50');

  findButton(App.root, 'Previous page').click();
  await flush();
  eq(lastList().payload.page, 1, 'previous page asks for page 1');

  has(byClass(App.root, 'players-pager__status')[0].textContent, 'of 400',
    'the pager states the whole-tournament total');

  // Nothing anywhere may request the whole tournament in one go.
  listCalls().forEach((c, i) => {
    eq(c.payload.pageSize, 50, 'call ' + i + ' keeps pageSize 50');
    ok(typeof c.payload.page === 'number' && c.payload.page >= 1, 'call ' + i + ' sends a page number');
  });
}

async function testSearchDebounce() {
  console.log('\n[6] rapid typing collapses into ONE server call');
  reset();
  await renderWith(listResponse());

  const before = listCalls().length;
  const input = byTag(App.root, 'INPUT').find((i) => i.name === 'player-search');
  ok(!!input, 'search box rendered');
  eq(input.type, 'search', 'it is a search input');

  '98765'.split('').forEach((ch, i) => {
    input.value = '98765'.slice(0, i + 1);
    input.dispatch('input');
  });

  eq(listCalls().length - before, 0, 'no request fired while the admin was still typing');

  await sleep(AdminPlayersPage.SEARCH_DEBOUNCE_MS + 150);
  await flush();

  eq(listCalls().length - before, 1, 'five keystrokes produced exactly one request');
  eq(lastList().payload.filter.search, '98765', 'the request carries the final text');
  eq(lastList().payload.page, 1, 'a new search starts at page 1');

  // A keystroke that leaves the value unchanged must not refetch.
  const after = listCalls().length;
  input.dispatch('input');
  await sleep(AdminPlayersPage.SEARCH_DEBOUNCE_MS + 150);
  await flush();
  eq(listCalls().length, after, 'an unchanged value does not refetch');
}

async function testFiltersRoundTrip() {
  console.log('\n[7] filters round-trip to the server');
  reset();
  await renderWith(listResponse({ page: 3, total: 400, totalPages: 8 }));

  // Start on a later page so the reset-to-page-1 rule can be observed.
  AdminPlayersPage._state.page = 3;

  const selects = byTag(App.root, 'SELECT');
  const payment = selects.find((s) => s.name === 'filter-paymentStatus');
  const auction = selects.find((s) => s.name === 'filter-auctionStatus');
  const withdrawn = selects.find((s) => s.name === 'filter-withdrawn');
  ok(!!payment && !!auction && !!withdrawn, 'three filter dropdowns rendered');

  payment.value = 'PENDING';
  payment.dispatch('change');
  await flush();
  eq(lastList().payload.filter.paymentStatus, 'PENDING', 'payment status filter sent');
  eq(lastList().payload.page, 1, 'changing a filter returns to page 1');

  auction.value = 'UNSOLD';
  auction.dispatch('change');
  await flush();
  eq(lastList().payload.filter.auctionStatus, 'UNSOLD', 'auction status filter sent');

  withdrawn.value = 'false';
  withdrawn.dispatch('change');
  await flush();
  eq(lastList().payload.filter.withdrawn, false, 'withdrawn:false is sent as a boolean');

  withdrawn.value = 'true';
  withdrawn.dispatch('change');
  await flush();
  eq(lastList().payload.filter.withdrawn, true, 'withdrawn:true is sent as a boolean');

  withdrawn.value = '';
  withdrawn.dispatch('change');
  await flush();
  eq(Object.prototype.hasOwnProperty.call(lastList().payload.filter, 'withdrawn'), false,
    'the blank option omits withdrawn entirely, which the server reads as "both"');

  // The three still-set filters travel together.
  eq(lastList().payload.filter.paymentStatus, 'PENDING', 'payment filter still applied');
  eq(lastList().payload.filter.auctionStatus, 'UNSOLD', 'auction filter still applied');
}

async function testSortRoundTrip() {
  console.log('\n[8] sorting is sent to the server, and only the four legal keys');
  reset();
  await renderWith(listResponse({ page: 2, total: 400, totalPages: 8 }));
  AdminPlayersPage._state.page = 2;

  const sortButtons = byClass(App.root, 'players-sort');
  eq(sortButtons.length, 4, 'exactly four sortable columns');
  const sortLabels = sortButtons.map((b) => byClass(b, 'players-sort__label')[0].textContent);
  ['Serial No', 'Name', 'Payment Status', 'Registration Date'].forEach((l) => {
    ok(sortLabels.indexOf(l) !== -1, '"' + l + '" is sortable');
  });

  const nameSort = sortButtons[sortLabels.indexOf('Name')];
  nameSort.click();
  await flush();
  eq(lastList().payload.sort, 'name', 'clicking Name sorts by name on the server');
  eq(lastList().payload.page, 1, 'a new sort returns to page 1');
  eq(Object.prototype.hasOwnProperty.call(lastList().payload, 'sortDir'), false,
    'the first click asks for the default ascending order');

  // Clicking the active column reverses it.
  const nameSort2 = byClass(App.root, 'players-sort')
    .find((b) => byClass(b, 'players-sort__label')[0].textContent === 'Name');
  nameSort2.click();
  await flush();
  eq(lastList().payload.sort, 'name', 'still sorting by name');
  eq(lastList().payload.sortDir, 'desc', 'the second click reverses the order');

  const th = byTag(App.root, 'TH').find((t) => t.textContent.indexOf('Name') === 0);
  eq(th.getAttribute('aria-sort'), 'descending', 'aria-sort reports the order the server used');

  // Every sort key we ever send is one the contract allows.
  const legal = ['serial_no', 'name', 'registered_at', 'payment_status'];
  listCalls().forEach((c, i) => {
    ok(legal.indexOf(c.payload.sort) !== -1, 'call ' + i + ' sorts by a legal key');
  });
}

async function testWithdrawConfirmation() {
  console.log('\n[9] the withdraw confirmation names the player and the reserved serial');
  reset();
  await renderWith(listResponse());

  const btn = findButton(App.root, 'Withdraw');
  ok(!!btn, 'withdraw button on the row');

  UI._answer = false;
  btn.click();
  await flush();

  eq(log.confirms.length, 1, 'a confirmation was shown');
  const cfg = log.confirms[0];
  has(cfg.title, 'Anand Kumar', 'the dialog names the player');
  has(cfg.body, 'Anand Kumar', 'the body names the player');
  has(cfg.body, '27', 'the body states the serial number');
  has(cfg.body, 'reserved', 'the body says the serial stays reserved');
  has(cfg.body, 'never reused', 'the body says the serial is never reused');
  eq(log.apiCalls.filter((c) => c.action === 'player.setWithdrawn').length, 0,
    'answering no calls nothing');

  // Now say yes.
  UI._answer = true;
  respond('player.setWithdrawn', (payload) => {
    eq(payload.playerId, 'PLY_1', 'player id sent');
    eq(payload.withdrawn, true, 'withdrawn:true sent');
    return { player_id: 'PLY_1', serial_no: 27, is_withdrawn: true };
  });

  const listsBefore = listCalls().length;
  findButton(App.root, 'Withdraw').click();
  await flush(12);

  eq(log.apiCalls.filter((c) => c.action === 'player.setWithdrawn').length, 1,
    'player.setWithdrawn called once');
  ok(listCalls().length > listsBefore, 'the page re-reads the list so the counts move');
}

async function testSoldRefusalIsSurfaced() {
  console.log('\n[10] a SOLD player\'s refusal is shown, not hidden');
  reset();
  const sold = player({ auction_status: 'SOLD', payment_status: 'VERIFIED' });
  await renderWith(listResponse({ rows: [sold] }));

  const btn = findButton(App.root, 'Withdraw');
  ok(!!btn, 'the withdraw button is still offered for a sold player');

  const message = 'Player #27 has already been sold, so this cannot be changed here. ' +
    'Use the auction correction screen instead — it also gives the team back its money.';
  respond('player.setWithdrawn', () => { throw { code: 'VALIDATION_FAILED', message: message }; });

  btn.click();
  await flush(12);

  const page = App.root.textContent;
  has(page, 'already been sold', 'the server reason appears on the page');
  has(page, 'auction correction screen', 'the remedy the server names is shown');
  ok(byClass(App.root, 'players-row__note')[0].textContent.indexOf('already been sold') !== -1,
    'the reason is shown against the row it belongs to');
  ok(byClass(App.root, 'admin__errors')[0].textContent.indexOf('already been sold') !== -1,
    'and in the page live region');

  // The row survives: nothing was optimistically changed.
  eq(rowsOf(App.root).length, 1, 'the row is still there');
}

async function testEmptyStates() {
  console.log('\n[11] empty page, out-of-range page and an empty tournament');
  reset();

  // (a) nobody registered yet
  await renderWith(listResponse({
    rows: [], total: 0, totalPages: 0,
    counts: { all: 0, pending: 0, verified: 0, rejected: 0, withdrawn: 0, eligible: 0 }
  }));
  eq(byTag(App.root, 'TABLE').length, 0, 'no empty table is drawn');
  has(App.root.textContent, 'No players have registered for this tournament yet',
    'the empty tournament says so');

  // (b) filters match nobody
  reset();
  await renderWith(listResponse({
    rows: [], total: 0, totalPages: 0,
    counts: { all: 400, pending: 42, verified: 340, rejected: 18, withdrawn: 5, eligible: 335 }
  }));
  const search = byTag(App.root, 'INPUT').find((i) => i.name === 'player-search');
  search.value = 'zzzz';
  search.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await flush();
  has(App.root.textContent, 'No player matches this search', 'the no-match message');
  has(App.root.textContent, 'zzzz', 'it repeats what was searched for');
  has(App.root.textContent, '400 players registered in total', 'and says how many exist');

  const clear = findButton(App.root, 'Clear the search and filters');
  ok(!!clear, 'a way out of a filter that matches nobody');
  always('player.list', () => listResponse());
  clear.click();
  await flush();
  eq(lastList().payload.filter.search, undefined, 'clearing drops the search from the payload');
  eq(byTag(App.root, 'INPUT').find((i) => i.name === 'player-search').value, '',
    'and empties the search box');

  // (c) page past the end
  reset();
  await renderWith(listResponse({ rows: [], page: 9, total: 400, totalPages: 8 }));
  has(App.root.textContent, 'Page 9 does not exist', 'out-of-range page named exactly');
  has(App.root.textContent, '400 players on 8 pages', 'and the real size of the list');
  const go = findButton(App.root, 'Go to page 1');
  ok(!!go, 'a button back to a page that exists');
  always('player.list', () => listResponse());
  go.click();
  await flush();
  eq(lastList().payload.page, 1, 'it asks the server for page 1');
}

async function testSessionExpiry() {
  console.log('\n[12] an expired session clears the token and goes to sign in');
  reset();
  respond('player.list', () => { throw { code: 'UNAUTHORIZED', message: 'Session expired.' }; });
  AdminPlayersPage.render(ctx({ t: 'TRN_1' }));
  await flush();

  eq(API.getToken(), null, 'token cleared');
  eq(log.navigations.length, 1, 'one navigation');
  eq(log.navigations[0].to, '/admin/login', 'to the login screen');
  eq(log.navigations[0].opts.replace, true, 'as a replace, so Back does not bounce');
  eq(byClass(App.root, 'admin__errors')[0].textContent, '',
    'no error banner is painted over a page that is being replaced');

  // No token at all: never even render.
  reset();
  API._token = null;
  AdminPlayersPage.render(ctx({ t: 'TRN_1' }));
  await flush();
  eq(log.apiCalls.length, 0, 'no call is made without a token');
  eq(log.navigations[0].to, '/admin/login', 'straight to sign in');
}

async function testTournamentChooser() {
  console.log('\n[13] the tournament selection travels with the page');
  reset();

  // (a) the ?t= selection app.js owns is what gets sent to the server, and
  //     the name it already knows is shown rather than a bare id.
  await renderWith(listResponse());
  eq(lastList().payload.tournamentId, 'TRN_1', 'App.currentTournamentId feeds player.list');
  has(byClass(App.root, 'players-scope')[0].textContent, 'Summer Cup',
    'the tournament name is shown, not just the id');
  has(byClass(App.root, 'players-scope')[0].textContent, 'TRN_1', 'the id is shown too');
  eq(findLink(App.root, 'Back to tournaments').href, '/cricket-auction/admin/dashboard?t=TRN_1',
    'internal links keep the selection (App.adminPath)');

  // (b) no selection at all: ask, never guess.
  reset();
  respond('tournament.list', () => ([
    { tournament_id: 'TRN_1', name: 'Summer Cup', player_count: 400, verified_count: 340 }
  ]));
  AdminPlayersPage.render(ctx({}));
  await flush();

  eq(listCalls().length, 0, 'no player.list without a tournament');
  has(App.root.textContent, 'Choose the tournament', 'it asks which tournament');
  const link = findLink(App.root, 'Summer Cup');
  ok(!!link, 'the tournament is offered as a link');
  eq(link.href, '/cricket-auction/admin/players?t=TRN_1', 'the link carries the id as ?t=');

  // (c) a shell without the Phase 2 helpers still works, and older bookmark
  //     spellings still open the right register.
  ['tournament', 'tournamentId', 'id', 't'].forEach(() => {});
  const spellings = [['t', 'TRN_A'], ['tournament', 'TRN_B'], ['tournamentId', 'TRN_C'], ['id', 'TRN_D']];
  for (const pair of spellings) {
    reset();
    delete App.currentTournamentId;
    delete App.adminPath;
    delete App.tournamentName;
    always('player.list', () => listResponse());
    const q = {};
    q[pair[0]] = pair[1];
    AdminPlayersPage.render(ctx(q));
    await flush();
    eq(lastList().payload.tournamentId, pair[1], '?' + pair[0] + '= works without App helpers');
    eq(findLink(App.root, 'Back to tournaments').href,
      '/cricket-auction/admin/dashboard?t=' + pair[1],
      'the fallback link builder still carries the selection');
  }
  reset();
}

async function testWithdrawnRow() {
  console.log('\n[14] a withdrawn player is marked with a word and can be put back');
  reset();
  await renderWith(listResponse({ rows: [player({ is_withdrawn: true })] }));

  const row = rowsOf(App.root)[0];
  has(row.className, 'players-row--withdrawn', 'the row is flagged');
  has(row.textContent, 'Withdrawn', 'the word "Withdrawn" is in the row, not just a colour');

  const btn = findButton(App.root, 'Cancel withdrawal');
  ok(!!btn, 'the inverse action is offered');

  UI._answer = true;
  respond('player.setWithdrawn', (payload) => {
    eq(payload.withdrawn, false, 'putting the player back sends withdrawn:false');
    return { player_id: 'PLY_1', serial_no: 27, is_withdrawn: false };
  });
  btn.click();
  await flush(12);
  has(log.confirms[0].body, 'never reused', 'the restore dialog is honest about the serial too');
}

async function testStaleRepliesDoNotPaint() {
  console.log('\n[15] a slow earlier reply never paints over a later one');
  reset();

  let resolveFirst;
  responses['player.list'] = [
    () => new Promise((r) => { resolveFirst = () => r(listResponse({ rows: [player({ name: 'STALE' })] })); }),
    () => listResponse({ rows: [player({ name: 'FRESH' })] })
  ];

  AdminPlayersPage.render(ctx({ t: 'TRN_1' }));
  await flush(2);

  const selects = byTag(App.root, 'SELECT');
  selects.find((s) => s.name === 'filter-paymentStatus').value = 'PENDING';
  selects.find((s) => s.name === 'filter-paymentStatus').dispatch('change');
  await flush();

  resolveFirst();
  await flush(10);

  has(App.root.textContent, 'FRESH', 'the newest reply is on screen');
  ok(App.root.textContent.indexOf('STALE') === -1, 'the slow first reply was discarded');
}

/* ==================================================================== *
 * 7. Run
 * ==================================================================== */

(async function run() {
  console.log('admin-players.js — harness');
  await testColumnsAndCells();
  await testStatusIsAWordNotAColour();
  await testHostileName();
  await testCountsHeader();
  await testServerSidePaging();
  await testSearchDebounce();
  await testFiltersRoundTrip();
  await testSortRoundTrip();
  await testWithdrawConfirmation();
  await testSoldRefusalIsSurfaced();
  await testEmptyStates();
  await testSessionExpiry();
  await testTournamentChooser();
  await testWithdrawnRow();
  await testStaleRepliesDoNotPaint();

  console.log('\n' + '-'.repeat(64));
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' FAILED');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(passed + '/' + passed + ' assertions passed');
})();
