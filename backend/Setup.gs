/**
 * Setup.gs — one-time and recovery operations (CONTRACTS.md §13).
 *
 * These are run by hand from the Apps Script editor, not from the web API.
 * They are deliberately bare global functions so they appear in the editor's
 * "Run" dropdown; internals live on the SetupUtil object below.
 *
 * This file never calls SpreadsheetApp directly — CONTRACTS §5 keeps every
 * Spreadsheet call inside Repo.gs, so tab creation goes through
 * Repo.ensureTab / Repo.clearDataRows.
 */

const SetupUtil = {

  /**
   * The Config tab name.
   * @return {string} tab name
   */
  configTab() {
    return (typeof SHEETS !== 'undefined' && SHEETS.CONFIG) ? SHEETS.CONFIG : 'Config';
  },

  /**
   * Resolve a tab name from SHEETS, falling back to the literal in CONTRACTS §4.
   * @param {string} key key in SHEETS, e.g. "USERS"
   * @param {string} literal literal tab name, e.g. "Users"
   * @return {string} tab name
   */
  tab(key, literal) {
    return (typeof SHEETS !== 'undefined' && SHEETS[key]) ? SHEETS[key] : literal;
  },

  /**
   * Every tab this project owns, in the order Config.gs declares them.
   * Falls back to the HEADERS keys if SHEETS is unavailable.
   * @return {string[]} tab names
   */
  allTabs() {
    if (typeof SHEETS !== 'undefined' && SHEETS) {
      return Object.keys(SHEETS).map((k) => SHEETS[k]);
    }
    return Object.keys(typeof HEADERS !== 'undefined' ? HEADERS : {});
  },

  /**
   * A value from the DEFAULTS constant, or a fallback when Config.gs does not
   * declare it. Keeps setup() runnable even if DEFAULTS drifts.
   * @param {string} key the DEFAULTS key
   * @param {*} fallback value to use when absent
   * @return {*} the value
   */
  def(key, fallback) {
    if (typeof DEFAULTS !== 'undefined' && DEFAULTS && DEFAULTS[key] !== undefined && DEFAULTS[key] !== null) {
      return DEFAULTS[key];
    }
    return fallback;
  },

  /**
   * An enum value. Every value in this schema equals its own key name, so the
   * key is a safe fallback if ENUM is shaped differently than expected.
   * @param {string} group enum group, e.g. "USER_ROLE"
   * @param {string} name value name, e.g. "ADMIN"
   * @return {string} the enum value
   */
  enumVal(group, name) {
    const g = (typeof ENUM !== 'undefined' && ENUM) ? ENUM[group] : null;
    if (g && !Array.isArray(g) && g[name]) return g[name];
    return name;
  },

  /**
   * Read one key from the Config tab.
   * @param {string} key config key
   * @return {string|null} the value, or null when the key is not present
   */
  readConfig(key) {
    const row = Repo.findBy(SetupUtil.configTab(), 'key', key);
    return row ? row.value : null;
  },

  /**
   * The seed values for the Config tab. Computed lazily inside setup() so
   * nothing runs at file load time.
   * @return {Array<{key: string, value: string}>} key/value pairs
   */
  configSeeds() {
    return [
      // TEST by default. Tests.gs and resetTestData() both refuse to run
      // unless this says TEST, so a live sheet must be switched to PROD.
      { key: 'env', value: String(SetupUtil.def('env', 'TEST')) },
      { key: 'max_image_bytes', value: String(SetupUtil.def('max_image_bytes', 5242880)) },
      { key: 'poll_interval_ms', value: String(SetupUtil.def('poll_interval_ms', 2000)) },
      { key: 'session_hours', value: String(SetupUtil.def('session_hours', 12)) },
      { key: 'lock_wait_ms', value: String(SetupUtil.def('lock_wait_ms', 20000)) }
    ];
  }
};

/**
 * Build or repair the spreadsheet. Safe to run any number of times: a tab is
 * created only when missing, the header row is always rewritten (so a schema
 * change is just a re-run), and data rows are never touched.
 *
 * @return {Object} a summary of what was created versus already present
 */
function setup() {
  const tabs = SetupUtil.allTabs();
  const report = {
    tabs_created: [],
    tabs_existing: [],
    tabs_skipped: [],
    columns_added: {},
    config_added: [],
    config_existing: [],
    pepper_generated: false,
    drive_root_id: null
  };

  tabs.forEach((tab) => {
    if (typeof HEADERS === 'undefined' || !HEADERS[tab]) {
      report.tabs_skipped.push(tab);
      return;
    }
    const r = Repo.ensureTab(tab);
    if (r.created) {
      report.tabs_created.push(tab);
    } else {
      report.tabs_existing.push(tab);
    }
    if (r.columnsAdded) report.columns_added[tab] = r.columnsAdded;
  });

  // --- Config keys -----------------------------------------------------
  const configTab = SetupUtil.configTab();
  const now = Util.nowIso();
  const present = {};
  Repo.readAll(configTab).forEach((r) => { present[String(r.key).trim()] = true; });

  const toAppend = [];
  SetupUtil.configSeeds().forEach((seed) => {
    if (present[seed.key]) {
      report.config_existing.push(seed.key);
    } else {
      toAppend.push({ key: seed.key, value: seed.value, updated_at: now });
      report.config_added.push(seed.key);
    }
  });

  // The pepper is generated exactly once. Overwriting it would invalidate
  // every password hash already stored in Users.
  if (present.pepper) {
    report.config_existing.push('pepper');
  } else {
    toAppend.push({ key: 'pepper', value: Util.randomToken(32), updated_at: now });
    report.config_added.push('pepper');
    report.pepper_generated = true;
  }

  if (toAppend.length) Repo.appendMany(configTab, toAppend);

  // --- Drive root ------------------------------------------------------
  // Drive.gs owns folder creation and is idempotent itself.
  try {
    report.drive_root_id = Drive.ensureRootFolder();
  } catch (e) {
    report.drive_root_id = null;
    console.error('setup(): could not create the Drive root folder: ' + e);
  }

  Repo.flush();

  console.log('setup() complete.');
  console.log('  tabs created  : ' + (report.tabs_created.join(', ') || '(none, all existed)'));
  console.log('  tabs existing : ' + (report.tabs_existing.join(', ') || '(none)'));
  if (report.tabs_skipped.length) {
    console.log('  tabs SKIPPED  : ' + report.tabs_skipped.join(', ') + '  (no HEADERS entry)');
  }
  if (Object.keys(report.columns_added).length) {
    console.log('  columns added : ' + JSON.stringify(report.columns_added));
  }
  console.log('  headers rewritten on every tab, row 1 frozen, data rows untouched.');
  console.log('  config added  : ' + (report.config_added.join(', ') || '(none)'));
  console.log('  config kept   : ' + (report.config_existing.join(', ') || '(none)'));
  console.log('  pepper        : ' + (report.pepper_generated ? 'GENERATED (first run)' : 'already present, left alone'));
  console.log('  drive root    : ' + (report.drive_root_id || 'FAILED — see the error above'));
  console.log('  env is "' + (SetupUtil.readConfig('env') || '?') + '". Set it to PROD on the live sheet before going live.');

  return report;
}

/**
 * Create the very first ADMIN user. Refuses to run if any ADMIN already
 * exists — creating admin accounts is an ordinary API operation once one
 * admin can log in, and a second bootstrap path is a privilege-escalation
 * hole waiting to happen.
 *
 * The password is never logged and never stored in plain text.
 *
 * @param {string} email login email, stored lowercased
 * @param {string} displayName name shown in the UI
 * @param {string} password plain text password, hashed immediately
 * @return {Object} the created user without password_hash or salt
 */
function seedAdmin(email, displayName, password) {
  const usersTab = SetupUtil.tab('USERS', 'Users');
  const ADMIN = SetupUtil.enumVal('USER_ROLE', 'ADMIN');
  const ACTIVE = SetupUtil.enumVal('USER_STATUS', 'ACTIVE');

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || cleanEmail.indexOf('@') < 1) {
    throw Util.AppError(ERR.VALIDATION_FAILED, 'Please give a valid email address for the admin.');
  }
  if (!String(displayName || '').trim()) {
    throw Util.AppError(ERR.VALIDATION_FAILED, 'Please give a display name for the admin.');
  }
  if (!password || String(password).length < 10) {
    throw Util.AppError(ERR.VALIDATION_FAILED, 'The admin password must be at least 10 characters long.');
  }

  const users = Repo.readAll(usersTab);
  const existingAdmin = users.filter((u) => String(u.role).trim() === ADMIN);
  if (existingAdmin.length) {
    throw Util.AppError(ERR.FORBIDDEN,
      'An admin already exists (' + existingAdmin[0].email + '). ' +
      'Create further admins through the app, not seedAdmin().');
  }
  if (users.some((u) => String(u.email).trim().toLowerCase() === cleanEmail)) {
    throw Util.AppError(ERR.VALIDATION_FAILED, 'A user with the email ' + cleanEmail + ' already exists.');
  }

  const pepper = SetupUtil.readConfig('pepper');
  if (!pepper) {
    throw Util.AppError(ERR.INTERNAL_ERROR, 'No pepper in the Config tab. Run setup() first.');
  }

  const salt = Util.randomToken(16);
  const now = Util.nowIso();
  const user = {
    user_id: Util.uid(ID_PREFIX.USER),
    email: cleanEmail,
    display_name: String(displayName).trim(),
    password_hash: Util.hashPassword(String(password), salt, pepper),
    salt: salt,
    role: ADMIN,
    tournament_id: '',   // admins are not scoped to one tournament
    status: ACTIVE,
    created_at: now,
    created_by: 'SETUP',
    last_login_at: ''
  };

  Repo.append(usersTab, user);
  Repo.flush();

  console.log('seedAdmin(): created admin ' + user.user_id + ' <' + user.email + '>.');
  return {
    user_id: user.user_id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    status: user.status
  };
}

/**
 * Wipe every data row from every tab except Config.
 *
 * Refuses to run unless the Config key `env` is exactly "TEST". This guard is
 * a safety requirement: there is no undo, and running it against a live
 * tournament would destroy the auction record.
 *
 * @return {Object} how many rows were cleared per tab
 */
function resetTestData() {
  const env = String(SetupUtil.readConfig('env') || '').trim();
  if (env !== 'TEST') {
    throw Util.AppError(ERR.FORBIDDEN,
      'resetTestData() refused to run: Config env is "' + env + '", not "TEST". ' +
      'This would have deleted live tournament data.');
  }

  const configTab = SetupUtil.configTab();
  const cleared = {};
  let total = 0;

  SetupUtil.allTabs().forEach((tab) => {
    if (tab === configTab) return;                 // keeps env and the pepper
    if (typeof HEADERS === 'undefined' || !HEADERS[tab]) return;
    const n = Repo.clearDataRows(tab);
    cleared[tab] = n;
    total += n;
  });

  Repo.flush();
  console.log('resetTestData(): cleared ' + total + ' rows. ' + JSON.stringify(cleared));
  console.log('  Config tab left intact. Cached versions and snapshots are not cleared here.');
  return { env: env, rows_cleared: total, per_tab: cleared };
}

/**
 * Recompute every team's purse_used and players_count from the AuctionResults
 * rows that are current and SOLD, and write the corrected figures back.
 *
 * Teams.purse_used and Teams.players_count are caches (DESIGN §2.5). This is
 * the recovery tool for when they drift — for example after a crash between
 * the AuctionResults write and the Teams write. It runs inside the auction
 * lock so it cannot race a live sale.
 *
 * @param {string} tournamentId the tournament to rebuild
 * @return {Object} a report of every value that changed
 */
function rebuildCounters(tournamentId) {
  if (!String(tournamentId || '').trim()) {
    throw Util.AppError(ERR.VALIDATION_FAILED, 'rebuildCounters() needs a tournament_id.');
  }

  const teamsTab = SetupUtil.tab('TEAMS', 'Teams');
  const resultsTab = SetupUtil.tab('AUCTION_RESULTS', 'AuctionResults');
  const SOLD = SetupUtil.enumVal('RESULT_STATUS', 'SOLD');

  return Repo.withLock(() => {
    const results = Repo.filterBy(resultsTab, {
      tournament_id: tournamentId,
      is_current: true,
      status: SOLD
    });

    const tally = {};
    const orphanTeamIds = [];
    results.forEach((r) => {
      const tid = String(r.team_id || '').trim();
      if (!tid) {
        // A current SOLD row with no team is a data fault, not a counter drift.
        orphanTeamIds.push('(blank team_id on ' + r.auction_id + ')');
        return;
      }
      if (!tally[tid]) tally[tid] = { spent: 0, players: 0 };
      tally[tid].spent += Util.toInt(r.amount, 0);
      tally[tid].players += 1;
    });

    const teams = Repo.filterBy(teamsTab, { tournament_id: tournamentId });
    const known = {};
    teams.forEach((t) => { known[String(t.team_id).trim()] = true; });
    Object.keys(tally).forEach((tid) => {
      if (!known[tid]) orphanTeamIds.push(tid);
    });

    const changes = [];
    teams.forEach((t) => {
      const t2 = tally[String(t.team_id).trim()] || { spent: 0, players: 0 };
      const wasPurse = Util.toInt(t.purse_used, 0);
      const wasCount = Util.toInt(t.players_count, 0);
      if (wasPurse === t2.spent && wasCount === t2.players) return;
      Repo.updateRow(teamsTab, t._row, { purse_used: t2.spent, players_count: t2.players });
      changes.push({
        team_id: t.team_id,
        team_name: t.team_name,
        purse_used: { from: wasPurse, to: t2.spent },
        players_count: { from: wasCount, to: t2.players }
      });
    });

    Repo.flush();

    const report = {
      tournament_id: tournamentId,
      sold_rows_counted: results.length,
      teams_checked: teams.length,
      teams_changed: changes.length,
      changes: changes,
      orphan_team_ids: orphanTeamIds
    };

    console.log('rebuildCounters(' + tournamentId + '): ' + results.length + ' current SOLD rows, ' +
      teams.length + ' teams, ' + changes.length + ' corrected.');
    changes.forEach((c) => {
      console.log('  ' + c.team_name + ' (' + c.team_id + '): purse_used ' +
        c.purse_used.from + ' -> ' + c.purse_used.to + ', players_count ' +
        c.players_count.from + ' -> ' + c.players_count.to);
    });
    if (orphanTeamIds.length) {
      console.error('  SOLD rows point at teams that do not exist: ' + orphanTeamIds.join(', '));
    }

    return report;
  });
}
