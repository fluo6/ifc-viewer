# IFC Viewer — Design

**Date:** 2026-05-04
**Status:** Approved (pending user review of this doc)

## Goal

A simple desktop IFC viewer. Drag an `.ifc` file onto the window (or double-click one in the OS), see the 3D building model, click elements to inspect their IFC properties, toggle visibility by IFC class, and clip the model with a single horizontal plane.

Files never leave the machine — everything runs locally in an Electron app, parsed in-process via WebAssembly.

## Scope

**In:**

- Drag-drop `.ifc` file onto the window
- File-open dialog as alternative
- OS `.ifc` file association (double-click opens viewer)
- 3D viewport: orbit / pan / zoom, fit-to-selection, reset view
- Click-to-select element with orange outline highlight
- Right panel: selected element's properties + property sets
- Left panel: per-IFC-class visibility toggles, "isolate" button per class
- Single horizontal section plane with draggable height
- Determinate loading progress bar
- Replace currently loaded model on new drop (no confirm)
- Dark theme

**Out (explicitly):**

- Multiple models loaded simultaneously
- Recent-files / persistence across launches
- Multi-plane or arbitrary-orientation clipping
- Editing / annotating / measuring
- Cloud sync, sharing, accounts
- Bundled sample IFC

## Stack

- **Renderer:** Vite + vanilla TypeScript (no React/Vue — UI is small enough that DOM modules are simpler)
- **3D / IFC:** `@thatopen/components` + `@thatopen/components-front` on top of `web-ifc` (WASM) and `three.js` (transitive)
- **Desktop shell:** Electron (main process opens a `BrowserWindow` pointing at Vite dev server in dev, packaged `dist/index.html` in prod)
- **Packaging:** `electron-builder` produces a Windows installer (`.exe` / NSIS); Mac/Linux targets possible later but not in scope
- **WASM hosting:** `web-ifc.wasm` copied from `node_modules` to `public/` at install time, loader configured to fetch it relative to the app

## File Layout

```
ifc-viewer/
├─ electron/
│  ├─ main.ts          # BrowserWindow, file-open dialog IPC, .ifc association
│  └─ preload.ts       # contextBridge: openFileDialog(), onOpenFile()
├─ src/
│  ├─ main.ts          # entry — bootstraps Viewer, mounts UI modules
│  ├─ viewer.ts        # OBC.Components setup, camera, scene, IFC load/unload
│  ├─ ui/
│  │  ├─ toolbar.ts    # Open button, current filename, element count
│  │  ├─ dropzone.ts   # drag-drop handler, empty-state placeholder
│  │  ├─ categories.ts # left panel: classify by IfcClass, visibility toggles
│  │  ├─ properties.ts # right panel: selected element properties
│  │  └─ clipper.ts    # bottom-left clip toggle + height slider
│  └─ styles.css
├─ public/
│  └─ web-ifc.wasm
├─ index.html
├─ vite.config.ts
├─ electron-builder.json
├─ package.json
└─ tsconfig.json
```

## Components

Each unit has one purpose, a small interface, and minimal coupling. UI modules know about the viewer; viewer knows nothing about UI.

### `viewer.ts` — owns the 3D world

Wraps `@thatopen/components`. Exposes:

- `loadIfc(file: File | ArrayBuffer): Promise<void>` — unloads previous, parses new, fits camera
- `unloadIfc(): void`
- `getCategories(): Map<string, ElementId[]>` — IFC class → element IDs
- `setCategoryVisible(ifcClass: string, visible: boolean): void`
- `isolateCategory(ifcClass: string): void` — hide all others
- `getProperties(elementId: ElementId): Promise<IfcProperties>`
- `setClippingPlane(enabled: boolean, height?: number): void`
- Events: `onModelLoaded`, `onModelUnloaded`, `onSelection`, `onLoadProgress`

### `ui/dropzone.ts` — handles drop + empty state

Accepts `.ifc` files dropped anywhere on the window; full-window placeholder when no model loaded; rejects non-`.ifc` with toast. Calls `viewer.loadIfc(file)`.

### `ui/toolbar.ts` — top bar

Open button (calls `window.electron.openFileDialog()`), current filename, element count from `viewer.onModelLoaded`.

### `ui/categories.ts` — left panel

Subscribes to `onModelLoaded`, renders one row per IFC class with checkbox + "isolate" button.

### `ui/properties.ts` — right panel

Subscribes to `onSelection`, calls `viewer.getProperties(id)`, renders properties as collapsible groups (one per Pset).

### `ui/clipper.ts` — bottom-left

Toggle button + height slider; calls `viewer.setClippingPlane(enabled, height)`.

### `electron/main.ts`

Creates the `BrowserWindow`, registers `.ifc` file association, handles `open-file` events from the OS, exposes a file-open dialog over IPC. In dev: loads `http://localhost:5173`. In prod: loads `dist/index.html`.

### `electron/preload.ts`

`contextBridge.exposeInMainWorld("electron", { openFileDialog, onOpenFile })`.

## Data Flow

```
[OS double-click .ifc] ──┐
[drag-drop on window]  ──┼──► viewer.loadIfc()
[Open button → dialog]  ──┘        │
                                    ▼
                          web-ifc parses (WASM) → three.js meshes
                                    │
                                    ▼
              ┌─ onModelLoaded ─────┼─ onLoadProgress
              ▼                     ▼
       toolbar + categories    progress bar in toolbar

[user clicks mesh] ─► viewer raycasts ─► onSelection(elementId)
                                                 │
                                                 ▼
                                       properties.ts ─► viewer.getProperties()
                                                 ▼
                                            renders Psets
```

## Defaults / Conventions

- One model at a time. New drop replaces previous, no confirm.
- No size cap; show determinate progress.
- Highlight: orange outline, 3px.
- No persistence between launches.
- Dark theme.
- Camera: LMB orbit, RMB/Shift+LMB pan, wheel zoom, **F** fit-to-selection, **R** reset.

## Error Handling

- Non-`.ifc` drop → toast "Only .ifc files are supported", no state change.
- IFC parse error → toast with the parser's error message; previous model (if any) stays loaded.
- WASM load failure → blocking error screen with "Reload" button (this is a deployment bug, not a user error).

## Testing

Smoke-only:

1. App boots without errors (Electron main + renderer load).
2. Loads a tiny known-good IFC fixture and reports >0 elements.
3. Categories list is non-empty after load.

No UI snapshot tests, no per-component unit tests — the modules are thin enough that integration smoke covers them.

## Open Questions / Future

- macOS / Linux installers (currently Windows-only)
- Recent files menu
- Multi-model overlay
- Measuring tool
- IFC export of filtered subset
