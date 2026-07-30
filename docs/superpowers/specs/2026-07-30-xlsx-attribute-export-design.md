# XLSX attribute export — design

Date: 2026-07-30
Status: approved, ready for planning
Priority: implement before the ruler measurement feature

## Problem

The properties panel shows one element at a time. Checking a whole model — every
member's section, length, volume and material — means clicking 1300 elements.
`src/ifc-parameters.ts` already extracts all of it; there is no way to get it out.

## Goals

- One toolbar button exports every element's parameters to a single `.xlsx`.
- Numbers land in cells as numbers, so they sort, sum and pivot.
- Readable without post-processing: one sheet per IFC class, units in headers.
- No regression risk to the renderer bundle, which is known to be fragile.

## Non-goals

- Filtering, column selection or an export dialog. One button, one workbook.
- Import or round-tripping. Export only.
- Exporting streamed models (>50 MB). They have no parameter reader; the button
  reports that rather than writing an empty file.

## Measured facts this design rests on

Taken from the two Centre for Jewish Life models on 2026-07-30:

| Fact | PAC | Halev |
| --- | --- | --- |
| Elements (beam/column/member/wall/slab) | 1307 | 887 |
| Parameter rows produced | 69,597 | 47,785 |
| Full extraction time | 467 ms | 203 ms |
| Elements with more than one swept solid | 0 | 0 |
| Distinct qualified columns per class | 46–68 | 46–65 |

Extraction is sub-second, so there is no progress UI, no streaming and no option
to skip derived geometry. Labels `ProfileName`, `Name` and `Depth` each occur in
two different groups, which is why columns must be qualified by group.

## Module boundaries

Three pieces, each independently testable:

```
src/report.ts          ElementParameters[] -> WorkbookModel      (pure, no DOM, no electron)
src/ui/export.ts       button, viewer wiring, toasts             (DOM only)
electron/xlsx-writer.ts  WorkbookModel -> .xlsx on disk          (exceljs, node only)
```

`WorkbookModel` is a plain data structure — sheet names, column definitions,
row arrays. It is the IPC payload.

### Why exceljs runs in the main process

`vite.config.ts` disables tree-shaking and uses terser specifically because
web-ifc's CommonJS shim kept being mangled; the git history is a trail of fixes
for exactly that. Adding another CJS-heavy library to that bundle invites the
same class of failure. `electron/` is compiled by `tsc` with no bundler, so
exceljs cannot be mangled there, and the renderer bundle does not grow.

exceljs goes in `dependencies`, not `devDependencies`, so electron-builder
includes it in the packaged app.

### Why the payload type is declared twice

`tsconfig.electron.json` sets `rootDir: "electron"` and `include: ["electron"]`,
so `electron/` cannot import from `src/`. Widening `rootDir` would change the
output layout and break `package.json`'s `main: dist-electron/main.js`.

So `WorkbookModel` is declared in `src/report.ts` and again, structurally
identical, in `electron/xlsx-writer.ts`. This is honest rather than merely
expedient: the two sides are separately compiled programs communicating by
structured clone, so the contract is structural in reality. The round-trip test
(below) is what enforces that they agree; a divergence fails it.

## Data model change: raw values on ParamRow

`ParamRow` currently carries display strings only — `"5000 mm"`, `"0.015809 m³"`.
Written into cells as-is, nothing sorts or sums. Parsing the strings back out
would be self-inflicted, so the reader exposes the magnitude directly:

```ts
export interface ParamRow {
  label: string;
  value: string;   // display form, unchanged
  raw?: number;    // magnitude in the unit named by `unit`
  unit?: string;   // "mm", "m²", "m³", "mm⁴"; "" when dimensionless
}
```

Additive and backwards compatible: the properties panel keeps rendering `value`
and does not change. Every numeric formatter in `src/ifc-parameters.ts`
populates `raw` and `unit`:

| Formatter | `unit` |
| --- | --- |
| `fmtLength`, `fmtLengthFromMetres` | project display unit (`mm`) |
| `fmtArea` | `m²` |
| `fmtVolume` | `m³` |
| `fmtProfileProperty` | `mm`, `mm²`, `mm³`, `mm⁴`, `mm⁶` per dimension |
| direction components (`XDirX` …) | `""` |
| `propertyRow` quantity and single-value branches | the property's own unit symbol |

Text rows (`ProfileName`, `Material.Name`, `ProfileType`) leave both undefined
and export as strings.

### Cell type rules

Applied in order, so there is exactly one reading:

1. `raw` is a number → numeric cell, and `unit` goes in the header.
2. Otherwise `value` is exactly `"True"` or `"False"` → boolean cell. This is how
   `Geometry.IsSolid` becomes a real boolean rather than the text `"True"`.
3. Otherwise `value` is exactly `"—"` (the reader's not-set marker) → empty cell.
   An absent optional dimension must not become the string `"—"` in a numeric
   column, and must not become `0`.
4. Otherwise → string cell.

### Derived columns

Three columns have no corresponding `ParamRow` and are computed by
`src/report.ts`:

| Column | Derivation |
| --- | --- |
| `Level` | The `Container` row of `ReferenceObject`, with the trailing `(IfcBuildingStorey)` class annotation stripped, so it reads `Story4` rather than `Story4 (IfcBuildingStorey)`. Empty when the element has no spatial container. |
| `SolidCount` | Number of swept solids found for the element: `1` when no group name carries a numeric suffix, otherwise the highest suffix seen. |
| `TessellationSuspect` | `TRUE` when the element's `CalculatedGeometryValues` group contains the `⚠ Tessellation` row, `FALSE` otherwise. The warning's prose stays out of the cells; this column is what you filter on to find the RHS members and concave slabs affected by the two upstream web-ifc defects. |

## Workbook structure

### Element sheets

One per IFC class present in the model, named for the class in plural form:
`Beams`, `Columns`, `Members`, `Walls`, `Slabs`. Column order is fixed groups
first, then parameters in the order the reader produces them:

1. **Identity, unqualified** — from the `ReferenceObject` group, because these
   identify the row rather than measure it: `ExpressID`, `Name`, `IfcClass`,
   `GUID`, `Level`, `CommonType`. `FileFormat` and `FileLengthUnit` are dropped;
   they are constant per file and belong on the `Model` sheet.
2. **Qualified parameter columns** — `<Prefix><Label> [unit]`:

   | Group | Prefix |
   | --- | --- |
   | `IfcShapeProfile` | `Profile.` |
   | `Extrusion` | `Extrusion.` |
   | `CalculatedGeometryValues` | `Geometry.` |
   | `IfcMaterial` | `Material.` |
   | `IfcMaterialLayerSetUsage` | `LayerSetUsage.` |
   | `IfcMaterialLayerSet` | `LayerSet.` |
   | property / quantity sets | the set's own name, e.g. `Qto_BeamBaseQuantities.` |

   `IfcStructuralProfileProperties` is excluded here — see `Profiles` below.
3. **Flags** — `SolidCount`, `TessellationSuspect`.

Columns are the union of what that class's elements actually produce, so a class
mixing I-sections and CHS gets both `Profile.OverallWidth` and `Profile.Radius`,
blank where inapplicable. Blank means "this element has no such parameter", never
zero. Header row is frozen with auto-filter enabled.

### The `Profiles` sheet

Section properties describe the *section*, not the element. Repeating
`MomentOfInertiaY` across 501 beams is both bloat and a misstatement of where
the data lives. So one row per unique `ProfileName`:

`ProfileName`, `ProfileDef`, the profile dimensions, then the full
`IfcStructuralProfileProperties` set. Roughly 30 rows in place of ~1300
repetitions, and it doubles as a section schedule.

Profile *dimensions* appear on both the element sheets and here. That
duplication is deliberate: scanning a member schedule for depth is the common
case, and forcing a VLOOKUP for it would be hostile. Section properties
(`MomentOfInertia*`, `SectionModulus*`, `TorsionalConstantX`, shear areas) appear
only here. The rule is: **dimensions inline and normalised, section properties
normalised only.**

Elements join to it on `Profile.ProfileName`.

### The `Model` sheet

Key/value rows: source filename, IFC schema, native length unit and its
conversion to mm, per-class element counts, total elements, export timestamp,
app version from `package.json`. Cheap, and it makes a stray workbook
self-describing months later.

## Multi-solid elements

A rectangular sheet cannot hold a variable number of solids. Rule: **the first
solid populates the `Profile.*` and `Extrusion.*` columns, and `SolidCount`
records how many there were.** `Geometry.*` is unaffected — it already covers the
whole element's mesh.

Neither project model has any such element (0 of 2194), but if a future model
does, the export must not quietly mislead: when any `SolidCount > 1`, the toast
on success names how many elements were truncated. No silent caps.

## IPC contract

Two channels, so a 5–10 MB payload is never serialised for a cancelled dialog:

```ts
// preload.ts, added to the existing window.electron surface
saveXlsxDialog: (suggestedName: string) => Promise<string | null>;
writeXlsx: (filePath: string, model: WorkbookModel) => Promise<void>;
```

`dialog:save-xlsx` shows a save dialog defaulting to the model's basename with
an `.xlsx` extension and returns the chosen path, or `null` if cancelled.
`file:write-xlsx` builds the workbook with exceljs and writes it, rejecting with
a readable message on failure.

## UI

A button in `#toolbar` beside `Open IFC…`, labelled `Export XLSX`:

- Disabled until a model is loaded; re-disabled on unload.
- Disabled while a write is in flight, label `Exporting…`, so a double click
  cannot start two writes.
- Success: `toast("Exported 1307 elements to <filename>", "info")`.
- Cancelled dialog: no toast, no error — the user changed their mind.
- Failure: `toast(message)` via the existing error path.
- Streamed model: `toast("Parameters are unavailable for streamed models over 50 MB")`.

Follows the existing `mountX(viewer)` convention in `src/ui/`, so
`@thatopen/*` stays out of the UI layer.

## Error handling

| Case | Behaviour |
| --- | --- |
| No model loaded | Button disabled; not reachable. |
| Streamed model (no parameter reader) | Toast explaining why; no file written. |
| Save dialog cancelled | Silent no-op. |
| Target path not writable, or file open in Excel | Rejection surfaced verbatim in a toast; no partial file left behind. |
| A single element throws during extraction | Skipped, counted, and the count reported in the success toast. One bad element must not lose the other 1306. |

## Testing

**Unit, `src/report.ts`** (pure, node, no Electron):
- Column union across mixed profile types: an I-section and a CHS in one class
  produce both dimension sets, with blanks — not zeros — where inapplicable.
- Colliding labels stay distinct: `Profile.ProfileName` and `Material.Name` do
  not overwrite each other, and neither collides with the identity `Name`.
- `Profiles` has exactly one row per unique `ProfileName`, and section properties
  appear there and not on element sheets.
- `SolidCount` reports >1 for a synthetic multi-solid element.

**Round-trip, `electron/xlsx-writer.ts`** (node + exceljs, no Electron):
Build from `tests/fixtures/i-beam.ifc`, write to a temp path, read back and
assert:
- `Profile.OverallWidth [mm]` holds the **number** `133`, not `"133 mm"`.
- `Geometry.Volume [m³]` is numeric and within tolerance of `0.0158086`.
- Header text carries the unit; the cell does not.
- Sheet names and the frozen header row are as specified.

This test is also what keeps the two `WorkbookModel` declarations honest.

**E2E, Playwright + Electron** via the existing `tests/launch.ts`:
Load the fixture, click `Export XLSX` with the dialog stubbed to a temp path,
assert the file exists, is non-empty, and opens with the expected sheet names.

## Risks

1. **Column union correctness** is the main source of subtle wrongness — a
   misaligned row would put a web thickness under a radius header. The unit tests
   target this directly.
2. **The two `WorkbookModel` declarations drifting.** Mitigated by the
   round-trip test, not by discipline.
3. **exceljs in the packaged app** — it must be in `dependencies` and survive
   electron-builder's pruning. Verified by packaging once, not assumed.
4. **Excel's 32,767-character cell limit** is far above anything here; noted and
   dismissed.

## Out of scope

Column pickers, saved export profiles, CSV output, exporting the geometry
warnings as anything richer than the `TessellationSuspect` flag, and any
attempt to work around the two upstream web-ifc tessellation defects. Those
remain flagged in the panel and in that column.
