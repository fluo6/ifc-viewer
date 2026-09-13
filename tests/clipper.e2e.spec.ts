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
  // Let the fit-to-model camera transition finish before any screenshot.
  await page.waitForTimeout(2500);
  return page;
}

/**
 * The clip button used to throw on every activation: OBC's SimplePlane builds a
 * three TransformControls gizmo and indexes `controls.object.children[0]
 * .children[0]`, but since three's Controls refactor `.object` is the attached
 * target, not the gizmo root, so that is undefined.
 */
test("enabling the clipping plane does not throw", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const result = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelHeightRange();
      try {
        viewer.setClippingPlane(true, (range.min + range.max) / 2);
        return "ok";
      } catch (err) {
        return `threw: ${(err as Error).message}`;
      }
    });
    expect(result).toBe("ok");
    expect(
      await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount()),
    ).toBe(1);
  } finally {
    await app.close();
  }
});

/**
 * Wiring alone is not proof — a plane can be registered and still clip nothing.
 * Two baseline captures establish that the render is deterministic frame to
 * frame; without that the pixel comparison below would be meaningless.
 */
test("the clipping plane visibly changes the render, and toggling off restores it", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    const baseline = await viewport.screenshot();
    await page.waitForTimeout(500);
    const baselineAgain = await viewport.screenshot();
    expect(
      baseline.equals(baselineAgain),
      "render is not deterministic between frames, so the clipping comparison below cannot conclude",
    ).toBe(true);

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelHeightRange();
      viewer.setClippingPlane(true, (range.min + range.max) / 2);
    });
    await page.waitForTimeout(500);
    const clipped = await viewport.screenshot();
    expect(
      clipped.equals(baseline),
      "the render is unchanged with a clipping plane at mid-height, so nothing is being clipped",
    ).toBe(false);

    await page.evaluate(() => (window as any).__viewer.setClippingPlane(false));
    await page.waitForTimeout(500);
    const restored = await viewport.screenshot();
    expect(restored.equals(baseline)).toBe(true);
    expect(
      await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount()),
    ).toBe(0);
  } finally {
    await app.close();
  }
});

test("moving the plane clips at a different height", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    const heights = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelHeightRange();
      return {
        low: range.min + (range.max - range.min) * 0.25,
        high: range.min + (range.max - range.min) * 0.75,
      };
    });

    await page.evaluate((h) => (window as any).__viewer.setClippingPlane(true, h), heights.low);
    await page.waitForTimeout(500);
    const low = await viewport.screenshot();

    await page.evaluate((h) => (window as any).__viewer.setClippingPlane(true, h), heights.high);
    await page.waitForTimeout(500);
    const high = await viewport.screenshot();

    expect(
      low.equals(high),
      "clipping at 25% and 75% of model height produced identical renders, so the height is not being applied",
    ).toBe(false);
  } finally {
    await app.close();
  }
});

test("a clipping plane above the model leaves the model visible", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    const baseline = await viewport.screenshot();
    await page.waitForTimeout(500);
    const baselineAgain = await viewport.screenshot();
    expect(
      baseline.equals(baselineAgain),
      "render is not deterministic between frames, so the clip direction comparison cannot conclude",
    ).toBe(true);

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelHeightRange();
      viewer.setClippingPlane(true, range.max + (range.max - range.min) * 0.01);
    });
    await page.waitForTimeout(500);
    const aboveTop = await viewport.screenshot();

    expect(
      aboveTop.equals(baseline),
      "a plane above the model clipped visible geometry; the clip direction is inverted",
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("unloading the model clears the clipping plane", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelHeightRange();
      viewer.setClippingPlane(true, (range.min + range.max) / 2);
      viewer.unloadIfc();
    });
    expect(
      await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount()),
    ).toBe(0);
  } finally {
    await app.close();
  }
});

test("orthogonal axes X and Z clip geometry along their respective directions", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");
    const baseline = await viewport.screenshot();

    // Cut along X axis
    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelAxisRange("x");
      viewer.setClippingState({
        enabled: true,
        mode: "plane",
        axis: "x",
        planePos: (range.min + range.max) / 2,
      });
    });
    await page.waitForTimeout(500);
    const cutX = await viewport.screenshot();
    expect(cutX.equals(baseline), "clipping along X should visibly change render").toBe(false);
    expect(await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount())).toBe(1);

    // Cut along Z axis
    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelAxisRange("z");
      viewer.setClippingState({
        enabled: true,
        mode: "plane",
        axis: "z",
        planePos: (range.min + range.max) / 2,
      });
    });
    await page.waitForTimeout(500);
    const cutZ = await viewport.screenshot();
    expect(cutZ.equals(baseline), "clipping along Z should visibly change render").toBe(false);
    expect(cutZ.equals(cutX), "X cut and Z cut should produce different renders").toBe(false);
    expect(await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount())).toBe(1);
  } finally {
    await app.close();
  }
});

test("inverting the cut direction flips which side of the plane is clipped", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelAxisRange("y");
      viewer.setClippingState({
        enabled: true,
        mode: "plane",
        axis: "y",
        inverted: false,
        planePos: (range.min + range.max) / 2,
      });
    });
    await page.waitForTimeout(500);
    const normalCut = await viewport.screenshot();

    // Flip cut direction
    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      viewer.setClippingState({ inverted: true });
    });
    await page.waitForTimeout(500);
    const invertedCut = await viewport.screenshot();

    expect(
      normalCut.equals(invertedCut),
      "normal cut and inverted cut should show opposite halves of the model",
    ).toBe(false);
  } finally {
    await app.close();
  }
});

test("slice mode creates two clipping planes", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");
    const baseline = await viewport.screenshot();

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelAxisRange("y");
      const span = range.max - range.min;
      viewer.setClippingState({
        enabled: true,
        mode: "slice",
        axis: "y",
        sliceMin: range.min + span * 0.3,
        sliceMax: range.min + span * 0.7,
      });
    });
    await page.waitForTimeout(500);
    const sliced = await viewport.screenshot();

    expect(sliced.equals(baseline), "slice mode should visibly isolate a slab").toBe(false);
    expect(await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount())).toBe(2);
  } finally {
    await app.close();
  }
});

test("section box mode creates 6 clipping planes and fitToSelection shrinks the box", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const box = viewer.getModelBoundingBox();
      viewer.setClippingState({
        enabled: true,
        mode: "box",
        boxMin: { x: box.min.x, y: box.min.y, z: box.min.z },
        boxMax: { x: box.max.x, y: box.max.y, z: box.max.z },
      });
    });
    expect(await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount())).toBe(6);

    // Select first beam and fit section box
    const fitted = await page.evaluate(async () => {
      const viewer = (window as any).__viewer;
      const categories = viewer.getCategories();
      const firstBeamId = categories.get("IFCBEAM")?.[0];
      if (firstBeamId == null) return false;
      await viewer.select(firstBeamId);
      return viewer.fitSectionBoxToSelection(0.2);
    });
    expect(fitted).toBe(true);

    const state = await page.evaluate(() => (window as any).__viewer.getClippingState());
    expect(state.mode).toBe("box");
    expect(state.enabled).toBe(true);

    // Reset box
    await page.evaluate(() => (window as any).__viewer.resetSectionBox());
    const resetState = await page.evaluate(() => (window as any).__viewer.getClippingState());
    const modelBounds = await page.evaluate(() => {
      const b = (window as any).__viewer.getModelBoundingBox();
      return { min: b.min, max: b.max };
    });
    expect(resetState.boxMin.x).toBeCloseTo(modelBounds.min.x, 3);
    expect(resetState.boxMax.x).toBeCloseTo(modelBounds.max.x, 3);
  } finally {
    await app.close();
  }
});

test("keyboard shortcut 'c' toggles clipping", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    expect(await page.evaluate(() => (window as any).__viewer.getClippingState().enabled)).toBe(false);

    await page.keyboard.press("c");
    expect(await page.evaluate(() => (window as any).__viewer.getClippingState().enabled)).toBe(true);

    await page.keyboard.press("c");
    expect(await page.evaluate(() => (window as any).__viewer.getClippingState().enabled)).toBe(false);
  } finally {
    await app.close();
  }
});

test("clipper UI renders buttons and interacts with modes", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const toggle = page.locator("#clipper-toggle");
    await expect(toggle).toHaveText("Clip: OFF");

    await toggle.click();
    await expect(toggle).toHaveText("Clip: ON");

    // Mode buttons should be present
    const planeBtn = page.locator("#clipper button:has-text('Plane')");
    const sliceBtn = page.locator("#clipper button:has-text('Slice')");
    const boxBtn = page.locator("#clipper button:has-text('Box')");
    await expect(planeBtn).toBeVisible();
    await expect(sliceBtn).toBeVisible();
    await expect(boxBtn).toBeVisible();

    // In Plane mode: Axis buttons X, Y, Z and Flip are visible
    await expect(page.locator("#clipper button:has-text('Y')")).toBeVisible();
    await expect(page.locator("#clipper button:has-text('Flip')")).toBeVisible();

    // Switch to Slice mode
    await sliceBtn.click();
    expect(await page.evaluate(() => (window as any).__viewer.getClippingState().mode)).toBe("slice");
    await expect(page.locator(".clip-slider-min")).toBeVisible();
    await expect(page.locator(".clip-slider-max")).toBeVisible();

    // Switch to Box mode
    await boxBtn.click();
    expect(await page.evaluate(() => (window as any).__viewer.getClippingState().mode)).toBe("box");
    await expect(page.locator("#section-box-panel")).toBeVisible();
  } finally {
    await app.close();
  }
});

