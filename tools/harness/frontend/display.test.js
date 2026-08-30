'use strict';
/**
 * test.js — behavioural tests for frontend/js/pages/display.js.
 *
 * Run:  node /tmp/display-harness/test.js
 *
 * No dependencies, no framework. Each test boots a fresh vm context with the
 * fake DOM, a fake clock and a stubbed API, evaluates the real page file
 * unmodified, and drives it the way the router and the browser would.
 *
 * The last block MUTATES the source and asserts that named tests then FAIL.
 * A test that still passes against broken code is not a test.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const {
  Element, walk, byClass, oneByClass, visibleText, makeClock, flush
} = require('./fakedom');

const REPO = '/Users/raja.t/cricket-auction';
const SRC_PATH = path.join(REPO, 'frontend/js/pages/display.js');
const CSS_PATH = path.join(REPO, 'frontend/css/display.css');
const APP_CSS_PATH = path.join(REPO, 'frontend/css/app.css');
const SOURCE = fs.readFileSync(SRC_PATH, 'utf8');

/* ====================================================================== *
 * Boot one isolated page
 * ====================================================================== */

function boot(opts) {
  const options = opts || {};
  const clock = makeClock();

  /* ---- document ---------------------------------------------------- */
  const body = new Element('body');
  const html = new Element('html');
  const appRoot = new Element('div');
  appRoot.id = 'app';
  body.appendChild(appRoot);

  const document = {
    title: '',
    body: body,
    documentElement: html,
    hidden: false,
    fullscreenElement: null,
    _listeners: {},
    createElement: (tag) => new Element(tag),
    getElementById: (id) => (id === 'app' ? appRoot : null),
    addEventListener(type, fn) {
      (document._listeners[type] = document._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = document._listeners[type];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    },
    dispatch(type, ev) {
      (document._listeners[type] || []).slice().forEach((fn) => fn(ev || {}));
    },
    listenerCount(type) { return (document._listeners[type] || []).length; }
  };

  /* ---- API stub ---------------------------------------------------- */
  const api = {
    lastVersion: null,
    calls: [],
    /** (action, params, nth) -> {data} | {error} */
    handler: options.handler || (() => ({ data: { v: 1, same: true } })),
    get(action, params, callOpts) {
      api.calls.push({
        action,
        params: JSON.parse(JSON.stringify(params || {})),
        opts: callOpts || null
      });
      const answer = api.handler(action, params, api.calls.length) || {};
      if (Object.prototype.hasOwnProperty.call(answer, 'error')) {
        return Promise.reject(answer.error);
      }
      if (answer.data && typeof answer.data.v === 'number') api.lastVersion = answer.data.v;
      return Promise.resolve(answer.data);
    },
    call() { throw new Error('display.js must never POST — it is read-only'); }
  };

  /* ---- Image recorder ---------------------------------------------- */
  const images = [];
  function Image() {
    const self = this;
    self.decoding = '';
    Object.defineProperty(self, 'src', {
      set(v) { self._src = v; images.push(String(v)); },
      get() { return self._src; }
    });
  }

  const windowObj = {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    location: { origin: 'https://example.test', pathname: '/', search: '' }
  };

  const sandbox = {
    document, window: windowObj, Image, console,
    CONFIG: { POLL_INTERVAL_MS: 2000 },
    API: api,
    UI: { money: (n) => '₹' + String(n) },
    Promise, Date, Math, Object, Array, String, Number, Boolean, JSON,
    isFinite, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);

  const source = options.mutate ? options.mutate(SOURCE) : SOURCE;
  vm.runInContext(source + '\n;this.__page = DisplayPage;', sandbox, { filename: 'display.js' });

  return {
    page: sandbox.__page, document, body, appRoot, api, images, clock,
    root: () => appRoot.childNodes[0],
    ctx: (over) => Object.assign({
      path: '/auction/TRN_x/display',
      params: { tournamentId: 'TRN_x' },
      query: { k: 'KEY123' },
      pattern: '/auction/:tournamentId/display'
    }, over || {})
  };
}

/* ====================================================================== *
 * Fixtures
 * ====================================================================== */

const SNAP_V2 = {
  v: 2,
  status: 'AUCTION_LIVE',
  tournament_name: 'Summer Cup',
  current: {
    player_id: 'PLY_1', serial_no: 27, name: 'Raj Kumar', role: 'ALL_ROUNDER',
    style: 'RIGHT', age_years: 26, photo_thumb_url: 'https://img.test/27.jpg',
    auction_status: 'PENDING', team_name: '', sold_amount_display: ''
  },
  teams: [
    {
      team_id: 'TM_1', team_name: 'Chennai Warriors', purse_remaining: 550000,
      purse_remaining_display: '₹5,50,000', players_count: 7, max_players: 12,
      per_slot_remaining_display: '₹1,10,000'
    },
    {
      team_id: 'TM_2', team_name: 'Madurai Kings', purse_remaining: 320000,
      purse_remaining_display: '₹3,20,000', players_count: 9, max_players: 12
    }
  ],
  summary: {
    eligible: 100, sold: 72, unsold: 18, pending_called: 4, not_called: 6,
    total_spent_display: '₹42,10,000'
  }
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/* ====================================================================== *
 * Runner
 * ====================================================================== */

const only = process.argv[2] || '';
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------------------------------------------------------------------- *
 * 1. The poll fires at the contracted interval
 * ---------------------------------------------------------------------- */

test('poll: first request is immediate and carries tournamentId + k', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });
  env.page.render(env.ctx());
  await flush();

  assert.strictEqual(env.api.calls.length, 1, 'the first poll must not wait 2s');
  assert.strictEqual(env.api.calls[0].action, 'auction.displayState');
  assert.strictEqual(env.api.calls[0].params.tournamentId, 'TRN_x');
  assert.strictEqual(env.api.calls[0].params.k, 'KEY123');
  assert.strictEqual(env.api.calls[0].params.v, undefined,
    'the first poll has no version to send');
  assert.strictEqual(env.api.calls[0].opts.retryBusy, false,
    'the SYSTEM_BUSY sleep would stack requests on a 2s loop');
});

test('poll: repeats every 2000 ms and sends back the version it holds', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });
  env.page.render(env.ctx());
  await flush();

  assert.ok(env.clock.delays().includes(2000),
    'a 2000 ms poll timer must be armed, saw ' + JSON.stringify(env.clock.delays()));

  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls.length, 2, 'second poll at t=2000');
  assert.strictEqual(env.api.calls[1].params.v, 2,
    'the poll must send the version it already has, or the server cannot answer {same:true}');

  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls.length, 3, 'third poll at t=4000');

  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls.length, 4, 'fourth poll at t=6000');
});

/* ---------------------------------------------------------------------- *
 * 2. {same:true} does not re-render
 * ---------------------------------------------------------------------- */

test('same:true does not repaint', async () => {
  let nth = 0;
  const env = boot({
    handler: () => {
      nth += 1;
      return nth === 1 ? { data: clone(SNAP_V2) } : { data: { v: 2, same: true } };
    }
  });

  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(env.page._paints, 1, 'the first snapshot paints once');

  for (let i = 0; i < 5; i++) { env.clock.advance(2000); await flush(); }

  assert.strictEqual(env.api.calls.length, 6, 'it kept polling');
  assert.strictEqual(env.page._paints, 1,
    'five unchanged polls must not repaint — repainting restarts the 200ms fade');

  const name = oneByClass(env.root(), 'display-name');
  assert.strictEqual(name.textContent, 'Raj Kumar', 'and the screen still shows the player');
});

test('a changed snapshot does repaint', async () => {
  let nth = 0;
  const env = boot({
    handler: () => {
      nth += 1;
      if (nth === 1) return { data: clone(SNAP_V2) };
      const next = clone(SNAP_V2);
      next.v = 3;
      next.current.auction_status = 'SOLD';
      next.current.team_name = 'Chennai Warriors';
      next.current.sold_amount_display = '₹1,20,000';
      return { data: next };
    }
  });

  env.page.render(env.ctx());
  await flush();
  env.clock.advance(2000);
  await flush();

  assert.strictEqual(env.page._paints, 2);
  const pill = oneByClass(env.root(), 'status');
  assert.ok(pill.classList.contains('status--sold'), 'pill turned green');
  assert.strictEqual(oneByClass(env.root(), 'display-amount').textContent, '₹1,20,000');
});

/* ---------------------------------------------------------------------- *
 * 3. Back-off doubles to a 15 s ceiling and says so on screen
 * ---------------------------------------------------------------------- */

test('failure: back-off doubles 2->4->8->15 and stops there', async () => {
  let ok = true;
  const env = boot({
    handler: () => (ok
      ? { data: clone(SNAP_V2) }
      : { error: { code: 'NETWORK', message: 'offline' } })
  });

  env.page.render(env.ctx());
  await flush();
  assert.ok(env.clock.delays().includes(2000));

  ok = false;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    // Run the armed poll timer, whatever its delay is.
    const armed = env.clock.delays().filter((d) => d !== env.page.HINT_MS);
    env.clock.advance(Math.max(...armed));
    await flush();
    seen.push(env.page._state.delay);
  }

  assert.deepStrictEqual(seen, [4000, 8000, 15000, 15000, 15000, 15000],
    'back-off must double and then hold at the 15s ceiling, saw ' + JSON.stringify(seen));
});

test('failure: an amber reconnecting indicator appears, with a word not just a colour', async () => {
  let ok = true;
  const env = boot({
    handler: () => (ok
      ? { data: clone(SNAP_V2) }
      : { error: { code: 'NETWORK', message: 'offline' } })
  });

  env.page.render(env.ctx());
  await flush();

  const link = oneByClass(env.root(), 'display__link');
  assert.strictEqual(link.dataset.state, 'live');
  assert.strictEqual(oneByClass(env.root(), 'display__link-text').textContent, 'Live');

  ok = false;
  env.clock.advance(2000);
  await flush();

  assert.strictEqual(link.dataset.state, 'reconnecting',
    'the indicator must change state, not just colour');
  assert.ok(/Reconnecting/.test(oneByClass(env.root(), 'display__link-text').textContent),
    'and it must say the word');
  assert.strictEqual(oneByClass(env.root(), 'display__link-mark').textContent, '⚠',
    'and carry a shape');

  // The stale figures stay on screen, but they are no longer claimed to be live.
  assert.strictEqual(oneByClass(env.root(), 'display-name').textContent, 'Raj Kumar');
});

test('recovery: one success resets the interval and the indicator', async () => {
  let mode = 'ok';
  const env = boot({
    handler: () => (mode === 'ok'
      ? { data: clone(SNAP_V2) }
      : { error: { code: 'NETWORK', message: 'offline' } })
  });

  env.page.render(env.ctx());
  await flush();

  mode = 'fail';
  for (let i = 0; i < 4; i++) {
    const armed = env.clock.delays().filter((d) => d !== env.page.HINT_MS);
    env.clock.advance(Math.max(...armed));
    await flush();
  }
  assert.strictEqual(env.page._state.delay, 15000, 'it is at the ceiling');

  mode = 'ok';
  env.clock.advance(15000);
  await flush();

  assert.strictEqual(env.page._state.delay, 2000,
    'one good poll must return the screen to a 2s cadence');
  assert.strictEqual(env.page._state.fails, 0);
  assert.strictEqual(oneByClass(env.root(), 'display__link').dataset.state, 'live');

  const before = env.api.calls.length;
  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls.length, before + 1, 'and it really is polling at 2s again');
});

/* ---------------------------------------------------------------------- *
 * 4. Visibility
 * ---------------------------------------------------------------------- */

test('visibility: hiding the tab stops the poll, showing it resumes immediately', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });
  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(env.api.calls.length, 1);

  env.document.hidden = true;
  env.document.dispatch('visibilitychange');

  assert.ok(!env.clock.delays().includes(2000),
    'the poll timer must be disarmed while hidden');

  env.clock.advance(60000);
  await flush();
  assert.strictEqual(env.api.calls.length, 1,
    'a hidden tab must not poll — that quota belongs to the live auction');

  env.document.hidden = false;
  env.document.dispatch('visibilitychange');
  await flush();

  assert.strictEqual(env.api.calls.length, 2,
    'showing the tab must catch up at once, not on the next tick');

  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls.length, 3, 'and the 2s loop is running again');
});

/* ---------------------------------------------------------------------- *
 * 5. Re-render must not leak a timer or a listener
 * ---------------------------------------------------------------------- */

test('render twice: exactly one poll loop and one set of listeners survive', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });

  env.page.render(env.ctx());
  await flush();
  assert.strictEqual(env.document.listenerCount('keydown'), 1);
  assert.strictEqual(env.document.listenerCount('visibilitychange'), 1);

  env.page.render(env.ctx());
  await flush();

  assert.strictEqual(env.document.listenerCount('keydown'), 1,
    'a leaked keydown handler would fire F and R twice');
  assert.strictEqual(env.document.listenerCount('visibilitychange'), 1);

  const pollTimers = env.clock.delays().filter((d) => d === 2000);
  assert.strictEqual(pollTimers.length, 1,
    'two armed poll timers means the poll rate has doubled, saw ' +
    JSON.stringify(env.clock.delays()));

  const before = env.api.calls.length;
  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls.length, before + 1,
    'one tick must produce exactly one request');
});

/* ---------------------------------------------------------------------- *
 * 6. A hostile player name is literal text
 * ---------------------------------------------------------------------- */

test('xss: a hostile name renders as text, never as markup', async () => {
  const hostile = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
  const snap = clone(SNAP_V2);
  snap.current.name = hostile;
  snap.teams[0].team_name = '<b>Boom</b>';

  const env = boot({ handler: () => ({ data: snap }) });
  env.page.render(env.ctx());
  await flush();

  const name = oneByClass(env.root(), 'display-name');
  assert.strictEqual(name.textContent, hostile,
    'the name must survive verbatim');
  assert.strictEqual(name.childNodes.length, 1);
  assert.strictEqual(name.childNodes[0].nodeType, 3,
    'it must be ONE text node — any element child means innerHTML was used');

  // Nothing anywhere in the tree became an element it should not be.
  const tags = walk(env.root()).map((n) => n.tagName);
  assert.ok(tags.indexOf('SCRIPT') === -1, 'no <script> was created');
  assert.ok(tags.indexOf('B') === -1, 'no <b> was created from a team name');

  const team = oneByClass(env.root(), 'display__team-name');
  assert.strictEqual(team.textContent, '<b>Boom</b>');
});

test('xss: the source file contains no innerHTML assignment at all', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML/.test(code),
    'innerHTML must not appear outside comments');
  assert.ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(code));
});

/* ---------------------------------------------------------------------- *
 * 7. Status pills: colour + word + shape
 * ---------------------------------------------------------------------- */

test('status pill: every status carries a word AND a shape AND a colour class', async () => {
  const cases = [
    ['PENDING', 'Pending', '●', 'status--pending'],
    ['SOLD', 'Sold', '✓', 'status--sold'],
    ['UNSOLD', 'Un-sold', '✕', 'status--unsold']
  ];

  for (const [wire, word, mark, cls] of cases) {
    const snap = clone(SNAP_V2);
    snap.current.auction_status = wire;
    const env = boot({ handler: () => ({ data: snap }) });
    env.page.render(env.ctx());
    await flush();

    const pill = oneByClass(env.root(), 'status');
    assert.ok(pill, wire + ': a pill must exist');
    assert.strictEqual(pill.hidden, false, wire + ': the pill must be visible');
    assert.ok(pill.classList.contains(cls), wire + ': the colour class is ' + cls);
    assert.strictEqual(oneByClass(pill, 'status__word').textContent, word,
      wire + ': the WORD must be present, colour is never the only signal');
    assert.strictEqual(oneByClass(pill, 'status__mark').textContent, mark,
      wire + ': the SHAPE must be a real node, not only a ::before');
    assert.strictEqual(oneByClass(pill, 'status__mark').getAttribute('aria-hidden'), 'true',
      wire + ': the glyph is decorative; the word is the accessible text');
  }
});

test('status pill: UN-SOLD is slate, never red (DESIGN §8)', () => {
  const css = fs.readFileSync(APP_CSS_PATH, 'utf8');
  assert.ok(/--status-unsold-bg:\s*#475569/.test(css), 'slate');
  assert.ok(/--status-pending-bg:\s*#B45309/.test(css), 'amber');
  assert.ok(/--status-sold-bg:\s*#15803D/.test(css), 'green');

  const mine = fs.readFileSync(CSS_PATH, 'utf8');
  assert.ok(!/--status-unsold-bg\s*:/.test(mine),
    'display.css must REUSE the status tokens, never redefine them');
  assert.ok(!/--proj-bg\s*:/.test(mine), 'and must not redefine the projector tokens');
});

/* ---------------------------------------------------------------------- *
 * 8. Bad token / missing token / no player / closed
 * ---------------------------------------------------------------------- */

test('no key in the address: a message, never a blank screen, and no poll at all', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });
  env.page.render(env.ctx({ query: {} }));
  await flush();

  assert.strictEqual(env.api.calls.length, 0,
    'there is nothing to ask the server without a key');

  const msg = oneByClass(env.root(), 'display__message');
  assert.strictEqual(msg.hidden, false);
  assert.ok(/display key/i.test(msg.textContent), 'it explains what is missing');
  assert.ok(visibleText(env.root()).trim().length > 40, 'the screen is not blank');
  assert.strictEqual(oneByClass(env.root(), 'display__link').dataset.state, 'stopped');
});

test('bad key: UNAUTHORIZED shows a message and stops polling', async () => {
  const env = boot({
    handler: () => ({ error: { code: 'UNAUTHORIZED', message: 'nope' } })
  });
  env.page.render(env.ctx({ query: { k: 'WRONG' } }));
  await flush();

  assert.strictEqual(env.api.calls.length, 1);

  const msg = oneByClass(env.root(), 'display__message');
  assert.strictEqual(msg.hidden, false, 'the message card is showing');
  assert.strictEqual(oneByClass(env.root(), 'display__card').hidden, true,
    'and the player card is not');
  assert.ok(/not valid/i.test(msg.textContent), 'in plain words: ' + msg.textContent);
  assert.ok(visibleText(env.root()).trim().length > 40, 'the screen is not blank');

  env.clock.advance(120000);
  await flush();
  assert.strictEqual(env.api.calls.length, 1,
    'a bad key never fixes itself; retrying it for three hours only burns quota');
});

test('no current player: the tournament name and "Waiting for the first player"', async () => {
  const snap = clone(SNAP_V2);
  snap.current = null;
  const env = boot({ handler: () => ({ data: snap }) });
  env.page.render(env.ctx());
  await flush();

  const msg = oneByClass(env.root(), 'display__message');
  assert.strictEqual(msg.hidden, false);
  assert.strictEqual(oneByClass(env.root(), 'display__message-title').textContent, 'Summer Cup');
  assert.strictEqual(oneByClass(env.root(), 'display__message-body').textContent,
    'Waiting for the first player');
  // The standings are still useful before the first call.
  assert.strictEqual(byClass(env.root(), 'display__team-cell').length, 2);
});

test('auction closed: the final summary replaces the player card', async () => {
  const snap = clone(SNAP_V2);
  snap.status = 'AUCTION_CLOSED';
  const env = boot({ handler: () => ({ data: snap }) });
  env.page.render(env.ctx());
  await flush();

  assert.strictEqual(oneByClass(env.root(), 'display__card').hidden, true);
  assert.strictEqual(oneByClass(env.root(), 'display__message-title').textContent,
    'Auction closed');
  const body = oneByClass(env.root(), 'display__message-body').textContent;
  assert.ok(/72 players sold/.test(body), body);
  assert.ok(/₹42,10,000/.test(body), body);
  assert.ok(/6 not called/.test(body), body);
  assert.strictEqual(oneByClass(env.root(), 'display__phase').textContent, 'Auction closed');
});

/* ---------------------------------------------------------------------- *
 * 9. Standings, summary, pre-warming, keyboard
 * ---------------------------------------------------------------------- */

test('standings strip: purse remaining and players count / max', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });
  env.page.render(env.ctx());
  await flush();

  const cells = byClass(env.root(), 'display__team-cell');
  assert.strictEqual(cells.length, 2);
  assert.strictEqual(oneByClass(cells[0], 'display__team-name').textContent, 'Chennai Warriors');
  assert.strictEqual(oneByClass(cells[0], 'display__team-purse').textContent, '₹5,50,000');
  assert.strictEqual(oneByClass(cells[0], 'display__team-count').textContent, '7 / 12');
  assert.strictEqual(oneByClass(cells[0], 'display__team-slot').textContent, '₹1,10,000 per slot');
  assert.strictEqual(oneByClass(cells[1], 'display__team-slot'), null,
    'an absent per-slot figure must not render an empty node');

  const summary = visibleText(oneByClass(env.root(), 'display__summary'));
  ['72', 'SOLD', '18', '6', 'Not called', '₹42,10,000'].forEach((needle) => {
    assert.ok(summary.toLowerCase().includes(String(needle).toLowerCase()),
      'summary should mention ' + needle + ' — got: ' + summary);
  });
});

test('pre-warm: the current thumbnail is fetched once, and a roster is fetched in full', async () => {
  let nth = 0;
  const env = boot({
    handler: () => {
      nth += 1;
      if (nth === 1) {
        const s = clone(SNAP_V2);
        s.roster = [
          { photo_thumb_url: 'https://img.test/1.jpg' },
          { photo_thumb_url: 'https://img.test/2.jpg' }
        ];
        return { data: s };
      }
      const s = clone(SNAP_V2);
      s.v = 3;
      s.current.serial_no = 28;
      s.current.player_id = 'PLY_2';
      s.current.photo_thumb_url = 'https://img.test/1.jpg';   // already warm
      return { data: s };
    }
  });

  env.page.render(env.ctx());
  await flush();

  assert.deepStrictEqual(env.images.sort(), [
    'https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/27.jpg'
  ], 'current + roster, all warmed up front');

  const beforeCount = env.images.length;
  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.images.length, beforeCount,
    'an already-warmed URL must not be fetched a second time');
});

test('keyboard: R forces an immediate poll and clears the back-off; F is fullscreen only', async () => {
  let ok = true;
  let fullscreenAsked = 0;
  const env = boot({
    handler: () => (ok
      ? { data: clone(SNAP_V2) }
      : { error: { code: 'NETWORK', message: 'offline' } })
  });
  env.document.documentElement.requestFullscreen = () => {
    fullscreenAsked += 1;
    return Promise.resolve();
  };

  env.page.render(env.ctx());
  await flush();

  ok = false;
  for (let i = 0; i < 4; i++) {
    const armed = env.clock.delays().filter((d) => d !== env.page.HINT_MS);
    env.clock.advance(Math.max(...armed));
    await flush();
  }
  assert.strictEqual(env.page._state.delay, 15000);

  ok = true;
  const before = env.api.calls.length;
  env.document.dispatch('keydown', { key: 'r', preventDefault() {} });
  await flush();

  assert.strictEqual(env.api.calls.length, before + 1, 'R polls right now');
  assert.strictEqual(env.page._state.delay, 2000, 'and drops the back-off');

  env.document.dispatch('keydown', { key: 'F', preventDefault() {} });
  assert.strictEqual(fullscreenAsked, 1, 'F asks for fullscreen');

  const after = env.api.calls.length;
  env.document.dispatch('keydown', { key: 'x', preventDefault() {} });
  env.document.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await flush();
  assert.strictEqual(env.api.calls.length, after, 'no other key does anything');
});

test('keyboard: a modified R (Ctrl+R / Cmd+R) is left to the browser', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });
  env.page.render(env.ctx());
  await flush();

  const before = env.api.calls.length;
  env.document.dispatch('keydown', { key: 'r', ctrlKey: true, preventDefault() {} });
  env.document.dispatch('keydown', { key: 'r', metaKey: true, preventDefault() {} });
  await flush();
  assert.strictEqual(env.api.calls.length, before,
    'Ctrl+R must still reload the page, not be swallowed');
});

test('hint: it is shown, then fades', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });
  env.page.render(env.ctx());
  await flush();

  const hint = oneByClass(env.root(), 'display__hint');
  assert.ok(/fullscreen/i.test(hint.textContent) && /refresh/i.test(hint.textContent));
  assert.strictEqual(hint.classList.contains('is-faded'), false);

  env.clock.advance(env.page.HINT_MS);
  await flush();
  assert.strictEqual(hint.classList.contains('is-faded'), true, 'it fades out on its own');
});

test('route: document.body.dataset.route is "display"', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP_V2) }) });
  env.page.render(env.ctx());
  assert.strictEqual(env.body.dataset.route, 'display',
    'app.css scopes the whole projector theme on this attribute');
});

test('read-only: display.js references no action other than auction.displayState', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const actions = code.match(/'[a-z]+\.[a-zA-Z]+'/g) || [];
  assert.deepStrictEqual([...new Set(actions)], ["'auction.displayState'"],
    'the projector must call nothing else — it is read-only');
  assert.ok(!/API\.call\s*\(/.test(code), 'no POST');
  assert.ok(!/\bfetch\s*\(/.test(code), 'every call goes through API');
});

test('css: scoped, fluid, system-font-only, inside the safe area', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

  assert.ok(!/@font-face|@import|https?:\/\//.test(rules),
    'no web font, no import, no CDN — nothing that can fail on venue wifi');

  // Every selector must be scoped to the display route.
  const selectors = rules
    .split('}')
    .map((block) => block.split('{')[0].trim())
    .filter((s) => s && !s.startsWith('@') && !s.startsWith('/'));
  selectors.forEach((sel) => {
    sel.split(',').map((s) => s.trim()).filter(Boolean).forEach((one) => {
      assert.ok(one.indexOf('body[data-route="display"]') === 0,
        'unscoped selector would leak into other pages: ' + one);
    });
  });

  assert.ok(/clamp\(/.test(rules), 'type must be fluid');
  assert.ok(!/font-size:\s*\d+px\s*;/.test(rules),
    'no fixed-pixel font size — everything scales with the viewport');
  assert.ok(/100vw/.test(rules) === false,
    '100vw would put content back inside the projector crop zone');
});

/* ====================================================================== *
 * MUTATION TESTS — break the code, prove the tests notice
 * ====================================================================== */

const mutations = [
  {
    name: 'M1 remove the {same:true} guard -> the "same:true does not repaint" test must fail',
    mutate: (s) => s.replace(
      'if (snap.same !== true) DisplayPage._paint(state, snap);',
      'DisplayPage._paint(state, snap);'),
    check: async (boot2) => {
      let nth = 0;
      const env = boot2({
        handler: () => {
          nth += 1;
          return nth === 1 ? { data: clone(SNAP_V2) } : { data: { v: 2, same: true } };
        }
      });
      env.page.render(env.ctx());
      await flush();
      for (let i = 0; i < 5; i++) { env.clock.advance(2000); await flush(); }
      assert.strictEqual(env.page._paints, 1);
    }
  },
  {
    name: 'M2 remove the 15s back-off ceiling -> the back-off test must fail',
    mutate: (s) => s.replace(
      'state.delay = Math.min(state.delay * 2, DisplayPage.MAX_POLL_MS);',
      'state.delay = state.delay * 2;'),
    check: async (boot2) => {
      const env = boot2({ handler: () => ({ error: { code: 'NETWORK', message: 'x' } }) });
      env.page.render(env.ctx());
      await flush();
      const seen = [];
      for (let i = 0; i < 6; i++) {
        const armed = env.clock.delays().filter((d) => d !== env.page.HINT_MS);
        if (!armed.length) break;
        env.clock.advance(Math.max(...armed));
        await flush();
        seen.push(env.page._state.delay);
      }
      assert.deepStrictEqual(seen, [4000, 8000, 15000, 15000, 15000, 15000]);
    }
  },
  {
    name: 'M3 drop the teardown in render() -> the double-render test must fail',
    mutate: (s) => s.replace('    DisplayPage._teardown();\n\n    const gen',
      '    const gen'),
    check: async (boot2) => {
      const env = boot2({ handler: () => ({ data: clone(SNAP_V2) }) });
      env.page.render(env.ctx());
      await flush();
      env.page.render(env.ctx());
      await flush();
      assert.strictEqual(env.document.listenerCount('keydown'), 1);
      assert.strictEqual(env.clock.delays().filter((d) => d === 2000).length, 1);
    }
  },
  {
    name: 'M4 write the player name with innerHTML -> the xss tests must fail',
    mutate: (s) => s.replace(
      '    if (node.textContent !== value) node.textContent = value;',
      '    if (node.textContent !== value) node.innerHTML = value;'),
    check: async (boot2, mutate) => {
      // (a) the source-level guard must notice
      const code = mutate(SOURCE)
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/innerHTML/.test(code), 'innerHTML must not appear outside comments');
    }
  },
  {
    name: 'M5 stop honouring document.hidden -> the visibility test must fail',
    mutate: (s) => s.replace('      if (document.hidden) {', '      if (false) {'),
    check: async (boot2) => {
      const env = boot2({ handler: () => ({ data: clone(SNAP_V2) }) });
      env.page.render(env.ctx());
      await flush();
      env.document.hidden = true;
      env.document.dispatch('visibilitychange');
      env.clock.advance(60000);
      await flush();
      assert.strictEqual(env.api.calls.length, 1);
    }
  }
];

/* ====================================================================== *
 * Go
 * ====================================================================== */

(async function main() {
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
    const boot2 = (o) => boot(Object.assign({}, o, { mutate: m.mutate }));
    let caught = null;
    try {
      await m.check(boot2, m.mutate);
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
