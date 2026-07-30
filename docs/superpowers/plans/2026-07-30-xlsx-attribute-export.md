# XLSX Attribute Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one toolbar button that exports every element's IFC parameters to an `.xlsx` workbook with one sheet per IFC class, numeric cells, and units in the headers.

**Architecture:** The renderer extracts parameters (already implemented in `src/ifc-parameters.ts`) and a pure builder in `src/report.ts` turns them into a `WorkbookModel` — plain sheet/column/row data. That model crosses IPC to the Electron main process, where `electron/xlsx-writer.ts` writes it with exceljs. The spreadsheet library stays out of the renderer bundle, which is known-fragile.

**Tech Stack:** TypeScript, Electron, exceljs (main process only), Playwright (both unit and e2e tests).

**Spec:** `docs/superpowers/specs/2026-07-30-xlsx-attribute-export-design.md`

## Global Constraints

- Repository: `C:\Users\fujial\fujia-dev\ifc-viewer`, branch `master`. **Not** the worktree.
- **Never push to a remote.** Local commits only. (There is no remote configured; do not add one.)
- `src/` compiles under `tsconfig.json`: `strict` **and** `noUncheckedIndexedAccess`. Indexing an array yields `T | undefined` — handle it explicitly or use `!` where a bound is provably safe.
- `electron/` compiles under `tsconfig.electron.json`: `strict`, `module: CommonJS`, `rootDir: "electron"`. **`electron/` cannot import from `src/`.**
- `@thatopen/*` and `three` must never be imported from `src/ui/`.
- exceljs goes in `dependencies`, not `devDependencies`, so electron-builder packages it.
- Tests live in `tests/` and are Playwright specs (`import { expect, test } from "@playwright/test"`), including pure unit tests. There is no jest.
- Playwright compiles specs to CJS: use `__dirname`, never `import.meta.url`.
- Display length unit is `mm` throughout, matching the properties panel.
- Run `npx tsc --noEmit -p tsconfig.json` after touching `src/`, and `npx tsc -p tsconfig.electron.json` after touching `electron/`.
- Commit after every task with `git -c commit.gpgsign=false commit`.

---

### Task 1: Expose raw values and units on `ParamRow`

Cells must hold numbers, not `"5000 mm"`. This adds `raw` and `unit` beside the existing display string, and routes every numeric formatter through a row builder. Purely additive — the properties panel keeps reading `value`.

**Files:**
- Modify: `src/ifc-parameters.ts:18-21` (the `ParamRow` interface)
- Modify: `src/ifc-parameters.ts` (row construction sites; see Step 3)
- Modify: `src/viewer.ts:432` (add `getModelUnits()` after `isStreamed()`)
- Test: `tests/param-raw-values.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ParamRow` gains `raw?: number` and `unit?: string`.
  - `Viewer.getModelUnits(): { schema: string; lengthUnit: string; lengthToMetres: number } | null`

- [ ] **Step 1: Write the failing test**

Create `tests/param-raw-values.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as WEBIFC from "web-ifc";

import {
  IfcParameterReader,
  PARAMETER_MODEL_SETTINGS,
  type ParamGroup,
} from "../src/ifc-parameters";

const FIXTURE = path.resolve(__dirname, "fixtures/i-beam.ifc");

async function readFixture() {
  const api = new WEBIFC.IfcAPI();
  await api.Init();
  const modelId = api.OpenModel(
    new Uint8Array(readFileSync(FIXTURE)),
    PARAMETER_MODEL_SETTINGS as any,
  );
  const reader = IfcParameterReader.attach(api, modelId);
  const ids = api.GetLineIDsWithType(modelId, WEBIFC.IFCBEAM);
  const params = reader.getElementParameters(ids.get(0));
  if (!params) throw new Error("fixture beam produced no parameters");
  return { reader, params };
}

function group(groups: ParamGroup[], name: string): ParamGroup {
  const found = groups.find((g) => g.name === name);
  if (!found) throw new Error(`no group ${name}`);
  return found;
}

function row(groups: ParamGroup[], groupName: string, label: string) {
  const found = group(groups, groupName).rows.find((r) => r.label === label);
  if (!found) throw new Error(`no row ${groupName}/${label}`);
  return found;
}

test("length parameters carry a numeric magnitude in mm", async () => {
  const { reader, params } = await readFixture();
  const width = row(params.groups, "IfcShapeProfile", "OverallWidth");
  expect(width.value).toBe("133 mm");
  expect(width.raw).toBe(133);
  expect(width.unit).toBe("mm");

  const depth = row(params.groups, "Extrusion", "Depth");
  expect(depth.raw).toBe(5000);
  expect(depth.unit).toBe("mm");
  reader.close();
});

test("volume and area carry SI magnitudes", async () => {
  const { reader, params } = await readFixture();
  const volume = row(params.groups, "CalculatedGeometryValues", "Volume");
  expect(volume.unit).toBe("m³");
  expect(volume.raw).toBeCloseTo(0.0158086, 6);

  const area = row(params.groups, "CalculatedGeometryValues", "Area");
  expect(area.unit).toBe("m²");
  expect(area.raw).toBeGreaterThan(0);
  reader.close();
});

test("section properties carry their dimensional unit", async () => {
  const { reader, params } = await readFixture();
  const inertia = row(
    params.groups,
    "IfcStructuralProfileProperties",
    "MomentOfInertiaY",
  );
  expect(inertia.raw).toBeCloseTo(23600000, 0);
  expect(inertia.unit).toBe("mm⁴");
  reader.close();
});

test("text and unset parameters carry no magnitude", async () => {
  const { reader, params } = await readFixture();
  const name = row(params.groups, "IfcShapeProfile", "ProfileName");
  expect(name.value).toBe("200UB25.4");
  expect(name.raw).toBeUndefined();

  const fillet = row(params.groups, "IfcShapeProfile", "FilletRadius");
  expect(fillet.value).toBe("—");
  expect(fillet.raw).toBeUndefined();
  reader.close();
});

test("direction components are dimensionless numbers", async () => {
  const { reader, params } = await readFixture();
  const xdir = row(params.groups, "Extrusion", "XDirX");
  expect(xdir.raw).toBe(1);
  expect(xdir.unit).toBe("");
  reader.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/param-raw-values.spec.ts`
Expected: FAIL — `expect(width.raw).toBe(133)` receives `undefined`, because `ParamRow` has no `raw` yet.

- [ ] **Step 3: Implement**

In `src/ifc-parameters.ts`, replace the `ParamRow` interface at lines 18-21:

```ts
export interface ParamRow {
  label: string;
  /** Display form, e.g. "133 mm". Unchanged; the properties panel reads this. */
  value: string;
  /**
   * Numeric magnitude expressed in `unit`. Present only for numeric
   * parameters, so a spreadsheet export can write real numbers instead of
   * parsing the display string back apart.
   */
  raw?: number;
  /** Unit `raw` is expressed in. "" when dimensionless. Absent with `raw`. */
  unit?: string;
}
```

Add these row builders inside the `IfcParameterReader` class, immediately after `fmtVolume` (currently line 1336):

```ts
  // --- Row builders -------------------------------------------------------
  // Every numeric parameter goes through one of these so `raw`/`unit` can
  // never drift from the formatted string beside it.

  private lengthRow(label: string, value: number): ParamRow {
    return {
      label,
      value: this.fmtLength(value),
      raw: value * this.modelToDisplay,
      unit: DISPLAY_LENGTH_UNIT,
    };
  }

  /** For values web-ifc already scaled to metres (tessellated geometry). */
  private metresLengthRow(label: string, metres: number): ParamRow {
    return {
      label,
      value: this.fmtLengthFromMetres(metres),
      raw: metres / DISPLAY_LENGTH_IN_METRES,
      unit: DISPLAY_LENGTH_UNIT,
    };
  }

  private areaRow(label: string, modelUnits: number): ParamRow {
    return {
      label,
      value: this.fmtArea(modelUnits),
      raw: modelUnits * this.lengthToMetres ** 2,
      unit: "m²",
    };
  }

  private volumeRow(label: string, modelUnits: number): ParamRow {
    return {
      label,
      value: this.fmtVolume(modelUnits),
      raw: modelUnits * this.lengthToMetres ** 3,
      unit: "m³",
    };
  }

  /** Volume/area already in SI, as produced from the tessellated mesh. */
  private siRow(label: string, si: number, unit: "m²" | "m³"): ParamRow {
    return { label, value: `${fmtSignificant(si)} ${unit}`, raw: si, unit };
  }

  private numberRow(label: string, value: number, decimals = 3): ParamRow {
    return { label, value: fmt(value, decimals), raw: value, unit: "" };
  }
```

Then convert each numeric row construction site to use them. The complete list:

1. **`profileGroup`** — the numeric branch of the attribute loop becomes:

```ts
      if (typeof value === "number") {
        rows.push(
          ANGLE_ATTRS.test(key)
            ? { label: key, value: `${fmt(value)} rad`, raw: value, unit: "rad" }
            : this.lengthRow(key, value),
        );
      } else if (value === null) {
```

2. **`profileGroup`** — the outline and derived-area rows:

```ts
      rows.push({ label: "Points", value: String(outline.count), raw: outline.count, unit: "" });
      rows.push(this.lengthRow("BoundingWidth", outline.width));
      rows.push(this.lengthRow("BoundingDepth", outline.depth));
      if (outline.simple) {
        rows.push(this.areaRow("EnclosedArea", outline.area));
      } else {
        rows.push({ label: "EnclosedArea", value: "n/a (self-intersecting outline)" });
      }
```

```ts
    if (derivedArea !== null) {
      rows.push(this.areaRow("CrossSectionArea (derived)", derivedArea));
    }
```

3. **`extrusionGroup`** — the whole `rows` array (currently lines ~745-757):

```ts
      rows: [
        ...(derived === null ? [] : [this.volumeRow("Volume (profile×depth)", derived)]),
        this.lengthRow("OriginX", origin.x),
        this.lengthRow("OriginY", origin.y),
        this.lengthRow("OriginZ", origin.z),
        this.numberRow("XDirX", xDir.x, 12),
        this.numberRow("XDirY", xDir.y, 12),
        this.numberRow("XDirZ", xDir.z, 12),
        this.lengthRow("ExtrusionX", extrusion.x),
        this.lengthRow("ExtrusionY", extrusion.y),
        this.lengthRow("ExtrusionZ", extrusion.z),
        this.lengthRow("Depth", depth),
      ],
```

4. **`fmtProfileProperty`** — replace the method with a row builder. Delete `fmtProfileProperty` and add:

```ts
  /** Converts a section property into the display length unit and labels it. */
  private profilePropertyRow(attr: string, value: number): ParamRow {
    for (const [pattern, exponent] of PROFILE_PROPERTY_DIMENSION) {
      if (!pattern.test(attr)) continue;
      const converted = value * this.modelToDisplay ** exponent;
      const unit = `${DISPLAY_LENGTH_UNIT}${exponent === 1 ? "" : superscript(exponent)}`;
      return { label: attr, value: `${fmt(converted)} ${unit}`, raw: converted, unit };
    }
    // Unknown dimension (e.g. PhysicalWeight): report the stored number as-is
    // rather than guess at a conversion.
    return { label: attr, value: fmt(value), raw: value, unit: "" };
  }
```

In `sectionPropertyGroups`, replace the push with:

```ts
        rows.push(
          typeof value === "number"
            ? this.profilePropertyRow(key, value)
            : { label: key, value: text(value) },
        );
```

5. **`calculatedGeometryGroup`** — the volume/area/centroid rows:

```ts
    const rows: ParamRow[] = [
      this.siRow("Volume", volume, "m³"),
      this.siRow("Area", area, "m²"),
    ];
    if (volume > 0) {
      rows.push(
        this.metresLengthRow("CenterOfGravityX", centroid.x / signedVolume),
        this.metresLengthRow("CenterOfGravityY", centroid.y / signedVolume),
        this.metresLengthRow("CenterOfGravityZ", centroid.z / signedVolume),
      );
    }
    rows.push({ label: "IsSolid", value: closed && volume > 0 ? "True" : "False" });
    rows.push({ label: "Triangles", value: String(triangles), raw: triangles, unit: "" });
```

Leave the `⚠ Tessellation` row exactly as it is — text only, no `raw`. Task 2 turns it into a flag column.

6. **`describeMaterial`** — the layer-set offset and thickness rows:

```ts
      rows.push(
        offset === null
          ? { label: "OffsetFromReferenceLine", value: UNSET }
          : this.lengthRow("OffsetFromReferenceLine", offset),
      );
```

```ts
        rows.push({
          label: `Layer ${i++}`,
          value: `${materialName} · ${this.fmtLength(thickness)}`,
        });
```
(leave `Layer N` as text — it combines a name and a thickness, so it has no single magnitude)

```ts
      rows.push(this.lengthRow("TotalThickness", total));
```

7. **`propertyRow`** — the quantity branch:

```ts
      if (key === "LengthValue") return this.lengthRow(label, value);
      if (key === "AreaValue") return this.areaRow(label, value);
      if (key === "VolumeValue") return this.volumeRow(label, value);
      return { label, value: fmt(value), raw: value, unit: "" };
```

and the `NominalValue` branch, so numeric property-set values export as numbers:

```ts
    if (prop.NominalValue !== undefined) {
      const value = scalarOf(prop.NominalValue);
      if (value === null) return { label, value: UNSET };
      const unitId = refId(prop.Unit);
      const unit = unitId === null ? null : this.line(unitId);
      const symbol = unit ? this.unitSymbol(unit) : "";
      const display = `${text(value)}${symbol ? ` ${symbol}` : ""}`;
      return typeof value === "number"
        ? { label, value: display, raw: value, unit: symbol }
        : { label, value: display };
    }
```

Finally add `getModelUnits` to `src/viewer.ts`, after `isStreamed()` (line 432):

```ts
  /**
   * Unit and schema metadata for the loaded model. Null when the raw parameter
   * reader is unavailable, i.e. for streamed models.
   */
  getModelUnits(): {
    schema: string;
    lengthUnit: string;
    lengthToMetres: number;
  } | null {
    if (!this.paramReader) return null;
    return {
      schema: this.paramReader.schema,
      lengthUnit: this.paramReader.lengthUnit,
      lengthToMetres: this.paramReader.lengthToMetres,
    };
  }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test tests/param-raw-values.spec.ts`
Expected: PASS, 5 tests.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npx playwright test`
Expected: all pre-existing tests still pass (19 before this task, 24 after). This confirms the properties panel is unaffected.

Run: `npm run check:params -- "C:/Users/fujial/Documents/264034 - Centre for Jewish Life/rhino/rhino-ifc-20260728/264034-TTW-P3-RH-ST-001-[01] - Halev IFC Model.ifc"`
Expected: ends with `OK — no missing groups`. This is the regression guard that the display strings did not change.

- [ ] **Step 5: Commit**

```bash
git add src/ifc-parameters.ts src/viewer.ts tests/param-raw-values.spec.ts
git -c commit.gpgsign=false commit -m "feat: expose raw magnitudes and units on ParamRow

Display strings alone cannot be exported to a spreadsheet -- a cell holding
\"5000 mm\" will not sort or sum. Every numeric parameter now carries its
magnitude and unit alongside the formatted text, routed through row builders so
the two cannot drift apart."
```

---

### Task 2: Pure workbook builder — element sheets

`src/report.ts` turns `ElementParameters[]` into a `WorkbookModel`. Pure data in, pure data out: no DOM, no Electron, no `@thatopen/*`, so it unit-tests with hand-built inputs.

**Files:**
- Create: `src/report.ts`
- Test: `tests/report.spec.ts`

**Interfaces:**
- Consumes: `ParamRow` (`raw`, `unit`, `value`), `ParamGroup`, `ElementParameters` from Task 1.
- Produces:
  - `type CellValue = number | string | boolean | null`
  - `interface ColumnDef { key: string; header: string }`
  - `interface SheetModel { name: string; columns: ColumnDef[]; rows: CellValue[][] }`
  - `interface WorkbookModel { sheets: SheetModel[]; truncatedMultiSolid: number; skipped: number }`
  - `interface ReportInput { filename: string; schema: string; lengthUnit: string; lengthToMetres: number; elements: ElementParameters[] }`
  - `function buildWorkbook(input: ReportInput): WorkbookModel`
  - `function cellOf(row: ParamRow): CellValue`

- [ ] **Step 1: Write the failing test**

Create `tests/report.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { buildWorkbook, cellOf, type ReportInput } from "../src/report";
import type { ElementParameters, ParamGroup } from "../src/ifc-parameters";

function element(
  expressId: number,
  ifcClass: string,
  name: string,
  groups: ParamGroup[],
): ElementParameters {
  return { expressId, ifcClass, name, groups };
}

const REFERENCE: ParamGroup = {
  name: "ReferenceObject",
  rows: [
    { label: "Name", value: "B1" },
    { label: "IFC Class", value: "IfcBeam" },
    { label: "GUID (IFC)", value: "1Beam00000000000000000" },
    { label: "Express ID", value: "#49" },
    { label: "File Format", value: "IFC2X3" },
    { label: "File Length Unit", value: "mm" },
    { label: "Common Type", value: "UB" },
    { label: "Container", value: "Level 1 (IfcBuildingStorey)" },
  ],
};

function input(elements: ElementParameters[]): ReportInput {
  return {
    filename: "m.ifc",
    schema: "IFC2X3",
    lengthUnit: "mm",
    lengthToMetres: 0.001,
    elements,
  };
}

function sheet(model: ReturnType<typeof buildWorkbook>, name: string) {
  const found = model.sheets.find((s) => s.name === name);
  if (!found) throw new Error(`no sheet ${name}: have ${model.sheets.map((s) => s.name)}`);
  return found;
}

function cell(
  model: ReturnType<typeof buildWorkbook>,
  sheetName: string,
  rowIndex: number,
  header: string,
) {
  const s = sheet(model, sheetName);
  const col = s.columns.findIndex((c) => c.header === header);
  if (col === -1) throw new Error(`no column "${header}": have ${s.columns.map((c) => c.header)}`);
  return s.rows[rowIndex]![col];
}

test("cellOf applies the type rules in order", () => {
  expect(cellOf({ label: "d", value: "133 mm", raw: 133, unit: "mm" })).toBe(133);
  expect(cellOf({ label: "s", value: "True" })).toBe(true);
  expect(cellOf({ label: "s", value: "False" })).toBe(false);
  expect(cellOf({ label: "u", value: "—" })).toBeNull();
  expect(cellOf({ label: "t", value: "200UB25.4" })).toBe("200UB25.4");
  // A raw of 0 is a real measurement and must not be treated as absent.
  expect(cellOf({ label: "z", value: "0 mm", raw: 0, unit: "mm" })).toBe(0);
});

test("identity columns come first and are unqualified", () => {
  const model = buildWorkbook(input([element(49, "IfcBeam", "B1", [REFERENCE])]));
  const s = sheet(model, "Beams");
  expect(s.columns.slice(0, 6).map((c) => c.header)).toEqual([
    "ExpressID",
    "Name",
    "IfcClass",
    "GUID",
    "Level",
    "CommonType",
  ]);
  expect(cell(model, "Beams", 0, "ExpressID")).toBe(49);
  expect(cell(model, "Beams", 0, "Name")).toBe("B1");
  expect(cell(model, "Beams", 0, "GUID")).toBe("1Beam00000000000000000");
});

test("Level strips the spatial class annotation", () => {
  const model = buildWorkbook(input([element(49, "IfcBeam", "B1", [REFERENCE])]));
  expect(cell(model, "Beams", 0, "Level")).toBe("Level 1");
});

test("units go in the header and never in the cell", () => {
  const model = buildWorkbook(
    input([
      element(49, "IfcBeam", "B1", [
        REFERENCE,
        {
          name: "IfcShapeProfile",
          rows: [{ label: "OverallWidth", value: "133 mm", raw: 133, unit: "mm" }],
        },
      ]),
    ]),
  );
  expect(cell(model, "Beams", 0, "Profile.OverallWidth [mm]")).toBe(133);
});

test("colliding labels stay distinct across groups", () => {
  const model = buildWorkbook(
    input([
      element(49, "IfcBeam", "B1", [
        REFERENCE,
        { name: "IfcShapeProfile", rows: [{ label: "ProfileName", value: "200UB25.4" }] },
        { name: "IfcMaterial", rows: [{ label: "Name", value: "Steel" }] },
        { name: "Extrusion", rows: [{ label: "Depth", value: "5000 mm", raw: 5000, unit: "mm" }] },
      ]),
    ]),
  );
  expect(cell(model, "Beams", 0, "Profile.ProfileName")).toBe("200UB25.4");
  expect(cell(model, "Beams", 0, "Material.Name")).toBe("Steel");
  expect(cell(model, "Beams", 0, "Name")).toBe("B1");
  expect(cell(model, "Beams", 0, "Extrusion.Depth [mm]")).toBe(5000);
});

test("mixed profile types produce a column union with blanks, not zeros", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcMember", "M1", [
        REFERENCE,
        {
          name: "IfcShapeProfile",
          rows: [{ label: "OverallWidth", value: "133 mm", raw: 133, unit: "mm" }],
        },
      ]),
      element(2, "IfcMember", "M2", [
        REFERENCE,
        {
          name: "IfcShapeProfile",
          rows: [{ label: "Radius", value: "84 mm", raw: 84, unit: "mm" }],
        },
      ]),
    ]),
  );
  expect(cell(model, "Members", 0, "Profile.OverallWidth [mm]")).toBe(133);
  expect(cell(model, "Members", 0, "Profile.Radius [mm]")).toBeNull();
  expect(cell(model, "Members", 1, "Profile.OverallWidth [mm]")).toBeNull();
  expect(cell(model, "Members", 1, "Profile.Radius [mm]")).toBe(84);
});

test("tessellation warnings become a filterable flag, not prose in a cell", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcSlab", "S1", [
        REFERENCE,
        {
          name: "CalculatedGeometryValues",
          rows: [
            { label: "Volume", value: "0.7 m³", raw: 0.7, unit: "m³" },
            { label: "⚠ Tessellation", value: "differs from profile×depth by 78.3%" },
          ],
        },
      ]),
      element(2, "IfcSlab", "S2", [
        REFERENCE,
        {
          name: "CalculatedGeometryValues",
          rows: [{ label: "Volume", value: "1.0 m³", raw: 1, unit: "m³" }],
        },
      ]),
    ]),
  );
  expect(cell(model, "Slabs", 0, "TessellationSuspect")).toBe(true);
  expect(cell(model, "Slabs", 1, "TessellationSuspect")).toBe(false);
  const headers = sheet(model, "Slabs").columns.map((c) => c.header);
  expect(headers).not.toContain("Geometry.⚠ Tessellation");
});

test("multi-solid elements report their solid count and are counted", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcBeam", "B1", [
        REFERENCE,
        { name: "IfcShapeProfile", rows: [{ label: "ProfileName", value: "A" }] },
        { name: "IfcShapeProfile 2", rows: [{ label: "ProfileName", value: "B" }] },
        { name: "Extrusion 2", rows: [{ label: "Depth", value: "1 mm", raw: 1, unit: "mm" }] },
      ]),
      element(2, "IfcBeam", "B2", [
        REFERENCE,
        { name: "IfcShapeProfile", rows: [{ label: "ProfileName", value: "C" }] },
      ]),
    ]),
  );
  expect(cell(model, "Beams", 0, "SolidCount")).toBe(2);
  expect(cell(model, "Beams", 1, "SolidCount")).toBe(1);
  // Only the first solid populates the Profile.* columns.
  expect(cell(model, "Beams", 0, "Profile.ProfileName")).toBe("A");
  expect(model.truncatedMultiSolid).toBe(1);
});

test("property sets are qualified by their own set name", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcBeam", "B1", [
        REFERENCE,
        { name: "Pset_BeamCommon", rows: [{ label: "Reference", value: "200UB25.4" }] },
      ]),
    ]),
  );
  expect(cell(model, "Beams", 0, "Pset_BeamCommon.Reference")).toBe("200UB25.4");
});

test("one sheet per class, named in plural", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcBeam", "B", [REFERENCE]),
      element(2, "IfcColumn", "C", [REFERENCE]),
      element(3, "IfcWall", "W", [REFERENCE]),
    ]),
  );
  const names = model.sheets.map((s) => s.name);
  expect(names).toContain("Beams");
  expect(names).toContain("Columns");
  expect(names).toContain("Walls");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/report.spec.ts`
Expected: FAIL — cannot resolve `../src/report`.

- [ ] **Step 3: Implement**

Create `src/report.ts`:

```ts
import type { ElementParameters, ParamGroup, ParamRow } from "./ifc-parameters";

/**
 * Turns extracted element parameters into a flat workbook description.
 *
 * Pure: no DOM, no Electron, no @thatopen imports, so it unit-tests with
 * hand-built inputs. The result crosses IPC to the main process, which owns the
 * spreadsheet library.
 */

export type CellValue = number | string | boolean | null;

export interface ColumnDef {
  /** Stable identity for the column, without the unit suffix. */
  key: string;
  /** Header text as written to the sheet, including a `[unit]` suffix. */
  header: string;
}

export interface SheetModel {
  name: string;
  columns: ColumnDef[];
  /** One array per row, positionally aligned to `columns`. */
  rows: CellValue[][];
}

export interface WorkbookModel {
  sheets: SheetModel[];
  /** Elements whose Profile./Extrusion. columns came from only their first solid. */
  truncatedMultiSolid: number;
  /** Elements that produced no parameters and were left out. */
  skipped: number;
}

export interface ReportInput {
  filename: string;
  schema: string;
  lengthUnit: string;
  lengthToMetres: number;
  elements: ElementParameters[];
}

/** Column prefix per parameter group. */
const GROUP_PREFIX = new Map<string, string>([
  ["IfcShapeProfile", "Profile."],
  ["Extrusion", "Extrusion."],
  ["CalculatedGeometryValues", "Geometry."],
  ["IfcMaterial", "Material."],
  ["IfcMaterialLayerSetUsage", "LayerSetUsage."],
  ["IfcMaterialLayerSet", "LayerSet."],
]);

/** Section properties are normalised onto the Profiles sheet instead. */
const SECTION_PROPERTY_GROUP = /ProfileProperties$/;

/**
 * ReferenceObject rows already surfaced as identity columns, or dropped because
 * they are constant per file and live on the Model sheet.
 */
const REFERENCE_HANDLED = new Set([
  "Name",
  "IFC Class",
  "GUID (IFC)",
  "Express ID",
  "Common Type",
  "Container",
  "File Format",
  "File Length Unit",
]);

const IDENTITY_COLUMNS: ColumnDef[] = [
  { key: "ExpressID", header: "ExpressID" },
  { key: "Name", header: "Name" },
  { key: "IfcClass", header: "IfcClass" },
  { key: "GUID", header: "GUID" },
  { key: "Level", header: "Level" },
  { key: "CommonType", header: "CommonType" },
];

const FLAG_COLUMNS: ColumnDef[] = [
  { key: "SolidCount", header: "SolidCount" },
  { key: "TessellationSuspect", header: "TessellationSuspect" },
];

/** The reader's marker for a parameter the file does not specify. */
const UNSET = "—";

/**
 * Cell type rules, applied in order so there is exactly one reading.
 * A `raw` of 0 is a real measurement, so the numeric branch tests for the
 * property rather than truthiness.
 */
export function cellOf(row: ParamRow): CellValue {
  if (typeof row.raw === "number" && Number.isFinite(row.raw)) return row.raw;
  if (row.value === "True") return true;
  if (row.value === "False") return false;
  if (row.value === UNSET) return null;
  return row.value;
}

/** `"Extrusion 2"` -> `"Extrusion"`; a suffix marks the Nth solid. */
function baseGroupName(name: string): string {
  return name.replace(/ \d+$/, "");
}

function solidIndex(name: string): number {
  const match = / (\d+)$/.exec(name);
  return match ? Number(match[1]) : 1;
}

function prefixFor(base: string): string {
  return GROUP_PREFIX.get(base) ?? `${base}.`;
}

/** `IfcBeam` -> `Beams`. Excel forbids []:*?/\ and caps names at 31 chars. */
function sheetNameFor(ifcClass: string): string {
  const stem = ifcClass.replace(/^Ifc/, "") || ifcClass;
  return `${stem}s`.replace(/[[\]:*?/\\]/g, "-").slice(0, 31);
}

function levelFrom(container: string | undefined): string {
  if (!container) return "";
  // "Level 1 (IfcBuildingStorey)" -> "Level 1"
  return container.replace(/\s*\([^)]*\)\s*$/, "");
}

interface SheetAccumulator {
  name: string;
  columns: Map<string, ColumnDef>;
  records: Array<Map<string, CellValue>>;
}

export function buildWorkbook(input: ReportInput): WorkbookModel {
  const accumulators = new Map<string, SheetAccumulator>();
  let truncatedMultiSolid = 0;
  let skipped = 0;

  for (const element of input.elements) {
    if (!element.groups.length) {
      skipped++;
      continue;
    }
    const sheetName = sheetNameFor(element.ifcClass);
    let acc = accumulators.get(sheetName);
    if (!acc) {
      acc = { name: sheetName, columns: new Map(), records: [] };
      // Identity first, so the leading columns are stable across sheets.
      for (const col of IDENTITY_COLUMNS) acc.columns.set(col.key, col);
      accumulators.set(sheetName, acc);
    }

    const record = new Map<string, CellValue>();
    const reference = element.groups.find((g) => g.name === "ReferenceObject");
    const referenceRow = (label: string): string | undefined =>
      reference?.rows.find((r) => r.label === label)?.value;

    record.set("ExpressID", element.expressId);
    record.set("Name", element.name);
    record.set("IfcClass", element.ifcClass);
    record.set("GUID", referenceRow("GUID (IFC)") ?? "");
    record.set("Level", levelFrom(referenceRow("Container")));
    const commonType = referenceRow("Common Type");
    record.set("CommonType", commonType === UNSET ? null : (commonType ?? ""));

    let solids = 1;
    let suspect = false;

    for (const group of element.groups) {
      const base = baseGroupName(group.name);
      const index = solidIndex(group.name);
      solids = Math.max(solids, index);
      if (SECTION_PROPERTY_GROUP.test(base)) continue;
      // Only the first solid populates columns; a sheet cannot hold N solids.
      if (index > 1) continue;

      const prefix = base === "ReferenceObject" ? "" : prefixFor(base);
      for (const row of group.rows) {
        if (row.label.includes("Tessellation")) {
          suspect = true;
          continue;
        }
        if (base === "ReferenceObject" && REFERENCE_HANDLED.has(row.label)) continue;

        const key = `${prefix}${row.label}`;
        if (!acc.columns.has(key)) {
          const unit = row.unit;
          acc.columns.set(key, {
            key,
            header: unit ? `${key} [${unit}]` : key,
          });
        }
        record.set(key, cellOf(row));
      }
    }

    if (solids > 1) truncatedMultiSolid++;
    record.set("SolidCount", solids);
    record.set("TessellationSuspect", suspect);
    acc.records.push(record);
  }

  const sheets: SheetModel[] = [];
  for (const acc of accumulators.values()) {
    // Flags last, after every parameter column discovered for this class.
    for (const col of FLAG_COLUMNS) acc.columns.set(col.key, col);
    const columns = [...acc.columns.values()];
    const rows = acc.records.map((record) =>
      columns.map((col) => record.get(col.key) ?? null),
    );
    sheets.push({ name: acc.name, columns, rows });
  }

  return { sheets, truncatedMultiSolid, skipped };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test tests/report.spec.ts`
Expected: PASS, 10 tests.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/report.ts tests/report.spec.ts
git -c commit.gpgsign=false commit -m "feat: pure workbook builder for element sheets

Columns are qualified by group because ProfileName, Name and Depth each occur in
two groups -- unqualified they would overwrite each other. Absent parameters
become empty cells rather than zeros, so a missing fillet radius cannot be
summed as if it were measured."
```

---

### Task 3: Profiles and Model sheets

Section properties describe the section, not the element. This normalises them onto their own sheet and adds a self-describing Model sheet.

**Files:**
- Modify: `src/report.ts` (add two builders, call them from `buildWorkbook`)
- Test: `tests/report.spec.ts` (append)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `buildWorkbook` output gains a `Profiles` sheet (when any element has a profile) and always a `Model` sheet.

- [ ] **Step 1: Write the failing test**

Append to `tests/report.spec.ts`:

```ts
const I_PROFILE: ParamGroup = {
  name: "IfcShapeProfile",
  rows: [
    { label: "ProfileName", value: "200UB25.4" },
    { label: "OverallWidth", value: "133 mm", raw: 133, unit: "mm" },
    { label: "ProfileDef", value: "IfcIShapeProfileDef" },
  ],
};

const I_SECTION: ParamGroup = {
  name: "IfcStructuralProfileProperties",
  rows: [
    { label: "ProfileName", value: "200UB25.4" },
    { label: "MomentOfInertiaY", value: "23600000 mm⁴", raw: 23600000, unit: "mm⁴" },
  ],
};

test("section properties are normalised onto Profiles, one row per section", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcBeam", "B1", [REFERENCE, I_PROFILE, I_SECTION]),
      element(2, "IfcBeam", "B2", [REFERENCE, I_PROFILE, I_SECTION]),
      element(3, "IfcBeam", "B3", [
        REFERENCE,
        {
          name: "IfcShapeProfile",
          rows: [
            { label: "ProfileName", value: "CHS168" },
            { label: "Radius", value: "84 mm", raw: 84, unit: "mm" },
          ],
        },
      ]),
    ]),
  );
  const profiles = sheet(model, "Profiles");
  expect(profiles.rows).toHaveLength(2);
  expect(cell(model, "Profiles", 0, "ProfileName")).toBe("200UB25.4");
  expect(cell(model, "Profiles", 0, "MomentOfInertiaY [mm⁴]")).toBe(23600000);
  expect(cell(model, "Profiles", 1, "ProfileName")).toBe("CHS168");
});

test("section properties do not appear on element sheets", () => {
  const model = buildWorkbook(
    input([element(1, "IfcBeam", "B1", [REFERENCE, I_PROFILE, I_SECTION])]),
  );
  const headers = sheet(model, "Beams").columns.map((c) => c.header);
  expect(headers).not.toContain("MomentOfInertiaY [mm⁴]");
  expect(headers).not.toContain("IfcStructuralProfileProperties.MomentOfInertiaY [mm⁴]");
  // Dimensions stay inline deliberately -- scanning a schedule for depth is the
  // common case and a VLOOKUP for it would be hostile.
  expect(headers).toContain("Profile.OverallWidth [mm]");
});

test("Model sheet records provenance", () => {
  const model = buildWorkbook(
    input([element(1, "IfcBeam", "B1", [REFERENCE]), element(2, "IfcWall", "W1", [REFERENCE])]),
  );
  const rows = sheet(model, "Model").rows;
  const asMap = new Map(rows.map((r) => [String(r[0]), r[1]]));
  expect(asMap.get("Source file")).toBe("m.ifc");
  expect(asMap.get("IFC schema")).toBe("IFC2X3");
  expect(asMap.get("Native length unit")).toBe("mm");
  expect(asMap.get("Total elements")).toBe(2);
  expect(asMap.get("Beams")).toBe(1);
  expect(asMap.get("Walls")).toBe(1);
});

test("Profiles is omitted when nothing has a profile", () => {
  const model = buildWorkbook(input([element(1, "IfcBeam", "B1", [REFERENCE])]));
  expect(model.sheets.map((s) => s.name)).not.toContain("Profiles");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/report.spec.ts`
Expected: FAIL — `no sheet Profiles: have Beams,Model` (or `Beams` only).

- [ ] **Step 3: Implement**

In `src/report.ts`, add these two builders after `buildWorkbook`:

```ts
/**
 * One row per unique section. Section properties belong to the profile, not the
 * element -- repeating MomentOfInertiaY across 501 beams is both bloat and a
 * misstatement of where the data lives. Elements join on Profile.ProfileName.
 */
function buildProfilesSheet(elements: ElementParameters[]): SheetModel | null {
  const columns = new Map<string, ColumnDef>([
    ["ProfileName", { key: "ProfileName", header: "ProfileName" }],
  ]);
  const records = new Map<string, Map<string, CellValue>>();

  for (const element of elements) {
    const profile = element.groups.find(
      (g) => baseGroupName(g.name) === "IfcShapeProfile",
    );
    if (!profile) continue;
    const nameRow = profile.rows.find((r) => r.label === "ProfileName");
    const profileName = nameRow?.value;
    if (!profileName || profileName === UNSET) continue;
    if (records.has(profileName)) continue;

    const record = new Map<string, CellValue>([["ProfileName", profileName]]);
    const section = element.groups.find((g) =>
      SECTION_PROPERTY_GROUP.test(baseGroupName(g.name)),
    );
    for (const group of [profile, section]) {
      if (!group) continue;
      for (const row of group.rows) {
        if (row.label === "ProfileName") continue;
        if (!columns.has(row.label)) {
          columns.set(row.label, {
            key: row.label,
            header: row.unit ? `${row.label} [${row.unit}]` : row.label,
          });
        }
        record.set(row.label, cellOf(row));
      }
    }
    records.set(profileName, record);
  }

  if (records.size === 0) return null;
  const cols = [...columns.values()];
  return {
    name: "Profiles",
    columns: cols,
    rows: [...records.values()].map((record) =>
      cols.map((col) => record.get(col.key) ?? null),
    ),
  };
}

/** Key/value provenance, so a stray workbook is self-describing later. */
function buildModelSheet(
  input: ReportInput,
  sheets: SheetModel[],
  exportedAt: string,
): SheetModel {
  const rows: CellValue[][] = [
    ["Source file", input.filename],
    ["IFC schema", input.schema],
    ["Native length unit", input.lengthUnit],
    ["Native unit in mm", input.lengthToMetres * 1000],
    ["Displayed length unit", "mm"],
    ["Total elements", input.elements.length],
  ];
  for (const sheet of sheets) {
    rows.push([sheet.name, sheet.rows.length]);
  }
  rows.push(["Exported at", exportedAt]);
  return {
    name: "Model",
    columns: [
      { key: "Property", header: "Property" },
      { key: "Value", header: "Value" },
    ],
    rows,
  };
}
```

Then change `buildWorkbook`'s signature and its return, so the timestamp is injected rather than read from a clock inside a pure function:

```ts
export function buildWorkbook(
  input: ReportInput,
  exportedAt = "",
): WorkbookModel {
```

and replace the final `return` with:

```ts
  const profiles = buildProfilesSheet(input.elements);
  if (profiles) sheets.push(profiles);
  sheets.push(buildModelSheet(input, sheets, exportedAt));

  return { sheets, truncatedMultiSolid, skipped };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx playwright test tests/report.spec.ts`
Expected: PASS, 14 tests.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/report.ts tests/report.spec.ts
git -c commit.gpgsign=false commit -m "feat: normalised Profiles sheet and Model provenance sheet

Section properties describe the section, so they get one row per unique profile
instead of being repeated on every element. Profile dimensions stay inline on the
element sheets as well, because scanning a member schedule for depth is the
common case."
```

---

### Task 4: exceljs writer

Turns a `WorkbookModel` into a real `.xlsx`. Lives in `electron/`, so exceljs never enters the renderer bundle.

**Files:**
- Modify: `package.json` (add exceljs to `dependencies`)
- Create: `electron/xlsx-writer.ts`
- Test: `tests/xlsx-writer.spec.ts`

**Interfaces:**
- Consumes: the `WorkbookModel` shape from Task 2, re-declared locally because `electron/` cannot import from `src/`.
- Produces: `async function writeWorkbook(filePath: string, model: WorkbookModel): Promise<void>`

- [ ] **Step 1: Install the dependency**

Run: `npm install --save exceljs`
Expected: `exceljs` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/xlsx-writer.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as WEBIFC from "web-ifc";

import { buildWorkbook } from "../src/report";
import { IfcParameterReader, PARAMETER_MODEL_SETTINGS } from "../src/ifc-parameters";
import { writeWorkbook } from "../electron/xlsx-writer";

const FIXTURE = path.resolve(__dirname, "fixtures/i-beam.ifc");

/**
 * Full pipeline: real IFC -> reader -> report builder -> exceljs -> read back.
 * This is also what keeps the two WorkbookModel declarations honest, since a
 * structural divergence between src/ and electron/ fails here.
 */
async function exportFixture() {
  const api = new WEBIFC.IfcAPI();
  await api.Init();
  const modelId = api.OpenModel(
    new Uint8Array(readFileSync(FIXTURE)),
    PARAMETER_MODEL_SETTINGS as any,
  );
  const reader = IfcParameterReader.attach(api, modelId);
  const ids = api.GetLineIDsWithType(modelId, WEBIFC.IFCBEAM);
  const elements = [];
  for (let i = 0; i < ids.size(); i++) {
    const p = reader.getElementParameters(ids.get(i));
    if (p) elements.push(p);
  }
  const model = buildWorkbook(
    {
      filename: "i-beam.ifc",
      schema: reader.schema,
      lengthUnit: reader.lengthUnit,
      lengthToMetres: reader.lengthToMetres,
      elements,
    },
    "2026-07-30T00:00:00Z",
  );
  reader.close();

  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "xlsx-")), "out.xlsx");
  await writeWorkbook(filePath, model);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(filePath);
  return book;
}

function headerRow(sheet: ExcelJS.Worksheet): string[] {
  const values = sheet.getRow(1).values as unknown[];
  return values.slice(1).map((v) => String(v));
}

function valueUnder(sheet: ExcelJS.Worksheet, header: string): unknown {
  const col = headerRow(sheet).indexOf(header);
  if (col === -1) throw new Error(`no column "${header}": have ${headerRow(sheet)}`);
  return (sheet.getRow(2).values as unknown[])[col + 1];
}

test("dimensions are written as numbers with the unit in the header", async () => {
  const book = await exportFixture();
  const beams = book.getWorksheet("Beams");
  if (!beams) throw new Error("no Beams sheet");
  expect(valueUnder(beams, "Profile.OverallWidth [mm]")).toBe(133);
  expect(typeof valueUnder(beams, "Profile.OverallWidth [mm]")).toBe("number");
  expect(headerRow(beams)).not.toContain("Profile.OverallWidth");
});

test("derived geometry survives the round trip", async () => {
  const book = await exportFixture();
  const beams = book.getWorksheet("Beams")!;
  expect(valueUnder(beams, "Geometry.Volume [m³]")).toBeCloseTo(0.0158086, 6);
  expect(valueUnder(beams, "Geometry.IsSolid")).toBe(true);
  expect(valueUnder(beams, "Extrusion.Depth [mm]")).toBe(5000);
});

test("expected sheets exist and the header row is frozen", async () => {
  const book = await exportFixture();
  const names = book.worksheets.map((s) => s.name);
  expect(names).toContain("Beams");
  expect(names).toContain("Profiles");
  expect(names).toContain("Model");
  const beams = book.getWorksheet("Beams")!;
  expect(beams.views[0]?.state).toBe("frozen");
  expect(beams.views[0]?.ySplit).toBe(1);
});

test("section properties live on Profiles, one row per section", async () => {
  const book = await exportFixture();
  const profiles = book.getWorksheet("Profiles")!;
  expect(profiles.rowCount).toBe(2); // header + one section
  expect(valueUnder(profiles, "ProfileName")).toBe("200UB25.4");
  expect(valueUnder(profiles, "MomentOfInertiaY [mm⁴]")).toBeCloseTo(23600000, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx playwright test tests/xlsx-writer.spec.ts`
Expected: FAIL — cannot resolve `../electron/xlsx-writer`.

- [ ] **Step 4: Implement**

Create `electron/xlsx-writer.ts`:

```ts
import ExcelJS from "exceljs";

/**
 * Writes a WorkbookModel to disk.
 *
 * The types below mirror src/report.ts. They are declared twice on purpose:
 * tsconfig.electron.json pins rootDir to "electron", so this file cannot import
 * from src/, and widening rootDir would change the output layout and break
 * package.json's `main: dist-electron/main.js`. The two sides are separately
 * compiled programs talking over structured clone, so the contract is
 * structural in reality. tests/xlsx-writer.spec.ts is what enforces it.
 */

export type CellValue = number | string | boolean | null;

export interface ColumnDef {
  key: string;
  header: string;
}

export interface SheetModel {
  name: string;
  columns: ColumnDef[];
  rows: CellValue[][];
}

export interface WorkbookModel {
  sheets: SheetModel[];
  truncatedMultiSolid: number;
  skipped: number;
}

export async function writeWorkbook(
  filePath: string,
  model: WorkbookModel,
): Promise<void> {
  const book = new ExcelJS.Workbook();
  book.creator = "IFC Viewer";

  for (const sheet of model.sheets) {
    const worksheet = book.addWorksheet(sheet.name);
    worksheet.addRow(sheet.columns.map((c) => c.header));
    const header = worksheet.getRow(1);
    header.font = { bold: true };
    header.commit();

    for (const row of sheet.rows) {
      // null becomes an empty cell rather than the text "null".
      worksheet.addRow(row.map((v) => (v === null ? undefined : v)));
    }

    // Freeze the header so it stays put while scrolling 1300 rows, and give
    // every column a filter. The Model sheet is key/value, so it gets neither.
    if (sheet.name !== "Model") {
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      if (sheet.columns.length > 0 && sheet.rows.length > 0) {
        worksheet.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: sheet.columns.length },
        };
      }
    }

    for (let i = 0; i < sheet.columns.length; i++) {
      // Wide enough for the header, which carries the unit suffix.
      worksheet.getColumn(i + 1).width = Math.min(
        40,
        Math.max(12, (sheet.columns[i]?.header.length ?? 12) + 2),
      );
    }
  }

  await book.xlsx.writeFile(filePath);
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx playwright test tests/xlsx-writer.spec.ts`
Expected: PASS, 4 tests.

Run: `npx tsc -p tsconfig.electron.json`
Expected: no output; `dist-electron/xlsx-writer.js` is produced.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json electron/xlsx-writer.ts tests/xlsx-writer.spec.ts
git -c commit.gpgsign=false commit -m "feat: write WorkbookModel to xlsx with exceljs

exceljs runs in the main process, not the renderer: vite.config.ts already
disables tree-shaking and uses terser to stop web-ifc's CommonJS shim being
mangled, and adding another CJS-heavy library to that bundle invites the same
failure. electron/ is compiled by tsc with no bundler."
```

---

### Task 5: IPC channels

Two channels, so a multi-megabyte payload is never serialised for a dialog the user cancels.

**Files:**
- Modify: `electron/main.ts:1-3` (imports), `electron/main.ts:92` (after the `file:read` handler)
- Modify: `electron/preload.ts` (both the exposed object and the `Window` declaration)

**Interfaces:**
- Consumes: `writeWorkbook` and `WorkbookModel` from Task 4.
- Produces on `window.electron`:
  - `saveXlsxDialog(suggestedName: string): Promise<string | null>`
  - `writeXlsx(filePath: string, model: WorkbookModel): Promise<void>`

- [ ] **Step 1: Implement the main-process handlers**

In `electron/main.ts`, extend the import on line 1 and add the writer import:

```ts
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import * as fs from "fs";
import { writeWorkbook, type WorkbookModel } from "./xlsx-writer";
```

Append after the `file:read` handler (currently ends line 92):

```ts
ipcMain.handle("dialog:save-xlsx", async (_event, suggestedName: string) => {
  const result = await dialog.showSaveDialog({
    title: "Export attributes",
    defaultPath: suggestedName,
    filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle(
  "file:write-xlsx",
  async (_event, filePath: string, model: WorkbookModel) => {
    // Let the rejection reach the renderer: "file is open in Excel" is the
    // common failure and the user needs to be told, not left guessing.
    await writeWorkbook(filePath, model);
  },
);
```

- [ ] **Step 2: Implement the preload bridge**

Replace `electron/preload.ts` entirely:

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { WorkbookModel } from "./xlsx-writer";

contextBridge.exposeInMainWorld("electron", {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:open-ifc"),
  readFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke("file:read", filePath),
  onOpenFile: (handler: (filePath: string) => void) => {
    ipcRenderer.on("open-file", (_event, filePath: string) => handler(filePath));
  },
  saveXlsxDialog: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke("dialog:save-xlsx", suggestedName),
  writeXlsx: (filePath: string, model: WorkbookModel): Promise<void> =>
    ipcRenderer.invoke("file:write-xlsx", filePath, model),
});

declare global {
  interface Window {
    electron: {
      openFileDialog: () => Promise<string | null>;
      readFile: (filePath: string) => Promise<ArrayBuffer>;
      onOpenFile: (handler: (filePath: string) => void) => void;
      saveXlsxDialog: (suggestedName: string) => Promise<string | null>;
      writeXlsx: (filePath: string, model: unknown) => Promise<void>;
    };
  }
}
```

- [ ] **Step 3: Mirror the surface for the renderer**

`src/electron-api.d.ts` declares the same global for `src/`. Open it and add the two methods to the interface so `src/ui/export.ts` typechecks. The renderer passes its own `WorkbookModel` type, which is why the parameter is `unknown` at the bridge:

```ts
    saveXlsxDialog: (suggestedName: string) => Promise<string | null>;
    writeXlsx: (filePath: string, model: unknown) => Promise<void>;
```

- [ ] **Step 4: Typecheck both projects**

Run: `npx tsc -p tsconfig.electron.json`
Expected: no output.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npx playwright test`
Expected: all tests still pass — no behaviour changed yet, this only adds channels.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts src/electron-api.d.ts
git -c commit.gpgsign=false commit -m "feat: IPC channels for saving an xlsx export

Dialog and write are separate calls so a multi-megabyte payload is never
serialised for a dialog the user cancels."
```

---

### Task 6: Toolbar button and wiring

**Files:**
- Modify: `index.html` (add the button inside `#toolbar`, after `#open-btn`)
- Create: `src/ui/export.ts`
- Modify: `src/main.ts` (import and mount)
- Test: `tests/export.e2e.spec.ts`

**Interfaces:**
- Consumes: `buildWorkbook`/`ReportInput` (Tasks 2-3), `Viewer.getCategories`, `Viewer.getElementParameters`, `Viewer.getModelUnits`, `Viewer.getCurrentFilename`, `Viewer.isStreamed`, `toast`, and `window.electron.saveXlsxDialog`/`writeXlsx` (Task 5).
- Produces: `function mountExport(viewer: Viewer): void`

- [ ] **Step 1: Write the failing test**

Create `tests/export.e2e.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { launchViewer, readyWindow } from "./launch";

const FIXTURE = path.resolve(__dirname, "fixtures/i-beam.ifc");

test("the export button writes a workbook for the loaded model", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const button = page.locator("#export-btn");

    // Disabled until something is loaded.
    await expect(button).toBeDisabled();

    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);
    await expect(button).toBeEnabled();

    // Stub the save dialog in the main process so no native window appears.
    const target = path.join(mkdtempSync(path.join(tmpdir(), "export-e2e-")), "out.xlsx");
    await app.evaluate(async ({ ipcMain }, filePath) => {
      ipcMain.removeHandler("dialog:save-xlsx");
      ipcMain.handle("dialog:save-xlsx", async () => filePath);
    }, target);

    await button.click();
    await expect(page.locator("#toast-host")).toContainText("Exported", {
      timeout: 30_000,
    });

    expect(existsSync(target)).toBe(true);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(target);
    expect(book.worksheets.map((s) => s.name)).toContain("Beams");
    expect(book.getWorksheet("Beams")!.rowCount).toBeGreaterThan(1);
  } finally {
    await app.close();
  }
});

test("cancelling the save dialog is a silent no-op", async () => {
  test.setTimeout(180_000);
  const app = await launchViewer();
  try {
    const page = await readyWindow(app);
    const bytes = [...readFileSync(FIXTURE)];
    await page.evaluate(async (data) => {
      await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
    }, bytes);

    await app.evaluate(async ({ ipcMain }) => {
      ipcMain.removeHandler("dialog:save-xlsx");
      ipcMain.handle("dialog:save-xlsx", async () => null);
    });

    await page.locator("#export-btn").click();
    await page.waitForTimeout(1500);
    await expect(page.locator("#toast-host")).toBeEmpty();
    await expect(page.locator("#export-btn")).toBeEnabled();
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/export.e2e.spec.ts`
Expected: FAIL — `#export-btn` never resolves.

- [ ] **Step 3: Add the button**

In `index.html`, inside `#toolbar`, immediately after the `#open-btn` line:

```html
        <button id="export-btn" disabled>Export XLSX</button>
```

- [ ] **Step 4: Implement the UI module**

Create `src/ui/export.ts`:

```ts
import { buildWorkbook, type ReportInput } from "../report";
import type { ElementParameters, Viewer } from "../viewer";
import { toast } from "./toast";

export function mountExport(viewer: Viewer): void {
  const button = document.getElementById("export-btn") as HTMLButtonElement;
  let busy = false;

  viewer.onModelLoaded.on(() => {
    button.disabled = false;
  });
  viewer.onModelUnloaded.on(() => {
    button.disabled = true;
  });

  button.addEventListener("click", async () => {
    if (busy) return;

    // The renderer also runs in a plain browser under `vite`, where there is no
    // IPC bridge. Same guard as mountToolbar's open button.
    if (!window.electron?.saveXlsxDialog) {
      toast("Export only works inside the Electron app", "info");
      return;
    }

    if (viewer.isStreamed()) {
      toast("Parameters are unavailable for streamed models over 50 MB", "info");
      return;
    }
    const units = viewer.getModelUnits();
    if (!units) {
      toast("No parameter data available for this model", "info");
      return;
    }

    const sourceName = viewer.getCurrentFilename() || "model.ifc";
    const suggested = `${sourceName.replace(/\.ifc$/i, "")}.xlsx`;
    const filePath = await window.electron.saveXlsxDialog(suggested);
    if (!filePath) return; // cancelled -- the user changed their mind

    busy = true;
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = "Exporting…";
    try {
      const model = buildWorkbook(
        { filename: sourceName, ...units, elements: collect(viewer) },
        new Date().toISOString(),
      );
      await window.electron.writeXlsx(filePath, model);
      const total = model.sheets
        .filter((s) => s.name !== "Model" && s.name !== "Profiles")
        .reduce((n, s) => n + s.rows.length, 0);
      const notes: string[] = [];
      if (model.skipped > 0) notes.push(`${model.skipped} skipped`);
      if (model.truncatedMultiSolid > 0) {
        // Never let a truncation pass unmentioned.
        notes.push(`${model.truncatedMultiSolid} multi-solid truncated to their first solid`);
      }
      const suffix = notes.length ? ` (${notes.join(", ")})` : "";
      toast(
        `Exported ${total} elements to ${filePath.split(/[\\/]/).pop()}${suffix}`,
        "info",
      );
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = previousLabel ?? "Export XLSX";
    }
  });
}

/** Every element the classifier knows about, with its parameters. */
function collect(viewer: Viewer): ElementParameters[] {
  const out: ElementParameters[] = [];
  for (const ids of viewer.getCategories().values()) {
    for (const id of ids) {
      // One unreadable element must not lose the other 1300; buildWorkbook
      // counts the gaps via `skipped`.
      const params = viewer.getElementParameters(id);
      if (params) out.push(params);
    }
  }
  return out;
}
```

- [ ] **Step 5: Mount it**

In `src/main.ts`, add the import beside the other UI imports:

```ts
import { mountExport } from "./ui/export";
```

and the call beside the other mounts, after `mountToolbar(viewer);`:

```ts
  mountExport(viewer);
```

- [ ] **Step 6: Run the whole suite**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npm run build`
Expected: build succeeds.

Run: `npx playwright test`
Expected: PASS, all tests including the two new e2e specs.

- [ ] **Step 7: Verify against the real models by hand**

Run the app: `npm run dev`, open the Halev model, click `Export XLSX`, save, and open the workbook. Confirm:
- `Beams`, `Columns`, `Members`, `Walls`, `Slabs`, `Profiles`, `Model` sheets exist.
- `Beams` has 286 data rows; `Members` has 375.
- `Geometry.Volume [m³]` sums (select the column — Excel shows a sum).
- Filtering `TessellationSuspect = TRUE` returns the 21 flagged slabs.
- `Profiles` has far fewer rows than `Beams`.

Then repeat with the PAC model and confirm `Profile.OverallWidth [mm]` reads ~311 for a `310UC158`, not 12.244 — the inch-to-mm conversion carried through to `raw`.

- [ ] **Step 8: Commit**

```bash
git add index.html src/main.ts src/ui/export.ts tests/export.e2e.spec.ts
git -c commit.gpgsign=false commit -m "feat: Export XLSX button

Disabled until a model is loaded and while a write is in flight. A cancelled
dialog is a silent no-op. Truncated multi-solid elements are named in the
success toast rather than silently dropped."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| `raw`/`unit` on `ParamRow`, formatter table | 1 |
| Cell type rules (ordered) | 2 (`cellOf`) |
| Derived columns `Level`, `SolidCount`, `TessellationSuspect` | 2 |
| Element sheets, identity columns, group prefixes, column union | 2 |
| `Profiles` sheet normalisation | 3 |
| `Model` sheet | 3 |
| Multi-solid rule + no silent caps | 2 (count), 6 (toast) |
| exceljs in main process, `dependencies` | 4 |
| Duplicated `WorkbookModel` + round-trip enforcement | 4 |
| IPC contract (two channels) | 5 |
| UI states, toasts, streamed-model guard | 6 |
| Error handling table | 5 (rejection passthrough), 6 (toasts, cancel, streamed) |
| Testing: unit / round-trip / e2e | 2-3 / 4 / 6 |

No spec requirement is unimplemented. Frozen header and auto-filter, mentioned in the spec's element-sheets section, are in Task 4 and asserted there.

**Placeholder scan:** none. Every code step carries complete code; every run step carries the exact command and expected result.

**Type consistency:** `WorkbookModel`, `SheetModel`, `ColumnDef`, `CellValue` are identical in `src/report.ts` (Task 2) and `electron/xlsx-writer.ts` (Task 4), which Task 4's round-trip test enforces. `buildWorkbook` gains its second parameter in Task 3 with a default, so Task 2's call sites and tests keep compiling. `ReportInput` field names are used identically in Tasks 2, 3, 4 and 6. `getModelUnits()` returns exactly the three fields Task 6 spreads into `ReportInput`.

**One deliberate deviation from the spec:** the spec listed a unit test asserting `SolidCount > 1` for "a synthetic multi-solid element". Task 2 does this with a hand-built `ParamGroup` named `"IfcShapeProfile 2"` rather than a synthetic IFC file, since neither project model has such an element and building one IFC by hand to test one integer is poor value.

**One correction made during self-review:** `src/ui/export.ts` originally called `window.electron.saveXlsxDialog` directly. The renderer also runs in a plain browser under `vite` (there is no IPC bridge there), and `src/ui/toolbar.ts` already guards its open button with `window.electron?.openFileDialog`. Task 6 now uses the same guard, so a browser session gets a toast rather than a `TypeError`.
