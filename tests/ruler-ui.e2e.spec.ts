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

test("the ruler bar appears only while a model is loaded", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    await expect(page.locator("#ruler")).toBeHidden();

    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);
    await expect(page.locator("#ruler")).toBeVisible();

    await page.evaluate(() => (window as any).__viewer.unloadIfc());
    await expect(page.locator("#ruler")).toBeHidden();
  } finally {
    await app.close();
  }
});

test("the toggle drives measure mode and reflects its state", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const toggle = page.locator("#ruler-toggle");
    await expect(toggle).toHaveText("Measure: OFF");

    await toggle.click();
    await expect(toggle).toHaveText("Measure: ON");
    expect(await page.evaluate(() => (window as any).__viewer.isMeasureMode())).toBe(true);
    await expect(page.locator("#ruler")).toContainText("Esc cancels");

    await toggle.click();
    await expect(toggle).toHaveText("Measure: OFF");
    expect(await page.evaluate(() => (window as any).__viewer.isMeasureMode())).toBe(false);
  } finally {
    await app.close();
  }
});

test("the m key toggles measure mode and the button follows", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.keyboard.press("m");
    await expect(page.locator("#ruler-toggle")).toHaveText("Measure: ON");
    await page.keyboard.press("m");
    await expect(page.locator("#ruler-toggle")).toHaveText("Measure: OFF");
  } finally {
    await app.close();
  }
});

test("Clear appears only when measurements exist and removes them", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await expect(page.locator("#ruler-clear")).toHaveCount(0);

    await page.evaluate(() => {
      (window as any).__viewer.measureBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
    });
    // The bar re-renders on mode change; force one so the button appears.
    await page.locator("#ruler-toggle").click();
    await expect(page.locator("#ruler-clear")).toBeVisible();

    await page.locator("#ruler-clear").click();
    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(0);
    await expect(page.locator("#ruler-clear")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("clicking the ruler bar itself does not place a measurement point", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.locator("#ruler-toggle").click(); // enters measure mode
    // Clicking the toggle again must not have anchored a point on the way.
    await page.locator("#ruler-toggle").click();
    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(0);
  } finally {
    await app.close();
  }
});
