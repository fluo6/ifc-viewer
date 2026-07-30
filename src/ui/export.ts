import { buildWorkbook, type ReportInput } from "../report";
import type { ElementParameters, Viewer } from "../viewer";
import { toast } from "./toast";

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

    // The renderer also runs in a plain browser under `vite`, where there is no
    // IPC bridge. Same guard as mountToolbar's open button.
    if (!window.electron?.saveXlsxDialog) {
      toast("Export only works inside the Electron app", "info");
      return;
    }

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
      const filePath = await window.electron.saveXlsxDialog(suggested);
      if (!filePath) return; // cancelled -- the user changed their mind, silent no-op

      button.textContent = "Exporting…";
      const { elements, unreadable } = collect(viewer);
      const model = buildWorkbook(
        { filename: sourceName, ...units, elements },
        new Date().toISOString(),
      );
      await window.electron.writeXlsx(filePath, model);
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
      toast(
        `Exported ${total} elements to ${filePath.split(/[\\/]/).pop()}${suffix}`,
        "info",
      );
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = previousLabel ?? "Export XLSX";
    }
  });
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
