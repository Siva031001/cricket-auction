/**
 * Code.gs — the only file Apps Script talks to directly.
 *
 * Holds:
 *   - the bare global doGet(e) / doPost(e) that Apps Script requires,
 *   - buildRoutes(), which merges every module's route table,
 *   - AuthRoutes(), the auth + smoke-test routes (Auth.gs holds the logic),
 *   - dispatch(), which implements CONTRACTS.md §11 steps 1-7 in order.
 *
 * Security note: the /exec URL is public and anonymous. Nothing in this file may
 * ever put a stack trace, an internal message or a Google error string into the
 * HTTP response. Real detail goes to console.error (Stackdriver) only.
 */

/**
 * The single message every unhandled throw turns into. Deliberately says
 * nothing about what broke — see CONTRACTS.md §11 step 6.
 * @const {string}
 */
const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Assemble the full route table.
 *
 * WHY THIS IS A FUNCTION AND NOT A TOP-LEVEL CONST: Apps Script concatenates
 * .gs files in an undefined order. A top-level `const ROUTES = Object.assign(...)`
 * would run at load time and could execute before TournamentRoutes / PlayerRoutes /
 * etc. are defined, producing a random "function is not defined" crash that only
 * shows up on some deployments. Function declarations are hoisted across all
 * files, so building the table lazily inside the request is always safe.
 *
 * @return {!Object<string, {auth: (string|!Array<string>), methods: !Array<string>, handler: !Function}>}
 */
function buildRoutes() {
  return Object.assign({},
    AuthRoutes(),
    TournamentRoutes(),
    PlayerRoutes(),
    PaymentRoutes(),
    TeamRoutes(),
    AuctionRoutes(),
    ReportRoutes()
  );
}

/**
 * Auth and system routes.
 *
 * These live in Code.gs rather than Auth.gs so that Auth.gs stays pure logic
 * with no knowledge of the transport layer.
 *
 * Handlers are called as handler(payload, session, e) per CONTRACTS.md §11.
 * auth.logout needs the raw token; it reads it off session.token, which
 * Auth.resolve puts there, rather than widening the handler signature.
 *
 * PHASE 3 will add: auth.organiserLink (one-time invite token -> real session,
 * DESIGN.md §5.4). It is not in Phase 0 because organiser onboarding is not built.
 *
 * @return {!Object} route table fragment
 */
function AuthRoutes() {
  return {
    'auth.login': {
      auth: 'PUBLIC',
      methods: ['POST'],
      /**
       * @param {!Object} payload {email, password, ua}
       * @return {!Object} {token, expiresAt, user}
       */
      handler: (payload) => {
        // Apps Script exposes no request headers, so the browser has to send its
        // own user agent in the body. It is untrusted and used for audit only.
        const ua = payload.ua || payload.userAgent || '';
        return Auth.login(payload.email, payload.password, ua);
      }
    },

    'auth.logout': {
      auth: 'ANY',
      methods: ['POST'],
      /**
       * @param {!Object} payload unused
       * @param {{token: string}} session resolved session, carries the token
       * @return {!Object} {loggedOut: true}
       */
      handler: (payload, session) => {
        Auth.logout(session.token);
        return { loggedOut: true };
      }
    },

    'auth.me': {
      auth: 'ANY',
      methods: ['POST'],
      /**
       * @param {!Object} payload unused
       * @param {!Object} session resolved session
       * @return {!Object} {user_id, role, tournament_id}
       */
      handler: (payload, session) => ({
        user_id: session.user_id,
        role: session.role,
        tournament_id: session.tournament_id
      })
    },

    'system.ping': {
      auth: 'PUBLIC',
      methods: ['GET', 'POST'],
      /**
       * Deployment smoke test. Touches no sheet, so it also proves the web app
       * is reachable when the Spreadsheet itself is the problem.
       * @return {!Object} {pong, time}
       */
      handler: () => ({ pong: true, time: Util.nowIso() })
    }
  };
}

/**
 * Route one request. Implements CONTRACTS.md §11 steps 1-6 in order and returns
 * an envelope object; the caller serialises it (step 7).
 *
 * This function never throws. Every failure path produces an envelope.
 *
 * @param {?string} action action name, e.g. 'auction.markSold'
 * @param {?Object} payload already-parsed payload object
 * @param {?string} token session token from the body, or null for GET
 * @param {string} method 'GET' or 'POST'
 * @param {?Object} e the raw Apps Script event object
 * @return {!Object} a response envelope built by Util.ok / Util.err
 */
function dispatch(action, payload, token, method, e) {
  // Step 1 — parse the body. Already done by doGet/doPost, which own the raw
  // event; a malformed body never reaches this far.
  const data = (payload && typeof payload === 'object') ? payload : {};

  // Step 2 — look up the action. Unknown -> BAD_REQUEST. hasOwnProperty guards
  // against a caller asking for 'constructor' or '__proto__' and getting a
  // function off Object.prototype.
  const routes = buildRoutes();
  if (!action || typeof action !== 'string' ||
      !Object.prototype.hasOwnProperty.call(routes, action)) {
    // The action name is not echoed back: it is attacker-controlled text and
    // this string is rendered straight into the UI.
    return Util.err(ERR.BAD_REQUEST, 'That action is not available.');
  }
  const route = routes[action];

  // Step 3 — check the method is allowed for this route.
  const methods = route.methods || [];
  if (methods.indexOf(method) === -1) {
    return Util.err(ERR.BAD_REQUEST, 'That action cannot be called this way.');
  }

  try {
    // Step 4 — authenticate and authorise, unless the route is public.
    // 'ANY' means any signed-in user, which Auth.require expresses as null roles.
    let session = null;
    if (route.auth !== 'PUBLIC') {
      const allowedRoles = (route.auth === 'ANY') ? null : route.auth;
      session = Auth.require(token, allowedRoles);
    }

    // Step 5 — run the handler.
    const result = route.handler(data, session, e);
    return Util.ok(result, resolveVersion(data));
  } catch (err) {
    // Step 6 — an AppError is something we chose to tell the user about.
    if (err && err.isAppError) {
      return Util.err(err.code, err.message);
    }
    // Anything else is a bug or a Google-side failure. The user gets a fixed
    // sentence; the detail goes to Stackdriver where only we can read it.
    console.error('Unhandled error in action "' + action + '": ' +
      ((err && err.message) ? err.message : String(err)) +
      '\n' + ((err && err.stack) ? err.stack : '(no stack)'));
    return Util.err(ERR.INTERNAL_ERROR, GENERIC_ERROR_MESSAGE);
  }
}

/**
 * Work out the auction state version to stamp on a successful response.
 *
 * Only meaningful when the request is scoped to a tournament, so it keys off the
 * payload. Both camelCase and the sheet's snake_case spelling are accepted
 * because payloads arrive from a hand-written frontend.
 *
 * A cache failure must not turn a successful write into an error, so it degrades
 * to null rather than throwing.
 *
 * @param {!Object} payload the request payload
 * @return {?number} the version, or null when not applicable
 */
function resolveVersion(payload) {
  const tid = payload.tournamentId || payload.tournament_id;
  if (Util.isBlank(tid)) return null;
  try {
    return Cache.getVersion(tid);
  } catch (err) {
    console.error('Cache.getVersion failed for ' + tid + ': ' + err);
    return null;
  }
}

/**
 * Serialise an envelope as a JSON HTTP response. Step 7 of §11.
 *
 * The mime type is JSON on the way out; requests must still come in as
 * text/plain (§11) because Apps Script cannot answer a CORS preflight.
 *
 * @param {!Object} envelope the response envelope
 * @return {!GoogleAppsScript.Content.TextOutput}
 */
function jsonOut(envelope) {
  return ContentService
    .createTextOutput(JSON.stringify(envelope))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Last-resort response for a crash in the dispatcher itself, or in Util/Config.
 *
 * CONTRACTS.md §2 says never hand-build an envelope, and normally that holds.
 * But if Util.err is the thing that is broken, calling it again just throws
 * again and Apps Script would return an HTML error page to a browser that is
 * expecting JSON. So: try the proper builder, then fall back to a literal.
 *
 * @param {*} err whatever was thrown
 * @return {!GoogleAppsScript.Content.TextOutput}
 */
function lastResortOut(err) {
  try {
    console.error('Fatal error in entry point: ' +
      ((err && err.message) ? err.message : String(err)) +
      '\n' + ((err && err.stack) ? err.stack : '(no stack)'));
  } catch (loggingFailed) {
    // Nothing sensible left to do.
  }
  try {
    return jsonOut(Util.err(ERR.INTERNAL_ERROR, GENERIC_ERROR_MESSAGE));
  } catch (builderFailed) {
    return ContentService
      .createTextOutput('{"ok":false,"error":{"code":"INTERNAL_ERROR",' +
        '"message":"Something went wrong. Please try again."}}')
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * HTTP GET entry point — the public read surface only.
 *
 * Shape: /exec?action=<name>&<params>. Everything in e.parameter other than
 * `action` becomes the payload. There is no token on GET, because a token in a
 * URL ends up in browser history, referrers and server logs (DESIGN.md §5.3).
 *
 * Only routes that are both auth:'PUBLIC' and list 'GET' are reachable. Every
 * other case returns the same BAD_REQUEST, on purpose: a FORBIDDEN here would
 * confirm to an anonymous caller that a private action exists.
 *
 * @param {!Object} e Apps Script event object
 * @return {!GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action;

    const payload = {};
    Object.keys(params).forEach((key) => {
      if (key !== 'action') payload[key] = params[key];
    });

    // Pre-filter before dispatch so that a private or POST-only action produces
    // BAD_REQUEST rather than UNAUTHORIZED.
    const routes = buildRoutes();
    const route = (action && typeof action === 'string' &&
      Object.prototype.hasOwnProperty.call(routes, action)) ? routes[action] : null;

    if (!route || route.auth !== 'PUBLIC' ||
        (route.methods || []).indexOf('GET') === -1) {
      return jsonOut(Util.err(ERR.BAD_REQUEST, 'That action is not available.'));
    }

    return jsonOut(dispatch(action, payload, null, 'GET', e));
  } catch (err) {
    return lastResortOut(err);
  }
}

/**
 * HTTP POST entry point — everything that writes, and every authenticated read.
 *
 * Body is JSON text sent as Content-Type: text/plain;charset=utf-8 (§11):
 *   { "action": "auction.markSold", "token": "abc...", "payload": { ... } }
 *
 * @param {!Object} e Apps Script event object
 * @return {!GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  try {
    // Step 1 — the body must exist and be a JSON object.
    if (!e || !e.postData || Util.isBlank(e.postData.contents)) {
      return jsonOut(Util.err(ERR.BAD_REQUEST, 'The request body is missing.'));
    }

    const body = Util.safeJsonParse(e.postData.contents, null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonOut(Util.err(ERR.BAD_REQUEST, 'The request body is not valid JSON.'));
    }

    const action = body.action;
    const token = Util.isBlank(body.token) ? null : String(body.token);
    const payload = (body.payload && typeof body.payload === 'object' &&
      !Array.isArray(body.payload)) ? body.payload : {};

    return jsonOut(dispatch(action, payload, token, 'POST', e));
  } catch (err) {
    return lastResortOut(err);
  }
}
