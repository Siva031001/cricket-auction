/**
 * Verification harness for frontend/js/pages/admin-login.js and
 * frontend/js/pages/admin-tournament.js.
 *
 * Lives outside the repo on purpose: the project has no build step and no npm
 * runtime deps, so nothing test-shaped is allowed to ship in frontend/.
 *
 * Provides a tiny DOM plus stubs for API / UI / ImageTool / Router / App,
 * loads the two page files as-is, and asserts the behaviour the task calls
 * out. Run with:  node /tmp/admin-harness/run.js
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
  this.files = [];
  this.value = '';
  this.checked = false;
  this.disabled = false;
  this.className = '';
  this._focused = false;
}

Object.defineProperty(El.prototype, 'textContent', {
  get() {
    return this._own + this.children.map((c) => c.textContent).join('');
  },
  set(v) {
    this.children = [];
    this._own = String(v);
  }
});

El.prototype.appendChild = function (node) {
  if (!node) throw new Error('appendChild(null) on <' + this.tagName + '>');
  // Once a child exists, own text is a prefix; keep it, that matches the DOM.
  this.children.push(node);
  node.parentNode = this;
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
El.prototype.dispatch = function (type, ev) {
  (this._listeners[type] || []).forEach((fn) => fn(ev || { preventDefault() {} }));
};
El.prototype.click = function () {
  if (this.disabled) return;
  if (typeof this._onClick === 'function') this._onClick();
  this.dispatch('click');
};
El.prototype.focus = function () { this._focused = true; global.document.activeElement = this; };
El.prototype.select = function () { this._selected = true; };
El.prototype.scrollIntoView = function () {};
El.prototype.querySelectorAll = function (sel) {
  const want = sel.toUpperCase();
  const out = [];
  (function walk(node) {
    node.children.forEach((c) => {
      if (c.nodeType !== 1) return;
      if (c.tagName === want) out.push(c);
      walk(c);
    });
  })(this);
  return out;
};

/** Depth-first list of every element node. */
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

function byTag(root, tag) {
  return all(root).filter((e) => e.tagName === tag.toUpperCase());
}

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

const log = {
  navigations: [],
  apiCalls: [],
  confirms: [],
  progress: []
};

global.CONFIG = { BASE_PATH: '/cricket-auction', TOKEN_KEY: 'ca.session.token' };

global.App = { root: new El('div'), intendedPath: null };

global.Router = {
  href: (p) => '/cricket-auction' + p,
  navigate: (to, opts) => { log.navigations.push({ to, opts: opts || {} }); }
};

/** Queued responses: { 'action': [Promise-producing fn, ...] } */
const responses = {};
function respond(action, fn) {
  (responses[action] = responses[action] || []).push(fn);
}

global.API = {
  _token: null,
  setToken(t) { API._token = t; },
  getToken() { return API._token; },
  clearToken() { API._token = null; },
  call(action, payload, opts) {
    log.apiCalls.push({ action, payload, opts });
    const queue = responses[action];
    if (!queue || !queue.length) {
      return Promise.reject({ code: 'INTERNAL_ERROR', message: 'harness: no stub for ' + action });
    }
    return queue.shift()(payload);
  }
};

/* The REAL js/ui.js is loaded below (see section 3) rather than stubbed, so
   these tests exercise the actual UI.field / UI.button / UI.money semantics
   the page depends on. Only UI.confirmDialog stays stubbed: it builds a modal
   with focus trapping, which is its own agent's business to test.

   ImageTool is stubbed because the real one needs <canvas> and
   createImageBitmap, which a fake DOM cannot provide. */

global.ImageTool = {
  fromFile(file, opts) {
    const o = opts || {};
    const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
    return Promise.resolve({
      data: 'QkFTRTY0',
      // Mirrors the real rule: a PNG stays a PNG only when keepPng is set.
      mime: (isPng && o.keepPng) ? 'image/png' : 'image/jpeg',
      filename: file.name,
      width: 1024,
      height: 768,
      bytes: 12345
    });
  },
  pair(file) { return Promise.resolve({ photo: null, photoThumb: null }); },
  previewUrl(file) { return 'blob:preview/' + file.name; }
};

/* ==================================================================== *
 * 3. Load the two page files exactly as the browser would
 * ==================================================================== */

function load(relPath, globalName) {
  const src = fs.readFileSync(path.join(FRONTEND, relPath), 'utf8');
  // `const X = {...}` is function-scoped inside new Function, so re-export it.
  new Function(src + '\n;globalThis.' + globalName + ' = ' + globalName + ';')();
}

load('js/ui.js', 'UI');
load('js/pages/admin-login.js', 'AdminLoginPage');
load('js/pages/admin-tournament.js', 'AdminTournamentPage');

// Keep only the modal stubbed; everything else in UI is the real thing.
UI._answer = true;
UI.confirmDialog = function (cfg) {
  log.confirms.push(cfg);
  return Promise.resolve(UI._answer);
};

// Record progress calls without replacing the real widget.
const realProgress = UI.progress;
UI.progress = function (label) {
  const p = realProgress.call(UI, label);
  const set = p.set;
  const done = p.done;
  p.set = function (pct) { log.progress.push(pct); return set.call(p, pct); };
  p.done = function (msg) { log.progress.push('done'); return done.call(p, msg); };
  return p;
};

/* ==================================================================== *
 * 4. Test harness
 * ==================================================================== */

let passed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { passed += 1; return; }
  failures.push(msg);
  console.log('  FAIL  ' + msg);
}

function eq(actual, expected, msg) {
  ok(actual === expected, msg + '  (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')');
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush(n) { for (let i = 0; i < (n || 6); i += 1) await tick(); }

function reset() {
  log.navigations.length = 0;
  log.apiCalls.length = 0;
  log.confirms.length = 0;
  log.progress.length = 0;
  Object.keys(responses).forEach((k) => delete responses[k]);
  API._token = null;
  UI._answer = true;
  App.root = new El('div');
  App.intendedPath = null;
  document.body = new El('body');
}

function textOf(root) { return root.textContent; }

function findButton(root, label) {
  return byTag(root, 'button').find((b) => b.textContent === label) || null;
}

/**
 * The visible error on a UI.field handle, with the screen-reader-only
 * "Error: " prefix stripped. null when the field has no error.
 */
function fieldError(handle) {
  const span = byClass(handle.wrap, 'field__error')[0];
  if (!span || span.hidden) return null;
  return span.textContent.replace(/^Error:\s*/, '');
}

/* ==================================================================== *
 * 5. Tests
 * ==================================================================== */

async function testLoginSuccess() {
  console.log('\n[1] login success stores a token and navigates');
  reset();

  respond('auth.login', (payload) => {
    eq(payload.email, 'admin@example.com', 'email sent');
    eq(payload.password, 'hunter2hunter2', 'password sent');
    eq(payload.ua, 'HarnessAgent/1.0', 'user agent sent in the body (Apps Script has no headers)');
    return Promise.resolve({
      token: 'TOK123',
      expiresAt: '2026-08-31T00:00:00.000Z',
      user: { user_id: 'USR_1', display_name: 'Admin', role: 'ADMIN', tournament_id: '' }
    });
  });

  AdminLoginPage.render({ path: '/admin/login', params: {}, query: {}, pattern: '/admin/login' });

  eq(document.body.dataset.route, 'admin-login', 'body data-route set');

  const state = AdminLoginPage._state;
  state.email.input.value = 'admin@example.com';
  state.password.input.value = 'hunter2hunter2';

  const btn = findButton(App.root, 'Sign in');
  ok(!!btn, 'sign in button rendered');
  btn.click();

  eq(state.submit.disabled, true, 'submit disabled while in flight');
  eq(state.submit.textContent, 'Signing in…', 'submit shows progress while in flight');

  // A second press while in flight must not fire a second login attempt —
  // that would burn two of the five allowed failures on one typo.
  btn.click();

  await flush();

  eq(log.apiCalls.filter((c) => c.action === 'auth.login').length, 1,
    'exactly one auth.login even after a double press');
  eq(API.getToken(), 'TOK123', 'token stored via API.setToken');
  eq(log.navigations.length, 1, 'navigated once');
  eq(log.navigations[0].to, '/admin/dashboard', 'navigated to the dashboard');
  eq(log.navigations[0].opts.replace, true, 'replaced the history entry, so Back does not re-show the form');
}

async function testLoginFailure() {
  console.log('\n[2] login failure shows the server message unchanged');
  reset();

  const SERVER_MSG = 'Email or password is incorrect.';
  respond('auth.login', () => Promise.reject({ code: 'UNAUTHORIZED', message: SERVER_MSG }));

  AdminLoginPage.render({ path: '/admin/login', params: {}, query: {}, pattern: '/admin/login' });
  const state = AdminLoginPage._state;
  state.email.input.value = 'nobody@example.com';
  state.password.input.value = 'wrongpassword';
  findButton(App.root, 'Sign in').click();
  await flush();

  const banner = byClass(App.root, 'banner--error')[0];
  ok(!!banner, 'an error banner is shown');
  // UI.banner prefixes a decorative glyph and a screen-reader-only "Error: ".
  // The server's own words must arrive whole and unedited after that.
  ok(banner.textContent.endsWith(SERVER_MSG),
    'server message shown verbatim, not reworded  (got ' + JSON.stringify(banner.textContent) + ')');
  ok(!/no such|unknown|wrong password|not registered/i.test(banner.textContent),
    'the form never hints whether the email exists');
  eq(state.errorRegion.getAttribute('aria-live'), 'assertive', 'errors live in an aria-live region');
  eq(state.submit.disabled, false, 're-enabled after failure');
  eq(state.password.input.value, '', 'password cleared');
  eq(state.email.input.value, 'nobody@example.com', 'email kept, so a retry is one field not two');
  eq(log.navigations.length, 0, 'no navigation on failure');

  // The 15-minute lockout arrives on the same code and must also pass through.
  reset();
  const LOCK_MSG = 'Too many failed sign-in attempts. This account is locked for 15 minutes. Please try again later.';
  respond('auth.login', () => Promise.reject({ code: 'UNAUTHORIZED', message: LOCK_MSG }));
  AdminLoginPage.render({ path: '/admin/login', params: {}, query: {}, pattern: '/admin/login' });
  AdminLoginPage._state.email.input.value = 'admin@example.com';
  AdminLoginPage._state.password.input.value = 'x';
  findButton(App.root, 'Sign in').click();
  await flush();
  ok(byClass(App.root, 'banner--error')[0].textContent.endsWith(LOCK_MSG),
    'lockout message surfaced plainly');
}

async function testIntendedPath() {
  console.log('\n[3b] a deep link survives the detour through sign-in');

  // App.requireAdmin parks the wanted path here before bouncing to login.
  const cases = [
    ['/admin/dashboard?view=create', '/admin/dashboard?view=create', 'a real deep link is honoured'],
    [null, '/admin/dashboard', 'no parked path falls back to the dashboard'],
    ['//evil.example.com/x', '/admin/dashboard', 'a protocol-relative URL is refused'],
    ['https://evil.example.com', '/admin/dashboard', 'an absolute off-site URL is refused'],
    ['/admin/login', '/admin/dashboard', 'never bounces straight back to the login form']
  ];

  for (const [parked, expected, msg] of cases) {
    reset();
    App.intendedPath = parked;
    respond('auth.login', () => Promise.resolve({ token: 'T', user: { role: 'ADMIN' } }));
    AdminLoginPage.render({ path: '/admin/login', params: {}, query: {}, pattern: '/admin/login' });
    AdminLoginPage._state.email.input.value = 'a@b.com';
    AdminLoginPage._state.password.input.value = 'pw';
    findButton(App.root, 'Sign in').click();
    await flush();
    eq(log.navigations[0].to, expected, msg);
    eq(App.intendedPath, null, 'the parked path is consumed once');
  }
}

async function testAlreadySignedIn() {
  console.log('\n[3] an existing valid token skips the form');
  reset();
  API.setToken('LIVE');
  respond('auth.me', () => Promise.resolve({ user_id: 'USR_1', role: 'ADMIN', tournament_id: '' }));

  AdminLoginPage.render({ path: '/admin/login', params: {}, query: {}, pattern: '/admin/login' });
  await flush();
  eq(log.navigations.length, 1, 'redirected');
  eq(log.navigations[0].to, '/admin/dashboard', 'straight to the dashboard');

  // ... and a dead token falls back to the form instead of a dead end.
  reset();
  API.setToken('STALE');
  respond('auth.me', () => Promise.reject({ code: 'UNAUTHORIZED', message: 'Session expired.' }));
  AdminLoginPage.render({ path: '/admin/login', params: {}, query: {}, pattern: '/admin/login' });
  await flush();
  eq(log.navigations.length, 0, 'no redirect on a dead token');
  eq(API.getToken(), null, 'dead token cleared');
  ok(!!findButton(App.root, 'Sign in'), 'the form is shown instead');
}

const ROWS = [
  {
    tournament_id: 'TRN_a1', slug: 'chennai-premier-league',
    name: 'Chennai Premier League', status: 'REG_OPEN',
    reg_start: '2026-08-01', reg_end: '2026-08-31',
    reg_start_display: '1 Aug 2026', reg_end_display: '31 Aug 2026',
    reg_fee: 500, player_count: 42, verified_count: 30,
    created_at: '2026-07-01T00:00:00.000Z'
  },
  {
    // Deliberately nasty: an untrusted name straight out of a sheet.
    tournament_id: 'TRN_b2', slug: 'evil',
    name: '<img src=x onerror=alert(1)>', status: 'DRAFT',
    reg_start: '2026-09-01', reg_end: '2026-09-10',
    reg_fee: 0, player_count: 0, verified_count: 0,
    created_at: '2026-07-02T00:00:00.000Z'
  }
];

async function testListRenders() {
  console.log('\n[4] the list renders one row per tournament');
  reset();
  API.setToken('TOK');
  respond('tournament.list', () => Promise.resolve(ROWS));

  AdminTournamentPage.render({ path: '/admin/dashboard', params: {}, query: {}, pattern: '/admin/dashboard' });
  eq(document.body.dataset.route, 'admin-dashboard', 'body data-route set');
  await flush();

  const tables = byTag(App.root, 'TABLE');
  eq(tables.length, 1, 'exactly one real <table>');

  const headers = byTag(tables[0], 'TH').filter((th) => th.scope === 'col');
  eq(headers.length, 7, 'seven column headers, each a real <th scope=col>');
  eq(headers.map((h) => h.textContent).join('|'),
    'Tournament|Status|Registration window|Fee|Registered|Verified|Actions',
    'header wording');

  const bodyRows = byTag(byTag(tables[0], 'TBODY')[0], 'TR');
  eq(bodyRows.length, 2, 'one row per tournament');

  const first = bodyRows[0].textContent;
  ok(first.indexOf('Chennai Premier League') !== -1, 'name rendered');
  ok(first.indexOf('Registration open') !== -1, 'status word rendered, not just a colour');
  ok(first.indexOf('1 Aug 2026 – 31 Aug 2026') !== -1,
    'uses the server *_display dates, not a browser reformat');
  ok(first.indexOf('₹500') !== -1, 'fee formatted through UI.money');
  ok(first.indexOf('42') !== -1 && first.indexOf('30') !== -1, 'registered and verified counts');

  // Rows with no *_display fall back to the raw server date, still unparsed.
  ok(bodyRows[1].textContent.indexOf('2026-09-01 – 2026-09-10') !== -1,
    'falls back to the raw date rather than reformatting it');

  // XSS: the hostile name must exist only as text.
  const evilRow = bodyRows[1];
  ok(evilRow.textContent.indexOf('<img src=x onerror=alert(1)>') !== -1,
    'hostile name kept as literal text');
  eq(byTag(evilRow, 'IMG').length, 0, 'no element was created from the hostile name');

  // Per-row actions.
  ok(!!byTag(evilRow, 'A').find((a) => a.textContent === 'Edit'), 'Edit action present');
  ok(!!findButton(bodyRows[0], 'Copy registration link'), 'Copy registration link present');

  // Phase 1 boundary: the later phases are named, not built.
  const later = byClass(App.root, 'later')[0];
  ok(!!later, 'placeholder panel for the later phases');
  ok(later.textContent.indexOf('Payment verification') !== -1, 'payment verification named as later');
  ok(later.textContent.indexOf('Phase 4') !== -1, 'auction named as later');
  eq(byTag(App.root, 'A').filter((a) => /verify/i.test(a.textContent)).length, 0,
    'no half-built payment screen');
}

async function testStatusTransitions() {
  console.log('\n[5] status controls offer only legal transitions');

  // The table straight from CONTRACTS-PHASE1.md §2.
  const legal = {
    DRAFT: ['REG_OPEN'],
    REG_OPEN: ['REG_CLOSED', 'AUCTION_LIVE'],
    REG_CLOSED: ['REG_OPEN', 'AUCTION_LIVE'],
    AUCTION_LIVE: ['AUCTION_CLOSED'],
    AUCTION_CLOSED: ['AUCTION_LIVE']
  };

  Object.keys(legal).forEach((from) => {
    eq(AdminTournamentPage.nextStatuses(from).join(','), legal[from].join(','),
      from + ' offers exactly ' + legal[from].join(' + '));
  });

  eq(AdminTournamentPage.nextStatuses('NOT_A_STATUS').length, 0,
    'an unknown status offers nothing rather than guessing');
  eq(AdminTournamentPage.nextStatuses('').length, 0, 'a blank status offers nothing');

  // Illegal moves are absent from every state's list.
  const illegal = [
    ['DRAFT', 'AUCTION_LIVE'], ['DRAFT', 'REG_CLOSED'], ['DRAFT', 'AUCTION_CLOSED'],
    ['REG_OPEN', 'DRAFT'], ['REG_OPEN', 'AUCTION_CLOSED'],
    ['REG_CLOSED', 'DRAFT'], ['REG_CLOSED', 'AUCTION_CLOSED'],
    ['AUCTION_LIVE', 'REG_OPEN'], ['AUCTION_LIVE', 'REG_CLOSED'], ['AUCTION_LIVE', 'DRAFT'],
    ['AUCTION_CLOSED', 'REG_OPEN'], ['AUCTION_CLOSED', 'REG_CLOSED'], ['AUCTION_CLOSED', 'DRAFT']
  ];
  illegal.forEach((pair) => {
    ok(AdminTournamentPage.nextStatuses(pair[0]).indexOf(pair[1]) === -1,
      pair[0] + ' -> ' + pair[1] + ' is not offered');
  });

  // ... and the rendered buttons match the table.
  reset();
  API.setToken('TOK');
  respond('tournament.list', () => Promise.resolve([
    Object.assign({}, ROWS[0], { status: 'AUCTION_LIVE' })
  ]));
  AdminTournamentPage.render({ path: '/admin/dashboard', params: {}, query: {}, pattern: '/admin/dashboard' });
  await flush();

  const controls = byClass(App.root, 'admin-table__status-controls')[0];
  const labels = byTag(controls, 'BUTTON').map((b) => b.textContent);
  eq(labels.join(','), 'Close auction', 'AUCTION_LIVE shows only "Close auction"');

  // Closing the auction must ask first.
  respond('tournament.setStatus', (p) => {
    eq(p.tournamentId, 'TRN_a1', 'setStatus carries the tournament id');
    eq(p.status, 'AUCTION_CLOSED', 'setStatus carries the target state');
    return Promise.resolve({ status: 'AUCTION_CLOSED' });
  });
  respond('tournament.list', () => Promise.resolve([
    Object.assign({}, ROWS[0], { status: 'AUCTION_CLOSED' })
  ]));

  findButton(controls, 'Close auction').click();
  await flush();
  eq(log.confirms.length, 1, 'closing the auction asks for confirmation');
  ok(/close the auction/i.test(log.confirms[0].title), 'confirm dialog names the action');
  ok(log.confirms[0].body.indexOf('Chennai Premier League') !== -1,
    'confirm dialog names the tournament');
  eq(log.apiCalls.filter((c) => c.action === 'tournament.setStatus').length, 1,
    'setStatus called once after confirming');

  // Reopening a closed auction also asks, and a "no" makes no call.
  const after = byClass(App.root, 'admin-table__status-controls')[0];
  eq(byTag(after, 'BUTTON').map((b) => b.textContent).join(','), 'Reopen auction',
    'AUCTION_CLOSED shows only "Reopen auction"');

  UI._answer = false;
  log.confirms.length = 0;
  findButton(after, 'Reopen auction').click();
  await flush();
  eq(log.confirms.length, 1, 'reopening a closed auction asks for confirmation');
  eq(log.apiCalls.filter((c) => c.action === 'tournament.setStatus').length, 1,
    'declining the confirm makes no further setStatus call');

  // Starting the auction while registration is open is legal but warned about.
  reset();
  API.setToken('TOK');
  respond('tournament.list', () => Promise.resolve([ROWS[0]]));  // REG_OPEN
  AdminTournamentPage.render({ path: '/admin/dashboard', params: {}, query: {}, pattern: '/admin/dashboard' });
  await flush();
  const openControls = byClass(App.root, 'admin-table__status-controls')[0];
  eq(byTag(openControls, 'BUTTON').map((b) => b.textContent).join(','),
    'Close registration,Start auction', 'REG_OPEN shows both legal moves');

  UI._answer = false;
  findButton(openControls, 'Start auction').click();
  await flush();
  eq(log.confirms.length, 1, 'starting the auction with registration open warns first');
  ok(/still open/i.test(log.confirms[0].body), 'the warning says registration is still open');

  // A one-click move needs no dialog.
  log.confirms.length = 0;
  UI._answer = true;
  respond('tournament.setStatus', () => Promise.resolve({}));
  respond('tournament.list', () => Promise.resolve([ROWS[0]]));
  findButton(openControls, 'Close registration').click();
  await flush();
  eq(log.confirms.length, 0, 'closing registration is a plain one-click action');
  eq(log.apiCalls.filter((c) => c.action === 'tournament.setStatus').length, 1,
    'closing registration called setStatus');
}

/** Put the page into a state where _buildForm can be driven directly. */
function formState() {
  AdminTournamentPage._gen += 1;
  AdminTournamentPage._state = {
    gen: AdminTournamentPage._gen,
    busy: false,
    objectUrls: [],
    errors: new El('div')
  };
  return AdminTournamentPage._state;
}

const GOOD = {
  name: 'Chennai Premier League',
  description: 'Season 3',
  rules: 'No chucking.',
  startDate: '2026-09-05',
  endDate: '2026-09-07',
  regStart: '2026-08-01',
  regEnd: '2026-08-31',
  regFee: '500',
  upiId: 'cpl@okhdfcbank',
  contactName: 'Raja',
  contactMobile: '9876543210',
  contactEmail: 'raja@example.com',
  defaultPurse: '500000',
  defaultMaxPlayers: '13'
};

function fill(form, values) {
  Object.keys(values).forEach((k) => { form.fields[k].handle.input.value = values[k]; });
}

async function testCreatePayload() {
  console.log('\n[6] the create form builds the contract payload');
  reset();
  API.setToken('TOK');
  formState();

  let captured = null;
  const form = AdminTournamentPage._buildForm('create', null, (payload) => {
    captured = payload;
    return Promise.resolve({});
  });

  fill(form, GOOD);

  // Attach a QR file so the PNG rule is exercised.
  const qrPicker = form.pickers.find((p) => p.key === 'qr');
  qrPicker.input.files = [{ name: 'upi-qr.png', type: 'image/png' }];

  form.run();
  eq(AdminTournamentPage._state.busy, true, 'submit locked while in flight');
  form.run();   // a double press must not build a second payload
  await flush();

  ok(!!captured, 'the payload reached the submit callback');

  const expectedKeys = [
    'name', 'description', 'rules', 'startDate', 'endDate', 'regStart', 'regEnd',
    'regFee', 'upiId', 'contactName', 'contactMobile', 'contactEmail',
    'defaultPurse', 'defaultMaxPlayers', 'logo', 'qr', 'gallery'
  ].sort();
  eq(Object.keys(captured).sort().join(','), expectedKeys.join(','),
    'exactly the keys CONTRACTS-PHASE1 §2 lists');

  eq(captured.name, GOOD.name, 'name');
  eq(captured.regStart, '2026-08-01', 'regStart is a bare IST calendar day');
  eq(captured.regEnd, '2026-08-31', 'regEnd is a bare IST calendar day');

  eq(typeof captured.regFee, 'number', 'regFee is a number, not a string');
  eq(captured.regFee, 500, 'regFee value');
  eq(Number.isInteger(captured.regFee), true, 'regFee is an integer — whole rupees only');
  eq(captured.defaultPurse, 500000, 'defaultPurse');
  eq(captured.defaultMaxPlayers, 13, 'defaultMaxPlayers');

  eq(captured.logo, null, 'no logo chosen sends null');
  eq(Array.isArray(captured.gallery), true, 'gallery is an array');
  eq(captured.gallery.length, 0, 'empty gallery');

  ok(!!captured.qr, 'qr image present');
  eq(Object.keys(captured.qr).sort().join(','), 'data,filename,mime',
    'an image is exactly {data, mime, filename} — no width/height/bytes leak through');
  eq(captured.qr.mime, 'image/png', 'the QR stayed PNG (keepPng), so it stays scannable');
  eq(AdminTournamentPage.QR_IMAGE_OPTS.keepPng, true, 'QR options declare keepPng');

  ok(log.progress.length > 0, 'upload progress was reported');
}

async function testCreateValidation() {
  console.log('\n[7] the create form refuses bad input before calling the server');
  reset();
  API.setToken('TOK');
  formState();

  let called = 0;
  const form = AdminTournamentPage._buildForm('create', null, () => { called += 1; return Promise.resolve({}); });

  fill(form, Object.assign({}, GOOD, {
    name: 'ab',                 // under 3
    regStart: '2026-09-01',     // after regEnd
    regEnd: '2026-08-31',
    endDate: '2026-09-01',      // before startDate
    regFee: '500.50',           // decimals are not whole rupees
    upiId: 'not-a-upi-id',
    contactMobile: '12345',
    defaultPurse: '0'           // must be > 0
  }));

  form.run();
  await flush();

  eq(called, 0, 'no server call with invalid input');
  ok(!!fieldError(form.fields.name.handle), 'name length flagged');
  ok(!!fieldError(form.fields.regEnd.handle), 'registration window order flagged');
  ok(!!fieldError(form.fields.endDate.handle), 'play date order flagged');
  ok(/whole number of rupees/.test(fieldError(form.fields.regFee.handle) || ''), 'decimal fee flagged');
  ok(!!fieldError(form.fields.upiId.handle), 'UPI id shape flagged');
  ok(!!fieldError(form.fields.contactMobile.handle), 'mobile flagged');
  ok(!!fieldError(form.fields.defaultPurse.handle), 'purse must be at least 1');
  eq(AdminTournamentPage._state.busy, false, 'form re-enabled after a validation stop');

  // A missing required field is caught too.
  formState();
  let called2 = 0;
  const form2 = AdminTournamentPage._buildForm('create', null, () => { called2 += 1; return Promise.resolve({}); });
  fill(form2, Object.assign({}, GOOD, { name: '' }));
  form2.run();
  await flush();
  eq(called2, 0, 'a blank required field stops the submit');
  ok(/required/i.test(fieldError(form2.fields.name.handle) || ''), 'blank name says it is required');
}

async function testEditDiff() {
  console.log('\n[8] edit pre-fills and sends only what changed');
  reset();
  API.setToken('TOK');
  formState();

  const row = {
    tournament_id: 'TRN_a1',
    name: 'Chennai Premier League',
    description: 'Season 3',
    rules: 'No chucking.',
    start_date: '2026-09-05',
    end_date: '2026-09-07',
    // A full instant rather than a bare date, which the sheet can return.
    reg_start: '2026-08-01T00:00:00.000Z',
    reg_end: '2026-08-31',
    reg_fee: 500,
    upi_id: 'cpl@okhdfcbank',
    contact_name: 'Raja',
    contact_mobile: '9876543210',
    contact_email: 'raja@example.com',
    default_purse: 500000,
    default_max_players: 13,
    status: 'REG_OPEN',
    display_token: 'DTOK'
  };

  let captured = null;
  const form = AdminTournamentPage._buildForm('edit', row, (payload) => {
    captured = payload;
    return Promise.resolve({});
  });

  eq(form.fields.name.handle.input.value, 'Chennai Premier League', 'name pre-filled');
  eq(form.fields.regStart.handle.input.value, '2026-08-01',
    'a full instant is sliced to YYYY-MM-DD for <input type=date>, never re-parsed');
  eq(form.fields.regFee.handle.input.value, '500', 'fee pre-filled as a plain integer');
  eq(form.fields.defaultMaxPlayers.handle.input.value, '13', 'squad size pre-filled');

  // Change exactly two fields.
  form.fields.regFee.handle.input.value = '750';
  form.fields.contactMobile.handle.input.value = '9000000001';

  form.run();
  await flush();

  ok(!!captured, 'the payload reached the submit callback');
  eq(Object.keys(captured).sort().join(','), 'contactMobile,regFee',
    'only the two changed fields are sent');
  eq(captured.regFee, 750, 'changed fee sent as a number');
  ok(!('logo' in captured), 'no image key when no image was chosen');
  ok(!('name' in captured), 'unchanged name is not resent');

  // Nothing changed at all -> a clear message, no pointless audit row.
  formState();
  let called = 0;
  const form2 = AdminTournamentPage._buildForm('edit', row, () => { called += 1; return Promise.resolve({}); });
  form2.run();
  await flush();
  eq(called, 0, 'an unchanged form makes no update call');

  // The remove flags are the only way to clear an image.
  formState();
  let captured3 = null;
  const form3 = AdminTournamentPage._buildForm('edit', row, (p) => { captured3 = p; return Promise.resolve({}); });
  form3.fields.name.handle.input.value = 'Renamed League';
  const logoPicker = form3.pickers.find((p) => p.key === 'logo');
  eq(logoPicker.removeKey, 'removeLogo', 'edit mode exposes removeLogo');
  logoPicker.isRemoveChecked = () => true;
  form3.run();
  await flush();
  eq(captured3.removeLogo, true, 'removeLogo:true is what clears an image');
}

async function testUnauthorizedHelper() {
  console.log('\n[9] one shared helper handles an expired session');
  reset();
  API.setToken('EXPIRED');

  ['tournament.list', 'tournament.get', 'tournament.setStatus', 'tournament.create', 'tournament.update']
    .forEach((action) => {
      respond(action, () => Promise.reject({ code: 'UNAUTHORIZED', message: 'Session expired.' }));
    });

  for (const action of ['tournament.list', 'tournament.get', 'tournament.setStatus',
    'tournament.create', 'tournament.update']) {
    log.navigations.length = 0;
    API.setToken('EXPIRED');
    let sentinel = null;
    await AdminTournamentPage._call(action, {}).catch((e) => { sentinel = e; });
    eq(sentinel, AdminTournamentPage.REDIRECTED, action + ': rejects with the handled sentinel');
    eq(API.getToken(), null, action + ': token cleared');
    eq(log.navigations[0] && log.navigations[0].to, '/admin/login', action + ': sent to sign-in');
  }

  // A non-auth error is passed through untouched for the caller to display.
  reset();
  API.setToken('TOK');
  respond('tournament.list', () => Promise.reject({ code: 'VALIDATION_FAILED', message: 'Nope.' }));
  let err = null;
  await AdminTournamentPage._call('tournament.list', {}).catch((e) => { err = e; });
  eq(err.code, 'VALIDATION_FAILED', 'other errors are not swallowed');
  eq(API.getToken(), 'TOK', 'other errors do not sign the admin out');
  eq(log.navigations.length, 0, 'other errors do not navigate');

  // No token at all: straight to sign-in, no empty dashboard flash.
  reset();
  AdminTournamentPage.render({ path: '/admin/dashboard', params: {}, query: {}, pattern: '/admin/dashboard' });
  eq(log.navigations[0].to, '/admin/login', 'render with no token redirects to sign-in');
  eq(log.apiCalls.length, 0, 'and makes no call');
}

async function testCreatedLinks() {
  console.log('\n[10] after creating, the links are front and centre');
  reset();
  API.setToken('TOK');

  respond('tournament.create', () => Promise.resolve({
    tournament_id: 'TRN_new1',
    slug: 'new-league',
    status: 'DRAFT',
    registrationUrl: 'https://example.github.io/cricket-auction/register/TRN_new1',
    displayUrl: 'https://example.github.io/cricket-auction/auction/TRN_new1/display?k=DTOK'
  }));

  AdminTournamentPage.render({
    path: '/admin/dashboard', params: {},
    query: { view: 'create' }, pattern: '/admin/dashboard'
  });

  const form = byClass(App.root, 'admin-form')[0];
  ok(!!form, 'the create view renders a form');

  // Drive the real rendered form, not the internal handle.
  const state = AdminTournamentPage._state;
  // Fill through the DOM the page actually built.
  const inputs = {};
  all(App.root).forEach((e) => { if (e.name) inputs[e.name] = e; });
  Object.keys(GOOD).forEach((k) => { if (inputs[k]) inputs[k].value = GOOD[k]; });

  findButton(App.root, 'Create tournament').click();
  await flush(10);

  const box = byClass(App.root, 'linkbox')[0];
  ok(!!box, 'a link box is shown after creating');
  ok(box.textContent.indexOf('Registration link') !== -1, 'registration link labelled');
  ok(box.textContent.indexOf('Projector display link') !== -1, 'projector link shown too');

  const urlInputs = byClass(box, 'linkbox__url');
  eq(urlInputs.length, 2, 'both URLs are in selectable boxes');
  eq(urlInputs[0].value, 'https://example.github.io/cricket-auction/register/TRN_new1',
    'the server registration URL is used verbatim');
  ok(/[?&]k=DTOK/.test(urlInputs[1].value), 'the projector link carries the display token');
  eq(byTag(box, 'BUTTON').filter((b) => b.textContent === 'Copy link').length, 2,
    'each link has a Copy button');

  // The locally built fallback matches BASE_PATH.
  eq(AdminTournamentPage._registrationUrl('TRN_x'),
    'https://example.github.io/cricket-auction/register/TRN_x',
    'the local fallback registration URL includes BASE_PATH');
  eq(AdminTournamentPage._displayUrl('TRN_x', 'k1'),
    'https://example.github.io/cricket-auction/auction/TRN_x/display?k=k1',
    'the local fallback projector URL carries the key');
}

async function testNoInnerHtml() {
  console.log('\n[11] no innerHTML anywhere in the two page files');
  ['js/pages/admin-login.js', 'js/pages/admin-tournament.js'].forEach((rel) => {
    const src = fs.readFileSync(path.join(FRONTEND, rel), 'utf8');
    ok(src.indexOf('innerHTML') === -1, rel + ' never mentions innerHTML');
    ok(src.indexOf('outerHTML') === -1, rel + ' never mentions outerHTML');
    ok(src.indexOf('insertAdjacentHTML') === -1, rel + ' never uses insertAdjacentHTML');
    ok(!/\bfetch\s*\(/.test(src), rel + ' never calls fetch directly');
    ok(!/\bXMLHttpRequest\b/.test(src), rel + ' never uses XMLHttpRequest');
  });
}

/* ==================================================================== *
 * 6. Run
 * ==================================================================== */

(async function main() {
  await testLoginSuccess();
  await testLoginFailure();
  await testIntendedPath();
  await testAlreadySignedIn();
  await testListRenders();
  await testStatusTransitions();
  await testCreatePayload();
  await testCreateValidation();
  await testEditDiff();
  await testUnauthorizedHelper();
  await testCreatedLinks();
  await testNoInnerHtml();

  console.log('\n=====================================');
  console.log('passed: ' + passed + '   failed: ' + failures.length);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('ALL GREEN');
})();
