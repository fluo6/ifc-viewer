import { expect, test, type Locator, type Page } from "@playwright/test";
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
 * Screenshot once the render stops changing.
 *
 * Every assertion here compares frames, so a frame caught mid camera-fit is
 * indistinguishable from a real difference. Waiting for two identical
 * consecutive frames pins that down properly; a fixed sleep only moves the
 * odds around, and at 500ms it did still flake.
 */
async function settled(page: Page, viewport: Locator): Promise<Buffer> {
  let prev = await viewport.screenshot();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const next = await viewport.screenshot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  throw new Error("render never settled, so no frame comparison here can conclude");
}

test("enabling edges visibly changes the render, and toggling off restores it", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    const baseline = await settled(page, viewport);

    await page.evaluate(() => (window as any).__viewer.setEdges(true));
    expect(
      (await settled(page, viewport)).equals(baseline),
      "the render is unchanged with edges on, so no outlines are being drawn",
    ).toBe(false);

    await page.evaluate(() => (window as any).__viewer.setEdges(false));
    expect(
      (await settled(page, viewport)).equals(baseline),
      "turning edges off did not restore the original render",
    ).toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * CustomEffectsPass ships with its fresnel gloss effect on. It is unrelated to
 * edge detection and fills surfaces seen near edge-on with solid black -- on
 * the i-beam fixture it paints a slab over the grid. Pinned because the
 * library default is on, so this silently returns on any upgrade.
 */
test("the gloss effect stays off, since it paints edge-on surfaces solid black", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => (window as any).__viewer.setEdges(true));
    expect(
      await page.evaluate(() => (window as any).__viewer.debugGlossEnabled()),
    ).toBe(false);
  } finally {
    await app.close();
  }
});

/**
 * The composer renders the scene itself rather than deferring to the plain
 * renderer, so it only honours clipping planes if Postproduction hands them
 * over -- which it does exactly when overrideClippingPlanes stays false.
 */
test("clipping still cuts geometry while edges are on", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    await page.evaluate(() => (window as any).__viewer.setEdges(true));
    const edgedUnclipped = await settled(page, viewport);

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelHeightRange();
      viewer.setClippingPlane(true, (range.min + range.max) / 2);
    });
    expect(
      (await settled(page, viewport)).equals(edgedUnclipped),
      "a mid-height clipping plane changed nothing, so postproduction is ignoring the clipping planes",
    ).toBe(false);
    expect(
      await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount()),
    ).toBe(1);
  } finally {
    await app.close();
  }
});

test("the edges button turns outline rendering on and off", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const btn = page.locator("#edges button");
    const enabled = () =>
      page.evaluate(() => (window as any).__viewer.edgesOn());

    await expect(btn).toHaveText("Edges: OFF");
    expect(await enabled()).toBe(false);

    await btn.click();
    await expect(btn).toHaveText("Edges: ON");
    expect(await enabled()).toBe(true);

    await btn.click();
    await expect(btn).toHaveText("Edges: OFF");
    expect(await enabled()).toBe(false);
  } finally {
    await app.close();
  }
});
