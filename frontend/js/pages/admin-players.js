/**
 * admin-players.js — the /admin/players screen. `AdminPlayersPage`.
 *
 * THE GENERAL REGISTER (DESIGN.md §11): every player who has registered for
 * one tournament, in one table, with the columns that document names —
 * Serial No, Name, DOB, Role, Style, Mobile, UPI Reference, Payment Status,
 * Registration Date, Auction Status — plus a withdraw action per row.
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE2 §1    player.list payload/response, player.setWithdrawn
 *   CONTRACTS-PHASE2 §3    the tournament-wide counts object in the header
 *   CONTRACTS-PHASE2 §6.2  paging, filters, search, status shapes, confirmation
 *   CONTRACTS-PHASE1 §4    textContent only, vanilla JS, data-route on <body>
 *   CONTRACTS.md §15       every call goes through API, never fetch
 *   CONTRACTS.md §6a       dates are rendered from the server's *_display
 *                          field, or printed verbatim; never re-parsed here
 *
 * Four decisions that are not style choices:
 *
 * 1. THE SERVER PAGES, NOT THE BROWSER. Exactly one page of 50 rows is ever
 *    in memory (DESIGN.md §14). Pulling all 400 to page locally would mean a
 *    full sheet read plus a 400-row payload on every filter change, and Apps
 *    Script only allows 30 simultaneous executions (DESIGN.md §13).
 *
 * 2. THE SEARCH IS DEBOUNCED BY 300 ms. Every keystroke would otherwise be a
 *    complete Repo.readAll(Players) on the server. Typing "9876543210" is
 *    ten full sheet reads unless the keystrokes are collapsed into one call.
 *
 * 3. STATUS IS A WORD AND A SHAPE, NEVER A COLOUR (DESIGN.md §8/§51). The
 *    pill text is the signal; app.css draws the shape from --status-mark and
 *    the colour last. Greyscale, sunlight and red-green colour blindness all
 *    have to survive this.
 *
 * 4. A WITHDRAWAL NEVER FREES A SERIAL NUMBER (DESIGN.md §9, §15 case 16).
 *    The confirmation says so in those words, because an admin who believes
 *    serial 27 is now available will hand it to somebody else by hand.
 *
 * WHICH TOURNAMENT? Every Phase 2 action is tournament-scoped and the route
 * carries no path parameter, so the selection lives in the query string as
 * ?t=TRN_... — app.js owns that spelling and guards the route, so this page
 * reads it through App.currentTournamentId(ctx) and builds every internal
 * link with App.adminPath(). With no id at all it lists the tournaments and
 * asks — never a silent default, because working through the wrong
 * tournament's register is exactly the mistake CONTRACTS-PHASE2 §6.3 warns
 * about.
 */

/* eslint-disable no-unused-vars */
const AdminPlayersPage = {

  LOGIN_PATH: '/admin/login',
  PLAYERS_PATH: '/admin/players',
  DASHBOARD_PATH: '/admin/dashboard',

  /** CONTRACTS-PHASE2 §6.2 rule 1 / DESIGN.md §14. Never raised here. */
  PAGE_SIZE: 50,

  /** CONTRACTS-PHASE2 §6.2 rule 6. Milliseconds. */
  SEARCH_DEBOUNCE_MS: 300,

  /**
   * Thrown by _call() after it has already handled an expired session. A
   * caller that sees this must render nothing — the page is being replaced.
   * @const
   */
  REDIRECTED: Object.freeze({ code: 'REDIRECTED', message: '' }),

  /* ------------------------------------------------------------------ *
   * Vocabulary
   * ------------------------------------------------------------------ */

  /** ENUM.PLAYER_ROLE -> the words register.js shows players. @const */
  ROLE_LABEL: Object.freeze({
    BATSMAN: 'Batsman',
    BOWLER: 'Bowler',
    ALL_ROUNDER: 'All rounder'
  }),

  /** ENUM.PLAYER_STYLE. @const */
  STYLE_LABEL: Object.freeze({
    LEFT: 'Left handed',
    RIGHT: 'Right handed'
  }),

  /** ENUM.PAYMENT_STATUS. @const */
  PAYMENT_LABEL: Object.freeze({
    PENDING: 'Pending',
    VERIFIED: 'Verified',
    REJECTED: 'Rejected'
  }),

  /**
   * Pill modifiers for a payment status.
   *
   * `status--pending` is app.css's own (amber, ● dot). `status--verified` and
   * `status--rejected` are new modifiers of the same component, defined in
   * css/players.css and scoped to this route — app.css owns .status itself
   * and is not edited. If players.css ever fails to load, app.css's default
   * ● shape and the visible word both still render.
   * @const
   */
  PAYMENT_CLASS: Object.freeze({
    PENDING: 'status--pending',
    VERIFIED: 'status--verified',
    REJECTED: 'status--rejected'
  }),

  /** ENUM.AUCTION_STATUS, worded as DESIGN.md §8 words them. @const */
  AUCTION_LABEL: Object.freeze({
    PENDING: 'Pending',
    SOLD: 'Sold',
    UNSOLD: 'Un-sold'
  }),

  /** @const */
  AUCTION_CLASS: Object.freeze({
    PENDING: 'status--pending',
    SOLD: 'status--sold',
    UNSOLD: 'status--unsold'
  }),

  /**
   * The columns, in the order DESIGN.md §11 lists them. The same table builds
   * the header and the body, so a column can never appear in one and not the
   * other.
   *
   *   sort    one of the four keys player.list accepts, or null for a column
   *           the server cannot sort by. Offering a fifth would produce
   *           VALIDATION_FAILED and tell the admin a lie.
   * @const {!Array<!Object>}
   */
  COLUMNS: Object.freeze([
    { key: 'serial_no',      label: 'Serial No',         sort: 'serial_no',      cls: 'serial', rowHeader: true },
    { key: 'name',           label: 'Name',              sort: 'name',           cls: 'name' },
    { key: 'dob',            label: 'DOB',               sort: null,             cls: 'dob' },
    { key: 'role',           label: 'Role',              sort: null,             cls: 'role' },
    { key: 'style',          label: 'Style',             sort: null,             cls: 'style' },
    { key: 'mobile',         label: 'Mobile',            sort: null,             cls: 'mobile' },
    { key: 'upi_ref',        label: 'UPI Reference',     sort: null,             cls: 'upi' },
    { key: 'payment_status', label: 'Payment Status',    sort: 'payment_status', cls: 'payment' },
    { key: 'registered_at',  label: 'Registration Date', sort: 'registered_at',  cls: 'registered' },
    { key: 'auction_status', label: 'Auction Status',    sort: null,             cls: 'auction' }
  ]),

  /** The counts summary, in the order CONTRACTS-PHASE2 §6.2 rule 5 lists it. @const */
  COUNT_TILES: Object.freeze([
    {
      key: 'eligible', label: 'Eligible for auction', headline: true,
      note: 'Verified and not withdrawn. This is the number that actually ' +
        'reaches the auction — not "total registered".'
    },
    { key: 'all',       label: 'Registered in total' },
    { key: 'pending',   label: 'Payment pending' },
    { key: 'verified',  label: 'Payment verified' },
    { key: 'rejected',  label: 'Payment rejected' },
    { key: 'withdrawn', label: 'Withdrawn' }
  ]),

  /* ------------------------------------------------------------------ *
   * Per-render state
   * ------------------------------------------------------------------ */

  /** @type {number} bumped on every render; async work checks it before painting */
  _gen: 0,

  /** @type {?Object} */
  _state: null,

  /* ================================================================== *
   * Entry point
   * ================================================================== */

  /**
   * @param {Object} ctx router context {path, params, query, pattern}
   * @return {void}
   */
  render: function (ctx) {
    document.body.dataset.route = 'admin-players';

    AdminPlayersPage._cancelSearch();

    const gen = ++AdminPlayersPage._gen;
    const query = (ctx && ctx.query) || {};

    // No token at all: do not flash an empty register, just go and sign in.
    if (!API.getToken()) {
      Router.navigate(AdminPlayersPage.LOGIN_PATH, { replace: true });
      return;
    }

    const tournamentId = AdminPlayersPage._tournamentId(ctx, query);

    AdminPlayersPage._state = {
      gen: gen,
      tournamentId: tournamentId,
      page: 1,
      sort: 'serial_no',
      sortDir: 'asc',
      filter: { paymentStatus: '', auctionStatus: '', withdrawn: '', search: '' },
      searchTimer: null,
      /** Bumped per list request so a slow earlier reply cannot paint over a
          later one — with a 300 ms debounce, out-of-order replies are normal. */
      req: 0,
      last: null,
      errors: null,
      countsBox: null,
      tableBox: null,
      pagerBox: null
    };

    if (!tournamentId) {
      AdminPlayersPage._renderChooser();
      return;
    }

    AdminPlayersPage._renderRegister();
  },

  /* ================================================================== *
   * Shared plumbing (same shape as admin-tournament.js)
   * ================================================================== */

  /**
   * Every backend call on this page goes through here.
   *
   * ONE place handles an expired session. A 12-hour session (CONTRACTS.md §7
   * rule 3) will expire under an admin who left the register open overnight,
   * and it can happen on the list call, on a withdrawal, or on the tournament
   * lookup. Handling it per call site means three chances to forget one.
   *
   * @param {string} action
   * @param {Object} [payload]
   * @return {!Promise<*>} rejects with AdminPlayersPage.REDIRECTED once the
   *         session is gone and navigation has already been started.
   */
  _call: function (action, payload) {
    return API.call(action, payload || {}).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        API.clearToken();
        Router.navigate(AdminPlayersPage.LOGIN_PATH, { replace: true });
        throw AdminPlayersPage.REDIRECTED;
      }
      throw err;
    });
  },

  /**
   * @param {*} err
   * @return {boolean} true when _call has already navigated away
   */
  _handled: function (err) {
    return err === AdminPlayersPage.REDIRECTED;
  },

  /**
   * @param {Object} state the state captured when the view was built
   * @return {boolean} true when this view is still the one on screen
   */
  _current: function (state) {
    return !!state && state.gen === AdminPlayersPage._gen;
  },

  /**
   * createElement with a class and text in one call. textContent only —
   * a player name comes out of a sheet and one of 400 people will eventually
   * type something that looks like markup (CONTRACTS-PHASE1.md §4 rule 1).
   *
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
   * @param {HTMLElement} el
   * @return {void}
   */
  _mount: function (el) {
    App.root.textContent = '';
    App.root.appendChild(el);
  },

  /**
   * Page frame: heading, actions, a permanent live region, a body.
   * @param {string} title
   * @param {string} [note]
   * @return {{main:HTMLElement, actions:HTMLElement, errors:HTMLElement, body:HTMLElement}}
   */
  _shell: function (title, note) {
    document.title = title + ' · Cricket Auction';

    const main = AdminPlayersPage._el('main', 'panel admin players');

    const head = AdminPlayersPage._el('div', 'admin__head');
    const heading = AdminPlayersPage._el('div');
    heading.appendChild(AdminPlayersPage._el('h1', 'panel__title', title));
    if (note) heading.appendChild(AdminPlayersPage._el('p', 'panel__note', note));
    head.appendChild(heading);

    const actions = AdminPlayersPage._el('div', 'admin__actions');
    head.appendChild(actions);
    main.appendChild(head);

    // Permanent live region: errors replace its contents rather than being
    // inserted, which is what makes them announced reliably.
    const errors = AdminPlayersPage._el('div', 'admin__errors');
    errors.setAttribute('aria-live', 'assertive');
    errors.setAttribute('aria-atomic', 'true');
    main.appendChild(errors);

    const body = AdminPlayersPage._el('div', 'admin__body');
    main.appendChild(body);

    return { main: main, actions: actions, errors: errors, body: body };
  },

  /**
   * @param {HTMLElement} region
   * @param {string|{message:string}} err
   * @return {void}
   */
  _showError: function (region, err) {
    if (!region) return;
    const message = (typeof err === 'string')
      ? err
      : ((err && err.message) ? String(err.message)
        : 'Something went wrong. Please try again.');
    region.textContent = '';
    region.appendChild(UI.banner('error', message));
    if (region.scrollIntoView) region.scrollIntoView({ block: 'nearest' });
  },

  /**
   * @param {HTMLElement} region
   * @return {void}
   */
  _clearError: function (region) {
    if (region) region.textContent = '';
  },

  /**
   * Link button that navigates inside the SPA.
   * @param {string} label
   * @param {string} path app path, no BASE_PATH
   * @param {string} [variant]
   * @return {HTMLElement}
   */
  _navButton: function (label, path, variant) {
    const a = AdminPlayersPage._el('a', 'btn' + (variant === 'secondary' ? ' btn--secondary' : ''));
    a.href = Router.href(path);      // Router's click handler turns this into pushState
    a.textContent = label;
    return a;
  },

  /**
   * Which tournament this register belongs to.
   *
   * app.js owns the selection: it keeps it in the URL as ?t=<id>, guards
   * every scoped route so a page never renders without one, and exposes
   * App.currentTournamentId(ctx) as the single place the sanitising happens.
   * That helper is preferred whenever it exists; the query-string fallback
   * below only matters if this page is ever mounted by a shell that predates
   * it, and it accepts the older ?tournament= / ?tournamentId= / ?id= spellings
   * so an old bookmark still opens the right register rather than the picker.
   *
   * @param {Object} ctx router context
   * @param {!Object<string,string>} query ctx.query, already defaulted
   * @return {string} a tournament id, or '' when none was supplied
   */
  _tournamentId: function (ctx, query) {
    if (typeof App !== 'undefined' && App && typeof App.currentTournamentId === 'function') {
      try {
        const chosen = String(App.currentTournamentId(ctx) || '').trim();
        if (chosen) return chosen;
      } catch (e) {
        /* fall through to the query string */
      }
    }
    return String(
      query.t || query.tournament || query.tournamentId || query.id || ''
    ).trim();
  },

  /**
   * An internal admin path that keeps the tournament selection.
   *
   * App.adminPath is the owner of the ?t= spelling; dropping the selection on
   * a link is how an admin ends up working through the wrong tournament
   * (CONTRACTS-PHASE2 §6.3).
   *
   * @param {string} path app path, no BASE_PATH
   * @param {string} [tournamentId] defaults to this page's tournament
   * @return {string}
   */
  _adminPath: function (path, tournamentId) {
    const id = String(
      tournamentId === undefined
        ? (AdminPlayersPage._state ? AdminPlayersPage._state.tournamentId : '')
        : (tournamentId || '')
    ).trim();

    if (typeof App !== 'undefined' && App && typeof App.adminPath === 'function') {
      try { return App.adminPath(path, id); } catch (e) { /* fall through */ }
    }
    if (!id) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(id);
  },

  /**
   * @param {string} tournamentId
   * @return {string} the app path for this register
   */
  _playersPath: function (tournamentId) {
    return AdminPlayersPage._adminPath(AdminPlayersPage.PLAYERS_PATH, tournamentId);
  },

  /** Drop any pending debounced search. @return {void} */
  _cancelSearch: function () {
    const state = AdminPlayersPage._state;
    if (state && state.searchTimer) {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
  },

  /* ================================================================== *
   * View 0 — no tournament chosen
   * ================================================================== */

  /**
   * The register is meaningless without a tournament, and guessing one is
   * worse than asking: an admin who withdraws a player from the wrong
   * tournament has made an unrecoverable mistake (CONTRACTS-PHASE2 §6.3).
   * @return {void}
   */
  _renderChooser: function () {
    const state = AdminPlayersPage._state;
    const shell = AdminPlayersPage._shell(
      'Players',
      'Choose the tournament whose register you want to open.'
    );
    state.errors = shell.errors;

    shell.actions.appendChild(AdminPlayersPage._navButton(
      'Back to tournaments', AdminPlayersPage._adminPath(AdminPlayersPage.DASHBOARD_PATH), 'secondary'));

    const box = AdminPlayersPage._el('div');
    box.appendChild(UI.spinner('Loading tournaments…'));
    shell.body.appendChild(box);

    AdminPlayersPage._mount(shell.main);

    AdminPlayersPage._call('tournament.list', {})
      .then(function (rows) {
        if (!AdminPlayersPage._current(state)) return;
        box.textContent = '';

        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) {
          box.appendChild(AdminPlayersPage._el('p', 'admin__empty',
            'There are no tournaments yet. Create one first, then come back ' +
            'here once players have registered.'));
          return;
        }

        const ul = AdminPlayersPage._el('ul', 'players-chooser');
        list.forEach(function (row) {
          const li = AdminPlayersPage._el('li', 'players-chooser__item');
          const link = AdminPlayersPage._navButton(
            String(row.name || '(untitled tournament)'),
            AdminPlayersPage._playersPath(row.tournament_id),
            'secondary');
          link.className += ' players-chooser__link';
          li.appendChild(link);
          li.appendChild(AdminPlayersPage._el('span', 'players-chooser__count',
            AdminPlayersPage._count(row.player_count) + ' registered, ' +
            AdminPlayersPage._count(row.verified_count) + ' verified'));
          ul.appendChild(li);
        });
        box.appendChild(ul);
      })
      .catch(function (err) {
        if (AdminPlayersPage._handled(err) || !AdminPlayersPage._current(state)) return;
        box.textContent = '';
        AdminPlayersPage._showError(shell.errors, err);
      });
  },

  /* ================================================================== *
   * View 1 — the register
   * ================================================================== */

  /**
   * Build the frame once — heading, counts region, filter bar, table region,
   * pager region — then let _load() repaint only the three regions. Rebuilding
   * the filter bar on every fetch would take the focus and the caret out of
   * the search box mid-word, which makes debounced typing unusable.
   * @return {void}
   */
  _renderRegister: function () {
    const state = AdminPlayersPage._state;

    const shell = AdminPlayersPage._shell(
      'Players',
      'Everyone who has registered for this tournament. Serial numbers are ' +
      'permanent: a withdrawn player keeps theirs and it is never reused.'
    );
    state.errors = shell.errors;

    shell.actions.appendChild(AdminPlayersPage._navButton(
      'Back to tournaments', AdminPlayersPage._adminPath(AdminPlayersPage.DASHBOARD_PATH), 'secondary'));
    shell.actions.appendChild(UI.button('Refresh', function () {
      AdminPlayersPage._load();
    }, { variant: 'secondary' }));

    /* Which tournament this register belongs to. app.js's nav says the same
       thing above the panel; it is repeated here because a withdrawal is
       irreversible-looking and the admin should not have to look away from
       the table to check which tournament they are in. The name comes from
       App when it already knows it — never from a second round trip. */
    let scopeName = '';
    if (typeof App !== 'undefined' && App && typeof App.tournamentName === 'function') {
      try { scopeName = String(App.tournamentName(state.tournamentId) || ''); } catch (e) { scopeName = ''; }
    }
    const scope = AdminPlayersPage._el('p', 'players-scope');
    scope.appendChild(AdminPlayersPage._el('span', 'players-scope__label', 'Tournament: '));
    if (scopeName) {
      scope.appendChild(AdminPlayersPage._el('span', 'players-scope__name', scopeName));
      scope.appendChild(document.createTextNode(' '));
    }
    scope.appendChild(AdminPlayersPage._el('span', 'players-scope__id', state.tournamentId));
    shell.body.appendChild(scope);

    state.countsBox = AdminPlayersPage._el('div', 'players-counts-box');
    state.countsBox.setAttribute('aria-live', 'polite');
    shell.body.appendChild(state.countsBox);

    shell.body.appendChild(AdminPlayersPage._buildFilterBar());

    state.tableBox = AdminPlayersPage._el('div', 'players-table-box');
    shell.body.appendChild(state.tableBox);

    state.pagerBox = AdminPlayersPage._el('div', 'players-pager-box');
    shell.body.appendChild(state.pagerBox);

    AdminPlayersPage._mount(shell.main);
    AdminPlayersPage._load();
  },

  /**
   * Search box plus the three filters. Every control here narrows the query
   * the SERVER runs; nothing is filtered in the browser.
   * @return {HTMLElement}
   */
  _buildFilterBar: function () {
    const state = AdminPlayersPage._state;

    const bar = AdminPlayersPage._el('div', 'players-filters');
    bar.setAttribute('role', 'search');

    const search = UI.field({
      label: 'Search',
      name: 'player-search',
      type: 'search',
      hint: 'Serial number, name, mobile or UPI reference. Searching runs on ' +
        'the server, so it waits until you stop typing.'
    });
    search.wrap.className += ' players-filters__search';
    search.input.setAttribute('autocomplete', 'off');
    search.input.setAttribute('autocapitalize', 'none');
    search.input.setAttribute('spellcheck', 'false');

    /* THE DEBOUNCE (CONTRACTS-PHASE2 §6.2 rule 6). Each call is one full
       Repo.readAll(Players) on the server, and Apps Script allows 30
       simultaneous executions in total (DESIGN.md §13). Ten keystrokes must
       become one request, not ten. */
    search.input.addEventListener('input', function () {
      AdminPlayersPage._cancelSearch();
      const typed = String(search.input.value || '');
      state.searchTimer = window.setTimeout(function () {
        state.searchTimer = null;
        if (!AdminPlayersPage._current(state)) return;
        const next = typed.trim();
        if (next === state.filter.search) return;   // nothing actually changed
        state.filter.search = next;
        state.page = 1;                             // a new query starts at page 1
        AdminPlayersPage._load();
      }, AdminPlayersPage.SEARCH_DEBOUNCE_MS);
    });

    // Enter should not wait out the debounce, and must not submit anything.
    search.input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      if (ev.preventDefault) ev.preventDefault();
      AdminPlayersPage._cancelSearch();
      const next = String(search.input.value || '').trim();
      if (next === state.filter.search) return;
      state.filter.search = next;
      state.page = 1;
      AdminPlayersPage._load();
    });

    bar.appendChild(search.wrap);
    state.searchField = search;

    bar.appendChild(AdminPlayersPage._filterSelect('paymentStatus', 'Payment status', [
      { value: '', label: 'Any payment status' },
      { value: 'PENDING', label: 'Pending' },
      { value: 'VERIFIED', label: 'Verified' },
      { value: 'REJECTED', label: 'Rejected' }
    ]));

    bar.appendChild(AdminPlayersPage._filterSelect('auctionStatus', 'Auction status', [
      { value: '', label: 'Any auction status' },
      { value: 'PENDING', label: 'Pending' },
      { value: 'SOLD', label: 'Sold' },
      { value: 'UNSOLD', label: 'Un-sold' }
    ]));

    // Omitting `withdrawn` means "both" (CONTRACTS-PHASE2 §1), so the blank
    // option is a real state and not a placeholder.
    bar.appendChild(AdminPlayersPage._filterSelect('withdrawn', 'Withdrawn', [
      { value: '', label: 'Everyone, withdrawn included' },
      { value: 'false', label: 'Hide withdrawn players' },
      { value: 'true', label: 'Withdrawn players only' }
    ]));

    return bar;
  },

  /**
   * One filter dropdown, wired straight to a re-fetch.
   * @param {string} key key inside state.filter
   * @param {string} label
   * @param {!Array<{value:string,label:string}>} options
   * @return {HTMLElement}
   */
  _filterSelect: function (key, label, options) {
    const state = AdminPlayersPage._state;

    const field = UI.field({
      label: label,
      name: 'filter-' + key,
      type: 'select',
      options: options,
      placeholderOption: ''       // the blank option is one of ours, with words
    });
    field.wrap.className += ' players-filters__select';
    field.input.value = state.filter[key];

    field.input.addEventListener('change', function () {
      state.filter[key] = String(field.input.value || '');
      state.page = 1;             // page 4 of the old filter means nothing now
      AdminPlayersPage._load();
    });

    return field.wrap;
  },

  /* ================================================================== *
   * Fetch
   * ================================================================== */

  /**
   * Assemble the player.list payload from the current state.
   *
   * pageSize is pinned to 50 and the page number is always sent, so there is
   * no code path that can ask the server for the whole tournament.
   *
   * @return {!Object} CONTRACTS-PHASE2 §1 player.list payload
   */
  _payload: function () {
    const state = AdminPlayersPage._state;
    const filter = {};

    if (state.filter.paymentStatus) filter.paymentStatus = state.filter.paymentStatus;
    if (state.filter.auctionStatus) filter.auctionStatus = state.filter.auctionStatus;
    if (state.filter.search) filter.search = state.filter.search;
    // Only an explicit true/false narrows; '' is left out so the server keeps
    // its "both" default.
    if (state.filter.withdrawn === 'true') filter.withdrawn = true;
    else if (state.filter.withdrawn === 'false') filter.withdrawn = false;

    const payload = {
      tournamentId: state.tournamentId,
      filter: filter,
      page: state.page,
      pageSize: AdminPlayersPage.PAGE_SIZE,
      sort: state.sort
    };

    /* sortDir is NOT in the CONTRACTS-PHASE2 §1 payload, but backend
       Players.list reads it and reverses the primary key when it is 'desc'.
       Sent only when the admin has actually asked for the reverse order, so
       an ordinary request stays exactly the documented shape. */
    if (state.sortDir === 'desc') payload.sortDir = 'desc';

    return payload;
  },

  /**
   * Fetch one page and repaint the counts, the table and the pager.
   * @return {!Promise<void>}
   */
  _load: function () {
    const state = AdminPlayersPage._state;
    if (!state || !state.tableBox) return Promise.resolve();

    const req = ++state.req;
    AdminPlayersPage._clearError(state.errors);

    state.tableBox.textContent = '';
    state.tableBox.appendChild(UI.spinner('Loading players…'));

    return AdminPlayersPage._call('player.list', AdminPlayersPage._payload())
      .then(function (data) {
        // Stale reply: a later request has already been sent, so painting
        // this one would show the previous filter's rows.
        if (!AdminPlayersPage._current(state) || req !== state.req) return;
        state.last = data || {};
        AdminPlayersPage._paint(state.last);
      })
      .catch(function (err) {
        if (AdminPlayersPage._handled(err) || !AdminPlayersPage._current(state)) return;
        if (req !== state.req) return;
        state.tableBox.textContent = '';
        state.pagerBox.textContent = '';
        AdminPlayersPage._showError(state.errors, err);
      });
  },

  /**
   * @param {!Object} data player.list response
   * @return {void}
   */
  _paint: function (data) {
    const state = AdminPlayersPage._state;

    AdminPlayersPage._paintCounts(data.counts || {});

    state.tableBox.textContent = '';
    const rows = Array.isArray(data.rows) ? data.rows : [];

    if (!rows.length) {
      state.tableBox.appendChild(AdminPlayersPage._emptyState(data));
    } else {
      state.tableBox.appendChild(AdminPlayersPage._table(rows));
    }

    AdminPlayersPage._paintPager(data);
  },

  /* ================================================================== *
   * Header counts — CONTRACTS-PHASE2 §3, §6.2 rule 5
   * ================================================================== */

  /**
   * The whole-tournament counts, never the page's. The admin needs "42 still
   * pending" while looking at page 1 of 8.
   *
   * `eligible` leads, and is labelled so it cannot be mistaken for a total:
   * it is the §2 predicate (verified and not withdrawn), which is the number
   * of players the auction will actually see.
   *
   * @param {!Object} counts
   * @return {void}
   */
  _paintCounts: function (counts) {
    const state = AdminPlayersPage._state;
    const box = state.countsBox;
    box.textContent = '';

    const list = AdminPlayersPage._el('ul', 'players-counts');

    AdminPlayersPage.COUNT_TILES.forEach(function (tile) {
      const li = AdminPlayersPage._el('li',
        'players-count' + (tile.headline ? ' players-count--headline' : ''));

      const value = counts[tile.key];
      li.appendChild(AdminPlayersPage._el('span', 'players-count__value',
        (value === null || value === undefined || value === '')
          ? '—'
          : AdminPlayersPage._count(value)));
      li.appendChild(AdminPlayersPage._el('span', 'players-count__label', tile.label));
      if (tile.note) {
        li.appendChild(AdminPlayersPage._el('span', 'players-count__note', tile.note));
      }
      list.appendChild(li);
    });

    box.appendChild(list);
  },

  /* ================================================================== *
   * The table
   * ================================================================== */

  /**
   * @param {!Array<!Object>} rows one page of player.list rows
   * @return {HTMLElement}
   */
  _table: function (rows) {
    const wrap = AdminPlayersPage._el('div', 'players-table__scroll');
    wrap.setAttribute('tabindex', '0');          // a scroll region needs to be
    wrap.setAttribute('role', 'region');         // reachable from a keyboard
    wrap.setAttribute('aria-label', 'Registered players');

    const table = AdminPlayersPage._el('table', 'admin-table players-table');

    const caption = AdminPlayersPage._el('caption', 'visually-hidden',
      'Registered players. Serial number, name, date of birth, role, style, ' +
      'mobile, UPI reference, payment status, registration date and auction ' +
      'status, with a withdraw action for each player.');
    table.appendChild(caption);

    table.appendChild(AdminPlayersPage._thead());

    const tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      tbody.appendChild(AdminPlayersPage._row(row));
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  },

  /**
   * The header row. A sortable column is a real <button> inside the <th>, so
   * it is reachable by keyboard and announced as a control; aria-sort tells a
   * screen reader which column the SERVER ordered by.
   * @return {HTMLElement}
   */
  _thead: function () {
    const state = AdminPlayersPage._state;

    const thead = document.createElement('thead');
    const tr = document.createElement('tr');

    AdminPlayersPage.COLUMNS.forEach(function (col) {
      const th = AdminPlayersPage._el('th', 'players-table__' + col.cls);
      th.scope = 'col';

      if (!col.sort) {
        th.textContent = col.label;
        tr.appendChild(th);
        return;
      }

      const active = state.sort === col.sort;
      th.setAttribute('aria-sort', active
        ? (state.sortDir === 'desc' ? 'descending' : 'ascending')
        : 'none');

      const btn = AdminPlayersPage._el('button', 'players-sort');
      btn.type = 'button';
      btn.appendChild(AdminPlayersPage._el('span', 'players-sort__label', col.label));

      // The arrow is decoration; the word after it is what carries meaning.
      const mark = AdminPlayersPage._el('span', 'players-sort__mark',
        active ? (state.sortDir === 'desc' ? '▼' : '▲') : '↕');
      mark.setAttribute('aria-hidden', 'true');
      btn.appendChild(mark);
      btn.appendChild(AdminPlayersPage._el('span', 'visually-hidden',
        active
          ? (state.sortDir === 'desc'
            ? ' (sorted last to first; activate to sort first to last)'
            : ' (sorted first to last; activate to reverse)')
          : ' (activate to sort by this column)'));

      btn.addEventListener('click', function () {
        AdminPlayersPage._sortBy(col.sort);
      });

      th.appendChild(btn);
      tr.appendChild(th);
    });

    const actions = AdminPlayersPage._el('th', 'players-table__actions', 'Actions');
    actions.scope = 'col';
    tr.appendChild(actions);

    thead.appendChild(tr);
    return thead;
  },

  /**
   * Change the order. The SERVER sorts — the whole point of paging server-side
   * is that page 1 of a name sort is not the same 50 rows as page 1 of a
   * serial sort, so this re-fetches rather than reordering what is on screen.
   *
   * @param {string} key one of the four keys player.list accepts
   * @return {void}
   */
  _sortBy: function (key) {
    const state = AdminPlayersPage._state;

    // Defensive: the buttons are built from COLUMNS, so this can only fire if
    // something else went wrong — and an unknown key is VALIDATION_FAILED.
    let allowed = false;
    AdminPlayersPage.COLUMNS.forEach(function (col) {
      if (col.sort === key) allowed = true;
    });
    if (!allowed) return;

    if (state.sort === key) {
      state.sortDir = (state.sortDir === 'desc') ? 'asc' : 'desc';
    } else {
      state.sort = key;
      state.sortDir = 'asc';
    }
    state.page = 1;
    AdminPlayersPage._cancelSearch();
    AdminPlayersPage._load();
  },

  /**
   * One player.
   *
   * Every value goes in as textContent. `screenshot_file_id` is deliberately
   * not in the response and must never be rendered here (CONTRACTS-PHASE2 §1)
   * — the payment screenshot belongs to /admin/payments, one at a time.
   *
   * @param {!Object} row a player.list row
   * @return {HTMLElement}
   */
  _row: function (row) {
    const tr = AdminPlayersPage._el('tr', 'players-row');
    const withdrawn = row.is_withdrawn === true;
    if (withdrawn) tr.className += ' players-row--withdrawn';

    /* Serial No — the row's identity, so it is the row header and the column
       that stays put when the table scrolls sideways on a phone. */
    const serial = AdminPlayersPage._el('th', 'players-table__serial');
    serial.scope = 'row';
    serial.appendChild(AdminPlayersPage._el('span', 'players-serial',
      AdminPlayersPage._count(row.serial_no)));
    tr.appendChild(serial);

    /* Name, with the 320px thumbnail beside it. */
    const nameCell = AdminPlayersPage._el('td', 'players-table__name');
    const nameRow = AdminPlayersPage._el('div', 'players-name');
    nameRow.appendChild(AdminPlayersPage._thumb(row));

    const nameText = AdminPlayersPage._el('div', 'players-name__text');
    nameText.appendChild(AdminPlayersPage._el('span', 'players-name__value',
      String(row.name || '(no name)')));
    if (withdrawn) {
      // A word, not a colour: this row is still in the register but out of
      // the auction (DESIGN.md §15 case 16).
      const flag = AdminPlayersPage._el('span', 'badge players-withdrawn', 'Withdrawn');
      flag.title = 'Withdrawn. The serial number stays reserved and is never reused.';
      nameText.appendChild(flag);
    }
    nameRow.appendChild(nameText);
    nameCell.appendChild(nameRow);
    tr.appendChild(nameCell);

    /* DOB. A bare YYYY-MM-DD is an IST calendar day and is printed exactly as
       stored — never re-parsed in the browser, which is how a date slides by
       one day (CONTRACTS.md §6a). Age comes from the server. */
    const dob = AdminPlayersPage._el('td', 'players-table__dob');
    dob.appendChild(AdminPlayersPage._el('span', 'players-dob__date',
      row.dob ? String(row.dob) : '—'));
    const age = Number(row.age_years);
    if (isFinite(age) && age > 0) {
      dob.appendChild(AdminPlayersPage._el('span', 'players-dob__age', 'Age ' + age));
    }
    tr.appendChild(dob);

    tr.appendChild(AdminPlayersPage._cell('role',
      AdminPlayersPage._label(AdminPlayersPage.ROLE_LABEL, row.role)));
    tr.appendChild(AdminPlayersPage._cell('style',
      AdminPlayersPage._label(AdminPlayersPage.STYLE_LABEL, row.style)));

    const mobile = AdminPlayersPage._cell('mobile', row.mobile ? String(row.mobile) : '—');
    mobile.className += ' players-mono';
    tr.appendChild(mobile);

    /* UPI reference — the string an admin compares against a bank statement,
       so it is monospace here too, exactly as on the payment queue. */
    const upi = AdminPlayersPage._cell('upi', row.upi_ref ? String(row.upi_ref) : '—');
    upi.className += ' players-mono';
    tr.appendChild(upi);

    const payment = AdminPlayersPage._el('td', 'players-table__payment');
    payment.appendChild(AdminPlayersPage._statusPill(
      row.payment_status, AdminPlayersPage.PAYMENT_LABEL, AdminPlayersPage.PAYMENT_CLASS));
    tr.appendChild(payment);

    // The server pre-formats this one (registered_at_display); reformatting a
    // UTC instant in a browser that may not be in IST is how the date drifts.
    tr.appendChild(AdminPlayersPage._cell('registered',
      row.registered_at_display
        ? String(row.registered_at_display)
        : (row.registered_at ? String(row.registered_at) : '—')));

    const auction = AdminPlayersPage._el('td', 'players-table__auction');
    auction.appendChild(AdminPlayersPage._statusPill(
      row.auction_status, AdminPlayersPage.AUCTION_LABEL, AdminPlayersPage.AUCTION_CLASS));
    tr.appendChild(auction);

    tr.appendChild(AdminPlayersPage._actionsCell(row));
    return tr;
  },

  /**
   * @param {string} cls column class suffix
   * @param {string} text
   * @return {HTMLElement}
   */
  _cell: function (cls, text) {
    return AdminPlayersPage._el('td', 'players-table__' + cls,
      (text === null || text === undefined || text === '') ? '—' : String(text));
  },

  /**
   * The 320 px thumbnail the server already stores a URL for. Lazy, because
   * 50 rows means 50 images and a page that fetches all of them at once is
   * slower than the sheet read that produced it (DESIGN.md §14).
   *
   * @param {!Object} row
   * @return {HTMLElement}
   */
  _thumb: function (row) {
    const url = AdminPlayersPage._safeUrl(row.photo_thumb_url);
    if (!url) {
      const none = AdminPlayersPage._el('span', 'players-thumb players-thumb--none');
      none.setAttribute('aria-hidden', 'true');
      none.textContent = '—';
      return none;
    }

    const img = AdminPlayersPage._el('img', 'players-thumb');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.width = 40;
    img.height = 40;
    // Decorative: the name is right next to it, so a screen reader announcing
    // "photo of X" after reading X is noise.
    img.alt = '';
    img.src = url;
    return img;
  },

  /**
   * Only http(s) URLs reach an attribute. The value comes from a sheet, and
   * an attribute is the one place textContent cannot protect us.
   * @param {*} value
   * @return {string} the URL, or '' when it is not one we will render
   */
  _safeUrl: function (value) {
    const url = String(value === null || value === undefined ? '' : value).trim();
    return /^https?:\/\//i.test(url) ? url : '';
  },

  /**
   * A status pill: the WORD is the signal, the shape comes from the ::before
   * in app.css section 7, and the colour is the third signal, not the first
   * (DESIGN.md §8/§51).
   *
   * @param {*} value the raw enum value
   * @param {!Object<string,string>} labels
   * @param {!Object<string,string>} classes
   * @return {HTMLElement}
   */
  _statusPill: function (value, labels, classes) {
    const key = String(value === null || value === undefined ? '' : value).toUpperCase();
    const known = Object.prototype.hasOwnProperty.call(labels, key);
    const span = AdminPlayersPage._el('span',
      'status ' + (known ? classes[key] : 'status--unknown'));
    // An unrecognised value is shown as itself rather than hidden or guessed.
    span.textContent = known ? labels[key] : (key || 'Unknown');
    return span;
  },

  /**
   * @param {!Object<string,string>} map
   * @param {*} value
   * @return {string}
   */
  _label: function (map, value) {
    const key = String(value === null || value === undefined ? '' : value).toUpperCase();
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : (key || '—');
  },

  /* ================================================================== *
   * Withdrawal — CONTRACTS-PHASE2 §1, DESIGN.md §9 / §15 case 16
   * ================================================================== */

  /**
   * @param {!Object} row
   * @return {HTMLElement}
   */
  _actionsCell: function (row) {
    const td = AdminPlayersPage._el('td', 'players-table__actions');
    const withdrawn = row.is_withdrawn === true;

    // A per-row live region, so a refusal is announced next to the row it is
    // about rather than only at the top of the page.
    const note = AdminPlayersPage._el('div', 'players-row__note');
    note.setAttribute('aria-live', 'polite');

    const btn = UI.button(
      withdrawn ? 'Cancel withdrawal' : 'Withdraw',
      function () {
        return AdminPlayersPage._toggleWithdrawn(row, !withdrawn, note);
      },
      { variant: 'secondary', busyLabel: withdrawn ? 'Restoring…' : 'Withdrawing…' }
    );
    btn.className += ' btn--small players-action';

    td.appendChild(btn);
    td.appendChild(note);
    return td;
  },

  /**
   * Confirm, then call player.setWithdrawn.
   *
   * The confirmation names the player AND says, in those words, that the
   * serial number stays reserved and is never reused (DESIGN.md §9). An admin
   * who believes #27 has been freed will hand it to somebody else on paper,
   * and then two people answer to the same number at the auction table.
   *
   * The button is NOT hidden for a SOLD player. The server refuses that case
   * with a message explaining that the sale has to be unwound through the
   * correction flow — and the reason is the useful part. A missing button
   * teaches nobody anything.
   *
   * @param {!Object} row
   * @param {boolean} withdrawn the state being asked for
   * @param {HTMLElement} note the per-row live region
   * @return {!Promise<void>}
   */
  _toggleWithdrawn: function (row, withdrawn, note) {
    const state = AdminPlayersPage._state;
    const name = String(row.name || 'this player');
    const serial = AdminPlayersPage._count(row.serial_no);

    const ask = withdrawn
      ? UI.confirmDialog({
        title: 'Withdraw ' + name + '?',
        body: 'Serial number ' + serial + ' stays reserved for ' + name +
          ' and is never reused, so nobody else can be given it. ' + name +
          ' will be left out of the auction, and the registration, the ' +
          'photo and the payment record all stay exactly as they are. ' +
          'This is recorded in the audit log. You can undo it here.',
        confirmLabel: 'Withdraw ' + name,
        cancelLabel: 'Keep in the auction',
        danger: true
      })
      : UI.confirmDialog({
        title: 'Put ' + name + ' back?',
        body: name + ' keeps serial number ' + serial + ' — it was reserved ' +
          'the whole time and was never reused. Once the payment is verified, ' +
          name + ' returns to the auction pool. This is recorded in the audit log.',
        confirmLabel: 'Put ' + name + ' back',
        cancelLabel: 'Leave withdrawn'
      });

    return ask.then(function (yes) {
      if (!yes || !AdminPlayersPage._current(state)) return null;

      note.textContent = '';
      AdminPlayersPage._clearError(state.errors);

      return AdminPlayersPage._call('player.setWithdrawn', {
        playerId: String(row.player_id || ''),
        withdrawn: withdrawn
      }).then(function () {
        if (!AdminPlayersPage._current(state)) return null;
        // Counts and the eligible number both move, and the row may drop out
        // of the current filter, so re-read the page rather than patch a cell.
        return AdminPlayersPage._load();
      });
    }).catch(function (err) {
      if (AdminPlayersPage._handled(err) || !AdminPlayersPage._current(state)) return;

      // Surface the server's own words. For a SOLD player that message names
      // the correction screen and explains what withdrawing would break.
      const message = (err && err.message)
        ? String(err.message)
        : 'That could not be changed. Please try again.';

      note.textContent = '';
      note.appendChild(UI.banner('error', message));
      AdminPlayersPage._showError(state.errors,
        'Serial ' + serial + ' (' + name + '): ' + message);
    });
  },

  /* ================================================================== *
   * Empty states — CONTRACTS-PHASE2 §6.2, rule 10 of the brief
   * ================================================================== */

  /**
   * Never an empty table. A blank grid reads as a failed load, and the three
   * reasons a page can be empty need three different actions.
   *
   * @param {!Object} data the player.list response
   * @return {HTMLElement}
   */
  _emptyState: function (data) {
    const state = AdminPlayersPage._state;
    const counts = data.counts || {};
    const total = Number(data.total) || 0;
    const page = Number(data.page) || state.page;
    const totalPages = Number(data.totalPages) || 0;

    const box = AdminPlayersPage._el('div', 'admin__empty players-empty');

    // 1. Nobody has registered at all.
    if (!Number(counts.all)) {
      box.appendChild(AdminPlayersPage._el('p', 'players-empty__title',
        'No players have registered for this tournament yet.'));
      box.appendChild(AdminPlayersPage._el('p', 'players-empty__note',
        'Registrations appear here the moment they arrive. Share the ' +
        'registration link from the tournament screen, and check that ' +
        'registration is open.'));
      box.appendChild(AdminPlayersPage._navButton(
        'Back to tournaments', AdminPlayersPage._adminPath(AdminPlayersPage.DASHBOARD_PATH), 'secondary'));
      return box;
    }

    // 2. The page is past the end — usually a bookmark from before a filter
    //    narrowed the list. The server sends the real totals with the empty
    //    slice, so we can say exactly where to go.
    if (total > 0 && page > 1 && page > totalPages) {
      box.appendChild(AdminPlayersPage._el('p', 'players-empty__title',
        'Page ' + page + ' does not exist.'));
      box.appendChild(AdminPlayersPage._el('p', 'players-empty__note',
        'This search has ' + total + ' player' + (total === 1 ? '' : 's') +
        ' on ' + totalPages + ' page' + (totalPages === 1 ? '' : 's') + '.'));
      box.appendChild(UI.button('Go to page 1', function () {
        state.page = 1;
        AdminPlayersPage._load();
      }, { variant: 'secondary' }));
      return box;
    }

    // 3. The filters match nobody.
    box.appendChild(AdminPlayersPage._el('p', 'players-empty__title',
      'No player matches this search.'));
    const registered = Number(counts.all) || 0;
    box.appendChild(AdminPlayersPage._el('p', 'players-empty__note',
      AdminPlayersPage._filterSummary() +
      ' There ' + (registered === 1 ? 'is 1 player' : 'are ' + registered + ' players') +
      ' registered in total.'));

    if (AdminPlayersPage._hasFilters()) {
      box.appendChild(UI.button('Clear the search and filters', function () {
        AdminPlayersPage._resetFilters();
      }, { variant: 'secondary' }));
    }
    return box;
  },

  /**
   * @return {boolean} true when anything is narrowing the list
   */
  _hasFilters: function () {
    const f = AdminPlayersPage._state.filter;
    return !!(f.paymentStatus || f.auctionStatus || f.withdrawn || f.search);
  },

  /**
   * Say back exactly what was asked for, so "no results" is never a mystery.
   * @return {string}
   */
  _filterSummary: function () {
    const f = AdminPlayersPage._state.filter;
    const parts = [];
    if (f.search) parts.push('search "' + f.search + '"');
    if (f.paymentStatus) {
      parts.push('payment ' + AdminPlayersPage._label(AdminPlayersPage.PAYMENT_LABEL, f.paymentStatus).toLowerCase());
    }
    if (f.auctionStatus) {
      parts.push('auction ' + AdminPlayersPage._label(AdminPlayersPage.AUCTION_LABEL, f.auctionStatus).toLowerCase());
    }
    if (f.withdrawn === 'true') parts.push('withdrawn players only');
    if (f.withdrawn === 'false') parts.push('withdrawn players hidden');

    if (!parts.length) return 'No filters are set.';
    return 'Filters: ' + parts.join(', ') + '.';
  },

  /**
   * Clear every filter, put the controls back to their blank option, refetch.
   * @return {void}
   */
  _resetFilters: function () {
    const state = AdminPlayersPage._state;
    state.filter = { paymentStatus: '', auctionStatus: '', withdrawn: '', search: '' };
    state.page = 1;
    AdminPlayersPage._cancelSearch();

    if (state.searchField) state.searchField.input.value = '';
    const selects = App.root.querySelectorAll ? App.root.querySelectorAll('select') : [];
    for (let i = 0; i < selects.length; i++) {
      if (String(selects[i].name || '').indexOf('filter-') === 0) selects[i].value = '';
    }

    AdminPlayersPage._load();
  },

  /* ================================================================== *
   * Pager
   * ================================================================== */

  /**
   * Previous / next plus an honest "page 2 of 8, 400 players". Both buttons
   * send a page NUMBER to the server; neither ever asks for everything.
   *
   * @param {!Object} data the player.list response
   * @return {void}
   */
  _paintPager: function (data) {
    const state = AdminPlayersPage._state;
    const box = state.pagerBox;
    box.textContent = '';

    const total = Number(data.total) || 0;
    const page = Number(data.page) || state.page;
    const totalPages = Number(data.totalPages) || 0;
    const pageSize = Number(data.pageSize) || AdminPlayersPage.PAGE_SIZE;
    const shown = Array.isArray(data.rows) ? data.rows.length : 0;

    if (!total) return;

    const bar = AdminPlayersPage._el('div', 'players-pager');

    const prev = UI.button('Previous page', function () {
      if (state.page <= 1) return;
      state.page -= 1;
      AdminPlayersPage._load();
    }, { variant: 'secondary' });
    prev.disabled = page <= 1;
    bar.appendChild(prev);

    const first = shown ? ((page - 1) * pageSize) + 1 : 0;
    const last = shown ? first + shown - 1 : 0;

    const status = AdminPlayersPage._el('p', 'players-pager__status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = shown
      ? ('Showing ' + first + '–' + last + ' of ' + total +
         ' · page ' + page + ' of ' + totalPages)
      : ('No rows on page ' + page + ' of ' + totalPages + ' · ' + total + ' in total');
    bar.appendChild(status);

    const next = UI.button('Next page', function () {
      if (state.page >= totalPages) return;
      state.page += 1;
      AdminPlayersPage._load();
    }, { variant: 'secondary' });
    next.disabled = page >= totalPages;
    bar.appendChild(next);

    box.appendChild(bar);

    box.appendChild(AdminPlayersPage._el('p', 'players-pager__note',
      'Loaded ' + AdminPlayersPage.PAGE_SIZE + ' players at a time from the ' +
      'server. Filters, search and sorting are applied there, across the ' +
      'whole tournament — not just this page.'));
  },

  /* ================================================================== *
   * Small helpers
   * ================================================================== */

  /**
   * @param {*} n
   * @return {string}
   */
  _count: function (n) {
    const v = Number(n);
    return isFinite(v) ? String(v) : '0';
  }
};
