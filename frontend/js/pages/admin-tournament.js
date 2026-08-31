/**
 * admin-tournament.js — the /admin/dashboard screen.
 *
 * Tournament create / list / edit, plus the registration and projector links.
 * This is where a tournament is set up and where one gets SELECTED — every
 * other admin screen is scoped to the selection made here.
 *
 * Payment verification, the player list, organisers, teams, the auction,
 * reports and the audit log all exist and live on their own screens. This page
 * links to them in running order (_nextStepsPanel), because the sequence is not
 * obvious from a row of nav tabs.
 *
 * One page module, three views, chosen by ?view= :
 *   (none)         LIST    tournament.list
 *   ?view=create   CREATE  tournament.create
 *   ?view=edit&id= EDIT    tournament.get  ->  tournament.update
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE1 §1  image transport: base64 {data, mime, filename},
 *                        resized in the browser, QR kept as PNG
 *   CONTRACTS-PHASE1 §2  create / update / list / get / setStatus payloads
 *                        and the legal status transitions
 *   CONTRACTS.md §6a     a bare YYYY-MM-DD is an IST calendar day
 *   CONTRACTS.md §15     every call goes through API, never fetch
 *   CONTRACTS-PHASE1 §4  textContent only, vanilla JS, data-route on <body>
 */

/* eslint-disable no-unused-vars */
const AdminTournamentPage = {

  LOGIN_PATH: '/admin/login',
  DASHBOARD_PATH: '/admin/dashboard',

  /**
   * Thrown by _call() after it has already handled an expired session. A
   * caller that sees this must render nothing — the page is being replaced.
   * @const
   */
  REDIRECTED: Object.freeze({ code: 'REDIRECTED', message: '' }),

  /* ------------------------------------------------------------------ *
   * Status machine — CONTRACTS-PHASE1.md §2, tournament.setStatus.
   *
   * Encoded here so the UI can only ever offer a move the server will
   * accept. Anything missing from this table produces VALIDATION_FAILED on
   * the server, and an admin who is shown a button that then fails has been
   * told a lie by the interface.
   * ------------------------------------------------------------------ */

  /** @const {!Object<string, !Array<string>>} */
  TRANSITIONS: Object.freeze({
    DRAFT:          Object.freeze(['REG_OPEN']),
    REG_OPEN:       Object.freeze(['REG_CLOSED', 'AUCTION_LIVE']),
    REG_CLOSED:     Object.freeze(['REG_OPEN', 'AUCTION_LIVE']),
    AUCTION_LIVE:   Object.freeze(['AUCTION_CLOSED']),
    AUCTION_CLOSED: Object.freeze(['AUCTION_LIVE'])
  }),

  /** @const {!Object<string,string>} */
  STATUS_LABEL: Object.freeze({
    DRAFT:          'Draft',
    REG_OPEN:       'Registration open',
    REG_CLOSED:     'Registration closed',
    AUCTION_LIVE:   'Auction live',
    AUCTION_CLOSED: 'Auction closed'
  }),

  /** Button wording, keyed "FROM>TO". @const {!Object<string,string>} */
  TRANSITION_LABEL: Object.freeze({
    'DRAFT>REG_OPEN':               'Open registration',
    'REG_OPEN>REG_CLOSED':          'Close registration',
    'REG_CLOSED>REG_OPEN':          'Reopen registration',
    'REG_OPEN>AUCTION_LIVE':        'Start auction',
    'REG_CLOSED>AUCTION_LIVE':      'Start auction',
    'AUCTION_LIVE>AUCTION_CLOSED':  'Close auction',
    'AUCTION_CLOSED>AUCTION_LIVE':  'Reopen auction'
  }),

  /**
   * Moves that need a yes/no first. Keyed "FROM>TO"; anything not listed
   * happens on one click. `body` is a function of the tournament name so the
   * dialog names the tournament it is about to change.
   * @const
   */
  TRANSITION_CONFIRM: Object.freeze({
    // Allowed by the contract, but the contract also says to warn: players
    // can still register after bidding has started.
    'REG_OPEN>AUCTION_LIVE': Object.freeze({
      title: 'Start the auction with registration still open?',
      confirmLabel: 'Start auction anyway',
      body: function (name) {
        return 'Registration for ' + name + ' is still open, so new players can ' +
          'register while the auction runs. Close registration first if that is ' +
          'not what you want.';
      }
    }),
    'AUCTION_LIVE>AUCTION_CLOSED': Object.freeze({
      title: 'Close the auction?',
      confirmLabel: 'Close auction',
      body: function (name) {
        return 'Closing the auction for ' + name + ' ends all bidding. Results stay ' +
          'visible. Only an admin can reopen it, and the reopening is recorded in ' +
          'the audit log.';
      }
    }),
    // DESIGN.md §44 / CONTRACTS-PHASE1 §2: ADMIN only, and audited.
    'AUCTION_CLOSED>AUCTION_LIVE': Object.freeze({
      title: 'Reopen a closed auction?',
      confirmLabel: 'Reopen auction',
      body: function (name) {
        return 'The auction for ' + name + ' has already been closed and the results ' +
          'may have been shared. Reopening it allows the results to change and is ' +
          'recorded in the audit log with your name on it.';
      }
    })
  }),

  /* ------------------------------------------------------------------ *
   * Image handling — CONTRACTS-PHASE1.md §1.
   * ------------------------------------------------------------------ */

  /** Logo and gallery: 1024 px longest side, JPEG 0.8, PNG left as PNG. */
  IMAGE_OPTS: Object.freeze({ maxEdge: 1024, quality: 0.8, keepPng: true }),

  /**
   * The UPI QR image.
   *
   * keepPng:true IS NOT OPTIONAL AND IS NOT A STYLE CHOICE.
   * A QR code is high-contrast fine detail, which is the exact thing JPEG's
   * lossy 8x8 blocks destroy. Re-encoding a PNG QR as JPEG smears the module
   * edges, the error-correction budget gets spent on the artefacts, and some
   * phone cameras then refuse to read it at all. This QR is the only way a
   * player can pay, so an unscannable QR does not degrade registration — it
   * stops every registration in the tournament. Keep the PNG.
   */
  QR_IMAGE_OPTS: Object.freeze({ maxEdge: 1024, quality: 0.8, keepPng: true }),

  /* ------------------------------------------------------------------ *
   * Form definition. One table, used to build the create form, the edit
   * form, the validation pass and the changed-fields diff, so the four can
   * never drift apart.
   *
   *   name    key in the tournament.create / update payload
   *   column  matching column in the Tournaments sheet row returned by
   *           tournament.get (CONTRACTS.md §4 header order)
   * ------------------------------------------------------------------ */

  /** @const {!Array<!Object>} */
  FORM_FIELDS: Object.freeze([
    {
      name: 'name', column: 'name', label: 'Tournament name', type: 'text',
      required: true, group: 'About',
      hint: '3 to 80 characters. Players see this at the top of the registration page.'
    },
    {
      name: 'description', column: 'description', label: 'Description',
      type: 'textarea', required: false, group: 'About',
      hint: 'A short introduction shown above the registration form. Optional.'
    },
    {
      name: 'rules', column: 'rules', label: 'Rules', type: 'textarea',
      required: false, group: 'About',
      hint: 'Shown to players before they register. Optional.'
    },
    {
      name: 'startDate', column: 'start_date', label: 'First day of play',
      type: 'date', required: true, group: 'Dates',
      hint: 'An Indian calendar day (IST).'
    },
    {
      name: 'endDate', column: 'end_date', label: 'Last day of play',
      type: 'date', required: true, group: 'Dates',
      hint: 'Must not be before the first day.'
    },
    {
      name: 'regStart', column: 'reg_start', label: 'Registration opens',
      type: 'date', required: true, group: 'Dates',
      // CONTRACTS.md §6a: a bare date is a whole IST day.
      hint: 'Opens at 00:00 IST on this day.'
    },
    {
      name: 'regEnd', column: 'reg_end', label: 'Registration closes',
      type: 'date', required: true, group: 'Dates',
      hint: 'Stays open all of this day, until 23:59 IST.'
    },
    {
      name: 'regFee', column: 'reg_fee', label: 'Registration fee', type: 'number',
      required: true, group: 'Money and contact', integer: true, min: 0,
      placeholder: '500',
      hint: 'Whole rupees, digits only. No decimals, no ₹ sign.'
    },
    {
      name: 'upiId', column: 'upi_id', label: 'UPI ID', type: 'text',
      required: true, group: 'Money and contact', placeholder: 'name@bank',
      hint: 'Where players pay the fee. Must look like something@something.'
    },
    {
      name: 'contactName', column: 'contact_name', label: 'Contact name',
      type: 'text', required: true, group: 'Money and contact',
      hint: 'Shown publicly, so players know who to call.'
    },
    {
      name: 'contactMobile', column: 'contact_mobile', label: 'Contact mobile',
      type: 'tel', required: true, group: 'Money and contact',
      placeholder: '9876543210',
      hint: '10 digits, starting 6 to 9. Shown publicly.'
    },
    {
      name: 'contactEmail', column: 'contact_email', label: 'Contact email',
      type: 'email', required: false, group: 'Money and contact',
      hint: 'For you only. Never shown on the public registration page.'
    },
    {
      name: 'defaultPurse', column: 'default_purse', label: 'Default team purse',
      type: 'number', required: true, group: 'Team defaults', integer: true, min: 1,
      placeholder: '500000',
      hint: 'Whole rupees. Pre-fills the purse of every team you create later.'
    },
    {
      name: 'defaultMaxPlayers', column: 'default_max_players',
      label: 'Default squad size', type: 'number', required: true,
      group: 'Team defaults', integer: true, min: 1, placeholder: '13',
      // DESIGN.md §6.4: 8 teams of 12 or 13, adjustable per team afterwards.
      hint: 'Pre-fills each team\'s player limit. This tournament runs 8 teams of ' +
            '12 or 13, so 13 is the usual value — you can change it per team later.'
    }
  ]),

  /** Order the groups appear in. @const {!Array<string>} */
  FORM_GROUPS: Object.freeze(['About', 'Dates', 'Money and contact', 'Team defaults']),

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
    document.body.dataset.route = 'admin-dashboard';

    AdminTournamentPage._releaseObjectUrls();
    const gen = ++AdminTournamentPage._gen;
    AdminTournamentPage._state = { gen: gen, busy: false, objectUrls: [] };

    // No token at all: do not flash an empty dashboard, just go and sign in.
    if (!API.getToken()) {
      Router.navigate(AdminTournamentPage.LOGIN_PATH, { replace: true });
      return;
    }

    const query = (ctx && ctx.query) || {};
    const view = String(query.view || 'list');

    if (view === 'create') {
      AdminTournamentPage._renderCreate();
    } else if (view === 'edit') {
      AdminTournamentPage._renderEdit(String(query.id || ''));
    } else {
      AdminTournamentPage._renderList();
    }
  },

  /* ================================================================== *
   * Shared plumbing
   * ================================================================== */

  /**
   * Every backend call on this page goes through here.
   *
   * ONE place handles an expired session. A 12-hour session (CONTRACTS.md §7
   * rule 3) will expire under an admin who left the tab open overnight, and
   * that can happen on any of the five actions this page calls. Handling it
   * per call means five chances to forget one, and the one that is forgotten
   * shows "Not signed in" forever with no way out.
   *
   * @param {string} action
   * @param {Object} [payload]
   * @return {!Promise<*>} rejects with AdminTournamentPage.REDIRECTED once the
   *         session is gone and navigation has already been started.
   */
  _call: function (action, payload) {
    return API.call(action, payload || {}).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        API.clearToken();
        Router.navigate(AdminTournamentPage.LOGIN_PATH, { replace: true });
        throw AdminTournamentPage.REDIRECTED;
      }
      throw err;
    });
  },

  /**
   * @param {*} err
   * @return {boolean} true when _call has already navigated away
   */
  _handled: function (err) {
    return err === AdminTournamentPage.REDIRECTED;
  },

  /**
   * @param {Object} state the state captured when the view was built
   * @return {boolean} true when this view is still the one on screen
   */
  _current: function (state) {
    return !!state && state.gen === AdminTournamentPage._gen;
  },

  /**
   * Build the page frame: header, action bar, live error region, body.
   * @param {string} title
   * @param {string} [note]
   * @return {{main:HTMLElement, actions:HTMLElement, errors:HTMLElement, body:HTMLElement}}
   */
  _shell: function (title, note) {
    document.title = title + ' · Cricket Auction';

    const main = document.createElement('main');
    main.className = 'panel admin';

    const head = document.createElement('div');
    head.className = 'admin__head';

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
    actions.className = 'admin__actions';
    head.appendChild(actions);

    main.appendChild(head);

    // Permanent live region. Errors replace its contents rather than being
    // added and removed, which is what makes them announced reliably.
    const errors = document.createElement('div');
    errors.className = 'admin__errors';
    errors.setAttribute('aria-live', 'assertive');
    errors.setAttribute('aria-atomic', 'true');
    main.appendChild(errors);

    const body = document.createElement('div');
    body.className = 'admin__body';
    main.appendChild(body);

    return { main: main, actions: actions, errors: errors, body: body };
  },

  /**
   * @param {HTMLElement} region the live region from _shell
   * @param {string|{message:string}} err
   * @return {void}
   */
  _showError: function (region, err) {
    if (!region) return;
    const message = (typeof err === 'string')
      ? err
      : ((err && err.message) ? String(err.message) : 'Something went wrong. Please try again.');
    region.textContent = '';
    region.appendChild(UI.banner('error', message));
    region.scrollIntoView({ block: 'nearest' });
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
   * Sign-out button, present on every view. Clearing the token locally is the
   * part that matters; the server call is best effort.
   * @return {HTMLElement}
   */
  _signOutButton: function () {
    return UI.button('Sign out', function () {
      API.call('auth.logout', {}, { retryBusy: false })
        .catch(function () { /* the session dies locally either way */ })
        .then(function () {
          API.clearToken();
          Router.navigate(AdminTournamentPage.LOGIN_PATH, { replace: true });
        });
    }, { variant: 'secondary' });
  },

  /**
   * Link button that navigates inside the SPA.
   * @param {string} label
   * @param {string} path app path, no BASE_PATH
   * @param {string} [variant]
   * @return {HTMLElement}
   */
  _navButton: function (label, path, variant) {
    const a = document.createElement('a');
    a.className = 'btn' + (variant === 'secondary' ? ' btn--secondary' : '');
    a.href = Router.href(path);      // Router's click handler turns this into pushState
    a.textContent = label;
    return a;
  },

  /* ================================================================== *
   * View 1 — LIST
   * ================================================================== */

  /** @return {void} */
  _renderList: function () {
    const state = AdminTournamentPage._state;
    const shell = AdminTournamentPage._shell(
      'Tournaments',
      'Create a tournament, share its registration link, and watch registrations arrive.'
    );
    state.errors = shell.errors;

    shell.actions.appendChild(
      AdminTournamentPage._navButton('New tournament', AdminTournamentPage.DASHBOARD_PATH + '?view=create')
    );
    shell.actions.appendChild(AdminTournamentPage._signOutButton());

    const listBox = document.createElement('div');
    listBox.appendChild(UI.spinner('Loading tournaments…'));
    shell.body.appendChild(listBox);

    shell.body.appendChild(AdminTournamentPage._nextStepsPanel(
      (typeof App !== 'undefined' && App.currentTournamentId)
        ? App.currentTournamentId() : ''));

    AdminTournamentPage._mount(shell.main);

    AdminTournamentPage._call('tournament.list', {})
      .then(function (rows) {
        if (!AdminTournamentPage._current(state)) return;
        listBox.textContent = '';
        listBox.appendChild(AdminTournamentPage._listContent(rows || []));
      })
      .catch(function (err) {
        if (AdminTournamentPage._handled(err) || !AdminTournamentPage._current(state)) return;
        listBox.textContent = '';
        AdminTournamentPage._showError(shell.errors, err);
      });
  },

  /**
   * @param {!Array<!Object>} rows tournament.list response
   * @return {HTMLElement}
   */
  _listContent: function (rows) {
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'admin__empty';
      empty.textContent =
        'No tournaments yet. Choose "New tournament" to create the first one.';
      return empty;
    }

    const wrap = document.createElement('div');
    wrap.className = 'admin-table__scroll';

    const table = document.createElement('table');
    table.className = 'admin-table';

    const caption = document.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = 'All tournaments, with their status and registration counts.';
    table.appendChild(caption);

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Tournament', 'Status', 'Registration window', 'Fee', 'Registered', 'Verified', 'Actions']
      .forEach(function (text) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = text;
        headRow.appendChild(th);
      });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      tbody.appendChild(AdminTournamentPage._listRow(row));
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  },

  /**
   * @param {!Object} row one tournament.list entry
   * @return {HTMLElement}
   */
  _listRow: function (row) {
    const tr = document.createElement('tr');
    const tid = String(row.tournament_id || '');

    /* Name. textContent, always: a tournament name is typed by a human into a
       form and stored in a sheet, so it is untrusted input. */
    const nameCell = document.createElement('th');
    nameCell.scope = 'row';
    nameCell.className = 'admin-table__name';
    const nameText = document.createElement('span');
    nameText.textContent = String(row.name || '(untitled)');
    nameCell.appendChild(nameText);
    if (row.slug) {
      const slug = document.createElement('span');
      slug.className = 'admin-table__slug';
      slug.textContent = String(row.slug);
      nameCell.appendChild(slug);
    }
    tr.appendChild(nameCell);

    tr.appendChild(AdminTournamentPage._cell(null, AdminTournamentPage._statusPill(row.status)));

    // Dates come pre-formatted from the server where the API supplies a
    // *_display field (CONTRACTS.md §6a rule 4). Reformatting a date in the
    // browser is how an IST day silently becomes the day before.
    tr.appendChild(AdminTournamentPage._cell(
      AdminTournamentPage._dateText(row, 'reg_start') + ' – ' +
      AdminTournamentPage._dateText(row, 'reg_end')
    ));

    tr.appendChild(AdminTournamentPage._cell(AdminTournamentPage._money(row.reg_fee), null, 'num'));
    tr.appendChild(AdminTournamentPage._cell(AdminTournamentPage._count(row.player_count), null, 'num'));
    tr.appendChild(AdminTournamentPage._cell(AdminTournamentPage._count(row.verified_count), null, 'num'));

    /* Actions */
    const actions = document.createElement('td');
    actions.className = 'admin-table__actions';

    actions.appendChild(AdminTournamentPage._navButton(
      'Edit',
      AdminTournamentPage.DASHBOARD_PATH + '?view=edit&id=' + encodeURIComponent(tid),
      'secondary'
    ));

    actions.appendChild(AdminTournamentPage._copyButton(
      'Copy registration link',
      AdminTournamentPage._registrationUrl(tid)
    ));

    const statusBox = document.createElement('div');
    statusBox.className = 'admin-table__status-controls';
    AdminTournamentPage._statusControls(row, statusBox);
    actions.appendChild(statusBox);

    tr.appendChild(actions);
    return tr;
  },

  /**
   * Render exactly the legal next moves for this row, and nothing else.
   * @param {!Object} row
   * @param {HTMLElement} box container, emptied first
   * @return {void}
   */
  _statusControls: function (row, box) {
    box.textContent = '';

    const from = String(row.status || '');
    const next = AdminTournamentPage.nextStatuses(from);

    if (!next.length) {
      const none = document.createElement('span');
      none.className = 'admin-table__no-moves';
      none.textContent = 'No status change available';
      box.appendChild(none);
      return;
    }

    next.forEach(function (to) {
      const label = AdminTournamentPage.TRANSITION_LABEL[from + '>' + to] ||
        ('Set ' + (AdminTournamentPage.STATUS_LABEL[to] || to));

      // No busyLabel: UI.button's guard restores itself when the promise its
      // handler returns settles, and this one returns nothing. _applyStatus
      // owns the busy state for the whole control group instead, because a
      // status change disables its siblings too.
      const btn = UI.button(label, function () {
        AdminTournamentPage._applyStatus(row, to, box, btn);
      }, { variant: 'secondary' });

      box.appendChild(btn);
    });
  },

  /**
   * The legal next states for a status, straight from the contract table.
   * An unknown status yields an empty list, so a column value this build has
   * never heard of shows no buttons rather than a wrong one.
   *
   * @param {string} status
   * @return {!Array<string>}
   */
  nextStatuses: function (status) {
    const list = AdminTournamentPage.TRANSITIONS[String(status || '').toUpperCase()];
    return list ? list.slice() : [];
  },

  /**
   * Confirm where the contract asks for it, then call tournament.setStatus.
   * @param {!Object} row
   * @param {string} to
   * @param {HTMLElement} box the status control container, re-rendered on success
   * @param {HTMLElement} btn the button that was pressed
   * @return {void}
   */
  _applyStatus: function (row, to, box, btn) {
    const state = AdminTournamentPage._state;
    const from = String(row.status || '');

    // Belt and braces. The buttons are built from the same table, so this can
    // only fire if something else went wrong — but a status change is exactly
    // the kind of thing that should refuse rather than guess.
    if (AdminTournamentPage.nextStatuses(from).indexOf(to) === -1) {
      AdminTournamentPage._showError(state.errors,
        'Cannot move this tournament from ' + AdminTournamentPage._statusText(from) +
        ' to ' + AdminTournamentPage._statusText(to) + '.');
      return;
    }

    const rule = AdminTournamentPage.TRANSITION_CONFIRM[from + '>' + to];
    const name = String(row.name || 'this tournament');

    const ask = rule
      ? UI.confirmDialog({
        title: rule.title,
        body: rule.body(name),
        confirmLabel: rule.confirmLabel
      })
      : Promise.resolve(true);

    ask.then(function (ok) {
      if (!ok || !AdminTournamentPage._current(state)) return null;

      AdminTournamentPage._clearError(state.errors);
      AdminTournamentPage._setControlsBusy(box, true);
      btn.textContent = 'Working…';

      return AdminTournamentPage._call('tournament.setStatus', {
        tournamentId: String(row.tournament_id || ''),
        status: to
      }).then(function () {
        if (!AdminTournamentPage._current(state)) return;
        // Counts and the window can change meaning with the status, so reload
        // the whole list rather than patching one cell.
        AdminTournamentPage._renderList();
      });
    }).catch(function (err) {
      if (AdminTournamentPage._handled(err) || !AdminTournamentPage._current(state)) return;
      AdminTournamentPage._setControlsBusy(box, false);
      AdminTournamentPage._statusControls(row, box);
      AdminTournamentPage._showError(state.errors, err);
    });
  },

  /**
   * @param {HTMLElement} box
   * @param {boolean} busy
   * @return {void}
   */
  _setControlsBusy: function (box, busy) {
    const buttons = box.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].disabled = !!busy;
    }
  },

  /* ================================================================== *
   * View 2 — CREATE
   * ================================================================== */

  /** @return {void} */
  _renderCreate: function () {
    const state = AdminTournamentPage._state;
    const shell = AdminTournamentPage._shell(
      'New tournament',
      'Everything here can be edited afterwards. The tournament starts as a draft, ' +
      'so nothing is public until you open registration.'
    );
    state.errors = shell.errors;

    shell.actions.appendChild(
      AdminTournamentPage._navButton('Back to tournaments', AdminTournamentPage.DASHBOARD_PATH, 'secondary')
    );

    const form = AdminTournamentPage._buildForm('create', null, function (payload, ui) {
      return AdminTournamentPage._call('tournament.create', payload)
        .then(function (result) {
          if (!AdminTournamentPage._current(state)) return;
          AdminTournamentPage._renderCreated(result || {});
        });
    });

    shell.body.appendChild(form.el);
    AdminTournamentPage._mount(shell.main);
    if (form.firstInput) form.firstInput.focus();
  },

  /**
   * The one screen that matters after creating a tournament: the links.
   * Everything else the admin can find again; the registration link is the
   * thing they are about to paste into a WhatsApp group.
   *
   * @param {!Object} result tournament.create response
   * @return {void}
   */
  _renderCreated: function (result) {
    const state = AdminTournamentPage._state;
    const tid = String(result.tournament_id || '');

    const shell = AdminTournamentPage._shell(
      'Tournament created',
      'It is a draft for now. Open registration from the tournament list when you ' +
      'are ready for players to sign up.'
    );
    state.errors = shell.errors;

    shell.actions.appendChild(
      AdminTournamentPage._navButton('Back to tournaments', AdminTournamentPage.DASHBOARD_PATH, 'secondary')
    );

    const links = document.createElement('section');
    links.className = 'linkbox';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Share these links';
    links.appendChild(h2);

    // Prefer the server's URLs; fall back to building them locally so the
    // screen is still useful if a field is missing.
    links.appendChild(AdminTournamentPage._linkRow(
      'Registration link',
      'Send this to players. It is the only link they need.',
      String(result.registrationUrl || AdminTournamentPage._registrationUrl(tid)),
      true
    ));

    links.appendChild(AdminTournamentPage._linkRow(
      'Projector display link',
      'Open this on the laptop plugged into the projector on auction day. It is ' +
      'read-only and shows no admin controls — keep the key in the link private.',
      String(result.displayUrl || AdminTournamentPage._displayUrl(tid, result.display_token)),
      false
    ));

    // Stream (OBS) and Watch use the SAME key as the projector link above —
    // there is nothing extra to generate or configure. They exist so an admin
    // never has to hand-type or guess these URLs, which is exactly how they
    // used to get the shape wrong (putting "stream" inside /auction/.../).
    links.appendChild(AdminTournamentPage._linkRow(
      'OBS overlay link',
      'Paste this into OBS Studio as a Browser Source (Width 1920, Height 1080). ' +
      'Transparent background — it sits over your camera, it is not a page to open ' +
      'in a normal browser tab.',
      String(result.streamUrl || AdminTournamentPage._streamUrl(tid, result.display_token)),
      false
    ));

    links.appendChild(AdminTournamentPage._linkRow(
      'Public viewer link',
      'Share this with anyone who just wants to follow the auction on their own ' +
      'phone or laptop. No login, no OBS, updates on its own.',
      String(result.watchUrl || AdminTournamentPage._watchUrl(tid, result.display_token)),
      true
    ));

    shell.body.appendChild(links);

    const ids = document.createElement('dl');
    ids.className = 'kv';
    [
      ['Tournament ID', tid],
      ['Slug', String(result.slug || '')],
      ['Status', AdminTournamentPage._statusText(result.status || 'DRAFT')]
    ].forEach(function (pair) {
      const dt = document.createElement('dt');
      dt.textContent = pair[0];
      const dd = document.createElement('dd');
      dd.textContent = pair[1];
      ids.appendChild(dt);
      ids.appendChild(dd);
    });
    shell.body.appendChild(ids);

    AdminTournamentPage._mount(shell.main);
  },

  /* ================================================================== *
   * View 3 — EDIT
   * ================================================================== */

  /**
   * @param {string} tournamentId from ?id=
   * @return {void}
   */
  _renderEdit: function (tournamentId) {
    const state = AdminTournamentPage._state;

    if (!tournamentId) {
      const bare = AdminTournamentPage._shell('Edit tournament');
      state.errors = bare.errors;
      bare.actions.appendChild(
        AdminTournamentPage._navButton('Back to tournaments', AdminTournamentPage.DASHBOARD_PATH, 'secondary')
      );
      AdminTournamentPage._mount(bare.main);
      AdminTournamentPage._showError(bare.errors,
        'No tournament was named in the address. Go back and choose one from the list.');
      return;
    }

    const shell = AdminTournamentPage._shell('Edit tournament');
    state.errors = shell.errors;
    shell.actions.appendChild(
      AdminTournamentPage._navButton('Back to tournaments', AdminTournamentPage.DASHBOARD_PATH, 'secondary')
    );
    shell.body.appendChild(UI.spinner('Loading tournament…'));
    AdminTournamentPage._mount(shell.main);

    AdminTournamentPage._call('tournament.get', { tournamentId: tournamentId })
      .then(function (row) {
        if (!AdminTournamentPage._current(state)) return;
        AdminTournamentPage._renderEditForm(tournamentId, row || {});
      })
      .catch(function (err) {
        if (AdminTournamentPage._handled(err) || !AdminTournamentPage._current(state)) return;
        shell.body.textContent = '';
        AdminTournamentPage._showError(shell.errors, err);
      });
  },

  /**
   * @param {string} tournamentId
   * @param {!Object} row tournament.get response
   * @return {void}
   */
  _renderEditForm: function (tournamentId, row) {
    const state = AdminTournamentPage._state;

    const shell = AdminTournamentPage._shell(
      String(row.name || 'Edit tournament'),
      'Only the fields you change are sent to the server.'
    );
    state.errors = shell.errors;

    shell.actions.appendChild(
      AdminTournamentPage._navButton('Back to tournaments', AdminTournamentPage.DASHBOARD_PATH, 'secondary')
    );

    const summary = document.createElement('div');
    summary.className = 'admin__summary';
    summary.appendChild(AdminTournamentPage._statusPill(row.status));
    shell.body.appendChild(summary);

    const links = document.createElement('section');
    links.className = 'linkbox';
    links.appendChild(AdminTournamentPage._linkRow(
      'Registration link',
      'Send this to players.',
      AdminTournamentPage._registrationUrl(tournamentId),
      true
    ));
    if (row.display_token) {
      links.appendChild(AdminTournamentPage._linkRow(
        'Projector display link',
        'Read-only. Keep the key in the link private.',
        AdminTournamentPage._displayUrl(tournamentId, row.display_token),
        false
      ));
      links.appendChild(AdminTournamentPage._linkRow(
        'OBS overlay link',
        'Paste into OBS Studio as a Browser Source.',
        AdminTournamentPage._streamUrl(tournamentId, row.display_token),
        false
      ));
      links.appendChild(AdminTournamentPage._linkRow(
        'Public viewer link',
        'Share with anyone following along from their own device.',
        AdminTournamentPage._watchUrl(tournamentId, row.display_token),
        true
      ));
    }
    shell.body.appendChild(links);

    const form = AdminTournamentPage._buildForm('edit', row, function (payload, ui) {
      payload.tournamentId = tournamentId;
      return AdminTournamentPage._call('tournament.update', payload)
        .then(function () {
          if (!AdminTournamentPage._current(state)) return;
          Router.navigate(AdminTournamentPage.DASHBOARD_PATH);
        });
    });

    shell.body.appendChild(form.el);
    AdminTournamentPage._mount(shell.main);
  },

  /* ================================================================== *
   * The shared form
   * ================================================================== */

  /**
   * Build the create or edit form.
   *
   * @param {string} mode 'create' | 'edit'
   * @param {?Object} row  existing tournament row, for 'edit'
   * @param {function(!Object, !Object): !Promise<*>} submit called with the
   *        assembled payload once validation and image encoding are done
   * @return {{el: HTMLElement, firstInput: ?HTMLElement}}
   */
  _buildForm: function (mode, row, submit) {
    const state = AdminTournamentPage._state;
    const isEdit = mode === 'edit';
    const existing = row || {};

    const form = document.createElement('form');
    form.className = 'admin-form';
    form.setAttribute('novalidate', 'novalidate');

    /** @type {!Object<string, !Object>} name -> UI.field handle */
    const fields = {};
    let firstInput = null;

    AdminTournamentPage.FORM_GROUPS.forEach(function (groupName) {
      const group = document.createElement('fieldset');
      group.className = 'admin-form__group';

      const legend = document.createElement('legend');
      legend.className = 'admin-form__legend';
      legend.textContent = groupName;
      group.appendChild(legend);

      AdminTournamentPage.FORM_FIELDS.forEach(function (spec) {
        if (spec.group !== groupName) return;

        const cfg = {
          label: spec.label,
          name: spec.name,
          type: spec.type,
          required: !!spec.required,
          hint: spec.hint
        };
        if (spec.placeholder) cfg.placeholder = spec.placeholder;

        if (spec.type === 'number') {
          // Whole rupees and whole players. step=1 keeps the spinner on
          // integers and inputmode brings up the number pad on a phone.
          cfg.step = 1;
          cfg.min = spec.min;
          cfg.inputmode = 'numeric';
        }
        if (spec.type === 'tel') {
          cfg.inputmode = 'numeric';
          cfg.maxLength = 10;
        }
        if (isEdit) cfg.value = AdminTournamentPage._prefill(spec, existing);

        const handle = UI.field(cfg);
        const input = handle.input;

        if (spec.type === 'email') input.autocapitalize = 'none';

        fields[spec.name] = { spec: spec, handle: handle };
        if (!firstInput) firstInput = input;
        group.appendChild(handle.wrap);
      });

      form.appendChild(group);
    });

    /* --- Images ---------------------------------------------------- */

    const imageGroup = document.createElement('fieldset');
    imageGroup.className = 'admin-form__group';
    const imageLegend = document.createElement('legend');
    imageLegend.className = 'admin-form__legend';
    imageLegend.textContent = 'Images';
    imageGroup.appendChild(imageLegend);

    const imageNote = document.createElement('p');
    imageNote.className = 'field__hint';
    imageNote.textContent = isEdit
      ? 'Leave an image blank to keep the one already uploaded. Pictures are ' +
        'shrunk in your browser before they are sent, so a large photo is fine.'
      : 'Pictures are shrunk in your browser before they are sent, so a large ' +
        'photo from a phone is fine.';
    imageGroup.appendChild(imageNote);

    const pickers = [];

    pickers.push(AdminTournamentPage._imagePicker(imageGroup, {
      key: 'logo',
      label: 'Tournament logo',
      hint: 'Shown at the top of the registration page. JPEG or PNG.',
      accept: 'image/png,image/jpeg',
      multiple: false,
      opts: AdminTournamentPage.IMAGE_OPTS,
      removable: isEdit,
      removeKey: 'removeLogo',
      removeLabel: 'Remove the current logo'
    }));

    pickers.push(AdminTournamentPage._imagePicker(imageGroup, {
      key: 'qr',
      label: 'UPI payment QR code',
      // Say it in the interface too, not only in the code: whoever exports the
      // QR from their bank app is the person who can get this wrong.
      hint: 'Upload the QR exactly as your bank app saved it, ideally a PNG. ' +
        'A PNG stays a PNG — it is never converted to JPEG, because that can ' +
        'make a QR code unscannable.',
      accept: 'image/png,image/jpeg',
      multiple: false,
      opts: AdminTournamentPage.QR_IMAGE_OPTS,
      removable: isEdit,
      removeKey: 'removeQr',
      removeLabel: 'Remove the current QR code'
    }));

    pickers.push(AdminTournamentPage._imagePicker(imageGroup, {
      key: 'gallery',
      label: 'Gallery images',
      hint: isEdit
        ? 'Optional. Choosing files here replaces the whole gallery.'
        : 'Optional. You can choose more than one.',
      accept: 'image/png,image/jpeg',
      multiple: true,
      opts: AdminTournamentPage.IMAGE_OPTS,
      removable: false
    }));

    form.appendChild(imageGroup);

    /* --- Progress and submit --------------------------------------- */

    const progressBox = document.createElement('div');
    progressBox.className = 'admin-form__progress';
    form.appendChild(progressBox);

    const submitLabel = isEdit ? 'Save changes' : 'Create tournament';
    const busyLabel = isEdit ? 'Saving…' : 'Creating…';

    /* No busyLabel, for the same reason as the sign-in button: UI.button
       restores itself as soon as the promise its handler RETURNS settles, and
       run() returns nothing, so it would re-enable mid-request. It also never
       sees the Enter key. setBusy() below owns both paths. */
    const submitBtn = UI.button(submitLabel, function () {
      run();
    }, { variant: 'primary', type: 'submit' });

    const bar = document.createElement('div');
    bar.className = 'admin-form__submit';
    bar.appendChild(submitBtn);
    form.appendChild(bar);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      run();
    });

    /**
     * Validate, encode the images, hand the payload to the caller.
     * Re-entrant calls while a submit is in flight do nothing — the guard is
     * set synchronously, so a click that also fires the form's submit event
     * still results in exactly one request.
     * @return {void}
     */
    function run() {
      if (state.busy) return;

      const values = AdminTournamentPage._readValues(fields);
      const problems = AdminTournamentPage._validate(values, fields, isEdit);

      Object.keys(fields).forEach(function (k) { fields[k].handle.clearError(); });
      AdminTournamentPage._clearError(state.errors);

      if (problems.length) {
        problems.forEach(function (p) {
          if (fields[p.field]) fields[p.field].handle.setError(p.message);
        });
        AdminTournamentPage._showError(state.errors,
          problems.length === 1
            ? problems[0].message
            : 'Please fix the ' + problems.length + ' highlighted fields and try again.');
        if (fields[problems[0].field]) fields[problems[0].field].handle.input.focus();
        return;
      }

      setBusy(true);

      // Progress matters here: encoding ten gallery photos plus a logo takes
      // real seconds, and silence makes people press the button again.
      const progress = UI.progress();
      progressBox.textContent = '';
      progressBox.appendChild(progress.el);

      AdminTournamentPage._collectImages(pickers, progress)
        .then(function (images) {
          if (!AdminTournamentPage._current(state)) return null;

          const payload = isEdit
            ? AdminTournamentPage._changedFields(values, existing)
            : AdminTournamentPage._fullPayload(values);

          Object.keys(images).forEach(function (k) { payload[k] = images[k]; });

          // In edit mode the remove flags are the only way to clear an image;
          // sending null leaves the existing one alone (CONTRACTS-PHASE1 §2).
          pickers.forEach(function (p) {
            if (p.removeKey && p.isRemoveChecked()) payload[p.removeKey] = true;
          });

          if (isEdit && Object.keys(payload).length === 0) {
            throw { code: 'NO_CHANGES', message: 'Nothing has changed, so there is nothing to save.' };
          }

          progress.done();
          return submit(payload, { progress: progress });
        })
        .catch(function (err) {
          if (AdminTournamentPage._handled(err) || !AdminTournamentPage._current(state)) return;
          progress.done();
          progressBox.textContent = '';
          setBusy(false);
          AdminTournamentPage._showError(state.errors, err);
        });
    }

    /**
     * @param {boolean} busy
     * @return {void}
     */
    function setBusy(busy) {
      state.busy = !!busy;
      submitBtn.disabled = !!busy;
      submitBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
      submitBtn.textContent = busy ? busyLabel : submitLabel;
    }

    return { el: form, firstInput: firstInput, fields: fields, pickers: pickers, run: run };
  },

  /**
   * One file input plus its "chosen" summary, preview and optional
   * "remove the existing one" checkbox.
   *
   * @param {HTMLElement} parent
   * @param {!Object} cfg {key, label, hint, accept, multiple, opts, removable, removeKey, removeLabel}
   * @return {!Object} picker handle used by _collectImages
   */
  _imagePicker: function (parent, cfg) {
    const state = AdminTournamentPage._state;

    const handle = UI.field({
      label: cfg.label,
      name: cfg.key,
      type: 'file',
      required: false,
      hint: cfg.hint,
      accept: cfg.accept,
      multiple: !!cfg.multiple
    });

    const input = handle.input;
    parent.appendChild(handle.wrap);

    const chosen = document.createElement('div');
    chosen.className = 'imagepick__chosen';
    parent.appendChild(chosen);

    let removeBox = null;
    if (cfg.removable) {
      const row = document.createElement('label');
      row.className = 'choice';
      removeBox = document.createElement('input');
      removeBox.type = 'checkbox';
      removeBox.name = cfg.removeKey;
      const text = document.createElement('span');
      text.textContent = cfg.removeLabel;
      row.appendChild(removeBox);
      row.appendChild(text);
      parent.appendChild(row);

      // Picking a replacement and asking to remove at the same time is a
      // contradiction; the replacement wins and the box unticks itself.
      input.addEventListener('change', function () {
        if (input.files && input.files.length) removeBox.checked = false;
      });
    }

    let mine = [];

    input.addEventListener('change', function () {
      // Free the previews from the previous choice before making new ones.
      mine.forEach(function (url) {
        try { window.URL.revokeObjectURL(url); } catch (e) { /* already gone */ }
      });
      mine = [];

      chosen.textContent = '';
      const files = input.files ? Array.prototype.slice.call(input.files) : [];
      if (!files.length) return;

      files.forEach(function (file) {
        const item = document.createElement('div');
        item.className = 'imagepick__item';

        const img = document.createElement('img');
        img.className = 'imagepick__thumb';
        img.alt = '';
        const url = ImageTool.previewUrl(file);
        img.src = url;
        // ImageTool.previewUrl says the caller revokes. Track it twice: once
        // here so re-picking frees the old blob, once on the page state so
        // leaving the page frees whatever is still held.
        mine.push(url);
        state.objectUrls.push(url);
        item.appendChild(img);

        const caption = document.createElement('span');
        caption.className = 'imagepick__name';
        caption.textContent = file.name;
        item.appendChild(caption);

        chosen.appendChild(item);
      });
    });

    return {
      key: cfg.key,
      multiple: !!cfg.multiple,
      opts: cfg.opts,
      input: input,
      removeKey: cfg.removable ? cfg.removeKey : null,
      isRemoveChecked: function () { return !!(removeBox && removeBox.checked); }
    };
  },

  /**
   * Encode every chosen file through ImageTool and report progress.
   *
   * Sequential on purpose: decoding several 4 MB photos at once on a modest
   * laptop spikes memory and stalls the tab. One at a time also makes the
   * progress bar honest.
   *
   * @param {!Array<!Object>} pickers
   * @param {{set: function(number), done: function()}} progress
   * @return {!Promise<!Object>} {logo?, qr?, gallery?} in payload shape
   */
  _collectImages: function (pickers, progress) {
    const jobs = [];

    pickers.forEach(function (picker) {
      const files = picker.input && picker.input.files
        ? Array.prototype.slice.call(picker.input.files)
        : [];
      files.forEach(function (file) {
        jobs.push({ picker: picker, file: file });
      });
    });

    if (!jobs.length) {
      progress.set(100);
      return Promise.resolve({});
    }

    const out = {};
    let done = 0;
    progress.set(0);

    return jobs.reduce(function (chain, job) {
      return chain.then(function () {
        return ImageTool.fromFile(job.file, job.picker.opts).then(function (img) {
          // Send only the three keys the contract defines. ImageTool also
          // returns width/height/bytes, which the server has no use for.
          const image = { data: img.data, mime: img.mime, filename: img.filename };

          if (job.picker.multiple) {
            if (!out[job.picker.key]) out[job.picker.key] = [];
            out[job.picker.key].push(image);
          } else {
            out[job.picker.key] = image;
          }

          done += 1;
          progress.set(Math.round((done / jobs.length) * 100));
        });
      });
    }, Promise.resolve()).then(function () {
      return out;
    });
  },

  /* ------------------------------------------------------------------ *
   * Values, validation, diffing
   * ------------------------------------------------------------------ */

  /**
   * @param {!Object} fields
   * @return {!Object<string,string>} raw trimmed strings, keyed by payload name
   */
  _readValues: function (fields) {
    const values = {};
    Object.keys(fields).forEach(function (name) {
      values[name] = String(fields[name].handle.input.value || '').trim();
    });
    return values;
  },

  /**
   * Mirror of the server-side rules in CONTRACTS-PHASE1.md §2. The server
   * checks all of this again — this pass exists to save a round trip, not to
   * be the authority.
   *
   * @param {!Object<string,string>} values
   * @param {!Object} fields
   * @param {boolean} isEdit
   * @return {!Array<{field:string, message:string}>}
   */
  _validate: function (values, fields, isEdit) {
    const problems = [];
    const add = function (field, message) { problems.push({ field: field, message: message }); };

    AdminTournamentPage.FORM_FIELDS.forEach(function (spec) {
      if (spec.required && !values[spec.name]) {
        add(spec.name, spec.label + ' is required.');
      }
    });

    if (values.name && (values.name.length < 3 || values.name.length > 80)) {
      add('name', 'The tournament name must be 3 to 80 characters.');
    }

    // Bare YYYY-MM-DD strings are IST calendar days (CONTRACTS.md §6a). They
    // compare correctly as strings because the format is fixed-width and
    // big-endian — which is also why we must never hand one to Date.parse.
    if (values.startDate && values.endDate && values.startDate > values.endDate) {
      add('endDate', 'The last day of play cannot be before the first day.');
    }
    if (values.regStart && values.regEnd && values.regStart > values.regEnd) {
      add('regEnd', 'Registration cannot close before it opens.');
    }

    AdminTournamentPage._checkInteger(values, 'regFee', 0, 'The registration fee', add);
    AdminTournamentPage._checkInteger(values, 'defaultPurse', 1, 'The default team purse', add);
    AdminTournamentPage._checkInteger(values, 'defaultMaxPlayers', 1, 'The default squad size', add);

    // something@something, matching the server's rule.
    if (values.upiId && !/^[^@\s]+@[^@\s]+$/.test(values.upiId)) {
      add('upiId', 'A UPI ID looks like name@bank.');
    }

    // Util.isValidMobileIN: 10 digits, first digit 6-9.
    if (values.contactMobile && !/^[6-9][0-9]{9}$/.test(values.contactMobile)) {
      add('contactMobile', 'Enter a 10-digit Indian mobile number starting 6 to 9.');
    }

    if (values.contactEmail && values.contactEmail.indexOf('@') === -1) {
      add('contactEmail', 'Enter a valid email address, or leave it blank.');
    }

    return problems;
  },

  /**
   * Money and counts are integers. No decimals anywhere — the server stores
   * whole rupees, so "500.50" would be silently truncated or rejected.
   *
   * @param {!Object} values
   * @param {string} key
   * @param {number} min
   * @param {string} label
   * @param {function(string,string)} add
   * @return {void}
   */
  _checkInteger: function (values, key, min, label, add) {
    const raw = values[key];
    if (!raw) return;   // required-ness is checked separately

    if (!/^[0-9]+$/.test(raw)) {
      add(key, label + ' must be a whole number of ' +
        (key === 'defaultMaxPlayers' ? 'players' : 'rupees') + ', digits only.');
      return;
    }
    const n = Number(raw);
    if (!isFinite(n) || n < min) {
      add(key, label + ' must be ' + min + ' or more.');
    }
  },

  /**
   * Full create payload. Every key is present, exactly as
   * CONTRACTS-PHASE1.md §2 lists them; the images are added by the caller.
   *
   * @param {!Object<string,string>} values
   * @return {!Object}
   */
  _fullPayload: function (values) {
    const payload = {};
    AdminTournamentPage.FORM_FIELDS.forEach(function (spec) {
      payload[spec.name] = spec.integer ? Number(values[spec.name]) : values[spec.name];
    });
    // Explicit nulls so the shape matches the contract even when nothing was
    // chosen. The server treats null as "no image".
    payload.logo = null;
    payload.qr = null;
    payload.gallery = [];
    return payload;
  },

  /**
   * Only the fields whose value actually differs from the stored row.
   * tournament.update treats every key as "change this", so sending an
   * unchanged field writes a pointless prev/next pair into the audit log.
   *
   * @param {!Object<string,string>} values
   * @param {!Object} existing tournament.get row
   * @return {!Object}
   */
  _changedFields: function (values, existing) {
    const payload = {};

    AdminTournamentPage.FORM_FIELDS.forEach(function (spec) {
      const now = values[spec.name];
      const before = AdminTournamentPage._prefill(spec, existing);
      if (now === before) return;
      payload[spec.name] = spec.integer ? Number(now) : now;
    });

    return payload;
  },

  /**
   * The stored value of one field, as the form input would hold it. Used both
   * to pre-fill and to diff, so the two can never disagree about what
   * "unchanged" means.
   *
   * @param {!Object} spec
   * @param {!Object} row
   * @return {string}
   */
  _prefill: function (spec, row) {
    const raw = row[spec.column];
    if (raw === null || raw === undefined) return '';

    const text = String(raw);

    if (spec.type === 'date') {
      /* <input type="date"> only accepts YYYY-MM-DD. If the sheet handed back
         a full instant, take the first ten characters as-is. We do NOT parse
         and re-format: `new Date('2026-08-31')` is UTC midnight, which in IST
         is already the 31st at 05:30, and any local re-format of it can slide
         the day. Slicing the string cannot. Everything the admin *reads* uses
         the server's *_display fields instead (CONTRACTS.md §6a rule 4). */
      return text.slice(0, 10);
    }

    return text;
  },

  /* ------------------------------------------------------------------ *
   * Links and copying
   * ------------------------------------------------------------------ */

  /**
   * @param {string} tournamentId
   * @return {string} absolute registration URL
   */
  _registrationUrl: function (tournamentId) {
    return AdminTournamentPage._absolute(
      Router.href('/register/' + encodeURIComponent(tournamentId))
    );
  },

  /**
   * @param {string} tournamentId
   * @param {string} displayToken
   * @return {string} absolute projector URL, or '' without a token
   */
  _displayUrl: function (tournamentId, displayToken) {
    if (!displayToken) return '';
    // /projector/:id, not /auction/:id/display — matches the flat shape
    // /stream/:id and /watch/:id already use (see _streamUrl/_watchUrl below).
    // Both spellings serve the identical page; the old one is untouched and
    // keeps working for any link already shared before this changed.
    return AdminTournamentPage._absolute(
      Router.href('/projector/' + encodeURIComponent(tournamentId)) +
      '?k=' + encodeURIComponent(String(displayToken))
    );
  },

  /**
   * @param {string} tournamentId
   * @param {string} displayToken
   * @return {string} absolute OBS Browser Source URL, or '' without a token
   */
  _streamUrl: function (tournamentId, displayToken) {
    if (!displayToken) return '';
    return AdminTournamentPage._absolute(
      Router.href('/stream/' + encodeURIComponent(tournamentId)) +
      '?k=' + encodeURIComponent(String(displayToken))
    );
  },

  /**
   * @param {string} tournamentId
   * @param {string} displayToken
   * @return {string} absolute public viewer URL, or '' without a token
   */
  _watchUrl: function (tournamentId, displayToken) {
    if (!displayToken) return '';
    return AdminTournamentPage._absolute(
      Router.href('/watch/' + encodeURIComponent(tournamentId)) +
      '?k=' + encodeURIComponent(String(displayToken))
    );
  },

  /**
   * @param {string} path already carries BASE_PATH
   * @return {string}
   */
  _absolute: function (path) {
    return window.location.origin + path;
  },

  /**
   * A labelled link with a read-only box holding the URL and a Copy button.
   * @param {string} label
   * @param {string} note
   * @param {string} url
   * @param {boolean} openable show an "Open" link too
   * @return {HTMLElement}
   */
  _linkRow: function (label, note, url, openable) {
    const row = document.createElement('div');
    row.className = 'linkbox__row';

    const heading = document.createElement('h3');
    heading.className = 'linkbox__label';
    heading.textContent = label;
    row.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'linkbox__note';
    hint.textContent = note;
    row.appendChild(hint);

    if (!url) {
      const missing = document.createElement('p');
      missing.className = 'linkbox__note';
      missing.textContent = 'Not available.';
      row.appendChild(missing);
      return row;
    }

    const controls = document.createElement('div');
    controls.className = 'linkbox__controls';

    // A read-only input rather than a <p>: it is selectable, scrolls a long
    // URL instead of wrapping it into soup, and gives the copy fallback
    // something real to select.
    const box = document.createElement('input');
    box.type = 'text';
    box.className = 'input linkbox__url';
    box.readOnly = true;
    box.value = url;
    box.setAttribute('aria-label', label);
    box.addEventListener('focus', function () { box.select(); });
    controls.appendChild(box);

    controls.appendChild(AdminTournamentPage._copyButton('Copy link', url, box));

    if (openable) {
      const open = document.createElement('a');
      open.className = 'btn btn--secondary';
      open.href = url;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Open';
      controls.appendChild(open);
    }

    row.appendChild(controls);
    return row;
  },

  /**
   * @param {string} label
   * @param {string} text what lands on the clipboard
   * @param {HTMLElement} [fallbackInput] an input holding the same text
   * @return {HTMLElement}
   */
  _copyButton: function (label, text, fallbackInput) {
    const btn = UI.button(label, function () {
      AdminTournamentPage._copy(text, fallbackInput).then(function (ok) {
        btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        // Live region so the confirmation is announced, not only seen.
        btn.setAttribute('aria-live', 'polite');
        window.setTimeout(function () { btn.textContent = label; }, 2000);
      });
    }, { variant: 'secondary', type: 'button' });
    return btn;
  },

  /**
   * Copy to the clipboard.
   *
   * navigator.clipboard needs a secure context. GitHub Pages is HTTPS so it
   * normally works, but an admin testing from a plain-http LAN address has no
   * clipboard API at all — hence the select-and-execCommand fallback, which
   * is deprecated but still the only thing that works there.
   *
   * @param {string} text
   * @param {HTMLElement} [fallbackInput]
   * @return {!Promise<boolean>}
   */
  _copy: function (text, fallbackInput) {
    if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
      return window.navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return AdminTournamentPage._copyFallback(fallbackInput); });
    }
    return Promise.resolve(AdminTournamentPage._copyFallback(fallbackInput));
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

  /** Revoke every object URL this page handed to an <img>. @return {void} */
  _releaseObjectUrls: function () {
    const state = AdminTournamentPage._state;
    if (!state || !state.objectUrls) return;
    state.objectUrls.forEach(function (url) {
      try { window.URL.revokeObjectURL(url); } catch (e) { /* already gone */ }
    });
    state.objectUrls = [];
  },

  /* ------------------------------------------------------------------ *
   * Small display helpers
   * ------------------------------------------------------------------ */

  /**
   * @param {?string} text
   * @param {HTMLElement} [child]
   * @param {string} [modifier]
   * @return {HTMLElement}
   */
  _cell: function (text, child, modifier) {
    const td = document.createElement('td');
    if (modifier) td.className = 'admin-table__' + modifier;
    if (child) {
      td.appendChild(child);
    } else {
      td.textContent = text === null || text === undefined ? '—' : String(text);
    }
    return td;
  },

  /**
   * @param {string} status
   * @return {HTMLElement}
   */
  _statusPill: function (status) {
    const key = String(status || '').toUpperCase();
    const span = document.createElement('span');
    span.className = 't-status t-status--' + (AdminTournamentPage.STATUS_LABEL[key]
      ? key.toLowerCase().replace(/_/g, '-')
      : 'unknown');
    // The word is the signal; the colour is only a reinforcement (DESIGN §8).
    span.textContent = AdminTournamentPage._statusText(key);
    return span;
  },

  /**
   * @param {string} status
   * @return {string}
   */
  _statusText: function (status) {
    const key = String(status || '').toUpperCase();
    return AdminTournamentPage.STATUS_LABEL[key] || (key || 'Unknown');
  },

  /**
   * Prefer the server's pre-formatted date. Never reformat a date in the
   * browser: these are IST calendar days and the browser's timezone is not
   * guaranteed to be IST (CONTRACTS.md §6a).
   *
   * @param {!Object} row
   * @param {string} key e.g. 'reg_start'
   * @return {string}
   */
  _dateText: function (row, key) {
    const display = row[key + '_display'];
    if (display) return String(display);
    const raw = row[key];
    return raw ? String(raw) : '—';
  },

  /**
   * @param {*} rupees whole rupees
   * @return {string} e.g. "₹500"
   */
  _money: function (rupees) {
    if (rupees === null || rupees === undefined || rupees === '') return '—';
    return UI.money(Number(rupees));
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
   * What to do next, with links to the screens that do it.
   *
   * This replaced a "Not built yet" panel that listed payment verification, the
   * player list, teams and the auction as arriving in later phases. All four now
   * exist and are in the nav, so the panel was telling an admin that working
   * features were missing — and sending them looking for nothing.
   *
   * Kept as a panel rather than deleted: the dashboard is where an admin lands,
   * and the order of these steps is not obvious from a row of nav tabs.
   *
   * @param {string} tournamentId the selected tournament, may be ''
   * @return {HTMLElement}
   */
  _nextStepsPanel: function (tournamentId) {
    const section = document.createElement('section');
    section.className = 'later';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Running a tournament, in order';
    section.appendChild(h2);

    const intro = document.createElement('p');
    intro.className = 'panel__note';
    intro.textContent = tournamentId
      ? 'Each step has its own screen. Work down the list.'
      : 'Create a tournament above, or select one, and these become available.';
    section.appendChild(intro);

    const ul = document.createElement('ul');
    ul.className = 'later__list';

    [
      ['Share the registration link', null,
        'Copy it from the tournament above and post it. Players need no account.'],
      ['Verify payments', '/admin/payments',
        'Check each UPI reference against your bank statement, then verify or reject. ' +
        'Only verified players can be sold.'],
      ['Check the player list', '/admin/players',
        'Search, filter and see who is eligible for the auction.'],
      ['Create the organiser', '/admin/organisers',
        'Sends a one-time link so they can set a password. Shown once.'],
      ['Teams and purses', '/organiser/dashboard',
        'The organiser creates the squads, pre-filled from this tournament\u2019s defaults.'],
      ['Run the auction', '/organiser/auction',
        'Call players by serial number, record sales. The projector link is on the ' +
        'tournament above.'],
      ['Reports and audit', '/admin/reports',
        'Export the player list, team report and auction report. The audit log ' +
        'settles any dispute afterwards.']
    ].forEach(function (row) {
      const li = document.createElement('li');

      // Linked whether or not a tournament is selected. app.js already shows a
      // picker on a tournament-scoped route with no selection, so the link is
      // never a dead end — and the list view, where nothing is selected yet, is
      // exactly where someone wants to click through.
      if (row[1]) {
        const a = document.createElement('a');
        a.className = 'later__link';
        a.textContent = row[0];
        // adminPath carries ?t= so the selection is not lost on the way there;
        // an admin verifying payments against the wrong tournament is silent
        // and unrecoverable (CONTRACTS-PHASE2 §6.3).
        a.href = (typeof App !== 'undefined' && App.adminPath)
          ? App.adminPath(row[1], tournamentId)
          : Router.href(row[1]);
        li.appendChild(a);
      } else {
        const strong = document.createElement('strong');
        strong.textContent = row[0];
        li.appendChild(strong);
      }

      li.appendChild(document.createTextNode(' \u2014 ' + row[2]));
      ul.appendChild(li);
    });

    section.appendChild(ul);
    return section;
  }
};
