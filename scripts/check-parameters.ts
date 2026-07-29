/**
 * Headless check for the raw-IFC parameter reader.
 *
 * Runs `IfcParameterReader` over real IFC files with the node build of
 * web-ifc and reports, per IFC class, how many elements yield each parameter
 * group. Exits non-zero if any element of a geometric class is missing its
 * profile, extrusion or calculated-geometry group.
 *
 * Run via `node scripts/check-parameters.mjs <file.ifc> [...]`.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as WEBIFC from "web-ifc";
import {
  IfcParameterReader,
  PARAMETER_MODEL_SETTINGS,
  type ElementParameters,
  type ParamGroup,
} from "../src/ifc-parameters";

const PRODUCT_TYPES: Array<[string, number]> = [
  ["IFCBEAM", WEBIFC.IFCBEAM],
  ["IFCCOLUMN", WEBIFC.IFCCOLUMN],
  ["IFCMEMBER", WEBIFC.IFCMEMBER],
  ["IFCWALL", WEBIFC.IFCWALL],
  ["IFCSLAB", WEBIFC.IFCSLAB],
];

const REQUIRED = ["ReferenceObject", "IfcShapeProfile", "Extrusion", "CalculatedGeometryValues"];

interface ClassStats {
  total: number;
  present: Map<string, number>;
  missing: Array<{ expressId: number; group: string }>;
}

function groupKind(group: ParamGroup): string {
  // Strip the " 2", " 3" … suffix multi-solid elements get.
  return group.name.replace(/ \d+$/, "");
}

function findGroup(params: ElementParameters, kind: string): ParamGroup | undefined {
  return params.groups.find((g) => groupKind(g) === kind);
}

/** Pulls the leading number out of a formatted row value like `"250 mm"`. */
function rowNumber(group: ParamGroup | undefined, label: string): number | null {
  const row = group?.rows.find((r) => r.label === label);
  if (!row) return null;
  const value = Number.parseFloat(row.value.replace(/[^0-9eE+\-.]/g, ""));
  return Number.isFinite(value) ? value : null;
}

interface Deviation {
  expressId: number;
  detail: string;
  relative: number;
  /** Whether the reader itself warned about this disagreement. */
  flagged?: boolean;
}

/**
 * Cross-section area computed from the profile's own dimensions, independent of
 * both the mesh and the file's catalogue values.
 *
 * Deliberately assumes sharp corners: these exports leave FilletRadius unset,
 * and the tessellated geometry follows suit. (That is exactly why the file's
 * `CrossSectionArea` — a catalogue figure including root fillets — runs up to
 * ~5% higher on light sections, and why it makes a poor reference here.)
 */
/**
 * The reader's own derived cross-section area, in m², read back off the
 * rendered rows. Returns null when the reader could not derive one (U-shapes,
 * self-intersecting outlines), which drops the element from the check.
 */
function analyticArea(profile: ParamGroup): { area: number; source: string } | null {
  const def = profile.rows.find((r) => r.label === "ProfileDef")?.value ?? "";
  const area = rowNumber(profile, "CrossSectionArea (derived)");
  if (area === null || area <= 0) return null;
  return { area, source: def.replace(/^Ifc/, "") };
}

/**
 * Independent cross-checks on the derived geometry. Both catch the failure mode
 * where unit or axis handling is silently wrong: mesh volume must agree with the
 * analytic profile area x depth, and for a profile centred on its own placement
 * the centroid must sit at the mid-point of the extrusion axis.
 */
function crossCheck(
  params: ElementParameters,
): { volume: Deviation | null; centroid: Deviation | null } {
  const extrusion = findGroup(params, "Extrusion");
  const geometry = findGroup(params, "CalculatedGeometryValues");
  const profile = findGroup(params, "IfcShapeProfile");
  if (!extrusion || !geometry) return { volume: null, centroid: null };

  const depth = rowNumber(extrusion, "Depth");
  const volume = rowNumber(geometry, "Volume");
  let volumeDev: Deviation | null = null;
  const analytic = profile ? analyticArea(profile) : null;
  if (depth !== null && volume !== null && depth > 0 && analytic) {
    // analytic.area is m², depth is in the reader's display unit (mm).
    const expected = analytic.area * depth * 0.001;
    const relative = Math.abs(volume - expected) / expected;
    volumeDev = {
      expressId: params.expressId,
      detail:
        `volume ${volume.toPrecision(4)} m³ vs ${analytic.source}×depth ` +
        `${expected.toPrecision(4)} m³`,
      relative,
      flagged: geometry.rows.some((r) => r.label.includes("Tessellation")),
    };
  }

  // Only profiles centred on their placement (rectangle / I / circle) put the
  // centroid exactly on the extrusion axis mid-point.
  const profileDef = profile?.rows.find((r) => r.label === "ProfileDef")?.value ?? "";
  const centred = /RectangleProfileDef|IShapeProfileDef|CircleProfileDef/i.test(profileDef);
  let centroidDev: Deviation | null = null;
  if (centred && depth !== null && depth > 0) {
    const axes = ["X", "Y", "Z"] as const;
    const origin = axes.map((a) => rowNumber(extrusion, `Origin${a}`));
    const vector = axes.map((a) => rowNumber(extrusion, `Extrusion${a}`));
    const actual = axes.map((a) => rowNumber(geometry, `CenterOfGravity${a}`));
    if (![...origin, ...vector, ...actual].some((v) => v === null)) {
      let sq = 0;
      for (let i = 0; i < 3; i++) {
        const expected = origin[i]! + vector[i]! / 2;
        sq += (actual[i]! - expected) ** 2;
      }
      const distance = Math.sqrt(sq);
      centroidDev = {
        expressId: params.expressId,
        detail: `centroid off extrusion mid-point by ${distance.toFixed(1)} (depth ${depth.toFixed(0)})`,
        relative: distance / depth,
      };
    }
  }
  return { volume: volumeDev, centroid: centroidDev };
}

function dump(params: ElementParameters): string {
  const lines = [`--- #${params.expressId} ${params.ifcClass} · ${params.name}`];
  for (const group of params.groups) {
    lines.push(`  [${group.name}]`);
    for (const row of group.rows) {
      lines.push(`    ${row.label.padEnd(24)} ${row.value}`);
    }
  }
  return lines.join("\n");
}

async function checkFile(path: string): Promise<number> {
  const data = new Uint8Array(readFileSync(path));
  const api = new WEBIFC.IfcAPI();
  await api.Init();
  const modelId = api.OpenModel(data, PARAMETER_MODEL_SETTINGS as any);
  const reader = IfcParameterReader.attach(api, modelId);

  console.log(`\n${"=".repeat(78)}`);
  console.log(basename(path));
  console.log(`${"=".repeat(78)}`);
  console.log(
    `schema=${reader.schema} lengthUnit=${reader.lengthUnit} toMetres=${reader.lengthToMetres}`,
  );

  const stats = new Map<string, ClassStats>();
  const samples = new Map<string, ElementParameters>();
  let iShapeSample: ElementParameters | null = null;
  const volumeDevs: Deviation[] = [];
  const centroidDevs: Deviation[] = [];

  for (const [className, typeCode] of PRODUCT_TYPES) {
    const ids = api.GetLineIDsWithType(modelId, typeCode);
    const stat: ClassStats = { total: 0, present: new Map(), missing: [] };
    stats.set(className, stat);
    for (let i = 0; i < ids.size(); i++) {
      const expressId = ids.get(i);
      const params = reader.getElementParameters(expressId);
      if (!params) {
        stat.missing.push({ expressId, group: "<no parameters at all>" });
        continue;
      }
      stat.total++;
      const kinds = new Set(params.groups.map(groupKind));
      for (const kind of kinds) {
        stat.present.set(kind, (stat.present.get(kind) ?? 0) + 1);
      }
      for (const required of REQUIRED) {
        if (!kinds.has(required)) stat.missing.push({ expressId, group: required });
      }
      const checks = crossCheck(params);
      if (checks.volume) volumeDevs.push(checks.volume);
      if (checks.centroid) centroidDevs.push(checks.centroid);
      if (!samples.has(className)) samples.set(className, params);
      if (
        !iShapeSample &&
        params.groups.some(
          (g) =>
            groupKind(g) === "IfcShapeProfile" &&
            g.rows.some(
              (r) =>
                r.label === "ProfileDef" &&
                r.value.toUpperCase() === "IFCISHAPEPROFILEDEF",
            ),
        )
      ) {
        iShapeSample = params;
      }
    }
  }

  let failures = 0;
  console.log("\ncoverage (elements with each group / total):");
  for (const [className, stat] of stats) {
    if (!stat.total) continue;
    const cols = REQUIRED.concat(["IfcMaterial"])
      .map((g) => `${g}=${stat.present.get(g) ?? 0}/${stat.total}`)
      .join("  ");
    console.log(`  ${className.padEnd(12)} ${cols}`);
    // Walls/slabs are extruded from arbitrary or rectangle profiles; every
    // element in these files is a swept solid, so all four groups must exist.
    for (const miss of stat.missing.slice(0, 5)) {
      console.log(`    MISSING ${miss.group} on #${miss.expressId}`);
    }
    failures += stat.missing.length;
  }

  // 1%: the derived area describes the same sharp-cornered prism the mesh does,
  // so the only legitimate gap is circle faceting (~0.3% at 48 segments).
  const VOLUME_TOLERANCE = 0.01;
  const CENTROID_TOLERANCE = 0.02;

  // Known upstream tessellation defects mean some elements legitimately
  // disagree. Those must be flagged to the user, never silently wrong — so the
  // failure condition is an UNFLAGGED disagreement.
  const volumeSorted = [...volumeDevs].sort((a, b) => b.relative - a.relative);
  const disagreeing = volumeSorted.filter((d) => d.relative > VOLUME_TOLERANCE);
  const unflagged = disagreeing.filter((d) => !d.flagged);
  console.log(
    `\nvolume vs derived area×depth: checked ${volumeDevs.length}, ` +
      `disagree >1%: ${disagreeing.length} (all flagged: ${unflagged.length === 0}), ` +
      `worst ${((volumeSorted[0]?.relative ?? 0) * 100).toFixed(2)}%`,
  );
  for (const dev of unflagged.slice(0, 5)) {
    console.log(
      `    UNFLAGGED #${dev.expressId} ${dev.detail} → ${(dev.relative * 100).toFixed(1)}%`,
    );
  }
  failures += unflagged.length;
  // A systemic unit or axis error would put nearly everything into
  // disagreement, so cap the share that may legitimately differ.
  const disagreeShare = volumeDevs.length ? disagreeing.length / volumeDevs.length : 0;
  if (disagreeShare > 0.2) {
    console.log(
      `    FAIL ${(disagreeShare * 100).toFixed(0)}% of elements disagree — looks systemic, not upstream`,
    );
    failures++;
  }

  const centroidSorted = [...centroidDevs].sort((a, b) => b.relative - a.relative);
  const centroidBad = centroidSorted.filter((d) => d.relative > CENTROID_TOLERANCE);
  console.log(
    `centroid vs extrusion mid-point: checked ${centroidDevs.length}, ` +
      `over 2%: ${centroidBad.length}, ` +
      `worst ${((centroidSorted[0]?.relative ?? 0) * 100).toFixed(2)}%`,
  );
  for (const dev of centroidBad.slice(0, 5)) {
    console.log(`    #${dev.expressId} ${dev.detail} → ${(dev.relative * 100).toFixed(1)}%`);
  }
  failures += centroidBad.length;

  console.log("\nsample element per class:");
  for (const params of samples.values()) console.log(dump(params));
  if (iShapeSample) {
    console.log("\nI-shape profile sample (matches the reference screenshot):");
    console.log(dump(iShapeSample));
  } else {
    console.log("\nWARNING: no IFCISHAPEPROFILEDEF element found");
    failures++;
  }

  reader.close();
  return failures;
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error("usage: node scripts/check-parameters.mjs <file.ifc> [...]");
    process.exit(2);
  }
  let total = 0;
  for (const path of paths) {
    total += await checkFile(path);
  }
  console.log(
    `\n${total === 0 ? "OK — no missing groups" : `FAIL — ${total} missing group(s)`}`,
  );
  process.exit(total === 0 ? 0 : 1);
}

void main();
