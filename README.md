# Nocturnal Roster

Web-based guild roster for an EverQuest guild (Project Quarm–style emulator).
**Google Apps Script backend + a single-file HTML frontend**, fed automatically by the
guild's Discord bot. It renders the live Google Sheet roster (DKP, raid attendance,
characters per class, key access…) as a fast, sortable, dark-themed table.

---

## Architecture

```
Discord bot (roster-bot)
        │  drops backup ZIPs (players.json + raids.json) on Google Drive
        ▼
Google Apps Script  ──reads──►  Google Sheets ("Roster", "Raw Discord Data", …)
        │                              │
        │  doGet(?mode=json)           │  getRosterData() → JSON (cached)
        ▼                              ▼
   index.html  ◄── fetch ──  /exec?mode=json   (hosted on nocturnal-guild.eu/roster/)
```

- **Backend** — Google Apps Script (managed with [clasp](https://github.com/google/clasp)).
- **Frontend** — `index.html`, a self-contained page (HTML + CSS + inline JS). Hosted on
  a normal web server (Apache) and talks to the Apps Script Web App over `fetch`. It also
  works *inside* the Apps Script iframe (`google.script.run`) — see the hybrid loader.
- **Data** — Google Sheets. The roster is read once, serialized to JSON, and cached so
  visitors get a ~100 ms response instead of a multi-second spreadsheet read.

## Data flow

1. `roster-bot` periodically uploads a `backup_<YYYYMMDDHHMMSS>.zip` (containing
   `players.json` + `raids.json`) to a Drive folder.
2. `parseLatestRaidDataAndUpdateRoster()` picks the latest ZIP, computes attendance and
   the last DKP-gain date, and writes everything into the **Roster** sheet
   (`completeRosterFromDiscord`), then appends new raids to **Raid Summary**.
3. The Web App serves the roster as JSON (`doGet?mode=json`), backed by a chunked cache
   kept warm by a 1-minute trigger.
4. `index.html` fetches that JSON and renders the grid (sticky headers, frozen columns,
   per-cell styling, note tooltips, sortable columns).

## Repository layout

| File | Role |
|------|------|
| `code.js` | Web App entry (`doGet`), JSON cache (chunked), `getRosterData()`, keep-warm (`warmRosterCache` / `rebuildRosterCache` / `installWarmTrigger`). |
| `DKPupdate.js` | Import pipeline: `parseLatestRaidDataAndUpdateRoster`, attendance (`calculateAttendance`), `completeRosterFromDiscord`, `updateRaidSummary`, Discord-ID note helpers. |
| `dkpLists.js` | `exportEligibleMainLists` → builds the **DKP Lists** sheet (Casters/Priests/Melee, filtered by RA threshold). |
| `noteParser.js` | `parseRosterNotesToTable` → parses `AA:` / `Access:` cell notes into the **Roster info** sheet; adds the "Roster Tools" menu (`onOpen`). |
| `tickStats.js` | `exportRosterStatsFromLatestDump` → builds the **Roster tick stats** sheet. |
| `config.js` | `CONFIG`: Drive folder ID, sheet names, guild ranks, RA thresholds. Single source of truth. |
| `shared.js` | Helpers shared by the import & exports: `getLatestBackupFile`, `readBackup`, `parseRawDiscordMembers`. |
| `index.html` | Frontend (rendering, sorting, tooltips, hybrid GAS/external loader, localStorage instant render). |
| `appsscript.json` | Apps Script manifest (timezone, OAuth scopes, web app config). |
| `.clasp.json` | clasp project binding (script ID). |

## Key concepts

- **Player identity** — stored in the *cell note* of the Discord-profile column as
  `Discord ID: <id>`. The display name can change; the ID is the stable key (with a
  name-based fallback). The ID is **stripped from the JSON payload** before it reaches the
  frontend (it stays in the sheet).
- **Attendance (RA)** — average of a player's **best 8 of the last 10 weeks** of
  `Tick`/`Start` events.
- **DKP / RA / status** — `M` / `M2` are main-character statuses; `MIN_RA` in `config.js`
  sets the RA needed to appear on the DKP lists.
- **Caching** — `getRosterData()` is serialized and split into <100 KB chunks (CacheService
  per-value limit). A 1-minute trigger keeps the cache warm and **only re-reads the sheet
  when it actually changed** (gated on the spreadsheet's last-modified time), so the heavy
  read runs a few times a day instead of every minute.
- **Instant render** — the frontend caches the last payload in `localStorage` and renders it
  immediately on load, then refreshes silently in the background.

## Setup & deployment

Prerequisites: a Google account, [clasp](https://github.com/google/clasp) installed and
logged in, and the project bound via `.clasp.json` (script ID already set).

```bash
clasp push          # upload the .js + appsscript.json to the Apps Script project
```

Then, in the Apps Script editor:

1. **Install the keep-warm trigger** — run `installWarmTrigger` once (creates a 1-minute
   time trigger; accept the authorization prompt).
2. **Publish the Web App** — Deploy → Manage deployments → Edit → *New version*. The
   `/exec` URL stays the same; pushing code alone does **not** update a versioned
   deployment.
3. **Frontend** — upload `index.html` to the web host. `SCRIPT_URL` inside it must point to
   the current `/exec` URL (if you ever create a *new* deployment, the URL changes — update
   `index.html` accordingly).

> Triggers run against the latest pushed code ("Head"), so `clasp push` is enough for the
> trigger/import logic to pick up changes; only the served Web App needs a new version.

## Operations (functions you run by hand)

| Function | What it does |
|----------|--------------|
| `installWarmTrigger` | Installs/refreshes the 1-minute keep-warm trigger. Run once after changing its interval. |
| `parseLatestRaidDataAndUpdateRoster_Force` | Reprocess the latest ZIP, ignoring the "already processed" history (testing). |
| `exportEligibleMainLists` | (Re)build the **DKP Lists** sheet. |
| `exportRosterStatsFromLatestDump` | (Re)build the **Roster tick stats** sheet. |
| `parseRosterNotesToTable` | (Re)build the **Roster info** sheet from cell notes (also in the "Roster Tools" menu). |
| `resetRaidSummary` | Delete the **Raid Summary** sheet and clear its processed-IDs history. |

## Performance notes

The initial load was brought from up to ~15 s down to ~2 s on a first visit (instant on
repeat visits) via three levers: a chunked cache that can't overflow the 100 KB limit, a
keep-warm trigger (with a last-modified gate so the heavy read rarely runs), and
`localStorage` instant rendering on the client.

A Sheets-Advanced-Service rewrite of `getRosterData` was prototyped and **rejected**: in
Apps Script, the native `SpreadsheetApp` batch reads are ~2.7× faster than a single
`Sheets.Spreadsheets.get` that has to fetch and parse per-cell formatting over HTTP.
