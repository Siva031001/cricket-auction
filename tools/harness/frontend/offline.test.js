#!/usr/bin/env node
/**
 * tools/harness/frontend/offline.test.js
 *
 * Node test harness for frontend/js/offline.js (Phase 5.5, offline
 * resilience). Standalone, same convention as the other files in this
 * directory: `node tools/harness/frontend/offline.test.js`, exit code 0 on
 * success. Nothing here ships; production has no Node.
 *
 * It loads offline.js into a fresh vm context per test with a minimal
 * in-memory IndexedDB: open / transaction / objectStore / put / get / getAll /
 * delete, plus onupgradeneeded, autoIncrement key generation, request
 * onsuccess/onerror, and transaction oncomplete/onerror/onabort. Requests are
 * settled asynchronously (setTimeout 0) so the ordering matches a real browser
 * closely enough to catch "resolved before commit" mistakes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.resolve('/Users/raja.t/cricket-auction/frontend/js/offline.js'), 'utf8');

/* ===================================================================== *
 * Fake IndexedDB
 * ===================================================================== */

function makeFakeIdb(seedData) {
  // The persistent "disk". Survives across module instances so we can
  // simulate a reload: new context, same store.
  const disk = seedData || { version: 0, stores: {}, generators: {} };

  const schema = {
    packMeta: { keyPath: 'tournament_id' },
    players: { keyPath: 'key' },
    images: { keyPath: 'player_id' },
    queue: { keyPath: 'seq', autoIncrement: true },
    rejected: { keyPath: 'seq' },
    kv: { keyPath: 'k' }
  };

  const control = {
    disk,
    openThrows: null,      // set to an Error to make open() throw
    openBlocked: false,    // set true to fire onblocked
    openSilent: false,     // set true to never fire any event (hang)
    quotaOn: null,         // set to a store name to make put() fail with quota
    writes: 0
  };

  function DOMErr(name, message) {
    const e = new Error(message || name);
    e.name = name;
    return e;
  }

  function makeRequest() {
    return { onsuccess: null, onerror: null, result: undefined, error: null };
  }

  function ObjectStore(name, tx) {
    this._name = name;
    this._tx = tx;
    if (!disk.stores[name]) disk.stores[name] = {};
  }

  ObjectStore.prototype._settle = function (req, fn) {
    const tx = this._tx;
    tx._pending += 1;
    setTimeout(function () {
      if (tx._done) return;
      try {
        req.result = fn();
        tx._pending -= 1;
        if (req.onsuccess) req.onsuccess({ target: req });
      } catch (e) {
        req.error = e;
        tx._pending -= 1;
        if (req.onerror) req.onerror({ target: req });
        tx._abort(e);
        return;
      }
      tx._maybeComplete();
    }, 0);
    return req;
  };

  ObjectStore.prototype.put = function (value) {
    const self = this;
    const req = makeRequest();
    return this._settle(req, function () {
      if (control.quotaOn === self._name) {
        throw DOMErr('QuotaExceededError', 'The quota has been exceeded.');
      }
      if (self._tx._mode !== 'readwrite') throw DOMErr('ReadOnlyError', 'read only');
      const spec = schema[self._name];
      const rec = JSON.parse(JSON.stringify(value, function (k, v) {
        return v;
      }));
      // Preserve non-JSON values (our fake "blobs" are Buffers/objects).
      Object.keys(value).forEach(function (k) {
        if (value[k] && typeof value[k] === 'object' && Buffer.isBuffer(value[k])) rec[k] = value[k];
      });
      let key;
      if (spec.autoIncrement && (rec[spec.keyPath] === undefined || rec[spec.keyPath] === null)) {
        const g = (disk.generators[self._name] || 0) + 1;
        disk.generators[self._name] = g;
        key = g;
        rec[spec.keyPath] = g;
      } else {
        key = rec[spec.keyPath];
        if (spec.autoIncrement && Number(key) > (disk.generators[self._name] || 0)) {
          disk.generators[self._name] = Number(key);
        }
      }
      if (!disk.stores[self._name]) disk.stores[self._name] = {};
      disk.stores[self._name][String(key)] = rec;
      control.writes += 1;
      return key;
    });
  };

  ObjectStore.prototype.get = function (key) {
    const self = this;
    return this._settle(makeRequest(), function () {
      const s = disk.stores[self._name] || {};
      const hit = s[String(key)];
      return hit === undefined ? undefined : hit;
    });
  };

  ObjectStore.prototype.getAll = function () {
    const self = this;
    return this._settle(makeRequest(), function () {
      const s = disk.stores[self._name] || {};
      return Object.keys(s).map(function (k) { return s[k]; });
    });
  };

  ObjectStore.prototype.delete = function (key) {
    const self = this;
    return this._settle(makeRequest(), function () {
      if (self._tx._mode !== 'readwrite') throw DOMErr('ReadOnlyError', 'read only');
      delete (disk.stores[self._name] || {})[String(key)];
      return undefined;
    });
  };

  function Transaction(names, mode, db) {
    this._names = names;
    this._mode = mode;
    this._db = db;
    this._pending = 0;
    this._done = false;
    this._started = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    const self = this;
    // Give the caller one synchronous tick to issue requests, then start
    // watching for completion — mirrors the browser's "auto-commit when no
    // more requests are pending" behaviour.
    setTimeout(function () { self._started = true; self._maybeComplete(); }, 0);
  }

  Transaction.prototype.objectStore = function (name) {
    if (this._names.indexOf(name) === -1) {
      throw DOMErr('NotFoundError', 'store ' + name + ' not in this transaction');
    }
    return new ObjectStore(name, this);
  };

  Transaction.prototype._maybeComplete = function () {
    if (this._done || !this._started || this._pending > 0) return;
    this._done = true;
    if (this.oncomplete) this.oncomplete({ target: this });
  };

  Transaction.prototype._abort = function (err) {
    if (this._done) return;
    this._done = true;
    this.error = err;
    if (this.onerror) this.onerror({ target: this });
    if (this.onabort) this.onabort({ target: this });
  };

  Transaction.prototype.abort = function () { this._abort(DOMErr('AbortError', 'aborted')); };

  function Database(version) {
    this.version = version;
    this.onversionchange = null;
    const names = Object.keys(schema);
    this.objectStoreNames = {
      contains: function (n) { return names.indexOf(n) !== -1; }
    };
  }

  Database.prototype.transaction = function (names, mode) {
    return new Transaction(names, mode || 'readonly', this);
  };
  Database.prototype.close = function () {};
  Database.prototype.createObjectStore = function (name, opts) {
    schema[name] = opts || {};
    if (!disk.stores[name]) disk.stores[name] = {};
    return new ObjectStore(name, { _mode: 'readwrite', _pending: 0, _maybeComplete: function () {}, _abort: function () {} });
  };

  const indexedDB = {
    open: function (name, version) {
      if (control.openThrows) throw control.openThrows;
      const req = makeRequest();
      req.onupgradeneeded = null;
      req.onblocked = null;
      if (control.openSilent) return req;
      setTimeout(function () {
        if (control.openBlocked) {
          if (req.onblocked) req.onblocked({ target: req });
          return;
        }
        const db = new Database(version);
        req.result = db;
        if (disk.version < version) {
          disk.version = version;
          Object.keys(schema).forEach(function (n) {
            if (!disk.stores[n]) disk.stores[n] = {};
          });
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  };

  return { indexedDB, control, disk };
}

/* ===================================================================== *
 * Fake localStorage
 * ===================================================================== */

function makeFakeLs(seed, opts) {
  const o = opts || {};
  const map = seed || {};
  return {
    _map: map,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) {
      if (o.quota && k.indexOf('probe') === -1) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      map[k] = String(v);
    },
    removeItem: function (k) { delete map[k]; }
  };
}

/* ===================================================================== *
 * Load offline.js into a fresh context
 * ===================================================================== */

let urlCounter = 0;

function loadOffline(env) {
  const e = env || {};
  const ctx = {
    console,
    setTimeout, clearTimeout, Date, Math, JSON, Promise, Error, String, Number,
    Object, Array, Boolean, isFinite, isNaN, Uint8Array, Buffer, RegExp,
    crypto: e.crypto === null ? undefined : (e.crypto || require('crypto').webcrypto),
    indexedDB: e.indexedDB,
    localStorage: e.localStorage,
    URL: {
      createObjectURL: function (b) { urlCounter += 1; return 'blob:fake/' + urlCounter; },
      revokeObjectURL: function () {}
    },
    API: e.API
  };
  vm.createContext(ctx);
  // `const Offline` is lexical, so it never lands on the context object.
  // The completion value of the script hands it back.
  return vm.runInContext(SRC + '\n;Offline;', ctx, { filename: 'offline.js' });
}

/* ===================================================================== *
 * Tiny assertion runner
 * ===================================================================== */

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ok    ' + name); }
  else {
    failed += 1;
    failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : ''));
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
function section(n) { console.log('\n' + n); }

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

function fakePlayers(n, tid, startSerial) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const s = (startSerial || 1) + i;
    rows.push({
      player_id: 'PLR_' + tid + '_' + s,
      serial_no: s,
      name: 'Player ' + s,
      role: 'ALL_ROUNDER',
      style: 'RIGHT',
      age_years: 20 + (s % 15),
      mobile: '90000000' + (100 + s),
      payment_status: 'VERIFIED',
      is_withdrawn: false,
      photo_thumb_url: 'https://drive.google.com/thumbnail?id=F' + s + '&sz=w320'
    });
  }
  return rows;
}

function listFnFor(rows) {
  return function (tid, page, pageSize) {
    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);
    return Promise.resolve({
      rows: slice,
      page: page,
      pageSize: pageSize,
      total: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / pageSize))
    });
  };
}

function imageFnOk(failUrls) {
  const bad = failUrls || [];
  return function (url) {
    if (bad.indexOf(url) !== -1) {
      return Promise.reject({ code: 'NETWORK', message: 'thumbnail unreachable' });
    }
    return Promise.resolve(Buffer.from('JPEGBYTES-' + url));
  };
}

/* ===================================================================== *
 * Tests
 * ===================================================================== */

async function main() {

  /* ---------------------------------------------------------------- */
  section('1. downloadPack — counts, progress, isPackReady');
  {
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });
    const rows = fakePlayers(7, 'TRN_A');
    const seen = [];

    const res = await O.downloadPack('TRN_A', function (p) { seen.push(p); },
      { listFn: listFnFor(rows), imageFn: imageFnOk(), pageSize: 3 });

    eq('playerCount is 7', res.playerCount, 7);
    eq('imageCount is 7', res.imageCount, 7);
    eq('complete is true', res.complete, true);
    eq('storage is idb', res.storage, 'idb');
    ok('progress was reported', seen.length >= 7, 'saw ' + seen.length + ' events');
    ok('progress has an images phase', seen.some(function (p) { return p.phase === 'images'; }));
    ok('progress ends with done', seen[seen.length - 1].phase === 'done');
    ok('progress carries the tournament id', seen.every(function (p) { return p.tournamentId === 'TRN_A'; }));

    const ready = await O.isPackReady('TRN_A');
    eq('isPackReady.ready true', ready.ready, true);
    eq('isPackReady.playerCount', ready.playerCount, 7);
    eq('isPackReady.imageCount', ready.imageCount, 7);
    ok('isPackReady.downloadedAt set', typeof ready.downloadedAt === 'string' && ready.downloadedAt.length > 10);

    // getPlayer / getImage
    const p3 = await O.getPlayer('TRN_A', 3);
    eq('getPlayer by number', p3 && p3.name, 'Player 3');
    const p3s = await O.getPlayer('TRN_A', '3');
    eq('getPlayer by string', p3s && p3s.name, 'Player 3');
    eq('getPlayer miss returns null', await O.getPlayer('TRN_A', 999), null);
    eq('getPlayer keeps only pack fields', p3.mobile, undefined);

    const url = await O.getImage('PLR_TRN_A_3');
    ok('getImage returns an object URL', typeof url === 'string' && url.indexOf('blob:') === 0, String(url));
    eq('getImage is memoised', await O.getImage('PLR_TRN_A_3'), url);
    eq('getImage unknown -> null', await O.getImage('PLR_NOPE'), null);
    eq('getImage wrong tournament -> null', await O.getImage('PLR_TRN_A_3', 'TRN_B'), null);
  }

  /* ---------------------------------------------------------------- */
  section('2. isPackReady is FALSE after a partial download');
  {
    // (a) crash mid-download: the INCOMPLETE marker is written first
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });
    const rows = fakePlayers(5, 'TRN_A');

    let threw = null;
    try {
      await O.downloadPack('TRN_A', null, {
        listFn: function (tid, page, pageSize) {
          // First page fine, then the network dies — a real venue failure.
          if (page === 1) return listFnFor(rows)(tid, 1, 2);
          return Promise.reject({ code: 'NETWORK', message: 'connection lost' });
        },
        imageFn: imageFnOk(),
        pageSize: 2
      });
    } catch (e) { threw = e; }

    ok('a mid-download failure rejects', !!threw, String(threw));
    const ready = await O.isPackReady('TRN_A');
    eq('ready is false after a crash mid-download', ready.ready, false);
    eq('exists is true (the marker is there)', ready.exists, true);
    eq('complete is false', ready.complete, false);

    // (b) some images fail -> pack finishes but reports incomplete
    const idb2 = makeFakeIdb();
    const O2 = loadOffline({ indexedDB: idb2.indexedDB, localStorage: makeFakeLs() });
    const rows2 = fakePlayers(4, 'TRN_B');
    const res2 = await O2.downloadPack('TRN_B', null, {
      listFn: listFnFor(rows2),
      imageFn: imageFnOk([rows2[2].photo_thumb_url])
    });
    eq('players all cached', res2.playerCount, 4);
    eq('one image missing', res2.imageCount, 3);
    eq('one failure recorded', res2.imageFailures.length, 1);
    eq('failure names the player', res2.imageFailures[0].serial_no, '3');
    eq('complete is false with a missing photo', res2.complete, false);
    const r2 = await O2.isPackReady('TRN_B');
    eq('isPackReady.ready false with a missing photo', r2.ready, false);
    eq('isPackReady still reports 4 players', r2.playerCount, 4);
    ok('a warning explains it', r2.warnings.some(function (w) { return /photograph/i.test(w); }),
      JSON.stringify(r2.warnings));
  }

  /* ---------------------------------------------------------------- */
  section('3. Failure detection — three flips, two does not, success resets');
  {
    const O = loadOffline({ indexedDB: makeFakeIdb().indexedDB, localStorage: makeFakeLs() });
    const events = [];
    O.onChange(function (s) { events.push(s); });

    eq('starts online', O.isOffline(), false);
    eq('noteFailure #1 does not flip', O.noteFailure('NETWORK'), false);
    eq('still online after 1', O.isOffline(), false);
    eq('noteFailure #2 does not flip', O.noteFailure('NETWORK'), false);
    eq('TWO failures do NOT flip', O.isOffline(), false);
    eq('failureCount is 2', O.failureCount(), 2);
    eq('noteFailure #3 flips', O.noteFailure('NETWORK'), true);
    eq('THREE failures flip to offline', O.isOffline(), true);
    eq('noteFailure #4 does not re-flip', O.noteFailure('NETWORK'), false);

    eq('noteSuccess flips back', O.noteSuccess(), true);
    eq('back online', O.isOffline(), false);
    eq('counter reset', O.failureCount(), 0);
    eq('second noteSuccess is a no-op', O.noteSuccess(), false);

    // ONE success resets the counter, so two more failures still do not flip.
    O.noteFailure(); O.noteFailure();
    O.noteSuccess();
    O.noteFailure(); O.noteFailure();
    eq('a success resets the run of failures', O.isOffline(), false);
    eq('counter is 2 again, not 4', O.failureCount(), 2);
    O.noteFailure();
    eq('the third after the reset flips', O.isOffline(), true);

    ok('onChange fired immediately on subscribe', events.length >= 1);
    ok('change events carry the banner text', events[0].bannerText === 'OFFLINE — results are not yet saved.',
      JSON.stringify(events[0].bannerText));
    eq('threshold constant is 3', O.FAILURE_THRESHOLD, 3);

    const off = O.onChange(function () { throw new Error('a listener bug'); });
    ok('a throwing listener does not break noteFailure', (function () {
      try { O.noteSuccess(); O.noteFailure(); O.noteFailure(); O.noteFailure(); return true; }
      catch (e) { return false; }
    })());
    off();
    const before = events.length;
    O.noteSuccess();
    ok('unsubscribe works', events.length > before);
  }

  /* ---------------------------------------------------------------- */
  section('4. Queue survives a reload; sequence is monotonic; ids stable');
  {
    const idb = makeFakeIdb();
    const O1 = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });

    const a = await O1.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P1', teamId: 'T1', amount: 50000 });
    const b = await O1.enqueue('auction.markUnsold', { tournamentId: 'TRN_A', playerId: 'P2' });
    eq('queue length is 2', await O1.queueLength(), 2);
    ok('seq is monotonic', b.seq > a.seq, a.seq + ' -> ' + b.seq);
    ok('ids differ', a.id !== b.id);
    ok('id has the oq_ prefix', /^oq_/.test(a.id), a.id);

    // ---- SIMULATED RELOAD / CRASH: brand-new module instance, same disk ----
    const O2 = loadOffline({ indexedDB: makeFakeIdb(idb.disk).indexedDB, localStorage: makeFakeLs() });
    const after = await O2.listQueue();
    eq('queue survived the reload', after.length, 2);
    eq('order preserved', after[0].seq < after[1].seq, true);
    eq('idempotency id 1 is stable across the reload', after[0].id, a.id);
    eq('idempotency id 2 is stable across the reload', after[1].id, b.id);
    eq('payload survived', after[0].payload.amount, 50000);
    eq('action survived', after[1].action, 'auction.markUnsold');

    const c = await O2.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P3', amount: 1 });
    ok('seq keeps climbing after a reload', c.seq > b.seq, b.seq + ' -> ' + c.seq);

    // Uniqueness over a decent sample.
    const ids = {};
    let dupe = null;
    let lastSeq = c.seq;
    let seqOk = true;
    for (let i = 0; i < 60; i++) {
      const r = await O2.enqueue('auction.markSold', { tournamentId: 'TRN_Z', playerId: 'X' + i });
      if (ids[r.id]) dupe = r.id;
      ids[r.id] = true;
      if (!(r.seq > lastSeq)) seqOk = false;
      lastSeq = r.seq;
    }
    ok('60 generated ids are all unique', dupe === null, 'duplicate ' + dupe);
    ok('60 sequence numbers are strictly increasing', seqOk);
  }

  /* ---------------------------------------------------------------- */
  section('5. sync replays in sequence order');
  {
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });
    for (let i = 1; i <= 5; i++) {
      await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P' + i, amount: i * 1000 });
    }
    const order = [];
    let metaOk = true;
    const res = await O.sync(function (action, payload, meta) {
      order.push(payload.playerId);
      metaOk = metaOk && typeof meta.idempotencyId === 'string' &&
        meta.idempotencyId.indexOf('oq_') === 0 && meta.seq === Number(meta.seq);
      return Promise.resolve({ ok: true });
    });
    ok('every call received a well-formed meta.idempotencyId', metaOk);

    eq('replayed in sequence order', order.join(','), 'P1,P2,P3,P4,P5');
    eq('all applied', res.applied.length, 5);
    eq('nothing rejected', res.rejected.length, 0);
    eq('nothing stopped it', res.stopped, null);
    eq('queue is empty afterwards', res.remaining, 0);
    eq('queueLength agrees', await O.queueLength(), 0);
    eq('applied entries carry the payload', res.applied[0].payload.playerId, 'P1');

    // Concurrency guard
    const idb2 = makeFakeIdb();
    const O2 = loadOffline({ indexedDB: idb2.indexedDB, localStorage: makeFakeLs() });
    await O2.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P1' });
    let slowResolve = null;
    const first = O2.sync(function () { return new Promise(function (r) { slowResolve = r; }); });
    let guard = null;
    try { await O2.sync(function () { return Promise.resolve(1); }); }
    catch (e) { guard = e; }
    eq('a second concurrent sync is refused', guard && guard.code, 'SYNC_IN_PROGRESS');
    while (!slowResolve) { await new Promise(function (r) { setTimeout(r, 1); }); }
    slowResolve({});
    await first;
  }

  /* ---------------------------------------------------------------- */
  section('6. A rejected item is returned with its payload and does not vanish');
  {
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P1', teamId: 'T1', amount: 1000 });
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P2', teamId: 'T1', amount: 900000 });
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P3', teamId: 'T2', amount: 2000 });

    const res = await O.sync(function (action, payload) {
      if (payload.playerId === 'P2') {
        return Promise.reject({ code: 'INSUFFICIENT_PURSE', message: 'Chennai Warriors has ₹40,000 left; the bid is ₹9,00,000.' });
      }
      return Promise.resolve({ ok: true });
    });

    eq('two applied', res.applied.length, 2);
    eq('one rejected', res.rejected.length, 1);
    eq('rejected carries the code', res.rejected[0].error.code, 'INSUFFICIENT_PURSE');
    ok('rejected carries the SERVER message',
      /Chennai Warriors has/.test(res.rejected[0].error.message), res.rejected[0].error.message);
    eq('rejected carries the ORIGINAL payload amount', res.rejected[0].payload.amount, 900000);
    eq('rejected carries the original playerId', res.rejected[0].payload.playerId, 'P2');
    eq('replay continued past the rejection', res.stopped, null);
    eq('nothing is left pending', res.remaining, 0);

    // It must not have vanished: it is durable in the rejected store.
    const kept = await O.listRejected();
    eq('the rejected item is persisted', kept.length, 1);
    eq('persisted payload intact', kept[0].payload.amount, 900000);
    eq('persisted message intact', kept[0].error.message, res.rejected[0].error.message);

    // ...and it survives a reload too.
    const O2 = loadOffline({ indexedDB: makeFakeIdb(idb.disk).indexedDB, localStorage: makeFakeLs() });
    const kept2 = await O2.listRejected();
    eq('rejected list survives a reload', kept2.length, 1);
    eq('and still has the payload', kept2[0].payload.playerId, 'P2');

    const cleared = await O2.clearRejected();
    eq('clearRejected removes it', cleared.deleted, 1);
    eq('rejected list now empty', (await O2.listRejected()).length, 0);
  }

  /* ---------------------------------------------------------------- */
  section('7. sync STOPS on the first hard failure');
  {
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });
    for (let i = 1; i <= 5; i++) {
      await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P' + i, amount: i });
    }
    const tried = [];
    const res = await O.sync(function (action, payload) {
      tried.push(payload.playerId);
      if (payload.playerId === 'P3') return Promise.reject({ code: 'NETWORK', message: 'Could not reach the server.' });
      return Promise.resolve({});
    });

    eq('stopped at P3', res.stopped && res.stopped.payload.playerId, 'P3');
    eq('stop error code', res.stopped.error.code, 'NETWORK');
    ok('stop carries a hint', typeof res.stopped.hint === 'string' && res.stopped.hint.length > 20);
    eq('only P1..P3 were attempted', tried.join(','), 'P1,P2,P3');
    eq('two applied', res.applied.length, 2);
    eq('nothing was rejected', res.rejected.length, 0);
    eq('three remain queued', res.remaining, 3);

    const left = await O.listQueue();
    eq('the stopped item is still first in the queue', left[0].payload.playerId, 'P3');
    eq('order after it is intact', left.map(function (r) { return r.payload.playerId; }).join(','), 'P3,P4,P5');
    eq('attempt count recorded', left[0].attempts, 1);
    eq('a hard failure also notes a poll failure', O.failureCount() >= 1, true);

    // STALE_STATE is deliberately a hard stop (offline expectedVersion is
    // always stale by replay time — CONTRACTS-PHASE4-7 §4.1 step 1).
    const idb2 = makeFakeIdb();
    const O2 = loadOffline({ indexedDB: idb2.indexedDB, localStorage: makeFakeLs() });
    await O2.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P1' });
    await O2.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P2' });
    const r2 = await O2.sync(function () { return Promise.reject({ code: 'STALE_STATE', message: 'version mismatch' }); });
    eq('STALE_STATE stops the replay', r2.stopped && r2.stopped.error.code, 'STALE_STATE');
    eq('nothing applied', r2.applied.length, 0);
    eq('both items still queued', r2.remaining, 2);
    ok('the hint names expectedVersion', /expectedVersion/.test(r2.stopped.hint), r2.stopped.hint);

    // An error with no code at all is hard too — unknown outcome.
    const idb3 = makeFakeIdb();
    const O3 = loadOffline({ indexedDB: idb3.indexedDB, localStorage: makeFakeLs() });
    await O3.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P1' });
    const r3 = await O3.sync(function () { throw new TypeError('undefined is not a function'); });
    ok('a thrown TypeError stops the replay', !!r3.stopped, JSON.stringify(r3));
    eq('and leaves the item queued', r3.remaining, 1);
  }

  /* ---------------------------------------------------------------- */
  section('8. Quota exceeded and blocked IndexedDB produce CLEAR errors');
  {
    // (a) quota during the image write
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });
    idb.control.quotaOn = 'images';
    let err = null;
    try {
      await O.downloadPack('TRN_A', null, { listFn: listFnFor(fakePlayers(3, 'TRN_A')), imageFn: imageFnOk() });
    } catch (e) { err = e; }
    eq('quota gives QUOTA_EXCEEDED', err && err.code, 'QUOTA_EXCEEDED');
    ok('the message tells the organiser what to do',
      /out of storage/i.test(err.message) && /clearPack/.test(err.message), err.message);
    const ready = await O.isPackReady('TRN_A');
    eq('and the pack is not reported ready', ready.ready, false);

    // (b) open() throws — Firefox private browsing
    const blockedThrow = makeFakeIdb();
    const e1 = new Error('A mutation operation was attempted on a database that did not allow mutations.');
    e1.name = 'InvalidStateError';
    blockedThrow.control.openThrows = e1;
    const Ob = loadOffline({ indexedDB: blockedThrow.indexedDB, localStorage: null });
    let berr = null;
    try { await Ob.storageInfo(); } catch (e) { berr = e; }
    eq('blocked IDB + no localStorage -> NO_STORAGE', berr && berr.code, 'NO_STORAGE');
    ok('the message says do not run the auction here', /Do not run the auction/.test(berr.message), berr.message);

    // (c) blocked IDB WITH localStorage -> documented fallback, not a crash
    const blocked2 = makeFakeIdb();
    blocked2.control.openThrows = e1;
    const Of = loadOffline({ indexedDB: blocked2.indexedDB, localStorage: makeFakeLs() });
    const info = await Of.storageInfo();
    eq('falls back to localStorage', info.kind, 'ls');
    eq('and reports itself degraded', info.degraded, true);
    eq('and says images are unavailable', info.images, false);

    // (d) onblocked (another tab holds an older version)
    const blocked3 = makeFakeIdb();
    blocked3.control.openBlocked = true;
    const Ob3 = loadOffline({ indexedDB: blocked3.indexedDB, localStorage: null });
    let b3 = null;
    try { await Ob3.storageInfo(); } catch (e) { b3 = e; }
    ok('onblocked surfaces a clear error', b3 && /NO_STORAGE|IDB_BLOCKED/.test(b3.code), String(b3 && b3.code));
    ok('and names the other-tab cause', /tab/i.test(b3.message), b3.message);

    // (e) no IndexedDB at all
    const Onone = loadOffline({ indexedDB: undefined, localStorage: null });
    let nerr = null;
    try { await Onone.storageInfo(); } catch (e) { nerr = e; }
    eq('no IDB and no localStorage -> NO_STORAGE', nerr && nerr.code, 'NO_STORAGE');

    // (f) localStorage quota on the fallback path
    const blocked4 = makeFakeIdb();
    blocked4.control.openThrows = e1;
    const Oq = loadOffline({ indexedDB: blocked4.indexedDB, localStorage: makeFakeLs(null, { quota: true }) });
    let qerr = null;
    try { await Oq.enqueue('auction.markSold', { tournamentId: 'TRN_A' }); } catch (e) { qerr = e; }
    eq('localStorage quota -> QUOTA_EXCEEDED', qerr && qerr.code, 'QUOTA_EXCEEDED');
  }

  /* ---------------------------------------------------------------- */
  section('9. localStorage fallback is honest about images');
  {
    const blocked = makeFakeIdb();
    const e1 = new Error('private browsing'); e1.name = 'InvalidStateError';
    blocked.control.openThrows = e1;
    const lsMap = {};
    const O = loadOffline({ indexedDB: blocked.indexedDB, localStorage: makeFakeLs(lsMap) });

    const res = await O.downloadPack('TRN_A', null, {
      listFn: listFnFor(fakePlayers(4, 'TRN_A')), imageFn: imageFnOk()
    });
    eq('players cached in localStorage', res.playerCount, 4);
    eq('no images cached', res.imageCount, 0);
    eq('storage reported as ls', res.storage, 'ls');
    eq('degraded flag set', res.degraded, true);
    ok('warning says images are not cached',
      res.warnings.some(function (w) { return /Photographs are not cached/.test(w); }),
      JSON.stringify(res.warnings));
    ok('localStorage keys are namespaced',
      Object.keys(lsMap).every(function (k) { return k.indexOf('ca.offline.') === 0; }),
      Object.keys(lsMap).join(','));
    ok('the pack key is per tournament', Object.keys(lsMap).indexOf('ca.offline.pack.TRN_A') !== -1,
      Object.keys(lsMap).join(','));

    eq('getPlayer works on the fallback', (await O.getPlayer('TRN_A', 2)).name, 'Player 2');
    eq('getImage returns null on the fallback', await O.getImage('PLR_TRN_A_2'), null);

    // Queue survives a reload on the fallback path too.
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P1', amount: 500 });
    const blocked2 = makeFakeIdb();
    blocked2.control.openThrows = e1;
    const O2 = loadOffline({ indexedDB: blocked2.indexedDB, localStorage: makeFakeLs(lsMap) });
    const q = await O2.listQueue();
    eq('fallback queue survives a reload', q.length, 1);
    eq('with its payload', q[0].payload.amount, 500);
    const seqBefore = q[0].seq;
    const nxt = await O2.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P2' });
    ok('fallback seq stays monotonic across reloads', nxt.seq > seqBefore, seqBefore + ' -> ' + nxt.seq);
  }

  /* ---------------------------------------------------------------- */
  section('10. NO_IMAGE_FETCHER, NO_PLAYER_SOURCE, BAD_ARGUMENT');
  {
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });

    let e = null;
    try { await O.downloadPack('TRN_A', null, { listFn: listFnFor(fakePlayers(2, 'TRN_A')) }); }
    catch (x) { e = x; }
    eq('no imageFn -> NO_IMAGE_FETCHER', e && e.code, 'NO_IMAGE_FETCHER');
    ok('the message says how to fix it', /setTransport|getBytes|imagesOptional/.test(e.message), e.message);

    const res = await O.downloadPack('TRN_A', null, {
      listFn: listFnFor(fakePlayers(2, 'TRN_A')), imagesOptional: true
    });
    eq('imagesOptional lets it through', res.playerCount, 2);
    eq('but with zero images', res.imageCount, 0);
    ok('and a warning', res.warnings.some(function (w) { return /no photographs/i.test(w); }),
      JSON.stringify(res.warnings));

    const O2 = loadOffline({ indexedDB: makeFakeIdb().indexedDB, localStorage: makeFakeLs() });
    let e2 = null;
    try { await O2.downloadPack('TRN_A'); } catch (x) { e2 = x; }
    eq('no listFn and no global API -> NO_PLAYER_SOURCE', e2 && e2.code, 'NO_PLAYER_SOURCE');

    let e3 = null;
    try { await O2.downloadPack(''); } catch (x) { e3 = x; }
    eq('blank tournament id -> BAD_ARGUMENT', e3 && e3.code, 'BAD_ARGUMENT');
    let e4 = null;
    try { await O2.getPlayer('TRN_A', ''); } catch (x) { e4 = x; }
    eq('blank serial -> BAD_ARGUMENT', e4 && e4.code, 'BAD_ARGUMENT');
    let e5 = null;
    try { await O2.sync(null); } catch (x) { e5 = x; }
    eq('sync with no callFn -> BAD_ARGUMENT', e5 && e5.code, 'BAD_ARGUMENT');
  }

  /* ---------------------------------------------------------------- */
  section('11. The default listFn uses the global API and filters eligibility');
  {
    const calls = [];
    const rows = fakePlayers(3, 'TRN_A');
    rows.push({
      player_id: 'PLR_BAD', serial_no: 99, name: 'Rejected Person', role: 'BATSMAN',
      style: 'RIGHT', age_years: 30, payment_status: 'REJECTED', is_withdrawn: false,
      photo_thumb_url: 'https://x/99'
    });
    rows.push({
      player_id: 'PLR_GONE', serial_no: 98, name: 'Withdrawn Person', role: 'BATSMAN',
      style: 'RIGHT', age_years: 30, payment_status: 'VERIFIED', is_withdrawn: true,
      photo_thumb_url: 'https://x/98'
    });

    const fakeApi = {
      call: function (action, payload) {
        calls.push({ action: action, payload: payload });
        return listFnFor(rows)(payload.tournamentId, payload.page, payload.pageSize);
      }
    };
    const O = loadOffline({ indexedDB: makeFakeIdb().indexedDB, localStorage: makeFakeLs(), API: fakeApi });
    const res = await O.downloadPack('TRN_A', null, { imageFn: imageFnOk() });

    eq('used player.list', calls[0].action, 'player.list');
    eq('asked for VERIFIED only', calls[0].payload.filter.paymentStatus, 'VERIFIED');
    eq('asked for not-withdrawn', calls[0].payload.filter.withdrawn, false);
    eq('a REJECTED and a WITHDRAWN row are dropped locally too', res.playerCount, 3);
    eq('the rejected player is not cached', await O.getPlayer('TRN_A', 99), null);
    eq('the withdrawn player is not cached', await O.getPlayer('TRN_A', 98), null);
  }

  /* ---------------------------------------------------------------- */
  section('12. clearPack / clearQueue affect ONLY the named tournament');
  {
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });

    await O.downloadPack('TRN_A', null, { listFn: listFnFor(fakePlayers(3, 'TRN_A', 1)), imageFn: imageFnOk() });
    await O.downloadPack('TRN_B', null, { listFn: listFnFor(fakePlayers(2, 'TRN_B', 1)), imageFn: imageFnOk() });

    // Same serial numbers in both tournaments — the namespacing test that matters.
    eq('A#1 is A', (await O.getPlayer('TRN_A', 1)).player_id, 'PLR_TRN_A_1');
    eq('B#1 is B', (await O.getPlayer('TRN_B', 1)).player_id, 'PLR_TRN_B_1');

    await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'A1' });
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'A2' });
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_B', playerId: 'B1' });
    eq('three queued in total', await O.queueLength(), 3);
    eq('two are A', await O.queueLength('TRN_A'), 2);
    eq('one is B', await O.queueLength('TRN_B'), 1);

    const cp = await O.clearPack('TRN_A');
    eq('clearPack deleted 3 A players', cp.playersDeleted, 3);
    eq('clearPack deleted 3 A images', cp.imagesDeleted, 3);
    eq('A pack is gone', (await O.isPackReady('TRN_A')).exists, false);
    eq('B pack untouched', (await O.isPackReady('TRN_B')).ready, true);
    eq('B players still readable', (await O.getPlayer('TRN_B', 1)).name, 'Player 1');
    ok('B image still readable', typeof (await O.getImage('PLR_TRN_B_1')) === 'string');
    eq('A player gone', await O.getPlayer('TRN_A', 1), null);
    eq('A image gone', await O.getImage('PLR_TRN_A_1'), null);
    eq('clearPack did NOT touch the queue', await O.queueLength(), 3);

    const cq = await O.clearQueue('TRN_A');
    eq('clearQueue removed the 2 A items', cq.deleted, 2);
    eq('B item survives', await O.queueLength(), 1);
    eq('and it is the B one', (await O.listQueue())[0].payload.playerId, 'B1');

    const cq2 = await O.clearQueue();
    eq('clearQueue() with no argument clears the rest', cq2.deleted, 1);
    eq('queue empty', await O.queueLength(), 0);

    // clearPack on an unknown tournament is a no-op, not an error.
    const cp2 = await O.clearPack('TRN_NOPE');
    eq('clearPack on an unknown id deletes nothing', cp2.playersDeleted, 0);
    eq('B still fine', (await O.isPackReady('TRN_B')).ready, true);
  }

  /* ---------------------------------------------------------------- */
  section('12b. Scoping holds on the localStorage fallback path too');
  {
    const e1 = new Error('private browsing'); e1.name = 'InvalidStateError';
    const mk = function (lsMap) {
      const b = makeFakeIdb();
      b.control.openThrows = e1;
      return loadOffline({ indexedDB: b.indexedDB, localStorage: makeFakeLs(lsMap) });
    };
    const lsMap = {};
    const O = mk(lsMap);

    await O.downloadPack('TRN_A', null, { listFn: listFnFor(fakePlayers(3, 'TRN_A')), imagesOptional: true });
    await O.downloadPack('TRN_B', null, { listFn: listFnFor(fakePlayers(2, 'TRN_B')), imagesOptional: true });
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'A1' });
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'A2' });
    await O.enqueue('auction.markSold', { tournamentId: 'TRN_B', playerId: 'B1' });
    eq('fallback: three queued', await O.queueLength(), 3);

    const cq = await O.clearQueue('TRN_A');
    eq('fallback: clearQueue removed only the 2 A items', cq.deleted, 2);
    eq('fallback: one item left', await O.queueLength(), 1);
    eq('fallback: and it is the B one', (await O.listQueue())[0].payload.playerId, 'B1');
    eq('fallback: scoped count for B', await O.queueLength('TRN_B'), 1);
    eq('fallback: scoped count for A', await O.queueLength('TRN_A'), 0);

    const cp = await O.clearPack('TRN_A');
    eq('fallback: clearPack removed 3 A players', cp.playersDeleted, 3);
    eq('fallback: A pack gone', (await O.isPackReady('TRN_A')).exists, false);
    eq('fallback: B pack untouched', (await O.isPackReady('TRN_B')).playerCount, 2);
    eq('fallback: B player still readable', (await O.getPlayer('TRN_B', 2)).name, 'Player 2');
    eq('fallback: clearPack did not touch the queue', await O.queueLength(), 1);

    const cq2 = await O.clearQueue();
    eq('fallback: clearQueue() with no argument clears the rest', cq2.deleted, 1);
    eq('fallback: queue empty', await O.queueLength(), 0);
  }

  /* ---------------------------------------------------------------- */
  section('13. Durability: enqueue resolves only after the write lands');
  {
    const idb = makeFakeIdb();
    const O = loadOffline({ indexedDB: idb.indexedDB, localStorage: makeFakeLs() });
    const p = O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P1' });
    // Before the promise settles there must be nothing to read yet, and after
    // it settles the record must be on the fake disk without any further tick.
    const r = await p;
    const onDisk = Object.keys(idb.disk.stores.queue || {}).length;
    eq('the record is on disk the instant enqueue resolves', onDisk, 1);
    eq('and carries the same seq', String(idb.disk.stores.queue[String(r.seq)].seq), String(r.seq));
    eq('and the same idempotency id', idb.disk.stores.queue[String(r.seq)].id, r.id);

    // A quota failure during enqueue must REJECT, never resolve.
    idb.control.quotaOn = 'queue';
    let qe = null;
    try { await O.enqueue('auction.markSold', { tournamentId: 'TRN_A', playerId: 'P2' }); }
    catch (e) { qe = e; }
    eq('a failed enqueue rejects', qe && qe.code, 'QUOTA_EXCEEDED');
    eq('and nothing extra was stored', Object.keys(idb.disk.stores.queue).length, 1);
  }

  /* ---------------------------------------------------------------- */
  section('14. Constants and banner text match the contract exactly');
  {
    const O = loadOffline({ indexedDB: makeFakeIdb().indexedDB, localStorage: makeFakeLs() });
    eq('banner text', O.OFFLINE_BANNER_TEXT, 'OFFLINE — results are not yet saved.');
    eq('em dash present', O.OFFLINE_BANNER_TEXT.indexOf('—') !== -1, true);
    eq('threshold', O.FAILURE_THRESHOLD, 3);
    ok('STALE_STATE is classed hard', O.HARD_ERROR_CODES.indexOf('STALE_STATE') !== -1);
    ok('TEAM_FULL is NOT classed hard', O.HARD_ERROR_CODES.indexOf('TEAM_FULL') === -1);
    ok('INSUFFICIENT_PURSE is NOT classed hard', O.HARD_ERROR_CODES.indexOf('INSUFFICIENT_PURSE') === -1);
  }

  console.log('\n' + '-'.repeat(64));
  console.log((passed) + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error('\nHARNESS CRASHED:', e && e.stack ? e.stack : e);
  process.exit(2);
});
