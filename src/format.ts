/**
 * Display formatting for property and quantity values.
 *
 * Quantity values arrive as raw IEEE doubles straight out of the IFC -- a
 * length of 600 mm stored in inches reads 23.622046999999998. Trim that noise
 * without hiding magnitude, and without collapsing genuinely small values to
 * zero. No DOM access, so it is unit-testable.
 */

/** Decimals kept for ordinary magnitudes. */
const DECIMALS = 4;

/** Below this, fixed-point would round to zero, so use significant figures. */
const SMALL_THRESHOLD = 1e-4;

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";

  if (typeof v === "boolean") return v ? "true" : "false";

  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    if (Math.abs(v) < SMALL_THRESHOLD) {
      // 1e-6 must not become "0"
      return String(Number(v.toPrecision(DECIMALS)));
    }
    // Number() drops the trailing zeros toFixed leaves behind.
    return String(Number(v.toFixed(DECIMALS)));
  }

  return String(v);
}
