import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as WEBIFC from "web-ifc";

import {
  IfcParameterReader,
  PARAMETER_MODEL_SETTINGS,
  type ParamGroup,
} from "../src/ifc-parameters";

const FIXTURE = path.resolve(__dirname, "fixtures/mixed-units-quantities.ifc");

async function readFixture(source = readFileSync(FIXTURE)) {
  const api = new WEBIFC.IfcAPI();
  await api.Init();
  const modelId = api.OpenModel(
    new Uint8Array(source),
    PARAMETER_MODEL_SETTINGS as any,
  );
  const reader = IfcParameterReader.attach(api, modelId);
  const ids = api.GetLineIDsWithType(modelId, WEBIFC.IFCSLAB);
  const params = reader.getElementParameters(ids.get(0));
  if (!params) throw new Error("mixed-unit fixture slab produced no parameters");
  return { reader, params };
}

function quantityRow(groups: ParamGroup[], label: string) {
  const qto = groups.find((group) => group.name === "Qto_SlabBaseQuantities");
  if (!qto) throw new Error("no Qto_SlabBaseQuantities group");
  const row = qto.rows.find((candidate) => candidate.label === label);
  if (!row) throw new Error(`no quantity row ${label}`);
  return row;
}

test("mixed project units format each IFC quantity with its declared dimension", async () => {
  const { reader, params } = await readFixture();
  try {
    expect(reader.lengthUnit).toBe("mm");
    expect(reader.lengthToMetres).toBe(0.001);

    expect(quantityRow(params.groups, "Width")).toMatchObject({
      value: "150 mm",
      raw: 150,
      unit: "mm",
    });
    expect(quantityRow(params.groups, "Perimeter")).toMatchObject({
      value: "244195.819 mm",
      unit: "mm",
    });
    expect(quantityRow(params.groups, "GrossArea")).toMatchObject({
      value: "2221.809 m²",
      unit: "m²",
    });
    expect(quantityRow(params.groups, "GrossVolume")).toMatchObject({
      value: "333.271 m³",
      unit: "m³",
    });
    expect(quantityRow(params.groups, "GrossWeight")).toMatchObject({
      value: "799851.405 kg",
      unit: "kg",
    });

    expect(quantityRow(params.groups, "GrossArea").raw).toBeCloseTo(
      2221.8094583068,
      10,
    );
    expect(quantityRow(params.groups, "GrossVolume").raw).toBeCloseTo(
      333.27141874602,
      10,
    );
  } finally {
    reader.close();
  }
});

test("a per-quantity unit overrides the project unit", async () => {
  const { reader, params } = await readFixture();
  try {
    expect(quantityRow(params.groups, "OverrideArea")).toMatchObject({
      value: "1 m²",
      raw: 1,
      unit: "m²",
    });
  } finally {
    reader.close();
  }
});

test("area and volume fall back to powers of LENGTHUNIT only when absent", async () => {
  const withoutAreaOrVolume = readFileSync(FIXTURE, "utf8").replace(
    "#20=IFCUNITASSIGNMENT((#15,#16,#17,#18));",
    "#20=IFCUNITASSIGNMENT((#15,#18));",
  );
  const { reader, params } = await readFixture(Buffer.from(withoutAreaOrVolume));
  try {
    expect(quantityRow(params.groups, "GrossArea")).toMatchObject({
      value: "0.002 m²",
      unit: "m²",
    });
    expect(quantityRow(params.groups, "GrossVolume")).toMatchObject({
      value: "3.333e-7 m³",
      unit: "m³",
    });
  } finally {
    reader.close();
  }
});
