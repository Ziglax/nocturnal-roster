/**
 * Extracts a Discord ID from a cell note.
 * Expected: "Discord ID: 1234567890"
 */
function parseDiscordIdFromNote(note) {
  const m = String(note || "").match(/Discord\s*ID\s*:\s*(\d+)/i);
  return m ? String(m[1]) : "";
}

/**
 * Adds / updates the "Discord ID: <id>" line in an existing note.
 */
function upsertDiscordIdInNote(existingNote, discordId) {
  const line = `Discord ID: ${discordId}`;
  const n = String(existingNote || "");

  if (!n) return line;

  if (/Discord\s*ID\s*:\s*\d+/i.test(n)) {
    return n.replace(/Discord\s*ID\s*:\s*\d+/i, line);
  }
  return line + "\n" + n;
}

/**
 * Fetches the latest backup ZIP, extracts the JSON files and updates the roster.
 *
 * Normal mode (force = false or undefined):
 *  - skips a ZIP already present in PROCESSED_ZIP_FILES
 *  - marks the ZIP as processed on success
 *
 * Forced mode (force = true):
 *  - completely ignores the PROCESSED_ZIP_FILES check
 *  - does NOT mark the ZIP as processed (useful for testing)
 */
function parseLatestRaidDataAndUpdateRoster(force) {
  const latest = getLatestBackupFile();
  if (!latest) {
    Logger.log("No ZIP file found in the folder.");
    return;
  }
  const latestName = latest.getName();
  const props      = PropertiesService.getScriptProperties();
  const processedStr = props.getProperty('PROCESSED_ZIP_FILES') || "";
  const done         = processedStr.split(',').filter(Boolean);

  const forced = force === true;

  if (!forced && done.includes(latestName)) {
    Logger.log(`${latestName} already processed (normal mode, no reprocessing).`);
    return;
  } else if (forced) {
    Logger.log(`${latestName} will be processed in FORCE MODE (ignoring history).`);
  }

  try {
    const backup = readBackup(latest);
    if (!backup) {
      Logger.log("players.json or raids.json not found.");
      return;
    }
    const { playersData, raidsData } = backup;
    
    // 1) compute attendance
    const attendanceMap  = calculateAttendance(raidsData);
    // 2) compute the date of the last DKP gain > 0
    const lastDKPDateMap = calculateLastPositiveDKPDate(playersData);
    // 3) update + complete the roster
    completeRosterFromDiscord(playersData, attendanceMap, lastDKPDateMap);
    // 4) update the stats
    updateRaidSummary(playersData, raidsData);
    // 5) rebuild the cache so visitors see the new data immediately
    rebuildRosterCache();

    // mark as processed ONLY in normal mode
    if (!forced) {
      done.push(latestName);
      props.setProperty('PROCESSED_ZIP_FILES', done.join(','));
      Logger.log("Processing done (normal mode, ZIP marked processed): " + latestName);
    } else {
      Logger.log("Processing done in FORCE MODE (ZIP NOT marked processed): " + latestName);
    }
  }
  catch(e) {
    Logger.log("ZIP processing error: " + e.message);
  }
}


/**
 * Attendance = average of a player's best 8 weeks among the last 10 weeks.
 * A "week" is grouped by ISO-like week key (YYYY-Www) in the script's timezone.
 * For each week: % = player_week_ticks / total_week_ticks.
 * Then take the top 8 weekly % (or fewer if not enough weeks) and average them.
 */
function calculateAttendance(raidsData) {
  const tz = Session.getScriptTimeZone();
  const now = Date.now();
  const TEN_WEEKS_MS = 10 * 7 * 24 * 60 * 60 * 1000;
  const windowStart = now - TEN_WEEKS_MS;

  // Per-week totals and per-week per-player counts
  const weekTotals = {};            // weekKey => total qualifying events
  const weekPlayerCounts = {};      // weekKey => { playerId => qualifying events count }

  // Helper: only count "Tick" or "Start"
  const isTickOrStart = (c) => c === "Tick" || c === "Start";

  // Build weekly buckets from the last 10 weeks
  for (const raid of raidsData || []) {
    for (const ev of (raid.attendance || [])) {
      const t = Number(ev.date || 0);
      const c = String(ev.comment || "");
      if (t < windowStart || !isTickOrStart(c)) continue;

      // Week key in script timezone. Uses week-year (YYYY) + week number (ww).
      // This is good enough for bucketing and lexicographic sorting.
      const weekKey = Utilities.formatDate(new Date(t), tz, "YYYY-'W'ww");

      weekTotals[weekKey] = (weekTotals[weekKey] || 0) + 1;

      const players = Array.isArray(ev.players) ? ev.players : [];
      if (!weekPlayerCounts[weekKey]) weekPlayerCounts[weekKey] = {};
      for (const pid of players) {
        const k = String(pid);
        weekPlayerCounts[weekKey][k] = (weekPlayerCounts[weekKey][k] || 0) + 1;
      }
    }
  }

  // Determine the last 10 weeks we actually saw ticks for
  const allWeeksSorted = Object.keys(weekTotals).sort();         // lexicographic works with "YYYY-Www"
  const lastWeeks = allWeeksSorted.slice(-10);

  // If there are no weeks, everybody is 0
  if (lastWeeks.length === 0) return {};

  // Collect player IDs that appeared at least once
  const seenPlayers = new Set();
  for (const wk of lastWeeks) {
    const map = weekPlayerCounts[wk] || {};
    Object.keys(map).forEach(pid => seenPlayers.add(pid));
  }

  const attendanceMap = {}; // pid => integer %

  // For each seen player, compute weekly %s, pick best 8, average
  for (const pid of seenPlayers) {
    const weeklyPercents = [];
    for (const wk of lastWeeks) {
      const total = weekTotals[wk] || 0;
      if (total === 0) continue; // should not happen because we built lastWeeks from totals>0
      const playerCount = (weekPlayerCounts[wk] && weekPlayerCounts[wk][pid]) ? weekPlayerCounts[wk][pid] : 0;
      weeklyPercents.push((playerCount / total) * 100);
    }

    // If we somehow have no data points, mark 0
    if (weeklyPercents.length === 0) {
      attendanceMap[pid] = 0;
      continue;
    }

    // Take the best 8 (or fewer if not enough weeks)
    weeklyPercents.sort((a, b) => b - a);
    const top = weeklyPercents.slice(0, 8);
    const avg = top.reduce((s, v) => s + v, 0) / top.length;

    attendanceMap[pid] = Math.floor(avg);
  }

  return attendanceMap;
}


/**
 * For each player, finds the date (ms) of their last log entry
 * where dkp > 0. If no gain, stays at 0.
 */
function calculateLastPositiveDKPDate(playersData) {
  const lastMap = {};
  playersData.forEach(player => {
    let last = 0;
    (player.log || []).forEach(entry => {
      if (entry.dkp > 0 && entry.date > last) {
        last = entry.date;
      }
    });
    lastMap[player.player] = last;
  });
  return lastMap;
}


/**
 * Builds/updates the "Raid Summary" sheet (incremental + batch).
 * Columns: raid name | date | duration | nb players | DKP gained | DKP spent | DKP delta | Average DKP gain per person
 *  - date      = DD-MM-YYYY
 *  - duration  = minutes (via tickDuration if available, otherwise first/last Tick diff)
 *  - gained    = Σ (tick value × player count) for Start & Tick
 *  - spent     = Σ absolute spend of players PRESENT at the raid
 *
 * Incremental: we remember the RaidIDs already added (ScriptProperties -> RAID_SUMMARY_DONE_IDS)
 */
function updateRaidSummary(playersData, raidsData) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = CONFIG.SHEETS.RAID_SUMMARY;
  const headers = ['raid name','date','duration','nb players','DKP gained','DKP spent','DKP delta','Avg DKP/person'];
  let sh = ss.getSheetByName(sheetName);
  if (!sh) {
    sh = ss.insertSheet(sheetName);
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else {
    // Ensure the header is correct (without rewriting the content)
    sh.getRange(1,1,1,headers.length).setValues([headers]);
  }

  const props = PropertiesService.getScriptProperties();
  const KEY = 'RAID_SUMMARY_DONE_IDS';
  let doneIds = [];
  try { doneIds = JSON.parse(props.getProperty(KEY) || '[]'); } catch(_) {}
  const doneSet = new Set(doneIds);

  // Target: new raids only
  const targetRaids = [];
  for (const raid of raidsData || []) {
    const rid = String(raid && raid._id || '');
    if (!rid || doneSet.has(rid) || !Array.isArray(raid.attendance)) continue;
    targetRaids.push(raid);
  }
  if (targetRaids.length === 0) return; // nothing new

  const tz = Session.getScriptTimeZone();
  const fmtDate = (ms) => ms ? Utilities.formatDate(new Date(ms), tz, 'dd-MM-yyyy') : '';

  // ——— 1) Presence / Earned / Duration (minutes) per raid ———
  const present = {};            // rid -> Set(pid)
  const earned = {};             // rid -> number
  const durationMin = {};        // rid -> minutes
  const raidName = {};           // rid -> string
  const raidDateStr = {};        // rid -> string DD-MM-YYYY

  for (const raid of targetRaids) {
    const rid = String(raid._id);
    raidName[rid] = String(raid.name || '');
    const dateForCol = raid.date || (raid.attendance.length ? raid.attendance[0].date : null);
    raidDateStr[rid] = fmtDate(dateForCol);

    const set = new Set();
    let e = 0;
    let numTicks = 0;
    let firstTickTime = null;
    let lastTickTime = null;
    const tickMs = (typeof raid.tickDuration === 'number' && raid.tickDuration > 0) ? raid.tickDuration : null;

    for (const ev of raid.attendance) {
      const players = Array.isArray(ev.players) ? ev.players : [];
      for (const pid of players) set.add(String(pid));

      const c = String(ev.comment || '');
      const t = Number(ev.date || 0);
      if (c === 'Tick') {
        numTicks++;
        if (t) {
          if (firstTickTime === null || t < firstTickTime) firstTickTime = t;
          if (lastTickTime === null || t > lastTickTime) lastTickTime = t;
        }
      }

      if (c === 'Tick' || c === 'Start') {
        const tickVal = (typeof ev.dkps === 'number') ? ev.dkps
                      : (typeof raid.dkpsPerTick === 'number') ? raid.dkpsPerTick
                      : 0;
        e += tickVal * players.length;
      }
    }

    const minutes = (tickMs && numTicks)
      ? Math.round((numTicks * tickMs) / 60000)
      : (firstTickTime && lastTickTime && lastTickTime >= firstTickTime)
        ? Math.max(1, Math.round((lastTickTime - firstTickTime) / 60000))
        : 0;

    present[rid] = set;
    earned[rid] = e;
    durationMin[rid] = minutes;
  }

  // ——— 2) Spend per raid (single pass over playersData) ———
  const targetIds = new Set(targetRaids.map(r => String(r._id)));
  const spent = {}; // rid -> number
  for (const p of playersData || []) {
    const pid = String(p && p.player || '');
    for (const lg of (p && p.log) || []) {
      const delta = Number(lg.dkp || 0);
      if (delta >= 0) continue; // spend only
      const r = lg.raid || {};
      const rid = String(r._id || '');
      if (!rid || !targetIds.has(rid)) continue;
      const set = present[rid];
      if (set && set.has(pid)) {
        spent[rid] = (spent[rid] || 0) + Math.abs(delta);
      }
    }
  }

  // ——— 3) Batch-write only the new rows ———
  const rows = [];
  for (const raid of targetRaids) {
    const rid = String(raid._id);
    const nb = present[rid] ? present[rid].size : 0;
    const g = earned[rid] || 0;
    const s = spent[rid] || 0;
    const delta = g - s;
    const avg = nb ? Math.floor(g / nb) : 0;
    rows.push([
      raidName[rid] || '',
      raidDateStr[rid] || '',
      durationMin[rid] || 0,
      nb,
      g,
      s,
      delta,
      avg
    ]);
    doneSet.add(rid);
  }

  if (rows.length) {
    const startRow = Math.max(2, sh.getLastRow() + 1);
    sh.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
  }

  props.setProperty(KEY, JSON.stringify(Array.from(doneSet)));

  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);
}

function completeRosterFromDiscord(playersData, attendanceMap, lastDKPDateMap) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rosterSheet = ss.getSheetByName(CONFIG.SHEETS.ROSTER);
  const rawSheet    = ss.getSheetByName(CONFIG.SHEETS.RAW_DISCORD);
  if (!rosterSheet || !rawSheet) return;

  // --- Find header + columns ---
  const all = rosterSheet.getDataRange().getValues();
  let headerRowIndex = -1;
  for (let i = 0; i < all.length; i++) {
    if (String(all[i][0] || "").trim() === "Discord profile") { headerRowIndex = i; break; }
  }
  if (headerRowIndex === -1) return;

  const headers      = all[headerRowIndex];
  const colName      = headers.indexOf("Discord profile");
  const colDKP       = headers.indexOf("DKP");
  const colRA        = headers.indexOf("RA");
  const colGuildRole = headers.indexOf("Guild Role");
  const colActivity  = headers.indexOf("Activity");
  if ([colName,colDKP,colRA,colGuildRole,colActivity].some(x => x < 0)) return;

  const headerRow1 = headerRowIndex + 1;
  const dataStart  = headerRow1 + 1;
  const lastRow    = rosterSheet.getLastRow();
  const lastCol    = rosterSheet.getLastColumn();
  const numData    = Math.max(0, lastRow - headerRow1);


  // --- Read roster in batch (values + colName notes) ---
  const dataRange = numData > 0 ? rosterSheet.getRange(dataStart, 1, numData, lastCol) : null;
  const rosterData = dataRange ? dataRange.getValues() : [];
  const nameRange  = numData > 0 ? rosterSheet.getRange(dataStart, colName + 1, numData, 1) : null;
  const nameNotes  = nameRange ? nameRange.getNotes() : [];
  const nameVals   = nameRange ? nameRange.getValues() : [];

  // index: discordId -> row idx (0-based in rosterData), fallback: name -> idx
  const idToIdx = {};
  const nameToIdx = {};
  for (let i = 0; i < numData; i++) {
    const nm = String(nameVals[i][0] || "").trim();
    if (!nm) continue;
    const did = parseDiscordIdFromNote(nameNotes[i][0] || "");
    if (did) idToIdx[did] = i;
    else nameToIdx[nm] = i;
  }

  // --- Pre-index playersData (DKP) ---
  const currentById = {};
  for (const p of (playersData || [])) {
    const pid = String(p && p.player || "").trim();
    if (!pid) continue;
    currentById[pid] = (p && typeof p.current === "number") ? p.current : 0;
  }

  // --- Build Raw map (discordId -> payload) ---
  const members = parseRawDiscordMembers(rawSheet);
  if (!members) return;

  const rawById = {};
  const activeIds = new Set();

  for (const m of members) {
    const discordId = m.discordId;
    const dkp = currentById[discordId] || 0;
    const attPercent = (attendanceMap && attendanceMap[discordId] != null) ? (Number(attendanceMap[discordId]) || 0) : 0;
    const lastTs = (lastDKPDateMap && lastDKPDateMap[discordId]) ? (Number(lastDKPDateMap[discordId]) || 0) : 0;
    const lastDate = lastTs > 0 ? new Date(lastTs) : null;

    rawById[discordId] = { displayName: m.displayName, guildRole: m.guildRole, dkp, ra: attPercent / 100, lastDate };
    activeIds.add(discordId);
  }

  // --- Prepare output columns (2D arrays) ---
  const outName     = new Array(numData);
  const outDKP      = new Array(numData);
  const outRA       = new Array(numData);
  const outRole     = new Array(numData);
  const outActivity = new Array(numData);
  const outNotes    = new Array(numData);

  // init with existing values
  for (let i = 0; i < numData; i++) {
    const row = rosterData[i] || [];
    outName[i]     = [row[colName] ?? nameVals[i][0] ?? ""];
    outDKP[i]      = [row[colDKP] ?? ""];
    outRA[i]       = [row[colRA] ?? ""];
    outRole[i]     = [row[colGuildRole] ?? ""];
    outActivity[i] = [row[colActivity] ?? ""];
    outNotes[i]    = [nameNotes[i] ? nameNotes[i][0] : ""];
  }

  // --- Apply updates (match by ID first, fallback by name if note missing) ---
  const seen = new Set();

  for (const discordId in rawById) {
    const payload = rawById[discordId];
    let idx = (idToIdx[discordId] != null) ? idToIdx[discordId] : null;

    if (idx == null) {
      const fallbackIdx = nameToIdx[payload.displayName];
      if (fallbackIdx != null) idx = fallbackIdx;
    }

    if (idx != null) {
      outName[idx] = [payload.displayName];
      outDKP[idx]  = [payload.dkp];
      outRA[idx]   = [payload.ra];
      outRole[idx] = [payload.guildRole];
      outActivity[idx] = [payload.lastDate || ""];
      outNotes[idx] = [upsertDiscordIdInNote(outNotes[idx][0], discordId)];
      seen.add(discordId);
    }
  }

  // --- Mark Left (by ID when possible) ---
  for (let i = 0; i < numData; i++) {
    const did = parseDiscordIdFromNote(outNotes[i][0]);
    if (did && !activeIds.has(did)) {
      outRA[i]   = [0];
      outRole[i] = ["Left"];
    }
  }

  // --- New members -> append in one block ---
  const newRows = [];
  const newNotes = [];
  for (const discordId in rawById) {
    if (seen.has(discordId)) continue;
    const payload = rawById[discordId];
    const rowValues = new Array(headers.length).fill("");
    rowValues[colName]      = payload.displayName;
    rowValues[colDKP]       = payload.dkp;
    rowValues[colRA]        = payload.ra;
    rowValues[colGuildRole] = payload.guildRole;
    rowValues[colActivity]  = payload.lastDate || "";
    newRows.push(rowValues);
    newNotes.push([`Discord ID: ${discordId}`]);
  }

  // --- Batch writes (a few calls instead of thousands) ---
  if (numData > 0) {
    rosterSheet.getRange(dataStart, colName + 1, numData, 1).setValues(outName);
    rosterSheet.getRange(dataStart, colDKP + 1, numData, 1).setValues(outDKP);
    rosterSheet.getRange(dataStart, colRA + 1, numData, 1).setValues(outRA).setNumberFormat("0%");
    rosterSheet.getRange(dataStart, colGuildRole + 1, numData, 1).setValues(outRole);
    rosterSheet.getRange(dataStart, colActivity + 1, numData, 1).setValues(outActivity).setNumberFormat("yy-MM-dd");
    rosterSheet.getRange(dataStart, colName + 1, numData, 1).setNotes(outNotes);
  }

  if (newRows.length) {
    const startRow = rosterSheet.getLastRow() + 1;
    rosterSheet.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
    rosterSheet.getRange(startRow, colRA + 1, newRows.length, 1).setNumberFormat("0%");
    rosterSheet.getRange(startRow, colActivity + 1, newRows.length, 1).setNumberFormat("yy-MM-dd");
    rosterSheet.getRange(startRow, colName + 1, newRows.length, 1).setNotes(newNotes);
  }

  // Sort (optional, but OK)
  const finalLastRow = rosterSheet.getLastRow();
  const finalNumData = Math.max(0, finalLastRow - headerRow1);
  if (finalNumData > 0) {
    rosterSheet.getRange(dataStart, 1, finalNumData, lastCol).sort([
      { column: colRA + 1,       ascending: false },
      { column: colActivity + 1, ascending: false },
      { column: colDKP + 1,      ascending: false }
    ]);
  }
}

/**
 * (Optional) Resets the summary:
 * - deletes the "Raid Summary" sheet
 * - clears the list of RaidIDs already added
 */
function resetRaidSummary(){
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CONFIG.SHEETS.RAID_SUMMARY);
  if (sh) ss.deleteSheet(sh);
  PropertiesService.getScriptProperties().deleteProperty('RAID_SUMMARY_DONE_IDS');
}

/**
 * Manual / test version that forces reprocessing of the latest ZIP
 * regardless of PROCESSED_ZIP_FILES.
 */
function parseLatestRaidDataAndUpdateRoster_Force() {
  parseLatestRaidDataAndUpdateRoster(true);
}
