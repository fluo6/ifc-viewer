# IFC Viewer

Local desktop IFC viewer. Drag an `.ifc` file onto the window or double-click one in the OS to open it. Inspect properties, toggle visibility per IFC class, and clip with a horizontal plane.

## Develop

```
npm install
npm run dev
```

## Package

```
npm run build
npm run dist     # produces release/ with installer
```

## Parameters panel

Selecting an element shows its section dimensions, extrusion, derived geometry,
material and any property sets. These come from a second `web-ifc` model kept
open on the source file ([src/ifc-parameters.ts](src/ifc-parameters.ts)) rather
than from the fragments: OBC's `IfcLoader` runs properties through
`IfcJsonExporter`, which drops every type in its `GeometryTypes` set — including
`IfcExtrudedAreaSolid`, all `IfcProfileDef` subtypes, `IfcLocalPlacement`,
`IfcAxis2Placement3D` and `IfcCartesianPoint`. Those hold the profile
dimensions, so without the raw read the panel has nothing to show for exports
that ship no `IfcPropertySet` (Rhino/ETABS models are typically in that
category).

Lengths are always displayed in millimetres; the file's own length unit is
listed under `ReferenceObject` as `File Length Unit`.

To verify extraction against real files:

```bash
npm run check:params -- "path/to/model.ifc"
```

It reports per-class group coverage and cross-checks the tessellated volume
against profile area × depth and the centroid against the extrusion mid-point.
Exits non-zero on a missing group or an unflagged disagreement.
