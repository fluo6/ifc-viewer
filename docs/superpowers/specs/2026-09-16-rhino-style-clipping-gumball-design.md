# Rhino-Style Clipping Gumball Design

**Date:** 2026-09-16  
**Status:** Approved for implementation planning

## Summary

Replace the current axis-only clipping gizmos with selectable viewport widgets and a Rhino-style combined gumball. The selected clipping boundary shows simultaneous translation, planar movement, rotation, and scale handles. Footer controls remain available for exact values.

`Viewer.clipState` remains the single source of truth. Both the viewport widgets and HTML controls write to it; renderer clipping planes and all visual helpers are derived from it.

## Goals

- Make plane, slice, and section-box clipping directly manipulable in the viewport.
- Match Rhino's selected-object interaction model: visible clipping widgets, one selected widget, and one object-aligned gumball.
- Support free rotation instead of limiting clipping to world X, Y, and Z.
- Show move, planar-move, rotate, and scale handles at the same time.
- Preserve precise footer controls and X/Y/Z orientation presets.
- Keep drag interaction smooth by mutating and reusing Three.js objects rather than rebuilding them per frame.
- Preserve the existing clipping behavior and tests where it remains applicable.

## Non-Goals

- Creating, naming, duplicating, or managing collections of independent clipping objects.
- Rhino's Alt-drag copy behavior.
- Object snapping, construction planes, named views, section drawings, hatches, or per-viewport clipping.
- Replacing the application's camera controls or general model-selection system.
- Adding a third-party gizmo library.

## Rhino Behavior Being Matched

Rhino represents a clipping plane as a selectable scene object with a direction indicator, translation point, scale points, and optional depth control. Its gumball appears for selected objects and exposes move, planar move, rotate, and scale handles around an object-aligned origin.

The viewer will reproduce that interaction pattern for clipping, while retaining its existing single active clipping configuration.

References:

- [Rhino ClippingPlane](https://docs.mcneel.com/rhino/8/help/en-us/commands/clippingplane.htm)
- [Rhino Gumball](https://docs.mcneel.com/rhino/8mac/help/en-us/commands/gumball.htm)
- [Three.js TransformControls](https://threejs.org/docs/pages/TransformControls.html)

## State Model

Clipping state will use a serializable local frame rather than world-axis scalar positions:

```ts
interface QuaternionData {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface ClipTransform {
  position: Point3;
  rotation: QuaternionData;
}

interface ClippingState {
  enabled: boolean;
  mode: "plane" | "slice" | "box";
  transform: ClipTransform;
  planeSize: { x: number; y: number };
  sliceDepth: number;
  boxSize: Point3;
  showHelper: boolean;
}
```

The transform's local positive Z axis is the primary clipping normal. Flip rotates the local frame by 180 degrees around local X. X/Y/Z buttons set exact world-aligned quaternions; they are presets rather than stored axis state.

Mode geometry is derived as follows:

- **Plane:** one infinite plane through `transform.position`, normal to local Z. `planeSize` affects only the visible widget.
- **Slice:** two parallel planes centered on `transform.position` and separated by `sliceDepth` along local Z.
- **Box:** six planes derived from the oriented center, `boxSize`, and local X/Y/Z axes.

All rotations are normalized before storage. Slice depth and box dimensions are clamped to a small positive minimum.

On model load, the transform is centered on the model and oriented to the current default Y cut. Plane size and box dimensions come from model bounds; slice depth starts at half the projected model depth. Switching modes preserves the current position and orientation while restoring the last valid dimensions for the destination mode. Reset Section Box restores a world-aligned box around the complete model. Fit Selection projects the selected element into the box's current local axes, preserving the box orientation.

## Viewport Components

### Clipping widgets

The viewer renders reusable translucent geometry for each active boundary:

- Plane: one rectangle with a visible-side direction indicator.
- Slice: two rectangles connected by subtle depth guides.
- Box: six selectable faces and an outline.

Unselected boundaries remain visible while helpers are enabled. The selected boundary is orange and receives the gumball. When helpers are disabled, clipping remains active but widgets and gumball are hidden.

### Combined clipping gumball

Add one focused `src/clipping-gumball.ts` component. It owns:

- Reusable arrow, plane-square, rotation-arc, and scale-handle meshes.
- One raycaster and one set of canvas pointer listeners.
- Hover and active-handle highlighting.
- Pointer capture and drag math.
- Drag-start snapshots, cancellation, and completion events.

Only one gumball instance exists. It is repositioned and reoriented when selection changes. This avoids overlapping `TransformControls`; Three.js's stock control exposes only one translate, rotate, or scale mode at a time and cannot provide the approved simultaneous handle set.

The component reports transforms and deltas. It does not own clipping state or renderer planes.

### Viewer integration

`Viewer` owns selection, translates gumball output into `clipState`, derives clipping planes, and synchronizes visuals. Pointer priority is:

1. Active gumball handles.
2. Clipping widget boundaries.
3. Existing IFC model selection and camera interaction.

Selecting a clipping boundary consumes the click so it does not select model geometry behind it. Camera controls are disabled only during a gumball drag and restored on every completion or cancellation path.

## Mode-Specific Transform Semantics

### Plane

- Translation moves the widget origin; movement along the normal changes the clipping plane.
- Rotation changes the clipping normal freely.
- Local X/Y scaling changes only the displayed rectangle size because clipping remains infinite.
- Local Z scaling is hidden.

### Slice

- Selecting either boundary places the gumball at that boundary.
- Translating along local Z moves the selected boundary while keeping the opposite boundary fixed, updating center and depth.
- Rotation rotates the complete slab around the selected boundary so its planes remain parallel.
- Local X/Y scaling changes widget size; local Z scaling changes depth while keeping the opposite boundary fixed.

### Section box

- Selecting a face places the gumball at that face center.
- Translation along the face normal moves that face while keeping the opposite face fixed, updating center and box size.
- Tangential translation moves the complete box.
- Rotation rotates the complete box around the selected face center, preserving an orthogonal box.
- Normal scaling changes the selected dimension from the opposite face; tangential scaling changes the corresponding box dimensions around the selected face center.

The box never deforms into an arbitrary six-plane polyhedron.

## Interaction Details

- Handle colors follow the familiar convention: X red, Y green, Z blue.
- Hovered and active handles brighten and take pointer priority.
- The gumball stays a stable screen-space size while the camera zooms.
- Pointer-down snapshots the current clipping state and captures the pointer.
- Pointer-up commits the transform and triggers one HTML UI refresh.
- Esc during a drag restores the snapshot; Esc while idle deselects the widget.
- Clicking empty viewport space deselects the widget.
- Shift enables translation snapping at one two-hundredth of the model bounding-box diagonal and 5-degree rotation snapping. Scaling remains continuous.
- Window blur, pointer cancellation, model unload, mode changes, and helper hiding terminate the interaction safely and restore camera controls.

## Footer Controls

The footer remains the precise-editing surface:

- X/Y/Z buttons reset orientation to exact world-axis presets.
- Flip reverses local Z.
- Plane exposes normal offset and widget width/height.
- Slice exposes center offset, depth, and widget width/height.
- Box controls edit local dimensions and center offsets.

Footer inputs update `clipState` without rebuilding the active input during a gesture. During viewport dragging, HTML rendering is deferred until drag completion.

## Data Flow

1. A footer input or gumball gesture proposes a state update.
2. `Viewer` validates and stores the update in `clipState`.
3. Existing `THREE.Plane` instances are updated from the transform and dimensions.
4. Existing widget, helper, and gumball objects are mutated in place.
5. The renderer updates.
6. `onClippingChanged` notifies the footer; notifications during active gestures do not rebuild its DOM.
7. Gesture completion emits one final notification for exact UI synchronization.

## Performance and Lifecycle

- Create clipping geometries, materials, helpers, planes, and gumball handles once per structural mode change, not once per pointer movement.
- Reuse the single gumball across all boundaries and modes.
- Mutate matrices, plane constants, and helper references during dragging.
- Dispose geometries, materials, listeners, and pointer capture on viewer teardown or model unload.
- Do not allocate temporary scene objects in the pointer-move path.

## Validation and Failure Handling

- Reject position, rotation, depth, and size updates containing non-finite numbers.
- Normalize non-zero quaternions; replace a zero-length quaternion with identity.
- Clamp slice depth and each box dimension above a model-scale epsilon.
- Restore the pre-drag snapshot when drag math becomes invalid.
- Always restore camera controls and clear drag state in completion, cancellation, blur, unload, helper-hide, and mode-change paths.

## Testing

Automated coverage will verify:

- Clicking a boundary selects it and shows one object-aligned combined gumball.
- Clicking empty space and pressing Esc deselect it.
- Translation updates clipping state and visible clipping.
- Free rotation changes the clipping normal.
- Plane scaling changes widget size without changing its plane equation.
- Slice boundary movement changes depth while keeping planes parallel.
- Box face movement changes dimensions while keeping the opposite face fixed.
- Box rotation preserves orthogonal planes.
- Shift snapping produces deterministic translation and 5-degree rotation increments.
- Esc during dragging restores the exact pre-drag state.
- Camera controls and pointer state recover after pointer-up, cancel, blur, unload, mode change, and helper hiding.
- Slider DOM nodes survive full pointer gestures.
- Viewport dragging defers footer rebuilding until drag completion.
- Existing clipping plane counts, direction, rendering, slice, box, shortcut, and UI behavior remain valid.

Acceptance commands:

```bash
npm run build
npx playwright test tests/clipper.e2e.spec.ts
```

The rebuilt Docker service must return HTTP 200 and be manually checked for smooth pointer interaction in the browser.

## Ponytail Constraints

- Add no dependency.
- Add one focused gumball component instead of a general scene-editor framework.
- Reuse current clipping events, renderer integration, camera controls, colors, and test infrastructure.
- Do not implement clipping-object collections, duplication, named views, object snaps, hatching, or unrelated Rhino tools.
- Keep the shortest implementation that satisfies the approved interaction and leaves executable regression coverage.
