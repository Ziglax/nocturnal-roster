/**
 * Extracts a table from the latest dump (latest ZIP):
 * Discord ID | Discord name | Role | DKP | RA | ticks since X | total ticks
 *
 * X in "yy-MM-dd" format (e.g. "25-12-01")
 */
function exportRosterStatsFromLatestDump() {
  // ====== PARAMS ======
  const OUTPUT_SHEET_NAME = CONFIG.SHEETS.TICK_STATS;
  const SINCE_YY_MM_DD = "26-02-25"; // <-- X here
  // ====================

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName(CONFIG.SHEETS.RAW_DISCORD);
  if (!rawSheet) {
    Logger.log("Sheet 'Raw Discord Data' not found.");
    return;
  }

  // --- Parse date X -> ms (midnight, script TZ) ---
  const dm = String(SINCE_YY_MM_DD || "").match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!dm) {
    Logger.log(`Invalid date format: "${SINCE_YY_MM_DD}", expected "yy-MM-dd"`);
    return;
  }
  const sinceMs = new Date(2000 + Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0, 0).getTime();

  // --- 1) Load the latest ZIP (players.json + raids.json) ---
  const latest = getLatestBackupFile();
  if (!latest) {
    Logger.log("No ZIP found in the backup folder.");
    return;
  }
  const latestZipName = latest.getName();

  let playersData, raidsData;
  try {
    const backup = readBackup(latest);
    if (!backup) {
      Logger.log("players.json or raids.json not found in ZIP: " + latestZipName);
      return;
    }
    playersData = backup.playersData;
    raidsData   = backup.raidsData;
  } catch (e) {
    Logger.log("ZIP read error: " + e.message);
    return;
  }

  // --- 2) DKP + RA (reuses the existing function) ---
  const currentById = {};
  for (const p of (playersData || [])) {
    const pid = String(p && p.player || "").trim();
    if (!pid) continue;
    currentById[pid] = (p && typeof p.current === "number") ? p.current : 0;
  }

  const attendanceMap = calculateAttendance(raidsData); // pid -> integer %

  // --- 3) Total ticks + since X (Start+Tick) ---
  const ticksTotalById = {};
  const ticksSinceById = {};
  for (const raid of (raidsData || [])) {
    for (const ev of (raid.attendance || [])) {
      const c = String(ev && ev.comment || "");
      if (c !== "Tick" && c !== "Start") continue;

      const t = Number(ev && ev.date || 0);
      const isSince = t >= sinceMs;
      const players = Array.isArray(ev && ev.players) ? ev.players : [];

      for (const pidRaw of players) {
        const pid = String(pidRaw);
        ticksTotalById[pid] = (ticksTotalById[pid] || 0) + 1;
        if (isSince) ticksSinceById[pid] = (ticksSinceById[pid] || 0) + 1;
      }
    }
  }

  // --- 4) Read Raw Discord Data and filter/pick a role ---
  const members = parseRawDiscordMembers(rawSheet);
  if (!members) {
    Logger.log("Raw Discord Data empty or required columns missing.");
    return;
  }

  const rows = [];
  rows.push([
    "Discord ID",
    "Discord name",
    "Role",
    "DKP",
    "RA",
    `raid ticks since ${SINCE_YY_MM_DD}`,
    "total raid ticks"
  ]);

  for (const m of members) {
    const discordId = m.discordId;
    const dkp = currentById[discordId] || 0;

    const raPercentInt = (attendanceMap && attendanceMap[discordId] != null)
      ? (Number(attendanceMap[discordId]) || 0)
      : 0;

    const raFraction = raPercentInt / 100;
    const ticksSince = ticksSinceById[discordId] || 0;
    const ticksTotal = ticksTotalById[discordId] || 0;

    rows.push([discordId, m.displayName, m.guildRole, dkp, raFraction, ticksSince, ticksTotal]);
  }

  // --- 5) Write output sheet ---
  let out = ss.getSheetByName(OUTPUT_SHEET_NAME);
  if (!out) out = ss.insertSheet(OUTPUT_SHEET_NAME);

  out.clearContents();
  out.getRange(1, 1, rows.length, rows[0].length).setValues(rows);

  out.setFrozenRows(1);
  out.getRange(1, 1, 1, rows[0].length).setFontWeight("bold");
  if (rows.length > 1) {
    out.getRange(2, 4, rows.length - 1, 1).setNumberFormat("0");   // DKP
    out.getRange(2, 5, rows.length - 1, 1).setNumberFormat("0%");  // RA
    out.getRange(2, 6, rows.length - 1, 2).setNumberFormat("0");   // ticks
  }
  out.autoResizeColumns(1, rows[0].length);

  Logger.log(`Export done -> "${OUTPUT_SHEET_NAME}" (${rows.length - 1} rows). ZIP: ${latestZipName}`);
}
