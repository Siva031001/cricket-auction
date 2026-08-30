/**
 * admin-login.js — the /admin/login screen.
 *
 * Scope (CONTRACTS-PHASE1.md §6): email + password, exchange them for a
 * session token, go to the dashboard. Nothing else lives here.
 *
 * Contracts honoured:
 *   CONTRACTS.md §7      auth.login(email, password, ua), 12 h session,
 *                        account locked for 15 minutes after 5 failures
 *   CONTRACTS.md §15     every call goes through API, never fetch
 *   CONTRACTS-PHASE1 §4  textContent only, vanilla JS, data-route on <body>
 *
 * UI widgets come from js/ui.js (UI) — this file never hand-rolls a field or
 * a button, so the admin screens and the registration screen stay identical.
 */

/* eslint-disable no-unused-vars */
const AdminLoginPage = {

  /** Where a successful sign-in lands. */
  DASHBOARD_PATH: '/admin/dashboard',

  /**
   * Per-render state. Recreated by every render() so a stale in-flight
   * request from a previous visit can never re-enable a button that no
   * longer exists.
   * @type {?Object}
   */
  _state: null,

  /**
   * Incremented on every render. Async callbacks compare against it and bail
   * out if the user has navigated somewhere else in the meantime.
   * @type {number}
   */
  _gen: 0,

  /**
   * Render the sign-in screen.
   * @param {Object} ctx router context {path, params, query, pattern}
   * @return {void}
   */
  render: function (ctx) {
    document.body.dataset.route = 'admin-login';
    document.title = 'Admin sign-in · Cricket Auction';

    const gen = ++AdminLoginPage._gen;
    AdminLoginPage._state = { busy: false, gen: gen };

    // Already signed in? Do not make the admin type a password they do not
    // need to type. auth.me is the cheapest way to find out whether the
    // stored token is still alive — a token in localStorage proves nothing,
    // sessions expire after 12 hours (CONTRACTS.md §7 rule 3).
    if (API.getToken()) {
      AdminLoginPage._renderChecking();
      API.call('auth.me', {})
        .then(function () {
          if (gen !== AdminLoginPage._gen) return;
          Router.navigate(AdminLoginPage.DASHBOARD_PATH, { replace: true });
        })
        .catch(function () {
          // Expired, revoked, or the network is down. Either way the only
          // useful thing to show is the form.
          if (gen !== AdminLoginPage._gen) return;
          API.clearToken();
          AdminLoginPage._renderForm();
        });
      return;
    }

    AdminLoginPage._renderForm();
  },

  /* ------------------------------------------------------------------ *
   * Views
   * ------------------------------------------------------------------ */

  /**
   * Interim view while auth.me decides whether the stored token still works.
   * @return {void}
   */
  _renderChecking: function () {
    const main = document.createElement('main');
    main.className = 'panel admin-login';

    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = 'Admin sign-in';
    main.appendChild(h1);

    main.appendChild(UI.spinner('Checking your session…'));

    AdminLoginPage._mount(main);
  },

  /**
   * The sign-in form.
   * @return {void}
   */
  _renderForm: function () {
    const state = AdminLoginPage._state;

    const main = document.createElement('main');
    main.className = 'panel admin-login';

    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = 'Admin sign-in';
    main.appendChild(h1);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent = 'Sign in to create tournaments and watch registrations arrive.';
    main.appendChild(note);

    /* Errors live in a permanent live region rather than being inserted and
       removed. A region that already exists when its text changes is the
       only arrangement screen readers announce reliably. */
    const errorRegion = document.createElement('div');
    errorRegion.className = 'admin-login__error';
    errorRegion.setAttribute('aria-live', 'assertive');
    errorRegion.setAttribute('aria-atomic', 'true');
    main.appendChild(errorRegion);

    const form = document.createElement('form');
    form.className = 'admin-login__form';
    form.setAttribute('novalidate', 'novalidate');   // our messages, not the browser's

    const email = UI.field({
      label: 'Email',
      name: 'email',
      type: 'email',
      required: true,
      autocomplete: 'username'
    });
    email.input.autocapitalize = 'none';
    email.input.spellcheck = false;
    form.appendChild(email.wrap);

    const password = UI.field({
      label: 'Password',
      name: 'password',
      type: 'password',
      required: true,
      autocomplete: 'current-password'
    });
    form.appendChild(password.wrap);

    /* No busyLabel here on purpose.
       UI.button's busyLabel guard restores the button when the promise its
       handler RETURNS settles — and this handler returns nothing, so it would
       restore on the very next microtask, re-enabling the button while the
       login request is still in flight. It also never sees the Enter key,
       which reaches the form's submit event directly. So the busy state has
       exactly one owner: _setBusy() below, which covers both paths. */
    const submit = UI.button('Sign in', function () {
      AdminLoginPage._submit();
    }, { variant: 'primary', type: 'submit' });
    form.appendChild(submit);

    /* One entry point for both paths. A click fires the UI.button handler and
       may also fire this listener; pressing Enter in a field fires only this
       one. _submit() guards on state.busy, which it sets synchronously, so a
       double trigger runs the request exactly once. */
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      AdminLoginPage._submit();
    });

    main.appendChild(form);

    state.email = email;
    state.password = password;
    state.submit = submit;
    state.submitLabel = 'Sign in';
    state.errorRegion = errorRegion;

    AdminLoginPage._mount(main);
    email.input.focus();
  },

  /* ------------------------------------------------------------------ *
   * Submit
   * ------------------------------------------------------------------ */

  /**
   * Validate, call auth.login, store the token, go to the dashboard.
   * Re-entrant calls while a request is in flight are ignored.
   * @return {void}
   */
  _submit: function () {
    const state = AdminLoginPage._state;
    if (!state || state.busy) return;

    const email = String(state.email.input.value || '').trim();
    const password = String(state.password.input.value || '');

    state.email.clearError();
    state.password.clearError();
    AdminLoginPage._clearError();

    // Local checks only catch an empty box. Everything else is the server's
    // call — see the comment in _onFailure about why.
    let bad = false;
    if (!email) {
      state.email.setError('Enter your email address.');
      bad = true;
    }
    if (!password) {
      state.password.setError('Enter your password.');
      bad = true;
    }
    if (bad) {
      (email ? state.password : state.email).input.focus();
      return;
    }

    AdminLoginPage._setBusy(true);

    API.call('auth.login', {
      email: email,
      password: password,
      // Apps Script cannot read request headers, so the browser sends its own
      // user agent in the body. Audit log only (CONTRACTS.md §7, Code.gs).
      ua: navigator.userAgent
    }, { retryBusy: false })
      .then(function (data) {
        if (state.gen !== AdminLoginPage._gen) return;
        AdminLoginPage._onSuccess(data);
      })
      .catch(function (err) {
        if (state.gen !== AdminLoginPage._gen) return;
        AdminLoginPage._setBusy(false);
        AdminLoginPage._onFailure(err);
      });
  },

  /**
   * @param {Object} data {token, expiresAt, user:{user_id, display_name, role, tournament_id}}
   * @return {void}
   */
  _onSuccess: function (data) {
    const token = data && data.token ? String(data.token) : '';
    if (!token) {
      AdminLoginPage._setBusy(false);
      AdminLoginPage._showError('Sign-in did not return a session. Please try again.');
      return;
    }

    API.setToken(token);

    // An ORGANISER can sign in through this form too; their home is a
    // different screen. Phase 1 has no organiser dashboard yet, so anyone who
    // is not an ADMIN still goes to /admin/dashboard and the server refuses
    // the actions they are not allowed to run. Authorisation is the server's
    // job; hiding a screen is not authorisation (DESIGN.md §5.6).
    Router.navigate(AdminLoginPage.DASHBOARD_PATH, { replace: true });
  },

  /**
   * @param {{code:string, message:string}} err rejection from API.call
   * @return {void}
   */
  _onFailure: function (err) {
    const message = (err && err.message)
      ? String(err.message)
      : 'Sign-in failed. Please try again.';

    /* SHOW THE SERVER'S MESSAGE UNCHANGED. DO NOT "IMPROVE" IT.
     *
     * Auth.login answers an unknown email, a disabled account and a wrong
     * password with one identical UNAUTHORIZED message, deliberately
     * (backend/Auth.gs, CONTRACTS.md §7). If this form said "no such user"
     * for one and "wrong password" for the other, anyone could feed it a list
     * of addresses and learn exactly who holds an account here — the form
     * would become an account-enumeration oracle. Rewording, splitting or
     * adding a hint to the message re-opens that hole from the client side.
     *
     * The 15-minute lockout after 5 consecutive failures (CONTRACTS.md §7
     * rule 5) also arrives as UNAUTHORIZED, with its own plain-English text.
     * Passing the message straight through is what makes that lockout
     * explain itself instead of looking like another wrong password.
     */
    AdminLoginPage._showError(message);

    // Clear the password, keep the email. Retyping an address after a typo in
    // the password is pure friction.
    AdminLoginPage._state.password.input.value = '';
    AdminLoginPage._state.password.input.focus();
  },

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  /**
   * Lock or unlock the form while a request is in flight. Disabling the
   * button is the only thing that stops a second login attempt racing the
   * first and burning two of the five allowed failures.
   * @param {boolean} busy
   * @return {void}
   */
  _setBusy: function (busy) {
    const state = AdminLoginPage._state;
    if (!state) return;

    state.busy = !!busy;
    state.submit.disabled = !!busy;
    state.submit.setAttribute('aria-busy', busy ? 'true' : 'false');
    state.submit.textContent = busy ? 'Signing in…' : state.submitLabel;
    state.email.input.readOnly = !!busy;
    state.password.input.readOnly = !!busy;
  },

  /**
   * @param {string} message shown verbatim
   * @return {void}
   */
  _showError: function (message) {
    const region = AdminLoginPage._state && AdminLoginPage._state.errorRegion;
    if (!region) return;
    region.textContent = '';
    region.appendChild(UI.banner('error', message));
  },

  /** @return {void} */
  _clearError: function () {
    const region = AdminLoginPage._state && AdminLoginPage._state.errorRegion;
    if (region) region.textContent = '';
  },

  /**
   * Replace the app root with one element.
   * @param {HTMLElement} el
   * @return {void}
   */
  _mount: function (el) {
    App.root.textContent = '';
    App.root.appendChild(el);
  }
};
