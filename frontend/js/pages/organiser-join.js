/**
 * organiser-join.js — the /organiser/join?k=<token> screen. `OrganiserJoinPage`.
 *
 * An organiser never signs up. An admin creates them and sends one link
 * (CONTRACTS-PHASE3.md §1, DESIGN.md §5.4). Opening that link once, and only
 * once, exchanges the one-time token for a real session and sets a password.
 * This page is therefore the ONLY door an organiser ever walks through, and if
 * it fails it must say what to do instead — there is no "forgot password" and
 * no self-service anything.
 *
 * Contracts honoured:
 *   CONTRACTS-PHASE3 §1   auth.organiserJoin {token, password}
 *                         -> {token, expiresAt, user:{...}}
 *                         password minimum 10 characters, as Auth.createUser
 *                         used / expired / unknown token -> UNAUTHORIZED with
 *                         ONE generic message for all three
 *   CONTRACTS-PHASE3 §5.1 read ?k=, ask twice, store the session, go to the
 *                         dashboard; a dead link must explain the next step
 *   CONTRACTS-PHASE1 §4   textContent only, vanilla JS, every call through
 *                         API, document.body.dataset.route
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT
 *
 *   1. THE PASSWORD RULE IS PRINTED BEFORE THE FIRST KEYSTROKE.
 *      Telling somebody their password is too short after they typed it twice
 *      is a rule they had no way of knowing. It is one line; show it up front.
 *
 *   2. UNAUTHORIZED HERE IS NOT AN EXPIRED SESSION.
 *      Every other page in this app treats UNAUTHORIZED as "your session died,
 *      go and sign in" and redirects. auth.organiserJoin is a PUBLIC action and
 *      the visitor has no password yet, so bouncing them to the sign-in form
 *      would be a dead end — they cannot sign in, that is the whole reason they
 *      were sent a link. So here UNAUTHORIZED means "this link is no good", and
 *      it is answered with the server's own words plus a next step. The
 *      redirect-on-UNAUTHORIZED wrapper lives in the two authenticated Phase 3
 *      pages, where it belongs.
 *
 *   3. THE JOIN CALL DELIBERATELY SENDS NO SESSION TOKEN.
 *      A stale token in localStorage — a previous organiser on a shared venue
 *      laptop, say — must have no bearing on who this link belongs to. The call
 *      passes {token: null} so API.call sends an empty token in the body.
 */

/* eslint-disable no-unused-vars */
const OrganiserJoinPage = {

  /** Where an organiser signs in once they HAVE a password. @const {string} */
  // The organiser door, not the admin one. Same form, but a person who has
  // just set an organiser password should not land on a screen headed
  // "Admin sign-in" and wonder whether they were given the wrong link.
  LOGIN_PATH: '/organiser/login',

  /** @const {string} */
  DASHBOARD_PATH: '/organiser/dashboard',

  /**
   * The organiser's tournament, remembered locally after joining.
   *
   * WHY THIS EXISTS. Every team action is scoped to one tournament, but the
   * Phase 3 contract has no "who am I" endpoint — the tournament id is handed
   * over exactly once, in the auth.organiserJoin response. Losing it would
   * leave the dashboard unable to call team.list at all. So it is written here
   * and read by OrganiserDashboardPage, which keeps the same two key names.
   * It is a convenience copy, never an authorisation: the server re-checks the
   * organiser's own tournament_id on every call (DESIGN.md §5.6).
   * @const {string}
   */
  TOURNAMENT_KEY: 'ca.organiser.tournament',

  /** @const {string} */
  NAME_KEY: 'ca.organiser.name',

  /**
   * Minimum password length, mirroring Auth.createUser (CONTRACTS-PHASE3 §1
   * rule 2). Checked here only to save a round trip and to be able to say the
   * rule out loud; the server is the authority.
   * @const {number}
   */
  MIN_PASSWORD: 10,

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
    document.body.dataset.route = 'organiser-join';

    const gen = ++OrganiserJoinPage._gen;
    OrganiserJoinPage._state = { gen: gen, busy: false, errors: null };

    const query = (ctx && ctx.query) || {};
    const token = String(query.k === undefined || query.k === null ? '' : query.k).trim();

    if (!token) {
      OrganiserJoinPage._renderIncompleteLink();
      return;
    }

    OrganiserJoinPage._renderForm(token);
  },

  /* ================================================================== *
   * Shared plumbing
   * ================================================================== */

  /**
   * @param {Object} state the state captured when the view was built
   * @return {boolean} true when this view is still the one on screen
   */
  _current: function (state) {
    return !!state && state.gen === OrganiserJoinPage._gen;
  },

  /**
   * Page frame: heading, note, live error region, body.
   * @param {string} title
   * @param {string} [note]
   * @return {{main:HTMLElement, errors:HTMLElement, body:HTMLElement}}
   */
  _shell: function (title, note) {
    document.title = title + ' · Cricket Auction';

    const main = document.createElement('main');
    main.className = 'panel org-join';

    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = title;
    main.appendChild(h1);

    if (note) {
      const p = document.createElement('p');
      p.className = 'panel__note';
      p.textContent = note;
      main.appendChild(p);
    }

    // Permanent live region. Errors replace its contents rather than being
    // added and removed, which is what makes them announced reliably.
    const errors = document.createElement('div');
    errors.className = 'org-join__errors';
    errors.setAttribute('aria-live', 'assertive');
    errors.setAttribute('aria-atomic', 'true');
    main.appendChild(errors);

    const body = document.createElement('div');
    body.className = 'org-join__body';
    main.appendChild(body);

    return { main: main, errors: errors, body: body };
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
   * @param {HTMLElement} el
   * @return {void}
   */
  _mount: function (el) {
    App.root.textContent = '';
    App.root.appendChild(el);
  },

  /**
   * The block that turns a dead end into an action. Shown whenever the link
   * cannot be used, whatever the reason — because from the organiser's side
   * every reason has the same answer.
   *
   * @return {HTMLElement}
   */
  _nextSteps: function () {
    const box = document.createElement('section');
    box.className = 'org-join__next';

    const h2 = document.createElement('h2');
    h2.className = 'panel__subtitle';
    h2.textContent = 'What to do next';
    box.appendChild(h2);

    const lead = document.createElement('p');
    lead.className = 'org-join__next-lead';
    lead.textContent = 'Ask the tournament admin to send you a new link.';
    box.appendChild(lead);

    const ul = document.createElement('ul');
    ul.className = 'org-join__next-list';
    [
      'A join link works once. After it has been used, it stops working.',
      'A join link expires ' + OrganiserJoinPage.EXPIRY_HOURS + ' hours after it is sent.',
      'When the admin sends a new link, any older link stops working straight away — ' +
        'always use the newest one.',
      'If you have already set your password, you do not need this page. Sign in instead.'
    ].forEach(function (text) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    });
    box.appendChild(ul);

    const signIn = document.createElement('a');
    signIn.className = 'btn btn--secondary';
    signIn.href = Router.href(OrganiserJoinPage.LOGIN_PATH);
    signIn.textContent = 'Go to sign in';
    box.appendChild(signIn);

    return box;
  },

  /* ================================================================== *
   * View 1 — the link had no key in it at all
   * ================================================================== */

  /** @return {void} */
  _renderIncompleteLink: function () {
    const shell = OrganiserJoinPage._shell(
      'This join link is incomplete',
      'The address is missing the key that identifies you, so there is nothing to check.'
    );

    OrganiserJoinPage._showError(shell.errors,
      'This link is incomplete. It is missing its key, which usually means only ' +
      'part of the link was copied — check that you pasted the whole thing, ' +
      'including everything after "?k=".');

    shell.body.appendChild(OrganiserJoinPage._nextSteps());
    OrganiserJoinPage._mount(shell.main);
  },

  /* ================================================================== *
   * View 2 — the form
   * ================================================================== */

  /**
   * @param {string} token the one-time join token from ?k=
   * @return {void}
   */
  _renderForm: function (token) {
    const state = OrganiserJoinPage._state;

    const shell = OrganiserJoinPage._shell(
      'Set your password',
      'This link sets up your organiser account for one tournament. You only ' +
      'need to do this once.'
    );
    state.errors = shell.errors;

    /* ---- the rule, BEFORE the boxes -------------------------------- */
    const rules = document.createElement('section');
    rules.className = 'org-join__rules';

    const rulesTitle = document.createElement('h2');
    rulesTitle.className = 'panel__subtitle';
    rulesTitle.textContent = 'Choose a password';
    rules.appendChild(rulesTitle);

    const rulesList = document.createElement('ul');
    rulesList.className = 'org-join__rules-list';
    [
      'At least ' + OrganiserJoinPage.MIN_PASSWORD + ' characters. Longer is better.',
      'Type it twice, so a typo cannot lock you out.',
      'You will sign in with your email address and this password from now on.',
      'This link expires ' + OrganiserJoinPage.EXPIRY_HOURS +
        ' hours after the admin sent it, and stops working once you have used it.'
    ].forEach(function (text) {
      const li = document.createElement('li');
      li.textContent = text;
      rulesList.appendChild(li);
    });
    rules.appendChild(rulesList);
    shell.body.appendChild(rules);

    /* ---- the form -------------------------------------------------- */
    const form = document.createElement('form');
    form.className = 'form org-join__form';
    form.setAttribute('novalidate', 'novalidate');

    const first = UI.field({
      label: 'New password',
      name: 'password',
      type: 'password',
      required: true,
      autocomplete: 'new-password',
      hint: 'At least ' + OrganiserJoinPage.MIN_PASSWORD + ' characters.'
    });
    const second = UI.field({
      label: 'Type it again',
      name: 'password2',
      type: 'password',
      required: true,
      autocomplete: 'new-password',
      hint: 'Both boxes must match exactly.'
    });

    form.appendChild(first.wrap);
    form.appendChild(second.wrap);

    /* No busyLabel: UI.button restores itself as soon as the promise its
       handler RETURNS settles, and run() returns nothing, so it would
       re-enable mid-request. It also never sees the Enter key. setBusy()
       owns both paths, exactly as the sign-in and tournament forms do. */
    const submitLabel = 'Set password and continue';
    const submit = UI.button(submitLabel, function () { run(); },
      { variant: 'primary', type: 'submit' });

    const bar = document.createElement('div');
    bar.className = 'org-join__submit';
    bar.appendChild(submit);
    form.appendChild(bar);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      run();
    });

    shell.body.appendChild(form);
    OrganiserJoinPage._mount(shell.main);
    if (first.input.focus) first.input.focus();

    /**
     * @param {boolean} busy
     * @return {void}
     */
    function setBusy(busy) {
      state.busy = !!busy;
      submit.disabled = !!busy;
      submit.setAttribute('aria-busy', busy ? 'true' : 'false');
      submit.textContent = busy ? 'Setting your password…' : submitLabel;
    }

    /**
     * Validate both boxes, then exchange the token for a session.
     * A mismatch or a short password never reaches the network: there is
     * nothing the server could tell us that we do not already know, and a
     * failed attempt against a one-time token is not a thing to risk.
     * @return {void}
     */
    function run() {
      if (state.busy) return;

      first.clearError();
      second.clearError();
      OrganiserJoinPage._clearError(state.errors);

      const a = String(first.input.value || '');
      const b = String(second.input.value || '');

      const problem = OrganiserJoinPage._validate(a, b);
      if (problem) {
        const handle = problem.field === 'password2' ? second : first;
        handle.setError(problem.message);
        OrganiserJoinPage._showError(state.errors, problem.message);
        if (handle.input.focus) handle.input.focus();
        return;
      }

      setBusy(true);

      // {token: null} = send no session token. See the header comment.
      API.call('auth.organiserJoin', { token: token, password: a }, { token: null })
        .then(function (data) {
          if (!OrganiserJoinPage._current(state)) return;
          OrganiserJoinPage._onJoined(data || {});
        })
        .catch(function (err) {
          if (!OrganiserJoinPage._current(state)) return;
          setBusy(false);
          OrganiserJoinPage._onFailure(err, first, second);
        });
    }
  },

  /**
   * The two client-side rules. Returns the FIRST problem only — fixing one
   * password box at a time is how people actually work.
   *
   * @param {string} a
   * @param {string} b
   * @return {?{field:string, message:string}}
   */
  _validate: function (a, b) {
    if (!a) {
      return {
        field: 'password',
        message: 'Enter a password of at least ' +
          OrganiserJoinPage.MIN_PASSWORD + ' characters.'
      };
    }
    if (a.length < OrganiserJoinPage.MIN_PASSWORD) {
      return {
        field: 'password',
        message: 'Your password must be at least ' + OrganiserJoinPage.MIN_PASSWORD +
          ' characters. This one has ' + a.length + '.'
      };
    }
    if (!b) {
      return {
        field: 'password2',
        message: 'Type the same password again in the second box.'
      };
    }
    if (a !== b) {
      return {
        field: 'password2',
        message: 'The two passwords do not match. Type the same password in both boxes.'
      };
    }
    return null;
  },

  /**
   * @param {!Object} data auth.organiserJoin response
   * @return {void}
   */
  _onJoined: function (data) {
    const state = OrganiserJoinPage._state;
    const session = data && data.token ? String(data.token) : '';

    if (!session) {
      OrganiserJoinPage._showError(state.errors,
        'Your password was set, but the server did not return a session. ' +
        'Sign in with your email address and the password you just chose.');
      return;
    }

    API.setToken(session);
    OrganiserJoinPage._remember(data.user || {});

    Router.navigate(OrganiserJoinPage.DASHBOARD_PATH, { replace: true });
  },

  /**
   * Keep the organiser's tournament and name for the dashboard. Best effort:
   * private browsing refuses writes, and the dashboard has its own fallbacks.
   *
   * @param {!Object} user {user_id, display_name, role, tournament_id}
   * @return {void}
   */
  _remember: function (user) {
    try {
      const tid = user && user.tournament_id ? String(user.tournament_id) : '';
      if (tid) window.localStorage.setItem(OrganiserJoinPage.TOURNAMENT_KEY, tid);

      const name = user && user.display_name ? String(user.display_name) : '';
      if (name) window.localStorage.setItem(OrganiserJoinPage.NAME_KEY, name);
    } catch (e) {
      /* the dashboard falls back to ?t= in the URL */
    }
  },

  /**
   * @param {{code:string, message:string}} err rejection from API.call
   * @param {!Object} first  UI.field handle
   * @param {!Object} second UI.field handle
   * @return {void}
   */
  _onFailure: function (err, first, second) {
    const state = OrganiserJoinPage._state;
    const code = err && err.code ? String(err.code) : '';
    const message = (err && err.message) ? String(err.message)
      : 'Something went wrong. Please try again.';

    /* UNAUTHORIZED covers unknown, already used and expired, on purpose and
       with one message for all three (CONTRACTS-PHASE3 §1 rule 1): telling an
       attacker which tokens exist is exactly what that generic message avoids.
       So it is shown UNCHANGED — and then answered with the next step, which
       is the part the organiser actually needs, because the message on its own
       leaves them holding a link that does nothing. */
    if (code === 'UNAUTHORIZED') {
      const shell = OrganiserJoinPage._shell(
        'This join link cannot be used',
        'It may have been used already, or it may have expired. Either way the ' +
        'fix is the same.'
      );
      state.errors = shell.errors;
      OrganiserJoinPage._showError(shell.errors, message);
      shell.body.appendChild(OrganiserJoinPage._nextSteps());
      OrganiserJoinPage._mount(shell.main);
      return;
    }

    /* Anything else — a short password the server rejected, a network drop —
       keeps the form on screen so it can be retried. The server's wording is
       shown as-is; it knows which rule was broken and we do not. */
    OrganiserJoinPage._showError(state.errors, message);

    if (code === 'VALIDATION_FAILED') {
      first.setError(message);
      if (first.input.focus) first.input.focus();
    }
  }
};
