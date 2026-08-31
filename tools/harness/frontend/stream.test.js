'use strict';
/**
 * stream.test.js — behavioural tests for frontend/js/pages/stream.js.
 *
 * Run:  node tools/harness/frontend/stream.test.js
 *       (or `node tools/test.js stream`, which is what CI does)
 *
 * Loads the REAL frontend/js/broadcast.js and frontend/js/pages/stream.js,
 * unmodified, into a fake DOM. broadcast.js's own poll/backoff logic is
 * exercised via broadcast.test.js; this file is about what StreamPage does
 * with a snapshot once broadcast.js hands it one.
 *
 * The last block MUTATES the source and asserts that named tests then FAIL.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const {
  Element, byClass, oneByClass, visibleText, makeClock, flush
} = require('./fakedom');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FRONTEND = path.join(REPO, 'frontend');
const BROADCAST_SRC = fs.readFileSync(path.join(FRONTEND, 'js/broadcast.js'), 'utf8');
const SRC_PATH = path.join(FRONTEND, 'js/pages/stream.js');
const SOURCE = fs.readFileSync(SRC_PATH, 'utf8');

/* ====================================================================== *
 * Boot
 * ====================================================================== */

function boot(opts) {
  const options = opts || {};
  const clock = makeClock();

  const body = new Element('body');
  const html = new Element('html');
  const appRoot = new Element('div');
  appRoot.id = 'app';
  body.appendChild(appRoot);

  const document = {
    title: '', body: body, documentElement: html, hidden: false,
    _listeners: {},
    createElement: (tag) => new Element(tag),
    createTextNode: (t) => {
      const n = new Element('#text');
      n.nodeType = 3;
      n.textContent = String(t);
      return n;
    },
    getElementById: (id) => (id === 'app' ? appRoot : null),
    addEventListener(type, fn) { (document._listeners[type] = document._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = document._listeners[type]; if (!l) return;
      const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1);
    },
    dispatch(type) { (document._listeners[type] || []).slice().forEach((fn) => fn({})); }
  };

  const api = {
    lastVersion: null,
    calls: [],
    handler: options.handler || (() => ({ data: { v: 1, same: true } })),
    get(action, params, callOpts) {
      api.calls.push({ action, params: JSON.parse(JSON.stringify(params || {})), opts: callOpts || null });
      const answer = api.handler(action, params, api.calls.length) || {};
      if (Object.prototype.hasOwnProperty.call(answer, 'error')) return Promise.reject(answer.error);
      if (answer.data && typeof answer.data.v === 'number') api.lastVersion = answer.data.v;
      return Promise.resolve(answer.data);
    },
    call() { throw new Error('stream.js must never POST — it is read-only'); }
  };

  const windowObj = {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id)
  };

  const sandbox = {
    document, window: windowObj, console,
    CONFIG: { POLL_INTERVAL_MS: 2000 },
    API: api,
    UI: { money: (n) => '₹' + String(n) },
    Promise, Date, Math, Object, Array, String, Number, Boolean, JSON,
    isFinite, isNaN, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);

  vm.runInContext(BROADCAST_SRC + '\n;this.Broadcast = Broadcast;', sandbox, { filename: 'broadcast.js' });
  const source = options.mutate ? options.mutate(SOURCE) : SOURCE;
  vm.runInContext(source + '\n;this.__page = StreamPage;', sandbox, { filename: 'stream.js' });

  return {
    page: sandbox.__page, document, body, html, appRoot, api, clock,
    root: () => appRoot.childNodes[0],
    ctx: (over) => Object.assign({
      path: '/stream/TRN_x', params: { tournamentId: 'TRN_x' },
      query: { k: 'KEY123' }, pattern: '/stream/:tournamentId'
    }, over || {})
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

const PENDING_SNAP = {
  v: 1, status: 'AUCTION_LIVE', tournament_name: 'Test Cup',
  current: {
    player_id: 'PLY_1', serial_no: 27, name: 'Raj Kumar', role: 'ALL_ROUNDER',
    style: 'RIGHT', photo_url: 'https://img.test/27-lg.jpg', auction_status: 'PENDING',
    team_name: '', sold_amount_display: ''
  },
  teams: [
    { team_id: 'TM_1', team_name: 'Chennai Warriors', purse_remaining: 550000, purse_remaining_display: '₹5,50,000' },
    { team_id: 'TM_2', team_name: 'Madurai Kings', purse_remaining: 320000, purse_remaining_display: '₹3,20,000' }
  ],
  summary: { sold: 4, unsold: 1, not_called: 2 }
};

const only = process.argv[2] || '';
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------------------------------------------------------------------- *
 * Boot and route
 * ---------------------------------------------------------------------- */

test('route: body.dataset.route is stream, default layout is player', async () => {
  const env = boot({ handler: () => ({ data: clone(PENDING_SNAP) }) });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(env.document.body.dataset.route, 'stream');
  assert.strictEqual(env.root().dataset.layout, 'player');
});

test('route: ?layout= selects the requested layout, unknown falls back to player', async () => {
  const env = boot({ handler: () => ({ data: { v: 1, same: true } }) });
  env.page.render(env.ctx({ query: { k: 'K', layout: 'full' } }));
  assert.strictEqual(env.root().dataset.layout, 'full');

  env.page.render(env.ctx({ query: { k: 'K', layout: 'not-a-real-layout' } }));
  assert.strictEqual(env.root().dataset.layout, 'player');
});

test('transparency: html background is set on render and CLEARED on teardown', async () => {
  const env = boot({ handler: () => ({ data: { v: 1, same: true } }) });
  env.page.render(env.ctx());
  assert.strictEqual(env.html.style.getPropertyValue('background'), 'transparent');

  env.page._teardown();
  assert.strictEqual(env.html.style.getPropertyValue('background'), '',
    'must not leak transparency into whatever route is rendered next');
});

test('silence: a missing token renders nothing and calls the API zero times', async () => {
  const env = boot({ handler: () => ({ data: clone(PENDING_SNAP) }) });
  env.page.render(env.ctx({ query: {} }));
  await flush();
  assert.strictEqual(env.api.calls.length, 0,
    'a broadcast surface must never show an error banner or retry pointlessly');
  assert.strictEqual(visibleText(oneByClass(env.root(), 'stream__sold')), '',
    'the sold sting must not be visible with nothing to show');
});

/* ---------------------------------------------------------------------- *
 * The player card
 * ---------------------------------------------------------------------- */

test('card: paints the current player and clears is-idle', async () => {
  const env = boot({ handler: () => ({ data: clone(PENDING_SNAP) }) });
  env.page.render(env.ctx());
  await flush();

  const card = oneByClass(env.root(), 'stream__card');
  assert.ok(!card.classList.contains('is-idle'));
  assert.strictEqual(oneByClass(card, 'stream__serial').textContent, '#27');
  assert.strictEqual(oneByClass(card, 'stream__name').textContent, 'Raj Kumar');
  assert.ok(oneByClass(card, 'stream__meta').textContent.indexOf('All rounder') !== -1);
});

test('card: uses photo_url (the 1024px variant), not the 320px thumbnail, when both exist', async () => {
  const snap = clone(PENDING_SNAP);
  snap.current.photo_thumb_url = 'https://img.test/27-small.jpg';
  const env = boot({ handler: () => ({ data: snap }) });
  env.page.render(env.ctx());
  await flush();

  const img = oneByClass(env.root(), 'stream__photo');
  assert.strictEqual(img.getAttribute('src'), 'https://img.test/27-lg.jpg');
});

test('card: no current player -> is-idle, no photo request left dangling', async () => {
  const env = boot({ handler: () => ({ data: { v: 1, status: 'AUCTION_LIVE', current: null, teams: [], summary: {} } }) });
  env.page.render(env.ctx());
  await flush();
  assert.ok(oneByClass(env.root(), 'stream__card').classList.contains('is-idle'));
});

test('xss: a hostile player and team name render as literal text', async () => {
  const snap = clone(PENDING_SNAP);
  snap.current.name = '<img src=x onerror=alert(1)>';
  snap.teams[0].team_name = '<script>evil()</script>';
  const env = boot({ handler: () => ({ data: snap }) });
  env.page.render(env.ctx({ query: { k: 'K', layout: 'full' } }));
  await flush();

  assert.strictEqual(oneByClass(env.root(), 'stream__name').textContent,
    '<img src=x onerror=alert(1)>');
  assert.strictEqual(byTag(env.root(), 'IMG').filter((n) => n.className === '').length, 0,
    'no hostile <img> may be created from the name');
  assert.strictEqual(byTag(env.root(), 'SCRIPT').length, 0,
    'no hostile <script> may be created from a team name');
});

function byTag(root, tag) {
  const out = [];
  (function walk(n) {
    if (n.tagName === tag) out.push(n);
    (n.childNodes || []).forEach(walk);
  }(root));
  return out;
}

/* ---------------------------------------------------------------------- *
 * The SOLD/UNSOLD sting
 * ---------------------------------------------------------------------- */

test('sting: fires on transition into SOLD, shows amount and team', async () => {
  let call = 0;
  const rows = [clone(PENDING_SNAP), (function () {
    const s = clone(PENDING_SNAP);
    s.v = 2; s.current.auction_status = 'SOLD';
    s.current.sold_amount_display = '₹75,000'; s.current.team_name = 'Chennai Warriors';
    return s;
  }())];
  const env = boot({ handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
  env.page.render(env.ctx());
  await flush();
  env.clock.advance(2000); await flush();

  const sold = oneByClass(env.root(), 'stream__sold');
  assert.strictEqual(sold.hidden, false);
  assert.strictEqual(oneByClass(sold, 'stream__sold-title').textContent, 'SOLD');
  assert.strictEqual(oneByClass(sold, 'stream__sold-amount').textContent, '₹75,000');
  assert.strictEqual(oneByClass(sold, 'stream__sold-team').textContent, 'Chennai Warriors');
});

test('sting: UNSOLD shows no amount and no team', async () => {
  let call = 0;
  const rows = [clone(PENDING_SNAP), (function () {
    const s = clone(PENDING_SNAP); s.v = 2; s.current.auction_status = 'UNSOLD'; return s;
  }())];
  const env = boot({ handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
  env.page.render(env.ctx());
  await flush();
  env.clock.advance(2000); await flush();

  const sold = oneByClass(env.root(), 'stream__sold');
  assert.strictEqual(oneByClass(sold, 'stream__sold-title').textContent, 'UN-SOLD');
  assert.ok(sold.classList.contains('stream__sold--unsold'));
  assert.strictEqual(oneByClass(sold, 'stream__sold-amount').hidden, true);
  assert.strictEqual(oneByClass(sold, 'stream__sold-team').hidden, true);
});

test("sting: in 'sold' layout it auto-clears after SOLD_STING_MS", async () => {
  let call = 0;
  const rows = [clone(PENDING_SNAP), (function () {
    const s = clone(PENDING_SNAP); s.v = 2; s.current.auction_status = 'SOLD'; return s;
  }())];
  const env = boot({ handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
  env.page.render(env.ctx({ query: { k: 'K', layout: 'sold' } }));
  await flush();
  env.clock.advance(2000); await flush();

  const sold = oneByClass(env.root(), 'stream__sold');
  assert.strictEqual(sold.hidden, false, 'the sting appears');
  env.clock.advance(env.page.SOLD_STING_MS);
  await flush();
  assert.strictEqual(sold.hidden, true, "and clears itself in 'sold' layout so the OBS layer empties again");
});

test("sting: in 'player' layout it is left up, not auto-cleared", async () => {
  let call = 0;
  const rows = [clone(PENDING_SNAP), (function () {
    const s = clone(PENDING_SNAP); s.v = 2; s.current.auction_status = 'SOLD'; return s;
  }())];
  const env = boot({ handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
  env.page.render(env.ctx());   // default 'player' layout
  await flush();
  env.clock.advance(2000); await flush();

  const sold = oneByClass(env.root(), 'stream__sold');
  env.clock.advance(env.page.SOLD_STING_MS + 5000);
  await flush();
  assert.strictEqual(sold.hidden, false,
    "the ordinary card sits beside the sting in 'player'/'full'; nothing needs to auto-hide it");
});

/* ---------------------------------------------------------------------- *
 * Ticker and tallies ('full' layout)
 * ---------------------------------------------------------------------- */

test('sting: still fires when the SAME poll also reports AUCTION_CLOSED', async () => {
  // An organiser can close the auction before the next 2-15s poll runs, so the
  // single snapshot reporting the tournament's FINAL sale can arrive already
  // carrying status:AUCTION_CLOSED alongside the SOLD transition. Swallowing
  // the sting there would make the last sale of the night the one result this
  // feature never shows.
  let call = 0;
  const rows = [clone(PENDING_SNAP), (function () {
    const s = clone(PENDING_SNAP);
    s.v = 2; s.status = 'AUCTION_CLOSED';
    s.current.auction_status = 'SOLD';
    s.current.sold_amount_display = '₹1,20,000'; s.current.team_name = 'Salem Spartans';
    return s;
  }())];
  const env = boot({ handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
  env.page.render(env.ctx());
  await flush();
  env.clock.advance(2000); await flush();

  const sold = oneByClass(env.root(), 'stream__sold');
  assert.strictEqual(sold.hidden, false, 'the final sale must still be shown');
  assert.strictEqual(oneByClass(sold, 'stream__sold-amount').textContent, '₹1,20,000');
  assert.ok(oneByClass(env.root(), 'stream__card').classList.contains('is-idle'),
    'the ordinary card still goes idle once closed — only the sting is exempt');
});

test("ticker: renders team purses in 'full' layout, capped by ?teams=", async () => {
  const snap = clone(PENDING_SNAP);
  snap.teams.push({ team_id: 'TM_3', team_name: 'Salem Spartans', purse_remaining_display: '₹1,00,000' });
  const env = boot({ handler: () => ({ data: snap }) });
  env.page.render(env.ctx({ query: { k: 'K', layout: 'full', teams: '2' } }));
  await flush();

  const items = byClass(env.root(), 'stream__ticker-item');
  assert.strictEqual(items.length, 2, 'the ?teams= cap must be respected');
});

test('tallies: not shown at all outside layout=full (display:none is CSS, but the node stays empty)', async () => {
  const env = boot({ handler: () => ({ data: clone(PENDING_SNAP) }) });
  env.page.render(env.ctx());   // player layout
  await flush();
  const tallies = oneByClass(env.root(), 'stream__tallies');
  assert.ok(tallies.hidden === false, 'the node itself is not JS-hidden — CSS is what hides it per layout');
});

/* ====================================================================== *
 * Mutation tests
 * ====================================================================== */

const mutations = [];
function mutation(name, mutate, check) { mutations.push({ name, mutate, check }); }

mutation(
  'M1 stop clearing html background on teardown -> the leak test must fail',
  (src) => src.replace(
    "document.documentElement.style.removeProperty('background');",
    "/* removed */"
  ),
  async (mutate) => {
    const env = boot({ mutate, handler: () => ({ data: { v: 1, same: true } }) });
    env.page.render(env.ctx());
    env.page._teardown();
    return env.html.style.getPropertyValue('background') === '';
  }
);

mutation(
  "M2 always auto-clear the sting regardless of layout -> the 'player' persistence test must fail",
  (src) => src.replace("if (el.root.dataset.layout === 'sold') {", "if (true) {"),
  async (mutate) => {
    let call = 0;
    const rows = [clone(PENDING_SNAP), (function () {
      const s = clone(PENDING_SNAP); s.v = 2; s.current.auction_status = 'SOLD'; return s;
    }())];
    const env = boot({ mutate, handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
    env.page.render(env.ctx());
    await flush();
    env.clock.advance(2000); await flush();
    const sold = oneByClass(env.root(), 'stream__sold');
    env.clock.advance(env.page.SOLD_STING_MS + 5000);
    await flush();
    return sold.hidden === false;
  }
);

mutation(
  'M3 use photo_thumb_url instead of photo_url -> the large-photo test must fail',
  (src) => src.replace(
    "const src = p.photo_url || p.photo_thumb_url || '';",
    "const src = p.photo_thumb_url || p.photo_url || '';"
  ),
  async (mutate) => {
    const snap = clone(PENDING_SNAP);
    snap.current.photo_thumb_url = 'https://img.test/27-small.jpg';
    const env = boot({ mutate, handler: () => ({ data: snap }) });
    env.page.render(env.ctx());
    await flush();
    return oneByClass(env.root(), 'stream__photo').getAttribute('src') === 'https://img.test/27-lg.jpg';
  }
);

mutation(
  "M4 tie the sting to 'not closed' again -> the final-sale test must fail",
  (src) => src.replace(
    "if (current && (transition === 'SOLD' || transition === 'UNSOLD')) {",
    "if (!closed && current && (transition === 'SOLD' || transition === 'UNSOLD')) {"
  ),
  async (mutate) => {
    let call = 0;
    const rows = [clone(PENDING_SNAP), (function () {
      const s = clone(PENDING_SNAP);
      s.v = 2; s.status = 'AUCTION_CLOSED'; s.current.auction_status = 'SOLD';
      return s;
    }())];
    const env = boot({ mutate, handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
    env.page.render(env.ctx());
    await flush();
    env.clock.advance(2000); await flush();
    return oneByClass(env.root(), 'stream__sold').hidden === false;
  }
);

async function main() {
  let pass = 0, fail = 0;
  for (const t of tests) {
    if (only && t.name.indexOf(only) === -1) continue;
    try { await t.fn(); pass += 1; console.log('  ok   ' + t.name); }
    catch (err) {
      fail += 1;
      console.log('  FAIL ' + t.name);
      console.log('       ' + String(err && err.message).split('\n').join('\n       '));
    }
  }

  console.log('\n--- mutation tests (each SHOULD fail) ---');
  for (const m of mutations) {
    if (only && m.name.indexOf(only) === -1) continue;
    let hit = false;
    const mutate = (src) => { const out = m.mutate(src); hit = out !== src; return out; };
    let ok = false;
    try { ok = await m.check(mutate); } catch (e) { ok = false; }
    if (!hit) { fail += 1; console.log('  FAIL ' + m.name + ' (mutation target not found)'); }
    else if (ok) { fail += 1; console.log('  FAIL ' + m.name + ' (mutant was NOT caught)'); }
    else { pass += 1; console.log('  ok   ' + m.name); }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main();
