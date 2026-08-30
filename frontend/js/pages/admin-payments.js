/**
 * admin-payments.js — the /admin/payments screen. `AdminPaymentsPage`.
 *
 * THE SCREEN THE TOURNAMENT LIVES OR DIES ON (CONTRACTS-PHASE2.md §6.1).
 * An admin sits with a bank statement open and works a queue of up to 400
 * payments, one at a time. Every saved click is real time; every mistake is
 * somebody's ₹500. Everything below is shaped by that one sentence.
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE2 §1   payment.list / payment.getScreenshot /
 *                         payment.verify / payment.reject payload + response
 *   CONTRACTS-PHASE2 §3   the counts object, taken straight out of the verify
 *                         and reject responses so a decision costs ONE call
 *   CONTRACTS-PHASE2 §6.1 the eight non-negotiable behaviours
 *   CONTRACTS-PHASE1 §4   textContent only, vanilla JS, all traffic through
 *                         API, document.body.dataset.route
 *   DESIGN.md §12         the application never decides a payment succeeded
 *   DESIGN.md §15 case 4  two admins on one row is a no-op, not an error
 *   DESIGN.md §15 case 15 possible_duplicate_of is a question, not a finding
 *   DESIGN.md §16 risk 1  the screenshot arrives as a data: URI and nothing
 *                         else. No Drive URL, no file id, ever.
 *
 * THE FIVE RULES THIS FILE EXISTS TO KEEP
 *
 *   1. ONE payment.getScreenshot PER VIEW, AND NEVER A PREFETCH.
 *      400 base64 screenshots would exhaust the tab, and there is deliberately
 *      no batch endpoint (CONTRACTS-PHASE2 §1 rule 3). The queue carries text
 *      only; bytes are fetched when — and only when — a row is opened.
 *
 *   2. THE UPI REFERENCE IS THE PRODUCT.
 *      It is rendered large, monospace and letter-spaced with a Copy button,
 *      because the whole job is comparing it character by character against a
 *      bank statement. Small proportional text is how a 0 becomes an O.
 *
 *   3. A REJECTION WITHOUT A REASON IS UNANSWERABLE.
 *      The server enforces 3–200 characters; the button here stays disabled
 *      until the box holds a real reason, so it never gets that far.
 *
 *   4. NO UNDO BUTTON (CONTRACTS-PHASE2 §6.1 rule 7).
 *      A decision is changed by deciding again, which the backend records as a
 *      reversal with reversedFrom set. This page shows that reversal in words.
 *      An undo button would hide the very thing the audit trail is for.
 *
 *   5. THE SCREENSHOT SOURCE IS A data: URI OR NOTHING.
 *      _setScreenshotSrc refuses anything else. A Drive link is unauthenticated
 *      — anyone holding it could read a stranger's payment proof.
 */

/* eslint-disable no-unused-vars */
const AdminPaymentsPage = {

  LOGIN_PATH: '/admin/login',
  DASHBOARD_PATH: '/admin/dashboard',
  PAYMENTS_PATH: '/admin/payments',

  /**
   * Thrown by _call() after it has already handled an expired session. A caller
   * that sees this must render nothing — the page is being replaced.
   * @const
   */
  REDIRECTED: Object.freeze({ code: 'REDIRECTED', message: '' }),

  /**
   * Where the chosen tournament is remembered between visits, WHEN app.js does
   * not already own that job.
   *
   * The integration agent's app.js is the authority: ?t=<id> in the URL is the
   * only source of truth, App.currentTournamentId reads it, App.setTournament
   * caches it and a route guard refuses to render this page with no selection.
   * This constant and the two helpers at the foot of the file are the fallback
   * for a build where those helpers are absent, so the queue still works
   * instead of showing an empty screen.
   * @const {string}
   */
  TOURNAMENT_KEY: 'ca.admin.tournament',

  /** Rows per payment.list call. The server default; the server caps at 200. */
  PAGE_SIZE: 50,

  /** Rejection reason limits, mirroring CONTRACTS-PHASE2 §1. @const {number} */
  REASON_MIN: 3,
  REASON_MAX: 200,

  /** @const {!Object<string,string>} */
  STATUS_LABEL: Object.freeze({
    PENDING: 'Pending',
    VERIFIED: 'Verified',
    REJECTED: 'Rejected'
  }),

  /**
   * Status filter. 'ALL' is the backend's explicit escape hatch — omitting
   * paymentStatus means PENDING, not "everything" (CONTRACTS-PHASE2 §1).
   * @const {!Array<{value:string, label:string}>}
   */
  FILTERS: Object.freeze([
    Object.freeze({ value: 'PENDING', label: 'Pending — still to check' }),
    Object.freeze({ value: 'VERIFIED', label: 'Verified' }),
    Object.freeze({ value: 'REJECTED', label: 'Rejected' }),
    Object.freeze({ value: 'ALL', label: 'All payments' })
  ]),

  /**
   * The keyboard path, shown on screen and never buried in a help modal
   * (CONTRACTS-PHASE2 §6.1 rule 8). This is a repetitive job: an admin who
   * never touches the mouse gets through the queue in a fraction of the time.
   * @const {!Array<{keys:string, what:string}>}
   */
  SHORTCUTS: Object.freeze([
    Object.freeze({ keys: 'V', what: 'Verify the open payment' }),
    Object.freeze({ keys: 'R', what: 'Reject it (jumps to the reason box)' }),
    Object.freeze({ keys: 'J / ↓', what: 'Next payment' }),
    Object.freeze({ keys: 'K / ↑', what: 'Previous payment' }),
    Object.freeze({ keys: 'Esc', what: 'Close the full-screen screenshot' })
  ]),

  /* ------------------------------------------------------------------ *
   * Per-render state
   * ------------------------------------------------------------------ */

  /** @type {number} bumped on every render; async work checks it before painting */
  _gen: 0,

  /** @type {?Object} */
  _state: null,

  /** @type {boolean} the document keydown listener is attached exactly once */
  _keysBound: false,

  /* ================================================================== *
   * Entry point
   * ================================================================== */

  /**
   * @param {Object} ctx router context {path, params, query, pattern}
   * @return {void}
   */
  render: function (ctx) {
    document.body.dataset.route = 'admin-payments';
    document.title = 'Payment verification · Cricket Auction';

    const gen = ++AdminPaymentsPage._gen;
    const query = (ctx && ctx.query) || {};

    AdminPaymentsPage._state = {
      gen: gen,
      /** the tournament every call on this page is scoped to */
      tournamentId: '',
      tournamentName: '',
      tournaments: [],
      /** true while the "which tournament?" chooser is on screen */
      picking: false,
      filter: AdminPaymentsPage._initialFilter(query),
      page: 1,
      totalPages: 1,
      total: 0,
      rows: [],
      counts: null,
      /** index into rows of the open payment, or -1 */
      index: -1,
      /** bumped on every open; a late getScreenshot for an old view is dropped */
      view: 0,
      /** true while a verify/reject is in flight — blocks a second decision */
      deciding: false,
      /** the full-screen screenshot overlay, when open */
      zoom: null,
      /** true while UI.confirmDialog owns the keyboard */
      dialogOpen: false,
      /** the on-screen shortcuts toggle. Off = an ordinary page again. */
      shortcuts: true,
      els: {}
    };

    // No token at all: do not flash an empty queue, just go and sign in.
    if (!API.getToken()) {
      Router.navigate(AdminPaymentsPage.LOGIN_PATH, { replace: true });
      return;
    }

    AdminPaymentsPage._bindKeys();
    AdminPaymentsPage._renderShell(ctx);

    // app.js owns the tournament selection: ?t=<id> in the URL, a guard that
    // refuses to render this route without one, and a shared nav that shows
    // which tournament is on screen (CONTRACTS-PHASE2 §6.3). Where those
    // helpers exist, take the id straight from them and skip a whole
    // tournament.list round trip. Where they do not, fall back to asking.
    const id = AdminPaymentsPage._tournamentIdFrom(ctx, query);
    if (id && typeof App.currentTournamentId === 'function') {
      AdminPaymentsPage._useTournament(id, AdminPaymentsPage._knownName(id));
    } else {
      AdminPaymentsPage._loadTournaments(id);
    }
  },

  /**
   * @param {!Object} query router query object
   * @return {string} the starting status filter
   */
  _initialFilter: function (query) {
    const wanted = String(query.status || '').toUpperCase();
    for (let i = 0; i < AdminPaymentsPage.FILTERS.length; i++) {
      if (AdminPaymentsPage.FILTERS[i].value === wanted) return wanted;
    }
    // The queue opens on the work still to do.
    return 'PENDING';
  },

  /**
   * Which tournament this visit is about.
   *
   * App.currentTournamentId wins whenever it exists: the URL is the single
   * source of truth there, so a reload, a bookmark and a shared link all open
   * the same tournament. The rest is a fallback for a build without it — the
   * address, then the last choice.
   *
   * @param {Object} ctx router context
   * @param {!Object} query router query object
   * @return {string} a tournament id, or '' to make the admin choose
   */
  _tournamentIdFrom: function (ctx, query) {
    if (typeof App.currentTournamentId === 'function') {
      const fromApp = String(App.currentTournamentId(ctx) || '').trim();
      if (fromApp) return fromApp;
    }
    const fromUrl = String(
      query.t || query.tournamentId || query.tournament || query.id || ''
    ).trim();
    if (fromUrl) return fromUrl;
    if (String(query.pick || '') === '1') return '';
    return AdminPaymentsPage._readStoredTournament();
  },

  /**
   * @param {string} id
   * @return {string} the name app.js already knows, or ''
   */
  _knownName: function (id) {
    if (typeof App.tournamentName !== 'function') return '';
    return String(App.tournamentName(id) || '');
  },

  /* ================================================================== *
   * Shared plumbing — the same shape as admin-tournament.js
   * ================================================================== */

  /**
   * Every backend call on this page goes through here.
   *
   * ONE place handles an expired session. A 12-hour session (CONTRACTS.md §7
   * rule 3) will expire under an admin who left the queue open overnight, and
   * that can happen on any of the five actions this page calls. Handling it per
   * call means five chances to forget one, and the one that is forgotten shows
   * "Not signed in" forever with no way out.
   *
   * @param {string} action
   * @param {Object} [payload]
   * @return {!Promise<*>} rejects with AdminPaymentsPage.REDIRECTED once the
   *         session is gone and navigation has already been started.
   */
  _call: function (action, payload) {
    return API.call(action, payload || {}).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        API.clearToken();
        Router.navigate(AdminPaymentsPage.LOGIN_PATH, { replace: true });
        throw AdminPaymentsPage.REDIRECTED;
      }
      throw err;
    });
  },

  /**
   * @param {*} err
   * @return {boolean} true when _call has already navigated away
   */
  _handled: function (err) {
    return err === AdminPaymentsPage.REDIRECTED;
  },

  /**
   * @param {Object} state the state captured when the view was built
   * @return {boolean} true when this view is still the one on screen
   */
  _current: function (state) {
    return !!state && state.gen === AdminPaymentsPage._gen;
  },

  /**
   * @param {HTMLElement} el
   * @return {void}
   */
  _mount: function (el) {
    if (!App.root) App.root = document.getElementById('app');
    App.root.textContent = '';
    App.root.appendChild(el);
  },

  /**
   * @param {string|{message:string}} err
   * @return {void}
   */
  _showError: function (err) {
    const region = AdminPaymentsPage._state && AdminPaymentsPage._state.els.errors;
    if (!region) return;
    const message = (typeof err === 'string')
      ? err
      : ((err && err.message) ? String(err.message) : 'Something went wrong. Please try again.');
    region.textContent = '';
    region.appendChild(UI.banner('error', message));
  },

  /** @return {void} */
  _clearError: function () {
    const region = AdminPaymentsPage._state && AdminPaymentsPage._state.els.errors;
    if (region) region.textContent = '';
  },

  /* ================================================================== *
   * The page frame
   * ================================================================== */

  /**
   * Build the whole frame once. Everything after this repaints one region:
   * the counts strip, the list, or the detail pane. Rebuilding the frame on
   * every keystroke would throw away focus, which is the one thing a
   * keyboard-driven queue cannot afford.
   * @param {Object} [ctx] router context, passed to the shared admin nav
   * @return {void}
   */
  _renderShell: function (ctx) {
    const state = AdminPaymentsPage._state;
    const els = state.els;

    const main = document.createElement('main');
    main.className = 'panel admin pay';

    /* ---- the shared admin nav ------------------------------------- */
    // app.js builds it, this page decides where it sits (CONTRACTS-PHASE2
    // §6.3). Asking for it takes ownership, so app.js stops mounting its own
    // copy above #app and the admin never sees two.
    if (typeof App.adminNav === 'function') {
      const nav = App.adminNav('payments', ctx);
      if (nav) {
        els.nav = nav;
        main.appendChild(nav);
      }
    }

    /* ---- head ---------------------------------------------------- */
    const head = document.createElement('div');
    head.className = 'admin__head';

    const heading = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = 'Payment verification';
    heading.appendChild(h1);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent = 'Open a payment, compare its UPI reference against your ' +
      'bank statement, then verify or reject it. Nothing is decided for you.';
    heading.appendChild(note);

    // Which tournament, in words, always on screen. Verifying against the
    // wrong tournament is unrecoverable (CONTRACTS-PHASE2 §6.3).
    els.scope = document.createElement('p');
    els.scope.className = 'pay-scope';
    heading.appendChild(els.scope);

    head.appendChild(heading);

    els.actions = document.createElement('div');
    els.actions.className = 'admin__actions';
    head.appendChild(els.actions);
    main.appendChild(head);

    /* ---- counts, error and decision regions ----------------------- */

    // Permanent live regions. Their CONTENTS change; they are never inserted
    // and removed, which is what makes them announced reliably.
    els.counts = document.createElement('div');
    els.counts.className = 'pay-counts';
    els.counts.setAttribute('aria-live', 'polite');
    els.counts.setAttribute('aria-atomic', 'true');
    main.appendChild(els.counts);

    els.errors = document.createElement('div');
    els.errors.className = 'admin__errors';
    els.errors.setAttribute('aria-live', 'assertive');
    els.errors.setAttribute('aria-atomic', 'true');
    main.appendChild(els.errors);

    els.result = document.createElement('div');
    els.result.className = 'pay-result';
    els.result.setAttribute('aria-live', 'polite');
    els.result.setAttribute('aria-atomic', 'true');
    main.appendChild(els.result);

    /* ---- body ------------------------------------------------------ */
    els.body = document.createElement('div');
    els.body.className = 'admin__body';
    main.appendChild(els.body);

    AdminPaymentsPage._mount(main);
  },

  /**
   * The action bar, rebuilt whenever the tournament changes.
   * @return {void}
   */
  _renderActions: function () {
    const state = AdminPaymentsPage._state;
    const bar = state.els.actions;
    if (!bar) return;
    bar.textContent = '';

    // Only in fallback mode. When app.js is present, the shared nav already
    // carries the tournament switch and the links to the other admin screens,
    // and a second set of them beside it is just clutter to misread.
    if (!state.els.nav && state.tournaments.length > 1) {
      bar.appendChild(UI.button('Change tournament', function () {
        AdminPaymentsPage._renderPicker();
      }, { variant: 'secondary' }));
    }

    bar.appendChild(UI.button('Refresh queue', function () {
      AdminPaymentsPage._loadQueue(state.page, { keepMessage: false });
    }, { variant: 'secondary' }));

    if (!state.els.nav) {
      const back = document.createElement('a');
      back.className = 'btn btn--secondary';
      back.href = Router.href(AdminPaymentsPage.DASHBOARD_PATH);
      back.textContent = 'Tournaments';
      bar.appendChild(back);
    }
  },

  /* ================================================================== *
   * Choosing the tournament
   * ================================================================== */

  /**
   * @param {string} wantedId '' to force the chooser
   * @return {void}
   */
  _loadTournaments: function (wantedId) {
    const state = AdminPaymentsPage._state;
    state.els.body.textContent = '';
    state.els.body.appendChild(UI.spinner('Loading tournaments…'));

    AdminPaymentsPage._call('tournament.list', {})
      .then(function (rows) {
        if (!AdminPaymentsPage._current(state)) return;
        state.tournaments = Array.isArray(rows) ? rows : [];

        if (!state.tournaments.length) {
          state.els.body.textContent = '';
          const empty = document.createElement('p');
          empty.className = 'admin__empty';
          empty.textContent = 'There are no tournaments yet, so there is nothing ' +
            'to verify. Create one from the Tournaments screen first.';
          state.els.body.appendChild(empty);
          AdminPaymentsPage._renderActions();
          return;
        }

        const chosen = AdminPaymentsPage._findTournament(wantedId) ||
          (state.tournaments.length === 1 ? state.tournaments[0] : null);

        if (!chosen) {
          AdminPaymentsPage._renderActions();
          AdminPaymentsPage._renderPicker();
          return;
        }
        AdminPaymentsPage._selectTournament(chosen);
      })
      .catch(function (err) {
        if (AdminPaymentsPage._handled(err) || !AdminPaymentsPage._current(state)) return;
        state.els.body.textContent = '';
        AdminPaymentsPage._showError(err);
      });
  },

  /**
   * @param {string} id
   * @return {?Object} the matching tournament.list row
   */
  _findTournament: function (id) {
    const state = AdminPaymentsPage._state;
    if (!id) return null;
    for (let i = 0; i < state.tournaments.length; i++) {
      if (String(state.tournaments[i].tournament_id || '') === String(id)) {
        return state.tournaments[i];
      }
    }
    return null;
  },

  /**
   * @param {!Object} row a tournament.list row
   * @return {void}
   */
  _selectTournament: function (row) {
    AdminPaymentsPage._useTournament(
      String(row.tournament_id || ''), String(row.name || ''));
  },

  /**
   * Point the queue at one tournament and load it.
   *
   * @param {string} id
   * @param {string} name '' when it is not known yet — app.js's nav fetches
   *        and fills in its own copy, so the header simply stays quiet rather
   *        than printing a raw id at the admin.
   * @return {void}
   */
  _useTournament: function (id, name) {
    const state = AdminPaymentsPage._state;
    state.tournamentId = String(id || '');
    state.tournamentName = String(name || '');
    state.picking = false;
    AdminPaymentsPage._writeStoredTournament(state.tournamentId, state.tournamentName);

    state.els.scope.textContent = '';
    if (state.tournamentName) {
      const label = document.createElement('span');
      label.className = 'pay-scope__label';
      label.textContent = 'Tournament: ';
      const value = document.createElement('strong');
      value.className = 'pay-scope__name';
      value.textContent = state.tournamentName;
      state.els.scope.appendChild(label);
      state.els.scope.appendChild(value);
    }

    AdminPaymentsPage._renderActions();
    AdminPaymentsPage._loadQueue(1, { keepMessage: false });
  },

  /**
   * The "which tournament?" chooser. Deliberately a list of plain buttons with
   * the registered / verified counts beside each name: picking the wrong one
   * is the mistake this screen cannot recover from.
   * @return {void}
   */
  _renderPicker: function () {
    const state = AdminPaymentsPage._state;
    state.picking = true;
    state.els.body.textContent = '';
    state.els.result.textContent = '';
    state.els.counts.textContent = '';

    const section = document.createElement('section');
    section.className = 'pay-picker';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Choose a tournament';
    section.appendChild(h2);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent = 'Every payment below belongs to one tournament. Check the ' +
      'name before you start verifying.';
    section.appendChild(note);

    const list = document.createElement('ul');
    list.className = 'pay-picker__list';

    state.tournaments.forEach(function (row) {
      const li = document.createElement('li');
      const btn = UI.button(String(row.name || '(untitled)'), function () {
        AdminPaymentsPage._selectTournament(row);
      }, { variant: 'secondary' });
      btn.className += ' pay-picker__btn';

      const meta = document.createElement('span');
      meta.className = 'pay-picker__meta';
      meta.textContent = AdminPaymentsPage._count(row.player_count) + ' registered · ' +
        AdminPaymentsPage._count(row.verified_count) + ' verified';
      btn.appendChild(meta);

      li.appendChild(btn);
      list.appendChild(li);
    });

    section.appendChild(list);
    state.els.body.appendChild(section);
  },

  /* ================================================================== *
   * The queue
   * ================================================================== */

  /**
   * Fetch one page of payment.list.
   *
   * TEXT ONLY. No screenshot is requested here for any row, at any time
   * (CONTRACTS-PHASE2 §6.1 rule 2). The response deliberately carries no
   * screenshot_file_id either.
   *
   * @param {number} page 1-based
   * @param {Object} [opts] {keepMessage: boolean, selectFirst: boolean}
   * @return {void}
   */
  _loadQueue: function (page, opts) {
    const state = AdminPaymentsPage._state;
    const options = opts || {};

    state.page = Math.max(1, Number(page) || 1);
    state.index = -1;
    state.view += 1;                       // any in-flight screenshot is stale
    if (!options.keepMessage) state.els.result.textContent = '';
    AdminPaymentsPage._clearError();

    state.els.body.textContent = '';
    state.els.body.appendChild(UI.spinner('Loading the payment queue…'));

    const filter = {};
    filter.paymentStatus = state.filter;   // 'ALL' is the explicit "no filter"

    AdminPaymentsPage._call('payment.list', {
      tournamentId: state.tournamentId,
      filter: filter,
      page: state.page,
      pageSize: AdminPaymentsPage.PAGE_SIZE,
      sort: 'submitted_at'                 // oldest first: whoever waited longest
    }).then(function (res) {
      if (!AdminPaymentsPage._current(state)) return;
      const data = res || {};
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.page = Number(data.page) || state.page;
      state.totalPages = Math.max(1, Number(data.totalPages) || 1);
      state.total = Number(data.total) || 0;
      state.counts = data.counts || state.counts;

      AdminPaymentsPage._renderCounts();
      AdminPaymentsPage._renderQueue();

      if (options.selectFirst && state.rows.length) {
        AdminPaymentsPage._openRow(0, { focus: true });
      }
    }).catch(function (err) {
      if (AdminPaymentsPage._handled(err) || !AdminPaymentsPage._current(state)) return;
      state.els.body.textContent = '';
      AdminPaymentsPage._showError(err);
    });
  },

  /**
   * The counts strip: "42 of 400 remaining" plus the whole-tournament totals.
   *
   * These numbers come out of the payment.list, payment.verify AND
   * payment.reject responses (CONTRACTS-PHASE2 §3), so working through the
   * queue never costs an extra round trip just to update a header. At 400
   * players that would be a full sheet read per click.
   * @return {void}
   */
  _renderCounts: function () {
    const state = AdminPaymentsPage._state;
    const box = state.els.counts;
    if (!box) return;

    box.textContent = '';
    const counts = state.counts;
    if (!counts) return;

    const headline = document.createElement('p');
    headline.className = 'pay-counts__headline';
    headline.textContent = AdminPaymentsPage._count(counts.pending) + ' of ' +
      AdminPaymentsPage._count(counts.all) + ' remaining';
    box.appendChild(headline);

    const chips = document.createElement('ul');
    chips.className = 'pay-counts__chips';
    [
      ['Pending', counts.pending],
      ['Verified', counts.verified],
      ['Rejected', counts.rejected],
      ['Withdrawn', counts.withdrawn],
      ['Eligible for the auction', counts.eligible],
      ['Registered', counts.all]
    ].forEach(function (pair) {
      if (pair[1] === undefined || pair[1] === null) return;
      const li = document.createElement('li');
      li.className = 'badge pay-counts__chip';
      li.textContent = pair[0] + ' ' + AdminPaymentsPage._count(pair[1]);
      chips.appendChild(li);
    });
    box.appendChild(chips);
  },

  /**
   * Paint the filter bar, the shortcut legend, the list and the detail pane.
   * @return {void}
   */
  _renderQueue: function () {
    const state = AdminPaymentsPage._state;
    const body = state.els.body;
    body.textContent = '';

    body.appendChild(AdminPaymentsPage._filterBar());
    body.appendChild(AdminPaymentsPage._shortcutBar());

    const layout = document.createElement('div');
    layout.className = 'pay-layout';
    state.els.layout = layout;

    const listPane = document.createElement('section');
    listPane.className = 'pay-pane pay-pane--list';
    listPane.setAttribute('aria-label', 'Payment queue');
    state.els.listPane = listPane;

    state.els.list = document.createElement('div');
    state.els.list.className = 'pay-list';
    listPane.appendChild(state.els.list);

    state.els.paging = document.createElement('div');
    state.els.paging.className = 'pay-paging';
    listPane.appendChild(state.els.paging);

    const detailPane = document.createElement('section');
    detailPane.className = 'pay-pane pay-pane--detail';
    detailPane.setAttribute('aria-label', 'Payment detail');
    state.els.detail = detailPane;

    layout.appendChild(listPane);
    layout.appendChild(detailPane);
    body.appendChild(layout);

    AdminPaymentsPage._renderList();
    AdminPaymentsPage._renderPaging();
    AdminPaymentsPage._renderNoSelection();
  },

  /**
   * Status filter. A <select>, not a row of tabs: it is one keyboard stop and
   * it stays one line on a phone.
   * @return {HTMLElement}
   */
  _filterBar: function () {
    const state = AdminPaymentsPage._state;

    const bar = document.createElement('div');
    bar.className = 'pay-filters';

    const handle = UI.field({
      label: 'Show',
      name: 'payment-status',
      type: 'select',
      value: state.filter,
      placeholderOption: '',
      options: AdminPaymentsPage.FILTERS.map(function (f) {
        return { value: f.value, label: f.label };
      }),
      hint: 'The queue opens on the payments still to check.'
    });
    handle.input.value = state.filter;
    handle.input.addEventListener('change', function () {
      state.filter = String(handle.input.value || 'PENDING');
      AdminPaymentsPage._loadQueue(1, { keepMessage: false });
    });
    bar.appendChild(handle.wrap);

    return bar;
  },

  /**
   * The shortcut legend, on the page rather than behind a help modal
   * (CONTRACTS-PHASE2 §6.1 rule 8), plus the switch that turns the shortcuts
   * off.
   *
   * WHY THE SWITCH EXISTS. A screen reader in browse mode uses single letters
   * to jump around the document, so a page that swallows V and R can trap a
   * screen reader user on this screen. The keys already stand down inside any
   * input, but this makes the escape hatch explicit and visible, which is the
   * point — a trap you cannot see is a trap you cannot leave.
   *
   * @return {HTMLElement}
   */
  _shortcutBar: function () {
    const state = AdminPaymentsPage._state;

    const box = document.createElement('div');
    box.className = 'pay-keys';

    const title = document.createElement('h2');
    title.className = 'pay-keys__title';
    title.textContent = 'Keyboard';
    box.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'pay-keys__list';
    AdminPaymentsPage.SHORTCUTS.forEach(function (item) {
      const li = document.createElement('li');
      li.className = 'pay-keys__item';
      const key = document.createElement('kbd');
      key.className = 'pay-keys__key';
      key.textContent = item.keys;
      li.appendChild(key);
      const what = document.createElement('span');
      what.className = 'pay-keys__what';
      what.textContent = item.what;
      li.appendChild(what);
      list.appendChild(li);
    });
    box.appendChild(list);

    const toggle = document.createElement('label');
    toggle.className = 'choice pay-keys__toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!state.shortcuts;
    cb.addEventListener('change', function () {
      state.shortcuts = !!cb.checked;
    });
    const cbText = document.createElement('span');
    cbText.textContent = 'Single-key shortcuts on';
    toggle.appendChild(cb);
    toggle.appendChild(cbText);
    box.appendChild(toggle);

    const note = document.createElement('p');
    note.className = 'pay-keys__note';
    note.textContent = 'Shortcuts never fire while you are typing in a box.';
    box.appendChild(note);

    return box;
  },

  /**
   * The queue itself: one button per payment.
   *
   * Buttons, not table rows, so every entry is reachable with Tab, works with
   * Enter and Space for free, and can carry aria-current for the open one.
   * @return {void}
   */
  _renderList: function () {
    const state = AdminPaymentsPage._state;
    const box = state.els.list;
    if (!box) return;

    box.textContent = '';

    if (!state.rows.length) {
      box.appendChild(AdminPaymentsPage._emptyQueue());
      return;
    }

    const count = document.createElement('p');
    count.className = 'pay-list__count';
    count.textContent = AdminPaymentsPage._count(state.total) + ' ' +
      AdminPaymentsPage._filterWord() + ' — showing ' +
      AdminPaymentsPage._count(state.rows.length) + ' on this page.';
    box.appendChild(count);

    const ul = document.createElement('ul');
    ul.className = 'pay-list__items';

    state.rows.forEach(function (row, i) {
      ul.appendChild(AdminPaymentsPage._listRow(row, i));
    });

    box.appendChild(ul);
  },

  /**
   * @param {!Object} row a payment.list row
   * @param {number} i its index in state.rows
   * @return {HTMLElement}
   */
  _listRow: function (row, i) {
    const state = AdminPaymentsPage._state;

    const li = document.createElement('li');
    li.className = 'pay-list__item';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pay-row' + (state.index === i ? ' pay-row--open' : '');
    if (state.index === i) btn.setAttribute('aria-current', 'true');

    const serial = document.createElement('span');
    serial.className = 'pay-row__serial';
    serial.textContent = AdminPaymentsPage._serialText(row.serial_no);
    btn.appendChild(serial);

    const mid = document.createElement('span');
    mid.className = 'pay-row__mid';

    // A player name comes from a sheet and is untrusted. textContent, always.
    const name = document.createElement('span');
    name.className = 'pay-row__name';
    name.textContent = String(row.name || '(name missing)');
    mid.appendChild(name);

    const ref = document.createElement('span');
    ref.className = 'pay-row__ref';
    ref.textContent = String(row.upi_ref || '');
    mid.appendChild(ref);

    btn.appendChild(mid);

    const right = document.createElement('span');
    right.className = 'pay-row__right';

    const amount = document.createElement('span');
    amount.className = 'pay-row__amount';
    amount.textContent = AdminPaymentsPage._amountText(row);
    right.appendChild(amount);

    right.appendChild(AdminPaymentsPage._statusPill(row.status));

    if (row.possible_duplicate_of !== null && row.possible_duplicate_of !== undefined &&
        row.possible_duplicate_of !== '') {
      const flag = document.createElement('span');
      flag.className = 'pay-row__dup';
      flag.textContent = 'Same name as ' +
        AdminPaymentsPage._serialText(row.possible_duplicate_of);
      right.appendChild(flag);
    }

    btn.appendChild(right);

    btn.addEventListener('click', function () {
      AdminPaymentsPage._openRow(i, { focus: false });
    });

    li.appendChild(btn);
    return li;
  },

  /**
   * An empty queue is the GOOD outcome, and the screen should say so rather
   * than looking like a failed load.
   * @return {HTMLElement}
   */
  _emptyQueue: function () {
    const state = AdminPaymentsPage._state;

    const box = document.createElement('div');
    box.className = 'empty pay-empty';

    const h = document.createElement('p');
    h.className = 'pay-empty__title';
    h.textContent = (state.filter === 'PENDING')
      ? 'Nothing left to check.'
      : 'No ' + AdminPaymentsPage._filterWord() + ' to show.';
    box.appendChild(h);

    const p = document.createElement('p');
    p.className = 'pay-empty__note';
    p.textContent = (state.filter === 'PENDING')
      ? 'Every payment in this tournament has been verified or rejected. New ' +
        'registrations will appear here as they arrive — press Refresh queue.'
      : 'Change the filter above to see other payments.';
    box.appendChild(p);

    return box;
  },

  /** @return {void} */
  _renderPaging: function () {
    const state = AdminPaymentsPage._state;
    const box = state.els.paging;
    if (!box) return;
    box.textContent = '';
    if (state.totalPages <= 1) return;

    const prev = UI.button('Previous page', function () {
      AdminPaymentsPage._loadQueue(state.page - 1, { keepMessage: false });
    }, { variant: 'secondary', disabled: state.page <= 1 });
    box.appendChild(prev);

    const label = document.createElement('span');
    label.className = 'pay-paging__label';
    label.textContent = 'Page ' + state.page + ' of ' + state.totalPages;
    box.appendChild(label);

    const next = UI.button('Next page', function () {
      AdminPaymentsPage._loadQueue(state.page + 1, { keepMessage: false });
    }, { variant: 'secondary', disabled: state.page >= state.totalPages });
    box.appendChild(next);
  },

  /* ================================================================== *
   * The detail pane
   * ================================================================== */

  /** @return {void} */
  _renderNoSelection: function () {
    const state = AdminPaymentsPage._state;
    const pane = state.els.detail;
    if (!pane) return;

    pane.textContent = '';
    if (state.els.layout) {
      state.els.layout.className = 'pay-layout';
    }

    const box = document.createElement('div');
    box.className = 'empty pay-detail__idle';
    box.textContent = state.rows.length
      ? 'Choose a payment from the queue, or press J to start at the top.'
      : 'There is nothing open.';
    pane.appendChild(box);
  },

  /**
   * Open one payment.
   *
   * THIS IS THE ONLY PLACE payment.getScreenshot IS EVER CALLED, and it is
   * called exactly once per open (CONTRACTS-PHASE2 §6.1 rule 2). state.view is
   * bumped first, so a screenshot that arrives after the admin has already
   * moved on is dropped instead of painted over the wrong player.
   *
   * @param {number} i index into state.rows
   * @param {Object} [opts] {focus: boolean} move focus into the detail pane
   * @return {void}
   */
  _openRow: function (i, opts) {
    const state = AdminPaymentsPage._state;
    const options = opts || {};
    if (i < 0 || i >= state.rows.length) return;

    const row = state.rows[i];
    state.index = i;
    state.view += 1;
    const viewToken = state.view;

    AdminPaymentsPage._renderList();          // move the "open" marker
    AdminPaymentsPage._renderDetail(row, i);

    const slot = state.els.shot;
    if (slot) {
      slot.textContent = '';
      slot.appendChild(UI.spinner('Loading the payment screenshot…'));

      AdminPaymentsPage._call('payment.getScreenshot', {
        paymentId: String(row.payment_id || '')
      }).then(function (res) {
        if (!AdminPaymentsPage._current(state) || state.view !== viewToken) return;
        AdminPaymentsPage._renderScreenshot(slot, row, res || {});
      }).catch(function (err) {
        if (AdminPaymentsPage._handled(err)) return;
        if (!AdminPaymentsPage._current(state) || state.view !== viewToken) return;
        slot.textContent = '';
        slot.appendChild(UI.banner('error',
          'The payment screenshot could not be loaded. ' +
          ((err && err.message) ? String(err.message) : '') +
          ' You can still verify from the UPI reference if your bank statement is clear.'));
      });
    }

    if (options.focus && state.els.detailHeading &&
        typeof state.els.detailHeading.focus === 'function') {
      state.els.detailHeading.focus();
    }
  },

  /**
   * Everything about one payment except the image bytes.
   * @param {!Object} row a payment.list row
   * @param {number} i its index
   * @return {void}
   */
  _renderDetail: function (row, i) {
    const state = AdminPaymentsPage._state;
    const pane = state.els.detail;
    if (!pane) return;

    pane.textContent = '';
    // On a narrow screen the detail REPLACES the list; the class is what the
    // stylesheet keys that off (CONTRACTS-PHASE2 §6.1 layout).
    if (state.els.layout) state.els.layout.className = 'pay-layout pay-layout--open';

    const card = document.createElement('div');
    card.className = 'pay-detail';

    /* ---- back to the queue: only visible on a narrow screen ------- */
    const back = UI.button('Back to the queue', function () {
      state.index = -1;
      state.view += 1;
      AdminPaymentsPage._renderList();
      AdminPaymentsPage._renderNoSelection();
    }, { variant: 'secondary' });
    back.className += ' pay-detail__back';
    card.appendChild(back);

    /* ---- who ------------------------------------------------------ */
    const head = document.createElement('div');
    head.className = 'pay-detail__head';

    const h2 = document.createElement('h2');
    h2.className = 'pay-detail__title';
    // tabindex -1 so a decision can hand focus to the next player's name.
    // Without it, focus falls to <body> and a screen reader user is lost.
    h2.setAttribute('tabindex', '-1');
    const serial = document.createElement('span');
    serial.className = 'pay-detail__serial';
    serial.textContent = AdminPaymentsPage._serialText(row.serial_no);
    h2.appendChild(serial);
    const name = document.createElement('span');
    name.className = 'pay-detail__name';
    name.textContent = String(row.name || '(name missing)');
    h2.appendChild(name);
    head.appendChild(h2);
    state.els.detailHeading = h2;

    head.appendChild(AdminPaymentsPage._statusPill(row.status));
    card.appendChild(head);

    /* ---- the duplicate question ----------------------------------- */
    const dup = AdminPaymentsPage._duplicateNotice(row);
    if (dup) card.appendChild(dup);

    /* ---- the UPI reference: the whole point of the screen ---------- */
    card.appendChild(AdminPaymentsPage._upiBlock(row));

    /* ---- the rest of the facts ------------------------------------ */
    const dl = document.createElement('dl');
    dl.className = 'kv pay-detail__facts';
    [
      ['Serial number', AdminPaymentsPage._serialText(row.serial_no)],
      ['Name', String(row.name || '—')],
      ['Mobile', String(row.mobile || '—')],
      ['Amount', AdminPaymentsPage._amountText(row)],
      ['Submitted', String(row.submitted_at_display || row.submitted_at || '—')],
      ['Payment status', AdminPaymentsPage._statusText(row.status)]
    ].forEach(function (pair) {
      const dt = document.createElement('dt');
      dt.textContent = pair[0];
      const dd = document.createElement('dd');
      dd.textContent = pair[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    card.appendChild(dl);

    /* ---- the screenshot slot, filled by _openRow ------------------- */
    const shotBox = document.createElement('div');
    shotBox.className = 'pay-shot';

    const shotTitle = document.createElement('h3');
    shotTitle.className = 'pay-shot__title';
    shotTitle.textContent = 'Payment screenshot';
    shotBox.appendChild(shotTitle);

    const shotNote = document.createElement('p');
    shotNote.className = 'pay-shot__note';
    shotNote.textContent = 'Select the screenshot to open it full screen. ' +
      'Reference numbers inside a screenshot are often tiny.';
    shotBox.appendChild(shotNote);

    state.els.shot = document.createElement('div');
    state.els.shot.className = 'pay-shot__slot';
    shotBox.appendChild(state.els.shot);
    card.appendChild(shotBox);

    /* ---- the decision --------------------------------------------- */
    card.appendChild(AdminPaymentsPage._decisionBlock(row, i));

    pane.appendChild(card);
  },

  /**
   * possible_duplicate_of, worded as a QUESTION.
   *
   * The backend matches names exactly, after collapsing case and whitespace,
   * and nothing else (DESIGN.md §15 case 15). In a tournament of 400 there
   * will be two people called the same thing, and neither has done anything
   * wrong. So this asks the admin to look; it never says "fraud".
   *
   * @param {!Object} row
   * @return {?HTMLElement}
   */
  _duplicateNotice: function (row) {
    const other = row.possible_duplicate_of;
    if (other === null || other === undefined || other === '') return null;

    const box = document.createElement('div');
    box.className = 'banner banner--warning pay-dup';
    box.setAttribute('role', 'status');

    const mark = document.createElement('span');
    mark.className = 'banner__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '?';
    box.appendChild(mark);
    box.appendChild(document.createTextNode(' '));

    const strong = document.createElement('strong');
    strong.textContent = AdminPaymentsPage._serialText(other) +
      ' has the same name. Check before verifying.';
    box.appendChild(strong);

    box.appendChild(document.createTextNode(
      ' Only the names match, exactly. Two people can share a name, so this is ' +
      'a question and not a finding — compare the mobile numbers and the UPI ' +
      'references before you decide.'));

    return box;
  },

  /**
   * The UPI reference, large, monospace and letter-spaced, with a Copy button.
   *
   * CONTRACTS-PHASE2 §6.1 rule 1. This is the string being matched character by
   * character against a bank statement. Rendering it in small proportional text
   * is exactly how a transcription mistake happens, and a mistake here is
   * somebody's ₹500.
   *
   * @param {!Object} row
   * @return {HTMLElement}
   */
  _upiBlock: function (row) {
    const value = String(row.upi_ref || '');

    const box = document.createElement('div');
    box.className = 'pay-upi';

    const label = document.createElement('h3');
    label.className = 'pay-upi__label';
    label.textContent = 'UPI reference';
    box.appendChild(label);

    const row1 = document.createElement('div');
    row1.className = 'pay-upi__row';

    const text = document.createElement('p');
    text.className = 'pay-upi__value';
    text.textContent = value || '(none recorded)';
    row1.appendChild(text);

    // A read-only input off-screen gives the clipboard fallback something real
    // to select on a browser with no navigator.clipboard (plain-http LAN).
    const shadow = document.createElement('input');
    shadow.type = 'text';
    shadow.readOnly = true;
    shadow.value = value;
    shadow.className = 'visually-hidden';
    shadow.setAttribute('aria-hidden', 'true');
    shadow.setAttribute('tabindex', '-1');
    row1.appendChild(shadow);

    if (value) {
      row1.appendChild(AdminPaymentsPage._copyButton('Copy reference', value, shadow));
    }

    box.appendChild(row1);

    const hint = document.createElement('p');
    hint.className = 'pay-upi__hint';
    hint.textContent = 'Match this against your bank statement, character by character.';
    box.appendChild(hint);

    return box;
  },

  /**
   * The screenshot itself.
   *
   * @param {HTMLElement} slot
   * @param {!Object} row the queue row it belongs to
   * @param {!Object} res the payment.getScreenshot response
   * @return {void}
   */
  _renderScreenshot: function (slot, row, res) {
    slot.textContent = '';

    const dataUri = String(res.dataUri || '');
    if (!AdminPaymentsPage._isDataUri(dataUri)) {
      // Belt and braces against a future backend change. The contract says a
      // data: URI and only a data: URI; a Drive URL here would be a leak, not
      // a convenience (DESIGN.md §16 risk 1).
      slot.appendChild(UI.banner('error',
        'The screenshot did not arrive in a form this page will display. ' +
        'Nothing has been lost — try again, and report it if it keeps happening.'));
      return;
    }

    // Cross-check that the bytes belong to the row on screen. A screenshot
    // shown next to the wrong UPI reference is the worst failure this screen
    // has, because it looks perfectly normal.
    const mismatch = AdminPaymentsPage._mismatch(row, res);
    if (mismatch) {
      slot.appendChild(UI.banner('error', mismatch));
      return;
    }

    const zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.className = 'pay-shot__zoom';
    zoomBtn.setAttribute('aria-label',
      'Open the payment screenshot full screen for ' +
      AdminPaymentsPage._serialText(row.serial_no) + ' ' + String(row.name || ''));

    const img = document.createElement('img');
    img.className = 'pay-shot__img';
    img.alt = 'Payment screenshot submitted by ' + String(row.name || 'this player');
    AdminPaymentsPage._setScreenshotSrc(img, dataUri);
    zoomBtn.appendChild(img);

    zoomBtn.addEventListener('click', function () {
      AdminPaymentsPage._openZoom(dataUri, img.alt, zoomBtn);
    });

    slot.appendChild(zoomBtn);

    const meta = document.createElement('p');
    meta.className = 'pay-shot__meta';
    meta.textContent = AdminPaymentsPage._shotMeta(res);
    slot.appendChild(meta);
  },

  /**
   * The ONLY place an <img> src is set on this page.
   *
   * A payment proof lives in a private Drive folder that is never shared. It
   * reaches a browser as base64 inside an admin-authenticated response and in
   * no other way. A Drive URL is unauthenticated: anyone who ended up with the
   * link could read a stranger's bank screenshot (DESIGN.md §16 risk 1). So
   * anything that is not a data: URI is refused here rather than "handled".
   *
   * @param {HTMLElement} img
   * @param {string} dataUri
   * @return {boolean} true when the src was set
   */
  _setScreenshotSrc: function (img, dataUri) {
    if (!AdminPaymentsPage._isDataUri(dataUri)) return false;
    img.src = dataUri;
    return true;
  },

  /**
   * @param {*} value
   * @return {boolean} true for "data:image/...;base64,..." and nothing else
   */
  _isDataUri: function (value) {
    return /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(String(value || ''));
  },

  /**
   * @param {!Object} row the queue row
   * @param {!Object} res the payment.getScreenshot response
   * @return {string} '' when they agree, otherwise the warning to show
   */
  _mismatch: function (row, res) {
    const shown = String(row.upi_ref || '');
    const got = String(res.upi_ref || '');
    if (shown && got && shown !== got) {
      return 'This screenshot belongs to a different payment (' + got +
        ', not ' + shown + '). Nothing has been changed. Refresh the queue and open it again.';
    }
    const player = res.player || {};
    const shownSerial = String(row.serial_no === null || row.serial_no === undefined ? '' : row.serial_no);
    const gotSerial = String(player.serial_no === null || player.serial_no === undefined ? '' : player.serial_no);
    if (shownSerial && gotSerial && shownSerial !== gotSerial) {
      return 'This screenshot belongs to serial ' + gotSerial + ', not ' + shownSerial +
        '. Nothing has been changed. Refresh the queue and open it again.';
    }
    return '';
  },

  /**
   * @param {!Object} res
   * @return {string} e.g. "JPEG · 148 KB"
   */
  _shotMeta: function (res) {
    const bits = [];
    const mime = String(res.mime || '');
    if (mime) bits.push(mime.replace(/^image\//, '').toUpperCase());
    const bytes = Number(res.bytes);
    if (isFinite(bytes) && bytes > 0) {
      bits.push(bytes >= 1024 ? (Math.round(bytes / 1024) + ' KB') : (bytes + ' bytes'));
    }
    return bits.length ? bits.join(' · ') : '';
  },

  /* ------------------------------------------------------------------ *
   * Full-screen screenshot
   * ------------------------------------------------------------------ */

  /**
   * Open the screenshot full screen (CONTRACTS-PHASE2 §6.1 rule 3).
   *
   * A UPI reference printed inside a payment app screenshot is often 10px tall
   * on a 1024px-wide image, and reading it is the whole job. Escape, the close
   * button and a click on the backdrop all close it, and focus goes back to the
   * thumbnail that opened it.
   *
   * @param {string} dataUri
   * @param {string} alt
   * @param {HTMLElement} opener the element to hand focus back to
   * @return {void}
   */
  _openZoom: function (dataUri, alt, opener) {
    const state = AdminPaymentsPage._state;
    if (state.zoom) return;
    if (!AdminPaymentsPage._isDataUri(dataUri)) return;

    const overlay = document.createElement('div');
    overlay.className = 'pay-zoom';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Payment screenshot, full screen');

    const inner = document.createElement('div');
    inner.className = 'pay-zoom__box';

    const close = UI.button('Close', function () {
      AdminPaymentsPage._closeZoom();
    }, { variant: 'secondary' });
    close.className += ' pay-zoom__close';
    inner.appendChild(close);

    const img = document.createElement('img');
    img.className = 'pay-zoom__img';
    img.alt = String(alt || 'Payment screenshot');
    AdminPaymentsPage._setScreenshotSrc(img, dataUri);
    inner.appendChild(img);

    const hint = document.createElement('p');
    hint.className = 'pay-zoom__hint';
    hint.textContent = 'Press Escape to close.';
    inner.appendChild(hint);

    overlay.appendChild(inner);
    overlay.addEventListener('click', function (ev) {
      if (ev && ev.target === overlay) AdminPaymentsPage._closeZoom();
    });

    document.body.appendChild(overlay);
    state.zoom = { el: overlay, opener: opener || null, close: close };
    if (typeof close.focus === 'function') close.focus();
  },

  /**
   * Close the full-screen screenshot and give focus back.
   * @return {void}
   */
  _closeZoom: function () {
    const state = AdminPaymentsPage._state;
    if (!state || !state.zoom) return;
    const zoom = state.zoom;
    state.zoom = null;

    if (zoom.el && zoom.el.parentNode) zoom.el.parentNode.removeChild(zoom.el);
    if (zoom.opener && typeof zoom.opener.focus === 'function') {
      try { zoom.opener.focus(); } catch (e) { /* gone from the DOM */ }
    }
  },

  /* ------------------------------------------------------------------ *
   * Verify and reject
   * ------------------------------------------------------------------ */

  /**
   * The two buttons and the reason box.
   *
   * @param {!Object} row
   * @param {number} i
   * @return {HTMLElement}
   */
  _decisionBlock: function (row, i) {
    const state = AdminPaymentsPage._state;

    const box = document.createElement('div');
    box.className = 'pay-decide';

    const h3 = document.createElement('h3');
    h3.className = 'pay-decide__title';
    h3.textContent = 'Your decision';
    box.appendChild(h3);

    /* ---- reject reason, above the buttons so it is filled in first -- */
    const reason = UI.field({
      label: 'Reason for rejecting',
      name: 'reject-reason',
      type: 'textarea',
      rows: 2,
      maxLength: AdminPaymentsPage.REASON_MAX,
      hint: AdminPaymentsPage.REASON_MIN + ' to ' + AdminPaymentsPage.REASON_MAX +
        ' characters. The player has to be told why, so write something they ' +
        'could act on — "no matching entry in the statement for this reference".'
    });
    reason.wrap.className += ' pay-decide__reason';
    state.els.reason = reason;

    const counter = document.createElement('p');
    counter.className = 'pay-decide__count';
    reason.wrap.appendChild(counter);

    /* ---- the buttons ---------------------------------------------- */
    const buttons = document.createElement('div');
    buttons.className = 'pay-decide__buttons';

    const verifyBtn = UI.button('Verify payment', function () {
      AdminPaymentsPage._verify(i);
    }, { variant: 'primary' });
    verifyBtn.className += ' pay-decide__verify';
    buttons.appendChild(verifyBtn);

    // Disabled until there is a real reason. The server enforces 3–200
    // (CONTRACTS-PHASE2 §1); the form should never let it get that far.
    const rejectBtn = UI.button('Reject payment', function () {
      AdminPaymentsPage._reject(i);
    }, { variant: 'danger', disabled: true });
    rejectBtn.className += ' pay-decide__reject';
    buttons.appendChild(rejectBtn);

    state.els.verifyBtn = verifyBtn;
    state.els.rejectBtn = rejectBtn;

    const sync = function () {
      const text = AdminPaymentsPage._reasonText();
      const okLength = text.length >= AdminPaymentsPage.REASON_MIN &&
        text.length <= AdminPaymentsPage.REASON_MAX;
      rejectBtn.disabled = !okLength || state.deciding;
      counter.textContent = text.length + ' of ' + AdminPaymentsPage.REASON_MAX +
        ' characters' + (okLength ? '' : ' — at least ' + AdminPaymentsPage.REASON_MIN + ' needed');
      if (okLength) reason.clearError();
    };
    reason.input.addEventListener('input', sync);
    reason.input.addEventListener('change', sync);
    sync();

    box.appendChild(reason.wrap);
    box.appendChild(buttons);

    /* ---- the reversal wording, when this row is already decided ---- */
    const current = AdminPaymentsPage._statusOf(row);
    if (current === 'VERIFIED' || current === 'REJECTED') {
      const already = document.createElement('p');
      already.className = 'pay-decide__already';
      already.textContent = 'This payment is already ' +
        AdminPaymentsPage._statusText(current).toLowerCase() +
        '. Deciding again is allowed and is recorded in the audit log as a reversal.';
      box.appendChild(already);
    }

    /* ---- no undo, said out loud ----------------------------------- */
    const noUndo = document.createElement('p');
    noUndo.className = 'pay-decide__noundo';
    noUndo.textContent = 'There is no undo. To change a decision, open the payment ' +
      'again and choose the other option — that is recorded as a reversal, with ' +
      'your name on it.';
    box.appendChild(noUndo);

    return box;
  },

  /**
   * @return {string} the reason box contents, whitespace collapsed exactly the
   *         way the server collapses it before measuring the length
   */
  _reasonText: function () {
    const state = AdminPaymentsPage._state;
    const handle = state && state.els.reason;
    if (!handle || !handle.input) return '';
    return String(handle.input.value || '').replace(/\s+/g, ' ').trim();
  },

  /**
   * @param {number} i index into state.rows
   * @return {void}
   */
  _verify: function (i) {
    const state = AdminPaymentsPage._state;
    const row = state.rows[i];
    if (!row || state.deciding) return;

    AdminPaymentsPage._confirmReversal(row, 'VERIFIED').then(function (go) {
      if (!go || !AdminPaymentsPage._current(state)) return;
      AdminPaymentsPage._send('payment.verify', {
        paymentId: String(row.payment_id || '')
      }, row, i, 'VERIFIED');
    });
  },

  /**
   * @param {number} i index into state.rows
   * @return {void}
   */
  _reject: function (i) {
    const state = AdminPaymentsPage._state;
    const row = state.rows[i];
    if (!row || state.deciding) return;

    const handle = state.els.reason;
    const text = AdminPaymentsPage._reasonText();

    if (text.length < AdminPaymentsPage.REASON_MIN) {
      if (handle) {
        handle.setError('Write at least ' + AdminPaymentsPage.REASON_MIN +
          ' characters saying why. The player has to be told.');
        if (typeof handle.input.focus === 'function') handle.input.focus();
      }
      return;
    }
    if (text.length > AdminPaymentsPage.REASON_MAX) {
      if (handle) {
        handle.setError('The reason is ' + text.length + ' characters. The limit is ' +
          AdminPaymentsPage.REASON_MAX + '.');
        if (typeof handle.input.focus === 'function') handle.input.focus();
      }
      return;
    }

    AdminPaymentsPage._confirmReversal(row, 'REJECTED').then(function (go) {
      if (!go || !AdminPaymentsPage._current(state)) return;
      AdminPaymentsPage._send('payment.reject', {
        paymentId: String(row.payment_id || ''),
        reason: text
      }, row, i, 'REJECTED');
    });
  },

  /**
   * Ask before overturning a decision a human already made.
   *
   * An ordinary PENDING row goes straight through — this queue is 400 long and
   * a confirm on the hot path would cost an hour. A row that is already decided
   * is different: someone looked at a bank statement and concluded something,
   * and changing that is worth one deliberate click.
   *
   * @param {!Object} row
   * @param {string} target 'VERIFIED' | 'REJECTED'
   * @return {!Promise<boolean>}
   */
  _confirmReversal: function (row, target) {
    const state = AdminPaymentsPage._state;
    const current = AdminPaymentsPage._statusOf(row);
    if (current !== 'VERIFIED' && current !== 'REJECTED') return Promise.resolve(true);
    if (current === target) return Promise.resolve(true);   // a no-op, not a reversal

    const who = AdminPaymentsPage._serialText(row.serial_no) + ' ' + String(row.name || '');
    state.dialogOpen = true;

    return UI.confirmDialog({
      title: 'Reverse the earlier decision?',
      body: who.trim() + ' is currently ' +
        AdminPaymentsPage._statusText(current).toLowerCase() + '. Marking it ' +
        AdminPaymentsPage._statusText(target).toLowerCase() +
        ' overturns that decision. It is allowed, it is not an undo, and it is ' +
        'written to the audit log as a reversal with your name and the time.',
      confirmLabel: 'Yes, mark it ' + AdminPaymentsPage._statusText(target).toLowerCase(),
      danger: target === 'REJECTED'
    }).then(function (answer) {
      state.dialogOpen = false;
      return !!answer;
    }, function () {
      state.dialogOpen = false;
      return false;
    });
  },

  /**
   * Send one decision and deal with everything that can come back.
   *
   * @param {string} action 'payment.verify' | 'payment.reject'
   * @param {!Object} payload
   * @param {!Object} row the queue row being decided
   * @param {number} i its index
   * @param {string} target 'VERIFIED' | 'REJECTED'
   * @return {void}
   */
  _send: function (action, payload, row, i, target) {
    const state = AdminPaymentsPage._state;

    state.deciding = true;
    AdminPaymentsPage._setDecideBusy(true, target);
    AdminPaymentsPage._clearError();

    AdminPaymentsPage._call(action, payload)
      .then(function (res) {
        if (!AdminPaymentsPage._current(state)) return;
        state.deciding = false;
        AdminPaymentsPage._applyDecision(row, i, res || {}, target);
      })
      .catch(function (err) {
        if (AdminPaymentsPage._handled(err)) return;
        if (!AdminPaymentsPage._current(state)) return;
        state.deciding = false;
        AdminPaymentsPage._setDecideBusy(false, target);
        AdminPaymentsPage._showError(err);
      });
  },

  /**
   * @param {boolean} busy
   * @param {string} target
   * @return {void}
   */
  _setDecideBusy: function (busy, target) {
    const state = AdminPaymentsPage._state;
    const v = state.els.verifyBtn;
    const r = state.els.rejectBtn;
    if (v) {
      v.disabled = !!busy;
      v.textContent = busy && target === 'VERIFIED' ? 'Verifying…' : 'Verify payment';
    }
    if (r) {
      const okLength = AdminPaymentsPage._reasonText().length >= AdminPaymentsPage.REASON_MIN;
      r.disabled = busy || !okLength;
      r.textContent = busy && target === 'REJECTED' ? 'Rejecting…' : 'Reject payment';
    }
  },

  /**
   * Record the outcome, refresh the counts from the response, say what
   * happened, and move on to the next one.
   *
   * NO SECOND ROUND TRIP. payment.verify and payment.reject both return the
   * whole-tournament counts precisely so this screen can update its header
   * without re-reading the sheet (CONTRACTS-PHASE2 §3).
   *
   * @param {!Object} row
   * @param {number} i
   * @param {!Object} res the verify/reject response
   * @param {string} target
   * @return {void}
   */
  _applyDecision: function (row, i, res, target) {
    const state = AdminPaymentsPage._state;

    row.status = String(res.status || target);
    row._decided = true;                     // shown as "just decided" in the list
    if (res.counts) state.counts = res.counts;

    AdminPaymentsPage._renderCounts();
    AdminPaymentsPage._showDecision(row, res, target);

    const next = AdminPaymentsPage._nextIndex(i);
    if (next >= 0) {
      // Focus follows the queue, so the keyboard path never breaks and a
      // screen reader announces the player that just opened.
      AdminPaymentsPage._openRow(next, { focus: true });
      return;
    }

    // Nothing left on this page. Roll on to the next one if there is one.
    if (state.page < state.totalPages) {
      AdminPaymentsPage._loadQueue(state.page + 1, { keepMessage: true, selectFirst: true });
      return;
    }

    state.index = -1;
    AdminPaymentsPage._renderList();
    AdminPaymentsPage._renderDone();
  },

  /**
   * The next payment worth opening after a decision.
   *
   * While the PENDING filter is on, an already-decided row is skipped — the
   * queue is a list of work, and re-offering something just decided wastes the
   * click this whole screen exists to save. The scan wraps once, because an
   * admin who jumped into the middle of the list still wants the top finished.
   *
   * @param {number} from the index just decided
   * @return {number} an index into state.rows, or -1
   */
  _nextIndex: function (from) {
    const state = AdminPaymentsPage._state;
    const rows = state.rows;
    const wantsPending = state.filter === 'PENDING';

    for (let i = from + 1; i < rows.length; i++) {
      if (!wantsPending || AdminPaymentsPage._statusOf(rows[i]) === 'PENDING') return i;
    }
    for (let i = 0; i <= from && i < rows.length; i++) {
      if (!wantsPending || AdminPaymentsPage._statusOf(rows[i]) === 'PENDING') {
        if (i !== from) return i;
      }
    }
    return -1;
  },

  /**
   * Say what just happened, in words, in a live region.
   *
   * Three cases the wording has to get right:
   *   alreadyVerified / alreadyRejected — two admins on one row is ORDINARY
   *     (DESIGN.md §15 case 4). Calm, not an error.
   *   reversedFrom — an earlier human decision was overturned. Named out loud,
   *     because that is the audit story the tournament relies on if there is a
   *     dispute (CONTRACTS-PHASE2 §6.1 rule 7).
   *   mirrorRepaired — the Players row was out of step and was corrected.
   *
   * @param {!Object} row
   * @param {!Object} res
   * @param {string} target
   * @return {void}
   */
  _showDecision: function (row, res, target) {
    const state = AdminPaymentsPage._state;
    const box = state.els.result;
    if (!box) return;

    const who = (AdminPaymentsPage._serialText(res.serial_no === undefined ? row.serial_no : res.serial_no) +
      ' ' + String(row.name || '')).trim();
    const noop = (target === 'VERIFIED') ? res.alreadyVerified : res.alreadyRejected;
    const reversed = res.reversedFrom ? String(res.reversedFrom) : '';

    let kind = 'success';
    let message;

    if (noop) {
      kind = 'info';
      const actor = AdminPaymentsPage._actorName(res);
      const when = String(res.verified_at_display || res.rejected_at_display || '');
      message = who + ' was already ' +
        AdminPaymentsPage._statusText(target).toLowerCase() + ' by ' + actor +
        (when ? ' on ' + when : '') +
        '. Nothing was changed — this happens when two people work the same queue.';
    } else if (reversed) {
      message = who + ' is now ' + AdminPaymentsPage._statusText(target).toLowerCase() +
        '. This reversed the earlier ' +
        AdminPaymentsPage._statusText(reversed).toLowerCase() +
        ' decision, and the reversal is in the audit log with your name and the time.';
    } else {
      message = who + ' ' + (target === 'VERIFIED' ? 'verified' : 'rejected') + '.';
      if (target === 'REJECTED' && res.reject_reason) {
        message += ' Reason: ' + String(res.reject_reason);
      }
    }

    if (state.counts) {
      message += ' ' + AdminPaymentsPage._count(state.counts.pending) + ' of ' +
        AdminPaymentsPage._count(state.counts.all) + ' remaining.';
    }
    if (res.mirrorRepaired) {
      message += ' The player record was out of step with the payment and has been corrected.';
    }

    box.textContent = '';
    box.appendChild(UI.banner(kind, message));
  },

  /**
   * Who made the earlier decision, for the "already verified by X" message.
   *
   * CONTRACTS-PHASE2 §1 says the no-op returns "the existing state", but the
   * fields it names do not include the earlier decider, and the Phase 2 backend
   * does not send one today. So this reads the field if a later build adds it
   * and otherwise says the true thing, calmly, without inventing a name.
   *
   * @param {!Object} res
   * @return {string}
   */
  _actorName: function (res) {
    const name = String(res.verified_by_name || res.verified_by || '').trim();
    return name || 'another admin';
  },

  /**
   * The end of the queue. This is the good outcome, so it says so.
   * @return {void}
   */
  _renderDone: function () {
    const state = AdminPaymentsPage._state;
    const pane = state.els.detail;
    if (!pane) return;

    pane.textContent = '';
    if (state.els.layout) state.els.layout.className = 'pay-layout';

    const box = document.createElement('div');
    box.className = 'empty pay-empty';

    const h = document.createElement('p');
    h.className = 'pay-empty__title';
    h.textContent = 'Queue clear.';
    box.appendChild(h);

    const p = document.createElement('p');
    p.className = 'pay-empty__note';
    p.textContent = 'Every payment on this page has been decided. Press Refresh ' +
      'queue to pick up anything that has arrived since.';
    box.appendChild(p);

    const refresh = UI.button('Refresh queue', function () {
      AdminPaymentsPage._loadQueue(1, { keepMessage: true });
    }, { variant: 'secondary' });
    box.appendChild(refresh);

    pane.appendChild(box);
  },

  /* ================================================================== *
   * Keyboard
   * ================================================================== */

  /**
   * Attach the document keydown listener exactly once, for the lifetime of the
   * tab.
   *
   * A page module has no teardown hook, so a listener added per render would
   * pile up one copy per visit and keep every dead state object alive with it.
   * One listener that checks the route and the generation is both leak-free and
   * simpler to reason about.
   * @return {void}
   */
  _bindKeys: function () {
    if (AdminPaymentsPage._keysBound) return;
    AdminPaymentsPage._keysBound = true;
    document.addEventListener('keydown', AdminPaymentsPage._onKeyDown);
  },

  /**
   * The repetitive path: V verify, R reject, J/K or the arrows to move.
   *
   * IT MUST NOT FIRE WHILE SOMEBODY IS TYPING. The reason box is a textarea
   * that will contain the letters v and r in almost every sentence, and a
   * "reject" that fires halfway through the word "reference" would be a
   * decision nobody made. _isTyping is the guard, and it is checked before any
   * key is looked at.
   *
   * @param {KeyboardEvent} ev
   * @return {void}
   */
  _onKeyDown: function (ev) {
    if (!ev || ev.defaultPrevented) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    // Only ever act on our own screen. The listener outlives the page.
    if (!document.body || document.body.dataset.route !== 'admin-payments') return;

    const state = AdminPaymentsPage._state;
    if (!AdminPaymentsPage._current(state)) return;

    const key = String(ev.key || '');

    // Escape closes the full-screen screenshot from anywhere, including from
    // the close button itself, and works even with the shortcuts switched off.
    if (key === 'Escape' || key === 'Esc') {
      if (state.zoom) {
        ev.preventDefault();
        AdminPaymentsPage._closeZoom();
      }
      return;
    }

    if (state.zoom || state.dialogOpen) return;    // a modal owns the keyboard
    if (!state.shortcuts) return;
    if (AdminPaymentsPage._isTyping(ev.target)) return;
    if (state.picking || !state.rows.length) return;

    if (key === 'j' || key === 'J' || key === 'ArrowDown' || key === 'Down') {
      ev.preventDefault();
      AdminPaymentsPage._move(1);
      return;
    }
    if (key === 'k' || key === 'K' || key === 'ArrowUp' || key === 'Up') {
      ev.preventDefault();
      AdminPaymentsPage._move(-1);
      return;
    }
    if (state.index < 0 || state.deciding) return;

    if (key === 'v' || key === 'V') {
      ev.preventDefault();
      AdminPaymentsPage._verify(state.index);
      return;
    }
    if (key === 'r' || key === 'R') {
      ev.preventDefault();
      // A rejection needs a reason. With the box empty, R takes you to it
      // rather than doing nothing — the reason IS the reject flow.
      if (AdminPaymentsPage._reasonText().length >= AdminPaymentsPage.REASON_MIN) {
        AdminPaymentsPage._reject(state.index);
      } else if (state.els.reason && typeof state.els.reason.input.focus === 'function') {
        state.els.reason.input.focus();
        state.els.reason.setError('Say why this payment is being rejected, then press ' +
          'Reject payment. At least ' + AdminPaymentsPage.REASON_MIN + ' characters.');
      }
    }
  },

  /**
   * @param {*} target the event target
   * @return {boolean} true when a keystroke belongs to a form control
   */
  _isTyping: function (target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = String(target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION';
  },

  /**
   * @param {number} delta +1 for the next payment, -1 for the previous one
   * @return {void}
   */
  _move: function (delta) {
    const state = AdminPaymentsPage._state;
    if (!state.rows.length) return;

    let next;
    if (state.index < 0) {
      next = delta > 0 ? 0 : state.rows.length - 1;
    } else {
      next = state.index + delta;
      if (next < 0) next = 0;
      if (next > state.rows.length - 1) next = state.rows.length - 1;
    }
    if (next === state.index) return;
    AdminPaymentsPage._openRow(next, { focus: true });
  },

  /* ================================================================== *
   * Copying
   * ================================================================== */

  /**
   * @param {string} label
   * @param {string} text what lands on the clipboard
   * @param {HTMLElement} [fallbackInput] an input holding the same text
   * @return {HTMLElement}
   */
  _copyButton: function (label, text, fallbackInput) {
    const btn = UI.button(label, function () {
      AdminPaymentsPage._copy(text, fallbackInput).then(function (ok) {
        btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        btn.setAttribute('aria-live', 'polite');
        window.setTimeout(function () { btn.textContent = label; }, 2000);
      });
    }, { variant: 'secondary', type: 'button' });
    btn.className += ' pay-copy';
    return btn;
  },

  /**
   * navigator.clipboard needs a secure context. GitHub Pages is HTTPS so it
   * normally works, but an admin testing from a plain-http LAN address has no
   * clipboard API at all — hence the select-and-execCommand fallback, which is
   * deprecated but still the only thing that works there.
   *
   * @param {string} text
   * @param {HTMLElement} [fallbackInput]
   * @return {!Promise<boolean>}
   */
  _copy: function (text, fallbackInput) {
    if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
      return window.navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return AdminPaymentsPage._copyFallback(fallbackInput); });
    }
    return Promise.resolve(AdminPaymentsPage._copyFallback(fallbackInput));
  },

  /**
   * @param {HTMLElement} [input]
   * @return {boolean}
   */
  _copyFallback: function (input) {
    if (!input || !input.select) return false;
    try {
      input.focus();
      input.select();
      return !!document.execCommand('copy');
    } catch (e) {
      return false;
    }
  },

  /* ================================================================== *
   * Small display helpers
   * ================================================================== */

  /**
   * @param {!Object} row
   * @return {string} 'PENDING' | 'VERIFIED' | 'REJECTED' | the raw value
   */
  _statusOf: function (row) {
    return String((row && row.status) || '').toUpperCase();
  },

  /**
   * @param {string} status
   * @return {string}
   */
  _statusText: function (status) {
    const key = String(status || '').toUpperCase();
    return AdminPaymentsPage.STATUS_LABEL[key] || (key || 'Unknown');
  },

  /**
   * Colour is never the only signal (DESIGN.md §8): the pill carries the word,
   * the stylesheet adds a shape, and the colour is the third cue.
   * @param {string} status
   * @return {HTMLElement}
   */
  _statusPill: function (status) {
    const key = String(status || '').toUpperCase();
    const known = !!AdminPaymentsPage.STATUS_LABEL[key];
    const span = document.createElement('span');
    span.className = 'status pay-status pay-status--' +
      (known ? key.toLowerCase() : 'unknown');
    span.textContent = AdminPaymentsPage._statusText(key);
    return span;
  },

  /**
   * @param {*} serial
   * @return {string} '#12', or 'No serial' when the player row is missing
   */
  _serialText: function (serial) {
    if (serial === null || serial === undefined || serial === '') return 'No serial';
    return '#' + String(serial);
  },

  /**
   * Prefer the server's formatted amount. UI.money is a faithful port of
   * Util.formatINR, so the fallback groups digits the same way, but the
   * server's own string is the one that cannot disagree with it.
   * @param {!Object} row
   * @return {string}
   */
  _amountText: function (row) {
    if (row.amount_display) return String(row.amount_display);
    if (row.amount === null || row.amount === undefined || row.amount === '') return '—';
    return UI.money(Number(row.amount));
  },

  /**
   * @param {*} n
   * @return {string}
   */
  _count: function (n) {
    const v = Number(n);
    return isFinite(v) ? String(v) : '0';
  },

  /**
   * @return {string} 'payments still to check' etc., for the list heading
   */
  _filterWord: function () {
    const state = AdminPaymentsPage._state;
    if (state.filter === 'PENDING') return 'payments still to check';
    if (state.filter === 'VERIFIED') return 'verified payments';
    if (state.filter === 'REJECTED') return 'rejected payments';
    return 'payments';
  },

  /* ------------------------------------------------------------------ *
   * The remembered tournament.
   *
   * app.js owns this when it is present — App.setTournament keeps the id and
   * the name in step, and throwing a stale name at the wrong id is exactly the
   * wrong-tournament mistake the nav exists to prevent. The direct
   * localStorage path below is only for a build without those helpers, and
   * both directions degrade to "no memory" rather than to a broken page,
   * because private browsing can throw on either.
   * ------------------------------------------------------------------ */

  /** @return {string} */
  _readStoredTournament: function () {
    if (typeof App.rememberedTournamentId === 'function') {
      return String(App.rememberedTournamentId() || '');
    }
    try {
      return String(window.localStorage.getItem(AdminPaymentsPage.TOURNAMENT_KEY) || '');
    } catch (e) {
      return '';
    }
  },

  /**
   * @param {string} id
   * @param {string} [name]
   * @return {void}
   */
  _writeStoredTournament: function (id, name) {
    if (!id) return;
    if (typeof App.setTournament === 'function') {
      App.setTournament(id, name || undefined);
      return;
    }
    try {
      window.localStorage.setItem(AdminPaymentsPage.TOURNAMENT_KEY, String(id));
    } catch (e) {
      /* private browsing; the page still works, it just forgets */
    }
  }
};
