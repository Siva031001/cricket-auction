/**
 * app.js — bootstrap and route table for the SPA shell.
 *
 * WHAT THIS FILE DOES, and nothing more:
 *   - restore the deep link that 404.html parked in the query string
 *   - warn loudly when config.js has not been filled in
 *   - map each route to a page module, or to a placeholder for phases that
 *     have not landed yet
 *   - guard /admin/* behind a stored session token
 *   - never let a missing or throwing page module produce a blank page
 *
 * Route map (CONTRACTS.md §15, CONTRACTS-PHASE1.md §4, CONTRACTS-PHASE2.md §6):
 *   /                              landing panel                     here
 *   /register/:tournamentId        RegisterPage         js/pages/register.js
 *   /admin/login                   AdminLoginPage       js/pages/admin-login.js
 *   /admin/dashboard               AdminTournamentPage  js/pages/admin-tournament.js
 *   /admin/payments                AdminPaymentsPage    js/pages/admin-payments.js
 *   /admin/players                 AdminPlayersPage     js/pages/admin-players.js
 *   /organiser/dashboard           Phase 3 placeholder
 *   /organiser/auction             Phase 4 placeholder
 *   /auction/:tournamentId/display Phase 5 placeholder
 *
 * Page module convention (CONTRACTS-PHASE1.md §4):
 *   const RegisterPage = { render: function (ctx) { ...fills App.root... } };
 * where ctx is the router context { path, params, query, pattern }.
 *
 * ==========================================================================
 * FOR THE PHASE 2 PAGE AUTHORS — the shared admin nav (CONTRACTS-PHASE2 §6.3)
 * ==========================================================================
 *
 *   App.adminNav(activeKey, ctx)  ->  HTMLElement    (a <nav>, ready to mount)
 *
 *     activeKey  'dashboard' | 'payments' | 'players'   which tab to mark
 *                as current. Any other value simply marks nothing.
 *     ctx        the router context your render(ctx) was given. Optional —
 *                omit it and the nav reads the live URL instead.
 *
 *   Append the returned element as the FIRST child of whatever you mount, or
 *   ignore it entirely: if you do not call it, app.js mounts the same nav
 *   itself, just above #app, so the admin always has it. Calling it takes
 *   ownership; app.js then stays out of the way. Never call it twice in one
 *   render — you would get two navs.
 *
 * The nav carries, in this order of prominence:
 *   1. WHICH TOURNAMENT IS SELECTED. Every Phase 2 action is tournament
 *      scoped and verifying a payment against the wrong tournament is silent
 *      and unrecoverable, so this is the loudest thing on the bar.
 *   2. Links to the three admin screens, each one carrying the selection.
 *   3. Sign out.
 *
 * The selection lives in the URL query as ?t=TRN_xxx. That is the ONLY
 * source of truth — a reload, a bookmark and a shared link therefore all
 * open the same tournament. localStorage holds a copy purely so that
 * arriving at /admin/payments with no ?t= can bounce you to your last one;
 * it is never read in preference to the URL.
 *
 *   App.currentTournamentId(ctx)  -> 'TRN_xxx' or '' — read this, not the
 *                                    query, so the sanitising stays in one
 *                                    place
 *   App.adminPath(path, id)       -> '/admin/players?t=TRN_xxx'; use it for
 *                                    every internal link you build, or the
 *                                    selection is lost on the next click
 *   App.tournamentName(id)        -> the name if it is already known, else
 *                                    '' (the nav fills its own in async)
 *   App.setTournament(id, name)   -> remember a selection; does not navigate
 *   App.changeTournament()        -> drop the selection and show the picker
 *                                    for the screen you are on
 *   App.signOut()                 -> clears the token and returns to login
 *
 * app.js also refuses to render a tournament-scoped page with no selection:
 * it shows a picker that explains why instead of an empty screen. So your
 * render(ctx) may assume App.currentTournamentId(ctx) is non-empty.
 * ==========================================================================
 *
 * HARD RULES carried over from Phase 0 and still binding:
 *   1. textContent, never innerHTML. A tournament name comes from the sheet
 *      and a tournament id comes from the URL; both are untrusted.
 *   2. Vanilla JS. No framework, no build step, no CDN, no web font.
 *   3. document.body.dataset.route is set on every navigation so CSS can
 *      scope itself (this is what turns on the projector theme).
 *   4. Every network call goes through API; never call fetch directly.
 */

/* eslint-disable no-unused-vars */
const App = {

  /** @type {HTMLElement|null} */
  root: null,

  /**
   * Where the admin was heading when the auth guard bounced them to the
   * login screen. AdminLoginPage may read this and send them back there
   * after a successful login; if it ignores it, nothing breaks.
   * @type {string|null}
   */
  intendedPath: null,

  /* ------------------------------------------------------------------ *
   * Admin shell constants
   * ------------------------------------------------------------------ */

  /** @const {string} */
  LOGIN_PATH: '/admin/login',

  /** @const {string} where a tournament gets chosen */
  DASHBOARD_PATH: '/admin/dashboard',

  /**
   * The query key that carries the selected tournament. CONTRACTS-PHASE2 §6.3
   * makes the selection visible and shareable, so it has to live in the URL:
   * '?t=TRN_k3m9x1qz7f2a'.
   * @const {string}
   */
  TOURNAMENT_PARAM: 't',

  /**
   * localStorage copy of the selection. A CONVENIENCE ONLY. It is read in
   * exactly one situation — an admin route asked for with no ?t= at all —
   * and the answer is immediately written into the URL so the URL stays the
   * single source of truth.
   * @const {string}
   */
  TOURNAMENT_KEY: 'ca.admin.tournament',

  /** localStorage copy of the selected tournament's NAME. @const {string} */
  TOURNAMENT_NAME_KEY: 'ca.admin.tournament.name',

  /**
   * The three admin screens, in nav order.
   * @const {!Array<{key:string, label:string, path:string}>}
   */
  NAV_ITEMS: [
    // Ordered by how an admin actually moves through a tournament: set it up,
    // verify the money, check the register, then reporting and evidence.
    { key: 'dashboard',  label: 'Tournaments', path: '/admin/dashboard' },
    { key: 'payments',   label: 'Payments',    path: '/admin/payments' },
    { key: 'players',    label: 'Players',     path: '/admin/players' },
    { key: 'organisers', label: 'Organisers',  path: '/admin/organisers' },
    { key: 'reports',    label: 'Reports',     path: '/admin/reports' },
    { key: 'audit',      label: 'Audit log',   path: '/admin/audit' }
  ],

  /**
   * Every route that is served by a separate page module.
   *
   * `global` is resolved by App.resolvePage at RENDER time, not at load
   * time, so the order of the <script> tags cannot silently break a route
   * and a page file that 404s degrades to a readable error panel instead
   * of a crash.
   *
   * ADDING A PAGE: add the entry here, add the <script> tag to index.html,
   * AND add the identifier to the switch in App.resolvePage — read the
   * comment there for why that switch cannot be replaced by window[name].
   *
   * `navKey`     shows the shared admin nav on this route and marks that tab
   *              as current (CONTRACTS-PHASE2 §6.3).
   * `tournament` the screen is meaningless without a selected tournament, so
   *              app.js shows the picker rather than letting the page render
   *              an empty shell.
   *
   * @type {Array<{path:string, global:string, file:string, routeKey:string,
   *               title:string, admin:boolean, navKey:(string|undefined),
   *               tournament:(boolean|undefined)}>}
   */
  PAGES: [
    {
      path: '/register/:tournamentId',
      global: 'RegisterPage',
      file: 'js/pages/register.js',
      routeKey: 'register',
      title: 'Player registration',
      admin: false
    },
    {
      path: '/admin/login',
      global: 'AdminLoginPage',
      file: 'js/pages/admin-login.js',
      routeKey: 'admin-login',
      title: 'Admin sign in',
      admin: false            // the login screen itself must stay reachable
    },
    {
      path: '/admin/dashboard',
      global: 'AdminTournamentPage',
      file: 'js/pages/admin-tournament.js',
      routeKey: 'admin-dashboard',
      title: 'Tournaments',
      admin: true,
      navKey: 'dashboard'
      // Not tournament-scoped: this IS the screen where one gets chosen.
    },
    {
      path: '/admin/payments',
      global: 'AdminPaymentsPage',
      file: 'js/pages/admin-payments.js',
      routeKey: 'admin-payments',
      title: 'Payment verification',
      admin: true,
      navKey: 'payments',
      tournament: true
    },
    {
      path: '/admin/players',
      global: 'AdminPlayersPage',
      file: 'js/pages/admin-players.js',
      routeKey: 'admin-players',
      title: 'Players',
      admin: true,
      navKey: 'players',
      tournament: true
    },

    /* ---- Phase 6 / 7: reports and the audit trail ---- */
    {
      path: '/admin/reports',
      global: 'AdminReportsPage',
      file: 'js/pages/admin-reports.js',
      routeKey: 'admin-reports',
      title: 'Reports',
      admin: true,
      navKey: 'reports',
      tournament: true
    },
    {
      path: '/admin/audit',
      global: 'AdminAuditPage',
      file: 'js/pages/admin-audit.js',
      routeKey: 'admin-audit',
      title: 'Audit log',
      admin: true,
      navKey: 'audit',
      tournament: true
    },

    /* ---- Phase 3: organisers ---- */
    {
      path: '/admin/organisers',
      global: 'AdminOrganisersPage',
      file: 'js/pages/admin-organisers.js',
      routeKey: 'admin-organisers',
      title: 'Organisers',
      admin: true,
      navKey: 'organisers',
      tournament: true
    },
    {
      path: '/organiser/login',
      global: 'AdminLoginPage',
      file: 'js/pages/admin-login.js',
      routeKey: 'admin-login',
      title: 'Organiser sign in',
      admin: false
      // The same form as /admin/login. An organiser who has set their password
      // needs a URL that makes sense to them; sending them to a path called
      // "admin" reads like they are in the wrong place. auth.login decides the
      // role, and AdminLoginPage._home sends them to the right screen.
    },
    {
      path: '/organiser/join',
      global: 'OrganiserJoinPage',
      file: 'js/pages/organiser-join.js',
      routeKey: 'organiser-join',
      title: 'Set your password',
      admin: false
      // Deliberately not admin-guarded: the organiser has no account yet. The
      // one-time token in ?k= is the credential. Bouncing them to a sign-in
      // form they cannot use would be a dead end.
    },
    {
      path: '/organiser/dashboard',
      global: 'OrganiserDashboardPage',
      file: 'js/pages/organiser-dashboard.js',
      routeKey: 'organiser-dashboard',
      title: 'Teams',
      admin: true
      // No `tournament` guard: an organiser is bound to exactly one tournament,
      // and the page resolves it itself (?t=, the join page's copy, then
      // auth.me). Forcing the admin picker on them would be wrong.
    },

    /* ---- Phase 4: the live auction console ---- */
    {
      path: '/organiser/auction',
      global: 'OrganiserAuctionPage',
      file: 'js/pages/organiser-auction.js',
      routeKey: 'organiser-auction',
      title: 'Auction console',
      admin: true
      // Same reasoning as the organiser dashboard.
    },

    /* ---- Phase 5: the projector ---- */
    {
      path: '/auction/:tournamentId/display',
      global: 'DisplayPage',
      file: 'js/pages/display.js',
      routeKey: 'display',
      title: 'Auction display',
      admin: false
      // Public by design. Its credential is the tournament's display_token in
      // ?k=, because this runs unattended on a venue laptop with nobody signed
      // in. Read-only: it offers no controls and carries no personal data.
    }
  ],

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  /**
   * Entry point. Called on DOMContentLoaded.
   * @return {void}
   */
  init: function () {
    App.root = document.getElementById('app');

    App.restoreDeepLink();
    App.registerRoutes();

    if (!CONFIG.isConfigured()) {
      // Loud, early, unmissable. Everything else would fail with a confusing
      // network error instead.
      App.renderSetupWarning();
    }

    Router.start();
  },

  /**
   * Undo the bounce performed by 404.html.
   *
   * 404.html sent us to  BASE_PATH + '/?ca_redirect=<encoded app path>'.
   * Put the intended URL back in the address bar with replaceState — replace,
   * not push, so the Back button does not land the user on the bounce URL.
   * Runs BEFORE Router.start(), because the router reads location.pathname.
   *
   * @return {void}
   */
  restoreDeepLink: function () {
    const query = Router.currentQuery();
    const wanted = query[CONFIG.REDIRECT_PARAM];
    if (!wanted) return;

    // Only ever accept a same-site path. A value like '//evil.com/x' or
    // 'https://evil.com' would otherwise become an open redirect.
    if (wanted.charAt(0) !== '/' || wanted.charAt(1) === '/') return;

    window.history.replaceState(null, '', Router.href(wanted));
  },

  /**
   * Build the route table. Page routes come from App.PAGES; the phases that
   * have not been built yet get a placeholder that names the phase.
   * @return {void}
   */
  registerRoutes: function () {
    Router.add('/', App.renderLanding);

    App.PAGES.forEach(function (spec) {
      Router.add(spec.path, App.pageHandler(spec));
    });

    Router
      .add('/organiser/dashboard', function (ctx) {
        App.renderPlaceholder('Organiser dashboard', 'organiser-dashboard', ctx,
          'Not built yet. Phase 3 puts teams, purses and squad limits here.');
      })

      .add('/organiser/auction', function (ctx) {
        App.renderPlaceholder('Auction console', 'organiser-auction', ctx,
          'Not built yet. Phase 4 puts the call, sell and unsold controls here.');
      })

      .add('/auction/:tournamentId/display', function (ctx) {
        App.renderPlaceholder('Projector display', 'display', ctx,
          'Not built yet. Phase 5 puts the full-screen projector view here.');
      })

      .notFound(function (ctx) {
        App.renderPlaceholder('Page not found', 'not-found', ctx,
          'No page matches this address. Check the link and try again.');
      });
  },

  /* ------------------------------------------------------------------ *
   * Page dispatch
   * ------------------------------------------------------------------ */

  /**
   * Wrap one page module in everything that must happen around it:
   * the auth guard, <body data-route>, the document title, the tournament
   * guard, the missing-module guard, a render-time try/catch, and the
   * shared admin nav.
   *
   * None of these guards is a security control — the server authorises every
   * call on its own (CONTRACTS.md §11). They exist so the app fails in a way
   * a human at a venue can read and act on.
   *
   * @param {{path:string, global:string, file:string, routeKey:string,
   *          title:string, admin:boolean, navKey:(string|undefined),
   *          tournament:(boolean|undefined)}} spec
   * @return {function(Object): void} a router handler
   */
  pageHandler: function (spec) {
    return function (ctx) {
      if (spec.admin && !App.requireAdmin(ctx)) return;   // redirected away

      App.beginRoute(spec.routeKey, spec.title);

      // Captured AFTER beginRoute bumped it. If the page navigates away
      // mid-render (an expired session, say), the sequence moves on and we
      // must not paint this route's nav over the new screen.
      const seq = App._routeSeq;

      if (spec.navKey) {
        App._navContext = { activeKey: spec.navKey, ctx: ctx };

        // A scoped screen always needs a tournament; any admin screen needs
        // one when the admin has just asked to change it.
        if ((spec.tournament || App._forcePick) &&
            !App.applyTournamentGuard(spec, ctx)) {
          if (App._routeSeq === seq) App.syncChromeNav();
          return;
        }
      } else {
        // Landing on a screen with no nav ends any pending re-pick, so it
        // cannot ambush the next admin screen the user opens.
        App._forcePick = false;
      }

      const page = App.resolvePage(spec.global);
      if (!page || typeof page.render !== 'function') {
        // The script tag 404'd, or the file threw while loading, so its
        // global was never defined. Say so, in plain words, with the file
        // name — a blank white page at a venue is undiagnosable.
        App.renderModuleError(spec, null);
        if (App._routeSeq === seq) App.syncChromeNav();
        return;
      }

      try {
        page.render(ctx);
      } catch (err) {
        console.error('App: ' + spec.global + '.render threw', err);
        App.renderModuleError(spec, err);
      }

      if (App._routeSeq === seq) App.syncChromeNav();
    };
  },

  /**
   * Find a page module by name, without ever throwing.
   *
   * WHY THIS IS A SWITCH AND NOT window[name].
   * The page files declare their module the same way the Phase 0 files do:
   *
   *     const RegisterPage = { render: function (ctx) { ... } };
   *
   * A top-level `const` (or `let`, or `class`) creates a global BINDING but
   * NOT a property of `window` — that is only true of `var` and of a bare
   * assignment. So `window.RegisterPage` is undefined even when the script
   * loaded perfectly, and a window-only lookup would send every route to
   * the "could not be opened" panel. Naming the identifier directly is what
   * actually resolves the binding.
   *
   * `typeof X` is safe on an identifier that was never declared at all — it
   * returns 'undefined' instead of throwing — which is exactly the case
   * when the script 404s. The try/catch covers the remaining corner: a
   * temporal-dead-zone ReferenceError if load order were ever broken.
   *
   * The `window` fallback keeps working for a module written with `var` or
   * assigned onto window instead.
   *
   * @param {string} name  global identifier, e.g. 'RegisterPage'
   * @return {Object|null}
   */
  resolvePage: function (name) {
    try {
      switch (name) {
        case 'RegisterPage':
          if (typeof RegisterPage !== 'undefined') return RegisterPage;
          break;
        case 'AdminLoginPage':
          if (typeof AdminLoginPage !== 'undefined') return AdminLoginPage;
          break;
        case 'AdminTournamentPage':
          if (typeof AdminTournamentPage !== 'undefined') return AdminTournamentPage;
          break;
        case 'AdminPaymentsPage':
          if (typeof AdminPaymentsPage !== 'undefined') return AdminPaymentsPage;
          break;
        case 'AdminPlayersPage':
          if (typeof AdminPlayersPage !== 'undefined') return AdminPlayersPage;
          break;
        case 'AdminReportsPage':
          if (typeof AdminReportsPage !== 'undefined') return AdminReportsPage;
          break;
        case 'AdminAuditPage':
          if (typeof AdminAuditPage !== 'undefined') return AdminAuditPage;
          break;
        case 'AdminOrganisersPage':
          if (typeof AdminOrganisersPage !== 'undefined') return AdminOrganisersPage;
          break;
        case 'OrganiserJoinPage':
          if (typeof OrganiserJoinPage !== 'undefined') return OrganiserJoinPage;
          break;
        case 'OrganiserDashboardPage':
          if (typeof OrganiserDashboardPage !== 'undefined') return OrganiserDashboardPage;
          break;
        case 'OrganiserAuctionPage':
          if (typeof OrganiserAuctionPage !== 'undefined') return OrganiserAuctionPage;
          break;
        case 'DisplayPage':
          if (typeof DisplayPage !== 'undefined') return DisplayPage;
          break;
        default:
          break;
      }
    } catch (e) {
      console.error('App.resolvePage: ' + name + ' is not usable', e);
    }

    try {
      return window[name] || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Auth guard for /admin/* routes.
   *
   * A missing token means the user cannot possibly succeed, so send them
   * straight to the login screen rather than letting every call on the page
   * fail with UNAUTHORIZED. A present token is NOT proof of anything: it may
   * be expired or revoked. The server decides; this only saves a round trip.
   *
   * replace:true so the Back button does not bounce them into the guarded
   * page again and straight back out.
   *
   * @param {Object} ctx  router context
   * @return {boolean} true when the route may render
   */
  requireAdmin: function (ctx) {
    if (API.getToken()) return true;

    App.intendedPath = ctx && ctx.path ? ctx.path : null;
    Router.navigate('/admin/login', { replace: true });
    return false;
  },

  /**
   * Common start-of-render work: scope the CSS, set the tab title, and reset
   * the admin-nav bookkeeping for the screen about to be painted.
   * Page modules may overwrite the route key or the title afterwards.
   *
   * @param {string} routeKey  value written to <body data-route>
   * @param {string} title     human name of the screen
   * @return {void}
   */
  beginRoute: function (routeKey, title) {
    App._routeSeq++;
    App._navClaimed = false;
    App._navContext = null;
    App.removeChromeNav();

    document.body.setAttribute('data-route', routeKey);
    document.title = title + ' · Cricket Auction';
  },

  /**
   * Empty #app and mount one element. The single place that clears the root,
   * so there is one place to look when something renders twice.
   *
   * @param {HTMLElement} el
   * @return {void}
   */
  mount: function (el) {
    if (!App.root) App.root = document.getElementById('app');
    App.root.textContent = '';
    App.root.appendChild(el);
  },

  /* ------------------------------------------------------------------ *
   * The selected tournament (CONTRACTS-PHASE2.md §6.3)
   *
   * Every Phase 2 action is scoped to one tournament. An admin who verifies
   * payments against the wrong tournament corrupts two tournaments at once,
   * gets no error, and cannot tell afterwards. So the selection is:
   *   - kept in the URL, where it is visible, bookmarkable and shareable;
   *   - shown at the top of every admin screen, in words, not just an id;
   *   - required before a scoped screen will render anything at all.
   * ------------------------------------------------------------------ */

  /** Names learned from tournament.list, keyed by id. @type {Object|null} */
  _tournamentIndex: null,

  /** In-flight tournament.list, so five callers make one request. */
  _tournamentPromise: null,

  /** Loop breaker for the localStorage restore. @type {string} */
  _lastRestore: '',

  /**
   * Set by App.changeTournament: show the picker on the next render even on
   * a route that would otherwise be happy without a selection.
   * @type {boolean}
   */
  _forcePick: false,

  /**
   * The tournament this screen is working on.
   *
   * Reads the URL and nothing else. localStorage is deliberately NOT
   * consulted here: if it were, a stale copy could quietly win over what the
   * address bar says, which is the exact confusion this whole mechanism
   * exists to prevent.
   *
   * @param {Object} [ctx]  router context; omit to read the live URL
   * @return {string} a tournament id, or '' when none is selected
   */
  currentTournamentId: function (ctx) {
    const query = (ctx && ctx.query) ? ctx.query : Router.currentQuery();
    return App._safeTournamentId(query[App.TOURNAMENT_PARAM]);
  },

  /**
   * Add ?t=<id> to an app path. Use this for every internal admin link, or
   * the selection is dropped on the first click.
   *
   * @param {string} path  app path, e.g. '/admin/players'
   * @param {string} [tournamentId]  omit to use the current selection
   * @return {string}
   */
  adminPath: function (path, tournamentId) {
    const id = App._safeTournamentId(
      tournamentId === undefined ? App.currentTournamentId() : tournamentId
    );
    if (!id) return path;
    const sep = path.indexOf('?') === -1 ? '?' : '&';
    return path + sep + App.TOURNAMENT_PARAM + '=' + encodeURIComponent(id);
  },

  /**
   * Remember a selection for the next visit. Convenience only — nothing
   * reads this in preference to the URL.
   *
   * If the id changes and no name comes with it, the cached name is thrown
   * away rather than left behind. A stale name is worse than no name: the
   * nav would confidently label the new tournament with the old one's name,
   * which is the exact wrong-tournament mistake the nav exists to prevent.
   *
   * @param {string} id
   * @param {string} [name]
   * @return {void}
   */
  setTournament: function (id, name) {
    const safe = App._safeTournamentId(id);
    if (!safe) return;
    try {
      const previous = window.localStorage.getItem(App.TOURNAMENT_KEY);
      window.localStorage.setItem(App.TOURNAMENT_KEY, safe);

      if (name) {
        window.localStorage.setItem(App.TOURNAMENT_NAME_KEY, String(name));
      } else if (previous !== safe) {
        window.localStorage.removeItem(App.TOURNAMENT_NAME_KEY);
      }
    } catch (e) {
      // Private browsing refuses writes. Losing the convenience copy is fine;
      // the URL still carries the selection.
    }
  },

  /**
   * @return {string} the remembered id, or ''
   */
  rememberedTournamentId: function () {
    try {
      return App._safeTournamentId(window.localStorage.getItem(App.TOURNAMENT_KEY));
    } catch (e) {
      return '';
    }
  },

  /** @return {void} */
  forgetTournament: function () {
    try {
      window.localStorage.removeItem(App.TOURNAMENT_KEY);
      window.localStorage.removeItem(App.TOURNAMENT_NAME_KEY);
    } catch (e) {
      /* nothing useful to do */
    }
  },

  /**
   * The human name of a tournament, if it is already known locally.
   * Never fetches — the nav does that asynchronously and fills itself in.
   *
   * @param {string} id
   * @return {string} the name, or '' when it is not known yet
   */
  tournamentName: function (id) {
    const safe = App._safeTournamentId(id);
    if (!safe) return '';

    if (App._tournamentIndex && App._tournamentIndex[safe]) {
      return String(App._tournamentIndex[safe].name || '');
    }
    try {
      if (window.localStorage.getItem(App.TOURNAMENT_KEY) === safe) {
        return String(window.localStorage.getItem(App.TOURNAMENT_NAME_KEY) || '');
      }
    } catch (e) {
      /* fall through */
    }
    return '';
  },

  /**
   * One tournament.list call, shared by the nav and the picker.
   * @return {!Promise<!Object>} id -> tournament row
   */
  loadTournamentIndex: function () {
    if (App._tournamentIndex) return Promise.resolve(App._tournamentIndex);
    if (App._tournamentPromise) return App._tournamentPromise;

    if (typeof API === 'undefined' || !API || typeof API.call !== 'function') {
      return Promise.reject({ code: 'NO_API', message: 'js/api.js did not load.' });
    }
    if (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.isConfigured &&
        !CONFIG.isConfigured()) {
      return Promise.reject({
        code: 'NOT_CONFIGURED',
        message: 'API_BASE_URL is not set in frontend/js/config.js.'
      });
    }

    App._tournamentPromise = API.call('tournament.list', {}).then(function (rows) {
      const index = {};
      (rows || []).forEach(function (row) {
        if (row && row.tournament_id) index[String(row.tournament_id)] = row;
      });
      App._tournamentIndex = index;
      App._tournamentPromise = null;
      return index;
    }, function (err) {
      App._tournamentPromise = null;
      throw err;
    });

    return App._tournamentPromise;
  },

  /**
   * Gate a tournament-scoped route.
   *
   * No selection in the URL, but one remembered from last time -> put it in
   * the URL (replace, so Back is not poisoned) and let the route re-resolve.
   * Nothing remembered, or the admin explicitly asked to change -> the
   * picker, which explains why.
   *
   * @param {{path:string, title:string, routeKey:string}} spec
   * @param {Object} ctx
   * @return {boolean} true when the page may render
   */
  applyTournamentGuard: function (spec, ctx) {
    const chosen = App.currentTournamentId(ctx);

    if (chosen) {
      App._forcePick = false;
      App._lastRestore = '';
      App.setTournament(chosen);
      return true;
    }

    if (!App._forcePick) {
      const remembered = App.rememberedTournamentId();
      const stamp = spec.path + '|' + remembered;

      // The guard against a redirect loop: if putting the remembered id in
      // the URL did not produce a URL with the id in it (a broken history
      // API, a BASE_PATH mismatch), fall through to the picker instead of
      // bouncing forever.
      if (remembered && App._lastRestore !== stamp) {
        App._lastRestore = stamp;
        Router.navigate(App.adminPath(spec.path, remembered), { replace: true });
        return false;
      }
    }

    App._forcePick = false;
    App._lastRestore = '';
    App.renderTournamentPicker(spec, ctx);
    return false;
  },

  /**
   * "Change tournament". An action, not a link: it drops the selection and
   * reloads the screen you are on without ?t=, which is what makes the
   * picker appear. Doing it this way means the admin re-picks in the
   * context of the screen they are actually working on, instead of being
   * sent to another screen to hunt for a selector.
   *
   * @return {void}
   */
  changeTournament: function () {
    App.forgetTournament();
    App._lastRestore = '';
    // The dashboard is happy with no selection, so it needs telling.
    App._forcePick = true;
    Router.navigate(Router.currentPath());
  },

  /**
   * Sign out. Local first: clearing the token is what actually ends the
   * session for this browser, and it must happen even if the network is
   * gone. The server call is best effort, sent with the token we just threw
   * away so it can still be matched to a session.
   *
   * @return {void}
   */
  signOut: function () {
    let token = null;
    try {
      if (typeof API !== 'undefined' && API && API.getToken) token = API.getToken();
      if (typeof API !== 'undefined' && API && API.clearToken) API.clearToken();
    } catch (e) {
      /* keep going: the navigation below matters more */
    }

    // A different admin may sign in next. Leaving the previous one's
    // tournament selected is exactly the wrong-tournament trap.
    App.forgetTournament();
    App._tournamentIndex = null;
    App._tournamentPromise = null;
    App._forcePick = false;
    App.intendedPath = null;

    try {
      if (token && typeof API !== 'undefined' && API && typeof API.call === 'function') {
        API.call('auth.logout', {}, { token: token, retryBusy: false })
          .catch(function () { /* the session dies locally either way */ });
      }
    } catch (e) {
      /* best effort only */
    }

    Router.navigate(App.LOGIN_PATH, { replace: true });
  },

  /* ------------------------------------------------------------------ *
   * The shared admin nav
   * ------------------------------------------------------------------ */

  /** The nav app.js mounted itself, if any. @type {HTMLElement|null} */
  _chromeNav: null,

  /** True once a page module asked for its own nav this render. */
  _navClaimed: false,

  /** {activeKey, ctx} for the current admin route, or null. */
  _navContext: null,

  /** Bumped by beginRoute; identifies one painting of one screen. */
  _routeSeq: 0,

  /**
   * PUBLIC. Build the shared admin nav — see the signature block at the top
   * of this file.
   *
   * Calling this takes ownership: app.js removes the copy it mounted and
   * will not mount another for this screen, so the page decides where the
   * nav sits.
   *
   * @param {string} activeKey  'dashboard' | 'payments' | 'players'
   * @param {Object} [ctx]  router context; omit to read the live URL
   * @return {HTMLElement} a <nav>
   */
  adminNav: function (activeKey, ctx) {
    App._navClaimed = true;
    App.removeChromeNav();
    return App.buildAdminNav(activeKey, ctx);
  },

  /**
   * Mount the nav ourselves, above #app, when the page did not ask for one.
   *
   * This is what makes the nav unconditional. The two Phase 2 page modules
   * were written in parallel with this file and may never call App.adminNav;
   * the admin still gets the tournament indicator and the sign-out control.
   *
   * @return {void}
   */
  syncChromeNav: function () {
    if (App._navClaimed || !App._navContext) {
      App.removeChromeNav();
      return;
    }

    const nav = App.buildAdminNav(App._navContext.activeKey, App._navContext.ctx);
    nav.setAttribute('data-chrome-nav', 'true');

    App.removeChromeNav();
    App._chromeNav = nav;

    if (!App.root) App.root = document.getElementById('app');
    if (App.root && App.root.parentNode) {
      App.root.parentNode.insertBefore(nav, App.root);
    } else {
      document.body.appendChild(nav);
    }
  },

  /** @return {void} */
  removeChromeNav: function () {
    const nav = App._chromeNav;
    App._chromeNav = null;
    if (!nav) return;
    try {
      if (nav.parentNode) nav.parentNode.removeChild(nav);
    } catch (e) {
      /* already gone */
    }
  },

  /**
   * The nav itself. Order on screen is the order of importance: the selected
   * tournament, then the three screens, then sign out.
   *
   * @param {string} activeKey
   * @param {Object} [ctx]
   * @return {HTMLElement}
   */
  buildAdminNav: function (activeKey, ctx) {
    const id = App.currentTournamentId(ctx);

    const nav = document.createElement('nav');
    nav.className = 'admin-nav';
    nav.setAttribute('aria-label', 'Admin sections');

    const bar = document.createElement('div');
    bar.className = 'admin-nav__bar';

    bar.appendChild(App._navScope(nav, id));
    bar.appendChild(App._navLinks(activeKey, id));

    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'btn btn--small btn--secondary admin-nav__signout';
    out.textContent = 'Sign out';
    out.addEventListener('click', function () { App.signOut(); });
    bar.appendChild(out);

    nav.appendChild(bar);
    return nav;
  },

  /**
   * The tournament indicator. The single most important thing the nav does,
   * so it is first in the DOM, first for a screen reader, and visually the
   * loudest element on the bar.
   *
   * @param {HTMLElement} nav  the nav being built, for the async warning
   * @param {string} id        selected tournament id, possibly ''
   * @return {HTMLElement}
   */
  _navScope: function (nav, id) {
    const scope = document.createElement('div');
    scope.className = 'admin-nav__scope' + (id ? '' : ' admin-nav__scope--none');

    const label = document.createElement('span');
    label.className = 'admin-nav__scope-label';
    // A glyph as well as the colour, matching the rest of the app
    // (DESIGN.md §8): the warning state must not depend on the tint alone.
    const mark = document.createElement('span');
    mark.className = 'admin-nav__scope-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = id ? '●' : '⚠';
    label.appendChild(mark);
    label.appendChild(document.createTextNode(
      id ? 'Working on' : 'No tournament selected'
    ));
    scope.appendChild(label);

    const name = document.createElement('strong');
    name.className = 'admin-nav__scope-name';
    name.textContent = id
      ? (App.tournamentName(id) || 'Loading name…')
      : 'Choose one before verifying anything.';
    scope.appendChild(name);

    if (id) {
      const idEl = document.createElement('span');
      idEl.className = 'code code--inline admin-nav__scope-id';
      idEl.textContent = id;
      scope.appendChild(idEl);
    }

    // A button, not a link: changing tournament is an action (it drops the
    // current selection), and a link would have to point at a screen that
    // has no selector on it.
    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'btn btn--small btn--secondary admin-nav__change';
    change.textContent = id ? 'Change tournament' : 'Choose a tournament';
    change.addEventListener('click', function () { App.changeTournament(); });
    scope.appendChild(change);

    if (id && !App.tournamentName(id)) App._resolveNavName(nav, scope, name, id);

    return scope;
  },

  /**
   * Turn the id in the URL into a name the admin can recognise, and say so
   * loudly when it turns out not to be a tournament they can see — an id
   * typed or pasted wrong is otherwise indistinguishable from a real one.
   *
   * @param {HTMLElement} nav
   * @param {HTMLElement} scope
   * @param {HTMLElement} nameEl
   * @param {string} id
   * @return {void}
   */
  _resolveNavName: function (nav, scope, nameEl, id) {
    App.loadTournamentIndex().then(function (index) {
      const row = index[id];
      if (row && row.name) {
        nameEl.textContent = String(row.name);
        App.setTournament(id, row.name);
        return;
      }

      scope.className = 'admin-nav__scope admin-nav__scope--unknown';
      nameEl.textContent = 'Not one of your tournaments';

      const warn = document.createElement('p');
      warn.className = 'admin-nav__warning';
      warn.setAttribute('role', 'alert');
      warn.textContent = 'The address asks for tournament ' + id +
        ', which is not in your list. Nothing on this screen belongs to it. ' +
        'Choose a tournament again before you change anything.';
      nav.appendChild(warn);
    }, function () {
      // Offline, or the backend is unreachable. The id is still correct and
      // still shown; only the friendly name is missing, and pretending
      // otherwise would be worse than admitting it.
      nameEl.textContent = 'Name unavailable — check the id below';
    });
  },

  /**
   * @param {string} activeKey
   * @param {string} id
   * @return {HTMLElement}
   */
  _navLinks: function (activeKey, id) {
    const list = document.createElement('ul');
    list.className = 'admin-nav__list';

    App.NAV_ITEMS.forEach(function (item) {
      const li = document.createElement('li');
      li.className = 'admin-nav__item';

      const a = document.createElement('a');
      const isActive = item.key === activeKey;
      a.className = 'admin-nav__link' + (isActive ? ' admin-nav__link--active' : '');
      // Carry the selection through every hop. This is the whole reason the
      // tournament survives moving between the three screens.
      a.href = Router.href(App.adminPath(item.path, id));
      a.textContent = item.label;
      if (isActive) a.setAttribute('aria-current', 'page');

      li.appendChild(a);
      list.appendChild(li);
    });

    return list;
  },

  /**
   * No tournament selected on a screen that cannot work without one.
   *
   * An empty payments table would look like "there is nothing to verify",
   * which at a venue is a dangerous thing to believe. So: say what is
   * missing, say why it matters, and offer the choice right here rather than
   * sending the admin off to another screen to find it.
   *
   * @param {{path:string, title:string}} spec
   * @param {Object} ctx
   * @return {void}
   */
  renderTournamentPicker: function (spec, ctx) {
    const main = document.createElement('main');
    main.className = 'panel panel--wide';

    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = 'Choose a tournament first';
    main.appendChild(h1);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent = spec.title + ' works on one tournament at a time, and ' +
      'the address you opened does not name one. Nothing is loaded yet — an ' +
      'empty list here would look like "nothing to do", and verifying a ' +
      'payment against the wrong tournament cannot be undone.';
    main.appendChild(note);

    const box = document.createElement('div');
    box.className = 'admin-picker';
    box.appendChild(App._pickerLoading());
    main.appendChild(box);

    App.mount(main);

    const seq = App._routeSeq;
    App.loadTournamentIndex().then(function (index) {
      if (App._routeSeq !== seq) return;      // navigated away while loading
      box.textContent = '';
      box.appendChild(App._pickerList(spec, index));
    }, function (err) {
      if (App._routeSeq !== seq) return;
      box.textContent = '';
      box.appendChild(App._pickerError(err));
    });
  },

  /** @return {HTMLElement} */
  _pickerLoading: function () {
    const p = document.createElement('p');
    p.className = 'empty';
    p.setAttribute('role', 'status');
    p.textContent = 'Loading your tournaments…';
    return p;
  },

  /**
   * @param {{path:string}} spec
   * @param {!Object} index
   * @return {HTMLElement}
   */
  _pickerList: function (spec, index) {
    const ids = Object.keys(index);

    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const p = document.createElement('p');
      p.textContent = 'There are no tournaments yet. Create one first.';
      empty.appendChild(p);
      empty.appendChild(App.link(App.DASHBOARD_PATH + '?view=create',
        'Create a tournament', 'btn'));
      return empty;
    }

    const list = document.createElement('ul');
    list.className = 'admin-picker__list';

    ids.forEach(function (id) {
      const row = index[id] || {};

      const li = document.createElement('li');
      li.className = 'admin-picker__item';

      // An anchor, not a button: the router turns it into pushState, and it
      // still works with middle-click and "open in new tab".
      const a = document.createElement('a');
      a.className = 'admin-picker__link';
      a.href = Router.href(App.adminPath(spec.path, id));

      const name = document.createElement('span');
      name.className = 'admin-picker__name';
      name.textContent = String(row.name || id);
      a.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'admin-picker__meta';
      meta.textContent = App._pickerMeta(row, id);
      a.appendChild(meta);

      li.appendChild(a);
      list.appendChild(li);
    });

    return list;
  },

  /**
   * One line of "which tournament is this" detail. Enough to tell two
   * similarly named tournaments apart without opening either.
   *
   * @param {!Object} row  a tournament.list row
   * @param {string} id
   * @return {string}
   */
  _pickerMeta: function (row, id) {
    const bits = [];
    if (row.status) bits.push(String(row.status).replace(/_/g, ' ').toLowerCase());
    if (row.player_count !== undefined && row.player_count !== null) {
      bits.push(String(row.player_count) + ' registered');
    }
    if (row.verified_count !== undefined && row.verified_count !== null) {
      bits.push(String(row.verified_count) + ' verified');
    }
    bits.push(id);
    return bits.join(' · ');
  },

  /**
   * @param {*} err
   * @return {HTMLElement}
   */
  _pickerError: function (err) {
    const wrap = document.createElement('div');

    const box = document.createElement('p');
    box.className = 'form-error';
    box.setAttribute('role', 'alert');
    box.textContent = 'The tournament list could not be loaded. ' + App._errText(err);
    wrap.appendChild(box);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = 'Try again';
    retry.addEventListener('click', function () { Router.resolve(); });
    wrap.appendChild(retry);

    wrap.appendChild(App.link(App.DASHBOARD_PATH, 'Go to tournaments',
      'btn btn--secondary'));

    return wrap;
  },

  /**
   * Accept only the shape a tournament id can actually have, so nothing odd
   * ever reaches a URL we build or a localStorage key we trust.
   * Ids look like 'TRN_k3m9x1qz7f2a' (DESIGN.md §5).
   *
   * @param {*} value
   * @return {string} the id, or '' when it is missing or malformed
   */
  _safeTournamentId: function (value) {
    if (value === null || value === undefined) return '';
    const s = String(value).trim();
    return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : '';
  },

  /* ------------------------------------------------------------------ *
   * Screens owned by this file
   * ------------------------------------------------------------------ */

  /**
   * The landing panel at '/'.
   *
   * This is the only page that links anywhere else. Players never arrive
   * here — they arrive on a /register/<id> link — so the only link offered
   * is the admin sign-in. The Phase 0 route index that listed every admin
   * and organiser URL has been removed: it advertised the admin surface to
   * anyone who opened the site.
   *
   * @param {Object} ctx  router context
   * @return {void}
   */
  renderLanding: function (ctx) {
    App.beginRoute('home', 'Cricket Auction');

    const main = document.createElement('main');
    main.className = 'panel';

    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = 'Cricket Auction';
    main.appendChild(h1);

    const note = document.createElement('p');
    note.className = 'panel__note';
    note.textContent = 'To register as a player, open the registration link ' +
      'the organisers shared for your tournament. There is nothing to sign up ' +
      'for here.';
    main.appendChild(note);

    const nav = document.createElement('nav');
    nav.className = 'route-nav';
    nav.setAttribute('aria-label', 'Site sections');

    const ul = document.createElement('ul');
    ul.className = 'route-nav__list';

    const li = document.createElement('li');
    li.appendChild(App.link('/admin/login', 'Admin sign in', 'route-nav__link'));
    ul.appendChild(li);

    nav.appendChild(ul);
    main.appendChild(nav);

    App.mount(main);
  },

  /**
   * Render one placeholder panel for a route whose real screen is not built
   * yet, and for the 404 fallback.
   *
   * No route index here. Only the path is echoed back, because on a 404 the
   * user needs to see what they actually typed or what the link contained.
   *
   * @param {string} title     human name of the route
   * @param {string} routeKey  value written to <body data-route>, which is
   *                           what scopes the projector theme in app.css
   * @param {Object} ctx       router context {path, params, query, pattern}
   * @param {string} [note]    one-line explanation
   * @return {void}
   */
  renderPlaceholder: function (title, routeKey, ctx, note) {
    App.beginRoute(routeKey, title);

    const main = document.createElement('main');
    main.className = 'panel';

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

    main.appendChild(App._definitionList([
      ['Address', (ctx && ctx.path) || '(unknown)']
    ]));

    main.appendChild(App.link('/', 'Go to the home page', 'btn btn--secondary'));

    App.mount(main);
  },

  /**
   * A page module is missing or blew up while rendering.
   *
   * The failure mode this prevents: a <script> that 404s leaves its global
   * undefined, the route handler throws ReferenceError, nothing is painted,
   * and the venue sees a white screen with no clue what to do. This panel
   * names the file, offers a reload, and offers a way home.
   *
   * @param {{global:string, file:string, title:string}} spec
   * @param {*} [err]  the caught error, when the module loaded but threw
   * @return {void}
   */
  renderModuleError: function (spec, err) {
    const main = document.createElement('main');
    main.className = 'panel';

    const h1 = document.createElement('h1');
    h1.className = 'panel__title';
    h1.textContent = 'This screen could not be opened';
    main.appendChild(h1);

    const p = document.createElement('p');
    p.className = 'panel__note';
    p.textContent = err
      ? 'The ' + spec.title + ' screen hit an unexpected error while loading. ' +
        'Reloading the page usually clears it.'
      : 'The ' + spec.title + ' screen did not load. This normally means a ' +
        'file is missing from the site, or the connection dropped part-way ' +
        'through loading it. Reload the page to try again.';
    main.appendChild(p);

    const box = document.createElement('p');
    box.className = 'form-error';
    box.setAttribute('role', 'alert');
    box.textContent = err
      ? spec.file + ' — ' + App._errText(err)
      : spec.file + ' — ' + spec.global + ' was not defined';
    main.appendChild(box);

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'btn';
    reload.textContent = 'Reload the page';
    reload.addEventListener('click', function () { window.location.reload(); });
    main.appendChild(reload);

    main.appendChild(App.link('/', 'Go to the home page', 'btn btn--secondary'));

    App.mount(main);
  },

  /**
   * Warn that config.js has not been filled in. Rendered once, above the
   * router output, and left in place.
   * @return {void}
   */
  renderSetupWarning: function () {
    const box = document.createElement('div');
    box.className = 'banner banner--error';
    box.setAttribute('role', 'alert');

    // Glyph as well as colour, matching UI.banner (DESIGN.md §51). It is
    // decorative, so it is hidden from screen readers; the words below say
    // the same thing.
    const mark = document.createElement('span');
    mark.className = 'banner__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '⚠';
    box.appendChild(mark);

    const strong = document.createElement('strong');
    strong.textContent = 'Setup needed. ';
    box.appendChild(strong);

    box.appendChild(document.createTextNode(
      'Open frontend/js/config.js and set API_BASE_URL to your Apps Script /exec URL. ' +
      'Until then no data can load.'
    ));

    document.body.insertBefore(box, document.body.firstChild);
  },

  /* ---------------------------------------------------------------- *
   * Small DOM helpers. textContent everywhere, never innerHTML, so a
   * tournament id in the URL can never inject markup.
   * ---------------------------------------------------------------- */

  /**
   * An internal link with BASE_PATH applied once, in one place.
   *
   * @param {string} to         app path, e.g. '/admin/login'
   * @param {string} label      visible text
   * @param {string} [cssClass] class attribute
   * @return {HTMLAnchorElement}
   */
  link: function (to, label, cssClass) {
    const a = document.createElement('a');
    a.href = Router.href(to);
    a.textContent = label;
    if (cssClass) a.className = cssClass;
    return a;
  },

  /**
   * @param {Array<Array<string>>} rows  [label, value] pairs
   * @return {HTMLElement}
   */
  _definitionList: function (rows) {
    const dl = document.createElement('dl');
    dl.className = 'kv';
    rows.forEach(function (row) {
      const dt = document.createElement('dt');
      dt.textContent = row[0];
      const dd = document.createElement('dd');
      dd.textContent = String(row[1]);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    return dl;
  },

  /**
   * @param {string} text
   * @return {HTMLElement}
   */
  _sectionHeading: function (text) {
    const h = document.createElement('h2');
    h.className = 'panel__subtitle';
    h.textContent = text;
    return h;
  },

  /**
   * Turn anything throwable into one short line of text.
   * @param {*} err
   * @return {string}
   */
  _errText: function (err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    if (err.code) return String(err.code);
    try {
      return String(err);
    } catch (e) {
      return 'unknown error';
    }
  }
};

document.addEventListener('DOMContentLoaded', App.init);
