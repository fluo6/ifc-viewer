import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { launchViewer, readyWindow } from "./launch";

/**
 * A hand-checkable IFC: one 133 x 203 I-section beam, 7.8 flanges and a 5.8
 * web, extruded 5000 mm along +Z from (1000, 2000, 3000). That is 3161.7 mm² of
 * steel, so 0.0158086 m³, with its centroid at z = 5500.
 *
 * Committed rather than pointed at a project model so the derived-geometry
 * numbers below can be checked by hand.
 */
const FIXTURE = path.resolve(__dirname, "fixtures/i-beam.ifc");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  app = await launchViewer();
  page = await readyWindow(app);
  // Hand the bytes straight to the viewer -- same path as the dropzone and the
  // OS file association, without a native dialog.
  const bytes = [...readFileSync(FIXTURE)];
  await page.evaluate(async (data) => {
    await (window as any).__viewer.loadIfc(new Uint8Array(data).buffer, "i-beam.ifc");
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
 * These parameters live in entities that OBC's IfcLoader strips from the
 * fragments (IfcIShapeProfileDef, IfcExtrudedAreaSolid, IfcLocalPlacement), so
 * this asserts the raw-IFC reader is wired up and running under Electron --
 * where it has to resolve its own copy of web-ifc.wasm over file://.
 */
test("panel shows profile, extrusion, geometry and material", async () => {
  const expressId = await page.evaluate(
    () => (window as any).__viewer.getCategories().get("IFCBEAM")[0],
  );
  await page.evaluate((id) => {
    (window as any).__viewer.onSelection.emit({ fragmentId: "test", expressId: id });
  }, expressId);

  const panel = page.locator("#properties");
  await expect(
    panel.locator("details summary", { hasText: "IfcShapeProfile" }),
  ).toBeVisible();

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

  const rows = await panel.evaluate((el) => {
    const out: Record<string, string> = {};
    for (const group of el.querySelectorAll("details")) {
      const name = group.querySelector("summary")!.textContent!;
      for (const r of group.querySelectorAll("div > div")) {
        const cells = r.querySelectorAll("span");
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
  expect(rows["IfcStructuralProfileProperties/MomentOfInertiaY"]).toBe(
    "23600000 mm⁴",
  );
  expect(rows["IfcMaterial/Name"]).toBe("Steel_Grade_300");
  expect(rows["IfcMaterial/YieldStress"]).toBe("300 MPa");
  expect(rows["Pset_BeamCommon/Reference"]).toBe("200UB25.4");
});

test("filters property names and values without losing focus or the query", async () => {
  const ids = await page.evaluate(() => {
    const categories = (window as any).__viewer.getCategories();
    return { beam: categories.get("IFCBEAM")[0], site: categories.get("IFCSITE")[0] };
  });
  const panel = page.locator("#properties");
  await page.evaluate(id => {
    (window as any).__viewer.onSelection.emit({ fragmentId: "test", expressId: id });
  }, ids.beam);
  await expect(panel).toContainText(`#${ids.beam}`);
  const search = panel.getByRole("searchbox", { name: "Search properties" });
  await expect(search).toBeVisible();

  await search.focus();
  await search.pressSequentially("oVeRaLlWiDtH");
  await expect(search).toBeFocused();
  await expect(panel.locator("details summary")).toHaveText(["IfcShapeProfile"]);
  await expect(panel.locator("details")).toContainText("OverallWidth");
  await expect(panel.locator("details")).toContainText("133 mm");
  await expect(panel.locator("details")).not.toContainText("OverallDepth");

  await search.fill("steel_grade_300");
  await expect(panel.locator("details summary")).toHaveText(["IfcMaterial"]);
  await expect(panel.locator("details")).toContainText("Steel_Grade_300");

  await search.fill("not-a-property");
  await expect(panel).toContainText("No matching properties");
  await expect(panel).toContainText(`#${ids.beam}`);
  await page.evaluate(id => {
    (window as any).__viewer.onSelection.emit({ fragmentId: "test", expressId: id });
  }, ids.site);
  await expect(search).toHaveValue("not-a-property");
  await expect(panel).toContainText(`#${ids.site}`);
  await page.evaluate(id => {
    (window as any).__viewer.onSelection.emit({ fragmentId: "test", expressId: id });
  }, ids.beam);
  await expect(search).toHaveValue("not-a-property");
  await expect(panel).toContainText(`#${ids.beam}`);

  await search.fill("");
  await expect(panel.locator("details summary")).toHaveCount(7);
});

test("clears the panel when the model is unloaded", async () => {
  await page.getByRole("searchbox", { name: "Search properties" }).fill("width");
  await page.evaluate(() => (window as any).__viewer.unloadIfc());
  await expect(page.locator("#properties")).toContainText(
    "Click an element to inspect",
  );
  await expect(page.getByRole("searchbox", { name: "Search properties" })).toHaveValue("");
});

test("keeps the no-parameters explanation while filtering an empty element", async () => {
  const panel = page.locator("#properties");
  await page.evaluate(() => {
    const viewer = (window as any).__viewer;
    viewer.unloadIfc();
    viewer.onSelection.emit({ fragmentId: "test", expressId: 999999 });
  });
  await expect(panel).toContainText("No parameters available for this element.");
  await panel.getByRole("searchbox", { name: "Search properties" }).fill("width");
  await expect(panel).toContainText("No parameters available for this element.");
});
