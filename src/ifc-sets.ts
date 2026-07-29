/**
 * Flattening of IFC property-set-definitions into name/value pairs.
 *
 * Two different subtypes of IfcPropertySetDefinition reach the properties
 * panel, and they store their contents in different attributes:
 *
 *   IfcPropertySet      -> HasProperties -> IfcPropertySingleValue.NominalValue
 *   IfcElementQuantity  -> Quantities    -> IfcQuantity*.<Type>Value
 *
 * Kept free of @thatopen/* and three imports so it is unit-testable in node.
 */

/** Resolves an express id to a web-ifc property object. */
export type EntityResolver = (id: number) => Promise<any>;

export interface IfcSet {
  name: string;
  props: Record<string, unknown>;
}

/**
 * The value attribute of each IfcPhysicalSimpleQuantity subtype. IFC gives
 * each its own attribute name rather than a shared one, so there is no
 * alternative to checking for each in turn.
 */
const QUANTITY_VALUE_KEYS = [
  "LengthValue",
  "AreaValue",
  "VolumeValue",
  "WeightValue",
  "CountValue",
  "TimeValue",
] as const;

/** Unwrap web-ifc's `{ type, value }` wrapper, tolerating bare values. */
function unwrap(v: any): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in v) return (v as any).value;
  return v;
}

/** Express id from an attribute that may be a handle or a bare number. */
function refId(ref: any): number | null {
  const v = unwrap(ref);
  return typeof v === "number" ? v : null;
}

function quantityValue(entity: any): unknown {
  for (const key of QUANTITY_VALUE_KEYS) {
    if (entity[key] !== undefined && entity[key] !== null) {
      return unwrap(entity[key]);
    }
  }
  return null;
}

/**
 * Flatten one IfcPropertySet or IfcElementQuantity into display pairs.
 *
 * `fallbackId` names the set when it carries no Name of its own.
 */
export async function collectSet(
  set: any,
  resolve: EntityResolver,
  fallbackId: number,
): Promise<IfcSet> {
  const name = (unwrap(set?.Name) as string) ?? `Set_${fallbackId}`;
  const props: Record<string, unknown> = {};

  // IfcPropertySet
  const singles = set?.HasProperties;
  if (Array.isArray(singles)) {
    for (const ref of singles) {
      const id = refId(ref);
      if (id === null) continue;
      const entity = await resolve(id);
      const key = unwrap(entity?.Name);
      if (key === undefined || key === null) continue;
      props[String(key)] = unwrap(entity?.NominalValue);
    }
  }

  // IfcElementQuantity. Without this branch a quantity set renders as an
  // empty section: the set itself resolves and supplies a name, but its
  // contents hang off Quantities rather than HasProperties.
  const quantities = set?.Quantities;
  if (Array.isArray(quantities)) {
    for (const ref of quantities) {
      const id = refId(ref);
      if (id === null) continue;
      const entity = await resolve(id);
      const key = unwrap(entity?.Name);
      if (key === undefined || key === null) continue;
      props[String(key)] = quantityValue(entity);
    }
  }

  return { name: String(name), props };
}
