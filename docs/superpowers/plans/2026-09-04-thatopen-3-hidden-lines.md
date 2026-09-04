# That Open 3.x Migration and Hidden-line Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Electron IFC viewer to That Open 3.x, preserve local large-IFC support through cached preprocessing, and add reversible PEN hidden-line rendering.

**Architecture:** The renderer owns a 3.x `FragmentsManager` and `FragmentsModel` lifecycle. Local IFCs above 50 MiB are converted by an Electron utility process using That Open's supported Node `IfcImporter.process({ readFromCallback })` API; main process caches the resulting compressed `.frag` atomically and the renderer loads only that fragment buffer. The postproduction state is a small explicit state machine: `COLOR`, `COLOR_PEN`, or `PEN`.

**Tech Stack:** Electron 31, TypeScript 5, Vite 5, Playwright, `@thatopen/components` 3.4.8, `@thatopen/components-front` 3.4.4, `@thatopen/fragments` 3.4.7, Three.js 0.182+, web-ifc 0.0.77+.

**Spec:** `docs/superpowers/specs/2026-09-04-thatopen-3-hidden-lines-design.md`

## Global Constraints

- Work only on `feat/thatopen-3-hidden-lines`; do not create a worktree.
- Keep IFC data private and local: no server, remote storage, upload, or new custom tile format.
- Preserve the 50 MiB routing threshold; replace the removed 2.4 tiler/streamer path with local preprocessing rather than falling back to full renderer-side IFC parsing.
- Cache only fully completed conversions. Key entries by resolved source path, size, mtime, exact converter versions, and conversion settings.
- Use `FRAGS.IfcImporter.process({ readFromCallback: true, readCallback, raw: false, progressCallback })`; do not write an IFC geometry tiler.
- Maintain the public `Viewer` methods used by current UI and browser tests unless their replacement is explicitly updated in the same task.
- Keep 3.x postproduction initialized once, keep `glossEnabled` false, and express normal/edges/hidden-line rendering with `COLOR`, `COLOR_PEN`, and `PEN`.
- Use the existing `settled()` screenshot helper for all new render comparisons. No fixed sleeps in new screenshot assertions.
- Run `npm test` before the final handoff and manually screenshot normal, Edges, PEN, and clipped-PEN states. Test a real IFC over 50 MiB manually before release; this repository has no such fixture.

---

### Task 1: Upgrade the runtime and port the regular-model Viewer lifecycle

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/copy-wasm.mjs`
- Modify: `vite.config.ts`
- Modify: `src/viewer.ts`
- Modify: `src/ui/categories.ts`
- Modify: `src/ui/properties.ts`
- Modify: `src/ui/ruler.ts`
- Test: `tests/renderer-2d.e2e.spec.ts`, `tests/measure.e2e.spec.ts`, `tests/properties-refresh.e2e.spec.ts`, `tests/pset-duplication.e2e.spec.ts`

**Interfaces:**
- Consumes: Vite asset URL support and `FragmentsManager.init(workerUrl)` from components 3.4.8.
- Produces: An initialized `FragmentsManager` whose manager-owned `FragmentsModel.object` can be attached to the existing world, plus a packaged version-matched renderer worker and a fully working regular IFC load path.

- [ ] **Step 1: Write the failing renderer-initialization assertion**

Extend `tests/renderer-2d.e2e.spec.ts` so a ready viewer exposes a test-only `debugFragmentsInitialized()` result of `true` before a model is loaded:

```ts
expect(
  await page.evaluate(() => (window as any).__viewer.debugFragmentsInitialized()),
).toBe(true);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx playwright test tests/renderer-2d.e2e.spec.ts --grep "fragments"`

Expected: FAIL because `debugFragmentsInitialized` does not exist.

- [ ] **Step 3: Upgrade the aligned runtime dependencies and assets**

Set the direct dependencies to the documented compatible set:

```json
"@thatopen/components": "3.4.8",
"@thatopen/components-front": "3.4.4",
"@thatopen/fragments": "3.4.7",
"three": "^0.182.0",
"web-ifc": "0.0.77"
```

Install with `npm install`, committing the resolved lockfile. Keep the WASM copy script but verify that the 0.0.77 single-threaded wasm is copied. Import the fragments worker as a Vite URL:

```ts
import fragmentsWorkerUrl from "@thatopen/fragments/worker?url";
```

In `Viewer.init`, initialize the manager before calling `IfcLoader.load`:

```ts
this.fragmentsManager = components.get(OBC.FragmentsManager);
this.fragmentsManager.init(fragmentsWorkerUrl);
```

Attach manager-owned models and keep their LOD/culling view current:

```ts
this.fragmentsManager.list.onItemSet.add(({ value: model }) => {
  model.useCamera(world.camera.three);
  world.scene.three.add(model.object);
  this.fragmentsManager.core.update(true);
});
world.camera.controls.addEventListener("rest", () =>
  this.fragmentsManager.core.update(true),
);
```

Expose `debugFragmentsInitialized()` as `return this.fragmentsManager.initialized;`.

Complete the 3.x ownership port in this same task so the dependency commit is
buildable: use `FRAGS.FragmentsModel` for `currentModel`; remove every 2.4
tiler/streamer field and `loadIfcStreaming`; load regular IFCs with
`IfcLoader.load`; use `model.object`, `model.box`, `model.modelId`,
`fragmentsManager.core.disposeModel(model.modelId)`, and asynchronous 3.x
category/property methods. Replace `world.meshes` raycast registration with
the public 3.x highlighter/fragments raycast APIs. Use the public
`LengthMeasurement.snapDistance` and `pickerSize` fields, never
`_vertexPicker`. Update UI callers whose category/property methods become
asynchronous. Preserve the existing public Viewer method names and behaviours
for ordinary IFCs.

- [ ] **Step 4: Run the focused test and build**

Run: `npm run build && npm run typecheck && npx playwright test tests/renderer-2d.e2e.spec.ts`

Expected: build/typecheck succeed and the regular-load, measurement,
properties, and manager-initialization assertions pass. Do not silence a 3.x
API mismatch with `any`; complete the API port in this task.

- [ ] **Step 5: Commit the dependency foundation**

```bash
git add package.json package-lock.json scripts/copy-wasm.mjs vite.config.ts src/viewer.ts src/ui/categories.ts src/ui/properties.ts src/ui/ruler.ts tests/renderer-2d.e2e.spec.ts tests/measure.e2e.spec.ts tests/properties-refresh.e2e.spec.ts tests/pset-duplication.e2e.spec.ts
git commit -m "build: upgrade That Open runtime to v3"
```

### Task 2: Add a testable local IFC-to-fragment cache contract

**Files:**
- Create: `electron/ifc-preprocessor.ts`
- Create: `tests/ifc-preprocessor.spec.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/electron-api.d.ts`

**Interfaces:**
- Consumes: an absolute local IFC path, source stat data, and the exact converter-version/settings record.
- Produces: `getIfcFileSize(filePath): Promise<number>`, `prepareIfc(filePath): Promise<{ cacheId: string; filename: string; cacheHit: boolean }>`, and `readPreparedIfc(cacheId): Promise<ArrayBuffer>` available through `window.electron`.

- [ ] **Step 1: Write failing cache-key and atomic-write tests**

Create `tests/ifc-preprocessor.spec.ts` with direct tests for exported pure helpers. The key must change when any source identity or converter input changes and a failed write must not replace an existing cache file:

```ts
expect(cacheKey({ path: "C:/a.ifc", size: 50, mtimeMs: 1 }, versions, settings))
  .not.toBe(cacheKey({ path: "C:/a.ifc", size: 51, mtimeMs: 1 }, versions, settings));
await writeCacheAtomically(target, new Uint8Array([1, 2]));
await expect(readFile(target)).resolves.toEqual(Buffer.from([1, 2]));
```

Use a `mkdtemp` directory and assert the temporary sibling name is removed when the writer throws.

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx playwright test tests/ifc-preprocessor.spec.ts`

Expected: FAIL because `electron/ifc-preprocessor.ts` and its exports do not exist.

- [ ] **Step 3: Implement cache identity and the narrow preload contract**

Export typed helpers and data structures from `electron/ifc-preprocessor.ts`:

```ts
export interface SourceIdentity { path: string; size: number; mtimeMs: number; }
export interface PreparedIfc { cacheId: string; filename: string; cacheHit: boolean; }
export interface PreprocessProgress { cacheId: string; progress: number; stage: string; }
export function cacheKey(source: SourceIdentity, versions: Record<string, string>, settings: Record<string, unknown>): string;
export async function writeCacheAtomically(target: string, bytes: Uint8Array): Promise<void>;
```

Use SHA-256 over `JSON.stringify` of a fixed-order object. Write to `${target}.${process.pid}.tmp`, then rename only after `writeFile` succeeds; on any error unlink only that temporary file and rethrow.

In main/preload/declarations expose only opaque cache IDs, not cache paths:

```ts
prepareIfc: (filePath: string) => Promise<PreparedIfc>;
readPreparedIfc: (cacheId: string) => Promise<ArrayBuffer>;
getIfcFileSize: (filePath: string) => Promise<number>;
onIfcPreprocessProgress: (handler: (event: PreprocessProgress) => void) => () => void;
```

Main owns the cache-ID-to-file mapping and rejects unknown IDs, preventing the renderer from turning the new IPC into arbitrary filesystem access.

- [ ] **Step 4: Run the focused tests and typecheck**

Run: `npm run typecheck && npx playwright test tests/ifc-preprocessor.spec.ts`

Expected: all cache identity and atomic-write tests pass.

- [ ] **Step 5: Commit the cache contract**

```bash
git add electron/ifc-preprocessor.ts electron/main.ts electron/preload.ts src/electron-api.d.ts tests/ifc-preprocessor.spec.ts
git commit -m "feat: add local IFC preprocessing cache contract"
```

### Task 3: Implement the upstream Node importer in an Electron utility process

**Files:**
- Create: `electron/ifc-preprocess-worker.ts`
- Modify: `electron/ifc-preprocessor.ts`
- Modify: `electron/main.ts`
- Modify: `package.json`
- Test: `tests/ifc-preprocessor.spec.ts`

**Interfaces:**
- Consumes: `{ sourcePath, outputPath, wasmPath, settings }` sent by main to the utility process.
- Produces: `{ type: "progress", progress, stage }`, `{ type: "complete" }`, or `{ type: "error", message }` process messages; main resolves `PreparedIfc` only after `complete` and an atomic cache rename.

- [ ] **Step 1: Add failing orchestration tests**

Add a fake-converter dependency to the preprocessor constructor and test three cases: cache hit skips conversion, cache miss calls the converter once and writes bytes, and rejection preserves an earlier cache file and returns the converter error.

```ts
let calls = 0;
const converter = { convert: async () => { calls++; return new Uint8Array([7]); } };
await service.prepare(sourcePath);
await service.prepare(sourcePath);
expect(calls).toBe(1);
```

Use the project’s Playwright test runner APIs rather than adding a second test framework.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx playwright test tests/ifc-preprocessor.spec.ts`

Expected: FAIL because no service can orchestrate conversion or cache hits.

- [ ] **Step 3: Implement the converter by adapting the published Node example**

Compile `electron/ifc-preprocess-worker.ts` with the Electron TypeScript build and start it with `utilityProcess.fork` from main. In the utility process, use the upstream callback model rather than loading the IFC into a renderer buffer:

```ts
const handle = await open(sourcePath, "r");
const importer = new FRAGS.IfcImporter();
importer.wasm = { path: wasmDirectory, absolute: true };
try {
  const bytes = await importer.process({
    readFromCallback: true,
    readCallback: async (offset) => {
      const buffer = new Uint8Array(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
      return buffer.subarray(0, bytesRead);
    },
    raw: false,
    progressCallback: (progress, data) => process.parentPort?.postMessage({
      type: "progress", progress, stage: String(data),
    }),
  });
  await writeFile(outputPath, bytes);
  process.parentPort?.postMessage({ type: "complete" });
} finally {
  await handle.close();
}
```

Use the actual Electron utility-process message API (`process.parentPort`) and pass a packaged absolute `web-ifc.wasm` directory from main. In development resolve it from the installed package; in production resolve it from the Electron extra resource. Add the worker output to the Electron build/package files.

The parent validates the source with `stat`, derives its cache key, writes to the temporary path, atomically promotes it on `complete`, forwards progress to the requesting `webContents`, and kills the utility process on cancellation/window destruction. It must map WebAssembly memory failures to a plain user-facing message explaining the approximately 2 GiB importer limit.

- [ ] **Step 4: Run focused tests and an Electron smoke test**

Run: `npm run build && npm run typecheck && npx playwright test tests/ifc-preprocessor.spec.ts`

Expected: all fake-converter cache tests pass and the generated utility-process script exists in `dist-electron`.

- [ ] **Step 5: Commit the preprocessor implementation**

```bash
git add electron/ifc-preprocessor.ts electron/ifc-preprocess-worker.ts electron/main.ts package.json tests/ifc-preprocessor.spec.ts
git commit -m "feat: preprocess large IFCs locally"
```

### Task 4: Route native large-file opens through the prepared-fragment cache

**Files:**
- Modify: `src/viewer.ts:261-525`
- Modify: `src/ui/toolbar.ts`
- Modify: `src/ui/dropzone.ts`
- Modify: `tests/measure.e2e.spec.ts`
- Modify: `tests/renderer-2d.e2e.spec.ts`

**Interfaces:**
- Consumes: `window.electron.prepareIfc`/`readPreparedIfc` and the 3.x `FragmentsModel` lifecycle delivered by Task 1.
- Produces: `Viewer.loadIfcPath(filePath)` for native dialog loads; it routes files over 50 MiB through a prepared compressed fragment without destabilising the current model.

- [ ] **Step 1: Replace the old streamed-load failure test with a failing preprocess failure test**

In `tests/measure.e2e.spec.ts`, replace direct access to private `tiler`/`streamer` with an injected `window.electron.prepareIfc` rejection for a large native-file load. Assert filename, categories, and model height remain unchanged after the rejection.

```ts
window.electron.prepareIfc = async () => { throw new Error("synthetic conversion failure"); };
await expect(viewer.loadIfcPath("C:/broken.ifc")).rejects.toThrow("synthetic conversion failure");
```

- [ ] **Step 2: Run the focused regression test to verify it fails**

Run: `npx playwright test tests/measure.e2e.spec.ts --grep "conversion failure"`

Expected: FAIL because `loadIfcPath` does not exist and the old tiler/streamer route is still present.

- [ ] **Step 3: Implement only the threshold routing and prepared fragment load**

For `loadIfcPath`, call `getIfcFileSize` through the narrow preload method. Files at or
below the threshold use the existing `readFile` then normal `loadIfc`; larger
files call `prepareIfc`, then `readPreparedIfc`, and load the returned buffer
with the Task 1 manager:

```ts
const model = await this.fragmentsManager.core.load(fragmentBuffer, {
  modelId: name,
  camera: this.world.camera.three,
});
```

Use `model.box` for camera fitting and height range. Dispose the old model
only after the new load is successful:

```ts
await this.fragmentsManager.core.disposeModel(this.currentModel.modelId);
```

Keep `currentIsStreamed` as a public compatibility signal, but set it to true
only for a model loaded from a prepared fragment. Use it to preserve the
existing limited-properties behaviour for large models. Make the dropzone and
file-input path display a clear local-file error above 50 MiB when Electron
cannot provide an absolute path; native Open remains the supported route for
preprocessing and must be documented in that error.

- [ ] **Step 4: Run the interaction regression set**

Run: `npm run build && npm run typecheck && npx playwright test tests/measure.e2e.spec.ts tests/renderer-2d.e2e.spec.ts tests/properties-refresh.e2e.spec.ts tests/pset-duplication.e2e.spec.ts`

Expected: all selected tests pass with no references to `IfcGeometryTiler`,
`IfcStreamer`, `FragmentsGroup`, `world.meshes`, or `_vertexPicker` remaining
in `src/viewer.ts`.

- [ ] **Step 5: Commit the large-file routing checkpoint**

```bash
git add src/viewer.ts src/ui/toolbar.ts src/ui/dropzone.ts tests/measure.e2e.spec.ts tests/renderer-2d.e2e.spec.ts tests/properties-refresh.e2e.spec.ts tests/pset-duplication.e2e.spec.ts
git commit -m "feat: load large IFCs from local fragments cache"
```

### Task 5: Restore clipping and existing Edges with 3.x postproduction styles

**Files:**
- Modify: `src/viewer.ts:525-570`
- Modify: `tests/edges.e2e.spec.ts`
- Modify: `tests/clipper.e2e.spec.ts`

**Interfaces:**
- Consumes: `OBF.PostproductionAspect.{COLOR,COLOR_PEN}`, public `postproduction.glossEnabled`, and `Viewer.setClippingPlane`.
- Produces: `setEdges(on: boolean): void`, `edgesOn(): boolean`, and a postproduction renderer that respects clipping in both normal and edged styles.

- [ ] **Step 1: Update edge tests to pin 3.x styles and write a failing assertion**

Add `debugPostproductionStyle()` to the viewer and assert the normal startup
style is `COLOR`, turning Edges on yields `COLOR_PEN`, and turning it off
returns `COLOR`. Retain the existing settled-frame reversibility and clipping
pixel assertions.

```ts
expect(await page.evaluate(() => (window as any).__viewer.debugPostproductionStyle()))
  .toBe("COLOR_PEN");
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx playwright test tests/edges.e2e.spec.ts`

Expected: FAIL because 2.4 `setPasses({ custom })` is gone and the debug style
method is not implemented.

- [ ] **Step 3: Implement the explicit normal/edges state**

Enable postproduction once in `init`, set `glossEnabled = false`, and use an
internal `applyRenderStyle()` helper:

```ts
private edgesPreference = false;
private hiddenLines = false;

private applyRenderStyle(): void {
  this.postFx.style = this.hiddenLines
    ? OBF.PostproductionAspect.PEN
    : this.edgesPreference
      ? OBF.PostproductionAspect.COLOR_PEN
      : OBF.PostproductionAspect.COLOR;
}

setEdges(on: boolean): void {
  this.edgesPreference = on;
  if (!this.hiddenLines) this.applyRenderStyle();
}
```

Keep the existing plain `THREE.Plane` clipping implementation, then correct
only the renderer API calls TypeScript identifies as changed. Do not restore
the 2.4 `customEffects`, `setPasses`, or `overrideClippingPlanes` calls.

- [ ] **Step 4: Run visual and clipping regressions**

Run: `npm run typecheck && npx playwright test tests/edges.e2e.spec.ts tests/clipper.e2e.spec.ts`

Expected: normal and edged frames remain reversible, gloss is false, and a
mid-height clipping plane changes both styles.

- [ ] **Step 5: Commit the 3.x postproduction parity checkpoint**

```bash
git add src/viewer.ts tests/edges.e2e.spec.ts tests/clipper.e2e.spec.ts
git commit -m "feat: restore edges with postproduction styles"
```

### Task 6: Add the hidden-line control and visual regression coverage

**Files:**
- Modify: `index.html`
- Modify: `src/ui/edges.ts`
- Modify: `src/styles.css`
- Modify: `src/viewer.ts`
- Modify: `tests/edges.e2e.spec.ts`

**Interfaces:**
- Consumes: `Viewer.setHiddenLines(on: boolean): void`, `Viewer.hiddenLinesOn(): boolean`, and the stored Edges preference.
- Produces: A `Hidden lines: ON/OFF` control beside the existing Edges button; disabling hidden lines restores `COLOR_PEN` when Edges was on and `COLOR` otherwise.

- [ ] **Step 1: Write failing UI and rendering tests using `settled()`**

Extend `tests/edges.e2e.spec.ts` with these cases:

```ts
await page.evaluate(() => (window as any).__viewer.setHiddenLines(true));
const pen = await settled(page, viewport);
expect(pen.equals(normal)).toBe(false);

await page.evaluate(() => (window as any).__viewer.setHiddenLines(false));
expect((await settled(page, viewport)).equals(normal)).toBe(true);
```

Add a restoration case: enable Edges, retain that settled frame, enter and
leave hidden lines, and compare the restored frame to the saved edged frame.
Add a clipping case that compares unclipped and clipped PEN frames. Drive the
new button and assert its accessible visible text changes with the mode.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx playwright test tests/edges.e2e.spec.ts --grep "hidden lines"`

Expected: FAIL because the viewer and UI expose no hidden-line methods or
button.

- [ ] **Step 3: Implement reversible PEN mode beside the existing control**

Add these viewer methods:

```ts
setHiddenLines(on: boolean): void {
  this.hiddenLines = on;
  this.applyRenderStyle();
}

hiddenLinesOn(): boolean {
  return this.hiddenLines;
}
```

In `mountEdges`, append a second `mini` button to the same `#edges` root. Its
click handler toggles `viewer.setHiddenLines(!viewer.hiddenLinesOn())`; its
render function writes `Hidden lines: ON` or `Hidden lines: OFF`. Preserve the
existing Edges button and re-render both labels after either button is clicked.

- [ ] **Step 4: Run focused tests and the full suite**

Run: `npm test`

Expected: build, typecheck, and all Playwright tests pass, including normal,
Edges, PEN, clipped-PEN, and restoration screenshot comparisons.

- [ ] **Step 5: Commit hidden-line mode**

```bash
git add index.html src/ui/edges.ts src/styles.css src/viewer.ts tests/edges.e2e.spec.ts
git commit -m "feat: add hidden-line rendering mode"
```

### Task 7: Perform the required real-model acceptance check and document the result

**Files:**
- Modify: `README.md` (only if it already documents viewer limitations or supported file sizes)
- Create: `docs/verification/thatopen-3-hidden-lines-acceptance.md`

**Interfaces:**
- Consumes: packaged Electron app, a local real IFC over 50 MiB, and the finished UI states.
- Produces: a concise record of exact app/dependency versions, test command output, real-model size, cache hit/miss result, and screenshot paths.

- [ ] **Step 1: Build a distributable app**

Run: `npm run dist`

Expected: Electron Builder emits the platform installer/package with the 3.x
fragments worker and `web-ifc.wasm` included.

- [ ] **Step 2: Exercise a real large model twice**

Open a local IFC greater than 50 MiB through the packaged app. Record the
first conversion’s progress and successful cache write. Close/reopen the same
file and record a cache hit with no repeat conversion. Verify selection,
measurement, clipping, categories, and properties behave as documented for a
prepared model.

- [ ] **Step 3: Capture required screenshots**

At an identical camera position, save screenshots for normal, Edges,
hidden-lines/PEN, and clipped-PEN. Inspect them for the historical black
edge-on gloss slab and for lines visible through faces. If either appears,
stop and repair it before accepting the task.

- [ ] **Step 4: Record evidence and final verification**

Create `docs/verification/thatopen-3-hidden-lines-acceptance.md` containing
the date, exact package versions, model byte size, cache miss/hit results,
four screenshot paths, and the final command result. Then run:

```bash
npm test
git diff --check
git status --short
```

Expected: all automated checks pass and only intentional acceptance evidence
is pending.

- [ ] **Step 5: Commit acceptance evidence**

```bash
git add docs/verification/thatopen-3-hidden-lines-acceptance.md README.md
git commit -m "docs: verify That Open 3 hidden-line migration"
```
