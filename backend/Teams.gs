/**
 * Teams.gs — teams, purse and squad size.
 *
 * Implements CONTRACTS-PHASE3.md §2 (team.create, team.createBatch, team.list,
 * team.squad, team.update, team.delete), §3 (counters and team.recount) and §4.
 * Rationale: DESIGN.md §2.5, §2.6, §6.4, §6.5a.
 *
 * PHASE 3 — teams and purse (DESIGN.md §6.4)
 *   team.create        ORGANISER or ADMIN. Seeds purse_total and max_players
 *                      from the tournament defaults when they are omitted.
 *   team.createBatch   ORGANISER or ADMIN. The main path: 8 names, one shared
 *                      purse and squad size, one locked section, one append.
 *   team.list          ORGANISER or ADMIN. The team dashboard, including
 *                      per_slot_remaining.
 *   team.squad         ORGANISER or ADMIN. The players one team has bought.
 *   team.update        ORGANISER (until the first sale) or ADMIN (any time).
 *   team.delete        ADMIN. Refuses with TEAM_NOT_EMPTY when the team has
 *                      players.
 *   team.recount       ADMIN. Rebuilds the cached counters from AuctionResults.
 *
 * ===========================================================================
 * THE COUNTERS ON A TEAMS ROW ARE A CACHE, NOT THE TRUTH.
 *
 * `purse_used` and `players_count` are derived facts. The append-only
 * AuctionResults tab is the single source of truth for both (DESIGN.md §2.5,
 * §2.6). Phase 4 maintains the cache inside the same lock that records a sale,
 * which is what makes it trustworthy.
 *
 * So nothing in this file may ever compute either number a second way — in
 * particular, NEVER derive a counter by scanning the Players tab at read time.
 * A Players scan looks like it agrees today and quietly stops agreeing the
 * first time a Phase 7 correction reverses a sale, because a correction
 * rewrites the team row and the AuctionResults history together. Two
 * definitions of one number is how a dashboard ends up arguing with the
 * projector in front of an audience.
 *
 * Phase 3 writes zeros at creation and never touches the counters again. The
 * only rebuild path is Teams.recomputeCounters, which reads AuctionResults.
 * ===========================================================================
 */

/** Shortest team name accepted (CONTRACTS-PHASE3 §2). @const {number} */
const TEAM_NAME_MIN = 2;

/** Longest team name accepted (CONTRACTS-PHASE3 §2). @const {number} */
const TEAM_NAME_MAX = 40;

/** Longest owner name accepted. Optional field, so this is only a sanity cap. @const {number} */
const TEAM_OWNER_MAX = 60;

/**
 * Most names one team.createBatch call may carry.
 *
 * The confirmed setup is 8 teams (DESIGN.md §6.4) and adding a 9th mid-auction
 * is explicitly allowed, so this is deliberately generous. It exists only so a
 * malformed payload cannot ask the server to write thousands of rows inside the
 * auction lock.
 * @const {number}
 */
const TEAM_BATCH_MAX = 32;

/**
 * Characters allowed in a team name.
 *
 * Wider than PLAYER_NAME_PATTERN because a team name is a brand, not a person:
 * digits ("Team 11"), ampersands and brackets are all normal. It must still
 * start with a letter or digit, which is what rejects control characters,
 * leading punctuation and names that are pure whitespace.
 * @const {!RegExp}
 */
const TEAM_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} .,'&()\/-]*$/u;

/** Thumbnail width for a team logo, matching the tournament logo. @const {number} */
const TEAM_LOGO_WIDTH = 320;

const Teams = {

  // ---------------------------------------------------------------------
  // Tab names and small helpers
  // ---------------------------------------------------------------------

  /**
   * Teams tab name, tolerating a SHEETS constant that has not loaded yet.
   * @return {string} the Teams tab name
   */
  _tab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.TEAMS) ? SHEETS.TEAMS : 'Teams';
  },

  /**
   * Tournaments tab name, same tolerance.
   * @return {string} the Tournaments tab name
   */
  _tournamentsTab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.TOURNAMENTS) ? SHEETS.TOURNAMENTS : 'Tournaments';
  },

  /**
   * AuctionResults tab name, same tolerance.
   * @return {string} the AuctionResults tab name
   */
  _resultsTab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.AUCTION_RESULTS) ? SHEETS.AUCTION_RESULTS : 'AuctionResults';
  },

  /**
   * Players tab name, same tolerance.
   * @return {string} the Players tab name
   */
  _playersTab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.PLAYERS) ? SHEETS.PLAYERS : 'Players';
  },

  /**
   * Trim any value to a string, treating null, undefined and whitespace as ''.
   * @param {*} v any value
   * @return {string} the trimmed string
   */
  _str(v) {
    return (v === null || v === undefined) ? '' : String(v).trim();
  },

  /**
   * True for a real boolean true and for the literal string the sheet stores.
   *
   * Repo hands back a real boolean for is_current because the column is in
   * BOOLEAN_FIELDS, but a row assembled anywhere else can still carry "TRUE".
   * Both are honoured, because reading a current sale as not-current is the one
   * mistake that would let an organiser edit a purse mid-auction.
   * @param {*} v the cell value
   * @return {boolean} true when the flag is set
   */
  _isTrue(v) {
    return v === true || String(v === null || v === undefined ? '' : v).trim().toUpperCase() === 'TRUE';
  },

  /**
   * Is this payload key carrying an image?
   * @param {*} img candidate value
   * @return {boolean} true when it is an object with data on it
   */
  _isImage(img) {
    return !!img && typeof img === 'object' && !Array.isArray(img) && !Util.isBlank(img.data);
  },

  /**
   * Does the payload explicitly carry this key?
   *
   * team.update is a patch: a field that is absent, null or '' is "leave it
   * alone", not "set it to nothing". Without this distinction an edit form that
   * only posts the changed field would blank everything else.
   * @param {!Object} p the payload
   * @param {...string} names the key spellings to accept, camelCase first
   * @return {boolean} true when one of the spellings carries a real value
   */
  _has(p, ...names) {
    for (let i = 0; i < names.length; i++) {
      const v = p[names[i]];
      if (v !== undefined && v !== null && v !== '') return true;
    }
    return false;
  },

  /**
   * Bump the auction state version if this tournament's auction is live.
   *
   * WHY: raising a squad size or a purse changes what the projector and the
   * organiser console are allowed to do next (DESIGN.md §6.4 — a mid-auction
   * change shows a confirmation stating the effect). Those screens poll a
   * cached snapshot keyed on the version (DESIGN.md §7), so without a bump they
   * keep offering the old limit until something else happens to change it.
   *
   * Only bumps while AUCTION_LIVE. Before the auction nothing is polling, so
   * bumping on every team edit would only churn the counter.
   *
   * Never throws: a cache hiccup must not roll back a team change that has
   * already been written and flushed. Same contract as
   * Payments._bumpIfAuctionLive, deliberately — two different behaviours for
   * the same job is how one screen refreshes and the other does not.
   *
   * @param {string} tournamentId tournament the team belongs to
   * @return {void}
   */
  _bumpIfAuctionLive(tournamentId) {
    try {
      if (!tournamentId) return;
      const row = Repo.findBy(Teams._tournamentsTab(), 'tournament_id', tournamentId);
      if (!row) return;

      const live = (typeof ENUM !== 'undefined' && ENUM.TOURNAMENT_STATUS)
        ? ENUM.TOURNAMENT_STATUS.AUCTION_LIVE
        : 'AUCTION_LIVE';

      if (Teams._str(row.status).toUpperCase() !== live) return;

      Cache.bumpVersion(tournamentId);
      Cache.invalidate(tournamentId);
    } catch (e) {
      console.error('Teams: could not bump auction version for ' + tournamentId + ': ' +
        (e && e.message ? e.message : e));
    }
  },

  /**
   * Move a superseded or orphaned logo to the Drive trash.
   *
   * Best effort on purpose: the sheet has already stopped pointing at the file,
   * so a Drive hiccup must not fail the operation. Trashed rather than hard
   * deleted, so a mistaken delete stays recoverable for 30 days.
   * @param {string} fileId Drive file id, may be blank
   * @return {void}
   */
  _trashQuietly(fileId) {
    const id = Teams._str(fileId);
    if (!id) return;
    try {
      Drive.deleteFile(id);
    } catch (e) {
      console.error('Teams: could not trash the logo ' + id + ': ' + e);
    }
  },

  // ---------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------

  /**
   * The comparison key for team-name uniqueness.
   *
   * Case-insensitive and whitespace-collapsed (CONTRACTS-PHASE3 §2), so
   * "Chennai Warriors", "chennai  warriors" and " CHENNAI WARRIORS " are all
   * the same team. Two teams whose names differ only by a stray space are
   * indistinguishable on a projector screen, so they must not both exist.
   * @param {*} v raw name
   * @return {string} the normalised key
   */
  _nameKey(v) {
    return Teams._str(v).replace(/\s+/g, ' ').toLowerCase();
  },

  /**
   * Validate a team name and return it in the form it will be stored in.
   *
   * Stored whitespace-collapsed but with the organiser's own capitalisation:
   * the display name is theirs, only the matching is normalised.
   * @param {*} raw the supplied name
   * @param {string} [label] how to refer to the field in an error, e.g. "Name 7"
   * @return {string} the trimmed, whitespace-collapsed name
   * @throws {!Error} VALIDATION_FAILED naming the field and the real length
   */
  _requireName(raw, label) {
    const what = label || 'The team name';
    const name = Teams._str(raw).replace(/\s+/g, ' ');
    if (!name) {
      throw Util.AppError(ERR.VALIDATION_FAILED, what + ' is required.');
    }
    if (name.length < TEAM_NAME_MIN) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        what + ' must be at least ' + TEAM_NAME_MIN + ' characters. "' + name + '" is ' +
        name.length + '.');
    }
    if (name.length > TEAM_NAME_MAX) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        what + ' must be ' + TEAM_NAME_MAX + ' characters or fewer. This one is ' +
        name.length + '.');
    }
    if (!TEAM_NAME_PATTERN.test(name)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        what + ' can use letters, numbers, spaces and . , \' & ( ) / - only, and must start ' +
        'with a letter or a number. Got "' + name.substring(0, TEAM_NAME_MAX) + '".');
    }
    return name;
  },

  /**
   * Validate the optional owner name.
   * @param {*} raw the supplied value; blank means "no owner recorded"
   * @return {string} the trimmed name, or ''
   * @throws {!Error} VALIDATION_FAILED when it is too long
   */
  _optionalOwner(raw) {
    const owner = Teams._str(raw).replace(/\s+/g, ' ');
    if (!owner) return '';
    if (owner.length > TEAM_OWNER_MAX) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The owner name must be ' + TEAM_OWNER_MAX + ' characters or fewer. This one is ' +
        owner.length + '.');
    }
    return owner;
  },

  /**
   * Validate an amount of money, keeping the field name in the message.
   *
   * Util.toMoney is the single definition of "a valid rupee amount"
   * (CONTRACTS.md §1.6) — whole rupees, greater than zero, no decimals and no
   * symbols. Its messages say "Amount", which on a team form is not enough to
   * tell the organiser which box to fix, so the code is preserved and the
   * label is added.
   * @param {*} value the supplied value
   * @param {string} label field name, e.g. "The purse"
   * @return {number} the amount as a positive integer
   * @throws {!Error} INVALID_AMOUNT
   */
  _money(value, label) {
    try {
      return Util.toMoney(value);
    } catch (e) {
      throw Util.AppError(e && e.code ? e.code : ERR.INVALID_AMOUNT,
        label + ': ' + ((e && e.message) ? e.message : 'is not a valid amount.'));
    }
  },

  /**
   * Validate a squad size.
   *
   * Digits only, so "12.7" is rejected rather than silently truncated to 12 —
   * a squad size is a hard limit the auction enforces, and quietly changing
   * what the organiser typed is worse than making them retype it. No upper
   * bound: DESIGN.md §6.4 says squad size stays flexible, and 12 or 13 is a
   * convention of this tournament, not a rule of the system.
   * @param {*} value the supplied value
   * @param {string} label field name, e.g. "The squad size"
   * @return {number} the squad size, at least 1
   * @throws {!Error} VALIDATION_FAILED
   */
  _squadSize(value, label) {
    const shown = Teams._str(value);
    let n;
    if (typeof value === 'number') {
      n = value;
    } else {
      if (!/^[0-9]+$/.test(shown)) {
        throw Util.AppError(ERR.VALIDATION_FAILED,
          label + ' must be a whole number of players. Got "' + shown.substring(0, 20) + '".');
      }
      n = Number(shown);
    }
    if (!isFinite(n) || Math.floor(n) !== n) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        label + ' must be a whole number of players, not a decimal. Got "' + shown + '".');
    }
    if (n < 1) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        label + ' must be at least 1 player. Got ' + n + '.');
    }
    return n;
  },

  /**
   * The purse for a new team: what was asked for, or the tournament default.
   *
   * default_purse exists precisely so an organiser creating 8 equal-purse teams
   * types the figure once (DESIGN.md §6.4), so an omitted purseTotal is normal
   * rather than an error — unless the tournament has no default either, in
   * which case the message says which of the two to fix.
   * @param {*} value the supplied purseTotal; blank means "use the default"
   * @param {!Object} tournament the Tournaments row
   * @return {number} whole rupees, greater than zero
   * @throws {!Error} INVALID_AMOUNT or VALIDATION_FAILED
   */
  _resolvePurse(value, tournament) {
    if (value !== undefined && value !== null && value !== '') {
      return Teams._money(value, 'The purse');
    }
    const fallback = Util.toInt(tournament.default_purse, 0);
    if (fallback <= 0) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'This team needs a purse. ' + Teams._str(tournament.name) +
        ' has no default purse set, so either type a purse for the team or set the ' +
        'tournament default first.');
    }
    return fallback;
  },

  /**
   * The squad size for a new team: what was asked for, or the tournament default.
   * @param {*} value the supplied maxPlayers; blank means "use the default"
   * @param {!Object} tournament the Tournaments row
   * @return {number} the squad size, at least 1
   * @throws {!Error} VALIDATION_FAILED
   */
  _resolveSquad(value, tournament) {
    if (value !== undefined && value !== null && value !== '') {
      return Teams._squadSize(value, 'The squad size');
    }
    const fallback = Util.toInt(tournament.default_max_players, 0);
    if (fallback < 1) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'This team needs a squad size. ' + Teams._str(tournament.name) +
        ' has no default squad size set, so either type one for the team or set the ' +
        'tournament default first.');
    }
    return fallback;
  },

  // ---------------------------------------------------------------------
  // Lookups and permissions
  // ---------------------------------------------------------------------

  /**
   * Load a tournament row or fail with NOT_FOUND.
   *
   * An unknown id must say so rather than come back as an empty team list,
   * which looks identical to a tournament nobody has added teams to yet.
   * @param {string} tournamentId the id from the payload
   * @return {!Object} the Tournaments row
   * @throws {!Error} NOT_FOUND
   */
  _requireTournament(tournamentId) {
    const row = Repo.findBy(Teams._tournamentsTab(), 'tournament_id', tournamentId);
    if (!row) {
      // Caller-controlled text, so it is length-capped before it reaches a
      // message the browser will render.
      throw Util.AppError(ERR.NOT_FOUND,
        'No tournament was found with the id "' + Teams._str(tournamentId).substring(0, 40) + '".');
    }
    return row;
  },

  /**
   * Load a team row or fail with NOT_FOUND.
   * @param {string} teamId the id from the payload
   * @return {!Object} the Teams row
   * @throws {!Error} NOT_FOUND
   */
  _requireTeam(teamId) {
    const row = Repo.findBy(Teams._tab(), 'team_id', teamId);
    if (!row) {
      throw Util.AppError(ERR.NOT_FOUND,
        'No team was found with the id "' + Teams._str(teamId).substring(0, 40) + '".');
    }
    return row;
  },

  /**
   * May this session change teams in this tournament right now?
   *
   * ORGANISER may create and change teams freely until the tournament has its
   * first SOLD result; ADMIN may do it at any time, including mid-auction
   * (CONTRACTS-PHASE3 §2, DESIGN.md §6.4). The cut-off is the first sale rather
   * than the auction going live, because before anything is sold there is no
   * existing data a change could contradict.
   *
   * The AUCTION_CLOSED branch is DESIGN.md §6.8: once the auction is closed,
   * every organiser write is refused and only an admin can act. Without it an
   * auction that closed with zero sales would still be editable by an
   * organiser, which is the one case hasAnySale cannot see.
   *
   * Tournament scope (Auth.requireTournament) is checked separately by every
   * caller, before this — this function answers "when", not "whose".
   *
   * @param {?Object} session the resolved session
   * @param {!Object} tournament the Tournaments row
   * @return {void}
   * @throws {!Error} FORBIDDEN after the first sale, AUCTION_CLOSED after close
   */
  _requireWriteAllowed(session, tournament) {
    const adminRole = (typeof ENUM !== 'undefined' && ENUM.USER_ROLE) ? ENUM.USER_ROLE.ADMIN : 'ADMIN';
    if (session && Teams._str(session.role).toUpperCase() === adminRole) return;

    const name = Teams._str(tournament.name) || 'this tournament';
    const closed = (typeof ENUM !== 'undefined' && ENUM.TOURNAMENT_STATUS)
      ? ENUM.TOURNAMENT_STATUS.AUCTION_CLOSED : 'AUCTION_CLOSED';

    if (Teams._str(tournament.status).toUpperCase() === closed) {
      throw Util.AppError(ERR.AUCTION_CLOSED,
        'The auction for ' + name + ' has been closed, so teams can no longer be changed. ' +
        'An admin can reopen it if this is wrong.');
    }

    if (Teams.hasAnySale(Teams._str(tournament.tournament_id))) {
      throw Util.AppError(ERR.FORBIDDEN,
        'Players have already been sold in ' + name + ', so team changes now have to be made ' +
        'by an admin. Ask your admin to make this change.');
    }
  },

  /**
   * Has anything been sold in this tournament yet?
   *
   * True when any AuctionResults row for the tournament is both is_current and
   * SOLD. Superseded rows do not count: a sale that a Phase 7 correction has
   * reversed is history, not a live fact, and the team row it touched has
   * already been put back (DESIGN.md §6.7).
   *
   * In Phase 3 the tab is empty, so this always returns false. It is written
   * properly now so Phase 4 does not have to retrofit the permission rule
   * (CONTRACTS-PHASE3 §2).
   *
   * One readAll, scanned in memory — a Repo.filterBy per criterion would
   * re-read the whole tab each time.
   *
   * @param {string} tournamentId the tournament to check
   * @return {boolean} true when at least one current SOLD row exists
   */
  hasAnySale(tournamentId) {
    const tid = Teams._str(tournamentId);
    if (!tid) return false;

    const sold = (typeof ENUM !== 'undefined' && ENUM.RESULT_STATUS)
      ? ENUM.RESULT_STATUS.SOLD : 'SOLD';

    const rows = Repo.readAll(Teams._resultsTab());
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (Teams._str(r.tournament_id) !== tid) continue;
      if (!Teams._isTrue(r.is_current)) continue;
      if (Teams._str(r.status).toUpperCase() === sold) return true;
    }
    return false;
  },

  // ---------------------------------------------------------------------
  // Shared row shaping
  // ---------------------------------------------------------------------

  /**
   * The teams of one tournament, from an already-read Teams tab.
   * @param {!Array<!Object>} allTeams every Teams row
   * @param {string} tournamentId the tournament
   * @return {!Array<!Object>} the matching rows, in sheet order
   */
  _ofTournament(allTeams, tournamentId) {
    const tid = Teams._str(tournamentId);
    const out = [];
    for (let i = 0; i < allTeams.length; i++) {
      if (Teams._str(allTeams[i].tournament_id) === tid) out.push(allTeams[i]);
    }
    return out;
  },

  /**
   * Find a team by normalised name inside an already-read list.
   * @param {!Array<!Object>} teams rows to search, already scoped to one tournament
   * @param {string} nameKey the key from Teams._nameKey
   * @param {string} [exceptTeamId] a team to ignore, so a rename to its own name passes
   * @return {?Object} the clashing row, or null
   */
  _findByNameKey(teams, nameKey, exceptTeamId) {
    const skip = Teams._str(exceptTeamId);
    for (let i = 0; i < teams.length; i++) {
      if (skip && Teams._str(teams[i].team_id) === skip) continue;
      if (Teams._nameKey(teams[i].team_name) === nameKey) return teams[i];
    }
    return null;
  },

  /**
   * Order teams for the dashboard: creation order, then name.
   *
   * Creation order is what the organiser typed into the batch form, so the
   * dashboard reads back in the order they built it. The name tie-break keeps
   * the order stable for rows created in the same millisecond, which a batch
   * append does produce.
   * @param {!Object} a first row
   * @param {!Object} b second row
   * @return {number} the comparison
   */
  _compareTeams(a, b) {
    const ca = Teams._str(a.created_at);
    const cb = Teams._str(b.created_at);
    if (ca !== cb) return ca < cb ? -1 : 1;
    const na = Teams._nameKey(a.team_name);
    const nb = Teams._nameKey(b.team_name);
    if (na === nb) return 0;
    return na < nb ? -1 : 1;
  },

  /**
   * Build the dashboard shape for one team (CONTRACTS-PHASE3 §2 team.list).
   *
   * Assembled field by field from an explicit list rather than by spreading the
   * sheet row, so a column a later phase appends to Teams stays invisible until
   * somebody deliberately adds a line here.
   *
   * purse_used and players_count are read straight off the row. They are the
   * cache Phase 4 maintains inside the sale lock — see the file header for why
   * nothing here recomputes them.
   *
   * per_slot_remaining is floor(purse_remaining / slots_remaining), or null
   * when the squad is full. Because prices are unpredictable (DESIGN.md §6.5a)
   * this is the number that actually tells an organiser whether a team is in
   * trouble, so it is computed here rather than left to the organiser to divide
   * in their head mid-auction.
   *
   * @param {!Object} team a Teams row
   * @return {!Object} the dashboard row
   */
  _listRow(team) {
    const purseTotal = Util.toInt(team.purse_total, 0);
    const purseUsed = Util.toInt(team.purse_used, 0);
    const purseRemaining = purseTotal - purseUsed;

    const maxPlayers = Util.toInt(team.max_players, 0);
    const playersCount = Util.toInt(team.players_count, 0);

    // Clamped at zero. An over-full squad can only come from corrupt data, and
    // a negative slot count would turn per_slot_remaining into a nonsense
    // positive number by dividing two negatives.
    const slotsRemaining = Math.max(0, maxPlayers - playersCount);

    // null, not 0: "nothing left to spend per slot" and "no slots left to spend
    // on" are different facts, and the dashboard renders them differently.
    const perSlot = slotsRemaining > 0 ? Math.floor(purseRemaining / slotsRemaining) : null;

    const logoId = Teams._str(team.logo_file_id);

    return {
      team_id: Teams._str(team.team_id),
      team_name: Teams._str(team.team_name),
      owner_name: Teams._str(team.owner_name),
      logo_url: logoId ? Drive.thumbUrl(logoId, TEAM_LOGO_WIDTH) : '',
      purse_total: purseTotal,
      purse_used: purseUsed,
      purse_remaining: purseRemaining,
      purse_total_display: Util.formatINR(purseTotal),
      purse_used_display: Util.formatINR(purseUsed),
      purse_remaining_display: Util.formatINR(purseRemaining),
      players_count: playersCount,
      max_players: maxPlayers,
      slots_remaining: slotsRemaining,
      per_slot_remaining: perSlot,
      // Blank rather than a word like "full", so the page decides how to show
      // it. Every other _display field in this project is pure formatting.
      per_slot_remaining_display: perSlot === null ? '' : Util.formatINR(perSlot)
    };
  },

  /**
   * The short shape team.create and team.createBatch return
   * (CONTRACTS-PHASE3 §2).
   *
   * owner_name and logo_url are added beyond the contract's list so the page
   * can render the new team card straight away instead of re-fetching the whole
   * dashboard after every create.
   * @param {!Object} row the Teams row that was written
   * @return {!Object} the created-team shape
   */
  _createdRow(row) {
    const logoId = Teams._str(row.logo_file_id);
    return {
      team_id: Teams._str(row.team_id),
      team_name: Teams._str(row.team_name),
      owner_name: Teams._str(row.owner_name),
      logo_url: logoId ? Drive.thumbUrl(logoId, TEAM_LOGO_WIDTH) : '',
      purse_total: Util.toInt(row.purse_total, 0),
      max_players: Util.toInt(row.max_players, 0),
      purse_used: Util.toInt(row.purse_used, 0),
      players_count: Util.toInt(row.players_count, 0)
    };
  },

  /**
   * Build one Teams row object ready to append.
   * @param {string} tournamentId the tournament
   * @param {string} name the validated team name
   * @param {string} ownerName the validated owner name, may be ''
   * @param {string} logoFileId Drive file id, may be ''
   * @param {number} purseTotal whole rupees
   * @param {number} maxPlayers squad size
   * @param {string} actor user_id of whoever is creating it
   * @return {!Object} the row
   */
  _newRow(tournamentId, name, ownerName, logoFileId, purseTotal, maxPlayers, actor) {
    return {
      team_id: Util.uid((typeof ID_PREFIX !== 'undefined' && ID_PREFIX.TEAM) ? ID_PREFIX.TEAM : 'TEM_'),
      tournament_id: tournamentId,
      team_name: name,
      owner_name: ownerName,
      logo_file_id: logoFileId,
      purse_total: purseTotal,
      // Zeros, always. The counters are a cache of AuctionResults and a brand
      // new team has no results (CONTRACTS-PHASE3 §3).
      purse_used: 0,
      max_players: maxPlayers,
      players_count: 0,
      created_at: Util.nowIso(),
      created_by: actor
    };
  },

  /**
   * The duplicate-name error, worded so the organiser can see which team clashes.
   * @param {string} name the name they tried to use
   * @param {!Object} clash the existing Teams row
   * @return {!Error} VALIDATION_FAILED
   */
  _duplicateNameError(name, clash) {
    return Util.AppError(ERR.VALIDATION_FAILED,
      'There is already a team called "' + Teams._str(clash.team_name) + '" in this tournament, ' +
      'so "' + name + '" would be a duplicate. Team names have to be different ignoring ' +
      'capitals and extra spaces.');
  },

  /**
   * Upload a team logo to the tournament's public Drive folder.
   *
   * Team logos go under public/ because the projector renders them from a plain
   * CDN thumbnail URL with no session (DESIGN.md §3, CONTRACTS.md §9 rule 1).
   * Drive.uploadImage does the real validation — declared mime, decoded size
   * and magic number — so the client's claim is never trusted.
   *
   * @param {!Object} tournament the Tournaments row
   * @param {{data: string, mime: string, filename: (string|undefined)}} img the image
   * @param {string} teamName used for the stored filename
   * @return {string} the new Drive file id
   * @throws {!Error} VALIDATION_FAILED
   */
  _uploadLogo(tournament, img, teamName) {
    const mime = Teams._str(img.mime);
    if (!mime) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The team logo did not say what type it is. Please pick the file again.');
    }
    const folders = Drive.ensureTournamentFolders(
      Teams._str(tournament.tournament_id), Teams._str(tournament.slug));
    const filename = Teams._str(img.filename) || ('team-' + Util.slugify(teamName));
    return Drive.uploadImage(folders.publicId, String(img.data), mime, filename);
  },

  // ---------------------------------------------------------------------
  // team.create
  // ---------------------------------------------------------------------

  /**
   * Create one team (CONTRACTS-PHASE3 §2).
   *
   * purseTotal and maxPlayers fall back to the tournament's default_purse and
   * default_max_players, which is what those columns are for (DESIGN.md §6.4).
   *
   * There is deliberately no "this purse is too small for this squad" guard
   * (CONTRACTS-PHASE3 §4): prices are unpredictable, so any threshold would be
   * a guess. team.list exposing per_slot_remaining gives the organiser the
   * honest number continuously instead.
   *
   * @param {!Object} payload {tournamentId, teamName, ownerName, purseTotal, maxPlayers, logo, ua}
   * @param {!Object} session the resolved ORGANISER or ADMIN session
   * @return {!Object} {team_id, team_name, owner_name, logo_url, purse_total, max_players, purse_used, players_count}
   * @throws {!Error} VALIDATION_FAILED, INVALID_AMOUNT, NOT_FOUND, FORBIDDEN, AUCTION_CLOSED
   */
  create(payload, session) {
    const p = payload || {};
    const tournamentId = Teams._str(p.tournamentId || p.tournament_id);
    if (!tournamentId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }

    // The only thing standing between one organiser and another organiser's
    // teams. Checked before anything is read (Auth.gs header, DESIGN.md §5.4).
    Auth.requireTournament(session, tournamentId);

    const tournament = Teams._requireTournament(tournamentId);
    Teams._requireWriteAllowed(session, tournament);

    const name = Teams._requireName(p.teamName || p.team_name);
    const ownerName = Teams._optionalOwner(p.ownerName || p.owner_name);
    const purseTotal = Teams._resolvePurse(
      p.purseTotal !== undefined ? p.purseTotal : p.purse_total, tournament);
    const maxPlayers = Teams._resolveSquad(
      p.maxPlayers !== undefined ? p.maxPlayers : p.max_players, tournament);

    if (p.logo !== null && p.logo !== undefined && !Teams._isImage(p.logo)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The team logo image is missing its data. Please pick the file again.');
    }

    const nameKey = Teams._nameKey(name);

    // Cheap duplicate check before the Drive round trip, so the ordinary
    // "typed the same name twice" case never uploads a file it has to throw
    // away. The authoritative check is the one inside the lock below.
    const clashNow = Teams._findByNameKey(
      Teams._ofTournament(Repo.readAll(Teams._tab()), tournamentId), nameKey);
    if (clashNow) throw Teams._duplicateNameError(name, clashNow);

    // Uploaded OUTSIDE the lock. A Drive upload can take seconds and the same
    // script lock serialises the auction (DESIGN.md §6.5) — holding it for a
    // file transfer would stall a live sale.
    const logoFileId = Teams._isImage(p.logo)
      ? Teams._uploadLogo(tournament, p.logo, name)
      : '';

    const actor = session ? Teams._str(session.user_id) : '';
    const ua = Teams._str(p.ua);

    return Repo.withLock(function () {
      // Re-read inside the lock. Two organisers on two laptops can type the
      // same name at the same time, and only this check is serialised.
      const clash = Teams._findByNameKey(
        Teams._ofTournament(Repo.readAll(Teams._tab()), tournamentId), nameKey);
      if (clash) {
        Teams._trashQuietly(logoFileId);
        throw Teams._duplicateNameError(name, clash);
      }

      const row = Teams._newRow(
        tournamentId, name, ownerName, logoFileId, purseTotal, maxPlayers, actor);
      Repo.append(Teams._tab(), row);

      Audit.log({
        actor: actor,
        role: session ? Teams._str(session.role) : '',
        action: Audit.ACTIONS.TEAM_CREATED,
        tournamentId: tournamentId,
        entityType: 'Team',
        entityId: row.team_id,
        prev: null,
        next: {
          team_name: name,
          owner_name: ownerName,
          purse_total: purseTotal,
          max_players: maxPlayers,
          purse_used: 0,
          players_count: 0
        },
        ua: ua
      });

      // Push the write out before the lock is released, so the next caller's
      // re-read actually sees it (CONTRACTS.md §5 rule 3).
      Repo.flush();
      Teams._bumpIfAuctionLive(tournamentId);

      return Teams._createdRow(row);
    });
  },

  // ---------------------------------------------------------------------
  // team.createBatch
  // ---------------------------------------------------------------------

  /**
   * Create several teams at once (CONTRACTS-PHASE3 §2).
   *
   * This is the main path, not a convenience. The confirmed setup is 8 teams
   * with an equal purse, and creating them one at a time is 8 round trips at
   * roughly 1.5 seconds each.
   *
   * THE WHOLE BATCH IS VALIDATED BEFORE ANY OF IT IS WRITTEN. Names must be
   * unique within the batch as well as against the teams already there, and a
   * duplicate at position 7 must not leave 6 teams created — half a batch is
   * worse than none, because the organiser then has to work out which of their
   * 8 names got through before retrying.
   *
   * One locked section, one Repo.appendMany.
   *
   * @param {!Object} payload {tournamentId, names: string[], purseTotal, maxPlayers, ua}
   * @param {!Object} session the resolved ORGANISER or ADMIN session
   * @return {{created: !Array<!Object>}} the teams that were written, in order
   * @throws {!Error} VALIDATION_FAILED, INVALID_AMOUNT, NOT_FOUND, FORBIDDEN, AUCTION_CLOSED
   */
  createBatch(payload, session) {
    const p = payload || {};
    const tournamentId = Teams._str(p.tournamentId || p.tournament_id);
    if (!tournamentId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }

    Auth.requireTournament(session, tournamentId);
    const tournament = Teams._requireTournament(tournamentId);
    Teams._requireWriteAllowed(session, tournament);

    const names = p.names;
    if (!Array.isArray(names) || !names.length) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'Give at least one team name. Send them as a list, for example ["Chennai Warriors", "Madurai Kings"].');
    }
    if (names.length > TEAM_BATCH_MAX) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'You can create at most ' + TEAM_BATCH_MAX + ' teams in one go. This request has ' +
        names.length + '.');
    }

    // The purse and squad size are shared by every team in the batch — that is
    // the point of the form (CONTRACTS-PHASE3 §2). Individual teams are
    // adjusted afterwards with team.update.
    const purseTotal = Teams._resolvePurse(
      p.purseTotal !== undefined ? p.purseTotal : p.purse_total, tournament);
    const maxPlayers = Teams._resolveSquad(
      p.maxPlayers !== undefined ? p.maxPlayers : p.max_players, tournament);

    // --- Pass 1: validate every name, and check the batch against itself ----
    const cleaned = [];
    const seen = {};
    for (let i = 0; i < names.length; i++) {
      const label = 'Team name ' + (i + 1);
      const name = Teams._requireName(names[i], label);
      const key = Teams._nameKey(name);
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        throw Util.AppError(ERR.VALIDATION_FAILED,
          'Team names ' + (seen[key] + 1) + ' and ' + (i + 1) + ' are both "' + name +
          '". Every team needs a different name, so nothing has been created — fix that ' +
          'one name and send the list again.');
      }
      seen[key] = i;
      cleaned.push({ name: name, key: key, position: i + 1 });
    }

    const actor = session ? Teams._str(session.user_id) : '';
    const role = session ? Teams._str(session.role) : '';
    const ua = Teams._str(p.ua);

    return Repo.withLock(function () {
      // --- Pass 2: check the whole batch against what already exists --------
      // One read of the Teams tab, then every comparison in memory.
      const existing = Teams._ofTournament(Repo.readAll(Teams._tab()), tournamentId);
      for (let i = 0; i < cleaned.length; i++) {
        const clash = Teams._findByNameKey(existing, cleaned[i].key);
        if (clash) {
          throw Util.AppError(ERR.VALIDATION_FAILED,
            'Team name ' + cleaned[i].position + ', "' + cleaned[i].name +
            '", is already taken by an existing team called "' + Teams._str(clash.team_name) +
            '". Nothing has been created — rename that one and send the list again.');
        }
      }

      // --- Pass 3: only now is anything written -----------------------------
      const rows = cleaned.map((c) =>
        Teams._newRow(tournamentId, c.name, '', '', purseTotal, maxPlayers, actor));
      Repo.appendMany(Teams._tab(), rows);

      // One audit row per team, not one for the batch: the trail is read by
      // entity_id when somebody asks "who set this team's purse?" (DESIGN.md
      // §42), and a single batch row would not answer that.
      rows.forEach((row) => {
        Audit.log({
          actor: actor,
          role: role,
          action: Audit.ACTIONS.TEAM_CREATED,
          tournamentId: tournamentId,
          entityType: 'Team',
          entityId: row.team_id,
          prev: null,
          next: {
            team_name: row.team_name,
            purse_total: purseTotal,
            max_players: maxPlayers,
            purse_used: 0,
            players_count: 0,
            batch_of: rows.length
          },
          ua: ua
        });
      });

      Repo.flush();
      Teams._bumpIfAuctionLive(tournamentId);

      return { created: rows.map((row) => Teams._createdRow(row)) };
    });
  },

  // ---------------------------------------------------------------------
  // team.list
  // ---------------------------------------------------------------------

  /**
   * The team dashboard (CONTRACTS-PHASE3 §2, DESIGN.md §17).
   *
   * One Repo.readAll of the Teams tab, everything else computed in memory. The
   * counters come straight off each row — see the file header for why this
   * function must never look at the Players tab to work out how many players a
   * team has.
   *
   * @param {!Object} payload {tournamentId}
   * @param {!Object} session the resolved ORGANISER or ADMIN session
   * @return {{teams: !Array<!Object>, totals: !Object}} the dashboard
   * @throws {!Error} VALIDATION_FAILED, NOT_FOUND, FORBIDDEN
   */
  list(payload, session) {
    const p = payload || {};
    const tournamentId = Teams._str(p.tournamentId || p.tournament_id);
    if (!tournamentId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }

    Auth.requireTournament(session, tournamentId);
    Teams._requireTournament(tournamentId);

    const rows = Teams._ofTournament(Repo.readAll(Teams._tab()), tournamentId);
    rows.sort(Teams._compareTeams);

    const teams = rows.map((row) => Teams._listRow(row));

    const totals = {
      teams: teams.length,
      purse_total: 0,
      purse_used: 0,
      purse_remaining: 0,
      players_count: 0,
      slots_total: 0,
      slots_remaining: 0
    };
    for (let i = 0; i < teams.length; i++) {
      const t = teams[i];
      totals.purse_total += t.purse_total;
      totals.purse_used += t.purse_used;
      totals.purse_remaining += t.purse_remaining;
      totals.players_count += t.players_count;
      totals.slots_total += t.max_players;
      totals.slots_remaining += t.slots_remaining;
    }

    return { teams: teams, totals: totals };
  },

  // ---------------------------------------------------------------------
  // team.squad
  // ---------------------------------------------------------------------

  /**
   * One team and the players it has bought (CONTRACTS-PHASE3 §2, DESIGN.md §31).
   *
   * Sorted by sold_at, so the squad reads as the order the team built it.
   *
   * total_players and total_spent are the team row's cached counters, NOT a sum
   * over the player rows listed below them. The listed rows and the counters
   * are maintained together inside the sale lock in Phase 4, so they agree; if
   * they ever stop agreeing, counters_stale says so and team.recount is the
   * fix. Summing the rows here instead would produce a second definition of the
   * same number and hide the drift rather than report it (CONTRACTS-PHASE3 §3).
   *
   * @param {!Object} payload {teamId}
   * @param {!Object} session the resolved ORGANISER or ADMIN session
   * @return {!Object} {team, players, total_players, total_spent, total_spent_display, purse_remaining_display, counters_stale}
   * @throws {!Error} VALIDATION_FAILED, NOT_FOUND, FORBIDDEN
   */
  squad(payload, session) {
    const p = payload || {};
    const teamId = Teams._str(p.teamId || p.team_id);
    if (!teamId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A team id is required.');
    }

    const team = Teams._requireTeam(teamId);

    // Scope is checked against the team's own tournament, so an organiser
    // guessing at team ids gets FORBIDDEN rather than another tournament's
    // squad.
    Auth.requireTournament(session, Teams._str(team.tournament_id));

    const allPlayers = Repo.readAll(Teams._playersTab());
    const mine = [];
    for (let i = 0; i < allPlayers.length; i++) {
      if (Teams._str(allPlayers[i].team_id) === teamId) mine.push(allPlayers[i]);
    }

    // Ascending sold_at. A squad member with no sold_at is a data fault rather
    // than an ordinary row, so it sorts last where it will be noticed instead
    // of first where it would look like the team's first signing.
    mine.sort(function (a, b) {
      const sa = Teams._str(a.sold_at);
      const sb = Teams._str(b.sold_at);
      if (sa !== sb) {
        if (!sa) return 1;
        if (!sb) return -1;
        return sa < sb ? -1 : 1;
      }
      return Util.toInt(a.serial_no, 0) - Util.toInt(b.serial_no, 0);
    });

    const players = mine.map(function (row) {
      const soldAmount = Util.toInt(row.sold_amount, 0);
      const soldAt = Teams._str(row.sold_at);
      return {
        player_id: Teams._str(row.player_id),
        serial_no: Util.toInt(row.serial_no, 0),
        name: Teams._str(row.name),
        role: Teams._str(row.role),
        style: Teams._str(row.style),
        photo_thumb_url: Teams._str(row.photo_thumb_url),
        sold_amount: soldAmount,
        sold_amount_display: Util.formatINR(soldAmount),
        sold_at_display: soldAt ? Util.formatIST(soldAt, true) : ''
      };
    });

    const shaped = Teams._listRow(team);

    // Reported, never used as the answer. See the JSDoc above.
    let scannedSpend = 0;
    for (let i = 0; i < players.length; i++) scannedSpend += players[i].sold_amount;
    const countersStale = (players.length !== shaped.players_count) ||
      (scannedSpend !== shaped.purse_used);

    return {
      team: shaped,
      players: players,
      total_players: shaped.players_count,
      total_spent: shaped.purse_used,
      total_spent_display: shaped.purse_used_display,
      purse_remaining_display: shaped.purse_remaining_display,
      counters_stale: countersStale
    };
  },

  // ---------------------------------------------------------------------
  // team.update
  // ---------------------------------------------------------------------

  /**
   * Change a team (CONTRACTS-PHASE3 §2, DESIGN.md §6.4).
   *
   * Everything stays changeable. The only rejections are the ones that would
   * make existing data contradictory:
   *
   *   raise max_players  — always allowed
   *   lower max_players  — not below players_count   SQUAD_BELOW_COUNT
   *   raise purse_total  — always allowed
   *   lower purse_total  — not below purse_used      PURSE_BELOW_SPENT
   *   rename             — must still be unique      VALIDATION_FAILED
   *
   * THE WHOLE THING RUNS INSIDE Repo.withLock, and the team row is re-read
   * inside it. That is not defensive tidiness: this is the same script lock the
   * auction holds while it records a sale (DESIGN.md §6.5, §6.4), so without it
   * a squad-size change could be decided against a players_count that a sale
   * increments a millisecond later — the guard would pass and the team would
   * end up over its own limit.
   *
   * A team logo is not editable here. team.create takes one and the Phase 3
   * contract does not put it on the update path, and a Drive upload cannot go
   * inside the auction lock.
   *
   * @param {!Object} payload {teamId, teamName, ownerName, purseTotal, maxPlayers, ua}
   * @param {!Object} session the resolved ORGANISER or ADMIN session
   * @return {!Object} the dashboard row for the team, plus `changed`
   * @throws {!Error} VALIDATION_FAILED, INVALID_AMOUNT, SQUAD_BELOW_COUNT,
   *     PURSE_BELOW_SPENT, NOT_FOUND, FORBIDDEN, AUCTION_CLOSED
   */
  update(payload, session) {
    const p = payload || {};
    const teamId = Teams._str(p.teamId || p.team_id);
    if (!teamId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A team id is required.');
    }

    const wantsName = Teams._has(p, 'teamName', 'team_name');
    const wantsOwner = p.ownerName !== undefined || p.owner_name !== undefined;
    const wantsPurse = Teams._has(p, 'purseTotal', 'purse_total');
    const wantsSquad = Teams._has(p, 'maxPlayers', 'max_players');

    if (!wantsName && !wantsOwner && !wantsPurse && !wantsSquad) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'Nothing to change. Send at least one of: team name, owner name, purse or squad size.');
    }

    // Validated before the lock is taken — a typo does not need to queue behind
    // a live sale to be told it is a typo.
    const newName = wantsName ? Teams._requireName(p.teamName || p.team_name) : '';
    const newOwner = wantsOwner ? Teams._optionalOwner(
      p.ownerName !== undefined ? p.ownerName : p.owner_name) : '';
    const newPurse = wantsPurse ? Teams._money(
      p.purseTotal !== undefined ? p.purseTotal : p.purse_total, 'The purse') : 0;
    const newSquad = wantsSquad ? Teams._squadSize(
      p.maxPlayers !== undefined ? p.maxPlayers : p.max_players, 'The squad size') : 0;

    const ua = Teams._str(p.ua);

    return Repo.withLock(function () {
      const allTeams = Repo.readAll(Teams._tab());

      let team = null;
      for (let i = 0; i < allTeams.length; i++) {
        if (Teams._str(allTeams[i].team_id) === teamId) { team = allTeams[i]; break; }
      }
      if (!team) {
        throw Util.AppError(ERR.NOT_FOUND,
          'No team was found with the id "' + teamId.substring(0, 40) + '".');
      }

      const tournamentId = Teams._str(team.tournament_id);
      Auth.requireTournament(session, tournamentId);

      const tournament = Teams._requireTournament(tournamentId);
      Teams._requireWriteAllowed(session, tournament);

      const currentName = Teams._str(team.team_name);
      const currentOwner = Teams._str(team.owner_name);
      const currentPurse = Util.toInt(team.purse_total, 0);
      const currentSquad = Util.toInt(team.max_players, 0);

      // The two numbers every guard below is measured against. Read off the
      // row, inside the lock, which is the only copy Phase 4 keeps correct.
      const purseUsed = Util.toInt(team.purse_used, 0);
      const playersCount = Util.toInt(team.players_count, 0);

      const patch = {};
      const prev = {};
      const next = {};
      const changed = {};

      // --- Rename: must still be unique -----------------------------------
      if (wantsName && Teams._nameKey(newName) !== Teams._nameKey(currentName)) {
        const clash = Teams._findByNameKey(
          Teams._ofTournament(allTeams, tournamentId), Teams._nameKey(newName), teamId);
        if (clash) throw Teams._duplicateNameError(newName, clash);
      }
      if (wantsName && newName !== currentName) {
        patch.team_name = newName;
        prev.team_name = currentName;
        next.team_name = newName;
        changed.team_name = { from: currentName, to: newName };
      }

      if (wantsOwner && newOwner !== currentOwner) {
        patch.owner_name = newOwner;
        prev.owner_name = currentOwner;
        next.owner_name = newOwner;
        changed.owner_name = { from: currentOwner, to: newOwner };
      }

      // --- Squad size: raising is free, lowering has one floor -------------
      if (wantsSquad && newSquad !== currentSquad) {
        if (newSquad < playersCount) {
          throw Util.AppError(ERR.SQUAD_BELOW_COUNT,
            currentName + ' already has ' + playersCount + ' player' +
            (playersCount === 1 ? '' : 's') + '. You cannot set the limit to ' + newSquad + '.');
        }
        patch.max_players = newSquad;
        prev.max_players = currentSquad;
        next.max_players = newSquad;
        changed.max_players = { from: currentSquad, to: newSquad };
      }

      // --- Purse: raising is free, lowering has one floor ------------------
      if (wantsPurse && newPurse !== currentPurse) {
        if (newPurse < purseUsed) {
          throw Util.AppError(ERR.PURSE_BELOW_SPENT,
            currentName + ' has already spent ' + Util.formatINR(purseUsed) +
            '. You cannot set the purse to ' + Util.formatINR(newPurse) + '.');
        }
        patch.purse_total = newPurse;
        prev.purse_total = currentPurse;
        next.purse_total = newPurse;
        changed.purse_total = { from: currentPurse, to: newPurse };
      }

      // Nothing actually different: a no-op success, not an error. Two people
      // saving the same form must not produce a scary message (DESIGN.md §15).
      // Nothing is written and nothing is audited, because nothing happened.
      if (!Object.keys(patch).length) {
        const same = Teams._listRow(team);
        same.changed = {};
        return same;
      }

      const merged = Repo.updateRow(Teams._tab(), team._row, patch);

      Audit.log({
        actor: session ? Teams._str(session.user_id) : '',
        role: session ? Teams._str(session.role) : '',
        action: Audit.ACTIONS.TEAM_UPDATED,
        tournamentId: tournamentId,
        entityType: 'Team',
        entityId: teamId,
        prev: prev,
        next: next,
        ua: ua
      });

      Repo.flush();
      Teams._bumpIfAuctionLive(tournamentId);

      const out = Teams._listRow(merged);
      // So the confirmation can state the effect in the organiser's own terms
      // — "raising Chennai Warriors to 13 players" (DESIGN.md §6.4).
      out.changed = changed;
      return out;
    });
  },

  // ---------------------------------------------------------------------
  // team.delete
  // ---------------------------------------------------------------------

  /**
   * Delete an empty team (CONTRACTS-PHASE3 §2). ADMIN only.
   *
   * Refused while the team has players. Deleting a team with a squad would
   * orphan those players — their Players rows would still carry a team_id that
   * no longer resolves, the money spent on them would be charged against
   * nothing, and no report would show an error, it would just be wrong.
   *
   * Two checks, not one: the cached players_count, and the AuctionResults rows
   * that are its source of truth. The second is not a duplicate of the first —
   * it is the safety net for the case where the cache has drifted to zero and
   * the sales are real. A delete cannot be undone from the UI, so it is worth
   * the extra read.
   *
   * The method is called `remove` because the route name is `team.delete` and a
   * property named `delete` reads like the operator at every call site.
   *
   * @param {!Object} payload {teamId, ua}
   * @param {!Object} session the resolved ADMIN session
   * @return {{team_id: string, team_name: string, deleted: boolean}} what went
   * @throws {!Error} VALIDATION_FAILED, NOT_FOUND, FORBIDDEN, TEAM_NOT_EMPTY
   */
  remove(payload, session) {
    const p = payload || {};
    const teamId = Teams._str(p.teamId || p.team_id);
    if (!teamId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A team id is required.');
    }
    const ua = Teams._str(p.ua);

    return Repo.withLock(function () {
      // Re-read inside the lock: a sale landing between the admin loading the
      // screen and clicking delete is exactly what this must not miss.
      const team = Teams._requireTeam(teamId);
      const tournamentId = Teams._str(team.tournament_id);
      Auth.requireTournament(session, tournamentId);

      const name = Teams._str(team.team_name);
      const playersCount = Util.toInt(team.players_count, 0);
      if (playersCount > 0) {
        throw Util.AppError(ERR.TEAM_NOT_EMPTY,
          name + ' still has ' + playersCount + ' player' + (playersCount === 1 ? '' : 's') +
          '. Return them to the pool first, then delete the team.');
      }

      const sold = (typeof ENUM !== 'undefined' && ENUM.RESULT_STATUS)
        ? ENUM.RESULT_STATUS.SOLD : 'SOLD';
      const results = Repo.readAll(Teams._resultsTab());
      let liveSales = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (Teams._str(r.team_id) !== teamId) continue;
        if (!Teams._isTrue(r.is_current)) continue;
        if (Teams._str(r.status).toUpperCase() === sold) liveSales++;
      }
      if (liveSales > 0) {
        throw Util.AppError(ERR.TEAM_NOT_EMPTY,
          name + ' shows no players on its row, but the auction record has ' + liveSales +
          ' player' + (liveSales === 1 ? '' : 's') + ' sold to it. Run the team recount first, ' +
          'then deal with those players.');
      }

      Repo.deleteRow(Teams._tab(), team._row);

      Audit.log({
        actor: session ? Teams._str(session.user_id) : '',
        role: session ? Teams._str(session.role) : '',
        action: Audit.ACTIONS.TEAM_DELETED,
        tournamentId: tournamentId,
        entityType: 'Team',
        entityId: teamId,
        // The whole row, because after this there is nothing left to look up.
        prev: {
          team_name: name,
          owner_name: Teams._str(team.owner_name),
          purse_total: Util.toInt(team.purse_total, 0),
          purse_used: Util.toInt(team.purse_used, 0),
          max_players: Util.toInt(team.max_players, 0),
          players_count: playersCount,
          created_at: Teams._str(team.created_at)
        },
        next: null,
        ua: ua
      });

      Repo.flush();

      // After the row is gone, so a Drive failure cannot leave a deleted team
      // behind. Trashed, not destroyed — recoverable for 30 days.
      Teams._trashQuietly(team.logo_file_id);

      Teams._bumpIfAuctionLive(tournamentId);

      return { team_id: teamId, team_name: name, deleted: true };
    });
  },

  // ---------------------------------------------------------------------
  // Counters
  // ---------------------------------------------------------------------

  /**
   * Rebuild purse_used and players_count for every team in a tournament
   * (CONTRACTS-PHASE3 §3).
   *
   * The truth is the append-only AuctionResults tab: every row that is both
   * is_current and SOLD. Superseded rows are skipped, which is what makes a
   * Phase 7 correction come out right — the correction wrote a new current row
   * and flipped the old one, so replaying only the current rows reproduces the
   * state the corrections left behind (DESIGN.md §2.6, §6.7).
   *
   * In Phase 3 the tab is empty, so this correctly produces zeros everywhere.
   * It is written properly now because it is the recovery path, and 11pm on
   * auction night is the wrong time to discover it was a placeholder.
   *
   * Runs inside Repo.withLock and takes the lock itself, so it must not be
   * called from inside another locked section.
   *
   * One readAll per tab. The AuctionResults scan is a single pass building a
   * tally keyed by team, not a filter per team.
   *
   * @param {string} tournamentId the tournament to rebuild
   * @return {!Object} {tournament_id, sold_rows_counted, teams_checked,
   *     teams_changed, changes, orphan_team_ids}
   * @throws {!Error} VALIDATION_FAILED when the id is blank
   */
  recomputeCounters(tournamentId) {
    const tid = Teams._str(tournamentId);
    if (!tid) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }

    const sold = (typeof ENUM !== 'undefined' && ENUM.RESULT_STATUS)
      ? ENUM.RESULT_STATUS.SOLD : 'SOLD';

    return Repo.withLock(function () {
      const results = Repo.readAll(Teams._resultsTab());

      const tally = {};
      const orphanTeamIds = [];
      let counted = 0;

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (Teams._str(r.tournament_id) !== tid) continue;
        if (!Teams._isTrue(r.is_current)) continue;
        if (Teams._str(r.status).toUpperCase() !== sold) continue;

        counted++;
        const teamId = Teams._str(r.team_id);
        if (!teamId) {
          // A current SOLD row with no team is a data fault, not counter drift.
          orphanTeamIds.push('(blank team_id on ' + Teams._str(r.auction_id) + ')');
          continue;
        }
        if (!tally[teamId]) tally[teamId] = { spent: 0, players: 0 };
        tally[teamId].spent += Util.toInt(r.amount, 0);
        tally[teamId].players += 1;
      }

      const teams = Teams._ofTournament(Repo.readAll(Teams._tab()), tid);
      const known = {};
      teams.forEach((t) => { known[Teams._str(t.team_id)] = true; });
      Object.keys(tally).forEach((teamId) => {
        if (!known[teamId]) orphanTeamIds.push(teamId);
      });

      const changes = [];
      teams.forEach((t) => {
        const truth = tally[Teams._str(t.team_id)] || { spent: 0, players: 0 };
        const wasPurse = Util.toInt(t.purse_used, 0);
        const wasCount = Util.toInt(t.players_count, 0);
        if (wasPurse === truth.spent && wasCount === truth.players) return;

        Repo.updateRow(Teams._tab(), t._row, {
          purse_used: truth.spent,
          players_count: truth.players
        });
        changes.push({
          team_id: Teams._str(t.team_id),
          team_name: Teams._str(t.team_name),
          purse_used: { from: wasPurse, to: truth.spent },
          players_count: { from: wasCount, to: truth.players }
        });
      });

      if (changes.length) Repo.flush();

      return {
        tournament_id: tid,
        sold_rows_counted: counted,
        teams_checked: teams.length,
        teams_changed: changes.length,
        changes: changes,
        orphan_team_ids: orphanTeamIds
      };
    });
  },

  /**
   * team.recount — rebuild the counters from the UI (CONTRACTS-PHASE3 §3).
   *
   * Exposed as a route so drift is fixable at 11pm without opening the Apps
   * Script editor. Setup.rebuildCounters stays the equivalent path for someone
   * who is already in the editor.
   *
   * @param {!Object} payload {tournamentId, ua}
   * @param {!Object} session the resolved ADMIN session
   * @return {!Object} the report from Teams.recomputeCounters
   * @throws {!Error} VALIDATION_FAILED, NOT_FOUND, FORBIDDEN
   */
  recount(payload, session) {
    const p = payload || {};
    const tournamentId = Teams._str(p.tournamentId || p.tournament_id);
    if (!tournamentId) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }

    Auth.requireTournament(session, tournamentId);
    Teams._requireTournament(tournamentId);

    const report = Teams.recomputeCounters(tournamentId);

    // Audited per team rather than once for the run: a counter moving is a
    // change to that team's row and has to be answerable by entity_id later.
    // Nothing changed means nothing happened, so nothing is logged.
    report.changes.forEach((c) => {
      Audit.log({
        actor: session ? Teams._str(session.user_id) : '',
        role: session ? Teams._str(session.role) : '',
        action: Audit.ACTIONS.TEAM_UPDATED,
        tournamentId: tournamentId,
        entityType: 'Team',
        entityId: c.team_id,
        prev: { purse_used: c.purse_used.from, players_count: c.players_count.from },
        next: {
          purse_used: c.purse_used.to,
          players_count: c.players_count.to,
          reason: 'RECOUNT_FROM_AUCTION_RESULTS'
        },
        ua: Teams._str(p.ua)
      });
    });

    if (report.teams_changed) Teams._bumpIfAuctionLive(tournamentId);

    return report;
  }
};

/**
 * Team route table.
 *
 * Every action is POST. None is offered on GET: five of the seven write, and
 * the two reads carry the session token in the body like everything else in
 * this project (CONTRACTS.md §11).
 *
 * ORGANISER appears alongside ADMIN on the five team-management actions. The
 * role check here only says "an organiser may call this"; Auth.requireTournament
 * inside each handler is what stops them reaching another tournament, and
 * Teams._requireWriteAllowed is what stops them changing anything once the
 * first player has been sold (CONTRACTS-PHASE3 §2).
 *
 * team.delete and team.recount are ADMIN only. Deleting is irreversible from
 * the UI, and a recount overwrites live counters.
 *
 * @return {!Object} route table fragment
 */
function TeamRoutes() {
  return {
    'team.create': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, teamName, ownerName, purseTotal, maxPlayers, logo}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {team_id, team_name, purse_total, max_players, purse_used, players_count}
       */
      handler: (payload, session) => Teams.create(payload, session)
    },

    'team.createBatch': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, names, purseTotal, maxPlayers}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {{created: !Array<!Object>}} the teams that were written
       */
      handler: (payload, session) => Teams.createBatch(payload, session)
    },

    'team.list': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {{teams: !Array<!Object>, totals: !Object}} the team dashboard
       */
      handler: (payload, session) => Teams.list(payload, session)
    },

    'team.squad': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {teamId}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} {team, players, total_players, total_spent, ...}
       */
      handler: (payload, session) => Teams.squad(payload, session)
    },

    'team.update': {
      auth: ['ORGANISER', 'ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {teamId, teamName, ownerName, purseTotal, maxPlayers}
       * @param {!Object} session ORGANISER or ADMIN session
       * @return {!Object} the team's dashboard row plus `changed`
       */
      handler: (payload, session) => Teams.update(payload, session)
    },

    'team.delete': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {teamId}
       * @param {!Object} session ADMIN session
       * @return {{team_id: string, team_name: string, deleted: boolean}}
       */
      handler: (payload, session) => Teams.remove(payload, session)
    },

    'team.recount': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ADMIN session
       * @return {!Object} what the rebuild changed
       */
      handler: (payload, session) => Teams.recount(payload, session)
    }
  };
}
