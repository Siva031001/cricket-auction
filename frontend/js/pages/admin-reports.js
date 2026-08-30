/**
 * admin-reports.js — the /admin/reports screen. `AdminReportsPage`.
 *
 * THE NUMBERS AND THE FILES (DESIGN.md §35 and §45, CONTRACTS-PHASE4-7
 * PHASE 6). One screen that answers "how did it go?" and then hands over the
 * spreadsheets the tournament owner actually keeps.
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE4-7 PHASE 6   dashboard.adminStats, report.players,
 *                                report.teams, report.auction
 *   CONTRACTS-PHASE4-7 PHASE 7 §3  report.final
 *   CONTRACTS-PHASE1 §4          textContent only, vanilla JS, data-route
 *   CONTRACTS.md §15             every call through API, never fetch
 *
 * Five decisions that are not style choices:
 *
 * 1. FOUR AUCTION LABELS, NEVER THREE (DESIGN.md §6.9). 8 teams x ~13 slots
 *    is about 100 places for 400 registrations, so roughly 300 players are
 *    never called at all — and every one of them paid the fee. "Sold /
 *    Unsold / Pending" hides that; "Sold / Unsold / Awaiting re-auction /
 *    Not called" explains it. All four tiles are always rendered, including
 *    the zeroes, because a missing label is what starts the argument.
 *
 * 2. THE CSV IS NOT TOUCHED HERE. The server already emitted bare integers
 *    with no ₹ and no thousands separators, mobiles as ="9876543210", RFC
 *    4180 quoting and a UTF-8 BOM (backend/Reports.gs). Post-processing any
 *    of that in the browser would undo the exact work that keeps the file
 *    summable in Excel. This page base64-decodes the bytes and saves them,
 *    byte for byte.
 *
 * 3. counters_match FALSE IS SHOWN, LOUDLY. The server derives spend from the
 *    sold players and compares it with the cached Teams.purse_used. When the
 *    two disagree, one of the numbers on this screen is wrong and nobody can
 *    tell which by looking. Hiding it would leave an organiser quoting a
 *    purse that does not exist.
 *
 * 4. MONEY ON SCREEN GOES THROUGH UI.money. Same Indian grouping as
 *    Util.formatINR on the server, so "₹1,00,000" here and "₹1,00,000" in the
 *    final report are the same number rendered the same way.
 *
 * 5. A DOWNLOAD SHOWS A SPINNER. A 400-row export is a full read of four tabs
 *    and takes a second or two. Silence makes people press the button again,
 *    and two exports of a moving system is two different files.
 */

/* eslint-disable no-unused-vars */
const AdminReportsPage = {

  LOGIN_PATH: '/admin/login',
  REPORTS_PATH: '/admin/reports',
  DASHBOARD_PATH: '/admin/dashboard',

  /**
   * How long the object URL is kept alive after the click.
   *
   * Not zero: several browsers start reading the blob asynchronously after
   * the synthetic click returns, and revoking immediately gives an empty
   * file. Kept as a constant so it can be checked and tuned in one place.
   * @const {number}
   */
  REVOKE_DELAY_MS: 1000,

  /**
   * Thrown by _call() after it has already handled an expired session.
   * @const
   */
  REDIRECTED: Object.freeze({ code: 'REDIRECTED', message: '' }),

  /**
   * The four exports, in the order an organiser asks for them.
   * @const {!Array<{key:string, action:string, label:string, busy:string, note:string}>}
   */
  REPORTS: Object.freeze([
    {
      key: 'players',
      action: 'report.players',
      label: 'Player List',
      busy: 'Building the player list…',
      note: 'Every registration: serial number, name, DOB, role, style, mobile, ' +
        'payment reference, payment status, auction status, team and purchase amount.'
    },
    {
      key: 'teams',
      action: 'report.teams',
      label: 'Team Report',
      busy: 'Building the team report…',
      note: 'Every team with the players they bought, the total spent and the ' +
        'purse they have left. Totals are added up from the rows in the file itself.'
    },
    {
      key: 'auction',
      action: 'report.auction',
      label: 'Auction Report',
      busy: 'Building the auction report…',
      note: 'The outcome for every registered player — the ones who were called, ' +
        'in the order it happened, then everyone who never came up.'
    },
    {
      key: 'final',
      action: 'report.final',
      label: 'Final Report',
      busy: 'Building the final report…',
      note: 'One file to keep and to send on: the summary, all team squads and ' +
        'the complete auction history including corrected sales.'
    }
  ]),

  /**
   * The numbers, grouped the way they are asked for out loud.
   *
   * `path`  where the value lives inside one dashboard.adminStats block
   * `money` render through UI.money rather than as a count
   * @const {!Array<{title:string, note:(string|undefined),
   *         tiles:!Array<{path:string, label:string, money:(boolean|undefined),
   *                       headline:(boolean|undefined), note:(string|undefined)}>}>}
   */
  GROUPS: Object.freeze([
    {
      title: 'Registrations and payments',
      tiles: [
        {
          path: 'registrations.all', label: 'Registered', headline: true,
          note: 'Everyone who filled in the form, whatever happened afterwards.'
        },
        { path: 'registrations.verified', label: 'Payment verified' },
        { path: 'registrations.pending', label: 'Payment pending' },
        { path: 'registrations.rejected', label: 'Payment rejected' },
        { path: 'registrations.withdrawn', label: 'Withdrawn' },
        {
          path: 'registrations.eligible', label: 'Eligible for the auction',
          headline: true,
          note: 'Verified and not withdrawn. This is the pool the auction draws from.'
        }
      ]
    },
    {
      title: 'Teams and squad slots',
      tiles: [
        { path: 'teams.total', label: 'Teams', headline: true },
        { path: 'teams.full', label: 'Teams full' },
        { path: 'teams.slots_total', label: 'Squad slots' },
        { path: 'teams.slots_filled', label: 'Slots filled' },
        { path: 'teams.slots_remaining', label: 'Slots left' }
      ]
    },
    {
      /* DESIGN.md §6.9 — the four honest labels, always all four. */
      title: 'Auction outcome',
      note: 'Four outcomes, not three. Everyone paid the fee, so "Not called" ' +
        'has to be a visible answer rather than a blank cell.',
      tiles: [
        { path: 'auction.sold', label: 'Sold', headline: true },
        {
          path: 'auction.unsold', label: 'Unsold',
          note: 'Came to the table and nobody bid.'
        },
        {
          path: 'auction.awaiting_reauction', label: 'Awaiting re-auction',
          note: 'Was called, went back to the pool, may still sell.'
        },
        {
          path: 'auction.not_called', label: 'Not called', headline: true,
          note: 'Never brought to the table. The squads filled up first.'
        }
      ]
    },
    {
      title: 'Money',
      tiles: [
        {
          path: 'purse.spent', label: 'Total auction value', money: true,
          headline: true, note: 'Everything the teams spent, added up from the sales.'
        },
        { path: 'purse.remaining', label: 'Purse left across all teams', money: true },
        { path: 'purse.highest_sale', label: 'Highest sale', money: true },
        { path: 'purse.average_sale', label: 'Average sale', money: true },
        { path: 'fees.collected', label: 'Registration fees collected', money: true }
      ]
    }
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
    document.body.dataset.route = 'admin-reports';

    const gen = ++AdminReportsPage._gen;
    const query = (ctx && ctx.query) || {};

    if (!API.getToken()) {
      Router.navigate(AdminReportsPage.LOGIN_PATH, { replace: true });
      return;
    }

    const tournamentId = AdminReportsPage._tournamentId(ctx, query);

    AdminReportsPage._state = {
      gen: gen,
      tournamentId: tournamentId,
      stats: null,
      errors: null,
      warnBox: null,
      statsBox: null,
      downloadStatus: null
    };

    if (!tournamentId) {
      AdminReportsPage._renderChooser(ctx);
      return;
    }

    AdminReportsPage._renderReports(ctx);
  },

  /* ================================================================== *
   * Shared plumbing (same shape as admin-players.js)
   * ================================================================== */

  /**
   * Every backend call on this page goes through here, so an expired session
   * is handled in exactly one place. It can expire on the stats call or on
   * any of the four exports.
   *
   * @param {string} action
   * @param {Object} [payload]
   * @return {!Promise<*>} rejects with AdminReportsPage.REDIRECTED once the
   *         session is gone and navigation has already been started.
   */
  _call: function (action, payload) {
    return API.call(action, payload || {}).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        API.clearToken();
        Router.navigate(AdminReportsPage.LOGIN_PATH, { replace: true });
        throw AdminReportsPage.REDIRECTED;
      }
      throw err;
    });
  },

  /**
   * @param {*} err
   * @return {boolean} true when _call has already navigated away
   */
  _handled: function (err) {
    return err === AdminReportsPage.REDIRECTED;
  },

  /**
   * @param {Object} state
   * @return {boolean} true when this view is still the one on screen
   */
  _current: function (state) {
    return !!state && state.gen === AdminReportsPage._gen;
  },

  /**
   * createElement with a class and text in one call. textContent only — a
   * tournament name and a player name both come out of a sheet.
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
    if (!App.root) App.root = document.getElementById('app');
    App.root.textContent = '';
    App.root.appendChild(el);
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
   * @param {string} label
   * @param {string} path app path, no BASE_PATH
   * @param {string} [variant]
   * @return {HTMLElement}
   */
  _navButton: function (label, path, variant) {
    const a = AdminReportsPage._el('a', 'btn' + (variant === 'secondary' ? ' btn--secondary' : ''));
    a.href = Router.href(path);
    a.textContent = label;
    return a;
  },

  /**
   * app.js owns the ?t= selection; the query-string fallback only matters if
   * this page is mounted by a shell that predates App.currentTournamentId.
   * @param {Object} ctx
   * @param {!Object<string,string>} query
   * @return {string}
   */
  _tournamentId: function (ctx, query) {
    if (typeof App !== 'undefined' && App && typeof App.currentTournamentId === 'function') {
      try {
        const chosen = String(App.currentTournamentId(ctx) || '').trim();
        if (chosen) return chosen;
      } catch (e) { /* fall through */ }
    }
    return String(
      query.t || query.tournament || query.tournamentId || query.id || ''
    ).trim();
  },

  /**
   * @param {string} path
   * @param {string} [tournamentId]
   * @return {string}
   */
  _adminPath: function (path, tournamentId) {
    const id = String(
      tournamentId === undefined
        ? (AdminReportsPage._state ? AdminReportsPage._state.tournamentId : '')
        : (tournamentId || '')
    ).trim();

    if (typeof App !== 'undefined' && App && typeof App.adminPath === 'function') {
      try { return App.adminPath(path, id); } catch (e) { /* fall through */ }
    }
    if (!id) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(id);
  },

  /**
   * Page frame: nav, heading, actions, a permanent live region, a body.
   * @param {string} title
   * @param {string} note
   * @param {Object} [ctx] router context, for the shared admin nav
   * @return {{main:HTMLElement, actions:HTMLElement, errors:HTMLElement, body:HTMLElement}}
   */
  _shell: function (title, note, ctx) {
    document.title = title + ' · Cricket Auction';

    const main = AdminReportsPage._el('main', 'panel admin reports');

    if (typeof App !== 'undefined' && App && typeof App.adminNav === 'function') {
      try {
        const nav = App.adminNav('reports', ctx);
        if (nav) main.appendChild(nav);
      } catch (e) { /* the nav is chrome; never let it stop the page rendering */ }
    }

    const head = AdminReportsPage._el('div', 'admin__head');
    const heading = AdminReportsPage._el('div');
    heading.appendChild(AdminReportsPage._el('h1', 'panel__title', title));
    if (note) heading.appendChild(AdminReportsPage._el('p', 'panel__note', note));
    head.appendChild(heading);

    const actions = AdminReportsPage._el('div', 'admin__actions');
    head.appendChild(actions);
    main.appendChild(head);

    const errors = AdminReportsPage._el('div', 'admin__errors');
    errors.setAttribute('aria-live', 'assertive');
    errors.setAttribute('aria-atomic', 'true');
    main.appendChild(errors);

    const body = AdminReportsPage._el('div', 'admin__body');
    main.appendChild(body);

    return { main: main, actions: actions, errors: errors, body: body };
  },

  /* ================================================================== *
   * View 0 — no tournament chosen
   * ================================================================== */

  /**
   * A report is meaningless without a tournament, and exporting the wrong
   * one's mobile numbers is not a mistake that can be taken back.
   * @param {Object} ctx
   * @return {void}
   */
  _renderChooser: function (ctx) {
    const state = AdminReportsPage._state;
    const shell = AdminReportsPage._shell(
      'Reports',
      'Choose the tournament you want the numbers and the exports for.',
      ctx
    );
    state.errors = shell.errors;

    shell.actions.appendChild(AdminReportsPage._navButton(
      'Back to tournaments',
      AdminReportsPage._adminPath(AdminReportsPage.DASHBOARD_PATH), 'secondary'));

    const box = AdminReportsPage._el('div');
    box.appendChild(UI.spinner('Loading tournaments…'));
    shell.body.appendChild(box);

    AdminReportsPage._mount(shell.main);

    AdminReportsPage._call('tournament.list', {})
      .then(function (rows) {
        if (!AdminReportsPage._current(state)) return;
        box.textContent = '';

        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) {
          box.appendChild(AdminReportsPage._el('p', 'admin__empty',
            'There are no tournaments yet. Create one first, then come back ' +
            'here once players have registered.'));
          return;
        }

        const ul = AdminReportsPage._el('ul', 'reports-chooser');
        list.forEach(function (row) {
          const li = AdminReportsPage._el('li', 'reports-chooser__item');
          const link = AdminReportsPage._navButton(
            String(row.name || '(untitled tournament)'),
            AdminReportsPage._adminPath(AdminReportsPage.REPORTS_PATH, row.tournament_id),
            'secondary');
          link.className += ' reports-chooser__link';
          li.appendChild(link);
          ul.appendChild(li);
        });
        box.appendChild(ul);
      })
      .catch(function (err) {
        if (AdminReportsPage._handled(err) || !AdminReportsPage._current(state)) return;
        box.textContent = '';
        AdminReportsPage._showError(shell.errors, err);
      });
  },

  /* ================================================================== *
   * View 1 — the dashboard and the exports
   * ================================================================== */

  /**
   * Build the frame once, then let _loadStats() repaint the warning and the
   * numbers. The download buttons never move, so a slow stats call cannot
   * take an export away from under the pointer.
   * @param {Object} ctx
   * @return {void}
   */
  _renderReports: function (ctx) {
    const state = AdminReportsPage._state;

    const shell = AdminReportsPage._shell(
      'Reports and exports',
      'Where the tournament stands, and the four files to keep. The exports ' +
      'open in Excel and every money column is a plain number, so totals work.',
      ctx
    );
    state.errors = shell.errors;

    shell.actions.appendChild(AdminReportsPage._navButton(
      'Back to tournaments',
      AdminReportsPage._adminPath(AdminReportsPage.DASHBOARD_PATH), 'secondary'));
    shell.actions.appendChild(UI.button('Refresh the numbers', function () {
      return AdminReportsPage._loadStats();
    }, { variant: 'secondary', busyLabel: 'Refreshing…' }));

    /* Which tournament these files are about. An export carries 400 mobile
       numbers, so the scope is on screen next to the button, not only in the
       nav bar above it. */
    let scopeName = '';
    if (typeof App !== 'undefined' && App && typeof App.tournamentName === 'function') {
      try { scopeName = String(App.tournamentName(state.tournamentId) || ''); } catch (e) { scopeName = ''; }
    }
    const scope = AdminReportsPage._el('p', 'reports-scope');
    scope.appendChild(AdminReportsPage._el('span', 'reports-scope__label', 'Tournament: '));
    if (scopeName) {
      scope.appendChild(AdminReportsPage._el('span', 'reports-scope__name', scopeName));
      scope.appendChild(document.createTextNode(' '));
    }
    scope.appendChild(AdminReportsPage._el('span', 'reports-scope__id', state.tournamentId));
    shell.body.appendChild(scope);

    // Permanent live region for the counters_match warning: its CONTENTS
    // change, so it is announced when it appears.
    state.warnBox = AdminReportsPage._el('div', 'reports-warnings');
    state.warnBox.setAttribute('aria-live', 'polite');
    state.warnBox.setAttribute('aria-atomic', 'true');
    shell.body.appendChild(state.warnBox);

    state.statsBox = AdminReportsPage._el('div', 'reports-stats-box');
    state.statsBox.setAttribute('aria-live', 'polite');
    state.statsBox.setAttribute('aria-busy', 'false');
    shell.body.appendChild(state.statsBox);

    shell.body.appendChild(AdminReportsPage._buildDownloads());

    AdminReportsPage._mount(shell.main);
    AdminReportsPage._loadStats();
  },

  /* ================================================================== *
   * dashboard.adminStats
   * ================================================================== */

  /**
   * @return {!Promise<void>}
   */
  _loadStats: function () {
    const state = AdminReportsPage._state;
    if (!state || !state.statsBox) return Promise.resolve();

    AdminReportsPage._clearError(state.errors);
    state.statsBox.setAttribute('aria-busy', 'true');
    state.statsBox.textContent = '';
    state.statsBox.appendChild(UI.spinner('Counting…'));

    return AdminReportsPage._call('dashboard.adminStats', {
      tournamentId: state.tournamentId
    }).then(function (data) {
      if (!AdminReportsPage._current(state)) return;
      state.stats = data || {};
      AdminReportsPage._paintStats(state.stats);
    }).catch(function (err) {
      if (AdminReportsPage._handled(err) || !AdminReportsPage._current(state)) return;
      state.statsBox.setAttribute('aria-busy', 'false');
      state.statsBox.textContent = '';
      state.warnBox.textContent = '';
      AdminReportsPage._showError(state.errors, err);
    });
  },

  /**
   * @param {!Object} data the dashboard.adminStats response
   * @return {void}
   */
  _paintStats: function (data) {
    const state = AdminReportsPage._state;
    const box = state.statsBox;
    const blocks = Array.isArray(data.tournaments) ? data.tournaments : [];
    const block = blocks[0] || null;

    box.textContent = '';
    state.warnBox.textContent = '';

    if (!block) {
      // The route asked for one tournament and the server found none to
      // report on. Say so rather than drawing a grid of dashes.
      box.appendChild(AdminReportsPage._el('p', 'admin__empty reports-empty',
        'There are no numbers for this tournament. It may have been removed. ' +
        'Go back to the tournament list and choose another one.'));
      box.setAttribute('aria-busy', 'false');
      return;
    }

    AdminReportsPage._paintWarnings(block);
    AdminReportsPage._paintContext(box, block);

    AdminReportsPage.GROUPS.forEach(function (group) {
      box.appendChild(AdminReportsPage._group(group, block));
    });

    if (data.generated_at_display || data.generated_at) {
      box.appendChild(AdminReportsPage._el('p', 'reports-generated',
        'Counted at ' + String(data.generated_at_display || data.generated_at) +
        '. A report is a snapshot of a moving auction, so refresh before you ' +
        'quote a number.'));
    }

    box.setAttribute('aria-busy', 'false');
  },

  /**
   * The two situations where a grid of zeroes would be read as a bug.
   * @param {HTMLElement} box
   * @param {!Object} block one dashboard.adminStats tournament block
   * @return {void}
   */
  _paintContext: function (box, block) {
    const reg = block.registrations || {};
    const auction = block.auction || {};
    const teams = block.teams || {};

    if (!Number(reg.all)) {
      const info = UI.banner('info',
        'No players have registered for this tournament yet, so every number ' +
        'below is zero. The four exports will still download — they will ' +
        'contain their column headings and nothing else.');
      info.className += ' reports-context';
      box.appendChild(info);
      return;
    }

    const started = Number(auction.sold) || Number(auction.unsold) ||
      Number(auction.awaiting_reauction) || Number(auction.results_recorded) ||
      Number(teams.slots_filled);
    if (!started) {
      const info = UI.banner('info',
        'The auction has not started yet. All ' + AdminReportsPage._count(reg.eligible) +
        ' eligible player' + (Number(reg.eligible) === 1 ? '' : 's') +
        ' count as "Not called" until they are brought to the table, and the ' +
        'total auction value stays at ' + UI.money(0) + '.');
      info.className += ' reports-context';
      box.appendChild(info);
    }
  },

  /**
   * The drift warning.
   *
   * counters_match is false when the spend derived from the sold players does
   * not equal the cached Teams.purse_used, or the filled slots do not equal
   * the sold count. It drifts when a row is hand-edited in the sheet. The
   * numbers on this page are the DERIVED ones, so they are the trustworthy
   * side — but a purse shown to an organiser mid-auction comes from the
   * cached side, and that is now wrong by a known amount.
   *
   * @param {!Object} block one dashboard.adminStats tournament block
   * @return {void}
   */
  _paintWarnings: function (block) {
    const state = AdminReportsPage._state;
    const purse = block.purse || {};

    if (purse.counters_match !== false) return;

    const derived = Number(purse.spent) || 0;
    const cached = Number(purse.spent_recorded_on_teams) || 0;
    const gap = cached - derived;

    const warn = AdminReportsPage._el('div', 'banner banner--warning reports-drift');
    warn.setAttribute('role', 'alert');

    const mark = AdminReportsPage._el('span', 'banner__mark', '⚠');
    mark.setAttribute('aria-hidden', 'true');
    warn.appendChild(mark);
    warn.appendChild(document.createTextNode(' '));

    warn.appendChild(AdminReportsPage._el('strong', 'banner__title',
      'The stored team totals disagree with the auction history.'));

    const words = 'Adding up the sales gives ' + UI.money(derived) +
      ' spent, but the teams themselves record ' + UI.money(cached) +
      (gap === 0 ? '' : ' — a difference of ' + UI.money(Math.abs(gap)) +
        (gap > 0 ? ' too much on the teams' : ' too little on the teams')) +
      '. Every number on this page is worked out from the sales, so it is the ' +
      'reliable side; the purse an organiser sees on the auction console comes ' +
      'from the stored totals and is currently wrong. Repairing it rebuilds the ' +
      'stored totals from the auction history. This is exactly the silent drift ' +
      'the audit log exists to catch — the entries that changed a purse are on ' +
      'the audit screen.';
    warn.appendChild(document.createTextNode(' ' + words));

    // The repair, as a button rather than an instruction.
    //
    // This warning used to end with "Run team.recount", which is an action name,
    // not something an admin can do. The one moment this is noticed is likely to
    // be the evening before the auction, and telling someone to open the Apps
    // Script editor then is not a repair path. The action already exists and is
    // ADMIN-only; it just had no way to be called.
    const repair = UI.button('Repair the stored totals', function () {
      return AdminReportsPage._recount(state);
    }, { variant: 'primary' });
    // className, not classList: the rest of this file builds classes as strings
    // and the DOM stub the harness uses implements only what the app actually
    // relies on. Reaching for classList here made the whole warning throw.
    repair.className = repair.className + ' reports-drift__fix';
    warn.appendChild(document.createElement('br'));
    warn.appendChild(repair);

    state.warnBox.appendChild(warn);
  },

  /**
   * Rebuild the cached team counters from the append-only auction history.
   *
   * team.recount is the documented repair for counter drift (CONTRACTS-PHASE3
   * §3). AuctionResults is the truth; purse_used and players_count on the Teams
   * row are a cache that Phase 4 maintains inside the sale lock. If the two ever
   * disagree, this recomputes the cache — it never edits history.
   *
   * @param {!Object} state the page state
   * @return {!Promise} resolves once the page has reloaded its stats
   */
  _recount: function (state) {
    const tid = state.tournamentId;
    if (!tid) return Promise.resolve();

    return AdminReportsPage._call('team.recount', { tournamentId: tid })
      .then(function (res) {
        if (res === AdminReportsPage.REDIRECTED) return null;
        // Say what actually changed. "Done" is not enough for a number that
        // controls how much money a team is believed to have left.
        const changed = (res && typeof res.changed === 'number')
          ? res.changed
          : (res && Array.isArray(res.teams) ? res.teams.length : null);
        AdminReportsPage._say(
          changed === null
            ? 'Stored totals rebuilt from the auction history.'
            : 'Stored totals rebuilt from the auction history. ' +
              changed + (changed === 1 ? ' team was' : ' teams were') + ' corrected.');
        return AdminReportsPage._loadStats();
      })
      .catch(function (err) {
        if (err === AdminReportsPage.REDIRECTED) return null;
        AdminReportsPage._say(
          'Could not repair the totals: ' + ((err && err.message) || 'unknown error'));
        return null;
      });
  },

  /**
   * One group of tiles.
   * @param {!Object} group an entry from GROUPS
   * @param {!Object} block one dashboard.adminStats tournament block
   * @return {HTMLElement}
   */
  _group: function (group, block) {
    const section = AdminReportsPage._el('section', 'reports-group');

    const h = AdminReportsPage._el('h2', 'reports-group__title', group.title);
    section.appendChild(h);
    if (group.note) {
      section.appendChild(AdminReportsPage._el('p', 'reports-group__note', group.note));
    }

    const list = AdminReportsPage._el('ul', 'reports-tiles');
    group.tiles.forEach(function (tile) {
      const li = AdminReportsPage._el('li',
        'reports-tile' + (tile.headline ? ' reports-tile--headline' : ''));

      const raw = AdminReportsPage._pick(block, tile.path);
      const value = (raw === null || raw === undefined || raw === '')
        ? '—'
        : (tile.money ? UI.money(raw) : AdminReportsPage._count(raw));

      li.appendChild(AdminReportsPage._el('span', 'reports-tile__value', value));
      li.appendChild(AdminReportsPage._el('span', 'reports-tile__label', tile.label));
      if (tile.note) {
        li.appendChild(AdminReportsPage._el('span', 'reports-tile__note', tile.note));
      }
      list.appendChild(li);
    });
    section.appendChild(list);

    return section;
  },

  /**
   * Read "purse.spent" out of a stats block, safely.
   * @param {!Object} block
   * @param {string} path dotted
   * @return {*} the value, or null when any step is missing
   */
  _pick: function (block, path) {
    let node = block;
    const parts = String(path).split('.');
    for (let i = 0; i < parts.length; i++) {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      node = node[parts[i]];
    }
    return (node === undefined) ? null : node;
  },

  /* ================================================================== *
   * The four exports
   * ================================================================== */

  /**
   * The download panel. Every button is a real <button>; the anchor that
   * actually saves the file is created, clicked and removed inside
   * _saveFile, because a link cannot exist before the bytes do.
   * @return {HTMLElement}
   */
  _buildDownloads: function () {
    const state = AdminReportsPage._state;

    const section = AdminReportsPage._el('section', 'reports-downloads');
    section.appendChild(AdminReportsPage._el('h2', 'reports-group__title', 'Download'));

    /* SAID PLAINLY, NEXT TO THE BUTTONS. The person receiving these files
       opens them in Excel and sums a column; the two facts below are what
       decide whether that works (backend/Reports.gs header comment). */
    section.appendChild(AdminReportsPage._el('p', 'reports-downloads__note',
      'Each file is a CSV. Double-click it and it opens in Excel or Google ' +
      'Sheets. Money columns are plain whole numbers with no ₹ sign and no ' +
      'commas, so SUM and totals work on them. Mobile numbers are saved as ' +
      'text, so Excel keeps all ten digits instead of turning them into ' +
      'scientific notation. Names in any script come out correctly.'));

    const list = AdminReportsPage._el('ul', 'reports-downloads__list');
    AdminReportsPage.REPORTS.forEach(function (spec) {
      const li = AdminReportsPage._el('li', 'reports-download');

      const btn = UI.button(spec.label, function () {
        return AdminReportsPage._download(spec);
      }, { busyLabel: spec.busy });
      btn.className += ' reports-download__btn';
      li.appendChild(btn);

      li.appendChild(AdminReportsPage._el('p', 'reports-download__note', spec.note));
      list.appendChild(li);
    });
    section.appendChild(list);

    // One live region for all four, so a screen reader hears "Saved
    // ...-players-2026-08-30.csv, 400 rows" once, next to the buttons.
    state.downloadStatus = AdminReportsPage._el('p', 'reports-downloads__status');
    state.downloadStatus.setAttribute('role', 'status');
    state.downloadStatus.setAttribute('aria-live', 'polite');
    state.downloadStatus.setAttribute('aria-atomic', 'true');
    section.appendChild(state.downloadStatus);

    return section;
  },

  /**
   * Ask the server to build one export, then save it.
   *
   * A 400-row export is a full read of four tabs; UI.button's busy state is
   * the spinner, and the live region below says what is happening in words.
   *
   * @param {{key:string, action:string, label:string}} spec
   * @return {!Promise<void>}
   */
  _download: function (spec) {
    const state = AdminReportsPage._state;

    AdminReportsPage._clearError(state.errors);
    AdminReportsPage._say('Building the ' + spec.label + '. A 400-row export ' +
      'takes a second or two.');

    return AdminReportsPage._call(spec.action, { tournamentId: state.tournamentId })
      .then(function (file) {
        if (!AdminReportsPage._current(state)) return;

        const saved = AdminReportsPage._saveFile(file);
        const rows = Number(file && file.rows);
        AdminReportsPage._say('Saved ' + saved.filename +
          (isFinite(rows) && rows >= 0
            ? ' — ' + rows + ' row' + (rows === 1 ? '' : 's')
            : '') +
          '. Check your downloads folder.');
      })
      .catch(function (err) {
        if (AdminReportsPage._handled(err) || !AdminReportsPage._current(state)) return;
        AdminReportsPage._say('The ' + spec.label + ' was not downloaded.');
        AdminReportsPage._showError(state.errors, err);
      });
  },

  /**
   * @param {string} message
   * @return {void}
   */
  _say: function (message) {
    const state = AdminReportsPage._state;
    if (state && state.downloadStatus) state.downloadStatus.textContent = message;
  },

  /**
   * Turn {filename, mime, base64} into a saved file.
   *
   * THE BYTES ARE NOT TOUCHED. The server already put a UTF-8 BOM at the
   * front, quoted every field to RFC 4180, wrote money as bare integers and
   * mobiles as ="9876543210". Decoding to a string and re-encoding here would
   * risk undoing all four, so the base64 is decoded straight into bytes and
   * handed to the Blob as-is.
   *
   * @param {!Object} file the report.* response
   * @return {{filename:string, bytes:number}}
   * @throws {!Object} {code, message} when the payload cannot be decoded
   */
  _saveFile: function (file) {
    const payload = file || {};
    const filename = String(payload.filename || 'report.csv');
    const mime = String(payload.mime || 'text/csv;charset=utf-8');
    const bytes = AdminReportsPage._bytes(String(payload.base64 || ''));

    const blob = new Blob([bytes], { type: mime });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    // The attribute is what names the file on disk; the server built the name
    // from Util.slugify, so it is already safe for every OS.
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();
    if (a.parentNode) a.parentNode.removeChild(a);

    // Revoked, always — an un-revoked object URL keeps the whole file in
    // memory until the tab closes, and an admin exporting four reports a few
    // times over an afternoon would hold on to all of them.
    window.setTimeout(function () {
      try { window.URL.revokeObjectURL(url); } catch (e) { /* already gone */ }
    }, AdminReportsPage.REVOKE_DELAY_MS);

    return { filename: filename, bytes: bytes.length };
  },

  /**
   * base64 -> Uint8Array, one byte per character of the decoded string.
   * @param {string} base64
   * @return {!Uint8Array}
   * @throws {!Object} {code:'INTERNAL_ERROR'} when the payload is not base64
   */
  _bytes: function (base64) {
    const decode = (typeof window !== 'undefined' && window.atob)
      ? window.atob
      : (typeof atob === 'function' ? atob : null);
    if (!decode) {
      throw {
        code: 'INTERNAL_ERROR',
        message: 'This browser cannot decode the file. Try Chrome, Edge, Firefox or Safari.'
      };
    }

    let binary;
    try {
      binary = decode(base64);
    } catch (e) {
      throw {
        code: 'INTERNAL_ERROR',
        message: 'The server sent a file this page could not read. Try again, ' +
          'and if it keeps happening the export is failing on the server.'
      };
    }

    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xFF;
    return out;
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
