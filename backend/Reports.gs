/**
 * Reports.gs — CSV exports, the admin dashboard numbers, and the audit viewer.
 *
 * Contract: CONTRACTS-PHASE4-7.md PHASE 6 and PHASE 7 item 1.
 * Rationale: DESIGN.md §6.9 (the four honest labels), §10 and §45 (the exports),
 * §35 (admin stats), §42 (the audit trail).
 *
 * -------------------------------------------------------------------------
 * THIS MODULE NEVER WRITES. NOT ONE ROW.
 * -------------------------------------------------------------------------
 * Reporting reads history; it does not make history. In particular the
 * AuditLog tab is append-only evidence used to settle "did that player
 * actually pay?" months after the event (DESIGN.md §42). There is deliberately
 * no action anywhere in this file — and there must never be one anywhere in
 * the project — that edits or deletes an audit row. audit.list is a read.
 * Exports are reads. If you are adding a write here, you are in the wrong file.
 *
 * -------------------------------------------------------------------------
 * WHY THE CSV RULES BELOW ARE NOT COSMETIC
 * -------------------------------------------------------------------------
 * The person who receives these files opens them in Excel and sums a column.
 * Four things silently break that, and all four are handled here once:
 *
 *  1. A "₹" or a thousands separator turns a numeric column into TEXT. Every
 *     SUM in the sheet then returns 0 and nobody notices until the money does
 *     not add up. Money is exported as a bare integer — see _money(). This is
 *     the one place in the codebase that must NOT use Util.formatINR.
 *  2. A 10-digit mobile becomes 9.87654E+09, and any leading zero is eaten.
 *     Mobiles and UPI references go out as ="9876543210" — see _excelText().
 *  3. A player name with a comma, a quote or a newline in it shifts every
 *     later column on that row. Names come from a public form, so one of the
 *     400 will contain a comma. Every single field goes through _csvCell().
 *  4. Without a UTF-8 BOM, Excel on Windows renders Tamil and Devanagari names
 *     as mojibake. Names are explicitly allowed in any script, so every file
 *     starts with REPORT_BOM.
 *
 * -------------------------------------------------------------------------
 * PERFORMANCE CONTRACT (CONTRACTS-PHASE4-7 cross-cutting rule 7)
 * -------------------------------------------------------------------------
 * ONE Repo.readAll PER TAB PER REQUEST. A report joins Players, Payments,
 * Teams and AuctionResults; each is read exactly once by _gather() and joined
 * in memory. Repo.filterBy / findBy / count each re-read the WHOLE tab, so one
 * per row at 400 players is hundreds of full sheet reads and walks straight
 * into the 6-minute execution limit (DESIGN.md §14).
 *
 * Nothing here runs inside Repo.withLock. Building a 400-row string takes a
 * second or two and holding the auction lock for that would stall a live sale
 * (DESIGN.md §7.1). A report is a snapshot of a moving system and is allowed
 * to be a moment stale.
 *
 * NOT AUDITED, DELIBERATELY: an export is a read, not a state change, and
 * Audit.ACTIONS (CONTRACTS.md §10) has no export action. Exports do carry
 * mobile numbers, so if a REPORT_EXPORTED action is ever added to Audit.gs,
 * wire it in here.
 */

/**
 * UTF-8 byte order mark, written as an escape so it survives every editor and
 * copy-paste. Excel on Windows guesses the code page without it and mangles
 * every non-Latin name (DESIGN.md §45 — names may be in any script).
 * @const {string}
 */
const REPORT_BOM = '\uFEFF';

/**
 * RFC 4180 line terminator. CRLF, because that is what Excel expects.
 * @const {string}
 */
const REPORT_EOL = '\r\n';

/** Content type returned with every export. @const {string} */
const REPORT_MIME_CSV = 'text/csv;charset=utf-8';

/**
 * The four honest auction outcomes from DESIGN.md §6.9.
 *
 * NOT the three raw AUCTION_STATUS values. With 8 teams x ~13 slots against
 * 400 registrations, roughly 300 players are never called at all. All 400 paid
 * the fee, so "Not called" has to be a visible, explainable outcome rather
 * than a blank cell or a misleading "Pending".
 *
 * @const {!Object<string,string>}
 */
const REPORT_LABEL = Object.freeze({
  /** Bought by a team. */
  SOLD: 'Sold',
  /** Came to the table and nobody bid. */
  UNSOLD: 'Unsold',
  /** PENDING with times_called > 0: returned to the pool, may sell later (§6.6). */
  AWAITING: 'Awaiting re-auction',
  /** PENDING with times_called == 0: never brought to the table. */
  NOT_CALLED: 'Not called'
});

/** Rows per page for audit.list when the caller does not say. @const {number} */
const REPORT_AUDIT_PAGE_DEFAULT = 50;

/** Hard ceiling on audit.list page size, so one call cannot pull the whole tab. @const {number} */
const REPORT_AUDIT_PAGE_MAX = 200;

/** Shown in the Team column when a sold player points at a team that no longer exists. @const {string} */
const REPORT_UNKNOWN_TEAM = '(unknown team)';

const Reports = {

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  /**
   * Null-safe string coercion. '' for null/undefined, trimmed otherwise.
   * @param {*} v any cell value
   * @return {string} the trimmed text
   */
  _str(v) {
    return (v === null || v === undefined) ? '' : String(v).trim();
  },

  /**
   * Title-case a SCREAMING_SNAKE enum for a human-readable report cell.
   * BATSMAN -> "Batsman", ALL_ROUNDER -> "All rounder", RETURNED_TO_POOL ->
   * "Returned to pool". These files are read by the tournament owner, not by a
   * machine, so the raw token would just be noise.
   * @param {*} v the enum value
   * @return {string} the readable label, '' when blank
   */
  _label(v) {
    const s = Reports._str(v);
    if (!s) return '';
    const words = s.toLowerCase().replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  },

  // ---------------------------------------------------------------------
  // CSV primitives — every exported field goes through exactly one of these
  // ---------------------------------------------------------------------

  /**
   * Encode ONE field for a CSV file. RFC 4180.
   *
   * Quote when the value contains a comma, a double quote, a CR or an LF, or
   * when it has leading/trailing whitespace (unquoted surrounding spaces are
   * discarded by some readers, which would silently trim a name). Embedded
   * quotes are escaped by doubling them.
   *
   * USE THIS FOR EVERY FIELD, NO EXCEPTIONS. Player names come from a public
   * form: one of 400 people will have a comma in their name, and one field
   * written raw shifts every later column on that row.
   *
   * A note on formula injection: this deliberately does NOT neutralise a
   * leading = + - @, because _excelText() below emits a real ="..." formula on
   * purpose and blanket-escaping would break it. The free-text fields that
   * reach a file here (name, upi_ref) are validated at entry to letters,
   * digits, spaces and dots (DESIGN.md §11), so none of them can begin with a
   * formula character. If a future field relaxes that, neutralise it there.
   *
   * @param {*} value the raw value
   * @return {string} the encoded field, ready to be joined with commas
   */
  _csvCell(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s === '') return '';
    if (/[",\r\n]/.test(s) || /^\s/.test(s) || /\s$/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  },

  /**
   * Force Excel to treat a value as text by exporting it as ="<value>".
   *
   * Without this a 10-digit mobile is read as a number and shown as
   * 9.87654E+09, and any leading zero is stripped. Long alphanumeric UPI
   * references get the same treatment — Excel will happily reinterpret
   * something like "1234E5" as scientific notation.
   *
   * The inner value has double quotes removed so a crafted field cannot break
   * out of the formula, then the whole thing is run through _csvCell, which
   * quotes it and doubles the quotes: ="98..." becomes "=""98...""".
   *
   * @param {*} value the raw value
   * @return {string} the encoded field, '' when there is nothing to protect
   */
  _excelText(value) {
    const s = Reports._str(value);
    if (!s) return '';
    return Reports._csvCell('="' + s.replace(/"/g, '') + '"');
  },

  /**
   * Encode a money column as a BARE INTEGER: no ₹, no thousands separator.
   *
   * This is the single most common way an export gets silently rejected by the
   * person who has to use it: one currency symbol makes the whole column text
   * and every SUM in the workbook returns zero.
   *
   * Util.formatINR is for screens. It must never be used in a CSV numeric
   * column. Blank stays blank — an empty cell and a zero are different facts
   * and SUM ignores the empty one, which is what we want for "not sold".
   *
   * @param {*} v rupees, as stored (Repo coerces the money columns to numbers)
   * @return {string} e.g. "125000", or '' when there is no amount
   */
  _money(v) {
    if (v === null || v === undefined || v === '') return '';
    return String(Util.toInt(v, 0));
  },

  /**
   * Encode a plain count column. Same bare-integer rule as _money.
   * @param {*} v the count
   * @return {string} the integer as text, '' when blank
   */
  _num(v) {
    if (v === null || v === undefined || v === '') return '';
    return String(Util.toInt(v, 0));
  },

  /**
   * An instant, rendered in readable Indian local time.
   *
   * Instants are stored UTC (CONTRACTS.md §6a) but a raw
   * "2026-08-30T18:45:00.000Z" in a report is both unreadable and wrong-looking
   * to everyone who was in the hall — that sale happened at 12:15 AM on the
   * 31st in Chennai. Storage stays UTC; only the rendering is IST.
   *
   * @param {*} iso ISO-8601 instant
   * @return {string} e.g. "31 Aug 2026, 12:15 AM", '' when unparseable
   */
  _when(iso) {
    return Util.formatIST(Reports._str(iso), true);
  },

  /**
   * A calendar date (DOB, tournament dates), rendered without a time.
   * @param {*} iso "YYYY-MM-DD" or a full instant
   * @return {string} e.g. "1 Jan 1995", '' when unparseable
   */
  _day(iso) {
    return Util.formatIST(Reports._str(iso), false);
  },

  /**
   * Join encoded cells into one CSV line.
   * @param {!Array<string>} cells already encoded by _csvCell / _excelText / _money
   * @return {string} the line, no terminator
   */
  _csvLine(cells) {
    return cells.join(',');
  },

  /**
   * Assemble a whole CSV document: BOM, then CRLF-terminated lines.
   * @param {!Array<string>} lines encoded lines, in order
   * @return {string} the file contents
   */
  _csvDocument(lines) {
    return REPORT_BOM + lines.join(REPORT_EOL) + REPORT_EOL;
  },

  /**
   * Build the download envelope the frontend expects.
   *
   * The browser turns {filename, mime, base64} into a download; `rows` is the
   * number of DATA rows in the file (headers and section titles excluded) so
   * the UI can say "400 rows exported" without decoding the payload.
   *
   * @param {string} slug tournament slug, used to build a descriptive filename
   * @param {string} kind e.g. "players", "teams", "auction", "final"
   * @param {!Array<string>} lines the encoded CSV lines
   * @param {number} rows how many data rows the file carries
   * @return {{filename:string, mime:string, base64:string, rows:number}} the export
   */
  _export(slug, kind, lines, rows) {
    const csv = Reports._csvDocument(lines);
    return {
      // Descriptive and safe: slug and kind are both already slug-shaped, and
      // todayIso() is the IST calendar day, so a file exported at 1 AM in
      // Chennai is not stamped with yesterday's date.
      filename: Reports._filename(slug, kind),
      mime: REPORT_MIME_CSV,
      base64: Utilities.base64Encode(csv, Utilities.Charset.UTF_8),
      rows: rows
    };
  },

  /**
   * "chennai-premier-league-players-2026-08-30.csv".
   * Everything is pushed through Util.slugify so a tournament called
   * 'Q3 "Finals" / North' cannot produce a filename the OS refuses to save.
   * @param {string} slug the tournament slug
   * @param {string} kind report kind
   * @return {string} a safe filename
   */
  _filename(slug, kind) {
    const base = Util.slugify(slug) || 'tournament';
    return base + '-' + kind + '-' + Util.todayIso() + '.csv';
  },

  // ---------------------------------------------------------------------
  // The four honest labels — DESIGN.md §6.9
  // ---------------------------------------------------------------------

  /**
   * The auction outcome for one player, as a label a human can act on.
   *
   * SOLD and UNSOLD map straight across. PENDING is the interesting one: it
   * splits on times_called, which exists for exactly this reason. "Nobody bid
   * on you" and "your number never came up" are completely different things to
   * explain to someone who paid ₹500, and the raw status cannot tell them
   * apart.
   *
   * @param {!Object} player a Players row
   * @return {string} one of the four REPORT_LABEL values
   */
  _auctionLabel(player) {
    const status = Reports._str(player && player.auction_status).toUpperCase();
    if (status === ENUM.AUCTION_STATUS.SOLD) return REPORT_LABEL.SOLD;
    if (status === ENUM.AUCTION_STATUS.UNSOLD) return REPORT_LABEL.UNSOLD;
    // PENDING, or a blank cell on a row written before the column existed.
    return Util.toInt(player && player.times_called, 0) > 0
      ? REPORT_LABEL.AWAITING
      : REPORT_LABEL.NOT_CALLED;
  },

  /**
   * The payment column for one player.
   *
   * A withdrawn player is annotated rather than given a status of its own: the
   * column list in the requirement is fixed, and dropping the withdrawal would
   * make someone who pulled out look identical to an active registration —
   * which is precisely the row a refund argument is about.
   *
   * @param {!Object} player a Players row
   * @return {string} e.g. "Verified", "Rejected", "Verified (withdrawn)"
   */
  _paymentLabel(player) {
    const base = Reports._label(player && player.payment_status) || 'Unknown';
    return (player && player.is_withdrawn === true) ? base + ' (withdrawn)' : base;
  },

  // ---------------------------------------------------------------------
  // Reads and joins — ONE Repo.readAll per tab, then everything in memory
  // ---------------------------------------------------------------------

  /**
   * Read the tabs a report needs, exactly once each.
   *
   * AuditLog is not here on purpose: audit.list does not need the tournament
   * lookup _gather() performs, so it does its own two reads.
   *
   * @param {!Object} want flags: {tournaments, players, payments, teams, results, users}
   * @return {!Object} raw unfiltered row arrays, [] for anything not requested
   */
  _read(want) {
    const w = want || {};
    return {
      tournaments: w.tournaments ? Repo.readAll(SHEETS.TOURNAMENTS) : [],
      players: w.players ? Repo.readAll(SHEETS.PLAYERS) : [],
      payments: w.payments ? Repo.readAll(SHEETS.PAYMENTS) : [],
      teams: w.teams ? Repo.readAll(SHEETS.TEAMS) : [],
      results: w.results ? Repo.readAll(SHEETS.AUCTION_RESULTS) : [],
      users: w.users ? Repo.readAll(SHEETS.USERS) : []
    };
  },

  /**
   * Rows of one tournament, filtered in memory. Never a second sheet read.
   * @param {!Array<!Object>} rows every row of a tab
   * @param {string} tournamentId the tournament
   * @return {!Array<!Object>} the matching rows
   */
  _scope(rows, tournamentId) {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      if (Reports._str(rows[i].tournament_id) === tournamentId) out.push(rows[i]);
    }
    return out;
  },

  /**
   * Everything a report needs about one tournament, from one pass over each tab.
   *
   * Also builds the join indexes, so no caller ever has to scan an array inside
   * a loop over another array.
   *
   * @param {string} tournamentId the tournament
   * @param {!Object} want which tabs to read; `tournaments` is always forced on
   * @return {!Object} {tournament, slug, players, payments, teams, results, users,
   *     playerById, teamById, paymentByPlayer, resultByPlayer, userById}
   * @throws {!Error} VALIDATION_FAILED when the id is blank, NOT_FOUND when unknown
   */
  _gather(tournamentId, want) {
    const id = Reports._str(tournamentId);
    if (!id) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'A tournament id is required.');
    }

    const w = Object.assign({}, want || {}, { tournaments: true });
    const all = Reports._read(w);

    let tournament = null;
    for (let i = 0; i < all.tournaments.length; i++) {
      if (Reports._str(all.tournaments[i].tournament_id) === id) {
        tournament = all.tournaments[i];
        break;
      }
    }
    if (!tournament) {
      // The id is caller-controlled text rendered straight into the UI, so it
      // is length-capped before it goes into the message.
      throw Util.AppError(ERR.NOT_FOUND,
        'No tournament was found with the id "' + id.substring(0, 40) + '".');
    }

    const players = Reports._scope(all.players, id);
    const payments = Reports._scope(all.payments, id);
    const teams = Reports._scope(all.teams, id);
    const results = Reports._scope(all.results, id);

    const playerById = {};
    for (let i = 0; i < players.length; i++) {
      playerById[Reports._str(players[i].player_id)] = players[i];
    }

    const teamById = {};
    for (let i = 0; i < teams.length; i++) {
      teamById[Reports._str(teams[i].team_id)] = teams[i];
    }

    const userById = {};
    for (let i = 0; i < all.users.length; i++) {
      userById[Reports._str(all.users[i].user_id)] = all.users[i];
    }

    return {
      tournamentId: id,
      tournament: tournament,
      slug: Reports._str(tournament.slug) || Util.slugify(tournament.name),
      players: players,
      payments: payments,
      teams: teams,
      results: results,
      users: all.users,
      allPlayers: all.players,
      playerById: playerById,
      teamById: teamById,
      userById: userById,
      paymentByPlayer: Reports._indexPayments(payments),
      resultByPlayer: Reports._indexResults(results)
    };
  },

  /**
   * player_id -> the payment row that represents that player's fee.
   *
   * Registration writes one payment per player, but a re-submission or a
   * hand-added row can produce two. A VERIFIED row always wins, because that
   * is the one that actually settled; otherwise the most recently submitted.
   *
   * @param {!Array<!Object>} payments Payments rows for one tournament
   * @return {!Object<string,!Object>} the index
   */
  _indexPayments(payments) {
    const out = {};
    for (let i = 0; i < payments.length; i++) {
      const pay = payments[i];
      const key = Reports._str(pay.player_id);
      if (!key) continue;
      const held = out[key];
      if (!held) { out[key] = pay; continue; }

      const heldVerified = Reports._str(held.status).toUpperCase() === ENUM.PAYMENT_STATUS.VERIFIED;
      const thisVerified = Reports._str(pay.status).toUpperCase() === ENUM.PAYMENT_STATUS.VERIFIED;
      if (thisVerified && !heldVerified) { out[key] = pay; continue; }
      if (thisVerified === heldVerified &&
          Reports._ms(pay.submitted_at) > Reports._ms(held.submitted_at)) {
        out[key] = pay;
      }
    }
    return out;
  },

  /**
   * player_id -> the CURRENT AuctionResults row for that player.
   *
   * History is append-only and a correction supersedes rather than edits
   * (DESIGN.md §43), so a player can have several rows and exactly one with
   * is_current TRUE. If the flag is somehow missing on all of them, the latest
   * by auction_time is used rather than dropping the player from the report.
   *
   * @param {!Array<!Object>} results AuctionResults rows for one tournament
   * @return {!Object<string,!Object>} the index
   */
  _indexResults(results) {
    const out = {};
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const key = Reports._str(r.player_id);
      if (!key) continue;
      const held = out[key];
      if (!held) { out[key] = r; continue; }

      if (r.is_current === true && held.is_current !== true) { out[key] = r; continue; }
      if ((r.is_current === true) === (held.is_current === true) &&
          Reports._ms(r.auction_time) > Reports._ms(held.auction_time)) {
        out[key] = r;
      }
    }
    return out;
  },

  /**
   * Milliseconds for sorting. Unparseable and blank sort oldest, so a row with
   * a broken timestamp never jumps to the top of a "newest first" list.
   *
   * The fallback is the smallest real Date value rather than -Infinity: two
   * -Infinity values subtracted give NaN, and a comparator that returns NaN
   * makes Array.sort's result undefined.
   *
   * @param {*} iso an ISO instant
   * @return {number} epoch ms, or -8.64e15 when there is no usable date
   */
  _ms(iso) {
    const ms = Date.parse(Reports._str(iso));
    return isNaN(ms) ? -8.64e15 : ms;
  },

  /**
   * Team name for a team id, honest about a dangling reference.
   * @param {!Object} data a _gather result
   * @param {*} teamId the id on a player or result row
   * @return {string} the team name, '' when there is no team, or the unknown marker
   */
  _teamName(data, teamId) {
    const id = Reports._str(teamId);
    if (!id) return '';
    const team = data.teamById[id];
    return team ? Reports._str(team.team_name) : REPORT_UNKNOWN_TEAM;
  },

  /**
   * Ascending comparator on serial_no, the order every screen already uses.
   * @param {!Object} a left player row
   * @param {!Object} b right player row
   * @return {number} negative, zero or positive
   */
  _bySerial(a, b) {
    return Util.toInt(a.serial_no, 0) - Util.toInt(b.serial_no, 0);
  },

  /**
   * Plain ascending text comparator. Returns 0 for equal values, which
   * Array.sort needs in order to keep a stable, repeatable order.
   * @param {string} a left value
   * @param {string} b right value
   * @return {number} negative, zero or positive
   */
  _compareText(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  },

  // ---------------------------------------------------------------------
  // report.players — CONTRACTS-PHASE4-7 PHASE 6
  // Serial No, Name, DOB, Role, Style, Mobile, Payment Reference,
  // Payment Status, Auction Status, Team, Purchase Amount
  // ---------------------------------------------------------------------

  /**
   * The Player List export: every registered player, one row each.
   *
   * Reads Players, Payments, Teams and Tournaments once each.
   *
   * @param {!Object} payload {tournamentId}
   * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
   * @return {{filename:string, mime:string, base64:string, rows:number}} the export
   * @throws {!Error} VALIDATION_FAILED, FORBIDDEN, NOT_FOUND
   */
  players(payload, session) {
    const p = payload || {};
    const tournamentId = Reports._str(p.tournamentId || p.tournament_id);
    // The only thing standing between one organiser and another organiser's
    // players. Checked before anything is read.
    Auth.requireTournament(session, tournamentId);

    const data = Reports._gather(tournamentId,
      { players: true, payments: true, teams: true });

    const lines = [Reports._csvLine([
      'Serial No', 'Name', 'DOB', 'Role', 'Style', 'Mobile', 'Payment Reference',
      'Payment Status', 'Auction Status', 'Team', 'Purchase Amount'
    ].map(Reports._csvCell))];

    const ordered = data.players.slice().sort(Reports._bySerial);
    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i];
      const pay = data.paymentByPlayer[Reports._str(row.player_id)] || null;
      lines.push(Reports._csvLine([
        Reports._num(row.serial_no),
        Reports._csvCell(row.name),
        Reports._csvCell(Reports._day(row.dob)),
        Reports._csvCell(Reports._label(row.role)),
        Reports._csvCell(Reports._label(row.style)),
        // ="9876543210" — see _excelText. Without it Excel shows 9.87654E+09.
        Reports._excelText(row.mobile),
        // UPI references are long alphanumerics Excel will also mangle.
        Reports._excelText(pay ? pay.upi_ref : ''),
        Reports._csvCell(Reports._paymentLabel(row)),
        Reports._csvCell(Reports._auctionLabel(row)),
        Reports._csvCell(Reports._teamName(data, row.team_id)),
        Reports._money(row.sold_amount)
      ]));
    }

    return Reports._export(data.slug, 'players', lines, ordered.length);
  },

  // ---------------------------------------------------------------------
  // report.teams
  // Team, Player, Purchase Amount, Total Players, Total Spent, Remaining Purse
  // ---------------------------------------------------------------------

  /**
   * The Team Report: every team, every player they bought, and the totals.
   *
   * The team-level columns repeat on each of that team's rows. That is
   * deliberate — blank cells break pivot tables and sorting, and a reader who
   * sorts the sheet by Purchase Amount would otherwise lose which totals
   * belonged to which team.
   *
   * THE TOTALS ARE DERIVED FROM THE ROWS IN THIS FILE, not from
   * Teams.purse_used, so the file is internally consistent: Total Spent always
   * equals the sum of the Purchase Amount cells above it, and Remaining Purse
   * is purse_total minus that sum. If those disagree with the stored counters
   * the counters have drifted, and rebuildCounters() in Setup.gs is the fix —
   * an export is the wrong place to paper over it.
   *
   * A team that bought nobody still gets one row with an empty Player, because
   * a team silently missing from the report is a worse error than a blank cell.
   *
   * @param {!Object} payload {tournamentId}
   * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
   * @return {{filename:string, mime:string, base64:string, rows:number}} the export
   * @throws {!Error} VALIDATION_FAILED, FORBIDDEN, NOT_FOUND
   */
  teams(payload, session) {
    const p = payload || {};
    const tournamentId = Reports._str(p.tournamentId || p.tournament_id);
    Auth.requireTournament(session, tournamentId);

    const data = Reports._gather(tournamentId, { players: true, teams: true });
    const squads = Reports._squads(data);

    const lines = [Reports._csvLine([
      'Team', 'Player', 'Purchase Amount', 'Total Players', 'Total Spent', 'Remaining Purse'
    ].map(Reports._csvCell))];

    let rows = 0;
    for (let i = 0; i < squads.length; i++) {
      const squad = squads[i];
      const name = Reports._csvCell(squad.team_name);
      const count = Reports._num(squad.players.length);
      const spent = Reports._money(squad.spent);
      const left = Reports._money(squad.remaining);

      if (!squad.players.length) {
        lines.push(Reports._csvLine([name, '', '', count, spent, left]));
        rows++;
        continue;
      }
      for (let j = 0; j < squad.players.length; j++) {
        const player = squad.players[j];
        lines.push(Reports._csvLine([
          name,
          Reports._csvCell(player.name),
          Reports._money(player.sold_amount),
          count, spent, left
        ]));
        rows++;
      }
    }

    return Reports._export(data.slug, 'teams', lines, rows);
  },

  /**
   * Group sold players under their team and total them up.
   *
   * Players whose team_id points at a deleted team are collected under a
   * synthetic "(unknown team)" entry rather than dropped, because money that
   * left a purse has to appear somewhere in the report.
   *
   * @param {!Object} data a _gather result carrying players and teams
   * @return {!Array<{team_id:string, team_name:string, purse_total:number,
   *     players:!Array<!Object>, count:number, spent:number, remaining:number,
   *     max_players:number}>} squads, sorted by team name
   */
  _squads(data) {
    const byId = {};
    const order = [];

    for (let i = 0; i < data.teams.length; i++) {
      const team = data.teams[i];
      const id = Reports._str(team.team_id);
      byId[id] = {
        team_id: id,
        team_name: Reports._str(team.team_name),
        purse_total: Util.toInt(team.purse_total, 0),
        max_players: Util.toInt(team.max_players, 0),
        purse_used_recorded: Util.toInt(team.purse_used, 0),
        players_count_recorded: Util.toInt(team.players_count, 0),
        players: [], spent: 0
      };
      order.push(byId[id]);
    }

    for (let i = 0; i < data.players.length; i++) {
      const player = data.players[i];
      const teamId = Reports._str(player.team_id);
      if (!teamId) continue;
      let squad = byId[teamId];
      if (!squad) {
        squad = {
          team_id: teamId,
          team_name: REPORT_UNKNOWN_TEAM,
          purse_total: 0, max_players: 0,
          purse_used_recorded: 0, players_count_recorded: 0,
          players: [], spent: 0
        };
        byId[teamId] = squad;
        order.push(squad);
      }
      squad.players.push(player);
      squad.spent += Util.toInt(player.sold_amount, 0);
    }

    for (let i = 0; i < order.length; i++) {
      order[i].players.sort(Reports._bySerial);
      order[i].count = order[i].players.length;
      order[i].remaining = order[i].purse_total - order[i].spent;
    }

    order.sort((a, b) => Reports._compareText(a.team_name, b.team_name));
    return order;
  },

  // ---------------------------------------------------------------------
  // report.auction
  // Serial No, Player, Status, Team, Purchase Amount, Auction Time
  // ---------------------------------------------------------------------

  /**
   * The Auction Report: the outcome for EVERY registered player.
   *
   * Not just the ones with an AuctionResults row. If this listed only recorded
   * results, "Not called" could never appear — and roughly 300 of the 400
   * players who each paid a fee end up in exactly that state (DESIGN.md §6.9).
   * Leaving them out is how a report starts an argument.
   *
   * Order: the players who were called, in the order it happened, then the ones
   * who never came up, by serial number. The file reads as the story of the
   * auction followed by everyone who was still waiting when it ended.
   *
   * This is the FINAL state per player. Superseded rows from a correction are
   * not here; they are in report.final's auction history section, which is the
   * place for the full paper trail.
   *
   * @param {!Object} payload {tournamentId}
   * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
   * @return {{filename:string, mime:string, base64:string, rows:number}} the export
   * @throws {!Error} VALIDATION_FAILED, FORBIDDEN, NOT_FOUND
   */
  auction(payload, session) {
    const p = payload || {};
    const tournamentId = Reports._str(p.tournamentId || p.tournament_id);
    Auth.requireTournament(session, tournamentId);

    const data = Reports._gather(tournamentId,
      { players: true, teams: true, results: true });

    const lines = [Reports._csvLine([
      'Serial No', 'Player', 'Status', 'Team', 'Purchase Amount', 'Auction Time'
    ].map(Reports._csvCell))];

    const called = [];
    const never = [];
    for (let i = 0; i < data.players.length; i++) {
      const player = data.players[i];
      const result = data.resultByPlayer[Reports._str(player.player_id)] || null;
      // sold_at is the fallback: a sale recorded before the result row landed
      // still has a time on the player, and a blank time on a SOLD row would
      // look like a bug to the reader.
      const at = Reports._str(result ? result.auction_time : '') || Reports._str(player.sold_at);
      const entry = { player: player, at: at };
      if (at) called.push(entry); else never.push(entry);
    }
    called.sort((a, b) => (Reports._ms(a.at) - Reports._ms(b.at)) ||
      Reports._bySerial(a.player, b.player));
    never.sort((a, b) => Reports._bySerial(a.player, b.player));

    const ordered = called.concat(never);
    for (let i = 0; i < ordered.length; i++) {
      const player = ordered[i].player;
      lines.push(Reports._csvLine([
        Reports._num(player.serial_no),
        Reports._csvCell(player.name),
        Reports._csvCell(Reports._auctionLabel(player)),
        Reports._csvCell(Reports._teamName(data, player.team_id)),
        Reports._money(player.sold_amount),
        Reports._csvCell(Reports._when(ordered[i].at))
      ]));
    }

    return Reports._export(data.slug, 'auction', lines, ordered.length);
  },

  // ---------------------------------------------------------------------
  // report.final — CONTRACTS-PHASE4-7 PHASE 7 item 3
  // ---------------------------------------------------------------------

  /**
   * The final tournament report: admin stats, every team squad and the full
   * auction history, in ONE file.
   *
   * One file rather than three, because this is the artefact that gets emailed
   * to the tournament owner and filed. Sections are separated by a blank line
   * and a title row; Excel opens that happily and a human can read it top to
   * bottom.
   *
   * The auction history section is the only place superseded rows appear. That
   * is the point of it: DESIGN.md §43 says a correction never deletes, so the
   * evidence that a sale was corrected — and to what — has to be exportable.
   *
   * Reads Tournaments, Players, Payments, Teams, AuctionResults and Users
   * exactly once each.
   *
   * @param {!Object} payload {tournamentId}
   * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
   * @return {{filename:string, mime:string, base64:string, rows:number}} the export
   * @throws {!Error} VALIDATION_FAILED, FORBIDDEN, NOT_FOUND
   */
  final(payload, session) {
    const p = payload || {};
    const tournamentId = Reports._str(p.tournamentId || p.tournament_id);
    Auth.requireTournament(session, tournamentId);

    const data = Reports._gather(tournamentId, {
      players: true, payments: true, teams: true, results: true, users: true
    });
    const stats = Reports._stats(data);

    const lines = [];
    let rows = 0;

    lines.push(Reports._csvLine([
      Reports._csvCell(Reports._str(data.tournament.name) + ' — Final Report')
    ]));
    lines.push(Reports._csvLine([
      Reports._csvCell('Generated'), Reports._csvCell(Reports._when(Util.nowIso()))
    ]));

    // --- Section 1: the numbers -------------------------------------------
    lines.push('');
    lines.push(Reports._csvLine([Reports._csvCell('SUMMARY')]));
    lines.push(Reports._csvLine([Reports._csvCell('Metric'), Reports._csvCell('Value')]));
    const metrics = Reports._statLines(data, stats);
    for (let i = 0; i < metrics.length; i++) {
      lines.push(Reports._csvLine([
        Reports._csvCell(metrics[i][0]),
        // Already encoded by the builder: money metrics are bare integers and
        // must not be re-quoted into text.
        metrics[i][1]
      ]));
      rows++;
    }

    // --- Section 2: the squads --------------------------------------------
    lines.push('');
    lines.push(Reports._csvLine([Reports._csvCell('TEAM SQUADS')]));
    lines.push(Reports._csvLine([
      'Team', 'Serial No', 'Player', 'Role', 'Purchase Amount',
      'Team Total Players', 'Team Total Spent', 'Team Remaining Purse'
    ].map(Reports._csvCell)));

    const squads = Reports._squads(data);
    for (let i = 0; i < squads.length; i++) {
      const squad = squads[i];
      const name = Reports._csvCell(squad.team_name);
      const count = Reports._num(squad.players.length);
      const spent = Reports._money(squad.spent);
      const left = Reports._money(squad.remaining);
      if (!squad.players.length) {
        lines.push(Reports._csvLine([name, '', '', '', '', count, spent, left]));
        rows++;
        continue;
      }
      for (let j = 0; j < squad.players.length; j++) {
        const player = squad.players[j];
        lines.push(Reports._csvLine([
          name,
          Reports._num(player.serial_no),
          Reports._csvCell(player.name),
          Reports._csvCell(Reports._label(player.role)),
          Reports._money(player.sold_amount),
          count, spent, left
        ]));
        rows++;
      }
    }

    // --- Section 3: the whole paper trail ---------------------------------
    lines.push('');
    lines.push(Reports._csvLine([
      Reports._csvCell('AUCTION HISTORY (every recorded result, superseded rows included)')
    ]));
    lines.push(Reports._csvLine([
      'Auction Time', 'Serial No', 'Player', 'Result', 'Team', 'Amount',
      'Recorded By', 'Current', 'Supersedes', 'Note'
    ].map(Reports._csvCell)));

    // Newest first, matching auction.history (CONTRACTS-PHASE4-7 §4.2).
    const history = data.results.slice().sort((a, b) => Reports._ms(b.auction_time) - Reports._ms(a.auction_time));
    for (let i = 0; i < history.length; i++) {
      const r = history[i];
      const player = data.playerById[Reports._str(r.player_id)] || null;
      // The result row denormalises serial_no; fall back to the player row so a
      // history line written before that column was populated still identifies
      // who it was about.
      const serial = Reports._str(r.serial_no) ? r.serial_no : (player ? player.serial_no : '');
      lines.push(Reports._csvLine([
        Reports._csvCell(Reports._when(r.auction_time)),
        Reports._num(serial),
        Reports._csvCell(player ? player.name : ''),
        // The RESULT status, not one of the four resting labels: these rows are
        // events ("returned to pool"), and an event is not a final outcome.
        Reports._csvCell(Reports._label(r.status)),
        Reports._csvCell(Reports._teamName(data, r.team_id)),
        Reports._money(r.amount),
        Reports._csvCell(Reports._actorName(data, r.recorded_by)),
        Reports._csvCell(r.is_current === true ? 'Yes' : 'No'),
        Reports._csvCell(r.supersedes_auction_id),
        Reports._csvCell(r.note)
      ]));
      rows++;
    }

    return Reports._export(data.slug, 'final', lines, rows);
  },

  /**
   * A user id turned into something a human can read in a report.
   * Falls back to the raw id so the trail is never lost, only improved.
   * @param {!Object} data a _gather result carrying userById
   * @param {*} userId the id from a recorded_by / actor_user_id column
   * @return {string} "Priya Nair" or the raw id, '' when blank
   */
  _actorName(data, userId) {
    const id = Reports._str(userId);
    if (!id) return '';
    const user = data.userById ? data.userById[id] : null;
    if (!user) return id;
    const name = Reports._str(user.display_name) || Reports._str(user.email);
    return name || id;
  },

  /**
   * The SUMMARY section of report.final, as [label, encodedValue] pairs.
   *
   * Money values go through _money so they stay bare integers in the file. The
   * corresponding readable "₹1,25,000" strings live on the dashboard.adminStats
   * response instead, where a currency symbol is what you actually want.
   *
   * @param {!Object} data a _gather result
   * @param {!Object} stats the _stats result for the same data
   * @return {!Array<!Array<string>>} label/value pairs, value already CSV-encoded
   */
  _statLines(data, stats) {
    return [
      ['Tournament', Reports._csvCell(data.tournament.name)],
      ['Status', Reports._csvCell(Reports._label(data.tournament.status))],
      ['Registrations', Reports._num(stats.registrations.all)],
      ['Payments verified', Reports._num(stats.registrations.verified)],
      ['Payments pending', Reports._num(stats.registrations.pending)],
      ['Payments rejected', Reports._num(stats.registrations.rejected)],
      ['Withdrawn', Reports._num(stats.registrations.withdrawn)],
      ['Eligible for the auction', Reports._num(stats.registrations.eligible)],
      ['Fees collected', Reports._money(stats.fees.collected)],
      ['Teams', Reports._num(stats.teams.total)],
      ['Teams full', Reports._num(stats.teams.full)],
      ['Squad slots', Reports._num(stats.teams.slots_total)],
      ['Slots filled', Reports._num(stats.teams.slots_filled)],
      ['Slots remaining', Reports._num(stats.teams.slots_remaining)],
      [REPORT_LABEL.SOLD, Reports._num(stats.auction.sold)],
      [REPORT_LABEL.UNSOLD, Reports._num(stats.auction.unsold)],
      [REPORT_LABEL.AWAITING, Reports._num(stats.auction.awaiting_reauction)],
      [REPORT_LABEL.NOT_CALLED, Reports._num(stats.auction.not_called)],
      ['Total spent', Reports._money(stats.purse.spent)],
      ['Purse remaining', Reports._money(stats.purse.remaining)],
      ['Highest sale', Reports._money(stats.purse.highest_sale)],
      ['Highest sale player', Reports._csvCell(stats.purse.highest_sale_player)],
      ['Average sale', Reports._money(stats.purse.average_sale)],
      ['Corrections recorded', Reports._num(stats.auction.corrections)]
    ];
  },

  // ---------------------------------------------------------------------
  // dashboard.adminStats — DESIGN.md §35
  // ---------------------------------------------------------------------

  /**
   * The admin dashboard numbers: registration, payment, team and auction
   * counts for one tournament, or across all of them.
   *
   * With a tournamentId: one block. Without: every tournament plus a totals
   * row, which is what the admin landing page shows when several tournaments
   * are live. Either way each tab is read exactly once and everything else is
   * grouped in memory.
   *
   * @param {!Object} payload {tournamentId} — optional; omit for all tournaments
   * @param {!Object} session ADMIN session
   * @return {{scope:string, generated_at:string, generated_at_display:string,
   *     tournaments:!Array<!Object>, totals:!Object}} the stats
   * @throws {!Error} NOT_FOUND when a supplied tournament id is unknown
   */
  adminStats(payload, session) {
    const p = payload || {};
    const tournamentId = Reports._str(p.tournamentId || p.tournament_id);

    const want = { tournaments: true, players: true, payments: true, teams: true, results: true };
    const all = Reports._read(want);

    let wanted = all.tournaments;
    if (tournamentId) {
      // Belt and braces: the route is ADMIN-only, but if it is ever widened to
      // ORGANISER this is the check that keeps them inside their own data.
      Auth.requireTournament(session, tournamentId);
      wanted = all.tournaments.filter((t) => Reports._str(t.tournament_id) === tournamentId);
      if (!wanted.length) {
        throw Util.AppError(ERR.NOT_FOUND,
          'No tournament was found with the id "' + tournamentId.substring(0, 40) + '".');
      }
    }

    const blocks = [];
    for (let i = 0; i < wanted.length; i++) {
      const tournament = wanted[i];
      const id = Reports._str(tournament.tournament_id);
      const scoped = {
        tournamentId: id,
        tournament: tournament,
        players: Reports._scope(all.players, id),
        payments: Reports._scope(all.payments, id),
        teams: Reports._scope(all.teams, id),
        results: Reports._scope(all.results, id),
        teamById: {}
      };
      for (let j = 0; j < scoped.teams.length; j++) {
        scoped.teamById[Reports._str(scoped.teams[j].team_id)] = scoped.teams[j];
      }
      blocks.push(Reports._stats(scoped));
    }

    const now = Util.nowIso();
    return {
      scope: tournamentId ? 'TOURNAMENT' : 'ALL',
      generated_at: now,
      generated_at_display: Reports._when(now),
      tournaments: blocks,
      totals: Reports._totals(blocks)
    };
  },

  /**
   * Every number for one tournament, computed from rows already in memory.
   *
   * The four auction counts are taken over the ELIGIBLE pool only, so
   * sold + unsold + awaiting_reauction + not_called === eligible. A player
   * whose payment was rejected was never in the auction and counting them as
   * "not called" would inflate the number the all-teams-full banner quotes
   * (CONTRACTS-PHASE4-7 §4.6). The registration block reports the rest.
   *
   * `spent` is derived from the sold players rather than read off
   * Teams.purse_used, and `counters_match` says whether the two agree. They
   * can drift if a row is hand-edited in the sheet, and the admin would rather
   * be told than shown a confident wrong number; rebuildCounters() in Setup.gs
   * is the repair.
   *
   * @param {!Object} data a _gather result, or the equivalent shape
   * @return {!Object} the stats block for one tournament
   */
  _stats(data) {
    const t = data.tournament;
    const counts = Players.counts(data.tournamentId, data.players);

    let sold = 0, unsold = 0, awaiting = 0, notCalled = 0;
    let spent = 0, highest = 0, highestPlayer = '';
    for (let i = 0; i < data.players.length; i++) {
      const player = data.players[i];
      if (!Players.isAuctionEligible(player)) continue;
      const label = Reports._auctionLabel(player);
      if (label === REPORT_LABEL.SOLD) {
        sold++;
        const amount = Util.toInt(player.sold_amount, 0);
        spent += amount;
        if (amount > highest) {
          highest = amount;
          highestPlayer = Reports._str(player.name);
        }
      } else if (label === REPORT_LABEL.UNSOLD) {
        unsold++;
      } else if (label === REPORT_LABEL.AWAITING) {
        awaiting++;
      } else {
        notCalled++;
      }
    }

    let purseTotal = 0, purseUsedRecorded = 0, slotsTotal = 0, slotsFilled = 0, teamsFull = 0;
    for (let i = 0; i < data.teams.length; i++) {
      const team = data.teams[i];
      const max = Util.toInt(team.max_players, 0);
      const filled = Util.toInt(team.players_count, 0);
      purseTotal += Util.toInt(team.purse_total, 0);
      purseUsedRecorded += Util.toInt(team.purse_used, 0);
      slotsTotal += max;
      slotsFilled += filled;
      if (max > 0 && filled >= max) teamsFull++;
    }

    let collected = 0;
    for (let i = 0; i < data.payments.length; i++) {
      if (Reports._str(data.payments[i].status).toUpperCase() === ENUM.PAYMENT_STATUS.VERIFIED) {
        collected += Util.toInt(data.payments[i].amount, 0);
      }
    }

    let corrections = 0;
    for (let i = 0; i < data.results.length; i++) {
      if (Reports._str(data.results[i].supersedes_auction_id)) corrections++;
    }

    const regFee = Util.toInt(t.reg_fee, 0);
    const remaining = purseTotal - spent;

    return {
      tournament_id: Reports._str(t.tournament_id),
      slug: Reports._str(t.slug),
      name: Reports._str(t.name),
      status: Reports._str(t.status),
      status_display: Reports._label(t.status),

      registrations: {
        all: counts.all,
        pending: counts.pending,
        verified: counts.verified,
        rejected: counts.rejected,
        withdrawn: counts.withdrawn,
        eligible: counts.eligible
      },

      fees: {
        reg_fee: regFee,
        reg_fee_display: Util.formatINR(regFee),
        collected: collected,
        collected_display: Util.formatINR(collected),
        // What the verified registrations are worth at the advertised fee. A
        // gap against `collected` means someone paid a different amount.
        expected: counts.verified * regFee,
        expected_display: Util.formatINR(counts.verified * regFee)
      },

      teams: {
        total: data.teams.length,
        full: teamsFull,
        // Advisory only — the admin still clicks close (DESIGN.md §6.9).
        all_teams_full: data.teams.length > 0 && teamsFull === data.teams.length,
        slots_total: slotsTotal,
        slots_filled: slotsFilled,
        slots_remaining: slotsTotal - slotsFilled
      },

      auction: {
        sold: sold,
        unsold: unsold,
        awaiting_reauction: awaiting,
        not_called: notCalled,
        results_recorded: data.results.length,
        corrections: corrections
      },

      purse: {
        total: purseTotal,
        total_display: Util.formatINR(purseTotal),
        spent: spent,
        spent_display: Util.formatINR(spent),
        remaining: remaining,
        remaining_display: Util.formatINR(remaining),
        highest_sale: highest,
        highest_sale_display: Util.formatINR(highest),
        highest_sale_player: highestPlayer,
        average_sale: sold ? Math.round(spent / sold) : 0,
        average_sale_display: Util.formatINR(sold ? Math.round(spent / sold) : 0),
        spent_recorded_on_teams: purseUsedRecorded,
        counters_match: purseUsedRecorded === spent && slotsFilled === sold
      }
    };
  },

  /**
   * Add up the per-tournament blocks for the all-tournaments view.
   * Only the additive numbers are rolled up: a "highest sale" or an "average"
   * across unrelated tournaments would be a number that means nothing.
   * @param {!Array<!Object>} blocks per-tournament stats
   * @return {!Object} the totals
   */
  _totals(blocks) {
    const out = {
      tournaments: blocks.length,
      registrations: { all: 0, pending: 0, verified: 0, rejected: 0, withdrawn: 0, eligible: 0 },
      fees: { collected: 0, collected_display: '' },
      teams: { total: 0, full: 0, slots_total: 0, slots_filled: 0, slots_remaining: 0 },
      auction: { sold: 0, unsold: 0, awaiting_reauction: 0, not_called: 0 },
      purse: { total: 0, spent: 0, remaining: 0, total_display: '', spent_display: '', remaining_display: '' }
    };
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      Object.keys(out.registrations).forEach((k) => { out.registrations[k] += b.registrations[k]; });
      Object.keys(out.auction).forEach((k) => { out.auction[k] += b.auction[k]; });
      out.fees.collected += b.fees.collected;
      out.teams.total += b.teams.total;
      out.teams.full += b.teams.full;
      out.teams.slots_total += b.teams.slots_total;
      out.teams.slots_filled += b.teams.slots_filled;
      out.teams.slots_remaining += b.teams.slots_remaining;
      out.purse.total += b.purse.total;
      out.purse.spent += b.purse.spent;
      out.purse.remaining += b.purse.remaining;
    }
    out.fees.collected_display = Util.formatINR(out.fees.collected);
    out.purse.total_display = Util.formatINR(out.purse.total);
    out.purse.spent_display = Util.formatINR(out.purse.spent);
    out.purse.remaining_display = Util.formatINR(out.purse.remaining);
    return out;
  },

  // ---------------------------------------------------------------------
  // audit.list — CONTRACTS-PHASE4-7 PHASE 7 item 1
  // ---------------------------------------------------------------------

  /**
   * One page of the audit trail: newest first, filterable by action, actor and
   * date range.
   *
   * READ-ONLY, AND THAT IS A DESIGN DECISION, NOT AN OVERSIGHT. The AuditLog
   * tab is append-only evidence. It is what settles "the organiser says I never
   * paid" three months after the tournament (DESIGN.md §42), and evidence that
   * can be edited from the same admin screen that is being disputed is not
   * evidence. There is no audit.update, no audit.delete and no audit.correct
   * anywhere in this project, and none may be added.
   *
   * Two reads: AuditLog once, Users once (so the trail shows "Priya Nair" and
   * not "USR_k3m9x1qz7f2a"). Never a lookup per row.
   *
   * @param {!Object} payload {tournamentId, action, actor, from, to, entityId,
   *     page, pageSize}
   * @param {!Object} session ADMIN session
   * @return {{rows:!Array<!Object>, page:number, pageSize:number, total:number,
   *     totalPages:number, actions:!Array<string>}} the page
   * @throws {!Error} VALIDATION_FAILED on an unknown action or a bad date bound
   */
  auditList(payload, session) {
    const p = payload || {};
    const tournamentId = Reports._str(p.tournamentId || p.tournament_id);
    if (tournamentId) {
      // ADMIN passes straight through. Here so the scope check cannot be
      // forgotten if this route is ever widened.
      Auth.requireTournament(session, tournamentId);
    }

    const wantAction = Reports._str(p.action).toUpperCase();
    if (wantAction && !Object.prototype.hasOwnProperty.call(Audit.ACTIONS, wantAction)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        '"' + wantAction.substring(0, 40) + '" is not an audited action. Use one of: ' +
        Object.keys(Audit.ACTIONS).join(', ') + '.');
    }

    const from = Reports._bound(p.from, 'From date');
    const to = Reports._bound(p.to, 'To date');
    // Both bounds given the wrong way round returns nothing, which looks like a
    // data problem. Say what actually happened instead.
    if (from && to && Date.parse(from) > Date.parse(to)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        'The from date (' + from + ') is after the to date (' + to + ').');
    }

    const wantActor = Reports._str(p.actor).toLowerCase();
    const wantEntity = Reports._str(p.entityId);

    const pageSizeRaw = Util.toInt(p.pageSize, REPORT_AUDIT_PAGE_DEFAULT) || REPORT_AUDIT_PAGE_DEFAULT;
    const pageSize = Math.min(REPORT_AUDIT_PAGE_MAX, Math.max(1, pageSizeRaw));
    const page = Math.max(1, Util.toInt(p.page, 1) || 1);

    // --- the two reads, and only these two --------------------------------
    const logRows = Repo.readAll(SHEETS.AUDIT_LOG);
    const userRows = Repo.readAll(SHEETS.USERS);

    const userById = {};
    for (let i = 0; i < userRows.length; i++) {
      userById[Reports._str(userRows[i].user_id)] = userRows[i];
    }
    const data = { userById: userById };

    // The action list offered to the filter dropdown is scoped to the
    // tournament but NOT to the other filters, so choosing an action never
    // empties the menu you chose it from.
    const inScope = [];
    const actionsSeen = {};
    for (let i = 0; i < logRows.length; i++) {
      const row = logRows[i];
      if (tournamentId && Reports._str(row.tournament_id) !== tournamentId) continue;
      inScope.push(row);
      const action = Reports._str(row.action);
      if (action) actionsSeen[action] = true;
    }

    const matched = [];
    for (let i = 0; i < inScope.length; i++) {
      const row = inScope[i];

      if (wantAction && Reports._str(row.action).toUpperCase() !== wantAction) continue;
      if (wantEntity && Reports._str(row.entity_id) !== wantEntity) continue;

      if (wantActor) {
        const user = userById[Reports._str(row.actor_user_id)];
        const hay = [
          Reports._str(row.actor_user_id),
          user ? Reports._str(user.email) : '',
          user ? Reports._str(user.display_name) : ''
        ].join(' ').toLowerCase();
        if (hay.indexOf(wantActor) === -1) continue;
      }

      if (from || to) {
        const at = Reports._str(row.timestamp);
        if (!at) continue;
        // CONTRACTS.md §6a rule 2: every date-range check goes through
        // isWithinWindow, so a bare "2026-08-31" covers the whole IST day
        // rather than closing at 05:30 that morning.
        if (!Util.isWithinWindow(from, to, at)) continue;
      }

      matched.push(row);
    }

    // Newest first. log_id breaks the tie so two rows written in the same
    // millisecond keep a stable order between requests.
    matched.sort((a, b) => (Reports._ms(b.timestamp) - Reports._ms(a.timestamp)) ||
      Reports._compareText(Reports._str(b.log_id), Reports._str(a.log_id)));

    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    // A page past the end is an empty list, not an error: the admin may be on
    // page 8 when a filter change shrinks the result to two pages.
    const slice = (start >= total) ? [] : matched.slice(start, start + pageSize);

    return {
      rows: slice.map((row) => Reports._auditRow(row, data)),
      page: page,
      pageSize: pageSize,
      total: total,
      totalPages: totalPages,
      actions: Object.keys(actionsSeen).sort()
    };
  },

  /**
   * Shape one AuditLog row for the admin screen.
   *
   * prev_value / new_value are stored as JSON text. They are parsed back into
   * objects here so the UI can render a field-by-field diff; anything that is
   * not valid JSON (a truncated payload, for instance) is passed through as
   * the raw string rather than dropped, because a partial record still helps.
   *
   * @param {!Object} row an AuditLog row
   * @param {{userById:!Object}} data the user index
   * @return {!Object} the response row
   */
  _auditRow(row, data) {
    const at = Reports._str(row.timestamp);
    const raw = Reports._str(row.prev_value);
    const rawNext = Reports._str(row.new_value);
    return {
      log_id: Reports._str(row.log_id),
      timestamp: at,
      timestamp_display: Reports._when(at),
      actor_user_id: Reports._str(row.actor_user_id),
      actor_name: Reports._actorName(data, row.actor_user_id),
      actor_role: Reports._str(row.actor_role),
      action: Reports._str(row.action),
      action_display: Reports._label(row.action),
      tournament_id: Reports._str(row.tournament_id),
      entity_type: Reports._str(row.entity_type),
      entity_id: Reports._str(row.entity_id),
      prev_value: raw ? Util.safeJsonParse(raw, raw) : null,
      new_value: rawNext ? Util.safeJsonParse(rawNext, rawNext) : null,
      user_agent: Reports._str(row.user_agent)
    };
  },

  /**
   * Validate one end of a date filter.
   *
   * A 10-character value stays a bare date on purpose: Util.isWithinWindow
   * widens it to the whole IST day (CONTRACTS.md §6a rule 3). Anything longer
   * must be a parseable instant.
   *
   * @param {*} v the supplied bound
   * @param {string} label field name for the error message
   * @return {string} the bound, '' when unbounded on that side
   * @throws {!Error} VALIDATION_FAILED when the value is not a date
   */
  _bound(v, label) {
    const s = Reports._str(v);
    if (!s) return '';
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        label + ' must be a date like 2026-08-31, got "' + s.substring(0, 40) + '".');
    }
    // istDayStartUtc rejects a day that does not exist (2026-02-30). Its own
    // message does not name the field, so it is re-thrown with one that does.
    let probe;
    try {
      probe = Date.parse(s.length === 10 ? Util.istDayStartUtc(s) : s);
    } catch (err) {
      probe = NaN;
    }
    if (isNaN(probe)) {
      throw Util.AppError(ERR.VALIDATION_FAILED,
        label + ' "' + s.substring(0, 40) + '" is not a real date.');
    }
    return s;
  }
};

/**
 * Report, dashboard and audit routes.
 *
 * The three CSVs and the final report allow ORGANISER as well as ADMIN, scoped
 * by Auth.requireTournament inside each handler: an organiser running the
 * auction needs the team sheet in their hand, and it is their own tournament's
 * data.
 *
 * dashboard.adminStats is ADMIN only because with no tournamentId it reports
 * across every tournament on the instance.
 *
 * audit.list is ADMIN only and READ-ONLY. There is deliberately no route here
 * that writes, edits or deletes an audit row (DESIGN.md §42).
 *
 * DESIGN.md §4.1 lists a single `report.export`; CONTRACTS-PHASE4-7 PHASE 6
 * splits it into the three named CSVs, which is what is built here.
 *
 * @return {!Object} route table fragment
 */
function ReportRoutes() {
  return {
    'report.players': {
      auth: ['ADMIN', 'ORGANISER'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
       * @return {!Object} {filename, mime, base64, rows}
       */
      handler: (payload, session) => Reports.players(payload, session)
    },

    'report.teams': {
      auth: ['ADMIN', 'ORGANISER'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
       * @return {!Object} {filename, mime, base64, rows}
       */
      handler: (payload, session) => Reports.teams(payload, session)
    },

    'report.auction': {
      auth: ['ADMIN', 'ORGANISER'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
       * @return {!Object} {filename, mime, base64, rows}
       */
      handler: (payload, session) => Reports.auction(payload, session)
    },

    'report.final': {
      auth: ['ADMIN', 'ORGANISER'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId}
       * @param {!Object} session ADMIN, or ORGANISER scoped to this tournament
       * @return {!Object} {filename, mime, base64, rows}
       */
      handler: (payload, session) => Reports.final(payload, session)
    },

    'dashboard.adminStats': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId} — optional
       * @param {!Object} session ADMIN session
       * @return {!Object} {scope, generated_at, tournaments, totals}
       */
      handler: (payload, session) => Reports.adminStats(payload, session)
    },

    'audit.list': {
      auth: ['ADMIN'],
      methods: ['POST'],
      /**
       * @param {!Object} payload {tournamentId, action, actor, from, to, entityId, page, pageSize}
       * @param {!Object} session ADMIN session
       * @return {!Object} {rows, page, pageSize, total, totalPages, actions}
       */
      handler: (payload, session) => Reports.auditList(payload, session)
    }
  };
}
