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

/**
 * Three phases at a point already confirmed to hit geometry (same screen
 * coordinates as "clicking twice on the model creates a measurement" below):
 * off → click selects (the positive control, so phase 2's non-selection can't
 * be explained by the click simply missing geometry), on → click does not
 * select, off again → click selects again. Without the positive control and
 * the final off-phase, moving `highlighter.enabled = !on` inside the
 * `if (on)` block would break selection permanently after the first
 * measurement and every test here would stay green.
 */
test("measure mode suspends element selection and restores it on exit", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const box = (await page.locator("#viewport").boundingBox())!;
    const x = box.x + box.width / 2;
    const yTop = box.y + box.height / 2 - 100;

    // Phase 1 -- measure mode off: a plain click selects (positive control).
    expect(await page.evaluate(() => (window as any).__viewer.isMeasureMode())).toBe(false);
    await page.mouse.click(x, yTop);
    await page.waitForTimeout(300);
    await expect(page.locator("#properties")).toContainText("IfcShapeProfile");

    // Phase 2 -- measure mode on: clear the prior selection first so the
    // "does not select" assertion below can't just be observing phase 1's
    // leftover selection still being shown.
    await page.evaluate(() => (window as any).__viewer.onSelection.emit(null));
    await expect(page.locator("#properties")).toContainText("Click an element to inspect");
    await page.evaluate(() => (window as any).__viewer.setMeasureMode(true));
    expect(await page.evaluate(() => (window as any).__viewer.isMeasureMode())).toBe(true);
    await page.mouse.click(x, yTop);
    await page.waitForTimeout(300);
    await expect(page.locator("#properties")).toContainText("Click an element to inspect");

    // Phase 3 -- measure mode off again: selection must be restored, not
    // permanently suspended.
    await page.evaluate(() => (window as any).__viewer.setMeasureMode(false));
    expect(await page.evaluate(() => (window as any).__viewer.isMeasureMode())).toBe(false);
    await page.mouse.click(x, yTop);
    await page.waitForTimeout(300);
    await expect(page.locator("#properties")).toContainText("IfcShapeProfile");
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
 * The browser fires `click` after mouseup regardless of how far the pointer
 * travelled between mousedown and mouseup -- so orbiting the camera (press,
 * drag, release, all over the canvas) dispatches a click same as a real
 * click would. Without a movement threshold that phantom click anchors a
 * measurement point the user never intended, and every later click is off
 * by one.
 *
 * measurementCount() alone can't tell this apart from an ordinary click: a
 * single anchored point doesn't complete a measurement either way, so the
 * count reads 0 in both the buggy and fixed cases. Worse, a real orbit drag
 * this large actually rotates the camera enough that the release point often
 * no longer raycasts onto the model at all (confirmed empirically -- with the
 * fix reverted, whether a phantom point gets anchored here is a coin flip
 * across runs, purely a function of where the camera ends up), which would
 * make an outcome-based assertion flaky no matter which coordinates are
 * picked. So this spies directly on Viewer.placeMeasurePoint -- the one call
 * ruler.ts's click handler is or isn't allowed to make -- which is exactly
 * the mechanism the fix gates, independent of whatever the camera happens to
 * be looking at afterwards.
 */
test("orbiting the camera in measure mode does not anchor a measurement point", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => (window as any).__viewer.setMeasureMode(true));

    await page.evaluate(() => {
      const v: any = (window as any).__viewer;
      (window as any).__placeCalls = 0;
      const original = v.placeMeasurePoint.bind(v);
      v.placeMeasurePoint = () => {
        (window as any).__placeCalls++;
        return original();
      };
    });

    const box = (await page.locator("#viewport").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 300, y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => (window as any).__placeCalls)).toBe(0);
    expect(await page.evaluate(() => (window as any).__viewer.measurementCount())).toBe(0);

    // A genuine click (no preceding drag) must still place a point normally.
    await page.mouse.click(x, y);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__placeCalls)).toBe(1);
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

    // Pin the unit chain end to end through a real click, not just
    // measureBetween with metre literals. The fixture is a single 5000 mm
    // beam, 203 mm deep, so any real chord across it lands well within
    // [50, 6000] -- a 1000x error in either direction (metres left
    // unconverted, or millimetres converted twice) would land far outside.
    // The exact figure is camera-dependent (the chord is between two
    // arbitrary surface points) and would be flaky to pin exactly.
    const label = await page.evaluate(() => {
      const viewport = document.getElementById("viewport")!;
      const divs = Array.from(viewport.querySelectorAll("div"));
      for (const d of divs) {
        const t = d.textContent?.trim() ?? "";
        if (/^\d+\s*mm$/.test(t) && d.children.length === 0) return t;
      }
      return null;
    });
    expect(label).toMatch(/^\s*\d+\s*mm\s*$/);
    const mm = Number(label!.match(/\d+/)![0]);
    expect(mm).toBeGreaterThanOrEqual(50);
    expect(mm).toBeLessThanOrEqual(6000);
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

test("a failed native large-file conversion keeps the existing model open", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);

    const before = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      return {
        filename: viewer.getCurrentFilename(),
        beamCount: viewer.getCategories().get("IFCBEAM")?.length ?? 0,
        hasHeightRange: viewer.getModelHeightRange() !== null,
      };
    });

    await app.evaluate(async ({ ipcMain }) => {
      ipcMain.removeHandler("ifc:get-size");
      ipcMain.handle("ifc:get-size", async () => 60 * 1024 * 1024);
      ipcMain.removeHandler("ifc:prepare");
      ipcMain.handle("ifc:prepare", async () => {
        throw new Error("synthetic conversion failure");
      });
    });

    const result = await page.evaluate(async () => {
      const viewer = (window as any).__viewer;
      try {
        await viewer.loadIfcPath("C:/broken.ifc");
        return "resolved";
      } catch (err) {
        return (err as Error).message;
      }
    });

    expect(result).toContain("synthetic conversion failure");
    expect(
      await page.evaluate(() => {
        const viewer = (window as any).__viewer;
        return {
          filename: viewer.getCurrentFilename(),
          beamCount: viewer.getCategories().get("IFCBEAM")?.length ?? 0,
          hasHeightRange: viewer.getModelHeightRange() !== null,
        };
      }),
    ).toEqual(before);
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
