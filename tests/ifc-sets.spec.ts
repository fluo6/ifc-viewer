import { expect, test } from "@playwright/test";

import { collectSet } from "../src/ifc-sets";

/**
 * Fixtures mirror what web-ifc's getProperties actually returns: every
 * attribute wrapped as { type, value }, references as handles.
 *
 * Values are taken verbatim from the PAC IFC model
 * (264034-TTW-11-RH-ST-001-[01]), slab TTWRH_A_RAFT_b567b294, whose
 * Qto_SlabBaseQuantities rendered as an empty section in the viewer.
 */
const ENTITIES: Record<number, any> = {
  // --- IfcElementQuantity for a slab ---
  38290: {
    expressID: 38290,
    Name: { type: 1, value: "Qto_SlabBaseQuantities" },
    Description: { type: 1, value: "ETABS-derived, gross only (TTW)" },
    MethodOfMeasurement: { type: 1, value: "BaseQuantities" },
    Quantities: [
      { type: 5, value: 38285 },
      { type: 5, value: 38286 },
      { type: 5, value: 38287 },
      { type: 5, value: 38288 },
      { type: 5, value: 38289 },
    ],
  },
  38285: {
    Name: { value: "Width" },
    Unit: null,
    LengthValue: { value: 23.622046999999998 },
  },
  38286: {
    Name: { value: "Perimeter" },
    Unit: null,
    LengthValue: { value: 905.4112868667435 },
  },
  38287: {
    Name: { value: "GrossArea" },
    Unit: null,
    AreaValue: { value: 50177.10191192469 },
  },
  38288: {
    Name: { value: "GrossVolume" },
    Unit: null,
    VolumeValue: { value: 1185285.8596872748 },
  },
  38289: {
    Name: { value: "GrossWeight" },
    Unit: null,
    WeightValue: { value: 271.4326427943678 },
  },

  // --- IfcPropertySet, which already worked; guards against regression ---
  38291: {
    Name: { type: 1, value: "TTW_QuantityCheck" },
    HasProperties: [
      { type: 5, value: 38292 },
      { type: 5, value: 38293 },
    ],
  },
  38292: {
    Name: { value: "MassMethod" },
    NominalValue: { type: 1, value: "analytic" },
  },
  38293: {
    Name: { value: "Thickness_m" },
    NominalValue: { type: 4, value: 0.6 },
  },

  // --- a count quantity, the one remaining IfcQuantity* subtype in use ---
  40000: {
    Name: { value: "Qto_Custom" },
    Quantities: [{ type: 5, value: 40001 }],
  },
  40001: { Name: { value: "Count" }, CountValue: { value: 3 } },
};

const resolve = async (id: number) => ENTITIES[id] ?? null;

test("reads quantities out of an IfcElementQuantity", async () => {
  const set = await collectSet(ENTITIES[38290], resolve, 38290);

  expect(set.name).toBe("Qto_SlabBaseQuantities");
  expect(set.props).toEqual({
    Width: 23.622046999999998,
    Perimeter: 905.4112868667435,
    GrossArea: 50177.10191192469,
    GrossVolume: 1185285.8596872748,
    GrossWeight: 271.4326427943678,
  });
});

test("a quantity set is never reported as empty when it has quantities", async () => {
  const set = await collectSet(ENTITIES[38290], resolve, 38290);
  expect(Object.keys(set.props).length).toBeGreaterThan(0);
});

test("still reads an ordinary IfcPropertySet", async () => {
  const set = await collectSet(ENTITIES[38291], resolve, 38291);
  expect(set.name).toBe("TTW_QuantityCheck");
  expect(set.props).toEqual({ MassMethod: "analytic", Thickness_m: 0.6 });
});

test("reads IfcQuantityCount", async () => {
  const set = await collectSet(ENTITIES[40000], resolve, 40000);
  expect(set.props).toEqual({ Count: 3 });
});

test("names a set with no Name using its express id", async () => {
  const set = await collectSet({ Quantities: [] }, resolve, 999);
  expect(set.name).toBe("Set_999");
});

test("tolerates an unresolvable reference without throwing", async () => {
  const set = await collectSet(
    { Name: { value: "Qto_Broken" }, Quantities: [{ type: 5, value: 123456 }] },
    resolve,
    1,
  );
  expect(set.props).toEqual({});
});
