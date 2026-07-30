import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { launchViewer, readyWindow } from "./launch";

const FIXTURE = path.resolve(__dirname, "fixtures/i-beam.ifc");

test("the export button writes a workbook for the loaded model", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const button = page.locator("#export-btn");

    // Disabled until something is loaded.
    await expect(button).toBeDisabled();

    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);
    await expect(button).toBeEnabled();

    // Stub the save dialog in the main process so no native window appears.
    const target = path.join(mkdtempSync(path.join(tmpdir(), "export-e2e-")), "out.xlsx");
    await app.evaluate(async ({ ipcMain }, filePath) => {
      ipcMain.removeHandler("dialog:save-xlsx");
      ipcMain.handle("dialog:save-xlsx", async () => filePath);
    }, target);

    await button.click();
    await expect(page.locator("#toast-host")).toContainText("Exported", {
      timeout: 30_000,
    });

    expect(existsSync(target)).toBe(true);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(target);
    expect(book.worksheets.map((s) => s.name)).toContain("Beams");
    expect(book.getWorksheet("Beams")!.rowCount).toBeGreaterThan(1);
  } finally {
    await app.close();
  }
});

test("a double click while the save dialog is open only starts one export", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);

    // Stub the handler to resolve slowly, reproducing the window during
    // which the real (unparented, non-modal) native save dialog would be
    // open and the renderer still fully interactive.
    const target = path.join(mkdtempSync(path.join(tmpdir(), "export-e2e-dbl-")), "out.xlsx");
    await app.evaluate(async ({ ipcMain }, filePath) => {
      (globalThis as any).__saveXlsxCalls = 0;
      ipcMain.removeHandler("dialog:save-xlsx");
      ipcMain.handle("dialog:save-xlsx", async () => {
        (globalThis as any).__saveXlsxCalls++;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return filePath;
      });
    }, target);

    const button = page.locator("#export-btn");

    // Dispatch two real clicks back-to-back in the same browser turn -- this
    // is what a physical double click looks like: the second event fires
    // before the first click handler's async work (the dialog await) has
    // had any chance to resolve. Using Playwright's own locator.click() twice
    // would instead re-run actionability waits for each call and could let
    // the second click land only after the first export has already
    // finished, which is not the race we're reproducing.
    await page.evaluate(() => {
      const btn = document.getElementById("export-btn") as HTMLButtonElement;
      btn.click();
      btn.click();
    });

    await expect(page.locator("#toast-host")).toContainText("Exported", {
      timeout: 30_000,
    });

    const calls = await app.evaluate(() => (globalThis as any).__saveXlsxCalls);
    expect(calls).toBe(1);

    // The fix must not leave the button stuck disabled or mislabelled.
    await expect(button).toBeEnabled();
    await expect(button).toHaveText("Export XLSX");
  } finally {
    await app.close();
  }
});

test("an element whose parameters cannot be read is reported, not silently dropped", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);

    // Viewer.getElementParameters swallows a read failure and returns null.
    // Simulate that for exactly one element; the export must still run and
    // must account for the gap out loud.
    const failed = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const original = viewer.getElementParameters.bind(viewer);
      const ids: number[] = [];
      for (const list of viewer.getCategories().values()) ids.push(...list);
      const doomed = ids[0];
      viewer.getElementParameters = (id: number) => (id === doomed ? null : original(id));
      return doomed;
    });
    expect(typeof failed).toBe("number");

    const target = path.join(mkdtempSync(path.join(tmpdir(), "export-e2e-null-")), "out.xlsx");
    await app.evaluate(async ({ ipcMain }, filePath) => {
      ipcMain.removeHandler("dialog:save-xlsx");
      ipcMain.handle("dialog:save-xlsx", async () => filePath);
    }, target);

    await page.locator("#export-btn").click();
    await expect(page.locator("#toast-host")).toContainText("1 unreadable", {
      timeout: 30_000,
    });
    expect(existsSync(target)).toBe(true);
  } finally {
    await app.close();
  }
});

test("cancelling the save dialog is a silent no-op", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);

    await app.evaluate(async ({ ipcMain }) => {
      ipcMain.removeHandler("dialog:save-xlsx");
      ipcMain.handle("dialog:save-xlsx", async () => null);
    });

    await page.locator("#export-btn").click();
    await page.waitForTimeout(1500);
    await expect(page.locator("#toast-host")).toBeEmpty();
    await expect(page.locator("#export-btn")).toBeEnabled();
  } finally {
    await app.close();
  }
});
