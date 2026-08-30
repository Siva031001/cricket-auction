/**
 * Verification harness for frontend/js/pages/admin-payments.js.
 *
 * Lives outside the repo on purpose: the project has no build step and no npm
 * runtime deps, so nothing test-shaped is allowed to ship in frontend/. Same
 * approach as /tmp/admin-harness/run.js, which covers the Phase 1 admin pages.
 *
 * A tiny DOM, stubs for API / Router / App, and the REAL frontend/js/ui.js, so
 * these tests exercise the actual UI.field / UI.button / UI.banner semantics
 * the page depends on.
 *
 * Run:  node /tmp/payments-harness/run.js
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
  this.className = '';
  this.parentNode = null;
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
  const at = this.children.indexOf(node);
  if (at !== -1) this.children.splice(at, 1);
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
El.prototype.removeEventListener = function (type, fn) {
  const l = this._listeners[type] || [];
  const at = l.indexOf(fn);
  if (at !== -1) l.splice(at, 1);
};
El.prototype.dispatch = function (type, ev) {
  const event = ev || {};
  if (!event.target) event.target = this;
  if (!event.preventDefault) event.preventDefault = function () { event.defaultPrevented = true; };
  (this._listeners[type] || []).slice().forEach((fn) => fn(event));
  return event;
};
El.prototype.click = function () {
  if (this.disabled) return;
  this.dispatch('click');
};
El.prototype.focus = function () { global.document.activeElement = this; };
El.prototype.select = function () { this._selected = true; };
El.prototype.scrollIntoView = function () {};
El.prototype.querySelectorAll = function (sel) {
  const want = String(sel).toUpperCase();
  return all(this).filter((e) => e.tagName === want);
};

/** Depth-first list of every element node under root. */
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
function first(root, cls) { return byClass(root, cls)[0] || null; }

/**
 * Everything the browser could show or act on, as one string: text, plus every
 * attribute value, plus src/href/value properties. Used by the "no Drive URL
 * anywhere" assertion, which would be worthless if it only looked at text.
 */
function serialize(root) {
  const bits = [];
  (function walk(n) {
    if (n.nodeType === 3) { bits.push(n._text); return; }
    bits.push('<' + n.tagName.toLowerCase() + ' class="' + n.className + '"');
    Object.keys(n.attributes).forEach((k) => bits.push(' ' + k + '="' + n.attributes[k] + '"'));
    ['src', 'href', 'value', 'alt'].forEach((k) => {
      if (n[k] !== undefined && n[k] !== '' && n[k] !== null) bits.push(' ' + k + '="' + n[k] + '"');
    });
    bits.push('>');
    bits.push(n._own);
    n.children.forEach(walk);
    bits.push('</' + n.tagName.toLowerCase() + '>');
  })(root);
  return bits.join('');
}

const docListeners = {};

global.document = {
  title: '',
  body: new El('body'),
  activeElement: null,
  createElement: (t) => new El(t),
  createTextNode: (t) => new TextNode(t),
  execCommand: () => true,
  getElementById: () => global.App.root,
  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  removeEventListener(type, fn) {
    const l = docListeners[type] || [];
    const at = l.indexOf(fn);
    if (at !== -1) l.splice(at, 1);
  }
};

/** Fire a document-level key event, exactly as the browser would. */
function key(k, target) {
  const ev = {
    key: k,
    target: target || global.document.body,
    defaultPrevented: false,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault() { ev.defaultPrevented = true; }
  };
  (docListeners.keydown || []).slice().forEach((fn) => fn(ev));
  return ev;
}

global.window = {
  location: { origin: 'https://example.github.io', pathname: '/', search: '' },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
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
Object.defineProperty(global, 'navigator', {
  value: global.window.navigator, configurable: true, writable: true
});

/* ==================================================================== *
 * 2. Stubs for the modules other agents own
 * ==================================================================== */

const log = { navigations: [], apiCalls: [], confirms: [] };

global.CONFIG = { BASE_PATH: '/cricket-auction', TOKEN_KEY: 'ca.session.token' };
global.App = { root: new El('div'), intendedPath: null };
global.Router = {
  href: (p) => '/cricket-auction' + p,
  navigate: (to, opts) => { log.navigations.push({ to, opts: opts || {} }); }
};

/** Queued responses: { 'action': [fn(payload) -> Promise, ...] } */
const responses = {};
function respond(action, fn) { (responses[action] = responses[action] || []).push(fn); }
/** A response used for every call to an action, however many there are. */
const always = {};
function alwaysRespond(action, fn) { always[action] = fn; }

global.API = {
  _token: 'TOK',
  setToken(t) { API._token = t; },
  getToken() { return API._token; },
  clearToken() { API._token = null; },
  call(action, payload, opts) {
    log.apiCalls.push({ action, payload, opts });
    const queue = responses[action];
    if (queue && queue.length) return queue.shift()(payload);
    if (always[action]) return always[action](payload);
    return Promise.reject({ code: 'INTERNAL_ERROR', message: 'harness: no stub for ' + action });
  }
};

/* ==================================================================== *
 * 3. Load the real files, exactly as the browser would
 * ==================================================================== */

function load(relPath, globalName) {
  const src = fs.readFileSync(path.join(FRONTEND, relPath), 'utf8');
  new Function(src + '\n;globalThis.' + globalName + ' = ' + globalName + ';')();
}

load('js/ui.js', 'UI');
load('js/pages/admin-payments.js', 'AdminPaymentsPage');

// Only the modal is stubbed: it needs a real <dialog> and HTMLDialogElement,
// which a fake DOM cannot provide. Everything else in UI is the real thing.
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
/** JSON.stringify would choke on a DOM node (parentNode is a cycle). */
function describe(v) {
  if (v && v.nodeType === 1) return '<' + v.tagName.toLowerCase() + ' class="' + v.className + '">';
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + '  (got ' + describe(actual) +
    ', want ' + describe(expected) + ')');
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush(n) { for (let i = 0; i < (n || 8); i += 1) await tick(); }

function callsTo(action) { return log.apiCalls.filter((c) => c.action === action); }

function reset() {
  log.navigations.length = 0;
  log.apiCalls.length = 0;
  log.confirms.length = 0;
  Object.keys(responses).forEach((k) => delete responses[k]);
  Object.keys(always).forEach((k) => delete always[k]);
  API._token = 'TOK';
  UI._answer = true;
  App.root = new El('div');
  document.body = new El('body');
  document.activeElement = null;
}

/* ---- fixtures ------------------------------------------------------ */

const TOURNAMENTS = [{
  tournament_id: 'TRN_1', name: 'Summer Cup', slug: 'summer-cup',
  status: 'REG_OPEN', player_count: 400, verified_count: 358
}];

const COUNTS_START = { all: 400, pending: 42, verified: 350, rejected: 8, withdrawn: 0, eligible: 350 };

/** A hostile name straight out of the registration sheet. */
const HOSTILE = '<img src=x onerror="alert(1)">Ravi & <b>Co</b>';

function row(i, over) {
  const base = {
    payment_id: 'PAY_' + i,
    player_id: 'PLR_' + i,
    serial_no: i,
    name: 'Player ' + i,
    mobile: '90000000' + (10 + i),
    upi_ref: 'UPI' + (100000 + i),
    amount: 500,
    amount_display: '₹500',
    submitted_at: '2026-08-0' + ((i % 9) + 1) + 'T06:00:00.000Z',
    submitted_at_display: '1 Aug 2026, 11:30 am',
    status: 'PENDING',
    photo_thumb_url: 'https://drive.google.com/thumbnail?id=FILE_ID_' + i,
    possible_duplicate_of: null
  };
  return Object.assign(base, over || {});
}

function queue(rows, counts, extra) {
  return Object.assign({
    rows: rows,
    page: 1,
    pageSize: 50,
    total: rows.length,
    totalPages: 1,
    counts: counts || COUNTS_START
  }, extra || {});
}

const SHOT = 'data:image/jpeg;base64,' + Buffer.from('not-a-real-jpeg').toString('base64');

function shotFor(r) {
  return {
    dataUri: SHOT,
    mime: 'image/jpeg',
    bytes: 151234,
    player: { serial_no: r.serial_no, name: r.name, mobile: r.mobile },
    upi_ref: r.upi_ref,
    amount_display: r.amount_display
  };
}

/** Boot the page with a given queue, and wait for it to settle. */
async function open(rows, counts) {
  reset();
  respond('tournament.list', () => Promise.resolve(TOURNAMENTS));
  respond('payment.list', () => Promise.resolve(queue(rows, counts)));
  const byId = {};
  rows.forEach((r) => { byId[r.payment_id] = r; });
  alwaysRespond('payment.getScreenshot', (p) =>
    Promise.resolve(shotFor(byId[p.paymentId] || rows[0])));
  AdminPaymentsPage.render({ path: '/admin/payments', params: {}, query: {}, pattern: '/admin/payments' });
  await flush();
}

function rowButtons() { return byClass(App.root, 'pay-row'); }
function reasonBox() { return AdminPaymentsPage._state.els.reason.input; }
function verifyBtn() { return AdminPaymentsPage._state.els.verifyBtn; }
function rejectBtn() { return AdminPaymentsPage._state.els.rejectBtn; }
function resultText() { return AdminPaymentsPage._state.els.result.textContent; }
function countsText() { return AdminPaymentsPage._state.els.counts.textContent; }
function detailText() { return AdminPaymentsPage._state.els.detail.textContent; }

/** Type into a textarea the way a person does: set value, fire input. */
function type(el, text) {
  el.value = text;
  el.dispatch('input', { target: el });
}

/* ==================================================================== *
 * 5. Tests
 * ==================================================================== */

async function testQueueRenders() {
  console.log('\n[1] the queue renders, with the counts header');
  await open([row(1), row(2), row(3)]);

  eq(document.body.dataset.route, 'admin-payments', 'body data-route is set');
  eq(callsTo('payment.list').length, 1, 'one payment.list');
  eq(callsTo('payment.list')[0].payload.filter.paymentStatus, 'PENDING',
    'the queue opens on the work still to do');
  eq(callsTo('payment.list')[0].payload.tournamentId, 'TRN_1', 'scoped to a tournament');
  eq(callsTo('payment.list')[0].payload.sort, 'submitted_at', 'oldest first');

  eq(rowButtons().length, 3, 'three rows in the queue');
  ok(rowButtons()[0].textContent.indexOf('#1') !== -1, 'the serial number is shown');
  ok(rowButtons()[0].textContent.indexOf('Player 1') !== -1, 'the name is shown');
  ok(rowButtons()[0].textContent.indexOf('UPI100001') !== -1, 'the UPI reference is shown');

  ok(countsText().indexOf('42 of 400 remaining') !== -1,
    'the counts header reads "42 of 400 remaining"  (got: ' + countsText() + ')');

  ok(App.root.textContent.indexOf('Summer Cup') !== -1,
    'the tournament being verified is named on screen');
}

async function testNoPrefetch() {
  console.log('\n[2] no prefetch, and exactly ONE getScreenshot per open');
  await open([row(1), row(2), row(3)]);

  eq(callsTo('payment.getScreenshot').length, 0,
    'NOTHING is prefetched — 400 base64 images would exhaust the tab');

  rowButtons()[1].click();
  await flush();

  eq(callsTo('payment.getScreenshot').length, 1, 'opening one row fetches one screenshot');
  eq(callsTo('payment.getScreenshot')[0].payload.paymentId, 'PAY_2', 'and it is the right one');

  // Re-rendering the detail (typing a reason) must not re-fetch.
  type(reasonBox(), 'looking at the statement');
  await flush();
  eq(callsTo('payment.getScreenshot').length, 1, 'typing does not re-fetch the screenshot');

  const img = first(App.root, 'pay-shot__img');
  ok(!!img, 'the screenshot is rendered');
  ok(String(img.src).indexOf('data:image/') === 0, 'the src is a data: URI');

  rowButtons()[2].click();
  await flush();
  eq(callsTo('payment.getScreenshot').length, 2, 'opening a second row fetches once more');
}

async function testZoom() {
  console.log('\n[3] the screenshot zooms full screen, and Escape closes it');
  await open([row(1)]);
  rowButtons()[0].click();
  await flush();

  const zoomBtn = first(App.root, 'pay-shot__zoom');
  ok(!!zoomBtn, 'the thumbnail is a real button, so the keyboard can reach it');
  zoomBtn.click();

  const overlay = byClass(document.body, 'pay-zoom')[0];
  ok(!!overlay, 'the full-screen overlay opened');
  eq(overlay.getAttribute('aria-modal'), 'true', 'it is a modal dialog');
  const big = first(overlay, 'pay-zoom__img');
  ok(!!big && String(big.src).indexOf('data:image/') === 0, 'the full-size image is the data: URI');

  key('Escape');
  eq(byClass(document.body, 'pay-zoom').length, 0, 'Escape closes it');
  eq(AdminPaymentsPage._state.zoom, null, 'and the state is clean');
}

async function testVerifyAdvances() {
  console.log('\n[4] verify advances to the next item and updates the counts');
  await open([row(1), row(2), row(3)]);
  rowButtons()[0].click();
  await flush();

  respond('payment.verify', (p) => {
    eq(p.paymentId, 'PAY_1', 'verify names the open payment');
    return Promise.resolve({
      payment_id: 'PAY_1', player_id: 'PLR_1', serial_no: 1, status: 'VERIFIED',
      verified_at_display: '30 Aug 2026, 6:15 pm',
      counts: { all: 400, pending: 41, verified: 351, rejected: 8, withdrawn: 0, eligible: 351 }
    });
  });

  const listCallsBefore = callsTo('payment.list').length;
  verifyBtn().click();
  await flush();

  ok(resultText().indexOf('#1 Player 1 verified') !== -1,
    'the decision is announced  (got: ' + resultText() + ')');
  ok(countsText().indexOf('41 of 400 remaining') !== -1,
    'the counts came out of the verify response  (got: ' + countsText() + ')');
  eq(callsTo('payment.list').length, listCallsBefore,
    'NO second round trip — counts ride along with the decision');

  eq(AdminPaymentsPage._state.index, 1, 'it advanced to the next pending payment');
  ok(detailText().indexOf('Player 2') !== -1, 'the next payment is open');
  eq(callsTo('payment.getScreenshot').length, 2, 'the next screenshot was fetched, once');
  eq(document.activeElement, AdminPaymentsPage._state.els.detailHeading,
    'focus followed the queue, so a keyboard user is not stranded');
}

async function testRejectNeedsReason() {
  console.log('\n[5] reject is blocked until a reason is typed');
  await open([row(1), row(2)]);
  rowButtons()[0].click();
  await flush();

  eq(rejectBtn().disabled, true, 'Reject starts disabled');
  rejectBtn().click();
  await flush();
  eq(callsTo('payment.reject').length, 0, 'a disabled Reject sends nothing');

  type(reasonBox(), 'no');                     // 2 chars, under the 3-char floor
  eq(rejectBtn().disabled, true, 'still disabled at two characters');
  rejectBtn().click();
  await flush();
  eq(callsTo('payment.reject').length, 0, 'and still sends nothing');

  respond('payment.reject', (p) => {
    eq(p.reason, 'no matching entry in the bank statement', 'the reason is sent');
    return Promise.resolve({
      payment_id: 'PAY_1', player_id: 'PLR_1', serial_no: 1, status: 'REJECTED',
      reject_reason: p.reason,
      counts: { all: 400, pending: 41, verified: 350, rejected: 9, withdrawn: 0, eligible: 350 }
    });
  });

  type(reasonBox(), 'no matching entry in the bank statement');
  eq(rejectBtn().disabled, false, 'enabled once the reason is long enough');
  rejectBtn().click();
  await flush();

  eq(callsTo('payment.reject').length, 1, 'one reject sent');
  ok(resultText().indexOf('#1 Player 1 rejected') !== -1,
    'the rejection is announced  (got: ' + resultText() + ')');
  eq(AdminPaymentsPage._state.index, 1, 'and it advanced');
}

async function testKeyboard() {
  console.log('\n[6] shortcuts work on the list and stand down inside the reason box');
  await open([row(1), row(2), row(3)]);

  key('j');
  await flush();
  eq(AdminPaymentsPage._state.index, 0, 'J from nowhere opens the first payment');

  key('j');
  await flush();
  eq(AdminPaymentsPage._state.index, 1, 'J moves down');

  key('ArrowDown');
  await flush();
  eq(AdminPaymentsPage._state.index, 2, 'the down arrow moves down too');

  key('k');
  await flush();
  eq(AdminPaymentsPage._state.index, 1, 'K moves back up');

  // --- the one that matters: keys must not fire while typing ---------
  const box = reasonBox();
  const before = AdminPaymentsPage._state.index;

  key('j', box);
  key('k', box);
  eq(AdminPaymentsPage._state.index, before, 'J and K do nothing while typing a reason');

  key('v', box);
  await flush();
  eq(callsTo('payment.verify').length, 0,
    'V INSIDE THE REASON BOX MUST NOT VERIFY — "verify" is a word people type');

  key('r', box);
  await flush();
  eq(callsTo('payment.reject').length, 0, 'R inside the reason box must not reject either');

  // Same for the status filter <select>, which also takes keystrokes.
  const select = byTag(App.root, 'SELECT')[0];
  key('v', select);
  await flush();
  eq(callsTo('payment.verify').length, 0, 'V inside a select does nothing');

  // --- and they DO fire from the list --------------------------------
  respond('payment.verify', () => Promise.resolve({
    payment_id: 'PAY_2', player_id: 'PLR_2', serial_no: 2, status: 'VERIFIED',
    counts: { all: 400, pending: 41, verified: 351, rejected: 8, withdrawn: 0, eligible: 351 }
  }));
  const ev = key('v', rowButtons()[1]);
  await flush();
  eq(callsTo('payment.verify').length, 1, 'V on the list verifies the open payment');
  eq(ev.defaultPrevented, true, 'and the key is consumed');

  // R with an empty reason box takes you to the box instead of rejecting.
  const idx = AdminPaymentsPage._state.index;
  key('r', rowButtons()[idx >= 0 ? idx : 0]);
  await flush();
  eq(callsTo('payment.reject').length, 0, 'R with no reason does not reject');
  eq(document.activeElement, reasonBox(), 'R moves focus to the reason box');

  // The visible switch really turns them off (the screen-reader escape hatch).
  AdminPaymentsPage._state.shortcuts = false;
  const idx2 = AdminPaymentsPage._state.index;
  key('j');
  eq(AdminPaymentsPage._state.index, idx2, 'with the switch off, J does nothing');
  AdminPaymentsPage._state.shortcuts = true;

  // The legend is on the page, not behind a help modal.
  ok(App.root.textContent.indexOf('Verify the open payment') !== -1,
    'the shortcuts are printed on the screen');
}

async function testHostileName() {
  console.log('\n[7] a hostile player name renders as literal text');
  await open([row(1, { name: HOSTILE })]);
  rowButtons()[0].click();
  await flush();

  const html = serialize(App.root);
  ok(html.indexOf('onerror=&') === -1, 'sanity: the harness is not escaping for us');
  ok(App.root.textContent.indexOf(HOSTILE) !== -1,
    'the name appears verbatim, as text');

  // Nothing built an element out of it: no IMG in the tree except the
  // screenshot, and no B at all.
  const imgs = byTag(App.root, 'IMG');
  eq(imgs.length, 1, 'exactly one <img> — the screenshot, not one from the name');
  eq(byTag(App.root, 'B').length, 0, 'the <b> in the name did not become an element');
  eq(imgs[0].getAttribute('onerror'), null, 'no onerror attribute anywhere');
}

async function testDuplicateHint() {
  console.log('\n[8] possible_duplicate_of shows as a question');
  await open([row(1, { possible_duplicate_of: 88 }), row(2)]);
  rowButtons()[0].click();
  await flush();

  const dup = first(App.root, 'pay-dup');
  ok(!!dup, 'the duplicate notice is rendered');
  ok(dup.textContent.indexOf('#88 has the same name. Check before verifying.') !== -1,
    'worded as the contract words it  (got: ' + dup.textContent + ')');
  ok(dup.textContent.toLowerCase().indexOf('fraud') === -1 &&
     dup.textContent.toLowerCase().indexOf('duplicate registration') === -1,
    'and it does not accuse anyone');
  ok(dup.textContent.indexOf('question and not a finding') !== -1,
    'it says out loud that it is only a hint');

  // Visible in the queue too, so the admin sees it before opening the row.
  ok(rowButtons()[0].textContent.indexOf('Same name as #88') !== -1,
    'the hint is on the list row as well');
}

async function testNoDriveUrl() {
  console.log('\n[9] no Drive URL and no file id ever reaches the DOM');
  // The list row fixture deliberately carries a Drive thumbnail URL and a file
  // id in photo_thumb_url. Neither may be rendered: the screenshot arrives as
  // a data: URI and a Drive link is unauthenticated (DESIGN.md §16 risk 1).
  await open([row(1, { possible_duplicate_of: 2 }), row(2)]);
  rowButtons()[0].click();
  await flush();
  first(App.root, 'pay-shot__zoom').click();       // include the zoom overlay

  const painted = serialize(App.root) + serialize(document.body);
  ok(painted.indexOf('drive.google.com') === -1, 'no Drive URL in the DOM');
  ok(painted.indexOf('googleusercontent') === -1, 'no Drive content URL either');
  ok(painted.indexOf('FILE_ID_') === -1, 'no Drive file id in the DOM');
  ok(painted.indexOf('/thumbnail?id=') === -1, 'no thumbnail link');
  ok(painted.indexOf('data:image/jpeg;base64,') !== -1, 'the screenshot IS there, as base64');
  AdminPaymentsPage._closeZoom();

  // And nothing ever asked for a batch of screenshots.
  ok(!log.apiCalls.some((c) => /getScreenshots|payment\.list.*screenshot/.test(c.action)),
    'no batch screenshot action exists or is called');
}

async function testAlreadyVerified() {
  console.log('\n[10] the already-verified no-op is calm, not an error');
  await open([row(1), row(2)]);
  rowButtons()[0].click();
  await flush();

  respond('payment.verify', () => Promise.resolve({
    payment_id: 'PAY_1', player_id: 'PLR_1', serial_no: 1, status: 'VERIFIED',
    verified_at_display: '30 Aug 2026, 5:02 pm',
    alreadyVerified: true,
    counts: COUNTS_START
  }));
  verifyBtn().click();
  await flush();

  const text = resultText();
  ok(text.indexOf('was already verified by') !== -1,
    'it says who, calmly  (got: ' + text + ')');
  ok(text.indexOf('Nothing was changed') !== -1, 'and that nothing changed');
  eq(AdminPaymentsPage._state.els.errors.textContent, '', 'it is NOT shown as an error');
  ok(byClass(AdminPaymentsPage._state.els.result, 'banner--error').length === 0,
    'the banner is not an error banner');
}

async function testReversal() {
  console.log('\n[11] a reversal is confirmed, then surfaced — and there is no undo button');
  await open([row(1, { status: 'REJECTED' })], { all: 400, pending: 0, verified: 391, rejected: 9, withdrawn: 0, eligible: 391 });
  AdminPaymentsPage._state.filter = 'ALL';
  rowButtons()[0].click();
  await flush();

  ok(detailText().indexOf('recorded in the audit log as a reversal') !== -1,
    'the detail warns that deciding again is a reversal');
  ok(detailText().indexOf('There is no undo.') !== -1,
    'and the detail says out loud that there is no undo');

  respond('payment.verify', () => Promise.resolve({
    payment_id: 'PAY_1', player_id: 'PLR_1', serial_no: 1, status: 'VERIFIED',
    verified_at_display: '30 Aug 2026, 6:40 pm',
    reversedFrom: 'REJECTED',
    counts: { all: 400, pending: 0, verified: 392, rejected: 8, withdrawn: 0, eligible: 392 }
  }));

  verifyBtn().click();
  await flush();

  eq(log.confirms.length, 1, 'overturning an earlier human decision asks first');
  ok(log.confirms[0].body.indexOf('reversal') !== -1, 'and the dialog says "reversal"');

  const text = resultText();
  ok(text.indexOf('reversed the earlier rejected decision') !== -1,
    'the reversal is surfaced in words  (got: ' + text + ')');
  ok(text.indexOf('audit log') !== -1, 'and it names the audit log');

  // Rule 7: no undo button anywhere on the screen.
  const labels = byTag(App.root, 'BUTTON').map((b) => b.textContent.toLowerCase());
  ok(!labels.some((l) => l.indexOf('undo') !== -1), 'there is no Undo button');
}

async function testEmptyQueue() {
  console.log('\n[12] an empty queue is the good outcome, and says so');
  await open([], { all: 400, pending: 0, verified: 392, rejected: 8, withdrawn: 0, eligible: 392 });

  ok(App.root.textContent.indexOf('Nothing left to check.') !== -1,
    'it says the queue is clear');
  ok(countsText().indexOf('0 of 400 remaining') !== -1, 'the counts still show');
  eq(AdminPaymentsPage._state.els.errors.textContent, '', 'and it is not an error');
  eq(callsTo('payment.getScreenshot').length, 0, 'nothing was fetched');
}

async function testFilter() {
  console.log('\n[13] the status filter re-queries the server');
  await open([row(1), row(2)]);
  const select = byTag(App.root, 'SELECT')[0];
  ok(!!select, 'there is a status filter');

  respond('payment.list', () => Promise.resolve(queue([row(9, { status: 'REJECTED' })])));
  select.value = 'REJECTED';
  select.dispatch('change', { target: select });
  await flush();

  const last = callsTo('payment.list').pop();
  eq(last.payload.filter.paymentStatus, 'REJECTED', 'the filter is sent to the server');
  eq(last.payload.page, 1, 'and it goes back to page one');
}

async function testUnauthorized() {
  console.log('\n[14] an expired session clears the token and goes to sign in');
  reset();
  respond('tournament.list', () => Promise.reject({ code: 'UNAUTHORIZED', message: 'Session expired.' }));
  AdminPaymentsPage.render({ path: '/admin/payments', params: {}, query: {}, pattern: '/admin/payments' });
  await flush();

  eq(API.getToken(), null, 'the token is cleared');
  eq(log.navigations.length, 1, 'it navigated');
  eq(log.navigations[0].to, '/admin/login', 'to the login screen');
  eq(log.navigations[0].opts.replace, true, 'replacing the history entry');
}

async function testUpiProminence() {
  console.log('\n[15] the UPI reference is large, monospace and copyable');
  await open([row(1)]);
  rowButtons()[0].click();
  await flush();

  const value = first(App.root, 'pay-upi__value');
  ok(!!value, 'the UPI reference has its own block');
  eq(value.textContent, 'UPI100001', 'showing the reference');

  const copy = byClass(App.root, 'pay-copy')[0];
  ok(!!copy, 'with a Copy button');

  const css = fs.readFileSync(path.join(FRONTEND, 'css/payments.css'), 'utf8');
  const block = css.slice(css.indexOf('.pay-upi__value'), css.indexOf('.pay-upi__value') + 600);
  ok(/font-family:\s*var\(--font-mono\)/.test(block), 'CSS sets a monospace font');
  ok(/letter-spacing:/.test(block), 'CSS sets letter-spacing');
  ok(/font-size:\s*clamp\(1\.5rem/.test(block), 'CSS sets it large');
}

async function testScreenshotMustBeDataUri() {
  console.log('\n[16] a non-data: screenshot source is refused, not rendered');
  reset();
  respond('tournament.list', () => Promise.resolve(TOURNAMENTS));
  respond('payment.list', () => Promise.resolve(queue([row(1)])));
  alwaysRespond('payment.getScreenshot', () => Promise.resolve({
    // A backend regression that hands back a Drive link instead of bytes.
    dataUri: 'https://drive.google.com/uc?id=FILE_ID_1',
    mime: 'image/jpeg', bytes: 1, player: { serial_no: 1, name: 'Player 1' }, upi_ref: 'UPI100001'
  }));
  AdminPaymentsPage.render({ path: '/admin/payments', params: {}, query: {}, pattern: '/admin/payments' });
  await flush();
  rowButtons()[0].click();
  await flush();

  eq(byTag(App.root, 'IMG').length, 0, 'no <img> was created for a Drive link');
  ok(serialize(App.root).indexOf('drive.google.com') === -1, 'and the link never reached the DOM');
  ok(detailText().indexOf('did not arrive in a form this page will display') !== -1,
    'the admin is told, in words');
}

async function testWrongScreenshotGuard() {
  console.log('\n[17] a screenshot belonging to another payment is refused');
  reset();
  respond('tournament.list', () => Promise.resolve(TOURNAMENTS));
  respond('payment.list', () => Promise.resolve(queue([row(1), row(2)])));
  alwaysRespond('payment.getScreenshot', () => Promise.resolve(shotFor(row(7))));
  AdminPaymentsPage.render({ path: '/admin/payments', params: {}, query: {}, pattern: '/admin/payments' });
  await flush();
  rowButtons()[0].click();
  await flush();

  eq(byTag(App.root, 'IMG').length, 0, 'the mismatched image is not shown');
  ok(detailText().indexOf('belongs to a different payment') !== -1,
    'and the admin is told which reference arrived');
}

async function testAccessibility() {
  console.log('\n[18] live regions, labels and focus');
  await open([row(1), row(2)]);

  eq(AdminPaymentsPage._state.els.counts.getAttribute('aria-live'), 'polite',
    'the counts are a live region');
  eq(AdminPaymentsPage._state.els.result.getAttribute('aria-live'), 'polite',
    'decision results are a live region');
  eq(AdminPaymentsPage._state.els.errors.getAttribute('aria-live'), 'assertive',
    'errors interrupt');

  rowButtons()[0].click();
  await flush();
  eq(rowButtons()[0].getAttribute('aria-current'), 'true', 'the open row is marked');

  // Every control has a real label.
  const labels = byTag(App.root, 'LABEL');
  ok(labels.length >= 2, 'there are real <label> elements');
  const reasonLabel = labels.find((l) => l.textContent.indexOf('Reason for rejecting') !== -1);
  ok(!!reasonLabel, 'the reason box has a visible label');
  eq(reasonLabel.getAttribute('for'), reasonBox().id, 'bound to the textarea by id');

  eq(AdminPaymentsPage._state.els.detailHeading.getAttribute('tabindex'), '-1',
    'the detail heading can receive focus after a decision');
}

async function testAppIntegration() {
  console.log('\n[19] it uses app.js\'s tournament selection and shared nav when they exist');
  reset();

  // The integration agent's app.js: ?t=<id> is the only source of truth, a
  // route guard has already made sure there is one, and App.adminNav builds
  // the shared bar that shows WHICH tournament is on screen.
  const setCalls = [];
  App.currentTournamentId = (ctx) => ((ctx && ctx.query && ctx.query.t) || '');
  App.tournamentName = (id) => (id === 'TRN_9' ? 'Winter Shield' : '');
  App.setTournament = (id, name) => setCalls.push({ id, name });
  App.adminNav = (activeKey) => {
    const nav = new El('nav');
    nav.className = 'admin-nav';
    nav._own = 'nav:' + activeKey;
    return nav;
  };

  respond('payment.list', () => Promise.resolve(queue([row(1)])));
  alwaysRespond('payment.getScreenshot', () => Promise.resolve(shotFor(row(1))));

  AdminPaymentsPage.render({
    path: '/admin/payments', params: {}, query: { t: 'TRN_9' }, pattern: '/admin/payments'
  });
  await flush();

  eq(callsTo('tournament.list').length, 0,
    'no tournament.list — app.js already knows the selection, so that round trip is saved');
  eq(callsTo('payment.list')[0].payload.tournamentId, 'TRN_9',
    'the queue is scoped to the id app.js supplied');
  eq(setCalls.length >= 1 && setCalls[0].id, 'TRN_9', 'the selection is handed back to app.js');

  const nav = first(App.root, 'admin-nav');
  ok(!!nav, 'the shared nav is mounted');
  eq(App.root.children[0].children[0], nav, 'as the first child of the panel');
  eq(nav.textContent, 'nav:payments', 'with the payments tab marked current');

  ok(App.root.textContent.indexOf('Winter Shield') !== -1,
    'and the tournament is named on the screen');

  // No duplicate navigation: the nav already carries those links.
  const labels = byTag(App.root, 'BUTTON').map((b) => b.textContent);
  ok(!labels.some((l) => l.indexOf('Change tournament') !== -1),
    'no second tournament switcher beside the nav');

  delete App.currentTournamentId;
  delete App.tournamentName;
  delete App.setTournament;
  delete App.adminNav;
}

/* ==================================================================== *
 * 6. Run
 * ==================================================================== */

(async function run() {
  console.log('admin-payments.js — behaviour harness');
  await testQueueRenders();
  await testNoPrefetch();
  await testZoom();
  await testVerifyAdvances();
  await testRejectNeedsReason();
  await testKeyboard();
  await testHostileName();
  await testDuplicateHint();
  await testNoDriveUrl();
  await testAlreadyVerified();
  await testReversal();
  await testEmptyQueue();
  await testFilter();
  await testUnauthorized();
  await testUpiProminence();
  await testScreenshotMustBeDataUri();
  await testWrongScreenshotGuard();
  await testAccessibility();
  await testAppIntegration();

  console.log('\n' + '-'.repeat(64));
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' FAILED');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(passed + '/' + passed + ' assertions passed');
})();
