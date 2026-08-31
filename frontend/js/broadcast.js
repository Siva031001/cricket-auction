/**
 * broadcast.js — shared polling engine for the public/broadcast screens.
 *
 * `Broadcast`. Used by js/pages/stream.js and js/pages/watch.js. NOT used by
 * js/pages/display.js — the projector already has its own copy of this exact
 * logic, proven in production, and duplicating the pattern here rather than
 * refactoring display.js to share it is deliberate: display.js is the screen
 * a few hundred people read from the back of a hall, and it is not touched by
 * this file at all. Zero risk of regressing it.
 *
 * WHAT THIS IS
 *   A small library that calls `auction.displayState` on a timer, backs off on
 *   failure, stops for good on a fatal error, and hands the caller a snapshot
 *   only when it actually changed. Every page that wants "the live auction
 *   state, kept fresh, without hammering the server" calls Broadcast.connect()
 *   once and gets back a controller with .stop() and .forceRefresh().
 *
 * WHY A SEPARATE CONTROLLER PER CALL, NOT A MODULE-LEVEL SINGLETON
 *   display.js uses one shared `_gen` counter because it is itself a singleton
 *   page module — only one instance of it is ever on screen. This file may be
 *   used by more than one page type across the app's lifetime (stream, watch,
 *   and anything added later per CONTRACTS §11's extension points), so each
 *   `connect()` call is fully self-contained: its own closure, its own timers,
 *   its own stopped flag. Two independent connections can exist without either
 *   one able to interfere with the other's teardown.
 *
 * THE CONTRACT (CONTRACTS-PHASE4-7.md §4.5, DESIGN.md §7.4)
 *   `auction.displayState` is PUBLIC and gated by the tournament's
 *   display_token — the same token the projector link already uses. An
 *   unchanged poll returns {v, same:true}, about 30 bytes, with NO Spreadsheet
 *   read on the server (CacheService only). That is what makes a 2-second poll
 *   from several simultaneous screens (projector + stream + watch + the
 *   organiser console) affordable for a three-hour auction.
 *
 * WHAT THIS FILE DOES NOT DO
 *   It does not paint anything. It does not touch the DOM. It calls the
 *   caller's onSnapshot/onLink/onFatal callbacks and nothing else. Painting,
 *   layout and animation are each page's own job — this is Just the Feed.
 *
 * HARD RULES (CONTRACTS.md §15, CONTRACTS-PHASE1.md §4)
 *   Every network call goes through API. No DOM access at all in this file —
 *   that is what keeps it paintable-agnostic and testable without a fake DOM.
 */

/* eslint-disable no-unused-vars */
const Broadcast = {

  /** The one action every broadcast screen is allowed to call. */
  ACTION: 'auction.displayState',

  /** Fallback poll interval when CONFIG is missing. DESIGN.md §7.4. */
  BASE_POLL_MS: 2000,

  /** Back-off ceiling. DESIGN.md §7.4: "double the interval up to 15s". */
  MAX_POLL_MS: 15000,

  /**
   * Errors that will never fix themselves by waiting. Retrying a bad token
   * every two seconds for three hours would burn quota and never succeed, so
   * these stop the poll for good and hand the caller one readable sentence.
   * @const {!Object<string,string>}
   */
  FATAL_MESSAGE: {
    UNAUTHORIZED:
      'The key in this address is not valid for this tournament. Ask the ' +
      'admin for the link again — it is the one that ends in "?k=".',
    FORBIDDEN:
      'The key in this address is not valid for this tournament. Ask the ' +
      'admin for the link again — it is the one that ends in "?k=".',
    NOT_FOUND:
      'No tournament matches this address. Check the link, or ask the admin ' +
      'to send it again.',
    NOT_CONFIGURED:
      'This copy of the site has not been pointed at a server yet. ' +
      'frontend/js/config.js still needs the Apps Script /exec URL.',
    VALIDATION_FAILED:
      'The server could not read this address. Ask the admin to send the ' +
      'link again.'
  },

  /**
   * Status words and shapes. DESIGN.md §8/§51: colour AND word AND shape,
   * never colour alone — a page's CSS supplies the colour via these class
   * names; the word and mark travel with the data so no page can drop them.
   * @const
   */
  STATUS: {
    PENDING:   { cls: 'status--pending', mark: '●', word: 'Pending' },
    SOLD:      { cls: 'status--sold',    mark: '✓', word: 'Sold' },
    UNSOLD:    { cls: 'status--unsold',  mark: '✕', word: 'Un-sold' },
    'UN-SOLD': { cls: 'status--unsold',  mark: '✕', word: 'Un-sold' }
  },

  /** ENUM.PLAYER_ROLE. Same words the registration form uses. */
  ROLE_LABEL: {
    BATSMAN: 'Batsman',
    BOWLER: 'Bowler',
    ALL_ROUNDER: 'All rounder'
  },

  /** The schema stores handedness only (DESIGN.md §2.3): one `style` column. */
  STYLE_LABEL: {
    LEFT: 'Left handed',
    RIGHT: 'Right handed'
  },

  /** Tournament status -> a human phrase. */
  PHASE_LABEL: {
    AUCTION_LIVE: 'Auction live',
    AUCTION_CLOSED: 'Auction closed',
    REG_OPEN: 'Registration open',
    REG_CLOSED: 'Registration closed',
    DRAFT: 'Not started'
  },

  /* ================================================================== *
   * The connection
   * ================================================================== */

  /**
   * Start polling one tournament's auction state.
   *
   * @param {{
   *   tournamentId: string,
   *   token: string,
   *   pollMs: (number|undefined),
   *   onSnapshot: function(!Object): void,
   *   onLink: function(string, string): void,
   *   onFatal: function(string): void
   * }} opts
   *   onSnapshot(snap) — called only when the state actually changed. `snap`
   *     carries an extra `_transition` field: 'SOLD' | 'UNSOLD' | null — set
   *     exactly once, on the poll where the current player's auction_status
   *     first became that value, so a page can trigger a banner animation
   *     without re-implementing edge detection itself.
   *   onLink(kind, text) — kind is 'live' | 'reconnecting' | 'stopped', for a
   *     connection-status indicator. Called on every state change, including
   *     recovery.
   *   onFatal(message) — called once, when the poll has stopped for good.
   *     onLink('stopped', ...) is called immediately before this.
   * @return {{stop: function(): void, forceRefresh: function(): void,
   *           isStopped: function(): boolean}}
   */
  connect: function (opts) {
    const o = opts || {};
    const state = {
      tournamentId: String(o.tournamentId || '').trim(),
      token: String(o.token || '').trim(),
      pollMs: (isFinite(Number(o.pollMs)) && Number(o.pollMs) > 0)
        ? Number(o.pollMs) : Broadcast.pollMs(),
      onSnapshot: (typeof o.onSnapshot === 'function') ? o.onSnapshot : function () {},
      onLink: (typeof o.onLink === 'function') ? o.onLink : function () {},
      onFatal: (typeof o.onFatal === 'function') ? o.onFatal : function () {},
      v: null,
      delay: 0,
      fails: 0,
      stopped: false,
      inFlight: false,
      paused: false,
      lastOkAt: 0,
      // Edge detector for _transition: "player_id|auction_status" last
      // painted. hasPainted stays false until the FIRST real snapshot has
      // gone out — see onSuccess for why that matters.
      shownKey: '',
      hasPainted: false,
      timer: null,
      onVisibility: null
    };
    state.delay = state.pollMs;

    const teardown = function () {
      state.stopped = true;
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
      detachVisibility();
    };

    const detachVisibility = function () {
      if (state.onVisibility) {
        document.removeEventListener('visibilitychange', state.onVisibility);
        state.onVisibility = null;
      }
    };

    const schedule = function (delay) {
      if (state.stopped || state.paused) return;
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = window.setTimeout(function () {
        state.timer = null;
        poll();
      }, delay);
    };

    const fatal = function (message) {
      state.stopped = true;
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
      // Same cleanup as teardown(). Without this, a bad or expired token left
      // an extra visibilitychange listener registered for the rest of the
      // tab's life — closing over this whole connection's state — because
      // fatal() is reached from inside a poll, not from the page's own
      // _teardown(), and nothing else was ever going to detach it.
      detachVisibility();
      state.onLink('stopped', 'Not connected');
      state.onFatal(String(message || ''));
    };

    const onFailure = function (err) {
      const code = (err && err.code) ? String(err.code) : '';
      if (Object.prototype.hasOwnProperty.call(Broadcast.FATAL_MESSAGE, code)) {
        fatal(Broadcast.FATAL_MESSAGE[code]);
        return;
      }
      state.fails += 1;
      state.delay = Math.min(state.delay * 2, Broadcast.MAX_POLL_MS);
      state.onLink('reconnecting',
        'Reconnecting' + Broadcast.stalenessSuffix(state.lastOkAt));
      schedule(state.delay);
    };

    const onSuccess = function (data) {
      state.fails = 0;
      state.delay = state.pollMs;
      state.lastOkAt = Date.now();
      state.onLink('live', 'Live');

      const snap = (data && typeof data === 'object') ? data : {};
      const version = (typeof snap.v === 'number')
        ? snap.v
        : ((typeof API !== 'undefined' && API && typeof API.lastVersion === 'number')
          ? API.lastVersion : state.v);
      state.v = version;

      // Only a CHANGED snapshot is handed to the caller. Repainting on an
      // unchanged poll would restart any reveal/fade animation every couple of
      // seconds and make a still screen look like it is flickering.
      if (snap.same !== true) {
        const current = (snap && snap.current) ? snap.current : null;
        // serial_no, NOT player_id. auction.displayState's allow-list
        // (backend/Auction.gs) deliberately never includes player_id — it is
        // an internal id with no reason to reach a public screen — so a key
        // built from it collapses to just the status for every player. Two
        // different players both observed already at SOLD (a tab paused
        // across two quick sales, or a slow poll catching up) would then
        // compare equal and the second sale's sting would never fire.
        // serial_no is a human-facing field the allow-list DOES carry.
        const key = current
          ? (String(current.serial_no || '') + '|' + String(current.auction_status || ''))
          : '';
        let transition = null;
        if (current && key !== state.shownKey) {
          const status = String(current.auction_status || '').toUpperCase();
          // NOT on the very first snapshot a connection ever receives. A
          // viewer who opens /stream or /watch mid-auction, while the current
          // player already shows SOLD from a sale that happened minutes
          // earlier, must not get a fresh SOLD sting flashed at them purely
          // because it is new to THIS connection. A transition is something
          // that happened while this screen was already watching.
          if (state.hasPainted && (status === 'SOLD' || status === 'UNSOLD')) {
            transition = status;
          }
        }
        state.shownKey = key;
        state.hasPainted = true;
        snap._transition = transition;
        state.onSnapshot(snap);
      }

      schedule(state.delay);
    };

    const poll = function () {
      if (state.stopped) return;
      if (state.inFlight) return;
      state.inFlight = true;

      const payload = { tournamentId: state.tournamentId, k: state.token };
      if (typeof state.v === 'number') payload.v = state.v;

      // retryBusy:false: API's own SYSTEM_BUSY backoff sleeps inside one call,
      // which on a fixed-interval loop would stack requests. This loop runs
      // its own visible back-off instead (DESIGN.md §7.4).
      API.get(Broadcast.ACTION, payload, { retryBusy: false })
        .then(function (data) {
          state.inFlight = false;
          if (state.stopped) return;
          onSuccess(data);
        })
        .catch(function (err) {
          state.inFlight = false;
          if (state.stopped) return;
          onFailure(err);
        });
    };

    // Park the loop while the tab/window is hidden; catch up instantly on
    // return. Several simultaneous broadcast screens polling every 2s for
    // three hours is real quota — an abandoned tab must not spend it.
    state.onVisibility = function () {
      if (state.stopped) return;
      if (document.hidden) {
        state.paused = true;
        if (state.timer !== null) {
          window.clearTimeout(state.timer);
          state.timer = null;
        }
        return;
      }
      if (!state.paused) return;
      state.paused = false;
      poll();
    };
    document.addEventListener('visibilitychange', state.onVisibility);

    if (!state.tournamentId) {
      fatal('This address does not name a tournament.');
    } else if (!state.token) {
      fatal('This address has no access key. Use the link the admin gave you.');
    } else {
      // First poll immediately — a viewer should not watch a blank screen for
      // one whole interval while the page waits for its own timer.
      poll();
    }

    return {
      stop: teardown,
      forceRefresh: function () {
        if (state.stopped) return;
        if (state.timer !== null) {
          window.clearTimeout(state.timer);
          state.timer = null;
        }
        state.delay = state.pollMs;
        poll();
      },
      isStopped: function () { return state.stopped; }
    };
  },

  /** @return {number} the contracted poll interval in ms */
  pollMs: function () {
    const configured = (typeof CONFIG !== 'undefined' && CONFIG)
      ? Number(CONFIG.POLL_INTERVAL_MS) : NaN;
    return (isFinite(configured) && configured > 0) ? configured : Broadcast.BASE_POLL_MS;
  },

  /**
   * " — data is 14s old". Says out loud what a viewer cannot otherwise know.
   * @param {number} lastOkAt Date.now() of the last successful poll, or 0
   * @return {string}
   */
  stalenessSuffix: function (lastOkAt) {
    if (!lastOkAt) return '';
    const seconds = Math.round((Date.now() - lastOkAt) / 1000);
    if (!isFinite(seconds) || seconds < 5) return '';
    return ' — data is ' + seconds + 's old';
  },

  /* ================================================================== *
   * Shared read-only helpers — no DOM, safe to unit test directly
   * ================================================================== */

  /**
   * @param {!Object} snap a displayState snapshot
   * @return {string} never the raw tournament id — see display.js's own note
   *     on why an id on a public screen is the wrong thing to show
   */
  tournamentName: function (snap) {
    if (!snap) return 'Auction';
    if (snap.tournament_name) return String(snap.tournament_name);
    if (snap.name) return String(snap.name);
    if (snap.tournament && snap.tournament.name) return String(snap.tournament.name);
    return 'Auction';
  },

  /** @param {*} role @return {string} */
  roleText: function (role) {
    const key = String(role || '').toUpperCase();
    if (!key) return '';
    return Broadcast.ROLE_LABEL[key] || key.replace(/_/g, ' ');
  },

  /** @param {*} style @return {string} */
  styleText: function (style) {
    const key = String(style || '').toUpperCase();
    if (!key) return '';
    return Broadcast.STYLE_LABEL[key] || key.replace(/_/g, ' ');
  },

  /** @param {*} years @return {string} e.g. "Age 26", or '' when missing */
  ageText: function (years) {
    const n = Number(years);
    if (!isFinite(n) || n <= 0) return '';
    return 'Age ' + Math.round(n);
  },

  /**
   * Prefers the server's own formatted string, so no two screens can ever
   * disagree about how a rupee amount is written.
   * @param {*} display e.g. "₹5,50,000"
   * @param {*} rupees e.g. 550000
   * @return {string}
   */
  moneyText: function (display, rupees) {
    if (display) return String(display);
    const n = Number(rupees);
    if (!isFinite(n)) return '';
    if (typeof UI !== 'undefined' && UI && typeof UI.money === 'function') {
      return UI.money(n);
    }
    return '₹' + String(Math.round(n));
  },

  /** @param {*} value @return {string} a whole number, or '0' */
  num: function (value) {
    const n = Number(value);
    return isFinite(n) ? String(Math.round(n)) : '0';
  },

  /**
   * createElement with a class and text in one call. textContent only —
   * every page built on this file inherits the same "never innerHTML" rule.
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @return {HTMLElement}
   */
  el: function (tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  },

  /**
   * Write text, but only when it differs, to avoid pointless reflows on a
   * screen repainted every couple of seconds.
   * @param {HTMLElement} node
   * @param {string} text
   * @return {void}
   */
  setText: function (node, text) {
    if (!node) return;
    const value = (text === null || text === undefined) ? '' : String(text);
    if (node.textContent !== value) node.textContent = value;
  },

  /**
   * Put a page's root node on screen. Prefers App.mount so there is one place
   * that clears #app, but works standalone if app.js is not loaded.
   *
   * Shared here rather than duplicated in every page built on this file —
   * display.js and organiser-auction.js each still carry their own identical
   * copy of this from before broadcast.js existed; this is the version
   * stream.js and watch.js call, so there are not yet MORE copies of the
   * same 8 lines than there already were.
   * @param {HTMLElement} el
   * @return {void}
   */
  mount: function (el) {
    if (typeof App !== 'undefined' && App && typeof App.mount === 'function') {
      App.mount(el);
      return;
    }
    const root = document.getElementById('app');
    if (!root) return;
    root.textContent = '';
    root.appendChild(el);
  }
};
