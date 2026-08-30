/**
 * Repo.gs — the ONLY file in this project allowed to touch SpreadsheetApp.
 * CONTRACTS.md §5. Every other module goes through these functions.
 *
 * Design notes that are easy to get wrong:
 *  - Apps Script charges per Spreadsheet call, not per cell. So every function
 *    here reads or writes a whole rectangle in one shot. Never loop getRange.
 *  - Globals are re-created on every execution, so the caches below are
 *    per-execution only. That is exactly what we want: fresh data each request,
 *    no repeated openById inside a single request.
 *  - `_row` is the 1-based sheet row. Row 1 is the header, so the first data
 *    row is 2. It is attached to every object returned from a read so callers
 *    can write back without searching again.
 */
const Repo = {

  /** Per-execution handle cache. Reset automatically between executions. */
  _cache: { ss: null, tz: null, sheets: {}, fields: {} },

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * The container-bound spreadsheet, opened at most once per execution.
   * @return {Spreadsheet} the active spreadsheet
   */
  _ss() {
    if (!Repo._cache.ss) {
      Repo._cache.ss = SpreadsheetApp.getActiveSpreadsheet();
    }
    return Repo._cache.ss;
  },

  /**
   * Spreadsheet time zone, used to decide whether a Date cell is date-only.
   * @return {string} an Olson time zone id, e.g. "Asia/Kolkata"
   */
  _tz() {
    if (!Repo._cache.tz) {
      Repo._cache.tz = Repo._ss().getSpreadsheetTimeZone() || 'UTC';
    }
    return Repo._cache.tz;
  },

  /**
   * A sheet by tab name, cached for the execution.
   * @param {string} tab tab name, must be a key of HEADERS
   * @return {Sheet} the sheet
   */
  _sheet(tab) {
    const hit = Repo._cache.sheets[tab];
    if (hit) return hit;
    const sh = Repo._ss().getSheetByName(tab);
    if (!sh) {
      throw Util.AppError(ERR.INTERNAL_ERROR,
        'The sheet tab "' + tab + '" is missing. Run setup() once to create it.');
    }
    Repo._cache.sheets[tab] = sh;
    return sh;
  },

  /**
   * Header array for a tab. Header strings are the object keys, verbatim.
   * @param {string} tab tab name
   * @return {string[]} column headers in binding order
   */
  _headers(tab) {
    const h = (typeof HEADERS !== 'undefined') ? HEADERS[tab] : null;
    if (!h || !h.length) {
      throw Util.AppError(ERR.INTERNAL_ERROR,
        'No HEADERS defined for the tab "' + tab + '".');
    }
    return h;
  },

  /**
   * Resolve a tab name from the SHEETS constant, falling back to the literal
   * name in CONTRACTS §4 if the constant is not loaded or is keyed differently.
   * @param {string} key key in SHEETS, e.g. "TOURNAMENTS"
   * @param {string} literal literal tab name, e.g. "Tournaments"
   * @return {string} tab name
   */
  _tab(key, literal) {
    return (typeof SHEETS !== 'undefined' && SHEETS[key]) ? SHEETS[key] : literal;
  },

  /**
   * Normalise a field-list constant into a lookup set for one tab.
   * BOOLEAN_FIELDS / NUMERIC_FIELDS may be either a flat array of field names
   * (they are unique across the schema) or an object keyed by tab name. Both
   * shapes are accepted so Config.gs is free to use either.
   * @param {Array|Object} spec the constant
   * @param {string} tab tab name
   * @return {Object} map of fieldName -> true
   */
  _fieldSet(spec, tab) {
    const out = {};
    if (!spec) return out;
    const list = Array.isArray(spec) ? spec : spec[tab];
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) out[list[i]] = true;
    }
    return out;
  },

  /**
   * Cached boolean/numeric field sets for a tab.
   * @param {string} tab tab name
   * @return {{bool: Object, num: Object}} lookup sets
   */
  _typing(tab) {
    let t = Repo._cache.fields[tab];
    if (!t) {
      t = {
        bool: Repo._fieldSet(typeof BOOLEAN_FIELDS !== 'undefined' ? BOOLEAN_FIELDS : null, tab),
        num: Repo._fieldSet(typeof NUMERIC_FIELDS !== 'undefined' ? NUMERIC_FIELDS : null, tab)
      };
      Repo._cache.fields[tab] = t;
    }
    return t;
  },

  /**
   * Sheets stores booleans as the literal strings TRUE / FALSE (CONTRACTS §4).
   * Anything blank counts as false.
   * @param {*} v raw cell value
   * @return {boolean} the boolean
   */
  _toBool(v) {
    if (v === true || v === false) return v;
    if (v === null || v === undefined) return false;
    if (typeof v === 'number') return v !== 0;
    return String(v).trim().toUpperCase() === 'TRUE';
  },

  /**
   * Numeric coercion. An empty cell is null, NOT 0 — "no purse recorded" and
   * "a purse of zero" are different facts and callers must be able to tell.
   * @param {*} v raw cell value
   * @return {number|null} the number, or null when blank/unparseable
   */
  _toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    if (v instanceof Date) return v.getTime();
    const n = Number(String(v).trim().replace(/,/g, ''));
    return isNaN(n) ? null : n;
  },

  /**
   * Sheets sometimes auto-parses an ISO string into a Date cell. Convert it
   * back to a string so the rest of the system only ever sees ISO-8601 text.
   * A cell at exact local midnight is treated as date-only (dob, start_date).
   * @param {Date} d the date cell
   * @return {string} ISO-8601 date or date-time
   */
  _dateToIso(d) {
    const tz = Repo._tz();
    if (Utilities.formatDate(d, tz, 'HH:mm:ss.SSS') === '00:00:00.000') {
      return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    }
    return d.toISOString();
  },

  /**
   * Turn one raw sheet row into a typed object.
   * @param {Array} row raw cell values
   * @param {string[]} headers column headers
   * @param {{bool: Object, num: Object}} typing field type sets
   * @param {number} rowNumber 1-based sheet row
   * @return {Object} the row object with _row attached
   */
  _mapRow(row, headers, typing, rowNumber) {
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      let v = row[c];
      if (typing.bool[key]) {
        v = Repo._toBool(v);
      } else if (typing.num[key]) {
        v = Repo._toNum(v);
      } else if (v instanceof Date) {
        v = Repo._dateToIso(v);
      }
      obj[key] = v;
    }
    obj._row = rowNumber;
    return obj;
  },

  /**
   * Turn an object into a raw row array in header order. Missing columns
   * become '' so the written rectangle is always full width.
   * @param {Object} obj source object
   * @param {string[]} headers column headers
   * @return {Array} raw cell values
   */
  _toRow(obj, headers) {
    const row = new Array(headers.length);
    for (let c = 0; c < headers.length; c++) {
      const v = obj[headers[c]];
      if (v === null || v === undefined) {
        row[c] = '';
      } else if (typeof v === 'boolean') {
        row[c] = v ? 'TRUE' : 'FALSE';
      } else if (v instanceof Date) {
        row[c] = v.toISOString();
      } else if (typeof v === 'object') {
        // json columns (photo_file_ids, audit prev/new) arrive as objects
        row[c] = JSON.stringify(v);
      } else {
        row[c] = v;
      }
    }
    return row;
  },

  /**
   * Loose comparison used by findBy / filterBy. Everything is compared as a
   * trimmed string, so 5 matches "5". Case matters, except for booleans, where
   * true and the stored "TRUE" must match.
   * @param {*} cell value from the sheet
   * @param {*} wanted value from the caller
   * @return {boolean} whether they match
   */
  _looseEq(cell, wanted) {
    if (typeof cell === 'boolean' || typeof wanted === 'boolean') {
      return Repo._toBool(cell) === Repo._toBool(wanted);
    }
    const a = (cell === null || cell === undefined) ? '' : String(cell).trim();
    const b = (wanted === null || wanted === undefined) ? '' : String(wanted).trim();
    return a === b;
  },

  /**
   * Grow the grid if a write would land past the last physical row.
   * @param {Sheet} sh the sheet
   * @param {number} lastNeededRow highest row number about to be written
   * @return {void}
   */
  _ensureRows(sh, lastNeededRow) {
    const max = sh.getMaxRows();
    if (lastNeededRow > max) sh.insertRowsAfter(max, lastNeededRow - max);
  },

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /**
   * Read every data row of a tab in a single getValues() call.
   * @param {string} tab tab name
   * @return {Object[]} row objects, [] when the tab holds only its header row
   */
  readAll(tab) {
    const sh = Repo._sheet(tab);
    const headers = Repo._headers(tab);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return [];
    const values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const typing = Repo._typing(tab);
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      out[i] = Repo._mapRow(values[i], headers, typing, i + 2);
    }
    return out;
  },

  /**
   * First row whose field loosely equals value.
   * @param {string} tab tab name
   * @param {string} field column header
   * @param {*} value value to match
   * @return {Object|null} the row object, or null when nothing matches
   */
  findBy(tab, field, value) {
    const rows = Repo.readAll(tab);
    for (let i = 0; i < rows.length; i++) {
      if (Repo._looseEq(rows[i][field], value)) return rows[i];
    }
    return null;
  },

  /**
   * All rows matching every key of criteria (AND).
   * @param {string} tab tab name
   * @param {Object} criteria map of column header -> value; empty means all
   * @return {Object[]} matching row objects
   */
  filterBy(tab, criteria) {
    const rows = Repo.readAll(tab);
    if (!criteria) return rows;
    const keys = Object.keys(criteria);
    if (!keys.length) return rows;
    return rows.filter((r) => {
      for (let k = 0; k < keys.length; k++) {
        if (!Repo._looseEq(r[keys[k]], criteria[keys[k]])) return false;
      }
      return true;
    });
  },

  /**
   * How many rows match the criteria.
   * @param {string} tab tab name
   * @param {Object} criteria map of column header -> value
   * @return {number} the count
   */
  count(tab, criteria) {
    return Repo.filterBy(tab, criteria).length;
  },

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  /**
   * Append one row. Missing columns are filled with ''.
   * @param {string} tab tab name
   * @param {Object} obj the row to write
   * @return {Object} the same object with _row set to the new sheet row
   */
  append(tab, obj) {
    return Repo.appendMany(tab, [obj])[0];
  },

  /**
   * Append many rows in a single setValues() call.
   * @param {string} tab tab name
   * @param {Object[]} objs the rows to write
   * @return {Object[]} the objects with _row set
   */
  appendMany(tab, objs) {
    if (!objs || !objs.length) return [];
    const sh = Repo._sheet(tab);
    const headers = Repo._headers(tab);
    const rows = objs.map((o) => Repo._toRow(o, headers));
    const start = Math.max(sh.getLastRow(), 1) + 1;
    Repo._ensureRows(sh, start + rows.length - 1);
    sh.getRange(start, 1, rows.length, headers.length).setValues(rows);
    for (let i = 0; i < objs.length; i++) objs[i]._row = start + i;
    return objs;
  },

  /**
   * Merge a patch into an existing row and write the whole row back as one
   * contiguous range. Keys not present in HEADERS are ignored.
   * @param {string} tab tab name
   * @param {number} rowNumber 1-based sheet row (as returned in _row)
   * @param {Object} patch fields to change
   * @return {Object} the merged row object
   */
  updateRow(tab, rowNumber, patch) {
    const sh = Repo._sheet(tab);
    const headers = Repo._headers(tab);
    if (!(rowNumber >= 2)) {
      throw Util.AppError(ERR.INTERNAL_ERROR,
        'Refusing to update row ' + rowNumber + ' of "' + tab + '" — row 1 is the header.');
    }
    const range = sh.getRange(rowNumber, 1, 1, headers.length);
    const existing = Repo._mapRow(range.getValues()[0], headers, Repo._typing(tab), rowNumber);
    const merged = existing;
    if (patch) {
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c];
        if (Object.prototype.hasOwnProperty.call(patch, key)) merged[key] = patch[key];
      }
    }
    range.setValues([Repo._toRow(merged, headers)]);
    merged._row = rowNumber;
    return merged;
  },

  /**
   * Find a row by field then patch it.
   * @param {string} tab tab name
   * @param {string} field column header to match on
   * @param {*} value value to match
   * @param {Object} patch fields to change
   * @return {Object|null} the merged row object, or null when nothing matched
   */
  updateBy(tab, field, value, patch) {
    const found = Repo.findBy(tab, field, value);
    if (!found) return null;
    return Repo.updateRow(tab, found._row, patch);
  },

  /**
   * Delete a sheet row. Every _row captured earlier in this execution below
   * this point becomes stale, so re-read before further writes.
   * @param {string} tab tab name
   * @param {number} rowNumber 1-based sheet row
   * @return {void}
   */
  deleteRow(tab, rowNumber) {
    if (!(rowNumber >= 2)) {
      throw Util.AppError(ERR.INTERNAL_ERROR,
        'Refusing to delete row ' + rowNumber + ' of "' + tab + '" — row 1 is the header.');
    }
    Repo._sheet(tab).deleteRow(rowNumber);
  },

  /**
   * Hand out the next player serial number for a tournament and increment the
   * stored counter.
   *
   * WARNING: THE CALLER MUST ALREADY HOLD THE SCRIPT LOCK (Repo.withLock).
   * THIS FUNCTION DOES NOT LOCK. Read-then-write without a lock will hand the
   * same serial to two simultaneous registrations. See DESIGN.md §6.2.
   *
   * @param {string} tournamentId the tournament
   * @return {number} the serial to use for this player
   */
  nextSerial(tournamentId) {
    const tab = Repo._tab('TOURNAMENTS', 'Tournaments');
    const t = Repo.findBy(tab, 'tournament_id', tournamentId);
    if (!t) {
      throw Util.AppError(ERR.NOT_FOUND, 'That tournament no longer exists.');
    }
    const current = Util.toInt(t.next_serial, 1) || 1;
    Repo.updateRow(tab, t._row, { next_serial: current + 1 });
    return current;
  },

  // ---------------------------------------------------------------------
  // Lock and flush
  // ---------------------------------------------------------------------

  /**
   * Run fn inside the script lock. The lock is always released, even when fn
   * throws, and fn's exception propagates unchanged.
   * @param {function():*} fn the critical section
   * @param {number} [waitMs] how long to wait for the lock, default DEFAULTS.lock_wait_ms
   * @return {*} whatever fn returns
   */
  withLock(fn, waitMs) {
    const wait = waitMs ||
      ((typeof DEFAULTS !== 'undefined' && DEFAULTS.lock_wait_ms) ? DEFAULTS.lock_wait_ms : 20000);
    const lock = LockService.getScriptLock();
    let held = false;
    try {
      // waitLock returns undefined and throws on timeout; some hosts return a
      // boolean instead. Treat anything that is not an explicit false as held.
      held = lock.waitLock(wait) !== false;
    } catch (e) {
      held = false;
    }
    if (!held) {
      throw Util.AppError(ERR.SYSTEM_BUSY, 'The system is busy. Please try again in a moment.');
    }
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Force pending Spreadsheet writes out before releasing the lock.
   * @return {void}
   */
  flush() {
    SpreadsheetApp.flush();
  },

  // ---------------------------------------------------------------------
  // Setup support — used only by Setup.gs, which may not call SpreadsheetApp
  // itself (CONTRACTS §5 keeps every Spreadsheet call inside this file).
  // ---------------------------------------------------------------------

  /**
   * Tab names that physically exist in the spreadsheet.
   * @return {string[]} sheet names
   */
  listTabs() {
    return Repo._ss().getSheets().map((s) => s.getName());
  },

  /**
   * Create a tab if it is missing, then always rewrite row 1 from HEADERS and
   * freeze it. Data rows are never touched, so this is safe to re-run after a
   * schema change.
   * @param {string} tab tab name
   * @return {{tab: string, created: boolean, columnsAdded: number}} what happened
   */
  ensureTab(tab) {
    const headers = Repo._headers(tab);
    const ss = Repo._ss();
    let sh = ss.getSheetByName(tab);
    let created = false;
    if (!sh) {
      sh = ss.insertSheet(tab);
      created = true;
    }
    let columnsAdded = 0;
    const maxCols = sh.getMaxColumns();
    if (maxCols < headers.length) {
      columnsAdded = headers.length - maxCols;
      sh.insertColumnsAfter(maxCols, columnsAdded);
    }
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    Repo._cache.sheets[tab] = sh;
    return { tab: tab, created: created, columnsAdded: columnsAdded };
  },

  /**
   * Clear every data row (row 2 down) of a tab, keeping the header.
   * @param {string} tab tab name
   * @return {number} how many rows were cleared
   */
  clearDataRows(tab) {
    const sh = Repo._sheet(tab);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return 0;
    sh.getRange(2, 1, lastRow - 1, sh.getMaxColumns()).clearContent();
    return lastRow - 1;
  }
};
