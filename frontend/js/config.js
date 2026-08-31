/**
 * config.js — every value the rest of the frontend is allowed to hardcode.
 *
 * Loaded first, before api.js / router.js / app.js. Plain global `const`, no
 * modules, no bundler (CONTRACTS.md §15).
 */

/* eslint-disable no-unused-vars */
const CONFIG = {

  /* ------------------------------------------------------------------ *
   * >>> YOU MUST EDIT THIS LINE BEFORE ANYTHING WORKS <<<
   *
   * Paste the Apps Script Web App URL here. Get it from the Apps Script
   * editor:  Deploy -> New deployment -> Web app
   *          Execute as: Me
   *          Who has access: Anyone
   * then copy the deployment URL. It ends in /exec, NOT /dev.
   *
   *   Good: https://script.google.com/macros/s/AKfycb...../exec
   *   Bad:  https://script.google.com/macros/s/AKfycb...../dev   (login-only)
   *
   * Re-deploying creates a NEW /exec URL unless you pick "Manage deployments"
   * and edit the existing one. See DESIGN.md §17.3, "the deployment trap".
   * ------------------------------------------------------------------ */
  API_BASE_URL: 'https://script.google.com/macros/s/AKfycbyvkQ0ZAI7dUglav0HDpegUaxjmvP1H5uMPGkhLHJQhh439bKlwsGOdqUwA6PIDENGXrQ/exec',

  /**
   * How often the auction screens re-poll for state.
   * Must match the `poll_interval_ms` Config key seeded by setup()
   * (CONTRACTS.md §13). 2000 ms is the agreed value.
   */
  POLL_INTERVAL_MS: 2000,

  /**
   * How long to wait for the API before showing an error, in milliseconds.
   *
   * fetch() has no timeout of its own, so without this a half-dead network
   * leaves every screen on a spinner that never resolves. Raise it if a venue
   * connection is slow but working; lower it if you would rather see an error
   * sooner during the auction.
   * @const {number}
   */
  REQUEST_TIMEOUT_MS: 20000,

  /**
   * GitHub Pages project sites are served from a sub-path, not the domain
   * root:  https://<user>.github.io/cricket-auction/
   * So every real URL is BASE_PATH + the app route. The router strips this
   * before matching, and adds it back when building links.
   *
   * If you rename the repo, change this AND the copy inside 404.html.
   * If you ever host at a domain root (user.github.io or a custom domain),
   * set this to '' (empty string).
   */
  BASE_PATH: '/cricket-auction',

  /** localStorage key holding the session token. Body-only, never a header. */
  TOKEN_KEY: 'ca.session.token',

  /**
   * Backoff schedule for the SYSTEM_BUSY error code, in milliseconds.
   * The backend returns SYSTEM_BUSY when it cannot grab the script lock in
   * time (CONTRACTS.md §3 / §5). That is transient, so we retry twice.
   */
  BUSY_RETRY_DELAYS_MS: [2000, 5000],

  /** Query-string key that 404.html uses to hand the deep link to index.html. */
  REDIRECT_PARAM: 'ca_redirect'
};

/**
 * True once someone has actually filled in API_BASE_URL above.
 * app.js uses this to show a loud setup message instead of failing silently.
 * @return {boolean}
 */
CONFIG.isConfigured = function () {
  return typeof CONFIG.API_BASE_URL === 'string' &&
    CONFIG.API_BASE_URL.indexOf('script.google.com') !== -1 &&
    /\/exec\/?$/.test(CONFIG.API_BASE_URL);
};
