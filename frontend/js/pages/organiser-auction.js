/**
 * organiser-auction.js — the live auction console. `OrganiserAuctionPage`.
 *
 * Route: /organiser/auction   (tournament from ?t=, storage, or auth.me)
 *
 * THIS IS THE SCREEN SOMEONE DRIVES A LIVE EVENT FROM, ON STAGE, IN FRONT OF A
 * FEW HUNDRED PEOPLE, WITH MONEY ATTACHED. Every decision below follows from
 * that one sentence. The organiser is standing, watching the room rather than
 * the screen, and a mistake here is visible to everyone in the hall and is only
 * fixable through a correction.
 *
 * THE WORKFLOW (DESIGN.md §34). The lottery is physical. A number is drawn in
 * the room, the organiser types it, the player appears on the projector,
 * bidding happens by voice, the organiser records what the room settled on:
 *
 *   type a serial -> player card appears -> physical bidding
 *        -> pick team + type amount -> confirm -> SOLD
 *        -> or MARK UNSOLD
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE4-7 §4.2  auction.getBySerial / search / markSold /
 *                            markUnsold / returnToPool / correct / state /
 *                            summary payloads and responses
 *   CONTRACTS-PHASE4-7 §4.5  the 2 s poll, the version handshake, {same:true}
 *   CONTRACTS-PHASE4-7 §4.6  the four honest labels and all_teams_full
 *   CONTRACTS-PHASE4-7 §4.7  three advisory warnings, none of which blocks
 *   CONTRACTS-PHASE4-7 §5.5  offline detection, the queue, the replay
 *   CONTRACTS-PHASE1 §4      textContent only, vanilla JS, all traffic through
 *                            API, document.body.dataset.route
 *   DESIGN.md §6.5a          the consequence line on every confirm
 *   DESIGN.md §6.6 / §6.7    return to pool, correction
 *   DESIGN.md §15 cases 18-23 unknown serial, ineligible player, closed
 *                            auction, no teams, all teams full
 *   DESIGN.md §32 / §33      search, and the nine controls the requirement asks
 *                            for
 *   KNOWN-ISSUES.md 10a      the offline replay MUST attach a freshly fetched
 *                            version — see _syncCall below
 *
 * THE SIX RULES THIS FILE EXISTS TO KEEP
 *
 *   1. THE CONFIRM DIALOG IS THE MAIN SAFETY FEATURE (DESIGN.md §6.5a).
 *      Nothing is ever sold without first showing the arithmetic:
 *          Sell Raj Kumar (#27) to Chennai Warriors for ₹75,000?
 *          Leaves ₹4,75,000 for 3 more slots.
 *      One extra zero during a live auction is the most damaging and least
 *      recoverable mistake available, and this line costs nothing.
 *
 *   2. WARNINGS ADVISE, THEY NEVER BLOCK (§4.7). Over a quarter of the team's
 *      purse, over five times the highest sale so far, or leaving less per
 *      remaining slot than the cheapest sale so far each raise an amber banner
 *      and a tick-box. A genuinely huge bid for a genuinely great player must
 *      always go through, so there is no wall anywhere on this screen.
 *
 *   3. expectedVersion IS MANDATORY ON EVERY WRITE, and STALE_STATE is never
 *      retried silently. The data the organiser was looking at when they
 *      decided was wrong, so the only honest answer is to say so and let them
 *      look again.
 *
 *   4. A {same:true} POLL MUST NOT REPAINT. Repainting twice a second would
 *      throw away the focus and the half-typed amount this screen is built
 *      around. The poll matches display.js exactly: 2 s, back off to 15 s with
 *      a visible indicator, stop while the tab is hidden, tear down on
 *      re-render.
 *
 *   5. OFFLINE IS A SAFETY NET, NOT A MODE (DESIGN.md §16). Three failed polls
 *      switch it on, the banner never goes away while it is on, and the paper
 *      sheet is named as the real fallback every time.
 *
 *   6. KEYBOARD FIRST. The serial box is big, numeric and always focused. A
 *      number plus Enter reveals a player. S sells, U marks unsold. The
 *      shortcuts are printed on the screen and they stand down inside the
 *      amount box and the search box, where a stray S would be a sale nobody
 *      asked for.
 *
 * CSS CLASS NAMES THIS FILE EMITS
 *   Reused from app.css unchanged:
 *     panel  panel__title  panel__subtitle  panel__note  banner  banner--error
 *     banner--warning  banner--info  banner--success  badge  choice  empty
 *     btn  btn--primary  btn--secondary  btn--danger  field  input  select
 *     status  status--pending  status--sold  status--unsold  visually-hidden
 *   New, owned by css/auction.css, every one scoped under
 *   body[data-route="organiser-auction"]:
 *     auc  auc__head  auc__scope  auc__actions  auc__banners  auc__errors
 *     auc__result  auc__body
 *     auc-link  auc-link__mark  auc-link__text
 *     auc-off  auc-off__title  auc-off__mark  auc-off__text  auc-off__note
 *     auc-off__actions
 *     auc-pack  auc-pack__status  auc-pack__progress  auc-pack__phase
 *     auc-pack__warnings  auc-pack__warn-list  auc-pack__actions  auc-pack__go
 *     auc-pack__note
 *     auc-call  auc-call__row  auc-call__go  auc-call__hint
 *     auc-find  auc-find__row  auc-find__results  auc-find__row-btn
 *     auc-find__serial  auc-find__name  auc-find__meta
 *     auc-card  auc-card__photo  auc-card__photo-empty  auc-card__body
 *     auc-card__serial  auc-card__name  auc-card__meta  auc-card__pills
 *     auc-card__called  auc-card__actions
 *     auc-sell  auc-sell__grid  auc-sell__preview  auc-sell__warnings
 *     auc-sell__ack  auc-sell__buttons  auc-sell__go  auc-sell__unsold
 *     auc-correct  auc-correct__grid
 *     auc-teams  auc-teams__list  auc-team  auc-team--full  auc-team__name
 *     auc-team__purse  auc-team__count  auc-team__slot
 *     auc-sum  auc-sum__list  auc-sum__item  auc-sum__value  auc-sum__label
 *     auc-keys  auc-keys__list  auc-keys__item  auc-keys__key  auc-keys__what
 *     auc-keys__note
 *     auc-rej  auc-rej__list  auc-rej__row  auc-rej__head  auc-rej__msg
 *     auc-rej__actions
 *     auc-zoom  auc-zoom__box  auc-zoom__img  auc-zoom__hint
 */

/* eslint-disable no-unused-vars */
const OrganiserAuctionPage = {

  /* ================================================================== *
   * Constants
   * ================================================================== */

  /** Written to <body data-route>; auction.css scopes everything on it. */
  ROUTE_KEY: 'organiser-auction',

  /** Organisers sign in through the same form as admins (PHASE3 §1). */
  LOGIN_PATH: '/admin/login',

  /** @const {string} */
  DASHBOARD_PATH: '/organiser/dashboard',

  /** The key organiser-join.js and organiser-dashboard.js already use. */
  TOURNAMENT_KEY: 'ca.organiser.tournament',

  /**
   * Thrown by _call() after it has already handled an expired session. A
   * caller that sees this must render nothing — the page is being replaced.
   * Same wrapper as admin-payments.js and admin-tournament.js.
   * @const
   */
  REDIRECTED: Object.freeze({ code: 'REDIRECTED', message: '' }),

  /** Fallback poll interval when CONFIG is missing. DESIGN.md §7.4. */
  BASE_POLL_MS: 2000,

  /** Back-off ceiling. DESIGN.md §7.4: "double the interval up to 15s". */
  MAX_POLL_MS: 15000,

  /** §4.7: over this share of the team's TOTAL purse raises an advisory. */
  WARN_PURSE_SHARE: 0.25,

  /** §4.7: over this multiple of the highest sale so far raises an advisory. */
  WARN_ABOVE_HIGHEST: 5,

  /** How many search rows to ask for. The server caps at 50 anyway. */
  SEARCH_LIMIT: 25,

  /**
   * Errors that will never fix themselves by waiting, so the poll stops and
   * says why rather than hammering the same wall every two seconds.
   * UNAUTHORIZED is not here: _call already redirects to the sign-in page.
   * @const {!Object<string,string>}
   */
  FATAL_MESSAGE: {
    FORBIDDEN:
      'This sign-in is not allowed to run the auction for this tournament. ' +
      'Ask the admin for a join link for the right tournament.',
    NOT_FOUND:
      'That tournament no longer exists. Check the link, or ask the admin.',
    NOT_CONFIGURED:
      'This copy of the site has not been pointed at a server yet. ' +
      'frontend/js/config.js still needs the Apps Script /exec URL.',
    VALIDATION_FAILED:
      'The server could not read this address. Open the auction console from ' +
      'the organiser dashboard.'
  },

  /**
   * Status pills. DESIGN.md §8/§51: colour AND word AND shape, always all
   * three. The shape is a real element, not a ::before, so it survives a
   * stylesheet that failed to load.
   * @const
   */
  STATUS: {
    PENDING: { cls: 'status--pending', mark: '●', word: 'Pending' },
    SOLD: { cls: 'status--sold', mark: '✓', word: 'Sold' },
    UNSOLD: { cls: 'status--unsold', mark: '✕', word: 'Un-sold' }
  },

  /** ENUM.PLAYER_ROLE, worded as the registration form worded it. */
  ROLE_LABEL: {
    BATSMAN: 'Batsman',
    BOWLER: 'Bowler',
    ALL_ROUNDER: 'All rounder'
  },

  /** ENUM.PLAYER_STYLE — the schema stores handedness only. */
  STYLE_LABEL: {
    LEFT: 'Left handed',
    RIGHT: 'Right handed'
  },

  /** Tournament status -> the word in the header. */
  PHASE_LABEL: {
    AUCTION_LIVE: 'Auction live',
    AUCTION_CLOSED: 'Auction closed',
    REG_OPEN: 'Registration open',
    REG_CLOSED: 'Registration closed',
    DRAFT: 'Not started'
  },

  /**
   * What each offline-pack failure means, in words the organiser can act on.
   * offline.js never fails silently — every one of these arrives as an Error
   * carrying `.code` — so every one of them gets a sentence here rather than a
   * shrug (offline.js "FAILURE MODES", KNOWN-ISSUES.md items 13 and 14).
   * @const {!Object<string,string>}
   */
  PACK_ERROR: {
    NO_IMAGE_FETCHER:
      'Photographs cannot be read by this browser build, so NOTHING was saved. ' +
      'Press Download again and the pack will be saved with PLAYER DETAILS ONLY — ' +
      'names, serial numbers, roles and styles, and no pictures.',
    NO_PLAYER_SOURCE:
      'The player list could not be reached, so the pack is empty. Check the ' +
      'connection and try again.',
    NO_STORAGE:
      'This browser window cannot store anything at all, so no offline pack and no ' +
      'queued result is possible. DO NOT RUN THE AUCTION FROM THIS WINDOW — use a ' +
      'normal (not private) window, or another laptop.',
    QUOTA_EXCEEDED:
      'This device is out of storage, so the pack was only partly saved. Free some ' +
      'space, or clear an old tournament pack, and download again. Do not start the ' +
      'auction assuming the pack is there.',
    IDB_BLOCKED:
      'The offline database is blocked in this window. Close every other tab of this ' +
      'app and reload. Private or incognito mode blocks it outright — use a normal window.',
    IDB_UPGRADE_FAILED:
      'The offline database could not be created or is newer than this copy of the ' +
      'app. Close every tab of this app and reload, then download again.',
    IDB_ERROR:
      'The offline store reported a fault and the pack is not complete. Try again, ' +
      'and if it keeps happening keep a paper list.'
  },

  /**
   * Printed on the screen, never hidden in a help modal. The organiser is
   * standing up and will not go looking for it.
   * @const {!Array<{keys:string, what:string}>}
   */
  SHORTCUTS: Object.freeze([
    Object.freeze({ keys: 'digits + Enter', what: 'Call that serial number' }),
    Object.freeze({ keys: 'S', what: 'SOLD — opens the confirm' }),
    Object.freeze({ keys: 'U', what: 'Mark the player UNSOLD' }),
    Object.freeze({ keys: 'A', what: 'Jump to the amount box' }),
    Object.freeze({ keys: '/', what: 'Jump to search' }),
    Object.freeze({ keys: 'N', what: 'Back to the serial box, ready for the next number' }),
    Object.freeze({ keys: 'P', what: 'Large photo' }),
    Object.freeze({ keys: 'Esc', what: 'Close the large photo' })
  ]),

  /* ================================================================== *
   * Per-render state
   * ================================================================== */

  /**
   * Bumped by every render(). Any timer or promise that finds _gen has moved
   * on belongs to a screen that is no longer on display and must do nothing.
   * @type {number}
   */
  _gen: 0,

  /** @type {?Object} the live render's state, or null after teardown */
  _state: null,

  /**
   * How many snapshots have actually been applied. Diagnostics only — and the
   * thing the harness asserts on to prove {same:true} does NOT repaint.
   * @type {number}
   */
  _paints: 0,

  /* ================================================================== *
   * Entry point
   * ================================================================== */

  /**
   * @param {Object} ctx router context {path, params, query, pattern}
   * @return {void}
   */
  render: function (ctx) {
    // ALWAYS FIRST. A second render() while the first is still polling would
    // otherwise leave two timers alive and double the request rate on every
    // navigation until the backend starts answering SYSTEM_BUSY.
    OrganiserAuctionPage._teardown();

    const gen = ++OrganiserAuctionPage._gen;

    document.body.dataset.route = OrganiserAuctionPage.ROUTE_KEY;
    document.title = 'Auction console · Cricket Auction';

    const state = {
      gen: gen,
      tournamentId: '',
      tournamentName: '',

      /* ---- the poll (DESIGN.md §7.4) ---- */
      /** the version we hold; sent back so an unchanged poll is ~30 bytes */
      v: null,
      status: '',
      teams: [],
      summary: null,
      delay: OrganiserAuctionPage.pollMs(),
      fails: 0,
      stopped: false,
      inFlight: false,
      paused: false,
      lastOkAt: 0,
      timer: null,

      /* ---- what is on the table ---- */
      /** the auction.getBySerial card, or null */
      card: null,
      /** true when the card came out of the offline pack, not the server */
      card_offline: false,
      /** the server's explanation when a player was looked up but not revealed */
      card_message: '',
      /** true when getBySerial actually put them on the projector */
      card_revealed: false,
      /** identity of the card the sell form was built for */
      sellKey: '',
      /** the signature of the warning set the tick-box was built for */
      warnKey: '',
      sell: { teamId: '', amount: '', ack: false },
      searchRows: [],

      /* ---- modals and flags ---- */
      zoom: null,
      dialogOpen: false,
      busy: false,
      correcting: false,

      /* ---- offline ---- */
      offline: false,
      queued: 0,
      rejected: [],
      /** the Offline.isPackReady answer, once it arrives */
      pack: null,
      /** true while Offline.downloadPack is running */
      packBusy: false,
      /** the UI.progress handle for the running download */
      packProgress: null,
      /** {code, message} from the last failed download */
      packError: null,
      /** set once a download has told us photographs are impossible here */
      packTextOnly: false,
      syncing: false,
      offChange: null,

      onKeydown: null,
      onVisibility: null,
      els: {}
    };
    OrganiserAuctionPage._state = state;

    // No token at all: do not flash an empty console, just go and sign in.
    if (!API.getToken()) {
      Router.navigate(OrganiserAuctionPage.LOGIN_PATH, { replace: true });
      return;
    }

    OrganiserAuctionPage._buildShell(state);
    OrganiserAuctionPage._attachListeners(state);
    OrganiserAuctionPage._watchOffline(state);

    const tid = OrganiserAuctionPage._resolveTournamentId(ctx);
    if (tid) {
      OrganiserAuctionPage._useTournament(state, tid);
      return;
    }
    // Nothing local knows the tournament. The session itself does, so ask it.
    // One extra round trip in the one case where the alternative is a dead end.
    OrganiserAuctionPage._askSession(state);
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
      : OrganiserAuctionPage.BASE_POLL_MS;
  },

  /**
   * @param {Object} state
   * @return {boolean} true when this state still owns the screen
   */
  _current: function (state) {
    return !!state && state.gen === OrganiserAuctionPage._gen;
  },

  /**
   * Drop every timer, listener and subscription the previous render created.
   * @return {void}
   */
  _teardown: function () {
    const state = OrganiserAuctionPage._state;
    OrganiserAuctionPage._state = null;
    if (!state) return;

    state.stopped = true;

    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.onKeydown) {
      document.removeEventListener('keydown', state.onKeydown);
      state.onKeydown = null;
    }
    if (state.onVisibility) {
      document.removeEventListener('visibilitychange', state.onVisibility);
      state.onVisibility = null;
    }
    if (typeof state.offChange === 'function') {
      try { state.offChange(); } catch (e) { /* already gone */ }
      state.offChange = null;
    }
    if (state.zoom && state.zoom.el && state.zoom.el.parentNode) {
      state.zoom.el.parentNode.removeChild(state.zoom.el);
    }
    state.zoom = null;
  },

  /* ================================================================== *
   * Shared plumbing — the same shape as admin-payments.js
   * ================================================================== */

  /**
   * Every backend call on this page goes through here.
   *
   * ONE place handles an expired session. A 12-hour session (CONTRACTS.md §7)
   * will expire under an organiser who left the console open overnight before
   * the auction, and that can happen on any of the eight actions this page
   * calls. Handling it per call means eight chances to forget one, and the one
   * that is forgotten shows "Not signed in" forever with no way out.
   *
   * @param {string} action
   * @param {Object} [payload]
   * @param {Object} [opts] passed through to API.call
   * @return {!Promise<*>} rejects with OrganiserAuctionPage.REDIRECTED once the
   *         session is gone and navigation has already been started.
   */
  _call: function (action, payload, opts) {
    return API.call(action, payload || {}, opts).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        API.clearToken();
        Router.navigate(OrganiserAuctionPage.LOGIN_PATH, { replace: true });
        throw OrganiserAuctionPage.REDIRECTED;
      }
      throw err;
    });
  },

  /**
   * @param {*} err
   * @return {boolean} true when _call has already navigated away
   */
  _handled: function (err) {
    return err === OrganiserAuctionPage.REDIRECTED;
  },

  /**
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

  /**
   * Which tournament this console is driving.
   *
   * The URL first, because it is visible, bookmarkable and shareable; then the
   * copy organiser-join.js left behind; then app.js's memory. All three are
   * conveniences — the server re-checks the caller's own tournament_id on
   * every action (DESIGN.md §5.6), so a wrong id here produces a refusal,
   * never somebody else's auction.
   *
   * @param {Object} ctx
   * @return {string} a tournament id, or ''
   */
  _resolveTournamentId: function (ctx) {
    const query = (ctx && ctx.query) || {};
    const param = (typeof App !== 'undefined' && App && App.TOURNAMENT_PARAM)
      ? App.TOURNAMENT_PARAM : 't';

    const fromUrl = OrganiserAuctionPage._safeId(query[param]);
    if (fromUrl) return fromUrl;

    let stored = '';
    try {
      stored = OrganiserAuctionPage._safeId(
        window.localStorage.getItem(OrganiserAuctionPage.TOURNAMENT_KEY));
    } catch (e) {
      stored = '';
    }
    if (stored) return stored;

    if (typeof App !== 'undefined' && App &&
        typeof App.rememberedTournamentId === 'function') {
      return OrganiserAuctionPage._safeId(App.rememberedTournamentId());
    }
    return '';
  },

  /**
   * Ids are generated by the server and are id-shaped. Anything else came from
   * a hand-edited URL and is not worth putting in a request.
   * @param {*} value
   * @return {string}
   */
  _safeId: function (value) {
    const s = String(value === null || value === undefined ? '' : value).trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
  },

  /**
   * @param {!Object} state
   * @return {void}
   */
  _askSession: function (state) {
    state.els.body.textContent = '';
    state.els.body.appendChild(UI.spinner('Finding your tournament…'));

    OrganiserAuctionPage._call('auth.me', {})
      .then(function (me) {
        if (!OrganiserAuctionPage._current(state)) return;
        const id = OrganiserAuctionPage._safeId(me && me.tournament_id);
        if (!id) {
          // An ADMIN has no tournament of their own (CONTRACTS.md §2.2).
          OrganiserAuctionPage._noTournament(state);
          return;
        }
        OrganiserAuctionPage._useTournament(state, id);
      })
      .catch(function (err) {
        if (OrganiserAuctionPage._handled(err) ||
            !OrganiserAuctionPage._current(state)) return;
        OrganiserAuctionPage._noTournament(state);
        OrganiserAuctionPage._showError(err);
      });
  },

  /**
   * @param {!Object} state
   * @return {void}
   */
  _noTournament: function (state) {
    state.els.body.textContent = '';
    const box = document.createElement('div');
    box.className = 'empty';

    const p = document.createElement('p');
    p.textContent = 'This console needs to know which tournament it is running. ' +
      'Open it from the organiser dashboard, or use the join link the admin sent you.';
    box.appendChild(p);

    const link = document.createElement('a');
    link.className = 'btn btn--secondary';
    link.href = Router.href(OrganiserAuctionPage.DASHBOARD_PATH);
    link.textContent = 'Organiser dashboard';
    box.appendChild(link);

    state.els.body.appendChild(box);
  },

  /**
   * @param {!Object} state
   * @param {string} id
   * @return {void}
   */
  _useTournament: function (state, id) {
    state.tournamentId = id;
    try {
      window.localStorage.setItem(OrganiserAuctionPage.TOURNAMENT_KEY, id);
    } catch (e) {
      /* convenience only; the console still works */
    }
    if (typeof App !== 'undefined' && App && typeof App.tournamentName === 'function') {
      state.tournamentName = String(App.tournamentName(id) || '');
    }
    OrganiserAuctionPage._renderScope(state);
    OrganiserAuctionPage._renderBody(state);
    OrganiserAuctionPage._loadRejected(state);
    OrganiserAuctionPage._loadPackStatus(state);

    // First poll immediately: an organiser should not watch a blank console
    // for two seconds while the page waits for its own timer.
    OrganiserAuctionPage._poll(state);
  },

  /* ================================================================== *
   * The frame
   * ================================================================== */

  /**
   * Build the whole frame once. Everything after this repaints one region.
   * Rebuilding the frame on every poll would throw away focus, which is the
   * one thing a keyboard-driven console cannot afford.
   * @param {!Object} state
   * @return {void}
   */
  _buildShell: function (state) {
    const els = state.els;

    const main = document.createElement('main');
    main.className = 'panel auc';

    /* ---- the offline bar, always in the DOM, usually empty ---------- */
    // Permanent live region: its CONTENTS change, it is never inserted and
    // removed, which is what makes it announced reliably.
    els.offline = document.createElement('div');
    els.offline.className = 'auc-off';
    els.offline.setAttribute('aria-live', 'assertive');
    els.offline.setAttribute('aria-atomic', 'true');
    els.offline.hidden = true;
    main.appendChild(els.offline);

    /* ---- head ------------------------------------------------------- */
    const head = document.createElement('div');
    head.className = 'auc__head';

    const heading = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = 'Auction console';
    heading.appendChild(h1);

    els.scope = document.createElement('p');
    els.scope.className = 'auc__scope';
    heading.appendChild(els.scope);
    head.appendChild(heading);

    els.actions = document.createElement('div');
    els.actions.className = 'auc__actions';

    // The connection state, in a word and a shape, not only a colour.
    els.link = document.createElement('span');
    els.link.className = 'auc-link';
    els.link.setAttribute('role', 'status');
    els.link.setAttribute('aria-live', 'polite');
    els.link.dataset.state = 'connecting';
    els.linkMark = document.createElement('span');
    els.linkMark.className = 'auc-link__mark';
    els.linkMark.setAttribute('aria-hidden', 'true');
    els.linkMark.textContent = '●';
    els.link.appendChild(els.linkMark);
    els.linkText = document.createElement('span');
    els.linkText.className = 'auc-link__text';
    els.linkText.textContent = 'Connecting';
    els.link.appendChild(els.linkText);
    els.actions.appendChild(els.link);

    els.actions.appendChild(UI.button('Auction summary', function () {
      OrganiserAuctionPage._loadSummary();
    }, { variant: 'secondary' }));

    const back = document.createElement('a');
    back.className = 'btn btn--secondary';
    back.href = Router.href(OrganiserAuctionPage.DASHBOARD_PATH);
    back.textContent = 'Teams and purses';
    els.actions.appendChild(back);

    head.appendChild(els.actions);
    main.appendChild(head);

    /* ---- banners, errors, result ------------------------------------ */
    els.banners = document.createElement('div');
    els.banners.className = 'auc__banners';
    main.appendChild(els.banners);

    els.errors = document.createElement('div');
    els.errors.className = 'auc__errors';
    els.errors.setAttribute('aria-live', 'assertive');
    els.errors.setAttribute('aria-atomic', 'true');
    main.appendChild(els.errors);

    // The result of the last SOLD / UNSOLD, announced politely. This is what a
    // screen reader user hears instead of watching the card change colour.
    els.result = document.createElement('div');
    els.result.className = 'auc__result';
    els.result.setAttribute('aria-live', 'polite');
    els.result.setAttribute('aria-atomic', 'true');
    main.appendChild(els.result);

    els.body = document.createElement('div');
    els.body.className = 'auc__body';
    main.appendChild(els.body);

    OrganiserAuctionPage._mount(main);
  },

  /**
   * @param {!Object} state
   * @return {void}
   */
  _renderScope: function (state) {
    const el = state.els.scope;
    if (!el) return;
    el.textContent = '';

    const label = document.createElement('span');
    label.textContent = 'Tournament: ';
    el.appendChild(label);

    const value = document.createElement('strong');
    // A tournament name comes from the sheet. textContent, always.
    value.textContent = state.tournamentName || state.tournamentId;
    el.appendChild(value);

    const phase = document.createElement('span');
    phase.className = 'badge';
    phase.textContent = OrganiserAuctionPage.PHASE_LABEL[state.status] ||
      (state.status ? state.status.replace(/_/g, ' ') : 'Loading');
    el.appendChild(phase);
  },

  /**
   * The body: call box, search, card, sell form, team strip, summary, keys.
   * Built once per tournament; after that only the regions repaint.
   * @param {!Object} state
   * @return {void}
   */
  _renderBody: function (state) {
    const els = state.els;
    const body = els.body;
    body.textContent = '';

    /* ---- 0. the offline pack. FIRST, because it is the thing that has to
       be done BEFORE the auction and it is worthless once the wifi has
       already gone (DESIGN.md §16, CONTRACTS-PHASE4-7 §5.5.1). It collapses
       to one quiet line once the pack is ready. ------------------------ */
    body.appendChild(OrganiserAuctionPage._buildPackBox(state));

    /* ---- 1. the primary control: type a serial number --------------- */
    body.appendChild(OrganiserAuctionPage._buildCallBox(state));

    /* ---- 2. the secondary path: search (DESIGN.md §32) -------------- */
    body.appendChild(OrganiserAuctionPage._buildSearchBox(state));

    /* ---- 3. the player card ----------------------------------------- */
    els.card = document.createElement('section');
    els.card.className = 'auc-card';
    els.card.setAttribute('aria-label', 'Player on the table');
    body.appendChild(els.card);

    /* ---- 4. the sell form ------------------------------------------- */
    els.sell = document.createElement('section');
    els.sell.className = 'auc-sell';
    els.sell.setAttribute('aria-label', 'Record the result');
    body.appendChild(els.sell);

    /* ---- 5. the team strip, permanently on screen ------------------- */
    const teams = document.createElement('section');
    teams.className = 'auc-teams';
    const teamsTitle = document.createElement('h2');
    teamsTitle.className = 'panel__subtitle';
    teamsTitle.textContent = 'Teams';
    teams.appendChild(teamsTitle);
    els.teams = document.createElement('ul');
    els.teams.className = 'auc-teams__list';
    els.teams.setAttribute('aria-label', 'Remaining purse and slots for every team');
    teams.appendChild(els.teams);
    body.appendChild(teams);

    /* ---- 6. the running summary ------------------------------------- */
    const sum = document.createElement('section');
    sum.className = 'auc-sum';
    els.summaryBox = document.createElement('div');
    els.summaryBox.className = 'auc-sum__list';
    sum.appendChild(els.summaryBox);
    body.appendChild(sum);

    /* ---- 7. rejected replays, if any survived a reload -------------- */
    els.rejected = document.createElement('section');
    els.rejected.className = 'auc-rej';
    els.rejected.hidden = true;
    body.appendChild(els.rejected);

    /* ---- 8. the keyboard legend, on the page, not in a modal -------- */
    body.appendChild(OrganiserAuctionPage._buildKeys(state));

    OrganiserAuctionPage._renderCard(state);
    OrganiserAuctionPage._renderTeams(state);
    OrganiserAuctionPage._renderSummaryStrip(state);
    OrganiserAuctionPage._renderPack(state);
  },

  /* ================================================================== *
   * The offline pack — CONTRACTS-PHASE4-7 §5.5.1
   * ================================================================== */

  /**
   * Build the pack panel once. Only the status line, the warnings and the
   * button label change afterwards, so the aria-live status is a node that
   * persists and gets new TEXT — a live region that is inserted at the same
   * moment it gets its text is often never announced.
   *
   * @param {!Object} state
   * @return {HTMLElement}
   */
  _buildPackBox: function (state) {
    const els = state.els;

    const box = document.createElement('section');
    box.className = 'auc-pack';
    box.dataset.state = 'unknown';
    els.pack = box;

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Offline pack';
    box.appendChild(h2);

    els.packStatus = document.createElement('p');
    els.packStatus.className = 'auc-pack__status';
    els.packStatus.setAttribute('aria-live', 'polite');
    els.packStatus.setAttribute('aria-atomic', 'true');
    els.packStatus.textContent = 'Checking what is stored on this laptop…';
    box.appendChild(els.packStatus);

    els.packProgress = document.createElement('div');
    els.packProgress.className = 'auc-pack__progress';
    box.appendChild(els.packProgress);

    // The phase label — "Cached 137 of 400 photographs…". At 400 players this
    // download is minutes long, and a bar with no words looks stuck.
    els.packPhase = document.createElement('p');
    els.packPhase.className = 'auc-pack__phase';
    els.packPhase.setAttribute('aria-live', 'polite');
    // Restored from state, not left blank. This element is recreated on every
    // re-render, and _loadPackStatus re-renders immediately after a download
    // finishes — so writing "Finished." straight to the DOM lost it before the
    // organiser could read it. The text lives in state and the DOM follows.
    els.packPhase.textContent = state.packPhaseText || '';
    box.appendChild(els.packPhase);

    els.packWarnings = document.createElement('div');
    els.packWarnings.className = 'auc-pack__warnings';
    box.appendChild(els.packWarnings);

    const actions = document.createElement('div');
    actions.className = 'auc-pack__actions';
    els.packBtn = UI.button('Download offline pack', function () {
      OrganiserAuctionPage._downloadPack(state);
    }, { variant: 'secondary' });
    els.packBtn.className += ' auc-pack__go';
    actions.appendChild(els.packBtn);
    box.appendChild(actions);

    const note = document.createElement('p');
    note.className = 'auc-pack__note';
    note.textContent = 'Download this before you leave for the venue, while you still ' +
      'have a good connection. It is a safety net, not a plan — the paper list is the ' +
      'real fallback.';
    box.appendChild(note);

    return box;
  },

  /**
   * How this screen classifies a pack. NOT simply `isPackReady().ready`.
   *
   * offline.js will legitimately report ready:true for a pack that was
   * deliberately downloaded with no photographs at all — `imagesOptional` and
   * the localStorage fallback both produce one. For THIS screen that is not
   * ready: a card with no picture is half a card, and an organiser who saw a
   * green tick would find out at the worst possible moment. So a text-only or
   * degraded pack is reported as PARTIAL, with the counts, and never as ready.
   *
   * @param {?Object} info the Offline.isPackReady answer
   * @return {string} 'unknown' | 'none' | 'partial' | 'ready'
   */
  _packState: function (info) {
    if (!info) return 'unknown';
    if (info.exists === false) return 'none';
    if (info.ready !== true) return 'partial';
    if (info.degraded === true) return 'partial';
    if (Number(info.imageCount) <= 0) return 'partial';
    return 'ready';
  },

  /**
   * @param {!Object} state
   * @return {string} the status line, in words and numbers
   */
  _packStatusText: function (state) {
    if (state.packBusy) return 'Downloading the offline pack. Do not close this tab.';

    const info = state.pack;
    const kind = OrganiserAuctionPage._packState(info);

    if (kind === 'unknown') return 'Checking what is stored on this laptop…';

    if (kind === 'none') {
      return 'NO OFFLINE PACK on this laptop. If the venue internet drops, this console ' +
        'can still record SOLD and UNSOLD, but it will not be able to look a player up ' +
        'by number and the projector will have no photographs.';
    }

    const when = OrganiserAuctionPage._whenText(info.downloadedAt);
    const players = OrganiserAuctionPage._num(info.playerCount);
    const images = OrganiserAuctionPage._num(info.imageCount);

    if (kind === 'ready') {
      return 'Offline pack READY — ' + players + ' players and ' + images +
        ' photographs' + (when ? ', downloaded ' + when : '') + '.';
    }

    if (Number(info.imageCount) <= 0 && Number(info.playerCount) > 0) {
      return 'Offline pack holds PLAYER DETAILS ONLY — ' + players +
        ' players and NO photographs' + (when ? ', downloaded ' + when : '') +
        '. Names and serial numbers will work offline; the card and the projector ' +
        'will have no picture. This is NOT a complete pack.';
    }

    return 'Offline pack INCOMPLETE — ' + players + ' of ' +
      OrganiserAuctionPage._num(info.expectedPlayers) + ' players and ' + images +
      ' of ' + OrganiserAuctionPage._num(info.expectedImages) + ' photographs' +
      (when ? ', downloaded ' + when : '') + '. Download it again.';
  },

  /**
   * @param {!Object} state
   * @return {void}
   */
  _renderPack: function (state) {
    const els = state.els;
    if (!els.pack) return;

    const kind = state.packBusy ? 'working' : OrganiserAuctionPage._packState(state.pack);
    els.pack.dataset.state = kind;
    els.packStatus.textContent = OrganiserAuctionPage._packStatusText(state);

    els.packBtn.disabled = !!state.packBusy;
    els.packBtn.textContent = state.packBusy
      ? 'Downloading…'
      : (kind === 'ready' ? 'Download the pack again' : 'Download offline pack');

    els.packProgress.textContent = '';
    if (state.packBusy && state.packProgress) {
      els.packProgress.appendChild(state.packProgress.el);
    } else {
      // Show the last thing that happened, not nothing. This used to blank the
      // line as soon as packBusy went false — which is the instant the download
      // finishes — so "Finished." was erased before anyone could read it. The
      // organiser needs to know the pack completed, and if it did not complete
      // they need to know that even more.
      els.packPhase.textContent = state.packPhaseText || '';
    }

    /* ---- warnings and the last failure --------------------------- */
    els.packWarnings.textContent = '';

    if (state.packError) {
      els.packWarnings.appendChild(UI.banner('error',
        state.packError.code + ' — ' + state.packError.message));
    }

    // Photographs are the part most likely to fail, and the reason is a
    // property of the deployment rather than of anything on this screen
    // (KNOWN-ISSUES.md item 13). Say so before the download, not after.
    if (!state.packBusy && !OrganiserAuctionPage._imageFetcher()) {
      els.packWarnings.appendChild(UI.banner('info',
        'This build cannot read photograph bytes from Drive, so the pack will hold ' +
        'PLAYER DETAILS ONLY. Names, serial numbers, roles and styles will work with ' +
        'no internet; pictures will not. That is a known gap, not a fault on this laptop.'));
    }

    const warnings = (state.pack && state.pack.warnings) || [];
    if (warnings.length) {
      const list = document.createElement('ul');
      list.className = 'auc-pack__warn-list';
      warnings.forEach(function (w) {
        const li = document.createElement('li');
        li.textContent = String(w);
        list.appendChild(li);
      });
      els.packWarnings.appendChild(list);
    }
  },

  /**
   * The image fetcher offline.js needs, IF this build has one.
   *
   * offline.js deliberately ships no default (its "TRANSPORT" block explains
   * why), and api.js has no API.getBytes yet — KNOWN-ISSUES.md item 14. Only
   * api.js may issue requests (CONTRACTS-PHASE1 §4 rule 4, enforced by
   * tools/check.js), so this page cannot read the bytes itself and must not
   * pretend otherwise. If a later build adds API.getBytes this picks it up
   * with no other change; until then the download runs text-only and says so
   * in as many words.
   *
   * @return {?function(string, Object): !Promise<*>}
   */
  _imageFetcher: function () {
    if (typeof API !== 'undefined' && API && typeof API.getBytes === 'function') {
      return function (url, player) { return API.getBytes(url, player); };
    }
    return null;
  },

  /**
   * Cache every eligible player, and their thumbnails where that is possible,
   * onto this laptop.
   * @param {!Object} state
   * @return {void}
   */
  _downloadPack: function (state) {
    if (typeof Offline === 'undefined' || !Offline) return;
    if (state.packBusy) return;

    const imageFn = OrganiserAuctionPage._imageFetcher();
    if (imageFn) Offline.setTransport({ imageFn: imageFn });

    // With no fetcher, ASK for a text-only pack rather than letting
    // downloadPack refuse with NO_IMAGE_FETCHER. The refusal is the right
    // default for a caller that has not thought about it; this one has, and
    // says so on screen both before and after.
    const opts = (imageFn && !state.packTextOnly) ? {} : { imagesOptional: true };

    state.packBusy = true;
    state.packError = null;
    state.packProgress = UI.progress('Offline pack');
    OrganiserAuctionPage._renderPack(state);

    Offline.downloadPack(state.tournamentId, function (info) {
      if (!OrganiserAuctionPage._current(state) || !state.packProgress) return;
      const total = Number(info && info.total) || 0;
      const done = Number(info && info.done) || 0;
      state.packProgress.set(total > 0 ? (done / total) * 100 : 0);
      state.packPhaseText = String((info && info.label) || '');
      state.els.packPhase.textContent = state.packPhaseText;
    }, opts).then(function (res) {
      state.packBusy = false;
      state.packProgress = null;
      if (!OrganiserAuctionPage._current(state)) return;
      state.packPhaseText = (res && res.complete)
        ? 'Finished.'
        : 'Finished, but the pack is not complete.';
      state.els.packPhase.textContent = state.packPhaseText;
      OrganiserAuctionPage._loadPackStatus(state);
    }).catch(function (err) {
      state.packBusy = false;
      state.packProgress = null;
      if (!OrganiserAuctionPage._current(state)) return;

      const code = (err && err.code) ? String(err.code) : 'IDB_ERROR';
      if (code === 'NO_IMAGE_FETCHER') {
        // The next press will ask for a text-only pack, which makes the
        // message below a true statement rather than a hopeful one.
        state.packTextOnly = true;
      }
      state.packError = {
        code: code,
        message: OrganiserAuctionPage.PACK_ERROR[code] ||
          ((err && err.message) ? String(err.message)
            : 'The offline pack could not be downloaded.')
      };
      state.els.packPhase.textContent = '';
      // Reload the status too: downloadPack marks the pack INCOMPLETE before
      // it starts, so a failure halfway leaves an honest answer behind.
      OrganiserAuctionPage._loadPackStatus(state);
    });
  },

  /**
   * @param {*} iso an ISO instant written by offline.js
   * @return {string} 'YYYY-MM-DD HH:MM UTC', or '' when there is nothing
   */
  _whenText: function (iso) {
    const s = String(iso === null || iso === undefined ? '' : iso);
    if (!s) return '';
    // Deliberately not toLocaleString: every other timestamp in this app is
    // formatted by the server, and an inconsistent local format on the one
    // screen that runs the auction is a needless thing to explain.
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
    return m ? m[1] + ' ' + m[2] + ' UTC' : s;
  },

  /**
   * The serial-number box. THE primary control on this screen: big, numeric,
   * and the resting place for focus, because a lottery number is drawn in the
   * room every minute or so and the organiser is not looking at the keyboard.
   *
   * @param {!Object} state
   * @return {HTMLElement}
   */
  _buildCallBox: function (state) {
    const box = document.createElement('form');
    box.className = 'auc-call';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Call a player';
    box.appendChild(h2);

    const row = document.createElement('div');
    row.className = 'auc-call__row';

    const field = UI.field({
      label: 'Serial number drawn',
      name: 'auction-serial',
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      required: true,
      hint: 'Type the number from the lottery and press Enter. This is what puts ' +
        'the player on the projector.'
    });
    state.els.serial = field;
    row.appendChild(field.wrap);

    const go = UI.button('Call player', function () {
      OrganiserAuctionPage._callSerial();
    }, { variant: 'primary' });
    go.className += ' auc-call__go';
    state.els.callGo = go;
    row.appendChild(go);

    box.appendChild(row);

    // A real <form>, so Enter submits the way every browser and every screen
    // reader already expects, rather than through a bespoke keydown handler.
    box.addEventListener('submit', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      OrganiserAuctionPage._callSerial();
    });
    field.input.addEventListener('keydown', function (ev) {
      const key = String((ev && ev.key) || '');
      if (key !== 'Enter') return;
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      OrganiserAuctionPage._callSerial();
    });

    return box;
  },

  /**
   * Search (DESIGN.md §32). The SECOND path, deliberately smaller than the
   * serial box: it is for confirming a name, not for calling a player.
   *
   * auction.search never touches times_called (§4.4), so looking someone up
   * here does not count as bringing them to the table. Calling them from a
   * result row does, because that row calls auction.getBySerial.
   *
   * @param {!Object} state
   * @return {HTMLElement}
   */
  _buildSearchBox: function (state) {
    const box = document.createElement('form');
    box.className = 'auc-find';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Find a player';
    box.appendChild(h2);

    const row = document.createElement('div');
    row.className = 'auc-find__row';

    const field = UI.field({
      label: 'Search by name, serial, role or style',
      name: 'auction-search',
      type: 'text',
      autocomplete: 'off',
      hint: 'Searching only looks someone up. It does not call them to the table ' +
        'and it does not change anything.'
    });
    state.els.search = field;
    row.appendChild(field.wrap);

    row.appendChild(UI.button('Search', function () {
      OrganiserAuctionPage._search();
    }, { variant: 'secondary' }));

    box.appendChild(row);

    state.els.results = document.createElement('div');
    state.els.results.className = 'auc-find__results';
    box.appendChild(state.els.results);

    box.addEventListener('submit', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      OrganiserAuctionPage._search();
    });

    return box;
  },

  /**
   * @param {!Object} state
   * @return {HTMLElement}
   */
  _buildKeys: function (state) {
    const box = document.createElement('section');
    box.className = 'auc-keys';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Keyboard';
    box.appendChild(h2);

    const list = document.createElement('ul');
    list.className = 'auc-keys__list';
    OrganiserAuctionPage.SHORTCUTS.forEach(function (item) {
      const li = document.createElement('li');
      li.className = 'auc-keys__item';
      const kbd = document.createElement('kbd');
      kbd.className = 'auc-keys__key';
      kbd.textContent = item.keys;
      li.appendChild(kbd);
      const what = document.createElement('span');
      what.className = 'auc-keys__what';
      what.textContent = item.what;
      li.appendChild(what);
      list.appendChild(li);
    });
    box.appendChild(list);

    const note = document.createElement('p');
    note.className = 'auc-keys__note';
    note.textContent = 'Shortcuts never fire while you are typing an amount or a search. ' +
      'They do work in the serial box, which only ever holds digits.';
    box.appendChild(note);

    return box;
  },

  /* ================================================================== *
   * The poll — DESIGN.md §7.4, CONTRACTS-PHASE4-7 §4.5
   * Deliberately the same shape as display.js, which polls the same state.
   * ================================================================== */

  /**
   * @param {!Object} state
   * @param {number} delay ms
   * @return {void}
   */
  _schedule: function (state, delay) {
    if (!OrganiserAuctionPage._current(state) || state.stopped || state.paused) return;
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(function () {
      state.timer = null;
      OrganiserAuctionPage._poll(state);
    }, delay);
  },

  /**
   * One request.
   *
   * retryBusy:false is deliberate. API's SYSTEM_BUSY backoff sleeps 2s and then
   * 5s inside a single call; on a 2-second loop that stacks requests on top of
   * each other. This page runs its own, visible back-off instead.
   *
   * @param {!Object} state
   * @return {void}
   */
  _poll: function (state) {
    if (!OrganiserAuctionPage._current(state) || state.stopped) return;
    if (!state.tournamentId) return;
    if (state.inFlight) return;
    state.inFlight = true;

    const payload = { tournamentId: state.tournamentId };
    if (typeof state.v === 'number') payload.v = state.v;

    OrganiserAuctionPage._call('auction.state', payload, { retryBusy: false })
      .then(function (data) {
        state.inFlight = false;
        if (!OrganiserAuctionPage._current(state) || state.stopped) return;
        OrganiserAuctionPage._onPollOk(state, data);
      })
      .catch(function (err) {
        state.inFlight = false;
        if (OrganiserAuctionPage._handled(err)) return;
        if (!OrganiserAuctionPage._current(state) || state.stopped) return;
        OrganiserAuctionPage._onPollFail(state, err);
      });
  },

  /**
   * @param {!Object} state
   * @param {*} data {v, same:true} or {v, ...snapshot}
   * @return {void}
   */
  _onPollOk: function (state, data) {
    // Recovery resets BOTH the interval and the indicator. Anything less and
    // the console would stay at 15-second polls for the rest of the auction
    // after one blip.
    state.fails = 0;
    state.delay = OrganiserAuctionPage.pollMs();
    state.lastOkAt = Date.now();
    OrganiserAuctionPage._setLink(state, 'live', 'Live');

    // Tell the offline module the network is up. It resets the consecutive
    // failure counter and, if we were offline, brings us back.
    if (typeof Offline !== 'undefined' && Offline) Offline.noteSuccess();

    const snap = (data && typeof data === 'object') ? data : {};
    const version = (typeof snap.v === 'number') ? snap.v : state.v;

    // THE WHOLE POINT OF THE VERSION HANDSHAKE. Nothing changed, so nothing is
    // repainted — repainting here would clear the amount box the organiser is
    // halfway through typing, twice a second, for three hours.
    if (snap.same === true) {
      state.v = version;
      OrganiserAuctionPage._schedule(state, state.delay);
      return;
    }

    OrganiserAuctionPage._applySnapshot(state, snap);
    OrganiserAuctionPage._schedule(state, state.delay);
  },

  /**
   * A failed poll. Back off 2s -> 4s -> 8s -> 15s and SAY SO on screen.
   *
   * A frozen-but-plausible console is worse than a visible warning: the
   * organiser cannot otherwise tell that the purse in front of them is a
   * minute old, and a minute is two sales.
   *
   * @param {!Object} state
   * @param {*} err {code, message}
   * @return {void}
   */
  _onPollFail: function (state, err) {
    const code = (err && err.code) ? String(err.code) : '';

    if (Object.prototype.hasOwnProperty.call(OrganiserAuctionPage.FATAL_MESSAGE, code)) {
      state.stopped = true;
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
      OrganiserAuctionPage._setLink(state, 'stopped', 'Not connected');
      OrganiserAuctionPage._showError(OrganiserAuctionPage.FATAL_MESSAGE[code]);
      return;
    }

    state.fails += 1;
    state.delay = Math.min(state.delay * 2, OrganiserAuctionPage.MAX_POLL_MS);

    OrganiserAuctionPage._setLink(state, 'reconnecting',
      'Reconnecting' + OrganiserAuctionPage._stalenessSuffix(state));

    // THREE consecutive failures flip the console into offline mode
    // (CONTRACTS-PHASE4-7 §5.5.2). Not one: a single dropped packet must not
    // put an OFFLINE banner on a live auction in front of an audience. This
    // runs AFTER _setLink so the offline state, which is the more serious of
    // the two, is the one left on the indicator.
    if (typeof Offline !== 'undefined' && Offline) Offline.noteFailure(code || 'poll failed');

    OrganiserAuctionPage._schedule(state, state.delay);
  },

  /**
   * " — data is 14s old". Says out loud what the organiser cannot otherwise
   * know: that the purse figures on screen are not current.
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
   * @param {!Object} state
   * @param {string} kind 'live' | 'reconnecting' | 'stopped' | 'offline'
   * @param {string} text
   * @return {void}
   */
  _setLink: function (state, kind, text) {
    const els = state.els;
    if (!els || !els.link) return;
    els.link.dataset.state = kind;
    els.linkMark.textContent = (kind === 'live') ? '●' : '⚠';
    els.linkText.textContent = text;
  },

  /**
   * Apply one changed snapshot (§4.5 / DESIGN.md §7.3).
   * @param {!Object} state
   * @param {!Object} snap
   * @return {void}
   */
  _applySnapshot: function (state, snap) {
    OrganiserAuctionPage._paints += 1;

    if (typeof snap.v === 'number') state.v = snap.v;
    state.status = String(snap.status || '');
    state.teams = Array.isArray(snap.teams) ? snap.teams : [];
    state.summary = (snap.summary && typeof snap.summary === 'object') ? snap.summary : null;

    // The card on the table may have been sold by another organiser, or
    // corrected by an admin. The snapshot is the authority, not our copy.
    if (state.card && snap.current && String(snap.current.player_id || '') ===
        String(state.card.player_id || '')) {
      state.card.auction_status = String(snap.current.auction_status ||
        state.card.auction_status);
      state.card.team_name = String(snap.current.team_name || '');
      state.card.sold_amount_display = String(snap.current.sold_amount_display || '');
    }

    OrganiserAuctionPage._renderScope(state);
    OrganiserAuctionPage._renderBanners(state);
    OrganiserAuctionPage._renderTeams(state);
    OrganiserAuctionPage._renderSummaryStrip(state);
    OrganiserAuctionPage._renderCard(state);
  },

  /* ================================================================== *
   * Listeners
   * ================================================================== */

  /**
   * @param {!Object} state
   * @return {void}
   */
  _attachListeners: function (state) {
    state.onKeydown = function (ev) {
      OrganiserAuctionPage._onKeyDown(state, ev);
    };
    document.addEventListener('keydown', state.onKeydown);

    /**
     * A console tab that someone minimised must not still be polling an hour
     * later. Park the loop while hidden; catch up the instant it is shown,
     * because whatever is on screen is by definition at least as stale as the
     * time the tab spent hidden.
     * @return {void}
     */
    state.onVisibility = function () {
      if (!OrganiserAuctionPage._current(state)) return;

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
      OrganiserAuctionPage._poll(state);
    };
    document.addEventListener('visibilitychange', state.onVisibility);
  },

  /**
   * The keyboard path. The organiser is standing, watching the room.
   *
   * IT MUST NOT FIRE WHILE SOMEBODY IS TYPING AN AMOUNT. "S" landing in the
   * middle of typing 175000 would open a sale confirm nobody asked for. The
   * serial box is the one deliberate exception: it is the resting place for
   * focus on this screen and it only ever holds digits, so a letter typed
   * there is a shortcut and never text.
   *
   * @param {!Object} state
   * @param {KeyboardEvent} ev
   * @return {void}
   */
  _onKeyDown: function (state, ev) {
    if (!ev || ev.defaultPrevented) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (!OrganiserAuctionPage._current(state)) return;
    if (!document.body || document.body.dataset.route !== OrganiserAuctionPage.ROUTE_KEY) return;

    const key = String(ev.key || '');

    // Escape closes the large photo from anywhere, even from inside a box.
    if (key === 'Escape' || key === 'Esc') {
      if (state.zoom) {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        OrganiserAuctionPage._closeZoom(state);
      }
      return;
    }

    if (state.zoom || state.dialogOpen) return;      // a modal owns the keyboard
    if (OrganiserAuctionPage._isTyping(state, ev.target)) return;

    // A digit pressed anywhere goes to the serial box and stays there. The
    // number is called out in the room and typed without looking down.
    if (/^[0-9]$/.test(key) && state.els.serial) {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const input = state.els.serial.input;
      if (document.activeElement !== input && typeof input.focus === 'function') input.focus();
      input.value = String(input.value || '') + key;
      return;
    }

    const lower = key.toLowerCase();

    if (lower === 'n') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      OrganiserAuctionPage._focusSerial(state, true);
      return;
    }
    if (lower === '/') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (state.els.search && typeof state.els.search.input.focus === 'function') {
        state.els.search.input.focus();
      }
      return;
    }
    if (lower === 'a') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (state.els.sellAmount && typeof state.els.sellAmount.input.focus === 'function') {
        state.els.sellAmount.input.focus();
      }
      return;
    }
    if (lower === 'p') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      OrganiserAuctionPage._openZoom(state);
      return;
    }
    if (lower === 's') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      OrganiserAuctionPage._sellPressed();
      return;
    }
    if (lower === 'u') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      OrganiserAuctionPage._unsoldPressed();
    }
  },

  /**
   * @param {!Object} state
   * @param {*} target the event target
   * @return {boolean} true when a keystroke belongs to a form control
   */
  _isTyping: function (state, target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = String(target.tagName || '').toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'OPTION') {
      return false;
    }
    // The one exception, argued for in _onKeyDown.
    if (state.els.serial && target === state.els.serial.input) return false;
    return true;
  },

  /**
   * @param {!Object} state
   * @param {boolean} [clear] empty the box first
   * @return {void}
   */
  _focusSerial: function (state, clear) {
    const field = state.els.serial;
    if (!field) return;
    if (clear) field.input.value = '';
    field.clearError();
    if (typeof field.input.focus === 'function') field.input.focus();
  },

  /* ================================================================== *
   * Banners — DESIGN.md §15 cases 20, 21, 23
   * ================================================================== */

  /**
   * @param {!Object} state
   * @return {void}
   */
  _renderBanners: function (state) {
    const box = state.els.banners;
    if (!box) return;
    box.textContent = '';

    const status = state.status;

    if (status === 'AUCTION_CLOSED') {
      box.appendChild(UI.banner('info',
        'This auction is closed. Nothing more can be recorded from here. ' +
        'Only an admin can reopen it, and reopening is written to the audit log.'));
    } else if (status && status !== 'AUCTION_LIVE') {
      box.appendChild(UI.banner('error',
        'The auction is not live yet — the tournament status is ' +
        (OrganiserAuctionPage.PHASE_LABEL[status] || status) + '. ' +
        'An admin has to start the auction before any result can be recorded.'));
    }

    if (status === 'AUCTION_LIVE' && !state.teams.length) {
      box.appendChild(UI.banner('error',
        'No teams have been created for this tournament, so there is nobody to ' +
        'sell a player to. Create the teams on the Teams and purses screen first.'));
    }

    // §4.6 / DESIGN.md §6.9. ADVISORY. The admin still clicks close.
    const s = state.summary;
    if (s && s.all_teams_full === true) {
      box.appendChild(UI.banner('info',
        'All ' + OrganiserAuctionPage._num(s.teams_total) + ' teams are full. ' +
        OrganiserAuctionPage._num(s.not_called) + ' players were not called. ' +
        'You can close the auction. Advisory only — an admin closes it, not this screen.'));
    }

    // The offline pack, checked BEFORE the internet fails rather than during
    // it (DESIGN.md §16, KNOWN-ISSUES.md 13). Finding out mid-outage that
    // there is no pack is the failure this line exists to prevent. ADVISORY:
    // it never stops the organiser doing anything.
    const advice = OrganiserAuctionPage._packAdvice(state);
    if (advice) box.appendChild(UI.banner('info', advice));
  },

  /**
   * The one-sentence version of the pack status, for the banner strip. The
   * detail lives in the pack panel; this is the bit that has to be visible
   * from the top of the screen.
   *
   * @param {!Object} state
   * @return {string} '' when there is nothing worth saying
   */
  _packAdvice: function (state) {
    if (state.packBusy) return '';
    const kind = OrganiserAuctionPage._packState(state.pack);
    if (kind === 'ready' || kind === 'unknown') return '';

    const live = state.status === 'AUCTION_LIVE';
    const head = live
      ? 'THE AUCTION IS LIVE AND THERE IS NO COMPLETE OFFLINE PACK ON THIS LAPTOP. '
      : '';
    const what = (kind === 'none')
      ? 'Nothing is cached, so if the connection drops this console cannot look a ' +
        'player up by number.'
      : 'The pack on this laptop is incomplete, so some players or photographs will ' +
        'be missing if the connection drops.';

    return head + what + ' Use Download offline pack at the top of this screen, and ' +
      'keep a paper list either way. This is advice, not a block — you can carry on.';
  },

  /**
   * Ask the offline module whether there is a usable pack.
   * @param {!Object} state
   * @return {void}
   */
  _loadPackStatus: function (state) {
    if (typeof Offline === 'undefined' || !Offline) return;
    Offline.isPackReady(state.tournamentId).then(function (info) {
      if (!OrganiserAuctionPage._current(state)) return;
      state.pack = info || null;
      OrganiserAuctionPage._renderPack(state);
      OrganiserAuctionPage._renderBanners(state);
    }).catch(function () {
      /* isPackReady already degrades to "not ready" with a reason */
    });
  },

  /**
   * @param {string|{message:string}} err
   * @return {void}
   */
  _showError: function (err) {
    const state = OrganiserAuctionPage._state;
    const region = state && state.els.errors;
    if (!region) return;
    const message = (typeof err === 'string')
      ? err
      : ((err && err.message) ? String(err.message)
        : 'Something went wrong. Nothing was recorded. Please try again.');
    region.textContent = '';
    region.appendChild(UI.banner('error', message));
  },

  /** @return {void} */
  _clearError: function () {
    const state = OrganiserAuctionPage._state;
    if (state && state.els.errors) state.els.errors.textContent = '';
  },

  /**
   * @param {string} kind 'success' | 'info' | 'error'
   * @param {string} message
   * @return {void}
   */
  _showResult: function (kind, message) {
    const state = OrganiserAuctionPage._state;
    const region = state && state.els.result;
    if (!region) return;
    region.textContent = '';
    region.appendChild(UI.banner(kind, message));
  },

  /* ================================================================== *
   * Calling a player — auction.getBySerial (§4.2, §4.4)
   * ================================================================== */

  /**
   * The primary action. Reads the serial box and brings that player to the
   * table, which increments times_called and puts them on the projector.
   * @return {void}
   */
  _callSerial: function () {
    const state = OrganiserAuctionPage._state;
    if (!state || !state.tournamentId) return;

    const field = state.els.serial;
    const raw = String(field.input.value || '').trim();
    if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
      field.setError('Type the serial number from the player card — digits only.');
      if (typeof field.input.focus === 'function') field.input.focus();
      return;
    }
    field.clearError();
    OrganiserAuctionPage._clearError();

    const serial = Number(raw);

    // With no network the pack is the only source. It carries names and
    // serials, never eligibility decisions, so the card is marked as coming
    // from the pack and the organiser is told to check the paper sheet.
    if (OrganiserAuctionPage._isOffline()) {
      OrganiserAuctionPage._offlineLookup(state, serial);
      return;
    }

    state.busy = true;
    state.els.card.textContent = '';
    state.els.card.appendChild(UI.spinner('Calling player #' + serial + '…'));

    OrganiserAuctionPage._call('auction.getBySerial', {
      tournamentId: state.tournamentId,
      serialNo: serial
    }).then(function (res) {
      state.busy = false;
      if (!OrganiserAuctionPage._current(state)) return;

      const data = res || {};
      state.card = data.player || null;
      state.card_offline = false;
      state.card_message = String(data.message || '');
      state.card_revealed = data.revealed === true;
      if (typeof data.v === 'number') state.v = data.v;

      state.sell = { teamId: '', amount: '', ack: false };
      state.sellKey = '';
      state.warnKey = '';
      state.els.results.textContent = '';
      state.searchRows = [];

      OrganiserAuctionPage._renderCard(state);
      OrganiserAuctionPage._focusAmountOrSerial(state);
    }).catch(function (err) {
      state.busy = false;
      if (OrganiserAuctionPage._handled(err) || !OrganiserAuctionPage._current(state)) return;
      state.card = null;
      OrganiserAuctionPage._renderCard(state);
      // NOT_FOUND is the everyday case — a number read out wrong, or a serial
      // from a different tournament. The server's own words name the number
      // (DESIGN.md §15 case 18), so they are printed unedited.
      OrganiserAuctionPage._showError(err);
      OrganiserAuctionPage._focusSerial(state, true);
    });
  },

  /**
   * @param {!Object} state
   * @param {number} serial
   * @return {void}
   */
  _offlineLookup: function (state, serial) {
    if (typeof Offline === 'undefined' || !Offline) return;

    state.els.card.textContent = '';
    state.els.card.appendChild(UI.spinner('Looking player #' + serial + ' up in the offline pack…'));

    Offline.getPlayer(state.tournamentId, serial).then(function (row) {
      if (!OrganiserAuctionPage._current(state)) return;
      if (!row) {
        state.card = null;
        OrganiserAuctionPage._renderCard(state);
        OrganiserAuctionPage._showError('No player with serial ' + serial +
          ' is in the offline pack. The pack only holds players who were verified ' +
          'when it was downloaded. Use the paper list.');
        return;
      }
      state.card = {
        player_id: String(row.player_id || ''),
        serial_no: Number(row.serial_no) || serial,
        name: String(row.name || ''),
        role: String(row.role || ''),
        style: String(row.style || ''),
        age_years: Number(row.age_years) || 0,
        photo_thumb_url: String(row.photo_thumb_url || ''),
        payment_status: 'VERIFIED',
        auction_status: 'PENDING',
        times_called: 0,
        eligible: true,
        team_id: '',
        team_name: '',
        sold_amount: null,
        sold_amount_display: ''
      };
      state.card_offline = true;
      state.card_message = '';
      state.sell = { teamId: '', amount: '', ack: false };
      state.sellKey = '';
      state.warnKey = '';
      OrganiserAuctionPage._renderCard(state);
      OrganiserAuctionPage._focusAmountOrSerial(state);
    }).catch(function (err) {
      if (!OrganiserAuctionPage._current(state)) return;
      state.card = null;
      OrganiserAuctionPage._renderCard(state);
      OrganiserAuctionPage._showError(err);
    });
  },

  /**
   * @param {!Object} state
   * @return {void}
   */
  _focusAmountOrSerial: function (state) {
    const card = state.card;
    if (card && card.eligible !== false &&
        String(card.auction_status || 'PENDING').toUpperCase() === 'PENDING' &&
        state.els.sellAmount && typeof state.els.sellAmount.input.focus === 'function') {
      state.els.sellAmount.input.focus();
      return;
    }
    OrganiserAuctionPage._focusSerial(state, true);
  },

  /* ================================================================== *
   * Search — auction.search (§4.2, DESIGN.md §32)
   * ================================================================== */

  /** @return {void} */
  _search: function () {
    const state = OrganiserAuctionPage._state;
    if (!state || !state.tournamentId) return;

    const q = String(state.els.search.input.value || '').trim();
    const box = state.els.results;
    box.textContent = '';
    if (!q) return;

    if (OrganiserAuctionPage._isOffline()) {
      OrganiserAuctionPage._offlineSearch(state, q);
      return;
    }

    box.appendChild(UI.spinner('Searching…'));

    OrganiserAuctionPage._call('auction.search', {
      tournamentId: state.tournamentId,
      q: q,
      limit: OrganiserAuctionPage.SEARCH_LIMIT
    }).then(function (res) {
      if (!OrganiserAuctionPage._current(state)) return;
      const data = res || {};
      state.searchRows = Array.isArray(data.rows) ? data.rows : [];
      OrganiserAuctionPage._renderResults(state, Number(data.total) || state.searchRows.length);
    }).catch(function (err) {
      if (OrganiserAuctionPage._handled(err) || !OrganiserAuctionPage._current(state)) return;
      box.textContent = '';
      box.appendChild(UI.banner('error',
        (err && err.message) ? String(err.message) : 'The search failed.'));
    });
  },

  /**
   * @param {!Object} state
   * @param {string} q
   * @return {void}
   */
  _offlineSearch: function (state, q) {
    if (typeof Offline === 'undefined' || !Offline) return;
    const needle = q.toLowerCase();

    Offline.getPlayers(state.tournamentId).then(function (rows) {
      if (!OrganiserAuctionPage._current(state)) return;
      state.searchRows = (rows || []).filter(function (r) {
        const blob = (String(r.name || '') + ' ' + String(r.role || '') + ' ' +
          String(r.style || '')).toLowerCase();
        return blob.indexOf(needle) !== -1 || String(r.serial_no) === needle;
      }).slice(0, OrganiserAuctionPage.SEARCH_LIMIT);
      OrganiserAuctionPage._renderResults(state, state.searchRows.length);
    }).catch(function () {
      if (!OrganiserAuctionPage._current(state)) return;
      state.els.results.textContent = '';
      state.els.results.appendChild(UI.banner('error',
        'The offline pack could not be read, so there is nothing to search.'));
    });
  },

  /**
   * @param {!Object} state
   * @param {number} total
   * @return {void}
   */
  _renderResults: function (state, total) {
    const box = state.els.results;
    box.textContent = '';

    if (!state.searchRows.length) {
      const none = document.createElement('p');
      none.className = 'panel__note';
      none.textContent = 'Nobody matches that. Check the spelling, or type the serial ' +
        'number in the box above.';
      box.appendChild(none);
      return;
    }

    const count = document.createElement('p');
    count.className = 'panel__note';
    count.textContent = OrganiserAuctionPage._num(total) + ' matched. ' +
      'Choosing one calls them to the table.';
    box.appendChild(count);

    const list = document.createElement('ul');
    state.searchRows.forEach(function (row) {
      const li = document.createElement('li');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'auc-find__row-btn';

      const serial = document.createElement('span');
      serial.className = 'auc-find__serial';
      serial.textContent = '#' + String(row.serial_no);
      btn.appendChild(serial);

      // A player name comes from a public registration form. textContent.
      const name = document.createElement('span');
      name.className = 'auc-find__name';
      name.textContent = String(row.name || '(name missing)');
      btn.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'auc-find__meta';
      meta.textContent = OrganiserAuctionPage._roleText(row.role) +
        (row.style ? ' · ' + OrganiserAuctionPage._styleText(row.style) : '') +
        (row.auction_status ? ' · ' + OrganiserAuctionPage._statusWord(row.auction_status) : '') +
        (row.eligible === false ? ' · not verified' : '');
      btn.appendChild(meta);

      btn.addEventListener('click', function () {
        state.els.serial.input.value = String(row.serial_no);
        OrganiserAuctionPage._callSerial();
      });

      li.appendChild(btn);
      list.appendChild(li);
    });
    box.appendChild(list);
  },

  /* ================================================================== *
   * The player card
   * ================================================================== */

  /**
   * @param {!Object} state
   * @return {void}
   */
  _renderCard: function (state) {
    const box = state.els.card;
    if (!box) return;
    if (state.busy) return;                  // a spinner is already in there

    box.textContent = '';
    const card = state.card;

    if (!card) {
      const idle = document.createElement('p');
      idle.className = 'empty';
      idle.textContent = 'Nobody is on the table. Type the serial number that was ' +
        'drawn and press Enter.';
      box.appendChild(idle);
      OrganiserAuctionPage._renderSell(state);
      return;
    }

    /* ---- photo -------------------------------------------------- */
    const photo = document.createElement('div');
    photo.className = 'auc-card__photo';
    const src = OrganiserAuctionPage._safeImageUrl(card.photo_thumb_url);
    if (src) {
      const img = document.createElement('img');
      img.setAttribute('src', src);
      // The name beside it is the accessible text; the photo adds nothing a
      // screen reader needs, so it stays decorative.
      img.setAttribute('alt', '');
      photo.appendChild(img);
    } else {
      const none = document.createElement('div');
      none.className = 'auc-card__photo-empty';
      none.textContent = '#' + String(card.serial_no);
      photo.appendChild(none);
    }
    box.appendChild(photo);

    /* ---- details ------------------------------------------------ */
    const bodyEl = document.createElement('div');
    bodyEl.className = 'auc-card__body';

    const serial = document.createElement('p');
    serial.className = 'auc-card__serial';
    serial.textContent = '#' + String(card.serial_no);
    bodyEl.appendChild(serial);

    const name = document.createElement('h2');
    name.className = 'auc-card__name';
    name.setAttribute('tabindex', '-1');
    name.textContent = String(card.name || 'Unnamed player');
    bodyEl.appendChild(name);
    state.els.cardName = name;

    const meta = document.createElement('p');
    meta.className = 'auc-card__meta';
    meta.textContent = [
      OrganiserAuctionPage._roleText(card.role),
      OrganiserAuctionPage._styleText(card.style),
      OrganiserAuctionPage._ageText(card.age_years)
    ].filter(Boolean).join(' · ');
    bodyEl.appendChild(meta);

    const pills = document.createElement('p');
    pills.className = 'auc-card__pills';
    pills.appendChild(OrganiserAuctionPage._statusPill(card.auction_status));
    if (card.auction_status === 'SOLD' && card.team_name) {
      const sold = document.createElement('span');
      sold.className = 'badge';
      sold.textContent = card.team_name +
        (card.sold_amount_display ? ' · ' + card.sold_amount_display : '');
      pills.appendChild(sold);
    }
    bodyEl.appendChild(pills);

    // times_called is what separates "came up and nobody bid" from "never came
    // up" in the reports (DESIGN.md §6.9), so it is worth showing here.
    const called = document.createElement('p');
    called.className = 'auc-card__called';
    const times = Number(card.times_called) || 0;
    called.textContent = times <= 1
      ? 'First time at the table.'
      : 'Called ' + times + ' times.';
    bodyEl.appendChild(called);

    /* ---- ineligible: say why, and show the payment status ------- */
    // DESIGN.md §15 case 19. The organiser can go and fix a payment, but only
    // if the screen tells them which one and what state it is in.
    if (card.eligible === false) {
      bodyEl.appendChild(UI.banner('error', state.card_message ||
        ('Player #' + card.serial_no + ' ' + String(card.name || '') +
          ' is not verified for the auction. Payment status is ' +
          (String(card.payment_status || 'PENDING')) +
          (card.is_withdrawn === true ? ' and they have withdrawn.' : '.'))));

      const note = document.createElement('p');
      note.className = 'panel__note';
      note.textContent = 'They were not put on the projector and their call count was ' +
        'not changed. An admin has to verify the payment before they can be sold.';
      bodyEl.appendChild(note);
    } else if (state.card_offline) {
      bodyEl.appendChild(UI.banner('info',
        'This card came from the offline pack, which was downloaded before the ' +
        'auction. It cannot know about a payment or a sale recorded since. Check ' +
        'the paper sheet before you record anything.'));
    }

    /* ---- actions ------------------------------------------------ */
    const actions = document.createElement('div');
    actions.className = 'auc-card__actions';

    if (src) {
      actions.appendChild(UI.button('View large photo', function () {
        OrganiserAuctionPage._openZoom(state);
      }, { variant: 'secondary' }));
    }

    if (card.auction_status === 'UNSOLD' && OrganiserAuctionPage._canWrite(state)) {
      // DESIGN.md §6.6. Section 23 of the requirement says an unsold player
      // "might get sold after sometime", and this is the only control that
      // makes that possible.
      actions.appendChild(UI.button('Return to the pool', function () {
        OrganiserAuctionPage._returnToPool();
      }, { variant: 'secondary' }));
    }

    if (card.auction_status === 'SOLD' && OrganiserAuctionPage._canWrite(state)) {
      actions.appendChild(UI.button('Correct this result', function () {
        state.correcting = !state.correcting;
        OrganiserAuctionPage._renderSell(state);
      }, { variant: 'secondary' }));
    }

    actions.appendChild(UI.button('Clear the table', function () {
      state.card = null;
      state.correcting = false;
      OrganiserAuctionPage._renderCard(state);
      OrganiserAuctionPage._focusSerial(state, true);
    }, { variant: 'secondary' }));

    bodyEl.appendChild(actions);
    box.appendChild(bodyEl);

    OrganiserAuctionPage._renderSell(state);
  },

  /**
   * A player photo is a public Drive thumbnail URL (DESIGN.md §3), not a
   * data: URI like a payment screenshot. Only http(s) is allowed through, so a
   * hand-edited sheet cell cannot put a javascript: URL into an <img>.
   * @param {*} value
   * @return {string} '' when it is not a URL worth loading
   */
  _safeImageUrl: function (value) {
    const url = String(value === null || value === undefined ? '' : value).trim();
    return /^https?:\/\//i.test(url) ? url : '';
  },

  /**
   * The enlarged photo (requirement §20). DESIGN.md §3 says the big variant is
   * the same Drive URL with sz=w1600, fetched only when it is asked for.
   * @param {string} thumbUrl
   * @return {string}
   */
  _largePhotoUrl: function (thumbUrl) {
    const url = OrganiserAuctionPage._safeImageUrl(thumbUrl);
    if (!url) return '';
    if (/[?&]sz=/.test(url)) return url.replace(/([?&]sz=)[^&]*/, '$1w1600');
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'sz=w1600';
  },

  /**
   * @param {!Object} state
   * @return {void}
   */
  _openZoom: function (state) {
    if (state.zoom) return;
    const card = state.card;
    if (!card) return;
    const src = OrganiserAuctionPage._largePhotoUrl(card.photo_thumb_url);
    if (!src) return;

    const overlay = document.createElement('div');
    overlay.className = 'auc-zoom';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label',
      'Large photo of #' + String(card.serial_no) + ' ' + String(card.name || ''));

    const box = document.createElement('div');
    box.className = 'auc-zoom__box';

    const close = UI.button('Close', function () {
      OrganiserAuctionPage._closeZoom(state);
    }, { variant: 'secondary' });
    box.appendChild(close);

    const img = document.createElement('img');
    img.className = 'auc-zoom__img';
    img.setAttribute('src', src);
    img.setAttribute('alt', 'Photograph of ' + String(card.name || 'this player'));
    box.appendChild(img);

    const hint = document.createElement('p');
    hint.className = 'auc-zoom__hint';
    hint.textContent = 'Press Escape to close.';
    box.appendChild(hint);

    overlay.appendChild(box);
    overlay.addEventListener('click', function (ev) {
      if (ev && ev.target === overlay) OrganiserAuctionPage._closeZoom(state);
    });

    document.body.appendChild(overlay);
    state.zoom = { el: overlay };
    if (typeof close.focus === 'function') close.focus();
  },

  /**
   * @param {!Object} state
   * @return {void}
   */
  _closeZoom: function (state) {
    if (!state || !state.zoom) return;
    const zoom = state.zoom;
    state.zoom = null;
    if (zoom.el && zoom.el.parentNode) zoom.el.parentNode.removeChild(zoom.el);
    if (state.els.cardName && typeof state.els.cardName.focus === 'function') {
      try { state.els.cardName.focus(); } catch (e) { /* gone from the DOM */ }
    }
  },

  /* ================================================================== *
   * The sell form — the money
   * ================================================================== */

  /**
   * @param {!Object} state
   * @return {boolean} true when a write would be accepted right now
   */
  _canWrite: function (state) {
    const s = state || OrganiserAuctionPage._state;
    if (!s) return false;
    // Offline, we cannot know the status, but the queue is exactly the point.
    if (OrganiserAuctionPage._isOffline()) return true;
    return s.status === 'AUCTION_LIVE';
  },

  /**
   * Build the sell controls for the card on the table.
   * @param {!Object} state
   * @return {void}
   */
  _renderSell: function (state) {
    const box = state.els.sell;
    if (!box) return;

    const card = state.card;
    const key = card
      ? [String(card.player_id), String(card.auction_status), String(state.teams.length),
        state.correcting ? 'c' : ''].join('|')
      : '';

    // Only rebuild when the situation actually changed. Rebuilding on every
    // poll would empty the amount box the organiser is typing into.
    if (key === state.sellKey) {
      OrganiserAuctionPage._syncSell(state);
      return;
    }
    state.sellKey = key;
    state.warnKey = '';
    box.textContent = '';
    state.els.sellTeam = null;
    state.els.sellAmount = null;
    state.els.sellPreview = null;
    state.els.sellWarn = null;
    state.els.sellAck = null;
    state.els.sellGo = null;

    if (!card) return;

    if (!OrganiserAuctionPage._canWrite(state)) {
      const note = document.createElement('p');
      note.className = 'panel__note';
      note.textContent = state.status === 'AUCTION_CLOSED'
        ? 'The auction is closed, so no result can be recorded.'
        : 'The auction is not live, so no result can be recorded.';
      box.appendChild(note);
      return;
    }

    if (card.eligible === false) return;      // the card already explains why

    if (String(card.auction_status || 'PENDING').toUpperCase() !== 'PENDING') {
      if (state.correcting) box.appendChild(OrganiserAuctionPage._buildCorrect(state));
      return;
    }

    if (!state.teams.length) return;          // the banner already explains why

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Record the result';
    box.appendChild(h2);

    const grid = document.createElement('div');
    grid.className = 'auc-sell__grid';

    const team = UI.field({
      label: 'Winning team',
      name: 'auction-team',
      type: 'select',
      required: true,
      placeholderOption: '— Choose the team —',
      options: OrganiserAuctionPage._teamOptions(state),
      hint: 'Remaining purse and slots are shown beside each name.'
    });
    team.input.value = state.sell.teamId || '';
    team.input.addEventListener('change', function () {
      OrganiserAuctionPage._syncSell(state);
    });
    state.els.sellTeam = team;
    grid.appendChild(team.wrap);

    const amount = UI.field({
      label: 'Winning amount in rupees',
      name: 'auction-amount',
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      required: true,
      hint: 'Whole rupees, digits only. There is no minimum and no increment — ' +
        'type whatever the room settled on.'
    });
    amount.input.value = state.sell.amount || '';
    amount.input.addEventListener('input', function () {
      OrganiserAuctionPage._syncSell(state);
    });
    amount.input.addEventListener('change', function () {
      OrganiserAuctionPage._syncSell(state);
    });
    state.els.sellAmount = amount;
    grid.appendChild(amount.wrap);

    box.appendChild(grid);

    // The consequence line (DESIGN.md §6.5a). Live, before the confirm, so the
    // organiser sees the arithmetic while they are still typing.
    const preview = document.createElement('p');
    preview.className = 'auc-sell__preview';
    preview.setAttribute('aria-live', 'polite');
    state.els.sellPreview = preview;
    box.appendChild(preview);

    const warn = document.createElement('div');
    warn.className = 'auc-sell__warnings';
    state.els.sellWarn = warn;
    box.appendChild(warn);

    const buttons = document.createElement('div');
    buttons.className = 'auc-sell__buttons';

    const go = UI.button('SOLD — record the sale', function () {
      OrganiserAuctionPage._sellPressed();
    }, { variant: 'primary' });
    go.className += ' auc-sell__go';
    state.els.sellGo = go;
    buttons.appendChild(go);

    const unsold = UI.button('MARK UNSOLD', function () {
      OrganiserAuctionPage._unsoldPressed();
    }, { variant: 'secondary' });
    unsold.className += ' auc-sell__unsold';
    buttons.appendChild(unsold);

    box.appendChild(buttons);

    OrganiserAuctionPage._syncSell(state);
  },

  /**
   * @param {!Object} state
   * @return {!Array<{value:string, label:string}>}
   */
  _teamOptions: function (state) {
    return state.teams.map(function (t) {
      const slots = (Number(t.max_players) || 0) - (Number(t.players_count) || 0);
      return {
        value: String(t.team_id),
        label: String(t.team_name) + ' — ' +
          OrganiserAuctionPage._money(t.purse_remaining, t.purse_remaining_display) +
          ' left, ' + OrganiserAuctionPage._num(t.players_count) + ' of ' +
          OrganiserAuctionPage._num(t.max_players) +
          (slots > 0 ? '' : ' (full)')
      };
    });
  },

  /**
   * Recompute the consequence line, the advisory warnings and the button
   * state from whatever is in the two boxes right now.
   * @param {!Object} state
   * @return {void}
   */
  _syncSell: function (state) {
    if (!state.els.sellGo) return;

    const teamId = String(state.els.sellTeam.input.value || '');
    const raw = String(state.els.sellAmount.input.value || '');
    state.sell.teamId = teamId;
    state.sell.amount = raw;

    const team = OrganiserAuctionPage._teamById(state, teamId);
    const amount = OrganiserAuctionPage._toRupees(raw);
    const valid = !!team && isFinite(amount) && amount > 0;

    /* ---- the consequence line ------------------------------------ */
    if (!valid) {
      state.els.sellPreview.textContent = team
        ? 'Type the winning amount to see what it leaves ' + String(team.team_name) + '.'
        : 'Choose the team and type the amount. The line here will show what the ' +
          'sale leaves them.';
    } else {
      const c = OrganiserAuctionPage._consequence(team, amount, state.card);
      state.els.sellPreview.textContent = c.question + ' ' + c.leaves;
    }

    /* ---- the advisory warnings (§4.7) ---------------------------- */
    const warnings = valid ? OrganiserAuctionPage._warningsFor(state, team, amount) : [];
    const signature = warnings.map(function (w) { return w.code; }).join(',') +
      '|' + teamId + '|' + String(amount);

    if (signature !== state.warnKey) {
      state.warnKey = signature;
      // A changed amount invalidates the acknowledgement. Ticking a box for
      // ₹75,000 must never carry over to a ₹7,50,000 typo.
      state.sell.ack = false;
      OrganiserAuctionPage._renderWarnings(state, warnings);
    }

    const needsAck = warnings.length > 0;
    state.els.sellGo.disabled = !valid || (needsAck && !state.sell.ack);
  },

  /**
   * @param {!Object} state
   * @param {!Array<{code:string, message:string}>} warnings
   * @return {void}
   */
  _renderWarnings: function (state, warnings) {
    const box = state.els.sellWarn;
    if (!box) return;
    box.textContent = '';
    state.els.sellAck = null;
    if (!warnings.length) return;

    warnings.forEach(function (w) {
      const b = UI.banner('info', w.message);
      // Amber, not red. This is a question about a number, not a refusal.
      b.className = 'banner banner--warning auc-warn';
      b.dataset.code = w.code;
      box.appendChild(b);
    });

    // A TICK-BOX, NOT A WALL (DESIGN.md §6.5a). A genuinely huge bid for a
    // genuinely great player must always go through.
    const label = document.createElement('label');
    label.className = 'choice auc-sell__ack';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!state.sell.ack;
    cb.addEventListener('change', function () {
      state.sell.ack = !!cb.checked;
      if (state.els.sellGo) {
        const team = OrganiserAuctionPage._teamById(state, state.sell.teamId);
        const amount = OrganiserAuctionPage._toRupees(state.sell.amount);
        const valid = !!team && isFinite(amount) && amount > 0;
        state.els.sellGo.disabled = !valid || !state.sell.ack;
      }
    });
    label.appendChild(cb);
    const text = document.createElement('span');
    text.textContent = 'I have checked this amount against the room and it is right.';
    label.appendChild(text);
    state.els.sellAck = cb;
    box.appendChild(label);
  },

  /**
   * The three advisory warnings of §4.7, computed from live tournament data so
   * they get more accurate as the auction goes on.
   *
   * These MIRROR Auction._warnings in backend/Auction.gs exactly, including the
   * "no history yet triggers nothing" rule: stats.count > 0 there is the same
   * test as highest_sale > 0 here, because every recorded sale is a positive
   * number of rupees. The server's own `warnings` array still comes back on the
   * markSold response and is shown if it disagrees — the copy here exists only
   * so the organiser sees the banner BEFORE committing, which is where
   * DESIGN.md §6.5a says it belongs.
   *
   * NONE OF THESE MAY EVER BLOCK.
   *
   * @param {!Object} state
   * @param {!Object} team a snapshot teams[] row
   * @param {number} amount whole rupees
   * @return {!Array<{code:string, message:string}>}
   */
  _warningsFor: function (state, team, amount) {
    const out = [];
    const s = state.summary || {};
    const name = String(team.team_name || '');
    const purseTotal = Number(team.purse_total) || 0;
    const remaining = Number(team.purse_remaining) || 0;
    const highest = Number(s.highest_sale) || 0;
    const lowest = Number(s.lowest_sale) || 0;

    if (purseTotal > 0 && amount > purseTotal * OrganiserAuctionPage.WARN_PURSE_SHARE) {
      const pct = Math.round((amount / purseTotal) * 100);
      out.push({
        code: 'LARGE_SHARE_OF_PURSE',
        message: OrganiserAuctionPage._money(amount) + ' is ' + pct + '% of ' + name +
          "'s total purse of " + OrganiserAuctionPage._money(purseTotal) +
          '. Check the amount before confirming.'
      });
    }

    if (highest > 0 && amount > highest * OrganiserAuctionPage.WARN_ABOVE_HIGHEST) {
      out.push({
        code: 'FAR_ABOVE_RECENT',
        message: OrganiserAuctionPage._money(amount) + ' is more than ' +
          OrganiserAuctionPage.WARN_ABOVE_HIGHEST +
          ' times the highest sale so far, which is ' +
          OrganiserAuctionPage._money(highest) + '. Check for an extra zero.'
      });
    }

    const slotsAfter = (Number(team.max_players) || 0) - (Number(team.players_count) || 0) - 1;
    const purseAfter = remaining - amount;
    if (lowest > 0 && slotsAfter > 0) {
      // Compared against the cheapest sale that ACTUALLY happened, and worded
      // the same way the server words it (Auction._warnings). No per-slot
      // average is shown: it reads as a price per player, and there isn't one.
      const perSlot = Math.floor(purseAfter / slotsAfter);
      if (perSlot < lowest) {
        out.push({
          code: 'SQUAD_AT_RISK',
          message: 'This leaves ' + name + ' ' + OrganiserAuctionPage._money(purseAfter) +
            ' for ' + slotsAfter + ' more ' + (slotsAfter === 1 ? 'slot' : 'slots') +
            '. The cheapest sale so far was ' + OrganiserAuctionPage._money(lowest) +
            ', so filling ' + (slotsAfter === 1 ? 'it' : 'them') +
            ' at that price would need about ' +
            OrganiserAuctionPage._money(lowest * slotsAfter) + '.'
        });
      }
    }

    return out;
  },

  /**
   * THE SINGLE MOST VALUABLE GUARD ON THIS SCREEN (DESIGN.md §6.5a).
   *
   *   Sell Raj Kumar (#27) to Chennai Warriors for ₹75,000?
   *   Leaves ₹4,75,000 for 3 more slots.
   *
   * No judgement, just the arithmetic. The organiser reads it in a second and
   * catches their own mistake. The per-slot division is Math.floor, the same
   * way Auction._teamSummary does it, so the two can never disagree.
   *
   * @param {!Object} team a snapshot teams[] row
   * @param {number} amount whole rupees
   * @param {!Object} card the player on the table
   * @return {{question:string, leaves:string}}
   */
  _consequence: function (team, amount, card) {
    const remaining = Number(team.purse_remaining) || 0;
    const after = remaining - amount;
    const slotsAfter = (Number(team.max_players) || 0) - (Number(team.players_count) || 0) - 1;

    const question = 'Sell ' + String(card.name || 'this player') + ' (#' +
      String(card.serial_no) + ') to ' + String(team.team_name) + ' for ' +
      OrganiserAuctionPage._money(amount) + '?';

    let leaves;
    if (slotsAfter > 0) {
      // No per-slot average. Every player sells for a different amount, so
      // dividing the purse by empty slots states a price that does not exist.
      // The two true figures — what is left and how many slots — are enough for
      // the organiser to judge it, and the server's SQUAD_AT_RISK advisory
      // quotes the cheapest sale that has actually happened.
      leaves = 'Leaves ' + OrganiserAuctionPage._money(after) + ' for ' + slotsAfter +
        ' more ' + (slotsAfter === 1 ? 'slot' : 'slots') + '.';
    } else if (slotsAfter === 0) {
      leaves = 'That completes the squad and leaves ' +
        OrganiserAuctionPage._money(after) + ' unspent.';
    } else {
      leaves = String(team.team_name) + ' has no slot left, so the server will refuse this.';
    }

    return { question: question, leaves: leaves };
  },

  /* ================================================================== *
   * Writes — every one of them carries expectedVersion
   * ================================================================== */

  /** @return {void} */
  _sellPressed: function () {
    const state = OrganiserAuctionPage._state;
    if (!state || !state.card || state.dialogOpen || state.busy) return;
    if (!state.els.sellGo) return;
    if (state.els.sellGo.disabled) {
      // Not a wall: say what is missing and go there.
      if (!state.sell.teamId && state.els.sellTeam) {
        state.els.sellTeam.setError('Choose the team that won the bidding.');
        if (typeof state.els.sellTeam.input.focus === 'function') {
          state.els.sellTeam.input.focus();
        }
      } else if (!isFinite(OrganiserAuctionPage._toRupees(state.sell.amount))) {
        state.els.sellAmount.setError('Type the winning amount in whole rupees.');
        if (typeof state.els.sellAmount.input.focus === 'function') {
          state.els.sellAmount.input.focus();
        }
      } else if (state.els.sellAck && typeof state.els.sellAck.focus === 'function') {
        state.els.sellAck.focus();
      }
      return;
    }

    const team = OrganiserAuctionPage._teamById(state, state.sell.teamId);
    const amount = OrganiserAuctionPage._toRupees(state.sell.amount);
    if (!team || !isFinite(amount)) return;

    const card = state.card;
    const c = OrganiserAuctionPage._consequence(team, amount, card);
    const warnings = OrganiserAuctionPage._warningsFor(state, team, amount);

    let body = c.leaves;
    if (warnings.length) {
      body += ' ' + warnings.map(function (w) { return w.message; }).join(' ');
    }
    if (OrganiserAuctionPage._isOffline()) {
      body += ' There is no connection, so this is stored on this laptop and sent ' +
        'when the network comes back. Write it on the paper sheet too.';
    }

    state.dialogOpen = true;
    UI.confirmDialog({
      title: c.question,
      body: body,
      confirmLabel: 'Yes, record the sale'
    }).then(function (go) {
      state.dialogOpen = false;
      if (!go || !OrganiserAuctionPage._current(state)) return;
      OrganiserAuctionPage._markSold(state, card, team, amount);
    }, function () {
      state.dialogOpen = false;
    });
  },

  /**
   * @param {!Object} state
   * @param {!Object} card
   * @param {!Object} team
   * @param {number} amount
   * @return {void}
   */
  _markSold: function (state, card, team, amount) {
    OrganiserAuctionPage._write(state, 'auction.markSold', {
      playerId: String(card.player_id),
      teamId: String(team.team_id),
      amount: amount
    }, {
      // Extra context, ignored by the server, kept so a queued item that comes
      // back rejected can be shown to the organiser in words rather than ids.
      offlineContext: {
        serialNo: card.serial_no,
        playerName: String(card.name || ''),
        teamName: String(team.team_name || ''),
        amountDisplay: OrganiserAuctionPage._money(amount)
      },
      offlineMessage: 'Recorded on this laptop: ' + String(card.name || '') + ' (#' +
        String(card.serial_no) + ') to ' + String(team.team_name) + ' for ' +
        OrganiserAuctionPage._money(amount) + '. It is NOT saved on the server yet.',
      onDone: function (res) {
        const t = (res && res.team) || null;
        let message = String(card.name || '') + ' (#' + String(card.serial_no) +
          ') sold to ' + String(team.team_name) + ' for ' +
          OrganiserAuctionPage._money(amount) + '.';
        if (t) {
          message += ' ' + String(t.team_name) + ' now has ' +
            String(t.purse_remaining_display || OrganiserAuctionPage._money(t.purse_remaining)) +
            ' for ' + OrganiserAuctionPage._num(t.slots_remaining) +
            (Number(t.slots_remaining) === 1 ? ' slot' : ' slots') + '.';
        }
        OrganiserAuctionPage._showResult('success', message);
        OrganiserAuctionPage._showServerWarnings(state, res);
      }
    });
  },

  /**
   * markSold returns an AUTHORITATIVE warnings array (§4.7). It is computed
   * inside the lock against the sheet, so it can legitimately differ from the
   * preview this screen showed a second earlier — another organiser may have
   * sold someone in between. When it does differ, say so plainly rather than
   * quietly showing one of the two.
   *
   * @param {!Object} state
   * @param {*} res the markSold / correct response
   * @return {void}
   */
  _showServerWarnings: function (state, res) {
    const box = state.els.result;
    if (!box) return;
    const list = (res && Array.isArray(res.warnings)) ? res.warnings : [];
    if (!list.length) return;

    const previewed = state.warnKey.split('|')[0];
    const got = list.map(function (w) { return String(w.code || ''); }).join(',');

    if (got !== previewed) {
      box.appendChild(UI.banner('info',
        'The server flagged something this screen had not, because the auction ' +
        'moved on between the preview and the sale. The sale WAS recorded — read ' +
        'the note below and correct it if it is wrong.'));
    }
    list.forEach(function (w) {
      const b = UI.banner('info', String(w.message || w.code || ''));
      b.className = 'banner banner--warning auc-warn';
      b.dataset.code = String(w.code || '');
      box.appendChild(b);
    });
  },

  /** @return {void} */
  _unsoldPressed: function () {
    const state = OrganiserAuctionPage._state;
    if (!state || !state.card || state.dialogOpen || state.busy) return;
    const card = state.card;
    if (card.eligible === false) return;
    if (String(card.auction_status || 'PENDING').toUpperCase() !== 'PENDING') return;
    if (!OrganiserAuctionPage._canWrite(state)) return;

    state.dialogOpen = true;
    UI.confirmDialog({
      title: 'Mark ' + String(card.name || '') + ' (#' + String(card.serial_no) +
        ') UNSOLD?',
      body: 'Nobody bid. No money moves and no slot is taken. They can be returned ' +
        'to the pool later and re-auctioned.',
      confirmLabel: 'Yes, mark unsold'
    }).then(function (go) {
      state.dialogOpen = false;
      if (!go || !OrganiserAuctionPage._current(state)) return;

      OrganiserAuctionPage._write(state, 'auction.markUnsold', {
        playerId: String(card.player_id)
      }, {
        offlineContext: {
          serialNo: card.serial_no,
          playerName: String(card.name || '')
        },
        offlineMessage: 'Recorded on this laptop: ' + String(card.name || '') + ' (#' +
          String(card.serial_no) + ') unsold. It is NOT saved on the server yet.',
        onDone: function () {
          OrganiserAuctionPage._showResult('success', String(card.name || '') + ' (#' +
            String(card.serial_no) + ') marked unsold. Use "Return to the pool" if ' +
            'they come back later.');
        }
      });
    }, function () {
      state.dialogOpen = false;
    });
  },

  /** DESIGN.md §6.6 — UNSOLD back to PENDING. @return {void} */
  _returnToPool: function () {
    const state = OrganiserAuctionPage._state;
    if (!state || !state.card || state.dialogOpen) return;
    const card = state.card;

    state.dialogOpen = true;
    UI.confirmDialog({
      title: 'Put ' + String(card.name || '') + ' (#' + String(card.serial_no) +
        ') back in the pool?',
      body: 'They go back to PENDING and can be called again. Their call count is ' +
        'kept, so the report still shows they came to the table once.',
      confirmLabel: 'Yes, return to the pool'
    }).then(function (go) {
      state.dialogOpen = false;
      if (!go || !OrganiserAuctionPage._current(state)) return;
      OrganiserAuctionPage._write(state, 'auction.returnToPool', {
        playerId: String(card.player_id)
      }, {
        // Deliberately NOT queueable offline: it is a tidy-up action, not a
        // result, and queueing it would reorder against the sale it precedes.
        offlineRefuse: 'Returning a player to the pool needs the server. Do it when ' +
          'the connection is back.',
        onDone: function () {
          OrganiserAuctionPage._showResult('success', String(card.name || '') + ' (#' +
            String(card.serial_no) + ') is back in the pool and can be called again.');
        }
      });
    }, function () {
      state.dialogOpen = false;
    });
  },

  /**
   * The correction panel (DESIGN.md §6.7, §4.3). A correction appends; it never
   * deletes. The server re-validates everything against the NEW team and
   * amount, because a correction can overspend a purse just as easily as a
   * fresh sale — and it is more likely to, because it is typed under pressure.
   *
   * @param {!Object} state
   * @return {HTMLElement}
   */
  _buildCorrect: function (state) {
    const card = state.card;

    const box = document.createElement('div');
    box.className = 'auc-correct';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Correct this result';
    box.appendChild(h2);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent = 'Nothing is deleted. The old result stays in the history and a ' +
      'new one supersedes it, with your name and the time on both.';
    box.appendChild(note);

    const grid = document.createElement('div');
    grid.className = 'auc-correct__grid';

    const status = UI.field({
      label: 'What it should say',
      name: 'auction-correct-status',
      type: 'select',
      placeholderOption: '',
      options: [
        { value: 'SOLD', label: 'Sold — to this team, for this amount' },
        { value: 'UNSOLD', label: 'Unsold — undo the sale, nobody bid' },
        { value: 'PENDING', label: 'Back in the pool — undo the sale entirely' }
      ]
    });
    status.input.value = 'SOLD';
    grid.appendChild(status.wrap);

    const team = UI.field({
      label: 'Team',
      name: 'auction-correct-team',
      type: 'select',
      placeholderOption: '— Keep the same team —',
      options: OrganiserAuctionPage._teamOptions(state)
    });
    grid.appendChild(team.wrap);

    const amount = UI.field({
      label: 'Amount in rupees',
      name: 'auction-correct-amount',
      type: 'text',
      inputmode: 'numeric',
      value: card.sold_amount === null || card.sold_amount === undefined
        ? '' : String(card.sold_amount)
    });
    grid.appendChild(amount.wrap);

    box.appendChild(grid);

    box.appendChild(UI.button('Record the correction', function () {
      const wanted = String(status.input.value || 'SOLD');
      const payload = { playerId: String(card.player_id), newStatus: wanted };
      let body;

      if (wanted === 'SOLD') {
        const n = OrganiserAuctionPage._toRupees(amount.input.value);
        if (!isFinite(n)) {
          amount.setError('Type the corrected amount in whole rupees.');
          return;
        }
        payload.amount = n;
        if (team.input.value) payload.teamId = String(team.input.value);
        const t = OrganiserAuctionPage._teamById(state, payload.teamId || card.team_id);
        body = 'The old sale is reversed on ' +
          (card.team_name || 'the old team') + ' and ' +
          OrganiserAuctionPage._money(n) + ' is charged to ' +
          ((t && t.team_name) || 'the chosen team') + ' instead.';
      } else {
        body = wanted === 'PENDING'
          ? 'The sale is reversed, the money goes back to ' +
            (card.team_name || 'the team') + ', and the player returns to the pool.'
          : 'The sale is reversed, the money goes back to ' +
            (card.team_name || 'the team') + ', and the player is recorded as unsold.';
      }

      state.dialogOpen = true;
      UI.confirmDialog({
        title: 'Correct #' + String(card.serial_no) + ' ' + String(card.name || '') + '?',
        body: body,
        confirmLabel: 'Yes, correct it'
      }).then(function (go) {
        state.dialogOpen = false;
        if (!go || !OrganiserAuctionPage._current(state)) return;
        OrganiserAuctionPage._write(state, 'auction.correct', payload, {
          offlineRefuse: 'A correction needs the server, because it has to reverse ' +
            'money on a team. Do it when the connection is back.',
          onDone: function (res) {
            state.correcting = false;
            state.sellKey = '';
            OrganiserAuctionPage._showResult('success',
              'Correction recorded for #' + String(card.serial_no) + ' ' +
              String(card.name || '') + '. The old result is still in the history.');
            OrganiserAuctionPage._showServerWarnings(state, res);
          }
        });
      }, function () {
        state.dialogOpen = false;
      });
    }, { variant: 'danger' }));

    return box;
  },

  /**
   * The one place a state-changing auction action leaves this page.
   *
   * expectedVersion IS ATTACHED HERE, ALWAYS, from the version the poll is
   * holding (§4.1 step 1). It is the third defence against a double sale and
   * the only one that catches a screen that has been sitting untouched for a
   * minute while somebody else sold the same player.
   *
   * @param {!Object} state
   * @param {string} action
   * @param {!Object} payload the action-specific fields
   * @param {{onDone: function(*), offlineContext: (Object|undefined),
   *          offlineMessage: (string|undefined),
   *          offlineRefuse: (string|undefined)}} opts
   * @return {void}
   */
  _write: function (state, action, payload, opts) {
    const options = opts || {};

    if (OrganiserAuctionPage._isOffline()) {
      if (options.offlineRefuse) {
        OrganiserAuctionPage._showError(options.offlineRefuse);
        return;
      }
      OrganiserAuctionPage._enqueue(state, action, payload, options);
      return;
    }

    if (typeof state.v !== 'number') {
      OrganiserAuctionPage._showError('This screen has not loaded the auction state yet, ' +
        'so it cannot record anything safely. Wait for the connection indicator to say ' +
        'Live, then try again.');
      return;
    }

    const body = Object.assign({ tournamentId: state.tournamentId }, payload);
    // Never optional. See the block comment above.
    body.expectedVersion = state.v;

    state.busy = true;
    OrganiserAuctionPage._setBusy(state, true);
    OrganiserAuctionPage._clearError();

    OrganiserAuctionPage._call(action, body).then(function (res) {
      state.busy = false;
      if (!OrganiserAuctionPage._current(state)) return;
      OrganiserAuctionPage._setBusy(state, false);

      const data = res || {};
      if (typeof data.v === 'number') state.v = data.v;
      if (data.player) state.card = data.player;

      state.sell = { teamId: '', amount: '', ack: false };
      state.sellKey = '';
      state.warnKey = '';

      if (typeof options.onDone === 'function') options.onDone(data);

      OrganiserAuctionPage._renderCard(state);
      // Pull the fresh purse figures straight away rather than waiting up to
      // two seconds; the next number is usually already being drawn.
      OrganiserAuctionPage._refreshNow(state);
      OrganiserAuctionPage._focusSerial(state, true);
    }).catch(function (err) {
      state.busy = false;
      if (OrganiserAuctionPage._handled(err)) return;
      if (!OrganiserAuctionPage._current(state)) return;
      OrganiserAuctionPage._setBusy(state, false);

      const code = (err && err.code) ? String(err.code) : '';

      if (code === 'STALE_STATE') {
        // DO NOT SILENTLY RETRY. The purse, the squad size or the player's
        // status changed after this screen last polled, so the figures the
        // organiser read before they decided were wrong. Say that in plain
        // words, refresh, and let them look again.
        OrganiserAuctionPage._showError('Nothing was recorded. This screen was out of ' +
          'date — the auction moved on since it last updated, so the figures you were ' +
          'looking at were wrong. It has just been refreshed: check the purse and the ' +
          'player, then record it again.');
        OrganiserAuctionPage._refreshNow(state);
        return;
      }

      if (code === 'NETWORK') {
        if (typeof Offline !== 'undefined' && Offline) Offline.noteFailure(code);
        OrganiserAuctionPage._showError('The server could not be reached, so nothing was ' +
          'recorded. If this keeps happening the console will switch to offline mode and ' +
          'keep your results on this laptop.');
        return;
      }

      // TEAM_FULL, INSUFFICIENT_PURSE, PLAYER_NOT_PENDING, ALREADY_ASSIGNED,
      // AUCTION_CLOSED, INVALID_AMOUNT: the server's messages name the number
      // or the team that blocks it, which is exactly what the organiser needs.
      // They are printed unedited.
      OrganiserAuctionPage._showError(err);
      OrganiserAuctionPage._refreshNow(state);
    });
  },

  /**
   * @param {!Object} state
   * @param {boolean} busy
   * @return {void}
   */
  _setBusy: function (state, busy) {
    if (state.els.sellGo) state.els.sellGo.disabled = !!busy;
  },

  /**
   * Throw away the back-off and poll right now.
   * @param {!Object} state
   * @return {void}
   */
  _refreshNow: function (state) {
    if (!OrganiserAuctionPage._current(state) || state.stopped) return;
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    state.delay = OrganiserAuctionPage.pollMs();
    OrganiserAuctionPage._poll(state);
  },

  /* ================================================================== *
   * Offline — CONTRACTS-PHASE4-7 PHASE 5.5, KNOWN-ISSUES.md 10a
   * ================================================================== */

  /** @return {boolean} */
  _isOffline: function () {
    return (typeof Offline !== 'undefined') && !!Offline && Offline.isOffline() === true;
  },

  /**
   * Subscribe to the offline module. It fires immediately with the current
   * state, so the banner renders without waiting for a first poll.
   * @param {!Object} state
   * @return {void}
   */
  _watchOffline: function (state) {
    if (typeof Offline === 'undefined' || !Offline) return;
    state.offChange = Offline.onChange(function (info) {
      if (!OrganiserAuctionPage._current(state)) return;
      state.offline = info.offline === true;
      state.queued = Number(info.queueLength) || 0;
      OrganiserAuctionPage._renderOffline(state);
      if (state.offline) {
        OrganiserAuctionPage._setLink(state, 'offline', 'Offline');
      }
      // The controls change shape offline (no correction, no return to pool),
      // so the sell form has to be rebuilt.
      state.sellKey = '';
      OrganiserAuctionPage._renderSell(state);
    });
  },

  /**
   * The banner. Offline.js's header block fixes exactly what has to be here:
   * the contracted text, the queue length, and a standing reminder that the
   * PAPER SHEET is the real record.
   * @param {!Object} state
   * @return {void}
   */
  _renderOffline: function (state) {
    const box = state.els.offline;
    if (!box) return;
    box.textContent = '';

    const offline = state.offline;
    const queued = state.queued;

    if (!offline && !queued) {
      box.hidden = true;
      box.dataset.mode = 'none';
      return;
    }
    box.hidden = false;
    box.dataset.mode = offline ? 'offline' : 'pending';

    const title = document.createElement('p');
    title.className = 'auc-off__title';

    const mark = document.createElement('span');
    mark.className = 'auc-off__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = offline ? '⚠' : '↑';
    title.appendChild(mark);

    const text = document.createElement('span');
    text.className = 'auc-off__text';
    // The em dash and the full stop are part of the contract, so the constant
    // is used rather than retyped (CONTRACTS-PHASE4-7 §5.5.3).
    text.textContent = offline
      ? Offline.OFFLINE_BANNER_TEXT
      : 'Back online. ' + queued + ' ' + (queued === 1 ? 'result' : 'results') +
        ' are still only on this laptop.';
    title.appendChild(text);
    box.appendChild(title);

    const note = document.createElement('p');
    note.className = 'auc-off__note';
    note.textContent = (offline
      ? queued + ' ' + (queued === 1 ? 'result is' : 'results are') +
        ' waiting to save. You can keep recording SOLD and UNSOLD. '
      : '') +
      'THE PAPER SHEET IS THE REAL RECORD. If the paper and this screen ever ' +
      'disagree, the paper wins and an admin makes a correction.';
    box.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'auc-off__actions';

    if (!offline && queued > 0) {
      // Never auto-sync. The organiser has to see the result of the replay,
      // because some of it may come back refused.
      actions.appendChild(UI.button(
        state.syncing ? 'Saving…' : 'Save the ' + queued + ' waiting ' +
          (queued === 1 ? 'result' : 'results'),
        function () { OrganiserAuctionPage._sync(state); },
        { variant: 'primary', disabled: state.syncing }));
    }
    if (offline) {
      actions.appendChild(UI.button('Try the connection now', function () {
        OrganiserAuctionPage._refreshNow(state);
      }, { variant: 'secondary' }));
    }
    box.appendChild(actions);
  },

  /**
   * Store one write locally because there is no network.
   *
   * NOTE WHAT IS *NOT* IN THE PAYLOAD: expectedVersion. See _syncCall.
   *
   * @param {!Object} state
   * @param {string} action
   * @param {!Object} payload
   * @param {!Object} options
   * @return {void}
   */
  _enqueue: function (state, action, payload, options) {
    if (typeof Offline === 'undefined' || !Offline) return;

    const body = Object.assign({ tournamentId: state.tournamentId }, payload,
      options.offlineContext || {});

    Offline.enqueue(action, body).then(function () {
      if (!OrganiserAuctionPage._current(state)) return;
      // enqueue resolves only once the record is DURABLE, so this is the first
      // moment it is honest to tell the organiser it was recorded at all.
      OrganiserAuctionPage._showResult('info', options.offlineMessage ||
        'Recorded on this laptop. It is not saved on the server yet.');

      if (state.card) {
        state.card.auction_status = (action === 'auction.markSold') ? 'SOLD' : 'UNSOLD';
        if (options.offlineContext && options.offlineContext.teamName) {
          state.card.team_name = options.offlineContext.teamName;
          state.card.sold_amount_display = options.offlineContext.amountDisplay || '';
        }
      }
      state.sell = { teamId: '', amount: '', ack: false };
      state.sellKey = '';
      OrganiserAuctionPage._renderCard(state);
      OrganiserAuctionPage._focusSerial(state, true);
    }).catch(function (err) {
      if (!OrganiserAuctionPage._current(state)) return;
      // A queue write that failed is the worst case in the whole file: the
      // organiser must know immediately that only the paper has it.
      OrganiserAuctionPage._showError('THIS RESULT WAS NOT SAVED, not even on this ' +
        'laptop. Write it on the paper sheet now. ' +
        ((err && err.message) ? String(err.message) : ''));
    });
  },

  /**
   * Replay the queue.
   * @param {!Object} state
   * @return {void}
   */
  _sync: function (state) {
    if (typeof Offline === 'undefined' || !Offline) return;
    if (state.syncing) return;
    state.syncing = true;
    OrganiserAuctionPage._renderOffline(state);

    Offline.sync(OrganiserAuctionPage._syncCall, { tournamentId: state.tournamentId })
      .then(function (res) {
        state.syncing = false;
        if (!OrganiserAuctionPage._current(state)) return;
        OrganiserAuctionPage._afterSync(state, res || {});
      })
      .catch(function (err) {
        state.syncing = false;
        if (!OrganiserAuctionPage._current(state)) return;
        OrganiserAuctionPage._renderOffline(state);
        OrganiserAuctionPage._showError(err);
      });
  },

  /**
   * THE REPLAY CALLBACK. Offline.sync hands every queued item to this.
   *
   * ============================================================================
   * IT MUST FETCH THE CURRENT VERSION AND ATTACH IT TO EACH ITEM BEFORE SENDING.
   *
   * A VERSION CAPTURED WHILE OFFLINE IS GUARANTEED TO BE STALE BY THE TIME THE
   * CONNECTION RETURNS, SO REPLAYING IT VERBATIM FAILS EVERY SINGLE QUEUED SALE
   * WITH STALE_STATE. That is why nothing is queued with an expectedVersion in
   * the first place (offline.js warns at enqueue time if one is present), and
   * why the version is read here, immediately before each call, rather than
   * once for the whole run: every applied item bumps the version, so a single
   * version fetched up front would already be stale by the second item.
   *
   * This is not a validation bypass. The version check exists to stop a stale
   * open TAB acting on old information; a queued write is not a stale tab, it
   * is a write that has not been attempted yet. The other two protections from
   * §4.1 — the script lock, and the re-read that makes a second caller see
   * SOLD — are untouched and still prevent a double sale, and the server
   * re-validates the purse, the squad size and the player's status from the
   * sheet for every replayed item exactly as it would for a live one.
   *
   * KNOWN-ISSUES.md item 10a; the "REPLAY SEMANTICS" block in offline.js.
   * ============================================================================
   *
   * @param {string} action
   * @param {!Object} payload the payload as it was queued, with no version
   * @return {!Promise<*>}
   */
  _syncCall: function (action, payload) {
    const state = OrganiserAuctionPage._state;
    const body = Object.assign({}, payload || {});
    if (state && state.tournamentId && !body.tournamentId) {
      body.tournamentId = state.tournamentId;
    }

    return OrganiserAuctionPage._freshVersion(body.tournamentId).then(function (v) {
      body.expectedVersion = v;
      return OrganiserAuctionPage._call(action, body);
    });
  },

  /**
   * Read the version the server holds RIGHT NOW.
   *
   * No `v` is sent, deliberately: we want the number the server has, not a
   * {same:true} answer measured against a version this tab may no longer
   * believe. The snapshot that comes back is applied too, so the team strip is
   * correct between replayed items.
   *
   * @param {string} tournamentId
   * @return {!Promise<number>}
   */
  _freshVersion: function (tournamentId) {
    const state = OrganiserAuctionPage._state;
    return OrganiserAuctionPage._call('auction.state', {
      tournamentId: tournamentId || (state && state.tournamentId)
    }, { retryBusy: false }).then(function (data) {
      const v = (data && typeof data.v === 'number') ? data.v : null;
      if (v === null) {
        throw {
          code: 'INTERNAL_ERROR',
          message: 'The server did not return an auction version, so a queued result ' +
            'cannot be replayed safely. Nothing was sent.'
        };
      }
      if (state && OrganiserAuctionPage._current(state)) {
        if (data.same === true) state.v = v;
        else OrganiserAuctionPage._applySnapshot(state, data);
      }
      return v;
    });
  },

  /**
   * @param {!Object} state
   * @param {!Object} res the Offline.sync result
   * @return {void}
   */
  _afterSync: function (state, res) {
    const applied = (res.applied || []).length;
    const rejected = res.rejected || [];
    const stopped = res.stopped || null;

    let kind = 'success';
    let message = applied + ' ' + (applied === 1 ? 'result' : 'results') + ' saved on the server.';

    if (rejected.length) {
      kind = 'info';
      message += ' ' + rejected.length + ' ' + (rejected.length === 1 ? 'was' : 'were') +
        ' refused and ' + (rejected.length === 1 ? 'is' : 'are') +
        ' listed below — nothing was thrown away and nothing was forced through. ' +
        'You decide what happens to each one.';
    }
    if (stopped) {
      kind = 'error';
      message += ' The replay STOPPED at #' +
        String((stopped.payload && stopped.payload.serialNo) || stopped.seq) + ': ' +
        String((stopped.error && stopped.error.message) || 'unknown failure') + ' ' +
        String(stopped.hint || '') +
        ' Everything after it is still queued, in order, and is safe.';
    }
    OrganiserAuctionPage._showResult(kind, message);

    OrganiserAuctionPage._loadRejected(state);
    OrganiserAuctionPage._renderOffline(state);
    OrganiserAuctionPage._refreshNow(state);
  },

  /**
   * Rejected items survive a reload, so they are read from storage rather than
   * only from the last sync result.
   * @param {!Object} state
   * @return {void}
   */
  _loadRejected: function (state) {
    if (typeof Offline === 'undefined' || !Offline) return;
    Offline.listRejected(state.tournamentId).then(function (rows) {
      if (!OrganiserAuctionPage._current(state)) return;
      state.rejected = rows || [];
      OrganiserAuctionPage._renderRejected(state);
    }).catch(function () {
      /* nothing useful to show; the sync result already said what happened */
    });
  },

  /**
   * One row per refused item, with the SERVER'S OWN MESSAGE. Never silently
   * dropped, never silently forced (CONTRACTS-PHASE4-7 §5.5.4).
   * @param {!Object} state
   * @return {void}
   */
  _renderRejected: function (state) {
    const box = state.els.rejected;
    if (!box) return;
    box.textContent = '';

    if (!state.rejected.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Results the server refused (' + state.rejected.length + ')';
    box.appendChild(h2);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent = 'These were recorded on this laptop while it was offline and the ' +
      'server would not accept them. They are NOT saved. Nothing here has been thrown ' +
      'away and nothing has been forced through — read each one, check it against the ' +
      'paper sheet, and decide.';
    box.appendChild(note);

    const list = document.createElement('ul');
    list.className = 'auc-rej__list';

    state.rejected.forEach(function (item) {
      const payload = item.payload || {};
      const li = document.createElement('li');
      li.className = 'auc-rej__row';

      const head = document.createElement('p');
      head.className = 'auc-rej__head';
      head.textContent = (payload.serialNo ? '#' + String(payload.serialNo) + ' ' : '') +
        String(payload.playerName || payload.playerId || '') +
        (item.action === 'auction.markSold'
          ? ' → ' + String(payload.teamName || payload.teamId || '') + ' for ' +
            String(payload.amountDisplay || OrganiserAuctionPage._money(payload.amount))
          : ' → unsold');
      li.appendChild(head);

      const msg = document.createElement('p');
      msg.className = 'auc-rej__msg';
      // The server's exact words. Rewriting them would hide the number that
      // explains the refusal.
      msg.textContent = String((item.error && item.error.code) || '') + ' — ' +
        String((item.error && item.error.message) || 'The server gave no reason.');
      li.appendChild(msg);

      const actions = document.createElement('div');
      actions.className = 'auc-rej__actions';
      actions.appendChild(UI.button('Try this one again now', function () {
        OrganiserAuctionPage._retryRejected(state, item);
      }, { variant: 'secondary' }));
      li.appendChild(actions);

      list.appendChild(li);
    });

    box.appendChild(list);

    box.appendChild(UI.button('I have dealt with all of these — clear the list', function () {
      state.dialogOpen = true;
      UI.confirmDialog({
        title: 'Clear the refused list?',
        body: 'This only clears the list on this laptop. It does not save anything and ' +
          'it does not undo anything. Only do it once every row above has been settled ' +
          'against the paper sheet.',
        confirmLabel: 'Yes, clear the list',
        danger: true
      }).then(function (go) {
        state.dialogOpen = false;
        if (!go || !OrganiserAuctionPage._current(state)) return;
        Offline.clearRejected(state.tournamentId).then(function () {
          if (!OrganiserAuctionPage._current(state)) return;
          state.rejected = [];
          OrganiserAuctionPage._renderRejected(state);
        });
      }, function () { state.dialogOpen = false; });
    }, { variant: 'secondary' }));
  },

  /**
   * Send one refused item again, with a freshly read version. The organiser
   * asked for it, so it is their decision, not a silent forcing.
   * @param {!Object} state
   * @param {!Object} item
   * @return {void}
   */
  _retryRejected: function (state, item) {
    OrganiserAuctionPage._clearError();
    OrganiserAuctionPage._syncCall(item.action, item.payload).then(function () {
      if (!OrganiserAuctionPage._current(state)) return;
      OrganiserAuctionPage._showResult('success',
        'That one went through this time. It is now saved on the server. ' +
        'Clear the list once you have checked the rest.');
      OrganiserAuctionPage._refreshNow(state);
    }).catch(function (err) {
      if (OrganiserAuctionPage._handled(err) || !OrganiserAuctionPage._current(state)) return;
      OrganiserAuctionPage._showError(err);
    });
  },

  /* ================================================================== *
   * Teams, summary
   * ================================================================== */

  /**
   * The team strip. Permanently on screen, because remaining purse and
   * remaining slots are what the organiser is actually managing.
   * @param {!Object} state
   * @return {void}
   */
  _renderTeams: function (state) {
    const list = state.els.teams;
    if (!list) return;
    list.textContent = '';

    if (!state.teams.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No teams yet.';
      list.appendChild(li);
      return;
    }

    state.teams.forEach(function (t) {
      const slots = (Number(t.max_players) || 0) - (Number(t.players_count) || 0);
      const li = document.createElement('li');
      li.className = 'auc-team' + (slots <= 0 ? ' auc-team--full' : '');

      const name = document.createElement('span');
      name.className = 'auc-team__name';
      // A team name is typed by an organiser. textContent, always.
      name.textContent = String(t.team_name || t.team_id || '');
      li.appendChild(name);

      const purse = document.createElement('span');
      purse.className = 'auc-team__purse';
      purse.textContent = OrganiserAuctionPage._money(t.purse_remaining, t.purse_remaining_display);
      li.appendChild(purse);

      const count = document.createElement('span');
      count.className = 'auc-team__count';
      count.textContent = OrganiserAuctionPage._num(t.players_count) + ' / ' +
        OrganiserAuctionPage._num(t.max_players);
      li.appendChild(count);

      // Slots left, NOT remaining-purse-divided-by-slots. Every player sells
      // for a different amount, so that average stated a price that does not
      // exist — and the organiser is reading this while deciding what to accept.
      const slot = document.createElement('span');
      slot.className = 'auc-team__slot';
      slot.textContent = slots > 0
        ? (String(slots) + (slots === 1 ? ' slot left' : ' slots left'))
        : 'Squad full';
      li.appendChild(slot);

      list.appendChild(li);
    });
  },

  /**
   * The four honest labels of DESIGN.md §6.9, straight off the snapshot.
   * @param {!Object} state
   * @return {void}
   */
  _renderSummaryStrip: function (state) {
    const box = state.els.summaryBox;
    if (!box) return;
    box.textContent = '';

    const s = state.summary;
    if (!s) return;

    [
      ['Sold', s.sold],
      ['Un-sold', s.unsold],
      ['Awaiting re-auction', s.pending_called],
      ['Not called', s.not_called],
      ['Eligible', s.eligible],
      ['Total spent', s.total_spent_display]
    ].forEach(function (pair) {
      if (pair[1] === undefined || pair[1] === null) return;
      const item = document.createElement('div');
      item.className = 'auc-sum__item';
      const value = document.createElement('span');
      value.className = 'auc-sum__value';
      value.textContent = String(pair[1]);
      item.appendChild(value);
      const label = document.createElement('span');
      label.className = 'auc-sum__label';
      label.textContent = pair[0];
      item.appendChild(label);
      box.appendChild(item);
    });
  },

  /**
   * auction.summary (§4.6) — the full set of counts and the close-the-auction
   * signal, on demand. The poll already carries most of it; this is the
   * "view auction summary" control the requirement asks for (DESIGN.md §33).
   * @return {void}
   */
  _loadSummary: function () {
    const state = OrganiserAuctionPage._state;
    if (!state || !state.tournamentId) return;

    OrganiserAuctionPage._call('auction.summary', { tournamentId: state.tournamentId })
      .then(function (res) {
        if (!OrganiserAuctionPage._current(state)) return;
        const s = res || {};
        const bits = [
          'Sold ' + OrganiserAuctionPage._num(s.sold),
          'Unsold ' + OrganiserAuctionPage._num(s.unsold),
          'Awaiting re-auction ' + OrganiserAuctionPage._num(s.awaiting_reauction),
          'Not called ' + OrganiserAuctionPage._num(s.not_called),
          'Eligible ' + OrganiserAuctionPage._num(s.eligible),
          'Total spent ' + String(s.total_spent_display ||
            OrganiserAuctionPage._money(s.total_spent)),
          'Teams full ' + OrganiserAuctionPage._num(s.teams_full) + ' of ' +
            OrganiserAuctionPage._num(s.teams_total)
        ];
        OrganiserAuctionPage._showResult('info', bits.join(' · ') +
          (s.banner ? '. ' + String(s.banner) : '.'));
      })
      .catch(function (err) {
        if (OrganiserAuctionPage._handled(err) || !OrganiserAuctionPage._current(state)) return;
        OrganiserAuctionPage._showError(err);
      });
  },

  /* ================================================================== *
   * Small helpers
   * ================================================================== */

  /**
   * @param {!Object} state
   * @param {string} teamId
   * @return {?Object}
   */
  _teamById: function (state, teamId) {
    const id = String(teamId || '');
    if (!id) return null;
    for (let i = 0; i < state.teams.length; i++) {
      if (String(state.teams[i].team_id) === id) return state.teams[i];
    }
    return null;
  },

  /**
   * Whole rupees, digits only. Commas, spaces and a rupee sign are tolerated
   * because an organiser will paste "1,50,000" at some point, but anything
   * else — a decimal point, a minus, an "e" — is not a number of rupees.
   * @param {*} raw
   * @return {number} NaN when it is not a positive whole number of rupees
   */
  _toRupees: function (raw) {
    const s = String(raw === null || raw === undefined ? '' : raw)
      .replace(/[,\s₹]/g, '');
    if (!/^[0-9]+$/.test(s)) return NaN;
    const n = Number(s);
    return (isFinite(n) && n > 0) ? n : NaN;
  },

  /**
   * Prefer the server's own formatted string. UI.money is a faithful port of
   * Util.formatINR, so the fallback groups digits the same way, but the
   * server's string is the one that cannot disagree with it.
   * @param {*} rupees
   * @param {string} [display]
   * @return {string}
   */
  _money: function (rupees, display) {
    if (display) return String(display);
    const n = Number(rupees);
    if (!isFinite(n)) return '';
    return UI.money(n);
  },

  /**
   * @param {*} value
   * @return {string}
   */
  _num: function (value) {
    const n = Number(value);
    return isFinite(n) ? String(Math.round(n)) : '0';
  },

  /**
   * @param {*} role
   * @return {string}
   */
  _roleText: function (role) {
    const key = String(role || '').toUpperCase();
    if (!key) return '';
    return OrganiserAuctionPage.ROLE_LABEL[key] || key.replace(/_/g, ' ');
  },

  /**
   * @param {*} style
   * @return {string}
   */
  _styleText: function (style) {
    const key = String(style || '').toUpperCase();
    if (!key) return '';
    return OrganiserAuctionPage.STYLE_LABEL[key] || key.replace(/_/g, ' ');
  },

  /**
   * @param {*} years
   * @return {string}
   */
  _ageText: function (years) {
    const n = Number(years);
    if (!isFinite(n) || n <= 0) return '';
    return 'Age ' + Math.round(n);
  },

  /**
   * @param {*} status
   * @return {string}
   */
  _statusWord: function (status) {
    const key = String(status || 'PENDING').toUpperCase();
    const spec = OrganiserAuctionPage.STATUS[key];
    return spec ? spec.word : key;
  },

  /**
   * Colour AND word AND shape, always all three (DESIGN.md §8/§51). The shape
   * is a real element so it survives a stylesheet that failed to load.
   * @param {*} status
   * @return {HTMLElement}
   */
  _statusPill: function (status) {
    const key = String(status || 'PENDING').toUpperCase();
    const spec = OrganiserAuctionPage.STATUS[key] || OrganiserAuctionPage.STATUS.PENDING;

    const pill = document.createElement('span');
    pill.className = 'status ' + spec.cls;

    const mark = document.createElement('span');
    mark.className = 'status__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = spec.mark;
    pill.appendChild(mark);

    const word = document.createElement('span');
    word.className = 'status__word';
    word.textContent = spec.word;
    pill.appendChild(word);

    return pill;
  }
};
