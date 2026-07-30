import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { launchViewer, readyWindow } from "./launch";

/**
 * Full export against the two real project models, replacing the brief's
 * "open Excel and eyeball it" step with something reproducible. Both files
 * live outside the repo, so -- following the same convention as
 * quantities.e2e.spec.ts and properties-refresh.e2e.spec.ts -- each test
 * skips rather than fails when its file is absent.
 */
const HALEV =
  "C:\\Users\\fujial\\Documents\\264034 - Centre for Jewish Life\\rhino\\rhino-ifc-20260728\\264034-TTW-P3-RH-ST-001-[01] - Halev IFC Model.ifc";
const PAC =
  "C:\\Users\\fujial\\Documents\\264034 - Centre for Jewish Life\\rhino\\rhino-ifc-20260728\\264034-TTW-11-RH-ST-001-[01] - PAC IFC Model.ifc";

const ELEMENT_SHEETS = ["Beams", "Columns", "Members", "Walls", "Slabs"];

/** Loads `ifcPath`, stubs the save dialog to `target`, and clicks Export. */
async function exportModel(
  app: Awaited<ReturnType<typeof launchViewer>>,
  page: Awaited<ReturnType<typeof readyWindow>>,
  ifcPath: string,
): Promise<string> {
  const target = path.join(
    mkdtempSync(path.join(tmpdir(), "export-real-")),
    "out.xlsx",
  );
  await app.evaluate(
    async ({ ipcMain }, filePath) => {
      ipcMain.removeHandler("dialog:save-xlsx");
      ipcMain.handle("dialog:save-xlsx", async () => filePath);
    },
    target,
  );

  await page.evaluate(async (path_) => {
    const buf = await (window as any).electron.readFile(path_);
    const filename = path_.split(/[\\/]/).pop();
    await (window as any).__viewer.loadIfc(buf, filename);
  }, ifcPath);

  await page.locator("#export-btn").click();
  // A full parameter read over ~1300 elements plus the exceljs write is slow;
  // give it far more room than the UI toast usually needs.
  await expect(page.locator("#toast-host")).toContainText("Exported", {
    timeout: 240_000,
  });
  return target;
}

/** 1-indexed column number of a header whose text matches `header` exactly. */
function columnOf(sheet: ExcelJS.Worksheet, header: string): number {
  const row = sheet.getRow(1);
  let found = 0;
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    if (cell.value === header) found = col;
  });
  return found;
}

test("Halev model exports the expected sheets and row counts", async () => {
  test.skip(!existsSync(HALEV), `fixture not present: ${HALEV}`);
  test.setTimeout(300_000);

  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const target = await exportModel(app, page, HALEV);

    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(target);
    const names = book.worksheets.map((s) => s.name);
    for (const expected of [...ELEMENT_SHEETS, "Profiles", "Model"]) {
      expect(names, `sheets were ${JSON.stringify(names)}`).toContain(expected);
    }

    const dataRows = (name: string) => book.getWorksheet(name)!.rowCount - 1;

    expect(dataRows("Beams")).toBe(286);
    expect(dataRows("Members")).toBe(375);

    const total = ELEMENT_SHEETS.reduce((n, name) => n + dataRows(name), 0);
    expect(total).toBe(887);

    // The whole point of Profiles normalisation: far fewer rows than the
    // element sheet that references them.
    expect(dataRows("Profiles")).toBeLessThan(dataRows("Beams"));

    // Reported, not asserted -- the brief calls out 21 flagged slabs by hand
    // but does not pin an exact total across every sheet.
    let suspectCount = 0;
    for (const name of ELEMENT_SHEETS) {
      const sheet = book.getWorksheet(name)!;
      const col = columnOf(sheet, "TessellationSuspect");
      if (col === 0) continue;
      for (let r = 2; r <= sheet.rowCount; r++) {
        if (sheet.getRow(r).getCell(col).value === true) suspectCount++;
      }
    }
    console.log(`[export-real-models] TessellationSuspect=true rows across all sheets: ${suspectCount}`);
  } finally {
    await app.close();
  }
});

test("PAC model (declared unit INCH) converts profile widths to real millimetres", async () => {
  test.skip(!existsSync(PAC), `fixture not present: ${PAC}`);
  test.setTimeout(300_000);

  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const target = await exportModel(app, page, PAC);

    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(target);

    // Profile columns are only prefixed on the per-class element sheets
    // ("Profile.ProfileName"/"Profile.OverallWidth [mm]"); the normalised
    // Profiles sheet uses the bare label. Search every element sheet for the
    // section, proving the conversion reached the value actually written next
    // to the element, not just the deduplicated reference sheet.
    let widthValue: unknown = undefined;
    for (const name of ELEMENT_SHEETS) {
      const sheet = book.getWorksheet(name);
      if (!sheet) continue;
      const nameCol = columnOf(sheet, "Profile.ProfileName");
      const widthCol = columnOf(sheet, "Profile.OverallWidth [mm]");
      if (nameCol === 0 || widthCol === 0) continue;
      for (let r = 2; r <= sheet.rowCount; r++) {
        if (sheet.getRow(r).getCell(nameCol).value === "310UC158") {
          widthValue = sheet.getRow(r).getCell(widthCol).value;
          break;
        }
      }
      if (widthValue !== undefined) break;
    }

    expect(widthValue, "no 310UC158 row found in any element sheet").not.toBeUndefined();
    expect(typeof widthValue).toBe("number");
    // ~311mm is the real section width; 12.244 would be the raw inch figure
    // read as if it were already millimetres (the bug this conversion fixes).
    expect(widthValue as number).toBeGreaterThan(305);
    expect(widthValue as number).toBeLessThan(315);
  } finally {
    await app.close();
  }
});
