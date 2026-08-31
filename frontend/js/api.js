/**
 * api.js — the only file that talks to the Apps Script backend.
 * Implements CONTRACTS.md §15 against the envelope in CONTRACTS.md §2.
 *
 *   API.call(action, payload)   -> Promise<data>   POST, authenticated
 *   API.get(action, params)     -> Promise<data>   GET,  public reads only
 *   API.setToken / getToken / clearToken
 *
 * ===================================================================
 * READ THIS BEFORE CHANGING ANY fetch() OPTION BELOW.
 *
 * Apps Script does NOT answer CORS preflight (OPTIONS) requests. It just
 * 405s them. So every request the browser sends must qualify as a CORS
 * "simple request", which means:
 *
 *   1. Content-Type MUST be one of text/plain, multipart/form-data or
 *      application/x-www-form-urlencoded. We use
 *      'text/plain;charset=utf-8' and put real JSON in the body.
 *      Setting 'application/json' triggers a preflight and the call FAILS.
 *      This is not a bug and it is not sloppiness. Do not "fix" it.
 *
 *   2. NO custom request headers. That means no `Authorization: Bearer ...`,
 *      no `X-Token`, nothing. A custom header also triggers preflight.
 *      Therefore the session token travels in the JSON BODY:
 *          { action, token, payload }
 *      exactly as CONTRACTS.md §11 specifies.
 *
 *   3. A successful /exec call answers with a 302 to a
 *      script.googleusercontent.com URL that carries the real body. So we
 *      need redirect:'follow' (the default, stated here explicitly so nobody
 *      changes it). And we must NOT use mode:'no-cors' — that would give us
 *      an opaque response we cannot read at all.
 *
 * The server side of this contract is DESIGN.md §1.2.
 * ===================================================================
 */

/* eslint-disable no-unused-vars */
const API = {

  /**
   * How long to wait for a response before giving up, in milliseconds.
   *
   * 20s: comfortably longer than a cold Apps Script start plus a 400-row export
   * (measured at a couple of seconds), short enough that a person watching a
   * spinner gets a real answer. Override per deployment with
   * CONFIG.REQUEST_TIMEOUT_MS.
   * @const {number}
   */
  DEFAULT_TIMEOUT_MS: 20000,

  /**
   * The `v` (auction state version) field from the most recent envelope, or
   * null. Polling code compares this to decide whether to re-render.
   * @type {number|null}
   */
  lastVersion: null,

  /* ---------------------------------------------------------------- *
   * Token storage
   * ---------------------------------------------------------------- */

  /**
   * Store the session token returned by auth.login.
   * @param {string} token
   * @return {void}
   */
  setToken: function (token) {
    try {
      window.localStorage.setItem(CONFIG.TOKEN_KEY, token || '');
    } catch (e) {
      // Private browsing can throw on write. Degrade to "logged out" rather
      // than crashing the page.
      console.error('API.setToken: localStorage unavailable', e);
    }
  },

  /**
   * @return {string|null} the stored token, or null if there is none.
   */
  getToken: function () {
    try {
      const t = window.localStorage.getItem(CONFIG.TOKEN_KEY);
      return t ? t : null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Forget the session token (logout, or after UNAUTHORIZED).
   * @return {void}
   */
  clearToken: function () {
    try {
      window.localStorage.removeItem(CONFIG.TOKEN_KEY);
    } catch (e) {
      /* nothing useful to do */
    }
  },

  /* ---------------------------------------------------------------- *
   * Requests
   * ---------------------------------------------------------------- */

  /**
   * POST an action to the backend.
   *
   * @param {string} action  e.g. 'auction.markSold'
   * @param {Object} [payload]  action arguments
   * @param {Object} [opts]  { token: string|null } to override the stored
   *                         token, and { retryBusy: false } to opt out of the
   *                         SYSTEM_BUSY backoff.
   * @return {Promise<*>} resolves with envelope.data
   *                      rejects with {code, message} — see CONTRACTS.md §3
   */
  call: function (action, payload, opts) {
    const options = opts || {};
    const token = Object.prototype.hasOwnProperty.call(options, 'token')
      ? options.token
      : API.getToken();

    const body = JSON.stringify({
      action: action,
      // Token in the BODY. See the header comment — never a header.
      token: token || '',
      payload: payload || {}
    });

    const attempt = function () {
      return API._fetch(API._endpoint(), {
        method: 'POST',
        // The one Content-Type Apps Script can receive without a preflight.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store'
      });
    };

    return options.retryBusy === false
      ? attempt()
      : API._withBusyRetry(attempt);
  },

  /**
   * GET a public read action.
   *
   * No token is sent. doGet only serves routes declared auth:'PUBLIC'
   * (CONTRACTS.md §11), so there is nothing to authenticate. The projector
   * display token, where needed, is an ordinary query param.
   *
   * @param {string} action  e.g. 'tournament.getPublic'
   * @param {Object} [params]  query parameters; null/undefined are dropped
   * @param {Object} [opts]  { retryBusy: false } to opt out of the backoff
   * @return {Promise<*>} resolves with envelope.data, rejects with {code, message}
   */
  get: function (action, params, opts) {
    const options = opts || {};
    const qs = API._queryString(Object.assign({ action: action }, params || {}));
    const url = API._endpoint() + '?' + qs;

    const attempt = function () {
      return API._fetch(url, {
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store'
      });
    };

    return options.retryBusy === false
      ? attempt()
      : API._withBusyRetry(attempt);
  },

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /**
   * @return {string} the configured /exec URL, minus any trailing slash.
   * @throws {Object} {code:'NOT_CONFIGURED'} style rejection is done by the
   *         caller; here we just fail loudly in the console.
   */
  _endpoint: function () {
    return String(CONFIG.API_BASE_URL || '').replace(/\/+$/, '');
  },

  /**
   * Build a query string, skipping null/undefined values.
   * @param {Object} params
   * @return {string}
   */
  _queryString: function (params) {
    const parts = [];
    Object.keys(params).forEach(function (k) {
      const v = params[k];
      if (v === null || v === undefined) return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.join('&');
  },

  /**
   * Do one request and unwrap the envelope.
   *
   * Resolution rules (CONTRACTS.md §2):
   *   ok:true   -> resolve(data), and stash `v` on API.lastVersion
   *   ok:false  -> reject(error) so callers can switch on error.code
   *   anything else (offline, DNS, CORS, HTML error page, bad JSON)
   *             -> reject({code:'NETWORK', message})
   *
   * @param {string} url
   * @param {Object} init  fetch init
   * @return {Promise<*>}
   */
  _fetch: function (url, init) {
    if (!CONFIG.isConfigured()) {
      return Promise.reject({
        code: 'NOT_CONFIGURED',
        message: 'API_BASE_URL is not set. Open frontend/js/config.js and paste your Apps Script /exec URL.'
      });
    }

    let response;

    // A TIMEOUT. fetch() has none of its own: a request to a host that accepts
    // the connection and then says nothing hangs for as long as the OS allows,
    // which is minutes. Every screen here shows a spinner while a call is in
    // flight, so with no timeout a slow or half-dead network does not produce an
    // error — it produces a spinner that never stops. That is what happened on
    // /organiser/dashboard, and at a venue on failing wifi it would happen to
    // the auction console mid-auction.
    //
    // An abort is reported as NETWORK, the same code as any other transport
    // failure, so every caller's existing handling applies unchanged.
    const ms = Number(CONFIG.REQUEST_TIMEOUT_MS) || API.DEFAULT_TIMEOUT_MS;
    let timer = null;
    let timedOut = false;
    const opts = Object.assign({}, init);

    if (typeof AbortController === 'function') {
      const controller = new AbortController();
      opts.signal = controller.signal;
      timer = window.setTimeout(function () {
        timedOut = true;
        controller.abort();
      }, ms);
    }

    const clear = function () {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
    };

    return fetch(url, opts)
      .catch(function (networkErr) {
        clear();
        // fetch() only rejects for genuine transport failures: offline, DNS,
        // TLS, a CORS rule the browser refused — or our own abort above.
        throw {
          code: 'NETWORK',
          message: timedOut
            ? 'The server did not respond within ' + Math.round(ms / 1000) +
              ' seconds. Check the internet connection and try again.'
            : 'Could not reach the server. Check the internet connection and try again.',
          timeout: timedOut,
          cause: String(networkErr && networkErr.message ? networkErr.message : networkErr)
        };
      })
      .then(function (res) { clear(); return res; })
      .then(function (res) {
        response = res;
        return res.text();
      })
      .catch(function (err) {
        if (err && err.code) throw err;
        throw { code: 'NETWORK', message: 'The server response could not be read.' };
      })
      .then(function (text) {
        if (!response.ok) {
          // Apps Script serves an HTML error page for a bad/undeployed URL.
          throw {
            code: 'NETWORK',
            message: 'Server returned HTTP ' + response.status + '. The Apps Script URL may be wrong or not deployed for "Anyone".'
          };
        }

        let envelope;
        try {
          envelope = JSON.parse(text);
        } catch (e) {
          // Almost always the Google sign-in interstitial, i.e. the web app
          // was deployed with "Who has access: Only myself".
          throw {
            code: 'NETWORK',
            message: 'The server did not return JSON. Re-deploy the Apps Script web app with access set to "Anyone".'
          };
        }

        if (!envelope || typeof envelope.ok !== 'boolean') {
          throw { code: 'NETWORK', message: 'The server returned an unexpected response.' };
        }

        if (envelope.ok === false) {
          const err = envelope.error || {};
          throw {
            code: err.code || 'INTERNAL_ERROR',
            message: err.message || 'Something went wrong.'
          };
        }

        API.lastVersion = (typeof envelope.v === 'number') ? envelope.v : null;
        return envelope.data;
      });
  },

  /**
   * Retry-with-backoff wrapper for SYSTEM_BUSY.
   *
   * The backend throws SYSTEM_BUSY when LockService could not hand over the
   * script lock inside its wait window (CONTRACTS.md §5 rule 3). During a
   * live auction several organisers hit the same lock, so this is expected
   * and self-clearing — retrying is correct, and safe, because a request
   * that returned SYSTEM_BUSY never entered the critical section.
   *
   * Two retries: 2s, then 5s. After that the error surfaces to the caller.
   *
   * @param {function(): Promise<*>} attempt
   * @return {Promise<*>}
   */
  _withBusyRetry: function (attempt) {
    const delays = CONFIG.BUSY_RETRY_DELAYS_MS || [];

    const run = function (tryIndex) {
      return attempt().catch(function (err) {
        if (!err || err.code !== 'SYSTEM_BUSY' || tryIndex >= delays.length) {
          throw err;
        }
        return API._sleep(delays[tryIndex]).then(function () {
          return run(tryIndex + 1);
        });
      });
    };

    return run(0);
  },

  /**
   * @param {number} ms
   * @return {Promise<void>}
   */
  _sleep: function (ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }
};
