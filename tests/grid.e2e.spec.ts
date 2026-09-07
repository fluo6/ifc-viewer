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

test("ground grid is placed below model base and resets on unload", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);

    const range = await page.evaluate(() => (window as any).__viewer.getModelHeightRange());
    expect(range).not.toBeNull();
    const gridY = await page.evaluate(() => (window as any).__viewer.debugGridElevation());

    // Grid should sit strictly below model base
    expect(gridY).toBeLessThan(range!.min);
    expect(Math.abs(gridY - (range!.min - 0.01))).toBeLessThan(0.005);

    // Unload model resets grid to 0
    await page.evaluate(async () => {
      await (window as any).__viewer.unloadIfc();
    });
    const resetGridY = await page.evaluate(() => (window as any).__viewer.debugGridElevation());
    expect(resetGridY).toBe(0);
  } finally {
    await app.close();
  }
});

test("grid toggle button and G key shortcut toggle grid visibility", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const btn = page.locator("#grid-toggle");

    await expect(btn).toHaveText("Grid: ON");
    expect(await page.evaluate(() => (window as any).__viewer.isGridVisible())).toBe(true);

    // Click button to toggle off
    await btn.click();
    await expect(btn).toHaveText("Grid: OFF");
    expect(await page.evaluate(() => (window as any).__viewer.isGridVisible())).toBe(false);

    // Press 'G' to toggle back on
    await page.keyboard.press("g");
    await expect(btn).toHaveText("Grid: ON");
    expect(await page.evaluate(() => (window as any).__viewer.isGridVisible())).toBe(true);
  } finally {
    await app.close();
  }
});
