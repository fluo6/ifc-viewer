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

    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("COLOR");

    const baseline = await settled(page, viewport);

    await page.evaluate(() => (window as any).__viewer.setEdges(true));
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("COLOR_PEN");
    expect(
      (await settled(page, viewport)).equals(baseline),
      "the render is unchanged with edges on, so no outlines are being drawn",
    ).toBe(false);

    await page.evaluate(() => (window as any).__viewer.setEdges(false));
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("COLOR");
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
    const btn = page.getByRole("button", { name: /^Edges:/ });
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

test("enabling hidden lines visibly changes the render, and toggling off restores normal", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    const normal = await settled(page, viewport);

    await page.evaluate(() => (window as any).__viewer.setHiddenLines(true));
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("PEN");
    const pen = await settled(page, viewport);
    expect(pen.equals(normal)).toBe(false);

    await page.evaluate(() => (window as any).__viewer.setHiddenLines(false));
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("COLOR");
    expect((await settled(page, viewport)).equals(normal)).toBe(true);
  } finally {
    await app.close();
  }
});

test("hidden lines restores edge rendering when edges was on", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    await page.evaluate(() => (window as any).__viewer.setEdges(true));
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("COLOR_PEN");
    const edged = await settled(page, viewport);

    await page.evaluate(() => (window as any).__viewer.setHiddenLines(true));
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("PEN");
    const pen = await settled(page, viewport);
    expect(pen.equals(edged)).toBe(false);

    await page.evaluate(() => (window as any).__viewer.setHiddenLines(false));
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("COLOR_PEN");
    expect((await settled(page, viewport)).equals(edged)).toBe(true);
  } finally {
    await app.close();
  }
});

test("clipping still cuts geometry while hidden lines are on", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const viewport = page.locator("#viewport");

    await page.evaluate(() => (window as any).__viewer.setHiddenLines(true));
    const penUnclipped = await settled(page, viewport);

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelHeightRange();
      viewer.setClippingPlane(true, (range.min + range.max) / 2);
    });
    expect(
      (await settled(page, viewport)).equals(penUnclipped),
      "a mid-height clipping plane changed nothing in hidden-lines mode",
    ).toBe(false);
    expect(
      await page.evaluate(() => (window as any).__viewer.debugClippingPlaneCount()),
    ).toBe(1);
  } finally {
    await app.close();
  }
});

test("the hidden lines button toggles hidden line rendering on and off and preserves edges state", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const edgesBtn = page.getByRole("button", { name: /^Edges:/ });
    const hiddenLinesBtn = page.getByRole("button", { name: /^Hidden lines:/ });

    await expect(edgesBtn).toHaveText("Edges: OFF");
    await expect(hiddenLinesBtn).toHaveText("Hidden lines: OFF");

    await hiddenLinesBtn.click();
    await expect(hiddenLinesBtn).toHaveText("Hidden lines: ON");
    expect(
      await page.evaluate(() => (window as any).__viewer.hiddenLinesOn()),
    ).toBe(true);
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("PEN");

    // Toggle edges on while hidden lines is active
    await edgesBtn.click();
    await expect(edgesBtn).toHaveText("Edges: ON");
    expect(
      await page.evaluate(() => (window as any).__viewer.edgesOn()),
    ).toBe(true);
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("PEN");

    // Toggle hidden lines off: style should restore to COLOR_PEN
    await hiddenLinesBtn.click();
    await expect(hiddenLinesBtn).toHaveText("Hidden lines: OFF");
    expect(
      await page.evaluate(() => (window as any).__viewer.hiddenLinesOn()),
    ).toBe(false);
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("COLOR_PEN");

    // Toggle edges off: style restores to COLOR
    await edgesBtn.click();
    await expect(edgesBtn).toHaveText("Edges: OFF");
    expect(
      await page.evaluate(() => (window as any).__viewer.edgesOn()),
    ).toBe(false);
    expect(
      await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()),
    ).toBe("COLOR");
  } finally {
    await app.close();
  }
});
