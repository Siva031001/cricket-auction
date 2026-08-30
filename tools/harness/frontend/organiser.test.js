/**
 * Verification harness for the Phase 3 organiser screens:
 *
 *   frontend/js/pages/organiser-join.js
 *   frontend/js/pages/organiser-dashboard.js
 *   frontend/js/pages/admin-organisers.js
 *
 * Lives outside the repo on purpose: the project has no build step and no npm
 * runtime deps, so nothing test-shaped may ship in frontend/. Same approach as
 * /tmp/players-harness/run.js and /tmp/admin-harness/run.js: a tiny DOM, the
 * REAL frontend/js/ui.js, stubs for API / Router / App / CONFIG, then
 * assertions.
 *
 * Run:  node /tmp/organiser-harness/run.js
 *       node /tmp/organiser-harness/run.js --mutate=1   (expects a FAILURE)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = '/Users/raja.t/cricket-auction/frontend';

/* ==================================================================== *
 * 0. Mutations — proof that the assertions are load-bearing
 * ==================================================================== */

const MUTATIONS = {
  1: {
    file: 'js/pages/organiser-join.js',
    from: '    if (a !== b) {',
    to: '    if (false) {',
    what: 'stop blocking a mismatched password pair client-side',
    expect: 'mismatch'
  },
  2: {
    file: 'js/pages/organiser-dashboard.js',
    from: '    if (ratio < OrganiserDashboardPage.LOW_SLOT_RATIO) {',
    to: '    if (false) {',
    what: 'stop marking a low ₹-per-empty-slot',
    expect: 'Low'
  },
  3: {
    file: 'js/pages/organiser-dashboard.js',
    from: '      const payload = { tournamentId: state.tournamentId, names: names };',
    to: '      const payload = { tournamentId: state.tournamentId, names: names.slice(0, 1) };',
    what: 'send only the first name in a batch',
    expect: 'names'
  }
};

const mutateArg = process.argv.find((a) => a.indexOf('--mutate=') === 0);
const MUTATION = mutateArg ? MUTATIONS[mutateArg.split('=')[1]] : null;
if (mutateArg && !MUTATION) throw new Error('unknown mutation ' + mutateArg);

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
  this.readOnly = false;
  this.open = false;
  this.className = '';
  this.parentNode = null;
}

Object.defineProperty(El.prototype, 'textContent', {
  get() { return this._own + this.children.map((c) => c.textContent).join(''); },
  set(v) { this.children = []; this._own = String(v); }
});

El.prototype.appendChild = function (node) {
  if (!node) throw new Error('appendChild(null) on <' + this.tagName + '>');
  if (this._own) { this.children.unshift(new TextNode(this._own)); this._own = ''; }
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
El.prototype.insertBefore = function (node, ref) {
  const i = this.children.indexOf(ref);
  if (i < 0) return this.appendChild(node);
  this.children.splice(i, 0, node);
  node.parentNode = this;
  return node;
};
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
  (this._listeners[type] || []).slice().forEach((fn) => fn(ev || {
    preventDefault() {}, stopPropagation() {}
  }));
};
El.prototype.click = function () {
  if (this.disabled) return;
  this.dispatch('click', { preventDefault() {}, stopPropagation() {} });
};
El.prototype.submit = function () {
  this.dispatch('submit', { preventDefault() {}, stopPropagation() {} });
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

const clipboard = { last: null, writeText(t) { clipboard.last = t; return Promise.resolve(); } };

global.window = {
  location: { origin: 'https://example.github.io', pathname: '/', search: '' },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  navigator: { userAgent: 'HarnessAgent/1.0', clipboard: clipboard },
  URL: { revokeObjectURL() {} },
  localStorage: (() => {
    const m = {};
    return {
      _map: m,
      getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: (k) => { delete m[k]; },
      clear: () => { Object.keys(m).forEach((k) => delete m[k]); }
    };
  })()
};

/* ==================================================================== *
 * 2. Stubs for the modules other agents own
 * ==================================================================== */

const log = { navigations: [], apiCalls: [], confirms: [] };

global.CONFIG = { BASE_PATH: '/cricket-auction', TOKEN_KEY: 'ca.session.token' };

const APP_HELPERS = {
  TOURNAMENT_PARAM: 't',
  currentTournamentId(ctx) {
    const q = (ctx && ctx.query) || {};
    return q.t ? String(q.t) : '';
  },
  adminPath(p, id) { return id ? p + '?t=' + encodeURIComponent(id) : p; },
  rememberedTournamentId() { return ''; },
  signOut() { log.navigations.push({ to: '/admin/login', opts: { replace: true }, via: 'App.signOut' }); }
};

global.App = Object.assign({ root: new El('div') }, APP_HELPERS);

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
 * 3. Load the real ui.js and the three pages under test
 * ==================================================================== */

function load(relPath, globalName) {
  let src = fs.readFileSync(path.join(FRONTEND, relPath), 'utf8');

  if (MUTATION && MUTATION.file === relPath) {
    if (src.indexOf(MUTATION.from) === -1) {
      throw new Error('mutation target not found in ' + relPath + ': ' + MUTATION.from);
    }
    src = src.replace(MUTATION.from, MUTATION.to);
  }

  new Function(src + '\n;globalThis.' + globalName + ' = ' + globalName + ';')();
}

load('js/ui.js', 'UI');
load('js/pages/organiser-join.js', 'OrganiserJoinPage');
load('js/pages/organiser-dashboard.js', 'OrganiserDashboardPage');
load('js/pages/admin-organisers.js', 'AdminOrganisersPage');

// Only the modal is stubbed; every other UI.* used by the pages is the real one.
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
  ok(actual === expected, msg + '  (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')');
}
function has(hay, needle, msg) {
  ok(String(hay).indexOf(needle) !== -1, msg + '  (missing "' + needle + '" in: ' +
    JSON.stringify(String(hay).slice(0, 400)) + ')');
}
function lacks(hay, needle, msg) {
  ok(String(hay).indexOf(needle) === -1, msg + '  (unexpectedly found "' + needle + '")');
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush(n) { for (let i = 0; i < (n || 10); i += 1) await tick(); }

function reset() {
  log.navigations.length = 0;
  log.apiCalls.length = 0;
  log.confirms.length = 0;
  Object.keys(responses).forEach((k) => delete responses[k]);
  API._token = 'TOK';
  UI._answer = true;
  clipboard.last = null;
  window.localStorage.clear();
  App.root = new El('div');
  Object.assign(App, APP_HELPERS);
  document.body = new El('body');
  document.activeElement = null;
  OrganiserDashboardPage._flash = '';
}

function callsTo(action) { return log.apiCalls.filter((c) => c.action === action); }
function lastCall(action) { const c = callsTo(action); return c[c.length - 1]; }
function findButton(root, label) {
  return byTag(root, 'BUTTON').find((b) => b.textContent.indexOf(label) !== -1) || null;
}
function findLink(root, label) {
  return byTag(root, 'A').find((a) => a.textContent.indexOf(label) !== -1) || null;
}
function inputNamed(root, name) {
  return all(root).find((e) => (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') &&
    e.name === name) || null;
}

/* ==================================================================== *
 * 5. Fixtures
 * ==================================================================== */

const HOSTILE = '<img src=x onerror="alert(1)">Bobby </td><script>drop()</script>';

function team(over) {
  return Object.assign({
    team_id: 'TEAM_1',
    team_name: 'Chennai Warriors',
    owner_name: 'Ravi',
    logo_url: '',
    purse_total: 500000,
    purse_used: 100000,
    purse_remaining: 400000,
    purse_total_display: '₹5,00,000',
    purse_used_display: '₹1,00,000',
    purse_remaining_display: '₹4,00,000',
    players_count: 3,
    max_players: 13,
    slots_remaining: 10,
    per_slot_remaining: 40000,
    per_slot_remaining_display: '₹40,000'
  }, over || {});
}

function listResponse(teams) {
  const rows = teams || [team()];
  return {
    teams: rows,
    totals: {
      teams: rows.length,
      purse_total: 4000000,
      purse_used: 800000,
      purse_remaining: 3200000,
      players_count: 24,
      slots_total: 104,
      slots_remaining: 80
    }
  };
}

function organiser(over) {
  return Object.assign({
    user_id: 'USR_1',
    email: 'ravi@example.com',
    display_name: 'Ravi Kumar',
    status: 'ACTIVE',
    created_at: '2026-08-01T06:30:00.000Z',
    created_at_display: '1 Aug 2026, 12:00',
    last_login_at: '',
    joinPending: true
  }, over || {});
}

function joinCtx(k) {
  return { path: '/organiser/join', params: {}, query: (k === undefined ? {} : { k: k }), pattern: '/organiser/join' };
}
function dashCtx(query) {
  return {
    path: '/organiser/dashboard', params: {},
    query: Object.assign({ t: 'TRN_1' }, query || {}),
    pattern: '/organiser/dashboard'
  };
}
function adminCtx(query) {
  return {
    path: '/admin/organisers', params: {},
    query: Object.assign({ t: 'TRN_1' }, query || {}),
    pattern: '/admin/organisers'
  };
}

async function renderDashboard(data, query) {
  always('team.list', () => data);
  OrganiserDashboardPage.render(dashCtx(query));
  await flush();
}

/* ==================================================================== *
 * 6. Tests — the join screen
 * ==================================================================== */

async function testJoinHappyPath() {
  console.log('\n[1] join sends the token and the password, then stores the session');
  reset();

  OrganiserJoinPage.render(joinCtx('JOIN_TOKEN_ABC'));
  await flush();

  eq(document.body.dataset.route, 'organiser-join', 'body data-route is organiser-join');

  // The rule is on screen BEFORE anything is typed.
  has(App.root.textContent, 'At least 10 characters',
    'the password rule is printed before the boxes, not after a failure');

  const p1 = inputNamed(App.root, 'password');
  const p2 = inputNamed(App.root, 'password2');
  ok(!!p1 && !!p2, 'two password boxes are rendered');
  eq(p1.type, 'password', 'the first box is a password input');
  eq(p2.type, 'password', 'the second box is a password input');
  eq(p1.getAttribute('autocomplete'), 'new-password', 'autocomplete asks for a new password');

  respond('auth.organiserJoin', () => ({
    token: 'SESSION_XYZ',
    expiresAt: '2026-08-31T06:30:00.000Z',
    user: { user_id: 'USR_1', display_name: 'Ravi Kumar', role: 'ORGANISER', tournament_id: 'TRN_9' }
  }));

  p1.value = 'correcthorse10';
  p2.value = 'correcthorse10';
  findButton(App.root, 'Set password and continue').click();
  await flush();

  const call = lastCall('auth.organiserJoin');
  ok(!!call, 'auth.organiserJoin was called');
  eq(call.payload.token, 'JOIN_TOKEN_ABC', 'the token from ?k= is sent');
  eq(call.payload.password, 'correcthorse10', 'the password is sent');
  eq(call.opts && call.opts.token, null, 'no session token rides along on the public join call');

  eq(API._token, 'SESSION_XYZ', 'the returned session token is stored via API.setToken');
  eq(window.localStorage.getItem('ca.organiser.tournament'), 'TRN_9',
    "the organiser's tournament is remembered for the dashboard");

  const nav = log.navigations[log.navigations.length - 1];
  eq(nav.to, '/organiser/dashboard', 'it navigates to the dashboard');
  eq(nav.opts.replace, true, 'and replaces the join URL so Back cannot reuse it');
}

async function testJoinMismatchBlockedLocally() {
  console.log('\n[2] a mismatched password pair never reaches the network');
  reset();

  OrganiserJoinPage.render(joinCtx('JOIN_TOKEN_ABC'));
  await flush();

  inputNamed(App.root, 'password').value = 'correcthorse10';
  inputNamed(App.root, 'password2').value = 'correcthorse11';
  findButton(App.root, 'Set password and continue').click();
  await flush();

  eq(callsTo('auth.organiserJoin').length, 0, 'no request was sent for a mismatch');
  has(App.root.textContent, 'The two passwords do not match',
    'the mismatch is explained on screen');
  eq(log.navigations.length, 0, 'and nothing navigated away');

  // Too short is also caught locally, with the actual length named.
  reset();
  OrganiserJoinPage.render(joinCtx('JOIN_TOKEN_ABC'));
  await flush();
  inputNamed(App.root, 'password').value = 'short';
  inputNamed(App.root, 'password2').value = 'short';
  findButton(App.root, 'Set password and continue').click();
  await flush();
  eq(callsTo('auth.organiserJoin').length, 0, 'a 5-character password is not sent either');
  has(App.root.textContent, 'at least 10 characters. This one has 5.',
    'the message names how short it actually is');
}

async function testJoinDeadLink() {
  console.log('\n[3] a used or expired link shows the server message AND the next step');
  reset();

  const GENERIC = 'This link is not valid. It may have been used already or it may have expired.';
  respond('auth.organiserJoin', () => { throw { code: 'UNAUTHORIZED', message: GENERIC }; });

  OrganiserJoinPage.render(joinCtx('DEAD_TOKEN'));
  await flush();
  inputNamed(App.root, 'password').value = 'correcthorse10';
  inputNamed(App.root, 'password2').value = 'correcthorse10';
  findButton(App.root, 'Set password and continue').click();
  await flush();

  const text = App.root.textContent;
  has(text, GENERIC, "the server's one generic message is shown unchanged");
  has(text, 'Ask the tournament admin to send you a new link.',
    'and the next step is spelled out');
  has(text, 'A join link works once', 'the "used once" rule is explained');
  has(text, '72 hours', 'the 72-hour expiry is explained');
  eq(log.navigations.length, 0, 'it does NOT bounce them to a sign-in form they cannot use');
  ok(!!findLink(App.root, 'Go to sign in'),
    'a sign-in link is offered for someone who already has a password');
}

async function testJoinNoTokenAtAll() {
  console.log('\n[4] no ?k= at all is called out as an incomplete link');
  reset();

  OrganiserJoinPage.render(joinCtx());
  await flush();

  has(App.root.textContent, 'This link is incomplete', 'the page says the link is incomplete');
  has(App.root.textContent, 'Ask the tournament admin to send you a new link.',
    'with the same next step');
  eq(callsTo('auth.organiserJoin').length, 0, 'nothing is sent without a token');
}

/* ==================================================================== *
 * 7. Tests — the team dashboard
 * ==================================================================== */

async function testBatchCreationIsOneCall() {
  console.log('\n[5] eight team names go out in ONE team.createBatch call');
  reset();
  await renderDashboard(listResponse([]));

  eq(document.body.dataset.route, 'organiser-dashboard', 'body data-route is organiser-dashboard');

  const names = ['Chennai Warriors', 'Delhi Kings', 'Mumbai Tigers', 'Kolkata Lions',
    'Pune Panthers', 'Jaipur Royals', 'Kochi Sharks', 'Indore Eagles'];
  names.forEach((n, i) => {
    const box = inputNamed(App.root, 'team-' + (i + 1));
    ok(!!box, 'name box ' + (i + 1) + ' exists');
    if (box) box.value = n;
  });
  ok(!inputNamed(App.root, 'team-9'), 'exactly eight boxes by default, matching the 8 teams');

  respond('team.createBatch', (payload) => ({
    created: payload.names.map((n, i) => ({ team_id: 'T' + i, team_name: n }))
  }));
  always('team.list', () => listResponse());

  inputNamed(App.root, 'purseTotal').value = '500000';
  inputNamed(App.root, 'maxPlayers').value = '13';
  findButton(App.root, 'Create teams').click();
  await flush(14);

  const batch = callsTo('team.createBatch');
  eq(batch.length, 1, 'exactly one request for all eight teams');
  eq(callsTo('team.create').length, 0, 'the slow one-at-a-time path was not used');
  eq(batch[0].payload.names.length, 8, 'all eight names are in that one request');
  eq(JSON.stringify(batch[0].payload.names), JSON.stringify(names), 'in the order they were typed');
  eq(batch[0].payload.purseTotal, 500000, 'the shared purse is a number, not a string');
  eq(batch[0].payload.maxPlayers, 13, 'the shared squad size is a number');
  eq(batch[0].payload.tournamentId, 'TRN_1', 'scoped to the tournament in the URL');
  has(App.root.textContent, '8 teams created', 'the result is confirmed on screen');
}

async function testBatchRejectsDuplicatesLocally() {
  console.log('\n[6] a duplicate name in the batch is caught before anything is written');
  reset();
  await renderDashboard(listResponse([]));

  inputNamed(App.root, 'team-1').value = 'Chennai Warriors';
  inputNamed(App.root, 'team-2').value = '  chennai   warriors ';
  findButton(App.root, 'Create teams').click();
  await flush();

  eq(callsTo('team.createBatch').length, 0, 'nothing was sent');
  has(App.root.textContent, 'Two teams cannot share the name',
    'the duplicate is named on screen');
}

async function testBatchRowsAddAndRemove() {
  console.log('\n[6b] name rows can be added and removed, and renumber themselves');
  reset();
  await renderDashboard(listResponse([]));

  findButton(App.root, 'Add another team').click();
  ok(!!inputNamed(App.root, 'team-9'), 'a ninth box appears');
  has(App.root.textContent, '9 name boxes', 'the count is announced');

  // Remove the first row; the remaining labels renumber from 1.
  const removeButtons = byClass(App.root, 'org-batch__remove');
  eq(removeButtons.length, 9, 'every row has its own Remove');
  removeButtons[0].click();
  has(App.root.textContent, '8 name boxes', 'the count drops');

  const labels = byClass(App.root, 'field__label')
    .map((l) => l.textContent).filter((t) => /^Team [0-9]+$/.test(t));
  eq(labels[0], 'Team 1', 'the labels renumber, so "Team 1" is never missing');
  eq(labels[labels.length - 1], 'Team 8', 'and run to the new last row');

  // The batch still sends exactly one call with the surviving names.
  inputNamed(App.root, 'team-2').value = 'Only Team';
  respond('team.createBatch', () => ({ created: [{ team_id: 'T1', team_name: 'Only Team' }] }));
  findButton(App.root, 'Create teams').click();
  await flush(14);
  eq(callsTo('team.createBatch').length, 1, 'still one request');
  eq(JSON.stringify(lastCall('team.createBatch').payload.names), '["Only Team"]',
    'and empty boxes are simply ignored');
}

async function testPerSlotRemaining() {
  console.log('\n[7] ₹ per empty slot renders, and is marked when it drops low');
  reset();

  await renderDashboard(listResponse([
    team({ team_id: 'A', team_name: 'Healthy', per_slot_remaining: 40000,
      per_slot_remaining_display: '₹40,000' }),
    team({ team_id: 'B', team_name: 'Squeezed', purse_total: 500000, max_players: 13,
      purse_used: 400000, purse_remaining: 100000, players_count: 6, slots_remaining: 7,
      per_slot_remaining: 14285, per_slot_remaining_display: '₹14,285' }),
    team({ team_id: 'C', team_name: 'Desperate', purse_total: 500000, max_players: 13,
      purse_used: 480000, purse_remaining: 20000, players_count: 5, slots_remaining: 8,
      per_slot_remaining: 2500, per_slot_remaining_display: '₹2,500' }),
    team({ team_id: 'D', team_name: 'Complete', players_count: 13, slots_remaining: 0,
      per_slot_remaining: null, per_slot_remaining_display: null })
  ]));

  const headers = byTag(byTag(App.root, 'THEAD')[0], 'TH').map((th) => th.textContent);
  has(headers.join('|'), '₹ per empty slot', 'the column is labelled in plain words');
  eq(byTag(byTag(App.root, 'THEAD')[0], 'TH').filter((th) => th.scope === 'col').length,
    headers.length, 'every header cell is th scope="col"');

  const cells = byClass(App.root, 'org-teams__slot');
  eq(cells.length, 4, 'one per-slot cell per team');

  has(cells[0].textContent, '₹40,000', "the server's formatted figure is shown");
  has(cells[0].className, 'org-teams__slot--ok', 'a comfortable team is not flagged');
  lacks(cells[0].textContent, 'Low', 'and carries no warning word');

  has(cells[1].textContent, '₹14,285', 'the squeezed team shows its figure');
  has(cells[1].className, 'org-teams__slot--low', 'the squeezed team is flagged low');
  has(cells[1].textContent, 'Low', 'the flag is a WORD, not only a colour');

  has(cells[2].className, 'org-teams__slot--critical', 'the desperate team is flagged critical');
  has(cells[2].textContent, 'Very low', 'with its own word');

  has(cells[3].textContent, 'Squad full', 'a null per-slot value reads as "Squad full"');
  has(cells[3].className, 'org-teams__slot--full', 'and is not dressed up as a warning');

  // Totals across all teams are on screen too.
  has(App.root.textContent, 'Purse total', 'totals across all teams are shown');
  has(App.root.textContent, '₹40,00,000', 'the totals use Indian digit grouping');
}

async function testUpdateErrorsAreVerbatim() {
  console.log('\n[8] SQUAD_BELOW_COUNT and PURSE_BELOW_SPENT are shown word for word');
  reset();
  await renderDashboard(listResponse([team()]));

  const editBtn = findButton(App.root, 'Edit');
  ok(!!editBtn, 'each team row offers Edit');
  const editRow = byClass(App.root, 'org-teams__editrow')[0];
  eq(editRow.hidden, true, 'the edit form starts closed');
  editBtn.click();
  eq(editRow.hidden, false, 'clicking Edit opens it');

  const SQUAD_MSG = 'Chennai Warriors already has 3 players. You cannot set the limit to 2.';
  respond('team.update', () => { throw { code: 'SQUAD_BELOW_COUNT', message: SQUAD_MSG }; });

  inputNamed(App.root, 'maxPlayers').value = '2';
  findButton(App.root, 'Save changes').click();
  await flush();

  const call = lastCall('team.update');
  eq(call.payload.maxPlayers, 2, 'only the changed field is sent, as a number');
  eq(call.payload.teamId, 'TEAM_1', 'with the team id');
  ok(call.payload.purseTotal === undefined, 'an unchanged purse is not sent');
  has(App.root.textContent, SQUAD_MSG, 'the server message is printed exactly as it came');
  ok(!!findButton(App.root, 'Save changes'),
    'the control stays available so the organiser can correct it');

  // And the purse guard, on the same form.
  const PURSE_MSG = 'Chennai Warriors has already spent ₹1,00,000. The purse cannot be set below that.';
  respond('team.update', () => { throw { code: 'PURSE_BELOW_SPENT', message: PURSE_MSG }; });
  inputNamed(App.root, 'maxPlayers').value = '13';
  inputNamed(App.root, 'purseTotal').value = '50000';
  findButton(App.root, 'Save changes').click();
  await flush();

  eq(lastCall('team.update').payload.purseTotal, 50000, 'the lowered purse is sent');
  has(App.root.textContent, PURSE_MSG, 'PURSE_BELOW_SPENT is printed exactly as it came');
}

async function testDeleteNotEmpty() {
  console.log('\n[9] TEAM_NOT_EMPTY is surfaced plainly, after a named confirmation');
  reset();
  await renderDashboard(listResponse([team({ players_count: 3 })]));

  const NOT_EMPTY = 'Chennai Warriors has 3 players. Release them before deleting the team.';
  respond('team.delete', () => { throw { code: 'TEAM_NOT_EMPTY', message: NOT_EMPTY }; });

  findButton(App.root, 'Delete').click();
  await flush();

  has(log.confirms[0].title, 'Chennai Warriors', 'the confirmation names the team');
  eq(lastCall('team.delete').payload.teamId, 'TEAM_1', 'the delete carries the team id');
  has(App.root.textContent, NOT_EMPTY, 'the refusal is printed as it came');
}

async function testSquadView() {
  console.log('\n[10] the squad view lists players, amounts and totals');
  reset();

  always('team.squad', () => ({
    team: { team_id: 'TEAM_1', team_name: 'Chennai Warriors', max_players: 13,
      purse_remaining: 400000, purse_remaining_display: '₹4,00,000' },
    players: [
      { serial_no: 27, name: 'Raj Kumar', role: 'BATSMAN', style: 'RIGHT',
        sold_amount: 75000, sold_amount_display: '₹75,000', sold_at_display: '2 Sep, 19:04' }
    ],
    total_players: 1,
    total_spent: 75000,
    total_spent_display: '₹75,000',
    purse_remaining_display: '₹4,00,000'
  }));

  OrganiserDashboardPage.render(dashCtx({ view: 'squad', team: 'TEAM_1' }));
  await flush();

  const call = lastCall('team.squad');
  eq(call.payload.teamId, 'TEAM_1', 'team.squad is called with the team id');
  const text = App.root.textContent;
  has(text, 'Raj Kumar', 'the player is listed');
  has(text, '₹75,000', 'with the amount they went for');
  has(text, '₹4,00,000', 'and the purse left');
  ok(!!findLink(App.root, 'Back to teams'), 'there is a way back');
  lacks(text, 'do not match the players listed below',
    'no drift warning when the counters agree');

  // counters_stale is the server telling us its cached totals have drifted.
  reset();
  always('team.squad', () => ({
    team: { team_id: 'TEAM_1', team_name: 'Chennai Warriors' },
    players: [{ serial_no: 1, name: 'A Player', sold_amount: 1000, sold_amount_display: '₹1,000' }],
    total_players: 4, total_spent: 9000, total_spent_display: '₹9,000',
    purse_remaining_display: '₹1,000', counters_stale: true
  }));
  OrganiserDashboardPage.render(dashCtx({ view: 'squad', team: 'TEAM_1' }));
  await flush();
  has(App.root.textContent, 'do not match the players listed below',
    'drift is reported, not hidden');
  has(App.root.textContent, 'team recount', 'and the fix is named');
}

async function testHostileTeamName() {
  console.log('\n[11] a hostile team name renders as literal text, never as markup');
  reset();
  await renderDashboard(listResponse([team({ team_name: HOSTILE, owner_name: HOSTILE })]));

  has(App.root.textContent, HOSTILE, 'the name appears verbatim as text');
  eq(byTag(App.root, 'SCRIPT').length, 0, 'no <script> element was created');
  eq(byTag(App.root, 'IMG').length, 0, 'no <img> element was created');

  // And in the confirmation dialog text as well.
  respond('team.delete', () => ({}));
  findButton(App.root, 'Delete').click();
  await flush(2);
  has(log.confirms[0].title, HOSTILE, 'the dialog title carries it as plain text too');
}

async function testUnauthorizedRedirect() {
  console.log('\n[12] an expired session clears the token and goes to the sign-in screen');
  reset();

  always('team.list', () => { throw { code: 'UNAUTHORIZED', message: 'Your session has expired.' }; });
  window.localStorage.setItem('ca.organiser.tournament', 'TRN_1');

  OrganiserDashboardPage.render(dashCtx());
  await flush();

  eq(API._token, null, 'the dead token is thrown away');
  eq(window.localStorage.getItem('ca.organiser.tournament'), null,
    'and so is the remembered tournament, so the next organiser is not misfiled');
  const nav = log.navigations[log.navigations.length - 1];
  eq(nav.to, '/admin/login', 'it redirects to the shared sign-in screen');
  eq(nav.opts.replace, true, 'with replace, so Back does not bounce straight out again');
  lacks(App.root.textContent, 'Your session has expired.',
    'no error is painted over a page that is being replaced');
}

async function testDashboardWithoutTournament() {
  console.log('\n[13] with nothing local, the session is asked; an admin with none is told why');
  reset();
  App.rememberedTournamentId = () => '';

  // An ORGANISER: auth.me knows the tournament, so the screen just works.
  always('auth.me', () => ({ user_id: 'USR_1', role: 'ORGANISER', tournament_id: 'TRN_7' }));
  always('team.list', () => listResponse());

  OrganiserDashboardPage.render({ path: '/organiser/dashboard', params: {}, query: {} });
  await flush(12);

  eq(lastCall('team.list').payload.tournamentId, 'TRN_7',
    'the tournament from the session is used');
  eq(window.localStorage.getItem('ca.organiser.tournament'), 'TRN_7',
    'and remembered, so the next visit costs no extra call');
  has(App.root.textContent, 'Chennai Warriors', 'the dashboard renders');

  // An ADMIN has no tournament of their own, so it says so instead of hanging.
  reset();
  App.rememberedTournamentId = () => '';
  always('auth.me', () => ({ user_id: 'USR_A', role: 'ADMIN', tournament_id: '' }));

  OrganiserDashboardPage.render({ path: '/organiser/dashboard', params: {}, query: {} });
  await flush(12);

  eq(callsTo('team.list').length, 0, 'no pointless team.list is made');
  has(App.root.textContent, 'No tournament is selected', 'the reason is on screen');
  has(App.root.textContent, 'choose a tournament on the admin dashboard',
    'with what an admin should do about it');
}

/* ==================================================================== *
 * 8. Tests — the admin organisers screen
 * ==================================================================== */

async function testJoinLinkShownOnce() {
  console.log('\n[14] the join link appears once, with Copy and the never-again warning');
  reset();

  always('organiser.list', () => [organiser()]);
  AdminOrganisersPage.render(adminCtx());
  await flush();

  eq(document.body.dataset.route, 'admin-organisers', 'body data-route is admin-organisers');

  const JOIN_URL = 'https://example.github.io/cricket-auction/organiser/join?k=RAWTOKEN123';
  respond('organiser.create', () => ({
    user_id: 'USR_2', email: 'new@example.com', display_name: 'New Person',
    tournament_id: 'TRN_1', joinUrl: JOIN_URL,
    joinExpiresAt: '2026-09-02T06:30:00.000Z',
    joinExpiresAtDisplay: '2 Sep 2026, 12:00'
  }));

  inputNamed(App.root, 'displayName').value = 'New Person';
  inputNamed(App.root, 'email').value = 'new@example.com';
  findButton(App.root, 'Create organiser and get the link').click();
  await flush(14);

  const created = lastCall('organiser.create');
  eq(created.payload.email, 'new@example.com', 'the email is sent');
  eq(created.payload.displayName, 'New Person', 'the display name is sent');
  eq(created.payload.tournamentId, 'TRN_1', 'scoped to the tournament');

  const box = byClass(App.root, 'org-link')[0];
  ok(!!box, 'the link box is rendered');
  const boxText = box.textContent;
  has(boxText, 'shown once and will not be shown again', 'the warning is in plain words');
  has(boxText, 'expires in 72 hours', 'the 72-hour expiry is stated');
  has(boxText, '2 Sep 2026, 12:00', "the server's expiry time is shown");
  has(boxText, 'Resend link', 'and it says what to do if the link is lost');

  const urlBox = byClass(box, 'org-link__url')[0];
  ok(!!urlBox, 'the URL sits in a read-only box');
  eq(urlBox.value, JOIN_URL, 'holding the exact link');
  eq(urlBox.readOnly, true, 'which cannot be edited by accident');

  // Never a clickable link: opening it burns the one-time token.
  const anchors = byTag(box, 'A');
  eq(anchors.filter((a) => String(a.href || '').indexOf('RAWTOKEN123') !== -1).length, 0,
    'the link is never rendered as a clickable <a>');

  const copy = findButton(box, 'Copy link');
  ok(!!copy, 'there is a Copy control');
  copy.click();
  await flush();
  eq(clipboard.last, JOIN_URL, 'Copy puts the exact link on the clipboard');
  has(copy.textContent, 'Copied', 'and confirms it did');

  // It is shown exactly once: dismissing clears it and nothing brings it back.
  findButton(box, 'I have copied it').click();
  eq(byClass(App.root, 'org-link').length, 0, 'dismissing removes the link from the page');
  lacks(App.root.textContent, 'RAWTOKEN123', 'and the token is nowhere on screen afterwards');
}

async function testListNeverShowsAToken() {
  console.log('\n[15] the organiser list never renders a token, and shows joinPending');
  reset();

  // Deliberately hostile fixture: fields the contract says are never returned.
  always('organiser.list', () => [
    Object.assign(organiser(), {
      join_token_hash: 'HASHVALUE_SHOULD_NEVER_RENDER',
      token: 'PLAINTOKEN_SHOULD_NEVER_RENDER',
      joinUrl: 'https://example/organiser/join?k=SHOULD_NEVER_RENDER'
    }),
    organiser({ user_id: 'USR_2', display_name: 'Old Hand', email: 'old@example.com',
      joinPending: false, status: 'DISABLED', last_login_at_display: '2 Sep 2026, 09:10' })
  ]);

  AdminOrganisersPage.render(adminCtx());
  await flush();

  const text = App.root.textContent;
  lacks(text, 'HASHVALUE_SHOULD_NEVER_RENDER', 'no token hash on screen');
  lacks(text, 'PLAINTOKEN_SHOULD_NEVER_RENDER', 'no plain token on screen');
  lacks(text, 'SHOULD_NEVER_RENDER', 'no stray join URL from the list response');

  has(text, 'Not used yet', 'joinPending is spelled out for the pending organiser');
  has(text, 'Password set', 'and the joined one is marked too');
  has(text, 'Disabled', 'a disabled account says so in a word');
  has(text, 'Never', 'an organiser who has never signed in says so');

  const headers = byTag(byTag(App.root, 'THEAD')[0], 'TH');
  ok(headers.length >= 6, 'the list is a real table with headers');
  eq(headers.filter((th) => th.scope === 'col').length, headers.length,
    'every header cell is th scope="col"');
  eq(byTag(App.root, 'TABLE').length, 1, 'exactly one table');
}

async function testResendAndDisableConfirmations() {
  console.log('\n[16] resend warns the old link dies; disable names the person and the sign-out');
  reset();

  always('organiser.list', () => [organiser()]);
  AdminOrganisersPage.render(adminCtx());
  await flush();

  const NEW_URL = 'https://example.github.io/cricket-auction/organiser/join?k=FRESHTOKEN';
  respond('organiser.resendLink', () => ({
    user_id: 'USR_1', display_name: 'Ravi Kumar', joinUrl: NEW_URL,
    joinExpiresAtDisplay: '3 Sep 2026, 12:00'
  }));

  findButton(App.root, 'Resend link').click();
  await flush(14);

  has(log.confirms[0].title, 'Ravi Kumar', 'the resend dialog names the organiser');
  has(log.confirms[0].body, 'previous one stops working',
    'and warns that the old link dies immediately');
  eq(lastCall('organiser.resendLink').payload.userId, 'USR_1', 'the resend carries the user id');
  eq(byClass(App.root, 'org-link__url')[0].value, NEW_URL, 'the new link is shown once');

  // Disable.
  log.confirms.length = 0;
  respond('organiser.disable', () => ({ user_id: 'USR_1', status: 'DISABLED' }));
  findButton(App.root, 'Disable').click();
  await flush(14);

  has(log.confirms[0].title, 'Ravi Kumar', 'the disable dialog names the person');
  has(log.confirms[0].body, 'signed out immediately', 'and says the sign-out is immediate');
  has(log.confirms[0].body, 'ravi@example.com', 'and shows which account that is');
  eq(log.confirms[0].danger, true, 'it is styled as the destructive action it is');
  eq(lastCall('organiser.disable').payload.userId, 'USR_1', 'organiser.disable carries the user id');
  has(App.root.textContent, 'has been disabled and signed out', 'the result is confirmed');
}

async function testHostileOrganiserName() {
  console.log('\n[17] a hostile organiser name renders as literal text');
  reset();

  always('organiser.list', () => [organiser({ display_name: HOSTILE })]);
  AdminOrganisersPage.render(adminCtx());
  await flush();

  has(App.root.textContent, HOSTILE, 'the name appears verbatim as text');
  eq(byTag(App.root, 'SCRIPT').length, 0, 'no <script> element was created');
  eq(byTag(App.root, 'IMG').length, 0, 'no <img> element was created');
}

async function testNoInnerHtmlAnywhere() {
  console.log('\n[18] the three page files contain no innerHTML, no fetch, no eval');
  const files = ['js/pages/organiser-join.js', 'js/pages/organiser-dashboard.js',
    'js/pages/admin-organisers.js'];
  files.forEach((f) => {
    const src = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
    ['innerHTML', 'outerHTML', 'document.write', 'eval(', 'fetch('].forEach((bad) => {
      lacks(src, bad, f + ' contains no ' + bad);
    });
    has(src, 'document.body.dataset.route', f + ' sets the route on <body>');
  });

  const css = fs.readFileSync(path.join(FRONTEND, 'css/organiser.css'), 'utf8');
  ['organiser-join', 'organiser-dashboard', 'admin-organisers'].forEach((route) => {
    has(css, 'body[data-route="' + route + '"]', 'organiser.css scopes rules to ' + route);
  });
  lacks(css, '@import', 'organiser.css imports nothing');
  lacks(css, '@font-face', 'organiser.css loads no web font');
}

/* ==================================================================== *
 * 9. Runner
 * ==================================================================== */

(async function main() {
  if (MUTATION) {
    console.log('MUTATION: ' + MUTATION.what + '  (' + MUTATION.file + ')');
  }

  const tests = [
    testJoinHappyPath, testJoinMismatchBlockedLocally, testJoinDeadLink,
    testJoinNoTokenAtAll,
    testBatchCreationIsOneCall, testBatchRejectsDuplicatesLocally, testBatchRowsAddAndRemove, testPerSlotRemaining,
    testUpdateErrorsAreVerbatim, testDeleteNotEmpty, testSquadView, testHostileTeamName,
    testUnauthorizedRedirect, testDashboardWithoutTournament,
    testJoinLinkShownOnce, testListNeverShowsAToken, testResendAndDisableConfirmations,
    testHostileOrganiserName, testNoInnerHtmlAnywhere
  ];

  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      failures.push(t.name + ' threw: ' + (err && err.stack ? err.stack : err));
      console.log('  THREW ' + t.name + ': ' + (err && err.message ? err.message : err));
    }
  }

  console.log('\n====================================');
  console.log(passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }

  if (MUTATION) {
    // A mutation that nothing notices means the assertion was decoration.
    if (failures.length) {
      console.log('\nMUTATION CAUGHT: the suite failed, as it must.');
      process.exit(0);
    }
    console.log('\nMUTATION SURVIVED: nothing detected "' + MUTATION.what + '".');
    process.exit(1);
  }

  process.exit(failures.length ? 1 : 0);
})();
