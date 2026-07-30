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
