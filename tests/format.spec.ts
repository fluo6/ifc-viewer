import { expect, test } from "@playwright/test";

import { formatValue } from "../src/format";

test("trims floating-point noise from real quantity values", () => {
  // Verbatim from the PAC IFC: 600 mm and 19.42 m3 expressed in inch units.
  expect(formatValue(23.622046999999998)).toBe("23.622");
  expect(formatValue(1185285.8596872748)).toBe("1185285.8597");
  expect(formatValue(905.4112868667435)).toBe("905.4113");
});

test("leaves integers alone", () => {
  expect(formatValue(3)).toBe("3");
  expect(formatValue(0)).toBe("0");
});

test("does not collapse very small values to zero", () => {
  // Fixed-point at 4 decimals would render both of these as "0", losing the
  // value entirely. Very small magnitudes fall back to significant figures,
  // which JS renders in exponent form -- correct for e.g. a MassDensity of
  // 2.447e-12 Gg/mm3.
  expect(formatValue(1e-6)).toBe("0.000001");
  expect(formatValue(2.4473189e-12)).toBe("2.447e-12");
  expect(formatValue(2.4473189e-12)).not.toBe("0");
});

test("renders absent values as a dash, not as 'null'", () => {
  expect(formatValue(null)).toBe("—");
  expect(formatValue(undefined)).toBe("—");
  expect(formatValue("")).toBe("—");
});

test("passes strings through", () => {
  expect(formatValue("250UC72.9")).toBe("250UC72.9");
  expect(formatValue("BaseQuantities")).toBe("BaseQuantities");
});

test("handles booleans and non-finite numbers", () => {
  expect(formatValue(true)).toBe("true");
  expect(formatValue(false)).toBe("false");
  expect(formatValue(NaN)).toBe("NaN");
});
