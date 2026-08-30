/**
 * Audit.gs — the append-only trail for every consequential change.
 * Implements CONTRACTS.md §10, schema per DESIGN.md §2.7.
 *
 * The one rule that matters here: log() must never throw. It is called from
 * inside business operations that have already changed the sheet, so a failed
 * audit write must degrade to a console.error and nothing more. Letting it
 * throw would roll a caller back after the real work was done.
 */
const Audit = {

  /** Every action name the system may record. Frozen so a typo fails loudly. */
  ACTIONS: Object.freeze({
    PAYMENT_VERIFIED: 'PAYMENT_VERIFIED',
    PAYMENT_REJECTED: 'PAYMENT_REJECTED',
    TEAM_CREATED: 'TEAM_CREATED',
    TEAM_UPDATED: 'TEAM_UPDATED',
    TEAM_DELETED: 'TEAM_DELETED',
    PLAYER_SOLD: 'PLAYER_SOLD',
    PLAYER_UNSOLD: 'PLAYER_UNSOLD',
    PLAYER_RETURNED_TO_POOL: 'PLAYER_RETURNED_TO_POOL',
    PLAYER_WITHDRAWN: 'PLAYER_WITHDRAWN',
    AUCTION_CORRECTED: 'AUCTION_CORRECTED',
    AUCTION_CLOSED: 'AUCTION_CLOSED',
    AUCTION_REOPENED: 'AUCTION_REOPENED',
    REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
    ORGANISER_CREATED: 'ORGANISER_CREATED',
    ORGANISER_DISABLED: 'ORGANISER_DISABLED',
    ORGANISER_LINK_RESENT: 'ORGANISER_LINK_RESENT',
    LOGIN_SUCCESS: 'LOGIN_SUCCESS',
    LOGIN_FAILED: 'LOGIN_FAILED',
    TOURNAMENT_CREATED: 'TOURNAMENT_CREATED',
    TOURNAMENT_UPDATED: 'TOURNAMENT_UPDATED'
  }),

  /** Per-cell cap for the JSON columns. Sheets allows 50000; 5000 is plenty. */
  MAX_JSON_CHARS: 5000,

  /** Per-cell cap for the user agent column. */
  MAX_UA_CHARS: 500,

  /** Suffix appended when a value was cut short. */
  TRUNCATION_SUFFIX: '...[truncated]',

  /**
   * Append one row to the AuditLog tab. Never throws.
   *
   * @param {{actor:(string|undefined), role:(string|undefined), action:string,
   *          tournamentId:(string|undefined), entityType:(string|undefined),
   *          entityId:(string|undefined), prev:(Object|null|undefined),
   *          next:(Object|null|undefined), ua:(string|undefined)}} entry
   *     What happened. `prev` and `next` are JSON-stringified here.
   * @return {void}
   */
  log(entry) {
    try {
      const e = entry || {};
      const row = {
        log_id: Util.uid(Audit._idPrefix('LOG', 'LOG_')),
        // Server clock only — a client timestamp would make the trail worthless.
        timestamp: Util.nowIso(),
        actor_user_id: Audit._str(e.actor),
        actor_role: Audit._str(e.role),
        action: Audit._str(e.action),
        tournament_id: Audit._str(e.tournamentId),
        entity_type: Audit._str(e.entityType),
        entity_id: Audit._str(e.entityId),
        prev_value: Audit._json(e.prev),
        new_value: Audit._json(e.next),
        user_agent: Audit._truncate(Audit._str(e.ua), Audit.MAX_UA_CHARS)
      };
      Repo.append(Audit._tab('AUDIT_LOG', 'AuditLog'), row);
    } catch (err) {
      // Deliberately swallowed. See the file header.
      console.error('Audit.log failed (operation continues): ' + err +
        ' | entry=' + Audit._describe(entry));
    }
  },

  /**
   * Serialise a prev/next payload for a sheet cell.
   *
   * @param {*} value Object, primitive, null or undefined.
   * @return {string} JSON text, '' for null/undefined, truncated if oversized.
   */
  _json(value) {
    if (value === null || value === undefined) return '';
    let text;
    try {
      text = JSON.stringify(value);
    } catch (err) {
      // Circular reference or similar — record that rather than losing the row.
      text = '"[unserialisable: ' + err + ']"';
    }
    if (text === undefined) return '';
    return Audit._truncate(String(text), Audit.MAX_JSON_CHARS);
  },

  /**
   * @param {string} text Value to cap.
   * @param {number} max Maximum characters to keep before the suffix.
   * @return {string} The value, cut short with a marker if it was too long.
   */
  _truncate(text, max) {
    const s = text == null ? '' : String(text);
    return s.length <= max ? s : s.slice(0, max) + Audit.TRUNCATION_SUFFIX;
  },

  /**
   * @param {*} v Any value.
   * @return {string} '' for null/undefined, otherwise String(v).
   */
  _str(v) {
    return (v === null || v === undefined) ? '' : String(v);
  },

  /**
   * Short, safe description of an entry for the error log.
   * @param {Object} entry The entry that could not be written.
   * @return {string} Action and entity, without the payloads.
   */
  _describe(entry) {
    try {
      const e = entry || {};
      return 'action=' + Audit._str(e.action) +
        ' actor=' + Audit._str(e.actor) +
        ' entity=' + Audit._str(e.entityType) + ':' + Audit._str(e.entityId);
    } catch (err) {
      return '(unreadable entry)';
    }
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
