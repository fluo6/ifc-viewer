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
  /**
   * Rows that declared a different unit than the one already in their column's
   * header. The header keeps the first unit and the magnitude is written
   * unconverted, so these cells are wrong by whatever the ratio is -- the count
   * exists so that is stated rather than discovered by a reader summing them.
   */
  unitConflicts: number;
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

/**
 * Groups the reader suffixes with a solid number. Nothing else is: a property
 * set legitimately named `Zone 2` is a property set, and reading its trailing
 * digit as a solid index would drop the whole set (index > 1 is skipped) while
 * blaming a multi-solid truncation that never happened.
 */
function isSolidSuffixed(base: string): boolean {
  return base === "IfcShapeProfile" || base === "Extrusion" || SECTION_PROPERTY_GROUP.test(base);
}

/** `"Extrusion 2"` -> `"Extrusion"`; a suffix marks the Nth solid. */
function baseGroupName(name: string): string {
  const stripped = name.replace(/ \d+$/, "");
  return stripped !== name && isSolidSuffixed(stripped) ? stripped : name;
}

function solidIndex(name: string): number {
  const match = / (\d+)$/.exec(name);
  if (!match) return 1;
  return isSolidSuffixed(name.slice(0, match.index)) ? Number(match[1]) : 1;
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
  /** First non-empty unit seen per column key; see `noteColumn`. */
  units: Map<string, string>;
  records: Array<Map<string, CellValue>>;
}

/**
 * Registers `key` as a column and settles its unit suffix.
 *
 * The unit cannot be taken from whichever row happens to mention the key first:
 * an unset optional dimension (`FilletRadius`, `OffsetFromReferenceLine`)
 * arrives with no unit at all, so scan order alone would decide whether the
 * column says `[mm]` -- and every later magnitude would sit under a unit-less
 * header. The first *non-empty* unit wins instead, upgrading a header already
 * created without one. The key itself stays unqualified so the unset row and
 * the valued row share one column.
 *
 * Returns 1 when a later row declares a *different* non-empty unit. Both units
 * are plausible readings of the file (IfcPropertySingleValue carries its own
 * IfcUnit, so beam A can say millimetres and beam B metres), and rescaling
 * silently would be inventing data, so the first header stands and the
 * disagreement is counted for the caller to report.
 */
function noteColumn(
  columns: Map<string, ColumnDef>,
  units: Map<string, string>,
  key: string,
  unit: string | undefined,
): number {
  if (unit) {
    const recorded = units.get(key);
    if (recorded === undefined) {
      units.set(key, unit);
      columns.set(key, { key, header: `${key} [${unit}]` });
      return 0;
    }
    if (recorded !== unit) return 1;
  }
  if (!columns.has(key)) columns.set(key, { key, header: key });
  return 0;
}

/**
 * Final value for one cell.
 *
 * A unit-bearing column is numeric by construction -- some row declared a
 * magnitude in `[mm]` or `[m²]` for it -- so anything non-numeric in it is
 * prose that leaked across from the properties panel. `EnclosedArea` reads
 * "n/a (self-intersecting outline)" for a self-intersecting slab outline,
 * which is the honest thing to show a human and poison in a spreadsheet:
 * Excel's SUM skips the text row and reports a total that is quietly short.
 * Blanking it makes the gap visible as a gap. Booleans get the same treatment;
 * they are not expected here, and a TRUE in a millimetre column is no more
 * summable than the prose is.
 */
function materialise(value: CellValue | undefined, unitBearing: boolean): CellValue {
  const cell = value ?? null;
  if (!unitBearing) return cell;
  return typeof cell === "number" ? cell : null;
}

/**
 * One row per unique section. Section properties belong to the profile, not the
 * element -- repeating MomentOfInertiaY across 501 beams is both bloat and a
 * misstatement of where the data lives. Elements join on Profile.ProfileName.
 */
function buildProfilesSheet(elements: ElementParameters[]): {
  sheet: SheetModel | null;
  unitConflicts: number;
} {
  const columns = new Map<string, ColumnDef>([
    ["ProfileName", { key: "ProfileName", header: "ProfileName" }],
  ]);
  const units = new Map<string, string>();
  const records = new Map<string, Map<string, CellValue>>();
  let unitConflicts = 0;

  for (const element of elements) {
    // Only solid 1's profile stands for this element's ProfileName; a second
    // solid is a different section entirely (see solidIndex/baseGroupName).
    const profile = element.groups.find(
      (g) => baseGroupName(g.name) === "IfcShapeProfile" && solidIndex(g.name) === 1,
    );
    if (!profile) continue;
    const nameRow = profile.rows.find((r) => r.label === "ProfileName");
    const profileName = nameRow?.value;
    if (!profileName || profileName === UNSET) continue;

    // Section-properties links are keyed off the profile *definition's* own
    // expressID (profilePropsOfProfile, keyed off solid.SweptArea), not off
    // ProfileName. Two elements can share a ProfileName while pointing at two
    // distinct IfcIShapeProfileDef entities, only one of which carries the
    // structural-properties link. Which element gets scanned first is an
    // artifact of traversal order, not of which one "owns" the data, so every
    // element sharing the name must get a chance to contribute -- merge into
    // whatever record already exists instead of keeping only the first.
    let record = records.get(profileName);
    if (!record) {
      record = new Map<string, CellValue>([["ProfileName", profileName]]);
      records.set(profileName, record);
    }

    // A profile can carry more than one section-properties group at once
    // (e.g. IfcStructuralProfileProperties and IfcGeneralProfileProperties
    // both point at the same profile def), so collect all of them, not just
    // the first. Restricted to solid 1 to match the profile group above.
    const sections = element.groups.filter(
      (g) => SECTION_PROPERTY_GROUP.test(baseGroupName(g.name)) && solidIndex(g.name) === 1,
    );

    for (const group of [profile, ...sections]) {
      for (const row of group.rows) {
        if (row.label === "ProfileName") continue;
        unitConflicts += noteColumn(columns, units, row.label, row.unit);
        // First non-null value per key wins: a key merely absent so far (or
        // present but null, e.g. the reader's unset marker) is fillable by a
        // later element, but once a real value lands it is not replaced. If
        // two elements genuinely disagree on a value for the same
        // ProfileName -- i.e. two distinct profile definitions that happen
        // to share a name -- the first one scanned wins silently; that is a
        // modelling error in the source file, not something this sheet
        // resolves.
        const existing = record.get(row.label);
        if (existing === undefined || existing === null) {
          record.set(row.label, cellOf(row));
        }
      }
    }
  }

  if (records.size === 0) return { sheet: null, unitConflicts };
  const cols = [...columns.values()];
  return {
    sheet: {
      name: "Profiles",
      columns: cols,
      rows: [...records.values()].map((record) =>
        cols.map((col) => materialise(record.get(col.key), units.has(col.key))),
      ),
    },
    unitConflicts,
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
  let unitConflicts = 0;

  for (const element of input.elements) {
    if (!element.groups.length) {
      skipped++;
      continue;
    }
    const sheetName = sheetNameFor(element.ifcClass);
    let acc = accumulators.get(sheetName);
    if (!acc) {
      acc = { name: sheetName, columns: new Map(), units: new Map(), records: [] };
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
        unitConflicts += noteColumn(acc.columns, acc.units, key, row.unit);
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
    // Materialised only now that the scan is over, so every column's unit is
    // final and the outcome does not depend on element order.
    const rows = acc.records.map((record) =>
      columns.map((col) => materialise(record.get(col.key), acc.units.has(col.key))),
    );
    sheets.push({ name: acc.name, columns, rows });
  }

  const profiles = buildProfilesSheet(input.elements);
  unitConflicts += profiles.unitConflicts;
  if (profiles.sheet) sheets.push(profiles.sheet);
  sheets.push(buildModelSheet(input, sheets, exportedAt));

  return { sheets, truncatedMultiSolid, skipped, unitConflicts };
}
