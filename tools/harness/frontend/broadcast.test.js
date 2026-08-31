'use strict';
/**
 * broadcast.test.js — behavioural tests for frontend/js/broadcast.js.
 *
 * Run:  node tools/harness/frontend/broadcast.test.js
 *       (or `node tools/test.js broadcast`, which is what CI does)
 *
 * No dependencies, no framework. Evaluates the real file unmodified into a vm
 * context with a fake clock and a stubbed API, and drives Broadcast.connect()
 * the way stream.js and watch.js actually do.
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
const SRC_PATH = path.join(REPO, 'frontend/js/broadcast.js');
const SOURCE = fs.readFileSync(SRC_PATH, 'utf8');

/* ====================================================================== *
 * Boot
 * ====================================================================== */

function boot(opts) {
  const options = opts || {};
  const clock = makeClock();

  const documentStub = {
    hidden: false,
    _listeners: {},
    addEventListener(type, fn) {
      (documentStub._listeners[type] = documentStub._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = documentStub._listeners[type];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    },
    dispatch(type) {
      (documentStub._listeners[type] || []).slice().forEach((fn) => fn({}));
    },
    listenerCount(type) { return (documentStub._listeners[type] || []).length; }
  };

  const api = {
    lastVersion: null,
    calls: [],
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
    }
  };

  const windowObj = {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id)
  };

  const sandbox = {
    document: documentStub, window: windowObj, console,
    CONFIG: { POLL_INTERVAL_MS: 2000 },
    API: api,
    UI: { money: (n) => '₹' + String(n) },
    Promise, Date, Math, Object, Array, String, Number, Boolean, JSON,
    isFinite, isNaN, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);

  const source = options.mutate ? options.mutate(SOURCE) : SOURCE;
  vm.runInContext(source + '\n;this.__mod = Broadcast;', sandbox, { filename: 'broadcast.js' });

  return { Broadcast: sandbox.__mod, document: documentStub, api, clock };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

const SNAP = {
  v: 5, same: false, status: 'AUCTION_LIVE', tournament_name: 'Test Cup',
  current: { player_id: 'PLY_1', serial_no: 9, name: 'Player 9', auction_status: 'PENDING' },
  teams: [], summary: { sold: 1, unsold: 0, not_called: 0 }
};

/* ====================================================================== *
 * Runner
 * ====================================================================== */

const only = process.argv[2] || '';
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------------------------------------------------------------------- *
 * The poll
 * ---------------------------------------------------------------------- */

test('connect: first poll is immediate and carries tournamentId + k, no v', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP) }) });
  env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1' });
  await flush();

  assert.strictEqual(env.api.calls.length, 1, 'must not wait for the first timer');
  assert.strictEqual(env.api.calls[0].action, 'auction.displayState');
  assert.strictEqual(env.api.calls[0].params.tournamentId, 'TRN_x');
  assert.strictEqual(env.api.calls[0].params.k, 'K1');
  assert.strictEqual(env.api.calls[0].params.v, undefined);
  assert.strictEqual(env.api.calls[0].opts.retryBusy, false,
    'API\'s own SYSTEM_BUSY sleep would stack requests on a fixed-interval loop');
});

test('connect: {same:true} does not call onSnapshot, but still reschedules', async () => {
  const env = boot({ handler: () => ({ data: { v: 5, same: true } }) });
  let snapshots = 0;
  env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1', onSnapshot: () => { snapshots += 1; } });
  await flush();
  assert.strictEqual(snapshots, 0, 'an unchanged poll must not repaint');
  assert.ok(env.clock.delays().includes(2000), 'the next poll must still be scheduled');
});

test('connect: a changed snapshot is handed to onSnapshot once', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP) }) });
  const seen = [];
  env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1', onSnapshot: (s) => seen.push(s) });
  await flush();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].tournament_name, 'Test Cup');
});

test('connect: the version travels on the NEXT poll only', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP) }) });
  env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1' });
  await flush();
  env.clock.advance(2000);
  await flush();
  assert.strictEqual(env.api.calls[1].params.v, 5, 'must send back the version it now holds');
});

/* ---------------------------------------------------------------------- *
 * Back-off and recovery
 * ---------------------------------------------------------------------- */

test('connect: back-off doubles 4s -> 8s -> 15s and stays capped', async () => {
  // The FIRST poll fires immediately, not on a timer — see the "immediate"
  // test above. So the first thing a failure schedules is 2000*2 = 4000, the
  // same proven sequence display.js's own tests assert for the identical
  // logic (tools/harness/frontend/display.test.js: "back-off doubles
  // 2->4->8->15"; its first observed delay is 4000 for the same reason).
  const env = boot({ handler: () => ({ error: { code: 'NETWORK', message: 'down' } }) });
  const links = [];
  env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1', onLink: (k) => links.push(k) });
  await flush();

  const seenDelays = [];
  for (let i = 0; i < 6; i += 1) {
    const d = env.clock.delays()[0];
    seenDelays.push(d);
    env.clock.advance(d);
    await flush();
  }
  assert.deepStrictEqual(seenDelays, [4000, 8000, 15000, 15000, 15000, 15000],
    'got ' + JSON.stringify(seenDelays));
  assert.ok(links.every((k) => k === 'reconnecting'), 'every failure reports reconnecting');
});

test('connect: recovery resets BOTH the delay and the link state', async () => {
  let fail = true;
  const env = boot({
    handler: () => (fail ? { error: { code: 'NETWORK' } } : { data: clone(SNAP) })
  });
  const links = [];
  env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1', onLink: (k) => links.push(k) });
  await flush();
  env.clock.advance(2000); await flush();
  env.clock.advance(4000); await flush();
  fail = false;
  env.clock.advance(8000); await flush();

  assert.strictEqual(links[links.length - 1], 'live');
  assert.ok(env.clock.delays().includes(2000),
    'one success must reset the interval, not leave it at the back-off ceiling');
});

/* ---------------------------------------------------------------------- *
 * Fatal errors
 * ---------------------------------------------------------------------- */

['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'NOT_CONFIGURED', 'VALIDATION_FAILED']
  .forEach((code) => {
    test('connect: ' + code + ' stops the loop for good, exactly once', async () => {
      const env = boot({ handler: () => ({ error: { code } }) });
      let fatals = 0;
      env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1', onFatal: () => { fatals += 1; } });
      await flush();
      assert.strictEqual(fatals, 1);
      assert.strictEqual(env.clock.count(), 0, 'no timer must survive a fatal error');

      // Nothing brings it back — a hidden/shown cycle must not resurrect it.
      env.document.dispatch('visibilitychange');
      await flush();
      assert.strictEqual(env.api.calls.length, 1, 'a fatal poll never retries');
    });
  });

test('connect: a missing token is fatal without ever calling the API', async () => {
  const env = boot();
  let fatals = 0;
  env.Broadcast.connect({ tournamentId: 'TRN_x', token: '', onFatal: () => { fatals += 1; } });
  await flush();
  assert.strictEqual(fatals, 1);
  assert.strictEqual(env.api.calls.length, 0);
});

/* ---------------------------------------------------------------------- *
 * Visibility pause/resume
 * ---------------------------------------------------------------------- */

test('connect: polling pauses while hidden and catches up instantly on show', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP) }) });
  env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1' });
  await flush();

  env.document.hidden = true;
  env.document.dispatch('visibilitychange');
  assert.strictEqual(env.clock.count(), 0, 'the timer must be cleared while hidden');

  env.document.hidden = false;
  env.document.dispatch('visibilitychange');
  await flush();
  assert.strictEqual(env.api.calls.length, 2, 'showing again polls immediately, not on the next tick');
});

/* ---------------------------------------------------------------------- *
 * forceRefresh and stop
 * ---------------------------------------------------------------------- */

test('forceRefresh: cancels the pending timer, polls now, and resets the ceiling-climb', async () => {
  const env = boot({ handler: () => ({ error: { code: 'NETWORK' } }) });
  const conn = env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1' });
  await flush();
  env.clock.advance(4000); await flush();   // call 2, now backed off to 8000
  env.clock.advance(8000); await flush();   // call 3, now backed off to 15000 (the ceiling)

  conn.forceRefresh();
  await flush();
  assert.strictEqual(env.api.calls.length, 4, 'forceRefresh polls immediately, not on the next tick');

  // The real point of forceRefresh: an operator who presses it after a long
  // outage must not stay parked at the 15s ceiling if this attempt ALSO
  // fails — the climb starts over from the base, exactly as if the outage
  // had just begun.
  assert.deepStrictEqual(env.clock.delays(), [4000],
    'a failed forceRefresh must schedule the FIRST back-off step, not continue climbing from 15s');
});

test('stop: no further polls, no listener left behind', async () => {
  const env = boot({ handler: () => ({ data: clone(SNAP) }) });
  const conn = env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1' });
  await flush();
  assert.strictEqual(env.document.listenerCount('visibilitychange'), 1);

  conn.stop();
  assert.strictEqual(env.clock.count(), 0);
  assert.strictEqual(env.document.listenerCount('visibilitychange'), 0);
  assert.ok(conn.isStopped());

  env.clock.advance(10000);
  await flush();
  assert.strictEqual(env.api.calls.length, 1, 'a stopped connection never polls again');
});

/* ---------------------------------------------------------------------- *
 * Transition edge-detection — this is what lets stream.js fire a SOLD sting
 * exactly once per sale, without re-implementing the comparison itself.
 * ---------------------------------------------------------------------- */

test('_transition: never fires on the very first snapshot, even if already SOLD', async () => {
  // A viewer opening /stream or /watch mid-auction sees the current player
  // already marked SOLD from a sale that happened minutes earlier. That must
  // not play a fresh "just sold" sting purely because it is new to THIS
  // connection — a transition is something that happens WHILE watching.
  const env = boot({ handler: () => ({ data: { v: 1, current: { player_id: 'PLY_1', auction_status: 'SOLD' } } }) });
  const transitions = [];
  env.Broadcast.connect({
    tournamentId: 'TRN_x', token: 'K1',
    onSnapshot: (s) => transitions.push(s._transition)
  });
  await flush();
  assert.deepStrictEqual(transitions, [null]);
});

test('_transition: fires SOLD exactly once when a player is sold', async () => {
  let call = 0;
  const rows = [
    { v: 1, current: { player_id: 'PLY_1', auction_status: 'PENDING' } },
    { v: 2, current: { player_id: 'PLY_1', auction_status: 'SOLD' } },
    { v: 2, same: true }
  ];
  const env = boot({ handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
  const transitions = [];
  env.Broadcast.connect({
    tournamentId: 'TRN_x', token: 'K1',
    onSnapshot: (s) => transitions.push(s._transition)
  });
  await flush();
  env.clock.advance(2000); await flush();
  env.clock.advance(2000); await flush();

  assert.deepStrictEqual(transitions, [null, 'SOLD'],
    'the first snapshot (PENDING) has no transition; SOLD fires once, the repeat (same:true) never arrives at all');
});

test('_transition: a NEW player arriving already SOLD after watching a while is not re-flagged', async () => {
  let call = 0;
  const rows = [
    { v: 1, current: { player_id: 'PLY_1', auction_status: 'PENDING' } },
    { v: 2, current: { player_id: 'PLY_1', auction_status: 'SOLD' } },
    { v: 3, current: { player_id: 'PLY_2', auction_status: 'PENDING' } }
  ];
  const env = boot({ handler: () => ({ data: clone(rows[Math.min(call++, rows.length - 1)]) }) });
  const transitions = [];
  env.Broadcast.connect({
    tournamentId: 'TRN_x', token: 'K1',
    onSnapshot: (s) => transitions.push(s._transition)
  });
  await flush();
  env.clock.advance(2000); await flush();
  env.clock.advance(2000); await flush();

  assert.deepStrictEqual(transitions, [null, 'SOLD', null],
    'the new player (#2) arriving PENDING is not itself a sale');
});

/* ---------------------------------------------------------------------- *
 * Read-only helpers
 * ---------------------------------------------------------------------- */

test('helpers: tournamentName never falls back to a raw id', async () => {
  const env = boot();
  assert.strictEqual(env.Broadcast.tournamentName({ tournament_name: 'Cup' }), 'Cup');
  assert.strictEqual(env.Broadcast.tournamentName({}), 'Auction');
  assert.strictEqual(env.Broadcast.tournamentName(null), 'Auction');
  // No code path may print something that looks like "TRN_xxxx".
  assert.ok(!/TRN_/.test(env.Broadcast.tournamentName({ tournament_id: 'TRN_abc' })));
});

test('helpers: moneyText prefers the server string, UI.money is the fallback', async () => {
  const env = boot();
  assert.strictEqual(env.Broadcast.moneyText('₹5,50,000', 550000), '₹5,50,000');
  assert.strictEqual(env.Broadcast.moneyText('', 550000), '₹550000');
});

test('helpers: setText never touches the DOM when the value is unchanged', async () => {
  const env = boot();
  let writes = 0;
  const node = {
    get textContent() { return this._t || ''; },
    set textContent(v) { writes += 1; this._t = v; }
  };
  env.Broadcast.setText(node, 'same');
  env.Broadcast.setText(node, 'same');
  assert.strictEqual(writes, 1, 'a second identical write must be a no-op');
});

/* ====================================================================== *
 * Mutation tests — each SHOULD fail
 * ====================================================================== */

const mutations = [];
function mutation(name, mutate, check) { mutations.push({ name, mutate, check }); }

mutation(
  'M1 remove the {same:true} guard -> the no-repaint test must fail',
  (src) => src.replace('if (snap.same !== true) {', 'if (true) {'),
  async (mutate) => {
    const env = boot({ mutate, handler: () => ({ data: { v: 5, same: true } }) });
    let n = 0;
    env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1', onSnapshot: () => { n += 1; } });
    await flush();
    return n === 0;
  }
);

mutation(
  'M2 stop sending retryBusy:false -> the fixed-interval test must fail',
  (src) => src.replace("{ retryBusy: false }", "{ retryBusy: true }"),
  async (mutate) => {
    const env = boot({ mutate, handler: () => ({ data: { v: 1, same: true } }) });
    env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1' });
    await flush();
    return env.api.calls[0].opts.retryBusy === false;
  }
);

mutation(
  'M3 cap the back-off at 8s instead of 15s -> the ceiling test must fail',
  (src) => src.replace('Broadcast.MAX_POLL_MS', '8000'),
  async (mutate) => {
    const env = boot({ mutate, handler: () => ({ error: { code: 'NETWORK' } }) });
    env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1' });
    await flush();
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      const d = env.clock.delays()[0];
      seen.push(d);
      env.clock.advance(d);
      await flush();
    }
    return JSON.stringify(seen) === JSON.stringify([2000, 4000, 8000, 15000, 15000, 15000]);
  }
);

mutation(
  'M4 stop clearing the visibility listener on stop() -> the leak test must fail',
  (src) => src.replace(
    "document.removeEventListener('visibilitychange', state.onVisibility);\n        state.onVisibility = null;",
    "/* removed */"
  ),
  async (mutate) => {
    const env = boot({ mutate, handler: () => ({ data: { v: 1, same: true } }) });
    const conn = env.Broadcast.connect({ tournamentId: 'TRN_x', token: 'K1' });
    await flush();
    conn.stop();
    return env.document.listenerCount('visibilitychange') === 0;
  }
);

/* ====================================================================== *
 * Runner
 * ====================================================================== */

mutation(
  'M5 fire a transition on the very first snapshot too -> the mid-join test must fail',
  (src) => src.replace('if (state.hasPainted && (status ===', 'if (true && (status ==='),
  async (mutate) => {
    const env = boot({
      mutate,
      handler: () => ({ data: { v: 1, current: { player_id: 'PLY_1', auction_status: 'SOLD' } } })
    });
    const transitions = [];
    env.Broadcast.connect({
      tournamentId: 'TRN_x', token: 'K1',
      onSnapshot: (s) => transitions.push(s._transition)
    });
    await flush();
    return transitions[0] === null;
  }
);

async function main() {
  let pass = 0, fail = 0;
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
    if (only && m.name.indexOf(only) === -1) continue;
    let mutatedSourceHit = false;
    const mutate = (src) => {
      const out = m.mutate(src);
      mutatedSourceHit = out !== src;
      return out;
    };
    let ok = false;
    try { ok = await m.check(mutate); } catch (e) { ok = false; }
    if (!mutatedSourceHit) {
      fail += 1;
      console.log('  FAIL ' + m.name + ' (mutation target not found in source)');
    } else if (ok) {
      fail += 1;
      console.log('  FAIL ' + m.name + ' (mutant was NOT caught)');
    } else {
      pass += 1;
      console.log('  ok   ' + m.name);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main();
