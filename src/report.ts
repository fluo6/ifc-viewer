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
