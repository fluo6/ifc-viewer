import { expect, test } from "@playwright/test";

import {
  FIXTURE_IFC,
  fixtureExists,
  launchViewer,
  readyWindow,
} from "./launch";

/**
 * End-to-end guard for quantity-set rendering.
 *
 * The unit tests in ifc-sets.spec.ts mock web-ifc's output shape. This one
 * runs a real parse through the real loader, which is the only way to confirm
 * that `Quantities` actually survives into the fragments property store --
 * the assumption the fix rests on.
 *
 * Point IFC_FIXTURE at any IFC carrying IfcElementQuantity to run it
 * elsewhere; the test skips when the file is absent.
 */
test("quantity sets come back populated from a real IFC parse", async () => {
  test.skip(!fixtureExists(), `fixture IFC not present: ${FIXTURE_IFC}`);
  test.setTimeout(180_000);

  const app = await launchViewer();
  try {
    const win = await readyWindow(app);

    const result = await win.evaluate(async (ifcPath: string) => {
      const viewer = (window as any).__viewer;
      const buf = await (window as any).electron.readFile(ifcPath);
      await viewer.loadIfc(buf, "fixture.ifc");

      const categories = viewer.getCategories() as Map<string, number[]>;
      const pick = (cls: string) => (categories.get(cls) ?? [])[0];

      const out: Record<string, any> = { categories: [...categories.keys()] };
      for (const cls of ["IFCSLAB", "IFCBEAM", "IFCWALL"]) {
        const id = pick(cls);
        if (id === undefined) continue;
        out[cls] = await viewer.getPropertySets(id);
      }
      return out;
    }, FIXTURE_IFC);

    // The model must actually have loaded, or the rest proves nothing.
    expect(result.categories).toContain("IFCSLAB");

    const slabSets: Array<{ name: string; props: Record<string, unknown> }> =
      result.IFCSLAB;
    expect(slabSets, "slab should carry property sets").toBeTruthy();

    const qto = slabSets.find((s) => s.name.startsWith("Qto_"));
    expect(qto, `no Qto_ set found; got ${slabSets.map((s) => s.name)}`)
      .toBeTruthy();

    // The actual regression: this was an empty object before the fix.
    expect(Object.keys(qto!.props).length).toBeGreaterThan(0);
    expect(qto!.props).toHaveProperty("GrossVolume");
    expect(typeof qto!.props.GrossVolume).toBe("number");

    // And the custom property set must still work alongside it.
    const ttw = slabSets.find((s) => s.name === "TTW_QuantityCheck");
    expect(ttw).toBeTruthy();
    expect(ttw!.props).toHaveProperty("MassMethod");

    // Beams carry a different template name and the catalogue weight.
    const beamSets: Array<{ name: string; props: Record<string, unknown> }> =
      result.IFCBEAM;
    if (beamSets) {
      const beamQto = beamSets.find((s) => s.name.startsWith("Qto_"));
      expect(beamQto).toBeTruthy();
      expect(beamQto!.props).toHaveProperty("NetWeight");
    }

    console.log(
      "slab sets:",
      JSON.stringify(slabSets.map((s) => [s.name, s.props]), null, 1),
    );
  } finally {
    await app.close();
  }
});
