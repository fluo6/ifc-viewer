import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { launchViewer, readyWindow } from "./launch";

test("continuous slider input preserves the gesture and tangential position", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => {
      const v = (window as any).__viewer;
      v.setClippingState({ enabled: true, transform: {
        position: { x: 0.12, y: 0.1, z: 0.08 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      } });
    });
    const result = await page.locator("#clipper .clip-slider").evaluate((element) => {
      const slider = element as HTMLInputElement;
      slider.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1 }));
      const value = Number(slider.min) + (Number(slider.max) - Number(slider.min)) * 0.4;
      for (let i = 0; i < 5; i++) {
        slider.value = String(value + i * Number(slider.step));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return { connected: slider.isConnected, offset: Number(slider.value), position: (window as any).__viewer.getClippingState().transform.position };
    });
    expect(result.connected).toBe(true);
    expect(result.position.x).toBeCloseTo(0.12);
    expect(result.position.y).toBeCloseTo(0.1);
    expect(result.position.z).toBeCloseTo(result.offset, 5);
  } finally { await app.close(); }
});

test("held keyboard slider input keeps focus and resumes after keyup", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.locator("#clipper-toggle").click();
    const slider = page.locator("#clipper .clip-slider");
    await slider.focus();
    await slider.evaluate(e => { (window as any).__activeClipSlider = e; });
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("ArrowRight");
    expect(await page.evaluate(() => (window as any).__activeClipSlider.isConnected)).toBe(true);
    await page.keyboard.up("ArrowRight");
    await expect(slider).toBeFocused();
    const before = await slider.inputValue();
    await page.keyboard.press("ArrowLeft");
    await expect(slider).toBeFocused();
    expect(await slider.inputValue()).not.toBe(before);
  } finally { await app.close(); }
});

test("negative box-face scaling follows the pointer and anchors the opposite face", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(async () => {
      const v = (window as any).__viewer;
      v.setClippingState({ enabled: true, showHelper: true, mode: "box", transform: { position: { x: 0, y: 2.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, boxSize: { x: 2, y: 2, z: 2 } });
      await v.world.camera.controls.setLookAt(-8, 7, 6, 0, 2.5, 0, false);
      v.world.camera.controls.update(0);
      v.world.camera.three.updateMatrixWorld();
    });
    const face = await page.evaluate(() => {
      const v = (window as any).__viewer;
      const p = v.activeWidgets[3].position.clone().project(v.world.camera.three);
      const r = v.world.renderer.three.domElement.getBoundingClientRect();
      return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
    });
    await page.mouse.click(face.x, face.y);
    expect(await page.evaluate(() => { const v = (window as any).__viewer; return v.activeWidgets.indexOf(v.selectedWidget); })).toBe(3);
    const p = await gumballPoint(page, "scale-x");
    const end = await gumballPoint(page, "scale-x", { x: 0, y: 0.8, z: 0 });
    const pastMinimum = await gumballPoint(page, "scale-x", { x: 0, y: 2, z: 0 });
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    expect(await page.evaluate(() => (window as any).__viewer.gumball.activeHandle)).toBe("scale-x");
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.move(pastMinimum.x, pastMinimum.y, { steps: 8 });
    await page.mouse.up();
    const after = await page.evaluate(() => (window as any).__viewer.getClippingState());
    expect(after.boxSize.x).toBeCloseTo(0.001, 5);
    expect(after.transform.position.x + after.boxSize.x / 2).toBeCloseTo(1, 5);
  } finally { await app.close(); }
});

async function selectClippingWidget(page: import("playwright").Page) {
  await page.evaluate(() => (window as any).__viewer.setClippingState({ enabled: true, showHelper: true }));
  const point = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const widget = v.activeWidgets[0];
    widget.updateWorldMatrix(true, false);
    const p = widget.position.clone().set(0.3, 0.3, 0);
    widget.localToWorld(p).project(v.world.camera.three);
    const rect = v.world.renderer.three.domElement.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(() => Boolean((window as any).__viewer.gumball?.object.visible))).toBe(true);
}

async function gumballPoint(page: import("playwright").Page, handleName: string, local?: { x: number; y: number; z: number }) {
  return page.evaluate(({ name, local }) => {
    const v = (window as any).__viewer;
    const g = v.gumball;
    g.object.updateWorldMatrix(true, true);
    const handle = g.object.children.find((h: any) => h.userData.handle === name);
    handle.geometry.computeBoundingSphere();
    const p = handle.geometry.boundingSphere.center.clone();
    if (local) p.set(local.x, local.y, local.z);
    handle.localToWorld(p).project(v.world.camera.three);
    const r = v.world.renderer.three.domElement.getBoundingClientRect();
    return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
  }, { name: handleName, local });
}

test("Shift snaps real rotation and translation drags", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await selectClippingWidget(page);
    const before = await page.evaluate(() => (window as any).__viewer.getClippingState());
    const start = await gumballPoint(page, "rotate-z", { x: 0.6 * Math.cos(0.25), y: 0.6 * Math.sin(0.25), z: 0 });
    const end = await gumballPoint(page, "rotate-z", { x: 0.6 * Math.cos(0.55), y: 0.6 * Math.sin(0.55), z: 0 });
    await page.keyboard.down("Shift");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    expect(await page.evaluate(() => (window as any).__viewer.isDraggingGizmo)).toBe(true);
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
    const rotated = await page.evaluate(() => (window as any).__viewer.getClippingState());
    const a = before.transform.rotation, b = rotated.transform.rotation;
    const angle = 2 * Math.acos(Math.min(1, Math.abs(a.x*b.x + a.y*b.y + a.z*b.z + a.w*b.w))) * 180 / Math.PI;
    expect(angle).toBeCloseTo(15, 3);
    const p = await gumballPoint(page, "translate-x");
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 40, p.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    const result = await page.evaluate((position) => {
      const v = (window as any).__viewer;
      const p = v.getClippingState().transform.position;
      const displacement = Math.hypot(p.x-position.x, p.y-position.y, p.z-position.z);
      const step = v.getModelBoundingBox().getSize(v.gumball.object.position.clone()).length() / 200;
      return displacement / step;
    }, rotated.transform.position);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeCloseTo(Math.round(result), 5);
  } finally { await app.close(); }
});

test("real gumball drag stays selected, follows sliders, and Escape restores state", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await selectClippingWidget(page);
    await page.locator("#clipper .clip-slider").focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => (window as any).__viewer.gumball.object.visible)).toBe(true);
    const before = await page.evaluate(() => (window as any).__viewer.getClippingState());
    const p = await gumballPoint(page, "translate-x");
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    expect(await page.evaluate(() => (window as any).__viewer.isDraggingGizmo)).toBe(true);
    expect(await page.evaluate(() => (window as any).__viewer.world.camera.controls.enabled)).toBe(false);
    await page.mouse.move(p.x + 40, p.y, { steps: 8 });
    expect(await page.evaluate(() => (window as any).__viewer.gumball.object.visible)).toBe(true);
    expect(await page.evaluate(() => (window as any).__viewer.getClippingState().transform.position)).not.toEqual(before.transform.position);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).__viewer.getClippingState())).toEqual(before);
    expect(await page.evaluate(() => (window as any).__viewer.world.camera.controls.enabled)).toBe(true);
  } finally { await app.close(); }
});

test("final release coordinates are applied even without a pointermove", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await selectClippingWidget(page);
    const before = await page.evaluate(() => (window as any).__viewer.getClippingState().transform.position.x);
    const p = await gumballPoint(page, "translate-x");
    const end = await gumballPoint(page, "translate-x", { x: 0, y: 1.2, z: 0 });
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    expect(await page.evaluate(() => (window as any).__viewer.gumball.activeHandle)).toBe("translate-x");
    await page.evaluate((point) => {
      const v = (window as any).__viewer;
      v.world.renderer.three.domElement.dispatchEvent(new PointerEvent("pointerup", {
        pointerId: v.gumball.pointerId, clientX: point.x, clientY: point.y, button: 0, isPrimary: true,
      }));
    }, end);
    await page.mouse.up();
    const after = await page.evaluate(() => (window as any).__viewer.getClippingState().transform.position.x);
    expect(after - before).toBeGreaterThan(0.001);
  } finally { await app.close(); }
});

test("the outward normal handle stays visible beyond the cutting plane", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(async () => {
      const v = (window as any).__viewer;
      const center = v.getModelBoundingBox().getCenter(v.world.camera.three.position.clone());
      v.setClippingState({ transform: { position: center, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
      await v.world.camera.controls.setLookAt(center.x + 5, center.y + 5, center.z + 5, center.x, center.y, center.z, false);
      v.world.camera.controls.update(0);
      v.world.camera.three.updateMatrixWorld();
    });
    await selectClippingWidget(page);
    const p = await gumballPoint(page, "translate-z");
    const clip = { x: Math.floor(p.x) - 8, y: Math.floor(p.y) - 8, width: 16, height: 16 };
    const shown = await page.screenshot({ clip });
    await page.evaluate(async () => {
      (window as any).__viewer.gumball.object.visible = false;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const hidden = await page.screenshot({ clip });
    expect(shown.equals(hidden), "the cutting plane also clipped its outward gumball handle").toBe(false);
  } finally { await app.close(); }
});

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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
    const viewport = page.locator("#viewport");
    const baseline = await viewport.screenshot();

    // Cut along X axis
    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelAxisRange("x");
      viewer.setClippingState({
        enabled: true,
        mode: "plane",
        transform: { position: { x: (range.min + range.max) / 2, y: 0, z: 0 }, rotation: { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } },
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
        transform: { position: { x: 0, y: 0, z: (range.min + range.max) / 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
    const viewport = page.locator("#viewport");

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelAxisRange("y");
      viewer.setClippingState({
        enabled: true,
        mode: "plane",
        transform: { position: { x: 0, y: (range.min + range.max) / 2, z: 0 }, rotation: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 } },
      });
    });
    await page.waitForTimeout(500);
    const normalCut = await viewport.screenshot();

    // Flip cut direction
    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      viewer.setClippingState({ transform: { position: viewer.getClippingState().transform.position, rotation: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 } } });
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
    const viewport = page.locator("#viewport");
    const baseline = await viewport.screenshot();

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelAxisRange("y");
      const span = range.max - range.min;
      viewer.setClippingState({
        enabled: true,
        mode: "slice",
        transform: { position: { x: 0, y: (range.min + range.max) / 2, z: 0 }, rotation: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 } },
        sliceDepth: span * 0.4,
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const box = viewer.getModelBoundingBox();
      viewer.setClippingState({
        enabled: true,
        mode: "box",
        transform: { position: box.getCenter(box.min.clone()), rotation: { x: 0, y: 0, z: 0, w: 1 } },
        boxSize: box.getSize(box.max.clone()),
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
    expect(resetState.transform.position.x - resetState.boxSize.x / 2).toBeCloseTo(modelBounds.min.x, 3);
    expect(resetState.transform.position.x + resetState.boxSize.x / 2).toBeCloseTo(modelBounds.max.x, 3);
  } finally {
    await app.close();
  }
});

test("keyboard shortcut 'c' toggles clipping", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
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
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
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
    await page.evaluate(() => (window as any).__viewer.setClippingState({ mode: "plane" }));
    await expect(page.locator("#section-box-panel")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("clipping updates keep the active slider mounted until its drag ends", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
    await page.locator("#clipper-toggle").click();

    const slider = page.locator("#clipper .clip-slider");
    const bounds = await slider.boundingBox();
    expect(bounds).not.toBeNull();

    await slider.evaluate((element) => {
      (window as any).__activeClipSlider = element;
    });
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();

    await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      viewer.setClippingState({ transform: viewer.getClippingState().transform });
    });

    expect(
      await page.evaluate(
        () => document.querySelector("#clipper .clip-slider") === (window as any).__activeClipSlider,
      ),
      "a clipping update replaced the slider while its pointer gesture was active",
    ).toBe(true);

    await page.mouse.up();
  } finally {
    await app.close();
  }
});

test("gumball dragging defers clipper rendering until the drag ends", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
    await selectClippingWidget(page);
    await page.locator("#clipper .clip-slider").evaluate(e => { (window as any).__activeClipSlider = e; });
    const p = await gumballPoint(page, "translate-x");
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 30, p.y, { steps: 8 });
    expect(await page.evaluate(() => document.querySelector("#clipper .clip-slider") === (window as any).__activeClipSlider)).toBe(true);
    await page.mouse.up();
    expect(await page.evaluate(() => document.querySelector("#clipper .clip-slider") !== (window as any).__activeClipSlider)).toBe(true);
  } finally {
    await app.close();
  }
});

test("slice and box planes retain their center and reject exterior points", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const distances = await page.evaluate(() => {
      const v = (window as any).__viewer;
      return ["slice", "box"].map(mode => {
        v.setClippingState({ enabled: true, mode, transform: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, sliceDepth: 2, boxSize: { x: 2, y: 2, z: 2 } });
        return v.activePlanes.map((p: any) => p.normal.x + 2 * p.normal.y + 3 * p.normal.z + p.constant);
      });
    });
    for (const modeDistances of distances) for (const distance of modeDistances) expect(distance).toBeCloseTo(1);
  } finally { await app.close(); }
});

test("clipping state preserves a freely oriented plane transform", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app); page.on('console', msg => console.log('BROWSER:', msg.text()));
    const rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const position = { x: 1, y: 2, z: 3 };
    const state = await page.evaluate(({ position, rotation }) => {
      const viewer = (window as any).__viewer;
      viewer.setClippingState({
        enabled: true,
        mode: "plane",
        transform: { position, rotation },
      });
      return viewer.getClippingState();
    }, { position, rotation });

    expect(state.transform.position).toEqual(position);
    expect(state.transform.rotation).toEqual(rotation);
  } finally {
    await app.close();
  }
});

test("real scale drag updates box dimensions and synchronizes the footer", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await page.evaluate(() => (window as any).__viewer.setClippingState({ mode: "box" }));
    await selectClippingWidget(page);
    await page.getByTitle("Open 3D Section Box sliders panel").click();
    const before = await page.evaluate(() => (window as any).__viewer.getClippingState());
    const p = await gumballPoint(page, "scale-x");
    const target = await gumballPoint(page, "scale-x", { x: 0, y: 0.9, z: 0 });
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    expect(await page.evaluate(() => (window as any).__viewer.isDraggingGizmo)).toBe(true);
    expect(await page.evaluate(() => (window as any).__viewer.gumball.activeHandle)).toBe("scale-x");
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    const after = await page.evaluate(() => (window as any).__viewer.getClippingState());
    expect(after.boxSize.x).not.toBeCloseTo(before.boxSize.x, 5);
    expect(after.boxSize.y).toBe(before.boxSize.y);
    expect(after.transform.rotation).toEqual(before.transform.rotation);
    expect(Number(await page.locator(".box-slider").first().inputValue())).toBeCloseTo(after.boxSize.x, 3);
    await page.evaluate(() => (window as any).__viewer.unloadIfc());
    expect(await page.evaluate(() => Boolean((window as any).__viewer.gumball))).toBe(false);
  } finally { await app.close(); }
});

test("clipping updates reuse helper geometry and registered planes", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    const result = await page.evaluate(() => {
      const v = (window as any).__viewer;
      v.setClippingState({ enabled: true, showHelper: true });
      const widgets = [...v.activeWidgets];
      const planes = [...v.activePlanes];
      for (let i = 0; i < 20; i++) {
        const state = v.getClippingState();
        state.transform.position.y += 0.001;
        v.setClippingState({ transform: state.transform });
      }
      v.setClippingState({ showHelper: true });
      const reused = widgets[0] === v.activeWidgets[0];
      const planesReused = planes[0] === v.activePlanes[0];
      v.setClippingState({ enabled: false });
      return { reused, planesReused, count: v.debugClippingPlaneCount() };
    });
    expect(result.reused).toBe(true);
    expect(result.planesReused).toBe(true);
    expect(result.count).toBe(0);
  } finally { await app.close(); }
});
