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

test("repeated groups with the same name are disambiguated by occurrence, not overwritten", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcWall", "W1", [
        REFERENCE,
        { name: "IfcMaterial", rows: [{ label: "Name", value: "Concrete" }] },
        { name: "IfcMaterial", rows: [{ label: "Name", value: "Insulation" }] },
        { name: "IfcMaterial", rows: [{ label: "Name", value: "Brick" }] },
      ]),
    ]),
  );
  expect(cell(model, "Walls", 0, "Material.Name")).toBe("Concrete");
  expect(cell(model, "Walls", 0, "Material 2.Name")).toBe("Insulation");
  expect(cell(model, "Walls", 0, "Material 3.Name")).toBe("Brick");
});

test("the multi-solid suffix is not treated as a repeated group name", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcBeam", "B1", [
        REFERENCE,
        { name: "IfcShapeProfile", rows: [{ label: "ProfileName", value: "A" }] },
        { name: "IfcShapeProfile 2", rows: [{ label: "ProfileName", value: "B" }] },
      ]),
    ]),
  );
  const headers = sheet(model, "Beams").columns.map((c) => c.header);
  expect(headers).toContain("Profile.ProfileName");
  expect(headers).not.toContain("Profile 2.ProfileName");
  expect(cell(model, "Beams", 0, "SolidCount")).toBe(2);
});

test("Level and GUID become empty cells for the reader's unset marker, not the literal marker", () => {
  const model = buildWorkbook(
    input([
      element(1, "IfcBeam", "B1", [
        {
          name: "ReferenceObject",
          rows: [
            { label: "Name", value: "B1" },
            { label: "IFC Class", value: "IfcBeam" },
            { label: "GUID (IFC)", value: "—" },
            { label: "Container", value: "— (IfcBuildingStorey)" },
          ],
        },
      ]),
    ]),
  );
  expect(cell(model, "Beams", 0, "Level")).toBeNull();
  expect(cell(model, "Beams", 0, "GUID")).toBeNull();
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
