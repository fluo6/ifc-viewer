# Rhino-Style Clipping Gumball Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Rhino-style selectable clipping widgets with a combined move/planar-move/rotate/scale gumball for plane, slice, and section-box modes.

**Architecture:** Keep `Viewer.clipState` as plain serializable source of truth. Add one reusable `ClippingGumball` scene controller that owns handle meshes and pointer math but never owns clipping state. `Viewer` derives renderer planes and widget visuals from state; `clipper.ts` remains the precise numeric editor and defers DOM replacement during gestures.

**Tech Stack:** TypeScript, Three.js 0.184.0, existing `@thatopen/components` renderer, Playwright Electron tests, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-16-rhino-style-clipping-gumball-design.md`

## Global Constraints

- Add no dependency.
- `Viewer.clipState` remains the single source of truth.
- Keep one gumball instance and reuse clipping planes, helpers, geometries, materials, and handles during pointer movement.
- The selected boundary alone shows the combined gumball; unselected widgets remain selectable while helpers are enabled.
- Preserve footer precision controls and X/Y/Z orientation presets.
- Do not implement clipping-object collections, Alt-drag duplication, object snaps, named views, hatching, or unrelated Rhino tools.
- Every production behavior added below gets a real regression test before completion.

---

### Task 1: Replace axis-only clipping state with an oriented transform

**Files:**
- Modify: `src/viewer.ts:30-65, 178-188, 1330-1390` — replace scalar clipping fields with serializable transform, dimensions, validation, and model/mode initialization.
- Modify: `tests/clipper.e2e.spec.ts` — add state and plane-orientation regression coverage.

**Interfaces:**
- `QuaternionData = { x: number; y: number; z: number; w: number }`.
- `ClipTransform = { position: Point3; rotation: QuaternionData }`.
- `ClippingState = { enabled, mode, transform, planeSize, sliceDepth, boxSize, showHelper }`.
- `setClippingState(updates: Partial<ClippingState>): void` continues to be the write boundary.
- `getClippingState(): Readonly<ClippingState>` returns a defensive top-level copy.

- [ ] **Step 1: Write the failing state test**

Add a browser test that loads the fixture, sets an oriented plane state with a non-identity quaternion, and asserts the public state preserves the literal position and quaternion:

```ts
test("clipping state preserves a freely oriented plane transform", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await loaded(app);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "freely oriented plane transform"`

Expected: FAIL because the current state has no `transform` field and the update is not represented.

- [ ] **Step 3: Implement the minimal state migration**

In `src/viewer.ts`:

1. Replace `axis`, `inverted`, `planePos`, `sliceMin`, `sliceMax`, `boxMin`, and `boxMax` with `transform`, `planeSize`, `sliceDepth`, and `boxSize`.
2. Initialize the default transform so local +Z points along the existing Y clipping direction, centered on the model.
3. Update model initialization, `clearClipping`, reset, fit, and `setClippingPlane` to write the new fields.
4. Validate updates before storing them: reject non-finite position/dimension values, normalize non-zero quaternions, replace a zero quaternion with identity, clamp depth/dimensions to a model-scale epsilon.
5. Preserve mode switching by retaining position/orientation and initializing destination-mode dimensions from the model when absent.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "freely oriented plane transform"`

Expected: PASS.

- [ ] **Step 5: Commit the state migration**

```bash
git add src/viewer.ts tests/clipper.e2e.spec.ts
git commit -m "refactor: store clipping orientation as a transform"
```

### Task 2: Add the reusable combined clipping gumball

**Files:**
- Create: `src/clipping-gumball.ts` — reusable handle geometry, selection, pointer capture, transform math, snapping, cancel, and lifecycle.
- Modify: `tests/clipper.e2e.spec.ts` — focused controller behavior using the real Electron renderer and pointer events.

**Interfaces:**

```ts
export type GumballHandle =
  | "translate-x" | "translate-y" | "translate-z"
  | "plane-xy" | "plane-yz" | "plane-xz"
  | "rotate-x" | "rotate-y" | "rotate-z"
  | "scale-x" | "scale-y" | "scale-z";

export interface GumballTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export interface ClippingGumballOptions {
  camera: THREE.Camera;
  domElement: HTMLElement;
  scene: THREE.Scene;
  onStart: (handle: GumballHandle, snapshot: GumballTransform) => void;
  onChange: (transform: GumballTransform, handle: GumballHandle, snapped: boolean) => void;
  onEnd: () => void;
  onCancel: (snapshot: GumballTransform) => void;
}

export class ClippingGumball {
  readonly object: THREE.Group;
  attach(transform: GumballTransform, pivot?: THREE.Vector3): void;
  detach(): void;
  setVisible(visible: boolean): void;
  update(transform: GumballTransform): void;
  cancel(): void;
  dispose(): void;
}
```

- [ ] **Step 1: Write failing transform-controller tests**

Add these cases to `tests/clipper.e2e.spec.ts`, using the existing `launchViewer` and `loaded` helpers so the tests exercise the real Electron renderer, canvas, camera, and gumball:

```ts
test("dragging a gumball translation handle updates the clipping transform", async () => {
  const app = await launchViewer();
  try {
    const page = await loaded(app);
    await enableClippingHelpers(page);
    const before = await page.evaluate(() => (window as any).__viewer.getClippingState().transform);
    await dragVisibleGumballHandle(page, "translate-z", { x: 0, y: -80 });
    const after = await page.evaluate(() => (window as any).__viewer.getClippingState().transform);
    expect(after.position.z).not.toBe(before.position.z);
  } finally {
    await app.close();
  }
});
```

Implement `enableClippingHelpers` and `dragVisibleGumballHandle` in the test file using the visible helper toggle, `boundingBox()`, `page.mouse`, and the gumball handle's stable `userData.handle` projection exposed by the viewer test surface. Also assert rotation changes the quaternion, Shift snapping rounds rotation to 5 degrees and translation to the model snap increment, Esc restores the exact start snapshot, and pointer-up completes once.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "gumball translation handle|gumball rotation|gumball cancel"`

Expected: FAIL because `src/clipping-gumball.ts` does not exist and the current proxy controls expose no selectable combined handles.

- [ ] **Step 3: Implement the minimum controller**

Build one `THREE.Group` containing reusable arrow cones/shafts, planar squares, rotation arcs, and scale boxes. Use one `THREE.Raycaster` and one pointer listener set on `domElement`.

Implement these rules:

1. Raycast handle meshes before model/widget selection.
2. On pointer-down, copy position/quaternion/scale into a snapshot, identify the handle, call `onStart`, and call `setPointerCapture`.
3. Project pointer movement onto the selected axis/plane; apply translation, quaternion rotation, or scale to the attached transform.
4. If Shift is held, round translation to `modelDiagonal / 200` and rotation to `Math.PI / 36`.
5. On pointer-move, call `onChange` without allocating scene objects.
6. On pointer-up, release capture and call `onEnd` exactly once.
7. On Escape, pointer-cancel, blur, or `cancel()`, restore the snapshot and call `onCancel`.
8. Keep handle size screen-stable by updating the group scale from camera distance during `update`.
9. `dispose()` removes listeners and disposes all owned geometries/materials exactly once.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "gumball translation handle|gumball rotation|gumball cancel"`

Expected: all controller tests PASS with no leaked listeners or duplicate completion callbacks.

- [ ] **Step 5: Commit the gumball controller**

```bash
git add src/clipping-gumball.ts tests/clipping-gumball.spec.ts
git commit -m "feat: add combined clipping gumball controller"
```

### Task 3: Integrate selectable widgets, gumball transforms, and renderer planes

**Files:**
- Modify: `src/viewer.ts:1500-1635` — replace cached `TransformControls` gizmos with reusable clipping widget groups and `ClippingGumball` integration.
- Modify: `tests/clipper.e2e.spec.ts` — add selection, direct manipulation, rotation, slice, box, and cancellation coverage.

**Interfaces:**
- Viewer owns `selectedClipBoundary: { mode: ClipMode; index: number } | null`.
- Viewer owns `gumballDragging: boolean` and exposes `get isDraggingGizmo(): boolean`.
- Viewer maps gumball callbacks to `setClippingState` and emits one final `onClippingChanged` after drag completion.
- Existing `getClippingState`, `setClippingState`, `onClippingChanged`, `setClippingPlane`, `fitSectionBoxToSelection`, and `resetSectionBox` remain public.

- [ ] **Step 1: Write failing end-to-end tests**

Add tests that load the fixture, enable helpers, and verify:

```ts
test("selecting a clipping boundary shows one combined gumball", async () => {
  // Click the visible plane widget, then assert the gumball group is visible
  // and only one gumball is attached even when the mode has multiple boundaries.
});

test("rotating the selected clipping plane changes its normal", async () => {
  // Drag the rotation ring and assert transform.rotation changes and the
  // active clipping plane still exists.
});

test("box rotation preserves six orthogonal clipping planes", async () => {
  // Rotate the selected box and assert plane count remains six and each local
  // axis pair remains perpendicular after the transform.
});
```

Also cover empty-click deselection, plane scaling changing only `planeSize`, slice boundary movement preserving parallel normals, box-face normal translation keeping the opposite face fixed, and Esc restoring the pre-drag state.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "combined gumball|selected clipping plane|box rotation"`

Expected: FAIL because the current invisible proxy gizmos are not selectable clipping widgets and cannot rotate arbitrary planes.

- [ ] **Step 3: Implement viewer integration**

1. Replace per-boundary `TransformControls` creation with one `ClippingGumball` and reusable widget groups.
2. Create selectable plane rectangles, slice rectangles/depth guides, and box faces/outlines once per structural mode change.
3. Raycast clipping widgets before model selection and store the selected boundary.
4. On selection, attach the shared gumball to the selected boundary’s derived transform and pivot.
5. Map callbacks:
   - Plane translation/rotation updates `transform` and plane size.
   - Slice normal translation updates center/depth with the opposite boundary fixed; rotation updates the whole slab.
   - Box normal translation/scaling updates the selected dimension with the opposite face fixed; rotation updates the whole oriented box.
6. In `syncClippingPlanes`, update existing `THREE.Plane` constants and existing helper objects in place. Only change registrations when plane count or mode changes.
7. Keep `gumballDragging` true from `onStart` through `onEnd`/`onCancel`; disable camera controls during that interval.
8. At completion, emit `onClippingChanged` once so the footer reflects the final state.
9. On mode change, helper hide, unload, blur, cancellation, or dispose, detach/hide the gumball and restore camera controls.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "combined gumball|selected clipping plane|box rotation"`

Expected: PASS.

- [ ] **Step 5: Commit the viewer integration**

```bash
git add src/viewer.ts tests/clipper.e2e.spec.ts
git commit -m "feat: integrate Rhino-style clipping widgets"
```

### Task 4: Migrate footer controls to local clipping coordinates

**Files:**
- Modify: `src/ui/clipper.ts:1-510` — use transform offsets, depth, dimensions, and orientation presets while preserving gesture-stable DOM behavior.
- Modify: `tests/clipper.e2e.spec.ts` — verify footer controls remain precise after viewport transforms.

**Interfaces:**
- Footer continues calling `viewer.setClippingState` only; it does not import Three.js.
- Slider gestures use the existing `isSliderInteraction` lifecycle and never call `root.innerHTML = ""` until pointer-up/change/cancel/blur.

- [ ] **Step 1: Write failing footer tests**

Add tests that rotate a plane in the viewport, move its offset slider, and assert the transform position changes along the current local normal without resetting rotation. Add equivalent slice-depth and box-dimension checks.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "local normal|slice depth|box dimension"`

Expected: FAIL because the footer still reads removed axis/scalar fields.

- [ ] **Step 3: Implement the footer migration**

1. Replace axis-only labels with offset/local-dimension labels.
2. Keep X/Y/Z buttons as quaternion presets and Flip as a local-Z reversal.
3. Calculate offset slider ranges from projected model bounds along the current local normal.
4. Keep plane width/height, slice depth, and box local dimensions precise.
5. Preserve `trackSliderInteraction`, `finishSliderInteraction`, and the gizmo-drag render guard.
6. Update the box panel only after a completed interaction, not during pointer movement.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "local normal|slice depth|box dimension"`

Expected: PASS.

- [ ] **Step 5: Commit the footer migration**

```bash
git add src/ui/clipper.ts tests/clipper.e2e.spec.ts
git commit -m "feat: expose local clipping dimensions in footer controls"
```

### Task 5: Complete lifecycle, performance, and acceptance verification

**Files:**
- Modify: `src/viewer.ts` — dispose/reuse all clipping resources and handle invalid/interrupted transforms.
- Modify: `src/clipping-gumball.ts` — verify pointer-capture and disposal paths are idempotent.
- Modify: `tests/clipper.e2e.spec.ts` — add lifecycle and performance-regression assertions.

- [ ] **Step 1: Write failing lifecycle tests**

Cover pointer cancel, window blur, model unload, helper toggle, and mode change. Assert camera controls are restored, the gumball is hidden/detached, no stale selection remains, and the next clipping interaction works. Assert repeated state updates do not increase widget/gumball child counts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test tests/clipper.e2e.spec.ts --grep "pointer cancel|blur|unload|child counts"`

Expected: FAIL until every interruption path and object-reuse invariant is implemented.

- [ ] **Step 3: Implement lifecycle and reuse cleanup**

1. Make `endDrag`, `cancel`, `detach`, and `dispose` safe to call more than once.
2. Release pointer capture if held and restore `world.camera.controls.enabled` in a `finally`-equivalent cleanup path.
3. Reuse `THREE.Plane`, `PlaneHelper`, `Box3Helper`, widget meshes, and gumball handles during state changes.
4. Dispose resources only when the mode/widget structure is removed or the viewer is unloaded.
5. Reject invalid state updates and restore the last valid drag snapshot if one appears.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
npm run build
npx playwright test tests/clipper.e2e.spec.ts
git diff --check
```

Expected: build exits 0, all clipping tests pass, and `git diff --check` reports no whitespace errors. Record any existing strict TypeScript errors separately; do not broaden this feature to unrelated type cleanup.

- [ ] **Step 5: Rebuild Docker and smoke-test the browser**

Run:

```bash
docker compose up -d --build
curl --noproxy '*' -sS -o /dev/null -w 'HTTP %{http_code}\\n' --max-time 15 http://127.0.0.1:2710/
```

Expected: the service is rebuilt, the curl check returns `HTTP 200`, and manual browser testing confirms selected-widget gumball dragging, free rotation, Esc cancellation, and smooth footer slider movement.

- [ ] **Step 6: Commit final verification adjustments**

```bash
git add src/viewer.ts src/ui/clipper.ts src/clipping-gumball.ts tests/clipper.e2e.spec.ts
git commit -m "test: verify clipping gumball lifecycle"
```
