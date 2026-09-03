# That Open 3.x migration and hidden-line rendering

## Decision and scope

Upgrade the viewer from `@thatopen/components` 2.4.11 and
`@thatopen/components-front` 2.4.12 to the current compatible 3.x releases,
then add hidden-line rendering through the supported
`PostproductionAspect.PEN` preset.

The upgrade is a prerequisite, not an incidental dependency bump. The
application's `IfcGeometryTiler` to in-memory `IfcStreamer` path is used for
IFC files larger than 50 MiB and is a release gate. The existing regular IFC
path, selection, measurement, clipping, category visibility, properties and
export workflows must retain their observed behaviour before a hidden-line UI
control is introduced.

This work remains on `feat/thatopen-3-hidden-lines`, based on `master`, in the
current checkout. No worktree is used.

## Why upgrade before implementing the mode

3.x supplies an explicit postproduction style API whose `PEN` preset is
designed for a technical drawing appearance. That is preferable to permanently
overriding fragment materials and maintaining an edge/depth pipeline that
duplicates library functionality.

The migration has material risk: the 3.x integration uses a new fragments
manager lifecycle (including worker initialisation and manager-owned models),
whereas this viewer directly owns `FragmentsGroup`s, adds their meshes to
`world.meshes`, and bridges tiler events into a custom fetch function for the
streamer. The migration will therefore establish API-compatible adapters or
replace the affected ownership flow as a coherent change, rather than using
unchecked casts to preserve the old shape.

## Compatibility inventory

| Capability | Current 2.4 integration | Required 3.x outcome |
| --- | --- | --- |
| Renderer and labels | `PostproductionRenderer` plus CSS2D labels | Canvas selection remains unobstructed; local clipping remains enabled. |
| Edges | Adds/removes the CustomEffects pass; gloss is forced off | Existing Edges toggle remains visually reversible and clipping-safe. |
| Regular IFC load | `IfcLoader.load` yields a `FragmentsGroup` added to the scene | A normal IFC loads, fits the camera, exposes categories/properties, selects, and unloads/reloads correctly. |
| Large IFC streaming | `IfcGeometryTiler` events build an in-memory tile map; `IfcStreamer.fetch` resolves it | The same no-disk, no-network tile hand-off works above 50 MiB; a failed stream preserves the prior model. |
| Mesh registration | Each `fragment.mesh` is added to `world.meshes` | Raycast selection and click-to-measure operate after first and subsequent loads. |
| Measurement | `LengthMeasurement`, a guarded private picker config, and global `SimpleDimensionLine` units | Measurements remain in whole millimetres with the intended 50 mm snap distance; private-API reliance is removed if 3.x exposes a public configuration path. |
| Model operations | `FragmentsGroup` drives category filtering, properties, bounds, disposal and selection fit | Those operations use the 3.x model representation without changing their public `Viewer` API. |
| Clipping and postproduction | Composer remains session-enabled; `custom` pass toggles; clipping override stays false | The equivalent 3.x pass controls preserve clipping; no gloss/edge-on black-slab regression. |

## Delivery sequence

1. **Lock the target dependency set.** Update components, components-front,
   fragments, `three`, `web-ifc`, and the copied WASM asset only as required by
   their published peer dependencies. Record resolved versions in the lockfile.
2. **Migrate the baseline integration.** Update renderer/world/fragments
   initialisation and model ownership. Preserve the public methods consumed by
   the UI and end-to-end tests.
3. **Restore both load paths.** Port regular loading first, then port the
   tiler/streamer bridge and its failure atomicity. Do not lower or remove the
   50 MiB threshold to avoid the streaming work.
4. **Restore interaction/rendering parity.** Port selection, category hiding,
   parameter/property reads, measurement, clipping, camera fit and current
   Edges behaviour. Reapply the known renderer constraints: initialise
   postproduction once per session, switch individual passes rather than the
   renderer, keep gloss disabled, and do not override clipping planes.
5. **Add hidden-line mode.** Extend the existing `src/ui/edges.ts` control
   rather than introduce a parallel postproduction UI. The mode selects
   `PostproductionAspect.PEN`; switching back restores the normal colour style
   and preserves the independent Edges preference only if the 3.x preset API
   supports that combination without contradictory pass state. Otherwise the
   UI will make the styles mutually exclusive and name that clearly.

## Verification gates

Each migration checkpoint must build and typecheck before proceeding. The
final suite is `npm test` (build, typecheck and Playwright), with the existing
`settled()` helper used for every rendering pixel assertion.

Add or retain browser coverage for:

- initialisation with the CSS2D label layer and enabled local clipping;
- normal IFC load, a second load in the same session, selection, category
  operations, property reads, measurements and model unload;
- Edges on/off visual reversibility, gloss disabled, and clipping while edges
  are enabled;
- the existing failed-stream atomicity test, plus a real IFC above 50 MiB
  exercised manually before release; the repository has no versioned large
  fixture, so this acceptance check cannot be replaced by a synthetic test;
- `PEN` visibly differing from normal rendering, rendering white faces with
  black visible edges, restoring normal rendering when disabled, and retaining
  clipping.

In addition to automated assertions, launch the running Electron app and save
manual screenshots of normal, Edges, PEN, and clipped-PEN states using a real
model. This is a mandatory release check because the prior gloss artifact was
not detectable through the test suite.

## Non-goals

- No custom material override or custom depth pass is retained as a fallback.
- No unrelated viewer redesign or UI overhaul.
- No reduction of the large-model streaming capability merely to make the
  dependency migration compile.
