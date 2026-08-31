/**
 * display.js — the projector screen. `DisplayPage`.
 *
 * Route: /auction/:tournamentId/display?k=<display_token>
 * Spec:  CONTRACTS-PHASE4-7.md "PHASE 5", DESIGN.md §7.4 (polling) and §8
 *        (projector, status colours), requirement §19 / §20 / §26 / §50 / §51.
 *
 * This is the most visible screen in the whole system: a few hundred people
 * read it from up to 15 metres, off a projector, in a bright hall. Every
 * decision below is a consequence of that.
 *
 * WHAT IT DOES
 *   Reads ctx.params.tournamentId and ctx.query.k, polls `auction.displayState`
 *   every 2 s (CONFIG.POLL_INTERVAL_MS), and paints the current player plus the
 *   team standings and the auction summary. It is READ-ONLY: it calls no other
 *   action and shows no control. There is nothing on this screen a stray click
 *   or a curious audience member can change.
 *
 * THE NINE FAILURE MODES THIS FILE IS SHAPED BY
 *
 *  1. UNREADABLE FROM THE BACK OF THE HALL. Photo left ~45%, details right
 *     ~55%; serial, name, role, style and age and nothing else. All the type
 *     scales with the viewport — see css/display.css. No fixed pixel sizes.
 *
 *  2. A WASHED-OUT PROJECTOR. #0B0F14 behind near-white text (>= 12:1). Those
 *     tokens already exist in app.css as --proj-bg / --proj-ink; this page
 *     reuses them and never redefines them.
 *
 *  3. EDGE CROP. A venue projector eats roughly 15% of the frame. app.css keeps
 *     the display route inside a 7.5%-per-side safe area; display.css sizes
 *     everything against 1024x768, not 1080p.
 *
 *  4. A FONT THAT NEVER ARRIVES. System stacks only. No @font-face anywhere.
 *
 *  5. COLOUR ALONE. Every status pill carries a COLOUR and a WORD and a SHAPE
 *     (DESIGN.md §8/§51). The shape is a real element in the DOM here, not a
 *     ::before, so it survives a stylesheet that failed to load and so it can
 *     be asserted on. UN-SOLD is slate, deliberately not red: red on a dim
 *     projector loses legibility and reads as "error" rather than "not sold
 *     this round".
 *
 *  6. HIDDEN CONTROLS. F toggles fullscreen, R forces a refresh. Nothing else.
 *     A small hint says so and then fades, because a permanent overlay is
 *     clutter on a screen the audience is reading.
 *
 *  7. A 400 ms WAIT WHEN #27 IS REVEALED. Every thumbnail we are told about is
 *     pre-warmed with `new Image()` on arrival, so the browser cache already
 *     holds it when the organiser calls that player.
 *
 *  8. A FROZEN BUT PLAUSIBLE SCREEN. This is the worst outcome of all: nobody
 *     in the hall can tell that the number in front of them is ten minutes
 *     old. So a failed poll backs off 2s -> 4s -> 8s -> 15s (ceiling) and puts
 *     an amber "Reconnecting" indicator on screen that also says how stale the
 *     data is. One success resets both the interval and the indicator.
 *
 *  9. MOTION READING AS LAG. The reveal is a 200 ms opacity fade and nothing
 *     else. No spin, no slide, no bounce.
 *
 * QUOTA
 *   Two clients polling every 2 s for three hours is ~10,800 requests, and the
 *   live auction console needs that quota more than an abandoned tab does. So
 *   polling STOPS on document 'visibilitychange' to hidden and resumes — with
 *   an immediate catch-up poll — on show.
 *
 * HARD RULES (CONTRACTS-PHASE1.md §4, CONTRACTS.md §15)
 *   textContent only, never innerHTML — player names come from a public
 *   registration form. Vanilla JS, no framework, no build step, no CDN, no web
 *   font. Every network call goes through API. document.body.dataset.route is
 *   set to 'display', which is what turns on the projector theme in app.css.
 *
 * CSS CLASS NAMES THIS FILE EMITS
 *   Reused from app.css unchanged:
 *     app  panel  visually-hidden  reveal
 *     display-layout  display-photo  display-serial  display-name
 *     display-meta  display-amount
 *     status  status--pending  status--sold  status--unsold
 *   New, owned by css/display.css (all scoped under body[data-route="display"]):
 *     display  display__top  display__tournament  display__phase
 *     display__link  display__link-mark  display__link-text
 *     display__stage  display__card  display__photo  display__photo--empty
 *     display__details  display__result  display__team  display__message
 *     display__message-title  display__message-body
 *     display__bottom  display__teams  display__team-cell  display__team-name
 *     display__team-purse  display__team-count  display__team-slot
 *     display__summary  display__summary-item  display__summary-value
 *     display__summary-label  display__hint  status__mark  status__word
 *     is-faded  is-hidden
 */

/* eslint-disable no-unused-vars */
const DisplayPage = {

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  /** Written to <body data-route>; app.css scopes the projector theme on it. */
  ROUTE_KEY: 'display',

  /** The one and only action this page is allowed to call. */
  ACTION: 'auction.displayState',

  /** Fallback poll interval when CONFIG is missing. DESIGN.md §7.4. */
  BASE_POLL_MS: 2000,

  /** Back-off ceiling. DESIGN.md §7.4: "double the interval up to 15s". */
  MAX_POLL_MS: 15000,

  /** How long the keyboard hint stays before it fades out. */
  HINT_MS: 6000,

  /**
   * Errors that will never fix themselves by waiting.
   *
   * A bad or missing display token is the important one. Retrying it every two
   * seconds for three hours would burn the same quota the live auction console
   * needs, and would never succeed. So these stop the poll and put a readable
   * message on screen instead — never a blank projector.
   * @const {!Object<string, string>}
   */
  FATAL_MESSAGE: {
    UNAUTHORIZED:
      'The key in this address is not valid for this tournament. Ask the ' +
      'admin for the projector link again — it is the one that ends in "?k=".',
    FORBIDDEN:
      'The key in this address is not valid for this tournament. Ask the ' +
      'admin for the projector link again — it is the one that ends in "?k=".',
    NOT_FOUND:
      'No tournament matches this address. Check the link, or ask the admin ' +
      'to send the projector link again.',
    NOT_CONFIGURED:
      'This copy of the site has not been pointed at a server yet. ' +
      'frontend/js/config.js still needs the Apps Script /exec URL.',
    VALIDATION_FAILED:
      'The server could not read this address. Ask the admin to send the ' +
      'projector link again.'
  },

  /**
   * Status pills. DESIGN.md §8: colour AND word AND shape, always all three.
   * The colours themselves are the --status-*-bg custom properties in app.css;
   * only the class name is chosen here.
   * @const
   */
  STATUS: {
    PENDING:   { cls: 'status--pending', mark: '●', word: 'Pending' },
    SOLD:      { cls: 'status--sold',    mark: '✓', word: 'Sold' },
    UNSOLD:    { cls: 'status--unsold',  mark: '✕', word: 'Un-sold' },
    'UN-SOLD': { cls: 'status--unsold',  mark: '✕', word: 'Un-sold' }
  },

  /** ENUM.PLAYER_ROLE (DESIGN.md §2.3). Same words as the registration form. */
  ROLE_LABEL: {
    BATSMAN: 'Batsman',
    BOWLER: 'Bowler',
    ALL_ROUNDER: 'All rounder'
  },

  /**
   * ENUM.PLAYER_STYLE. The schema stores handedness only — one `style` column
   * with LEFT or RIGHT (DESIGN.md §2.3) — so "batting / bowling style" on the
   * projector is that single value, worded exactly as the registration form
   * worded it back to the player.
   */
  STYLE_LABEL: {
    LEFT: 'Left handed',
    RIGHT: 'Right handed'
  },

  /** Tournament status -> the word in the top bar. */
  PHASE_LABEL: {
    AUCTION_LIVE: 'Auction live',
    AUCTION_CLOSED: 'Auction closed',
    REG_OPEN: 'Registration open',
    REG_CLOSED: 'Registration closed',
    DRAFT: 'Not started'
  },

  /** Summary rows, in the order they appear. Keys come from DESIGN.md §7.3. */
  SUMMARY_FIELDS: [
    { key: 'sold', label: 'Sold' },
    { key: 'unsold', label: 'Un-sold' },
    { key: 'pending_called', label: 'Awaiting re-auction' },
    { key: 'not_called', label: 'Not called' },
    { key: 'eligible', label: 'Eligible' }
  ],

  /* ------------------------------------------------------------------ *
   * Per-render state
   * ------------------------------------------------------------------ */

  /**
   * Bumped by every render(). Any timer or promise that finds _gen has moved
   * on belongs to a screen that is no longer on display and must do nothing.
   * @type {number}
   */
  _gen: 0,

  /** @type {?Object} the live render's state, or null after teardown */
  _state: null,

  /**
   * How many times a snapshot has actually been painted. Diagnostics only —
   * and the thing the tests assert on to prove that a {same:true} poll does
   * NOT repaint.
   * @type {number}
   */
  _paints: 0,

  /**
   * Thumbnail URLs already handed to `new Image()`. Module level, not per
   * render, so navigating away and back does not re-fetch a warm cache.
   * @type {!Object<string, boolean>}
   */
  _warmed: {},

  /** Stops _warmed growing without bound over a long auction. @const */
  WARM_LIMIT: 1200,

  /* ================================================================== *
   * Entry point
   * ================================================================== */

  /**
   * @param {Object} ctx router context {path, params, query, pattern}
   * @return {void}
   */
  render: function (ctx) {
    // ALWAYS FIRST. A second render() while the first is still polling would
    // otherwise leave two timers alive, and the poll rate would double on
    // every navigation until the backend starts returning SYSTEM_BUSY.
    DisplayPage._teardown();

    const gen = ++DisplayPage._gen;

    document.body.dataset.route = DisplayPage.ROUTE_KEY;
    document.title = 'Auction display · Cricket Auction';

    const params = (ctx && ctx.params) || {};
    const query = (ctx && ctx.query) || {};
    const tournamentId = String(params.tournamentId || '').trim();
    const token = String(query.k || '').trim();

    const state = {
      gen: gen,
      tournamentId: tournamentId,
      token: token,
      /** last version we hold; sent back as ?v= so an unchanged poll is ~30 bytes */
      v: null,
      /** current gap between polls, in ms; doubles on failure up to MAX_POLL_MS */
      delay: DisplayPage.pollMs(),
      /** consecutive failures */
      fails: 0,
      /** true once a fatal error has stopped the poll for good */
      stopped: false,
      /** true while a request is in flight, so a manual R cannot double up */
      inFlight: false,
      /** true while the tab is hidden and the poll is parked */
      paused: false,
      /** Date.now() of the last successful poll, for the staleness read-out */
      lastOkAt: 0,
      /** identity of the player currently on screen, so we only fade on change */
      shownKey: '',
      timer: null,
      hintTimer: null,
      onKeydown: null,
      onVisibility: null,
      el: null
    };
    DisplayPage._state = state;

    // No key in the address at all. Say so now rather than polling once,
    // collecting an UNAUTHORIZED and showing the same thing a second later.
    state.el = DisplayPage._buildSkeleton(state);
    DisplayPage._mount(state.el.root);
    DisplayPage._attachListeners(state);
    DisplayPage._startHintTimer(state);

    if (!tournamentId) {
      DisplayPage._fatal(state, 'This address does not name a tournament. ' +
        'Open the projector link the admin gave you.');
      return;
    }
    if (!token) {
      DisplayPage._fatal(state, 'This address has no display key. The projector ' +
        'link ends in "?k=" followed by the key — open that link, not this one.');
      return;
    }

    // First poll immediately: an audience should not watch a blank screen for
    // two seconds while the page waits for its own timer.
    DisplayPage._poll(state);
  },

  /**
   * @return {number} the contracted poll interval in ms
   */
  pollMs: function () {
    const configured = (typeof CONFIG !== 'undefined' && CONFIG)
      ? Number(CONFIG.POLL_INTERVAL_MS)
      : NaN;
    return (isFinite(configured) && configured > 0)
      ? configured
      : DisplayPage.BASE_POLL_MS;
  },

  /**
   * @param {!Object} state
   * @return {boolean} true when this state still owns the screen
   */
  _current: function (state) {
    return !!state && state.gen === DisplayPage._gen;
  },

  /* ================================================================== *
   * Lifecycle: teardown
   * ================================================================== */

  /**
   * Drop every timer and every listener the previous render created.
   *
   * Called at the top of render(), so navigating away and back — or the router
   * re-resolving on a popstate — can never leave a second poll loop running or
   * a second keydown handler swallowing F and R.
   * @return {void}
   */
  _teardown: function () {
    const state = DisplayPage._state;
    DisplayPage._state = null;
    if (!state) return;

    state.stopped = true;

    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.hintTimer !== null) {
      window.clearTimeout(state.hintTimer);
      state.hintTimer = null;
    }
    if (state.onKeydown) {
      document.removeEventListener('keydown', state.onKeydown);
      state.onKeydown = null;
    }
    if (state.onVisibility) {
      document.removeEventListener('visibilitychange', state.onVisibility);
      state.onVisibility = null;
    }
  },

  /* ================================================================== *
   * Listeners: keyboard and visibility
   * ================================================================== */

  /**
   * @param {!Object} state
   * @return {void}
   */
  _attachListeners: function (state) {
    /**
     * F = fullscreen, R = refresh. Nothing else, and nothing that could change
     * data — this page has no write action to call.
     * @param {KeyboardEvent} ev
     * @return {void}
     */
    state.onKeydown = function (ev) {
      if (!DisplayPage._current(state)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;   // browser shortcuts

      const key = String(ev.key || '').toLowerCase();
      if (key === 'f') {
        ev.preventDefault();
        DisplayPage._toggleFullscreen();
      } else if (key === 'r') {
        ev.preventDefault();
        DisplayPage.forceRefresh();
      }
    };
    document.addEventListener('keydown', state.onKeydown);

    /**
     * A projector tab that someone minimised at 4pm must not still be polling
     * at 7pm. Park the loop while hidden; catch up the instant it is shown.
     * @return {void}
     */
    state.onVisibility = function () {
      if (!DisplayPage._current(state)) return;

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
      if (state.stopped) return;
      // Immediately, not on the next tick: whatever is on screen is by
      // definition at least as stale as the time the tab spent hidden.
      DisplayPage._poll(state);
    };
    document.addEventListener('visibilitychange', state.onVisibility);
  },

  /**
   * Ask for, or leave, fullscreen. Wrapped because the Fullscreen API rejects
   * when it is not driven by a user gesture, and an unhandled rejection in
   * front of an audience helps nobody.
   * @return {void}
   */
  _toggleFullscreen: function () {
    try {
      const doc = document;
      const root = doc.documentElement;
      const active = doc.fullscreenElement || doc.webkitFullscreenElement || null;

      const run = active
        ? (doc.exitFullscreen || doc.webkitExitFullscreen)
        : (root.requestFullscreen || root.webkitRequestFullscreen);
      if (typeof run !== 'function') return;

      const result = run.call(active ? doc : root);
      if (result && typeof result.catch === 'function') {
        result.catch(function () { /* refused; the screen is still usable */ });
      }
    } catch (e) {
      /* no Fullscreen API here; F simply does nothing */
    }
  },

  /**
   * PUBLIC. What the R key does: throw away the back-off and poll right now.
   * Also the escape hatch for an operator who suspects the screen is stale.
   * @return {void}
   */
  forceRefresh: function () {
    const state = DisplayPage._state;
    if (!DisplayPage._current(state)) return;
    if (state.stopped) return;

    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    state.delay = DisplayPage.pollMs();
    DisplayPage._poll(state);
  },

  /* ================================================================== *
   * The poll — DESIGN.md §7.4, CONTRACTS-PHASE4-7.md §4.5
   * ================================================================== */

  /**
   * @param {!Object} state
   * @param {number} delay ms
   * @return {void}
   */
  _schedule: function (state, delay) {
    if (!DisplayPage._current(state) || state.stopped || state.paused) return;
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(function () {
      state.timer = null;
      DisplayPage._poll(state);
    }, delay);
  },

  /**
   * One request.
   *
   * `v` is the version we already hold. The server answers {v, same:true} —
   * about 30 bytes, and no Spreadsheet read — when nothing has changed, which
   * is what makes a 2-second poll affordable for three hours.
   *
   * retryBusy:false is deliberate. API's SYSTEM_BUSY backoff sleeps 2s and then
   * 5s inside a single call; on a 2-second loop that would stack requests on
   * top of each other. This page runs its own, visible back-off instead.
   *
   * @param {!Object} state
   * @return {void}
   */
  _poll: function (state) {
    if (!DisplayPage._current(state) || state.stopped) return;
    if (state.inFlight) return;
    state.inFlight = true;

    const payload = { tournamentId: state.tournamentId, k: state.token };
    if (typeof state.v === 'number') payload.v = state.v;

    API.get(DisplayPage.ACTION, payload, { retryBusy: false })
      .then(function (data) {
        state.inFlight = false;
        if (!DisplayPage._current(state) || state.stopped) return;
        DisplayPage._onSuccess(state, data);
      })
      .catch(function (err) {
        state.inFlight = false;
        if (!DisplayPage._current(state) || state.stopped) return;
        DisplayPage._onFailure(state, err);
      });
  },

  /**
   * @param {!Object} state
   * @param {*} data envelope.data — either {v, same:true} or {v, ...snapshot}
   * @return {void}
   */
  _onSuccess: function (state, data) {
    // Recovery resets BOTH the interval and the indicator. Anything less and
    // the screen would stay at 15-second polls for the rest of the auction
    // after one blip.
    state.fails = 0;
    state.delay = DisplayPage.pollMs();
    state.lastOkAt = Date.now();
    DisplayPage._setLink(state, 'live', 'Live');

    const snap = (data && typeof data === 'object') ? data : {};
    const version = (typeof snap.v === 'number')
      ? snap.v
      : ((typeof API !== 'undefined' && API && typeof API.lastVersion === 'number')
        ? API.lastVersion
        : state.v);
    state.v = version;

    // The whole point of the version handshake: nothing changed, so nothing is
    // repainted. Repainting here would restart the fade twice a second and
    // make a still screen look like it is flickering.
    if (snap.same !== true) DisplayPage._paint(state, snap);

    DisplayPage._schedule(state, state.delay);
  },

  /**
   * A failed poll. Back off 2s -> 4s -> 8s -> 15s and SAY SO on screen.
   *
   * @param {!Object} state
   * @param {*} err {code, message}
   * @return {void}
   */
  _onFailure: function (state, err) {
    const code = (err && err.code) ? String(err.code) : '';

    if (Object.prototype.hasOwnProperty.call(DisplayPage.FATAL_MESSAGE, code)) {
      DisplayPage._fatal(state, DisplayPage.FATAL_MESSAGE[code]);
      return;
    }

    state.fails += 1;
    state.delay = Math.min(state.delay * 2, DisplayPage.MAX_POLL_MS);

    DisplayPage._setLink(state, 'reconnecting',
      'Reconnecting' + DisplayPage._stalenessSuffix(state));

    DisplayPage._schedule(state, state.delay);
  },

  /**
   * " — data is 14s old". Says out loud what the audience cannot otherwise
   * know: that the figure on screen is not current.
   *
   * @param {!Object} state
   * @return {string}
   */
  _stalenessSuffix: function (state) {
    if (!state.lastOkAt) return '';
    const seconds = Math.round((Date.now() - state.lastOkAt) / 1000);
    if (!isFinite(seconds) || seconds < 5) return '';
    return ' — data is ' + seconds + 's old';
  },

  /**
   * Stop for good and put a readable message where the player card was.
   * A blank projector at a venue cannot be diagnosed; a sentence can.
   *
   * @param {!Object} state
   * @param {string} message
   * @return {void}
   */
  _fatal: function (state, message) {
    state.stopped = true;
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    DisplayPage._setLink(state, 'stopped', 'Not connected');
    DisplayPage._showMessage(state, 'Cannot show this auction', message);
  },

  /* ================================================================== *
   * Painting
   * ================================================================== */

  /**
   * Paint one snapshot. Only ever called for a CHANGED snapshot — see
   * _onSuccess.
   *
   * Nothing here rebuilds the DOM. The skeleton is created once in
   * _buildSkeleton and this only writes textContent into it, so the browser
   * has almost no layout to redo and the 200 ms fade is the only motion on
   * screen.
   *
   * @param {!Object} state
   * @param {!Object} snap DESIGN.md §7.3 snapshot
   * @return {void}
   */
  _paint: function (state, snap) {
    DisplayPage._paints += 1;

    const el = state.el;
    const status = String(snap.status || '');
    const closed = status === 'AUCTION_CLOSED';
    const current = (snap && snap.current) ? snap.current : null;

    DisplayPage._setText(el.tournament, DisplayPage._tournamentName(state, snap));
    DisplayPage._setText(el.phase, DisplayPage.PHASE_LABEL[status] ||
      (status ? status.replace(/_/g, ' ').toLowerCase() : ''));

    if (closed) {
      // The end state everyone in the hall is waiting for. The final figures
      // are the headline now, not whoever happened to be called last.
      DisplayPage._showMessage(state, 'Auction closed',
        DisplayPage._closingLine(snap));
      state.shownKey = '';
    } else if (current) {
      DisplayPage._paintPlayer(state, current);
    } else {
      DisplayPage._showMessage(state, DisplayPage._tournamentName(state, snap),
        'Waiting for the first player');
      state.shownKey = '';
    }

    DisplayPage._paintTeams(state, snap.teams);
    DisplayPage._paintSummary(state, snap.summary);
    DisplayPage._prewarm(snap);
  },

  /**
   * @param {!Object} state
   * @param {!Object} p snapshot.current
   * @return {void}
   */
  _paintPlayer: function (state, p) {
    const el = state.el;

    el.message.hidden = true;
    el.card.hidden = false;

    const serial = (p.serial_no === null || p.serial_no === undefined || p.serial_no === '')
      ? '' : String(p.serial_no);

    DisplayPage._setText(el.serial, serial ? '#' + serial : '');
    // textContent, never innerHTML. This name was typed into a public form by
    // a stranger; on a projector in front of 300 people it is the very last
    // place we would want markup to be interpreted.
    DisplayPage._setText(el.name, String(p.name || 'Unnamed player'));
    DisplayPage._setText(el.role, DisplayPage._roleText(p.role));
    DisplayPage._setText(el.style, DisplayPage._styleText(p.style));
    DisplayPage._setText(el.age, DisplayPage._ageText(p.age_years));

    // photo_url is the 1200px projector variant; photo_thumb_url (320px) is the
    // fallback for a snapshot from an older backend.
    DisplayPage._setPhoto(state, p.photo_url || p.photo_thumb_url, serial);
    DisplayPage._setStatus(state, p.auction_status);
    DisplayPage._setResult(state, p);

    // Fade only when the player on screen actually changed. A repaint caused
    // by a purse update must not re-run the reveal — from the back of the hall
    // a re-fade looks like the screen glitched.
    const key = String(p.player_id || '') + '|' + serial + '|' + String(p.name || '');
    if (key !== state.shownKey) {
      state.shownKey = key;
      DisplayPage._replay(el.card);
    }
  },

  /**
   * The "waiting", "closed" and "cannot connect" screens all share one card,
   * so there is exactly one place that can leave the projector blank.
   *
   * @param {!Object} state
   * @param {string} title
   * @param {string} body
   * @return {void}
   */
  _showMessage: function (state, title, body) {
    const el = state.el;
    el.card.hidden = true;
    el.message.hidden = false;
    DisplayPage._setText(el.messageTitle, String(title || ''));
    DisplayPage._setText(el.messageBody, String(body || ''));
  },

  /**
   * @param {!Object} state
   * @param {*} teams snapshot.teams
   * @return {void}
   */
  _paintTeams: function (state, teams) {
    const list = state.el.teams;
    const rows = Array.isArray(teams) ? teams : [];

    // Rebuilt rather than diffed: the teams strip is a handful of nodes, it
    // only changes when a sale happens, and a diff here would be more code to
    // get wrong than it saves.
    list.textContent = '';

    if (!rows.length) {
      state.el.bottom.hidden = true;
      return;
    }
    state.el.bottom.hidden = false;

    // SHAPE THE TABLE TO THE NUMBER OF TEAMS.
    //
    // This was a fixed "six rows, then a new column", which is fine at 6 and 12
    // and wrong at 20: four columns will not fit across a 1024px projector
    // beside the tallies.
    //
    // Instead, bound the COLUMNS and let the rows grow. Ten rows is about the
    // most that fits the bottom third of a 768px screen at a legible size, so:
    //
    //    6 teams -> 1 column of 6      20 teams -> 2 columns of 10
    //   12 teams -> 2 columns of 6     30 teams -> 3 columns of 10
    //
    // Height is the cheaper axis here — the block is bottom-aligned and the
    // stage above it is what needs the room, not the strip.
    // Eight per column, capped at three columns. Eight, not ten, because ten
    // produced a discontinuity nobody would predict: 10 teams became ONE column
    // of ten rows at full size — TALLER than 11 teams, which became two columns
    // of six at a smaller size. On a laptop with browser chrome that tallest
    // case overflowed the strip and the last team was never seen.
    //
    //    6 -> 1 x 6      12 -> 2 x 6      20 -> 3 x 7      30 -> 3 x 10
    const perColumn = 8;
    const maxCols = 3;
    const cols = Math.min(maxCols, Math.max(1, Math.ceil(rows.length / perColumn)));
    const rowCount = Math.ceil(rows.length / cols);

    // A CUSTOM PROPERTY, not grid-template-rows directly.
    //
    // An inline grid-template-rows beats every stylesheet rule including one
    // inside a media query, so setting it here silently killed the portrait
    // rule added alongside it — a portrait-mounted projector kept the tall
    // layout on the layout with the least vertical room. CSS reads this value
    // through a var() it can override.
    list.style.setProperty('--auto-rows', String(rowCount));

    // Drives the type scale. Past a dozen teams the rows have to give up some
    // size to stay inside the strip; CSS decides how much.
    if (state.el.teamsBox) {
      // Tied to how tall the block actually gets, which is rowCount — not the
      // raw team count, which is what made 10 teams render larger than 11.
      state.el.teamsBox.dataset.density =
        (rowCount > 8 || rows.length > 18) ? 'tight'
          : ((rowCount > 6 || rows.length > 8) ? 'compact' : 'normal');
      state.el.teamsBox.dataset.columns = String(cols);
    }

    rows.forEach(function (team) {
      const li = DisplayPage._el('li', 'display__team-cell');

      li.appendChild(DisplayPage._el('span', 'display__team-name',
        String(team.team_name || team.team_id || '')));

      li.appendChild(DisplayPage._el('span', 'display__team-purse',
        DisplayPage._moneyText(team.purse_remaining_display, team.purse_remaining)));

      const count = DisplayPage._num(team.players_count);
      const max = DisplayPage._num(team.max_players);
      const countEl = DisplayPage._el('span', 'display__team-count',
        count + ' / ' + max);

      // Mark a full squad so it reads at a glance from the back of the hall.
      //
      // Compared as NUMBERS. _num returns a formatted string, and '7' >= '12'
      // is true in a string comparison because '7' sorts after '1' — which
      // marked every single-digit team as full.
      const countN = Number(team.players_count) || 0;
      const maxN = Number(team.max_players) || 0;
      if (maxN > 0 && countN >= maxN) countEl.dataset.full = 'true';
      li.appendChild(countEl);

      // per_slot removed: every player goes for a different amount, so a purse
      // divided by empty slots implied a price that does not exist.

      list.appendChild(li);
    });
  },

  /**
   * @param {!Object} state
   * @param {*} summary snapshot.summary
   * @return {void}
   */
  _paintSummary: function (state, summary) {
    const box = state.el.summary;
    const s = (summary && typeof summary === 'object') ? summary : null;

    box.textContent = '';
    if (!s) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    DisplayPage.SUMMARY_FIELDS.forEach(function (field) {
      if (s[field.key] === null || s[field.key] === undefined) return;
      box.appendChild(DisplayPage._summaryItem(
        DisplayPage._num(s[field.key]), field.label));
    });

  },

  /**
   * @param {string} value
   * @param {string} label
   * @return {HTMLElement}
   */
  _summaryItem: function (value, label) {
    const item = DisplayPage._el('div', 'display__summary-item');
    item.appendChild(DisplayPage._el('span', 'display__summary-value', value));
    item.appendChild(DisplayPage._el('span', 'display__summary-label', label));
    return item;
  },

  /**
   * The line under "Auction closed" — the final numbers, in words.
   * @param {!Object} snap
   * @return {string}
   */
  _closingLine: function (snap) {
    const s = (snap && snap.summary) ? snap.summary : {};
    const bits = [];
    if (s.sold !== undefined && s.sold !== null) {
      bits.push(DisplayPage._num(s.sold) + ' players sold');
    }
    if (s.total_spent_display || s.total_spent !== undefined) {
      bits.push('for ' + DisplayPage._moneyText(s.total_spent_display, s.total_spent));
    }
    if (s.not_called !== undefined && s.not_called !== null) {
      bits.push('· ' + DisplayPage._num(s.not_called) + ' not called');
    }
    return bits.length ? bits.join(' ') : 'Final results are below.';
  },

  /* ------------------------------------------------------------------ *
   * Small painters
   * ------------------------------------------------------------------ */

  /**
   * The status pill: a COLOUR (class), a WORD (text) and a SHAPE (a real
   * element). DESIGN.md §8/§51 — never colour alone, because a washed-out
   * projector eats saturation and roughly 1 in 12 men cannot tell the green
   * one from the amber one.
   *
   * The shape is a child element rather than a ::before so that it survives
   * display.css failing to load, and so a test can see it. display.css turns
   * app.css's ::before off inside this route to avoid two glyphs.
   *
   * @param {!Object} state
   * @param {*} status PENDING | SOLD | UNSOLD
   * @return {void}
   */
  _setStatus: function (state, status) {
    const key = String(status || '').toUpperCase();
    const spec = DisplayPage.STATUS[key] || null;
    const pill = state.el.status;

    if (!spec) {
      pill.hidden = true;
      pill.className = 'status';
      return;
    }

    pill.hidden = false;
    pill.className = 'status ' + spec.cls;
    DisplayPage._setText(state.el.statusMark, spec.mark);
    DisplayPage._setText(state.el.statusWord, spec.word);
  },

  /**
   * The money line: "₹1,20,000 · Chennai Warriors" once a player is sold.
   * @param {!Object} state
   * @param {!Object} p
   * @return {void}
   */
  _setResult: function (state, p) {
    const amount = p.sold_amount_display ? String(p.sold_amount_display) : '';
    const team = p.team_name ? String(p.team_name) : '';

    DisplayPage._setText(state.el.amount, amount);
    DisplayPage._setText(state.el.team, team);
    state.el.amount.hidden = !amount;
    state.el.team.hidden = !team;
  },

  /**
   * @param {!Object} state
   * @param {*} url photo_thumb_url
   * @param {string} serial
   * @return {void}
   */
  _setPhoto: function (state, url, serial) {
    const src = url ? String(url) : '';
    const img = state.el.photo;
    const empty = state.el.photoEmpty;

    if (!src) {
      img.hidden = true;
      img.removeAttribute('src');
      empty.hidden = false;
      DisplayPage._setText(empty, serial ? '#' + serial : 'No photo');
      return;
    }

    empty.hidden = true;
    img.hidden = false;
    // Only touch src when it changed: reassigning the same URL restarts the
    // decode and can flash the image on some browsers.
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    // The name beside it is the accessible text; the photo adds nothing a
    // screen reader needs, so it stays decorative.
    img.setAttribute('alt', '');
  },

  /**
   * Re-run the 200 ms fade defined in app.css.
   *
   * Removing the class, forcing a reflow and re-adding it is the only reliable
   * way to restart a CSS animation. offsetWidth is read purely for the side
   * effect; nothing uses the value.
   *
   * @param {HTMLElement} node
   * @return {void}
   */
  _replay: function (node) {
    if (!node || !node.classList) return;
    node.classList.remove('reveal');
    /* eslint-disable-next-line no-unused-expressions */
    node.offsetWidth;
    node.classList.add('reveal');
  },

  /**
   * @param {!Object} state
   * @param {string} kind 'live' | 'reconnecting' | 'stopped'
   * @param {string} text
   * @return {void}
   */
  _setLink: function (state, kind, text) {
    const el = state.el;
    if (!el || !el.link) return;
    el.link.dataset.state = kind;
    DisplayPage._setText(el.linkMark, kind === 'live' ? '●' : '⚠');
    DisplayPage._setText(el.linkText, text);
  },

  /* ================================================================== *
   * Image pre-warming — CONTRACTS-PHASE4-7.md PHASE 5 §7
   * ================================================================== */

  /**
   * Put every thumbnail we have been told about into the browser cache.
   *
   * Revealing player #27 must be instant. A cold thumbnail is a 400 ms blank
   * rectangle in front of an audience, which is exactly the moment the room is
   * looking hardest at the screen.
   *
   * CONTRACT AMBIGUITY, RESOLVED: PHASE 5 §7 says "fetch every eligible
   * player's thumbnail once", but the §4.5 / DESIGN §7.3 snapshot only carries
   * `current`. There is no public roster action to call, and inventing one
   * would be a second public surface guarded by the same display token. So:
   * if the payload ever grows a roster (`roster`, `players`, `upcoming` or a
   * plain `thumbs` array) every URL in it is warmed on the first snapshot that
   * carries it; otherwise each player's thumbnail is warmed the moment they
   * first appear, which still removes the wait on every re-display and on the
   * SOLD/UN-SOLD repaint of the player already on screen.
   *
   * @param {!Object} snap
   * @return {void}
   */
  _prewarm: function (snap) {
    if (typeof Image !== 'function') return;

    const urls = [];
    const take = function (value) {
      if (!value) return;
      if (typeof value === 'string') { urls.push(value); return; }
      // One image per player: whichever the stage will actually render.
      if (value.photo_url) urls.push(String(value.photo_url));
      else if (value.photo_thumb_url) urls.push(String(value.photo_thumb_url));
      else if (value.thumb) urls.push(String(value.thumb));
    };

    take(snap.current);
    ['roster', 'players', 'upcoming', 'thumbs'].forEach(function (key) {
      const list = snap[key];
      if (Array.isArray(list)) list.forEach(take);
    });

    urls.forEach(function (url) {
      if (!url || DisplayPage._warmed[url]) return;
      if (Object.keys(DisplayPage._warmed).length >= DisplayPage.WARM_LIMIT) return;
      DisplayPage._warmed[url] = true;
      try {
        const img = new Image();
        img.decoding = 'async';
        // No onload, no onerror, nothing appended to the DOM. The browser
        // cache is doing the work; we only need the request to have happened.
        img.src = url;
      } catch (e) {
        /* a warm cache is an optimisation, never a requirement */
      }
    });
  },

  /* ================================================================== *
   * The skeleton — built once per render, then only written into
   * ================================================================== */

  /**
   * @param {!Object} state
   * @return {!Object} a map of the nodes _paint writes into
   */
  _buildSkeleton: function (state) {
    const root = DisplayPage._el('main', 'panel display');

    /* ---- top bar: which tournament, which phase, is the feed alive ---- */
    const top = DisplayPage._el('header', 'display__top');

    // NOT the tournament id. "TRN_ghb1jr2xgs84" on a screen in front of a hall
    // is meaningless; the real name arrives in the snapshot and _paint fills it
    // in. Until then a neutral word, never the id.
    const tournament = DisplayPage._el('span', 'display__tournament', 'Auction');
    top.appendChild(tournament);

    const phase = DisplayPage._el('span', 'display__phase', '');
    top.appendChild(phase);

    // role="status" not "alert": going amber must not interrupt a screen
    // reader mid-sentence, but it must be announced.
    const link = DisplayPage._el('span', 'display__link');
    link.setAttribute('role', 'status');
    link.setAttribute('aria-live', 'polite');
    link.dataset.state = 'connecting';

    const linkMark = DisplayPage._el('span', 'display__link-mark', '●');
    linkMark.setAttribute('aria-hidden', 'true');   // the word beside it speaks
    link.appendChild(linkMark);

    const linkText = DisplayPage._el('span', 'display__link-text', 'Connecting');
    link.appendChild(linkText);
    top.appendChild(link);

    root.appendChild(top);

    /* ---- the stage: either the player card or a message ---------------- */
    const stage = DisplayPage._el('div', 'display__stage');

    const card = DisplayPage._el('section', 'display-layout display__card');
    card.hidden = true;

    const photoBox = DisplayPage._el('div', 'display__photo');
    const photo = DisplayPage._el('img', 'display-photo');
    photo.setAttribute('alt', '');
    photo.hidden = true;
    photoBox.appendChild(photo);
    const photoEmpty = DisplayPage._el('div', 'display__photo--empty', '');
    photoEmpty.hidden = true;
    photoBox.appendChild(photoEmpty);
    card.appendChild(photoBox);

    const details = DisplayPage._el('div', 'display__details');

    const serial = DisplayPage._el('p', 'display-serial', '');
    details.appendChild(serial);

    // <h1>, because the player's name is the heading of this screen.
    const name = DisplayPage._el('h1', 'display-name', '');
    details.appendChild(name);

    const role = DisplayPage._el('p', 'display-meta display-meta--role', '');
    details.appendChild(role);

    const style = DisplayPage._el('p', 'display-meta', '');
    details.appendChild(style);

    const age = DisplayPage._el('p', 'display-meta', '');
    details.appendChild(age);

    const result = DisplayPage._el('div', 'display__result');

    const status = DisplayPage._el('span', 'status');
    status.hidden = true;
    const statusMark = DisplayPage._el('span', 'status__mark', '');
    statusMark.setAttribute('aria-hidden', 'true');
    status.appendChild(statusMark);
    const statusWord = DisplayPage._el('span', 'status__word', '');
    status.appendChild(statusWord);
    result.appendChild(status);

    const amount = DisplayPage._el('span', 'display-amount', '');
    amount.hidden = true;
    result.appendChild(amount);

    const team = DisplayPage._el('span', 'display__team', '');
    team.hidden = true;
    result.appendChild(team);

    details.appendChild(result);
    card.appendChild(details);
    stage.appendChild(card);

    const message = DisplayPage._el('section', 'display__message');
    const messageTitle = DisplayPage._el('h1', 'display__message-title',
      'Auction display');
    message.appendChild(messageTitle);
    const messageBody = DisplayPage._el('p', 'display__message-body', 'Connecting…');
    message.appendChild(messageBody);
    stage.appendChild(message);

    root.appendChild(stage);

    /* ---- bottom: team standings and the summary ------------------------ */
    const bottom = DisplayPage._el('footer', 'display__bottom');
    bottom.hidden = true;

    // The teams block is wrapped so it can carry one caption instead of
    // repeating the word "Remaining" on every row — which at 12 teams is twelve
    // repetitions of the same word competing with the figures.
    const teamsBox = DisplayPage._el('section', 'display__teams-box');
    teamsBox.appendChild(DisplayPage._el('h2', 'display__teams-caption',
      'Teams · purse remaining · players'));

    const teams = DisplayPage._el('ul', 'display__teams');
    teams.setAttribute('aria-label', 'Team standings');
    teamsBox.appendChild(teams);


    const summary = DisplayPage._el('div', 'display__summary');
    summary.hidden = true;

    // Summary first in the DOM, teams second: the bottom-right corner is the
    // teams table (feedback), and source order matches reading order for a
    // screen reader.
    bottom.appendChild(summary);
    bottom.appendChild(teamsBox);

    root.appendChild(bottom);

    /* ---- the keyboard hint, which fades out ---------------------------- */
    const hint = DisplayPage._el('p', 'display__hint',
      'F — fullscreen   ·   R — refresh');
    root.appendChild(hint);

    return {
      root: root,
      tournament: tournament,
      phase: phase,
      link: link,
      linkMark: linkMark,
      linkText: linkText,
      stage: stage,
      card: card,
      photo: photo,
      photoEmpty: photoEmpty,
      serial: serial,
      name: name,
      role: role,
      style: style,
      age: age,
      status: status,
      statusMark: statusMark,
      statusWord: statusWord,
      amount: amount,
      team: team,
      message: message,
      messageTitle: messageTitle,
      messageBody: messageBody,
      bottom: bottom,
      teams: teams,
      teamsBox: teamsBox,
      summary: summary,
      hint: hint
    };
  },

  /**
   * Fade the hint out after a few seconds. It has to be visible long enough
   * for whoever set the laptop up to read it, and gone long enough before the
   * first player that the audience never sees it.
   * @param {!Object} state
   * @return {void}
   */
  _startHintTimer: function (state) {
    state.hintTimer = window.setTimeout(function () {
      state.hintTimer = null;
      if (!DisplayPage._current(state)) return;
      if (state.el && state.el.hint && state.el.hint.classList) {
        state.el.hint.classList.add('is-faded');
      }
    }, DisplayPage.HINT_MS);
  },

  /**
   * Put the page on screen. Prefers App.mount so there is one place that
   * clears #app, but works standalone if app.js is not loaded.
   * @param {HTMLElement} el
   * @return {void}
   */
  _mount: function (el) {
    if (typeof App !== 'undefined' && App && typeof App.mount === 'function') {
      App.mount(el);
      return;
    }
    const root = document.getElementById('app');
    if (!root) return;
    root.textContent = '';
    root.appendChild(el);
  },

  /* ================================================================== *
   * Text helpers. textContent only, everywhere, without exception.
   * ================================================================== */

  /**
   * createElement with a class and text in one call.
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @return {HTMLElement}
   */
  _el: function (tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  },

  /**
   * Write text, but only when it differs. On a screen repainted every couple
   * of seconds this is the difference between no layout work and a full
   * reflow of a 140px heading.
   * @param {HTMLElement} node
   * @param {string} text
   * @return {void}
   */
  _setText: function (node, text) {
    if (!node) return;
    const value = (text === null || text === undefined) ? '' : String(text);
    if (node.textContent !== value) node.textContent = value;
  },

  /**
   * @param {!Object} state
   * @param {!Object} snap
   * @return {string}
   *
   * CONTRACT AMBIGUITY, RESOLVED: the §7.3 snapshot shape does not list a
   * tournament name, but requirement 12 asks for one on the waiting screen.
   * Any of the obvious keys is accepted, and the tournament id is the last
   * resort — an id on screen is ugly, but it is honest and it is diagnosable,
   * which "Waiting for the first player" on its own is not.
   */
  _tournamentName: function (state, snap) {
    if (!snap) return 'Auction';
    if (snap.tournament_name) return String(snap.tournament_name);
    if (snap.name) return String(snap.name);
    if (snap.tournament && snap.tournament.name) return String(snap.tournament.name);
    return 'Auction';
  },

  /**
   * @param {*} role
   * @return {string}
   */
  _roleText: function (role) {
    const key = String(role || '').toUpperCase();
    if (!key) return '';
    return DisplayPage.ROLE_LABEL[key] || key.replace(/_/g, ' ');
  },

  /**
   * @param {*} style
   * @return {string}
   */
  _styleText: function (style) {
    const key = String(style || '').toUpperCase();
    if (!key) return '';
    return DisplayPage.STYLE_LABEL[key] || key.replace(/_/g, ' ');
  },

  /**
   * @param {*} years
   * @return {string} e.g. "Age 26", or '' when the age is missing
   */
  _ageText: function (years) {
    const n = Number(years);
    if (!isFinite(n) || n <= 0) return '';
    return 'Age ' + Math.round(n);
  },

  /**
   * Prefer the server's pre-formatted money string. UI.money is the same
   * Indian grouping as Util.formatINR, so the fallback cannot disagree with
   * the rest of the app — but the server's own string is still preferred, so
   * one screen can never say "₹10,00,000" while another says "₹1,000,000".
   *
   * @param {*} display  e.g. "₹5,50,000"
   * @param {*} rupees   e.g. 550000
   * @return {string}
   */
  _moneyText: function (display, rupees) {
    if (display) return String(display);
    const n = Number(rupees);
    if (!isFinite(n)) return '';
    if (typeof UI !== 'undefined' && UI && typeof UI.money === 'function') {
      return UI.money(n);
    }
    return '₹' + String(Math.round(n));
  },

  /**
   * @param {*} value
   * @return {string} a whole number, or '0'
   */
  _num: function (value) {
    const n = Number(value);
    return isFinite(n) ? String(Math.round(n)) : '0';
  }
};
