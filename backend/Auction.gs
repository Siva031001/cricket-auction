/**
 * Auction.gs — the live auction. CONTRACTS-PHASE4-7 §4, DESIGN.md §6.5–§6.9, §7.
 *
 * This is the highest-risk file in the project. It runs in front of an audience,
 * with money attached, and a mistake is visible to everyone in the hall. Three
 * rules govern everything below.
 *
 * 1. EVERY STATE CHANGE RUNS INSIDE Repo.withLock, RE-READS FROM THE SHEET, AND
 *    VALIDATES THERE. A value that arrived from a browser is a suggestion, never
 *    a fact. Auction._write() owns steps 1, 2, 3, 14 and 15 of the §4.1 order and
 *    every write path in this file goes through it.
 *
 * 2. AuctionResults IS THE TRUTH. Teams.purse_used and Teams.players_count are a
 *    cache of it, maintained inside this lock (CONTRACTS-PHASE3 §3). Nothing here
 *    ever derives a counter by scanning Players — that would be a second
 *    definition of the same number and the two would disagree.
 *
 * 3. NOTHING IS EVER DELETED. A correction appends a superseding row and flips
 *    is_current on the old one (DESIGN.md §2.6, §43). History is evidence.
 *
 * Performance contract (§4.5): a poll that finds no change must not open the
 * Spreadsheet. Two clients polling every 2 s for three hours is ~10,800 requests;
 * at ~500 ms per Spreadsheet open that is wasted quota and a visibly laggy
 * projector. The version lives in PropertiesService and the snapshot in
 * CacheService, so an unchanged poll costs ~10 ms and touches no sheet.
 */

/**
 * Cache key for "which player is on the projector right now".
 *
 * WHY THIS IS NOT IN THE SHEET: the schema (CONTRACTS.md §4) has no column for
 * it, and it is presentation state rather than a business fact — every fact the
 * auction produces lives in Players and AuctionResults. Losing it to a cache
 * eviction blanks the card until the organiser calls the next serial; it can
 * never lose a sale. The snapshot carries the same pointer as a second chance,
 * so a rebuild recovers it even when this key has gone.
 * @const {string}
 */
const AUCTION_CURRENT_PREFIX = 'auccur:';

/**
 * Cache key prefix for a display token that has already been verified.
 * @const {string}
 */
const AUCTION_DTOK_PREFIX = 'dtok:';

/**
 * How long a verified display token stays trusted, in seconds.
 *
 * Auth.verifyDisplayToken reads the Tournaments tab, so calling it on every
 * projector poll would open the Spreadsheet every 2 s and break §4.5 for the one
 * screen the audience is watching. Caching the positive answer for five minutes
 * turns ~5,400 sheet reads over a three-hour auction into ~36, and still lets a
 * rotated token take effect within five minutes (DESIGN.md §16 risk 7 rates a
 * leaked display token Low and rotatable). A failed check is never cached.
 * @const {number}
 */
const AUCTION_DTOK_TTL_SEC = 300;

/** Largest number of rows auction.search will return in one response. @const {number} */
const AUCTION_SEARCH_LIMIT = 50;

/** Advisory sold-amount warning codes (§4.7). Never block a sale. @const {!Object<string,string>} */
const AUCTION_WARN = Object.freeze({
  LARGE_SHARE_OF_PURSE: 'LARGE_SHARE_OF_PURSE',
  FAR_ABOVE_RECENT: 'FAR_ABOVE_RECENT',
  SQUAD_AT_RISK: 'SQUAD_AT_RISK'
});

/** Amount above this fraction of a team's total purse raises an advisory. @const {number} */
const AUCTION_WARN_PURSE_SHARE = 0.25;

/** Amount above this multiple of the highest sale so far raises an advisory. @const {number} */
const AUCTION_WARN_ABOVE_HIGHEST = 5;

/**
 * Width of the projector photo variant, in pixels.
 *
 * The display shows the photo at about half the screen. 1200 covers a 1920-wide
 * projector at that size without asking Drive for a needlessly large file on
 * every reveal.
 * @const {number}
 */
const AUCTION_PROJECTOR_PHOTO_WIDTH = 1200;

const Auction = {

  // =========================================================================
  // Small internals
  // =========================================================================

  /**
   * Trim any value to a string; null, undefined and whitespace become ''.
   * @param {*} v any value
   * @return {string} the trimmed string
   */
  _str(v) {
    return Util.isBlank(v) ? '' : String(v).trim();
  },

  /**
   * The tournament id a payload is talking about, accepting both spellings the
   * hand-written frontend might send.
   * @param {!Object} payload request payload
   * @return {string} the tournament id
   * @throws {!Error} VALIDATION_FAILED when it is missing
   */
  _tournamentId(payload) {
    const tid = Auction._str(payload.tournamentId || payload.tournament_id);
    if (!tid) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'tournamentId is required.');
    }
    return tid;
  },

  /**
   * Read the tournament row.
   * @param {string} tournamentId the tournament
   * @return {!Object} the Tournaments row
   * @throws {!Error} NOT_FOUND when it does not exist
   */
  _tournament(tournamentId) {
    const row = Repo.findBy(SHEETS.TOURNAMENTS, 'tournament_id', tournamentId);
    if (!row) {
      throw Util.AppError(ERR.NOT_FOUND, 'That tournament no longer exists.');
    }
    return row;
  },

  /**
   * Step 3 of §4.1 — the auction must be live before anything may be recorded.
   *
   * AUCTION_CLOSED is reported separately from AUCTION_NOT_LIVE because they
   * need different actions from the user: one needs an admin to reopen, the
   * other needs the auction to be started (DESIGN.md §15 case 20).
   *
   * @param {!Object} trn the Tournaments row, already re-read inside the lock
   * @return {void}
   * @throws {!Error} AUCTION_CLOSED or AUCTION_NOT_LIVE
   */
  _requireLive(trn) {
    const status = Auction._str(trn.status).toUpperCase();
    if (status === ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED) {
      throw Util.AppError(ERR.AUCTION_CLOSED,
        'The auction for "' + Auction._str(trn.name) + '" is closed. ' +
        'An admin has to reopen it before any more results can be recorded.');
    }
    if (status !== ENUM.TOURNAMENT_STATUS.AUCTION_LIVE) {
      throw Util.AppError(ERR.AUCTION_NOT_LIVE,
        'The auction for "' + Auction._str(trn.name) + '" is not live — the tournament status is ' +
        (status || 'blank') + '. Start the auction first.');
    }
  },

  /**
   * Step 1 of §4.1 — the third and outermost defence against a double sale.
   *
   * The lock serialises writes and the re-read catches a player who is already
   * SOLD, but neither of those helps when the action is legal in itself and the
   * organiser is simply looking at a screen that is thirty seconds out of date.
   * This check is what stops a stale browser tab acting on old information —
   * for example selling to a team whose purse was raised or lowered since the
   * tab last polled. Do not make it optional.
   *
   * @param {string} tournamentId the tournament
   * @param {*} expectedVersion the version the client believes is current
   * @return {number} the live version, which matched
   * @throws {!Error} VALIDATION_FAILED when absent, STALE_STATE when behind
   */
  _requireVersion(tournamentId, expectedVersion) {
    if (Util.isBlank(expectedVersion)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'expectedVersion is required. Refresh the auction screen and try again.');
    }
    const want = Util.toInt(expectedVersion, -1);
    const have = Cache.getVersion(tournamentId);
    if (want !== have) {
      throw Util.AppError(ERR.STALE_STATE,
        'The auction has moved on since your screen last updated — you are on version ' +
        want + ' and the auction is at version ' + have + '. Refresh and try again.');
    }
    return have;
  },

  /**
   * One player of one tournament, by player_id.
   * @param {!Array<!Object>} playerRows every Players row, read once
   * @param {string} tournamentId the tournament
   * @param {string} playerId the player
   * @return {!Object} the Players row
   * @throws {!Error} VALIDATION_FAILED when the id is blank, NOT_FOUND otherwise
   */
  _playerById(playerRows, tournamentId, playerId) {
    const id = Auction._str(playerId);
    if (!id) throw Util.AppError(ERR.VALIDATION_FAILED, 'playerId is required.');
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      if (Auction._str(row.player_id) === id &&
          Auction._str(row.tournament_id) === tournamentId) {
        return row;
      }
    }
    throw Util.AppError(ERR.NOT_FOUND, 'That player is not in this tournament.');
  },

  /**
   * One player of one tournament, by serial number (DESIGN.md §15 case 18).
   * @param {!Array<!Object>} playerRows every Players row, read once
   * @param {string} tournamentId the tournament
   * @param {*} serialNo the serial the organiser typed
   * @return {!Object} the Players row
   * @throws {!Error} VALIDATION_FAILED on a bad serial, NOT_FOUND when unused
   */
  _playerBySerial(playerRows, tournamentId, serialNo) {
    const n = Util.toInt(serialNo, 0);
    if (!(n > 0)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'Serial number "' + Auction._str(serialNo) + '" is not a number. Type the number on the player card.');
    }
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      if (Util.toInt(row.serial_no, 0) === n &&
          Auction._str(row.tournament_id) === tournamentId) {
        return row;
      }
    }
    throw Util.AppError(ERR.NOT_FOUND, 'No player with serial ' + n + ' in this tournament.');
  },

  /**
   * One team of one tournament.
   * @param {!Array<!Object>} teamRows every Teams row, read once
   * @param {string} tournamentId the tournament
   * @param {string} teamId the team
   * @return {!Object} the Teams row
   * @throws {!Error} VALIDATION_FAILED when blank, NOT_FOUND otherwise
   */
  _teamById(teamRows, tournamentId, teamId) {
    const id = Auction._str(teamId);
    if (!id) throw Util.AppError(ERR.VALIDATION_FAILED, 'teamId is required.');
    for (let i = 0; i < teamRows.length; i++) {
      const row = teamRows[i];
      if (Auction._str(row.team_id) === id &&
          Auction._str(row.tournament_id) === tournamentId) {
        return row;
      }
    }
    throw Util.AppError(ERR.NOT_FOUND, 'That team no longer exists in this tournament.');
  },

  /**
   * Index teams by id so a card or a snapshot can name a team without a second
   * pass over the rows.
   * @param {!Array<!Object>} teamRows every Teams row
   * @param {string} tournamentId the tournament
   * @return {!Object<string,!Object>} team_id -> Teams row
   */
  _teamIndex(teamRows, tournamentId) {
    const out = {};
    for (let i = 0; i < teamRows.length; i++) {
      const row = teamRows[i];
      if (Auction._str(row.tournament_id) !== tournamentId) continue;
      out[Auction._str(row.team_id)] = row;
    }
    return out;
  },

  /**
   * The team's name, or a readable placeholder when the id no longer resolves.
   * @param {!Object<string,!Object>} teamsById index from _teamIndex
   * @param {string} teamId the team id from a player or result row
   * @return {string} the team name, '' when there is no team
   */
  _teamName(teamsById, teamId) {
    const id = Auction._str(teamId);
    if (!id) return '';
    const t = teamsById[id];
    return t ? Auction._str(t.team_name) : id;
  },

  /**
   * A projector-sized photo URL for a player.
   *
   * photo_thumb_url is a 320px variant, sized for a table row. The projector
   * shows the photo at roughly half the screen, so scaling the thumbnail up is
   * visibly soft to an audience sitting 15 metres away.
   *
   * Built from photo_file_id via Drive.thumbUrl rather than by rewriting the
   * stored thumb URL, so the width lives in one place and a change to Drive's
   * URL shape only has to be handled in Drive.gs.
   *
   * Returns '' when the player has no photo; the page renders its placeholder.
   *
   * @param {!Object} playerRow a Players row
   * @return {string} an image URL, or ''
   */
  _largePhotoUrl(playerRow) {
    const fileId = Auction._str(playerRow && playerRow.photo_file_id);
    if (!fileId) return Auction._str(playerRow && playerRow.photo_thumb_url);
    try {
      return Drive.thumbUrl(fileId, AUCTION_PROJECTOR_PHOTO_WIDTH);
    } catch (e) {
      // Never fail a poll over a photo. A soft picture beats a blank screen.
      return Auction._str(playerRow && playerRow.photo_thumb_url);
    }
  },

  /**
   * Rupees a team still has to spend.
   * @param {!Object} team a Teams row
   * @return {number} purse_total - purse_used, never below zero on a bad row
   */
  _purseRemaining(team) {
    return Util.toInt(team.purse_total, 0) - Util.toInt(team.purse_used, 0);
  },

  /**
   * Squad slots a team still has to fill.
   * @param {!Object} team a Teams row
   * @return {number} max_players - players_count
   */
  _slotsRemaining(team) {
    return Util.toInt(team.max_players, 0) - Util.toInt(team.players_count, 0);
  },

  // =========================================================================
  // AuctionResults — the append-only truth
  // =========================================================================

  /**
   * The one result row that currently describes a player, if any.
   *
   * Exactly one row per player carries is_current = TRUE. Every write path below
   * flips the previous one to FALSE before appending, so this can never be
   * ambiguous.
   *
   * @param {!Array<!Object>} resultRows every AuctionResults row, read once
   * @param {string} tournamentId the tournament
   * @param {string} playerId the player
   * @return {?Object} the current result row, or null when the player has none
   */
  _currentResult(resultRows, tournamentId, playerId) {
    const id = Auction._str(playerId);
    for (let i = 0; i < resultRows.length; i++) {
      const row = resultRows[i];
      if (Auction._str(row.player_id) !== id) continue;
      if (Auction._str(row.tournament_id) !== tournamentId) continue;
      if (row.is_current === true) return row;
    }
    return null;
  },

  /**
   * Highest, lowest and total of the sales that already stand in a tournament.
   *
   * Reads is_current SOLD rows only, so a corrected-away sale stops influencing
   * the advisory thresholds the moment it is superseded.
   *
   * @param {!Array<!Object>} resultRows every AuctionResults row, read once
   * @param {string} tournamentId the tournament
   * @param {string} [excludeAuctionId] a row to ignore, used by a correction so
   *     the sale being replaced does not compare against itself
   * @return {{count: number, highest: number, lowest: number, total: number}} the stats
   */
  _saleStats(resultRows, tournamentId, excludeAuctionId) {
    const skip = Auction._str(excludeAuctionId);
    const out = { count: 0, highest: 0, lowest: 0, total: 0 };
    for (let i = 0; i < resultRows.length; i++) {
      const row = resultRows[i];
      if (Auction._str(row.tournament_id) !== tournamentId) continue;
      if (row.is_current !== true) continue;
      if (Auction._str(row.status) !== ENUM.RESULT_STATUS.SOLD) continue;
      if (skip && Auction._str(row.auction_id) === skip) continue;
      const amount = Util.toInt(row.amount, 0);
      out.count++;
      out.total += amount;
      if (amount > out.highest) out.highest = amount;
      if (out.lowest === 0 || amount < out.lowest) out.lowest = amount;
    }
    return out;
  },

  /**
   * Flip is_current to FALSE on a result row. Never deletes, never rewrites the
   * facts in the row — only the flag that says "this is the standing answer".
   * @param {?Object} row a result row from _currentResult, or null
   * @return {void}
   */
  _supersede(row) {
    if (!row) return;
    Repo.updateRow(SHEETS.AUCTION_RESULTS, row._row, { is_current: false });
  },

  /**
   * Append one AuctionResults row.
   * @param {{tournamentId: string, player: !Object, status: string,
   *          teamId: (string|undefined), amount: (number|undefined),
   *          recordedBy: string, supersedes: (string|undefined),
   *          note: (string|undefined), at: string}} spec what happened
   * @return {!Object} the appended row, with auction_id and _row set
   */
  _appendResult(spec) {
    return Repo.append(SHEETS.AUCTION_RESULTS, {
      auction_id: Util.uid(ID_PREFIX.AUCTION),
      tournament_id: spec.tournamentId,
      player_id: Auction._str(spec.player.player_id),
      serial_no: Util.toInt(spec.player.serial_no, 0),
      status: spec.status,
      team_id: Auction._str(spec.teamId),
      // Blank, not 0, for a non-sale: "no money changed hands" and "sold for
      // nothing" must stay distinguishable in the export.
      amount: (spec.amount === undefined || spec.amount === null) ? '' : Util.toInt(spec.amount, 0),
      auction_time: spec.at,
      recorded_by: Auction._str(spec.recordedBy),
      is_current: true,
      supersedes_auction_id: Auction._str(spec.supersedes),
      note: Auction._str(spec.note)
    });
  },

  // =========================================================================
  // The §4.1 validations
  // =========================================================================

  /**
   * Steps 4, 5 and 6 of §4.1 — is this player available to be sold right now?
   *
   * Step 4 delegates to Players.isAuctionEligible. THAT IS DELIBERATE AND MUST
   * STAY. The predicate "payment_status === VERIFIED && !is_withdrawn" is
   * written once, in Players.gs, per CONTRACTS-PHASE2 §2. A second copy here
   * would drift the first time the payment rules change — and the way it fails
   * is a rejected player on the projector in front of the hall.
   *
   * @param {!Object} player the Players row, re-read inside the lock
   * @param {!Object<string,!Object>} teamsById index for naming the buyer
   * @return {void}
   * @throws {!Error} PLAYER_NOT_ELIGIBLE, PLAYER_NOT_PENDING or ALREADY_ASSIGNED
   */
  _requireSellable(player, teamsById) {
    const serial = Util.toInt(player.serial_no, 0);
    const name = Auction._str(player.name);

    // Step 4 — the single copy of the eligibility rule (CONTRACTS-PHASE2 §2).
    if (!Players.isAuctionEligible(player)) {
      const paid = Auction._str(player.payment_status) || 'PENDING';
      const withdrawn = player.is_withdrawn === true;
      throw Util.AppError(ERR.PLAYER_NOT_ELIGIBLE,
        'Player #' + serial + ' ' + name + ' is not eligible for the auction. ' +
        (withdrawn ? 'They have withdrawn.' : 'Their payment status is ' + paid + '.'));
    }

    // Step 5 — the second defence against a double sale. A caller who lost the
    // race for the lock re-reads the row here and sees the sale that already
    // happened, whatever their browser was showing.
    const status = Auction._str(player.auction_status).toUpperCase() || ENUM.AUCTION_STATUS.PENDING;
    if (status !== ENUM.AUCTION_STATUS.PENDING) {
      const sold = status === ENUM.AUCTION_STATUS.SOLD;
      throw Util.AppError(ERR.PLAYER_NOT_PENDING,
        'Player #' + serial + ' ' + name + ' is already ' + status +
        (sold
          ? ' to ' + (Auction._teamName(teamsById, player.team_id) || 'a team') +
            ' for ' + Util.formatINR(Util.toInt(player.sold_amount, 0)) + '.'
          : '. Return them to the pool first if they are being re-auctioned.'));
    }

    // Step 6 — belt and braces. A PENDING player holding a team_id means the
    // two columns disagree, which is a data fault, not a normal state.
    if (Auction._str(player.team_id)) {
      throw Util.AppError(ERR.ALREADY_ASSIGNED,
        'Player #' + serial + ' ' + name + ' is already assigned to ' +
        (Auction._teamName(teamsById, player.team_id) || Auction._str(player.team_id)) + '.');
    }
  },

  /**
   * Steps 8 and 9 of §4.1 — can this team take this player at this price?
   *
   * TEAM_FULL IS CHECKED BEFORE INSUFFICIENT_PURSE, ON PURPOSE (§4.1, DESIGN.md
   * §15 case 8). A team with no slots left gets told it has no slots left. If
   * the purse test ran first, an organiser whose squad is complete would be
   * shown a confusing message about money instead.
   *
   * @param {!Object} team the Teams row, re-read inside the lock
   * @param {number} amount the bid in whole rupees, already through Util.toMoney
   * @param {{countDelta: (number|undefined), purseDelta: (number|undefined)}} [adjust]
   *     reversal already applied by a correction, so the team is measured as it
   *     will actually be, not as the sheet currently reads
   * @return {void}
   * @throws {!Error} TEAM_FULL or INSUFFICIENT_PURSE
   */
  _requireTeamCanBuy(team, amount, adjust) {
    const a = adjust || {};
    const countDelta = Util.toInt(a.countDelta, 0);
    const purseDelta = Util.toInt(a.purseDelta, 0);

    const name = Auction._str(team.team_name);
    const count = Util.toInt(team.players_count, 0) + countDelta;
    const max = Util.toInt(team.max_players, 0);

    // Step 8 — squad size first.
    if (count >= max) {
      throw Util.AppError(ERR.TEAM_FULL,
        name + ' already has all ' + max + ' players. There is no slot left for another buy.');
    }

    // Step 9 — then the money. Exactly equal to the remaining purse is allowed
    // (DESIGN.md §15 case 6): the comparison is <=, never <.
    const remaining = Auction._purseRemaining(team) + purseDelta;
    if (amount > remaining) {
      throw Util.AppError(ERR.INSUFFICIENT_PURSE,
        'Insufficient purse amount. ' + name + ' has only ' + Util.formatINR(remaining) +
        ' remaining and the bid is ' + Util.formatINR(amount) + ' — ' +
        Util.formatINR(amount - remaining) + ' short.');
    }
  },

  /**
   * Advisory sold-amount warnings (§4.7, DESIGN.md §6.5a).
   *
   * ADVISORY ONLY. Nothing in this function may ever throw or block. Prices in
   * this tournament are genuinely unpredictable — there is no base price and no
   * increment rule — so any hard limit would eventually refuse a legitimate bid
   * in front of an audience, which is far worse than recording an odd number.
   * The first few sales trigger nothing because there is no history yet, and
   * that is correct.
   *
   * @param {!Object} team the buying team, before the sale is applied
   * @param {number} amount the bid in whole rupees
   * @param {{count: number, highest: number, lowest: number, total: number}} stats
   *     sale stats for the tournament, excluding this sale
   * @param {{countDelta: (number|undefined), purseDelta: (number|undefined)}} [adjust]
   *     the same correction reversal passed to _requireTeamCanBuy
   * @return {!Array<{code: string, message: string}>} zero or more advisories
   */
  _warnings(team, amount, stats, adjust) {
    const a = adjust || {};
    const out = [];
    const name = Auction._str(team.team_name);
    const purseTotal = Util.toInt(team.purse_total, 0);

    if (purseTotal > 0 && amount > purseTotal * AUCTION_WARN_PURSE_SHARE) {
      const pct = Math.round((amount / purseTotal) * 100);
      out.push({
        code: AUCTION_WARN.LARGE_SHARE_OF_PURSE,
        message: Util.formatINR(amount) + ' is ' + pct + '% of ' + name + "'s total purse of " +
          Util.formatINR(purseTotal) + '. Check the amount before confirming.'
      });
    }

    if (stats.count > 0 && amount > stats.highest * AUCTION_WARN_ABOVE_HIGHEST) {
      out.push({
        code: AUCTION_WARN.FAR_ABOVE_RECENT,
        message: Util.formatINR(amount) + ' is more than ' + AUCTION_WARN_ABOVE_HIGHEST +
          ' times the highest sale so far, which is ' + Util.formatINR(stats.highest) +
          '. Check for an extra zero.'
      });
    }

    const slotsAfter = Auction._slotsRemaining(team) + Util.toInt(a.countDelta, 0) - 1;
    const purseAfter = Auction._purseRemaining(team) + Util.toInt(a.purseDelta, 0) - amount;
    if (stats.count > 0 && slotsAfter > 0) {
      const perSlot = Math.floor(purseAfter / slotsAfter);
      if (perSlot < stats.lowest) {
        out.push({
          code: AUCTION_WARN.SQUAD_AT_RISK,
          message: 'This leaves ' + name + ' ' + Util.formatINR(purseAfter) + ' for ' + slotsAfter +
            ' more ' + (slotsAfter === 1 ? 'slot' : 'slots') + ' — ' + Util.formatINR(perSlot) +
            ' each, below the cheapest sale so far of ' + Util.formatINR(stats.lowest) + '.'
        });
      }
    }

    return out;
  },

  // =========================================================================
  // Version, snapshot and the current card
  // =========================================================================

  /**
   * Remember which player the projector is showing.
   * @param {string} tournamentId the tournament
   * @param {string} playerId the player now on the table, '' to clear the card
   * @return {void}
   */
  _setCurrentPlayerId(tournamentId, playerId) {
    try {
      Cache.putRaw(AUCTION_CURRENT_PREFIX + tournamentId,
        { player_id: Auction._str(playerId) }, CACHE_MAX_TTL_SEC);
    } catch (err) {
      // Presentation state only — never fail a sale because the card pointer
      // could not be cached.
      console.error('Auction: could not cache the current player for ' + tournamentId + ': ' + err);
    }
  },

  /**
   * Which player the projector should be showing.
   * @param {string} tournamentId the tournament
   * @return {string} the player id, '' when nothing is on the table
   */
  _getCurrentPlayerId(tournamentId) {
    const hit = Cache.getRaw(AUCTION_CURRENT_PREFIX + tournamentId);
    if (hit && hit.player_id) return Auction._str(hit.player_id);
    // Second chance: the last snapshot carried the same pointer, so a lost cache
    // key does not have to blank the card mid-auction.
    const snap = Cache.getSnapshot(tournamentId);
    if (snap && snap.current && snap.current.player_id) return Auction._str(snap.current.player_id);
    return '';
  },

  /**
   * The four honest outcome labels of DESIGN.md §6.9, counted once.
   *
   * With 400 players and ~100 slots roughly 300 players are never called, so
   * "came up and nobody bid" and "never came up" have to be different numbers.
   * times_called is what separates them.
   *
   * The four buckets partition the players who are in the auction pool at all:
   * eligible players, plus anyone already SOLD. A player sold earlier and made
   * ineligible afterwards still counts as sold, because their money is spent and
   * their slot is filled — pretending otherwise would make the totals lie.
   *
   * @param {!Array<!Object>} playerRows every Players row, read once
   * @param {string} tournamentId the tournament
   * @return {{eligible: number, sold: number, unsold: number,
   *           awaiting_reauction: number, not_called: number}} the counts
   */
  _poolCounts(playerRows, tournamentId) {
    const out = { eligible: 0, sold: 0, unsold: 0, awaiting_reauction: 0, not_called: 0 };
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      if (Auction._str(row.tournament_id) !== tournamentId) continue;

      // The single copy of the eligibility rule, again (CONTRACTS-PHASE2 §2).
      const eligible = Players.isAuctionEligible(row);
      if (eligible) out.eligible++;

      const status = Auction._str(row.auction_status).toUpperCase() || ENUM.AUCTION_STATUS.PENDING;
      if (!eligible && status !== ENUM.AUCTION_STATUS.SOLD) continue;

      if (status === ENUM.AUCTION_STATUS.SOLD) out.sold++;
      else if (status === ENUM.AUCTION_STATUS.UNSOLD) out.unsold++;
      else if (Util.toInt(row.times_called, 0) > 0) out.awaiting_reauction++;
      else out.not_called++;
    }
    return out;
  },

  /**
   * Build the poll snapshot (§4.5, DESIGN.md §7.3).
   *
   * Deliberately small and fixed-size: one player card, one row per team and six
   * numbers. It never carries a player list, so it stays a few kilobytes at 400
   * players and can never approach the 95 KB cap Cache.putSnapshot enforces.
   * It also carries no mobile number and no UPI reference, because the projector
   * feed (§4.2 auction.displayState) is built from exactly this object.
   *
   * @param {string} tournamentId the tournament
   * @param {number} version the version this snapshot describes
   * @param {{trn: (Object|undefined), players: (Array|undefined),
   *          teams: (Array|undefined), results: (Array|undefined)}} [preloaded]
   *     rows the caller has already read, so a write path pays for one read each
   * @return {!Object} the snapshot
   */
  _buildSnapshot(tournamentId, version, preloaded) {
    const pre = preloaded || {};
    const trn = pre.trn || Auction._tournament(tournamentId);
    const playerRows = pre.players || Repo.readAll(SHEETS.PLAYERS);
    const teamRows = pre.teams || Repo.readAll(SHEETS.TEAMS);
    const resultRows = pre.results || Repo.readAll(SHEETS.AUCTION_RESULTS);

    const teamsById = Auction._teamIndex(teamRows, tournamentId);
    const counts = Auction._poolCounts(playerRows, tournamentId);
    const stats = Auction._saleStats(resultRows, tournamentId);

    const teams = [];
    let teamsFull = 0;
    for (let i = 0; i < teamRows.length; i++) {
      const t = teamRows[i];
      if (Auction._str(t.tournament_id) !== tournamentId) continue;
      const remaining = Auction._purseRemaining(t);
      const slots = Auction._slotsRemaining(t);
      if (slots <= 0) teamsFull++;
      teams.push({
        team_id: Auction._str(t.team_id),
        team_name: Auction._str(t.team_name),
        purse_remaining: remaining,
        purse_remaining_display: Util.formatINR(remaining),
        // purse_total is not in the §4.5 shape. It is added so the organiser
        // console can raise the LARGE_SHARE_OF_PURSE advisory (§4.7) in the
        // confirm dialog, before committing, which is where DESIGN.md §6.5a
        // says the amber banner belongs. Costs ~20 bytes per team.
        purse_total: Util.toInt(t.purse_total, 0),
        players_count: Util.toInt(t.players_count, 0),
        max_players: Util.toInt(t.max_players, 0)
        // per_slot_remaining deliberately removed. It averaged the remaining
        // purse across empty slots, which implies every player costs the same.
        // Prices here are genuinely unpredictable (DESIGN.md §6.5a), so the
        // number was not just noise on the projector — it was misleading.
      });
    }
    teams.sort((a, b) => a.team_name.localeCompare(b.team_name));

    let current = null;
    const currentId = Auction._getCurrentPlayerId(tournamentId);
    if (currentId) {
      for (let i = 0; i < playerRows.length; i++) {
        const p = playerRows[i];
        if (Auction._str(p.player_id) !== currentId) continue;
        if (Auction._str(p.tournament_id) !== tournamentId) continue;
        const soldAmount = Util.toInt(p.sold_amount, 0);
        current = {
          player_id: Auction._str(p.player_id),
          serial_no: Util.toInt(p.serial_no, 0),
          name: Auction._str(p.name),
          role: Auction._str(p.role),
          style: Auction._str(p.style),
          age_years: Util.toInt(p.age_years, 0),
          photo_thumb_url: Auction._str(p.photo_thumb_url),
          // A large variant for the projector. The thumbnail is 320px wide and
          // the display shows the photo at roughly half a 1024-1920px screen,
          // so scaling the thumbnail up looks soft to an audience. Built from
          // the stored file id rather than by string-munging the thumb URL.
          photo_url: Auction._largePhotoUrl(p),
          auction_status: Auction._str(p.auction_status) || ENUM.AUCTION_STATUS.PENDING,
          team_name: Auction._teamName(teamsById, p.team_id),
          sold_amount_display: soldAmount > 0 ? Util.formatINR(soldAmount) : ''
        };
        break;
      }
    }

    return {
      v: version,
      status: Auction._str(trn.status),
      // The audience reads this. Without it display.js fell back to the raw
      // tournament id ("TRN_ghb1jr2xgs84"), which is meaningless on a screen in
      // front of a hall. Safe to expose: the name is already public on the
      // registration page.
      tournament_name: Auction._str(trn.name),
      current: current,
      teams: teams,
      summary: {
        eligible: counts.eligible,
        sold: counts.sold,
        unsold: counts.unsold,
        pending_called: counts.awaiting_reauction,
        not_called: counts.not_called,
        total_spent_display: Util.formatINR(stats.total),
        teams_full: teamsFull,
        teams_total: teams.length,
        all_teams_full: teams.length > 0 && teamsFull === teams.length,
        // Reference numbers for the pre-commit advisories of §4.7. Two integers.
        highest_sale: stats.highest,
        lowest_sale: stats.lowest
      }
    };
  },

  /**
   * Step 15 of §4.1 — bump the version and rebuild the snapshot, in that order,
   * inside the caller's lock.
   *
   * Rebuilding here rather than lazily on the next poll is what guarantees a
   * client can never fetch a version newer than the snapshot it gets. Both
   * writes happen while the lock is held, so the pair is always consistent.
   *
   * A snapshot failure must never turn a completed sale into an error: the money
   * is already on the sheet and flushed. On failure the cached snapshot is
   * dropped instead, and the next poll rebuilds it from the sheet.
   *
   * @param {string} tournamentId the tournament
   * @param {{trn: (Object|undefined), players: (Array|undefined),
   *          teams: (Array|undefined), results: (Array|undefined)}} [preloaded] rows in hand
   * @return {number} the new version
   */
  _bumpAndRebuild(tournamentId, preloaded) {
    const v = Cache.bumpVersion(tournamentId);
    try {
      Cache.putSnapshot(tournamentId, Auction._buildSnapshot(tournamentId, v, preloaded));
    } catch (err) {
      console.error('Auction: snapshot rebuild failed for ' + tournamentId +
        ' at version ' + v + ' — the next poll will rebuild it: ' + err);
      try {
        Cache.invalidate(tournamentId);
      } catch (inner) {
        console.error('Auction: snapshot invalidate also failed: ' + inner);
      }
    }
    return v;
  },

  // =========================================================================
  // Read actions
  // =========================================================================

  /**
   * Shape one player as an auction card.
   * @param {!Object} row a Players row
   * @param {!Object<string,!Object>} teamsById index from _teamIndex
   * @return {!Object} the card
   */
  _card(row, teamsById) {
    const soldAmount = Util.isBlank(row.sold_amount) ? null : Util.toInt(row.sold_amount, 0);
    const soldAt = Auction._str(row.sold_at);
    return {
      player_id: Auction._str(row.player_id),
      serial_no: Util.toInt(row.serial_no, 0),
      name: Auction._str(row.name),
      role: Auction._str(row.role),
      style: Auction._str(row.style),
      age_years: Util.toInt(row.age_years, 0),
      photo_thumb_url: Auction._str(row.photo_thumb_url),
      payment_status: Auction._str(row.payment_status),
      auction_status: Auction._str(row.auction_status) || ENUM.AUCTION_STATUS.PENDING,
      times_called: Util.toInt(row.times_called, 0),
      is_withdrawn: row.is_withdrawn === true,
      eligible: Players.isAuctionEligible(row),
      team_id: Auction._str(row.team_id),
      team_name: Auction._teamName(teamsById, row.team_id),
      sold_amount: soldAmount,
      sold_amount_display: soldAmount === null ? '' : Util.formatINR(soldAmount),
      sold_at: soldAt,
      sold_at_display: soldAt ? Util.formatIST(soldAt, true) : ''
    };
  },

  /**
   * auction.getBySerial — bring a player to the table (§4.2, §4.4).
   *
   * This is the one read that writes. It increments times_called, which is what
   * separates "came up and nobody bid" from "never came up" in the reports
   * (DESIGN.md §6.9), and it sets the card the projector shows.
   *
   * An INELIGIBLE PLAYER IS LOOKED UP BUT NEVER REVEALED: no times_called bump,
   * no projector card, no version change. The organiser still gets the row and
   * the payment status so they can act on it (DESIGN.md §15 case 19), but a
   * player whose payment was rejected cannot reach the big screen from here.
   *
   * @param {!Object} payload {tournamentId, serialNo}
   * @param {!Object} session ORGANISER or ADMIN session
   * @return {!Object} {player, revealed, v, message}
   */
  getBySerial(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    const playerRows = Repo.readAll(SHEETS.PLAYERS);
    const teamRows = Repo.readAll(SHEETS.TEAMS);
    const teamsById = Auction._teamIndex(teamRows, tid);
    const found = Auction._playerBySerial(playerRows, tid, payload.serialNo || payload.serial_no);

    if (!Players.isAuctionEligible(found)) {
      // Read-only path. Nothing is written, so nothing is audited and the
      // version does not move.
      return {
        player: Auction._card(found, teamsById),
        revealed: false,
        v: Cache.getVersion(tid),
        message: 'Player #' + Util.toInt(found.serial_no, 0) + ' ' + Auction._str(found.name) +
          ' is not verified for the auction. Payment status is ' +
          (Auction._str(found.payment_status) || 'PENDING') +
          (found.is_withdrawn === true ? ' and they have withdrawn.' : '.')
      };
    }

    const playerId = Auction._str(found.player_id);
    return Repo.withLock(() => {
      const trn = Auction._tournament(tid);
      Auction._requireLive(trn);

      // Re-read: times_called must be incremented from what the sheet says now,
      // not from the copy read before the lock was taken.
      const rows = Repo.readAll(SHEETS.PLAYERS);
      const player = Auction._playerById(rows, tid, playerId);
      const times = Util.toInt(player.times_called, 0) + 1;
      const updated = Repo.updateRow(SHEETS.PLAYERS, player._row, { times_called: times });

      Auction._setCurrentPlayerId(tid, playerId);
      Repo.flush();

      // Re-reading Players once more would cost a second full read for one
      // changed cell, so patch the in-memory copy instead.
      for (let i = 0; i < rows.length; i++) {
        if (Auction._str(rows[i].player_id) === playerId) { rows[i].times_called = times; break; }
      }
      const v = Auction._bumpAndRebuild(tid, { trn: trn, players: rows });

      return {
        // teamsById was built before the lock; a times_called bump cannot have
        // renamed a team, so there is no reason to read the tab again.
        player: Auction._card(updated, teamsById),
        revealed: true,
        v: v,
        message: ''
      };
    });
  },

  /**
   * auction.search — find a player without calling them (§4.2, §4.4).
   *
   * READ-ONLY. It must never touch times_called: searching to check a name is
   * not the same as bringing someone to the auction table, and the whole "not
   * called" report depends on that distinction.
   *
   * @param {!Object} payload {tournamentId, q, role, style, eligibleOnly, limit}
   * @param {!Object} session ORGANISER or ADMIN session
   * @return {!Object} {rows, total, limit}
   */
  search(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    const needle = Auction._str(payload.q || payload.query || payload.search).toLowerCase();
    const role = Auction._str(payload.role).toUpperCase();
    const style = Auction._str(payload.style).toUpperCase();
    const eligibleOnly = payload.eligibleOnly === true;
    const limit = Math.max(1, Math.min(Util.toInt(payload.limit, AUCTION_SEARCH_LIMIT), AUCTION_SEARCH_LIMIT));

    const playerRows = Repo.readAll(SHEETS.PLAYERS);
    const teamsById = Auction._teamIndex(Repo.readAll(SHEETS.TEAMS), tid);

    const matched = [];
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      if (Auction._str(row.tournament_id) !== tid) continue;
      if (role && Auction._str(row.role).toUpperCase() !== role) continue;
      if (style && Auction._str(row.style).toUpperCase() !== style) continue;
      if (eligibleOnly && !Players.isAuctionEligible(row)) continue;
      if (needle) {
        // search_blob carries name + role + style (DESIGN.md §32). The serial is
        // checked separately because an organiser typing "27" means serial 27,
        // not "any blob containing 27".
        const blob = Auction._str(row.search_blob).toLowerCase();
        const serial = String(Util.toInt(row.serial_no, 0));
        if (blob.indexOf(needle) === -1 &&
            Auction._str(row.name).toLowerCase().indexOf(needle) === -1 &&
            serial !== needle) {
          continue;
        }
      }
      matched.push(row);
    }

    matched.sort((a, b) => Util.toInt(a.serial_no, 0) - Util.toInt(b.serial_no, 0));
    return {
      rows: matched.slice(0, limit).map((r) => Auction._card(r, teamsById)),
      total: matched.length,
      limit: limit
    };
  },

  /**
   * auction.state — the 2-second poll (§4.5).
   *
   * ================== PERFORMANCE CONTRACT, NOT A FEATURE =====================
   * AN UNCHANGED POLL MUST NOT OPEN THE SPREADSHEET. The version comes from
   * PropertiesService and the snapshot from CacheService; neither touches a
   * sheet. Opening a Spreadsheet costs ~500 ms against ~10 ms for the cache, and
   * two clients polling every 2 s for three hours is ~10,800 requests. Doing it
   * the expensive way burns the daily quota and makes the projector visibly lag.
   *
   * The only path that reads a sheet is a cold cache, which happens once after
   * an eviction. That rebuild runs inside the lock so the version and the
   * snapshot it hands out can never disagree.
   * ===========================================================================
   *
   * @param {!Object} payload {tournamentId, v}
   * @param {!Object} session ORGANISER or ADMIN session
   * @return {!Object} {v, same: true} or {v, same: false, ...snapshot}
   */
  state(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);
    return Auction._snapshotFor(tid, payload.v);
  },

  /**
   * Shared poll body for auction.state and auction.displayState.
   * @param {string} tournamentId the tournament
   * @param {*} clientVersion the version the client already has
   * @return {!Object} {v, same} plus the snapshot when it changed
   */
  _snapshotFor(tournamentId, clientVersion) {
    // PropertiesService only. No Spreadsheet.
    const v = Cache.getVersion(tournamentId);
    // -1 so an absent v never accidentally equals a real version of 0.
    if (Util.toInt(clientVersion, -1) === v) return { v: v, same: true };

    // CacheService only. Still no Spreadsheet.
    const cached = Cache.getSnapshot(tournamentId);
    if (cached && Util.toInt(cached.v, -1) === v) {
      return Object.assign({ same: false }, cached);
    }

    // Cold cache. This is the one path that reads the sheet, and it runs inside
    // the lock so the rebuilt snapshot always matches the version it is stamped
    // with, even if a sale lands at the same moment.
    return Repo.withLock(() => {
      const liveV = Cache.getVersion(tournamentId);
      const again = Cache.getSnapshot(tournamentId);
      if (again && Util.toInt(again.v, -1) === liveV) {
        return Object.assign({ same: false }, again);
      }
      const rebuilt = Auction._buildSnapshot(tournamentId, liveV);
      try {
        Cache.putSnapshot(tournamentId, rebuilt);
      } catch (err) {
        console.error('Auction: could not cache the rebuilt snapshot for ' +
          tournamentId + ': ' + err);
      }
      return Object.assign({ same: false }, rebuilt);
    });
  },

  /**
   * Verify a projector display token, remembering the answer for a few minutes.
   *
   * Auth.verifyDisplayToken reads the Tournaments tab. Calling it on every 2 s
   * poll would open the Spreadsheet ~5,400 times over a three-hour auction and
   * defeat §4.5 for the single screen the audience is looking at. Only a
   * successful check is cached, and only for AUCTION_DTOK_TTL_SEC, so a rotated
   * token stops working within five minutes and a wrong token is never trusted.
   *
   * @param {string} tournamentId the tournament being displayed
   * @param {string} token the `k` query parameter
   * @return {boolean} true when the token is valid
   */
  _verifyDisplayToken(tournamentId, token) {
    if (Util.isBlank(tournamentId) || Util.isBlank(token)) return false;
    // The token is hashed into the key so a cache dump never reveals it.
    const key = AUCTION_DTOK_PREFIX + tournamentId + ':' + Util.sha256Hex(String(token));
    try {
      if (Cache.getRaw(key) === true) return true;
    } catch (err) {
      console.error('Auction: display token cache read failed: ' + err);
    }
    if (!Auth.verifyDisplayToken(tournamentId, token)) return false;
    try {
      Cache.putRaw(key, true, AUCTION_DTOK_TTL_SEC);
    } catch (err) {
      console.error('Auction: display token cache write failed: ' + err);
    }
    return true;
  },

  /**
   * auction.displayState — the projector feed (§4.2, DESIGN.md §8).
   *
   * PUBLIC, gated on the tournament's display token. Read-only: there is no
   * write endpoint anywhere near this action.
   *
   * The payload is built field by field from the snapshot rather than copied or
   * spread. That is deliberate. A spread would silently publish any field a
   * later phase adds to the snapshot, and the thing on the other end of this
   * action is a screen in a public hall. There is no mobile number, no UPI
   * reference, no payment status and no team_id in what comes back — only what
   * the projector actually shows.
   *
   * @param {!Object} payload {tournamentId, k, v}
   * @return {!Object} {v, same: true} or the projector view of the snapshot
   */
  displayState(payload) {
    const tid = Auction._tournamentId(payload);
    const token = Auction._str(payload.k || payload.token || payload.displayToken);
    if (!Auction._verifyDisplayToken(tid, token)) {
      // One message for a missing, wrong and rotated token alike.
      throw Util.AppError(ERR.UNAUTHORIZED,
        'This display link is not valid for that tournament. Ask the organiser for the current link.');
    }

    const snap = Auction._snapshotFor(tid, payload.v);
    if (snap.same === true) return { v: snap.v, same: true };

    const teams = [];
    const src = snap.teams || [];
    for (let i = 0; i < src.length; i++) {
      teams.push({
        team_name: src[i].team_name,
        purse_remaining_display: src[i].purse_remaining_display,
        players_count: src[i].players_count,
        max_players: src[i].max_players,
        per_slot_remaining_display: src[i].per_slot_remaining_display
      });
    }

    const c = snap.current;
    const s = snap.summary || {};
    return {
      v: snap.v,
      same: false,
      status: snap.status,
      current: c ? {
        serial_no: c.serial_no,
        name: c.name,
        role: c.role,
        style: c.style,
        age_years: c.age_years,
        photo_thumb_url: c.photo_thumb_url,
        auction_status: c.auction_status,
        team_name: c.team_name,
        sold_amount_display: c.sold_amount_display
      } : null,
      teams: teams,
      summary: {
        eligible: s.eligible,
        sold: s.sold,
        unsold: s.unsold,
        pending_called: s.pending_called,
        not_called: s.not_called,
        total_spent_display: s.total_spent_display
      }
    };
  },

  /**
   * auction.summary — the four honest labels plus the close-the-auction signal
   * (§4.6, DESIGN.md §6.9 and §27).
   *
   * @param {!Object} payload {tournamentId}
   * @param {!Object} session ORGANISER or ADMIN session
   * @return {!Object} the §4.6 summary
   */
  summary(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    const trn = Auction._tournament(tid);
    const playerRows = Repo.readAll(SHEETS.PLAYERS);
    const teamRows = Repo.readAll(SHEETS.TEAMS);
    const resultRows = Repo.readAll(SHEETS.AUCTION_RESULTS);

    const counts = Auction._poolCounts(playerRows, tid);
    // total_spent comes from AuctionResults, the append-only truth, not from the
    // Teams counters it maintains (CONTRACTS-PHASE3 §3).
    const stats = Auction._saleStats(resultRows, tid);

    let teamsTotal = 0;
    let teamsFull = 0;
    for (let i = 0; i < teamRows.length; i++) {
      if (Auction._str(teamRows[i].tournament_id) !== tid) continue;
      teamsTotal++;
      if (Auction._slotsRemaining(teamRows[i]) <= 0) teamsFull++;
    }

    // Advisory only (§4.6). The admin still clicks close — nothing here forces it.
    const allFull = teamsTotal > 0 && teamsFull === teamsTotal;
    return {
      status: Auction._str(trn.status),
      eligible: counts.eligible,
      sold: counts.sold,
      unsold: counts.unsold,
      awaiting_reauction: counts.awaiting_reauction,
      not_called: counts.not_called,
      total_spent: stats.total,
      total_spent_display: Util.formatINR(stats.total),
      highest_sale: stats.highest,
      lowest_sale: stats.lowest,
      teams_full: teamsFull,
      teams_total: teamsTotal,
      all_teams_full: allFull,
      banner: allFull
        ? 'All ' + teamsTotal + ' teams are full. ' + counts.not_called +
          ' players were not called. You can close the auction.'
        : ''
    };
  },

  /**
   * auction.history — every AuctionResults row for the tournament, newest first,
   * INCLUDING superseded ones (§4.2).
   *
   * Superseded rows are the point of this action. A correction never deletes, so
   * the history is the evidence that settles an argument about what was recorded
   * and when (DESIGN.md §42, §43).
   *
   * @param {!Object} payload {tournamentId, limit}
   * @param {!Object} session ORGANISER or ADMIN session
   * @return {!Object} {rows, total}
   */
  history(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    const resultRows = Repo.readAll(SHEETS.AUCTION_RESULTS);
    const teamsById = Auction._teamIndex(Repo.readAll(SHEETS.TEAMS), tid);

    const playersById = {};
    const playerRows = Repo.readAll(SHEETS.PLAYERS);
    for (let i = 0; i < playerRows.length; i++) {
      if (Auction._str(playerRows[i].tournament_id) !== tid) continue;
      playersById[Auction._str(playerRows[i].player_id)] = playerRows[i];
    }

    const mine = [];
    for (let i = 0; i < resultRows.length; i++) {
      if (Auction._str(resultRows[i].tournament_id) === tid) mine.push(resultRows[i]);
    }

    // Newest first. Rows written in the same millisecond fall back to sheet
    // order, which is append order, so the sequence is always total.
    mine.sort((a, b) => {
      const ta = Date.parse(Auction._str(a.auction_time)) || 0;
      const tb = Date.parse(Auction._str(b.auction_time)) || 0;
      if (tb !== ta) return tb - ta;
      return Util.toInt(b._row, 0) - Util.toInt(a._row, 0);
    });

    const limit = Util.toInt(payload.limit, 0);
    const slice = limit > 0 ? mine.slice(0, limit) : mine;

    return {
      total: mine.length,
      rows: slice.map((r) => {
        const player = playersById[Auction._str(r.player_id)];
        const amount = Util.isBlank(r.amount) ? null : Util.toInt(r.amount, 0);
        const at = Auction._str(r.auction_time);
        return {
          auction_id: Auction._str(r.auction_id),
          player_id: Auction._str(r.player_id),
          serial_no: Util.toInt(r.serial_no, 0),
          name: player ? Auction._str(player.name) : '',
          status: Auction._str(r.status),
          team_id: Auction._str(r.team_id),
          team_name: Auction._teamName(teamsById, r.team_id),
          amount: amount,
          amount_display: amount === null ? '' : Util.formatINR(amount),
          auction_time: at,
          auction_time_display: at ? Util.formatIST(at, true) : '',
          recorded_by: Auction._str(r.recorded_by),
          is_current: r.is_current === true,
          supersedes_auction_id: Auction._str(r.supersedes_auction_id),
          note: Auction._str(r.note)
        };
      })
    };
  },

  // =========================================================================
  // Write actions — every one of them runs the §4.1 critical section
  // =========================================================================

  /**
   * The shell every state-changing auction action runs inside.
   *
   * It owns steps 1, 2, 3, 14 and 15 of §4.1: take the lock, check the version,
   * re-read every tab from the sheet, hand the fresh rows to the body, flush,
   * then bump the version and rebuild the snapshot. The body owns the checks and
   * the writes that are specific to it.
   *
   * ONE Repo.readAll PER TAB, done here, so no body is ever tempted to call
   * Repo.findBy inside a loop (CONTRACTS-PHASE4-7 cross-cutting rule 7).
   *
   * @param {{tournamentId: string, expectedVersion: *, session: !Object,
   *          requireLive: (boolean|undefined), mutatesTournament: (boolean|undefined),
   *          body: function(!Object): !Object}} spec what to run
   * @return {!Object} the body's result, with the new version added
   */
  _write(spec) {
    const tid = spec.tournamentId;
    return Repo.withLock(() => {
      // ---- Step 1. Version check. Defence three against a stale tab.
      Auction._requireVersion(tid, spec.expectedVersion);

      // ---- Step 2. Re-read everything from the sheet. Defence two: whatever
      // the client believed, this is what is actually recorded right now.
      const trn = Auction._tournament(tid);
      const players = Repo.readAll(SHEETS.PLAYERS);
      const teams = Repo.readAll(SHEETS.TEAMS);
      const results = Repo.readAll(SHEETS.AUCTION_RESULTS);

      // ---- Step 3. The auction has to be live.
      if (spec.requireLive !== false) Auction._requireLive(trn);

      const ctx = {
        tournamentId: tid,
        session: spec.session,
        trn: trn,
        players: players,
        teams: teams,
        results: results,
        teamsById: Auction._teamIndex(teams, tid),
        at: Util.nowIso()
      };

      const out = spec.body(ctx);

      // ---- Step 14. Push the writes out before the lock is released, so the
      // next caller's re-read genuinely sees them.
      Repo.flush();

      // ---- Step 15. Bump, then rebuild the snapshot from the same lock.
      // Players, Teams and AuctionResults are deliberately re-read rather than
      // patched in memory: the snapshot must describe the sheet, not what the
      // body believes it wrote. The tournament row is handed over only when the
      // body cannot have changed it — close and reopen do, everything else
      // does not, and re-reading a nine-row tab per sale is pure waste.
      out.v = Auction._bumpAndRebuild(tid,
        spec.mutatesTournament === true ? undefined : { trn: trn });
      return out;
    });
  },

  /**
   * Apply a set of counter deltas to Teams rows, one write per team.
   *
   * A correction that moves a player between two teams touches two rows; one
   * that only changes the amount touches one. Collecting the deltas first means
   * a same-team correction is a single, correct write instead of two that
   * cancel out by luck.
   *
   * @param {!Object<string,{row: !Object, purse: number, count: number}>} deltas
   *     keyed by team_id
   * @return {!Object<string,!Object>} team_id -> the merged Teams row after writing
   */
  _applyTeamDeltas(deltas) {
    const out = {};
    const ids = Object.keys(deltas);
    for (let i = 0; i < ids.length; i++) {
      const d = deltas[ids[i]];
      if (d.purse === 0 && d.count === 0) { out[ids[i]] = d.row; continue; }
      out[ids[i]] = Repo.updateRow(SHEETS.TEAMS, d.row._row, {
        purse_used: Util.toInt(d.row.purse_used, 0) + d.purse,
        players_count: Util.toInt(d.row.players_count, 0) + d.count
      });
    }
    return out;
  },

  /**
   * auction.markSold — the critical section of §4.1, in the order given there.
   *
   * ================== THREE DEFENCES AGAINST A DOUBLE SALE ====================
   * All three are here on purpose and none of them is redundant.
   *
   *   1. THE LOCK (_write -> Repo.withLock) serialises the writes, so two
   *      organisers pressing SOLD at the same instant are processed one after
   *      the other rather than interleaved.
   *   2. THE RE-READ (_write step 2, checked by _requireSellable step 5) means
   *      the caller who lost that race sees auction_status = SOLD on the sheet
   *      and is refused with PLAYER_NOT_PENDING. Without it the second caller
   *      would happily write a second sale over the first.
   *   3. THE VERSION CHECK (_requireVersion) stops a stale tab acting on old
   *      information even when the action would otherwise be legal — a screen
   *      that has not polled for a minute does not get to spend a purse it
   *      remembers rather than the one that exists.
   *
   * Removing any one of them leaves a real hole. Do not "simplify" them.
   * ===========================================================================
   *
   * @param {!Object} payload {tournamentId, playerId, teamId, amount, expectedVersion, note}
   * @param {!Object} session ORGANISER or ADMIN session
   * @return {!Object} {player, team, result, warnings, v}
   */
  markSold(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    return Auction._write({
      tournamentId: tid,
      expectedVersion: payload.expectedVersion,
      session: session,
      body: (ctx) => {
        const player = Auction._playerById(ctx.players, tid, payload.playerId);

        // ---- Steps 4, 5, 6. Eligibility via Players.isAuctionEligible only.
        Auction._requireSellable(player, ctx.teamsById);

        // ---- Step 7. Positive whole rupees, and nothing more (DESIGN.md §6.5a).
        const amount = Util.toMoney(payload.amount);

        const team = Auction._teamById(ctx.teams, tid, payload.teamId);

        // ---- Steps 8 and 9, in that order: TEAM_FULL before INSUFFICIENT_PURSE.
        Auction._requireTeamCanBuy(team, amount);

        const stats = Auction._saleStats(ctx.results, tid);
        const warnings = Auction._warnings(team, amount, stats);

        const prev = {
          auction_status: Auction._str(player.auction_status) || ENUM.AUCTION_STATUS.PENDING,
          team_id: Auction._str(player.team_id),
          sold_amount: Util.isBlank(player.sold_amount) ? null : Util.toInt(player.sold_amount, 0),
          team_purse_used: Util.toInt(team.purse_used, 0),
          team_players_count: Util.toInt(team.players_count, 0)
        };

        // ---- Step 10. Append the result. A player returned to the pool has an
        // older standing row; retire it so exactly one row is ever current.
        Auction._supersede(Auction._currentResult(ctx.results, tid, player.player_id));
        const result = Auction._appendResult({
          tournamentId: tid,
          player: player,
          status: ENUM.RESULT_STATUS.SOLD,
          teamId: team.team_id,
          amount: amount,
          recordedBy: session.user_id,
          note: payload.note,
          at: ctx.at
        });

        // ---- Step 11. The Players row mirrors the standing result.
        const updatedPlayer = Repo.updateRow(SHEETS.PLAYERS, player._row, {
          auction_status: ENUM.AUCTION_STATUS.SOLD,
          team_id: Auction._str(team.team_id),
          sold_amount: amount,
          sold_at: ctx.at
        });

        // ---- Step 12. Counters, inside this lock, never recomputed by scanning
        // Players (CONTRACTS-PHASE3 §3).
        const teamsAfter = Auction._applyTeamDeltas({
          [Auction._str(team.team_id)]: { row: team, purse: amount, count: 1 }
        });
        const updatedTeam = teamsAfter[Auction._str(team.team_id)];

        // ---- Step 13. Audit with prev and next.
        Audit.log({
          actor: session.user_id,
          role: session.role,
          action: Audit.ACTIONS.PLAYER_SOLD,
          tournamentId: tid,
          entityType: 'Player',
          entityId: Auction._str(player.player_id),
          prev: prev,
          next: {
            auction_status: ENUM.AUCTION_STATUS.SOLD,
            team_id: Auction._str(team.team_id),
            team_name: Auction._str(team.team_name),
            sold_amount: amount,
            sold_at: ctx.at,
            auction_id: Auction._str(result.auction_id),
            team_purse_used: Util.toInt(updatedTeam.purse_used, 0),
            team_players_count: Util.toInt(updatedTeam.players_count, 0)
          },
          ua: payload.ua
        });

        // The card on the projector is this player, so the SOLD state is what
        // the hall sees next.
        Auction._setCurrentPlayerId(tid, Auction._str(player.player_id));

        return {
          // ctx.teamsById is enough to name the buyer: the sale changed the
          // team's counters, never its name, and the fresh counters come back
          // in `team` below. Re-reading the whole Teams tab here would cost a
          // second Spreadsheet read per sale for nothing.
          player: Auction._card(updatedPlayer, ctx.teamsById),
          team: Auction._teamSummary(updatedTeam),
          result: { auction_id: Auction._str(result.auction_id), status: ENUM.RESULT_STATUS.SOLD },
          // Advisory, after the fact, never a reason to refuse (§4.7).
          warnings: warnings
        };
      }
    });
  },

  /**
   * auction.markUnsold — nobody bid (§4.2).
   *
   * The same shape as markSold minus the team and purse checks: no money moves
   * and no slot is taken, so steps 7, 8 and 9 do not apply.
   *
   * @param {!Object} payload {tournamentId, playerId, expectedVersion, note}
   * @param {!Object} session ORGANISER or ADMIN session
   * @return {!Object} {player, result, v}
   */
  markUnsold(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    return Auction._write({
      tournamentId: tid,
      expectedVersion: payload.expectedVersion,
      session: session,
      body: (ctx) => {
        const player = Auction._playerById(ctx.players, tid, payload.playerId);
        Auction._requireSellable(player, ctx.teamsById);

        const prev = {
          auction_status: Auction._str(player.auction_status) || ENUM.AUCTION_STATUS.PENDING,
          times_called: Util.toInt(player.times_called, 0)
        };

        Auction._supersede(Auction._currentResult(ctx.results, tid, player.player_id));
        const result = Auction._appendResult({
          tournamentId: tid,
          player: player,
          status: ENUM.RESULT_STATUS.UNSOLD,
          recordedBy: session.user_id,
          note: payload.note,
          at: ctx.at
        });

        const updatedPlayer = Repo.updateRow(SHEETS.PLAYERS, player._row, {
          auction_status: ENUM.AUCTION_STATUS.UNSOLD
        });

        Audit.log({
          actor: session.user_id,
          role: session.role,
          action: Audit.ACTIONS.PLAYER_UNSOLD,
          tournamentId: tid,
          entityType: 'Player',
          entityId: Auction._str(player.player_id),
          prev: prev,
          next: {
            auction_status: ENUM.AUCTION_STATUS.UNSOLD,
            auction_id: Auction._str(result.auction_id),
            auction_time: ctx.at
          },
          ua: payload.ua
        });

        Auction._setCurrentPlayerId(tid, Auction._str(player.player_id));

        return {
          player: Auction._card(updatedPlayer, ctx.teamsById),
          result: { auction_id: Auction._str(result.auction_id), status: ENUM.RESULT_STATUS.UNSOLD }
        };
      }
    });
  },

  /**
   * auction.returnToPool — UNSOLD back to PENDING (§4.2, DESIGN.md §6.6).
   *
   * WHY THIS ACTION EXISTS: section 23 of the requirement says an unsold player
   * "might get sold after sometime", and no other control in the system can move
   * a player out of UNSOLD. Without it that sentence is unimplementable.
   *
   * times_called is deliberately NOT reset. The player has been to the table, so
   * they belong in "awaiting re-auction", not back in "not called" (DESIGN.md
   * §6.9) — resetting it would erase the difference the reports are built on.
   *
   * @param {!Object} payload {tournamentId, playerId, expectedVersion, note}
   * @param {!Object} session ORGANISER or ADMIN session
   * @return {!Object} {player, result, v}
   */
  returnToPool(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    return Auction._write({
      tournamentId: tid,
      expectedVersion: payload.expectedVersion,
      session: session,
      body: (ctx) => {
        const player = Auction._playerById(ctx.players, tid, payload.playerId);
        const serial = Util.toInt(player.serial_no, 0);
        const name = Auction._str(player.name);
        const status = Auction._str(player.auction_status).toUpperCase() || ENUM.AUCTION_STATUS.PENDING;

        if (status === ENUM.AUCTION_STATUS.SOLD) {
          // A sale is unwound through auction.correct, which reverses the purse
          // and the slot. Quietly clearing the status here would leave the money
          // spent against nobody.
          throw Util.AppError(ERR.ALREADY_ASSIGNED,
            'Player #' + serial + ' ' + name + ' is SOLD to ' +
            (Auction._teamName(ctx.teamsById, player.team_id) || 'a team') +
            ' for ' + Util.formatINR(Util.toInt(player.sold_amount, 0)) +
            '. Use Correct to undo a sale — Return to pool only works on an unsold player.');
        }
        if (status !== ENUM.AUCTION_STATUS.UNSOLD) {
          throw Util.AppError(ERR.VALIDATION_FAILED,
            'Player #' + serial + ' ' + name + ' is already in the pool with status ' + status +
            '. Return to pool only applies to a player marked UNSOLD.');
        }

        Auction._supersede(Auction._currentResult(ctx.results, tid, player.player_id));
        // No supersedes_auction_id: this is a new event in the player's history,
        // not a correction of the UNSOLD row, which remains a true record of
        // what happened at the time (§4.3 reserves supersedes for corrections).
        const result = Auction._appendResult({
          tournamentId: tid,
          player: player,
          status: ENUM.RESULT_STATUS.RETURNED_TO_POOL,
          recordedBy: session.user_id,
          note: payload.note,
          at: ctx.at
        });

        const updatedPlayer = Repo.updateRow(SHEETS.PLAYERS, player._row, {
          auction_status: ENUM.AUCTION_STATUS.PENDING,
          team_id: '',
          sold_amount: '',
          sold_at: ''
        });

        Audit.log({
          actor: session.user_id,
          role: session.role,
          action: Audit.ACTIONS.PLAYER_RETURNED_TO_POOL,
          tournamentId: tid,
          entityType: 'Player',
          entityId: Auction._str(player.player_id),
          prev: { auction_status: ENUM.AUCTION_STATUS.UNSOLD, times_called: Util.toInt(player.times_called, 0) },
          next: {
            auction_status: ENUM.AUCTION_STATUS.PENDING,
            times_called: Util.toInt(player.times_called, 0),
            auction_id: Auction._str(result.auction_id),
            auction_time: ctx.at
          },
          ua: payload.ua
        });

        return {
          player: Auction._card(updatedPlayer, ctx.teamsById),
          result: {
            auction_id: Auction._str(result.auction_id),
            status: ENUM.RESULT_STATUS.RETURNED_TO_POOL
          }
        };
      }
    });
  },

  /**
   * auction.correct — fix a recorded result without deleting anything
   * (§4.3, DESIGN.md §6.7, §43).
   *
   * The sequence, all inside one lock:
   *   1. Reverse the standing result's effect on its team.
   *   2. Validate the new team and amount from scratch — A CORRECTION CAN
   *      OVERSPEND A PURSE JUST AS EASILY AS A FRESH SALE, and it is more likely
   *      to, because it is typed under pressure after a mistake.
   *   3. Apply the new effect.
   *   4. Append a superseding row and flip is_current on the old one.
   *   5. Audit both values.
   *
   * Nothing is deleted and nothing in the old row is rewritten except the flag
   * that says it is no longer the standing answer.
   *
   * Two §4.1 checks are deliberately skipped: PLAYER_NOT_PENDING and
   * ALREADY_ASSIGNED. Correcting an already-sold player is the entire purpose of
   * this action, so applying them would make it impossible to call.
   *
   * @param {!Object} payload {tournamentId, playerId, newStatus, teamId, amount,
   *                           expectedVersion, note}
   * @param {!Object} session ADMIN, or ORGANISER while the auction is still open
   * @return {!Object} {player, result, warnings, v}
   */
  correct(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    const newStatus = (Auction._str(payload.newStatus || payload.status) ||
      ENUM.RESULT_STATUS.SOLD).toUpperCase();
    if (newStatus !== ENUM.AUCTION_STATUS.SOLD &&
        newStatus !== ENUM.AUCTION_STATUS.UNSOLD &&
        newStatus !== ENUM.AUCTION_STATUS.PENDING) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'newStatus must be SOLD, UNSOLD or PENDING, not "' + newStatus + '".');
    }

    return Auction._write({
      tournamentId: tid,
      expectedVersion: payload.expectedVersion,
      session: session,
      // An admin must be able to fix a mistake after the auction is closed —
      // that is when most of them are noticed. The gate below is status-aware
      // instead of a flat requireLive.
      requireLive: false,
      body: (ctx) => {
        const status = Auction._str(ctx.trn.status).toUpperCase();
        if (status === ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED) {
          // §4.2: ADMIN always; ORGANISER only before the auction is closed.
          if (Auction._str(session.role) !== ENUM.USER_ROLE.ADMIN) {
            throw Util.AppError(ERR.AUCTION_CLOSED,
              'The auction is closed. Only an admin can correct a result once it has been closed.');
          }
        } else if (status !== ENUM.TOURNAMENT_STATUS.AUCTION_LIVE) {
          throw Util.AppError(ERR.AUCTION_NOT_LIVE,
            'There is nothing to correct — the tournament status is ' + (status || 'blank') + '.');
        }

        const player = Auction._playerById(ctx.players, tid, payload.playerId);
        const serial = Util.toInt(player.serial_no, 0);
        const name = Auction._str(player.name);

        const old = Auction._currentResult(ctx.results, tid, player.player_id);
        if (!old) {
          throw Util.AppError(ERR.NOT_FOUND,
            'There is no auction result for player #' + serial + ' ' + name + ' to correct.');
        }

        const oldStatus = Auction._str(old.status);
        const oldAmount = Util.toInt(old.amount, 0);
        const oldTeamId = Auction._str(old.team_id);

        // ---- 1. Reverse the old effect. Only a SOLD row ever had one.
        const deltas = {};
        if (oldStatus === ENUM.RESULT_STATUS.SOLD && oldTeamId) {
          const oldTeam = Auction._teamById(ctx.teams, tid, oldTeamId);
          deltas[oldTeamId] = { row: oldTeam, purse: -oldAmount, count: -1 };
        }

        // ---- 2. Validate the new state against the team as it will be.
        let newTeam = null;
        let newAmount = null;
        let warnings = [];

        if (newStatus === ENUM.AUCTION_STATUS.SOLD) {
          // A correction to SOLD still has to respect the pool rule: only an
          // eligible player may hold a slot (CONTRACTS-PHASE2 §2).
          if (!Players.isAuctionEligible(player)) {
            throw Util.AppError(ERR.PLAYER_NOT_ELIGIBLE,
              'Player #' + serial + ' ' + name + ' is not eligible for the auction. ' +
              'Their payment status is ' + (Auction._str(player.payment_status) || 'PENDING') +
              '. Fix the payment before correcting the sale.');
          }

          newAmount = Util.toMoney(payload.amount);
          const wantTeamId = Auction._str(payload.teamId) || oldTeamId;
          newTeam = Auction._teamById(ctx.teams, tid, wantTeamId);
          const newTeamId = Auction._str(newTeam.team_id);

          // Measure the target team with the reversal already counted, so
          // changing only the amount on the same team does not read as a
          // second player at a second full price.
          //
          // Signs: reversal.purse is negative (it subtracts from purse_used) and
          // reversal.count is -1. _requireTeamCanBuy wants deltas on the team as
          // the organiser experiences it, where LESS purse_used means MORE purse
          // remaining — hence the negation on purse, and none on count.
          const reversal = deltas[newTeamId];
          const adjust = {
            purseDelta: reversal ? -reversal.purse : 0,
            countDelta: reversal ? reversal.count : 0
          };

          Auction._requireTeamCanBuy(newTeam, newAmount, adjust);
          warnings = Auction._warnings(
            newTeam, newAmount,
            Auction._saleStats(ctx.results, tid, Auction._str(old.auction_id)),
            adjust
          );

          if (deltas[newTeamId]) {
            deltas[newTeamId].purse += newAmount;
            deltas[newTeamId].count += 1;
          } else {
            deltas[newTeamId] = { row: newTeam, purse: newAmount, count: 1 };
          }
        }

        const prev = {
          auction_status: Auction._str(player.auction_status),
          team_id: oldTeamId,
          team_name: Auction._teamName(ctx.teamsById, oldTeamId),
          sold_amount: oldStatus === ENUM.RESULT_STATUS.SOLD ? oldAmount : null,
          sold_at: Auction._str(player.sold_at),
          result_status: oldStatus,
          auction_id: Auction._str(old.auction_id)
        };

        // ---- 3 and 4. Retire the old row, append the superseding one.
        Auction._supersede(old);
        const result = Auction._appendResult({
          tournamentId: tid,
          player: player,
          status: newStatus === ENUM.AUCTION_STATUS.PENDING
            ? ENUM.RESULT_STATUS.RETURNED_TO_POOL
            : newStatus,
          teamId: newTeam ? newTeam.team_id : '',
          amount: newAmount === null ? undefined : newAmount,
          recordedBy: session.user_id,
          supersedes: Auction._str(old.auction_id),
          note: payload.note,
          at: ctx.at
        });

        // Correcting back to PENDING or UNSOLD must clear the sale outright:
        // team_id, sold_amount and sold_at all go (§4.3).
        const patch = (newStatus === ENUM.AUCTION_STATUS.SOLD)
          ? {
            auction_status: ENUM.AUCTION_STATUS.SOLD,
            team_id: Auction._str(newTeam.team_id),
            sold_amount: newAmount,
            sold_at: ctx.at
          }
          : {
            auction_status: newStatus,
            team_id: '',
            sold_amount: '',
            sold_at: ''
          };
        const updatedPlayer = Repo.updateRow(SHEETS.PLAYERS, player._row, patch);

        const teamsAfter = Auction._applyTeamDeltas(deltas);

        // ---- 5. Audit both values.
        Audit.log({
          actor: session.user_id,
          role: session.role,
          action: Audit.ACTIONS.AUCTION_CORRECTED,
          tournamentId: tid,
          entityType: 'Player',
          entityId: Auction._str(player.player_id),
          prev: prev,
          next: {
            auction_status: newStatus,
            team_id: newTeam ? Auction._str(newTeam.team_id) : '',
            team_name: newTeam ? Auction._str(newTeam.team_name) : '',
            sold_amount: newAmount,
            sold_at: newStatus === ENUM.AUCTION_STATUS.SOLD ? ctx.at : '',
            result_status: Auction._str(result.status),
            auction_id: Auction._str(result.auction_id),
            supersedes_auction_id: Auction._str(old.auction_id),
            teams: Object.keys(teamsAfter).map((id) => ({
              team_id: id,
              purse_used: Util.toInt(teamsAfter[id].purse_used, 0),
              players_count: Util.toInt(teamsAfter[id].players_count, 0)
            }))
          },
          ua: payload.ua
        });

        Auction._setCurrentPlayerId(tid, Auction._str(player.player_id));

        return {
          player: Auction._card(updatedPlayer, ctx.teamsById),
          result: {
            auction_id: Auction._str(result.auction_id),
            status: Auction._str(result.status),
            supersedes_auction_id: Auction._str(old.auction_id)
          },
          teams: Object.keys(teamsAfter).map((id) => Auction._teamSummary(teamsAfter[id])),
          warnings: warnings
        };
      }
    });
  },

  /**
   * Small public view of a team, used in write responses so the console can
   * update its purse column without a second round trip.
   * @param {!Object} team a Teams row
   * @return {!Object} the team summary
   */
  _teamSummary(team) {
    const remaining = Auction._purseRemaining(team);
    const slots = Auction._slotsRemaining(team);
    return {
      team_id: Auction._str(team.team_id),
      team_name: Auction._str(team.team_name),
      purse_total: Util.toInt(team.purse_total, 0),
      purse_used: Util.toInt(team.purse_used, 0),
      purse_remaining: remaining,
      purse_remaining_display: Util.formatINR(remaining),
      players_count: Util.toInt(team.players_count, 0),
      max_players: Util.toInt(team.max_players, 0),
      slots_remaining: slots,
      per_slot_remaining_display: slots > 0 ? Util.formatINR(Math.floor(remaining / slots)) : 'Squad full'
    };
  },

  // =========================================================================
  // Closing and reopening (§4.2, DESIGN.md §6.8)
  // =========================================================================

  /**
   * auction.close — AUCTION_LIVE to AUCTION_CLOSED.
   *
   * After this every organiser write returns AUCTION_CLOSED, because
   * _requireLive refuses on that status (DESIGN.md §15 case 20). Only an admin
   * can reopen.
   *
   * @param {!Object} payload {tournamentId, expectedVersion, note}
   * @param {!Object} session ADMIN session
   * @return {!Object} {tournament_id, status, prev_status, summary, v}
   */
  close(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    return Auction._write({
      tournamentId: tid,
      expectedVersion: payload.expectedVersion,
      session: session,
      requireLive: false,
      mutatesTournament: true,
      body: (ctx) => {
        const status = Auction._str(ctx.trn.status).toUpperCase();
        if (status === ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED) {
          // Two admins clicking close is not an error worth a scary message.
          return {
            tournament_id: tid,
            status: ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED,
            prev_status: status,
            alreadyClosed: true
          };
        }
        if (status !== ENUM.TOURNAMENT_STATUS.AUCTION_LIVE) {
          throw Util.AppError(ERR.AUCTION_NOT_LIVE,
            'The auction cannot be closed — the tournament status is ' + (status || 'blank') +
            ', not AUCTION_LIVE.');
        }

        const counts = Auction._poolCounts(ctx.players, tid);
        const stats = Auction._saleStats(ctx.results, tid);

        Repo.updateRow(SHEETS.TOURNAMENTS, ctx.trn._row, {
          status: ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED
        });

        Audit.log({
          actor: session.user_id,
          role: session.role,
          action: Audit.ACTIONS.AUCTION_CLOSED,
          tournamentId: tid,
          entityType: 'Tournament',
          entityId: tid,
          prev: { status: status },
          next: {
            status: ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED,
            closed_at: ctx.at,
            sold: counts.sold,
            unsold: counts.unsold,
            awaiting_reauction: counts.awaiting_reauction,
            not_called: counts.not_called,
            total_spent: stats.total,
            note: Auction._str(payload.note)
          },
          ua: payload.ua
        });

        return {
          tournament_id: tid,
          status: ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED,
          prev_status: status,
          alreadyClosed: false,
          summary: {
            sold: counts.sold,
            unsold: counts.unsold,
            awaiting_reauction: counts.awaiting_reauction,
            not_called: counts.not_called,
            total_spent: stats.total,
            total_spent_display: Util.formatINR(stats.total)
          }
        };
      }
    });
  },

  /**
   * auction.reopen — AUCTION_CLOSED back to AUCTION_LIVE. ADMIN only, audited.
   *
   * Reopening a closed auction is a serious act: it re-enables every organiser
   * write. The audit row is the record of who decided that and when
   * (DESIGN.md §6.8, §42).
   *
   * @param {!Object} payload {tournamentId, expectedVersion, reason}
   * @param {!Object} session ADMIN session
   * @return {!Object} {tournament_id, status, prev_status, v}
   */
  reopen(payload, session) {
    const tid = Auction._tournamentId(payload);
    Auth.requireTournament(session, tid);

    return Auction._write({
      tournamentId: tid,
      expectedVersion: payload.expectedVersion,
      session: session,
      requireLive: false,
      mutatesTournament: true,
      body: (ctx) => {
        const status = Auction._str(ctx.trn.status).toUpperCase();
        if (status === ENUM.TOURNAMENT_STATUS.AUCTION_LIVE) {
          return {
            tournament_id: tid,
            status: ENUM.TOURNAMENT_STATUS.AUCTION_LIVE,
            prev_status: status,
            alreadyOpen: true
          };
        }
        if (status !== ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED) {
          throw Util.AppError(ERR.AUCTION_NOT_LIVE,
            'Only a closed auction can be reopened — the tournament status is ' +
            (status || 'blank') + '.');
        }

        Repo.updateRow(SHEETS.TOURNAMENTS, ctx.trn._row, {
          status: ENUM.TOURNAMENT_STATUS.AUCTION_LIVE
        });

        Audit.log({
          actor: session.user_id,
          role: session.role,
          action: Audit.ACTIONS.AUCTION_REOPENED,
          tournamentId: tid,
          entityType: 'Tournament',
          entityId: tid,
          prev: { status: ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED },
          next: {
            status: ENUM.TOURNAMENT_STATUS.AUCTION_LIVE,
            reopened_at: ctx.at,
            reason: Auction._str(payload.reason || payload.note)
          },
          ua: payload.ua
        });

        return {
          tournament_id: tid,
          status: ENUM.TOURNAMENT_STATUS.AUCTION_LIVE,
          prev_status: status,
          alreadyOpen: false
        };
      }
    });
  }
};

/**
 * Auction route table (CONTRACTS-PHASE4-7 §4.2).
 *
 * auction.displayState is PUBLIC. It is the projector feed and the browser
 * showing it has no session — access is gated on the tournament's display token
 * instead (DESIGN.md §5.5). It must be added to EXPECTED_PUBLIC in
 * tools/check.js, deliberately, as the cross-cutting rules require.
 *
 * @return {!Object} route table fragment
 */
function AuctionRoutes() {
  return {
    'auction.getBySerial': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, serialNo}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {player, revealed, v, message}
       */
      handler: (payload, session) => Auction.getBySerial(payload, session)
    },

    'auction.search': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, q, role, style, eligibleOnly, limit}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {rows, total, limit}
       */
      handler: (payload, session) => Auction.search(payload, session)
    },

    'auction.markSold': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, playerId, teamId, amount, expectedVersion}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {player, team, result, warnings, v}
       */
      handler: (payload, session) => Auction.markSold(payload, session)
    },

    'auction.markUnsold': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, playerId, expectedVersion}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {player, result, v}
       */
      handler: (payload, session) => Auction.markUnsold(payload, session)
    },

    'auction.returnToPool': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, playerId, expectedVersion}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {player, result, v}
       */
      handler: (payload, session) => Auction.returnToPool(payload, session)
    },

    'auction.correct': {
      // ORGANISER is allowed through the route so the handler can apply the
      // §4.2 rule properly: an organiser may correct until the auction is
      // closed, an admin at any time. A flat ['ADMIN'] here would block the
      // common case of fixing a typo thirty seconds after making it.
      auth: ['ADMIN', 'ORGANISER'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, playerId, newStatus, teamId, amount, expectedVersion}
       * @param {!Object} session ADMIN, or ORGANISER before the auction closes
       * @return {!Object} {player, result, teams, warnings, v}
       */
      handler: (payload, session) => Auction.correct(payload, session)
    },

    'auction.state': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, v}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {v, same} plus the snapshot when it changed
       */
      handler: (payload, session) => Auction.state(payload, session)
    },

    'auction.displayState': {
      auth: 'PUBLIC',
      methods: ['GET', 'POST'],
      /**
       * @param {!Object} payload {tournamentId, k, v}
       * @return {!Object} {v, same} plus the projector view when it changed
       */
      handler: (payload) => Auction.displayState(payload)
    },

    'auction.summary': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} the §4.6 summary
       */
      handler: (payload, session) => Auction.summary(payload, session)
    },

    'auction.history': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, limit}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {rows, total}
       */
      handler: (payload, session) => Auction.history(payload, session)
    },

    'auction.close': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, expectedVersion}
       * @param {!Object} session ADMIN session
       * @return {!Object} {tournament_id, status, prev_status, summary, v}
       */
      handler: (payload, session) => Auction.close(payload, session)
    },

    'auction.reopen': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, expectedVersion, reason}
       * @param {!Object} session ADMIN session
       * @return {!Object} {tournament_id, status, prev_status, v}
       */
      handler: (payload, session) => Auction.reopen(payload, session)
    }
  };
}
