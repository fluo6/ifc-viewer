import { expect, test } from "@playwright/test";

import {
  FIXTURE_IFC,
  fixtureExists,
  launchViewer,
  readyWindow,
} from "./launch";

/**
 * Guard against property-set cards accumulating across selections.
 *
 * Symptom: selecting elements one after another made the panel show
 * Qto_SlabBaseQuantities / TTW_QuantityCheck twice, then three times, and so
 * on. This exercises the underlying data path rather than the DOM, so it
 * isolates whether the duplication originates in the relations index.
 */
test("repeated getPropertySets calls do not accumulate sets", async () => {
  test.skip(!fixtureExists(), `fixture IFC not present: ${FIXTURE_IFC}`);
  test.setTimeout(180_000);

  const app = await launchViewer();
  try {
    const win = await readyWindow(app);

    const runs = await win.evaluate(async (ifcPath: string) => {
      const viewer = (window as any).__viewer;
      const buf = await (window as any).electron.readFile(ifcPath);
      await viewer.loadIfc(buf, "fixture.ifc");

      const categories = viewer.getCategories() as Map<string, number[]>;
      const slabs = categories.get("IFCSLAB") ?? [];
      const beams = categories.get("IFCBEAM") ?? [];
      const first = slabs[0];
      const second = beams[0] ?? slabs[1];
      if (first === undefined || second === undefined) {
        // Two distinct elements are the whole premise: the bug only shows when
        // selection moves away and comes back.
        throw new Error(
          `fixture has too few elements: ${slabs.length} slabs, ${beams.length} beams`,
        );
      }

      // Two CONCURRENT first calls, before any sequential call has had a
      // chance to mark the relations index as built. A boolean guard lets
      // both through and the duplication returns.
      const concurrentIds = [first, first, second];
      const concurrent = await Promise.all(
        concurrentIds.map((id) => viewer.getPropertySets(id)),
      );

      // Then mimic a user clicking around: same element, a different one,
      // and back again.
      const sequence = [first, first, second, first, second, first];
      const out: Array<{ id: number; names: string[] }> = [];
      concurrentIds.forEach((id, i) => {
        out.push({ id, names: concurrent[i].map((s: any) => s.name) });
      });
      for (const id of sequence) {
        const sets = await viewer.getPropertySets(id);
        out.push({ id, names: sets.map((s: any) => s.name) });
      }
      return out;
    }, FIXTURE_IFC);

    for (const run of runs) {
      console.log(`#${run.id}: ${JSON.stringify(run.names)}`);
    }

    // Every call for a given element must return exactly the same sets.
    const baselineRun = runs[0];
    if (!baselineRun) throw new Error("no getPropertySets calls were recorded");
    const firstId = baselineRun.id;
    const baseline = baselineRun.names;
    expect(baseline.length).toBeGreaterThan(0);

    for (const run of runs) {
      if (run.id !== firstId) continue;
      expect(
        run.names,
        `sets for #${run.id} changed across calls -- accumulating`,
      ).toEqual(baseline);
    }

    // And no set name may appear twice within a single call.
    for (const run of runs) {
      const unique = new Set(run.names);
      expect(
        unique.size,
        `duplicate set names for #${run.id}: ${JSON.stringify(run.names)}`,
      ).toBe(run.names.length);
    }
  } finally {
    await app.close();
  }
});
