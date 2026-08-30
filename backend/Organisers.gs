/**
 * Organisers.gs — organiser accounts and their one-time join links.
 * Implements CONTRACTS-PHASE3.md §1. Access model per DESIGN.md §5.4 and §15.
 *
 * Organisers never self-register. An admin creates the account, the backend
 * mints a one-time join link, and opening that link once sets the password and
 * turns it into a real session. Each organiser is locked to exactly one
 * tournament for the life of the account.
 *
 * Three rules in this file are security boundaries rather than preferences:
 *
 *   1. THE PLAIN JOIN TOKEN EXISTS IN EXACTLY ONE PLACE — the response to
 *      organiser.create and organiser.resendLink. It is never written to the
 *      sheet (only its SHA-256 digest is), never returned by organiser.list and
 *      never passed to Audit.log. If the spreadsheet leaks, nothing in it can be
 *      redeemed.
 *   2. organiser.disable revokes every session as well as flipping the status.
 *      Setting status alone would leave a disabled organiser signed in for up to
 *      twelve more hours, which is most of an auction.
 *   3. Rows are never deleted. The audit trail references actor_user_id, and a
 *      deleted user turns every row that names them into an unresolvable id.
 *
 * The token logic itself lives in Auth.gs (Auth.newJoinToken / mintJoinToken /
 * redeemJoinToken / isJoinPending); this file is the admin-facing surface over
 * it. The matching public route, auth.organiserJoin, is in AuthRoutes().
 */

/**
 * Frontend path the join link points at. Paired with `?k=<token>`.
 * The SPA router is path-based (frontend/js/router.js), so this is a real path
 * and not a hash fragment.
 * @const {string}
 */
const ORGANISER_JOIN_PATH = '/organiser/join';

/** Longest display name accepted, matching what the Users tab is for. @const {number} */
const ORGANISER_MAX_NAME_LEN = 60;

const Organisers = {

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Users tab name, tolerating a SHEETS constant that has not loaded yet.
   * @return {string} the Users tab name
   */
  _usersTab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.USERS) ? SHEETS.USERS : 'Users';
  },

  /**
   * Tournaments tab name, same tolerance.
   * @return {string} the Tournaments tab name
   */
  _tournamentsTab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.TOURNAMENTS) ? SHEETS.TOURNAMENTS : 'Tournaments';
  },

  /**
   * Trim a value to a string, treating null/undefined/whitespace as ''.
   * @param {*} v any value
   * @return {string} the trimmed string
   */
  _str(v) {
    return Util.isBlank(v) ? '' : String(v).trim();
  },

  /**
   * The ORGANISER role token.
   * @return {string} 'ORGANISER'
   */
  _roleOrganiser() {
    return (typeof ENUM !== 'undefined' && ENUM.USER_ROLE) ? ENUM.USER_ROLE.ORGANISER : 'ORGANISER';
  },

  /**
   * The origin the SPA is served from, without a trailing slash.
   *
   * Deliberately the same rule Tournaments._frontendBase() applies to
   * registrationUrl and displayUrl, reading the same Config key: read the Config
   * tab, strip a trailing slash, and degrade to '' rather than failing the
   * request. When the key is unset the caller gets a bare path
   * ("/organiser/join?k=..."), which still works when the frontend is
   * same-origin — RUNBOOK part 1 step 7a is where the key gets filled in.
   *
   * @return {string} e.g. "https://example.github.io/cricket-auction", or ''
   */
  _frontendBase() {
    let base = '';
    try {
      base = Organisers._str(Cache.getConfig(CONFIG_KEY_FRONTEND_BASE_URL));
    } catch (e) {
      console.error('Could not read ' + CONFIG_KEY_FRONTEND_BASE_URL + ' from Config: ' + e);
      base = '';
    }
    return base.replace(/\/+$/, '');
  },

  /**
   * Build the one-time join link.
   * @param {string} plainToken the plain join token, shown to the admin once
   * @return {string} absolute URL, or the path alone when no base is configured
   */
  _joinUrl(plainToken) {
    return Organisers._frontendBase() + ORGANISER_JOIN_PATH +
      '?k=' + encodeURIComponent(Organisers._str(plainToken));
  },

  /**
   * Load a tournament row or fail. Creating an organiser for a tournament that
   * does not exist would produce an account nobody can ever use.
   * @param {string} tournamentId the id from the payload
   * @return {!Object} the Tournaments row
   * @throws {Error} VALIDATION_FAILED when blank, NOT_FOUND when unknown
   */
  _requireTournament(tournamentId) {
    const id = Organisers._str(tournamentId);
    if (!id) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }
    const row = Repo.findBy(Organisers._tournamentsTab(), 'tournament_id', id);
    if (!row) {
      // Caller-controlled text, so it is length-capped before it goes into a
      // message the browser will render.
      throw Util.AppError(ERR.NOT_FOUND,
        'No tournament was found with the id "' + id.substring(0, 40) + '".');
    }
    return row;
  },

  /**
   * Load an ORGANISER row by user_id.
   *
   * An ADMIN row is reported as NOT_FOUND rather than FORBIDDEN: these actions
   * exist to manage organisers, and letting organiser.resendLink mint a join
   * link for an admin account would turn it into an unaudited password reset for
   * the most privileged role in the system.
   *
   * @param {string} userId the id from the payload
   * @return {!Object} the Users row, carrying _row
   * @throws {Error} VALIDATION_FAILED when blank, NOT_FOUND when unknown or not an organiser
   */
  _requireOrganiser(userId) {
    const id = Organisers._str(userId);
    if (!id) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A user id is required.');
    }
    const row = Repo.findBy(Organisers._usersTab(), 'user_id', id);
    if (!row || Organisers._str(row.role).toUpperCase() !== Organisers._roleOrganiser()) {
      throw Util.AppError(ERR.NOT_FOUND,
        'No organiser was found with the id "' + id.substring(0, 40) + '".');
    }
    return row;
  },

  /**
   * The join-link half of a create or resendLink response.
   * @param {string} plainToken the plain token, used here and then discarded
   * @param {string} expiresAt ISO instant the link stops working
   * @return {!Object} {joinUrl, joinExpiresAt, joinExpiresAtDisplay}
   */
  _linkFields(plainToken, expiresAt) {
    return {
      joinUrl: Organisers._joinUrl(plainToken),
      joinExpiresAt: expiresAt,
      // The admin has to tell someone when the link dies, so give them the
      // IST wording rather than a UTC timestamp to translate in their head.
      joinExpiresAtDisplay: Util.formatIST(expiresAt)
    };
  },

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  /**
   * Create an organiser account with no password and issue its join link.
   *
   * The row is written with `password_hash` and `salt` blank on purpose: until
   * the organiser redeems the link there is no password to guess, and
   * Auth.login's `stored && ...` check means a blank hash can never authenticate.
   *
   * @param {!Object} payload {tournamentId, email, displayName}
   * @param {!Object} session ADMIN session
   * @return {!Object} {user_id, email, display_name, tournament_id, joinUrl,
   *     joinExpiresAt, joinExpiresAtDisplay}
   * @throws {Error} VALIDATION_FAILED on a bad field or a duplicate email,
   *     NOT_FOUND on an unknown tournament
   */
  create(payload, session) {
    const p = payload || {};
    const tournament = Organisers._requireTournament(p.tournamentId || p.tournament_id);
    const tournamentId = Organisers._str(tournament.tournament_id);

    // Email shape, normalisation and the duplicate lookup all come from Auth.
    // Auth owns the Users tab and the login lookup; a second definition of
    // "the same email address" living here is exactly how an organiser account
    // ends up shadowing an admin one.
    const email = Auth._normEmail(p.email);
    if (!Auth._looksLikeEmail(email)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'Email: "' + Organisers._str(p.email).substring(0, 60) + '" is not a valid email address.');
    }

    const displayName = Organisers._str(p.displayName || p.display_name);
    if (!displayName) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Display name is required.');
    }
    if (displayName.length > ORGANISER_MAX_NAME_LEN) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'Display name: must be ' + ORGANISER_MAX_NAME_LEN + ' characters or fewer. You entered ' +
        displayName.length + '.');
    }

    const actor = (session && session.user_id) ? String(session.user_id) : '';
    const minted = Auth.newJoinToken();

    // Locked so that the duplicate-email check and the append are one step. Two
    // admins adding the same organiser at the same moment would otherwise both
    // read "not present" and both write a row.
    const row = Repo.withLock(() => {
      if (Auth._findUserByEmail(email)) {
        throw Util.AppError(ERR.VALIDATION_FAILED, 'Email: ' + email + ' is already registered.');
      }
      return Repo.append(Organisers._usersTab(), {
        user_id: Util.uid((typeof ID_PREFIX !== 'undefined' && ID_PREFIX.USER) ? ID_PREFIX.USER : 'USR_'),
        email: email,
        display_name: displayName,
        password_hash: '',
        salt: '',
        role: Organisers._roleOrganiser(),
        tournament_id: tournamentId,
        status: (typeof ENUM !== 'undefined' && ENUM.USER_STATUS) ? ENUM.USER_STATUS.ACTIVE : 'ACTIVE',
        created_at: Util.nowIso(),
        created_by: actor,
        last_login_at: '',
        // Only the digest. The plain token is in the response and nowhere else.
        join_token_hash: minted.hash,
        join_expires_at: minted.expiresAt,
        join_used_at: ''
      });
    });

    Audit.log({
      actor: actor || 'SYSTEM',
      role: session ? session.role : 'ADMIN',
      action: Audit.ACTIONS.ORGANISER_CREATED,
      tournamentId: tournamentId,
      entityType: 'USER',
      entityId: row.user_id,
      prev: null,
      // join_expires_at is recorded; the token is not.
      next: {
        email: email,
        display_name: displayName,
        role: row.role,
        tournament_id: tournamentId,
        join_expires_at: minted.expiresAt
      }
    });

    return Object.assign({
      user_id: row.user_id,
      email: email,
      display_name: displayName,
      tournament_id: tournamentId
    }, Organisers._linkFields(minted.token, minted.expiresAt));
  },

  /**
   * List the organisers of one tournament.
   *
   * The response is assembled field by field from a literal allow-list, not
   * copied from the row: join_token_hash, password_hash and salt live on the
   * same object and a spread would ship all three.
   *
   * @param {!Object} payload {tournamentId}
   * @param {!Object} session ADMIN session
   * @return {!Array<!Object>} [{user_id, email, display_name, status, created_at,
   *     last_login_at, joinPending}]
   * @throws {Error} VALIDATION_FAILED when blank, NOT_FOUND on an unknown tournament
   */
  list(payload, session) {
    const p = payload || {};
    const tournament = Organisers._requireTournament(p.tournamentId || p.tournament_id);
    const tournamentId = Organisers._str(tournament.tournament_id);

    const rows = Repo.filterBy(Organisers._usersTab(), {
      tournament_id: tournamentId,
      role: Organisers._roleOrganiser()
    });

    rows.sort((a, b) => {
      const x = Organisers._str(a.created_at);
      const y = Organisers._str(b.created_at);
      return x < y ? -1 : (x > y ? 1 : 0);
    });

    return rows.map((r) => ({
      user_id: Organisers._str(r.user_id),
      email: Organisers._str(r.email),
      display_name: Organisers._str(r.display_name),
      status: Organisers._str(r.status),
      created_at: Organisers._str(r.created_at),
      last_login_at: Organisers._str(r.last_login_at),
      // The one safe fact about the token: whether it is still waiting.
      joinPending: Auth.isJoinPending(r)
    }));
  },

  /**
   * Issue a fresh join link, invalidating the previous one.
   *
   * Links get lost in forwarded messages and expire over a long weekend, so this
   * is a routine operation rather than an exception. Because it also resets the
   * password path, it is the admin's way of recovering an organiser who has
   * forgotten theirs — which is why it is audited separately.
   *
   * @param {!Object} payload {userId}
   * @param {!Object} session ADMIN session
   * @return {!Object} {user_id, email, display_name, tournament_id, joinUrl,
   *     joinExpiresAt, joinExpiresAtDisplay}
   * @throws {Error} NOT_FOUND on an unknown organiser, VALIDATION_FAILED when disabled
   */
  resendLink(payload, session) {
    const p = payload || {};
    const user = Organisers._requireOrganiser(p.userId || p.user_id);

    const active = (typeof ENUM !== 'undefined' && ENUM.USER_STATUS) ? ENUM.USER_STATUS.ACTIVE : 'ACTIVE';
    if (Organisers._str(user.status).toUpperCase() !== active) {
      // Handing a working link to a disabled account would silently undo the
      // disable, so re-enabling has to be a deliberate, separate decision.
      throw Util.AppError(ERR.VALIDATION_FAILED,
        Organisers._str(user.email) + ' is disabled, so a join link cannot be sent.');
    }

    const minted = Auth.mintJoinToken(user.user_id);
    const actor = (session && session.user_id) ? String(session.user_id) : '';

    Audit.log({
      actor: actor || 'SYSTEM',
      role: session ? session.role : 'ADMIN',
      action: Audit.ACTIONS.ORGANISER_LINK_RESENT,
      tournamentId: Organisers._str(user.tournament_id),
      entityType: 'USER',
      entityId: Organisers._str(user.user_id),
      prev: { join_expires_at: Organisers._str(user.join_expires_at) },
      next: { join_expires_at: minted.expiresAt }
    });

    return Object.assign({
      user_id: Organisers._str(user.user_id),
      email: Organisers._str(user.email),
      display_name: Organisers._str(user.display_name),
      tournament_id: Organisers._str(user.tournament_id)
    }, Organisers._linkFields(minted.token, minted.expiresAt));
  },

  /**
   * Disable an organiser: flip the status, kill every session they hold, and
   * void any join link still outstanding.
   *
   * Safe to call twice — a second call on an already-disabled account is not an
   * error, it just re-revokes nothing.
   *
   * @param {!Object} payload {userId}
   * @param {!Object} session ADMIN session
   * @return {!Object} {user_id, email, display_name, status, sessions_revoked}
   * @throws {Error} NOT_FOUND on an unknown organiser
   */
  disable(payload, session) {
    const p = payload || {};
    const user = Organisers._requireOrganiser(p.userId || p.user_id);
    const disabled = (typeof ENUM !== 'undefined' && ENUM.USER_STATUS)
      ? ENUM.USER_STATUS.DISABLED : 'DISABLED';
    const prevStatus = Organisers._str(user.status);

    // Locked, and paired with the lock in Auth.redeemJoinToken: an organiser
    // redeeming their link at this exact moment must either finish first (and
    // then have their brand new session revoked here) or see DISABLED and fail.
    // Interleaved, the two read-modify-writes could leave a disabled account
    // holding a live session.
    const revoked = Repo.withLock(() => {
      Repo.updateRow(Organisers._usersTab(), user._row, {
        status: disabled,
        // An unredeemed link on a disabled account is a way back in. Auth.
        // redeemJoinToken also refuses a non-ACTIVE row, so this is the second
        // of two locks on the same door.
        join_token_hash: ''
      });

      // Status alone is not enough: Auth.resolve reads the Sessions row, not the
      // Users row, so a live token would keep working until it expired.
      return Auth.revokeAllSessions(user.user_id);
    });

    const actor = (session && session.user_id) ? String(session.user_id) : '';
    Audit.log({
      actor: actor || 'SYSTEM',
      role: session ? session.role : 'ADMIN',
      action: Audit.ACTIONS.ORGANISER_DISABLED,
      tournamentId: Organisers._str(user.tournament_id),
      entityType: 'USER',
      entityId: Organisers._str(user.user_id),
      prev: { status: prevStatus },
      next: { status: disabled, sessions_revoked: revoked }
    });

    return {
      user_id: Organisers._str(user.user_id),
      email: Organisers._str(user.email),
      display_name: Organisers._str(user.display_name),
      status: disabled,
      sessions_revoked: revoked
    };
  }
};

/**
 * Organiser route table.
 *
 * Built inside a function, never at load time: Apps Script concatenates .gs
 * files in an undefined order (CONTRACTS.md §11).
 *
 * Every entry is ADMIN-only and POST-only. There is no public organiser route
 * here — the one action an organiser can call without an account is
 * auth.organiserJoin, which lives in AuthRoutes() in Code.gs.
 *
 * @return {!Object} route table fragment
 */
function OrganiserRoutes() {
  return {
    'organiser.create': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, email, displayName}
       * @param {!Object} session ADMIN session
       * @return {!Object} the new organiser plus its one-time joinUrl
       */
      handler: (payload, session) => Organisers.create(payload, session)
    },

    'organiser.list': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ADMIN session
       * @return {!Array<!Object>} organisers, never carrying a token
       */
      handler: (payload, session) => Organisers.list(payload, session)
    },

    'organiser.resendLink': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {userId}
       * @param {!Object} session ADMIN session
       * @return {!Object} a fresh joinUrl; the previous link stops working
       */
      handler: (payload, session) => Organisers.resendLink(payload, session)
    },

    'organiser.disable': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {userId}
       * @param {!Object} session ADMIN session
       * @return {!Object} {user_id, email, display_name, status, sessions_revoked}
       */
      handler: (payload, session) => Organisers.disable(payload, session)
    }
  };
}
