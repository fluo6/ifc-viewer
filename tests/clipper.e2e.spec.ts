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
