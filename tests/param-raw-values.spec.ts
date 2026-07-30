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
