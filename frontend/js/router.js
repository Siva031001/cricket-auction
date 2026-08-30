/**
 * router.js — path-based SPA router. No hashes.
 *
 * Real URLs, as DESIGN.md §1.1 requires:
 *     https://<user>.github.io/cricket-auction/register/TRN_k3m9x1qz7f2a
 * not
 *     https://<user>.github.io/cricket-auction/#/register/TRN_k3m9x1qz7f2a
 *
 * Two things make that possible on GitHub Pages, which has no server-side
 * rewrite rule:
 *   1. 404.html catches the deep link on a cold load and bounces it into
 *      index.html (see the comments in 404.html).
 *   2. This router owns navigation from then on, via history.pushState.
 *
 * Everything here works on the path with CONFIG.BASE_PATH already stripped,
 * so route patterns are written as if the app lived at the domain root.
 */

/* eslint-disable no-unused-vars */
const Router = {

  /** @type {Array<{pattern:string, keys:string[], re:RegExp, handler:Function}>} */
  _routes: [],

  /** @type {Function|null} */
  _notFound: null,

  /** @type {boolean} */
  _started: false,

  /* ---------------------------------------------------------------- *
   * Registration
   * ---------------------------------------------------------------- */

  /**
   * Register a route.
   *
   * Patterns are literal segments plus `:name` parameters, e.g.
   *   '/register/:tournamentId'
   *   '/auction/:tournamentId/display'
   *
   * @param {string} pattern
   * @param {function(Object): void} handler  called with a context object:
   *        { path, params, query, pattern }
   * @return {Object} Router, for chaining
   */
  add: function (pattern, handler) {
    const compiled = Router._compile(pattern);
    Router._routes.push({
      pattern: pattern,
      keys: compiled.keys,
      re: compiled.re,
      handler: handler
    });
    return Router;
  },

  /**
   * Register the fallback used when nothing matches.
   * @param {function(Object): void} handler
   * @return {Object} Router, for chaining
   */
  notFound: function (handler) {
    Router._notFound = handler;
    return Router;
  },

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Attach listeners and render the current URL. Call once, after all
   * routes are registered.
   * @return {void}
   */
  start: function () {
    if (Router._started) return;
    Router._started = true;

    // Back / forward buttons.
    window.addEventListener('popstate', function () {
      Router.resolve();
    });

    // Turn same-origin <a> clicks into pushState navigation.
    document.addEventListener('click', Router._onDocumentClick);

    Router.resolve();
  },

  /**
   * Navigate to an internal route.
   * @param {string} to  an app path such as '/admin/login' (no BASE_PATH)
   * @param {Object} [opts]  { replace: true } to swap the history entry
   *                         instead of pushing a new one
   * @return {void}
   */
  navigate: function (to, opts) {
    const options = opts || {};
    const url = Router.href(to);

    if (options.replace) {
      window.history.replaceState({}, '', url);
    } else {
      window.history.pushState({}, '', url);
    }
    Router.resolve();
  },

  /**
   * Turn an app path into a real browser URL by prefixing BASE_PATH.
   * Use this for every internal <a href> so links keep working on both a
   * project site (/cricket-auction/...) and a root site (/...).
   *
   * @param {string} to  e.g. '/admin/login'
   * @return {string}    e.g. '/cricket-auction/admin/login'
   */
  href: function (to) {
    const base = Router._base();
    const path = to.charAt(0) === '/' ? to : '/' + to;
    return (base + path) || '/';
  },

  /**
   * Match the current location and run the matching handler.
   * @return {void}
   */
  resolve: function () {
    const path = Router.currentPath();
    const query = Router.currentQuery();

    for (let i = 0; i < Router._routes.length; i++) {
      const route = Router._routes[i];
      const m = route.re.exec(path);
      if (!m) continue;

      const params = {};
      route.keys.forEach(function (key, idx) {
        // decodeURIComponent so an id with %20 etc. arrives readable.
        params[key] = Router._safeDecode(m[idx + 1]);
      });

      route.handler({
        path: path,
        params: params,
        query: query,
        pattern: route.pattern
      });
      return;
    }

    if (Router._notFound) {
      Router._notFound({ path: path, params: {}, query: query, pattern: null });
    }
  },

  /**
   * The current path with BASE_PATH removed and no trailing slash.
   * '/cricket-auction/admin/login' -> '/admin/login'
   * '/cricket-auction/'            -> '/'
   * @return {string}
   */
  currentPath: function () {
    return Router.stripBase(window.location.pathname);
  },

  /**
   * Remove BASE_PATH from a pathname and normalise it.
   * @param {string} pathname
   * @return {string} always starts with '/', never ends with '/' unless it is '/'
   */
  stripBase: function (pathname) {
    const base = Router._base();
    let p = pathname || '/';

    if (base && (p === base || p.indexOf(base + '/') === 0)) {
      p = p.slice(base.length);
    }
    if (p.charAt(0) !== '/') p = '/' + p;

    // Collapse duplicate slashes and drop a trailing one.
    p = p.replace(/\/{2,}/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');

    return p || '/';
  },

  /**
   * Current query string as a plain object.
   * @return {Object<string,string>}
   */
  currentQuery: function () {
    const out = {};
    const search = window.location.search;
    if (!search || search.length < 2) return out;

    search.slice(1).split('&').forEach(function (pair) {
      if (!pair) return;
      const eq = pair.indexOf('=');
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? '' : pair.slice(eq + 1);
      out[Router._safeDecode(k.replace(/\+/g, ' '))] =
        Router._safeDecode(v.replace(/\+/g, ' '));
    });
    return out;
  },

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /**
   * BASE_PATH normalised: leading slash, no trailing slash, '' when hosted
   * at the domain root.
   * @return {string}
   */
  _base: function () {
    let b = (CONFIG && CONFIG.BASE_PATH) ? String(CONFIG.BASE_PATH) : '';
    if (!b || b === '/') return '';
    if (b.charAt(0) !== '/') b = '/' + b;
    return b.replace(/\/+$/, '');
  },

  /**
   * Compile '/auction/:tournamentId/display' into a RegExp plus the ordered
   * list of parameter names.
   * @param {string} pattern
   * @return {{re: RegExp, keys: string[]}}
   */
  _compile: function (pattern) {
    const keys = [];
    const segments = pattern.replace(/^\/+|\/+$/g, '').split('/');

    let source = '^';
    if (segments.length === 1 && segments[0] === '') {
      source += '/';
    } else {
      segments.forEach(function (seg) {
        if (seg.charAt(0) === ':') {
          keys.push(seg.slice(1));
          source += '/([^/]+)';       // one non-empty segment
        } else {
          source += '/' + Router._escapeRe(seg);
        }
      });
    }
    source += '$';

    return { re: new RegExp(source), keys: keys };
  },

  /**
   * @param {string} s
   * @return {string} s with regex metacharacters escaped
   */
  _escapeRe: function (s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  /**
   * decodeURIComponent that never throws on a malformed '%' sequence.
   * @param {string} s
   * @return {string}
   */
  _safeDecode: function (s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  },

  /**
   * Click interceptor. Only same-origin, plain left clicks on ordinary
   * links become pushState navigation. Everything else (new tab, download,
   * external site, mailto:, target="_blank") is left to the browser.
   * @param {MouseEvent} ev
   * @return {void}
   */
  _onDocumentClick: function (ev) {
    if (ev.defaultPrevented) return;
    if (ev.button !== 0) return;                                  // not a left click
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // open-in-new-tab etc.

    // closest() so a click on an <span> inside the <a> still counts.
    const anchor = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!anchor) return;

    if (anchor.hasAttribute('download')) return;
    if (anchor.getAttribute('rel') === 'external') return;
    if (anchor.hasAttribute('data-native')) return;

    const target = anchor.getAttribute('target');
    if (target && target !== '_self') return;

    const href = anchor.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;                  // in-page anchor
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) return; // mailto:, tel:

    // Resolve relative hrefs and reject anything off-origin.
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;

    // Off-app paths on the same origin (e.g. a sibling GitHub Pages project)
    // must be a real page load.
    const base = Router._base();
    if (base && url.pathname !== base && url.pathname.indexOf(base + '/') !== 0) return;

    ev.preventDefault();
    const appPath = Router.stripBase(url.pathname) + url.search + url.hash;
    Router.navigate(appPath);
  }
};
