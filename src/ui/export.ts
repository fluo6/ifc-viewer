import { buildWorkbook, type CellValue, type ReportInput, type WorkbookModel } from "../report";
import type { ElementParameters, Viewer } from "../viewer";
import { toast } from "./toast";
import ExcelJS from "exceljs";

export function mountExport(viewer: Viewer): void {
  const button = document.getElementById("export-btn") as HTMLButtonElement;
  let busy = false;

  viewer.onModelLoaded.on(() => {
    button.disabled = false;
  });
  viewer.onModelUnloaded.on(() => {
    button.disabled = true;
  });

  button.addEventListener("click", async () => {
    if (busy) return;

    if (viewer.isStreamed()) {
      toast("Parameters are unavailable for streamed models over 50 MB", "info");
      return;
    }
    const units = viewer.getModelUnits();
    if (!units) {
      toast("No parameter data available for this model", "info");
      return;
    }

    const sourceName = viewer.getCurrentFilename() || "model.ifc";
    const suggested = `${sourceName.replace(/\.ifc$/i, "")}.xlsx`;

    // Claim busy (and disable the button) before opening the dialog, not
    // after it resolves. main's dialog:save-xlsx has no parent BrowserWindow,
    // so the native dialog isn't modal and the renderer stays fully
    // interactive for as long as the user takes to pick a filename -- a
    // second click in that window must hit the `if (busy) return;` guard
    // above rather than opening a second dialog.
    busy = true;
    button.disabled = true;
    const previousLabel = button.textContent;
    try {
      button.textContent = "Exporting…";
      const { elements, unreadable } = collect(viewer);
      const model = buildWorkbook(
        { filename: sourceName, ...units, elements },
        new Date().toISOString(),
      );
      let outputName = suggested;
      if (window.electron?.saveXlsxDialog && window.electron.writeXlsx) {
        const filePath = await window.electron.saveXlsxDialog(suggested);
        if (!filePath) return;
        await window.electron.writeXlsx(filePath, model);
        outputName = filePath.split(/[\\/]/).pop() ?? suggested;
      } else {
        await downloadWorkbook(model, suggested);
      }
      const total = model.sheets
        .filter((s) => s.name !== "Model" && s.name !== "Profiles")
        .reduce((n, s) => n + s.rows.length, 0);
      const notes: string[] = [];
      // Everything the workbook could not represent gets said out loud here;
      // an export that quietly loses rows or mixes units is worse than one
      // that admits it.
      if (unreadable > 0) notes.push(`${unreadable} unreadable`);
      if (model.skipped > 0) notes.push(`${model.skipped} skipped`);
      if (model.truncatedMultiSolid > 0) {
        // Never let a truncation pass unmentioned.
        notes.push(`${model.truncatedMultiSolid} multi-solid truncated to their first solid`);
      }
      if (model.unitConflicts > 0) {
        notes.push(`${model.unitConflicts} values whose unit differs from their column`);
      }
      const suffix = notes.length ? ` (${notes.join(", ")})` : "";
      toast(`Exported ${total} elements to ${outputName}${suffix}`, "info");
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = previousLabel ?? "Export XLSX";
    }
  });
}

/** Serialize a report in the browser and trigger a local XLSX download. */
export async function downloadWorkbook(model: WorkbookModel, filename: string): Promise<void> {
  const book = new ExcelJS.Workbook();
  book.creator = "IFC Viewer";
  for (const sheet of model.sheets) {
    const worksheet = book.addWorksheet(sheet.name);
    worksheet.addRow(sheet.columns.map((column) => column.header));
    worksheet.getRow(1).font = { bold: true };
    for (const row of sheet.rows) {
      worksheet.addRow(row.map((value: CellValue) => (value === null ? undefined : value)));
    }
    if (sheet.name !== "Model") {
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      if (sheet.columns.length > 0 && sheet.rows.length > 0) {
        worksheet.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: sheet.columns.length },
        };
      }
    }
    for (let i = 0; i < sheet.columns.length; i++) {
      worksheet.getColumn(i + 1).width = Math.min(
        40,
        Math.max(12, (sheet.columns[i]?.header.length ?? 12) + 2),
      );
    }
  }

  const buffer = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Every element the classifier knows about, with its parameters, plus how many
 * could not be read at all.
 *
 * Viewer.getElementParameters swallows a read failure and returns null, so a
 * failing element never reaches buildWorkbook and its `skipped` counter cannot
 * see it. One unreadable element must not lose the other 1300, but it must not
 * disappear without mention either -- hence the count travels back with them.
 */
function collect(viewer: Viewer): { elements: ElementParameters[]; unreadable: number } {
  const elements: ElementParameters[] = [];
  let unreadable = 0;
  for (const ids of viewer.getCategories().values()) {
    for (const id of ids) {
      const params = viewer.getElementParameters(id);
      if (params) elements.push(params);
      else unreadable++;
    }
  }
  return { elements, unreadable };
}
