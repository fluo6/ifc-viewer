# That Open 3.x migration and hidden-line rendering

## Decision and scope

Upgrade the viewer from `@thatopen/components` 2.4.11 and
`@thatopen/components-front` 2.4.12 to the current compatible 3.x releases,
then add hidden-line rendering through the supported
`PostproductionAspect.PEN` preset.

The upgrade is a prerequisite, not an incidental dependency bump. The
application's current `IfcGeometryTiler` to in-memory `IfcStreamer` path is
used for IFC files larger than 50 MiB. Because 3.x no longer exports that
pipeline, the replacement is an Electron-local preprocessing pipeline that
converts an IFC to a versioned cached `.frag` file using 3.x
`FRAGS.IfcImporter`. The existing regular IFC path, selection, measurement,
clipping, category visibility, properties and export workflows must retain
their observed behaviour before a hidden-line UI control is introduced.

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
streamer. The migration will replace that ownership flow as a coherent change,
rather than use unchecked casts to preserve the old shape.

## Large-file preprocessing architecture

The desktop app retains private, offline opening of local IFCs. It does not
add a web service, remote storage, cloud upload, or a custom tile format.

1. The renderer passes the selected absolute IFC path to a dedicated Electron
   IPC method only when the file exceeds 50 MiB. It never sends that raw IFC
   buffer across IPC.
2. The Electron main process starts a utility process for conversion. The
   utility process adapts the upstream Node.js pattern:
   `new FRAGS.IfcImporter().process({ readFromCallback: true, readCallback,
   raw: false, progressCallback })`. It configures the installed `web-ifc`
   WASM path and retains the viewer's coordinate-to-origin, tape-size and
   opening-element exclusion settings where the 3.x importer supports them.
3. The converter writes a compressed `.frag` to
   `app.getPath("userData")/ifc-cache` through a temporary sibling file and
   renames it only after conversion succeeds. Cache entries are keyed by
   resolved input path, source size, source modification time, exact
   components/fragments/web-ifc versions, and conversion settings.
4. Main forwards converter progress and failure messages to the renderer. A
   failed or cancelled conversion leaves the currently displayed model and any
   prior valid cache entry intact.
5. The renderer reads only the resulting `.frag` through an IPC method and
   loads it with the initialized 3.x `FragmentsManager`. That manager supplies
   worker-managed model data and its built-in tile/LOD lifecycle.

The conversion process exists because the 3.x packages do not export
`IfcGeometryTiler`, `IfcStreamer`, `StreamedAsset`, or `StreamedGeometries`.
`IfcImporter` uses WebAssembly, so IFCs near 2 GiB can still exceed its linear
memory ceiling; the UI must report that conversion limit rather than claim
unbounded large-file support.

## Compatibility inventory

| Capability | Current 2.4 integration | Required 3.x outcome |
| --- | --- | --- |
| Renderer and labels | `PostproductionRenderer` plus CSS2D labels | Canvas selection remains unobstructed; local clipping remains enabled. |
| Edges | Adds/removes the CustomEffects pass; gloss is forced off | `COLOR` and `COLOR_PEN` styles implement Edges off/on; gloss remains disabled and clipping-safe. |
| Regular IFC load | `IfcLoader.load` yields a `FragmentsGroup` added to the scene | A normal IFC loads, fits the camera, exposes categories/properties, selects, and unloads/reloads correctly. |
| Large IFC streaming | `IfcGeometryTiler` events build an in-memory tile map; `IfcStreamer.fetch` resolves it | A local utility process converts the source to cached compressed `.frag`; a failed conversion preserves the prior model and cache entry. |
| Mesh registration | Each `fragment.mesh` is added to `world.meshes` | 3.x `FragmentsManager`/model worker owns tiles; raycast selection and click-to-measure operate after first and subsequent loads. |
| Measurement | `LengthMeasurement`, a guarded private picker config, and global `SimpleDimensionLine` units | Measurements remain in whole millimetres with the intended 50 mm snap distance through 3.x's public `snapDistance` and `pickerSize` APIs. |
| Model operations | `FragmentsGroup` drives category filtering, properties, bounds, disposal and selection fit | Those operations use the 3.x model representation without changing their public `Viewer` API. |
| Clipping and postproduction | Composer remains session-enabled; `custom` pass toggles; clipping override stays false | The equivalent 3.x pass controls preserve clipping; no gloss/edge-on black-slab regression. |

## Delivery sequence

1. **Lock the target dependency set.** Update to components 3.4.8,
   components-front 3.4.4, fragments 3.4.7, Three at least 0.182, and web-ifc
   at least 0.0.77. Update the copied WASM asset and record exact resolved
   versions in the lockfile.
2. **Migrate the baseline integration.** Update renderer/world/fragments
   initialisation and model ownership. Preserve the public methods consumed by
   the UI and end-to-end tests.
3. **Restore both load paths.** Port regular loading first, then add the
   Electron utility-process converter, cache, IPC progress/failure protocol,
   and cached-fragment loader. Do not lower or remove the 50 MiB threshold to
   avoid the large-file work.
4. **Restore interaction/rendering parity.** Port selection, category hiding,
   parameter/property reads, measurement, clipping, camera fit and current
   Edges behaviour. Initialise postproduction once per session; use its 3.x
   style API rather than the removed CustomEffects pass API; and keep gloss
   disabled.
5. **Add hidden-line mode.** Extend the existing `src/ui/edges.ts` control
   rather than introduce a parallel postproduction UI. Normal rendering maps
   to `PostproductionAspect.COLOR`, Edges on maps to `COLOR_PEN`, and hidden
   lines maps to `PEN`. Entering `PEN` records the independent Edges
   preference; leaving it restores `COLOR_PEN` or `COLOR` accordingly.

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
- cache hit/miss and failed-conversion atomicity in the Electron preprocessor,
  plus a real IFC above 50 MiB exercised manually before release; the
  repository has no versioned large fixture, so this acceptance check cannot
  be replaced by a synthetic test;
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
