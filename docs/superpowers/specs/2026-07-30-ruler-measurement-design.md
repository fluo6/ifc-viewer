# Ruler measurement — design

Date: 2026-07-30
Status: approved, ready for planning
Priority: implement after the XLSX attribute export

## Problem

There is no way to measure anything in the viewer. Checking a clearance, a span
or an offset means going back to Rhino or the drawings.

## Goals

- Click two points, get a dimension line labelled with the distance.
- Snap to geometry vertices, so measurements land on real points.
- Never fight element selection.

## Non-goals

- Area, angle, face, edge and volume measurement. The library provides all of
  them; they are deliberately excluded until point-to-point proves useful.
- Persisting measurements across sessions, or exporting them.
- Snapping to member axes, midpoints or grid intersections. See "Future".

## Approach

Wrap `OBF.LengthMeasurement`, already present in the installed
`@thatopen/components-front`. It provides vertex snapping via an internal
`VertexPicker`, dimension lines with 3D labels, and `create` / `delete` /
`deleteAll` / `cancelCreation`.

Confirmed by reading the built code rather than the docs:

- `create()` toggles: first call starts a line, second finishes it. The caller
  drives it, so we choose the click semantics.
- `set enabled(v)` wires and unwires its own `mousemove` and `keydown` handlers,
  and cancels any in-progress line when set false. `world` must be assigned
  before enabling.
- Escape is already handled internally: `onKeydown` calls `cancelCreation()`.
- `snapDistance` defaults to `0.25` world units.
- The line material uses `depthTest: false`, so dimensions draw over geometry.

A custom raycasting ruler was considered and rejected: it would re-implement
vertex snapping against *instanced* fragment meshes, which is the hardest part of
the problem, for roughly three times the code. Revisit only if vertex snapping
proves too coarse in practice.

## Renderer change

Measurement labels are `Mark` objects wrapping `CSS2DObject`. Rendering them
needs a `CSS2DRenderer`, which `OBC.SimpleRenderer` does not have. So
`viewer.init()` swaps in `OBF.RendererWith2D`, which extends `SimpleRenderer` and
adds a `three2D: CSS2DRenderer`.

Because it is a subclass, the clipper (which relies on `localClippingEnabled`)
and the highlighter (which binds events to `renderer.three.domElement`) should be
unaffected — but both are re-verified rather than assumed.

## Units

Fragment geometry is in metres; the properties panel displays mm. The ruler
matches the panel via `SimpleDimensionLine`'s statics:

```ts
SimpleDimensionLine.scale = 0.001;  // metres -> mm
SimpleDimensionLine.units = "mm";
SimpleDimensionLine.rounding = 0;
```

Confirmed against the built library (`getTextContent()` in
`@thatopen/components-front`'s dist bundle): the label text is
`(length / scale).toFixed(rounding)` with `units` appended — `scale` **divides**,
it does not multiply. `1000` was the wrong guess: geometry is in metres, so
dividing a 5 m span by `1000` renders `"0 mm"`. `0.001` is the value that
actually yields millimetres.

`snapDistance` is set to `0.05` (50 mm), not the default `0.25` (250 mm), which
is far too grabby at building scale. This is a starting value to be tuned against
the project models.

Model coordinates are `COORDINATE_TO_ORIGIN`-shifted, which does not affect
distances.

## Module boundaries

Follows the existing split: `Viewer` owns engine state, `src/ui/*` owns DOM, and
`@thatopen/*` never appears in `src/ui/`.

### `src/viewer.ts`

```ts
readonly onMeasureModeChanged = new Emitter<boolean>();

setMeasureMode(on: boolean): void;   // the only place that knows measuring and
                                     // selecting are mutually exclusive
placeMeasurePoint(): void;           // -> lengthMeasurement.create()
clearMeasurements(): void;           // -> deleteAll()
isMeasureMode(): boolean;
measureBetween(a: Point3, b: Point3): void;  // -> createOnPoints; Point3 is a
                                             // plain {x,y,z}, not THREE.Vector3
                                             // -- src/ui/ never imports three
```

`setMeasureMode` flips `highlighter.enabled` inversely and clears the current
selection. Keeping that inversion in exactly one method is what stops the two
tools fighting; scattering it across the UI is how that bug gets reintroduced.

`unloadIfc()` calls `clearMeasurements()` and `setMeasureMode(false)`, mirroring
how it already resets the clipper.

`measureBetween` is real API, not a test hook — it is the natural way to add a
dimension programmatically, and it lets tests assert label formatting without
depending on camera position.

### `src/ui/ruler.ts`

`mountRuler(viewer)`, alongside `mountClipper`, driven by a new
`<div id="ruler">` in `index.html` next to `#clipper`:

- A `Measure: OFF` / `Measure: ON` toggle using the existing `.mini` class.
- A `Clear` button, shown only when at least one measurement exists.
- A hint line while active: `click two points · Esc cancels`.
- Visible only while a model is loaded, hidden on unload — same as the clipper.
- Installs the canvas click listener that calls `placeMeasurePoint()`.

The click listener is bound to the renderer canvas, **not** `#viewport`.
`#viewport` also contains the dropzone, clipper and ruler overlay divs, so
binding there would drop a measurement point every time the user clicks the
toggle button.

### `src/ui/keybindings.ts`

Add `m` to toggle measure mode, matching the existing single-letter, no-modifier
style of `f` and `r`. Escape needs no handler — the library installs its own.

## Interaction

| Step | Behaviour |
| --- | --- |
| Toggle on | Crosshair cursor on the canvas, selection suspended, current selection cleared. |
| First click | Anchors the start point. |
| Mouse move | Live preview with vertex snapping. |
| Second click | Commits a persistent dimension line. |
| Escape | Cancels the in-progress line; committed lines remain. |
| Toggle off | Cancels any in-progress line; committed lines remain visible. |
| `Clear` | Removes all measurements. |
| Model unload | Measurements cleared, mode exited. |

Measurements accumulate until cleared.

## Risks

1. **The CSS2D layer swallowing clicks.** Its `domElement` is absolutely
   positioned over the viewport. If it does not stay `pointer-events: none`,
   element selection dies everywhere in the app. This is the first thing to
   verify and the highest-consequence failure.
2. **Renderer swap regressions.** Clipping and highlighting must be re-tested,
   subclass or not.
3. **`scale` / `units` / `rounding` semantics.** Confirmed against the built
   library: `scale` divides, so `0.001` (not `1000`) is what yields
   millimetres. See "Units" above.
4. **Streamed models (>50 MB).** Snapping only sees currently-streamed
   fragments, so it can miss geometry that has not loaded. Documented, not fixed.
5. **`snapDistance` tuning.** 50 mm is a guess informed by scale; it needs a pass
   against the real models.

## Testing

**E2E, Playwright + Electron** via `tests/launch.ts`, against
`tests/fixtures/i-beam.ifc` whose geometry is known by hand — the beam runs
5000 mm along +Z from `(1000, 2000, 3000)`:

- `measureBetween` its two ends produces a label reading `5000 mm`.
- Toggling measure mode on suspends selection: clicking an element leaves the
  properties panel unchanged.
- Toggling off restores selection.
- `Clear` empties the measurement list.
- Unloading the model clears measurements and exits the mode.
- Element selection still works with the 2D renderer in place — the regression
  guard for risk 1.

Two-click measurement at synthetic screen coordinates is deliberately **not**
tested: it depends on camera framing and would be flaky. `measureBetween` covers
the same maths deterministically.

## Future

If vertex snapping proves too coarse, the follow-up is snapping to member axes
and profile midpoints, which the library cannot do and which would mean the
custom raycasting approach rejected above. That is a separate spec.
