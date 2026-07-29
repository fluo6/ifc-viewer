import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Playwright compiles specs to CJS, so __dirname is the portable choice here —
// using import.meta.url flips the output to ESM and breaks the require interop.
const root = resolve(__dirname, "..");
const FIXTURE = resolve(__dirname, "fixtures/i-beam.ifc");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ["."], cwd: root });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean((window as any).__viewer), null, {
    timeout: 60_000,
  });
  // Hand the bytes straight to the viewer — this exercises the same path the
  // dropzone and the OS file association use, without a native dialog.
  const bytes = [...readFileSync(FIXTURE)];
  await page.evaluate(async (data) => {
    const buffer = new Uint8Array(data).buffer;
    await (window as any).__viewer.loadIfc(buffer, "i-beam.ifc");
  }, bytes);
});

test.afterAll(async () => {
  await app?.close();
});

test("loads the fixture and classifies the beam", async () => {
  const categories = await page.evaluate(() => [
    ...(window as any).__viewer.getCategories().keys(),
  ]);
  expect(categories).toContain("IFCBEAM");
});

/**
 * The parameters below live in entities that OBC's IfcLoader strips from the
 * fragments (IfcIShapeProfileDef, IfcExtrudedAreaSolid, IfcLocalPlacement), so
 * this asserts the raw-IFC reader is wired up and running in Electron — where
 * it has to resolve its own copy of web-ifc.wasm under file://.
 */
test("panel shows profile, extrusion, geometry and material", async () => {
  const expressId = await page.evaluate(
    () => (window as any).__viewer.getCategories().get("IFCBEAM")[0],
  );
  await page.evaluate((id) => {
    (window as any).__viewer.onSelection.emit({ fragmentId: "test", expressId: id });
  }, expressId);

  const panel = page.locator("#properties");
  await expect(panel.locator("details summary", { hasText: "IfcShapeProfile" })).toBeVisible();

  const groups = await panel
    .locator("details summary")
    .evaluateAll((els) => els.map((e) => e.textContent));
  expect(groups).toEqual([
    "ReferenceObject",
    "IfcShapeProfile",
    "Extrusion",
    "IfcStructuralProfileProperties",
    "CalculatedGeometryValues",
    "IfcMaterial",
    "Pset_BeamCommon",
  ]);

  // Values are hand-checkable from the fixture: a 133 x 203 I with 7.8 flanges
  // and a 5.8 web is 3161.7 mm², extruded 5000 mm from z=3000 so the centroid
  // sits at z=5500.
  const rows = await panel.evaluate((el) => {
    const out: Record<string, string> = {};
    for (const group of el.querySelectorAll("details")) {
      const name = group.querySelector("summary")!.textContent!;
      for (const row of group.querySelectorAll("div > div")) {
        const cells = row.querySelectorAll("span");
        if (cells.length === 2) {
          out[`${name}/${cells[0]!.textContent}`] = cells[1]!.textContent!;
        }
      }
    }
    return out;
  });

  expect(rows["IfcShapeProfile/ProfileName"]).toBe("200UB25.4");
  expect(rows["IfcShapeProfile/OverallWidth"]).toBe("133 mm");
  expect(rows["IfcShapeProfile/OverallDepth"]).toBe("203 mm");
  expect(rows["IfcShapeProfile/WebThickness"]).toBe("5.8 mm");
  expect(rows["IfcShapeProfile/FlangeThickness"]).toBe("7.8 mm");
  expect(rows["Extrusion/Depth"]).toBe("5000 mm");
  expect(rows["Extrusion/ExtrusionZ"]).toBe("5000 mm");
  expect(rows["Extrusion/OriginX"]).toBe("1000 mm");
  expect(rows["CalculatedGeometryValues/Volume"]).toBe("0.015809 m³");
  expect(rows["CalculatedGeometryValues/CenterOfGravityZ"]).toBe("5500 mm");
  expect(rows["CalculatedGeometryValues/IsSolid"]).toBe("True");
  expect(rows["IfcStructuralProfileProperties/MomentOfInertiaY"]).toBe("23600000 mm⁴");
  expect(rows["IfcMaterial/Name"]).toBe("Steel_Grade_300");
  expect(rows["IfcMaterial/YieldStress"]).toBe("300 MPa");
  expect(rows["Pset_BeamCommon/Reference"]).toBe("200UB25.4");
});

test("clears the panel when the model is unloaded", async () => {
  await page.evaluate(() => (window as any).__viewer.unloadIfc());
  await expect(page.locator("#properties")).toContainText("Click an element to inspect");
});
