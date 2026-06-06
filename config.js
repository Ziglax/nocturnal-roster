// --- SHARED CONFIG ---
// Single source of truth for IDs, sheet names and thresholds used across files.
// In Apps Script every file shares one global scope, so CONFIG is visible everywhere.
const CONFIG = {
  // Drive folder holding the backup ZIPs (players.json + raids.json).
  BACKUP_FOLDER_ID: "1OFEYgw_cD-65WiEUkK6DB6j0l2GUxbHT",

  // Spreadsheet tab names.
  SHEETS: {
    ROSTER: "Roster",
    RAW_DISCORD: "Raw Discord Data",
    DKP_LISTS: "DKP Lists",
    RAID_SUMMARY: "Raid Summary",
    ROSTER_INFO: "Roster info",
    TICK_STATS: "Roster tick stats",
  },

  // Guild ranks, highest priority first (used to pick a member's displayed role).
  RANK_PRIORITY: ["Guild Leader", "Officer", "Raider", "Recruit", "Member"],

  // Minimum raid attendance (fraction) to be eligible on the DKP lists, per status.
  MIN_RA: { M: 0.20, M2: 0.40 },
};
