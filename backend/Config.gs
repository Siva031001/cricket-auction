/**
 * Config.gs — shared constants for the whole backend.
 *
 * Contract: CONTRACTS.md §3 (error codes) and §4 (tabs, headers, enums, prefixes).
 *
 * Apps Script concatenates .gs files in an undefined order, so this file contains
 * nothing but `const` declarations of plain literals. Anything that *runs* at load
 * time would be a load-order bug. Everything here is frozen: these values are read
 * from every module and an accidental mutation would be invisible until production.
 */

/**
 * Spreadsheet tab names. Used as the key into HEADERS and as the argument to every
 * Repo call, so a rename only has to happen here.
 * @const {!Object<string,string>}
 */
const SHEETS = Object.freeze({
  TOURNAMENTS: 'Tournaments',
  USERS: 'Users',
  PLAYERS: 'Players',
  PAYMENTS: 'Payments',
  TEAMS: 'Teams',
  AUCTION_RESULTS: 'AuctionResults',
  AUDIT_LOG: 'AuditLog',
  SESSIONS: 'Sessions',
  CONFIG: 'Config'
});

/**
 * Header row for each tab, keyed by tab name.
 *
 * COLUMN ORDER IS BINDING (CONTRACTS.md §4). Setup.gs writes these verbatim into
 * row 1 and Repo.gs maps a row array to an object using this order, so reordering
 * an entry silently re-labels live data. Append new columns at the end only.
 *
 * @const {!Object<string,!Array<string>>}
 */
const HEADERS = Object.freeze({
  [SHEETS.TOURNAMENTS]: Object.freeze([
    'tournament_id', 'slug', 'name', 'description', 'start_date', 'end_date',
    'reg_start', 'reg_end', 'reg_fee', 'logo_file_id', 'photo_file_ids',
    'qr_file_id', 'upi_id', 'contact_name', 'contact_mobile', 'contact_email',
    'rules', 'status', 'drive_folder_id', 'next_serial', 'default_purse',
    'default_max_players', 'display_token', 'created_at', 'created_by'
  ]),

  // The last three columns carry the one-time organiser join link
  // (CONTRACTS-PHASE3.md §1). join_token_hash is a SHA-256 digest, never the
  // token itself, so a leaked copy of this sheet contains nothing usable.
  [SHEETS.USERS]: Object.freeze([
    'user_id', 'email', 'display_name', 'password_hash', 'salt', 'role',
    'tournament_id', 'status', 'created_at', 'created_by', 'last_login_at',
    'join_token_hash', 'join_expires_at', 'join_used_at'
  ]),

  [SHEETS.PLAYERS]: Object.freeze([
    'player_id', 'tournament_id', 'serial_no', 'name', 'dob', 'age_years', 'role',
    'style', 'mobile', 'photo_file_id', 'photo_thumb_url', 'payment_status',
    'auction_status', 'times_called', 'team_id', 'sold_amount', 'sold_at',
    'is_withdrawn', 'search_blob', 'registered_at'
  ]),

  [SHEETS.PAYMENTS]: Object.freeze([
    'payment_id', 'tournament_id', 'player_id', 'upi_ref', 'amount',
    'screenshot_file_id', 'status', 'verified_by', 'verified_at',
    'reject_reason', 'submitted_at'
  ]),

  [SHEETS.TEAMS]: Object.freeze([
    'team_id', 'tournament_id', 'team_name', 'owner_name', 'logo_file_id',
    'purse_total', 'purse_used', 'max_players', 'players_count',
    'created_at', 'created_by'
  ]),

  [SHEETS.AUCTION_RESULTS]: Object.freeze([
    'auction_id', 'tournament_id', 'player_id', 'serial_no', 'status', 'team_id',
    'amount', 'auction_time', 'recorded_by', 'is_current',
    'supersedes_auction_id', 'note'
  ]),

  [SHEETS.AUDIT_LOG]: Object.freeze([
    'log_id', 'timestamp', 'actor_user_id', 'actor_role', 'action',
    'tournament_id', 'entity_type', 'entity_id', 'prev_value', 'new_value',
    'user_agent'
  ]),

  [SHEETS.SESSIONS]: Object.freeze([
    'token', 'user_id', 'role', 'tournament_id', 'issued_at', 'expires_at', 'revoked'
  ]),

  [SHEETS.CONFIG]: Object.freeze([
    'key', 'value', 'updated_at'
  ])
});

/**
 * The eight enumerations from CONTRACTS.md §4.
 *
 * Each member's value is its own name, so the sheet stores the same token the code
 * compares against. Never write a bare string literal for one of these.
 *
 * @const {!Object<string,!Object<string,string>>}
 */
const ENUM = Object.freeze({
  /** Lifecycle of a tournament. */
  TOURNAMENT_STATUS: Object.freeze({
    DRAFT: 'DRAFT',
    REG_OPEN: 'REG_OPEN',
    REG_CLOSED: 'REG_CLOSED',
    AUCTION_LIVE: 'AUCTION_LIVE',
    AUCTION_CLOSED: 'AUCTION_CLOSED'
  }),

  /** ADMIN is global; ORGANISER is scoped to one tournament. */
  USER_ROLE: Object.freeze({
    ADMIN: 'ADMIN',
    ORGANISER: 'ORGANISER'
  }),

  USER_STATUS: Object.freeze({
    ACTIVE: 'ACTIVE',
    DISABLED: 'DISABLED'
  }),

  PLAYER_ROLE: Object.freeze({
    BATSMAN: 'BATSMAN',
    BOWLER: 'BOWLER',
    ALL_ROUNDER: 'ALL_ROUNDER'
  }),

  /** Batting/bowling handedness. */
  PLAYER_STYLE: Object.freeze({
    LEFT: 'LEFT',
    RIGHT: 'RIGHT'
  }),

  PAYMENT_STATUS: Object.freeze({
    PENDING: 'PENDING',
    VERIFIED: 'VERIFIED',
    REJECTED: 'REJECTED'
  }),

  /** Denormalised onto the Players row for fast filtering. */
  AUCTION_STATUS: Object.freeze({
    PENDING: 'PENDING',
    SOLD: 'SOLD',
    UNSOLD: 'UNSOLD'
  }),

  /**
   * Status of an AuctionResults row. Wider than AUCTION_STATUS because a
   * correction can push a player back into the pool, which is an event we keep
   * in history but never a resting state on the player.
   */
  RESULT_STATUS: Object.freeze({
    SOLD: 'SOLD',
    UNSOLD: 'UNSOLD',
    RETURNED_TO_POOL: 'RETURNED_TO_POOL'
  })
});

/**
 * Error codes from CONTRACTS.md §3. Value equals key so the wire format and the
 * constant can never drift apart.
 * @const {!Object<string,string>}
 */
const ERR = Object.freeze({
  /** Malformed body, unknown action, missing required field. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** No token, expired token, bad credentials. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Valid token, wrong role or wrong tournament. */
  FORBIDDEN: 'FORBIDDEN',
  /** Entity does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** Field-level validation; the message names the field. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Mobile already registered in this tournament. */
  DUPLICATE_MOBILE: 'DUPLICATE_MOBILE',
  /** UPI reference already used in this tournament. */
  DUPLICATE_UPI_REF: 'DUPLICATE_UPI_REF',
  /** Outside the registration window. */
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  /** Tournament status is not AUCTION_LIVE. */
  AUCTION_NOT_LIVE: 'AUCTION_NOT_LIVE',
  /** Auction has been closed. */
  AUCTION_CLOSED: 'AUCTION_CLOSED',
  /** Payment not VERIFIED. */
  PLAYER_NOT_ELIGIBLE: 'PLAYER_NOT_ELIGIBLE',
  /** Auction status is not PENDING. */
  PLAYER_NOT_PENDING: 'PLAYER_NOT_PENDING',
  /** Player already has a team_id. */
  ALREADY_ASSIGNED: 'ALREADY_ASSIGNED',
  /** players_count >= max_players. */
  TEAM_FULL: 'TEAM_FULL',
  /** Amount exceeds remaining purse. */
  INSUFFICIENT_PURSE: 'INSUFFICIENT_PURSE',
  /** Not a positive integer. */
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  /** New max_players is below current players_count. */
  SQUAD_BELOW_COUNT: 'SQUAD_BELOW_COUNT',
  /** New purse_total is below purse_used. */
  PURSE_BELOW_SPENT: 'PURSE_BELOW_SPENT',
  /** Cannot delete a team that has players. */
  TEAM_NOT_EMPTY: 'TEAM_NOT_EMPTY',
  /** Client expectedVersion did not match. */
  STALE_STATE: 'STALE_STATE',
  /** Could not acquire the lock in time. */
  SYSTEM_BUSY: 'SYSTEM_BUSY',
  /** Anything unhandled. */
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

/**
 * Entity id prefixes for Util.uid(). Format: prefix + 12 base36 chars,
 * e.g. "PLY_k3m9x1qz7f2a".
 * @const {!Object<string,string>}
 */
const ID_PREFIX = Object.freeze({
  TOURNAMENT: 'TRN_',
  USER: 'USR_',
  PLAYER: 'PLY_',
  PAYMENT: 'PAY_',
  TEAM: 'TEM_',
  AUCTION: 'AUC_',
  LOG: 'LOG_'
});

/**
 * Header names stored in the sheet as the literal strings "TRUE" / "FALSE".
 * Repo converts these to and from real booleans on the way in and out.
 * @const {!Array<string>}
 */
const BOOLEAN_FIELDS = Object.freeze([
  'is_current',
  'is_withdrawn',
  'revoked'
]);

/**
 * Header names that must round-trip as JavaScript numbers, not strings.
 *
 * Sheets happily hands back a string for a cell a human typed, and purse maths on
 * a string silently concatenates instead of adding. Repo coerces these on read.
 *
 * @const {!Array<string>}
 */
const NUMERIC_FIELDS = Object.freeze([
  'reg_fee',
  'next_serial',
  'default_purse',
  'default_max_players',
  'serial_no',
  'age_years',
  'times_called',
  'sold_amount',
  'amount',
  'purse_total',
  'purse_used',
  'max_players',
  'players_count'
]);

/**
 * Tunable defaults. The Config tab may override some of these at runtime
 * (see CONTRACTS.md §13); these are the values used when it does not.
 * @const {!Object<string,number>}
 */
const DEFAULTS = Object.freeze({
  /** LockService wait before giving up with SYSTEM_BUSY. */
  lock_wait_ms: 20000,
  /** Session lifetime. */
  session_hours: 12,
  /** CacheService maximum TTL (6 hours). */
  cache_ttl_sec: 21600,
  /** Largest decoded image accepted by Drive.uploadImage (5 MB). */
  max_image_bytes: 5242880,
  /** How often the projector/auction screens poll for a version bump. */
  poll_interval_ms: 2000,
  /** HMAC-SHA256 rounds in Util.hashPassword (DESIGN.md §5.2). */
  hash_iterations: 1000,
  /** Snapshot cap, kept under the 100 KB CacheService limit with headroom. */
  max_snapshot_bytes: 97280
});
