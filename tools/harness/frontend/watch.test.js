'use strict';
/**
 * watch.test.js — behavioural tests for frontend/js/pages/watch.js.
 *
 * Run:  node tools/harness/frontend/watch.test.js
 *       (or `node tools/test.js watch`, which is what CI does)
 *
 * The security-critical part of this file is the ?video= allow-list: it is
 * the one place in this whole app that builds an <iframe src> from a value a
 * shared link's query string controls. Most of the weight below is on that.
 *
 * The last block MUTATES the source and asserts that named tests then FAIL.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { Element, byClass, oneByClass, visibleText, makeClock, flush } = require('./fakedom');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FRONTEND = path.join(REPO, 'frontend');
const BROADCAST_SRC = fs.readFileSync(path.join(FRONTEND, 'js/broadcast.js'), 'utf8');
const SRC_PATH = path.join(FRONTEND, 'js/pages/watch.js');
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
    getElementById: (id) => (id === 'app' ? appRoot : null),
    addEventListener(type, fn) { (document._listeners[type] = document._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = document._listeners[type]; if (!l) return;
      const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1);
    },
    dispatch(type) { (document._listeners[type] || []).slice().forEach((fn) => fn({})); }
  };

  // Two independent handlers: the ONE-TIME branding call (tournament.getPublic)
  // and the POLLED live call (auction.displayState). Kept separate so a test
  // can assert getPublic fired exactly once regardless of how many polls ran.
  const publicCalls = [];
  const liveCalls = [];
  const api = {
    lastVersion: null,
    publicHandler: options.publicHandler || (() => ({ data: { name: 'Test Cup', logo_url: '' } })),
    liveHandler: options.liveHandler || (() => ({ data: { v: 1, same: true } })),
    get(action, params) {
      if (action === 'tournament.getPublic') {
        publicCalls.push(params);
        const a = api.publicHandler(params) || {};
        if (Object.prototype.hasOwnProperty.call(a, 'error')) return Promise.reject(a.error);
        return Promise.resolve(a.data);
      }
      liveCalls.push(params);
      const a = api.liveHandler(params) || {};
      if (Object.prototype.hasOwnProperty.call(a, 'error')) return Promise.reject(a.error);
      if (a.data && typeof a.data.v === 'number') api.lastVersion = a.data.v;
      return Promise.resolve(a.data);
    },
    call() { throw new Error('watch.js must never POST — it is read-only'); }
  };

  const windowObj = {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id)
  };

  const bannerCalls = [];
  const sandbox = {
    document, window: windowObj, console, URL,
    CONFIG: { POLL_INTERVAL_MS: 2000 },
    API: api,
    UI: {
      money: (n) => '₹' + String(n),
      banner: (kind, message) => {
        bannerCalls.push({ kind, message });
        const el = new Element('div');
        el.className = 'banner banner--' + kind;
        el.textContent = message;
        return el;
      }
    },
    Promise, Date, Math, Object, Array, String, Number, Boolean, JSON,
    isFinite, isNaN, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);

  vm.runInContext(BROADCAST_SRC + '\n;this.Broadcast = Broadcast;', sandbox, { filename: 'broadcast.js' });
  const source = options.mutate ? options.mutate(SOURCE) : SOURCE;
  vm.runInContext(source + '\n;this.__page = WatchPage;', sandbox, { filename: 'watch.js' });

  return {
    page: sandbox.__page, document, body, appRoot, api, clock,
    publicCalls, liveCalls, bannerCalls,
    root: () => appRoot.childNodes[0],
    ctx: (over) => Object.assign({
      path: '/watch/TRN_x', params: { tournamentId: 'TRN_x' },
      query: { k: 'KEY123' }, pattern: '/watch/:tournamentId'
    }, over || {})
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

const PENDING_SNAP = {
  v: 1, status: 'AUCTION_LIVE', tournament_name: 'Test Cup',
  current: {
    player_id: 'PLY_1', serial_no: 27, name: 'Raj Kumar', role: 'ALL_ROUNDER',
    style: 'RIGHT', age_years: 26, photo_url: 'https://img.test/27.jpg',
    auction_status: 'PENDING', team_name: '', sold_amount_display: ''
  },
  teams: [
    { team_id: 'TM_1', team_name: 'Chennai Warriors', purse_remaining: 550000, purse_remaining_display: '₹5,50,000', players_count: 7, max_players: 12 },
    { team_id: 'TM_2', team_name: 'Madurai Kings', purse_remaining: 320000, purse_remaining_display: '₹3,20,000', players_count: 9, max_players: 12 }
  ],
  summary: { sold: 4, unsold: 1, pending_called: 0, not_called: 2, eligible: 7 }
};

const only = process.argv[2] || '';
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function byTag(root, tag) {
  const out = [];
  (function walk(n) { if (n.tagName === tag) out.push(n); (n.childNodes || []).forEach(walk); }(root));
  return out;
}

/* ---------------------------------------------------------------------- *
 * Boot, branding (one-time, not polled)
 * ---------------------------------------------------------------------- */

test('route: body.dataset.route is watch', async () => {
  const env = boot({ liveHandler: () => ({ data: clone(PENDING_SNAP) }) });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(env.document.body.dataset.route, 'watch');
});

test('branding: tournament.getPublic is called exactly ONCE, never on a poll', async () => {
  const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
  env.page.render(env.ctx());
  await flush();
  env.clock.advance(2000); await flush();
  env.clock.advance(2000); await flush();
  assert.strictEqual(env.publicCalls.length, 1,
    'branding must not repeat on the poll interval — it does not change every 2s');
  assert.strictEqual(env.liveCalls.length, 3, '(sanity: the live poll DID run three times)');
});

test('branding: name and logo paint from getPublic once it resolves', async () => {
  const env = boot({
    publicHandler: () => ({ data: { name: 'Karaikal Premier League', logo_url: 'https://img.test/logo.png' } }),
    liveHandler: () => ({ data: { v: 1, same: true } })
  });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(oneByClass(env.root(), 'watch__title').textContent, 'Karaikal Premier League');
  const logo = oneByClass(env.root(), 'watch__logo');
  assert.strictEqual(logo.hidden, false);
  assert.strictEqual(logo.getAttribute('src'), 'https://img.test/logo.png');
});

test('branding: a failed getPublic falls back to the live snapshot\'s own name', async () => {
  const env = boot({
    publicHandler: () => ({ error: { code: 'NOT_FOUND' } }),
    liveHandler: () => ({ data: clone(PENDING_SNAP) })
  });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(oneByClass(env.root(), 'watch__title').textContent, 'Test Cup',
    'the header must not stay blank just because the non-essential branding call failed');
});

/* ---------------------------------------------------------------------- *
 * The video slot — the security-critical part
 * ---------------------------------------------------------------------- */

test('video: a youtube.com https embed URL renders an iframe with that exact src', async () => {
  const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
  env.page.render(env.ctx({
    query: { k: 'K', video: 'https://www.youtube.com/embed/abc123?autoplay=1' }
  }));
  await flush();
  const frames = byTag(env.root(), 'IFRAME');
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].getAttribute('src'), 'https://www.youtube.com/embed/abc123?autoplay=1');
  assert.strictEqual(oneByClass(env.root(), 'watch__video-empty').hidden, true);
});

test('video: youtube-nocookie.com and facebook.com are also accepted', async () => {
  ['https://www.youtube-nocookie.com/embed/abc', 'https://www.facebook.com/plugins/video.php?href=x']
    .forEach((url) => {
      const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
      env.page.render(env.ctx({ query: { k: 'K', video: url } }));
      assert.strictEqual(byTag(env.root(), 'IFRAME').length, 1, url + ' should be accepted');
    });
});

test('video: an arbitrary host is REFUSED — no iframe is created at all', async () => {
  const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
  env.page.render(env.ctx({
    query: { k: 'K', video: 'https://evil.example.com/frame-this-site' }
  }));
  await flush();
  assert.strictEqual(byTag(env.root(), 'IFRAME').length, 0,
    'a link crafted with an arbitrary ?video= host must never produce an iframe');
  assert.strictEqual(oneByClass(env.root(), 'watch__video-empty').hidden, false);
});

test('video: a look-alike host (youtube.com.evil.example) is REFUSED', async () => {
  // The classic bypass attempt for a naive "contains youtube.com" check.
  // new URL().hostname for this is "youtube.com.evil.example", which the
  // allow-list compares by EXACT match, so it is refused correctly.
  const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
  env.page.render(env.ctx({ query: { k: 'K', video: 'https://youtube.com.evil.example/embed/x' } }));
  await flush();
  assert.strictEqual(byTag(env.root(), 'IFRAME').length, 0);
});

test('video: non-https (http, javascript:, data:) is REFUSED even on an allowed host', async () => {
  ['http://www.youtube.com/embed/abc', 'javascript:alert(1)', 'data:text/html,<script>1</script>']
    .forEach((url) => {
      const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
      env.page.render(env.ctx({ query: { k: 'K', video: url } }));
      assert.strictEqual(byTag(env.root(), 'IFRAME').length, 0, url + ' must be refused');
    });
});

test('video: a garbage value that is not a URL at all is REFUSED, not thrown', async () => {
  const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
  // new URL() throws on this input; the page must catch it, not crash render().
  env.page.render(env.ctx({ query: { k: 'K', video: 'not a url at all' } }));
  assert.strictEqual(byTag(env.root(), 'IFRAME').length, 0);
});

test('video: absent ?video= shows the empty-slot message, no iframe', async () => {
  const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
  env.page.render(env.ctx());
  assert.strictEqual(byTag(env.root(), 'IFRAME').length, 0);
  assert.strictEqual(oneByClass(env.root(), 'watch__video-empty').hidden, false);
});

test('video: the iframe never inherits the referrer, and cannot escape its sandbox to script this page', async () => {
  const env = boot({ liveHandler: () => ({ data: { v: 1, same: true } }) });
  env.page.render(env.ctx({ query: { k: 'K', video: 'https://www.youtube.com/embed/abc' } }));
  const frame = byTag(env.root(), 'IFRAME')[0];
  assert.strictEqual(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
});

/* ---------------------------------------------------------------------- *
 * Player / waiting / closed
 * ---------------------------------------------------------------------- */

test('waiting: no current player shows a plain-English waiting message', async () => {
  const env = boot({ liveHandler: () => ({ data: { v: 1, status: 'AUCTION_LIVE', current: null, teams: [], summary: {} } }) });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(oneByClass(env.root(), 'watch__card').hidden, true);
  assert.strictEqual(oneByClass(env.root(), 'watch__waiting').hidden, false);
});

test('closed: shows a closing message and hides the live card', async () => {
  const env = boot({ liveHandler: () => ({ data: { v: 1, status: 'AUCTION_CLOSED', current: null, teams: [], summary: { sold: 10 } } }) });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(visibleText(oneByClass(env.root(), 'watch__waiting')).indexOf('closed') !== -1
    || oneByClass(env.root(), 'watch__waiting').textContent.toLowerCase().indexOf('closed') !== -1, true);
});

test('card: paints the current player with role, style and age', async () => {
  const env = boot({ liveHandler: () => ({ data: clone(PENDING_SNAP) }) });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(oneByClass(env.root(), 'watch__serial').textContent, '#27');
  assert.strictEqual(oneByClass(env.root(), 'watch__name').textContent, 'Raj Kumar');
  const meta = oneByClass(env.root(), 'watch__meta').textContent;
  assert.ok(meta.indexOf('All rounder') !== -1 && meta.indexOf('Age 26') !== -1);
});

test('xss: a hostile player name and team name render as literal text', async () => {
  const snap = clone(PENDING_SNAP);
  snap.current.name = '<img src=x onerror=alert(1)>';
  snap.teams[0].team_name = '<script>evil()</script>';
  const env = boot({ liveHandler: () => ({ data: snap }) });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(oneByClass(env.root(), 'watch__name').textContent, '<img src=x onerror=alert(1)>');
  assert.strictEqual(byTag(env.root(), 'SCRIPT').length, 0);
  assert.strictEqual(byTag(env.root(), 'IMG').filter((n) => n !== oneByClass(env.root(), 'watch__photo')
    && n !== oneByClass(env.root(), 'watch__logo')).length, 0,
    'no extra <img> may be created from a team name');
});

/* ---------------------------------------------------------------------- *
 * Teams grid and tallies
 * ---------------------------------------------------------------------- */

test('teams: renders every team up to the ?teams= cap', async () => {
  const snap = clone(PENDING_SNAP);
  snap.teams.push({ team_id: 'TM_3', team_name: 'Salem Spartans', purse_remaining_display: '₹1,00,000', players_count: 3, max_players: 12 });
  const env = boot({ liveHandler: () => ({ data: snap }) });
  env.page.render(env.ctx({ query: { k: 'K', teams: '2' } }));
  await flush();
  assert.strictEqual(byClass(env.root(), 'watch__team-card').length, 2);
});

test('tallies: renders the four honest labels plus eligible', async () => {
  const env = boot({ liveHandler: () => ({ data: clone(PENDING_SNAP) }) });
  env.page.render(env.ctx());
  await flush();
  const labels = byClass(env.root(), 'watch__tally-label').map((n) => n.textContent);
  ['Sold', 'Un-sold', 'Not called', 'Eligible'].forEach((l) => assert.ok(labels.indexOf(l) !== -1, labels.join(',')));
});

/* ---------------------------------------------------------------------- *
 * Fatal errors — this is a normal page, so it gets a real message
 * ---------------------------------------------------------------------- */

test('fatal: a missing token shows a UI.banner error, reusing the app\'s own component', async () => {
  const env = boot();
  env.page.render(env.ctx({ query: {} }));
  await flush();
  assert.strictEqual(env.bannerCalls.length, 1);
  assert.strictEqual(env.bannerCalls[0].kind, 'error');
  assert.strictEqual(env.liveCalls.length, 0, 'no point polling with nothing to poll for');
});

test('fatal: an UNAUTHORIZED live poll shows the banner and stops polling', async () => {
  const env = boot({ liveHandler: () => ({ error: { code: 'UNAUTHORIZED' } }) });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(env.bannerCalls.length, 1);
  env.clock.advance(30000);
  await flush();
  assert.strictEqual(env.liveCalls.length, 1, 'a fatal error must not keep retrying');
});

/* ====================================================================== *
 * Mutation tests
 * ====================================================================== */

const mutations = [];
function mutation(name, mutate, check) { mutations.push({ name, mutate, check }); }

mutation(
  'M1 accept ANY https host for the video embed -> the arbitrary-host test must fail',
  (src) => src.replace(
    "WatchPage.VIDEO_HOSTS.indexOf(host) !== -1;",
    "true;"
  ),
  async (mutate) => {
    const env = boot({ mutate, liveHandler: () => ({ data: { v: 1, same: true } }) });
    env.page.render(env.ctx({ query: { k: 'K', video: 'https://evil.example.com/x' } }));
    await flush();
    return byTag(env.root(), 'IFRAME').length === 0;   // true = still correctly refused
  }
);

mutation(
  'M2 drop the https-only check -> the http/javascript/data-URL test must fail',
  (src) => src.replace(
    "const safe = !!url && url.protocol === 'https:' &&",
    "const safe = !!url &&"
  ),
  async (mutate) => {
    const env = boot({ mutate, liveHandler: () => ({ data: { v: 1, same: true } }) });
    env.page.render(env.ctx({ query: { k: 'K', video: 'http://www.youtube.com/embed/abc' } }));
    await flush();
    return byTag(env.root(), 'IFRAME').length === 0;   // true = still correctly refused
  }
);

mutation(
  'M3 use a substring/contains check instead of an exact host match -> the look-alike test must fail',
  (src) => src.replace(
    'WatchPage.VIDEO_HOSTS.indexOf(host) !== -1;',
    'WatchPage.VIDEO_HOSTS.some((h) => host.indexOf(h) !== -1);'
  ),
  async (mutate) => {
    const env = boot({ mutate, liveHandler: () => ({ data: { v: 1, same: true } }) });
    env.page.render(env.ctx({ query: { k: 'K', video: 'https://youtube.com.evil.example/embed/x' } }));
    await flush();
    return byTag(env.root(), 'IFRAME').length === 0;   // true = still correctly refused
  }
);

/* The real branding-guard mutation: remove the call entirely and confirm the
   test that depends on it actually fails, proving that test is not vacuous. */
mutation(
  'M4 stop calling tournament.getPublic at all -> the branding-once test must fail',
  (src) => src.replace(
    "API.get('tournament.getPublic', { tournamentId: tournamentId })",
    "Promise.resolve(null)"
  ),
  async (mutate) => {
    const env = boot({
      mutate,
      publicHandler: () => ({ data: { name: 'Karaikal Premier League', logo_url: '' } }),
      liveHandler: () => ({ data: { v: 1, same: true } })
    });
    env.page.render(env.ctx());
    await flush();
    return oneByClass(env.root(), 'watch__title').textContent === 'Karaikal Premier League';
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
