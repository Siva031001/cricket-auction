/**
 * app.js — bootstrap for the SPA shell.
 *
 * PHASE 0 SCOPE, and nothing beyond it (CONTRACTS.md §15, §16):
 *   - restore the deep link that 404.html parked in the query string
 *   - register every route with a placeholder panel
 *   - start the router
 *
 * The real screens land later:
 *   Phase 1  /register/:tournamentId          player registration
 *   Phase 2  /admin/login, /admin/dashboard   payment verification
 *   Phase 3  /organiser/dashboard             teams and squads
 *   Phase 4  /organiser/auction               the auction console
 *   Phase 5  /auction/:tournamentId/display   projector view
 */

/* eslint-disable no-unused-vars */
const App = {

  /** @type {HTMLElement|null} */
  root: null,

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
   * Register every Phase 0 route. Each one renders a placeholder naming the
   * route and any parsed parameters, so the router is verifiable on its own.
   * @return {void}
   */
  registerRoutes: function () {
    Router
      .add('/', function (ctx) {
        App.renderPlaceholder('Home', 'home', ctx,
          'Phase 0 shell. Open a tournament link to register, or sign in as an admin.');
      })

      .add('/register/:tournamentId', function (ctx) {
        App.renderPlaceholder('Player registration', 'register', ctx,
          'Phase 1 will put the mobile-first registration form here.');
      })

      .add('/admin/login', function (ctx) {
        App.renderPlaceholder('Admin login', 'admin-login', ctx,
          'Phase 2 will put the email and password form here.');
      })

      .add('/admin/dashboard', function (ctx) {
        App.renderPlaceholder('Admin dashboard', 'admin-dashboard', ctx,
          'Phase 2 will put payment verification and tournament setup here.');
      })

      .add('/organiser/dashboard', function (ctx) {
        App.renderPlaceholder('Organiser dashboard', 'organiser-dashboard', ctx,
          'Phase 3 will put teams, purses and squad limits here.');
      })

      .add('/organiser/auction', function (ctx) {
        App.renderPlaceholder('Auction console', 'organiser-auction', ctx,
          'Phase 4 will put the call, sell and unsold controls here.');
      })

      .add('/auction/:tournamentId/display', function (ctx) {
        App.renderPlaceholder('Projector display', 'display', ctx,
          'Phase 5 will put the full-screen projector view here.');
      })

      .notFound(function (ctx) {
        App.renderPlaceholder('Page not found', 'not-found', ctx,
          'No route matches this address. Check the link and try again.');
      });
  },

  /**
   * Render one placeholder panel.
   *
   * @param {string} title       human name of the route
   * @param {string} routeKey    value written to <body data-route>, which is
   *                             what scopes the projector theme in app.css
   * @param {Object} ctx         router context {path, params, query, pattern}
   * @param {string} [note]      one-line explanation of what lands here later
   * @return {void}
   */
  renderPlaceholder: function (title, routeKey, ctx, note) {
    document.body.setAttribute('data-route', routeKey);
    document.title = title + ' · Cricket Auction';

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
      ['Route pattern', ctx.pattern || '(no match)'],
      ['Path', ctx.path]
    ]));

    const paramRows = Object.keys(ctx.params).map(function (k) {
      return [k, ctx.params[k]];
    });
    if (paramRows.length) {
      main.appendChild(App._sectionHeading('Route parameters'));
      main.appendChild(App._definitionList(paramRows));
    }

    const queryRows = Object.keys(ctx.query).map(function (k) {
      return [k, ctx.query[k]];
    });
    if (queryRows.length) {
      main.appendChild(App._sectionHeading('Query parameters'));
      main.appendChild(App._definitionList(queryRows));
    }

    main.appendChild(App._navList());

    App.root.textContent = '';
    App.root.appendChild(main);
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
   * Links to every stubbed route, so the router can be clicked through
   * without typing URLs. Temporary — Phase 1 onwards replaces this.
   * @return {HTMLElement}
   */
  _navList: function () {
    const routes = [
      ['/', 'Home'],
      ['/register/TRN_demo000001', 'Registration (sample id)'],
      ['/admin/login', 'Admin login'],
      ['/admin/dashboard', 'Admin dashboard'],
      ['/organiser/dashboard', 'Organiser dashboard'],
      ['/organiser/auction', 'Auction console'],
      ['/auction/TRN_demo000001/display', 'Projector display (sample id)'],
      ['/no/such/page', '404 fallback']
    ];

    const nav = document.createElement('nav');
    nav.className = 'route-nav';
    nav.setAttribute('aria-label', 'Phase 0 route index');

    const heading = document.createElement('h2');
    heading.className = 'panel__subtitle';
    heading.textContent = 'Routes';
    nav.appendChild(heading);

    const ul = document.createElement('ul');
    ul.className = 'route-nav__list';
    routes.forEach(function (r) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'route-nav__link';
      a.href = Router.href(r[0]);   // BASE_PATH added here, once
      a.textContent = r[1];
      li.appendChild(a);
      ul.appendChild(li);
    });
    nav.appendChild(ul);

    return nav;
  }
};

document.addEventListener('DOMContentLoaded', App.init);
