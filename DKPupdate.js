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
 * Attendance metrics. All are TICK-WEIGHTED ratios over windows of ISO weeks
 * (Monday-start, script TZ): metric = player's Tick/Start events / guild's
 * Tick/Start events within the window — so busier weeks weigh more than light
 * ones. The IN-PROGRESS week counts as it fills, so RA moves day by day: its
 * influence stays proportional to the ticks already raided, and the worst-week
 * forgiveness (ties drop the heavier week) absorbs the haven't-raided-yet case
 * for regulars. Weeks with no guild raids don't exist as buckets and never
 * count against anyone (windows are counted in RAID-weeks, not calendar weeks).
 *
 * Returns { ra, d30 }, each mapping discordId -> integer percent:
 *  - ra:  "raid RA" over ALL guild ticks of the last 10 raid-weeks (the
 *         in-progress week included, weighted by its ticks so far). New
 *         joiners ramp up as they accumulate ticks — intended; 30d RA offers
 *         the short-term view. The player's 2 worst weeks are forgiven
 *         ("best 8 of 10"). Shown in the Roster RA column; drives DKP-list
 *         eligibility.
 *  - d30: plain ratio (no drop) of attended vs total guild events since
 *         day -30 exactly — or since the player's first tick if they joined
 *         more recently. Day-precise timestamps, no week bucketing.
 */
function calculateAttendance(raidsData) {
  const tz = Session.getScriptTimeZone();
  const now = Date.now();
  const currentWeek = isoWeekKey(now, tz);
  const isTickOrStart = (c) => c === "Tick" || c === "Start";

  // --- Bucket every qualifying event by ISO week (full history) ---
  const weekTotals = {};       // weekKey -> total qualifying events
  const weekPlayerCounts = {}; // weekKey -> { playerId -> events attended }
  // Day-precise accumulators for 30d RA (that metric ignores week bucketing).
  const d30Start = now - 30 * 86400000;
  const firstSeen = {};        // playerId -> earliest qualifying event timestamp
  const recentEvents = [];     // qualifying events of the last 30 days

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
      if (wk > currentWeek) continue; // future-dated noise: ignore

      for (const pid of players) {
        if (firstSeen[pid] === undefined || t < firstSeen[pid]) firstSeen[pid] = t;
      }
      if (t >= d30Start && t <= now) recentEvents.push({ t, players: new Set(players) });

      weekTotals[wk] = (weekTotals[wk] || 0) + 1;
      if (!weekPlayerCounts[wk]) weekPlayerCounts[wk] = {};
      for (const pid of players) {
        weekPlayerCounts[wk][pid] = (weekPlayerCounts[wk][pid] || 0) + 1;
      }
    }
  }

  const weeks = Object.keys(weekTotals).sort(); // chronological ("YYYY-Www")
  const ra = {}, d30 = {};
  if (!weeks.length) return { ra, d30 };

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

  // "raid RA" over ALL guild ticks of the last n raid-weeks — the same window
  // for everyone: a new joiner ramps up as they accumulate ticks (intended;
  // 30d RA offers the short-term perspective). The player's 2 WORST weeks are
  // forgiven ("best 8 of 10"): lowest weekly % first; on ties the heavier week
  // (more total ticks) is dropped, which favors the player and stays
  // deterministic. (The length guard only avoids degenerate data.)
  const raidRa = (pid, n) => {
    let wks = weeks.slice(-n);
    if (wks.length > 2) {
      const weeklyPct = (wk) => (weekPlayerCounts[wk][pid] || 0) / weekTotals[wk];
      const dropped = new Set(
        [...wks].sort((a, b) => (weeklyPct(a) - weeklyPct(b)) || (weekTotals[b] - weekTotals[a])).slice(0, 2)
      );
      wks = wks.filter(wk => !dropped.has(wk));
    }
    return ratio(pid, wks);
  };

  for (const pid of seen) {
    ra[pid] = raidRa(pid, 10);

    // d30: day-precise ratio — attended vs total guild events since day -30,
    // or since the player's first tick if they joined more recently.
    const from = Math.max(firstSeen[pid], d30Start);
    let attended = 0, total = 0;
    for (const ev of recentEvents) {
      if (ev.t < from) continue;
      total++;
      if (ev.players.has(pid)) attended++;
    }
    d30[pid] = total ? Math.floor((attended / total) * 100 + 1e-9) : 0;
  }

  return { ra, d30 };
}


/**
 * Lifetime DKP stats per player, from the bot's full log:
 *  - earned: sum of all positive log entries
 *  - spent:  sum of |negative| log entries
 *  - topBid: the single most expensive spend { dkp, name, date } — item name
 *            from the auction item, falling back to the log comment for older
 *            entries without an item object; ties resolved to the most recent.
 * Returns { discordId: { earned, spent, topBid | null } }.
 */
function calculateDkpStats(playersData) {
  const stats = {};
  for (const p of (playersData || [])) {
    const pid = String(p && p.player || "").trim();
    if (!pid) continue;
    let earned = 0, spent = 0, top = null;
    for (const lg of (p.log || [])) {
      const dkp = Number(lg.dkp || 0);
      if (dkp > 0) {
        earned += dkp;
      } else if (dkp < 0) {
        const abs = -dkp;
        spent += abs;
        if (!top || abs > top.dkp || (abs === top.dkp && Number(lg.date || 0) > top.date)) {
          top = {
            dkp: abs,
            name: String((lg.item && lg.item.name) || lg.comment || "?"),
            date: Number(lg.date || 0),
          };
        }
      }
    }
    stats[pid] = { earned, spent, topBid: top };
  }
  return stats;
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
    if (!attendance || !attendance.d30 || attendance.d30[id] == null) return "";
    return "30d RA = " + attendance.d30[id] + "%";
  };

  // Note written on the DKP cell: the player's lifetime DKP economy.
  const dkpStats = calculateDkpStats(playersData);
  const buildDkpNote = (id) => {
    const s = dkpStats[id];
    if (!s) return "";
    let note = "Lifetime earned = " + Math.round(s.earned) + " DKP\n" +
               "Lifetime spent = " + Math.round(s.spent) + " DKP";
    if (s.earned > 0) {
      note += "\nSpent/earned = " + Math.floor((s.spent / s.earned) * 100 + 1e-9) + "%";
    }
    if (s.topBid) {
      note += "\nTop bid: " + Math.round(s.topBid.dkp) + " DKP — " + s.topBid.name +
              " (" + Utilities.formatDate(new Date(s.topBid.date), Session.getScriptTimeZone(), "yyyy-MM-dd") + ")";
    }
    return note;
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
      ra: attPercent / 100, raNote: buildRaNote(discordId),
      dkpNote: buildDkpNote(discordId), lastDate
    };
    activeIds.add(discordId);
  }

  // --- Prepare output columns (2D arrays) ---
  const outName     = new Array(numData);
  const outDKP      = new Array(numData);
  const outDKPNotes = new Array(numData);
  const outRA       = new Array(numData);
  const outRANotes  = new Array(numData);
  const outRole     = new Array(numData);
  const outActivity = new Array(numData);
  const outNotes    = new Array(numData);

  // init with existing values. RA/DKP notes start empty: this sync owns them,
  // so rows without a matched member get theirs cleared (no stale metrics).
  for (let i = 0; i < numData; i++) {
    const row = rosterData[i] || [];
    outName[i]     = [row[colName] ?? nameVals[i][0] ?? ""];
    outDKP[i]      = [row[colDKP] ?? ""];
    outDKPNotes[i] = [""];
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
      outDKPNotes[idx] = [payload.dkpNote];
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
  const newDKPNotes = [];
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
    newDKPNotes.push([payload.dkpNote]);
  }

  // --- Batch writes (a few calls instead of thousands) ---
  if (numData > 0) {
    rosterSheet.getRange(dataStart, colName + 1, numData, 1).setValues(outName);
    rosterSheet.getRange(dataStart, colDKP + 1, numData, 1).setValues(outDKP);
    rosterSheet.getRange(dataStart, colDKP + 1, numData, 1).setNotes(outDKPNotes);
    rosterSheet.getRange(dataStart, colRA + 1, numData, 1).setValues(outRA).setNumberFormat("0%");
    rosterSheet.getRange(dataStart, colRA + 1, numData, 1).setNotes(outRANotes);
    rosterSheet.getRange(dataStart, colGuildRole + 1, numData, 1).setValues(outRole);
    rosterSheet.getRange(dataStart, colActivity + 1, numData, 1).setValues(outActivity).setNumberFormat("yy-MM-dd");
    rosterSheet.getRange(dataStart, colName + 1, numData, 1).setNotes(outNotes);
  }

  if (newRows.length) {
    const startRow = rosterSheet.getLastRow() + 1;
    rosterSheet.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
    rosterSheet.getRange(startRow, colDKP + 1, newRows.length, 1).setNotes(newDKPNotes);
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
