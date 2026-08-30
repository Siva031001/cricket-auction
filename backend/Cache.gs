/**
 * Cache.gs — version counters, auction snapshots, sessions, config and
 * login-failure counters. Implements CONTRACTS.md §8.
 *
 * Two different stores, on purpose:
 *   - PropertiesService (durable) holds the per-tournament version counter.
 *     It must survive cache eviction: the version is the only thing telling a
 *     polling client "you are behind". Losing it would silently desync everyone.
 *   - CacheService (volatile) holds everything else. A missing snapshot or a
 *     missing config entry is harmless — it is rebuilt or re-read on the next hit.
 */

/** CacheService hard maximum TTL, in seconds (6 hours). */
const CACHE_MAX_TTL_SEC = 21600;

/** Key prefixes — CONTRACTS.md §8. */
const CACHE_PREFIX_VERSION = 'v:';
const CACHE_PREFIX_SNAPSHOT = 'snap:';
const CACHE_PREFIX_SESSION = 'sess:';
const CACHE_PREFIX_CONFIG = 'cfg:';
const CACHE_PREFIX_LOGIN_FAIL = 'login_fail:';

/** Fallback tab name if Config.gs has not declared SHEETS.CONFIG under that key. */
const CACHE_CONFIG_TAB_FALLBACK = 'Config';

const Cache = {

  // ---------------------------------------------------------------- internals

  /**
   * Script-wide volatile cache.
   * @return {GoogleAppsScript.Cache.Cache} the script cache
   */
  _cache() {
    return CacheService.getScriptCache();
  },

  /**
   * Script-wide durable key/value store.
   * @return {GoogleAppsScript.Properties.Properties} the script properties
   */
  _props() {
    return PropertiesService.getScriptProperties();
  },

  /**
   * Clamp a requested TTL into the range CacheService actually accepts.
   * A TTL above 21600 is rejected by the service, so silently clamping is
   * better than letting a caller's "one day" throw at runtime.
   * @param {number} [ttlSec] requested time to live in seconds
   * @return {number} a TTL between 1 and CACHE_MAX_TTL_SEC
   */
  _ttl(ttlSec) {
    const n = Math.floor(Number(ttlSec));
    if (!isFinite(n) || n <= 0) return CACHE_MAX_TTL_SEC;
    return Math.min(n, CACHE_MAX_TTL_SEC);
  },

  /**
   * Name of the Config tab, tolerating either SHEETS.CONFIG or a plain literal.
   * @return {string} the sheet tab name
   */
  _configTab() {
    if (typeof SHEETS !== 'undefined' && SHEETS && SHEETS.CONFIG) return SHEETS.CONFIG;
    return CACHE_CONFIG_TAB_FALLBACK;
  },

  // ----------------------------------------------------------- version counter

  /**
   * Current auction state version for a tournament.
   * @param {string} tournamentId tournament id
   * @return {number} the version, 0 when never bumped
   */
  getVersion(tournamentId) {
    const raw = this._props().getProperty(CACHE_PREFIX_VERSION + tournamentId);
    const n = parseInt(raw, 10);
    return isFinite(n) && n > 0 ? n : 0;
  },

  /**
   * Increment and persist the auction state version.
   *
   * Read-modify-write is not atomic in PropertiesService. Every caller that
   * bumps the version is already inside `Repo.withLock`, which is what makes
   * this safe — see DESIGN.md §7.1/§7.2. Do not call it outside the lock.
   *
   * @param {string} tournamentId tournament id
   * @return {number} the new version
   */
  bumpVersion(tournamentId) {
    const next = this.getVersion(tournamentId) + 1;
    this._props().setProperty(CACHE_PREFIX_VERSION + tournamentId, String(next));
    return next;
  },

  // ----------------------------------------------------------------- snapshot

  /**
   * Read the cached auction snapshot.
   * @param {string} tournamentId tournament id
   * @return {Object|null} the snapshot, or null when absent or unparseable
   */
  getSnapshot(tournamentId) {
    return this.getRaw(CACHE_PREFIX_SNAPSHOT + tournamentId);
  },

  /**
   * Store the auction snapshot.
   *
   * CacheService allows 100 KB per key. When you exceed it, it does NOT throw —
   * it silently drops the write, so every later read is a cache miss and the
   * projector quietly falls back to rebuilding from the Spreadsheet on every
   * poll. Failing loudly at 95 KB is far better than that silent failure.
   *
   * @param {string} tournamentId tournament id
   * @param {Object} obj snapshot object (DESIGN.md §7.3)
   * @return {void}
   * @throws {Error} INTERNAL_ERROR when the serialised snapshot is too large
   */
  putSnapshot(tournamentId, obj) {
    const json = JSON.stringify(obj);
    // Byte length, not character length: player names are often non-ASCII and
    // a UTF-8 name costs 2-3 bytes per character in the cache.
    const bytes = Utilities.newBlob(json).getBytes().length;
    const max = DEFAULTS.max_snapshot_bytes;
    if (bytes > max) {
      throw Util.AppError(
        ERR.INTERNAL_ERROR,
        `Auction snapshot for ${tournamentId} is ${bytes} bytes, over the ${max} byte cache limit. ` +
        'Reduce what the snapshot carries — it is meant to be a small summary, not a full data dump.'
      );
    }
    this._cache().put(CACHE_PREFIX_SNAPSHOT + tournamentId, json, CACHE_MAX_TTL_SEC);
  },

  /**
   * Drop the cached snapshot for a tournament so the next read rebuilds it.
   *
   * This deliberately does NOT reset the version counter. Resetting the version
   * to 0 would make every polling client — which sends its last seen version —
   * compare against a smaller number and conclude it is already up to date,
   * freezing the projector on stale data. The version only ever goes up.
   *
   * @param {string} tournamentId tournament id
   * @return {void}
   */
  invalidate(tournamentId) {
    this._cache().remove(CACHE_PREFIX_SNAPSHOT + tournamentId);
  },

  // ----------------------------------------------------------------- sessions

  /**
   * Read a cached session.
   * @param {string} token session token
   * @return {Object|null} the session object, or null when absent or unparseable
   */
  getSession(token) {
    return this.getRaw(CACHE_PREFIX_SESSION + token);
  },

  /**
   * Cache a session. TTL is the CacheService maximum of 6 hours; sessions
   * themselves last 12 hours (CONTRACTS §7.3), so `Auth.resolve` must still fall
   * back to the Sessions tab on a miss.
   * @param {string} token session token
   * @param {Object} obj session object
   * @param {number} [ttlSec] optional TTL, clamped to 21600
   * @return {void}
   */
  putSession(token, obj, ttlSec) {
    this.putRaw(CACHE_PREFIX_SESSION + token, obj, this._ttl(ttlSec));
  },

  /**
   * Remove a cached session, e.g. on logout or revocation.
   * @param {string} token session token
   * @return {void}
   */
  delSession(token) {
    this.del(CACHE_PREFIX_SESSION + token);
  },

  // ------------------------------------------------------------------- config

  /**
   * Read a Config value, cache-through: cache first, then the Config tab.
   * @param {string} key config key, e.g. 'pepper'
   * @return {*} the stored value, or null when the key does not exist
   */
  getConfig(key) {
    const cacheKey = CACHE_PREFIX_CONFIG + key;
    const hit = this._cache().get(cacheKey);
    if (hit !== null && hit !== undefined) return Util.safeJsonParse(hit, null);

    const row = Repo.findBy(this._configTab(), 'key', key);
    if (!row) return null; // A miss is not cached — a key seeded a second later must be visible.

    const value = row.value;
    this.putConfig(key, value);
    return value;
  },

  /**
   * Put a value into the config cache. This writes the cache only — the Config
   * tab is owned by `Setup.gs`. Call it after writing the sheet, not instead.
   * @param {string} key config key
   * @param {*} value any JSON-serialisable value
   * @return {void}
   */
  putConfig(key, value) {
    this.putRaw(CACHE_PREFIX_CONFIG + key, value, CACHE_MAX_TTL_SEC);
  },

  /**
   * Forget a cached config value so the next read comes from the sheet.
   * @param {string} key config key
   * @return {void}
   */
  invalidateConfig(key) {
    this.del(CACHE_PREFIX_CONFIG + key);
  },

  // ---------------------------------------------------- login failure counters

  /**
   * Consecutive failed login attempts for an email.
   * Kept in cache, never in the sheet: it is throwaway data and a lockout that
   * evaporates after a cache flush is an acceptable trade for not writing a row
   * on every wrong password. (CONTRACTS §7.5)
   * @param {string} email lower-cased email
   * @return {number} the current count, 0 when none
   */
  getLoginFailures(email) {
    const n = parseInt(this._cache().get(CACHE_PREFIX_LOGIN_FAIL + email), 10);
    return isFinite(n) && n > 0 ? n : 0;
  },

  /**
   * Increment the failed-login counter and refresh its window.
   * @param {string} email lower-cased email
   * @param {number} ttlSec how long the counter lives, clamped to 21600
   * @return {number} the new count
   */
  bumpLoginFailures(email, ttlSec) {
    const next = this.getLoginFailures(email) + 1;
    this._cache().put(CACHE_PREFIX_LOGIN_FAIL + email, String(next), this._ttl(ttlSec));
    return next;
  },

  /**
   * Clear the failed-login counter, e.g. after a successful login.
   * @param {string} email lower-cased email
   * @return {void}
   */
  clearLoginFailures(email) {
    this.del(CACHE_PREFIX_LOGIN_FAIL + email);
  },

  // ------------------------------------------------------------------ generic

  /**
   * Read and parse any cache key. Never throws: a corrupt or half-written entry
   * returns null and the caller simply treats it as a miss.
   * @param {string} key full cache key, prefix included
   * @return {*} the parsed value, or null
   */
  getRaw(key) {
    const raw = this._cache().get(key);
    if (raw === null || raw === undefined) return null;
    return Util.safeJsonParse(raw, null);
  },

  /**
   * Write any value to the cache as JSON.
   * @param {string} key full cache key, prefix included
   * @param {*} obj any JSON-serialisable value
   * @param {number} [ttlSec] time to live in seconds, clamped to 21600
   * @return {void}
   */
  putRaw(key, obj, ttlSec) {
    this._cache().put(key, JSON.stringify(obj), this._ttl(ttlSec));
  },

  /**
   * Remove a cache key.
   * @param {string} key full cache key, prefix included
   * @return {void}
   */
  del(key) {
    this._cache().remove(key);
  }
};
