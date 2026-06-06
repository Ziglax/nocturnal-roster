// --- SHARED HELPERS ---
// Functions reused by more than one file (DKPupdate.js, tickStats.js).

/**
 * Finds the most recent backup ZIP in the Drive folder (by the backup_<timestamp>
 * in its name). Returns the Drive File, or null if there is none.
 * "Find" is split from "read" so callers can check the file name (e.g. dedup against
 * already-processed ZIPs) before paying for the unzip.
 */
function getLatestBackupFile() {
  const folder = DriveApp.getFolderById(CONFIG.BACKUP_FOLDER_ID);
  const files = folder.getFiles();
  const zipFiles = [];
  while (files.hasNext()) {
    const f = files.next();
    if (String(f.getName() || "").toLowerCase().endsWith(".zip")) zipFiles.push(f);
  }
  if (!zipFiles.length) return null;

  zipFiles.sort((a, b) => {
    const ts = (name) => {
      const m = String(name || "").match(/backup_(\d{14})/);
      return m ? m[1] : "00000000000000";
    };
    return ts(b.getName()).localeCompare(ts(a.getName()));
  });
  return zipFiles[0];
}

/**
 * Unzips a backup File and parses players.json + raids.json.
 * Returns { playersData, raidsData } or null if either JSON is missing.
 */
function readBackup(file) {
  const blobs = Utilities.unzip(file.getBlob().setContentType("application/zip"));
  let playersBlob = null, raidsBlob = null;
  for (const b of blobs) {
    const n = String(b.getName() || "").toLowerCase();
    if (n.includes("players.json")) playersBlob = b;
    if (n.includes("raids.json")) raidsBlob = b;
  }
  if (!playersBlob || !raidsBlob) return null;
  return {
    playersData: JSON.parse(playersBlob.getDataAsString()),
    raidsData: JSON.parse(raidsBlob.getDataAsString()),
  };
}

/**
 * Reads the "Raw Discord Data" sheet and returns the guild members:
 * [{ discordId, displayName, guildRole }]. Skips bots, rows without an ID/name, and
 * members whose roles contain none of CONFIG.RANK_PRIORITY. guildRole is the
 * highest-priority rank found.
 * Returns null if the sheet is empty or its required columns are missing (so callers
 * can abort instead of treating it as "no members").
 */
function parseRawDiscordMembers(rawSheet) {
  const raw = rawSheet.getDataRange().getValues();
  if (raw.length < 2) return null;

  const h = raw[0];
  const idxId = h.indexOf("ID");
  const idxDisplay = h.indexOf("Display Name");
  const idxRoles = h.indexOf("Roles");
  const idxUserType = h.indexOf("User Type");
  if (idxId < 0 || idxDisplay < 0 || idxRoles < 0) return null;

  const members = [];
  for (let r = 1; r < raw.length; r++) {
    const row = raw[r];
    const userType = idxUserType >= 0 ? String(row[idxUserType] || "").trim() : "";
    if (userType === "Bot") continue;

    const discordId = String(row[idxId] || "").trim();
    const displayName = String(row[idxDisplay] || "").trim();
    if (!discordId || !displayName) continue;

    let rolesStr = String(row[idxRoles] || "").replace(/^\[/, "").replace(/\]$/, "");
    const roles = rolesStr.split(",").map(x => x.trim()).filter(Boolean);
    if (!roles.length) continue;

    let guildRole = "";
    for (const rp of CONFIG.RANK_PRIORITY) {
      if (roles.indexOf(rp) !== -1) { guildRole = rp; break; }
    }
    if (!guildRole) continue;

    members.push({ discordId, displayName, guildRole });
  }
  return members;
}
