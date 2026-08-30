/**
 * Phase 2 DOM-stub smoke test for the cricket-auction SPA shell.
 *
 * Extends /tmp/ca-smoke/run.js (Phase 1). Same idea: a minimal DOM stub, the
 * real config/api/router/app sources run in a vm, no network. This one adds
 * parentNode/removeChild/insertBefore and a location.search that pushState
 * actually updates, because the Phase 2 nav lives outside #app and the
 * tournament selection lives in the query string.
 *
 * Run:  node /tmp/ca-smoke/phase2.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const FE = '/Users/raja.t/cricket-auction/frontend';

/* --------------------------------------------------------------- stub --- */

function mkEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    attrs: {},
    parentNode: null,
    _text: '',
    className: '',
    href: '',
    type: '',
    _listeners: {},

    set textContent(v) {
      this._text = String(v);
      this.children.forEach((c) => { c.parentNode = null; });
      this.children.length = 0;
    },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('');
    },
    get firstChild() { return this.children[0] || null; },

    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.unshift(c); else this.children.splice(i, 0, c);
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    hasAttribute(k) { return k in this.attrs; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    click() { (this._listeners.click || []).forEach((fn) => fn({})); },
    closest() { return null; },
    scrollIntoView() {}
  };
  return el;
}

const bodyEl = mkEl('body');
const appEl = mkEl('div');
appEl.attrs.id = 'app';
bodyEl.appendChild(appEl);

const docListeners = {};
const store = {};

const sandbox = {
  console,
  document: {
    body: bodyEl,
    title: '',
    getElementById: (id) => (id === 'app' ? appEl : null),
    createElement: mkEl,
    createTextNode: (t) => {
      const n = mkEl('#text');
      n._text = String(t);
      return n;
    },
    addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); }
  },
  window: {
    addEventListener() {},
    location: {
      pathname: '/cricket-auction/',
      search: '',
      href: 'https://x.github.io/cricket-auction/',
      origin: 'https://x.github.io',
      reload() {}
    },
    history: {
      pushState(s, t, url) { setUrl(url); },
      replaceState(s, t, url) { setUrl(url); }
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    setTimeout, clearTimeout, URL, Promise
  },
  setTimeout,
  clearTimeout,
  Promise,
  fetch: () => Promise.reject(new Error('no network in smoke test'))
};
sandbox.window.window = sandbox.window;
sandbox.localStorage = sandbox.window.localStorage;
vm.createContext(sandbox);

function setUrl(url) {
  const q = url.indexOf('?');
  sandbox.window.location.pathname = q === -1 ? url : url.slice(0, q);
  sandbox.window.location.search = q === -1 ? '' : url.slice(q);
  sandbox.window.location.href = sandbox.window.location.origin +
    sandbox.window.location.pathname + sandbox.window.location.search;
}

['js/config.js', 'js/api.js', 'js/router.js', 'js/app.js'].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(FE, f), 'utf8'), sandbox, { filename: f });
});

/* ------------------------------------------------------------- helpers --- */

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function run(code) { return vm.runInContext(code, sandbox); }

/** Navigate by full app path (may include ?query) and resolve the router. */
function go(appPath) {
  setUrl('/cricket-auction' + (appPath === '/' ? '/' : appPath));
  run('Router.resolve();');
}

function walk(el, out) {
  out = out || [];
  out.push(el);
  el.children.forEach((c) => walk(c, out));
  return out;
}

function allNodes() { return walk(bodyEl); }

function byClass(cls, root) {
  return walk(root || bodyEl).filter(
    (e) => typeof e.className === 'string' &&
      (' ' + e.className + ' ').indexOf(' ' + cls + ' ') !== -1
  );
}

function bodyText() { return bodyEl.textContent.replace(/\s+/g, ' ').trim(); }
function appText() { return appEl.textContent.replace(/\s+/g, ' ').trim(); }
function route() { return bodyEl.attrs['data-route']; }
function currentUrl() {
  return sandbox.window.location.pathname + sandbox.window.location.search;
}

/** Wait for pending promise callbacks (the nav/picker fill in async). */
function flush() { return new Promise((r) => setImmediate(() => setImmediate(r))); }

/* ---------------------------------------------------------------- boot --- */

docListeners.DOMContentLoaded.forEach((fn) => fn());

/* =========================================================== the tests === */

(async function main() {
  console.log('\nPhase 2 shell smoke test\n');

  /* --- 0. NOTHING is defined yet: this is a 404'd <script> ------------- */
  console.log('0. A page module that never loaded renders the error panel');

  run("API.setToken('fake-token'); App.setTournament('TRN_abc123');");

  let threw = null;
  try { go('/admin/payments?t=TRN_abc123'); } catch (e) { threw = e; }
  check('routing to a missing module did not throw', threw === null, threw && threw.message);
  check('route key was still set', route() === 'admin-payments', route());
  check('the error panel names the screen',
    appText().indexOf('This screen could not be opened') !== -1, appText().slice(0, 120));
  check('and names the file',
    appText().indexOf('js/pages/admin-payments.js') !== -1, appText().slice(0, 250));
  check('and names the global that was missing',
    appText().indexOf('AdminPaymentsPage was not defined') !== -1, appText().slice(0, 250));
  check('the admin nav is still there, so sign-out remains reachable',
    byClass('admin-nav').length === 1);

  threw = null;
  try { go('/admin/players?t=TRN_abc123'); } catch (e) { threw = e; }
  check('the same for /admin/players', threw === null &&
    appText().indexOf('js/pages/admin-players.js') !== -1, appText().slice(0, 250));

  /* Also: the picker must not blow up when the backend is unreachable.
     config.js still holds the placeholder URL at this point. */
  run('App.forgetTournament(); App._tournamentIndex = null;');
  go('/admin/payments');
  await flush();
  check('an unreachable backend leaves the picker readable, not blank',
    appText().indexOf('The tournament list could not be loaded') !== -1 &&
    appText().indexOf('Try again') !== -1, appText().slice(0, 250));

  /* --- now the page modules "load" ------------------------------------- */
  /* Declared with `const`, exactly as CONTRACTS-PHASE1 §4 shows, which is
     the case window[name] cannot resolve. Behaviour is switched through a
     property, never by reassigning the binding — a top-level const cannot
     be reassigned, which is the whole point of the resolvePage switch. */
  run(`
    var seen = { payments: null, players: null, dashboard: null };
    const AdminPaymentsPage = { render: function (ctx) {
      seen.payments = ctx;
      const m = document.createElement('main');
      m.textContent = 'PAYMENTS t=' + App.currentTournamentId(ctx);
      App.mount(m);
    }};
    const AdminPlayersPage = {
      mode: 'normal',
      render: function (ctx) {
        seen.players = ctx;
        if (AdminPlayersPage.mode === 'throw') throw new Error('boom in page');
        const m = document.createElement('main');
        if (AdminPlayersPage.mode === 'ownnav') m.appendChild(App.adminNav('players', ctx));
        const p = document.createElement('p');
        p.textContent = (AdminPlayersPage.mode === 'ownnav' ? 'PLAYERS OWN NAV t=' : 'PLAYERS t=') +
          App.currentTournamentId(ctx);
        m.appendChild(p);
        App.mount(m);
      }
    };
    const AdminTournamentPage = { render: function (ctx) {
      seen.dashboard = ctx;
      const m = document.createElement('main');
      m.textContent = 'DASHBOARD t=' + App.currentTournamentId(ctx);
      App.mount(m);
    }};
    const AdminLoginPage = { render: function () {
      const m = document.createElement('main');
      m.textContent = 'LOGIN PAGE';
      App.mount(m);
    }};
  `);

  /* A configured backend with a tournament.list that answers, so names and
     the picker can be exercised. */
  run(`
    CONFIG.API_BASE_URL = 'https://script.google.com/macros/s/AKfycbTEST/exec';
    API.call = function (action) {
      API._lastAction = action;
      if (action === 'tournament.list') {
        return Promise.resolve([
          { tournament_id: 'TRN_abc123', name: 'Summer Cup 2026', status: 'REG_OPEN',
            player_count: 41, verified_count: 12 },
          { tournament_id: 'TRN_zzz999', name: 'Winter Shield', status: 'DRAFT',
            player_count: 0, verified_count: 0 }
        ]);
      }
      return Promise.resolve({});
    };
  `);

  /* --- 1. route table + resolvePage ------------------------------------ */
  console.log('\n1. Routes are registered and resolve to their modules');

  const paths = run('App.PAGES.map(function (p) { return p.path; })');
  check('/admin/payments is in App.PAGES', paths.includes('/admin/payments'), JSON.stringify(paths));
  check('/admin/players is in App.PAGES', paths.includes('/admin/players'), JSON.stringify(paths));
  check('AdminPaymentsPage resolves (const binding, not window)',
    run("App.resolvePage('AdminPaymentsPage') !== null"));
  check('AdminPlayersPage resolves (const binding, not window)',
    run("App.resolvePage('AdminPlayersPage') !== null"));
  check('window.AdminPaymentsPage really is undefined (the switch is load-bearing)',
    run("typeof window['AdminPaymentsPage'] === 'undefined'"));

  /* --- 2. auth guard --------------------------------------------------- */
  console.log('\n2. Auth guard bounces both new routes when there is no token');

  run('API.clearToken(); App.forgetTournament();');
  go('/admin/payments?t=TRN_abc123');
  check('no token -> /admin/payments lands on the login screen',
    route() === 'admin-login' && appText().indexOf('LOGIN PAGE') !== -1,
    route() + ' / ' + appText());
  check('intendedPath remembers /admin/payments',
    run('App.intendedPath') === '/admin/payments', run('App.intendedPath'));
  check('no admin nav is drawn on the login screen', byClass('admin-nav').length === 0);

  go('/admin/players?t=TRN_abc123');
  check('no token -> /admin/players lands on the login screen',
    route() === 'admin-login', route());
  check('intendedPath remembers /admin/players',
    run('App.intendedPath') === '/admin/players', run('App.intendedPath'));

  /* --- 3. no tournament selected -> picker ----------------------------- */
  console.log('\n3. No tournament selected shows the picker, not an empty screen');

  run("API.setToken('fake-token'); App.forgetTournament(); App._tournamentIndex = null;");
  go('/admin/payments');
  check('route key is admin-payments (not bounced away)', route() === 'admin-payments', route());
  check('the page module was NOT rendered',
    appText().indexOf('PAYMENTS') === -1, appText());
  check('the picker explains itself',
    appText().indexOf('Choose a tournament first') !== -1, appText().slice(0, 120));
  check('and says why the screen is empty',
    appText().indexOf('works on one tournament at a time') !== -1);
  check('the nav still shows, with the "none selected" warning state',
    byClass('admin-nav__scope--none').length === 1);
  check('and says No tournament selected',
    bodyText().indexOf('No tournament selected') !== -1);

  await flush();
  check('the picker lists the tournaments it loaded',
    appText().indexOf('Summer Cup 2026') !== -1 && appText().indexOf('Winter Shield') !== -1,
    appText().slice(0, 200));

  const pickLinks = byClass('admin-picker__link', appEl);
  check('each picker entry links to this same screen with ?t=',
    pickLinks.length === 2 &&
    pickLinks[0].href === '/cricket-auction/admin/payments?t=TRN_abc123',
    pickLinks.map((a) => a.href).join(' | '));

  go('/admin/players');
  check('/admin/players with no selection shows the picker too',
    appText().indexOf('Choose a tournament first') !== -1 &&
    appText().indexOf('PLAYERS') === -1, appText().slice(0, 120));

  /* --- 4. with a tournament -> the page renders ------------------------ */
  console.log('\n4. With ?t= the page renders and the nav names the tournament');

  run('App._tournamentIndex = null;');
  go('/admin/payments?t=TRN_abc123');
  check('AdminPaymentsPage rendered', appText().indexOf('PAYMENTS t=TRN_abc123') !== -1, appText());
  check('ctx carried the tournament id',
    run('seen.payments.query.t') === 'TRN_abc123');
  check('exactly one admin nav on screen', byClass('admin-nav').length === 1,
    String(byClass('admin-nav').length));
  check('the nav shows the raw id immediately',
    bodyText().indexOf('TRN_abc123') !== -1);

  await flush();
  check('the nav resolves the id to a human name',
    bodyText().indexOf('Summer Cup 2026') !== -1, bodyText().slice(0, 200));
  check('the Payments tab is marked current',
    byClass('admin-nav__link--active')[0] &&
    byClass('admin-nav__link--active')[0].textContent === 'Payments',
    byClass('admin-nav__link--active').map((a) => a.textContent).join(','));

  /* --- 5. the id survives moving between all three screens ------------- */
  console.log('\n5. The tournament survives navigation between all three screens');

  function navLink(label) {
    return byClass('admin-nav__link').filter((a) => a.textContent === label)[0];
  }
  function follow(anchor) {
    go(run('Router.stripBase(' + JSON.stringify(anchor.href.split('?')[0]) + ')') +
      (anchor.href.indexOf('?') === -1 ? '' : '?' + anchor.href.split('?')[1]));
  }

  const toPlayers = navLink('Players');
  check('the Players link carries ?t=',
    toPlayers && toPlayers.href === '/cricket-auction/admin/players?t=TRN_abc123',
    toPlayers && toPlayers.href);
  follow(toPlayers);
  check('Players screen rendered with the same tournament',
    appText().indexOf('PLAYERS t=TRN_abc123') !== -1, appText());
  check('the URL still carries it',
    currentUrl() === '/cricket-auction/admin/players?t=TRN_abc123', currentUrl());

  const toDash = navLink('Tournaments');
  check('the Tournaments link carries ?t= as well',
    toDash && toDash.href === '/cricket-auction/admin/dashboard?t=TRN_abc123',
    toDash && toDash.href);
  follow(toDash);
  check('Tournaments screen rendered with the same tournament',
    appText().indexOf('DASHBOARD t=TRN_abc123') !== -1, appText());
  check('the Tournaments tab is the current one now',
    byClass('admin-nav__link--active')[0].textContent === 'Tournaments',
    byClass('admin-nav__link--active')[0].textContent);

  follow(navLink('Payments'));
  check('and back to Payments, still the same tournament',
    appText().indexOf('PAYMENTS t=TRN_abc123') !== -1 &&
    currentUrl() === '/cricket-auction/admin/payments?t=TRN_abc123',
    appText() + ' | ' + currentUrl());

  /* --- 6. localStorage is a convenience, the URL is the truth ---------- */
  console.log('\n6. localStorage restores a selection into the URL, never over it');

  check('the selection was remembered', run('App.rememberedTournamentId()') === 'TRN_abc123',
    run('App.rememberedTournamentId()'));
  go('/admin/players');
  check('no ?t= but one remembered -> it is put back INTO the url',
    currentUrl() === '/cricket-auction/admin/players?t=TRN_abc123', currentUrl());
  check('and the page rendered rather than the picker',
    appText().indexOf('PLAYERS t=TRN_abc123') !== -1, appText());

  run("App.setTournament('TRN_zzz999');");
  go('/admin/players?t=TRN_abc123');
  check('an explicit ?t= beats the remembered one',
    appText().indexOf('PLAYERS t=TRN_abc123') !== -1, appText());
  check('and the remembered copy is corrected to match the URL',
    run('App.rememberedTournamentId()') === 'TRN_abc123', run('App.rememberedTournamentId()'));

  /* --- 7. an id that is not one of yours ------------------------------- */
  console.log('\n7. An unknown tournament id is called out, not silently shown');

  run('App._tournamentIndex = null;');
  go('/admin/payments?t=TRN_nosuch');
  await flush();
  check('the scope switches to the unknown state',
    byClass('admin-nav__scope--unknown').length === 1);
  check('and says so in words',
    bodyText().indexOf('Not one of your tournaments') !== -1, bodyText().slice(0, 250));
  check('naming the id that is wrong',
    bodyText().indexOf('which is not in your list') !== -1);

  /* --- 8. a throwing page module --------------------------------------- */
  console.log('\n8. A page module that throws is caught, not escaped');

  run("AdminPlayersPage.mode = 'throw';");
  threw = null;
  try { go('/admin/players?t=TRN_abc123'); } catch (e) { threw = e; }
  check('a throwing page module did not escape', threw === null, threw && threw.message);
  check('and produced the same readable panel',
    appText().indexOf('This screen could not be opened') !== -1 &&
    appText().indexOf('boom in page') !== -1, appText().slice(0, 250));
  check('the nav survives a throwing page, so sign-out is still reachable',
    byClass('admin-nav').length === 1, String(byClass('admin-nav').length));
  check('and the nav still names the tournament',
    bodyText().indexOf('TRN_abc123') !== -1);

  /* --- 9. a page that renders the nav itself gets exactly one ---------- */
  console.log('\n9. A page that calls App.adminNav() gets one nav, not two');

  run("AdminPlayersPage.mode = 'ownnav';");
  go('/admin/players?t=TRN_abc123');
  check('exactly one nav in the document', byClass('admin-nav').length === 1,
    String(byClass('admin-nav').length));
  check('and it is inside the page, not above #app',
    byClass('admin-nav', appEl).length === 1);
  check('the page rendered', appText().indexOf('PLAYERS OWN NAV t=TRN_abc123') !== -1);
  check('its Payments link still carries the tournament',
    navLink('Payments').href === '/cricket-auction/admin/payments?t=TRN_abc123',
    navLink('Payments').href);
  run("AdminPlayersPage.mode = 'normal';");

  /* --- 9b. "Change tournament" actually re-picks ------------------------ */
  console.log('\n9b. Change tournament drops the selection and shows the picker');

  go('/admin/payments?t=TRN_abc123');
  check('starting from a selected tournament',
    appText().indexOf('PAYMENTS t=TRN_abc123') !== -1, appText());
  byClass('admin-nav__change')[0].click();
  check('the ?t= is gone from the URL',
    currentUrl() === '/cricket-auction/admin/payments', currentUrl());
  check('the remembered copy is gone too', run('App.rememberedTournamentId()') === '');
  check('and the picker is on screen, not the page',
    appText().indexOf('Choose a tournament first') !== -1 &&
    appText().indexOf('PAYMENTS t=') === -1, appText().slice(0, 120));

  await flush();
  const rePick = byClass('admin-picker__link', appEl)[1];
  check('picking the OTHER tournament is offered',
    rePick && rePick.href === '/cricket-auction/admin/payments?t=TRN_zzz999',
    rePick && rePick.href);
  follow(rePick);
  check('picking it selects it', appText().indexOf('PAYMENTS t=TRN_zzz999') !== -1, appText());
  await flush();
  check('and the nav names the NEW tournament, not the old one',
    bodyText().indexOf('Winter Shield') !== -1 &&
    bodyText().indexOf('Summer Cup 2026') === -1, bodyText().slice(0, 220));

  // The dashboard is happy without a tournament, so Change has to force it.
  go('/admin/dashboard?t=TRN_zzz999');
  check('the dashboard renders with a selection',
    appText().indexOf('DASHBOARD t=TRN_zzz999') !== -1, appText());
  byClass('admin-nav__change')[0].click();
  check('Change on the dashboard also reaches the picker',
    appText().indexOf('Choose a tournament first') !== -1 &&
    currentUrl() === '/cricket-auction/admin/dashboard', appText().slice(0, 100));
  await flush();
  follow(byClass('admin-picker__link', appEl)[0]);
  check('and picking there returns to the dashboard, scoped',
    appText().indexOf('DASHBOARD t=TRN_abc123') !== -1 &&
    currentUrl() === '/cricket-auction/admin/dashboard?t=TRN_abc123',
    appText() + ' | ' + currentUrl());

  go('/');
  go('/admin/dashboard?t=TRN_abc123');
  check('a pending re-pick cannot ambush a later screen',
    appText().indexOf('DASHBOARD t=TRN_abc123') !== -1, appText());

  /* --- 10. sign out ---------------------------------------------------- */  console.log('\n10. Sign out clears the token and returns to the login screen');

  go('/admin/payments?t=TRN_abc123');
  const signOut = byClass('admin-nav__signout')[0];
  check('there is a sign-out control', !!signOut);
  check('token is present before signing out', run('API.getToken()') === 'fake-token');
  signOut.click();
  check('the token is gone', run('API.getToken()') === null, String(run('API.getToken()')));
  check('the remembered tournament is gone too (next admin must choose)',
    run('App.rememberedTournamentId()') === '', run('App.rememberedTournamentId()'));
  check('we are on the login screen', route() === 'admin-login', route());
  check('and the nav is gone with it', byClass('admin-nav').length === 0);

  /* --- 11. Phase 1 must not regress ------------------------------------ */
  console.log('\n11. Phase 1 behaviour is unchanged');

  go('/');
  check("'/' still renders the landing panel",
    route() === 'home' && appText().indexOf('Cricket Auction') !== -1, appText().slice(0, 80));
  check('no admin nav leaks onto the landing page', byClass('admin-nav').length === 0);

  go('/nope');
  check('the 404 fallback still works',
    route() === 'not-found' && appText().indexOf('Page not found') !== -1, appText().slice(0, 80));

  go('/register/TRN_abc123');
  check('a public route is untouched by the admin guard', route() === 'register', route());

  // Phase 3 landed, so /organiser/dashboard is no longer a placeholder — it is
  // a real admin-guarded route. With no token the guard must bounce it to the
  // sign-in page, exactly like the other guarded routes above. This assertion
  // used to check for the placeholder text; that state no longer exists.
  go('/organiser/dashboard');
  check('an unauthenticated organiser is sent to sign in',
    route() === 'admin-login', route());

  check('the setup warning rendered at boot is still on the page',
    byClass('banner--error').length >= 1);

  setUrl('/cricket-auction/?ca_redirect=%2Fadmin%2Fplayers%3Ft%3DTRN_abc123');
  run('App.restoreDeepLink();');
  check('restoreDeepLink still un-bounces a 404.html deep link, query and all',
    currentUrl() === '/cricket-auction/admin/players?t=TRN_abc123', currentUrl());

  setUrl('/cricket-auction/?ca_redirect=%2F%2Fevil.com%2Fx');
  run('App.restoreDeepLink();');
  check('and still refuses a protocol-relative open redirect',
    currentUrl() === '/cricket-auction/?ca_redirect=%2F%2Fevil.com%2Fx', currentUrl());

  /* --------------------------------------------------------------------- */
  console.log('\n' + '-'.repeat(60));
  console.log(fail ? `${pass}/${pass + fail} passed, ${fail} FAILED` : `${pass}/${pass} passed`);
  process.exit(fail ? 1 : 0);
})();
