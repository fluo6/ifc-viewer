import { expect, test } from "@playwright/test";

import {
  FIXTURE_IFC,
  fixtureExists,
  launchViewer,
  readyWindow,
} from "./launch";

/**
 * The properties panel must show exactly the current selection.
 *
 * mountProperties clears the panel only after awaiting two async lookups, so a
 * slow render can resolve after a newer one and repaint with a stale element.
 * The first lookup on a fresh model is the slow one -- it builds the relations
 * index -- which makes "click A, immediately click B" the natural trigger.
 *
 * Asserted at the DOM level because that is what the user actually sees.
 */
test("panel shows only the latest selection, once", async () => {
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
      const slab = (categories.get("IFCSLAB") ?? [])[0];
      const beam = (categories.get("IFCBEAM") ?? [])[0];

      // Two selections back to back, without awaiting the first render --
      // exactly what clicking two elements quickly produces.
      viewer.onSelection.emit({ fragmentId: "test", expressId: slab });
      viewer.onSelection.emit({ fragmentId: "test", expressId: beam });

      // Let every in-flight render settle, including the slow first one.
      await new Promise((r) => setTimeout(r, 6000));

      const root = document.getElementById("properties")!;
      const html = root.innerHTML;
      const summaries = [...root.querySelectorAll("summary")].map(
        (s) => s.textContent ?? "",
      );
      return { html, summaries, slab, beam };
    }, FIXTURE_IFC);

    // The newer selection must win.
    expect(
      result.html,
      `panel should show the beam (#${result.beam})`,
    ).toContain(`#${result.beam}`);
    expect(
      result.html,
      `panel should NOT still show the slab (#${result.slab}) -- stale render won`,
    ).not.toContain(`#${result.slab}`);

    // And each card must appear exactly once, not piled up.
    const ttw = result.summaries.filter((s) => s === "TTW_QuantityCheck");
    expect(
      ttw.length,
      `TTW_QuantityCheck appeared ${ttw.length}x: ${JSON.stringify(result.summaries)}`,
    ).toBe(1);

    const qto = result.summaries.filter((s) => s.startsWith("Qto_"));
    expect(qto.length, `Qto_ cards: ${JSON.stringify(qto)}`).toBe(1);
    // The beam won, so the card must be the beam's template, not the slab's.
    expect(qto[0]).toBe("Qto_BeamBaseQuantities");
  } finally {
    await app.close();
  }
});

/**
 * Same requirement, with lookup order forcibly inverted.
 *
 * In normal operation both selections queue on the same relations-indexing
 * promise and therefore resolve in call order, so the newer render happens to
 * land last. That ordering is incidental, not guaranteed -- any future change
 * that makes one lookup slower than another (per-element caching, a network
 * fetch, a heavier element) reintroduces the stale repaint. This pins the
 * requirement by delaying the FIRST lookup so it resolves last.
 */
test("a slow stale render must not overwrite a newer selection", async () => {
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
      const slab = (categories.get("IFCSLAB") ?? [])[0];
      const beam = (categories.get("IFCBEAM") ?? [])[0];

      // Warm the relations index so it is not the dominant cost.
      await viewer.getPropertySets(slab);

      // Delay only the first subsequent lookup, so the earlier selection
      // resolves after the later one.
      const original = viewer.getPropertySets.bind(viewer);
      let calls = 0;
      viewer.getPropertySets = async (id: number) => {
        const delay = calls++ === 0 ? 2500 : 0;
        const sets = await original(id);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return sets;
      };

      viewer.onSelection.emit({ fragmentId: "test", expressId: slab });
      viewer.onSelection.emit({ fragmentId: "test", expressId: beam });

      await new Promise((r) => setTimeout(r, 6000));

      viewer.getPropertySets = original;
      const root = document.getElementById("properties")!;
      return {
        html: root.innerHTML,
        summaries: [...root.querySelectorAll("summary")].map(
          (s) => s.textContent ?? "",
        ),
        slab,
        beam,
      };
    }, FIXTURE_IFC);

    expect(
      result.html,
      `stale slab render (#${result.slab}) overwrote the newer beam selection (#${result.beam})`,
    ).not.toContain(`#${result.slab}`);
    expect(result.html).toContain(`#${result.beam}`);

    const qto = result.summaries.filter((s) => s.startsWith("Qto_"));
    expect(qto).toEqual(["Qto_BeamBaseQuantities"]);
  } finally {
    await app.close();
  }
});
