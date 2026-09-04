import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { launchViewer, readyWindow } from "./launch";

const FIXTURE = path.resolve(__dirname, "fixtures/i-beam.ifc");

test("fragments manager is initialized before a model is loaded", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    expect(
      await page.evaluate(() => (window as any).__viewer.debugFragmentsInitialized()),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * The CSS2D label layer is an absolutely-positioned div covering the whole
 * viewport. If it ever stops being pointer-events:none, element selection dies
 * everywhere in the app — so this is pinned rather than assumed.
 */
test("the 2D label layer exists and does not intercept pointer events", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);

    const layer = await page.evaluate(() => {
      const viewport = document.getElementById("viewport")!;
      const divs = [...viewport.children].filter(
        (el) => el.tagName === "DIV" && !el.id,
      );
      return divs.map((el) => getComputedStyle(el).pointerEvents);
    });
    // RendererWith2D appends exactly one unnamed div: the CSS2D layer.
    expect(layer).toContain("none");
    expect(layer.filter((v) => v !== "none")).toHaveLength(0);

    // #dropzone legitimately owns the centre of an *empty* viewport (it gets
    // the "empty" class and pointer-events:auto so drag-and-drop works before
    // a model is loaded). Load the fixture first so the canvas is what's
    // actually under test here.
    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);

    // Whatever sits under the middle of the viewport must be the canvas, not
    // an overlay — this is the precise failure mode being guarded.
    const topmost = await page.evaluate(() => {
      const rect = document.getElementById("viewport")!.getBoundingClientRect();
      const el = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return el?.tagName ?? "none";
    });
    expect(topmost).toBe("CANVAS");
  } finally {
    await app.close();
  }
});

test("selection still works, and the renderer subclass still enables local clipping, with the 2D renderer in place", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);

    // Selection still populates the panel.
    const expressId = await page.evaluate(
      () => (window as any).__viewer.getCategories().get("IFCBEAM")[0],
    );
    await page.evaluate((id) => {
      (window as any).__viewer.onSelection.emit({ fragmentId: "t", expressId: id });
    }, expressId);
    await expect(page.locator("#properties")).toContainText("IfcShapeProfile");

    // The clipper depends on the renderer enabling local clipping. Assert the
    // subclass still does, rather than calling setClippingPlane — that throws
    // for a reason unrelated to this change (verified against the original
    // SimpleRenderer), and asserting a known-broken path would be noise.
    const localClipping = await page.evaluate(
      () => (window as any).__viewer.debugLocalClippingEnabled?.() ?? null,
    );
    expect(localClipping).toBe(true);
  } finally {
    await app.close();
  }
});
