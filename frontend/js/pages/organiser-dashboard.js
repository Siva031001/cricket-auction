/**
 * organiser-dashboard.js — the /organiser/dashboard screen.
 * `OrganiserDashboardPage`.
 *
 * The team dashboard (DESIGN.md §17 / CONTRACTS-PHASE3.md §2), plus creating
 * and editing teams. This is the screen an organiser has open on a laptop at a
 * noisy venue, so everything on it is big, plainly worded, and numeric.
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE3 §2  team.createBatch / team.create / team.list /
 *                        team.squad / team.update / team.delete payloads and
 *                        their error codes
 *   CONTRACTS-PHASE3 §5  batch creation is the DEFAULT path; per_slot_remaining
 *                        is shown per team
 *   DESIGN.md §6.4       purse and squad size stay editable at any time; only
 *                        a change that contradicts existing data is refused
 *   DESIGN.md §6.5a      prices are unpredictable, so the honest continuous
 *                        signal is money-per-empty-slot, not a fixed threshold
 *   DESIGN.md §31        the squad view: players, amounts, totals
 *   CONTRACTS-PHASE1 §4  textContent only, vanilla JS, all traffic through API,
 *                        document.body.dataset.route
 *
 * FOUR RULES THIS FILE EXISTS TO KEEP
 *
 *   1. EIGHT TEAMS IS ONE REQUEST, NOT EIGHT.
 *      team.create is ~1.5s of round trip each; eight of them is a
 *      quarter-minute of an organiser staring at a form. The batch form is the
 *      main path and it sends every name in a single team.createBatch call.
 *      The one-at-a-time form is still here, folded away and labelled slower,
 *      because adding a ninth team later is a real thing (DESIGN.md §6.4).
 *
 *   2. "₹ PER EMPTY SLOT" IS THE HEADLINE NUMBER.
 *      Purse remaining alone does not tell an organiser whether a team is in
 *      trouble: ₹1,00,000 is comfortable with one slot left and hopeless with
 *      six. per_slot_remaining is the division the server has already done
 *      (CONTRACTS-PHASE3 §2), so it gets the largest type in the row and a
 *      word — "Low" / "Very low" — whenever it falls well under what the team
 *      could originally afford per slot.
 *
 *   3. NEVER HIDE A CONTROL TO PREVENT AN ERROR.
 *      Lowering a squad size below the players already bought is refused with
 *      SQUAD_BELOW_COUNT, and lowering a purse below what is spent with
 *      PURSE_BELOW_SPENT. Both messages name the number that blocks it, which
 *      is precisely what the organiser needs to know. So the controls stay
 *      enabled and the server's own words are printed, unedited.
 *
 *   4. THE COUNTERS ARE THE SERVER'S TO CALCULATE.
 *      purse_used, players_count, slots_remaining and per_slot_remaining are
 *      read straight off team.list and never recomputed here. A second
 *      definition of the same number is how two screens end up disagreeing
 *      (CONTRACTS-PHASE3 §3).
 */

/* eslint-disable no-unused-vars */
const OrganiserDashboardPage = {

  /** Organisers sign in through the same form as admins. @const {string} */
  LOGIN_PATH: '/admin/login',

  /** @const {string} */
  DASHBOARD_PATH: '/organiser/dashboard',

  /** Written by OrganiserJoinPage. Same key names on purpose. @const {string} */
  TOURNAMENT_KEY: 'ca.organiser.tournament',

  /** @const {string} */
  NAME_KEY: 'ca.organiser.name',

  /**
   * Thrown by _call() after it has already handled an expired session. A
   * caller that sees this must render nothing — the page is being replaced.
   * @const
   */
  REDIRECTED: Object.freeze({ code: 'REDIRECTED', message: '' }),

  /** 8 teams (CONTRACTS-PHASE3 §2, DESIGN.md §6.4). @const {number} */
  DEFAULT_TEAM_COUNT: 8,

  /** Team name limits, mirroring the server. @const {number} */
  NAME_MIN: 2,
  NAME_MAX: 40,

  /**
   * When to call money-per-empty-slot "Low" and "Very low".
   *
   * There is no absolute threshold — prices are unpredictable (DESIGN.md
   * §6.5a), so any fixed rupee figure would be a guess. The comparison that
   * does mean something is against the team's OWN starting position:
   * purse_total / max_players is what every slot could afford before a single
   * player was bought. Falling under half of that means the rest of the squad
   * has to be filled at well below the team's original average, and a quarter
   * means it is nearly out of room. Both are warnings, never blocks.
   * @const {number}
   */
  LOW_SLOT_RATIO: 0.5,
  CRITICAL_SLOT_RATIO: 0.25,

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
    document.body.dataset.route = 'organiser-dashboard';

    const gen = ++OrganiserDashboardPage._gen;
    const state = {
      gen: gen,
      busy: false,
      errors: null,
      notices: null,
      tournamentId: '',
      flash: OrganiserDashboardPage._flash || ''
    };
    OrganiserDashboardPage._flash = '';
    OrganiserDashboardPage._state = state;

    // No token at all: do not flash an empty dashboard, just go and sign in.
    if (!API.getToken()) {
      Router.navigate(OrganiserDashboardPage.LOGIN_PATH, { replace: true });
      return;
    }

    const query = (ctx && ctx.query) || {};
    const tid = OrganiserDashboardPage._resolveTournamentId(ctx);

    if (!tid) {
      OrganiserDashboardPage._renderNoTournament();
      return;
    }
    state.tournamentId = tid;

    if (String(query.view || '') === 'squad') {
      OrganiserDashboardPage._renderSquad(String(query.team || ''));
      return;
    }

    OrganiserDashboardPage._renderTeams();
  },

  /** Message shown once after the next render. @type {string} */
  _flash: '',

  /* ================================================================== *
   * Shared plumbing
   * ================================================================== */

  /**
   * Every backend call on this page goes through here.
   *
   * ONE place handles an expired session. A 12-hour session (CONTRACTS.md §7)
   * will expire under an organiser who left the laptop open overnight, and
   * that can happen on any of the six actions this page calls. Handling it per
   * call means six chances to forget one, and the one that is forgotten shows
   * "Not signed in" forever with no way out.
   *
   * The organiser's remembered tournament is cleared at the same time: the
   * next person to sign in on this venue laptop may well be a different
   * organiser on a different tournament.
   *
   * @param {string} action
   * @param {Object} [payload]
   * @return {!Promise<*>} rejects with OrganiserDashboardPage.REDIRECTED once
   *         the session is gone and navigation has already been started.
   */
  _call: function (action, payload) {
    return API.call(action, payload || {}).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        API.clearToken();
        OrganiserDashboardPage._forgetTournament();
        Router.navigate(OrganiserDashboardPage.LOGIN_PATH, { replace: true });
        throw OrganiserDashboardPage.REDIRECTED;
      }
      throw err;
    });
  },

  /**
   * @param {*} err
   * @return {boolean} true when _call has already navigated away
   */
  _handled: function (err) {
    return err === OrganiserDashboardPage.REDIRECTED;
  },

  /**
   * @param {Object} state
   * @return {boolean} true when this view is still the one on screen
   */
  _current: function (state) {
    return !!state && state.gen === OrganiserDashboardPage._gen;
  },

  /**
   * Which tournament this organiser is working on.
   *
   * There is no "who am I" endpoint in the Phase 3 contract, so the id comes
   * from, in order:
   *   1. ?t= in the address — always wins, so a link can be shared and an
   *      admin can open an organiser's dashboard for a named tournament;
   *   2. the copy OrganiserJoinPage saved when the organiser joined;
   *   3. the admin shell's remembered selection, if app.js is present.
   * It is a convenience only. The server re-checks the caller's own
   * tournament_id on every action (DESIGN.md §5.6), so a wrong id here
   * produces a refusal, never someone else's data.
   *
   * @param {Object} ctx
   * @return {string} a tournament id, or ''
   */
  _resolveTournamentId: function (ctx) {
    const query = (ctx && ctx.query) || {};
    const param = (typeof App !== 'undefined' && App && App.TOURNAMENT_PARAM)
      ? App.TOURNAMENT_PARAM : 't';

    const fromUrl = OrganiserDashboardPage._safeId(query[param]);
    if (fromUrl) return fromUrl;

    let stored = '';
    try {
      stored = OrganiserDashboardPage._safeId(
        window.localStorage.getItem(OrganiserDashboardPage.TOURNAMENT_KEY));
    } catch (e) {
      stored = '';
    }
    if (stored) return stored;

    if (typeof App !== 'undefined' && App &&
        typeof App.rememberedTournamentId === 'function') {
      return OrganiserDashboardPage._safeId(App.rememberedTournamentId());
    }
    return '';
  },

  /**
   * Ids are generated by the server and are id-shaped. Anything else came
   * from a hand-edited URL and is not worth putting in a request.
   * @param {*} value
   * @return {string}
   */
  _safeId: function (value) {
    const s = String(value === undefined || value === null ? '' : value).trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
  },

  /** @return {void} */
  _forgetTournament: function () {
    try {
      window.localStorage.removeItem(OrganiserDashboardPage.TOURNAMENT_KEY);
      window.localStorage.removeItem(OrganiserDashboardPage.NAME_KEY);
    } catch (e) {
      /* nothing useful to do */
    }
  },

  /**
   * An app path back into this page, carrying the tournament so the selection
   * survives a click.
   * @param {Object} [extra] additional query keys
   * @return {string}
   */
  _path: function (extra) {
    const param = (typeof App !== 'undefined' && App && App.TOURNAMENT_PARAM)
      ? App.TOURNAMENT_PARAM : 't';
    const state = OrganiserDashboardPage._state;
    const parts = [];

    if (state && state.tournamentId) {
      parts.push(param + '=' + encodeURIComponent(state.tournamentId));
    }
    Object.keys(extra || {}).forEach(function (k) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(extra[k])));
    });

    return OrganiserDashboardPage.DASHBOARD_PATH +
      (parts.length ? '?' + parts.join('&') : '');
  },

  /**
   * Page frame: heading, actions, live regions, body.
   * @param {string} title
   * @param {string} [note]
   * @return {{main:HTMLElement, actions:HTMLElement, errors:HTMLElement,
   *           notices:HTMLElement, body:HTMLElement}}
   */
  _shell: function (title, note) {
    document.title = title + ' · Cricket Auction';

    const main = document.createElement('main');
    main.className = 'panel org';

    const head = document.createElement('div');
    head.className = 'org__head';

    const heading = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = title;
    heading.appendChild(h1);

    if (note) {
      const p = document.createElement('p');
      p.className = 'panel__note';
      p.textContent = note;
      heading.appendChild(p);
    }
    head.appendChild(heading);

    const actions = document.createElement('div');
    actions.className = 'org__actions';
    head.appendChild(actions);

    main.appendChild(head);

    // Two permanent live regions. Errors interrupt (assertive) because they
    // stop the organiser doing what they were doing; confirmations wait for a
    // gap (polite). Both replace their contents rather than being added and
    // removed, which is what makes them announced reliably.
    const errors = document.createElement('div');
    errors.className = 'org__errors';
    errors.setAttribute('aria-live', 'assertive');
    errors.setAttribute('aria-atomic', 'true');
    main.appendChild(errors);

    const notices = document.createElement('div');
    notices.className = 'org__notices';
    notices.setAttribute('aria-live', 'polite');
    notices.setAttribute('aria-atomic', 'true');
    main.appendChild(notices);

    const body = document.createElement('div');
    body.className = 'org__body';
    main.appendChild(body);

    return {
      main: main, actions: actions, errors: errors, notices: notices, body: body
    };
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
   * @param {string} message
   * @return {void}
   */
  _showNotice: function (region, message) {
    if (!region) return;
    region.textContent = '';
    region.appendChild(UI.banner('success', String(message)));
  },

  /**
   * @param {HTMLElement} region
   * @return {void}
   */
  _clearError: function (region) {
    if (region) region.textContent = '';
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
   * @param {string} label
   * @param {string} path app path, no BASE_PATH
   * @param {string} [variant]
   * @return {HTMLElement}
   */
  _navButton: function (label, path, variant) {
    const a = document.createElement('a');
    a.className = 'btn btn--auto' + (variant === 'secondary' ? ' btn--secondary' : '');
    a.href = Router.href(path);   // Router's click handler turns this into pushState
    a.textContent = label;
    return a;
  },

  /**
   * Sign out. Clearing the token locally is the part that matters; the server
   * call is best effort.
   * @return {HTMLElement}
   */
  _signOutButton: function () {
    return UI.button('Sign out', function () {
      OrganiserDashboardPage._forgetTournament();

      if (typeof App !== 'undefined' && App && typeof App.signOut === 'function') {
        App.signOut();
        return;
      }
      API.call('auth.logout', {}, { retryBusy: false })
        .catch(function () { /* the session dies locally either way */ })
        .then(function () {
          API.clearToken();
          Router.navigate(OrganiserDashboardPage.LOGIN_PATH, { replace: true });
        });
    }, { variant: 'secondary' });
  },

  /* ================================================================== *
   * View 0 — no tournament to work on
   * ================================================================== */

  /** @return {void} */
  _renderNoTournament: function () {
    const shell = OrganiserDashboardPage._shell(
      'Teams',
      'This screen needs to know which tournament you are running.'
    );
    shell.actions.appendChild(OrganiserDashboardPage._signOutButton());

    OrganiserDashboardPage._showError(shell.errors,
      'No tournament is selected, so there are no teams to show.');

    const help = document.createElement('ul');
    help.className = 'org__help-list';
    [
      'If you are an organiser, open the join link the admin sent you, or sign ' +
        'in again — signing in tells this screen which tournament is yours.',
      'If you are an admin, choose a tournament on the admin dashboard first.'
    ].forEach(function (text) {
      const li = document.createElement('li');
      li.textContent = text;
      help.appendChild(li);
    });
    shell.body.appendChild(help);

    OrganiserDashboardPage._mount(shell.main);
  },

  /* ================================================================== *
   * View 1 — the team dashboard
   * ================================================================== */

  /** @return {void} */
  _renderTeams: function () {
    const state = OrganiserDashboardPage._state;

    const shell = OrganiserDashboardPage._shell(
      'Teams',
      'Purses, squad sizes and how much each team has left for every empty slot.'
    );
    state.errors = shell.errors;
    state.notices = shell.notices;

    shell.actions.appendChild(UI.button('Refresh', function () {
      OrganiserDashboardPage._renderTeams();
    }, { variant: 'secondary' }));
    shell.actions.appendChild(OrganiserDashboardPage._signOutButton());

    if (state.flash) {
      OrganiserDashboardPage._showNotice(shell.notices, state.flash);
      state.flash = '';
    }

    const box = document.createElement('div');
    box.appendChild(UI.spinner('Loading teams…'));
    shell.body.appendChild(box);

    OrganiserDashboardPage._mount(shell.main);

    OrganiserDashboardPage._call('team.list', { tournamentId: state.tournamentId })
      .then(function (data) {
        if (!OrganiserDashboardPage._current(state)) return;
        box.textContent = '';
        box.appendChild(OrganiserDashboardPage._teamsContent(data || {}));
      })
      .catch(function (err) {
        if (OrganiserDashboardPage._handled(err) ||
            !OrganiserDashboardPage._current(state)) return;
        box.textContent = '';
        OrganiserDashboardPage._showError(shell.errors, err);
        // The create forms still work when the list failed to load, and an
        // organiser with no teams and a flaky connection needs them to.
        box.appendChild(OrganiserDashboardPage._createSection(true));
      });
  },

  /**
   * @param {!Object} data team.list response {teams, totals}
   * @return {HTMLElement}
   */
  _teamsContent: function (data) {
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const wrap = document.createElement('div');

    wrap.appendChild(OrganiserDashboardPage._totals(data.totals || {}, teams.length));

    if (teams.length) {
      wrap.appendChild(OrganiserDashboardPage._teamsTable(teams));
    } else {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent =
        'No teams yet. Type all your team names below and create them in one go.';
      wrap.appendChild(empty);
    }

    wrap.appendChild(OrganiserDashboardPage._createSection(teams.length === 0));
    return wrap;
  },

  /**
   * The row of totals across every team.
   * @param {!Object} totals team.list totals block
   * @param {number} teamCount
   * @return {HTMLElement}
   */
  _totals: function (totals, teamCount) {
    const section = document.createElement('section');
    section.className = 'org-totals';

    const h2 = document.createElement('h2');
    h2.className = 'visually-hidden';
    h2.textContent = 'Totals across all teams';
    section.appendChild(h2);

    const list = document.createElement('dl');
    list.className = 'org-totals__list';

    /* totals carries no *_display fields (CONTRACTS-PHASE3 §2), so UI.money
       formats them — it is a deliberate port of the server's Util.formatINR,
       so the grouping matches the per-team figures beside it. */
    [
      ['Teams', OrganiserDashboardPage._count(
        totals.teams === undefined ? teamCount : totals.teams)],
      ['Purse total', UI.money(totals.purse_total || 0)],
      ['Spent', UI.money(totals.purse_used || 0)],
      ['Remaining', UI.money(totals.purse_remaining || 0)],
      ['Players bought', OrganiserDashboardPage._count(totals.players_count)],
      ['Slots left', OrganiserDashboardPage._count(totals.slots_remaining) + ' of ' +
        OrganiserDashboardPage._count(totals.slots_total)]
    ].forEach(function (pair) {
      const item = document.createElement('div');
      item.className = 'org-totals__item';

      const dt = document.createElement('dt');
      dt.className = 'org-totals__label';
      dt.textContent = pair[0];

      const dd = document.createElement('dd');
      dd.className = 'org-totals__value';
      dd.textContent = pair[1];

      item.appendChild(dt);
      item.appendChild(dd);
      list.appendChild(item);
    });

    section.appendChild(list);
    return section;
  },

  /**
   * @param {!Array<!Object>} teams
   * @return {HTMLElement}
   */
  _teamsTable: function (teams) {
    const wrap = document.createElement('div');
    wrap.className = 'table__wrap org-teams';

    const table = document.createElement('table');
    table.className = 'table org-teams__table';

    const caption = document.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent =
      'Every team, with its purse, what it has spent, how many players it has ' +
      'bought, and how much money it has left for each empty slot.';
    table.appendChild(caption);

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    [
      { text: 'Team', numeric: false },
      { text: 'Purse', numeric: true },
      { text: 'Used', numeric: true },
      { text: 'Remaining', numeric: true },
      { text: '₹ per empty slot', numeric: true },
      { text: 'Players', numeric: true },
      { text: 'Actions', numeric: false }
    ].forEach(function (col) {
      const th = document.createElement('th');
      th.scope = 'col';
      if (col.numeric) th.className = 'is-numeric';
      th.textContent = col.text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    teams.forEach(function (team) {
      // Each team contributes two rows: the figures, and a hidden edit form
      // underneath it. Building the form up front — rather than splicing a row
      // into the table on click — keeps the DOM order fixed and means the
      // Cancel button has nothing to clean up.
      const row = OrganiserDashboardPage._teamRow(team);
      tbody.appendChild(row.tr);
      tbody.appendChild(row.editTr);
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  },

  /**
   * @param {!Object} team one team.list entry
   * @return {{tr:HTMLElement, editTr:HTMLElement}}
   */
  _teamRow: function (team) {
    const tr = document.createElement('tr');
    tr.className = 'org-teams__row';

    /* Name. textContent, always: a team name is typed by a human into a form
       and stored in a sheet, so it is untrusted input. */
    const nameCell = document.createElement('th');
    nameCell.scope = 'row';
    nameCell.className = 'org-teams__name';

    const nameText = document.createElement('span');
    nameText.className = 'org-teams__name-text';
    nameText.textContent = String(team.team_name || '(unnamed team)');
    nameCell.appendChild(nameText);

    if (team.owner_name) {
      const owner = document.createElement('span');
      owner.className = 'org-teams__owner';
      owner.textContent = String(team.owner_name);
      nameCell.appendChild(owner);
    }
    tr.appendChild(nameCell);

    tr.appendChild(OrganiserDashboardPage._cell(
      OrganiserDashboardPage._money(team, 'purse_total'), 'is-numeric'));
    tr.appendChild(OrganiserDashboardPage._cell(
      OrganiserDashboardPage._money(team, 'purse_used'), 'is-numeric'));
    tr.appendChild(OrganiserDashboardPage._cell(
      OrganiserDashboardPage._money(team, 'purse_remaining'), 'is-numeric'));

    tr.appendChild(OrganiserDashboardPage._slotCell(team));

    const players = document.createElement('td');
    players.className = 'is-numeric org-teams__players';
    players.textContent = OrganiserDashboardPage._count(team.players_count) + ' / ' +
      OrganiserDashboardPage._count(team.max_players);
    const slots = document.createElement('span');
    slots.className = 'org-teams__slots';
    slots.textContent = OrganiserDashboardPage._count(team.slots_remaining) + ' empty';
    players.appendChild(slots);
    tr.appendChild(players);

    /* ---- actions --------------------------------------------------- */
    const actions = document.createElement('td');
    actions.className = 'org-teams__actions';

    const teamId = String(team.team_id || '');

    const editBtn = UI.button('Edit', function () {
      OrganiserDashboardPage._toggleEdit(editTr, editBtn, firstEditInput);
    }, { variant: 'secondary' });
    actions.appendChild(editBtn);

    actions.appendChild(OrganiserDashboardPage._navButton(
      'Squad', OrganiserDashboardPage._path({ view: 'squad', team: teamId }), 'secondary'));

    actions.appendChild(UI.button('Delete', function () {
      OrganiserDashboardPage._deleteTeam(team);
    }, { variant: 'danger' }));

    tr.appendChild(actions);

    /* ---- the hidden edit row --------------------------------------- */
    const editTr = document.createElement('tr');
    editTr.className = 'org-teams__editrow';
    editTr.hidden = true;

    const editCell = document.createElement('td');
    editCell.className = 'org-teams__editcell';
    editCell.setAttribute('colspan', '7');

    const editForm = OrganiserDashboardPage._editForm(team, editTr, editBtn);
    editCell.appendChild(editForm.el);
    editTr.appendChild(editCell);

    const firstEditInput = editForm.firstInput;

    return { tr: tr, editTr: editTr };
  },

  /**
   * The money-per-empty-slot cell — the one an organiser actually reads
   * mid-auction, so it gets the biggest type in the row plus a word when it
   * is low. Colour is never the only signal (DESIGN.md §51).
   *
   * @param {!Object} team
   * @return {HTMLElement}
   */
  _slotCell: function (team) {
    const td = document.createElement('td');
    const level = OrganiserDashboardPage._slotLevel(team);
    td.className = 'is-numeric org-teams__slot org-teams__slot--' + level.level;

    const value = document.createElement('span');
    value.className = 'org-slot__value';
    value.textContent = level.text;
    td.appendChild(value);

    if (level.label) {
      const flag = document.createElement('span');
      flag.className = 'org-slot__flag';
      flag.textContent = level.label;
      td.appendChild(flag);
    }

    return td;
  },

  /**
   * How much room a team has left per empty slot, and whether that is low.
   *
   * @param {!Object} team a team.list entry
   * @return {{level:string, text:string, label:string}}
   */
  _slotLevel: function (team) {
    const raw = team ? team.per_slot_remaining : null;

    // null means the squad is full (CONTRACTS-PHASE3 §2). Nothing to divide,
    // and nothing to warn about — a full squad is the goal, not a problem.
    if (raw === null || raw === undefined || raw === '') {
      return { level: 'full', text: 'Squad full', label: '' };
    }

    const value = Number(raw);
    const text = (team.per_slot_remaining_display)
      ? String(team.per_slot_remaining_display)
      : UI.money(isFinite(value) ? value : 0);

    if (!isFinite(value) || value <= 0) {
      return { level: 'critical', text: text, label: 'No money left' };
    }

    const total = Number(team.purse_total);
    const max = Number(team.max_players);
    const baseline = (isFinite(total) && isFinite(max) && max > 0) ? (total / max) : 0;
    if (!baseline) return { level: 'ok', text: text, label: '' };

    const ratio = value / baseline;
    if (ratio < OrganiserDashboardPage.CRITICAL_SLOT_RATIO) {
      return { level: 'critical', text: text, label: 'Very low' };
    }
    if (ratio < OrganiserDashboardPage.LOW_SLOT_RATIO) {
      return { level: 'low', text: text, label: 'Low' };
    }
    return { level: 'ok', text: text, label: '' };
  },

  /**
   * @param {HTMLElement} editTr
   * @param {HTMLElement} button
   * @param {?HTMLElement} firstInput
   * @return {void}
   */
  _toggleEdit: function (editTr, button, firstInput) {
    const open = !editTr.hidden;
    editTr.hidden = open;
    button.textContent = open ? 'Edit' : 'Close';
    button.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (!open && firstInput && firstInput.focus) firstInput.focus();
  },

  /* ------------------------------------------------------------------ *
   * Editing one team
   * ------------------------------------------------------------------ */

  /**
   * Purse and squad size stay changeable at any time (DESIGN.md §6.4). The
   * server refuses only what would contradict data that already exists, and
   * says why — so nothing here is disabled or hidden.
   *
   * @param {!Object} team
   * @param {HTMLElement} editTr the row this form lives in
   * @param {HTMLElement} editBtn the toggle that opened it
   * @return {{el:HTMLElement, firstInput:?HTMLElement}}
   */
  _editForm: function (team, editTr, editBtn) {
    const state = OrganiserDashboardPage._state;

    const form = document.createElement('form');
    form.className = 'form org-edit';
    form.setAttribute('novalidate', 'novalidate');

    const legend = document.createElement('h3');
    legend.className = 'org-edit__title';
    legend.textContent = 'Edit ' + String(team.team_name || 'this team');
    form.appendChild(legend);

    const grid = document.createElement('div');
    grid.className = 'org-edit__grid';

    const name = UI.field({
      label: 'Team name', name: 'teamName', type: 'text', required: true,
      value: String(team.team_name || ''),
      maxLength: OrganiserDashboardPage.NAME_MAX,
      hint: OrganiserDashboardPage.NAME_MIN + ' to ' + OrganiserDashboardPage.NAME_MAX +
        ' characters, and different from every other team.'
    });
    const owner = UI.field({
      label: 'Owner name', name: 'ownerName', type: 'text',
      value: String(team.owner_name || ''),
      hint: 'Optional.'
    });
    const purse = UI.field({
      label: 'Team purse', name: 'purseTotal', type: 'number',
      value: OrganiserDashboardPage._numberValue(team.purse_total),
      min: 1, step: 1, inputmode: 'numeric',
      hint: 'Whole rupees, digits only. Cannot go below what the team has already spent.'
    });
    const squad = UI.field({
      label: 'Squad size', name: 'maxPlayers', type: 'number',
      value: OrganiserDashboardPage._numberValue(team.max_players),
      min: 1, step: 1, inputmode: 'numeric',
      hint: 'Cannot go below the number of players the team has already bought.'
    });

    [name, owner, purse, squad].forEach(function (f) { grid.appendChild(f.wrap); });
    form.appendChild(grid);

    // Per-row live region, so the reason a change was refused appears beside
    // the control that caused it and not only at the top of a long page.
    const rowErrors = document.createElement('div');
    rowErrors.className = 'org-edit__errors';
    rowErrors.setAttribute('aria-live', 'assertive');
    rowErrors.setAttribute('aria-atomic', 'true');
    form.appendChild(rowErrors);

    const saveLabel = 'Save changes';
    const save = UI.button(saveLabel, function () { run(); },
      { variant: 'primary', type: 'submit' });
    const cancel = UI.button('Cancel', function () {
      OrganiserDashboardPage._toggleEdit(editTr, editBtn, null);
    }, { variant: 'secondary' });

    const bar = document.createElement('div');
    bar.className = 'btn-row org-edit__actions';
    bar.appendChild(save);
    bar.appendChild(cancel);
    form.appendChild(bar);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      run();
    });

    /**
     * @param {boolean} busy
     * @return {void}
     */
    function setBusy(busy) {
      save.disabled = !!busy;
      save.setAttribute('aria-busy', busy ? 'true' : 'false');
      save.textContent = busy ? 'Saving…' : saveLabel;
    }

    /** @return {void} */
    function run() {
      if (save.disabled) return;

      [name, owner, purse, squad].forEach(function (f) { f.clearError(); });
      rowErrors.textContent = '';
      OrganiserDashboardPage._clearError(state.errors);

      const values = {
        teamName: String(name.input.value || '').trim(),
        ownerName: String(owner.input.value || '').trim(),
        purseTotal: String(purse.input.value || '').trim(),
        maxPlayers: String(squad.input.value || '').trim()
      };

      const problems = [];
      if (!values.teamName) {
        problems.push({ handle: name, message: 'A team needs a name.' });
      } else if (values.teamName.length < OrganiserDashboardPage.NAME_MIN ||
                 values.teamName.length > OrganiserDashboardPage.NAME_MAX) {
        problems.push({
          handle: name,
          message: 'A team name must be ' + OrganiserDashboardPage.NAME_MIN + ' to ' +
            OrganiserDashboardPage.NAME_MAX + ' characters.'
        });
      }
      if (!/^[0-9]+$/.test(values.purseTotal) || Number(values.purseTotal) < 1) {
        problems.push({
          handle: purse,
          message: 'The purse must be a whole number of rupees, 1 or more. No decimals, no ₹ sign.'
        });
      }
      if (!/^[0-9]+$/.test(values.maxPlayers) || Number(values.maxPlayers) < 1) {
        problems.push({
          handle: squad, message: 'The squad size must be a whole number, 1 or more.'
        });
      }

      if (problems.length) {
        problems.forEach(function (p) { p.handle.setError(p.message); });
        OrganiserDashboardPage._showError(rowErrors, problems[0].message);
        if (problems[0].handle.input.focus) problems[0].handle.input.focus();
        return;
      }

      // Send only what changed. team.update audits prev/next for every key it
      // is given, so an unchanged field writes a pointless audit row.
      const payload = {
        tournamentId: state.tournamentId,
        teamId: String(team.team_id || '')
      };
      let changed = 0;
      if (values.teamName !== String(team.team_name || '')) {
        payload.teamName = values.teamName; changed += 1;
      }
      if (values.ownerName !== String(team.owner_name || '')) {
        payload.ownerName = values.ownerName; changed += 1;
      }
      if (values.purseTotal !== OrganiserDashboardPage._numberValue(team.purse_total)) {
        payload.purseTotal = Number(values.purseTotal); changed += 1;
      }
      if (values.maxPlayers !== OrganiserDashboardPage._numberValue(team.max_players)) {
        payload.maxPlayers = Number(values.maxPlayers); changed += 1;
      }

      if (!changed) {
        OrganiserDashboardPage._showError(rowErrors,
          'Nothing has changed, so there is nothing to save.');
        return;
      }

      setBusy(true);

      OrganiserDashboardPage._call('team.update', payload)
        .then(function () {
          if (!OrganiserDashboardPage._current(state)) return;
          OrganiserDashboardPage._flash =
            String(team.team_name || 'The team') + ' was updated.';
          OrganiserDashboardPage.render({
            query: OrganiserDashboardPage._queryForReload()
          });
        })
        .catch(function (err) {
          if (OrganiserDashboardPage._handled(err) ||
              !OrganiserDashboardPage._current(state)) return;
          setBusy(false);
          OrganiserDashboardPage._surfaceUpdateError(err, rowErrors, purse, squad, name);
        });
    }

    return { el: form, firstInput: name.input };
  },

  /**
   * Print the server's refusal WORD FOR WORD, against the control that caused
   * it.
   *
   * SQUAD_BELOW_COUNT and PURSE_BELOW_SPENT are not generic failures — the
   * server builds each message around the number that blocks the change
   * ("Chennai Warriors already has 12 players…", DESIGN.md §6.4). Rewriting
   * that into "invalid value" would throw away the only useful part.
   *
   * @param {{code:string, message:string}} err
   * @param {HTMLElement} region
   * @param {!Object} purse UI.field handle
   * @param {!Object} squad UI.field handle
   * @param {!Object} name  UI.field handle
   * @return {void}
   */
  _surfaceUpdateError: function (err, region, purse, squad, name) {
    const state = OrganiserDashboardPage._state;
    const code = err && err.code ? String(err.code) : '';
    const message = (err && err.message) ? String(err.message)
      : 'The change could not be saved.';

    if (code === 'SQUAD_BELOW_COUNT') {
      squad.setError(message);
      if (squad.input.focus) squad.input.focus();
    } else if (code === 'PURSE_BELOW_SPENT') {
      purse.setError(message);
      if (purse.input.focus) purse.input.focus();
    } else if (code === 'VALIDATION_FAILED') {
      name.setError(message);
      if (name.input.focus) name.input.focus();
    }

    OrganiserDashboardPage._showError(region, message);
    OrganiserDashboardPage._showError(state.errors, message);
  },

  /**
   * Delete a team. Only legal while it has no players (CONTRACTS-PHASE3 §2) —
   * deleting one with players would orphan them and leave their purse spent
   * against nothing. The server decides; TEAM_NOT_EMPTY is shown as it comes.
   *
   * @param {!Object} team
   * @return {void}
   */
  _deleteTeam: function (team) {
    const state = OrganiserDashboardPage._state;
    const teamName = String(team.team_name || 'this team');
    const count = Number(team.players_count) || 0;

    const body = count > 0
      ? teamName + ' has ' + count + ' player' + (count === 1 ? '' : 's') +
        ' already bought. A team with players cannot be deleted — release them ' +
        'first. Trying will show you the exact reason.'
      : teamName + ' has no players, so deleting it removes the team and its ' +
        'purse from this tournament. This cannot be undone.';

    UI.confirmDialog({
      title: 'Delete ' + teamName + '?',
      body: body,
      confirmLabel: 'Delete team',
      danger: true
    }).then(function (ok) {
      if (!ok || !OrganiserDashboardPage._current(state)) return null;

      OrganiserDashboardPage._clearError(state.errors);

      return OrganiserDashboardPage._call('team.delete', {
        tournamentId: state.tournamentId,
        teamId: String(team.team_id || '')
      }).then(function () {
        if (!OrganiserDashboardPage._current(state)) return;
        OrganiserDashboardPage._flash = teamName + ' was deleted.';
        OrganiserDashboardPage.render({ query: OrganiserDashboardPage._queryForReload() });
      });
    }).catch(function (err) {
      if (OrganiserDashboardPage._handled(err) ||
          !OrganiserDashboardPage._current(state)) return;
      // TEAM_NOT_EMPTY lands here, and its message names the team and the
      // players. Print it plainly.
      OrganiserDashboardPage._showError(state.errors, err);
    });
  },

  /* ------------------------------------------------------------------ *
   * Creating teams
   * ------------------------------------------------------------------ */

  /**
   * Batch creation first, one-at-a-time folded away underneath.
   * @param {boolean} openBatch  expand the batch form (no teams exist yet)
   * @return {HTMLElement}
   */
  _createSection: function (openBatch) {
    const section = document.createElement('section');
    section.className = 'org-create';

    section.appendChild(OrganiserDashboardPage._batchForm(openBatch));
    section.appendChild(OrganiserDashboardPage._singleForm());

    return section;
  },

  /**
   * ONE form, eight name boxes, one shared purse and squad size, ONE request.
   *
   * @param {boolean} open  start expanded
   * @return {HTMLElement}
   */
  _batchForm: function (open) {
    const state = OrganiserDashboardPage._state;

    const box = document.createElement('details');
    box.className = 'org-batch';
    if (open) box.open = true;

    const summary = document.createElement('summary');
    summary.className = 'org-batch__summary';
    summary.textContent = 'Create teams — type all the names, save once';
    box.appendChild(summary);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent =
      'This tournament runs ' + OrganiserDashboardPage.DEFAULT_TEAM_COUNT +
      ' teams. Type a name in each box and press Create — every team is made in ' +
      'a single save, with the same purse and squad size. Leave a box empty to ' +
      'skip it. You can change any team afterwards.';
    box.appendChild(note);

    const form = document.createElement('form');
    form.className = 'form org-batch__form';
    form.setAttribute('novalidate', 'novalidate');

    /* ---- shared purse and squad size -------------------------------- */
    const shared = document.createElement('div');
    shared.className = 'org-batch__shared';

    const purse = UI.field({
      label: 'Purse for every team', name: 'purseTotal', type: 'number',
      min: 1, step: 1, inputmode: 'numeric', placeholder: '500000',
      hint: 'Whole rupees, digits only. Leave blank to use the tournament default.'
    });
    const squad = UI.field({
      label: 'Squad size for every team', name: 'maxPlayers', type: 'number',
      min: 1, step: 1, inputmode: 'numeric', placeholder: '13',
      hint: 'Leave blank to use the tournament default. Change it per team later ' +
        'if one squad is 12 and another 13.'
    });
    shared.appendChild(purse.wrap);
    shared.appendChild(squad.wrap);
    form.appendChild(shared);

    /* ---- the name rows ---------------------------------------------- */
    const namesBox = document.createElement('div');
    namesBox.className = 'org-batch__names';
    form.appendChild(namesBox);

    const count = document.createElement('p');
    count.className = 'org-batch__count';
    count.setAttribute('aria-live', 'polite');
    form.appendChild(count);

    /** @type {!Array<!Object>} UI.field handles, in row order */
    const rows = [];

    /**
     * @return {void}
     */
    function refreshCount() {
      count.textContent = rows.length + ' name box' + (rows.length === 1 ? '' : 'es') +
        '. Empty boxes are ignored.';
      rows.forEach(function (row, i) {
        row.label.textContent = 'Team ' + (i + 1);
      });
    }

    /**
     * @param {string} [value]
     * @return {!Object} the row handle
     */
    function addRow(value) {
      const index = rows.length + 1;

      const wrap = document.createElement('div');
      wrap.className = 'org-batch__row';

      const field = UI.field({
        label: 'Team ' + index,
        name: 'team-' + index,
        type: 'text',
        maxLength: OrganiserDashboardPage.NAME_MAX,
        value: value || ''
      });
      wrap.appendChild(field.wrap);

      const remove = UI.button('Remove', function () {
        const at = rows.indexOf(row);
        if (at === -1) return;
        if (rows.length <= 1) {
          field.input.value = '';
          return;
        }
        rows.splice(at, 1);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        refreshCount();
      }, { variant: 'secondary' });
      remove.className += ' btn--small org-batch__remove';
      wrap.appendChild(remove);

      // The generated label element inside the field, so renumbering after a
      // removal does not have to rebuild the row.
      const labelEl = field.wrap.children && field.wrap.children.length
        ? field.wrap.children[0] : null;

      const row = {
        field: field,
        wrap: wrap,
        label: labelEl || { textContent: '' }
      };
      rows.push(row);
      namesBox.appendChild(wrap);
      return row;
    }

    for (let i = 0; i < OrganiserDashboardPage.DEFAULT_TEAM_COUNT; i++) addRow('');
    refreshCount();

    const addBtn = UI.button('Add another team', function () {
      const row = addRow('');
      refreshCount();
      if (row.field.input.focus) row.field.input.focus();
    }, { variant: 'secondary' });
    addBtn.className += ' btn--auto org-batch__add';
    form.appendChild(addBtn);

    const errors = document.createElement('div');
    errors.className = 'org-batch__errors';
    errors.setAttribute('aria-live', 'assertive');
    errors.setAttribute('aria-atomic', 'true');
    form.appendChild(errors);

    const createLabel = 'Create teams';
    const create = UI.button(createLabel, function () { run(); },
      { variant: 'primary', type: 'submit' });

    const bar = document.createElement('div');
    bar.className = 'org-batch__submit';
    bar.appendChild(create);
    form.appendChild(bar);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      run();
    });

    /**
     * @param {boolean} busy
     * @return {void}
     */
    function setBusy(busy) {
      create.disabled = !!busy;
      create.setAttribute('aria-busy', busy ? 'true' : 'false');
      create.textContent = busy ? 'Creating teams…' : createLabel;
    }

    /**
     * Validate the whole batch, then send it as ONE team.createBatch call.
     *
     * The duplicate check mirrors the server's (case-insensitive, whitespace
     * collapsed) and runs over the whole batch before anything is sent, for
     * the same reason the server validates before writing: a duplicate at
     * position 7 must not leave six teams created.
     * @return {void}
     */
    function run() {
      if (create.disabled) return;

      rows.forEach(function (row) { row.field.clearError(); });
      purse.clearError();
      squad.clearError();
      errors.textContent = '';
      OrganiserDashboardPage._clearError(state.errors);

      const names = [];
      const seen = {};
      let firstBad = null;

      rows.forEach(function (row) {
        const raw = String(row.field.input.value || '').trim();
        if (!raw) return;

        if (raw.length < OrganiserDashboardPage.NAME_MIN ||
            raw.length > OrganiserDashboardPage.NAME_MAX) {
          const msg = 'A team name must be ' + OrganiserDashboardPage.NAME_MIN +
            ' to ' + OrganiserDashboardPage.NAME_MAX + ' characters.';
          row.field.setError(msg);
          if (!firstBad) firstBad = { handle: row.field, message: msg };
          return;
        }

        const key = raw.toLowerCase().replace(/\s+/g, ' ');
        if (Object.prototype.hasOwnProperty.call(seen, key)) {
          const msg = 'Two teams cannot share the name "' + raw + '".';
          row.field.setError(msg);
          if (!firstBad) firstBad = { handle: row.field, message: msg };
          return;
        }
        seen[key] = true;
        names.push(raw);
      });

      const purseRaw = String(purse.input.value || '').trim();
      const squadRaw = String(squad.input.value || '').trim();

      if (purseRaw && (!/^[0-9]+$/.test(purseRaw) || Number(purseRaw) < 1)) {
        const msg = 'The purse must be a whole number of rupees, 1 or more. ' +
          'No decimals, no ₹ sign.';
        purse.setError(msg);
        if (!firstBad) firstBad = { handle: purse, message: msg };
      }
      if (squadRaw && (!/^[0-9]+$/.test(squadRaw) || Number(squadRaw) < 1)) {
        const msg = 'The squad size must be a whole number, 1 or more.';
        squad.setError(msg);
        if (!firstBad) firstBad = { handle: squad, message: msg };
      }

      if (!firstBad && !names.length) {
        firstBad = {
          handle: rows[0].field,
          message: 'Type at least one team name before creating.'
        };
        rows[0].field.setError(firstBad.message);
      }

      if (firstBad) {
        OrganiserDashboardPage._showError(errors, firstBad.message);
        if (firstBad.handle.input.focus) firstBad.handle.input.focus();
        return;
      }

      const payload = { tournamentId: state.tournamentId, names: names };
      // Omitted, not zeroed: the server falls back to the tournament's
      // default_purse / default_max_players when these are absent
      // (CONTRACTS-PHASE3 §2).
      if (purseRaw) payload.purseTotal = Number(purseRaw);
      if (squadRaw) payload.maxPlayers = Number(squadRaw);

      setBusy(true);

      OrganiserDashboardPage._call('team.createBatch', payload)
        .then(function (result) {
          if (!OrganiserDashboardPage._current(state)) return;
          const made = (result && Array.isArray(result.created))
            ? result.created.length : names.length;
          OrganiserDashboardPage._flash = made + ' team' + (made === 1 ? '' : 's') +
            ' created.';
          OrganiserDashboardPage.render({ query: OrganiserDashboardPage._queryForReload() });
        })
        .catch(function (err) {
          if (OrganiserDashboardPage._handled(err) ||
              !OrganiserDashboardPage._current(state)) return;
          setBusy(false);
          // Nothing was written — the server validates the whole batch first —
          // so the names stay on screen for a one-word fix and a retry.
          OrganiserDashboardPage._showError(errors, err);
          OrganiserDashboardPage._showError(state.errors, err);
        });
    }

    box.appendChild(form);
    return box;
  },

  /**
   * The slow path, kept and labelled as such. Useful for a ninth team added
   * later (DESIGN.md §6.4), not for the first eight.
   * @return {HTMLElement}
   */
  _singleForm: function () {
    const state = OrganiserDashboardPage._state;

    const box = document.createElement('details');
    box.className = 'org-single';

    const summary = document.createElement('summary');
    summary.className = 'org-single__summary';
    summary.textContent = 'Add one team on its own (slower)';
    box.appendChild(summary);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent =
      'One team per save, about a second and a half each. Use the form above for ' +
      'several teams at once; use this one to add a single extra team later.';
    box.appendChild(note);

    const form = document.createElement('form');
    form.className = 'form org-single__form';
    form.setAttribute('novalidate', 'novalidate');

    const name = UI.field({
      label: 'Team name', name: 'teamName', type: 'text', required: true,
      maxLength: OrganiserDashboardPage.NAME_MAX,
      hint: OrganiserDashboardPage.NAME_MIN + ' to ' + OrganiserDashboardPage.NAME_MAX +
        ' characters, and different from every other team.'
    });
    const owner = UI.field({
      label: 'Owner name', name: 'ownerName', type: 'text', hint: 'Optional.'
    });
    const purse = UI.field({
      label: 'Team purse', name: 'purseTotal', type: 'number',
      min: 1, step: 1, inputmode: 'numeric', placeholder: '500000',
      hint: 'Whole rupees. Leave blank to use the tournament default.'
    });
    const squad = UI.field({
      label: 'Squad size', name: 'maxPlayers', type: 'number',
      min: 1, step: 1, inputmode: 'numeric', placeholder: '13',
      hint: 'Leave blank to use the tournament default.'
    });

    const grid = document.createElement('div');
    grid.className = 'org-single__grid';
    [name, owner, purse, squad].forEach(function (f) { grid.appendChild(f.wrap); });
    form.appendChild(grid);

    const errors = document.createElement('div');
    errors.className = 'org-single__errors';
    errors.setAttribute('aria-live', 'assertive');
    errors.setAttribute('aria-atomic', 'true');
    form.appendChild(errors);

    const addLabel = 'Add team';
    const add = UI.button(addLabel, function () { run(); },
      { variant: 'primary', type: 'submit' });
    const bar = document.createElement('div');
    bar.className = 'org-single__submit';
    bar.appendChild(add);
    form.appendChild(bar);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      run();
    });

    /** @return {void} */
    function run() {
      if (add.disabled) return;

      [name, owner, purse, squad].forEach(function (f) { f.clearError(); });
      errors.textContent = '';

      const teamName = String(name.input.value || '').trim();
      const ownerName = String(owner.input.value || '').trim();
      const purseRaw = String(purse.input.value || '').trim();
      const squadRaw = String(squad.input.value || '').trim();

      let bad = null;
      if (teamName.length < OrganiserDashboardPage.NAME_MIN ||
          teamName.length > OrganiserDashboardPage.NAME_MAX) {
        bad = {
          handle: name,
          message: 'A team name must be ' + OrganiserDashboardPage.NAME_MIN + ' to ' +
            OrganiserDashboardPage.NAME_MAX + ' characters.'
        };
      } else if (purseRaw && (!/^[0-9]+$/.test(purseRaw) || Number(purseRaw) < 1)) {
        bad = {
          handle: purse,
          message: 'The purse must be a whole number of rupees, 1 or more.'
        };
      } else if (squadRaw && (!/^[0-9]+$/.test(squadRaw) || Number(squadRaw) < 1)) {
        bad = {
          handle: squad, message: 'The squad size must be a whole number, 1 or more.'
        };
      }

      if (bad) {
        bad.handle.setError(bad.message);
        OrganiserDashboardPage._showError(errors, bad.message);
        if (bad.handle.input.focus) bad.handle.input.focus();
        return;
      }

      const payload = { tournamentId: state.tournamentId, teamName: teamName };
      if (ownerName) payload.ownerName = ownerName;
      if (purseRaw) payload.purseTotal = Number(purseRaw);
      if (squadRaw) payload.maxPlayers = Number(squadRaw);

      add.disabled = true;
      add.textContent = 'Adding…';

      OrganiserDashboardPage._call('team.create', payload)
        .then(function (created) {
          if (!OrganiserDashboardPage._current(state)) return;
          OrganiserDashboardPage._flash =
            String((created && created.team_name) || teamName) + ' was created.';
          OrganiserDashboardPage.render({ query: OrganiserDashboardPage._queryForReload() });
        })
        .catch(function (err) {
          if (OrganiserDashboardPage._handled(err) ||
              !OrganiserDashboardPage._current(state)) return;
          add.disabled = false;
          add.textContent = addLabel;
          OrganiserDashboardPage._showError(errors, err);
        });
    }

    box.appendChild(form);
    return box;
  },

  /* ================================================================== *
   * View 2 — one team's squad (DESIGN.md §31)
   * ================================================================== */

  /**
   * @param {string} teamId from ?team=
   * @return {void}
   */
  _renderSquad: function (teamId) {
    const state = OrganiserDashboardPage._state;
    const id = OrganiserDashboardPage._safeId(teamId);

    const shell = OrganiserDashboardPage._shell('Squad', 'Who this team has bought, and for how much.');
    state.errors = shell.errors;
    state.notices = shell.notices;

    shell.actions.appendChild(OrganiserDashboardPage._navButton(
      'Back to teams', OrganiserDashboardPage._path(), 'secondary'));
    shell.actions.appendChild(OrganiserDashboardPage._signOutButton());

    if (!id) {
      OrganiserDashboardPage._mount(shell.main);
      OrganiserDashboardPage._showError(shell.errors,
        'No team was named in the address. Go back and choose one from the list.');
      return;
    }

    shell.body.appendChild(UI.spinner('Loading squad…'));
    OrganiserDashboardPage._mount(shell.main);

    OrganiserDashboardPage._call('team.squad', {
      tournamentId: state.tournamentId,
      teamId: id
    })
      .then(function (data) {
        if (!OrganiserDashboardPage._current(state)) return;
        shell.body.textContent = '';
        shell.body.appendChild(OrganiserDashboardPage._squadContent(data || {}));
      })
      .catch(function (err) {
        if (OrganiserDashboardPage._handled(err) ||
            !OrganiserDashboardPage._current(state)) return;
        shell.body.textContent = '';
        OrganiserDashboardPage._showError(shell.errors, err);
      });
  },

  /**
   * @param {!Object} data team.squad response
   * @return {HTMLElement}
   */
  _squadContent: function (data) {
    const team = data.team || {};
    const players = Array.isArray(data.players) ? data.players : [];

    const wrap = document.createElement('div');
    wrap.className = 'org-squad';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle org-squad__name';
    h2.textContent = String(team.team_name || 'Squad');
    wrap.appendChild(h2);

    const list = document.createElement('dl');
    list.className = 'org-totals__list org-squad__totals';

    [
      ['Players', OrganiserDashboardPage._count(data.total_players) +
        (team.max_players ? ' of ' + OrganiserDashboardPage._count(team.max_players) : '')],
      ['Spent', data.total_spent_display
        ? String(data.total_spent_display) : UI.money(data.total_spent || 0)],
      ['Purse left', data.purse_remaining_display
        ? String(data.purse_remaining_display)
        : OrganiserDashboardPage._money(team, 'purse_remaining')]
    ].forEach(function (pair) {
      const item = document.createElement('div');
      item.className = 'org-totals__item';
      const dt = document.createElement('dt');
      dt.className = 'org-totals__label';
      dt.textContent = pair[0];
      const dd = document.createElement('dd');
      dd.className = 'org-totals__value';
      dd.textContent = pair[1];
      item.appendChild(dt);
      item.appendChild(dd);
      list.appendChild(item);
    });
    wrap.appendChild(list);

    if (!players.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No players yet. This team has not bought anyone.';
      wrap.appendChild(empty);
      return wrap;
    }

    const scroll = document.createElement('div');
    scroll.className = 'table__wrap';

    const table = document.createElement('table');
    table.className = 'table org-squad__table';

    const caption = document.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = 'Players bought by this team, in the order they were sold.';
    table.appendChild(caption);

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    [
      { text: '#', numeric: true },
      { text: 'Player', numeric: false },
      { text: 'Role', numeric: false },
      { text: 'Style', numeric: false },
      { text: 'Sold for', numeric: true },
      { text: 'Sold at', numeric: false }
    ].forEach(function (col) {
      const th = document.createElement('th');
      th.scope = 'col';
      if (col.numeric) th.className = 'is-numeric';
      th.textContent = col.text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    players.forEach(function (p) {
      const tr = document.createElement('tr');

      const serial = document.createElement('th');
      serial.scope = 'row';
      serial.className = 'is-numeric';
      serial.textContent = OrganiserDashboardPage._count(p.serial_no);
      tr.appendChild(serial);

      tr.appendChild(OrganiserDashboardPage._cell(String(p.name || '—')));
      tr.appendChild(OrganiserDashboardPage._cell(p.role ? String(p.role) : '—'));
      tr.appendChild(OrganiserDashboardPage._cell(p.style ? String(p.style) : '—'));
      tr.appendChild(OrganiserDashboardPage._cell(
        p.sold_amount_display ? String(p.sold_amount_display) : UI.money(p.sold_amount || 0),
        'is-numeric'));
      tr.appendChild(OrganiserDashboardPage._cell(
        p.sold_at_display ? String(p.sold_at_display) : '—'));

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    scroll.appendChild(table);
    wrap.appendChild(scroll);
    return wrap;
  },

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  /**
   * The query object to re-render this page with after a change. Keeps the
   * tournament in the URL and drops any ?view=, so a save always lands back on
   * the team list.
   * @return {!Object}
   */
  _queryForReload: function () {
    const state = OrganiserDashboardPage._state;
    const param = (typeof App !== 'undefined' && App && App.TOURNAMENT_PARAM)
      ? App.TOURNAMENT_PARAM : 't';
    const query = {};
    if (state && state.tournamentId) query[param] = state.tournamentId;
    return query;
  },

  /**
   * @param {?string} text
   * @param {string} [className]
   * @return {HTMLElement}
   */
  _cell: function (text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = (text === null || text === undefined || text === '')
      ? '—' : String(text);
    return td;
  },

  /**
   * Money, preferring the server's own formatting.
   *
   * The API sends both `purse_total` and `purse_total_display` in the same
   * response (CONTRACTS-PHASE3 §2). Using the display string keeps every
   * screen agreeing about digit grouping; UI.money is the fallback and is a
   * deliberate port of the same server function.
   *
   * @param {!Object} row
   * @param {string} key e.g. 'purse_total'
   * @return {string}
   */
  _money: function (row, key) {
    const display = row ? row[key + '_display'] : null;
    if (display) return String(display);
    const raw = row ? row[key] : null;
    if (raw === null || raw === undefined || raw === '') return '—';
    return UI.money(Number(raw));
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
   * An integer as a form input would hold it. Used both to pre-fill and to
   * diff, so the two can never disagree about what "unchanged" means.
   * @param {*} n
   * @return {string}
   */
  _numberValue: function (n) {
    const v = Number(n);
    return isFinite(v) ? String(Math.round(v)) : '';
  }
};
