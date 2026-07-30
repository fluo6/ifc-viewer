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

/**
 * Geometry is in metres and the label divides by SimpleDimensionLine.scale, so
 * a 5 m span must read 5000 mm. Driving this through measureBetween rather than
 * two synthetic clicks keeps it independent of camera framing.
 */
test("a measurement is labelled in millimetres", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => {
      (window as any).__viewer.measureBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
    });
    await expect(page.locator("#viewport")).toContainText("5000 mm");
    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(1);
  } finally {
    await app.close();
  }
});

test("a sub-metre measurement still reads in whole millimetres", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => {
      (window as any).__viewer.measureBetween({ x: 0, y: 0, z: 0 }, { x: 0.25, y: 0, z: 0 });
    });
    await expect(page.locator("#viewport")).toContainText("250 mm");
  } finally {
    await app.close();
  }
});

test("measure mode suspends element selection and restores it", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);

    await page.evaluate(() => (window as any).__viewer.setMeasureMode(true));
    expect(await page.evaluate(() => (window as any).__viewer.isMeasureMode())).toBe(true);

    // A real click on the canvas must not select while measuring.
    const box = (await page.locator("#viewport").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    await expect(page.locator("#properties")).toContainText("Click an element to inspect");

    await page.evaluate(() => (window as any).__viewer.setMeasureMode(false));
    expect(await page.evaluate(() => (window as any).__viewer.isMeasureMode())).toBe(false);
  } finally {
    await app.close();
  }
});

test("entering measure mode clears the current selection", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const expressId = await page.evaluate(
      () => (window as any).__viewer.getCategories().get("IFCBEAM")[0],
    );
    await page.evaluate((id) => {
      (window as any).__viewer.onSelection.emit({ fragmentId: "t", expressId: id });
    }, expressId);
    await expect(page.locator("#properties")).toContainText("IfcShapeProfile");

    await page.evaluate(() => (window as any).__viewer.setMeasureMode(true));
    await expect(page.locator("#properties")).toContainText("Click an element to inspect");
  } finally {
    await app.close();
  }
});

test("clearing removes every measurement", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      viewer.measureBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
      viewer.measureBetween({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    });
    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(2);

    await page.evaluate(() => (window as any).__viewer.clearMeasurements());
    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(0);
    await expect(page.locator("#viewport")).not.toContainText("5000 mm");
  } finally {
    await app.close();
  }
});

test("the effective vertex snap radius is 50 mm, not the library default", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const snap = await page.evaluate(() => (window as any).__viewer.debugSnapDistance());
    // 0.25 here would mean the library default is still in force and the
    // setting never took — the picker caches its config at construction.
    expect(snap).toBeCloseTo(0.05, 6);
  } finally {
    await app.close();
  }
});

/**
 * Every other test in this file drives measureBetween/createOnPoints, which
 * bypasses raycasting entirely. The actual two-click UX goes through
 * LengthMeasurement's vertex picker, which raycasts against world.meshes --
 * so this is the one test that would have caught world.meshes never being
 * populated. The two screen points below were confirmed empirically (by
 * checking that a plain click there, with measure mode off, selects the
 * beam and populates the properties panel) rather than assumed from camera
 * framing.
 */
test("clicking twice on the model creates a measurement", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const box = (await page.locator("#viewport").boundingBox())!;
    const x = box.x + box.width / 2;
    const yTop = box.y + box.height / 2 - 100;
    const yBottom = box.y + box.height / 2 + 100;

    await page.evaluate(() => (window as any).__viewer.setMeasureMode(true));

    await page.mouse.click(x, yTop);
    await page.waitForTimeout(200);
    await page.mouse.click(x, yBottom);
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(1);
  } finally {
    await app.close();
  }
});

/**
 * Regression test: loadIfc is the normal way to switch models (both
 * dropzone.ts and toolbar.ts call it directly, with no separate unload step),
 * and a second load in the same session previously left world.meshes empty
 * forever -- the vertex picker behind click-to-measure raycasts against
 * world.meshes, so clicking to measure silently died after the first model.
 * Same two screen points as "clicking twice on the model creates a
 * measurement" above, confirmed there to hit geometry.
 */
test("clicking twice on the model creates a measurement after a second load", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    await loaded(app);
    const page = await loaded(app); // second load, same session, no explicit unload

    const box = (await page.locator("#viewport").boundingBox())!;
    const x = box.x + box.width / 2;
    const yTop = box.y + box.height / 2 - 100;
    const yBottom = box.y + box.height / 2 + 100;

    await page.evaluate(() => (window as any).__viewer.setMeasureMode(true));

    await page.mouse.click(x, yTop);
    await page.waitForTimeout(200);
    await page.mouse.click(x, yBottom);
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(1);
  } finally {
    await app.close();
  }
});

test("unloading a model clears measurements and exits measure mode", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      viewer.measureBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
      viewer.setMeasureMode(true);
      viewer.unloadIfc();
    });
    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(0);
    expect(await page.evaluate(() => (window as any).__viewer.isMeasureMode())).toBe(false);
  } finally {
    await app.close();
  }
});
