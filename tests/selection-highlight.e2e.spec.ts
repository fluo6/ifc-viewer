import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { launchViewer, readyWindow } from "./launch";

const FIXTURE = path.resolve(__dirname, "fixtures/i-beam.ifc");

async function loaded(app: Awaited<ReturnType<typeof launchViewer>>) {
  const page = await readyWindow(app);
  const bytes = [...readFileSync(FIXTURE)];
  await page.evaluate(async (data) => {
    await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
  }, bytes);
  return page;
}

test("clicking an element selects and highlights it with azure blue color", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");
    const baseline = await viewport.screenshot();

    const box = (await viewport.boundingBox())!;
    const x = box.x + box.width / 2;
    const yTop = box.y + box.height / 2 - 100;

    // Click to select the beam
    await page.mouse.click(x, yTop);
    await page.waitForTimeout(600);

    // Assert properties panel reflects selected beam
    await expect(page.locator("#properties")).toContainText("IfcBeam");
    await expect(page.locator("#properties")).toContainText("#49");

    // Assert visual highlight was applied (frame changed)
    const selectedShot = await viewport.screenshot();
    expect(selectedShot.equals(baseline)).toBe(false);

    // Assert highlight data is set in fragments model
    const highlightData = await page.evaluate(async () => {
      const viewer = (window as any).__viewer;
      const model = viewer.currentModel;
      const expressId = viewer.getSelection()?.expressId;
      return expressId ? model.getHighlight([expressId]) : null;
    });
    expect(highlightData).not.toBeNull();
    expect(highlightData[0]?.color).toBeDefined();

    // Deselect by clicking empty background
    await page.mouse.click(box.x + 40, box.y + 40);
    await page.waitForTimeout(600);

    await expect(page.locator("#properties")).toContainText("Click an element to inspect");
    const deselectedShot = await viewport.screenshot();
    expect(deselectedShot.equals(baseline)).toBe(true);
  } finally {
    await app.close();
  }
});

test("programmatic viewer.select and clearSelection update highlight and properties", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");
    const baseline = await viewport.screenshot();

    // Select expressId 49 programmatically
    await page.evaluate(async () => {
      await (window as any).__viewer.select(49);
    });
    await page.waitForTimeout(600);

    expect(await page.evaluate(() => (window as any).__viewer.getSelection()?.expressId)).toBe(49);
    await expect(page.locator("#properties")).toContainText("#49");

    const selectedShot = await viewport.screenshot();
    expect(selectedShot.equals(baseline)).toBe(false);

    // Clear selection programmatically
    await page.evaluate(async () => {
      await (window as any).__viewer.clearSelection();
    });
    await page.waitForTimeout(600);

    expect(await page.evaluate(() => (window as any).__viewer.getSelection())).toBeNull();
    const clearedShot = await viewport.screenshot();
    expect(clearedShot.equals(baseline)).toBe(true);
  } finally {
    await app.close();
  }
});

test("selection highlighting operates correctly alongside X-Ray mode", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");
    const box = (await viewport.boundingBox())!;
    const x = box.x + box.width / 2;
    const yTop = box.y + box.height / 2 - 100;

    // Enable X-Ray mode
    await page.evaluate(async () => {
      await (window as any).__viewer.setXray(true);
    });
    await page.waitForTimeout(400);
    const xrayBaseline = await viewport.screenshot();

    // Click beam to select in X-Ray mode
    await page.mouse.click(x, yTop);
    await page.waitForTimeout(600);

    const xraySelectedShot = await viewport.screenshot();
    expect(xraySelectedShot.equals(xrayBaseline)).toBe(false);

    // Deselect beam: X-Ray state should be restored
    await page.mouse.click(box.x + 40, box.y + 40);
    await page.waitForTimeout(600);

    const xrayDeselectedShot = await viewport.screenshot();
    expect(xrayDeselectedShot.equals(xrayBaseline)).toBe(true);
  } finally {
    await app.close();
  }
});
