/**
 * Reads the notes of the Roster!D6:R cells, parses "AA:" and "Access:",
 * and writes a normalized table into the "Roster info" tab.
 *
 * Assumptions:
 * - "Discord Profile" is in column A of the same row (Roster!A6:A).
 * - "Access:" keys can contain VP, ST, Emp, VT (separated by comma/semicolon).
 * - Only REAL notes (Insert > Note) are processed, not Google comments.
 */
function parseRosterNotesToTable() {
  const ss = SpreadsheetApp.getActive();
  const roster = ss.getSheetByName(CONFIG.SHEETS.ROSTER);
  if (!roster) throw new Error('Sheet "Roster" not found.');

  const ROW_START = 6;         // Start at row 6
  const COL_START = 4;         // Column D
  const COL_END = 18;          // Column R
  const numRows = roster.getLastRow() - ROW_START + 1;
  if (numRows <= 0) {
    SpreadsheetApp.getUi().alert('No data under Roster!D6:R.');
    return;
  }
  const numCols = COL_END - COL_START + 1;

  // Values and notes of the D6:R matrix
  const values = roster.getRange(ROW_START, COL_START, numRows, numCols).getValues();
  const notes  = roster.getRange(ROW_START, COL_START, numRows, numCols).getNotes();

  // Discord Profile (column A)
  const discordCol = roster.getRange(ROW_START, 1, numRows, 1).getValues().map(r => r[0]);

  const out = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const note = (notes[r][c] || '').toString().trim();
      if (!note) continue; // ignore cells without a note

      // Character name = content of the cell carrying the note
      const charName = values[r][c];
      if (charName === '' || charName === null) continue;

      // Discord Profile = column A of the same row
      const discord = discordCol[r] || '';

      // AA: <number>
      // robust to spaces/line breaks (e.g. "AA: 100")
      const aaMatch = note.match(/(^|\n)\s*AA\s*:\s*([0-9]+)/i);
      const aa = aaMatch ? Number(aaMatch[2]) : '';

      // Access: VP, ST, Emp, VT
      // accepts comma/semicolon separators and varied spacing
      const accessMatch = note.match(/(^|\n)\s*Access\s*:\s*([^\n]+)/i);
      let accessList = [];
      if (accessMatch) {
        accessList = accessMatch[2]
          .split(/[;,]/)
          .map(s => s.trim().toUpperCase())
          .filter(Boolean);
      }

      // Boolean normalization for each key
      const hasVP  = accessList.includes('VP');
      const hasST  = accessList.includes('ST') || accessList.includes("SLEEPER'S TOMB") || accessList.includes('SLEEPERS TOMB');
      const hasEMP = accessList.includes('EMP') || accessList.includes('EMPEROR') || accessList.includes('EMPEROR SSRA');
      const hasVT  = accessList.includes('VT') || accessList.includes('VEX THAL');

      out.push([discord, charName, aa, hasVP, hasST, hasEMP, hasVT]);
    }
  }

  // Write into "Roster info"
  const outName = CONFIG.SHEETS.ROSTER_INFO;
  let outSheet = ss.getSheetByName(outName);
  if (!outSheet) outSheet = ss.insertSheet(outName);
  outSheet.clearContents();

  const header = [['Discord Profile', 'Character Name', 'AA', 'VP key', 'ST key', 'Emp key', 'VT key']];
  outSheet.getRange(1, 1, 1, header[0].length).setValues(header);

  if (out.length) {
    outSheet.getRange(2, 1, out.length, header[0].length).setValues(out);
    // (Option) checkboxes for the key columns
    outSheet.getRange(2, 4, out.length, 4).insertCheckboxes();
  }

  outSheet.autoResizeColumns(1, header[0].length);
}

/**
 * (Optional) Adds a menu to re-run easily.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Roster Tools')
    .addItem('Extract notes → Roster info', 'parseRosterNotesToTable')
    .addToUi();
}
