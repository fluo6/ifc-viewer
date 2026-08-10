# IFC Viewer

Local desktop IFC viewer. Drag an `.ifc` file onto the window or double-click one in the OS to open it. Inspect properties, toggle visibility per IFC class, and clip with a horizontal plane.

## Develop

```
npm install
npm run dev
```

## LAN web app

The same renderer can run as a browser app for another machine on the local
network. It processes IFC files in that browser; the host only serves the
static application and never receives the model.

From this directory, start the production container:

```bash
docker compose up -d --build
```

Find this host's LAN address (`hostname -I` on Linux), then open
`http://<host-ip>:2710` from the other machine. Use **Open IFC…** to choose a
file on that machine or drag one into the viewer. **Export XLSX** downloads the
workbook through the browser.

Port 2710 is the default. Change it without editing the compose file:

```bash
IFC_VIEWER_PORT=2711 docker compose up -d --build
```

Allow the selected TCP port through the host firewall if the browser cannot
connect. This mode has no authentication and is intended only for a trusted
LAN; do not expose it directly to the public internet. Stop it with:

```bash
docker compose down
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
