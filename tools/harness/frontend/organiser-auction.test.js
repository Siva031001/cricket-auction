'use strict';
/**
 * organiser-auction.test.js — behavioural harness for
 * frontend/js/pages/organiser-auction.js, the live auction console.
 *
 * Run:  node tools/harness/frontend/organiser-auction.test.js
 *       (or `node tools/test.js organiser-auction`, which is what CI does)
 *
 * No dependencies and no framework. Each test boots a fresh vm context with a
 * small DOM, a fake clock and a stubbed API, then evaluates THREE REAL FILES
 * unmodified into it:
 *
 *   frontend/js/ui.js       so UI.field / UI.button / UI.banner / UI.money are
 *                           the real thing, including the Indian digit
 *                           grouping the consequence line depends on
 *   frontend/js/offline.js  so noteFailure / noteSuccess / enqueue / sync are
 *                           the real state machine, on its localStorage
 *                           fallback path, rather than a stub that agrees with
 *                           whatever the page happens to do
 *   frontend/js/pages/organiser-auction.js   the file under test
 *
 * Only UI.confirmDialog is replaced, because it needs a real <dialog> and
 * HTMLDialogElement that a fake DOM cannot provide. The replacement records
 * the exact {title, body} it was asked for, which is how the consequence-line
 * assertions read the arithmetic the organiser would actually see.
 *
 * The last block MUTATES the source and asserts that named tests then FAIL.
 * A test that still passes against broken code is not a test.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { makeClock, flush } = require('./fakedom');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FRONTEND = path.join(REPO, 'frontend');
const SRC_PATH = path.join(FRONTEND, 'js/pages/organiser-auction.js');
const CSS_PATH = path.join(FRONTEND, 'css/auction.css');

const SOURCE = fs.readFileSync(SRC_PATH, 'utf8');
const UI_SOURCE = fs.readFileSync(path.join(FRONTEND, 'js/ui.js'), 'utf8');
const OFFLINE_SOURCE = fs.readFileSync(path.join(FRONTEND, 'js/offline.js'), 'utf8');

const clone = (o) => JSON.parse(JSON.stringify(o));

/* ====================================================================== *
 * 1. A DOM big enough for ui.js and the console
 * ====================================================================== */

class ClassList {
  constructor(node) { this._node = node; }
  _list() { return String(this._node.className || '').split(/\s+/).filter(Boolean); }
  _write(l) { this._node.className = l.join(' '); }
  add(n) { const l = this._list(); if (l.indexOf(n) === -1) l.push(n); this._write(l); }
  remove(n) { this._write(this._list().filter((x) => x !== n)); }
  contains(n) { return this._list().indexOf(n) !== -1; }
}

class TextNode {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.childNodes = []; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.className = '';
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.id = '';
    this.name = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.required = false;
    this.readOnly = false;
    this.offsetWidth = 0;
    this.classList = new ClassList(this);
    this._doc = doc;
    this._listeners = {};
  }

  appendChild(c) {
    if (!c) throw new Error('appendChild(null) on <' + this.tagName.toLowerCase() + '>');
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i !== -1) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }

  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const l = this._listeners[t];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i !== -1) l.splice(i, 1);
  }
  dispatch(type, ev) {
    const event = ev || {};
    if (!event.target) event.target = this;
    if (!event.preventDefault) {
      event.preventDefault = function () { event.defaultPrevented = true; };
    }
    (this._listeners[type] || []).slice().forEach((fn) => fn(event));
    return event;
  }
  listenerCount(t) { return (this._listeners[t] || []).length; }

  click() { if (this.disabled) return; this.dispatch('click'); }
  focus() { if (this._doc) this._doc.activeElement = this; }
  select() { this._selected = true; }

  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    const s = (v === null || v === undefined) ? '' : String(v);
    if (s !== '') this.appendChild(new TextNode(s));
  }
}

function walk(node, out) {
  out = out || [];
  out.push(node);
  (node.childNodes || []).forEach((c) => { if (c.nodeType === 1) walk(c, out); });
  return out;
}
function byClass(root, cls) {
  return root ? walk(root).filter((n) => n.classList && n.classList.contains(cls)) : [];
}
function first(root, cls) { return byClass(root, cls)[0] || null; }
function byTag(root, tag) {
  const want = String(tag).toUpperCase();
  return root ? walk(root).filter((n) => n.tagName === want) : [];
}
/** Text of everything that is not inside a hidden subtree. */
function visibleText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.data;
  if (node.hidden) return '';
  return (node.childNodes || []).map(visibleText).join(' ');
}

/* ====================================================================== *
 * 2. Fixtures
 * ====================================================================== */

/**
 * Chennai Warriors is DESIGN.md §6.5a's worked example: ₹5,50,000 remaining
 * with 4 slots left, so a ₹75,000 sale must leave ₹4,75,000 for 3 slots at
 * ₹1,58,333 per slot. Salem Spartans has the same purse position but a much
 * bigger TOTAL purse, so the SQUAD_AT_RISK threshold can be tested on its own
 * without LARGE_SHARE_OF_PURSE firing at the same time.
 */
const SNAP = {
  v: 2,
  same: false,
  status: 'AUCTION_LIVE',
  current: null,
  teams: [
    {
      team_id: 'TM_1', team_name: 'Chennai Warriors',
      purse_remaining: 550000, purse_remaining_display: '₹5,50,000',
      purse_total: 1000000, players_count: 8, max_players: 12,
      per_slot_remaining_display: '₹1,37,500'
    },
    {
      team_id: 'TM_2', team_name: 'Madurai Kings',
      purse_remaining: 320000, purse_remaining_display: '₹3,20,000',
      purse_total: 1000000, players_count: 9, max_players: 12,
      per_slot_remaining_display: '₹1,06,666'
    },
    {
      team_id: 'TM_3', team_name: 'Salem Spartans',
      purse_remaining: 550000, purse_remaining_display: '₹5,50,000',
      purse_total: 4000000, players_count: 8, max_players: 12,
      per_slot_remaining_display: '₹1,37,500'
    }
  ],
  summary: {
    eligible: 100, sold: 17, unsold: 6, pending_called: 2, not_called: 75,
    total_spent_display: '₹4,50,000',
    teams_full: 0, teams_total: 3, all_teams_full: false,
    highest_sale: 120000, lowest_sale: 20000
  }
};

const CARD = {
  player_id: 'PLY_27', serial_no: 27, name: 'Raj Kumar', role: 'ALL_ROUNDER',
  style: 'RIGHT', age_years: 26, photo_thumb_url: 'https://drive.google.com/thumbnail?id=X&sz=w320',
  payment_status: 'VERIFIED', auction_status: 'PENDING', times_called: 1,
  is_withdrawn: false, eligible: true, team_id: '', team_name: '',
  sold_amount: null, sold_amount_display: '', sold_at: '', sold_at_display: ''
};

/* ====================================================================== *
 * 3. Boot one isolated console
 * ====================================================================== */

function boot(opts) {
  const options = opts || {};
  const clock = makeClock();

  /* ---- document ---------------------------------------------------- */
  const document = {
    title: '',
    hidden: false,
    activeElement: null,
    _listeners: {},
    createElement(tag) { return new Element(tag, document); },
    createTextNode(t) { return new TextNode(t); },
    getElementById(id) { return id === 'app' ? appRoot : null; },
    addEventListener(t, fn) { (document._listeners[t] = document._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const l = document._listeners[t];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    },
    dispatch(t, ev) { (document._listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    listenerCount(t) { return (document._listeners[t] || []).length; }
  };
  const body = new Element('body', document);
  const html = new Element('html', document);
  const appRoot = new Element('div', document);
  appRoot.id = 'app';
  body.appendChild(appRoot);
  document.body = body;
  document.documentElement = html;

  /** Fire a document-level key event, exactly as the browser would. */
  function key(k, target) {
    const ev = {
      key: k,
      target: target || body,
      defaultPrevented: false,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      preventDefault() { ev.defaultPrevented = true; }
    };
    document.dispatch('keydown', ev);
    return ev;
  }

  /* ---- storage ------------------------------------------------------ */
  const store = {};
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };

  /* ---- API stub ----------------------------------------------------- */
  const api = {
    lastVersion: null,
    calls: [],
    cleared: false,
    handlers: Object.assign({}, options.handlers || {}),
    call(action, payload, callOpts) {
      const entry = {
        action,
        payload: JSON.parse(JSON.stringify(payload || {})),
        opts: callOpts || null
      };
      api.calls.push(entry);
      const h = api.handlers[action];
      if (!h) {
        return Promise.reject({ code: 'INTERNAL_ERROR', message: 'harness: no stub for ' + action });
      }
      const nth = api.calls.filter((c) => c.action === action).length;
      const answer = h(entry.payload, nth) || {};
      if (Object.prototype.hasOwnProperty.call(answer, 'error')) {
        return Promise.reject(answer.error);
      }
      if (answer.data && typeof answer.data.v === 'number') api.lastVersion = answer.data.v;
      return Promise.resolve(answer.data);
    },
    get() { throw new Error('the console must POST; auction.state is not a public GET'); },
    getToken: () => 'TOK',
    setToken() {},
    clearToken() { api.cleared = true; }
  };

  const navigations = [];
  const Router = {
    href: (p) => '/cricket-auction' + p,
    navigate: (to, o) => { navigations.push({ to, opts: o || {} }); }
  };

  const App = {
    root: appRoot,
    TOURNAMENT_PARAM: 't',
    mount(el) { appRoot.textContent = ''; appRoot.appendChild(el); },
    rememberedTournamentId: () => '',
    tournamentName: () => 'Summer Cup'
  };

  const windowObj = {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    localStorage: localStorage,
    location: { origin: 'https://example.test', pathname: '/', search: '' },
    navigator: { userAgent: 'Harness/1.0' }
  };

  const confirms = [];
  const answer = { value: true };

  // offline.js warns once per boot that it fell back to localStorage, which is
  // expected here (Node has no IndexedDB) and would otherwise bury the results.
  const quietConsole = { log: function () {}, warn: function () {}, error: console.error };

  const sandbox = {
    document, window: windowObj, console: quietConsole,
    localStorage: localStorage,
    CONFIG: { POLL_INTERVAL_MS: 2000, TOKEN_KEY: 'ca.session.token', BASE_PATH: '' },
    API: api, Router: Router, App: App,
    __confirms: confirms, __answer: answer,
    Promise, Date, Math, Object, Array, String, Number, Boolean, JSON, RegExp, Error,
    isFinite, parseInt, parseFloat, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);

  // The real widget kit and the real offline module.
  vm.runInContext(UI_SOURCE + '\n;this.UI = UI;', sandbox, { filename: 'ui.js' });
  vm.runInContext(OFFLINE_SOURCE + '\n;this.Offline = Offline;', sandbox, { filename: 'offline.js' });

  // The ONE stub: a modal needs a real <dialog>. Recording {title, body} is
  // how the consequence-line tests read what the organiser would have seen.
  vm.runInContext(
    'UI.confirmDialog = function (cfg) { __confirms.push(cfg); ' +
    'return Promise.resolve(__answer.value); };', sandbox);

  const source = options.mutate ? options.mutate(SOURCE) : SOURCE;
  vm.runInContext(source + '\n;this.__page = OrganiserAuctionPage;', sandbox,
    { filename: 'organiser-auction.js' });

  return {
    page: sandbox.__page,
    UI: sandbox.UI,
    Offline: sandbox.Offline,
    document, body, appRoot, api, clock, key, navigations, confirms, answer,
    localStorage,
    root: () => appRoot.childNodes[0],
    ctx: (over) => Object.assign({
      path: '/organiser/auction',
      params: {},
      query: { t: 'TRN_1' },
      pattern: '/organiser/auction'
    }, over || {})
  };
}

/** Only the poll timer, ignoring anything else that might be armed. */
function pollDelays(env) { return env.clock.delays(); }

/* ---- small drivers -------------------------------------------------- */

function stateHandler(ref) {
  return function (payload) {
    if (ref.down) return { error: { code: 'NETWORK', message: 'offline' } };
    if (ref.sameFrom !== undefined && payload.v === ref.sameFrom) {
      return { data: { v: ref.snap.v, same: true } };
    }
    return { data: clone(ref.snap) };
  };
}

/** Boot, render, settle the first poll. */
async function open(over) {
  const ref = { snap: clone(SNAP), down: false };
  const handlers = Object.assign({
    'auction.state': stateHandler(ref),
    'auction.getBySerial': () => ({ data: { player: clone(CARD), revealed: true, v: ref.snap.v, message: '' } })
  }, (over && over.handlers) || {});

  const env = boot({ handlers: handlers, mutate: over && over.mutate });
  env.ref = ref;
  env.page.render(env.ctx((over && over.ctx) || {}));
  await flush();
  return env;
}

/** Type a serial number into the big box and press Enter. */
async function callSerial(env, serial) {
  const input = first(env.root(), 'auc-call').childNodes
    ? byTag(first(env.root(), 'auc-call'), 'INPUT')[0]
    : null;
  input.value = String(serial);
  input.dispatch('keydown', { key: 'Enter' });
  await flush();
  return input;
}

/** The sell form's team select, amount box, tick-box and SOLD button. */
function sellEls(env) {
  const root = env.root();
  const sell = first(root, 'auc-sell');
  const selects = byTag(sell, 'SELECT');
  const inputs = byTag(sell, 'INPUT');
  return {
    sell: sell,
    team: selects[0] || null,
    amount: inputs.filter((i) => i.type !== 'checkbox')[0] || null,
    ack: inputs.filter((i) => i.type === 'checkbox')[0] || null,
    go: first(sell, 'auc-sell__go'),
    unsold: first(sell, 'auc-sell__unsold'),
    preview: first(sell, 'auc-sell__preview'),
    warnings: byClass(sell, 'auc-warn')
  };
}

/** Choose a team and type an amount, the way an organiser would. */
function enterSale(env, teamId, amount) {
  const els = sellEls(env);
  els.team.value = String(teamId);
  els.team.dispatch('change');
  els.amount.value = String(amount);
  els.amount.dispatch('input');
  return sellEls(env);
}

function warnCodes(env) {
  return byClass(first(env.root(), 'auc-sell'), 'auc-warn').map((b) => b.dataset.code);
}

/* ====================================================================== *
 * 4. Tests
 * ====================================================================== */

const only = process.argv[2] || '';
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------------------------------------------------------------------- *
 * A. Boot, route and the poll
 * ---------------------------------------------------------------------- */

test('route: body.dataset.route is organiser-auction and the first poll is immediate', async () => {
  const env = await open();
  assert.strictEqual(env.body.dataset.route, 'organiser-auction',
    'auction.css scopes everything on this attribute');
  const polls = env.api.calls.filter((c) => c.action === 'auction.state');
  assert.strictEqual(polls.length, 1, 'the first poll must not wait 2s');
  assert.strictEqual(polls[0].payload.tournamentId, 'TRN_1');
  assert.strictEqual(polls[0].payload.v, undefined, 'nothing to send on the first poll');
  assert.strictEqual(polls[0].opts.retryBusy, false,
    'the SYSTEM_BUSY sleep would stack requests on a 2s loop');
});

test('poll: repeats every 2000 ms and sends back the version it holds', async () => {
  const env = await open();
  assert.ok(pollDelays(env).includes(2000),
    'a 2000 ms poll timer must be armed, saw ' + JSON.stringify(pollDelays(env)));

  env.clock.advance(2000);
  await flush();
  const polls = env.api.calls.filter((c) => c.action === 'auction.state');
  assert.strictEqual(polls.length, 2);
  assert.strictEqual(polls[1].payload.v, 2,
    'the poll must send the version it has, or the server cannot answer {same:true}');

  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.state').length, 3);
});

test('poll: {same:true} does NOT re-render', async () => {
  const env = await open();
  env.ref.sameFrom = 2;
  assert.strictEqual(env.page._paints, 1, 'the first snapshot is applied once');

  for (let i = 0; i < 5; i++) { env.clock.advance(2000); await flush(); }

  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.state').length, 6,
    'it kept polling');
  assert.strictEqual(env.page._paints, 1,
    'five unchanged polls must not repaint — a repaint would empty the amount box');
  assert.strictEqual(first(env.root(), 'auc-team__name').textContent, 'Chennai Warriors',
    'and the team strip is still on screen');
});

test('poll: a changed snapshot does repaint', async () => {
  const env = await open();
  env.ref.snap.v = 3;
  env.ref.snap.teams[0].purse_remaining_display = '₹4,75,000';
  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.page._paints, 2);
  assert.strictEqual(first(env.root(), 'auc-team__purse').textContent, '₹4,75,000');
});

test('poll: back-off doubles 2 -> 4 -> 8 -> 15 and holds at the ceiling', async () => {
  const env = await open();
  assert.ok(pollDelays(env).includes(2000));

  env.ref.down = true;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const armed = pollDelays(env);
    env.clock.advance(Math.max.apply(null, armed));
    await flush();
    seen.push(env.page._state.delay);
  }
  assert.deepStrictEqual(seen, [4000, 8000, 15000, 15000, 15000, 15000],
    'back-off must double then hold at 15s, saw ' + JSON.stringify(seen));
});

test('poll: a reconnecting indicator appears, with a word and a shape not just a colour', async () => {
  const env = await open();
  const link = first(env.root(), 'auc-link');
  assert.strictEqual(link.dataset.state, 'live');
  assert.strictEqual(first(env.root(), 'auc-link__text').textContent, 'Live');

  env.ref.down = true;
  env.clock.advance(2000);
  await flush();

  assert.strictEqual(link.dataset.state, 'reconnecting',
    'the indicator must change state, not only colour');
  assert.ok(/Reconnecting/.test(first(env.root(), 'auc-link__text').textContent));
  assert.strictEqual(first(env.root(), 'auc-link__mark').textContent, '⚠');
});

test('poll: one success resets the interval and the indicator', async () => {
  const env = await open();
  env.ref.down = true;
  for (let i = 0; i < 4; i++) {
    env.clock.advance(Math.max.apply(null, pollDelays(env)));
    await flush();
  }
  assert.strictEqual(env.page._state.delay, 15000, 'it is at the ceiling');

  env.ref.down = false;
  env.clock.advance(15000);
  await flush();
  assert.strictEqual(env.page._state.delay, 2000, 'one good poll returns it to 2s');
  assert.strictEqual(env.page._state.fails, 0);
  assert.strictEqual(first(env.root(), 'auc-link').dataset.state, 'live');
});

test('poll: a hidden tab stops polling and a shown tab catches up at once', async () => {
  const env = await open();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.state').length, 1);

  env.document.hidden = true;
  env.document.dispatch('visibilitychange');
  assert.ok(!pollDelays(env).includes(2000), 'the poll timer is disarmed while hidden');

  env.clock.advance(60000);
  await flush();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.state').length, 1,
    'a hidden tab must not poll — that quota belongs to the projector');

  env.document.hidden = false;
  env.document.dispatch('visibilitychange');
  await flush();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.state').length, 2,
    'showing the tab catches up immediately, not on the next tick');
});

test('teardown: rendering twice leaves one poll loop and one set of listeners', async () => {
  const env = await open();
  assert.strictEqual(env.document.listenerCount('keydown'), 1);
  assert.strictEqual(env.document.listenerCount('visibilitychange'), 1);

  env.page.render(env.ctx());
  await flush();

  assert.strictEqual(env.document.listenerCount('keydown'), 1,
    'a leaked keydown handler would fire SOLD twice');
  assert.strictEqual(env.document.listenerCount('visibilitychange'), 1);
  assert.strictEqual(pollDelays(env).filter((d) => d === 2000).length, 1,
    'two armed poll timers means the poll rate doubled: ' + JSON.stringify(pollDelays(env)));

  const before = env.api.calls.filter((c) => c.action === 'auction.state').length;
  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.state').length, before + 1,
    'one tick must produce exactly one request');
});

/* ---------------------------------------------------------------------- *
 * B. Calling a player
 * ---------------------------------------------------------------------- */

test('serial: typing a number and pressing Enter calls getBySerial ONCE and renders the card', async () => {
  const env = await open();
  await callSerial(env, 27);

  const got = env.api.calls.filter((c) => c.action === 'auction.getBySerial');
  assert.strictEqual(got.length, 1, 'exactly one call, never two');
  assert.strictEqual(got[0].payload.tournamentId, 'TRN_1');
  assert.strictEqual(got[0].payload.serialNo, 27, 'sent as a number, not "27"');

  const card = first(env.root(), 'auc-card');
  assert.strictEqual(first(card, 'auc-card__serial').textContent, '#27');
  assert.strictEqual(first(card, 'auc-card__name').textContent, 'Raj Kumar');
  assert.ok(/All rounder/.test(first(card, 'auc-card__meta').textContent));
  assert.ok(/Right handed/.test(first(card, 'auc-card__meta').textContent));
  assert.ok(/Age 26/.test(first(card, 'auc-card__meta').textContent));

  const pill = first(card, 'status');
  assert.ok(pill.classList.contains('status--pending'), 'colour');
  assert.strictEqual(first(pill, 'status__word').textContent, 'Pending', 'word');
  assert.strictEqual(first(pill, 'status__mark').textContent, '●', 'shape');
});

test('serial: a non-numeric entry is refused locally and never reaches the server', async () => {
  const env = await open();
  const box = byTag(first(env.root(), 'auc-call'), 'INPUT')[0];
  box.value = 'twenty seven';
  box.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.getBySerial').length, 0);
  assert.ok(/digits only/i.test(first(env.root(), 'auc-call').textContent));
});

test('serial: an unknown number shows the server\'s own message (DESIGN §15 case 18)', async () => {
  const env = await open({
    handlers: {
      'auction.getBySerial': () => ({
        error: { code: 'NOT_FOUND', message: 'No player with serial 999 in this tournament.' }
      })
    }
  });
  await callSerial(env, 999);
  assert.ok(/No player with serial 999 in this tournament\./.test(
    first(env.root(), 'auc__errors').textContent));
  assert.strictEqual(first(env.root(), 'auc-sell').textContent, '',
    'and there is nothing to sell');
});

test('serial: an ineligible player shows the payment status so the organiser can act (§15 case 19)', async () => {
  const env = await open({
    handlers: {
      'auction.getBySerial': () => ({
        data: {
          player: Object.assign(clone(CARD), {
            eligible: false, payment_status: 'REJECTED', times_called: 0
          }),
          revealed: false,
          v: 2,
          message: 'Player #27 Raj Kumar is not verified for the auction. Payment status is REJECTED.'
        }
      })
    }
  });
  await callSerial(env, 27);

  const card = first(env.root(), 'auc-card');
  assert.ok(/Payment status is REJECTED/.test(card.textContent),
    'the payment status must be on screen: ' + card.textContent);
  assert.ok(/not put on the projector/i.test(card.textContent),
    'and it must say they were not revealed');
  assert.strictEqual(first(env.root(), 'auc-sell').textContent, '',
    'an ineligible player has no sell form at all');
});

test('search: auction.search is read-only and choosing a row calls that serial', async () => {
  const env = await open({
    handlers: {
      'auction.search': () => ({
        data: {
          rows: [Object.assign(clone(CARD), { serial_no: 27, name: 'Raj Kumar' })],
          total: 1, limit: 25
        }
      })
    }
  });

  const findBox = first(env.root(), 'auc-find');
  const input = byTag(findBox, 'INPUT')[0];
  input.value = 'raj';
  findBox.dispatch('submit');
  await flush();

  const search = env.api.calls.filter((c) => c.action === 'auction.search');
  assert.strictEqual(search.length, 1);
  assert.strictEqual(search[0].payload.q, 'raj');
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.getBySerial').length, 0,
    'searching must NOT call a player to the table — times_called depends on it');

  first(env.root(), 'auc-find__row-btn').click();
  await flush();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.getBySerial').length, 1,
    'but choosing a result does');
});

/* ---------------------------------------------------------------------- *
 * C. The confirm dialog — the main safety feature
 * ---------------------------------------------------------------------- */

test('confirm: the dialog shows the exact remaining purse and slot count (DESIGN §6.5a)', async () => {
  const env = await open({
    handlers: {
      'auction.markSold': () => ({
        data: { player: Object.assign(clone(CARD), { auction_status: 'SOLD' }), team: null, warnings: [], v: 3 }
      })
    }
  });
  await callSerial(env, 27);

  const els = enterSale(env, 'TM_1', 75000);

  // The live consequence line, before anything is pressed.
  assert.strictEqual(els.preview.textContent,
    'Sell Raj Kumar (#27) to Chennai Warriors for ₹75,000? ' +
    'Leaves ₹4,75,000 for 3 more slots.',
    'the arithmetic must be exact: ' + els.preview.textContent);

  // No per-slot average. Every player sells for a different amount, so
  // remaining-purse-over-empty-slots states a price that does not exist.
  assert.ok(els.preview.textContent.indexOf('per slot') === -1,
    'the preview must not quote a per-slot price');

  els.go.click();
  await flush();

  assert.strictEqual(env.confirms.length, 1, 'nothing is sold without a confirm');
  assert.strictEqual(env.confirms[0].title,
    'Sell Raj Kumar (#27) to Chennai Warriors for ₹75,000?');
  assert.strictEqual(env.confirms[0].body,
    'Leaves ₹4,75,000 for 3 more slots.',
    'remaining purse ₹5,50,000 - ₹75,000 = ₹4,75,000, with 3 slots to fill');
});

test('confirm: answering no sends nothing at all', async () => {
  const env = await open({ handlers: { 'auction.markSold': () => ({ data: { v: 3 } }) } });
  await callSerial(env, 27);
  env.answer.value = false;
  enterSale(env, 'TM_1', 75000).go.click();
  await flush();
  assert.strictEqual(env.confirms.length, 1);
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.markSold').length, 0);
});

test('confirm: the last slot and an overspend are both described honestly', async () => {
  const env = await open();
  await callSerial(env, 27);

  // Madurai Kings: 9 of 12, ₹3,20,000 left. A sale leaves 2 slots.
  let els = enterSale(env, 'TM_2', 100000);
  assert.ok(/Leaves ₹2,20,000 for 2 more slots\./.test(els.preview.textContent),
    els.preview.textContent);

  // More than the purse: the line still tells the truth rather than hiding it.
  els = enterSale(env, 'TM_2', 400000);
  assert.ok(/Leaves -₹80,000 for 2 more slots/.test(els.preview.textContent),
    'an overspend is shown, not silently clamped: ' + els.preview.textContent);
});

/* ---------------------------------------------------------------------- *
 * D. The three advisory warnings — each at its threshold, none blocking
 * ---------------------------------------------------------------------- */

test('warning LARGE_SHARE_OF_PURSE fires just over 25% of the TOTAL purse and not at it', async () => {
  const env = await open();
  await callSerial(env, 27);

  // Chennai Warriors' total purse is ₹10,00,000, so the line is ₹2,50,000.
  enterSale(env, 'TM_1', 250000);
  assert.ok(warnCodes(env).indexOf('LARGE_SHARE_OF_PURSE') === -1,
    'exactly 25% must not warn (the backend uses a strict >)');

  enterSale(env, 'TM_1', 250001);
  assert.ok(warnCodes(env).indexOf('LARGE_SHARE_OF_PURSE') !== -1,
    'one rupee over 25% must warn, saw ' + JSON.stringify(warnCodes(env)));

  const banner = byClass(first(env.root(), 'auc-sell'), 'auc-warn')
    .filter((b) => b.dataset.code === 'LARGE_SHARE_OF_PURSE')[0];
  assert.ok(/25% of Chennai Warriors's total purse of ₹10,00,000/.test(banner.textContent),
    banner.textContent);
  assert.ok(banner.classList.contains('banner--warning'), 'amber, not red');
});

test('warning FAR_ABOVE_RECENT fires just over 5x the highest sale so far and not at it', async () => {
  const env = await open();
  await callSerial(env, 27);

  // highest_sale is ₹1,20,000, so the line is ₹6,00,000.
  enterSale(env, 'TM_1', 600000);
  assert.ok(warnCodes(env).indexOf('FAR_ABOVE_RECENT') === -1, 'exactly 5x must not warn');

  enterSale(env, 'TM_1', 600001);
  assert.ok(warnCodes(env).indexOf('FAR_ABOVE_RECENT') !== -1,
    'one rupee over 5x must warn, saw ' + JSON.stringify(warnCodes(env)));
});

test('warning FAR_ABOVE_RECENT stays silent while there is no history at all', async () => {
  const env = await open();
  env.ref.snap.v = 3;
  env.ref.snap.summary.highest_sale = 0;
  env.ref.snap.summary.lowest_sale = 0;
  env.clock.advance(2000);
  await flush();
  await callSerial(env, 27);

  enterSale(env, 'TM_3', 3000000);
  const codes = warnCodes(env);
  assert.ok(codes.indexOf('FAR_ABOVE_RECENT') === -1,
    'the first few sales have nothing to compare against, and that is correct');
  assert.ok(codes.indexOf('SQUAD_AT_RISK') === -1, 'nor a cheapest sale to compare against');
});

test('warning SQUAD_AT_RISK fires when the leftover per slot drops below the cheapest sale', async () => {
  const env = await open();
  await callSerial(env, 27);

  // Salem Spartans: ₹5,50,000 left, 8 of 12, so 3 slots after this sale. The
  // cheapest sale so far is ₹20,000, so the line is at ₹4,90,000 exactly:
  // ₹60,000 over 3 slots is ₹20,000 each, which is not BELOW ₹20,000.
  enterSale(env, 'TM_3', 490000);
  assert.ok(warnCodes(env).indexOf('SQUAD_AT_RISK') === -1,
    'exactly the cheapest sale per slot must not warn, saw ' + JSON.stringify(warnCodes(env)));

  enterSale(env, 'TM_3', 490001);
  assert.ok(warnCodes(env).indexOf('SQUAD_AT_RISK') !== -1,
    'one rupee more and it must warn, saw ' + JSON.stringify(warnCodes(env)));

  const banner = byClass(first(env.root(), 'auc-sell'), 'auc-warn')
    .filter((b) => b.dataset.code === 'SQUAD_AT_RISK')[0];
  assert.ok(/₹59,999 for 3 more slots — ₹19,999 each/.test(banner.textContent), banner.textContent);
  assert.ok(/cheapest sale so far of ₹20,000/.test(banner.textContent), banner.textContent);
});

test('warning: a warned sale is NEVER blocked — the tick-box lets it through', async () => {
  const env = await open({
    handlers: {
      'auction.markSold': () => ({
        data: {
          player: Object.assign(clone(CARD), { auction_status: 'SOLD' }),
          team: {
            team_id: 'TM_1', team_name: 'Chennai Warriors',
            purse_remaining_display: '₹49,999', slots_remaining: 3
          },
          warnings: [], v: 3
        }
      })
    }
  });
  await callSerial(env, 27);

  let els = enterSale(env, 'TM_1', 500001);
  assert.ok(els.warnings.length >= 1, 'a huge bid raises at least one advisory');
  assert.strictEqual(els.go.disabled, true, 'the SOLD button waits for the tick');
  assert.ok(els.ack, 'and there is a real tick-box to tick');

  els.ack.checked = true;
  els.ack.dispatch('change');
  els = sellEls(env);
  assert.strictEqual(els.go.disabled, false, 'ticking it lets the sale through — never a wall');

  els.go.click();
  await flush();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.markSold').length, 1,
    'a genuinely huge bid for a genuinely great player must always go through');
});

test('warning: changing the amount throws the tick away again', async () => {
  const env = await open();
  await callSerial(env, 27);

  let els = enterSale(env, 'TM_1', 500001);
  els.ack.checked = true;
  els.ack.dispatch('change');
  assert.strictEqual(sellEls(env).go.disabled, false);

  // A typo corrected into a bigger typo must not inherit the acknowledgement.
  els = enterSale(env, 'TM_1', 5000010);
  assert.strictEqual(els.go.disabled, true,
    'the tick is for one amount, never for the next one');
  assert.strictEqual(els.ack.checked, false);
});

test('warning: the server\'s own warnings are shown, and a disagreement is named', async () => {
  const env = await open({
    handlers: {
      'auction.markSold': () => ({
        data: {
          player: Object.assign(clone(CARD), { auction_status: 'SOLD' }),
          team: null,
          warnings: [{ code: 'SQUAD_AT_RISK', message: 'This leaves Chennai Warriors ₹1 for 3 more slots.' }],
          v: 3
        }
      })
    }
  });
  await callSerial(env, 27);
  enterSale(env, 'TM_1', 75000).go.click();
  await flush();

  const result = first(env.root(), 'auc__result');
  assert.ok(/This leaves Chennai Warriors ₹1 for 3 more slots\./.test(result.textContent),
    'the authoritative warning must be shown: ' + result.textContent);
  assert.ok(/server flagged something this screen had not/i.test(result.textContent),
    'and the disagreement must be named, not hidden');
});

/* ---------------------------------------------------------------------- *
 * E. expectedVersion and STALE_STATE
 * ---------------------------------------------------------------------- */

test('expectedVersion is sent on markSold, markUnsold, returnToPool and correct', async () => {
  const sold = Object.assign(clone(CARD), {
    auction_status: 'SOLD', team_id: 'TM_1', team_name: 'Chennai Warriors',
    sold_amount: 75000, sold_amount_display: '₹75,000'
  });
  const unsold = Object.assign(clone(CARD), { auction_status: 'UNSOLD' });

  /* ---- markSold ---- */
  let env = await open({
    handlers: { 'auction.markSold': () => ({ data: { player: sold, team: null, warnings: [], v: 3 } }) }
  });
  await callSerial(env, 27);
  enterSale(env, 'TM_1', 75000).go.click();
  await flush();
  let sent = env.api.calls.filter((c) => c.action === 'auction.markSold')[0];
  assert.strictEqual(sent.payload.expectedVersion, 2, 'markSold carries the held version');
  assert.strictEqual(sent.payload.playerId, 'PLY_27');
  assert.strictEqual(sent.payload.teamId, 'TM_1');
  assert.strictEqual(sent.payload.amount, 75000, 'a whole-rupee integer, not a string');

  /* ---- markUnsold ---- */
  env = await open({
    handlers: { 'auction.markUnsold': () => ({ data: { player: unsold, v: 3 } }) }
  });
  await callSerial(env, 27);
  sellEls(env).unsold.click();
  await flush();
  sent = env.api.calls.filter((c) => c.action === 'auction.markUnsold')[0];
  assert.strictEqual(sent.payload.expectedVersion, 2, 'markUnsold carries it too');

  /* ---- returnToPool ---- */
  env = await open({
    handlers: {
      'auction.getBySerial': () => ({ data: { player: unsold, revealed: true, v: 2, message: '' } }),
      'auction.returnToPool': () => ({ data: { player: clone(CARD), v: 3 } })
    }
  });
  await callSerial(env, 27);
  byTag(first(env.root(), 'auc-card__actions'), 'BUTTON')
    .filter((b) => /Return to the pool/.test(b.textContent))[0].click();
  await flush();
  sent = env.api.calls.filter((c) => c.action === 'auction.returnToPool')[0];
  assert.strictEqual(sent.payload.expectedVersion, 2, 'returnToPool carries it too');

  /* ---- correct ---- */
  env = await open({
    handlers: {
      'auction.getBySerial': () => ({ data: { player: sold, revealed: true, v: 2, message: '' } }),
      'auction.correct': () => ({ data: { player: sold, warnings: [], v: 3 } })
    }
  });
  await callSerial(env, 27);
  byTag(first(env.root(), 'auc-card__actions'), 'BUTTON')
    .filter((b) => /Correct this result/.test(b.textContent))[0].click();
  await flush();
  const correctBox = first(env.root(), 'auc-correct');
  assert.ok(correctBox, 'the correction panel opens for a sold player (DESIGN §6.7)');
  byTag(correctBox, 'INPUT')[0].value = '65000';
  byTag(correctBox, 'BUTTON')[0].click();
  await flush();
  sent = env.api.calls.filter((c) => c.action === 'auction.correct')[0];
  assert.strictEqual(sent.payload.expectedVersion, 2, 'correct carries it too');
  assert.strictEqual(sent.payload.amount, 65000);
  assert.strictEqual(sent.payload.newStatus, 'SOLD');
});

test('expectedVersion follows the poll: a later version is the one that is sent', async () => {
  const env = await open({
    handlers: { 'auction.markSold': () => ({ data: { player: clone(CARD), team: null, warnings: [], v: 8 } }) }
  });
  await callSerial(env, 27);

  env.ref.snap.v = 7;
  env.clock.advance(2000);
  await flush();

  enterSale(env, 'TM_1', 75000).go.click();
  await flush();
  assert.strictEqual(
    env.api.calls.filter((c) => c.action === 'auction.markSold')[0].payload.expectedVersion, 7,
    'the version the screen holds now, not the one it started with');
});

test('STALE_STATE says the screen was out of date, refreshes, and does NOT auto-retry', async () => {
  const env = await open({
    handlers: {
      'auction.markSold': () => ({
        error: {
          code: 'STALE_STATE',
          message: 'The auction has moved on since your screen last updated.'
        }
      })
    }
  });
  await callSerial(env, 27);

  const pollsBefore = env.api.calls.filter((c) => c.action === 'auction.state').length;
  enterSale(env, 'TM_1', 75000).go.click();
  await flush();

  const sells = env.api.calls.filter((c) => c.action === 'auction.markSold');
  assert.strictEqual(sells.length, 1, 'it must NOT silently retry — the data was wrong');

  const errors = first(env.root(), 'auc__errors').textContent;
  assert.ok(/Nothing was recorded/.test(errors), errors);
  assert.ok(/out of date/i.test(errors), 'it must say plainly that the screen was stale: ' + errors);
  assert.ok(/record it again/i.test(errors), 'and that the organiser has to look and re-record');

  assert.ok(env.api.calls.filter((c) => c.action === 'auction.state').length > pollsBefore,
    'it refreshes straight away so the next attempt sees the truth');

  // And still no second write after time passes.
  env.clock.advance(30000);
  await flush();
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.markSold').length, 1);
});

test('a business refusal prints the server\'s own words, unedited', async () => {
  const env = await open({
    handlers: {
      'auction.markSold': () => ({
        error: {
          code: 'INSUFFICIENT_PURSE',
          message: 'Insufficient purse amount. Chennai Warriors has only ₹5,50,000 ' +
            'remaining and the bid is ₹9,00,000 — ₹3,50,000 short.'
        }
      })
    }
  });
  await callSerial(env, 27);
  const els = enterSale(env, 'TM_1', 900000);
  els.ack.checked = true;
  els.ack.dispatch('change');
  sellEls(env).go.click();
  await flush();
  assert.ok(/₹3,50,000 short/.test(first(env.root(), 'auc__errors').textContent),
    'the shortfall is the number the organiser needs, so it is not paraphrased');
});

/* ---------------------------------------------------------------------- *
 * F. Offline
 * ---------------------------------------------------------------------- */

test('offline: THREE consecutive poll failures flip to the OFFLINE banner, not one or two', async () => {
  const env = await open();
  env.ref.down = true;

  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.Offline.isOffline(), false, 'one failure is a blip, not an outage');
  assert.strictEqual(first(env.root(), 'auc-off').hidden, true);

  env.clock.advance(4000);
  await flush();
  assert.strictEqual(env.Offline.isOffline(), false, 'two is still a blip');

  env.clock.advance(8000);
  await flush();
  assert.strictEqual(env.Offline.isOffline(), true, 'three is an outage');

  const bar = first(env.root(), 'auc-off');
  assert.strictEqual(bar.hidden, false, 'and the banner is unmissable');
  assert.strictEqual(bar.dataset.mode, 'offline');
  assert.ok(bar.textContent.indexOf('OFFLINE — results are not yet saved.') !== -1,
    'the exact contracted text: ' + bar.textContent);
  assert.ok(/PAPER SHEET IS THE REAL RECORD/i.test(bar.textContent),
    'the paper backup must be named every time');
  assert.strictEqual(bar.getAttribute('aria-live'), 'assertive');
  assert.strictEqual(first(env.root(), 'auc-link').dataset.state, 'offline');
});

test('offline: the organiser can still record a sale, and it is queued WITHOUT a version', async () => {
  const env = await open();
  await callSerial(env, 27);

  env.ref.down = true;
  for (let i = 0; i < 3; i++) {
    env.clock.advance(Math.max.apply(null, pollDelays(env)));
    await flush();
  }
  assert.strictEqual(env.Offline.isOffline(), true);

  enterSale(env, 'TM_1', 75000).go.click();
  await flush();

  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.markSold').length, 0,
    'nothing goes to the network while offline');

  const queue = await env.Offline.listQueue('TRN_1');
  assert.strictEqual(queue.length, 1, 'the sale is on the laptop');
  assert.strictEqual(queue[0].action, 'auction.markSold');
  assert.strictEqual(queue[0].payload.playerId, 'PLY_27');
  assert.strictEqual(queue[0].payload.amount, 75000);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(queue[0].payload, 'expectedVersion'), false,
    'A VERSION CAPTURED OFFLINE IS ALWAYS STALE. It must not be queued at all.');

  assert.ok(/NOT saved on the server yet/i.test(first(env.root(), 'auc__result').textContent),
    'and the organiser is told it is not saved');
});

test('offline: on reconnect the replay attaches a FRESHLY FETCHED version, not the captured one', async () => {
  const env = await open({
    handlers: {
      'auction.markSold': () => ({
        data: { player: Object.assign(clone(CARD), { auction_status: 'SOLD' }), team: null, warnings: [], v: 100 }
      })
    }
  });
  await callSerial(env, 27);

  /* ---- go offline and record ---- */
  env.ref.down = true;
  for (let i = 0; i < 3; i++) {
    env.clock.advance(Math.max.apply(null, pollDelays(env)));
    await flush();
  }
  enterSale(env, 'TM_1', 75000).go.click();
  await flush();
  assert.strictEqual((await env.Offline.listQueue('TRN_1')).length, 1);

  /* ---- the network comes back, and the auction has MOVED ON ---- */
  env.ref.down = false;
  env.ref.snap.v = 99;
  env.clock.advance(Math.max.apply(null, pollDelays(env)));
  await flush();
  assert.strictEqual(env.Offline.isOffline(), false, 'one success brings us back');

  const bar = first(env.root(), 'auc-off');
  assert.strictEqual(bar.dataset.mode, 'pending');
  assert.ok(/Back online/.test(bar.textContent), bar.textContent);
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.markSold').length, 0,
    'it must NOT auto-sync — the organiser has to see the result of the replay');

  /* ---- and the version moves again before the organiser presses Save ---- */
  env.ref.snap.v = 123;

  byTag(bar, 'BUTTON').filter((b) => /^Save the/.test(b.textContent))[0].click();
  await flush(20);

  const sold = env.api.calls.filter((c) => c.action === 'auction.markSold');
  assert.strictEqual(sold.length, 1, 'the queued sale replayed');
  assert.strictEqual(sold[0].payload.expectedVersion, 123,
    'THE REPLAY MUST RE-READ THE VERSION. 123 is what the server holds now; the ' +
    'screen was holding 99 when Save was pressed and nothing at all was captured ' +
    'offline. Anything else and every queued sale fails with STALE_STATE.');

  // The re-read has to happen immediately before the send, not once per run.
  const idx = env.api.calls.indexOf(sold[0]);
  assert.strictEqual(env.api.calls[idx - 1].action, 'auction.state',
    'the version is read directly before the write it belongs to');
  assert.strictEqual(env.api.calls[idx - 1].payload.v, undefined,
    'and it is read with no v, so the server answers with the number it holds');

  assert.strictEqual((await env.Offline.listQueue('TRN_1')).length, 0, 'the queue is drained');
  assert.ok(/1 result saved on the server/.test(first(env.root(), 'auc__result').textContent),
    first(env.root(), 'auc__result').textContent);
});

test('offline: a rejected replay item is SHOWN with the server\'s message, never dropped', async () => {
  const env = await open({
    handlers: {
      'auction.markSold': () => ({
        error: {
          code: 'TEAM_FULL',
          message: 'Chennai Warriors already has all 12 players. There is no slot left for another buy.'
        }
      })
    }
  });
  await callSerial(env, 27);

  env.ref.down = true;
  for (let i = 0; i < 3; i++) {
    env.clock.advance(Math.max.apply(null, pollDelays(env)));
    await flush();
  }
  enterSale(env, 'TM_1', 75000).go.click();
  await flush();

  env.ref.down = false;
  env.clock.advance(Math.max.apply(null, pollDelays(env)));
  await flush();

  byTag(first(env.root(), 'auc-off'), 'BUTTON')
    .filter((b) => /^Save the/.test(b.textContent))[0].click();
  await flush(20);

  const kept = await env.Offline.listRejected('TRN_1');
  assert.strictEqual(kept.length, 1, 'it survives in storage, so a reload does not lose it');

  const panel = first(env.root(), 'auc-rej');
  assert.strictEqual(panel.hidden, false, 'and it is on screen');
  const row = first(panel, 'auc-rej__row');
  assert.ok(row, 'one row per refused item');
  assert.ok(/#27 Raj Kumar/.test(row.textContent),
    'named in words, not as an id: ' + row.textContent);
  assert.ok(/Chennai Warriors for ₹75,000/.test(row.textContent), row.textContent);
  assert.ok(/TEAM_FULL/.test(row.textContent), 'with the code');
  assert.ok(/already has all 12 players/.test(row.textContent),
    'and the server\'s exact message');
  assert.ok(/nothing has been forced through/i.test(panel.textContent),
    'and it says out loud that nothing was forced');

  assert.strictEqual((await env.Offline.listQueue('TRN_1')).length, 0,
    'it left the pending queue, so it will not replay on its own');
});

/* ---------------------------------------------------------------------- *
 * G. Keyboard
 * ---------------------------------------------------------------------- */

test('keyboard: S does NOT fire while typing in the amount box, but does elsewhere', async () => {
  const env = await open({
    handlers: { 'auction.markSold': () => ({ data: { player: clone(CARD), team: null, warnings: [], v: 3 } }) }
  });
  await callSerial(env, 27);
  const els = enterSale(env, 'TM_1', 75000);

  env.key('s', els.amount);
  await flush();
  assert.strictEqual(env.confirms.length, 0,
    'an S typed into the amount box must never open a sale confirm');

  env.key('u', els.amount);
  await flush();
  assert.strictEqual(env.confirms.length, 0, 'nor a U');

  const searchInput = byTag(first(env.root(), 'auc-find'), 'INPUT')[0];
  env.key('s', searchInput);
  await flush();
  assert.strictEqual(env.confirms.length, 0, 'nor an S typed into the search box');

  // The serial box is the deliberate exception: it only ever holds digits.
  const serialInput = byTag(first(env.root(), 'auc-call'), 'INPUT')[0];
  env.key('s', serialInput);
  await flush();
  assert.strictEqual(env.confirms.length, 1,
    'but S from the serial box, where focus rests, must sell');
});

test('keyboard: U marks unsold, and a digit anywhere goes to the serial box', async () => {
  const env = await open({
    handlers: { 'auction.markUnsold': () => ({ data: { player: clone(CARD), v: 3 } }) }
  });
  await callSerial(env, 27);

  env.key('u', env.body);
  await flush();
  assert.strictEqual(env.confirms.length, 1);
  assert.ok(/UNSOLD\?$/.test(env.confirms[0].title), env.confirms[0].title);
  assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.markUnsold').length, 1);

  const serialInput = byTag(first(env.root(), 'auc-call'), 'INPUT')[0];
  serialInput.value = '';
  env.key('4', env.body);
  env.key('2', env.body);
  assert.strictEqual(serialInput.value, '42',
    'a number called out in the room is typed without looking at the screen');
  assert.strictEqual(env.document.activeElement, serialInput);
});

test('keyboard: the shortcuts are printed on the page, not hidden in a modal', async () => {
  const env = await open();
  const keys = first(env.root(), 'auc-keys');
  assert.ok(keys, 'the legend exists');
  const text = keys.textContent;
  ['S', 'U', 'Esc', 'digits + Enter'].forEach((k) => {
    assert.ok(byClass(keys, 'auc-keys__key').some((n) => n.textContent === k),
      'the legend must show ' + k);
  });
  assert.ok(/never fire while you are typing an amount/i.test(text), text);
});

/* ---------------------------------------------------------------------- *
 * H. Team strip, banners, edge cases
 * ---------------------------------------------------------------------- */

test('team strip: purse remaining, count / max and per-slot are permanently on screen', async () => {
  const env = await open();
  const cells = byClass(env.root(), 'auc-team');
  assert.strictEqual(cells.length, 3);
  assert.strictEqual(first(cells[0], 'auc-team__name').textContent, 'Chennai Warriors');
  assert.strictEqual(first(cells[0], 'auc-team__purse').textContent, '₹5,50,000');
  assert.strictEqual(first(cells[0], 'auc-team__count').textContent, '8 / 12');
  assert.strictEqual(first(cells[0], 'auc-team__slot').textContent, '₹1,37,500 per slot');
});

test('team strip: a full squad is marked by a class AND the words "Squad full"', async () => {
  const env = await open();
  env.ref.snap.v = 3;
  env.ref.snap.teams[0].players_count = 12;
  env.ref.snap.teams[0].per_slot_remaining_display = 'Squad full';
  env.clock.advance(2000);
  await flush();

  const cell = byClass(env.root(), 'auc-team')[0];
  assert.ok(cell.classList.contains('auc-team--full'), 'a class for the shape');
  assert.strictEqual(first(cell, 'auc-team__slot').textContent, 'Squad full',
    'and the word, because colour is never the only signal');
});

test('banner: all_teams_full shows the exact advisory sentence from §4.6', async () => {
  const env = await open();
  env.ref.snap.v = 3;
  env.ref.snap.summary.all_teams_full = true;
  env.ref.snap.summary.teams_total = 8;
  env.ref.snap.summary.not_called = 298;
  env.clock.advance(2000);
  await flush();

  const banners = first(env.root(), 'auc__banners').textContent;
  assert.ok(banners.indexOf(
    'All 8 teams are full. 298 players were not called. You can close the auction.') !== -1,
  'the contracted wording, verbatim: ' + banners);
  assert.ok(/Advisory only/i.test(banners), 'and it must say it is advisory');
  assert.ok(/an admin closes it/i.test(banners), 'because the admin closes the auction, not this screen');
});

test('edge: an auction that is not live yet refuses to show the sell controls', async () => {
  const env = await open();
  env.ref.snap.v = 3;
  env.ref.snap.status = 'REG_CLOSED';
  env.clock.advance(2000);
  await flush();
  await callSerial(env, 27);

  assert.ok(/not live yet/i.test(first(env.root(), 'auc__banners').textContent));
  assert.strictEqual(first(env.root(), 'auc-sell__go'), null, 'no SOLD button at all');
});

test('edge: a closed auction says so and offers no controls (DESIGN §15 case 20)', async () => {
  const env = await open();
  env.ref.snap.v = 3;
  env.ref.snap.status = 'AUCTION_CLOSED';
  env.clock.advance(2000);
  await flush();
  await callSerial(env, 27);

  assert.ok(/auction is closed/i.test(first(env.root(), 'auc__banners').textContent));
  assert.strictEqual(first(env.root(), 'auc-sell__go'), null);
  assert.ok(/closed, so no result can be recorded/i.test(first(env.root(), 'auc-sell').textContent));
});

test('edge: no teams created is named as the blocker (DESIGN §15 case 21)', async () => {
  const env = await open();
  env.ref.snap.v = 3;
  env.ref.snap.teams = [];
  env.clock.advance(2000);
  await flush();
  await callSerial(env, 27);

  assert.ok(/No teams have been created/i.test(first(env.root(), 'auc__banners').textContent));
  assert.strictEqual(first(env.root(), 'auc-sell__go'), null,
    'there is nobody to sell to, so there is no button');
});

test('edge: no offline pack is flagged BEFORE the internet fails, not during it', async () => {
  const env = await open();
  await flush(6);
  const banners = first(env.root(), 'auc__banners').textContent;
  assert.ok(/Nothing is cached/i.test(banners),
    'finding out mid-outage is the failure this line prevents: ' + banners);
  assert.ok(/keep a paper list either way/i.test(banners));
  assert.ok(/advice, not a block/i.test(banners), 'advisory, never blocking');
});

/* ---------------------------------------------------------------------- *
 * H2. The offline pack — arming the safety net (CONTRACTS-PHASE4-7 §5.5.1)
 * ---------------------------------------------------------------------- */

/** player.list rows the real Offline.downloadPack will accept. */
const PACK_ROWS = [1, 2, 3].map((i) => ({
  player_id: 'PLY_' + i, serial_no: i, name: 'Player ' + i,
  role: 'BATSMAN', style: 'RIGHT', age_years: 20 + i,
  photo_thumb_url: 'https://drive.google.com/thumbnail?id=P' + i,
  payment_status: 'VERIFIED', is_withdrawn: false
}));

function packHandlers(extra) {
  return Object.assign({
    'player.list': () => ({
      data: { rows: PACK_ROWS, total: PACK_ROWS.length, page: 1, totalPages: 1 }
    })
  }, extra || {});
}

/** The Download button, wherever it sits in the pack panel. */
function packBtn(env) {
  return first(env.root(), 'auc-pack__go');
}

test('pack: the console has a Download offline pack control, and it is not buried', async () => {
  const env = await open({ handlers: packHandlers() });
  await flush(6);

  const panel = first(env.root(), 'auc-pack');
  assert.ok(panel, 'there is a pack panel');
  const bodyKids = first(env.root(), 'auc__body').childNodes;
  assert.strictEqual(bodyKids[0], panel,
    'it is the first thing in the body — a pack downloaded after the wifi died is useless');

  const btn = packBtn(env);
  assert.ok(btn, 'and a real button');
  assert.strictEqual(btn.textContent, 'Download offline pack');
  assert.strictEqual(panel.dataset.state, 'none', 'nothing is cached yet');
  assert.ok(/NO OFFLINE PACK/.test(first(panel, 'auc-pack__status').textContent));
  assert.strictEqual(first(panel, 'auc-pack__status').getAttribute('aria-live'), 'polite');
});

test('pack: pressing Download calls downloadPack ONCE and reports real progress', async () => {
  const env = await open({ handlers: packHandlers() });
  await flush(6);

  let calls = 0;
  const realDownload = env.Offline.downloadPack;
  const seenPhases = [];
  env.Offline.downloadPack = function (tid, onProgress, opts) {
    calls += 1;
    assert.strictEqual(tid, 'TRN_1', 'scoped to this tournament');
    return realDownload.call(env.Offline, tid, function (info) {
      seenPhases.push(info.phase);
      onProgress(info);
    }, opts);
  };

  packBtn(env).click();

  // Mid-flight: the button is busy and the bar is on screen.
  assert.strictEqual(packBtn(env).disabled, true, 'no second download');
  assert.strictEqual(packBtn(env).textContent, 'Downloading…');
  assert.strictEqual(first(env.root(), 'auc-pack').dataset.state, 'working');
  assert.ok(byTag(first(env.root(), 'auc-pack__progress'), 'PROGRESS').length === 1,
    'a real <progress> element, not a spinner — 100+ images is a long wait');

  packBtn(env).click();
  assert.strictEqual(calls, 1, 'a second press while it runs must do nothing');

  await flush(40);

  assert.strictEqual(calls, 1, 'downloadPack was called exactly once');
  assert.ok(seenPhases.indexOf('start') !== -1 && seenPhases.indexOf('players') !== -1 &&
    seenPhases.indexOf('done') !== -1,
  'progress arrived for every phase, saw ' + JSON.stringify(seenPhases));
  assert.ok(/Finished/.test(first(env.root(), 'auc-pack__phase').textContent),
    first(env.root(), 'auc-pack__phase').textContent);
  assert.strictEqual(packBtn(env).disabled, false, 'and the button comes back');

  const cached = await env.Offline.getPlayer('TRN_1', 2);
  assert.ok(cached && cached.name === 'Player 2', 'the pack really is on the laptop now');
});

test('pack: a text-only pack is reported PARTIAL, never ready, however offline.js scores it', async () => {
  const env = await open({ handlers: packHandlers() });
  await flush(6);

  packBtn(env).click();
  await flush(40);

  // Node has no IndexedDB, so offline.js takes its localStorage path and
  // caches no photographs at all. It scores that pack complete:true.
  const raw = await env.Offline.isPackReady('TRN_1');
  assert.strictEqual(raw.ready, true, 'offline.js itself says ready');
  assert.strictEqual(raw.imageCount, 0, 'with zero photographs');
  assert.strictEqual(raw.degraded, true);

  // The console must NOT repeat that to the organiser.
  const panel = first(env.root(), 'auc-pack');
  assert.strictEqual(panel.dataset.state, 'partial',
    'a pack with no photographs is PARTIAL on this screen, never ready');
  const status = first(panel, 'auc-pack__status').textContent;
  assert.ok(/PLAYER DETAILS ONLY/.test(status), status);
  assert.ok(/NO photographs/.test(status), status);
  assert.ok(/NOT a complete pack/.test(status), status);
  assert.ok(!/READY/.test(status), 'the word READY must not appear: ' + status);

  assert.ok(/incomplete/i.test(first(env.root(), 'auc__banners').textContent),
    'and the top-of-screen advisory still says so');
});

test('pack: a genuinely complete pack reads as READY with its counts and time', async () => {
  const env = await open({ handlers: packHandlers() });
  await flush(6);

  // What a browser with IndexedDB and a working image fetcher would produce.
  env.Offline.isPackReady = () => Promise.resolve({
    ready: true, exists: true, complete: true, degraded: false,
    playerCount: 400, imageCount: 400,
    expectedPlayers: 400, expectedImages: 400,
    downloadedAt: '2026-08-30T09:15:42.000Z', imageFailures: [], warnings: [],
    storage: 'idb'
  });
  env.page._loadPackStatus(env.page._state);
  await flush(6);

  const panel = first(env.root(), 'auc-pack');
  assert.strictEqual(panel.dataset.state, 'ready');
  assert.strictEqual(first(panel, 'auc-pack__status').textContent,
    'Offline pack READY — 400 players and 400 photographs, downloaded 2026-08-30 09:15 UTC.');
  assert.strictEqual(packBtn(env).textContent, 'Download the pack again');
  assert.ok(!/offline pack/i.test(first(env.root(), 'auc__banners').textContent),
    'and the advisory banner goes away');
});

test('pack: a half-finished pack reads as INCOMPLETE with both counts', async () => {
  const env = await open({ handlers: packHandlers() });
  await flush(6);

  env.Offline.isPackReady = () => Promise.resolve({
    ready: false, exists: true, complete: false, degraded: false,
    playerCount: 398, imageCount: 350,
    expectedPlayers: 400, expectedImages: 400,
    downloadedAt: '2026-08-30T09:15:00.000Z',
    imageFailures: [{}, {}], warnings: ['50 of 400 photographs could not be cached.'],
    storage: 'idb'
  });
  env.page._loadPackStatus(env.page._state);
  await flush(6);

  const panel = first(env.root(), 'auc-pack');
  assert.strictEqual(panel.dataset.state, 'partial');
  const status = first(panel, 'auc-pack__status').textContent;
  assert.ok(/INCOMPLETE/.test(status), status);
  assert.ok(/398 of 400 players/.test(status), status);
  assert.ok(/350 of 400 photographs/.test(status), status);
  assert.ok(/50 of 400 photographs could not be cached\./.test(panel.textContent),
    'offline.js\'s own warning is passed through: ' + panel.textContent);
});

test('pack: NO_IMAGE_FETCHER is named, not swallowed, and the next press asks for text only', async () => {
  const env = await open({ handlers: packHandlers() });
  await flush(6);

  // Before anything is pressed, the missing fetcher is already explained —
  // KNOWN-ISSUES.md 13/14 is a property of the deployment, not a surprise.
  assert.ok(/cannot read photograph bytes from Drive/i.test(
    first(env.root(), 'auc-pack__warnings').textContent),
  'the known gap is stated up front');

  let seenOpts = null;
  env.Offline.downloadPack = function (tid, onProgress, opts) {
    seenOpts = opts;
    const e = new Error('Cannot download photographs: no image fetcher is installed.');
    e.code = 'NO_IMAGE_FETCHER';
    return Promise.reject(e);
  };

  packBtn(env).click();
  await flush(20);

  const warnings = first(env.root(), 'auc-pack__warnings').textContent;
  assert.ok(/NO_IMAGE_FETCHER/.test(warnings), 'the code is shown: ' + warnings);
  assert.ok(/NOTHING was saved/.test(warnings),
    'and it says plainly that nothing was saved, rather than claiming success');
  assert.ok(/PLAYER DETAILS ONLY/.test(warnings), 'and what the next press will do');
  assert.notStrictEqual(first(env.root(), 'auc-pack').dataset.state, 'ready',
    'a failed download must never leave the panel reading ready');

  packBtn(env).click();
  await flush(20);
  assert.ok(seenOpts && seenOpts.imagesOptional === true,
    'the second press deliberately asks for a text-only pack, so the message was true');
});

test('pack: a storage fault names itself instead of failing silently', async () => {
  const env = await open({ handlers: packHandlers() });
  await flush(6);

  env.Offline.downloadPack = function () {
    const e = new Error('out of room');
    e.code = 'QUOTA_EXCEEDED';
    return Promise.reject(e);
  };
  packBtn(env).click();
  await flush(20);

  const warnings = first(env.root(), 'auc-pack__warnings').textContent;
  assert.ok(/QUOTA_EXCEEDED/.test(warnings), warnings);
  assert.ok(/out of storage/i.test(warnings), warnings);
  assert.ok(/Do not start the auction assuming the pack is there/i.test(warnings),
    'the consequence is spelled out: ' + warnings);
});

test('edge: no session token goes straight to sign-in without flashing an empty console', async () => {
  const env = boot({ handlers: {} });
  env.api.getToken = () => null;
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(env.navigations.length, 1);
  assert.strictEqual(env.navigations[0].to, '/admin/login');
  assert.strictEqual(env.api.calls.length, 0);
});

test('edge: UNAUTHORIZED mid-auction clears the token and redirects, once', async () => {
  const env = await open();
  env.ref.snap = clone(SNAP);
  env.api.handlers['auction.state'] = () => ({
    error: { code: 'UNAUTHORIZED', message: 'expired' }
  });
  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.cleared, true, 'the dead token is thrown away');
  assert.ok(env.navigations.some((n) => n.to === '/admin/login'));
});

test('edge: no tournament in the URL falls back to auth.me', async () => {
  const env = boot({
    handlers: {
      'auth.me': () => ({ data: { user_id: 'USR_1', role: 'ORGANISER', tournament_id: 'TRN_9' } }),
      'auction.state': () => ({ data: clone(SNAP) })
    }
  });
  env.page.render(env.ctx({ query: {} }));
  await flush();
  assert.strictEqual(env.api.calls[0].action, 'auth.me');
  assert.strictEqual(env.api.calls[1].action, 'auction.state');
  assert.strictEqual(env.api.calls[1].payload.tournamentId, 'TRN_9',
    'the session is the authoritative answer to "which tournament"');
});

/* ---------------------------------------------------------------------- *
 * I. Safety: hostile input, no markup, accessibility
 * ---------------------------------------------------------------------- */

test('xss: a hostile player name and team name render as literal text', async () => {
  const hostile = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
  const env = await open({
    handlers: {
      'auction.getBySerial': () => ({
        data: {
          player: Object.assign(clone(CARD), { name: hostile }),
          revealed: true, v: 2, message: ''
        }
      })
    }
  });
  env.ref.snap.teams[0].team_name = '<b>Boom</b>';
  env.ref.snap.v = 3;
  env.clock.advance(2000);
  await flush();
  await callSerial(env, 27);

  const name = first(env.root(), 'auc-card__name');
  assert.strictEqual(name.textContent, hostile, 'the name survives verbatim');
  assert.strictEqual(name.childNodes.length, 1);
  assert.strictEqual(name.childNodes[0].nodeType, 3,
    'ONE text node — any element child would mean markup was parsed');

  const tags = walk(env.root()).map((n) => n.tagName);
  assert.strictEqual(tags.indexOf('SCRIPT'), -1, 'no <script> was created');
  assert.strictEqual(tags.indexOf('B'), -1, 'no <b> was created from a team name');
  assert.strictEqual(first(env.root(), 'auc-team__name').textContent, '<b>Boom</b>');

  // And it stays literal all the way into the confirm dialog.
  enterSale(env, 'TM_1', 75000);
  assert.ok(first(env.root(), 'auc-sell__preview').textContent.indexOf(hostile) !== -1);
});

test('xss: a hostile photo URL is refused rather than put in an img src', async () => {
  const env = await open({
    handlers: {
      'auction.getBySerial': () => ({
        data: {
          player: Object.assign(clone(CARD), { photo_thumb_url: 'javascript:alert(1)' }),
          revealed: true, v: 2, message: ''
        }
      })
    }
  });
  await callSerial(env, 27);
  assert.strictEqual(byTag(first(env.root(), 'auc-card'), 'IMG').length, 0,
    'only http(s) may reach an img src');
  assert.strictEqual(first(env.root(), 'auc-card__photo-empty').textContent, '#27',
    'and the placeholder still names the player');
});

test('photo: View large photo asks Drive for the big variant, and Escape closes it', async () => {
  const env = await open();
  await callSerial(env, 27);

  byTag(first(env.root(), 'auc-card__actions'), 'BUTTON')
    .filter((b) => /View large photo/.test(b.textContent))[0].click();

  const zoom = first(env.body, 'auc-zoom');
  assert.ok(zoom, 'the overlay is mounted on the body');
  assert.strictEqual(byTag(zoom, 'IMG')[0].getAttribute('src'),
    'https://drive.google.com/thumbnail?id=X&sz=w1600',
    'sz=w320 becomes sz=w1600 — the big variant is only fetched when asked for');
  assert.strictEqual(zoom.getAttribute('aria-modal'), 'true');

  env.key('Escape', env.body);
  assert.strictEqual(first(env.body, 'auc-zoom'), null, 'Escape closes it');
});

test('source: no innerHTML, no eval, no raw fetch anywhere in the page', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML/.test(code), 'innerHTML must not appear outside comments');
  assert.ok(!/outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(code));
  assert.ok(!/(?<![.\w])fetch\s*\(/.test(code), 'every call goes through API');
  assert.ok(!/window\.confirm|window\.alert/.test(code),
    'a blocking dialog would stall the poll mid-auction');
});

test('accessibility: real labels, live regions and a focusable heading', async () => {
  const env = await open();
  await callSerial(env, 27);
  const root = env.root();

  // Every control built by UI.field carries a real for/id binding.
  const labels = byTag(root, 'LABEL').filter((l) => l.getAttribute('for'));
  assert.ok(labels.length >= 3, 'serial, search, team and amount all have real labels');
  labels.forEach((l) => {
    const id = l.getAttribute('for');
    assert.ok(walk(root).some((n) => n.id === id), 'label for="' + id + '" points at a real control');
  });

  assert.strictEqual(first(root, 'auc__result').getAttribute('aria-live'), 'polite',
    'the result is announced');
  assert.strictEqual(first(root, 'auc__errors').getAttribute('aria-live'), 'assertive');
  assert.strictEqual(first(root, 'auc-link').getAttribute('aria-live'), 'polite',
    'the connection state is announced');
  assert.strictEqual(first(root, 'auc-sell__preview').getAttribute('aria-live'), 'polite',
    'so is the consequence line, as the amount is typed');
  assert.strictEqual(first(root, 'auc-card__name').getAttribute('tabindex'), '-1',
    'focus can be handed to the player just called');

  const serialInput = byTag(first(root, 'auc-call'), 'INPUT')[0];
  assert.strictEqual(serialInput.getAttribute('inputmode'), 'numeric',
    'a phone or tablet must show the number pad');
});

test('css: scoped to this route, no web font, no CDN', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

  assert.ok(!/@font-face|@import|https?:\/\//.test(rules),
    'no web font, no import, no CDN — nothing that can fail on venue wifi');

  // Innermost declaration blocks only, so @media wrappers are skipped.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let count = 0;
  while ((m = re.exec(rules)) !== null) {
    const selector = m[1].trim();
    if (!selector || selector.charAt(0) === '@') continue;
    selector.split(',').map((s) => s.trim()).filter(Boolean).forEach((one) => {
      count += 1;
      assert.strictEqual(one.indexOf('body[data-route="organiser-auction"]'), 0,
        'unscoped selector would leak into other pages: ' + one);
    });
  }
  assert.ok(count > 30, 'the stylesheet is actually there, saw ' + count + ' selectors');

  // The status pill colours belong to app.css and must not be redefined.
  assert.ok(!/--status-[a-z]+-bg\s*:/.test(rules),
    'auction.css must REUSE the status tokens, never redeclare them');
});

/* ====================================================================== *
 * 5. MUTATION TESTS — break the code, prove the assertions notice
 * ====================================================================== */

const mutations = [
  {
    name: 'M1 remove the {same:true} guard -> the no-repaint test must fail',
    mutate: (s) => s.replace('    if (snap.same === true) {', '    if (false) {'),
    check: async (mutate) => {
      const env = await open({ mutate: mutate });
      env.ref.sameFrom = 2;
      for (let i = 0; i < 5; i++) { env.clock.advance(2000); await flush(); }
      assert.strictEqual(env.page._paints, 1);
    }
  },
  {
    name: 'M2 stop sending expectedVersion -> the expectedVersion test must fail',
    mutate: (s) => s.replace('    body.expectedVersion = state.v;', '    /* removed */'),
    check: async (mutate) => {
      const env = await open({
        mutate: mutate,
        handlers: { 'auction.markSold': () => ({ data: { player: clone(CARD), team: null, warnings: [], v: 3 } }) }
      });
      await callSerial(env, 27);
      enterSale(env, 'TM_1', 75000).go.click();
      await flush();
      assert.strictEqual(
        env.api.calls.filter((c) => c.action === 'auction.markSold')[0].payload.expectedVersion, 2);
    }
  },
  {
    name: 'M3 replay the CAPTURED version instead of a fresh one -> the offline replay test must fail',
    mutate: (s) => s.replace('      body.expectedVersion = v;',
      '      body.expectedVersion = (payload && payload.expectedVersion) || 1;'),
    check: async (mutate) => {
      const env = await open({
        mutate: mutate,
        handlers: {
          'auction.markSold': () => ({ data: { player: clone(CARD), team: null, warnings: [], v: 100 } })
        }
      });
      await callSerial(env, 27);
      env.ref.down = true;
      for (let i = 0; i < 3; i++) {
        env.clock.advance(Math.max.apply(null, pollDelays(env)));
        await flush();
      }
      enterSale(env, 'TM_1', 75000).go.click();
      await flush();

      env.ref.down = false;
      env.ref.snap.v = 99;
      env.clock.advance(Math.max.apply(null, pollDelays(env)));
      await flush();
      env.ref.snap.v = 123;

      byTag(first(env.root(), 'auc-off'), 'BUTTON')
        .filter((b) => /^Save the/.test(b.textContent))[0].click();
      await flush(20);

      const sold = env.api.calls.filter((c) => c.action === 'auction.markSold');
      assert.strictEqual(sold.length, 1);
      assert.strictEqual(sold[0].payload.expectedVersion, 123);
    }
  },
  {
    name: 'M4 remove the 15s back-off ceiling -> the back-off test must fail',
    mutate: (s) => s.replace(
      'state.delay = Math.min(state.delay * 2, OrganiserAuctionPage.MAX_POLL_MS);',
      'state.delay = state.delay * 2;'),
    check: async (mutate) => {
      const env = await open({ mutate: mutate });
      env.ref.down = true;
      const seen = [];
      for (let i = 0; i < 6; i++) {
        const armed = pollDelays(env);
        if (!armed.length) break;
        env.clock.advance(Math.max.apply(null, armed));
        await flush();
        seen.push(env.page._state.delay);
      }
      assert.deepStrictEqual(seen, [4000, 8000, 15000, 15000, 15000, 15000]);
    }
  },
  {
    name: 'M5 let shortcuts fire inside a text box -> the amount-box test must fail',
    mutate: (s) => s.replace(
      '    if (OrganiserAuctionPage._isTyping(state, ev.target)) return;',
      '    if (false) return;'),
    check: async (mutate) => {
      const env = await open({
        mutate: mutate,
        handlers: { 'auction.markSold': () => ({ data: { player: clone(CARD), team: null, warnings: [], v: 3 } }) }
      });
      await callSerial(env, 27);
      const els = enterSale(env, 'TM_1', 75000);
      env.key('s', els.amount);
      await flush();
      assert.strictEqual(env.confirms.length, 0);
    }
  },
  {
    name: 'M6 auto-retry on STALE_STATE -> the stale-state test must fail',
    mutate: (s) => s.replace(
      '        OrganiserAuctionPage._refreshNow(state);\n        return;',
      '        OrganiserAuctionPage._call(action, body).catch(function () {});\n        return;'),
    check: async (mutate) => {
      const env = await open({
        mutate: mutate,
        handlers: {
          'auction.markSold': () => ({ error: { code: 'STALE_STATE', message: 'moved on' } })
        }
      });
      await callSerial(env, 27);
      enterSale(env, 'TM_1', 75000).go.click();
      await flush(20);
      assert.strictEqual(env.api.calls.filter((c) => c.action === 'auction.markSold').length, 1);
    }
  },
  {
    name: 'M7 let a text-only pack read as ready -> the partial-pack test must fail',
    mutate: (s) => s.replace(
      "    if (info.degraded === true) return 'partial';\n" +
      "    if (Number(info.imageCount) <= 0) return 'partial';",
      '    /* removed */'),
    check: async (mutate) => {
      const env = await open({ mutate: mutate, handlers: packHandlers() });
      await flush(6);
      packBtn(env).click();
      await flush(40);

      const raw = await env.Offline.isPackReady('TRN_1');
      assert.strictEqual(raw.ready, true, 'offline.js itself says ready');
      assert.strictEqual(raw.imageCount, 0, 'with zero photographs');

      const panel = first(env.root(), 'auc-pack');
      assert.strictEqual(panel.dataset.state, 'partial',
        'a pack with no photographs is PARTIAL on this screen, never ready');
      assert.ok(!/READY/.test(first(panel, 'auc-pack__status').textContent),
        'the word READY must not appear');
    }
  },
  {
    name: 'M8 swallow a pack download failure -> the NO_IMAGE_FETCHER test must fail',
    // `false && {...}` evaluates to false, so packError is falsy and the
    // warnings never render — a real "swallow the error" mutation.
    //
    // The previous version spliced in `(0) ? {` and left a conditional with no
    // else branch, so the mutant did not parse. A SyntaxError makes the mutation
    // look detected while proving nothing about the assertion: any test at all
    // would have "caught" it. A mutation has to produce runnable code that is
    // merely wrong.
    mutate: (s) => s.replace(
      '      state.packError = {\n        code: code,',
      '      state.packError = false && {\n        code: code,'),
    check: async (mutate) => {
      const env = await open({ mutate: mutate, handlers: packHandlers() });
      await flush(6);
      env.Offline.downloadPack = function () {
        const e = new Error('no fetcher');
        e.code = 'NO_IMAGE_FETCHER';
        return Promise.reject(e);
      };
      packBtn(env).click();
      await flush(20);
      const warnings = first(env.root(), 'auc-pack__warnings').textContent;
      assert.ok(/NO_IMAGE_FETCHER/.test(warnings), 'the code is shown: ' + warnings);
      assert.ok(/NOTHING was saved/.test(warnings),
        'and it says plainly that nothing was saved');
    }
  }
];

/* ====================================================================== *
 * 6. Go
 * ====================================================================== */

(async function main() {
  console.log('organiser-auction.js — behaviour harness\n');
  let pass = 0;
  let fail = 0;

  for (const t of tests) {
    if (only && t.name.indexOf(only) === -1) continue;
    try {
      await t.fn();
      pass += 1;
      console.log('  ok   ' + t.name);
    } catch (err) {
      fail += 1;
      console.log('  FAIL ' + t.name);
      console.log('       ' + String(err && err.message).split('\n').join('\n       '));
    }
  }

  console.log('\n--- mutation tests (each SHOULD fail) ---');
  for (const m of mutations) {
    // A mutation that does not change the source at all is a broken test, not
    // a surviving mutant, so check that first.
    const mutated = m.mutate(SOURCE);
    if (mutated === SOURCE) {
      fail += 1;
      console.log('  FAIL ' + m.name + '  <-- the mutation matched nothing in the source');
      continue;
    }
    let caught = null;
    try {
      await m.check(m.mutate);
    } catch (err) {
      caught = err;
    }
    if (caught) {
      pass += 1;
      console.log('  ok   ' + m.name);
      console.log('       caught: ' + String(caught.message).split('\n')[0]);
    } else {
      fail += 1;
      console.log('  FAIL ' + m.name + '  <-- the mutant SURVIVED; the assertion is not real');
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}());
