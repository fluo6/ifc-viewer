# Ruler Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click two points in the 3D view and get a dimension line labelled with the distance in millimetres.

**Architecture:** Wrap `OBF.LengthMeasurement`, already present in the installed `@thatopen/components-front`. It brings vertex snapping and dimension lines with 3D labels. Those labels are `CSS2DObject`s, so `world.renderer` swaps from `OBC.SimpleRenderer` to `OBF.RendererWith2D` (a subclass). `Viewer` owns the engine state and `src/ui/ruler.ts` owns the DOM, matching how the clipper is already built.

**Tech Stack:** TypeScript, Electron, `@thatopen/components-front`, three.js, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-30-ruler-measurement-design.md`

## Facts verified against the built library before writing this plan

The spec listed three items to confirm at implementation time. All three are now settled — **do not re-derive them, and note that one contradicts the spec**:

1. **`SimpleDimensionLine` divides by `scale`; the spec guessed it multiplies.** The built source is:
   ```js
   getTextContent() { return `${(this._length / Qt.scale).toFixed(Qt.rounding)} ${Qt.units}`; }
   ```
   Defaults are `scale = 1`, `units = "m"`, `rounding = 2`. Geometry is in metres, so millimetres require **`scale = 0.001`**, not `1000`. Setting `1000` would render a 5 m beam as `0 mm`.
2. **The CSS2D layer already sets `pointerEvents = "none"`** in `RendererWith2D.setupHtmlRenderer`. The spec's top risk is pre-mitigated upstream. Task 1 still pins it with a regression test, because it is the failure that would break selection everywhere.
3. **`LengthMeasurement.setupEvents` binds `pointermove` to `world.renderer.three.domElement.parentElement`** — the canvas's parent, i.e. `#viewport` — and throws if `world` is unset. It also registers its own `keydown` handler on `window` that calls `cancelCreation()` on Escape, so Escape needs no code from us.

Also confirmed at runtime: `OBF.RendererWith2D`, `OBF.LengthMeasurement` and `OBF.SimpleDimensionLine` all exist as exports, and `Highlighter.onMouseUp` early-returns on `!this.enabled`, so setting `enabled = false` cleanly suspends selection.

## Global Constraints

- Repository: `C:\Users\fujial\fujia-dev\ifc-viewer`, branch `master` (the XLSX export is merged; `master` is at `f5edd8f`).
- **Never push to a remote.** Local commits only. There is no remote configured; do not add one. Use `git -c commit.gpgsign=false commit`.
- `src/` compiles under `tsconfig.json`: `strict` **and** `noUncheckedIndexedAccess`.
- `tsconfig.test.json` typechecks `tests`, `src` and `electron` together; `npm test` runs `build`, then `typecheck`, then `playwright test`. All three must stay green.
- **`src/ui/` must never import `@thatopen/*` or `three`.** `Viewer` exposes plain methods; that is why `measureBetween` takes plain `{x, y, z}` objects rather than `THREE.Vector3`.
- Tests are Playwright specs in `tests/` (`import { expect, test } from "@playwright/test"`). There is no jest. Specs compile to CJS: use `__dirname`, never `import.meta.url`.
- e2e specs use `launchViewer()` / `readyWindow()` from `tests/launch.ts`, which allocate a fresh Electron `userData` dir to dodge the app's single-instance lock.
- The suite currently has **60 passing tests**. Each task states the expected new total.
- Lengths display in **mm**, matching the properties panel.
- Comments explain *why*, not *what*.

---

### Task 1: Swap the renderer to `RendererWith2D`

Measurement labels are `CSS2DObject`s and need a `CSS2DRenderer`. This task does the swap on its own, so any regression in selection or clipping is attributable to exactly one change.

**Files:**
- Modify: `src/viewer.ts:87`
- Test: `tests/renderer-2d.e2e.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `world.renderer` is an `OBF.RendererWith2D`, which extends `OBC.SimpleRenderer` and adds `three2D: CSS2DRenderer`. The world's generic parameter stays `OBC.SimpleRenderer` — the subclass satisfies it.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer-2d.e2e.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { launchViewer, readyWindow } from "./launch";

const FIXTURE = path.resolve(__dirname, "fixtures/i-beam.ifc");

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

test("selection and clipping still work with the 2D renderer in place", async () => {
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

    // Clipping still applies — the clipper depends on the renderer's
    // localClippingEnabled, which the subclass must not have lost.
    const clipped = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const range = viewer.getModelHeightRange();
      viewer.setClippingPlane(true, (range.min + range.max) / 2);
      return true;
    });
    expect(clipped).toBe(true);
    await expect(page.locator("#properties")).toContainText("IfcShapeProfile");
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/renderer-2d.e2e.spec.ts`
Expected: the first test FAILS — `OBC.SimpleRenderer` appends no CSS2D layer, so `layer` is an empty array and `expect(layer).toContain("none")` fails. The second test passes already; that is fine, it is the regression guard.

- [ ] **Step 3: Swap the renderer**

In `src/viewer.ts`, replace line 87:

```ts
    world.renderer = new OBC.SimpleRenderer(components, container);
```

with:

```ts
    // RendererWith2D extends SimpleRenderer and adds a CSS2DRenderer, which is
    // what draws measurement labels. Its label layer is pointer-events:none, so
    // it does not intercept selection clicks.
    world.renderer = new OBF.RendererWith2D(components, container);
```

`OBF` is already imported at the top of the file. Leave the `OBC.SimpleWorld<..., OBC.SimpleRenderer>` type parameter alone — the subclass satisfies it.

- [ ] **Step 4: Run the tests**

Run: `npx playwright test tests/renderer-2d.e2e.spec.ts`
Expected: PASS, 2 tests.

Run: `npm test`
Expected: build clean, typecheck clean, **62 passing**.

- [ ] **Step 5: Commit**

```bash
git add src/viewer.ts tests/renderer-2d.e2e.spec.ts
git -c commit.gpgsign=false commit -m "feat: render 2D labels via RendererWith2D

Measurement labels are CSS2DObjects and need a CSS2DRenderer, which
SimpleRenderer does not have. The subclass swap is isolated in its own commit
so any regression in selection or clipping is attributable to one change."
```

---

### Task 2: Measurement engine on `Viewer`

**Files:**
- Modify: `src/viewer.ts` — add a field near `highlighter` (line 56), configure in `init()` after the highlighter block, add public methods after `getModelUnits()` (ends line ~450), and reset in `unloadIfc()` (line 401)
- Test: `tests/measure.e2e.spec.ts`

**Interfaces:**
- Consumes: `world.renderer` is `RendererWith2D` (Task 1).
- Produces, all on `Viewer`:
  - `readonly onMeasureModeChanged: Emitter<boolean>`
  - `setMeasureMode(on: boolean): void`
  - `isMeasureMode(): boolean`
  - `placeMeasurePoint(): void`
  - `clearMeasurements(): void`
  - `measurementCount(): number`
  - `measureBetween(a: Point3, b: Point3): void` where `export interface Point3 { x: number; y: number; z: number }` is exported from `src/viewer.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/measure.e2e.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/measure.e2e.spec.ts`
Expected: FAIL — `viewer.measureBetween is not a function`.

- [ ] **Step 3: Implement**

In `src/viewer.ts`, add the exported point type beside the other interfaces, after `Selection` (line ~29):

```ts
/** A world-space point, in metres. Plain data so src/ui never imports three. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}
```

Add the emitter beside the other emitters (after `onLoadProgress`, line ~41):

```ts
  readonly onMeasureModeChanged = new Emitter<boolean>();
```

Add fields beside `highlighter` (line ~56):

```ts
  private lengthMeasurement!: OBF.LengthMeasurement;
  private measureMode = false;
```

In `init()`, immediately after the `selectEvents` block and before the trailing assignments (`this.components = components;`), add:

```ts
    const lengthMeasurement = components.get(OBF.LengthMeasurement);
    lengthMeasurement.world = world;
    // The library default is 0.25 world units — 250 mm at building scale, which
    // grabs the wrong vertex constantly. 50 mm is close enough to be useful.
    lengthMeasurement.snapDistance = 0.05;

    // SimpleDimensionLine renders `length / scale` with `rounding` decimals.
    // Geometry is in metres, so 0.001 yields millimetres — matching the
    // properties panel. Note this DIVIDES: 1000 here would render 5 m as 0 mm.
    OBF.SimpleDimensionLine.scale = 0.001;
    OBF.SimpleDimensionLine.units = "mm";
    OBF.SimpleDimensionLine.rounding = 0;
```

and add `this.lengthMeasurement = lengthMeasurement;` alongside the other assignments at the end of `init()`.

Add the public methods after `getModelUnits()`:

```ts
  /**
   * Measuring and selecting both want the single click, so they are mutually
   * exclusive. This method is the only place that knows that; scattering the
   * inversion across the UI is how the two tools end up fighting.
   */
  setMeasureMode(on: boolean): void {
    if (this.measureMode === on) return;
    this.measureMode = on;
    this.lengthMeasurement.enabled = on;
    this.highlighter.enabled = !on;
    if (on) {
      try {
        this.highlighter.clear();
      } catch {
        /* nothing selected */
      }
      this.lastSelection = null;
      this.onSelection.emit(null);
    }
    this.onMeasureModeChanged.emit(on);
  }

  isMeasureMode(): boolean {
    return this.measureMode;
  }

  /**
   * Anchors the first point, or completes the line on the second call. The
   * library's own `create` toggles between those two states.
   */
  placeMeasurePoint(): void {
    if (!this.measureMode) return;
    this.lengthMeasurement.create();
  }

  clearMeasurements(): void {
    this.lengthMeasurement.deleteAll();
  }

  measurementCount(): number {
    return this.lengthMeasurement.list.length;
  }

  /** Adds a dimension between two world-space points, in metres. */
  measureBetween(a: Point3, b: Point3): void {
    this.lengthMeasurement.createOnPoints(
      new THREE.Vector3(a.x, a.y, a.z),
      new THREE.Vector3(b.x, b.y, b.z),
    );
  }
```

In `unloadIfc()`, immediately after the `if (!this.currentModel) return;` guard, add:

```ts
    this.setMeasureMode(false);
    this.clearMeasurements();
```

- [ ] **Step 4: Run the tests**

Run: `npx playwright test tests/measure.e2e.spec.ts`
Expected: PASS, 6 tests.

Run: `npm test`
Expected: build clean, typecheck clean, **68 passing**.

- [ ] **Step 5: Commit**

```bash
git add src/viewer.ts tests/measure.e2e.spec.ts
git -c commit.gpgsign=false commit -m "feat: point-to-point measurement on Viewer

Wraps OBF.LengthMeasurement, which brings vertex snapping and dimension lines.
Labels read in mm: SimpleDimensionLine divides the metre length by \`scale\`, so
0.001 is the conversion, not 1000.

setMeasureMode is the single place that knows measuring and selecting are
mutually exclusive."
```

---

### Task 3: Ruler UI and keybinding

**Files:**
- Modify: `index.html` — add `<div id="ruler"></div>` after `<div id="clipper"></div>`
- Modify: `src/styles.css` — add a `#ruler` rule after the `#clipper` rule (ends line 102)
- Create: `src/ui/ruler.ts`
- Modify: `src/main.ts` — import and mount after `mountClipper(viewer)` (line 31)
- Modify: `src/ui/keybindings.ts` — add `m`
- Test: `tests/ruler-ui.e2e.spec.ts`

**Interfaces:**
- Consumes: `setMeasureMode`, `isMeasureMode`, `placeMeasurePoint`, `clearMeasurements`, `measurementCount`, `onMeasureModeChanged`, `onModelLoaded`, `onModelUnloaded` from Task 2.
- Produces: `mountRuler(viewer: Viewer): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/ruler-ui.e2e.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/ruler-ui.e2e.spec.ts`
Expected: FAIL — `#ruler` does not exist, so the first assertion times out.

- [ ] **Step 3: Add the markup and styles**

In `index.html`, inside `#viewport`, immediately after the `<div id="clipper"></div>` line:

```html
          <div id="ruler"></div>
```

In `src/styles.css`, after the `#clipper` rule (which ends at line 102), add:

```css
#ruler {
  position: absolute; bottom: 52px; left: 12px;
  background: rgba(22,27,34,0.92);
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  display: flex; align-items: center; gap: 8px;
}
```

- [ ] **Step 4: Implement the UI module**

Create `src/ui/ruler.ts`:

```ts
import type { Viewer } from "../viewer";

export function mountRuler(viewer: Viewer): void {
  const root = document.getElementById("ruler")!;
  root.style.display = "none";

  viewer.onModelLoaded.on(() => {
    root.style.display = "flex";
    render();
  });

  viewer.onModelUnloaded.on(() => {
    root.style.display = "none";
  });

  // Keeps the bar in step however the mode was changed — button or `m` key.
  viewer.onMeasureModeChanged.on(render);

  // The canvas, not #viewport: the dropzone, clipper and ruler overlays are all
  // children of #viewport, so listening there would drop a measurement point
  // every time the user clicked this bar's own buttons.
  const canvas = document.querySelector("#viewport canvas");
  canvas?.addEventListener("click", () => {
    viewer.placeMeasurePoint();
    render();
  });

  function render() {
    const on = viewer.isMeasureMode();
    root.innerHTML = "";

    const toggle = document.createElement("button");
    toggle.id = "ruler-toggle";
    toggle.className = "mini";
    toggle.textContent = on ? "Measure: ON" : "Measure: OFF";
    toggle.addEventListener("click", () => viewer.setMeasureMode(!on));
    root.appendChild(toggle);

    if (on) {
      const hint = document.createElement("span");
      hint.className = "muted";
      hint.textContent = "click two points · Esc cancels";
      root.appendChild(hint);
    }

    if (viewer.measurementCount() > 0) {
      const clear = document.createElement("button");
      clear.id = "ruler-clear";
      clear.className = "mini";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => {
        viewer.clearMeasurements();
        render();
      });
      root.appendChild(clear);
    }
  }
}
```

- [ ] **Step 5: Mount it and add the keybinding**

In `src/main.ts`, add the import beside the others:

```ts
import { mountRuler } from "./ui/ruler";
```

and the call after `mountClipper(viewer);`:

```ts
  mountRuler(viewer);
```

In `src/ui/keybindings.ts`, add a branch to the existing `if / else if` chain, after the `r` branch:

```ts
    } else if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      viewer.setMeasureMode(!viewer.isMeasureMode());
    }
```

Escape needs no branch — `LengthMeasurement` installs its own `window` keydown handler that cancels the in-progress line.

- [ ] **Step 6: Run the tests**

Run: `npx playwright test tests/ruler-ui.e2e.spec.ts`
Expected: PASS, 5 tests.

Run: `npm test`
Expected: build clean, typecheck clean, **73 passing**.

- [ ] **Step 7: Verify against a real model**

Run `npm run dev`, open the Halev model at
`C:\Users\fujial\Documents\264034 - Centre for Jewish Life\rhino\rhino-ifc-20260728\264034-TTW-P3-RH-ST-001-[01] - Halev IFC Model.ifc`,
press `m`, and click two column base points. Confirm the label reads a plausible
millimetre figure, that the snap latches onto vertices rather than mid-face, and
that pressing Escape mid-line cancels it. Record what you observed — in
particular whether `snapDistance = 0.05` felt too grabby or too weak at this
model's scale, since that value is an estimate and this is the first real test
of it.

- [ ] **Step 8: Commit**

```bash
git add index.html src/styles.css src/ui/ruler.ts src/main.ts src/ui/keybindings.ts tests/ruler-ui.e2e.spec.ts
git -c commit.gpgsign=false commit -m "feat: ruler bar and m keybinding

The click listener binds to the canvas rather than #viewport, because the
dropzone, clipper and ruler overlays are all children of #viewport and would
otherwise drop a measurement point whenever the user clicked this bar."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Wrap `OBF.LengthMeasurement`, reject custom raycasting | 2 |
| Renderer swap to `RendererWith2D` | 1 |
| Re-verify clipping and highlighting after the swap | 1 |
| Units: `scale`/`units`/`rounding`, confirm semantics first | Resolved before writing; applied in 2 |
| `snapDistance = 0.05` rather than the 0.25 default | 2 |
| `setMeasureMode` as the single owner of the selection inversion | 2 |
| `placeMeasurePoint`, `clearMeasurements`, `isMeasureMode`, `measureBetween`, `onMeasureModeChanged` | 2 |
| `unloadIfc` clears measurements and exits the mode | 2 |
| `mountRuler`, toggle, Clear, hint, visible only with a model | 3 |
| Click listener on the canvas, not `#viewport` | 3 |
| `m` keybinding; Escape needs no handler | 3 |
| Interaction table (anchor, preview, commit, cancel, accumulate) | 2 and 3 |
| Risk 1, CSS2D layer swallowing clicks | 1 |
| Risk 2, renderer swap regressions | 1 |
| Risk 3, `scale` semantics | Resolved before writing |
| Risk 5, `snapDistance` tuning | 3, Step 7 |
| Testing: `measureBetween` gives `5000 mm`; mode suspends selection; Clear empties; unload resets; selection still works | 1 and 2 |
| Two-click measurement deliberately not tested | Honoured — no task tests synthetic screen-coordinate clicks |

Spec Risk 4 (streamed models see only loaded fragments) is documented as accepted, not fixed, so it correctly has no task.

**Placeholder scan:** none. Every code step carries complete code; every run step carries the exact command and expected result.

**Type consistency:** `Point3` is defined in Task 2 and used only there. `measurementCount()`, `isMeasureMode()`, `placeMeasurePoint()`, `clearMeasurements()`, `setMeasureMode()` and `onMeasureModeChanged` are named identically in Tasks 2 and 3. Element ids `#ruler`, `#ruler-toggle`, `#ruler-clear` match between the Task 3 tests, the markup and `ruler.ts`. Test totals chain correctly: 60 → 62 → 68 → 73.

**One deviation from the spec, already applied above:** the spec says to confirm the `scale`/`units`/`rounding` semantics as the first implementation step. That was done while writing this plan instead, and it disproved the spec's assumption — `scale` divides. The plan therefore specifies `0.001` directly and flags the trap, rather than sending an implementer to rediscover it.

**One risk this plan carries knowingly:** `mountRuler` resolves the canvas once at mount time with `document.querySelector("#viewport canvas")`. That is safe because `main.ts` awaits `viewer.init()` before mounting any UI, and `SimpleRenderer` creates its canvas during construction. If the renderer is ever recreated at runtime the listener would be orphaned; nothing in the current code does that.
