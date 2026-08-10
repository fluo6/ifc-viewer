import * as WEBIFC from "web-ifc";

/**
 * Reads the *raw* IFC entity graph for a single element.
 *
 * Why this exists: `OBC.IfcLoader` builds the FragmentsGroup's property store
 * through `IfcJsonExporter`, which skips every type in its `GeometryTypes`
 * set — that set includes IfcExtrudedAreaSolid, every IfcProfileDef subtype,
 * IfcLocalPlacement, IfcAxis2Placement3D, IfcCartesianPoint and IfcDirection.
 * Those are exactly the entities that carry section dimensions, extrusion
 * vectors and placements. Rhino/ETABS exports also ship no IfcPropertySet at
 * all, so the fragments' property store has nothing useful in it either.
 *
 * So we keep a second web-ifc model open on the source buffer for the lifetime
 * of the loaded model and walk it directly when the user selects something.
 */

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

export interface ParamGroup {
  name: string;
  rows: ParamRow[];
  /** Rendered collapsed when false. Defaults to expanded. */
  open?: boolean;
}

export interface ElementParameters {
  expressId: number;
  /** IFC entity name as web-ifc reports it, e.g. `IFCBEAM`. */
  ifcClass: string;
  name: string;
  groups: ParamGroup[];
}

/** web-ifc encodes entity references as `{ type: 5, value: expressID }`. */
const REF = 5;

/**
 * Loader settings for the parameter-only model.
 *
 * - `COORDINATE_TO_ORIGIN: false` keeps placements and centroids in the file's
 *   own coordinate system, matching what other IFC inspectors report.
 * - `CIRCLE_SEGMENTS: 48` — the default 12 inscribes a polygon that undershoots
 *   a circle's area by ~4.5%, which showed up as CHS members reporting volumes
 *   5% low. 48 brings that under 0.3%. This model is never rendered, so the
 *   extra triangles cost nothing visually.
 */
export const PARAMETER_MODEL_SETTINGS = {
  COORDINATE_TO_ORIGIN: false,
  CIRCLE_SEGMENTS: 48,
  TAPE_SIZE: 256 * 1024 * 1024,
};

const UNSET = "—";

const SI_PREFIX_FACTOR: Record<string, number> = {
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
  PICO: 1e-12,
  FEMTO: 1e-15,
  ATTO: 1e-18,
};

const SI_PREFIX_SYMBOL: Record<string, string> = {
  EXA: "E",
  PETA: "P",
  TERA: "T",
  GIGA: "G",
  MEGA: "M",
  KILO: "k",
  HECTO: "h",
  DECA: "da",
  DECI: "d",
  CENTI: "c",
  MILLI: "m",
  MICRO: "µ",
  NANO: "n",
  PICO: "p",
  FEMTO: "f",
  ATTO: "a",
};

/**
 * Length-dimension exponent per section-property attribute name.
 * IfcProfileProperties attributes are all typed measures but web-ifc hands us
 * bare numbers, so the dimension has to be inferred from the attribute name.
 * Attributes not listed here are shown unconverted and unlabelled.
 */
const PROFILE_PROPERTY_DIMENSION: Array<[RegExp, number]> = [
  [/Area[XYZ]?$/, 2],
  [/^WarpingConstant$/, 6],
  [/^MomentOfInertia|^TorsionalConstant/, 4],
  [/SectionModulus/, 3],
  [/^Perimeter$|PlateThickness$|^ShearCentre|^CentreOfGravity/, 1],
];

/**
 * Lengths are always reported in millimetres regardless of the file's own
 * length unit. ETABS/Rhino exports of metric projects sometimes declare INCH
 * (see the PAC model, where a 310UC158 reads 12.244 as OverallWidth), and a
 * section catalogue in inches is unreadable on a metric job. The file's native
 * unit is still surfaced in the ReferenceObject group so nothing is hidden.
 */
const DISPLAY_LENGTH_UNIT = "mm";
const DISPLAY_LENGTH_IN_METRES = 0.001;

/** Profile attributes that are angles, not lengths. */
const ANGLE_ATTRS = /Slope$|Angle$/;

/** Attributes surfaced in the ReferenceObject group, so the raw dump skips them. */
const HEADER_ATTRS = new Set([
  "expressID",
  "type",
  "GlobalId",
  "Name",
  "ObjectType",
  "Description",
  "Tag",
  "PredefinedType",
  "OwnerHistory",
]);

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface ProfileOutline {
  count: number;
  width: number;
  depth: number;
  /** Shoelace area — only meaningful when `simple` is true. */
  area: number;
  /** False when the outline crosses itself, which these exports do produce. */
  simple: boolean;
}

interface ResolvedUnit {
  /** Multiplies a stored value into m, m², m³, kg, or s. */
  toCanonical: number;
  symbol: string;
}

interface QuantityUnitChoice {
  /** True when an override or project unit was declared for this dimension. */
  declared: boolean;
  resolved: ResolvedUnit | null;
  symbol: string;
}

/** Column-major 4x4, same layout as `THREE.Matrix4.elements`. */
type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export class IfcParameterReader {
  /** Project length unit symbol, e.g. `mm`. */
  lengthUnit = "m";
  /** Multiply a stored length by this to get metres. */
  lengthToMetres = 1;
  /** IFC schema as declared in the file header, e.g. `IFC2X3`. */
  schema = "";

  private readonly api: WEBIFC.IfcAPI;
  private readonly modelId: number;
  private readonly ownsApi: boolean;
  private closed = false;

  private readonly lineCache = new Map<number, any>();
  private readonly materialOfElement = new Map<number, number>();
  private readonly extendedPropsOfMaterial = new Map<number, number[]>();
  private readonly profilePropsOfProfile = new Map<number, number[]>();
  private readonly containerOfElement = new Map<number, number>();
  private readonly psetsOfElement = new Map<number, number[]>();
  private readonly typeOfElement = new Map<number, number>();
  private readonly projectUnits = new Map<string, any>();

  private constructor(api: WEBIFC.IfcAPI, modelId: number, ownsApi: boolean) {
    this.api = api;
    this.modelId = modelId;
    this.ownsApi = ownsApi;
  }

  /** Opens a private web-ifc model on `buffer`. See PARAMETER_MODEL_SETTINGS. */
  static async open(
    buffer: Uint8Array,
    wasmPath = "./",
    wasmAbsolute = false,
  ): Promise<IfcParameterReader> {
    const api = new WEBIFC.IfcAPI();
    api.SetWasmPath(wasmPath, wasmAbsolute);
    await api.Init();
    const modelId = api.OpenModel(buffer, PARAMETER_MODEL_SETTINGS as any);
    const reader = new IfcParameterReader(api, modelId, true);
    reader.build();
    return reader;
  }

  /** Wraps an already-open model. Used by the headless checks. */
  static attach(api: WEBIFC.IfcAPI, modelId: number): IfcParameterReader {
    const reader = new IfcParameterReader(api, modelId, false);
    reader.build();
    return reader;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lineCache.clear();
    try {
      this.api.CloseModel(this.modelId);
    } catch {
      /* already gone */
    }
    if (this.ownsApi) {
      try {
        this.api.Dispose();
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------- indexing

  private build(): void {
    try {
      this.schema = this.api.GetModelSchema(this.modelId) ?? "";
    } catch {
      this.schema = "";
    }
    this.readUnits();
    this.indexRelations();
  }

  private readUnits(): void {
    const projectId = this.idsOfType(WEBIFC.IFCPROJECT)[0];
    const projectAssignmentId = refId(this.line(projectId)?.UnitsInContext);
    const assignmentIds =
      projectAssignmentId === null
        ? this.idsOfType(WEBIFC.IFCUNITASSIGNMENT)
        : [projectAssignmentId];
    for (const id of assignmentIds) {
      const assignment = this.line(id);
      for (const handle of asArray(assignment?.Units)) {
        const unitId = refId(handle);
        if (unitId === null) continue;
        const unit = this.line(unitId);
        if (!unit) continue;
        const unitType = scalarOf(unit.UnitType);
        if (typeof unitType === "string") this.projectUnits.set(unitType, unit);
      }
    }

    const length = this.projectUnits.get("LENGTHUNIT");
    const resolved = length ? this.resolveUnit(length, "LENGTHUNIT") : null;
    if (resolved) {
      this.lengthToMetres = resolved.toCanonical;
      this.lengthUnit = resolved.symbol;
    }
  }

  /** Resolve an IFC named unit into the canonical display dimension. */
  private resolveUnit(unit: any, expectedType: string): ResolvedUnit | null {
    const kind = this.kindOf(unit);
    if (kind === "IFCSIUNIT") {
      const prefix = scalarOf(unit.Prefix) as string | null;
      const prefixFactor = prefix ? (SI_PREFIX_FACTOR[prefix] ?? 1) : 1;
      const name = String(scalarOf(unit.Name) ?? "");
      let toCanonical: number | null = null;
      if (name === "METRE") toCanonical = prefixFactor;
      // Prefix scales the named SI unit as a whole: MICRO SQUARE_METRE is
      // 1e-6 m² (equivalent to mm²), and NANO CUBIC_METRE is 1e-9 m³.
      if (name === "SQUARE_METRE") toCanonical = prefixFactor;
      if (name === "CUBIC_METRE") toCanonical = prefixFactor;
      // IFC defines the SI mass name as GRAM even though the SI base unit is kg.
      if (name === "GRAM") toCanonical = prefixFactor * 1e-3;
      if (name === "SECOND") toCanonical = prefixFactor;
      return toCanonical === null
        ? null
        : { toCanonical, symbol: this.unitSymbol(unit) };
    }

    if (
      kind === "IFCCONVERSIONBASEDUNIT" ||
      kind === "IFCCONVERSIONBASEDUNITWITHOFFSET"
    ) {
      const factorId = refId(unit.ConversionFactor);
      const measure = factorId === null ? null : this.line(factorId);
      const component = numberOf(measure?.ValueComponent);
      const baseId = refId(measure?.UnitComponent);
      const base = baseId === null ? null : this.line(baseId);
      const baseUnit = base ? this.resolveUnit(base, expectedType) : null;
      if (component === null || !baseUnit) return null;
      return {
        toCanonical: component * baseUnit.toCanonical,
        symbol: String(scalarOf(unit.Name) ?? this.unitSymbol(unit)).toLowerCase(),
      };
    }

    return null;
  }

  /** Quantity.Unit overrides the corresponding project unit when present. */
  private quantityUnit(prop: any, unitType: string): QuantityUnitChoice {
    const overrideId = refId(prop.Unit);
    const unit =
      overrideId === null ? this.projectUnits.get(unitType) : this.line(overrideId);
    if (!unit) return { declared: false, resolved: null, symbol: "" };
    return {
      declared: true,
      resolved: this.resolveUnit(unit, unitType),
      symbol: this.unitSymbol(unit),
    };
  }

  private indexRelations(): void {
    this.indexOneToMany(
      WEBIFC.IFCRELASSOCIATESMATERIAL,
      "RelatedObjects",
      "RelatingMaterial",
      this.materialOfElement,
    );
    this.indexOneToMany(
      WEBIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE,
      "RelatedElements",
      "RelatingStructure",
      this.containerOfElement,
    );
    this.indexOneToMany(
      WEBIFC.IFCRELDEFINESBYTYPE,
      "RelatedObjects",
      "RelatingType",
      this.typeOfElement,
    );

    // Property sets: one rel can name several sets in IFC4, one in IFC2X3.
    for (const relId of this.idsOfType(WEBIFC.IFCRELDEFINESBYPROPERTIES)) {
      const rel = this.line(relId);
      if (!rel) continue;
      const setIds: number[] = [];
      for (const handle of asArray(rel.RelatingPropertyDefinition)) {
        const id = refId(handle);
        if (id !== null) setIds.push(id);
      }
      if (!setIds.length) continue;
      for (const handle of asArray(rel.RelatedObjects)) {
        const objId = refId(handle);
        if (objId === null) continue;
        push(this.psetsOfElement, objId, ...setIds);
      }
    }

    // Section properties point *at* the profile definition, so invert.
    for (const type of [
      WEBIFC.IFCSTRUCTURALPROFILEPROPERTIES,
      WEBIFC.IFCGENERALPROFILEPROPERTIES,
    ]) {
      for (const id of this.idsOfType(type)) {
        const props = this.line(id);
        const profileId = refId(props?.ProfileDefinition);
        if (profileId !== null) push(this.profilePropsOfProfile, profileId, id);
      }
    }

    for (const id of this.idsOfType(WEBIFC.IFCEXTENDEDMATERIALPROPERTIES)) {
      const props = this.line(id);
      const materialId = refId(props?.Material);
      if (materialId !== null)
        push(this.extendedPropsOfMaterial, materialId, id);
    }
  }

  private indexOneToMany(
    relType: number,
    relatedAttr: string,
    relatingAttr: string,
    into: Map<number, number>,
  ): void {
    for (const relId of this.idsOfType(relType)) {
      const rel = this.line(relId);
      if (!rel) continue;
      const relatingId = refId(rel[relatingAttr]);
      if (relatingId === null) continue;
      for (const handle of asArray(rel[relatedAttr])) {
        const objId = refId(handle);
        if (objId !== null) into.set(objId, relatingId);
      }
    }
  }

  // ------------------------------------------------------------ line helpers

  private idsOfType(type: number): number[] {
    try {
      const vector = this.api.GetLineIDsWithType(this.modelId, type);
      const out: number[] = [];
      for (let i = 0; i < vector.size(); i++) out.push(vector.get(i));
      return out;
    } catch {
      return [];
    }
  }

  private line(expressId: number | null | undefined): any | null {
    if (expressId === null || expressId === undefined) return null;
    if (this.lineCache.has(expressId)) return this.lineCache.get(expressId);
    let value: any = null;
    try {
      value = this.api.GetLine(this.modelId, expressId, false, false);
    } catch {
      value = null;
    }
    this.lineCache.set(expressId, value);
    return value;
  }

  /** Display name as web-ifc reports it, e.g. `IfcExtrudedAreaSolid`. */
  private typeName(type: number | undefined): string {
    if (type === undefined) return "";
    try {
      return this.api.GetNameFromTypeCode(type) ?? "";
    } catch {
      return "";
    }
  }

  private classOf(line: any): string {
    return this.typeName(line?.type);
  }

  /**
   * Upper-cased entity name, for comparisons. web-ifc's
   * `GetNameFromTypeCode` returns PascalCase (`IfcExtrudedAreaSolid`), which is
   * easy to mismatch against the schema's `IFCEXTRUDEDAREASOLID` spelling.
   */
  private kindOf(line: any): string {
    return this.classOf(line).toUpperCase();
  }

  // ------------------------------------------------------------- public read

  getElementParameters(expressId: number): ElementParameters | null {
    if (this.closed) return null;
    const element = this.line(expressId);
    if (!element) return null;

    const ifcClass = this.classOf(element);
    const name = String(scalarOf(element.Name) ?? "(unnamed)");
    const groups: ParamGroup[] = [];

    groups.push(this.referenceObjectGroup(expressId, element, ifcClass));

    const solids = this.sweptSolids(element);
    const placement = this.objectPlacementMatrix(refId(element.ObjectPlacement));
    const multiple = solids.length > 1;
    // Summed profile-area x depth across the element's solids, in model units³.
    // Null as soon as one solid's profile area isn't exactly derivable.
    let derivedVolume: number | null = 0;
    solids.forEach((solid, i) => {
      const suffix = multiple ? ` ${i + 1}` : "";
      const profile = this.profileGroup(solid, suffix);
      if (profile) groups.push(profile);
      const extrusion = this.extrusionGroup(solid, placement, suffix);
      if (extrusion) groups.push(extrusion);
      groups.push(...this.sectionPropertyGroups(solid, suffix));
      const solidVolume = this.solidDerivedVolume(solid);
      derivedVolume =
        derivedVolume === null || solidVolume === null
          ? null
          : derivedVolume + solidVolume;
    });

    const geometry = this.calculatedGeometryGroup(
      expressId,
      derivedVolume === null
        ? null
        : derivedVolume * this.lengthToMetres ** 3,
    );
    if (geometry) groups.push(geometry);

    groups.push(...this.materialGroups(expressId));
    groups.push(...this.propertySetGroups(expressId));
    groups.push(this.rawAttributesGroup(element));

    return {
      expressId,
      ifcClass,
      name,
      groups: groups.filter((group) => group.rows.length > 0),
    };
  }

  // ------------------------------------------------------- reference object

  private referenceObjectGroup(
    expressId: number,
    element: any,
    ifcClass: string,
  ): ParamGroup {
    const rows: ParamRow[] = [];
    rows.push({ label: "Name", value: text(scalarOf(element.Name)) });
    rows.push({ label: "IFC Class", value: ifcClass || UNSET });
    rows.push({
      label: "GUID (IFC)",
      value: text(scalarOf(element.GlobalId)),
    });
    rows.push({ label: "Express ID", value: `#${expressId}` });
    rows.push({ label: "File Format", value: this.schema || "IFC" });
    // Lengths above are converted to mm; say what the file actually stores.
    rows.push({
      label: "File Length Unit",
      value:
        this.lengthUnit === DISPLAY_LENGTH_UNIT
          ? this.lengthUnit
          : `${this.lengthUnit} (× ${fmt(this.modelToDisplay, 6)} → mm)`,
    });
    rows.push({
      label: "Common Type",
      value: text(scalarOf(element.ObjectType)),
    });
    // Only worth a row when the exporter actually filled them in.
    for (const [label, attr] of [
      ["Predefined Type", "PredefinedType"],
      ["Tag", "Tag"],
      ["Description", "Description"],
    ] as const) {
      const value = scalarOf(element[attr]);
      if (value !== null && value !== "") {
        rows.push({ label, value: text(value) });
      }
    }
    const containerId = this.containerOfElement.get(expressId);
    if (containerId !== undefined) {
      const container = this.line(containerId);
      rows.push({
        label: "Container",
        value: `${text(scalarOf(container?.Name))} (${this.classOf(container)})`,
      });
    }
    const typeId = this.typeOfElement.get(expressId);
    if (typeId !== undefined) {
      const typeObj = this.line(typeId);
      rows.push({
        label: "Element Type",
        value: `${text(scalarOf(typeObj?.Name))} (${this.classOf(typeObj)})`,
      });
    }
    return { name: "ReferenceObject", rows };
  }

  // --------------------------------------------------------- representation

  /**
   * Collects the swept-area solids under the element's shape representation.
   * Booleans and mapped items are followed so clipped members still report
   * their underlying profile.
   */
  private sweptSolids(element: any): any[] {
    const shapeId = refId(element?.Representation);
    const shape = this.line(shapeId);
    if (!shape) return [];
    const out: any[] = [];
    const seen = new Set<number>();
    for (const repHandle of asArray(shape.Representations)) {
      const rep = this.line(refId(repHandle));
      if (!rep) continue;
      for (const itemHandle of asArray(rep.Items)) {
        this.collectSolids(refId(itemHandle), out, seen, 0);
      }
    }
    return out;
  }

  private collectSolids(
    itemId: number | null,
    out: any[],
    seen: Set<number>,
    depth: number,
  ): void {
    if (itemId === null || depth > 8 || seen.has(itemId)) return;
    seen.add(itemId);
    const item = this.line(itemId);
    if (!item) return;
    const kind = this.kindOf(item);
    if (item.SweptArea !== undefined) {
      out.push(item);
      return;
    }
    if (kind === "IFCBOOLEANCLIPPINGRESULT" || kind === "IFCBOOLEANRESULT") {
      this.collectSolids(refId(item.FirstOperand), out, seen, depth + 1);
      return;
    }
    if (kind === "IFCMAPPEDITEM") {
      const source = this.line(refId(item.MappingSource));
      const mapped = this.line(refId(source?.MappedRepresentation));
      for (const handle of asArray(mapped?.Items)) {
        this.collectSolids(refId(handle), out, seen, depth + 1);
      }
    }
  }

  private profileGroup(solid: any, suffix: string): ParamGroup | null {
    const profile = this.line(refId(solid.SweptArea));
    if (!profile) return null;
    const kind = this.classOf(profile);
    const rows: ParamRow[] = [];

    const profileName = scalarOf(profile.ProfileName);
    rows.push({ label: "ProfileName", value: text(profileName) });

    for (const [key, raw] of Object.entries(profile)) {
      if (
        key === "expressID" ||
        key === "type" ||
        key === "ProfileName" ||
        key === "ProfileType" ||
        key === "Position"
      ) {
        continue;
      }
      if (refId(raw) !== null || Array.isArray(raw)) continue;
      const value = scalarOf(raw);
      if (typeof value === "number") {
        rows.push(
          ANGLE_ATTRS.test(key)
            ? { label: key, value: `${fmt(value)} rad`, raw: value, unit: "rad" }
            : this.lengthRow(key, value),
        );
      } else if (value === null) {
        // Optional dimension absent in the file (a bare `$`).
        rows.push({ label: key, value: UNSET });
      } else {
        rows.push({ label: key, value: text(value) });
      }
    }

    // Arbitrary profiles carry no dimensions, so derive the useful ones.
    const outline = this.profileOutline(profile);
    if (outline) {
      rows.push({ label: "Points", value: String(outline.count), raw: outline.count, unit: "" });
      rows.push(this.lengthRow("BoundingWidth", outline.width));
      rows.push(this.lengthRow("BoundingDepth", outline.depth));
      if (outline.simple) {
        rows.push(this.areaRow("EnclosedArea", outline.area));
      } else {
        // A shoelace area is meaningless on a self-intersecting outline, and
        // these exports do produce them. Say so rather than print a number.
        rows.push({ label: "EnclosedArea", value: "n/a (self-intersecting outline)" });
      }
    }

    const derivedArea = this.profileArea(profile, outline);
    if (derivedArea !== null) {
      rows.push(this.areaRow("CrossSectionArea (derived)", derivedArea));
    }

    rows.push({ label: "ProfileType", value: text(scalarOf(profile.ProfileType)) });
    rows.push({ label: "ProfileDef", value: kind || UNSET });
    return { name: `IfcShapeProfile${suffix}`, rows };
  }

  /** 2D outline stats for IfcArbitraryClosedProfileDef-style profiles. */
  private profileOutline(profile: any): ProfileOutline | null {
    const curve = this.line(refId(profile.OuterCurve));
    if (!curve || this.kindOf(curve) !== "IFCPOLYLINE") return null;
    const pts: Array<[number, number]> = [];
    for (const handle of asArray(curve.Points)) {
      const point = this.line(refId(handle));
      const coords = asArray(point?.Coordinates).map((c) => numberOf(c) ?? 0);
      const x = coords[0];
      const y = coords[1];
      if (x !== undefined && y !== undefined) pts.push([x, y]);
    }
    // A closing repeat of the first point carries no information here.
    while (pts.length > 1) {
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      if (first[0] !== last[0] || first[1] !== last[1]) break;
      pts.pop();
    }
    if (pts.length < 3) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let twiceArea = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i]!;
      const [nx, ny] = pts[(i + 1) % pts.length]!;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      twiceArea += x * ny - nx * y;
    }
    return {
      count: pts.length,
      width: maxX - minX,
      depth: maxY - minY,
      area: Math.abs(twiceArea) / 2,
      simple: isSimplePolygon(pts),
    };
  }

  /**
   * Cross-section area from the profile's declared dimensions.
   *
   * Worth reporting alongside the tessellated volume for two reasons: it is
   * exact (no circle faceting), and web-ifc 0.0.68 meshes
   * IfcRectangleHollowProfileDef with half the declared WallThickness, so for
   * RHS/SHS the mesh is the thing that's wrong, not this.
   *
   * Fillet radii are ignored — matching how these exports leave FilletRadius
   * unset — so expect a couple of percent below the catalogue figure in
   * IfcStructuralProfileProperties for rolled sections.
   */
  private profileArea(profile: any, outline: ProfileOutline | null): number | null {
    const kind = this.kindOf(profile);
    const num = (attr: string): number | null => numberOf(profile[attr]);
    switch (kind) {
      case "IFCRECTANGLEPROFILEDEF": {
        const x = num("XDim");
        const y = num("YDim");
        return x !== null && y !== null ? x * y : null;
      }
      case "IFCRECTANGLEHOLLOWPROFILEDEF": {
        const x = num("XDim");
        const y = num("YDim");
        const t = num("WallThickness");
        if (x === null || y === null || t === null) return null;
        return x * y - Math.max(0, x - 2 * t) * Math.max(0, y - 2 * t);
      }
      case "IFCISHAPEPROFILEDEF": {
        const w = num("OverallWidth");
        const d = num("OverallDepth");
        const tw = num("WebThickness");
        const tf = num("FlangeThickness");
        if (w === null || d === null || tw === null || tf === null) return null;
        return 2 * w * tf + Math.max(0, d - 2 * tf) * tw;
      }
      case "IFCCIRCLEPROFILEDEF": {
        const r = num("Radius");
        return r === null ? null : Math.PI * r * r;
      }
      case "IFCCIRCLEHOLLOWPROFILEDEF": {
        const r = num("Radius");
        const t = num("WallThickness");
        if (r === null || t === null) return null;
        return Math.PI * (r * r - Math.max(0, r - t) ** 2);
      }
      case "IFCARBITRARYCLOSEDPROFILEDEF":
        return outline?.simple ? outline.area : null;
      default:
        return null;
    }
  }

  /** Profile area x depth in model units³, or null if not exactly derivable. */
  private solidDerivedVolume(solid: any): number | null {
    if (this.kindOf(solid) !== "IFCEXTRUDEDAREASOLID") return null;
    const profile = this.line(refId(solid.SweptArea));
    if (!profile) return null;
    const area = this.profileArea(profile, this.profileOutline(profile));
    const depth = numberOf(solid.Depth);
    if (area === null || depth === null) return null;
    return area * depth;
  }

  private extrusionGroup(
    solid: any,
    placement: Mat4,
    suffix: string,
  ): ParamGroup | null {
    if (this.kindOf(solid) !== "IFCEXTRUDEDAREASOLID") return null;
    const local = this.axisPlacementMatrix(this.line(refId(solid.Position)));
    const total = mul(placement, local);
    const origin = { x: el(total, 12), y: el(total, 13), z: el(total, 14) };
    const xDir = { x: el(total, 0), y: el(total, 1), z: el(total, 2) };
    const depth = numberOf(solid.Depth) ?? 0;
    const dir = this.directionOf(refId(solid.ExtrudedDirection), {
      x: 0,
      y: 0,
      z: 1,
    });
    const extrusion = applyDirection(total, {
      x: dir.x * depth,
      y: dir.y * depth,
      z: dir.z * depth,
    });
    const derived = this.solidDerivedVolume(solid);
    return {
      name: `Extrusion${suffix}`,
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
    };
  }

  private sectionPropertyGroups(solid: any, suffix: string): ParamGroup[] {
    const profileId = refId(solid.SweptArea);
    if (profileId === null) return [];
    const out: ParamGroup[] = [];
    for (const propsId of this.profilePropsOfProfile.get(profileId) ?? []) {
      const props = this.line(propsId);
      if (!props) continue;
      const rows: ParamRow[] = [];
      for (const [key, raw] of Object.entries(props)) {
        if (
          key === "expressID" ||
          key === "type" ||
          key === "ProfileDefinition"
        ) {
          continue;
        }
        if (refId(raw) !== null || Array.isArray(raw)) continue;
        const value = scalarOf(raw);
        if (value === null) continue;
        rows.push(
          typeof value === "number"
            ? this.profilePropertyRow(key, value)
            : { label: key, value: text(value) },
        );
      }
      if (rows.length) {
        out.push({ name: `${this.classOf(props)}${suffix}`, rows, open: false });
      }
    }
    return out;
  }

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

  // ------------------------------------------------------- derived geometry

  /**
   * Volume, surface area, centroid and closedness from the tessellated solid.
   * Matches what other inspectors label "CalculatedGeometryValues".
   *
   * Note the unit mismatch: web-ifc scales tessellated geometry to METRES
   * regardless of the file's length unit, while `GetLine` hands back raw model
   * units. So volume/area need no conversion, but the centroid has to be
   * pushed back into model units to line up with the placement values.
   */
  private calculatedGeometryGroup(
    expressId: number,
    derivedVolumeM3: number | null,
  ): ParamGroup | null {
    let mesh: WEBIFC.FlatMesh;
    try {
      mesh = this.api.GetFlatMesh(this.modelId, expressId);
    } catch {
      return null;
    }
    const count = mesh?.geometries?.size?.() ?? 0;
    if (!count) return null;

    let signedVolume = 0;
    let area = 0;
    let triangles = 0;
    const centroid = { x: 0, y: 0, z: 0 };
    const normalSum = { x: 0, y: 0, z: 0 };

    for (let g = 0; g < count; g++) {
      const placed = mesh.geometries.get(g);
      let geometry: WEBIFC.IfcGeometry;
      try {
        geometry = this.api.GetGeometry(this.modelId, placed.geometryExpressID);
      } catch {
        continue;
      }
      const verts = this.api.GetVertexArray(
        geometry.GetVertexData(),
        geometry.GetVertexDataSize(),
      );
      const indices = this.api.GetIndexArray(
        geometry.GetIndexData(),
        geometry.GetIndexDataSize(),
      );
      const m = placed.flatTransformation;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = vertexAt(verts, indices[i]!, m);
        const b = vertexAt(verts, indices[i + 1]!, m);
        const c = vertexAt(verts, indices[i + 2]!, m);
        const ab = sub(b, a);
        const ac = sub(c, a);
        const n = cross(ab, ac);
        const triArea = 0.5 * length(n);
        area += triArea;
        normalSum.x += n.x * 0.5;
        normalSum.y += n.y * 0.5;
        normalSum.z += n.z * 0.5;
        const tetra = dot(a, cross(b, c)) / 6;
        signedVolume += tetra;
        centroid.x += tetra * (a.x + b.x + c.x) * 0.25;
        centroid.y += tetra * (a.y + b.y + c.y) * 0.25;
        centroid.z += tetra * (a.z + b.z + c.z) * 0.25;
        triangles++;
      }
      try {
        geometry.delete();
      } catch {
        /* ignore */
      }
    }

    if (!triangles) return null;
    const volume = Math.abs(signedVolume);
    // A closed surface has area-weighted normals summing to zero. Cheaper and
    // more robust than edge-pairing across web-ifc's duplicated vertices.
    const closed = length(normalSum) < Math.max(area * 1e-4, 1e-9);
    const rows: ParamRow[] = [
      // Significant digits, not fixed decimals: a small plate at 0.008 m³
      // would otherwise lose most of its precision.
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

    // These values describe the tessellated solid, which is not always what the
    // profile says it should be — web-ifc 0.0.68 halves the wall thickness of
    // IfcRectangleHollowProfileDef and mis-triangulates some concave outlines.
    // Surface the disagreement rather than let a wrong number pass unremarked.
    if (derivedVolumeM3 !== null && derivedVolumeM3 > 0 && volume > 0) {
      const relative = Math.abs(volume - derivedVolumeM3) / derivedVolumeM3;
      if (relative > 0.01) {
        rows.push({
          label: "⚠ Tessellation",
          value:
            `differs from profile×depth (${fmtSignificant(derivedVolumeM3)} m³) ` +
            `by ${(relative * 100).toFixed(1)}%`,
        });
      }
    }
    return { name: "CalculatedGeometryValues", rows };
  }

  // ---------------------------------------------------------------- material

  private materialGroups(expressId: number): ParamGroup[] {
    const rootId = this.materialOfElement.get(expressId);
    if (rootId === undefined) return [];
    const groups: ParamGroup[] = [];
    const materials: number[] = [];
    this.describeMaterial(rootId, groups, materials, 0);
    const seen = new Set<number>();
    for (const materialId of materials) {
      if (seen.has(materialId)) continue;
      seen.add(materialId);
      groups.push(this.materialGroup(materialId));
    }
    return groups;
  }

  /** Unwraps usages/sets/lists down to the IfcMaterial leaves. */
  private describeMaterial(
    id: number,
    groups: ParamGroup[],
    materials: number[],
    depth: number,
  ): void {
    if (depth > 6) return;
    const entity = this.line(id);
    if (!entity) return;
    const kind = this.kindOf(entity);

    if (kind === "IFCMATERIAL") {
      materials.push(id);
      return;
    }

    if (kind === "IFCMATERIALLAYERSETUSAGE") {
      const rows: ParamRow[] = [
        {
          label: "LayerSetDirection",
          value: text(scalarOf(entity.LayerSetDirection)),
        },
        {
          label: "DirectionSense",
          value: text(scalarOf(entity.DirectionSense)),
        },
      ];
      const offset = numberOf(entity.OffsetFromReferenceLine);
      rows.push(
        offset === null
          ? { label: "OffsetFromReferenceLine", value: UNSET }
          : this.lengthRow("OffsetFromReferenceLine", offset),
      );
      groups.push({ name: "IfcMaterialLayerSetUsage", rows });
      const setId = refId(entity.ForLayerSet);
      if (setId !== null) this.describeMaterial(setId, groups, materials, depth + 1);
      return;
    }

    if (kind === "IFCMATERIALLAYERSET") {
      const rows: ParamRow[] = [
        {
          label: "LayerSetName",
          value: text(scalarOf(entity.LayerSetName)),
        },
      ];
      let i = 1;
      let total = 0;
      for (const handle of asArray(entity.MaterialLayers)) {
        const layer = this.line(refId(handle));
        if (!layer) continue;
        const materialId = refId(layer.Material);
        if (materialId !== null) materials.push(materialId);
        const thickness = numberOf(layer.LayerThickness) ?? 0;
        total += thickness;
        const materialName = text(
          scalarOf(this.line(materialId)?.Name),
        );
        rows.push({
          label: `Layer ${i++}`,
          value: `${materialName} · ${this.fmtLength(thickness)}`,
        });
      }
      rows.push(this.lengthRow("TotalThickness", total));
      groups.push({ name: "IfcMaterialLayerSet", rows });
      return;
    }

    if (kind === "IFCMATERIALLIST") {
      for (const handle of asArray(entity.Materials)) {
        const materialId = refId(handle);
        if (materialId !== null) materials.push(materialId);
      }
      return;
    }

    if (
      kind === "IFCMATERIALPROFILESETUSAGE" ||
      kind === "IFCMATERIALCONSTITUENTSET" ||
      kind === "IFCMATERIALPROFILESET"
    ) {
      const nested =
        refId(entity.ForProfileSet) ??
        refId(entity.ForProfileEndSet) ??
        null;
      if (nested !== null) {
        this.describeMaterial(nested, groups, materials, depth + 1);
      }
      for (const key of ["MaterialProfiles", "MaterialConstituents"]) {
        for (const handle of asArray(entity[key])) {
          const part = this.line(refId(handle));
          const materialId = refId(part?.Material);
          if (materialId !== null) materials.push(materialId);
        }
      }
      return;
    }

    // Anything else (IfcMaterialProfile, IfcMaterialConstituent, …).
    const materialId = refId(entity.Material);
    if (materialId !== null) materials.push(materialId);
  }

  private materialGroup(materialId: number): ParamGroup {
    const material = this.line(materialId);
    const rows: ParamRow[] = [
      { label: "Name", value: text(scalarOf(material?.Name)) },
    ];
    for (const key of ["Description", "Category"]) {
      if (material?.[key] !== undefined) {
        rows.push({ label: key, value: text(scalarOf(material[key])) });
      }
    }
    for (const propsId of this.extendedPropsOfMaterial.get(materialId) ?? []) {
      const props = this.line(propsId);
      if (!props) continue;
      const setName = scalarOf(props.Name);
      if (setName) rows.push({ label: "PropertySet", value: text(setName) });
      for (const handle of asArray(props.ExtendedProperties)) {
        const row = this.propertyRow(refId(handle));
        if (row) rows.push(row);
      }
    }
    return { name: "IfcMaterial", rows };
  }

  // ----------------------------------------------------------- property sets

  private propertySetGroups(expressId: number): ParamGroup[] {
    const ids = [...(this.psetsOfElement.get(expressId) ?? [])];
    const typeId = this.typeOfElement.get(expressId);
    if (typeId !== undefined) {
      const typeObj = this.line(typeId);
      for (const handle of asArray(typeObj?.HasPropertySets)) {
        const id = refId(handle);
        if (id !== null) ids.push(id);
      }
    }
    const out: ParamGroup[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const group = this.propertySetGroup(id);
      if (group) out.push(group);
    }
    return out;
  }

  private propertySetGroup(setId: number): ParamGroup | null {
    const set = this.line(setId);
    if (!set) return null;
    const kind = this.kindOf(set);
    const rows: ParamRow[] = [];
    const members =
      kind === "IFCELEMENTQUANTITY" ? set.Quantities : set.HasProperties;
    for (const handle of asArray(members)) {
      const row = this.propertyRow(refId(handle));
      if (row) rows.push(row);
    }
    if (!rows.length) return null;
    const name = String(scalarOf(set.Name) ?? kind ?? `Set #${setId}`);
    return { name, rows };
  }

  /** Formats any IfcProperty / IfcPhysicalQuantity leaf as one row. */
  private propertyRow(propId: number | null): ParamRow | null {
    if (propId === null) return null;
    const prop = this.line(propId);
    if (!prop) return null;
    const label = String(scalarOf(prop.Name) ?? `#${propId}`);
    const kind = this.kindOf(prop);

    const unitSuffix = () => {
      const unitId = refId(prop.Unit);
      const unit = unitId === null ? null : this.line(unitId);
      const symbol = unit ? this.unitSymbol(unit) : "";
      return symbol ? ` ${symbol}` : "";
    };

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
    if (kind === "IFCPROPERTYENUMERATEDVALUE") {
      const values = asArray(prop.EnumerationValues)
        .map((v) => scalarOf(v))
        .filter((v) => v !== null)
        .map((v) => text(v));
      return { label, value: values.length ? values.join(", ") : UNSET };
    }
    if (kind === "IFCPROPERTYLISTVALUE") {
      const values = asArray(prop.ListValues)
        .map((v) => scalarOf(v))
        .filter((v) => v !== null)
        .map((v) => text(v));
      return { label, value: values.length ? values.join(", ") : UNSET };
    }
    if (kind === "IFCPROPERTYBOUNDEDVALUE") {
      const lower = scalarOf(prop.LowerBoundValue);
      const upper = scalarOf(prop.UpperBoundValue);
      return { label, value: `${text(lower)} … ${text(upper)}${unitSuffix()}` };
    }
    if (kind === "IFCCOMPLEXPROPERTY") {
      const parts = asArray(prop.HasProperties)
        .map((h) => this.propertyRow(refId(h)))
        .filter((r): r is ParamRow => r !== null)
        .map((r) => `${r.label}=${r.value}`);
      return { label, value: parts.length ? parts.join("; ") : UNSET };
    }

    // Physical quantities: IfcQuantityLength/Area/Volume/Count/Weight/Time.
    for (const key of [
      "LengthValue",
      "AreaValue",
      "VolumeValue",
      "CountValue",
      "WeightValue",
      "TimeValue",
    ]) {
      if (prop[key] === undefined) continue;
      const value = numberOf(prop[key]);
      if (value === null) return { label, value: UNSET };
      if (key === "LengthValue") return this.quantityLengthRow(label, value, prop);
      if (key === "AreaValue") return this.quantityAreaRow(label, value, prop);
      if (key === "VolumeValue") return this.quantityVolumeRow(label, value, prop);
      if (key === "WeightValue") return this.quantityWeightRow(label, value, prop);
      return { label, value: fmt(value), raw: value, unit: "" };
    }
    return null;
  }

  private unitSymbol(unit: any): string {
    const kind = this.kindOf(unit);
    if (kind === "IFCSIUNIT") {
      const prefix = scalarOf(unit.Prefix) as string | null;
      const name = String(scalarOf(unit.Name) ?? "");
      const base =
        {
          METRE: "m",
          SQUARE_METRE: "m²",
          CUBIC_METRE: "m³",
          GRAM: "g",
          SECOND: "s",
          NEWTON: "N",
          PASCAL: "Pa",
          RADIAN: "rad",
          DEGREE_CELSIUS: "°C",
        }[name] ?? name.toLowerCase();
      return `${prefix ? (SI_PREFIX_SYMBOL[prefix] ?? "") : ""}${base}`;
    }
    if (kind === "IFCCONVERSIONBASEDUNIT") {
      return String(scalarOf(unit.Name) ?? "");
    }
    if (kind === "IFCDERIVEDUNIT") {
      // Compose from the exponent list: far more useful than echoing
      // "massdensityunit" back at the reader.
      const parts: string[] = [];
      for (const handle of asArray(unit.Elements)) {
        const element = this.line(refId(handle));
        if (!element) continue;
        const baseId = refId(element.Unit);
        const base = baseId === null ? null : this.line(baseId);
        const symbol = base ? this.unitSymbol(base) : "";
        const exponent = numberOf(element.Exponent) ?? 1;
        if (!symbol || exponent === 0) continue;
        parts.push(exponent === 1 ? symbol : `${symbol}${superscript(exponent)}`);
      }
      if (parts.length) return parts.join("·");
    }
    const unitType = scalarOf(unit?.UnitType);
    return unitType ? String(unitType).toLowerCase() : "";
  }

  // ------------------------------------------------------------ raw fallback

  private rawAttributesGroup(element: any): ParamGroup {
    const rows: ParamRow[] = [];
    for (const [key, raw] of Object.entries(element)) {
      if (HEADER_ATTRS.has(key)) continue;
      if (refId(raw) !== null || Array.isArray(raw)) continue;
      const value = scalarOf(raw);
      if (value === null) continue;
      rows.push({ label: key, value: text(value) });
    }
    return { name: "Attributes", rows, open: false };
  }

  // -------------------------------------------------------------- placements

  private objectPlacementMatrix(
    placementId: number | null,
    depth = 0,
  ): Mat4 {
    if (placementId === null || depth > 16) return [...IDENTITY];
    const placement = this.line(placementId);
    if (!placement) return [...IDENTITY];
    if (this.kindOf(placement) !== "IFCLOCALPLACEMENT") return [...IDENTITY];
    const parent = this.objectPlacementMatrix(
      refId(placement.PlacementRelTo),
      depth + 1,
    );
    const own = this.axisPlacementMatrix(this.line(refId(placement.RelativePlacement)));
    return mul(parent, own);
  }

  private axisPlacementMatrix(axis: any): Mat4 {
    if (!axis) return [...IDENTITY];
    const location = this.line(refId(axis.Location));
    const coords = asArray(location?.Coordinates).map((c) => numberOf(c) ?? 0);
    const origin = {
      x: coords[0] ?? 0,
      y: coords[1] ?? 0,
      z: coords[2] ?? 0,
    };
    const z = normalize(this.directionOf(refId(axis.Axis), { x: 0, y: 0, z: 1 }));
    const refDir = this.directionOf(refId(axis.RefDirection), {
      x: 1,
      y: 0,
      z: 0,
    });
    // Gram-Schmidt: project RefDirection onto the plane normal to Axis.
    const d = dot(refDir, z);
    let x = normalize({
      x: refDir.x - z.x * d,
      y: refDir.y - z.y * d,
      z: refDir.z - z.z * d,
    });
    if (length(x) < 1e-9) {
      x = normalize(
        Math.abs(z.x) < 0.9 ? cross({ x: 1, y: 0, z: 0 }, z) : cross({ x: 0, y: 1, z: 0 }, z),
      );
    }
    const y = cross(z, x);
    return [
      x.x, x.y, x.z, 0,
      y.x, y.y, y.z, 0,
      z.x, z.y, z.z, 0,
      origin.x, origin.y, origin.z, 1,
    ];
  }

  private directionOf(dirId: number | null, fallback: Vec3): Vec3 {
    const dir = this.line(dirId);
    const ratios = asArray(dir?.DirectionRatios).map((c) => numberOf(c) ?? 0);
    const x = ratios[0];
    const y = ratios[1];
    if (x === undefined || y === undefined) return fallback;
    return { x, y, z: ratios[2] ?? 0 };
  }

  // ------------------------------------------------------------- formatting

  /** Model length units in one display unit (mm). */
  private get modelToDisplay(): number {
    return this.lengthToMetres / DISPLAY_LENGTH_IN_METRES;
  }

  private fmtLength(value: number): string {
    return `${fmt(value * this.modelToDisplay)} ${DISPLAY_LENGTH_UNIT}`;
  }

  /** For values web-ifc already scaled to metres (tessellated geometry). */
  private fmtLengthFromMetres(metres: number): string {
    return `${fmt(metres / DISPLAY_LENGTH_IN_METRES)} ${DISPLAY_LENGTH_UNIT}`;
  }

  private fmtArea(value: number): string {
    return `${fmtSignificant(value * this.lengthToMetres ** 2)} m²`;
  }

  private fmtVolume(value: number): string {
    return `${fmtSignificant(value * this.lengthToMetres ** 3)} m³`;
  }

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

  private quantityLengthRow(label: string, value: number, prop: any): ParamRow {
    const choice = this.quantityUnit(prop, "LENGTHUNIT");
    if (choice.resolved) {
      return this.quantityCanonicalRow(
        label,
        value * choice.resolved.toCanonical / DISPLAY_LENGTH_IN_METRES,
        DISPLAY_LENGTH_UNIT,
      );
    }
    if (choice.declared) {
      return this.unconvertedQuantityRow(label, value, choice.symbol);
    }
    return this.lengthRow(label, value);
  }

  private quantityAreaRow(label: string, value: number, prop: any): ParamRow {
    const choice = this.quantityUnit(prop, "AREAUNIT");
    if (choice.resolved) {
      return this.quantityCanonicalRow(
        label,
        value * choice.resolved.toCanonical,
        "m²",
      );
    }
    if (choice.declared) {
      return this.unconvertedQuantityRow(label, value, choice.symbol);
    }
    // IFC permits AREAUNIT to be omitted; only then derive it from LENGTHUNIT.
    return this.quantityCanonicalRow(label, value * this.lengthToMetres ** 2, "m²");
  }

  private quantityVolumeRow(label: string, value: number, prop: any): ParamRow {
    const choice = this.quantityUnit(prop, "VOLUMEUNIT");
    if (choice.resolved) {
      return this.quantityCanonicalRow(
        label,
        value * choice.resolved.toCanonical,
        "m³",
      );
    }
    if (choice.declared) {
      return this.unconvertedQuantityRow(label, value, choice.symbol);
    }
    // IFC permits VOLUMEUNIT to be omitted; only then derive it from LENGTHUNIT.
    return this.quantityCanonicalRow(label, value * this.lengthToMetres ** 3, "m³");
  }

  private quantityWeightRow(label: string, value: number, prop: any): ParamRow {
    const choice = this.quantityUnit(prop, "MASSUNIT");
    if (choice.resolved) {
      return this.quantityCanonicalRow(
        label,
        value * choice.resolved.toCanonical,
        "kg",
      );
    }
    if (choice.declared) {
      return this.unconvertedQuantityRow(label, value, choice.symbol);
    }
    return { label, value: fmt(value), raw: value, unit: "" };
  }

  /** IFC quantities use three decimal places; mesh-derived values retain SI precision. */
  private quantityCanonicalRow(label: string, value: number, unit: string): ParamRow {
    return { label, value: `${fmt(value)} ${unit}`, raw: value, unit };
  }

  /** Preserve an explicitly declared unit even if this reader cannot convert it. */
  private unconvertedQuantityRow(
    label: string,
    value: number,
    unit: string,
  ): ParamRow {
    return {
      label,
      value: `${fmt(value)}${unit ? ` ${unit}` : ""}`,
      raw: value,
      unit,
    };
  }

  /** Volume/area already in SI, as produced from the tessellated mesh. */
  private siRow(label: string, si: number, unit: "m²" | "m³"): ParamRow {
    return { label, value: `${fmtSignificant(si)} ${unit}`, raw: si, unit };
  }

  private numberRow(label: string, value: number, decimals = 3): ParamRow {
    return { label, value: fmt(value, decimals), raw: value, unit: "" };
  }
}

// ------------------------------------------------------------------ helpers

function refId(value: any): number | null {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === REF &&
    typeof value.value === "number"
  ) {
    return value.value;
  }
  return null;
}

/** Unwraps a web-ifc typed value to a primitive; null for refs/aggregates. */
function scalarOf(value: any): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return null;
  if (value.type === REF) return null;
  const inner = value.value;
  if (inner === null || inner === undefined || typeof inner === "object") {
    return null;
  }
  return inner;
}

function numberOf(value: any): number | null {
  const scalar = scalarOf(value);
  if (typeof scalar === "number" && Number.isFinite(scalar)) return scalar;
  if (typeof scalar === "string") {
    const parsed = Number(scalar);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Normalises a possibly-scalar IFC aggregate to an array. */
function asArray(value: any): any[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function push<K, V>(map: Map<K, V[]>, key: K, ...values: V[]): void {
  const existing = map.get(key);
  if (existing) existing.push(...values);
  else map.set(key, [...values]);
}

function text(value: string | number | boolean | null): string {
  if (value === null || value === undefined || value === "") return UNSET;
  if (typeof value === "number") return fmt(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function fmt(value: number, maxDecimals = 3): string {
  if (!Number.isFinite(value)) return UNSET;
  if (Number.isInteger(value)) return String(value);
  const rounded = value.toFixed(maxDecimals);
  const trimmed = rounded.replace(/\.?0+$/, "");
  // Guard against tiny magnitudes collapsing to "0" / "-0".
  if (Number(trimmed) === 0 && value !== 0) return value.toExponential(3);
  return trimmed === "-0" ? "0" : trimmed;
}

/**
 * Reads vertex `index` (stride 6: xyz + normal), applies the placed
 * geometry's transform, then maps web-ifc's Y-up output back to IFC's Z-up.
 *
 * web-ifc bakes the Y-up swap into each `flatTransformation` — `GetCoordination
 * Matrix()` stays identity — so `ifc = (glX, -glZ, glY)`. The map is a rotation
 * (det = +1), so volumes and areas are unaffected; only positions need it.
 */
/**
 * True when no two non-adjacent edges of the closed polygon cross.
 *
 * O(n²), which is fine for profile outlines; anything with an implausible point
 * count is reported as non-simple rather than scanned.
 */
function isSimplePolygon(pts: Array<[number, number]>): boolean {
  const n = pts.length;
  if (n < 3) return false;
  if (n > 512) return false;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i]!;
    const a2 = pts[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // Skip edges sharing an endpoint (i,i+1 vs i+1,i+2 and the wrap-around).
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue;
      if (segmentsCross(a1, a2, pts[j]!, pts[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

function segmentsCross(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  const d1 = crossSign(p3, p4, p1);
  const d2 = crossSign(p3, p4, p2);
  const d3 = crossSign(p1, p2, p3);
  const d4 = crossSign(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  // Collinear overlap counts as touching, not crossing — profile outlines with
  // a doubled-back edge are degenerate but not self-intersecting in a way that
  // invalidates the shoelace sum.
  return false;
}

function crossSign(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): number {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (value > 1e-9) return 1;
  if (value < -1e-9) return -1;
  return 0;
}

const SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

function superscript(exponent: number): string {
  const digits = String(Math.abs(Math.trunc(exponent)))
    .split("")
    .map((d) => SUPERSCRIPTS[Number(d)])
    .join("");
  return exponent < 0 ? `⁻${digits}` : digits;
}

/** Keeps small magnitudes readable where fixed decimals would truncate them. */
function fmtSignificant(value: number, digits = 5): string {
  if (!Number.isFinite(value)) return UNSET;
  if (value === 0) return "0";
  if (Math.abs(value) >= 1000) return fmt(value);
  return String(Number(value.toPrecision(digits)));
}

function vertexAt(verts: Float32Array, index: number, m: number[]): Vec3 {
  const o = index * 6;
  const x = verts[o] ?? 0;
  const y = verts[o + 1] ?? 0;
  const z = verts[o + 2] ?? 0;
  const glX = el(m, 0) * x + el(m, 4) * y + el(m, 8) * z + el(m, 12);
  const glY = el(m, 1) * x + el(m, 5) * y + el(m, 9) * z + el(m, 13);
  const glZ = el(m, 2) * x + el(m, 6) * y + el(m, 10) * z + el(m, 14);
  return { x: glX, y: -glZ, z: glY };
}

/** Bounds-safe read; every Mat4 here is length 16 by construction. */
function el(m: readonly number[], i: number): number {
  return m[i] ?? 0;
}

function applyDirection(m: Mat4, v: Vec3): Vec3 {
  return {
    x: el(m, 0) * v.x + el(m, 4) * v.y + el(m, 8) * v.z,
    y: el(m, 1) * v.x + el(m, 5) * v.y + el(m, 9) * v.z,
    z: el(m, 2) * v.x + el(m, 6) * v.y + el(m, 10) * v.z,
  };
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += el(a, k * 4 + row) * el(b, col * 4 + k);
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (len < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
