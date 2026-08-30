/**
 * Auth.gs — authentication, sessions and authorisation.
 * Implements CONTRACTS.md §7. Password scheme per DESIGN.md §5.2.
 *
 * Security notes that are easy to undo by accident:
 *  - Every login failure returns the SAME message. Telling the caller
 *    "no such user" vs "wrong password" hands an attacker a user-enumeration
 *    oracle for free.
 *  - requireTournament() is the only thing standing between one organiser and
 *    another organiser's data. Treat it as a boundary, not a convenience check.
 */
const Auth = {

  /** Generic message for every credential failure. Never make this specific. */
  BAD_CREDENTIALS_MSG: 'Email or password is incorrect.',

  /** Consecutive failures before the account is locked (DESIGN §16 risk 6). */
  MAX_LOGIN_FAILURES: 5,

  /** Lockout / failure-counter window, in seconds. */
  LOGIN_FAIL_TTL_SEC: 900,

  /** Minimum password length (DESIGN §16 risk 6). */
  MIN_PASSWORD_LEN: 10,

  /**
   * Generic message for every organiser join-link failure — unknown, already
   * used, expired, or the account is disabled. Never make this specific: a
   * message that distinguishes "already used" from "no such token" tells an
   * attacker which tokens exist, which is the same oracle BAD_CREDENTIALS_MSG
   * exists to close.
   */
  BAD_JOIN_LINK_MSG: 'This join link is not valid. It may have already been used or expired. ' +
    'Ask the admin to send you a new one.',

  /** Random bytes in a join token (CONTRACTS-PHASE3 §1). */
  JOIN_TOKEN_BYTES: 32,

  /** Join-link lifetime: long enough to survive a weekend, short enough to matter. */
  JOIN_TOKEN_TTL_HOURS: 72,

  // ---------------------------------------------------------------- login

  /**
   * Verify credentials and mint a session.
   *
   * @param {string} email Case-insensitive; trimmed and lowercased here.
   * @param {string} password Plain text password as typed.
   * @param {string} [ua] User agent string, recorded in the audit log only.
   * @return {{token:string, expiresAt:string,
   *           user:{user_id:string, display_name:string, role:string, tournament_id:string}}}
   * @throws {Error} UNAUTHORIZED when locked out or the credentials are wrong.
   */
  login(email, password, ua) {
    const em = Auth._normEmail(email);
    const failKey = Auth._failKey(em);

    // Lockout is checked before anything else so a locked account costs an
    // attacker one cache read and gives them no signal about the password.
    if (Auth._failureCount(failKey) >= Auth.MAX_LOGIN_FAILURES) {
      Auth._auditLoginFailed(em, 'LOCKED_OUT', ua);
      throw Util.AppError(
        ERR.UNAUTHORIZED,
        'Too many failed sign-in attempts. This account is locked for 15 minutes. Please try again later.'
      );
    }

    const user = Auth._findUserByEmail(em);

    // All three failure modes (unknown email, disabled account, wrong password)
    // fall through to the same branch with the same message.
    let ok = false;
    if (user && String(user.status || '').toUpperCase() === 'ACTIVE') {
      const stored = String(user.password_hash || '');
      if (stored && !Util.isBlank(password)) {
        const computed = Util.hashPassword(String(password), String(user.salt || ''), Auth._pepper());
        ok = Auth._constantTimeEquals(computed, stored);
      }
    }

    if (!ok) {
      Auth._recordFailure(failKey);
      Auth._auditLoginFailed(em, user ? 'BAD_CREDENTIALS' : 'NO_SUCH_USER', ua);
      throw Util.AppError(ERR.UNAUTHORIZED, Auth.BAD_CREDENTIALS_MSG);
    }

    Cache.del(failKey);

    const session = Auth._createSession(user, ua);
    const now = Util.nowIso();
    try {
      Repo.updateRow(Auth._tab('USERS', 'Users'), user._row, { last_login_at: now });
    } catch (err) {
      // A stale last_login_at is not worth failing a valid sign-in over.
      console.error('Auth.login: could not update last_login_at for ' + user.user_id + ': ' + err);
    }

    Audit.log({
      actor: user.user_id,
      role: user.role,
      action: Audit.ACTIONS.LOGIN_SUCCESS,
      tournamentId: user.tournament_id || '',
      entityType: 'USER',
      entityId: user.user_id,
      prev: null,
      next: { email: em, at: now },
      ua: ua
    });

    return {
      token: session.token,
      expiresAt: session.expires_at,
      user: {
        user_id: user.user_id,
        display_name: user.display_name,
        role: user.role,
        tournament_id: user.tournament_id || ''
      }
    };
  },

  /**
   * Revoke a session. Safe to call with an unknown or already-dead token.
   *
   * @param {string} token Session token.
   * @return {void}
   */
  logout(token) {
    if (Util.isBlank(token)) return;
    const t = String(token);
    try {
      Cache.delSession(t);
    } catch (err) {
      console.error('Auth.logout: cache delete failed: ' + err);
    }
    try {
      Repo.updateBy(Auth._tab('SESSIONS', 'Sessions'), 'token', t, { revoked: true });
    } catch (err) {
      // Cache is already cleared, so the token is dead on the fast path either way.
      console.error('Auth.logout: could not revoke session row: ' + err);
    }
  },

  // ------------------------------------------------------------- sessions

  /**
   * Resolve a token to a live session. Cache first, sheet as the durable
   * fallback (DESIGN §5.3). Never throws — a broken token is just `null`.
   *
   * @param {string} token Session token.
   * @return {{user_id:string, role:string, tournament_id:string, expires_at:string, token:string}|null}
   */
  resolve(token) {
    if (Util.isBlank(token)) return null;
    const t = String(token);

    try {
      let sess = null;

      try {
        sess = Cache.getSession(t);
      } catch (err) {
        console.error('Auth.resolve: cache read failed: ' + err);
      }

      let fromCache = true;
      if (!sess || !sess.user_id) {
        fromCache = false;
        const row = Repo.findBy(Auth._tab('SESSIONS', 'Sessions'), 'token', t);
        if (!row) return null;
        sess = {
          token: t,
          user_id: row.user_id,
          role: row.role,
          tournament_id: row.tournament_id || '',
          expires_at: row.expires_at,
          revoked: Auth._isTrue(row.revoked)
        };
      }

      if (Auth._isTrue(sess.revoked)) return null;

      const expiresMs = Auth._parseIsoMs(sess.expires_at);
      if (expiresMs === null || expiresMs <= Date.now()) return null;

      // Cold cache but a good sheet row: warm the cache so the next call is fast.
      if (!fromCache) {
        try {
          Cache.putSession(t, sess);
        } catch (err) {
          console.error('Auth.resolve: cache write failed: ' + err);
        }
      }

      return {
        token: t,
        user_id: sess.user_id,
        role: sess.role,
        tournament_id: sess.tournament_id || '',
        expires_at: sess.expires_at
      };
    } catch (err) {
      console.error('Auth.resolve failed: ' + err);
      return null;
    }
  },

  /**
   * Resolve a token and enforce a role requirement.
   *
   * @param {string} token Session token.
   * @param {(string[]|string|null)} allowedRoles Array of roles, or `null` /
   *     `'ANY'` for "any authenticated user".
   * @return {{user_id:string, role:string, tournament_id:string, expires_at:string, token:string}}
   * @throws {Error} UNAUTHORIZED when the token is dead, FORBIDDEN on wrong role.
   */
  require(token, allowedRoles) {
    const session = Auth.resolve(token);
    if (!session) throw Util.AppError(ERR.UNAUTHORIZED, 'Please sign in again.');

    if (allowedRoles === null || allowedRoles === undefined || allowedRoles === 'ANY') {
      return session;
    }

    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (roles.indexOf(session.role) === -1) {
      throw Util.AppError(ERR.FORBIDDEN, 'You do not have access to this action.');
    }
    return session;
  },

  /**
   * Enforce tournament scope. ADMIN sees every tournament; ORGANISER sees
   * exactly one (DESIGN §5.4). Fails closed when the id is missing.
   *
   * @param {{role:string, tournament_id:string}} session Session from require().
   * @param {string} tournamentId Tournament the action is about to touch.
   * @return {void}
   * @throws {Error} UNAUTHORIZED without a session, FORBIDDEN on a scope mismatch.
   */
  requireTournament(session, tournamentId) {
    if (!session) throw Util.AppError(ERR.UNAUTHORIZED, 'Please sign in again.');
    if (session.role === 'ADMIN') return;

    const want = Util.isBlank(tournamentId) ? '' : String(tournamentId).trim();
    const have = Util.isBlank(session.tournament_id) ? '' : String(session.tournament_id).trim();

    if (!want || !have || want !== have) {
      throw Util.AppError(
        ERR.FORBIDDEN,
        'You only have access to your own tournament.'
      );
    }
  },

  // ----------------------------------------------------------------- users

  /**
   * Create a user. Password is hashed before it touches the sheet and the
   * returned object never carries `password_hash` or `salt`.
   *
   * @param {{email:string, displayName:string, password:string, role:string,
   *          tournamentId:(string|undefined)}} spec New user details.
   * @param {string} [actorUserId] user_id of the admin doing this, for the audit row.
   * @return {Object} The created user row, minus the secrets.
   * @throws {Error} VALIDATION_FAILED on any bad field or a duplicate email.
   */
  createUser(spec, actorUserId) {
    const s = spec || {};
    const email = Auth._normEmail(s.email);
    const displayName = Util.isBlank(s.displayName) ? '' : String(s.displayName).trim();
    const role = Util.isBlank(s.role) ? '' : String(s.role).trim().toUpperCase();
    const tournamentId = Util.isBlank(s.tournamentId) ? '' : String(s.tournamentId).trim();
    const password = s.password == null ? '' : String(s.password);

    if (!Auth._looksLikeEmail(email)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Email: "' + (s.email || '') + '" is not a valid email address.');
    }
    if (!displayName) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Display name is required.');
    }
    if (role !== 'ADMIN' && role !== 'ORGANISER') {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Role must be ADMIN or ORGANISER.');
    }
    Auth._validatePassword(password);

    if (role === 'ORGANISER' && !tournamentId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'An organiser must be linked to exactly one tournament.');
    }
    if (role === 'ADMIN' && tournamentId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'An admin is not tied to a tournament, so tournament must be left blank.');
    }
    if (Auth._findUserByEmail(email)) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'Email: ' + email + ' is already registered.');
    }

    const salt = Util.randomToken(16);
    const now = Util.nowIso();
    const row = {
      user_id: Util.uid(Auth._idPrefix('USER', 'USR_')),
      email: email,
      display_name: displayName,
      password_hash: Util.hashPassword(password, salt, Auth._pepper()),
      salt: salt,
      role: role,
      tournament_id: tournamentId,
      status: 'ACTIVE',
      created_at: now,
      created_by: Util.isBlank(actorUserId) ? '' : String(actorUserId),
      last_login_at: ''
    };

    const created = Repo.append(Auth._tab('USERS', 'Users'), row);

    Audit.log({
      actor: actorUserId || 'SYSTEM',
      role: 'ADMIN',
      action: Audit.ACTIONS.ORGANISER_CREATED,
      tournamentId: tournamentId,
      entityType: 'USER',
      entityId: row.user_id,
      prev: null,
      next: { email: email, display_name: displayName, role: role, tournament_id: tournamentId }
    });

    return Auth._publicUser(created || row);
  },

  /**
   * Replace a user's password with a fresh salt and hash, then kill every
   * session they hold — a password change must log out the old device.
   *
   * @param {string} userId Target user_id.
   * @param {string} newPlain New plain text password.
   * @return {void}
   * @throws {Error} VALIDATION_FAILED on a weak password, NOT_FOUND on a bad user_id.
   */
  setPassword(userId, newPlain) {
    Auth._validatePassword(newPlain == null ? '' : String(newPlain));

    const user = Repo.findBy(Auth._tab('USERS', 'Users'), 'user_id', userId);
    if (!user) throw Util.AppError(ERR.NOT_FOUND, 'No user found with id ' + userId + '.');

    const salt = Util.randomToken(16);
    Repo.updateRow(Auth._tab('USERS', 'Users'), user._row, {
      salt: salt,
      password_hash: Util.hashPassword(String(newPlain), salt, Auth._pepper())
    });

    Auth.revokeAllSessions(user.user_id);
  },

  /**
   * Revoke every session belonging to a user, in the sheet and in the cache.
   *
   * @param {string} userId Target user_id.
   * @return {number} How many sessions were revoked.
   */
  revokeAllSessions(userId) {
    if (Util.isBlank(userId)) return 0;
    const tab = Auth._tab('SESSIONS', 'Sessions');
    let n = 0;
    try {
      const rows = Repo.filterBy(tab, { user_id: String(userId) });
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (Auth._isTrue(row.revoked)) continue;
        Repo.updateRow(tab, row._row, { revoked: true });
        try {
          Cache.delSession(row.token);
        } catch (err) {
          console.error('Auth.revokeAllSessions: cache delete failed: ' + err);
        }
        n++;
      }
    } catch (err) {
      console.error('Auth.revokeAllSessions failed for ' + userId + ': ' + err);
    }
    return n;
  },

  // -------------------------------------------- organiser join tokens

  /**
   * Generate a one-time organiser join token and its stored form.
   *
   * The caller writes `hash` and `expiresAt` to the Users row and hands `token`
   * straight back to the admin in the HTTP response. THE PLAIN TOKEN MUST NEVER
   * BE STORED OR LOGGED — if the sheet leaks, only the digest is in it, and a
   * digest cannot be redeemed.
   *
   * @return {{token:string, hash:string, expiresAt:string}} Plain token, its
   *     SHA-256 digest, and the ISO instant it stops working.
   */
  newJoinToken() {
    const token = Util.randomToken(Auth.JOIN_TOKEN_BYTES);
    return {
      token: token,
      hash: Util.sha256Hex(token),
      expiresAt: new Date(Date.now() + Auth.JOIN_TOKEN_TTL_HOURS * 3600 * 1000).toISOString()
    };
  },

  /**
   * Issue a fresh join token for an existing user, invalidating any previous
   * one — the old plain token no longer hashes to anything stored.
   *
   * @param {string} userId Target user_id.
   * @return {{user_id:string, token:string, expiresAt:string}} The plain token,
   *     which the caller must show once and never persist.
   * @throws {Error} VALIDATION_FAILED on a blank id, NOT_FOUND on an unknown one.
   */
  mintJoinToken(userId) {
    const id = Util.isBlank(userId) ? '' : String(userId).trim();
    if (!id) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A user id is required to issue a join link.');
    }

    const usersTab = Auth._tab('USERS', 'Users');
    const user = Repo.findBy(usersTab, 'user_id', id);
    if (!user) throw Util.AppError(ERR.NOT_FOUND, 'No user found with id ' + id + '.');

    const minted = Auth.newJoinToken();
    Repo.updateRow(usersTab, user._row, {
      join_token_hash: minted.hash,
      join_expires_at: minted.expiresAt,
      // A reissued link is unused again, whatever happened to the last one.
      join_used_at: ''
    });

    return { user_id: user.user_id, token: minted.token, expiresAt: minted.expiresAt };
  },

  /**
   * Is a user's join link still waiting to be used?
   *
   * This is the only thing about a join token that is safe to show in a list —
   * the token and its hash never leave the backend.
   *
   * @param {Object} userRow A Users row.
   * @return {boolean} True while a token exists, is unused and has not expired.
   */
  isJoinPending(userRow) {
    if (!userRow) return false;
    if (Util.isBlank(userRow.join_token_hash)) return false;
    if (!Util.isBlank(userRow.join_used_at)) return false;
    const expiresMs = Auth._parseIsoMs(userRow.join_expires_at);
    return expiresMs !== null && expiresMs > Date.now();
  },

  /**
   * Exchange a one-time join token for a password and a real session.
   *
   * Returns exactly the shape Auth.login returns, so the frontend stores the
   * session the same way after joining as after signing in.
   *
   * @param {string} token The plain join token from the `?k=` parameter.
   * @param {string} password The password the organiser is choosing.
   * @param {string} [ua] User agent, recorded in the audit log only.
   * @return {{token:string, expiresAt:string,
   *           user:{user_id:string, display_name:string, role:string, tournament_id:string}}}
   * @throws {Error} UNAUTHORIZED for any bad token, VALIDATION_FAILED for a weak password.
   */
  redeemJoinToken(token, password, ua) {
    const plain = Util.isBlank(token) ? '' : String(token).trim();
    // A missing token gets the same sentence as a wrong one.
    if (!plain) throw Util.AppError(ERR.UNAUTHORIZED, Auth.BAD_JOIN_LINK_MSG);

    const hash = Util.sha256Hex(plain);
    const usersTab = Auth._tab('USERS', 'Users');

    // THE TOKEN IS BURNED IN THE SAME LOCKED SECTION THAT SETS THE PASSWORD.
    // Validating here and burning in a second step would leave a window where
    // two requests carrying the same link both pass validation, and a token
    // that survives its own use is a permanent back door into the account.
    const outcome = Repo.withLock(() => {
      const row = Auth._findUserByJoinTokenHash(hash);

      // Unknown token, disabled account, already-used link and expired link all
      // fall through to the same branch with the same message.
      if (!row ||
          String(row.status || '').toUpperCase() !== 'ACTIVE' ||
          !Util.isBlank(row.join_used_at)) {
        throw Util.AppError(ERR.UNAUTHORIZED, Auth.BAD_JOIN_LINK_MSG);
      }
      const expiresMs = Auth._parseIsoMs(row.join_expires_at);
      if (expiresMs === null || expiresMs <= Date.now()) {
        throw Util.AppError(ERR.UNAUTHORIZED, Auth.BAD_JOIN_LINK_MSG);
      }

      // Password rules are identical to createUser. This throws before anything
      // is written, so a too-short password leaves the link usable and the
      // organiser simply tries again.
      Auth._validatePassword(password == null ? '' : String(password));

      const salt = Util.randomToken(16);
      const merged = Repo.updateRow(usersTab, row._row, {
        salt: salt,
        password_hash: Util.hashPassword(String(password), salt, Auth._pepper()),
        // Clearing the hash is the burn; join_used_at records that it happened.
        join_token_hash: '',
        join_used_at: Util.nowIso()
      });

      // The session is minted inside the same lock as well. Organisers.disable
      // revokes sessions under this lock too, so an admin disabling the account
      // at this exact moment cannot slip between the two writes and leave a live
      // session behind on a disabled organiser.
      return { user: merged, session: Auth._createSession(merged, ua) };
    });

    const user = outcome.user;
    const session = outcome.session;
    const now = Util.nowIso();
    try {
      Repo.updateRow(usersTab, user._row, { last_login_at: now });
    } catch (err) {
      // A stale last_login_at is not worth failing a completed join over.
      console.error('Auth.redeemJoinToken: could not update last_login_at for ' +
        user.user_id + ': ' + err);
    }

    Audit.log({
      actor: user.user_id,
      role: user.role,
      action: Audit.ACTIONS.ORGANISER_CREATED,
      tournamentId: user.tournament_id || '',
      entityType: 'USER',
      entityId: user.user_id,
      prev: null,
      // The plain token is deliberately absent — the audit trail records that a
      // join happened, never the secret that made it possible.
      next: { email: user.email, joined: true, at: now },
      ua: ua
    });

    return {
      token: session.token,
      expiresAt: session.expires_at,
      user: {
        user_id: user.user_id,
        display_name: user.display_name,
        role: user.role,
        tournament_id: user.tournament_id || ''
      }
    };
  },

  /**
   * Check a projector display token (DESIGN §5.5). Read-only surface, so this
   * answers with a boolean and never throws.
   *
   * @param {string} tournamentId Tournament being displayed.
   * @param {string} token The `k` query parameter.
   * @return {boolean} True only on an exact match against a non-blank token.
   */
  verifyDisplayToken(tournamentId, token) {
    try {
      if (Util.isBlank(tournamentId) || Util.isBlank(token)) return false;
      const trn = Repo.findBy(Auth._tab('TOURNAMENTS', 'Tournaments'), 'tournament_id', String(tournamentId));
      if (!trn || Util.isBlank(trn.display_token)) return false;
      return Auth._constantTimeEquals(String(trn.display_token), String(token));
    } catch (err) {
      console.error('Auth.verifyDisplayToken failed: ' + err);
      return false;
    }
  },

  // -------------------------------------------------------------- internals

  /**
   * Mint a session row plus its cache mirror.
   * @param {Object} user Users row.
   * @param {string} [ua] User agent, not stored on the session row.
   * @return {Object} The session row that was written.
   */
  _createSession(user, ua) {
    const hours = Number((typeof DEFAULTS !== 'undefined' && DEFAULTS.session_hours) || 12) || 12;
    const issuedAt = Util.nowIso();
    const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

    const row = {
      token: Util.randomToken(32),
      user_id: user.user_id,
      role: user.role,
      tournament_id: user.tournament_id || '',
      issued_at: issuedAt,
      expires_at: expiresAt,
      revoked: false
    };

    Repo.append(Auth._tab('SESSIONS', 'Sessions'), row);

    // Cache TTL is capped at 6 h by Cache.gs while the row lives 12 h. That gap
    // is fine: resolve() falls back to the sheet once the cache entry drops.
    try {
      Cache.putSession(row.token, {
        token: row.token,
        user_id: row.user_id,
        role: row.role,
        tournament_id: row.tournament_id,
        expires_at: row.expires_at,
        revoked: false
      });
    } catch (err) {
      console.error('Auth._createSession: cache write failed: ' + err);
    }

    return row;
  },

  /**
   * Compare two hex strings without leaking length or position through timing.
   * Loops over every character and never early-returns.
   * @param {string} a First string.
   * @param {string} b Second string.
   * @return {boolean} True when identical.
   */
  _constantTimeEquals(a, b) {
    const s1 = a == null ? '' : String(a);
    const s2 = b == null ? '' : String(b);
    let diff = s1.length ^ s2.length;
    const n = Math.max(s1.length, s2.length);
    for (let i = 0; i < n; i++) {
      const c1 = i < s1.length ? s1.charCodeAt(i) : 0;
      const c2 = i < s2.length ? s2.charCodeAt(i) : 0;
      diff |= (c1 ^ c2);
    }
    return diff === 0;
  },

  /**
   * Read the server pepper (DESIGN §5.2). Cache first, Config tab as fallback.
   * @return {string} The pepper.
   * @throws {Error} INTERNAL_ERROR when it is missing.
   */
  _pepper() {
    let pepper = null;
    try {
      pepper = Cache.getConfig('pepper');
    } catch (err) {
      console.error('Auth._pepper: cache read failed: ' + err);
    }
    if (Util.isBlank(pepper)) {
      const row = Repo.findBy(Auth._tab('CONFIG', 'Config'), 'key', 'pepper');
      pepper = row ? row.value : null;
    }
    // Falling back to an empty pepper would silently weaken every hash in the
    // sheet, so this is a hard stop rather than a warning.
    if (Util.isBlank(pepper)) {
      throw Util.AppError(
        ERR.INTERNAL_ERROR,
        'The server is not set up yet: the password pepper is missing from the Config tab. Run setup() once, then try again.'
      );
    }
    return String(pepper);
  },

  /**
   * Case-insensitive user lookup. Scans the whole (small) Users tab so that a
   * row saved with mixed case still matches.
   * @param {string} normalisedEmail Already lowercased and trimmed.
   * @return {Object|null} The Users row, or null.
   */
  _findUserByEmail(normalisedEmail) {
    if (!normalisedEmail) return null;
    const rows = Repo.readAll(Auth._tab('USERS', 'Users'));
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i].email;
      if (e && String(e).trim().toLowerCase() === normalisedEmail) return rows[i];
    }
    return null;
  },

  /**
   * Find the user holding a join token, by its stored digest.
   *
   * A blank digest never matches, so the many rows with an empty
   * join_token_hash cell cannot be redeemed with an empty token. The compare is
   * constant time and the loop never early-returns, for the same reason login's
   * password compare does not.
   *
   * @param {string} hash SHA-256 hex digest of the supplied token.
   * @return {Object|null} The Users row, or null.
   */
  _findUserByJoinTokenHash(hash) {
    const want = Util.isBlank(hash) ? '' : String(hash).trim().toLowerCase();
    if (!want) return null;
    const rows = Repo.readAll(Auth._tab('USERS', 'Users'));
    let found = null;
    for (let i = 0; i < rows.length; i++) {
      const stored = Util.isBlank(rows[i].join_token_hash)
        ? '' : String(rows[i].join_token_hash).trim().toLowerCase();
      if (stored && Auth._constantTimeEquals(stored, want)) found = rows[i];
    }
    return found;
  },

  /**
   * @param {string} password Plain text password.
   * @return {void}
   * @throws {Error} VALIDATION_FAILED when shorter than the minimum.
   */
  _validatePassword(password) {
    const p = password == null ? '' : String(password);
    if (p.length < Auth.MIN_PASSWORD_LEN) {
      throw Util.AppError(
        ERR.VALIDATION_FAILED,
        'Password: must be at least ' + Auth.MIN_PASSWORD_LEN + ' characters. You entered ' + p.length + '.'
      );
    }
  },

  /**
   * @param {string} email Raw email input.
   * @return {string} Trimmed, lowercased email ('' when blank).
   */
  _normEmail(email) {
    return Util.isBlank(email) ? '' : String(email).trim().toLowerCase();
  },

  /**
   * @param {string} email Normalised email.
   * @return {boolean} True when it is shaped like an email address.
   */
  _looksLikeEmail(email) {
    if (!email || email.length > 254) return false;
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
  },

  /**
   * @param {string} email Normalised email.
   * @return {string} Cache key for the failure counter.
   */
  _failKey(email) {
    return 'login_fail:' + email;
  },

  /**
   * @param {string} failKey Cache key from _failKey.
   * @return {number} Consecutive failures recorded so far.
   */
  _failureCount(failKey) {
    try {
      const raw = Cache.getRaw(failKey);
      const n = Number(raw);
      return isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch (err) {
      // A cache outage must not lock everyone out, so treat it as zero failures.
      console.error('Auth._failureCount: cache read failed: ' + err);
      return 0;
    }
  },

  /**
   * Bump the failure counter, refreshing the 15 minute window.
   * @param {string} failKey Cache key from _failKey.
   * @return {void}
   */
  _recordFailure(failKey) {
    try {
      Cache.putRaw(failKey, Auth._failureCount(failKey) + 1, Auth.LOGIN_FAIL_TTL_SEC);
    } catch (err) {
      console.error('Auth._recordFailure: cache write failed: ' + err);
    }
  },

  /**
   * Audit a failed sign-in. The attempted email is recorded, the password never is.
   * @param {string} email Normalised email that was tried.
   * @param {string} reason Internal reason code, for the log only.
   * @param {string} [ua] User agent.
   * @return {void}
   */
  _auditLoginFailed(email, reason, ua) {
    Audit.log({
      actor: '',
      role: '',
      action: Audit.ACTIONS.LOGIN_FAILED,
      tournamentId: '',
      entityType: 'USER',
      entityId: email,
      prev: null,
      next: { email: email, reason: reason },
      ua: ua
    });
  },

  /**
   * @param {Object} user Users row.
   * @return {Object} Copy without password_hash, salt, join_token_hash or the
   *     sheet row marker. A join token digest is a credential too.
   */
  _publicUser(user) {
    const out = {};
    for (const k in user) {
      if (k === 'password_hash' || k === 'salt' || k === 'join_token_hash' || k === '_row') continue;
      out[k] = user[k];
    }
    return out;
  },

  /**
   * @param {*} v Sheet or cache value.
   * @return {boolean} True for real `true` and for the literal string "TRUE".
   */
  _isTrue(v) {
    return v === true || String(v).trim().toUpperCase() === 'TRUE';
  },

  /**
   * @param {string} iso ISO-8601 timestamp.
   * @return {number|null} Milliseconds since epoch, or null if unparseable.
   */
  _parseIsoMs(iso) {
    if (Util.isBlank(iso)) return null;
    const ms = (iso instanceof Date) ? iso.getTime() : new Date(String(iso)).getTime();
    return isFinite(ms) ? ms : null;
  },

  /**
   * @param {string} key Key in the global SHEETS map.
   * @param {string} literal Tab name from CONTRACTS §4, used if SHEETS lacks the key.
   * @return {string} Tab name.
   */
  _tab(key, literal) {
    return (typeof SHEETS !== 'undefined' && SHEETS && SHEETS[key]) ? SHEETS[key] : literal;
  },

  /**
   * @param {string} key Key in the global ID_PREFIX map.
   * @param {string} literal Prefix from CONTRACTS §4, used if ID_PREFIX lacks the key.
   * @return {string} Id prefix.
   */
  _idPrefix(key, literal) {
    return (typeof ID_PREFIX !== 'undefined' && ID_PREFIX && ID_PREFIX[key]) ? ID_PREFIX[key] : literal;
  }
};
