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
