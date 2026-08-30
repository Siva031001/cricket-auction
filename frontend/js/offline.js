/**
 * offline.js — `Offline`. The venue-internet safety net (DESIGN.md §16,
 * CONTRACTS-PHASE4-7.md "PHASE 5.5 — Offline Resilience").
 *
 * ===========================================================================
 * READ THIS FIRST — WHAT THIS IS AND IS NOT
 * ===========================================================================
 *
 * A live auction runs in a hall in front of a few hundred people. The venue
 * Wi-Fi will drop at some point and the auction cannot pause while somebody
 * reboots a router. This module is the net that catches that.
 *
 * IT IS A SAFETY NET, NOT A MODE ANYONE SHOULD PLAN TO USE. Every screen that
 * switches into offline mode must keep saying so, loudly, and must keep saying
 * that THE PAPER BACKUP IS THE REAL FALLBACK (DESIGN.md §16, point 4). A
 * software queue on one laptop is not evidence. A signed sheet of paper is.
 * If this module and the paper disagree, the paper wins and an admin makes a
 * correction through `auction.correct` (CONTRACTS-PHASE4-7.md §4.3).
 *
 * Nothing here bypasses server validation. Replayed writes go through exactly
 * the same `auction.markSold` / `auction.markUnsold` path as a live write, and
 * the server may reject any of them. That is the point, not a limitation.
 *
 * ===========================================================================
 * PUBLIC API — the complete set. Pages call these and nothing else.
 * ===========================================================================
 *
 * WIRING (once, at boot — see "TRANSPORT" below for why)
 *   Offline.setTransport({listFn, imageFn})   -> void
 *   Offline.storageInfo()                     -> Promise<{kind, degraded, reason}>
 *
 * THE PACK (before the auction, on the organiser console)
 *   Offline.downloadPack(tournamentId, onProgress, opts)
 *                                             -> Promise<packResult>
 *   Offline.isPackReady(tournamentId)
 *          -> Promise<{ready, playerCount, imageCount, downloadedAt, ...}>
 *   Offline.clearPack(tournamentId)           -> Promise<{playersDeleted, imagesDeleted}>
 *
 * READING THE PACK (while offline, on the console and the projector)
 *   Offline.getPlayer(tournamentId, serialNo) -> Promise<player|null>
 *   Offline.getPlayers(tournamentId)          -> Promise<player[]>   (serial order)
 *   Offline.getImage(playerId)                -> Promise<objectURL|null>
 *   Offline.revokeImages()                    -> void   (call on page unload)
 *
 * FAILURE DETECTION (the poll calls these)
 *   Offline.noteFailure(reason)               -> boolean  true if it just flipped
 *   Offline.noteSuccess()                     -> boolean  true if it just flipped
 *   Offline.isOffline()                       -> boolean
 *   Offline.failureCount()                    -> number
 *   Offline.setOffline(flag, reason)          -> boolean  manual override / drills
 *   Offline.onChange(cb)                      -> function unsubscribe
 *
 * THE QUEUE (recording a sale with no network)
 *   Offline.enqueue(action, payload)          -> Promise<{seq, id}>
 *   Offline.queueLength(tournamentId)         -> Promise<number>
 *   Offline.listQueue(tournamentId)           -> Promise<item[]>   (seq order)
 *   Offline.clearQueue(tournamentId)          -> Promise<{deleted}>
 *
 * REPLAY
 *   Offline.sync(callFn, opts)
 *          -> Promise<{applied, rejected, stopped, remaining, ...}>
 *   Offline.listRejected(tournamentId)        -> Promise<item[]>
 *   Offline.clearRejected(tournamentId)       -> Promise<{deleted}>
 *
 * CONSTANTS a page may read
 *   Offline.OFFLINE_BANNER_TEXT   'OFFLINE — results are not yet saved.'
 *   Offline.FAILURE_THRESHOLD     3
 *   Offline.HARD_ERROR_CODES      string[]
 *
 * ===========================================================================
 * DOM / CSS THIS MODULE EMITS: NONE.
 * ===========================================================================
 *
 * This is a data module. It creates no elements and sets no class names. The
 * banner is the page's job. What the page must render, exactly:
 *
 *  1. WHEN `Offline.isOffline()` IS TRUE — a permanent, unmissable banner, at
 *     the top of the viewport, that cannot be dismissed and does not scroll
 *     away. Its text is fixed by CONTRACTS-PHASE4-7.md §5.5.3:
 *
 *         OFFLINE — results are not yet saved.
 *
 *     Use `Offline.OFFLINE_BANNER_TEXT` rather than retyping it; the em dash
 *     and the full stop are part of the contract. Colour is never the only
 *     signal (DESIGN.md §51): pair it with the word OFFLINE and a shape.
 *     Alongside it show `Offline.queueLength()` — "4 results waiting to save"
 *     — and a standing reminder that the paper sheet is the real record.
 *
 *  2. WHEN `Offline.isOffline()` IS FALSE BUT THE QUEUE IS NOT EMPTY — a
 *     different, still-visible banner: back online, N results not yet saved,
 *     with a Sync button. Do not auto-sync silently; the organiser must see
 *     the result of the replay.
 *
 *  3. AFTER A SYNC THAT RETURNED A NON-EMPTY `rejected` — a list the organiser
 *     must work through by hand, one row per rejected item, showing the
 *     server's message and the original payload. Rejected items stay in
 *     storage until `clearRejected` is called, so this survives a reload.
 *
 *  4. AFTER A SYNC THAT RETURNED A NON-NULL `stopped` — replay halted part
 *     way. Show which item stopped it and why, and that the rest of the queue
 *     is untouched and still safe.
 *
 *  5. `Offline.isPackReady().ready === false` — the pack is incomplete. Say
 *     how incomplete (the counts are in the same object) and offer a re-run.
 *     An incomplete pack is still usable for the players it does hold; it is
 *     just not the whole tournament.
 *
 * ===========================================================================
 * TRANSPORT — why this module never calls the network itself
 * ===========================================================================
 *
 * CONTRACTS-PHASE1.md §4 rule 4: every network call goes through `API`.
 * `tools/check.js` enforces it — a bare `fetch(` in any frontend file other
 * than `api.js` fails the build. So there is no `fetch` here.
 *
 *   listFn(tournamentId, page, pageSize) -> Promise<{rows, total, totalPages}>
 *       Defaults to `API.call('player.list', ...)` (CONTRACTS-PHASE2.md §1),
 *       filtered to paymentStatus VERIFIED and withdrawn false. That is a
 *       global reference resolved at call time, not an import, so this module
 *       stays loadable and testable outside a browser.
 *
 *   imageFn(url, player) -> Promise<Blob|ArrayBuffer|Uint8Array>
 *       There is NO default. Two reasons, both real:
 *         a. Only api.js is allowed to issue requests (above).
 *         b. `photo_thumb_url` is a drive.google.com/thumbnail URL
 *            (DESIGN.md §2.3, §3). Reading its BYTES cross-origin needs a
 *            CORS header Drive does not reliably send. An <img> tag renders
 *            it fine; `fetch` may not be able to read it. Whether it works is
 *            a property of the deployment, not of this module.
 *       So the page — or better, a small `API.getBytes(url)` added to api.js —
 *       supplies it. If none is supplied `downloadPack` REJECTS with
 *       NO_IMAGE_FETCHER. It does not quietly cache a pack with no photos:
 *       an organiser who clicked "Download offline pack" and saw a green tick
 *       would find out at the worst possible moment.
 *       Pass `{imagesOptional: true}` to deliberately accept a text-only pack.
 *
 * ===========================================================================
 * STORAGE
 * ===========================================================================
 *
 * IndexedDB, database `ca-offline`, version 1. Object stores:
 *
 *   packMeta   keyPath 'tournament_id'   one row per tournament
 *   players    keyPath 'key'             key = '<tournamentId>::<serialNo>'
 *   images     keyPath 'player_id'       carries tournament_id for scoping
 *   queue      keyPath 'seq', autoIncrement — IndexedDB owns the monotonic
 *                                        sequence and persists the generator
 *                                        across reloads, which is exactly the
 *                                        guarantee the replay order needs
 *   rejected   keyPath 'seq'             items the server refused, kept
 *   kv         keyPath 'k'               counters for the localStorage path
 *
 * Every key is namespaced by tournament id, so two tournaments on the same
 * laptop cannot mix. `clearPack('A')` cannot touch tournament B.
 *
 * FALLBACK. If IndexedDB cannot be opened (private browsing, a blocked
 * upgrade, a browser without it) the module falls back to localStorage for
 * the JSON only, under keys `ca.offline.*`. IMAGE BYTES CANNOT GO THERE —
 * localStorage holds ~5 MB of UTF-16 strings and 400 thumbnails is well past
 * that, and base64 would inflate it by a third again. In that mode the pack
 * is marked `degraded: true` with an explicit warning string, `imageCount` is
 * 0, and `getImage` returns null. The page must say "photos will not be
 * available offline" rather than let the organiser discover it live.
 *
 * FAILURE MODES, EACH WITH ITS OWN ERROR CODE, NEVER A SILENT NO-OP:
 *   IDB_UNAVAILABLE     no indexedDB on this global at all
 *   IDB_BLOCKED         open() threw or hung — usually private browsing, or
 *                       another tab holding an older version of the database
 *   IDB_UPGRADE_FAILED  onupgradeneeded threw, or the stored database is
 *                       NEWER than this code (an old tab against new code)
 *   QUOTA_EXCEEDED      the device is out of storage mid-write
 *   IDB_ERROR           anything else IndexedDB reported
 *   NO_STORAGE          neither IndexedDB nor localStorage works
 *   NO_IMAGE_FETCHER    downloadPack with no imageFn and no imagesOptional
 *   NO_PLAYER_SOURCE    downloadPack with no listFn and no global API
 *   BAD_ARGUMENT        a caller passed a blank tournament id, etc.
 *   SYNC_IN_PROGRESS    sync called while a sync is already running
 *
 * Rejections are Error objects carrying `.code` and `.message`, the same two
 * fields api.js rejects with (CONTRACTS.md §3), so a page can handle an
 * Offline error and an API error with one code switch.
 *
 * ===========================================================================
 * CRASH SAFETY — the rule that matters most
 * ===========================================================================
 *
 * `enqueue` resolves ONLY after the write is durable. Never show the organiser
 * "Sold to Chennai Warriors" before that promise settles, and never hold a
 * result in a variable "until the network comes back". A browser crash or a
 * closed lid halfway through the auction must not lose a recorded sale — the
 * queue is read back from storage on the next load with its sequence numbers
 * and idempotency ids intact.
 *
 * ===========================================================================
 * REPLAY SEMANTICS — CONTRACTS-PHASE4-7.md §5.5.4
 * ===========================================================================
 *
 * `sync(callFn)` walks the queue in ascending `seq`, one at a time, never in
 * parallel. Each item is handed to `callFn(action, payload, meta)`, which the
 * page implements as `API.call(action, payload)`. Three outcomes:
 *
 *   APPLIED    callFn resolved. The item is deleted from the queue and listed
 *              in `applied`. Replay continues.
 *
 *   REJECTED   callFn rejected with a business verdict — TEAM_FULL,
 *              INSUFFICIENT_PURSE, PLAYER_NOT_PENDING, ALREADY_ASSIGNED and
 *              the rest of CONTRACTS.md §3. The server has decided; retrying
 *              would produce the same answer. The item moves out of the queue
 *              into the `rejected` store and is returned in `rejected` with
 *              the server's exact message and the original payload. It is
 *              never dropped and it is never forced through. Replay continues,
 *              because a refused write changed nothing on the server and the
 *              items behind it are still valid — a rejected sale actually
 *              frees purse for the next one.
 *
 *   STOPPED    callFn rejected with a hard failure — NETWORK, SYSTEM_BUSY,
 *              UNAUTHORIZED, INTERNAL_ERROR, STALE_STATE, or anything with no
 *              recognisable code. We do not know whether the server applied
 *              it. Replay STOPS immediately. The item and everything after it
 *              stay in the queue in order. Auction writes are order dependent
 *              — a later sale can only be judged against the purse a previous
 *              one left behind — so continuing past an unknown outcome would
 *              be guessing with somebody's money.
 *
 * STALE_STATE IS DELIBERATELY A HARD STOP, and it is the one every integrator
 * gets wrong. `auction.markSold` checks `expectedVersion` first
 * (CONTRACTS-PHASE4-7.md §4.1 step 1). A version captured while offline is
 * guaranteed stale by the time it replays, so every queued item would fail.
 *
 *   >> DO NOT PUT `expectedVersion` IN A QUEUED PAYLOAD. <<
 *
 * Either omit it and let `callFn` attach the CURRENT version immediately
 * before each call, or omit it entirely. This is not a validation bypass: the
 * version check exists to stop a stale open tab acting on old information,
 * and the other two protections from §4.1 — the lock, and the re-read that
 * makes a second caller see SOLD — are untouched and still prevent a double
 * sale. If a STALE_STATE does reach us the replay halts loudly rather than
 * marching the whole queue into the same wall.
 *
 * `meta.idempotencyId` is passed to `callFn` as the third argument. The
 * current backend ignores it. It is generated and persisted anyway so that a
 * replay can be de-duplicated the day the backend grows that check, and so a
 * queued row can be traced to an audit entry by hand today.
 *
 * ===========================================================================
 * Vanilla JS, no framework, no build step, no CDN, no dependency
 * (CONTRACTS.md §15). textContent-only does not apply — no DOM is touched.
 */

/* eslint-disable no-unused-vars */
const Offline = {

  /* ================================================================== *
   * Constants
   * ================================================================== */

  /** Exact banner copy from CONTRACTS-PHASE4-7.md §5.5.3. Do not retype it. */
  OFFLINE_BANNER_TEXT: 'OFFLINE — results are not yet saved.',

  /**
   * Consecutive poll failures before we switch to offline mode.
   * THREE, not one. A single blip — one slow lock, one dropped packet — must
   * not flip a live auction into offline mode in front of an audience.
   * DESIGN.md §16 and CONTRACTS-PHASE4-7.md §5.5.2.
   */
  FAILURE_THRESHOLD: 3,

  /**
   * Error codes that STOP a replay instead of being recorded as a rejection.
   * See "REPLAY SEMANTICS" above. Anything not in this list, and not blank, is
   * treated as a considered server verdict.
   * @type {string[]}
   */
  HARD_ERROR_CODES: [
    'NETWORK',            // never reached the server; outcome unknown
    'NOT_CONFIGURED',     // API_BASE_URL not set; nothing will work
    'SYSTEM_BUSY',        // lock contention; the item is still valid, retry later
    'UNAUTHORIZED',       // session expired mid-replay; log in and resume
    'FORBIDDEN',          // wrong role or wrong tournament; a wiring bug
    'INTERNAL_ERROR',     // unhandled server error; outcome unknown
    'BAD_REQUEST',        // malformed payload; every later item is suspect too
    'STALE_STATE'         // see the long note in the header block
  ],

  DB_NAME: 'ca-offline',
  DB_VERSION: 1,
  STORE_PACK: 'packMeta',
  STORE_PLAYERS: 'players',
  STORE_IMAGES: 'images',
  STORE_QUEUE: 'queue',
  STORE_REJECTED: 'rejected',
  STORE_KV: 'kv',

  /** localStorage key prefix for the degraded path. Namespaced, never bare. */
  LS_PREFIX: 'ca.offline.',

  /** How long to wait for indexedDB.open before calling it blocked, in ms. */
  OPEN_TIMEOUT_MS: 8000,

  /** Players fetched per `player.list` page. The action caps pageSize at 200. */
  PAGE_SIZE: 200,

  /* ================================================================== *
   * Mutable state. All of it is either a cache of storage or a runtime
   * detail that is allowed to reset on reload.
   * ================================================================== */

  /** @type {{listFn: function|null, imageFn: function|null}} */
  _transport: { listFn: null, imageFn: null },

  /** @type {Promise|null} memoised indexedDB.open */
  _dbPromise: null,
  /** @type {Promise|null} memoised "which backend are we on" */
  _backendPromise: null,

  /** Consecutive poll failures since the last success. */
  _failures: 0,
  /** True once _failures reached FAILURE_THRESHOLD, or setOffline(true). */
  _offline: false,
  /** Why we last changed state; surfaced in the change event. */
  _reason: '',

  /** @type {function[]} onChange subscribers */
  _subs: [],

  /**
   * Last known queue length. A cache for the synchronous change event only.
   * `queueLength()` always re-reads storage and is the authoritative answer.
   */
  _queueLen: 0,

  /** Guard against two overlapping replays. */
  _syncing: false,

  /**
   * playerId -> {url, tid}. Memoised so repeated reveals do not leak one blob
   * URL per call. The tournament id is kept alongside so a scoped `getImage`
   * cannot be short-circuited by the cache into returning another
   * tournament's photograph.
   * @type {Object<string,{url:string, tid:string}>}
   */
  _urls: {},

  /* ================================================================== *
   * 1. Wiring
   * ================================================================== */

  /**
   * Install the two functions this module needs to reach the network.
   * Call once at boot, before `downloadPack`. See "TRANSPORT" in the header.
   *
   * @param {Object} t
   * @param {function(string, number, number): Promise<Object>} [t.listFn]
   *        (tournamentId, page, pageSize) -> {rows, total, totalPages}
   * @param {function(string, Object): Promise<*>} [t.imageFn]
   *        (thumbUrl, player) -> Blob | ArrayBuffer | Uint8Array
   * @return {void}
   */
  setTransport: function (t) {
    const spec = t || {};
    if (typeof spec.listFn === 'function') Offline._transport.listFn = spec.listFn;
    if (typeof spec.imageFn === 'function') Offline._transport.imageFn = spec.imageFn;
  },

  /**
   * Which storage backend we actually got, and whether it is degraded.
   * Safe to call before anything else; it is what a settings screen shows.
   *
   * @return {Promise<{kind:string, degraded:boolean, images:boolean, reason:string}>}
   */
  storageInfo: function () {
    return Offline._backend().then(function (b) {
      return {
        kind: b.kind,
        degraded: b.kind !== 'idb',
        images: b.kind === 'idb',
        reason: b.reason || ''
      };
    });
  },

  /**
   * Forget the memoised database handle and backend choice. Only useful after
   * a failure the user has since fixed (closed the other tab, left private
   * browsing), and in tests.
   * @return {void}
   */
  resetStorage: function () {
    Offline._dbPromise = null;
    Offline._backendPromise = null;
  },

  /* ================================================================== *
   * 2. The pack
   * ================================================================== */

  /**
   * Cache every auction-eligible player and their thumbnail bytes for one
   * tournament, so the console and the projector keep working with no network.
   *
   * Writes an INCOMPLETE marker before it starts and only stamps the pack
   * complete at the very end. A crash, a closed lid or a reload halfway
   * through therefore leaves `isPackReady().ready === false`, which is the
   * truth. It never reports success for a partial download.
   *
   * @param {string} tournamentId
   * @param {function(Object)} [onProgress] called often, with
   *        {phase, done, total, label, tournamentId}. phase is one of
   *        'start' | 'players' | 'images' | 'done'. Exceptions thrown by this
   *        callback are swallowed — a rendering bug must not abort the pack.
   * @param {Object} [opts]
   * @param {function} [opts.listFn]   overrides the installed transport
   * @param {function} [opts.imageFn]  overrides the installed transport
   * @param {boolean}  [opts.imagesOptional]  accept a text-only pack on purpose
   * @param {number}   [opts.pageSize]
   * @return {Promise<{tournamentId, playerCount, imageCount, expectedPlayers,
   *                   expectedImages, imageFailures, complete, degraded,
   *                   storage, downloadedAt, warnings}>}
   * @throws {Error} with .code — see the failure-mode list in the header.
   */
  downloadPack: function (tournamentId, onProgress, opts) {
    const tid = Offline._requireId(tournamentId);
    if (tid instanceof Error) return Promise.reject(tid);

    const options = opts || {};
    const progress = Offline._progressFn(onProgress, tid);
    const pageSize = options.pageSize || Offline.PAGE_SIZE;
    const imagesOptional = options.imagesOptional === true;

    const listFn = options.listFn || Offline._transport.listFn || Offline._defaultListFn();
    if (!listFn) {
      return Promise.reject(Offline._err('NO_PLAYER_SOURCE',
        'Cannot download the offline pack: no player source. Load api.js first, ' +
        'or call Offline.setTransport({listFn}).'));
    }

    const imageFn = options.imageFn || Offline._transport.imageFn;

    let backend = null;
    let players = [];
    const warnings = [];
    const imageFailures = [];
    let imageCount = 0;

    return Offline._backend()
      .then(function (b) {
        backend = b;
        if (b.kind !== 'idb') {
          warnings.push(
            'IndexedDB is not available (' + (b.reason || 'unknown reason') + '), so this ' +
            'pack is stored in localStorage and holds PLAYER DETAILS ONLY. Photographs ' +
            'are not cached — localStorage cannot hold image bytes. Offline screens will ' +
            'show names and serial numbers with no picture.');
        } else if (!imageFn && imagesOptional) {
          warnings.push(
            'No image fetcher was supplied and imagesOptional was set, so this pack holds ' +
            'PLAYER DETAILS ONLY. Offline screens will show no photographs.');
        }

        if (b.kind === 'idb' && !imageFn && !imagesOptional) {
          throw Offline._err('NO_IMAGE_FETCHER',
            'Cannot download photographs: no image fetcher is installed. Add ' +
            'API.getBytes(url) to api.js, or call Offline.setTransport({imageFn}), or ' +
            'pass {imagesOptional:true} to accept a pack with no photographs.');
        }

        // Mark it incomplete FIRST. Everything after this point can die and
        // isPackReady will still tell the truth.
        return Offline._writeMeta(backend, {
          tournament_id: tid,
          complete: false,
          started_at: Offline._nowIso(),
          downloaded_at: '',
          player_count: 0,
          image_count: 0,
          expected_players: 0,
          expected_images: 0,
          image_failures: [],
          degraded: backend.kind !== 'idb',
          storage: backend.kind,
          warnings: warnings.slice()
        });
      })
      .then(function () {
        progress({ phase: 'start', done: 0, total: 0, label: 'Fetching the player list…' });
        return Offline._fetchAllPlayers(tid, listFn, pageSize, progress);
      })
      .then(function (rows) {
        players = rows;
        return Offline._clearPlayers(backend, tid);
      })
      .then(function () {
        return Offline._writePlayers(backend, tid, players, progress);
      })
      .then(function () {
        const withPhotos = (backend.kind === 'idb' && imageFn)
          ? players.filter(function (p) { return !!p.photo_thumb_url; })
          : [];

        return Offline._downloadImages(tid, withPhotos, imageFn, progress, players.length)
          .then(function (res) {
            imageCount = res.stored;
            res.failures.forEach(function (f) { imageFailures.push(f); });
            return res;
          });
      })
      .then(function () {
        const expectedImages = (backend.kind === 'idb' && imageFn)
          ? players.filter(function (p) { return !!p.photo_thumb_url; }).length
          : 0;

        const complete = players.length > 0 &&
          imageCount === expectedImages &&
          imageFailures.length === 0;

        if (!complete && players.length === 0) {
          warnings.push('The server returned no eligible players for this tournament. ' +
            'Verify some payments first (CONTRACTS-PHASE2.md §1) and download again.');
        }
        if (imageFailures.length) {
          warnings.push(imageFailures.length + ' of ' + expectedImages +
            ' photographs could not be cached. Run the download again before the auction.');
        }

        const meta = {
          tournament_id: tid,
          complete: complete,
          started_at: '',
          downloaded_at: Offline._nowIso(),
          player_count: players.length,
          image_count: imageCount,
          expected_players: players.length,
          expected_images: expectedImages,
          image_failures: imageFailures,
          degraded: backend.kind !== 'idb' || expectedImages === 0,
          storage: backend.kind,
          warnings: warnings
        };

        return Offline._writeMeta(backend, meta).then(function () {
          progress({
            phase: 'done',
            done: players.length + imageCount,
            total: players.length + expectedImages,
            label: complete ? 'Offline pack ready.' : 'Offline pack incomplete.'
          });
          return {
            tournamentId: tid,
            playerCount: players.length,
            imageCount: imageCount,
            expectedPlayers: players.length,
            expectedImages: expectedImages,
            imageFailures: imageFailures,
            complete: complete,
            degraded: meta.degraded,
            storage: backend.kind,
            downloadedAt: meta.downloaded_at,
            warnings: warnings
          };
        });
      });
  },

  /**
   * Is there a usable pack for this tournament, and how complete is it?
   *
   * `ready` is strict. It is true only when the last download finished and
   * every player row AND every expected photograph landed. A pack with 398 of
   * 400 photos reports ready:false with the counts, because the organiser
   * needs to decide whether to re-run it, not to be reassured.
   *
   * `ready:false` does not mean unusable — `getPlayer` still serves whatever
   * was cached. It means incomplete.
   *
   * @param {string} tournamentId
   * @return {Promise<{ready, playerCount, imageCount, downloadedAt, complete,
   *                   degraded, storage, expectedPlayers, expectedImages,
   *                   imageFailures, warnings, exists}>}
   */
  isPackReady: function (tournamentId) {
    const tid = Offline._requireId(tournamentId);
    if (tid instanceof Error) return Promise.reject(tid);

    const empty = {
      ready: false, playerCount: 0, imageCount: 0, downloadedAt: null,
      complete: false, degraded: false, storage: 'none',
      expectedPlayers: 0, expectedImages: 0, imageFailures: [],
      warnings: ['No offline pack has been downloaded for this tournament.'],
      exists: false
    };

    return Offline._backend()
      .then(function (b) { return Offline._readMeta(b, tid); })
      .then(function (meta) {
        if (!meta) return empty;
        const playerCount = meta.player_count || 0;
        const imageCount = meta.image_count || 0;
        return {
          ready: meta.complete === true,
          playerCount: playerCount,
          imageCount: imageCount,
          downloadedAt: meta.downloaded_at || null,
          complete: meta.complete === true,
          degraded: meta.degraded === true,
          storage: meta.storage || 'unknown',
          expectedPlayers: meta.expected_players || 0,
          expectedImages: meta.expected_images || 0,
          imageFailures: meta.image_failures || [],
          warnings: meta.warnings || [],
          exists: true
        };
      })
      .catch(function (err) {
        // Storage itself is broken. That is not "no pack", it is a fault, and
        // saying ready:false with the reason is the honest answer.
        const out = Offline._assign({}, empty);
        out.storage = 'error';
        out.warnings = [(err && err.message) || 'The offline store could not be read.'];
        return out;
      });
  },

  /**
   * Delete one tournament's cached players, thumbnails and pack metadata.
   * Scoped: another tournament's pack, and the queue, are untouched.
   * @param {string} tournamentId
   * @return {Promise<{playersDeleted:number, imagesDeleted:number}>}
   */
  clearPack: function (tournamentId) {
    const tid = Offline._requireId(tournamentId);
    if (tid instanceof Error) return Promise.reject(tid);

    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') {
        const ls = Offline._ls();
        const raw = Offline._lsGet(ls, 'pack.' + tid);
        const count = (raw && raw.players) ? raw.players.length : 0;
        Offline._lsRemove(ls, 'pack.' + tid);
        Offline._revokeFor(null);
        return { playersDeleted: count, imagesDeleted: 0 };
      }

      let playersDeleted = 0;
      let imagesDeleted = 0;

      return Offline._run([Offline.STORE_PLAYERS, Offline.STORE_IMAGES], 'readonly', function (s) {
        return [s[Offline.STORE_PLAYERS].getAll(), s[Offline.STORE_IMAGES].getAll()];
      }).then(function (res) {
        const playerKeys = (res[0] || [])
          .filter(function (r) { return r && r.tournament_id === tid; })
          .map(function (r) { return r.key; });
        const imageKeys = (res[1] || [])
          .filter(function (r) { return r && r.tournament_id === tid; })
          .map(function (r) { return r.player_id; });

        playersDeleted = playerKeys.length;
        imagesDeleted = imageKeys.length;
        imageKeys.forEach(function (pid) { Offline._revokeFor(pid); });

        return Offline._run(
          [Offline.STORE_PLAYERS, Offline.STORE_IMAGES, Offline.STORE_PACK],
          'readwrite',
          function (s) {
            const reqs = [];
            playerKeys.forEach(function (k) { reqs.push(s[Offline.STORE_PLAYERS].delete(k)); });
            imageKeys.forEach(function (k) { reqs.push(s[Offline.STORE_IMAGES].delete(k)); });
            reqs.push(s[Offline.STORE_PACK].delete(tid));
            return reqs;
          }
        );
      }).then(function () {
        return { playersDeleted: playersDeleted, imagesDeleted: imagesDeleted };
      });
    });
  },

  /* ================================================================== *
   * 3. Reading the pack
   * ================================================================== */

  /**
   * One cached player by serial number, so the console can keep calling
   * "player 27" with no network.
   *
   * @param {string} tournamentId
   * @param {(string|number)} serialNo
   * @return {Promise<Object|null>} {player_id, serial_no, name, role, style,
   *         age_years, photo_thumb_url, tournament_id} or null if not cached.
   */
  getPlayer: function (tournamentId, serialNo) {
    const tid = Offline._requireId(tournamentId);
    if (tid instanceof Error) return Promise.reject(tid);

    const serial = Offline._normSerial(serialNo);
    if (serial === '') {
      return Promise.reject(Offline._err('BAD_ARGUMENT', 'A serial number is required.'));
    }

    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') {
        const raw = Offline._lsGet(Offline._ls(), 'pack.' + tid);
        const rows = (raw && raw.players) || [];
        let hit = null;
        rows.forEach(function (r) {
          if (!hit && Offline._normSerial(r.serial_no) === serial) hit = r;
        });
        return hit;
      }
      return Offline._run(Offline.STORE_PLAYERS, 'readonly', function (s) {
        return [s[Offline.STORE_PLAYERS].get(Offline._playerKey(tid, serial))];
      }).then(function (res) {
        const row = res[0];
        return (row && row.tournament_id === tid) ? row : null;
      });
    });
  },

  /**
   * Every cached player for one tournament, in serial order.
   * @param {string} tournamentId
   * @return {Promise<Object[]>}
   */
  getPlayers: function (tournamentId) {
    const tid = Offline._requireId(tournamentId);
    if (tid instanceof Error) return Promise.reject(tid);

    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') {
        const raw = Offline._lsGet(Offline._ls(), 'pack.' + tid);
        return ((raw && raw.players) || []).slice();
      }
      return Offline._run(Offline.STORE_PLAYERS, 'readonly', function (s) {
        return [s[Offline.STORE_PLAYERS].getAll()];
      }).then(function (res) {
        return (res[0] || []).filter(function (r) { return r && r.tournament_id === tid; });
      });
    }).then(function (rows) {
      return rows.sort(function (a, b) {
        return Number(a.serial_no || 0) - Number(b.serial_no || 0);
      });
    });
  },

  /**
   * An object URL for a cached thumbnail, ready for `img.src`.
   *
   * The URL is memoised per player, so calling this on every reveal does not
   * leak one blob URL per call. Call `Offline.revokeImages()` on unload.
   *
   * Returns null — not an error — when the photo is simply not cached, which
   * is the normal case on the localStorage fallback. The caller should fall
   * back to the live `photo_thumb_url`, which still works when there is
   * network, and to a placeholder when there is not.
   *
   * @param {string} playerId
   * @param {string} [tournamentId] optional scope check; when given, a photo
   *        belonging to another tournament is treated as absent.
   * @return {Promise<string|null>}
   */
  getImage: function (playerId, tournamentId) {
    const pid = String(playerId || '').trim();
    if (!pid) return Promise.resolve(null);
    const scope = tournamentId ? String(tournamentId) : '';

    const memo = Offline._urls[pid];
    if (memo) {
      // The scope check runs against the cache too, or the second caller for
      // the same player id would get a photo the first caller was allowed and
      // they are not.
      return Promise.resolve((scope && memo.tid !== scope) ? null : memo.url);
    }

    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') return null;
      return Offline._run(Offline.STORE_IMAGES, 'readonly', function (s) {
        return [s[Offline.STORE_IMAGES].get(pid)];
      }).then(function (res) {
        const row = res[0];
        if (!row || !row.blob) return null;
        if (scope && row.tournament_id !== scope) return null;
        const url = Offline._toObjectUrl(row.blob, row.mime);
        if (url) Offline._urls[pid] = { url: url, tid: String(row.tournament_id || '') };
        return url;
      });
    }).catch(function () {
      // A read fault here must not black out the projector. The caller still
      // has photo_thumb_url. Storage faults are reported by isPackReady.
      return null;
    });
  },

  /**
   * Release every object URL handed out by `getImage`. Call on page unload or
   * when leaving the auction screen.
   * @return {void}
   */
  revokeImages: function () {
    Object.keys(Offline._urls).forEach(function (pid) { Offline._revokeFor(pid); });
  },

  /* ================================================================== *
   * 4. Failure detection
   * ================================================================== */

  /**
   * Record ONE failed poll or failed write.
   *
   * Three consecutive failures switch to offline mode — not one. A single
   * blip must not flip a live auction in front of an audience, and the poll
   * already runs every 2 s (DESIGN.md §7.4), so three failures is at most
   * about six seconds of genuinely dead network.
   *
   * @param {string} [reason] short text for the change event, e.g. an error code
   * @return {boolean} true if THIS call flipped us into offline mode
   */
  noteFailure: function (reason) {
    Offline._failures += 1;
    if (!Offline._offline && Offline._failures >= Offline.FAILURE_THRESHOLD) {
      Offline._offline = true;
      Offline._reason = reason ? String(reason) : 'poll failed ' + Offline._failures + ' times';
      Offline._emit();
      return true;
    }
    return false;
  },

  /**
   * Record one successful call. Resets the consecutive-failure counter and,
   * if we were offline, brings us back online.
   * @return {boolean} true if THIS call flipped us back online
   */
  noteSuccess: function () {
    Offline._failures = 0;
    if (Offline._offline) {
      Offline._offline = false;
      Offline._reason = 'a call succeeded';
      Offline._emit();
      return true;
    }
    return false;
  },

  /** @return {boolean} */
  isOffline: function () { return Offline._offline === true; },

  /** @return {number} consecutive failures since the last success */
  failureCount: function () { return Offline._failures; },

  /**
   * Manual override, for a pre-auction drill or for an organiser who can see
   * the network is dead and does not want to wait for three polls.
   * @param {boolean} flag
   * @param {string} [reason]
   * @return {boolean} true if the state changed
   */
  setOffline: function (flag, reason) {
    const next = flag === true;
    if (next === Offline._offline) return false;
    Offline._offline = next;
    Offline._failures = next ? Offline.FAILURE_THRESHOLD : 0;
    Offline._reason = reason ? String(reason) : (next ? 'switched on by hand' : 'switched off by hand');
    Offline._emit();
    return true;
  },

  /**
   * Subscribe to offline-state and queue-length changes. Fires immediately
   * with the current state so a banner can render without a first poll.
   *
   * @param {function(Object)} cb receives
   *        {offline, consecutiveFailures, queueLength, reason, bannerText}
   * @return {function()} unsubscribe
   */
  onChange: function (cb) {
    if (typeof cb !== 'function') return function () {};
    Offline._subs.push(cb);
    try { cb(Offline._state()); } catch (e) { Offline._warn('onChange listener threw', e); }
    return function () {
      const i = Offline._subs.indexOf(cb);
      if (i !== -1) Offline._subs.splice(i, 1);
    };
  },

  /* ================================================================== *
   * 5. The queue
   * ================================================================== */

  /**
   * Persist one pending write. Resolves ONLY once the record is durable, so
   * a page may show "Sold" the moment this settles and not before.
   *
   * @param {string} action  e.g. 'auction.markSold'
   * @param {Object} payload exactly what would have gone to the server. Do NOT
   *        include `expectedVersion` — see the header note on STALE_STATE.
   * @return {Promise<{seq:number, id:string, createdAt:string}>}
   *         `seq` is monotonic and survives a reload; `id` is the client
   *         idempotency id, generated here and never regenerated.
   */
  enqueue: function (action, payload) {
    const act = String(action || '').trim();
    if (!act) {
      return Promise.reject(Offline._err('BAD_ARGUMENT', 'enqueue needs an action name.'));
    }
    const body = payload || {};
    const tid = String(body.tournamentId || body.tournament_id || '');

    const record = {
      id: Offline._newId(),
      tournament_id: tid,
      action: act,
      payload: body,
      created_at: Offline._nowIso(),
      attempts: 0,
      last_error: null
    };

    if (Object.prototype.hasOwnProperty.call(body, 'expectedVersion')) {
      Offline._warn('Offline.enqueue: payload carries expectedVersion. It will be stale ' +
        'by replay time and the server will answer STALE_STATE. See offline.js header.');
    }

    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') {
        const ls = Offline._ls();
        const q = Offline._lsGet(ls, 'queue') || [];
        const seq = Offline._lsNextSeq(ls, q);
        record.seq = seq;
        q.push(record);
        Offline._lsSet(ls, 'queue', q);
        Offline._queueLen = q.length;
        Offline._emit();
        return { seq: seq, id: record.id, createdAt: record.created_at };
      }

      // keyPath 'seq' with autoIncrement: IndexedDB assigns the number and
      // persists its generator, which is what makes the ordering survive a
      // reload without us maintaining a counter that could race between tabs.
      return Offline._run(Offline.STORE_QUEUE, 'readwrite', function (s) {
        return [s[Offline.STORE_QUEUE].put(record)];
      }).then(function (res) {
        const seq = res[0];
        record.seq = seq;
        return Offline._countQueue().then(function (n) {
          Offline._queueLen = n;
          Offline._emit();
          return { seq: seq, id: record.id, createdAt: record.created_at };
        });
      });
    });
  },

  /**
   * How many writes are waiting. Reads storage every time; this is the number
   * the banner must show.
   * @param {string} [tournamentId] count only this tournament's items
   * @return {Promise<number>}
   */
  queueLength: function (tournamentId) {
    return Offline.listQueue(tournamentId).then(function (rows) {
      if (!tournamentId) Offline._queueLen = rows.length;
      return rows.length;
    });
  },

  /**
   * The pending queue in ascending sequence order — replay order.
   * @param {string} [tournamentId]
   * @return {Promise<Object[]>} {seq, id, tournament_id, action, payload,
   *         created_at, attempts, last_error}
   */
  listQueue: function (tournamentId) {
    return Offline._readList(Offline.STORE_QUEUE, 'queue', tournamentId);
  },

  /**
   * Drop pending items. DESTRUCTIVE — a queued sale that has not synced is
   * lost. Only for cleanup between tournaments, and only behind a confirm.
   * @param {string} [tournamentId] scope to one tournament; omit to clear all
   * @return {Promise<{deleted:number}>}
   */
  clearQueue: function (tournamentId) {
    return Offline._clearList(Offline.STORE_QUEUE, 'queue', tournamentId, 'seq')
      .then(function (out) {
        return Offline._countQueue().then(function (n) {
          Offline._queueLen = n;
          Offline._emit();
          return out;
        });
      });
  },

  /* ================================================================== *
   * 6. Replay
   * ================================================================== */

  /**
   * Replay the queue against the live server, in order, one at a time.
   *
   * Read "REPLAY SEMANTICS" in the header before changing anything here. The
   * short version: applied items are deleted, server rejections are moved to
   * the rejected store and returned for a human decision, and the first hard
   * failure stops the run with the rest of the queue intact.
   *
   * @param {function(string, Object, Object): Promise<*>} callFn
   *        (action, payload, meta) -> Promise. The page passes
   *        `function (a, p) { return API.call(a, p); }`. Injected rather than
   *        imported so this module never depends on api.js and stays testable.
   *        `meta` is {idempotencyId, seq, tournamentId, createdAt, attempts}.
   * @param {Object} [opts]
   * @param {string} [opts.tournamentId] replay only this tournament's items
   * @param {function(Object)} [opts.onProgress] {done, total, seq, action}
   * @param {function(Object):boolean} [opts.isHardFailure] override the
   *        HARD_ERROR_CODES classification
   * @return {Promise<{applied, rejected, stopped, remaining, total, ranAt}>}
   *         applied  [{seq, id, action, payload, result}]
   *         rejected [{seq, id, action, payload, error:{code,message}}]
   *         stopped  {seq, id, action, payload, error} | null
   */
  sync: function (callFn, opts) {
    if (typeof callFn !== 'function') {
      return Promise.reject(Offline._err('BAD_ARGUMENT',
        'Offline.sync needs a call function, e.g. (a, p) => API.call(a, p).'));
    }
    if (Offline._syncing) {
      return Promise.reject(Offline._err('SYNC_IN_PROGRESS',
        'A sync is already running. Wait for it to finish rather than starting a second one — ' +
        'two replays at once would send the same sale twice.'));
    }

    const options = opts || {};
    const tid = options.tournamentId ? String(options.tournamentId) : '';
    const isHard = typeof options.isHardFailure === 'function'
      ? options.isHardFailure
      : Offline._isHardFailure;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    const applied = [];
    const rejected = [];
    let stopped = null;
    let total = 0;

    Offline._syncing = true;

    return Offline.listQueue(tid || undefined)
      .then(function (items) {
        total = items.length;

        const step = function (i) {
          if (i >= items.length || stopped) return Promise.resolve();
          const item = items[i];

          if (onProgress) {
            try {
              onProgress({ done: i, total: total, seq: item.seq, action: item.action });
            } catch (e) { Offline._warn('sync onProgress threw', e); }
          }

          const meta = {
            idempotencyId: item.id,
            seq: item.seq,
            tournamentId: item.tournament_id,
            createdAt: item.created_at,
            attempts: (item.attempts || 0) + 1
          };

          let promise;
          try {
            promise = Promise.resolve(callFn(item.action, item.payload, meta));
          } catch (thrown) {
            promise = Promise.reject(thrown);
          }

          return promise.then(
            function (result) {
              // Applied. Delete only AFTER the server confirmed, so a crash
              // between the call and the delete replays it rather than losing
              // it. That is the safe direction: a duplicate is visible and
              // correctable, a lost sale is not.
              return Offline._deleteQueueItem(item.seq).then(function () {
                applied.push({
                  seq: item.seq, id: item.id, action: item.action,
                  payload: item.payload, result: result
                });
                Offline.noteSuccess();
                return step(i + 1);
              });
            },
            function (err) {
              const error = Offline._normError(err);

              if (isHard(error)) {
                // Outcome unknown, or the whole run is doomed. Stop. The item
                // and everything behind it stay queued, in order.
                stopped = {
                  seq: item.seq, id: item.id, action: item.action,
                  payload: item.payload, error: error,
                  hint: Offline._stopHint(error)
                };
                Offline.noteFailure(error.code);
                return Offline._bumpAttempt(item, error);
              }

              // A considered server verdict. Never dropped, never forced.
              // Moved out of the pending queue into the rejected store so it
              // survives a reload and the organiser can work through it.
              const row = {
                seq: item.seq, id: item.id, tournament_id: item.tournament_id,
                action: item.action, payload: item.payload,
                created_at: item.created_at, rejected_at: Offline._nowIso(),
                error: error
              };
              return Offline._moveToRejected(item.seq, row).then(function () {
                rejected.push({
                  seq: item.seq, id: item.id, action: item.action,
                  payload: item.payload, error: error
                });
                // The server answered, so the network is up.
                Offline.noteSuccess();
                return step(i + 1);
              });
            }
          );
        };

        return step(0);
      })
      .then(function () {
        return Offline._countQueue();
      })
      .then(function (remaining) {
        Offline._queueLen = remaining;
        Offline._syncing = false;
        Offline._emit();
        if (onProgress) {
          try { onProgress({ done: total, total: total, seq: null, action: null }); }
          catch (e) { Offline._warn('sync onProgress threw', e); }
        }
        return {
          applied: applied,
          rejected: rejected,
          stopped: stopped,
          remaining: remaining,
          total: total,
          ranAt: Offline._nowIso()
        };
      })
      .catch(function (err) {
        Offline._syncing = false;
        throw Offline._normError(err);
      });
  },

  /**
   * Items the server refused, kept for the organiser to decide about. They
   * are not in the pending queue any more and will not replay on their own.
   * @param {string} [tournamentId]
   * @return {Promise<Object[]>}
   */
  listRejected: function (tournamentId) {
    return Offline._readList(Offline.STORE_REJECTED, 'rejected', tournamentId);
  },

  /**
   * Forget rejected items, once the organiser has dealt with them on paper or
   * through `auction.correct`.
   * @param {string} [tournamentId]
   * @return {Promise<{deleted:number}>}
   */
  clearRejected: function (tournamentId) {
    return Offline._clearList(Offline.STORE_REJECTED, 'rejected', tournamentId, 'seq');
  },

  /* ================================================================== *
   * ================  INTERNALS BELOW THIS LINE  =====================
   * ================================================================== */

  /* ---------------------------------------------------------------- *
   * Environment access. Guarded, because this file is also loaded by a
   * Node test harness where none of these globals exist.
   * ---------------------------------------------------------------- */

  /** @return {Object} the global object, whatever it is called here */
  _global: function () {
    if (typeof globalThis !== 'undefined') return globalThis;
    if (typeof self !== 'undefined') return self;
    if (typeof window !== 'undefined') return window;
    return {};
  },

  /** @return {Object|null} indexedDB, or null when there is none */
  _idb: function () {
    const g = Offline._global();
    try {
      return g.indexedDB || g.mozIndexedDB || g.webkitIndexedDB || g.msIndexedDB || null;
    } catch (e) {
      // Some browsers throw on merely touching indexedDB in a sandboxed frame.
      return null;
    }
  },

  /** @return {Object|null} localStorage, or null when it is unusable */
  _ls: function () {
    try {
      const s = Offline._global().localStorage;
      if (!s) return null;
      // Safari private browsing has the object but throws on write.
      const probe = Offline.LS_PREFIX + 'probe';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (e) {
      return null;
    }
  },

  /** @return {string} an ISO instant. Display timestamps come from the server. */
  _nowIso: function () { return new Date().toISOString(); },

  /** @param {...*} args */
  _warn: function (msg, extra) {
    const g = Offline._global();
    if (g.console && typeof g.console.warn === 'function') {
      if (extra === undefined) g.console.warn(msg); else g.console.warn(msg, extra);
    }
  },

  /**
   * Build an Error carrying `.code`, matching the {code, message} shape
   * api.js rejects with (CONTRACTS.md §3) so pages need one code switch.
   * @param {string} code
   * @param {string} message
   * @param {*} [cause]
   * @return {Error}
   */
  _err: function (code, message, cause) {
    const e = new Error(message);
    e.code = code;
    if (cause !== undefined) e.cause = cause;
    return e;
  },

  /** Object.assign, spelled out so nothing here depends on a polyfill order. */
  _assign: function (target, src) {
    Object.keys(src || {}).forEach(function (k) { target[k] = src[k]; });
    return target;
  },

  /**
   * @param {*} value
   * @return {string|Error} the trimmed id, or an Error to reject with
   */
  _requireId: function (value) {
    const id = String(value === undefined || value === null ? '' : value).trim();
    if (!id) {
      return Offline._err('BAD_ARGUMENT',
        'A tournament id is required. Offline storage is namespaced per tournament so ' +
        'two tournaments on the same laptop can never mix.');
    }
    return id;
  },

  /** @return {string} '' when there is no usable serial */
  _normSerial: function (v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return '';
    const n = Number(s);
    return (isFinite(n) && String(n) !== 'NaN') ? String(n) : s;
  },

  /** @return {string} the namespaced players-store key */
  _playerKey: function (tid, serial) { return tid + '::' + serial; },

  /**
   * A client-generated idempotency id. Random, not derived from the payload:
   * two identical sales (same player, same team, same amount) recorded twice
   * by mistake must stay distinguishable so the organiser can see both.
   * Persisted with the record, so it is stable across reloads by construction.
   * @return {string}
   */
  _newId: function () {
    const g = Offline._global();
    try {
      if (g.crypto && typeof g.crypto.randomUUID === 'function') {
        return 'oq_' + g.crypto.randomUUID();
      }
      if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
        const buf = new Uint8Array(16);
        g.crypto.getRandomValues(buf);
        let hex = '';
        for (let i = 0; i < buf.length; i++) hex += (buf[i] + 0x100).toString(16).slice(1);
        return 'oq_' + hex;
      }
    } catch (e) { /* fall through to the time+random form */ }
    return 'oq_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10);
  },

  /** Wrap the caller's onProgress so a rendering bug cannot abort a download. */
  _progressFn: function (cb, tid) {
    return function (info) {
      if (typeof cb !== 'function') return;
      try {
        cb(Offline._assign({ tournamentId: tid }, info || {}));
      } catch (e) {
        Offline._warn('Offline.downloadPack: onProgress threw; continuing', e);
      }
    };
  },

  /* ---------------------------------------------------------------- *
   * Change notification
   * ---------------------------------------------------------------- */

  _state: function () {
    return {
      offline: Offline._offline,
      consecutiveFailures: Offline._failures,
      queueLength: Offline._queueLen,
      reason: Offline._reason,
      bannerText: Offline.OFFLINE_BANNER_TEXT
    };
  },

  _emit: function () {
    const snapshot = Offline._state();
    Offline._subs.slice().forEach(function (cb) {
      try { cb(snapshot); } catch (e) { Offline._warn('Offline.onChange listener threw', e); }
    });
  },

  /* ---------------------------------------------------------------- *
   * The IndexedDB promise wrapper.
   *
   * Small on purpose. Every request in one logical operation is issued
   * synchronously inside `build`, then we wait for tx.oncomplete. That
   * avoids the classic bug where awaiting between requests lets the
   * transaction auto-close, which Safari does aggressively.
   * ---------------------------------------------------------------- */

  /**
   * Open (and if needed upgrade) the database.
   * @return {Promise<Object>} the IDBDatabase
   */
  _openDb: function () {
    if (Offline._dbPromise) return Offline._dbPromise;

    const idb = Offline._idb();
    if (!idb) {
      return Promise.reject(Offline._err('IDB_UNAVAILABLE',
        'This browser has no IndexedDB, so the offline pack cannot store photographs. ' +
        'Player details will fall back to localStorage.'));
    }

    Offline._dbPromise = new Promise(function (resolve, reject) {
      let settled = false;
      let timer = null;

      const finish = function (fn, arg) {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          const g = Offline._global();
          if (typeof g.clearTimeout === 'function') g.clearTimeout(timer);
          timer = null;
        }
        fn(arg);
      };

      const fail = function (err) {
        // Do not memoise a failure: the user may close the other tab, or leave
        // private browsing, and a later retry should be allowed to succeed.
        Offline._dbPromise = null;
        finish(reject, err);
      };

      let req;
      try {
        req = idb.open(Offline.DB_NAME, Offline.DB_VERSION);
      } catch (e) {
        // Firefox private browsing throws InvalidStateError right here.
        fail(Offline._idbError(e,
          'IndexedDB could not be opened. This is usually private browsing mode.'));
        return;
      }

      const g = Offline._global();
      if (typeof g.setTimeout === 'function') {
        timer = g.setTimeout(function () {
          // Safari in private mode can leave open() hanging with no event at
          // all. A hang is a failure; treat it as one instead of waiting for
          // an event that will never arrive.
          fail(Offline._err('IDB_BLOCKED',
            'IndexedDB did not respond within ' + Offline.OPEN_TIMEOUT_MS + ' ms. ' +
            'Close other tabs of this app and reload. If you are in a private or ' +
            'incognito window, use a normal window — private mode blocks IndexedDB.'));
        }, Offline.OPEN_TIMEOUT_MS);
      }

      req.onupgradeneeded = function (ev) {
        try {
          const db = req.result;
          const names = db.objectStoreNames;
          const has = function (n) {
            return names && typeof names.contains === 'function'
              ? names.contains(n)
              : Array.prototype.indexOf.call(names || [], n) !== -1;
          };
          if (!has(Offline.STORE_PACK)) db.createObjectStore(Offline.STORE_PACK, { keyPath: 'tournament_id' });
          if (!has(Offline.STORE_PLAYERS)) db.createObjectStore(Offline.STORE_PLAYERS, { keyPath: 'key' });
          if (!has(Offline.STORE_IMAGES)) db.createObjectStore(Offline.STORE_IMAGES, { keyPath: 'player_id' });
          if (!has(Offline.STORE_QUEUE)) db.createObjectStore(Offline.STORE_QUEUE, { keyPath: 'seq', autoIncrement: true });
          if (!has(Offline.STORE_REJECTED)) db.createObjectStore(Offline.STORE_REJECTED, { keyPath: 'seq' });
          if (!has(Offline.STORE_KV)) db.createObjectStore(Offline.STORE_KV, { keyPath: 'k' });
        } catch (e) {
          // Abort rather than leave a half-built schema that fails obscurely
          // on the first write during the auction.
          try { if (ev && ev.target && ev.target.transaction) ev.target.transaction.abort(); } catch (x) { /* nothing */ }
          fail(Offline._err('IDB_UPGRADE_FAILED',
            'The offline database could not be created or upgraded: ' +
            ((e && e.message) || String(e)), e));
        }
      };

      req.onblocked = function () {
        fail(Offline._err('IDB_BLOCKED',
          'Another tab of this app is holding an older version of the offline database ' +
          'open. Close every other tab of this app and reload this one.'));
      };

      req.onerror = function () {
        fail(Offline._idbError(req.error, 'The offline database could not be opened.'));
      };

      req.onsuccess = function () {
        const db = req.result;
        try {
          // If a newer tab upgrades the schema under us, drop our handle so
          // the next call reopens rather than failing on a closed connection.
          db.onversionchange = function () {
            try { db.close(); } catch (e) { /* nothing useful */ }
            Offline._dbPromise = null;
            Offline._backendPromise = null;
          };
        } catch (e) { /* not fatal */ }
        finish(resolve, db);
      };
    });

    return Offline._dbPromise;
  },

  /**
   * Map a DOMException (or a thrown error) onto one of our codes with a
   * message the organiser can act on.
   * @param {*} e
   * @param {string} fallbackMessage
   * @return {Error}
   */
  _idbError: function (e, fallbackMessage) {
    const name = (e && e.name) ? String(e.name) : '';
    const detail = (e && e.message) ? String(e.message) : '';

    if (name === 'QuotaExceededError' || /quota/i.test(detail)) {
      return Offline._err('QUOTA_EXCEEDED',
        'This device is out of storage, so the offline pack could not be saved in full. ' +
        'Clear an old tournament pack with Offline.clearPack(oldId), free space on the ' +
        'device, and download again. Do NOT start the auction assuming the pack is there.',
        e);
    }
    if (name === 'VersionError') {
      return Offline._err('IDB_UPGRADE_FAILED',
        'The offline database on this device is NEWER than this copy of the app. ' +
        'Another tab is probably running a newer version. Close every tab of this app ' +
        'and reload.', e);
    }
    if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError' ||
        name === 'NotAllowedError' || name === 'AbortError') {
      return Offline._err('IDB_BLOCKED',
        'IndexedDB is blocked in this browser window (' + (name || 'unknown') + '). ' +
        'Private or incognito mode is the usual cause. Use a normal window, or the ' +
        'offline pack will hold player details only, with no photographs.', e);
    }
    return Offline._err('IDB_ERROR',
      fallbackMessage + (detail ? ' (' + detail + ')' : ''), e);
  },

  /**
   * Run one transaction. `build(stores, tx)` must issue every request it
   * needs synchronously and return them as an array (or a single request).
   * Resolves with the array of `request.result` values, in the same order,
   * after the transaction commits.
   *
   * A failing request is NOT swallowed: we let it abort the transaction, then
   * reject with the mapped error. Half a write is never reported as a success.
   *
   * @param {(string|string[])} storeNames
   * @param {string} mode 'readonly' | 'readwrite'
   * @param {function(Object, Object): (Array|Object)} build
   * @return {Promise<Array>}
   */
  _run: function (storeNames, mode, build) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];

    return Offline._openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        let tx;
        const stores = {};

        try {
          tx = db.transaction(names, mode);
          names.forEach(function (n) { stores[n] = tx.objectStore(n); });
        } catch (e) {
          reject(Offline._idbError(e, 'Could not start an IndexedDB transaction.'));
          return;
        }

        let firstError = null;
        const bail = function (err) {
          if (!firstError) firstError = err;
        };

        tx.onabort = function () {
          reject(firstError || Offline._idbError(tx.error, 'The offline write was aborted.'));
        };
        tx.onerror = function () {
          reject(firstError || Offline._idbError(tx.error, 'The offline write failed.'));
        };

        let requests;
        try {
          requests = build(stores, tx) || [];
        } catch (e) {
          bail(Offline._idbError(e, 'The offline operation could not be built.'));
          try { tx.abort(); } catch (x) { reject(firstError); }
          return;
        }
        if (!Array.isArray(requests)) requests = [requests];

        const results = new Array(requests.length);
        requests.forEach(function (r, i) {
          if (!r || typeof r !== 'object') { results[i] = r; return; }
          r.onsuccess = function () { results[i] = r.result; };
          r.onerror = function () {
            // Deliberately NOT preventDefault: letting it bubble aborts the
            // transaction, which is what we want. Quota exhaustion halfway
            // through must not leave a partial pack looking complete.
            bail(Offline._idbError(r.error, 'An offline write failed.'));
          };
        });

        tx.oncomplete = function () { resolve(results); };
      });
    });
  },

  /**
   * Decide once whether we are on IndexedDB or the localStorage fallback.
   * @return {Promise<{kind:string, reason:string}>}
   */
  _backend: function () {
    if (Offline._backendPromise) return Offline._backendPromise;

    Offline._backendPromise = Offline._openDb()
      .then(function () { return { kind: 'idb', reason: '' }; })
      .catch(function (err) {
        const ls = Offline._ls();
        if (ls) {
          Offline._warn('Offline: IndexedDB unavailable (' + (err && err.code) +
            '); falling back to localStorage for JSON only. Photographs will NOT be cached.');
          return { kind: 'ls', reason: (err && err.message) || 'IndexedDB unavailable' };
        }
        throw Offline._err('NO_STORAGE',
          'Neither IndexedDB nor localStorage can be used in this browser window, so ' +
          'nothing can be cached and no result can be queued. Do not run the auction ' +
          'from this window. ' + ((err && err.message) || ''), err);
      });

    return Offline._backendPromise;
  },

  /* ---------------------------------------------------------------- *
   * localStorage fallback helpers. JSON only, always namespaced.
   * ---------------------------------------------------------------- */

  _lsKey: function (suffix) { return Offline.LS_PREFIX + suffix; },

  _lsGet: function (ls, suffix) {
    if (!ls) return null;
    try {
      const raw = ls.getItem(Offline._lsKey(suffix));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      Offline._warn('Offline: could not read ' + Offline._lsKey(suffix), e);
      return null;
    }
  },

  _lsSet: function (ls, suffix, value) {
    if (!ls) {
      throw Offline._err('NO_STORAGE', 'localStorage is not available, so nothing can be saved.');
    }
    try {
      ls.setItem(Offline._lsKey(suffix), JSON.stringify(value));
    } catch (e) {
      const name = (e && e.name) ? String(e.name) : '';
      if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
          /quota/i.test((e && e.message) || '')) {
        throw Offline._err('QUOTA_EXCEEDED',
          'localStorage is full, so the offline data could not be saved. This browser ' +
          'is already on the reduced fallback path (no photographs); there is no room ' +
          'left even for the player list. Clear old data and try again.', e);
      }
      throw Offline._err('IDB_ERROR', 'Could not write offline data: ' +
        ((e && e.message) || String(e)), e);
    }
  },

  _lsRemove: function (ls, suffix) {
    if (!ls) return;
    try { ls.removeItem(Offline._lsKey(suffix)); } catch (e) { /* nothing useful */ }
  },

  /**
   * Monotonic sequence for the fallback path. Kept in its own key AND floored
   * by the highest seq still in the queue, so a partially cleared counter can
   * never hand out a number that reorders the replay.
   */
  _lsNextSeq: function (ls, queue) {
    let stored = 0;
    try { stored = Number(ls.getItem(Offline._lsKey('seq')) || 0) || 0; } catch (e) { stored = 0; }
    let maxInQueue = 0;
    (queue || []).forEach(function (r) {
      if (r && Number(r.seq) > maxInQueue) maxInQueue = Number(r.seq);
    });
    const next = Math.max(stored, maxInQueue) + 1;
    try { ls.setItem(Offline._lsKey('seq'), String(next)); } catch (e) { /* best effort */ }
    return next;
  },

  /* ---------------------------------------------------------------- *
   * Pack metadata
   * ---------------------------------------------------------------- */

  _writeMeta: function (backend, meta) {
    if (backend.kind !== 'idb') {
      const ls = Offline._ls();
      const existing = Offline._lsGet(ls, 'pack.' + meta.tournament_id) || {};
      existing.meta = meta;
      if (!existing.players) existing.players = [];
      Offline._lsSet(ls, 'pack.' + meta.tournament_id, existing);
      return Promise.resolve(meta);
    }
    return Offline._run(Offline.STORE_PACK, 'readwrite', function (s) {
      return [s[Offline.STORE_PACK].put(meta)];
    }).then(function () { return meta; });
  },

  _readMeta: function (backend, tid) {
    if (backend.kind !== 'idb') {
      const raw = Offline._lsGet(Offline._ls(), 'pack.' + tid);
      return Promise.resolve((raw && raw.meta) || null);
    }
    return Offline._run(Offline.STORE_PACK, 'readonly', function (s) {
      return [s[Offline.STORE_PACK].get(tid)];
    }).then(function (res) { return res[0] || null; });
  },

  /* ---------------------------------------------------------------- *
   * Pack download steps
   * ---------------------------------------------------------------- */

  /**
   * The default player source: `player.list` through the global API, paged,
   * filtered to auction-eligible players. Returns null when api.js is not
   * loaded, so the caller can produce a clear error instead of a TypeError.
   * @return {function|null}
   */
  _defaultListFn: function () {
    const g = Offline._global();
    const api = g.API;
    if (!api || typeof api.call !== 'function') return null;
    return function (tournamentId, page, pageSize) {
      return api.call('player.list', {
        tournamentId: tournamentId,
        filter: { paymentStatus: 'VERIFIED', withdrawn: false },
        page: page,
        pageSize: pageSize,
        sort: 'serial_no'
      });
    };
  },

  /**
   * Page through the player source and keep only auction-eligible rows.
   *
   * The eligibility test is repeated here on purpose even though the filter
   * asks the server for it: an offline pack that contains a rejected or
   * withdrawn player would put that face on the projector, which is exactly
   * the failure CONTRACTS-PHASE4-7.md §4.1 step 4 warns about. This is a
   * narrowing of what the server sent, never a widening — nothing becomes
   * eligible here that the server did not already mark VERIFIED.
   */
  _fetchAllPlayers: function (tid, listFn, pageSize, progress) {
    const out = [];
    const seen = {};

    const pull = function (page) {
      return Promise.resolve(listFn(tid, page, pageSize)).then(function (res) {
        const data = res || {};
        const rows = data.rows || [];

        rows.forEach(function (r) {
          if (!r) return;
          if (String(r.payment_status || '').toUpperCase() !== 'VERIFIED') return;
          if (r.is_withdrawn === true || String(r.is_withdrawn).toUpperCase() === 'TRUE') return;

          const serial = Offline._normSerial(r.serial_no);
          if (!serial || seen[serial]) return;
          seen[serial] = true;

          out.push({
            key: Offline._playerKey(tid, serial),
            tournament_id: tid,
            player_id: String(r.player_id || ''),
            serial_no: serial,
            name: String(r.name || ''),
            role: String(r.role || ''),
            style: String(r.style || ''),
            age_years: (r.age_years === undefined || r.age_years === null) ? '' : r.age_years,
            photo_thumb_url: String(r.photo_thumb_url || '')
          });
        });

        const total = Number(data.total || out.length);
        progress({
          phase: 'players', done: out.length, total: total || out.length,
          label: 'Cached ' + out.length + ' of ' + (total || out.length) + ' players…'
        });

        const totalPages = Number(data.totalPages || 1);
        if (rows.length && page < totalPages) return pull(page + 1);
        return out;
      });
    };

    return pull(1);
  },

  _clearPlayers: function (backend, tid) {
    if (backend.kind !== 'idb') return Promise.resolve();
    return Offline._run(Offline.STORE_PLAYERS, 'readonly', function (s) {
      return [s[Offline.STORE_PLAYERS].getAll()];
    }).then(function (res) {
      const keys = (res[0] || [])
        .filter(function (r) { return r && r.tournament_id === tid; })
        .map(function (r) { return r.key; });
      if (!keys.length) return null;
      return Offline._run(Offline.STORE_PLAYERS, 'readwrite', function (s) {
        return keys.map(function (k) { return s[Offline.STORE_PLAYERS].delete(k); });
      });
    });
  },

  _writePlayers: function (backend, tid, players, progress) {
    if (backend.kind !== 'idb') {
      const ls = Offline._ls();
      const existing = Offline._lsGet(ls, 'pack.' + tid) || {};
      existing.players = players;
      Offline._lsSet(ls, 'pack.' + tid, existing);
      progress({
        phase: 'players', done: players.length, total: players.length,
        label: 'Saved ' + players.length + ' players (details only).'
      });
      return Promise.resolve();
    }
    if (!players.length) return Promise.resolve();

    return Offline._run(Offline.STORE_PLAYERS, 'readwrite', function (s) {
      return players.map(function (p) { return s[Offline.STORE_PLAYERS].put(p); });
    }).then(function () {
      progress({
        phase: 'players', done: players.length, total: players.length,
        label: 'Saved ' + players.length + ' players.'
      });
    });
  },

  /**
   * Fetch and store thumbnail bytes one at a time, reporting after each.
   *
   * One at a time on purpose: this is 100+ requests on a venue connection
   * that is already the thing we do not trust, and a serial run gives honest
   * progress and does not queue 400 sockets. A single failed image does not
   * abort the pack, but every failure is recorded and makes the pack
   * incomplete, so `isPackReady` reports the truth.
   */
  _downloadImages: function (tid, players, imageFn, progress, playerTotal) {
    const failures = [];
    let stored = 0;

    if (!players.length || !imageFn) {
      return Promise.resolve({ stored: 0, failures: failures });
    }

    const total = players.length;

    const one = function (i) {
      if (i >= total) return Promise.resolve();
      const p = players[i];

      return Promise.resolve()
        .then(function () { return imageFn(p.photo_thumb_url, p); })
        .then(function (bytes) {
          if (!bytes) throw Offline._err('EMPTY_IMAGE', 'The image fetcher returned nothing.');
          const record = {
            player_id: p.player_id,
            tournament_id: tid,
            serial_no: p.serial_no,
            blob: bytes,
            mime: (bytes && bytes.type) ? bytes.type : 'image/jpeg',
            bytes: Offline._byteLength(bytes),
            cached_at: Offline._nowIso()
          };
          return Offline._run(Offline.STORE_IMAGES, 'readwrite', function (s) {
            return [s[Offline.STORE_IMAGES].put(record)];
          }).then(function () { stored += 1; });
        })
        .catch(function (err) {
          const e = Offline._normError(err);
          // Running out of room is not a per-image problem. Stop, so the
          // organiser sees one clear message instead of 300 identical ones.
          if (e.code === 'QUOTA_EXCEEDED') throw e;
          failures.push({
            player_id: p.player_id,
            serial_no: p.serial_no,
            name: p.name,
            message: e.message,
            code: e.code
          });
        })
        .then(function () {
          progress({
            phase: 'images',
            done: playerTotal + i + 1,
            total: playerTotal + total,
            label: 'Cached ' + stored + ' of ' + total + ' photographs…'
          });
          return one(i + 1);
        });
    };

    return one(0).then(function () { return { stored: stored, failures: failures }; });
  },

  /** @return {number} best-effort byte count for a Blob / ArrayBuffer / view */
  _byteLength: function (b) {
    if (!b) return 0;
    if (typeof b.size === 'number') return b.size;
    if (typeof b.byteLength === 'number') return b.byteLength;
    if (typeof b.length === 'number') return b.length;
    return 0;
  },

  /** @return {string|null} an object URL, or null when this runtime has none */
  _toObjectUrl: function (bytes, mime) {
    const g = Offline._global();
    const U = g.URL;
    if (!U || typeof U.createObjectURL !== 'function') return null;
    try {
      let blob = bytes;
      const isBlob = (typeof g.Blob === 'function') && (bytes instanceof g.Blob);
      if (!isBlob && typeof g.Blob === 'function') {
        blob = new g.Blob([bytes], { type: mime || 'image/jpeg' });
      }
      return U.createObjectURL(blob);
    } catch (e) {
      Offline._warn('Offline.getImage: could not build an object URL', e);
      return null;
    }
  },

  /** Revoke one memoised URL, or all of them when playerId is null. */
  _revokeFor: function (playerId) {
    const g = Offline._global();
    const U = g.URL;
    const kill = function (pid) {
      const memo = Offline._urls[pid];
      if (!memo) return;
      try { if (U && typeof U.revokeObjectURL === 'function') U.revokeObjectURL(memo.url); }
      catch (e) { /* nothing useful */ }
      delete Offline._urls[pid];
    };
    if (playerId === null || playerId === undefined) {
      Object.keys(Offline._urls).forEach(kill);
    } else {
      kill(String(playerId));
    }
  },

  /* ---------------------------------------------------------------- *
   * Queue / rejected list storage
   * ---------------------------------------------------------------- */

  /** Shared reader for the queue and rejected stores, sorted by seq. */
  _readList: function (storeName, lsSuffix, tournamentId) {
    const tid = tournamentId ? String(tournamentId) : '';
    return Offline._backend().then(function (b) {
      let rows;
      if (b.kind !== 'idb') {
        rows = Promise.resolve(Offline._lsGet(Offline._ls(), lsSuffix) || []);
      } else {
        rows = Offline._run(storeName, 'readonly', function (s) {
          return [s[storeName].getAll()];
        }).then(function (res) { return res[0] || []; });
      }
      return rows.then(function (list) {
        return list
          .filter(function (r) { return r && (!tid || r.tournament_id === tid); })
          .sort(function (a, b2) { return Number(a.seq) - Number(b2.seq); });
      });
    });
  },

  /** Shared deleter for the queue and rejected stores. */
  _clearList: function (storeName, lsSuffix, tournamentId, keyField) {
    const tid = tournamentId ? String(tournamentId) : '';
    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') {
        const ls = Offline._ls();
        const all = Offline._lsGet(ls, lsSuffix) || [];
        const keep = tid
          ? all.filter(function (r) { return r && r.tournament_id !== tid; })
          : [];
        Offline._lsSet(ls, lsSuffix, keep);
        return { deleted: all.length - keep.length };
      }
      return Offline._run(storeName, 'readonly', function (s) {
        return [s[storeName].getAll()];
      }).then(function (res) {
        const doomed = (res[0] || []).filter(function (r) {
          return r && (!tid || r.tournament_id === tid);
        });
        if (!doomed.length) return { deleted: 0 };
        return Offline._run(storeName, 'readwrite', function (s) {
          return doomed.map(function (r) { return s[storeName].delete(r[keyField]); });
        }).then(function () { return { deleted: doomed.length }; });
      });
    });
  },

  /** @return {Promise<number>} total pending items across all tournaments */
  _countQueue: function () {
    return Offline.listQueue().then(function (rows) { return rows.length; });
  },

  _deleteQueueItem: function (seq) {
    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') {
        const ls = Offline._ls();
        const q = (Offline._lsGet(ls, 'queue') || []).filter(function (r) {
          return !r || Number(r.seq) !== Number(seq);
        });
        Offline._lsSet(ls, 'queue', q);
        return null;
      }
      return Offline._run(Offline.STORE_QUEUE, 'readwrite', function (s) {
        return [s[Offline.STORE_QUEUE].delete(seq)];
      });
    });
  },

  /**
   * Move one item out of the pending queue into the rejected store.
   * Written as ONE transaction over both stores where IndexedDB allows it, so
   * a crash between the two cannot make a rejected sale disappear.
   */
  _moveToRejected: function (seq, row) {
    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') {
        const ls = Offline._ls();
        const rejected = Offline._lsGet(ls, 'rejected') || [];
        rejected.push(row);
        Offline._lsSet(ls, 'rejected', rejected);
        const q = (Offline._lsGet(ls, 'queue') || []).filter(function (r) {
          return !r || Number(r.seq) !== Number(seq);
        });
        Offline._lsSet(ls, 'queue', q);
        return null;
      }
      return Offline._run([Offline.STORE_QUEUE, Offline.STORE_REJECTED], 'readwrite', function (s) {
        return [
          s[Offline.STORE_REJECTED].put(row),
          s[Offline.STORE_QUEUE].delete(seq)
        ];
      });
    });
  },

  /** Record that we tried this item and it stopped the run. Best effort. */
  _bumpAttempt: function (item, error) {
    const updated = Offline._assign({}, item);
    updated.attempts = (item.attempts || 0) + 1;
    updated.last_error = error;

    return Offline._backend().then(function (b) {
      if (b.kind !== 'idb') {
        const ls = Offline._ls();
        const q = (Offline._lsGet(ls, 'queue') || []).map(function (r) {
          return (r && Number(r.seq) === Number(item.seq)) ? updated : r;
        });
        Offline._lsSet(ls, 'queue', q);
        return null;
      }
      return Offline._run(Offline.STORE_QUEUE, 'readwrite', function (s) {
        return [s[Offline.STORE_QUEUE].put(updated)];
      });
    }).catch(function (e) {
      // The attempt counter is a nicety. Losing it must not turn a stopped
      // replay into a thrown error that hides why it stopped.
      Offline._warn('Offline.sync: could not record the attempt count', e);
      return null;
    });
  },

  /* ---------------------------------------------------------------- *
   * Error classification for replay
   * ---------------------------------------------------------------- */

  /**
   * Coerce anything a callFn threw into {code, message} with a real message.
   * @param {*} err
   * @return {Object} a plain {code, message} — safe to store in IndexedDB,
   *         which cannot structured-clone an Error's own properties reliably.
   */
  _normError: function (err) {
    if (err && typeof err === 'object') {
      const code = err.code ? String(err.code) : '';
      const message = err.message ? String(err.message) : '';
      if (code || message) {
        return {
          code: code || 'INTERNAL_ERROR',
          message: message || 'The server rejected this without a message.'
        };
      }
    }
    return {
      code: 'INTERNAL_ERROR',
      message: err === undefined || err === null ? 'Unknown failure.' : String(err)
    };
  },

  /**
   * Is this error a hard failure that must stop the replay?
   * Anything with no code is hard too: an unrecognised failure means an
   * unknown outcome, and guessing about an unknown outcome is how a sale gets
   * applied twice.
   * @param {Object} error {code, message}
   * @return {boolean}
   */
  _isHardFailure: function (error) {
    const code = (error && error.code) ? String(error.code) : '';
    if (!code) return true;
    return Offline.HARD_ERROR_CODES.indexOf(code) !== -1;
  },

  /** A one-line hint for the "replay stopped" banner. */
  _stopHint: function (error) {
    const code = (error && error.code) ? String(error.code) : '';
    if (code === 'STALE_STATE') {
      return 'A queued write carried an expectedVersion captured while offline, which is ' +
        'always stale by replay time. Re-read the current version and attach it inside ' +
        'your sync callback, then run the sync again. See the offline.js header.';
    }
    if (code === 'NETWORK' || code === 'NOT_CONFIGURED') {
      return 'The server was not reachable, so we do not know whether this write was ' +
        'applied. Nothing after it was attempted. Restore the connection and sync again.';
    }
    if (code === 'SYSTEM_BUSY') {
      return 'The server was busy. Nothing was lost — wait a few seconds and sync again.';
    }
    if (code === 'UNAUTHORIZED') {
      return 'The session expired mid-replay. Sign in again and sync again; the queue is intact.';
    }
    return 'Replay stopped here to keep the order intact. The rest of the queue is untouched.';
  }
};

/*
 * A closing reminder, because it is the most important sentence in the file:
 * this module exists so a dead router does not stop an auction. It is not a
 * plan. The organiser still keeps a paper sheet, and the paper sheet is what
 * settles a dispute (DESIGN.md §16, point 4).
 */
