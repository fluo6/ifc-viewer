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

test("X-Ray toggle button and X shortcut toggle transparency mode", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const btn = page.locator("#xray-toggle");

    // Initially OFF
    await expect(btn).toHaveText("X-Ray: OFF");
    expect(await page.evaluate(() => (window as any).__viewer.xrayOn())).toBe(false);

    // Toggle ON via button click
    await btn.click();
    await expect(btn).toHaveText("X-Ray: ON");
    expect(await page.evaluate(() => (window as any).__viewer.xrayOn())).toBe(true);

    // Toggle OFF via X key shortcut
    await page.keyboard.press("x");
    await expect(btn).toHaveText("X-Ray: OFF");
    expect(await page.evaluate(() => (window as any).__viewer.xrayOn())).toBe(false);

    // Toggle ON via X key shortcut
    await page.keyboard.press("x");
    await expect(btn).toHaveText("X-Ray: ON");
    expect(await page.evaluate(() => (window as any).__viewer.xrayOn())).toBe(true);

    // Unload model resets X-Ray to OFF
    await page.evaluate(async () => {
      await (window as any).__viewer.unloadIfc();
    });
    await expect(btn).toHaveText("X-Ray: OFF");
    expect(await page.evaluate(() => (window as any).__viewer.xrayOn())).toBe(false);
  } finally {
    await app.close();
  }
});

test("Back edges toggle button and B shortcut toggle back-edge lines", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const btn = page.locator("#back-edges-toggle");

    // Initially OFF
    await expect(btn).toHaveText("Back edges: OFF");
    expect(await page.evaluate(() => (window as any).__viewer.backEdgesOn())).toBe(false);

    // Toggle ON via button click
    await btn.click();
    await expect(btn).toHaveText("Back edges: ON");
    expect(await page.evaluate(() => (window as any).__viewer.backEdgesOn())).toBe(true);
    await page.waitForFunction(
      () => (window as any).__viewer.modelBackEdgesGroup.children.length > 0,
    );
    const modelEdgesCount = await page.evaluate(
      () => (window as any).__viewer.modelBackEdgesGroup.children.length,
    );
    expect(modelEdgesCount).toBeGreaterThan(0);

    // Toggle OFF via button click
    await btn.click();
    await expect(btn).toHaveText("Back edges: OFF");
    expect(await page.evaluate(() => (window as any).__viewer.backEdgesOn())).toBe(false);
    const isVisibleAfterOff = await page.evaluate(
      () => (window as any).__viewer.modelBackEdgesGroup.visible,
    );
    expect(isVisibleAfterOff).toBe(false);

    // Toggle ON via B key shortcut
    await page.keyboard.press("b");
    await expect(btn).toHaveText("Back edges: ON");
    expect(await page.evaluate(() => (window as any).__viewer.backEdgesOn())).toBe(true);

    // Toggle OFF via B key shortcut
    await page.keyboard.press("b");
    await expect(btn).toHaveText("Back edges: OFF");
    expect(await page.evaluate(() => (window as any).__viewer.backEdgesOn())).toBe(false);
  } finally {
    await app.close();
  }
});

test("selection generates dashed back-edges and deselect clears them", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);

    // Turn back edges ON first
    await page.evaluate(() => (window as any).__viewer.setBackEdges(true));

    // Check selectionBackEdgesGroup child count initially
    const initialCount = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      return viewer.selectionBackEdgesGroup?.children?.length ?? 0;
    });
    expect(initialCount).toBe(0);

    // Find first element ID in the loaded model and invoke updateSelectionBackEdges
    const childCountAfterSelect = await page.evaluate(async () => {
      const viewer = (window as any).__viewer;
      const model = viewer.currentModel;
      const ids = await model.getItemsIds();
      await viewer.updateSelectionBackEdges(ids[0]);
      return viewer.selectionBackEdgesGroup.children.length;
    });
    // Should have created both solid and dashed LineSegments (at least 2 meshes)
    expect(childCountAfterSelect).toBeGreaterThan(0);

    // Clearing selection back edges
    const childCountAfterClear = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      viewer.clearSelectionBackEdges();
      return viewer.selectionBackEdgesGroup.children.length;
    });
    expect(childCountAfterClear).toBe(0);
  } finally {
    await app.close();
  }
});

