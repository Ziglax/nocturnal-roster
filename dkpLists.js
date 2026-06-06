function exportEligibleMainLists() {
  const SOURCE_SHEET = CONFIG.SHEETS.ROSTER;
  const TARGET_SHEET = CONFIG.SHEETS.DKP_LISTS;

  const CLASS_HEADER_ROW = 1;
  const META_HEADER_ROW = 5;
  const DATA_START_ROW = 6;

  const CASTERS = new Set(["Wizard", "Enchanter", "Magician", "Necromancer"]);
  const PRIESTS = new Set(["Cleric", "Shaman", "Druid"]);

  const MIN_RA_M = CONFIG.MIN_RA.M;
  const MIN_RA_M2 = CONFIG.MIN_RA.M2;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SOURCE_SHEET);
  if (!sheet) {
    Logger.log('Source sheet not found: ' + SOURCE_SHEET);
    return;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < DATA_START_ROW) {
    Logger.log("No usable data.");
    return;
  }

  const classHeaders = sheet.getRange(CLASS_HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const metaHeaders = sheet.getRange(META_HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const data = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, lastCol).getValues();

  const idxDKP = metaHeaders.indexOf("DKP");
  const idxRA = metaHeaders.indexOf("RA");

  if (idxDKP === -1 || idxRA === -1) {
    Logger.log("DKP and/or RA columns not found on row 5.");
    return;
  }

  const casters = [];
  const priests = [];
  const melee = [];

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const dkp = Number(row[idxDKP]) || 0;
    const ra = parsePercentToFraction(row[idxRA]);

    for (let c = 0; c < classHeaders.length; c++) {
      const className = String(classHeaders[c] || "").trim();
      if (!className) continue;

      const cell = String(row[c] || "").trim();
      if (!cell) continue;

      let status = "";

      if (cell.includes("(M2-")) {
        status = "M2";
        if (ra < MIN_RA_M2) continue;
      } else if (cell.includes("(M-")) {
        status = "M";
        if (ra < MIN_RA_M) continue;
      } else {
        continue;
      }

      const name = cell.split(" (")[0].trim();

      const entry = {
        name,
        className,
        status,
        dkp,
        ra
      };

      if (CASTERS.has(className)) {
        casters.push(entry);
      } else if (PRIESTS.has(className)) {
        priests.push(entry);
      } else {
        melee.push(entry);
      }
    }
  }

  sortByDkp(casters);
  sortByDkp(priests);
  sortByDkp(melee);

  const casterBlock = buildSectionBlock("Casters", casters);
  const priestBlock = buildSectionBlock("Priests", priests);
  const meleeBlock = buildSectionBlock("Melee", melee);

  const finalRows = mergeBlocksSideBySide([
    casterBlock,
    priestBlock,
    meleeBlock
  ]);

  let out = ss.getSheetByName(TARGET_SHEET);
  if (!out) out = ss.insertSheet(TARGET_SHEET);

  out.clearContents();

  if (finalRows.length > 0) {
    out.getRange(1, 1, finalRows.length, finalRows[0].length).setValues(finalRows);
  }

  // Formatting
  out.setFrozenRows(2);

  // Section titles
  out.getRange(1, 1, 1, 6).setFontWeight("bold");
  out.getRange(1, 8, 1, 6).setFontWeight("bold");
  out.getRange(1, 15, 1, 6).setFontWeight("bold");

  // Headers
  out.getRange(2, 1, 1, 6).setFontWeight("bold");
  out.getRange(2, 8, 1, 6).setFontWeight("bold");
  out.getRange(2, 15, 1, 6).setFontWeight("bold");

  // Number formats
  const numRows = Math.max(finalRows.length - 2, 0);
  if (numRows > 0) {
    // Casters
    out.getRange(3, 4, numRows, 1).setNumberFormat("0");
    out.getRange(3, 5, numRows, 1).setNumberFormat("0%");
    out.getRange(3, 6, numRows, 1).setNumberFormat("0");

    // Priests
    out.getRange(3, 11, numRows, 1).setNumberFormat("0");
    out.getRange(3, 12, numRows, 1).setNumberFormat("0%");
    out.getRange(3, 13, numRows, 1).setNumberFormat("0");

    // Melee
    out.getRange(3, 18, numRows, 1).setNumberFormat("0");
    out.getRange(3, 19, numRows, 1).setNumberFormat("0%");
    out.getRange(3, 20, numRows, 1).setNumberFormat("0");
  }

  out.autoResizeColumns(1, finalRows[0].length);

  Logger.log(`Export done. Casters=${casters.length}, Priests=${priests.length}, Melee=${melee.length}`);
}

function parsePercentToFraction(value) {
  const txt = String(value || "").trim();
  if (!txt) return 0;

  if (txt.endsWith("%")) {
    const n = parseFloat(txt.replace("%", "").trim());
    return isNaN(n) ? 0 : n / 100;
  }

  const n = parseFloat(txt);
  if (isNaN(n)) return 0;

  return n > 1 ? n / 100 : n;
}

function sortByDkp(arr) {
  arr.sort((a, b) => {
    if (b.dkp !== a.dkp) return b.dkp - a.dkp;
    if (b.ra !== a.ra) return b.ra - a.ra;
    return a.name.localeCompare(b.name);
  });
}

function buildSectionBlock(title, entries) {
  const rows = [];
  rows.push([title, "", "", "", "", ""]);
  rows.push(["Character", "Class", "Status", "DKP", "RA", "Gap to next"]);

  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    const next = entries[i + 1];
    const gap = next ? (cur.dkp - next.dkp) : "";

    rows.push([
      cur.name,
      cur.className,
      cur.status,
      cur.dkp,
      cur.ra,
      gap
    ]);
  }

  return rows;
}

function mergeBlocksSideBySide(blocks) {
  const separatorWidth = 1;
  const blockWidths = blocks.map(block => (block[0] ? block[0].length : 0));
  const maxRows = Math.max(...blocks.map(block => block.length));

  const output = [];

  for (let r = 0; r < maxRows; r++) {
    const row = [];

    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      const width = blockWidths[b];

      if (r < block.length) {
        row.push(...block[r]);
      } else {
        row.push(...new Array(width).fill(""));
      }

      if (b < blocks.length - 1) {
        row.push(...new Array(separatorWidth).fill(""));
      }
    }

    output.push(row);
  }

  return output;
}