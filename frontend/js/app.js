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
 * Route map (CONTRACTS.md §15, CONTRACTS-PHASE1.md §4):
 *   /                              landing panel                     here
 *   /register/:tournamentId        RegisterPage         js/pages/register.js
 *   /admin/login                   AdminLoginPage       js/pages/admin-login.js
 *   /admin/dashboard               AdminTournamentPage  js/pages/admin-tournament.js
 *   /organiser/dashboard           Phase 3 placeholder
 *   /organiser/auction             Phase 4 placeholder
 *   /auction/:tournamentId/display Phase 5 placeholder
 *
 * Page module convention (CONTRACTS-PHASE1.md §4):
 *   const RegisterPage = { render: function (ctx) { ...fills App.root... } };
 * where ctx is the router context { path, params, query, pattern }.
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
   * @type {Array<{path:string, global:string, file:string, routeKey:string,
   *               title:string, admin:boolean}>}
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
      admin: true
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
   * the auth guard, <body data-route>, the document title, the
   * missing-module guard and a render-time try/catch.
   *
   * Neither guard is a security control — the server authorises every call
   * on its own (CONTRACTS.md §11). They exist so the app fails in a way a
   * human at a venue can read and act on.
   *
   * @param {{path:string, global:string, file:string, routeKey:string,
   *          title:string, admin:boolean}} spec
   * @return {function(Object): void} a router handler
   */
  pageHandler: function (spec) {
    return function (ctx) {
      if (spec.admin && !App.requireAdmin(ctx)) return;   // redirected away

      App.beginRoute(spec.routeKey, spec.title);

      const page = App.resolvePage(spec.global);
      if (!page || typeof page.render !== 'function') {
        // The script tag 404'd, or the file threw while loading, so its
        // global was never defined. Say so, in plain words, with the file
        // name — a blank white page at a venue is undiagnosable.
        App.renderModuleError(spec, null);
        return;
      }

      try {
        page.render(ctx);
      } catch (err) {
        console.error('App: ' + spec.global + '.render threw', err);
        App.renderModuleError(spec, err);
      }
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
   * Common start-of-render work: scope the CSS and set the tab title.
   * Page modules may overwrite either afterwards.
   *
   * @param {string} routeKey  value written to <body data-route>
   * @param {string} title     human name of the screen
   * @return {void}
   */
  beginRoute: function (routeKey, title) {
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
