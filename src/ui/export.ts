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
      const model = buildWorkbook(
        { filename: sourceName, ...units, elements: collect(viewer) },
        new Date().toISOString(),
      );
      await window.electron.writeXlsx(filePath, model);
      const total = model.sheets
        .filter((s) => s.name !== "Model" && s.name !== "Profiles")
        .reduce((n, s) => n + s.rows.length, 0);
      const notes: string[] = [];
      if (model.skipped > 0) notes.push(`${model.skipped} skipped`);
      if (model.truncatedMultiSolid > 0) {
        // Never let a truncation pass unmentioned.
        notes.push(`${model.truncatedMultiSolid} multi-solid truncated to their first solid`);
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

/** Every element the classifier knows about, with its parameters. */
function collect(viewer: Viewer): ElementParameters[] {
  const out: ElementParameters[] = [];
  for (const ids of viewer.getCategories().values()) {
    for (const id of ids) {
      // One unreadable element must not lose the other 1300; buildWorkbook
      // counts the gaps via `skipped`.
      const params = viewer.getElementParameters(id);
      if (params) out.push(params);
    }
  }
  return out;
}
