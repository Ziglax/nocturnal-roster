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
    
    // 1) compute attendance metrics ({ra, personal, d30, mo3})
    const attendance     = calculateAttendance(raidsData);
    // Empty/truncated raids.json would zero every RA and wipe all RA notes,
    // then mark the ZIP processed (unrecoverable until the next backup): abort.
    if (!Object.keys(attendance.ra).length) {
      Logger.log("No qualifying attendance events in backup — aborting roster update (ZIP not marked processed).");
      return;
    }
    // 2) compute the date of the last DKP gain > 0
    const lastDKPDateMap = calculateLastPositiveDKPDate(playersData);
    // 3) update + complete the roster
    completeRosterFromDiscord(playersData, attendance, lastDKPDateMap);
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
 * ISO-8601 week key (e.g. "2026-W28") for a timestamp, computed on the calendar
 * date in the given timezone. ISO weeks start MONDAY; the week-year is the year
 * of that week's Thursday. Zero-padded so keys sort chronologically as strings.
 */
function isoWeekKey(ms, tz) {
  const parts = Utilities.formatDate(new Date(ms), tz, "yyyy-MM-dd").split("-");
  const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  const dayNum = d.getUTCDay() || 7;            // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);    // shift to this week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

/**
 * Attendance metrics. All are TICK-WEIGHTED ratios over windows of completed
 * ISO weeks (Monday-start, script TZ): metric = player's Tick/Start events /
 * guild's Tick/Start events within the window — so busier weeks weigh more
 * than light ones. The in-progress week is excluded everywhere. Weeks with no
 * guild raids don't exist as buckets and never count against anyone (windows
 * are counted in RAID-weeks, not calendar weeks).
 *
 * Returns { ra, personal, d30, mo3 }, each mapping discordId -> integer percent:
 *  - ra:       guild's last 8 completed raid-weeks, IGNORING the 2 lightest of
 *              them (fewest total events — same weeks dropped for everyone), so
 *              an off-week with a single short raid doesn't skew the ratio.
 *              Shown in the Roster RA column and drives DKP-list eligibility.
 *              Recent recruits ramp up by design (pre-join ticks stay in the
 *              denominator).
 *  - personal: since the player's FIRST recorded attendance — fair to recruits.
 *  - d30:      guild's last 4 completed raid-weeks.
 *  - mo3:      guild's last 12 completed raid-weeks.
 */
function calculateAttendance(raidsData) {
  const tz = Session.getScriptTimeZone();
  const currentWeek = isoWeekKey(Date.now(), tz);
  const isTickOrStart = (c) => c === "Tick" || c === "Start";

  // --- Bucket every qualifying event by ISO week (full history) ---
  const weekTotals = {};       // weekKey -> total qualifying events
  const weekPlayerCounts = {}; // weekKey -> { playerId -> events attended }

  // Memoize week keys per hour bucket: isoWeekKey costs one Utilities.formatDate
  // Java-bridge call, and the full-history scan has ~thousands of events. Safe
  // because Europe/Paris UTC offsets are whole hours, so one hour bucket always
  // maps to a single local calendar date.
  const weekKeyCache = {};
  const weekKeyOf = (ms) => {
    const h = Math.floor(ms / 3600000);
    return weekKeyCache[h] || (weekKeyCache[h] = isoWeekKey(ms, tz));
  };

  for (const raid of raidsData || []) {
    for (const ev of (raid.attendance || [])) {
      const t = Number(ev.date || 0);
      if (!t || !isTickOrStart(String(ev.comment || ""))) continue;

      // Dedup ids within one event (a duplicated id must not count twice) and
      // skip attendee-less events (bot noise that would inflate the denominator).
      const players = Array.isArray(ev.players) ? [...new Set(ev.players.map(String))] : [];
      if (!players.length) continue;

      const wk = weekKeyOf(t);
      if (wk >= currentWeek) continue; // in-progress (or future) week: ignore

      weekTotals[wk] = (weekTotals[wk] || 0) + 1;
      if (!weekPlayerCounts[wk]) weekPlayerCounts[wk] = {};
      for (const pid of players) {
        weekPlayerCounts[wk][pid] = (weekPlayerCounts[wk][pid] || 0) + 1;
      }
    }
  }

  const weeks = Object.keys(weekTotals).sort(); // chronological ("YYYY-Www")
  const ra = {}, personal = {}, d30 = {}, mo3 = {};
  if (!weeks.length) return { ra, personal, d30, mo3 };

  const seen = new Set();
  weeks.forEach(wk => Object.keys(weekPlayerCounts[wk]).forEach(pid => seen.add(pid)));

  // Tick-weighted ratio over a set of week keys, as a floored integer percent.
  // The +1e-9 guards float error: an exact-integer ratio (e.g. 45%) can compute
  // as 44.999999999999994 and floor to 44 — which matters at DKP thresholds.
  const ratio = (pid, wks) => {
    let attended = 0, total = 0;
    for (const wk of wks) {
      attended += (weekPlayerCounts[wk][pid] || 0);
      total += weekTotals[wk];
    }
    return total ? Math.floor((attended / total) * 100 + 1e-9) : 0;
  };

  // ra window: the guild's last 8 completed raid-weeks minus the 2 lightest
  // (fewest total events). Identical for every player; ties resolve to the
  // older week (stable sort), so the result is deterministic.
  const raWindow = weeks.slice(-8);
  const raWeeks = raWindow.length > 2
    ? [...raWindow].sort((a, b) => weekTotals[a] - weekTotals[b]).slice(2)
    : raWindow;

  for (const pid of seen) {
    ra[pid]  = ratio(pid, raWeeks);
    d30[pid] = ratio(pid, weeks.slice(-4));
    mo3[pid] = ratio(pid, weeks.slice(-12));
    // personal: since the player's first recorded raid-week
    const first = weeks.findIndex(wk => (weekPlayerCounts[wk][pid] || 0) > 0);
    personal[pid] = first === -1 ? 0 : ratio(pid, weeks.slice(first));
  }

  return { ra, personal, d30, mo3 };
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

function completeRosterFromDiscord(playersData, attendance, lastDKPDateMap) {
  // Note written on the RA cell (shown as a tooltip in the web roster):
  // per-player attendance metrics complementing the guild-window RA in the cell.
  const buildRaNote = (id) => {
    if (!attendance || attendance.personal == null || attendance.personal[id] == null) return "";
    return "personal RA = " + attendance.personal[id] + "%\n" +
           "30d RA = " + attendance.d30[id] + "%\n" +
           "3mo RA = " + attendance.mo3[id] + "%";
  };
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
    const attPercent = (attendance && attendance.ra && attendance.ra[discordId] != null)
      ? (Number(attendance.ra[discordId]) || 0) : 0;
    const lastTs = (lastDKPDateMap && lastDKPDateMap[discordId]) ? (Number(lastDKPDateMap[discordId]) || 0) : 0;
    const lastDate = lastTs > 0 ? new Date(lastTs) : null;

    rawById[discordId] = {
      displayName: m.displayName, guildRole: m.guildRole, dkp,
      ra: attPercent / 100, raNote: buildRaNote(discordId), lastDate
    };
    activeIds.add(discordId);
  }

  // --- Prepare output columns (2D arrays) ---
  const outName     = new Array(numData);
  const outDKP      = new Array(numData);
  const outRA       = new Array(numData);
  const outRANotes  = new Array(numData);
  const outRole     = new Array(numData);
  const outActivity = new Array(numData);
  const outNotes    = new Array(numData);

  // init with existing values. RA notes start empty: this sync owns them, so
  // rows without a matched member get theirs cleared (no stale metrics).
  for (let i = 0; i < numData; i++) {
    const row = rosterData[i] || [];
    outName[i]     = [row[colName] ?? nameVals[i][0] ?? ""];
    outDKP[i]      = [row[colDKP] ?? ""];
    outRA[i]       = [row[colRA] ?? ""];
    outRANotes[i]  = [""];
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
      outRANotes[idx] = [payload.raNote];
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
  const newRANotes = [];
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
    newRANotes.push([payload.raNote]);
  }

  // --- Batch writes (a few calls instead of thousands) ---
  if (numData > 0) {
    rosterSheet.getRange(dataStart, colName + 1, numData, 1).setValues(outName);
    rosterSheet.getRange(dataStart, colDKP + 1, numData, 1).setValues(outDKP);
    rosterSheet.getRange(dataStart, colRA + 1, numData, 1).setValues(outRA).setNumberFormat("0%");
    rosterSheet.getRange(dataStart, colRA + 1, numData, 1).setNotes(outRANotes);
    rosterSheet.getRange(dataStart, colGuildRole + 1, numData, 1).setValues(outRole);
    rosterSheet.getRange(dataStart, colActivity + 1, numData, 1).setValues(outActivity).setNumberFormat("yy-MM-dd");
    rosterSheet.getRange(dataStart, colName + 1, numData, 1).setNotes(outNotes);
  }

  if (newRows.length) {
    const startRow = rosterSheet.getLastRow() + 1;
    rosterSheet.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
    rosterSheet.getRange(startRow, colRA + 1, newRows.length, 1).setNumberFormat("0%");
    rosterSheet.getRange(startRow, colRA + 1, newRows.length, 1).setNotes(newRANotes);
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
