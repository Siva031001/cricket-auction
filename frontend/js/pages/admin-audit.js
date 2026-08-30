/**
 * admin-audit.js — the /admin/audit screen. `AdminAuditPage`.
 *
 * THE DISPUTE-SETTLING SCREEN (DESIGN.md §42, CONTRACTS-PHASE4-7 PHASE 7 §1).
 * Three months after the tournament somebody says "I paid" or "that player
 * was ours". This page is where the answer is: who did what, when, and what
 * the value was before and after.
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE4-7 PHASE 7 §1   audit.list payload and response shape
 *   CONTRACTS-PHASE1 §4             textContent only, vanilla JS, data-route
 *   CONTRACTS.md §15                every call through API, never fetch
 *   CONTRACTS.md §6a                instants are printed from the server's
 *                                   timestamp_display (IST) and never
 *                                   re-parsed in a browser of unknown zone
 *
 * Five decisions that are not style choices:
 *
 * 1. THERE IS NO EDIT CONTROL AND NO DELETE CONTROL ON THIS PAGE, AND THERE
 *    NEVER MAY BE. backend/Reports.gs says the same thing at its own top:
 *    the AuditLog tab is append-only evidence, and evidence that can be
 *    edited from the very screen being disputed is not evidence. There is no
 *    audit.update, no audit.delete and no audit.correct action to call even
 *    if a control existed. The page says this out loud, because an admin who
 *    does not know the log is tamper-proof will not think to trust it.
 *
 * 2. THE SERVER PAGES AND FILTERS, NOT THE BROWSER. One page of 50 rows is
 *    ever in memory. An audit tab grows without limit — it is the one tab
 *    nothing ever deletes from — so pulling it all to filter locally gets
 *    slower every week until it stops working (DESIGN.md §14).
 *
 * 3. FREE TEXT IS DEBOUNCED BY 300 ms. Every call is a full
 *    Repo.readAll(AuditLog) plus Repo.readAll(Users) on the server. Typing
 *    "priya" is five complete reads of an ever-growing tab unless the
 *    keystrokes are collapsed into one request.
 *
 * 4. prev_value / new_value ARE RENDERED AS A FIELD-BY-FIELD DIFF, NOT AS
 *    JSON. The server has already parsed them (Reports._auditRow). This is
 *    read under time pressure, out loud, by someone settling an argument in
 *    front of the person arguing; "purse_used: ₹4,00,000 → ₹5,25,000" is
 *    usable and {"purse_used":525000,...} is not.
 *
 * 5. FOUR ACTIONS ARE MARKED AS DISPUTE EVIDENCE. PAYMENT_VERIFIED,
 *    PAYMENT_REJECTED, PLAYER_SOLD and AUCTION_CORRECTED are the entries an
 *    argument is actually about. They get a word and a border, never a
 *    colour alone (DESIGN.md §8/§51).
 *
 * WHICH TOURNAMENT? audit.list accepts a blank tournamentId and then reports
 * across every tournament on the instance, which is genuinely useful here —
 * a LOGIN_FAILED run or an ORGANISER_CREATED entry is not scoped to one
 * tournament. So the tournament is a FILTER on this page rather than a hard
 * scope: it defaults to App.currentTournamentId(ctx) when app.js has one, and
 * "All tournaments" is a real, selectable option.
 */

/* eslint-disable no-unused-vars */
const AdminAuditPage = {

  LOGIN_PATH: '/admin/login',
  AUDIT_PATH: '/admin/audit',
  DASHBOARD_PATH: '/admin/dashboard',

  /** Rows per request. The server caps at 200 (REPORT_AUDIT_PAGE_MAX). */
  PAGE_SIZE: 50,

  /** Milliseconds. Same figure as the register's search box. */
  FILTER_DEBOUNCE_MS: 300,

  /**
   * The entries a dispute is actually about (DESIGN.md §42, §43).
   * Marked with a word and a border, never a colour on its own.
   * @const {!Array<string>}
   */
  KEY_ACTIONS: Object.freeze([
    'PAYMENT_VERIFIED',
    'PAYMENT_REJECTED',
    'PLAYER_SOLD',
    'AUCTION_CORRECTED'
  ]),

  /**
   * Field names whose numeric value is whole rupees, so it is shown through
   * UI.money rather than as a bare integer. Money in an audit entry is the
   * thing people argue about; "525000" invites a miscount out loud.
   * @const {!RegExp}
   */
  MONEY_KEY: /(^|[._])(amount|purse|purse_total|purse_used|purse_remaining|sold_amount|reg_fee|total_spent|spent|price)$/i,

  /** Never render more than this many changed fields for one entry. */
  MAX_CHANGE_ROWS: 24,

  /** Longest value printed in full; the rest goes in the title attribute. */
  MAX_VALUE_CHARS: 180,

  /**
   * Thrown by _call() after it has already handled an expired session. A
   * caller that sees this must render nothing — the page is being replaced.
   * @const
   */
  REDIRECTED: Object.freeze({ code: 'REDIRECTED', message: '' }),

  /**
   * The columns, in the order they are read aloud when settling an argument:
   * when, who, what, which record, and what actually changed.
   * @const {!Array<{key:string, label:string, cls:string}>}
   */
  COLUMNS: Object.freeze([
    { key: 'time',    label: 'Time (IST)',       cls: 'time' },
    { key: 'actor',   label: 'Actor',            cls: 'actor' },
    { key: 'action',  label: 'Action',           cls: 'action' },
    { key: 'entity',  label: 'Record',           cls: 'entity' },
    { key: 'changes', label: 'Before → after',   cls: 'changes' }
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
    document.body.dataset.route = 'admin-audit';

    AdminAuditPage._cancelDebounce();

    const gen = ++AdminAuditPage._gen;
    const query = (ctx && ctx.query) || {};

    // No token at all: do not flash an empty log, just go and sign in.
    if (!API.getToken()) {
      Router.navigate(AdminAuditPage.LOGIN_PATH, { replace: true });
      return;
    }

    AdminAuditPage._state = {
      gen: gen,
      page: 1,
      filter: {
        tournamentId: AdminAuditPage._tournamentId(ctx, query),
        action: '',
        actor: '',
        from: '',
        to: ''
      },
      debounceTimer: null,
      /** Bumped per request so a slow earlier reply cannot paint over a
          later one — with a 300 ms debounce, out-of-order replies are normal. */
      req: 0,
      last: null,
      /** The action list currently rendered in the dropdown, joined. */
      actionOptions: '',
      errors: null,
      tableBox: null,
      pagerBox: null,
      actionField: null,
      actorField: null,
      tournamentField: null,
      fromField: null,
      toField: null
    };

    AdminAuditPage._renderShell(ctx);
    AdminAuditPage._loadTournaments();
    AdminAuditPage._load();
  },

  /* ================================================================== *
   * Shared plumbing (same shape as admin-players.js)
   * ================================================================== */

  /**
   * Every backend call on this page goes through here.
   *
   * ONE place handles an expired session. A 12-hour session (CONTRACTS.md §7
   * rule 3) will expire under an admin who left the log open overnight, and
   * it can happen on the list call or on the tournament lookup. Handling it
   * per call site means two chances to forget one.
   *
   * @param {string} action
   * @param {Object} [payload]
   * @return {!Promise<*>} rejects with AdminAuditPage.REDIRECTED once the
   *         session is gone and navigation has already been started.
   */
  _call: function (action, payload) {
    return API.call(action, payload || {}).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        API.clearToken();
        Router.navigate(AdminAuditPage.LOGIN_PATH, { replace: true });
        throw AdminAuditPage.REDIRECTED;
      }
      throw err;
    });
  },

  /**
   * @param {*} err
   * @return {boolean} true when _call has already navigated away
   */
  _handled: function (err) {
    return err === AdminAuditPage.REDIRECTED;
  },

  /**
   * @param {Object} state the state captured when the view was built
   * @return {boolean} true when this view is still the one on screen
   */
  _current: function (state) {
    return !!state && state.gen === AdminAuditPage._gen;
  },

  /**
   * createElement with a class and text in one call. textContent only — an
   * audit value carries player names and rejection reasons typed by the
   * public, and one of 400 people will eventually type something that looks
   * like markup (CONTRACTS-PHASE1.md §4 rule 1).
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
   * @param {string} text
   * @return {HTMLElement} text only a screen reader gets
   */
  _sr: function (text) {
    return AdminAuditPage._el('span', 'visually-hidden', text);
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
    const a = AdminAuditPage._el('a', 'btn' + (variant === 'secondary' ? ' btn--secondary' : ''));
    a.href = Router.href(path);      // Router's click handler turns this into pushState
    a.textContent = label;
    return a;
  },

  /**
   * Which tournament the filter starts on.
   *
   * app.js owns the selection and exposes App.currentTournamentId(ctx) as the
   * single place the sanitising happens; the query-string fallback below only
   * matters if this page is mounted by a shell that predates it, and it
   * accepts the older spellings so an old bookmark still opens the right log.
   *
   * @param {Object} ctx router context
   * @param {!Object<string,string>} query ctx.query, already defaulted
   * @return {string} a tournament id, or '' for "all tournaments"
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
   * @param {string} path app path, no BASE_PATH
   * @param {string} [tournamentId] defaults to the current filter
   * @return {string}
   */
  _adminPath: function (path, tournamentId) {
    const id = String(
      tournamentId === undefined
        ? (AdminAuditPage._state ? AdminAuditPage._state.filter.tournamentId : '')
        : (tournamentId || '')
    ).trim();

    if (typeof App !== 'undefined' && App && typeof App.adminPath === 'function') {
      try { return App.adminPath(path, id); } catch (e) { /* fall through */ }
    }
    if (!id) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(id);
  },

  /** Drop any pending debounced fetch. @return {void} */
  _cancelDebounce: function () {
    const state = AdminAuditPage._state;
    if (state && state.debounceTimer) {
      window.clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
  },

  /* ================================================================== *
   * The frame
   * ================================================================== */

  /**
   * Build the frame once — heading, the append-only notice, the filter bar,
   * a table region and a pager region — then let _load() repaint only the
   * two regions. Rebuilding the filter bar on every fetch would take the
   * caret out of the actor box mid-word, which makes debounced typing
   * unusable.
   *
   * @param {Object} ctx router context, passed to the shared admin nav
   * @return {void}
   */
  _renderShell: function (ctx) {
    const state = AdminAuditPage._state;

    document.title = 'Audit log · Cricket Auction';

    const main = AdminAuditPage._el('main', 'panel admin audit');

    // app.js builds the nav, this page decides where it sits. Asking for it
    // takes ownership, so app.js stops mounting its own copy above #app.
    if (typeof App !== 'undefined' && App && typeof App.adminNav === 'function') {
      try {
        const nav = App.adminNav('audit', ctx);
        if (nav) main.appendChild(nav);
      } catch (e) { /* the nav is chrome; never let it stop the log rendering */ }
    }

    const head = AdminAuditPage._el('div', 'admin__head');
    const heading = AdminAuditPage._el('div');
    heading.appendChild(AdminAuditPage._el('h1', 'panel__title', 'Audit log'));
    heading.appendChild(AdminAuditPage._el('p', 'panel__note',
      'Every recorded change, newest first, with the value before and after. ' +
      'This is what settles "I paid" and "that player was ours" months later.'));
    head.appendChild(heading);

    const actions = AdminAuditPage._el('div', 'admin__actions');
    actions.appendChild(AdminAuditPage._navButton(
      'Back to tournaments', AdminAuditPage._adminPath(AdminAuditPage.DASHBOARD_PATH), 'secondary'));
    actions.appendChild(UI.button('Refresh', function () {
      AdminAuditPage._cancelDebounce();
      AdminAuditPage._load();
    }, { variant: 'secondary' }));
    head.appendChild(actions);
    main.appendChild(head);

    /* THE POINT OF THE WHOLE SCREEN, said once, in one line, at the top.
       An admin who does not know the log cannot be altered will not think to
       trust it, and the other party to the argument certainly will not. */
    const notice = UI.banner('info',
      'Append-only evidence: entries are written as changes happen and nothing ' +
      'in this app can alter or remove one — there is deliberately no edit or ' +
      'delete control anywhere on this page.');
    notice.className += ' audit-notice';
    main.appendChild(notice);

    // Permanent live region: errors replace its contents rather than being
    // inserted, which is what makes them announced reliably.
    state.errors = AdminAuditPage._el('div', 'admin__errors');
    state.errors.setAttribute('aria-live', 'assertive');
    state.errors.setAttribute('aria-atomic', 'true');
    main.appendChild(state.errors);

    const body = AdminAuditPage._el('div', 'admin__body');
    body.appendChild(AdminAuditPage._buildFilterBar());

    state.tableBox = AdminAuditPage._el('div', 'audit-table-box');
    state.tableBox.setAttribute('aria-live', 'polite');
    state.tableBox.setAttribute('aria-busy', 'false');
    body.appendChild(state.tableBox);

    state.pagerBox = AdminAuditPage._el('div', 'audit-pager-box');
    body.appendChild(state.pagerBox);

    main.appendChild(body);

    if (!App.root) App.root = document.getElementById('app');
    App.root.textContent = '';
    App.root.appendChild(main);
  },

  /**
   * The five filters. Every control here narrows the query the SERVER runs;
   * nothing is filtered in the browser.
   * @return {HTMLElement}
   */
  _buildFilterBar: function () {
    const state = AdminAuditPage._state;

    const bar = AdminAuditPage._el('div', 'audit-filters');
    bar.setAttribute('role', 'search');

    /* ---- tournament ------------------------------------------------ */
    // A real option, not a placeholder: LOGIN_FAILED and ORGANISER_CREATED
    // belong to no tournament, and hiding them by default would hide exactly
    // the entries a "somebody got into my account" question is about.
    const tournament = UI.field({
      label: 'Tournament',
      name: 'audit-tournament',
      type: 'select',
      options: [{ value: '', label: 'All tournaments' }],
      placeholderOption: ''
    });
    tournament.wrap.className += ' audit-filters__select';
    if (state.filter.tournamentId) {
      AdminAuditPage._addOption(tournament.input, state.filter.tournamentId,
        state.filter.tournamentId);
      tournament.input.value = state.filter.tournamentId;
    }
    tournament.input.addEventListener('change', function () {
      state.filter.tournamentId = String(tournament.input.value || '');
      state.page = 1;
      // The action list is scoped to the tournament, so it is rebuilt from
      // the next response rather than left describing the previous one.
      state.actionOptions = '';
      AdminAuditPage._cancelDebounce();
      AdminAuditPage._load();
    });
    state.tournamentField = tournament;
    bar.appendChild(tournament.wrap);

    /* ---- action ---------------------------------------------------- */
    const action = UI.field({
      label: 'Action',
      name: 'audit-action',
      type: 'select',
      options: [{ value: '', label: 'Any action' }],
      placeholderOption: '',
      hint: 'Only the actions that appear in this tournament are listed.'
    });
    action.wrap.className += ' audit-filters__select';
    action.input.addEventListener('change', function () {
      state.filter.action = String(action.input.value || '');
      state.page = 1;
      AdminAuditPage._cancelDebounce();
      AdminAuditPage._load();
    });
    state.actionField = action;
    bar.appendChild(action.wrap);

    /* ---- actor (free text, debounced) ------------------------------ */
    const actor = UI.field({
      label: 'Actor',
      name: 'audit-actor',
      type: 'search',
      hint: 'Name, email or user id. Matching runs on the server, so it waits ' +
        'until you stop typing.'
    });
    actor.wrap.className += ' audit-filters__search';
    actor.input.setAttribute('autocomplete', 'off');
    actor.input.setAttribute('autocapitalize', 'none');
    actor.input.setAttribute('spellcheck', 'false');

    /* THE DEBOUNCE. Each call is a full Repo.readAll(AuditLog) plus
       Repo.readAll(Users) on the server, and Apps Script allows 30
       simultaneous executions in total (DESIGN.md §13). Five keystrokes must
       become one request, not five. */
    actor.input.addEventListener('input', function () {
      AdminAuditPage._cancelDebounce();
      const typed = String(actor.input.value || '');
      state.debounceTimer = window.setTimeout(function () {
        state.debounceTimer = null;
        if (!AdminAuditPage._current(state)) return;
        const next = typed.trim();
        if (next === state.filter.actor) return;   // nothing actually changed
        state.filter.actor = next;
        state.page = 1;                            // a new query starts at page 1
        AdminAuditPage._load();
      }, AdminAuditPage.FILTER_DEBOUNCE_MS);
    });

    // Enter should not wait out the debounce, and must not submit anything.
    actor.input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      if (ev.preventDefault) ev.preventDefault();
      AdminAuditPage._cancelDebounce();
      const next = String(actor.input.value || '').trim();
      if (next === state.filter.actor) return;
      state.filter.actor = next;
      state.page = 1;
      AdminAuditPage._load();
    });
    state.actorField = actor;
    bar.appendChild(actor.wrap);

    /* ---- date range ------------------------------------------------ */
    // A bare YYYY-MM-DD is sent verbatim. The server widens it to the whole
    // IST day through Util.isWithinWindow (CONTRACTS.md §6a rule 3), which is
    // why nothing here converts it to an instant first.
    state.fromField = AdminAuditPage._dateFilter('from', 'From date',
      'The whole day is included, in Indian time.');
    bar.appendChild(state.fromField.wrap);

    state.toField = AdminAuditPage._dateFilter('to', 'To date',
      'The whole day is included, in Indian time.');
    bar.appendChild(state.toField.wrap);

    return bar;
  },

  /**
   * One end of the date range.
   * @param {string} key 'from' or 'to'
   * @param {string} label
   * @param {string} hint
   * @return {{wrap:HTMLElement, input:HTMLElement}}
   */
  _dateFilter: function (key, label, hint) {
    const state = AdminAuditPage._state;
    const field = UI.field({
      label: label, name: 'audit-' + key, type: 'date', hint: hint
    });
    field.wrap.className += ' audit-filters__date';
    field.input.addEventListener('change', function () {
      state.filter[key] = String(field.input.value || '');
      state.page = 1;
      AdminAuditPage._cancelDebounce();
      AdminAuditPage._load();
    });
    return field;
  },

  /**
   * @param {HTMLElement} select
   * @param {string} value
   * @param {string} label
   * @return {void}
   */
  _addOption: function (select, value, label) {
    const opt = AdminAuditPage._el('option', null, label);
    opt.value = value;
    select.appendChild(opt);
  },

  /* ================================================================== *
   * Fetch
   * ================================================================== */

  /**
   * Fill the tournament dropdown. Best effort: the log is perfectly usable
   * across all tournaments, so a failure here narrows the filter rather than
   * breaking the page, and is not shown as an error.
   * @return {!Promise<void>}
   */
  _loadTournaments: function () {
    const state = AdminAuditPage._state;

    return AdminAuditPage._call('tournament.list', {})
      .then(function (rows) {
        if (!AdminAuditPage._current(state) || !state.tournamentField) return;

        const select = state.tournamentField.input;
        const chosen = state.filter.tournamentId;

        select.textContent = '';
        AdminAuditPage._addOption(select, '', 'All tournaments');

        let found = false;
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
          const id = String((row && row.tournament_id) || '');
          if (!id) return;
          if (id === chosen) found = true;
          AdminAuditPage._addOption(select, id,
            String((row && row.name) || '(untitled tournament)'));
        });

        // A selection that is not in the list (a deleted tournament, or an id
        // pasted into the URL) stays selectable rather than silently
        // switching the admin to "all tournaments".
        if (chosen && !found) AdminAuditPage._addOption(select, chosen, chosen);
        select.value = chosen;
      })
      .catch(function () {
        /* the log still works; the dropdown just stays short */
      });
  },

  /**
   * Assemble the audit.list payload from the current state.
   *
   * pageSize is pinned and the page number is always sent, so there is no
   * code path that can ask the server for the whole tab. Blank filters are
   * omitted entirely rather than sent as '' — the server treats a present
   * key as a filter to apply.
   *
   * @return {!Object} CONTRACTS-PHASE4-7 PHASE 7 §1 audit.list payload
   */
  _payload: function () {
    const state = AdminAuditPage._state;
    const f = state.filter;

    const payload = {
      page: state.page,
      pageSize: AdminAuditPage.PAGE_SIZE
    };
    if (f.tournamentId) payload.tournamentId = f.tournamentId;
    if (f.action) payload.action = f.action;
    if (f.actor) payload.actor = f.actor;
    if (f.from) payload.from = f.from;
    if (f.to) payload.to = f.to;

    return payload;
  },

  /**
   * Fetch one page and repaint the table and the pager.
   * @return {!Promise<void>}
   */
  _load: function () {
    const state = AdminAuditPage._state;
    if (!state || !state.tableBox) return Promise.resolve();

    const req = ++state.req;
    AdminAuditPage._clearError(state.errors);

    state.tableBox.setAttribute('aria-busy', 'true');
    state.tableBox.textContent = '';
    state.tableBox.appendChild(UI.spinner('Reading the audit log…'));

    return AdminAuditPage._call('audit.list', AdminAuditPage._payload())
      .then(function (data) {
        // Stale reply: a later request has already been sent, so painting
        // this one would show the previous filter's rows.
        if (!AdminAuditPage._current(state) || req !== state.req) return;
        state.last = data || {};
        AdminAuditPage._paint(state.last);
      })
      .catch(function (err) {
        if (AdminAuditPage._handled(err) || !AdminAuditPage._current(state)) return;
        if (req !== state.req) return;
        state.tableBox.setAttribute('aria-busy', 'false');
        state.tableBox.textContent = '';
        state.pagerBox.textContent = '';
        // The server's own words are the useful part here: it names the
        // illegal action, or says the from date is after the to date.
        AdminAuditPage._showError(state.errors, err);
      });
  },

  /**
   * @param {!Object} data audit.list response
   * @return {void}
   */
  _paint: function (data) {
    const state = AdminAuditPage._state;

    AdminAuditPage._syncActionOptions(data.actions);

    state.tableBox.textContent = '';
    const rows = Array.isArray(data.rows) ? data.rows : [];

    if (!rows.length) {
      state.tableBox.appendChild(AdminAuditPage._emptyState(data));
    } else {
      state.tableBox.appendChild(AdminAuditPage._table(rows));
    }
    state.tableBox.setAttribute('aria-busy', 'false');

    AdminAuditPage._paintPager(data);
  },

  /**
   * Rebuild the action dropdown from the actions the server actually saw in
   * scope. Done only when the list has changed, so choosing an action never
   * rebuilds the menu underneath the pointer.
   *
   * @param {*} actions the response's `actions` array
   * @return {void}
   */
  _syncActionOptions: function (actions) {
    const state = AdminAuditPage._state;
    if (!state.actionField) return;

    const list = Array.isArray(actions) ? actions.map(String) : [];
    const key = list.join('|');
    if (key === state.actionOptions) return;
    state.actionOptions = key;

    const select = state.actionField.input;
    const chosen = state.filter.action;

    select.textContent = '';
    AdminAuditPage._addOption(select, '', 'Any action');

    let found = false;
    list.forEach(function (name) {
      if (name === chosen) found = true;
      AdminAuditPage._addOption(select, name, AdminAuditPage._humanAction(name));
    });
    // Keep a chosen action that produced no rows, or the admin cannot see
    // what they filtered by and cannot get back to it.
    if (chosen && !found) {
      AdminAuditPage._addOption(select, chosen, AdminAuditPage._humanAction(chosen));
    }
    select.value = chosen;
  },

  /* ================================================================== *
   * The table
   * ================================================================== */

  /**
   * @param {!Array<!Object>} rows one page of audit.list rows
   * @return {HTMLElement}
   */
  _table: function (rows) {
    const wrap = AdminAuditPage._el('div', 'audit-table__scroll');
    wrap.setAttribute('tabindex', '0');          // a scroll region needs to be
    wrap.setAttribute('role', 'region');         // reachable from a keyboard
    wrap.setAttribute('aria-label', 'Audit log entries');

    const table = AdminAuditPage._el('table', 'admin-table audit-table');

    table.appendChild(AdminAuditPage._el('caption', 'visually-hidden',
      'Audit log entries, newest first. Time in Indian Standard Time, the ' +
      'person who acted, the action, the record it changed, and each field ' +
      'that changed with its value before and after. This log cannot be ' +
      'edited or deleted.'));

    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    AdminAuditPage.COLUMNS.forEach(function (col) {
      const th = AdminAuditPage._el('th', 'audit-table__' + col.cls, col.label);
      th.scope = 'col';
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      tbody.appendChild(AdminAuditPage._row(row));
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  },

  /**
   * One audit entry. Every value goes in as textContent: an actor name and a
   * rejection reason are both user-entered free text.
   *
   * @param {!Object} row an audit.list row
   * @return {HTMLElement}
   */
  _row: function (row) {
    const action = String(row.action || '').toUpperCase();
    const key = AdminAuditPage.KEY_ACTIONS.indexOf(action) !== -1;

    const tr = AdminAuditPage._el('tr', 'audit-row' + (key ? ' audit-row--key' : ''));

    /* ---- when (the row header) ------------------------------------- */
    // The server pre-formats this in IST. Re-parsing a UTC instant in a
    // browser of unknown time zone is how an audit entry slides by a day and
    // stops matching the bank statement (CONTRACTS.md §6a).
    const time = AdminAuditPage._el('th', 'audit-table__time');
    time.scope = 'row';
    time.appendChild(AdminAuditPage._el('span', 'audit-time',
      String(row.timestamp_display || row.timestamp || '—')));
    if (row.log_id) {
      // Quotable in an email: "entry AUD_k3m9x1qz7f2a".
      const id = AdminAuditPage._el('span', 'audit-logid', String(row.log_id));
      id.title = 'Entry reference';
      time.appendChild(id);
    }
    tr.appendChild(time);

    /* ---- who -------------------------------------------------------- */
    const actor = AdminAuditPage._el('td', 'audit-table__actor');
    actor.appendChild(AdminAuditPage._el('span', 'audit-actor__name',
      String(row.actor_name || row.actor_user_id || '(system)')));
    if (row.actor_role) {
      actor.appendChild(AdminAuditPage._el('span', 'audit-actor__role',
        AdminAuditPage._humanAction(String(row.actor_role))));
    }
    if (row.actor_user_id && String(row.actor_user_id) !== String(row.actor_name || '')) {
      actor.appendChild(AdminAuditPage._el('span', 'audit-actor__id',
        String(row.actor_user_id)));
    }
    tr.appendChild(actor);

    /* ---- what ------------------------------------------------------- */
    const cell = AdminAuditPage._el('td', 'audit-table__action');
    const pill = AdminAuditPage._el('span',
      'audit-action' + (key ? ' audit-action--key' : ''),
      row.action_display ? String(row.action_display)
        : AdminAuditPage._humanAction(String(row.action || '')));
    cell.appendChild(pill);
    if (key) {
      // A word, never a colour on its own (DESIGN.md §8/§51).
      const flag = AdminAuditPage._el('span', 'badge audit-flag', 'Dispute evidence');
      flag.title = 'One of the four entries an argument is usually about: ' +
        'payment verified, payment rejected, player sold, auction corrected.';
      cell.appendChild(flag);
    }
    // The raw enum, so a written complaint and this screen use one vocabulary.
    if (row.action) {
      cell.appendChild(AdminAuditPage._el('span', 'audit-action__code', String(row.action)));
    }
    tr.appendChild(cell);

    /* ---- which record ----------------------------------------------- */
    const entity = AdminAuditPage._el('td', 'audit-table__entity');
    entity.appendChild(AdminAuditPage._el('span', 'audit-entity__type',
      row.entity_type ? AdminAuditPage._humanAction(String(row.entity_type)) : '—'));
    if (row.entity_id) {
      entity.appendChild(AdminAuditPage._el('span', 'audit-entity__id', String(row.entity_id)));
    }
    if (row.tournament_id) {
      entity.appendChild(AdminAuditPage._el('span', 'audit-entity__tournament',
        String(row.tournament_id)));
    }
    tr.appendChild(entity);

    /* ---- before and after -------------------------------------------- */
    const changes = AdminAuditPage._el('td', 'audit-table__changes');
    changes.appendChild(AdminAuditPage._changes(row.prev_value, row.new_value));
    tr.appendChild(changes);

    return tr;
  },

  /* ================================================================== *
   * The before/after renderer — the reason this screen exists
   * ================================================================== */

  /**
   * A field-by-field diff of the two parsed JSON values.
   *
   * The server already parsed them (Reports._auditRow) and passes anything
   * unparseable through as the raw string, so both shapes are handled:
   * objects become a list of "field: old → new", and a bare string becomes a
   * labelled before/after pair.
   *
   * Changed fields are listed first. Under time pressure the reader wants
   * "what moved", and an entry like PLAYER_SOLD carries a dozen unchanged
   * fields around the two that matter.
   *
   * @param {*} prev the prev_value from the response
   * @param {*} next the new_value from the response
   * @return {HTMLElement}
   */
  _changes: function (prev, next) {
    const box = AdminAuditPage._el('div', 'audit-changes');

    const hasPrev = !(prev === null || prev === undefined || prev === '');
    const hasNext = !(next === null || next === undefined || next === '');

    if (!hasPrev && !hasNext) {
      box.appendChild(AdminAuditPage._el('p', 'audit-changes__none',
        'No values were recorded with this entry.'));
      return box;
    }

    const before = hasPrev ? AdminAuditPage._flatten(prev, '', {}, 0) : {};
    const after = hasNext ? AdminAuditPage._flatten(next, '', {}, 0) : {};

    const keys = [];
    Object.keys(before).forEach(function (k) { keys.push(k); });
    Object.keys(after).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });

    const changed = [];
    const same = [];
    keys.forEach(function (k) {
      const inBefore = Object.prototype.hasOwnProperty.call(before, k);
      const inAfter = Object.prototype.hasOwnProperty.call(after, k);
      const oldText = inBefore ? AdminAuditPage._value(k, before[k]) : null;
      const newText = inAfter ? AdminAuditPage._value(k, after[k]) : null;
      const entry = { key: k, oldText: oldText, newText: newText };
      if (oldText === newText) same.push(entry); else changed.push(entry);
    });

    const ordered = changed.concat(same);
    const list = AdminAuditPage._el('ul', 'audit-changes__list');
    const shown = Math.min(ordered.length, AdminAuditPage.MAX_CHANGE_ROWS);

    for (let i = 0; i < shown; i++) {
      list.appendChild(AdminAuditPage._changeRow(ordered[i], i < changed.length));
    }
    box.appendChild(list);

    if (ordered.length > shown) {
      box.appendChild(AdminAuditPage._el('p', 'audit-changes__more',
        (ordered.length - shown) + ' further unchanged field' +
        ((ordered.length - shown) === 1 ? '' : 's') + ' are not shown.'));
    }

    if (!changed.length) {
      box.appendChild(AdminAuditPage._el('p', 'audit-changes__none',
        'No field changed value.'));
    }

    return box;
  },

  /**
   * One field's before and after.
   * @param {{key:string, oldText:?string, newText:?string}} entry
   * @param {boolean} changed
   * @return {HTMLElement}
   */
  _changeRow: function (entry, changed) {
    const li = AdminAuditPage._el('li',
      'audit-change' + (changed ? ' audit-change--moved' : ' audit-change--same'));

    li.appendChild(AdminAuditPage._el('span', 'audit-change__field',
      AdminAuditPage._humanField(entry.key)));

    li.appendChild(AdminAuditPage._valueCell('old', entry.oldText, 'not recorded before'));

    // The arrow is decoration; the words beside it are what a screen reader
    // hears, so the diff survives greyscale and audio alike.
    const arrow = AdminAuditPage._el('span', 'audit-change__arrow', '→');
    arrow.setAttribute('aria-hidden', 'true');
    li.appendChild(arrow);
    li.appendChild(AdminAuditPage._sr(changed ? ' changed to ' : ' unchanged, still '));

    li.appendChild(AdminAuditPage._valueCell('new', entry.newText, 'not recorded after'));

    return li;
  },

  /**
   * @param {string} which 'old' or 'new'
   * @param {?string} text the formatted value, or null when the field is
   *        absent on that side
   * @param {string} absentWords what a screen reader hears instead of the dash
   * @return {HTMLElement}
   */
  _valueCell: function (which, text, absentWords) {
    const span = AdminAuditPage._el('span', 'audit-change__' + which);
    if (text === null) {
      span.className += ' audit-change__absent';
      const dash = AdminAuditPage._el('span', null, '—');
      dash.setAttribute('aria-hidden', 'true');
      span.appendChild(dash);
      span.appendChild(AdminAuditPage._sr(absentWords));
      return span;
    }
    if (text.length > AdminAuditPage.MAX_VALUE_CHARS) {
      span.textContent = text.slice(0, AdminAuditPage.MAX_VALUE_CHARS) + '…';
      span.title = text;      // an attribute, but set as a property, never parsed
      return span;
    }
    span.textContent = text;
    return span;
  },

  /**
   * Flatten a parsed JSON value into dotted-key -> primitive.
   *
   * Depth-limited: below the limit a nested object is summarised on one line
   * rather than dropped, because a partial record still helps and a missing
   * one starts a second argument.
   *
   * @param {*} value
   * @param {string} prefix
   * @param {!Object} out accumulator
   * @param {number} depth
   * @return {!Object<string,*>}
   */
  _flatten: function (value, prefix, out, depth) {
    const p = prefix || '';

    if (value === null || value === undefined || typeof value !== 'object') {
      out[p] = value;
      return out;
    }

    if (Array.isArray(value)) {
      if (!value.length) { out[p] = '(empty list)'; return out; }
      const flat = value.every(function (v) {
        return v === null || v === undefined || typeof v !== 'object';
      });
      if (flat || depth >= 3) {
        out[p] = value.map(function (v) { return AdminAuditPage._plain(v); }).join(', ');
        return out;
      }
      value.forEach(function (v, i) {
        AdminAuditPage._flatten(v, p + '[' + (i + 1) + ']', out, depth + 1);
      });
      return out;
    }

    const keys = Object.keys(value);
    if (!keys.length) { out[p] = '(no values)'; return out; }
    if (depth >= 3) {
      out[p] = keys.map(function (k) {
        return k + '=' + AdminAuditPage._plain(value[k]);
      }).join(', ');
      return out;
    }
    keys.forEach(function (k) {
      AdminAuditPage._flatten(value[k], p ? p + '.' + k : k, out, depth + 1);
    });
    return out;
  },

  /**
   * A primitive as plain text, with no money formatting — used inside a
   * summarised nested value where there is no field name to judge by.
   * @param {*} v
   * @return {string}
   */
  _plain: function (v) {
    if (v === null || v === undefined || v === '') return '(empty)';
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    if (typeof v === 'object') return Array.isArray(v) ? '(list)' : '(details)';
    return String(v);
  },

  /**
   * A value formatted for the field it belongs to.
   *
   * Money goes through UI.money, which is the same Indian grouping the server
   * uses (Util.formatINR), so a purse on this screen reads identically to the
   * same purse on every other screen. A bare 525000 in a dispute gets
   * miscounted out loud.
   *
   * @param {string} key the flattened field name
   * @param {*} v
   * @return {string}
   */
  _value: function (key, v) {
    if (v === null || v === undefined || v === '') return '(empty)';
    if (v === true) return 'Yes';
    if (v === false) return 'No';

    if (typeof v === 'number' && isFinite(v) && AdminAuditPage.MONEY_KEY.test(key)) {
      return UI.money(v);
    }
    return String(v);
  },

  /**
   * "purse_used" -> "Purse used"; "team.purse_used" -> "Team › Purse used".
   * @param {string} key a flattened key, possibly ''
   * @return {string}
   */
  _humanField: function (key) {
    const k = String(key || '');
    if (!k) return 'Value';
    return k.split('.').map(function (part) {
      return AdminAuditPage._humanAction(part);
    }).join(' › ');
  },

  /**
   * SCREAMING_SNAKE or snake_case -> "Sentence case". The same rule the
   * server's Reports._label uses, so the screen and the CSV agree.
   * @param {string} value
   * @return {string}
   */
  _humanAction: function (value) {
    const s = String(value === null || value === undefined ? '' : value).trim();
    if (!s) return '';
    // An index suffix from an array stays attached: "players[2]".
    const words = s.toLowerCase().replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  },

  /* ================================================================== *
   * Empty states
   * ================================================================== */

  /**
   * Never an empty table. A blank grid reads as a failed load, and the three
   * reasons a page can be empty need three different actions.
   *
   * @param {!Object} data the audit.list response
   * @return {HTMLElement}
   */
  _emptyState: function (data) {
    const state = AdminAuditPage._state;
    const total = Number(data.total) || 0;
    const page = Number(data.page) || state.page;
    const totalPages = Number(data.totalPages) || 0;

    const box = AdminAuditPage._el('div', 'admin__empty audit-empty');

    // 1. The page is past the end — usually a bookmark from before a filter
    //    narrowed the list, or a filter change while sitting on page 8.
    if (total > 0 && page > 1 && page > totalPages) {
      box.appendChild(AdminAuditPage._el('p', 'audit-empty__title',
        'Page ' + page + ' does not exist.'));
      box.appendChild(AdminAuditPage._el('p', 'audit-empty__note',
        'This filter has ' + total + ' entr' + (total === 1 ? 'y' : 'ies') +
        ' on ' + totalPages + ' page' + (totalPages === 1 ? '' : 's') + '.'));
      box.appendChild(UI.button('Go to page 1', function () {
        state.page = 1;
        AdminAuditPage._load();
      }, { variant: 'secondary' }));
      return box;
    }

    // 2. A search is running and matches nothing. The tournament on its own
    //    does not count as a search — it is the scope the screen opened in,
    //    and telling a brand-new tournament that "your filters matched
    //    nothing" sends the admin hunting for a filter they never set.
    if (AdminAuditPage._hasSearchFilters()) {
      box.appendChild(AdminAuditPage._el('p', 'audit-empty__title',
        'No audit entry matches these filters.'));
      box.appendChild(AdminAuditPage._el('p', 'audit-empty__note',
        AdminAuditPage._filterSummary() +
        ' Nothing has been hidden — the log simply has no entry that matches. ' +
        'Widen the dates or clear a filter and look again.'));
      box.appendChild(UI.button('Clear the filters', function () {
        AdminAuditPage._resetFilters();
      }, { variant: 'secondary' }));
      return box;
    }

    // 3. Genuinely nothing recorded yet, in this scope.
    const scoped = !!AdminAuditPage._state.filter.tournamentId;
    box.appendChild(AdminAuditPage._el('p', 'audit-empty__title',
      scoped
        ? 'This tournament has no audit entries yet.'
        : 'The audit log has no entries yet.'));
    box.appendChild(AdminAuditPage._el('p', 'audit-empty__note',
      'Entries appear here automatically the first time somebody signs in, ' +
      'verifies a payment, creates a team or records a sale. Nothing is ' +
      'written by hand and nothing can be removed.'));

    if (scoped) {
      // Sign-ins and organiser invitations belong to no tournament, so the
      // entry being looked for may be one filter away rather than missing.
      box.appendChild(UI.button('Look across all tournaments', function () {
        AdminAuditPage._clearTournamentFilter();
      }, { variant: 'secondary' }));
    }
    return box;
  },

  /**
   * @return {boolean} true when the admin has actually searched for something,
   *         as opposed to simply arriving with a tournament selected
   */
  _hasSearchFilters: function () {
    const f = AdminAuditPage._state.filter;
    return !!(f.action || f.actor || f.from || f.to);
  },

  /**
   * Widen the scope to every tournament, keeping any other filter.
   * @return {void}
   */
  _clearTournamentFilter: function () {
    const state = AdminAuditPage._state;
    state.filter.tournamentId = '';
    state.page = 1;
    state.actionOptions = '';
    if (state.tournamentField) state.tournamentField.input.value = '';
    AdminAuditPage._cancelDebounce();
    AdminAuditPage._load();
  },

  /**
   * Say back exactly what was asked for, so "no results" is never a mystery.
   * @return {string}
   */
  _filterSummary: function () {
    const f = AdminAuditPage._state.filter;
    const parts = [];
    if (f.tournamentId) parts.push('tournament ' + AdminAuditPage._tournamentLabel(f.tournamentId));
    if (f.action) parts.push('action ' + AdminAuditPage._humanAction(f.action).toLowerCase());
    if (f.actor) parts.push('actor "' + f.actor + '"');
    if (f.from) parts.push('from ' + f.from);
    if (f.to) parts.push('to ' + f.to);

    if (!parts.length) return 'No filters are set.';
    return 'Filters: ' + parts.join(', ') + '.';
  },

  /**
   * @param {string} id
   * @return {string} the tournament's name when it is known, else the id
   */
  _tournamentLabel: function (id) {
    if (typeof App !== 'undefined' && App && typeof App.tournamentName === 'function') {
      try {
        const name = String(App.tournamentName(id) || '');
        if (name) return name;
      } catch (e) { /* fall through to the id */ }
    }
    return String(id);
  },

  /**
   * Clear every filter, put the controls back to their blank option, refetch.
   * The tournament filter is cleared too: "no results" often means the entry
   * being looked for belongs to a different tournament.
   * @return {void}
   */
  _resetFilters: function () {
    const state = AdminAuditPage._state;
    state.filter = { tournamentId: '', action: '', actor: '', from: '', to: '' };
    state.page = 1;
    AdminAuditPage._cancelDebounce();

    if (state.actorField) state.actorField.input.value = '';
    if (state.fromField) state.fromField.input.value = '';
    if (state.toField) state.toField.input.value = '';
    if (state.actionField) state.actionField.input.value = '';
    if (state.tournamentField) state.tournamentField.input.value = '';

    AdminAuditPage._load();
  },

  /* ================================================================== *
   * Pager
   * ================================================================== */

  /**
   * Previous / next plus an honest "page 2 of 8, 400 entries". Both buttons
   * send a page NUMBER to the server; neither ever asks for everything.
   *
   * @param {!Object} data the audit.list response
   * @return {void}
   */
  _paintPager: function (data) {
    const state = AdminAuditPage._state;
    const box = state.pagerBox;
    box.textContent = '';

    const total = Number(data.total) || 0;
    const page = Number(data.page) || state.page;
    const totalPages = Number(data.totalPages) || 0;
    const pageSize = Number(data.pageSize) || AdminAuditPage.PAGE_SIZE;
    const shown = Array.isArray(data.rows) ? data.rows.length : 0;

    if (!total) return;

    const bar = AdminAuditPage._el('div', 'audit-pager');

    const prev = UI.button('Previous page', function () {
      if (state.page <= 1) return;
      state.page -= 1;
      AdminAuditPage._cancelDebounce();
      AdminAuditPage._load();
    }, { variant: 'secondary' });
    prev.disabled = page <= 1;
    bar.appendChild(prev);

    const first = shown ? ((page - 1) * pageSize) + 1 : 0;
    const last = shown ? first + shown - 1 : 0;

    const status = AdminAuditPage._el('p', 'audit-pager__status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = shown
      ? ('Showing ' + first + '–' + last + ' of ' + total +
         ' · page ' + page + ' of ' + totalPages)
      : ('No entries on page ' + page + ' of ' + totalPages + ' · ' + total + ' in total');
    bar.appendChild(status);

    const next = UI.button('Next page', function () {
      if (state.page >= totalPages) return;
      state.page += 1;
      AdminAuditPage._cancelDebounce();
      AdminAuditPage._load();
    }, { variant: 'secondary' });
    next.disabled = page >= totalPages;
    bar.appendChild(next);

    box.appendChild(bar);

    box.appendChild(AdminAuditPage._el('p', 'audit-pager__note',
      'Newest first, ' + AdminAuditPage.PAGE_SIZE + ' entries at a time. ' +
      'Filters and dates are applied on the server, across the whole log — ' +
      'not just this page. ' + AdminAuditPage._filterSummary()));
  }
};
