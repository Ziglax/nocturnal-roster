// --- CACHE CONFIG ---
// CacheService caps each value at 100 KB. The roster payload is ~100 KB (right at
// the limit), so we split it into chunks to never hit that cap.
var CACHE_TTL = 600;        // cache lifetime (10 min)
var CACHE_CHUNK = 90000;    // chunk size (< 100 KB, margin for multi-byte chars)

/** Stores the roster JSON in the cache, split into chunks. */
function cachePutRoster(jsonString) {
  var cache = CacheService.getScriptCache();
  var entries = {};
  var n = 0;
  for (var i = 0; i < jsonString.length; i += CACHE_CHUNK) {
    entries['ROSTER_CHUNK_' + n] = jsonString.substring(i, i + CACHE_CHUNK);
    n++;
  }
  entries['ROSTER_NCHUNKS'] = String(n);
  cache.putAll(entries, CACHE_TTL);
}

/** Reads the roster JSON back from the cache. Returns null if absent/incomplete. */
function cacheGetRoster() {
  var cache = CacheService.getScriptCache();
  var nStr = cache.get('ROSTER_NCHUNKS');
  if (!nStr) return null;
  var n = parseInt(nStr, 10);
  if (!n) return null;

  var keys = [];
  for (var i = 0; i < n; i++) keys.push('ROSTER_CHUNK_' + i);
  var map = cache.getAll(keys);

  var out = '';
  for (var j = 0; j < n; j++) {
    var part = map['ROSTER_CHUNK_' + j];
    if (part == null) return null;   // a chunk is missing -> clean MISS
    out += part;
  }
  return out;
}

/**
 * Serves the web application.
 * Acts as a router: returns JSON if requested via ?mode=json,
 * otherwise returns the HTML UI.
 */
function doGet(e) {
  // Check if the URL parameter "mode" is set to "json"
  // Example: .../exec?mode=json
  if (e && e.parameter && e.parameter.mode === 'json') {
    try {
      // --- CACHE OPTIMIZATION (CacheService, chunked) ---
      // Avoids re-reading the Spreadsheet on every request (~3-4s -> ~100ms).

      var debug = e.parameter.debug === '1';
      var t0 = Date.now();
      var cachedJSON = cacheGetRoster();
      var jsonString, meta;

      if (cachedJSON != null) {
        jsonString = cachedJSON;
        meta = { cache: "HIT", bytes: cachedJSON.length, totalMs: Date.now() - t0 };
      } else {
        var data = getRosterData();
        jsonString = JSON.stringify(data);
        var readMs = Date.now() - t0;
        var put;
        try {
          cachePutRoster(jsonString);
          put = "stored";
        } catch (cacheError) {
          put = "FAILED:" + cacheError.toString();
        }
        meta = { cache: "MISS", bytes: jsonString.length, readMs: readMs, put: put };
      }

      // When ?debug=1 is passed, inject diagnostic into the JSON response so it's visible
      // in the Network tab even when Apps Script logs are unavailable.
      if (debug) {
        jsonString = jsonString.slice(0, -1) + ',"_meta":' + JSON.stringify(meta) + '}';
      }

      return ContentService.createTextOutput(jsonString)
        .setMimeType(ContentService.MimeType.JSON);
      
    } catch (err) {
      // MAJOR ERROR HANDLER (e.g., missing tab, permissions...)
      // Return error as JSON to avoid "NetworkError" (CORS) on external site.
      return ContentService.createTextOutput(JSON.stringify({ 
        error: "Server Error", 
        details: err.toString() 
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Default behavior: Return the HTML interface
  // Example: .../exec
  return HtmlService.createTemplateFromFile('index')
      .evaluate()
      .setTitle('Nocturnal Roster')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Removes the "Discord ID: <id>" line(s) from a note, leaving everything else
 * (AA:, Access:, etc.) intact. The ID stays in the sheet — we only hide it from the payload.
 */
function stripDiscordIdLine(note) {
  var n = String(note || '');
  if (!n) return '';
  return n.split('\n')
          .filter(function (line) { return !/^\s*Discord\s*ID\s*:\s*\d+\s*$/i.test(line); })
          .join('\n')
          .trim();
}

/**
 * Fetches and formats data from the "Roster" sheet.
 */
function getRosterData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.ROSTER);
  if (!sheet) throw new Error("Tab 'Roster' not found.");

  // Optimized last row detection
  var lastRow = sheet.getLastRow();
  var realLastRow = 5;
  if (lastRow > 5) {
    // Read only column A to find the real end of data
    var valuesA = sheet.getRange("A1:A" + lastRow).getValues();
    for (var i = valuesA.length - 1; i >= 0; i--) {
      if (valuesA[i][0] !== "" && valuesA[i][0] != null) {
        realLastRow = i + 1;
        break;
      }
    }
  }
  if (realLastRow < 5) realLastRow = 5;

  var lastCol = sheet.getLastColumn();
  if (lastCol > 30) lastCol = 30;

  // Optimized global fetch (1 single Spreadsheet call)
  var range = sheet.getRange(1, 1, realLastRow, lastCol);

  // Header heights (Rows 1-5 only)
  var headerHeights = [];
  for (var r = 1; r <= 5; r++) {
    headerHeights.push(sheet.getRowHeight(r));
  }

  // Per-cell link URLs (covers both =HYPERLINK() formulas and manually inserted links).
  // null when the cell has no link.
  var richTexts = range.getRichTextValues();
  var links = richTexts.map(function (row) {
    return row.map(function (rt) {
      return (rt && typeof rt.getLinkUrl === 'function') ? rt.getLinkUrl() : null;
    });
  });
  richTexts = null; // free the (heavy) RichText objects before reading styles

  // Style dictionary: replace 8 formatting matrices with a small dict + per-cell index.
  // Most cells share <30 distinct style combos -> massive payload reduction (target <100KB
  // so the result fits in CacheService).
  var bgs = range.getBackgrounds();
  var fcs = range.getFontColors();
  var fws = range.getFontWeights();
  var fss = range.getFontStyles();
  var fls = range.getFontLines();
  var fszs = range.getFontSizes();
  var has = range.getHorizontalAlignments();
  var vas = range.getVerticalAlignments();

  var styleDict = [];
  var styleMap = {}; // composite key -> index
  var styleIndex = [];
  for (var r = 0; r < bgs.length; r++) {
    var rowIdx = [];
    for (var c = 0; c < bgs[r].length; c++) {
      var key = bgs[r][c] + "|" + fcs[r][c] + "|" + fws[r][c] + "|" + fss[r][c]
              + "|" + fls[r][c] + "|" + fszs[r][c] + "|" + has[r][c] + "|" + vas[r][c];
      var idx = styleMap[key];
      if (idx === undefined) {
        idx = styleDict.length;
        styleMap[key] = idx;
        styleDict.push({
          bg: bgs[r][c], fc: fcs[r][c], fw: fws[r][c], fs: fss[r][c],
          fl: fls[r][c], sz: fszs[r][c], ha: has[r][c], va: vas[r][c]
        });
      }
      rowIdx.push(idx);
    }
    styleIndex.push(rowIdx);
  }

  // Free the 8 style matrices before reading values/notes: lowers the peak
  // memory that can trigger the "INTERNAL" error.
  bgs = fcs = fws = fss = fls = fszs = has = vas = null;

  // Notes (tooltips). We hide the "Discord ID: ..." line: it must not be sent
  // to the frontend (it stays intact in the sheet).
  var notes = range.getNotes().map(function (row) {
    return row.map(stripDiscordIdLine);
  });

  return {
    values: range.getDisplayValues(),
    notes: notes,
    links: links,
    styleDict: styleDict,
    styleIndex: styleIndex,
    headerHeights: headerHeights
  };
}

/**
 * Rebuilds the cache unconditionally: reads the sheet, stores the JSON, and records
 * the sheet's last-modified time. Called after an import, and by warmRosterCache when
 * the sheet has actually changed.
 */
function rebuildRosterCache() {
  cachePutRoster(JSON.stringify(getRosterData()));
  var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var modified = DriveApp.getFileById(ssId).getLastUpdated().getTime();
  PropertiesService.getScriptProperties().setProperty('ROSTER_LAST_BUILT', String(modified));
}

/**
 * Keep-warm: called by a time-based trigger every minute so visitors always get a
 * cache HIT (~100ms) instead of a spreadsheet read or a cold start.
 * Only does the heavy read when the sheet changed since the last build: getLastUpdated()
 * is one cheap Drive call vs the ~11 reads of getRosterData, and the roster changes only
 * a few times a day, so most ticks just extend the TTL of the cache already stored.
 */
function warmRosterCache() {
  // Prevents two refreshes from running at once: a slow or stuck run
  // (DEADLINE_EXCEEDED) no longer makes the following runs fail in cascade.
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return; // a refresh is already running -> skip this tick
  try {
    var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    var modified = DriveApp.getFileById(ssId).getLastUpdated().getTime();
    var lastBuilt = Number(PropertiesService.getScriptProperties().getProperty('ROSTER_LAST_BUILT') || 0);
    var cached = cacheGetRoster();

    if (modified > lastBuilt || cached == null) {
      rebuildRosterCache();      // real change (or cache gone) -> heavy read
    } else {
      cachePutRoster(cached);    // nothing changed -> just extend the cache TTL
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Run ONCE by hand (Run menu) to install the keep-warm trigger.
 * Safe to re-run: it first deletes any existing trigger.
 */
function installWarmTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'warmRosterCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('warmRosterCache').timeBased().everyMinutes(1).create();
}