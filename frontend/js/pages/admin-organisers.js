/**
 * admin-organisers.js — the /admin/organisers screen. `AdminOrganisersPage`.
 *
 * An organiser never signs up. An admin creates them here, locked to one
 * tournament, and sends them a one-time join link (CONTRACTS-PHASE3.md §1,
 * DESIGN.md §5.4 / §15).
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE3 §1  organiser.create / organiser.list /
 *                        organiser.resendLink / organiser.disable
 *   CONTRACTS-PHASE3 §5.4 the join link is shown ONCE, with a Copy button and
 *                        a plain warning that it will not be shown again
 *   CONTRACTS-PHASE1 §4  textContent only, vanilla JS, all traffic through
 *                        API, document.body.dataset.route
 *
 * THREE RULES THIS FILE EXISTS TO KEEP
 *
 *   1. THE LINK EXISTS IN EXACTLY ONE RESPONSE, AND THEN IT IS GONE.
 *      The token is stored hashed and the plain text is never returned again
 *      (CONTRACTS-PHASE3 §1 rule 2). So the moment it arrives it is put in a
 *      box the admin cannot miss, with a Copy button and a sentence saying it
 *      will not be shown again. If they lose it, Resend is the answer — and
 *      resending invalidates the old link, which is also said on screen,
 *      because an admin who sends both links has just confused their organiser.
 *
 *   2. THE LINK IS NEVER A CLICKABLE <a>.
 *      Opening it consumes the one-time token. An admin who clicks their own
 *      organiser's link to "check it works" has just burned it. Copy only.
 *
 *   3. THE LIST NEVER CONTAINS A TOKEN, SO THIS PAGE NEVER LOOKS FOR ONE.
 *      organiser.list returns no token and no hash by design. Every cell below
 *      is read from a named field; nothing iterates the row, so a field added
 *      to the API later cannot leak onto the screen by accident.
 */

/* eslint-disable no-unused-vars */
const AdminOrganisersPage = {

  /** @const {string} */
  LOGIN_PATH: '/admin/login',

  /** @const {string} */
  DASHBOARD_PATH: '/admin/dashboard',

  /** @const {string} */
  ORGANISERS_PATH: '/admin/organisers',

  /**
   * Thrown by _call() after it has already handled an expired session. A
   * caller that sees this must render nothing — the page is being replaced.
   * @const
   */
  REDIRECTED: Object.freeze({ code: 'REDIRECTED', message: '' }),

  /** How long a join link lives (CONTRACTS-PHASE3 §1 rule 4). @const {number} */
  EXPIRY_HOURS: 72,

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
    document.body.dataset.route = 'admin-organisers';

    const gen = ++AdminOrganisersPage._gen;
    const state = {
      gen: gen, errors: null, notices: null, links: null, listBox: null,
      tournamentId: ''
    };
    AdminOrganisersPage._state = state;

    // No token at all: do not flash an empty screen, just go and sign in.
    if (!API.getToken()) {
      Router.navigate(AdminOrganisersPage.LOGIN_PATH, { replace: true });
      return;
    }

    const tid = AdminOrganisersPage._resolveTournamentId(ctx);
    if (!tid) {
      AdminOrganisersPage._renderNoTournament();
      return;
    }
    state.tournamentId = tid;

    AdminOrganisersPage._renderList();
  },

  /* ================================================================== *
   * Shared plumbing
   * ================================================================== */

  /**
   * Every backend call on this page goes through here.
   *
   * ONE place handles an expired session. A 12-hour session (CONTRACTS.md §7)
   * will expire under an admin who left the tab open overnight, and that can
   * happen on any of the four actions this page calls. Handling it per call
   * means four chances to forget one, and the one that is forgotten shows
   * "Not signed in" forever with no way out.
   *
   * @param {string} action
   * @param {Object} [payload]
   * @return {!Promise<*>} rejects with AdminOrganisersPage.REDIRECTED once the
   *         session is gone and navigation has already been started.
   */
  _call: function (action, payload) {
    return API.call(action, payload || {}).catch(function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        API.clearToken();
        Router.navigate(AdminOrganisersPage.LOGIN_PATH, { replace: true });
        throw AdminOrganisersPage.REDIRECTED;
      }
      throw err;
    });
  },

  /**
   * @param {*} err
   * @return {boolean} true when _call has already navigated away
   */
  _handled: function (err) {
    return err === AdminOrganisersPage.REDIRECTED;
  },

  /**
   * @param {Object} state
   * @return {boolean} true when this view is still the one on screen
   */
  _current: function (state) {
    return !!state && state.gen === AdminOrganisersPage._gen;
  },

  /**
   * The tournament this screen is scoped to. app.js keeps the selection in
   * ?t= (CONTRACTS-PHASE2 §6.3); this reads the same key so a link from any
   * other admin screen arrives already scoped.
   *
   * @param {Object} ctx
   * @return {string}
   */
  _resolveTournamentId: function (ctx) {
    if (typeof App !== 'undefined' && App &&
        typeof App.currentTournamentId === 'function') {
      const fromApp = String(App.currentTournamentId(ctx) || '');
      if (fromApp) return fromApp;
    }

    const query = (ctx && ctx.query) || {};
    const param = (typeof App !== 'undefined' && App && App.TOURNAMENT_PARAM)
      ? App.TOURNAMENT_PARAM : 't';
    const raw = String(query[param] === undefined ? '' : query[param]).trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : '';
  },

  /**
   * An app path carrying the tournament, so the selection survives a click.
   * @param {string} path
   * @return {string}
   */
  _path: function (path) {
    const state = AdminOrganisersPage._state;
    const id = state ? state.tournamentId : '';
    if (typeof App !== 'undefined' && App && typeof App.adminPath === 'function') {
      return App.adminPath(path, id);
    }
    return id ? path + '?t=' + encodeURIComponent(id) : path;
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
    main.className = 'panel org-admin';

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
    a.href = Router.href(path);
    a.textContent = label;
    return a;
  },

  /* ================================================================== *
   * View 0 — no tournament chosen
   * ================================================================== */

  /** @return {void} */
  _renderNoTournament: function () {
    const shell = AdminOrganisersPage._shell(
      'Organisers',
      'An organiser is created for one tournament, so a tournament has to be ' +
      'chosen first.'
    );
    shell.actions.appendChild(AdminOrganisersPage._navButton(
      'Choose a tournament', AdminOrganisersPage.DASHBOARD_PATH, 'secondary'));

    AdminOrganisersPage._mount(shell.main);
    AdminOrganisersPage._showError(shell.errors,
      'No tournament is selected. Open the tournament list and pick one, then ' +
      'come back to this screen.');
  },

  /* ================================================================== *
   * View 1 — create, list, resend, disable
   * ================================================================== */

  /** @return {void} */
  _renderList: function () {
    const state = AdminOrganisersPage._state;

    const shell = AdminOrganisersPage._shell(
      'Organisers',
      'Create an organiser, send them their one-time join link, and switch them ' +
      'off when the tournament is over.'
    );
    state.errors = shell.errors;
    state.notices = shell.notices;

    shell.actions.appendChild(AdminOrganisersPage._navButton(
      'Back to tournaments', AdminOrganisersPage.DASHBOARD_PATH, 'secondary'));

    // The one-time link lives at the very top, above everything, because it is
    // the only thing on this page that cannot be recovered by reloading.
    const links = document.createElement('div');
    links.className = 'org-links';
    state.links = links;
    shell.body.appendChild(links);

    shell.body.appendChild(AdminOrganisersPage._createForm());

    const listBox = document.createElement('div');
    listBox.className = 'org-list';
    state.listBox = listBox;
    shell.body.appendChild(listBox);

    AdminOrganisersPage._mount(shell.main);
    AdminOrganisersPage._loadList();
  },

  /** @return {void} */
  _loadList: function () {
    const state = AdminOrganisersPage._state;
    const box = state.listBox;
    if (!box) return;

    box.textContent = '';
    box.appendChild(UI.spinner('Loading organisers…'));

    AdminOrganisersPage._call('organiser.list', { tournamentId: state.tournamentId })
      .then(function (rows) {
        if (!AdminOrganisersPage._current(state)) return;
        box.textContent = '';
        box.appendChild(AdminOrganisersPage._listContent(rows || []));
      })
      .catch(function (err) {
        if (AdminOrganisersPage._handled(err) ||
            !AdminOrganisersPage._current(state)) return;
        box.textContent = '';
        AdminOrganisersPage._showError(state.errors, err);
      });
  },

  /* ------------------------------------------------------------------ *
   * Create
   * ------------------------------------------------------------------ */

  /** @return {HTMLElement} */
  _createForm: function () {
    const state = AdminOrganisersPage._state;

    const box = document.createElement('section');
    box.className = 'org-new';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'Add an organiser';
    box.appendChild(h2);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent =
      'They do not choose a password here — you get a one-time link to send them, ' +
      'and they set their own password when they open it. The link is shown once, ' +
      'so have somewhere ready to paste it.';
    box.appendChild(note);

    const form = document.createElement('form');
    form.className = 'form org-new__form';
    form.setAttribute('novalidate', 'novalidate');

    const name = UI.field({
      label: 'Name', name: 'displayName', type: 'text', required: true,
      hint: 'How they will be named in the audit log, e.g. "Ravi Kumar".'
    });
    const email = UI.field({
      label: 'Email address', name: 'email', type: 'email', required: true,
      autocomplete: 'off',
      hint: 'They sign in with this. It must not already be in use.'
    });
    email.input.autocapitalize = 'none';

    const grid = document.createElement('div');
    grid.className = 'org-new__grid';
    grid.appendChild(name.wrap);
    grid.appendChild(email.wrap);
    form.appendChild(grid);

    const errors = document.createElement('div');
    errors.className = 'org-new__errors';
    errors.setAttribute('aria-live', 'assertive');
    errors.setAttribute('aria-atomic', 'true');
    form.appendChild(errors);

    const createLabel = 'Create organiser and get the link';
    const create = UI.button(createLabel, function () { run(); },
      { variant: 'primary', type: 'submit' });

    const bar = document.createElement('div');
    bar.className = 'org-new__submit';
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
      create.textContent = busy ? 'Creating…' : createLabel;
    }

    /** @return {void} */
    function run() {
      if (create.disabled) return;

      name.clearError();
      email.clearError();
      errors.textContent = '';
      AdminOrganisersPage._clearError(state.errors);

      const displayName = String(name.input.value || '').trim();
      const address = String(email.input.value || '').trim();

      let bad = null;
      if (!displayName) {
        bad = { handle: name, message: 'Give the organiser a name.' };
      } else if (!address) {
        bad = { handle: email, message: 'An email address is required.' };
      } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
        bad = { handle: email, message: 'That does not look like an email address.' };
      }

      if (bad) {
        bad.handle.setError(bad.message);
        AdminOrganisersPage._showError(errors, bad.message);
        if (bad.handle.input.focus) bad.handle.input.focus();
        return;
      }

      setBusy(true);

      AdminOrganisersPage._call('organiser.create', {
        tournamentId: state.tournamentId,
        email: address,
        displayName: displayName
      })
        .then(function (result) {
          if (!AdminOrganisersPage._current(state)) return;
          setBusy(false);
          name.input.value = '';
          email.input.value = '';
          AdminOrganisersPage._showLink(result || {}, 'created');
          AdminOrganisersPage._loadList();
        })
        .catch(function (err) {
          if (AdminOrganisersPage._handled(err) ||
              !AdminOrganisersPage._current(state)) return;
          setBusy(false);
          // A duplicate email comes back as VALIDATION_FAILED with the server's
          // own wording; show it against the field that caused it.
          const message = (err && err.message) ? String(err.message)
            : 'The organiser could not be created.';
          email.setError(message);
          AdminOrganisersPage._showError(errors, message);
        });
    }

    box.appendChild(form);
    return box;
  },

  /* ------------------------------------------------------------------ *
   * The one-time link
   * ------------------------------------------------------------------ */

  /**
   * Show the join link. This is the only moment it exists in readable form.
   *
   * @param {!Object} result organiser.create / organiser.resendLink response
   * @param {string} kind 'created' | 'resent'
   * @return {void}
   */
  _showLink: function (result, kind) {
    const state = AdminOrganisersPage._state;
    const region = state.links;
    if (!region) return;

    const url = String(result.joinUrl || '');
    const who = String(result.display_name || result.email || 'this organiser');

    region.textContent = '';

    const box = document.createElement('section');
    box.className = 'org-link';
    // role=group + a label so a screen reader announces the whole box as one
    // thing rather than a stray input floating above a table.
    box.setAttribute('role', 'group');

    const h2 = document.createElement('h2');
    h2.className = 'org-link__title';
    h2.textContent = (kind === 'resent' ? 'New join link for ' : 'Join link for ') + who;
    box.appendChild(h2);

    /* ---- the warning, before the link itself ------------------------ */
    const warn = document.createElement('p');
    warn.className = 'org-link__warn';

    const mark = document.createElement('span');
    mark.className = 'org-link__warn-mark';
    mark.setAttribute('aria-hidden', 'true');   // decorative; the word follows
    mark.textContent = '⚠';
    warn.appendChild(mark);
    warn.appendChild(document.createTextNode(' '));

    const srWord = document.createElement('span');
    srWord.className = 'visually-hidden';
    srWord.textContent = 'Important: ';
    warn.appendChild(srWord);

    warn.appendChild(document.createTextNode(
      'This link is shown once and will not be shown again. Copy it now and send ' +
      'it to ' + who + '. It expires in ' + AdminOrganisersPage.EXPIRY_HOURS +
      ' hours and stops working the moment it is used.'));
    box.appendChild(warn);

    if (!url) {
      const missing = document.createElement('p');
      missing.className = 'org-link__note';
      missing.textContent =
        'The server did not return a link. Use "Resend link" on the row below to ' +
        'get a new one.';
      box.appendChild(missing);
      region.appendChild(box);
      return;
    }

    /* ---- the link itself -------------------------------------------- */
    const controls = document.createElement('div');
    controls.className = 'org-link__controls';

    /* A read-only input, never an <a>: clicking the link would open it, and
       opening it burns the one-time token before the organiser ever sees it
       (CONTRACTS-PHASE3 §1 rule 3). It is also selectable, scrolls a long URL
       instead of wrapping it into soup, and gives the copy fallback something
       real to select. */
    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'input org-link__url';
    field.readOnly = true;
    field.value = url;
    field.setAttribute('aria-label', 'Join link for ' + who);
    field.addEventListener('focus', function () { field.select(); });
    controls.appendChild(field);

    controls.appendChild(AdminOrganisersPage._copyButton('Copy link', url, field));
    box.appendChild(controls);

    const expiry = document.createElement('p');
    expiry.className = 'org-link__note';
    const expiryText = result.joinExpiresAtDisplay
      ? String(result.joinExpiresAtDisplay)
      : (result.joinExpiresAt ? String(result.joinExpiresAt) : '');
    expiry.textContent = expiryText
      ? 'Expires ' + expiryText + '.'
      : 'Expires ' + AdminOrganisersPage.EXPIRY_HOURS + ' hours from now.';
    box.appendChild(expiry);

    const lost = document.createElement('p');
    lost.className = 'org-link__note';
    lost.textContent =
      'If the link is lost, use "Resend link" on their row. That creates a fresh ' +
      'link and the one above stops working immediately — so only ever send the ' +
      'newest one. Do not open the link yourself: opening it uses it up.';
    box.appendChild(lost);

    const dismiss = UI.button('I have copied it — hide this link', function () {
      region.textContent = '';
    }, { variant: 'secondary' });
    dismiss.className += ' btn--auto org-link__dismiss';
    box.appendChild(dismiss);

    region.appendChild(box);
    if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
    if (field.focus) field.focus();
  },

  /**
   * @param {string} label
   * @param {string} text what lands on the clipboard
   * @param {HTMLElement} [fallbackInput] an input holding the same text
   * @return {HTMLElement}
   */
  _copyButton: function (label, text, fallbackInput) {
    const btn = UI.button(label, function () {
      AdminOrganisersPage._copy(text, fallbackInput).then(function (ok) {
        btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        // Live region so the confirmation is announced, not only seen.
        btn.setAttribute('aria-live', 'polite');
        window.setTimeout(function () { btn.textContent = label; }, 2000);
      });
    }, { variant: 'primary', type: 'button' });
    btn.className += ' btn--auto org-link__copy';
    return btn;
  },

  /**
   * Copy to the clipboard.
   *
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
    if (window.navigator && window.navigator.clipboard &&
        window.navigator.clipboard.writeText) {
      return window.navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return AdminOrganisersPage._copyFallback(fallbackInput); });
    }
    return Promise.resolve(AdminOrganisersPage._copyFallback(fallbackInput));
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

  /* ------------------------------------------------------------------ *
   * The list
   * ------------------------------------------------------------------ */

  /**
   * @param {!Array<!Object>} rows organiser.list response
   * @return {HTMLElement}
   */
  _listContent: function (rows) {
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent =
        'No organisers for this tournament yet. Add one above and send them the link.';
      return empty;
    }

    const wrap = document.createElement('div');
    wrap.className = 'table__wrap';

    const table = document.createElement('table');
    table.className = 'table org-list__table';

    const caption = document.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent =
      'Organisers for this tournament, whether they have set a password yet, and ' +
      'when they last signed in.';
    table.appendChild(caption);

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Name', 'Email', 'Account', 'Join link', 'Added', 'Last sign-in', 'Actions']
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
      tbody.appendChild(AdminOrganisersPage._listRow(row || {}));
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  },

  /**
   * One organiser row.
   *
   * EVERY CELL IS A NAMED FIELD. organiser.list returns no token and no hash
   * (CONTRACTS-PHASE3 §1), and nothing here loops over the row's keys, so a
   * field added to that response later cannot end up on screen by accident.
   *
   * @param {!Object} row {user_id, email, display_name, status, created_at,
   *        last_login_at, joinPending}
   * @return {HTMLElement}
   */
  _listRow: function (row) {
    const tr = document.createElement('tr');
    const disabled = String(row.status || '').toUpperCase() === 'DISABLED';
    if (disabled) tr.className = 'org-list__row--disabled';

    /* Name. textContent, always: it was typed by an admin into a form and
       stored in a sheet, so it is untrusted input. */
    const nameCell = document.createElement('th');
    nameCell.scope = 'row';
    nameCell.className = 'org-list__name';
    nameCell.textContent = String(row.display_name || '(no name)');
    tr.appendChild(nameCell);

    tr.appendChild(AdminOrganisersPage._cell(String(row.email || '—')));

    /* Account status: word first, colour second (DESIGN.md §51). */
    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = 'org-badge ' +
      (disabled ? 'org-badge--disabled' : 'org-badge--active');
    status.textContent = disabled ? 'Disabled' : 'Active';
    statusCell.appendChild(status);
    tr.appendChild(statusCell);

    /* joinPending is true while the link is unused and unexpired — i.e. this
       person has not set a password yet, which is the single thing an admin
       wants to know when the organiser says "it does not work". */
    const joinCell = document.createElement('td');
    const join = document.createElement('span');
    if (row.joinPending) {
      join.className = 'org-badge org-badge--pending';
      join.textContent = 'Not used yet';
    } else {
      join.className = 'org-badge org-badge--done';
      join.textContent = 'Password set';
    }
    joinCell.appendChild(join);
    tr.appendChild(joinCell);

    tr.appendChild(AdminOrganisersPage._cell(AdminOrganisersPage._when(row, 'created_at')));
    tr.appendChild(AdminOrganisersPage._cell(
      AdminOrganisersPage._when(row, 'last_login_at', 'Never')));

    /* ---- actions ---------------------------------------------------- */
    const actions = document.createElement('td');
    actions.className = 'org-list__actions';

    actions.appendChild(UI.button('Resend link', function () {
      AdminOrganisersPage._resend(row);
    }, { variant: 'secondary' }));

    if (!disabled) {
      actions.appendChild(UI.button('Disable', function () {
        AdminOrganisersPage._disable(row);
      }, { variant: 'danger' }));
    } else {
      const note = document.createElement('span');
      note.className = 'org-list__note';
      note.textContent = 'Signed out and blocked';
      actions.appendChild(note);
    }

    tr.appendChild(actions);
    return tr;
  },

  /**
   * Mint a fresh link. The old one dies at the same moment, so the dialog says
   * so before anything happens (CONTRACTS-PHASE3 §1).
   *
   * @param {!Object} row
   * @return {void}
   */
  _resend: function (row) {
    const state = AdminOrganisersPage._state;
    const who = String(row.display_name || row.email || 'this organiser');

    UI.confirmDialog({
      title: 'Send ' + who + ' a new join link?',
      body: 'This creates a brand new link and the previous one stops working ' +
        'straight away. The new link is shown once, here on this screen, and ' +
        'expires in ' + AdminOrganisersPage.EXPIRY_HOURS + ' hours. If ' + who +
        ' has already set a password they do not need a link at all — they can ' +
        'just sign in.',
      confirmLabel: 'Create a new link'
    }).then(function (ok) {
      if (!ok || !AdminOrganisersPage._current(state)) return null;

      AdminOrganisersPage._clearError(state.errors);

      return AdminOrganisersPage._call('organiser.resendLink', {
        tournamentId: state.tournamentId,
        userId: String(row.user_id || '')
      }).then(function (result) {
        if (!AdminOrganisersPage._current(state)) return;
        AdminOrganisersPage._showLink(result || { display_name: who }, 'resent');
        AdminOrganisersPage._loadList();
      });
    }).catch(function (err) {
      if (AdminOrganisersPage._handled(err) ||
          !AdminOrganisersPage._current(state)) return;
      AdminOrganisersPage._showError(state.errors, err);
    });
  },

  /**
   * Disable an organiser. Their sessions are revoked server-side, so this is
   * immediate, not "from the next sign-in" — the dialog says that plainly and
   * names the person, because "Disable?" on its own next to eight rows is how
   * the wrong one gets switched off.
   *
   * @param {!Object} row
   * @return {void}
   */
  _disable: function (row) {
    const state = AdminOrganisersPage._state;
    const who = String(row.display_name || row.email || 'this organiser');
    const address = String(row.email || '');

    UI.confirmDialog({
      title: 'Disable ' + who + '?',
      body: who + (address ? ' (' + address + ')' : '') +
        ' will be signed out immediately, on every device, and will not be able ' +
        'to sign in again. Anything they have already done stays in the records. ' +
        'You can create them again later if you need to.',
      confirmLabel: 'Disable ' + who,
      danger: true
    }).then(function (ok) {
      if (!ok || !AdminOrganisersPage._current(state)) return null;

      AdminOrganisersPage._clearError(state.errors);

      return AdminOrganisersPage._call('organiser.disable', {
        userId: String(row.user_id || '')
      }).then(function () {
        if (!AdminOrganisersPage._current(state)) return;
        AdminOrganisersPage._showNotice(state.notices,
          who + ' has been disabled and signed out.');
        AdminOrganisersPage._loadList();
      });
    }).catch(function (err) {
      if (AdminOrganisersPage._handled(err) ||
          !AdminOrganisersPage._current(state)) return;
      AdminOrganisersPage._showError(state.errors, err);
    });
  },

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

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
   * A timestamp, preferring the server's formatting. Never reformat an instant
   * in the browser: the server generates every timestamp and knows the
   * timezone rule (CONTRACTS.md §6a).
   *
   * @param {!Object} row
   * @param {string} key e.g. 'last_login_at'
   * @param {string} [fallback='—'] shown when the field is empty
   * @return {string}
   */
  _when: function (row, key, fallback) {
    const display = row[key + '_display'];
    if (display) return String(display);
    const raw = row[key];
    return raw ? String(raw) : String(fallback === undefined ? '—' : fallback);
  }
};
