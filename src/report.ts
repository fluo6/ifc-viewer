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

/**
 * An element can carry several groups with the identical base name (e.g. one
 * `IfcMaterial` group per material layer). Writing them all through the same
 * prefix would let later groups silently overwrite earlier ones, so the Nth
 * occurrence of a base name gets its own `<Label> N.` prefix instead.
 */
function prefixForOccurrence(base: string, occurrence: number): string {
  const label = prefixFor(base).replace(/\.$/, "");
  return occurrence > 1 ? `${label} ${occurrence}.` : `${label}.`;
}

/** The reader's marker for "not set", or a blank string, both mean an empty cell. */
function nullIfAbsent(value: string): CellValue {
  return value === "" || value === UNSET ? null : value;
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

export function buildWorkbook(
  input: ReportInput,
  exportedAt = "",
): WorkbookModel {
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
    record.set("GUID", nullIfAbsent(referenceRow("GUID (IFC)") ?? ""));
    record.set("Level", nullIfAbsent(levelFrom(referenceRow("Container"))));
    const commonType = referenceRow("Common Type");
    record.set("CommonType", commonType === UNSET ? null : (commonType ?? ""));

    let solids = 1;
    let suspect = false;
    // Counts groups by base name, but only those that reach the per-row loop
    // below: the multi-solid suffix (index > 1) is a different concept and is
    // already skipped above, so it must not also bump this counter.
    const occurrences = new Map<string, number>();

    for (const group of element.groups) {
      const base = baseGroupName(group.name);
      const index = solidIndex(group.name);
      solids = Math.max(solids, index);
      if (SECTION_PROPERTY_GROUP.test(base)) continue;
      // Only the first solid populates columns; a sheet cannot hold N solids.
      if (index > 1) continue;

      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      const prefix = base === "ReferenceObject" ? "" : prefixForOccurrence(base, occurrence);
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

  const profiles = buildProfilesSheet(input.elements);
  if (profiles) sheets.push(profiles);
  sheets.push(buildModelSheet(input, sheets, exportedAt));

  return { sheets, truncatedMultiSolid, skipped };
}
