# IFC Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local Electron desktop app that opens an `.ifc` file (drag-drop, file dialog, or OS double-click), renders the 3D building model, lets the user click elements to inspect IFC properties, toggle visibility per IFC class, and clip with a single horizontal plane.

**Architecture:** Electron shell with two processes. Main process owns the `BrowserWindow`, OS file dialog, and `.ifc` file association. Renderer is a Vite-built TypeScript SPA. The renderer's `viewer.ts` wraps `@thatopen/components` (which itself wraps `web-ifc` WASM + three.js); UI modules under `src/ui/` mount into named DOM containers and subscribe to viewer events. Files never leave the machine — IFC parsing happens in-renderer via WebAssembly.

**Tech Stack:** Node 20+, npm, TypeScript 5, Vite 5, Electron 31, electron-builder, `@thatopen/components` ^2.4, `@thatopen/components-front` ^2.4, `web-ifc` ^0.0.57, `three` (transitive). Windows-only installer.

**Important upstream-API caveat:** The `@thatopen/components` API has changed across the 2.x line. Code examples in this plan target the v2.4 surface (`components.get(Type)` registry, `OBC.Worlds`, `OBC.IfcLoader`, `OBC.Classifier`, `OBC.Hider`, `OBC.Clipper`, `OBF.Highlighter`). After `npm install`, **verify the actual exports** under `node_modules/@thatopen/components/dist` and `@thatopen/components-front/dist` and adjust imports / method names if the installed version has reorganized. Don't fight the lib — match what's there.

---

## File Structure

```
ifc-viewer/
├─ electron/
│  ├─ main.ts                 # BrowserWindow, dialog IPC, .ifc association
│  └─ preload.ts              # contextBridge: openFileDialog(), onOpenFile()
├─ src/
│  ├─ main.ts                 # entry: bootstraps Viewer, mounts UI modules
│  ├─ viewer.ts               # OBC.Components, world, IFC load/unload, events
│  ├─ events.ts               # tiny typed event emitter (used by viewer)
│  ├─ ui/
│  │  ├─ toolbar.ts           # Open button, filename, element count, progress
│  │  ├─ dropzone.ts          # window-wide drag-drop + empty-state placeholder
│  │  ├─ categories.ts        # left panel: visibility toggles per IfcClass
│  │  ├─ properties.ts        # right panel: selected element properties
│  │  ├─ clipper.ts           # bottom-left: clip toggle + height slider
│  │  └─ toast.ts             # transient error notifications
│  └─ styles.css              # all renderer styles (dark theme)
├─ public/
│  └─ web-ifc.wasm            # copied from node_modules postinstall
├─ scripts/
│  ├─ copy-wasm.mjs           # postinstall: copy web-ifc.wasm to public/
│  └─ dev.mjs                 # boots vite + electron together
├─ tests/
│  └─ smoke.spec.ts           # Playwright-electron: app boots, loads fixture
├─ test-fixtures/
│  └─ tiny.ifc                # smallest valid IFC for smoke
├─ index.html
├─ vite.config.ts
├─ tsconfig.json
├─ tsconfig.electron.json
├─ electron-builder.json
├─ package.json
├─ .gitignore
└─ README.md
```

---

## Task 0: Initialize repo and skeleton

**Files:**
- Create: `.gitignore`, `README.md`, `package.json`, `tsconfig.json`

- [ ] **Step 1: Init git**

```bash
git init
git config user.email "you@example.com"   # if not already global
git config user.name "Your Name"           # if not already global
```

- [ ] **Step 2: Write `.gitignore`**

Create `.gitignore`:

```
node_modules/
dist/
dist-electron/
release/
.vite/
*.log
.DS_Store
.superpowers/
```

- [ ] **Step 3: Write minimal `README.md`**

Create `README.md`:

````markdown
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
````

- [ ] **Step 4: Write `package.json`**

Create `package.json`:

```json
{
  "name": "ifc-viewer",
  "version": "0.1.0",
  "private": true,
  "main": "dist-electron/main.js",
  "scripts": {
    "postinstall": "node scripts/copy-wasm.mjs",
    "dev": "node scripts/dev.mjs",
    "build:renderer": "vite build",
    "build:electron": "tsc -p tsconfig.electron.json",
    "build": "npm run build:renderer && npm run build:electron",
    "dist": "npm run build && electron-builder",
    "test": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.45.0",
    "@types/node": "^20.12.0",
    "electron": "^31.0.0",
    "electron-builder": "^24.13.0",
    "playwright": "^1.45.0",
    "typescript": "^5.4.0",
    "vite": "^5.3.0"
  },
  "dependencies": {
    "@thatopen/components": "^2.4.0",
    "@thatopen/components-front": "^2.4.0",
    "three": "^0.160.0",
    "web-ifc": "^0.0.57"
  }
}
```

- [ ] **Step 5: Write root `tsconfig.json` (renderer)**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "index.html"]
}
```

- [ ] **Step 6: Commit**

```bash
git add .gitignore README.md package.json tsconfig.json
git commit -m "chore: initial repo skeleton"
```

---

## Task 1: Vite renderer that says "Hello"

**Files:**
- Create: `index.html`, `src/main.ts`, `src/styles.css`, `vite.config.ts`

- [ ] **Step 1: Write `vite.config.ts`**

Create `vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",                 // file:// load in packaged Electron
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
```

- [ ] **Step 2: Write `index.html`**

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>IFC Viewer</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="app">
      <div id="toolbar"></div>
      <div id="main">
        <div id="categories"></div>
        <div id="viewport">
          <div id="dropzone"></div>
          <div id="clipper"></div>
        </div>
        <div id="properties"></div>
      </div>
      <div id="toast-host"></div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Write `src/styles.css`**

Create `src/styles.css`:

```css
* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
body {
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  background: #0d1117;
  color: #c9d1d9;
  overflow: hidden;
}

#app {
  display: grid;
  grid-template-rows: 40px 1fr;
}

#toolbar {
  background: #161b22;
  border-bottom: 1px solid #30363d;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  font-size: 13px;
}

#main {
  display: grid;
  grid-template-columns: 220px 1fr 280px;
  min-height: 0;
}

#categories,
#properties {
  background: #161b22;
  border-right: 1px solid #30363d;
  overflow-y: auto;
  padding: 8px;
  font-size: 12px;
}

#properties {
  border-right: none;
  border-left: 1px solid #30363d;
}

#viewport {
  position: relative;
  background: #1a1f26;
  min-width: 0;
}

#viewport canvas { display: block; width: 100%; height: 100%; }

#dropzone {
  position: absolute; inset: 0;
  pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  color: #6e7681; font-size: 14px;
  border: 2px dashed transparent;
  transition: background 120ms, border-color 120ms;
}
#dropzone.empty { pointer-events: auto; }
#dropzone.dragover {
  background: rgba(255,165,0,0.06);
  border-color: rgba(255,165,0,0.5);
}

#clipper {
  position: absolute; bottom: 12px; left: 12px;
  background: rgba(22,27,34,0.92);
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  display: flex; align-items: center; gap: 8px;
}

#toast-host {
  position: fixed; bottom: 16px; right: 16px;
  display: flex; flex-direction: column; gap: 8px;
  z-index: 1000;
}
.toast {
  background: #21262d;
  border: 1px solid #30363d;
  border-left: 3px solid #f85149;
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 12px;
  max-width: 360px;
}
.toast.info { border-left-color: #58a6ff; }
```

- [ ] **Step 4: Write `src/main.ts`**

Create `src/main.ts`:

```ts
const dropzone = document.getElementById("dropzone")!;
dropzone.classList.add("empty");
dropzone.textContent = "Drop an .ifc file here, or click Open in the toolbar.";

const toolbar = document.getElementById("toolbar")!;
toolbar.textContent = "IFC Viewer";

console.log("renderer booted");
```

- [ ] **Step 5: Verify it runs in the browser**

```bash
npm install --no-audit --no-fund
npm run dev:vite-only 2>/dev/null || npx vite
```

Expected: Vite dev server prints `Local: http://localhost:5173/`. Open it in a browser and confirm the placeholder text appears in the viewport area, dark theme, three columns. Stop with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add index.html src/main.ts src/styles.css vite.config.ts
git commit -m "feat: scaffold renderer shell with three-pane dark layout"
```

---

## Task 2: Electron shell + dev orchestration

**Files:**
- Create: `electron/main.ts`, `electron/preload.ts`, `tsconfig.electron.json`, `scripts/dev.mjs`, `scripts/copy-wasm.mjs`

- [ ] **Step 1: Write `tsconfig.electron.json`**

Create `tsconfig.electron.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist-electron",
    "rootDir": "electron",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["electron"]
}
```

- [ ] **Step 2: Write `electron/main.ts`**

Create `electron/main.ts`:

```ts
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";

const isDev = !app.isPackaged;
let pendingOpenPath: string | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0d1117",
    title: "IFC Viewer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingOpenPath && mainWindow) {
      mainWindow.webContents.send("open-file", pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// Ensure single instance so a second double-click forwards the path to existing window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const ifc = argv.find((a) => a.toLowerCase().endsWith(".ifc"));
    if (ifc && mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send("open-file", ifc);
    }
  });

  // macOS open-file event
  app.on("open-file", (event, openPath) => {
    event.preventDefault();
    if (mainWindow) {
      mainWindow.webContents.send("open-file", openPath);
    } else {
      pendingOpenPath = openPath;
    }
  });

  app.whenReady().then(() => {
    // Windows: argv[1] may be the .ifc when double-clicked
    const ifc = process.argv.find((a) => a.toLowerCase().endsWith(".ifc"));
    if (ifc) pendingOpenPath = ifc;
    createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

ipcMain.handle("dialog:open-ifc", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open IFC",
    properties: ["openFile"],
    filters: [{ name: "IFC", extensions: ["ifc"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

- [ ] **Step 3: Write `electron/preload.ts`**

Create `electron/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:open-ifc"),
  onOpenFile: (handler: (filePath: string) => void) => {
    ipcRenderer.on("open-file", (_event, filePath: string) => handler(filePath));
  },
});

declare global {
  interface Window {
    electron: {
      openFileDialog: () => Promise<string | null>;
      onOpenFile: (handler: (filePath: string) => void) => void;
    };
  }
}
```

- [ ] **Step 4: Write `scripts/dev.mjs`**

Create `scripts/dev.mjs`:

```js
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const PORT = 5173;

function waitForPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = createConnection(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("vite never came up"));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

const vite = spawn(npx, ["vite"], { stdio: "inherit", shell: false });
const tsc = spawn(npx, ["tsc", "-p", "tsconfig.electron.json", "--watch"], {
  stdio: "inherit", shell: false,
});

await waitForPort(PORT);

// Give tsc one shot to produce dist-electron/main.js before launching electron
await new Promise((r) => setTimeout(r, 1500));

const electron = spawn(npx, ["electron", "."], { stdio: "inherit", shell: false });

const cleanup = () => {
  vite.kill(); tsc.kill(); electron.kill();
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
electron.on("exit", cleanup);
```

- [ ] **Step 5: Write `scripts/copy-wasm.mjs`**

Create `scripts/copy-wasm.mjs`:

```js
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = resolve(root, "node_modules/web-ifc/web-ifc.wasm");
const destDir = resolve(root, "public");
const dest = resolve(destDir, "web-ifc.wasm");

if (!existsSync(src)) {
  console.warn(`[copy-wasm] not found: ${src} — skipping (run after npm install)`);
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-wasm] copied -> ${dest}`);
```

- [ ] **Step 6: Update `electron-builder` file association in `package.json`**

Add this top-level entry to `package.json` (between `"main"` and `"scripts"`):

```json
"build": {
  "appId": "com.example.ifcviewer",
  "productName": "IFC Viewer",
  "files": ["dist/**", "dist-electron/**", "package.json"],
  "extraResources": ["public/web-ifc.wasm"],
  "win": {
    "target": "nsis",
    "fileAssociations": [
      { "ext": "ifc", "name": "IFC Model", "role": "Viewer" }
    ]
  },
  "directories": { "output": "release" }
},
```

- [ ] **Step 7: Run dev script and verify Electron window opens**

```bash
npm run dev
```

Expected: Vite logs `Local: http://localhost:5173/`, tsc logs `Found 0 errors`, then an Electron window opens showing the same dark three-pane layout from Task 1, plus a detached DevTools window. Console of the renderer says `renderer booted`. Close the window to exit.

If it fails: check `dist-electron/main.js` exists; check the renderer console for IPC errors.

- [ ] **Step 8: Commit**

```bash
git add electron/ scripts/ tsconfig.electron.json package.json
git commit -m "feat: electron shell with dev orchestration and file association"
```

---

## Task 3: Wire up `@thatopen/components` — empty world renders

**Files:**
- Create: `src/events.ts`, `src/viewer.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Install dependencies**

```bash
npm install
```

This also runs `postinstall` which copies `web-ifc.wasm` to `public/`. Verify:

```bash
ls public/web-ifc.wasm
```

Expected: file exists, ~5–10 MB.

- [ ] **Step 2: Write `src/events.ts`**

Create `src/events.ts`:

```ts
export class Emitter<T> {
  private handlers = new Set<(value: T) => void>();
  on(handler: (value: T) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(value: T): void {
    for (const h of this.handlers) h(value);
  }
}
```

- [ ] **Step 3: Write `src/viewer.ts` — minimal world bootstrap**

Create `src/viewer.ts`:

```ts
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as THREE from "three";
import { Emitter } from "./events";

export type ElementId = number;

export interface ModelLoaded {
  filename: string;
  elementCount: number;
  categories: ReadonlyMap<string, ElementId[]>;
}

export interface LoadProgress {
  loaded: number;          // bytes parsed (approximate)
  total: number;           // bytes total (0 = indeterminate)
}

export interface Selection {
  fragmentId: string;
  expressId: ElementId;
}

export class Viewer {
  readonly onModelLoaded = new Emitter<ModelLoaded>();
  readonly onModelUnloaded = new Emitter<void>();
  readonly onSelection = new Emitter<Selection | null>();
  readonly onLoadProgress = new Emitter<LoadProgress>();

  private components!: OBC.Components;
  private world!: OBC.World;
  private currentModelId: string | null = null;

  async init(container: HTMLElement): Promise<void> {
    const components = new OBC.Components();
    const worlds = components.get(OBC.Worlds);

    const world = worlds.create<
      OBC.SimpleScene,
      OBC.SimpleCamera,
      OBC.SimpleRenderer
    >();

    world.scene = new OBC.SimpleScene(components);
    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.SimpleCamera(components);
    world.scene.setup();

    components.init();

    world.scene.three.background = new THREE.Color("#1a1f26");
    world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0);

    const grids = components.get(OBC.Grids);
    grids.create(world);

    this.components = components;
    this.world = world;
  }

  async loadIfc(_file: File | ArrayBuffer, _filename = "model.ifc"): Promise<void> {
    throw new Error("not implemented yet — Task 4");
  }

  unloadIfc(): void {
    if (!this.currentModelId) return;
    // implemented in Task 4
    this.currentModelId = null;
    this.onModelUnloaded.emit();
  }

  // exposed for later tasks
  _internals() {
    return { components: this.components, world: this.world };
  }
}
```

- [ ] **Step 4: Update `src/main.ts` to mount the viewer**

Replace `src/main.ts` with:

```ts
import { Viewer } from "./viewer";

const viewport = document.getElementById("viewport")!;
const dropzone = document.getElementById("dropzone")!;
const toolbar = document.getElementById("toolbar")!;

dropzone.classList.add("empty");
dropzone.textContent = "Drop an .ifc file here, or click Open in the toolbar.";
toolbar.textContent = "IFC Viewer";

const viewer = new Viewer();
viewer.init(viewport).then(() => {
  console.log("viewer initialized");
});

(window as any).__viewer = viewer;
```

- [ ] **Step 5: Run and verify**

```bash
npm run dev
```

Expected: Electron window shows the dark layout, the viewport now contains a 3D grid with axes; you can orbit/pan with the mouse. The drop placeholder text overlays the grid. Renderer console shows `viewer initialized`. No errors.

If `@thatopen/components` exports differ from the example (e.g. `OBC.Worlds` not found, `setup()` signature changed): open `node_modules/@thatopen/components/dist/index.d.ts` and adapt. Common alternates seen across versions: `world.scene.setup()` may be a no-op or absent; `components.init()` may be `await components.init()`; `Worlds` may be under a different key. Match what's actually in the package.

- [ ] **Step 6: Commit**

```bash
git add src/events.ts src/viewer.ts src/main.ts
git commit -m "feat: bootstrap @thatopen/components world with grid"
```

---

## Task 4: IFC loader + drag-drop

**Files:**
- Modify: `src/viewer.ts`
- Create: `src/ui/dropzone.ts`, `src/ui/toast.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add toast helper — `src/ui/toast.ts`**

Create `src/ui/toast.ts`:

```ts
export function toast(message: string, kind: "error" | "info" = "error", ms = 4000): void {
  const host = document.getElementById("toast-host")!;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
```

- [ ] **Step 2: Implement `loadIfc` in `src/viewer.ts`**

Replace the body of `loadIfc` and `unloadIfc` in `src/viewer.ts`. Also add the import for `OBC.IfcLoader` and `OBC.Classifier` and a private `currentFragments` field.

Full updated `src/viewer.ts`:

```ts
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as THREE from "three";
import * as FRAGS from "@thatopen/fragments";
import { Emitter } from "./events";

export type ElementId = number;

export interface ModelLoaded {
  filename: string;
  elementCount: number;
  categories: ReadonlyMap<string, ElementId[]>;
}

export interface LoadProgress { loaded: number; total: number; }
export interface Selection { fragmentId: string; expressId: ElementId; }

export class Viewer {
  readonly onModelLoaded = new Emitter<ModelLoaded>();
  readonly onModelUnloaded = new Emitter<void>();
  readonly onSelection = new Emitter<Selection | null>();
  readonly onLoadProgress = new Emitter<LoadProgress>();

  private components!: OBC.Components;
  private world!: OBC.World;
  private ifcLoader!: OBC.IfcLoader;
  private fragmentsManager!: OBC.FragmentsManager;
  private classifier!: OBC.Classifier;
  private currentModel: FRAGS.FragmentsGroup | null = null;
  private currentCategories = new Map<string, ElementId[]>();
  private currentFilename = "";

  async init(container: HTMLElement): Promise<void> {
    const components = new OBC.Components();
    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();
    world.scene = new OBC.SimpleScene(components);
    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.SimpleCamera(components);
    world.scene.setup();
    components.init();

    world.scene.three.background = new THREE.Color("#1a1f26");
    world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0);

    const grids = components.get(OBC.Grids);
    grids.create(world);

    const ifcLoader = components.get(OBC.IfcLoader);
    await ifcLoader.setup({
      wasm: { path: "./", absolute: false },
    });

    this.fragmentsManager = components.get(OBC.FragmentsManager);
    this.classifier = components.get(OBC.Classifier);

    this.components = components;
    this.world = world;
    this.ifcLoader = ifcLoader;
  }

  async loadIfc(input: File | ArrayBuffer, filename?: string): Promise<void> {
    const name = filename ?? (input instanceof File ? input.name : "model.ifc");
    const buffer = input instanceof File
      ? new Uint8Array(await input.arrayBuffer())
      : new Uint8Array(input);

    this.onLoadProgress.emit({ loaded: 0, total: buffer.byteLength });

    // Parse FIRST. Only unload the previous model on success — spec requires the
    // previous model to stay visible if the new file fails to parse.
    let model: FRAGS.FragmentsGroup;
    try {
      model = await this.ifcLoader.load(buffer);
    } catch (err) {
      this.onLoadProgress.emit({ loaded: buffer.byteLength, total: buffer.byteLength });
      throw new Error(`IFC parse failed: ${(err as Error).message}`);
    }

    if (this.currentModel) this.unloadIfc();

    this.world.scene.three.add(model);
    this.currentModel = model;
    this.currentFilename = name;

    this.onLoadProgress.emit({
      loaded: buffer.byteLength,
      total: buffer.byteLength,
    });

    // Classify by IFC entity (class). After this, classifier.list.entities has the buckets.
    this.classifier.byEntity(model);
    const categories = new Map<string, ElementId[]>();
    const entities = (this.classifier.list as any).entities ?? {};
    for (const [ifcClass, group] of Object.entries(entities)) {
      const ids: ElementId[] = [];
      for (const fragId of Object.keys((group as any).map ?? {})) {
        for (const expressId of (group as any).map[fragId]) {
          ids.push(expressId as ElementId);
        }
      }
      categories.set(ifcClass, ids);
    }
    this.currentCategories = categories;

    // Fit camera to model bounds
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    await this.world.camera.controls.fitToBox(box, true, {
      paddingTop: size * 0.1, paddingBottom: size * 0.1,
      paddingLeft: size * 0.1, paddingRight: size * 0.1,
    } as any).catch(() => {
      // older versions: just reposition
      this.world.camera.controls.setLookAt(
        center.x + size, center.y + size, center.z + size,
        center.x, center.y, center.z, true,
      );
    });

    let elementCount = 0;
    for (const ids of categories.values()) elementCount += ids.length;

    this.onModelLoaded.emit({
      filename: name,
      elementCount,
      categories,
    });
  }

  unloadIfc(): void {
    if (!this.currentModel) return;
    this.world.scene.three.remove(this.currentModel);
    this.fragmentsManager.disposeGroup(this.currentModel);
    this.currentModel = null;
    this.currentCategories.clear();
    this.currentFilename = "";
    this.onModelUnloaded.emit();
  }

  getCategories(): ReadonlyMap<string, ElementId[]> {
    return this.currentCategories;
  }

  getCurrentModel(): FRAGS.FragmentsGroup | null { return this.currentModel; }
  getCurrentFilename(): string { return this.currentFilename; }
  _internals() { return { components: this.components, world: this.world, classifier: this.classifier }; }
}
```

If `@thatopen/fragments` is not already pulled in transitively, install it:

```bash
npm install @thatopen/fragments
```

If `ifcLoader.setup({ wasm: { path: "./", absolute: false } })` rejects because the API differs, look at the loader's d.ts file: in some versions the path option is just `wasm: "./"`, in others it's `wasmPath`. Match the installed package.

- [ ] **Step 3: Implement `src/ui/dropzone.ts`**

Create `src/ui/dropzone.ts`:

```ts
import type { Viewer } from "../viewer";
import { toast } from "./toast";

export function mountDropzone(viewer: Viewer): void {
  const root = document.getElementById("app")!;
  const placeholder = document.getElementById("dropzone")!;

  placeholder.classList.add("empty");
  placeholder.textContent = "Drop an .ifc file here, or click Open in the toolbar.";

  viewer.onModelLoaded.on(() => placeholder.classList.remove("empty"));
  viewer.onModelUnloaded.on(() => {
    placeholder.classList.add("empty");
    placeholder.textContent = "Drop an .ifc file here, or click Open in the toolbar.";
  });

  const stop = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); };

  root.addEventListener("dragenter", (e) => { stop(e); placeholder.classList.add("dragover"); });
  root.addEventListener("dragover",  (e) => { stop(e); placeholder.classList.add("dragover"); });
  root.addEventListener("dragleave", (e) => {
    stop(e);
    if (e.target === root) placeholder.classList.remove("dragover");
  });
  root.addEventListener("drop", async (e) => {
    stop(e);
    placeholder.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".ifc")) {
      toast("Only .ifc files are supported");
      return;
    }
    try {
      await viewer.loadIfc(file);
    } catch (err) {
      toast((err as Error).message);
    }
  });
}
```

- [ ] **Step 4: Update `src/main.ts`**

Replace `src/main.ts`:

```ts
import { Viewer } from "./viewer";
import { mountDropzone } from "./ui/dropzone";

const viewport = document.getElementById("viewport")!;
const toolbar = document.getElementById("toolbar")!;
toolbar.textContent = "IFC Viewer";

const viewer = new Viewer();

viewer.init(viewport).then(() => {
  mountDropzone(viewer);
  console.log("viewer ready");
});

(window as any).__viewer = viewer;
```

- [ ] **Step 5: Run and verify with a real IFC**

```bash
npm run dev
```

Expected: window opens, grid visible. Drag any `.ifc` file from your filesystem onto the window. The placeholder hides; the model appears centered in the viewport; you can orbit around it. Renderer console shows no errors. Test with a non-IFC file (e.g. a `.txt`) — toast appears, no crash.

You can grab a free sample IFC from: https://github.com/IFCjs/test-ifc-files (e.g., `Schependomlaan.ifc` is a small house, ~3 MB).

- [ ] **Step 6: Commit**

```bash
git add src/viewer.ts src/ui/dropzone.ts src/ui/toast.ts src/main.ts package.json package-lock.json
git commit -m "feat: load IFC via drag-drop with categorization and camera fit"
```

---

## Task 5: Toolbar — Open dialog, filename, element count, progress

**Files:**
- Create: `src/ui/toolbar.ts`
- Modify: `src/main.ts`, `index.html`

- [ ] **Step 1: Update toolbar markup in `index.html`**

Find `<div id="toolbar"></div>` and replace with:

```html
<div id="toolbar">
  <button id="open-btn">Open IFC…</button>
  <span id="model-name" class="muted">no model loaded</span>
  <span id="model-count"></span>
  <div id="progress" class="hidden"><div id="progress-bar"></div></div>
</div>
```

Append these classes to `src/styles.css`:

```css
#toolbar button {
  background: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
#toolbar button:hover { background: #30363d; }
.muted { color: #6e7681; }
#progress {
  flex: 1; max-width: 240px;
  height: 6px;
  background: #21262d;
  border-radius: 3px;
  overflow: hidden;
}
#progress.hidden { visibility: hidden; }
#progress-bar {
  height: 100%; width: 0%;
  background: #f0883e;
  transition: width 100ms linear;
}
```

- [ ] **Step 2: Implement `src/ui/toolbar.ts`**

Create `src/ui/toolbar.ts`:

```ts
import type { Viewer } from "../viewer";
import { toast } from "./toast";

export function mountToolbar(viewer: Viewer): void {
  const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
  const nameEl  = document.getElementById("model-name")!;
  const countEl = document.getElementById("model-count")!;
  const progress    = document.getElementById("progress")!;
  const progressBar = document.getElementById("progress-bar") as HTMLElement;

  openBtn.addEventListener("click", async () => {
    const filePath = await window.electron.openFileDialog();
    if (!filePath) return;
    await loadFromPath(viewer, filePath);
  });

  // For OS double-click / second-instance forwarding
  window.electron.onOpenFile(async (filePath) => {
    await loadFromPath(viewer, filePath);
  });

  viewer.onLoadProgress.on(({ loaded, total }) => {
    progress.classList.remove("hidden");
    const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    if (loaded >= total && total > 0) {
      setTimeout(() => progress.classList.add("hidden"), 400);
    }
  });

  viewer.onModelLoaded.on(({ filename, elementCount }) => {
    nameEl.textContent = filename;
    nameEl.classList.remove("muted");
    countEl.textContent = `· ${elementCount} elements`;
  });

  viewer.onModelUnloaded.on(() => {
    nameEl.textContent = "no model loaded";
    nameEl.classList.add("muted");
    countEl.textContent = "";
  });
}

async function loadFromPath(viewer: Viewer, filePath: string): Promise<void> {
  try {
    // The renderer can't fs.readFile directly; fetch via file:// works in Electron.
    const url = "file:///" + filePath.replace(/\\/g, "/");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`could not read ${filePath}`);
    const buf = await resp.arrayBuffer();
    const filename = filePath.split(/[\\/]/).pop() ?? "model.ifc";
    await viewer.loadIfc(buf, filename);
  } catch (err) {
    toast((err as Error).message);
  }
}
```

If `fetch("file:///…")` is blocked in the renderer (Electron sometimes restricts this depending on `webPreferences`), fall back to reading on the main process: add an IPC handler `ipcMain.handle("read-file", (_e, p) => fs.promises.readFile(p))` in `electron/main.ts`, expose it via `preload.ts`, and call `window.electron.readFile(filePath)` here. Pick whichever works in dev — note the actual path in a comment.

- [ ] **Step 3: Update `src/main.ts`**

Replace:

```ts
import { Viewer } from "./viewer";
import { mountDropzone } from "./ui/dropzone";
import { mountToolbar } from "./ui/toolbar";

const viewport = document.getElementById("viewport")!;
const viewer = new Viewer();

viewer.init(viewport).then(() => {
  mountDropzone(viewer);
  mountToolbar(viewer);
  console.log("viewer ready");
});

(window as any).__viewer = viewer;
```

- [ ] **Step 4: Run and verify**

```bash
npm run dev
```

Expected: Toolbar shows `[Open IFC…] no model loaded`. Click Open, select an IFC — file loads, name + element count appear, progress bar fills then hides. Drag-drop a different IFC — replaces previous model, name updates. Close + relaunch via OS double-click on `.ifc` (only meaningful after `npm run dist` packaging — for now just verify the click + dialog path).

- [ ] **Step 5: Commit**

```bash
git add src/ui/toolbar.ts src/main.ts index.html src/styles.css
git commit -m "feat: toolbar with open dialog, filename, count, progress"
```

---

## Task 6: Properties panel — click to inspect

**Files:**
- Modify: `src/viewer.ts` (add highlighter + selection)
- Create: `src/ui/properties.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add highlighter + properties API in `src/viewer.ts`**

Add a new private field, init code, and methods. Inside the `Viewer` class:

Add field near other privates:

```ts
private highlighter!: OBF.Highlighter;
private indexer!: OBC.IfcRelationsIndexer;
```

In `init()`, after `components.init()` and before the grids line, add:

```ts
const highlighter = components.get(OBF.Highlighter);
highlighter.setup({
  world: this.world ?? world,
  selectionColor: new THREE.Color("#f0883e"),  // orange, per spec
});
highlighter.zoomToSelection = false;
// Some versions ignore selectionColor in setup() — set on the colors map too:
(highlighter as any).colors?.set?.("select", new THREE.Color("#f0883e"));

highlighter.events.select.onHighlight.add((selection) => {
  // selection is { [fragmentId]: Set<expressId> }
  const fragId = Object.keys(selection)[0];
  if (!fragId) return;
  const ids = selection[fragId];
  const expressId = ids.values().next().value as number | undefined;
  if (expressId === undefined) return;
  this.onSelection.emit({ fragmentId: fragId, expressId });
});
highlighter.events.select.onClear.add(() => this.onSelection.emit(null));

this.highlighter = highlighter;
this.indexer = components.get(OBC.IfcRelationsIndexer);
```

Add a `getProperties` method:

```ts
async getProperties(expressId: ElementId): Promise<Record<string, unknown> | null> {
  if (!this.currentModel) return null;
  const props = await this.currentModel.getProperties(expressId);
  return (props as unknown as Record<string, unknown>) ?? null;
}

async getPropertySets(expressId: ElementId): Promise<Array<{ name: string; props: Record<string, unknown> }>> {
  if (!this.currentModel) return [];
  // Build the relations index once per model
  await this.indexer.process(this.currentModel);
  const psetIds = this.indexer.getEntityRelations(this.currentModel, expressId, "IsDefinedBy") ?? [];
  const out: Array<{ name: string; props: Record<string, unknown> }> = [];
  for (const id of psetIds) {
    const pset = await this.currentModel.getProperties(id) as any;
    if (!pset) continue;
    const name = pset.Name?.value ?? `Pset_${id}`;
    const props: Record<string, unknown> = {};
    if (Array.isArray(pset.HasProperties)) {
      for (const p of pset.HasProperties) {
        const single = await this.currentModel.getProperties(p.value) as any;
        if (single?.Name?.value) {
          props[single.Name.value] = single.NominalValue?.value ?? null;
        }
      }
    }
    out.push({ name, props });
  }
  return out;
}
```

After loading the model in `loadIfc`, also call `this.highlighter.update()` if the version requires it (check d.ts; many versions auto-track new fragments).

- [ ] **Step 2: Implement `src/ui/properties.ts`**

Create `src/ui/properties.ts`:

```ts
import type { Viewer } from "../viewer";

export function mountProperties(viewer: Viewer): void {
  const root = document.getElementById("properties")!;
  reset();

  viewer.onModelUnloaded.on(reset);

  viewer.onSelection.on(async (sel) => {
    if (!sel) { reset(); return; }
    root.innerHTML = `<div class="muted">loading…</div>`;
    const direct = await viewer.getProperties(sel.expressId);
    const psets = await viewer.getPropertySets(sel.expressId);
    root.innerHTML = "";
    root.appendChild(renderHeader(sel.expressId, direct));
    root.appendChild(renderDirect(direct));
    for (const pset of psets) root.appendChild(renderPset(pset));
  });

  function reset() {
    root.innerHTML = `<div class="muted" style="padding:8px">Click an element to inspect.</div>`;
  }
}

function renderHeader(expressId: number, direct: Record<string, unknown> | null): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "padding:8px;border-bottom:1px solid #30363d;margin-bottom:6px";
  const type = (direct as any)?.constructor?.name ?? (direct as any)?.type ?? "Element";
  const name = (direct as any)?.Name?.value ?? "(unnamed)";
  el.innerHTML = `<div style="color:#c9d1d9;font-weight:600">${escape(String(name))}</div>
                  <div class="muted">#${expressId} · ${escape(String(type))}</div>`;
  return el;
}

function renderDirect(direct: Record<string, unknown> | null): HTMLElement {
  const el = document.createElement("details");
  el.open = true;
  el.innerHTML = `<summary>Attributes</summary>`;
  const body = document.createElement("div");
  body.style.cssText = "padding:4px 12px";
  if (direct) {
    for (const [k, v] of Object.entries(direct)) {
      if (k === "expressID" || k === "type") continue;
      const val = (v as any)?.value ?? v;
      if (val === null || typeof val === "object") continue;
      body.appendChild(row(k, String(val)));
    }
  }
  el.appendChild(body);
  return el;
}

function renderPset(pset: { name: string; props: Record<string, unknown> }): HTMLElement {
  const el = document.createElement("details");
  el.innerHTML = `<summary>${escape(pset.name)}</summary>`;
  const body = document.createElement("div");
  body.style.cssText = "padding:4px 12px";
  for (const [k, v] of Object.entries(pset.props)) {
    body.appendChild(row(k, v == null ? "—" : String(v)));
  }
  el.appendChild(body);
  return el;
}

function row(k: string, v: string): HTMLElement {
  const r = document.createElement("div");
  r.style.cssText = "display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-size:11px";
  r.innerHTML = `<span class="muted">${escape(k)}</span><span style="color:#c9d1d9;text-align:right">${escape(v)}</span>`;
  return r;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
```

Append to `src/styles.css`:

```css
#properties details {
  border: 1px solid #30363d;
  border-radius: 4px;
  margin-bottom: 6px;
  background: #0d1117;
}
#properties summary {
  padding: 6px 8px;
  cursor: pointer;
  font-weight: 600;
  font-size: 12px;
  color: #c9d1d9;
}
```

- [ ] **Step 3: Mount in `src/main.ts`**

Add the import and call:

```ts
import { mountProperties } from "./ui/properties";
// inside .then(() => { ... }) after mountToolbar:
mountProperties(viewer);
```

- [ ] **Step 4: Run and verify**

```bash
npm run dev
```

Expected: Load an IFC. Click an element in the 3D view. The element gets a colored outline; the right panel shows its name, ID, type, attributes, and property sets in collapsible sections. Click empty space → panel returns to "Click an element to inspect."

If `getEntityRelations` or property-set traversal looks empty for elements that should have psets, log the raw `pset` object — IFC's relation graph varies by exporter and the helper API may use a different relation name like `HasPropertySets` or `RelDefinesByProperties`.

- [ ] **Step 5: Commit**

```bash
git add src/viewer.ts src/ui/properties.ts src/main.ts src/styles.css
git commit -m "feat: click selection with properties + psets panel"
```

---

## Task 7: Categories panel — visibility toggles + isolate

**Files:**
- Modify: `src/viewer.ts` (add Hider helpers)
- Create: `src/ui/categories.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add Hider helpers in `src/viewer.ts`**

Add a private field:

```ts
private hider!: OBC.Hider;
```

In `init()` add:

```ts
this.hider = components.get(OBC.Hider);
```

Add public methods:

```ts
setCategoryVisible(ifcClass: string, visible: boolean): void {
  if (!this.currentModel) return;
  const ids = this.currentCategories.get(ifcClass);
  if (!ids) return;
  // Hider expects a map of fragmentId -> Set<expressId>; use classifier to build it.
  const found = (this.classifier.find as any)({ entities: [ifcClass] });
  this.hider.set(visible, found);
}

isolateCategory(ifcClass: string): void {
  for (const c of this.currentCategories.keys()) {
    this.setCategoryVisible(c, c === ifcClass);
  }
}

showAllCategories(): void {
  for (const c of this.currentCategories.keys()) {
    this.setCategoryVisible(c, true);
  }
}
```

(The `classifier.find` API name varies — alternates: `classifier.get`, `classifier.byEntity` returns a query-able structure. Inspect `node_modules/@thatopen/components/dist/classifier.d.ts` to confirm.)

- [ ] **Step 2: Implement `src/ui/categories.ts`**

Create `src/ui/categories.ts`:

```ts
import type { Viewer } from "../viewer";

export function mountCategories(viewer: Viewer): void {
  const root = document.getElementById("categories")!;
  reset();

  viewer.onModelUnloaded.on(reset);

  viewer.onModelLoaded.on(({ categories }) => {
    root.innerHTML = "";
    const header = document.createElement("div");
    header.innerHTML = `<div style="padding:6px 4px;display:flex;justify-content:space-between;align-items:center">
      <strong>Categories</strong>
      <button id="cat-show-all" class="mini">show all</button>
    </div>`;
    root.appendChild(header);
    header.querySelector<HTMLButtonElement>("#cat-show-all")!
      .addEventListener("click", () => {
        viewer.showAllCategories();
        for (const cb of root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) cb.checked = true;
      });

    const sorted = [...categories.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [name, ids] of sorted) {
      root.appendChild(renderRow(viewer, name, ids.length));
    }
  });

  function reset() {
    root.innerHTML = `<div class="muted" style="padding:8px">Load an IFC to see categories.</div>`;
  }
}

function renderRow(viewer: Viewer, name: string, count: number): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:11px";
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = true;
  cb.addEventListener("change", () => viewer.setCategoryVisible(name, cb.checked));

  const label = document.createElement("span");
  label.textContent = `${name} (${count})`;
  label.style.cssText = "flex:1;color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

  const isoBtn = document.createElement("button");
  isoBtn.className = "mini"; isoBtn.textContent = "iso";
  isoBtn.title = "Isolate (hide all others)";
  isoBtn.addEventListener("click", () => {
    viewer.isolateCategory(name);
    const all = row.parentElement!.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    for (const x of all) x.checked = false;
    cb.checked = true;
  });

  row.append(cb, label, isoBtn);
  return row;
}
```

Append to `src/styles.css`:

```css
button.mini {
  background: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  cursor: pointer;
}
button.mini:hover { background: #30363d; }
```

- [ ] **Step 3: Mount in `src/main.ts`**

```ts
import { mountCategories } from "./ui/categories";
// inside .then() ... :
mountCategories(viewer);
```

- [ ] **Step 4: Run and verify**

```bash
npm run dev
```

Expected: Load IFC. Left panel shows a sorted list like `IfcWallStandardCase (42)`, `IfcWindow (24)`, …. Uncheck `IfcWindow` → windows disappear. Click `iso` next to `IfcSlab` → only slabs visible, all checkboxes flip off except IfcSlab. Click "show all" → everything reappears.

- [ ] **Step 5: Commit**

```bash
git add src/viewer.ts src/ui/categories.ts src/main.ts src/styles.css
git commit -m "feat: categories panel with per-class visibility and isolate"
```

---

## Task 8: Clipper — single horizontal section plane

**Files:**
- Modify: `src/viewer.ts` (Clipper integration)
- Create: `src/ui/clipper.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add clipper API in `src/viewer.ts`**

Add fields:

```ts
private clipper!: OBC.Clipper;
private clipPlane: any = null;   // type from OBC, kept loose
```

In `init()`:

```ts
this.clipper = components.get(OBC.Clipper);
this.clipper.enabled = false;
```

Public method:

```ts
setClippingPlane(enabled: boolean, height = 0): void {
  if (!enabled) {
    this.clipper.deleteAll();
    this.clipPlane = null;
    this.clipper.enabled = false;
    return;
  }
  this.clipper.enabled = true;
  if (!this.clipPlane) {
    // Create a plane at world Y = height, normal = +Y (cuts off above)
    const normal = new (window as any).THREE.Vector3?.(0, 1, 0)
      ?? new (require("three") as any).Vector3(0, 1, 0);
    const point  = new (window as any).THREE.Vector3?.(0, height, 0)
      ?? new (require("three") as any).Vector3(0, height, 0);
    this.clipPlane = this.clipper.createFromNormalAndCoplanarPoint(this.world, normal, point);
  } else {
    // Move existing plane: most versions expose plane.three.constant or a setter
    const three = this.clipPlane.three ?? this.clipPlane;
    if (three.constant !== undefined) three.constant = -height;
  }
}

getModelHeightRange(): { min: number; max: number } | null {
  if (!this.currentModel) return null;
  const box = new (require("three") as any).Box3().setFromObject(this.currentModel);
  return { min: box.min.y, max: box.max.y };
}
```

If the dynamic `require("three")` upsets the TS strict mode, just `import * as THREE from "three";` at the top (already done) and use `new THREE.Vector3(...)` / `new THREE.Box3()` directly.

- [ ] **Step 2: Implement `src/ui/clipper.ts`**

Create `src/ui/clipper.ts`:

```ts
import type { Viewer } from "../viewer";

export function mountClipper(viewer: Viewer): void {
  const root = document.getElementById("clipper")!;
  root.style.display = "none";

  let enabled = false;
  let min = 0, max = 1;

  viewer.onModelLoaded.on(() => {
    const r = viewer.getModelHeightRange();
    if (!r) return;
    min = r.min; max = r.max;
    root.style.display = "flex";
    render();
  });
  viewer.onModelUnloaded.on(() => {
    root.style.display = "none";
    enabled = false;
    viewer.setClippingPlane(false);
  });

  function render() {
    root.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "mini";
    btn.textContent = enabled ? "Clip: ON" : "Clip: OFF";
    btn.addEventListener("click", () => {
      enabled = !enabled;
      viewer.setClippingPlane(enabled, (min + max) / 2);
      render();
    });
    root.appendChild(btn);

    if (enabled) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(min); slider.max = String(max);
      slider.step = String((max - min) / 200);
      slider.value = String((min + max) / 2);
      slider.style.width = "180px";
      slider.addEventListener("input", () => {
        viewer.setClippingPlane(true, parseFloat(slider.value));
      });
      root.appendChild(slider);
    }
  }
}
```

- [ ] **Step 3: Mount in `src/main.ts`**

```ts
import { mountClipper } from "./ui/clipper";
// inside .then() ... :
mountClipper(viewer);
```

- [ ] **Step 4: Run and verify**

```bash
npm run dev
```

Expected: Load IFC. Bottom-left shows `Clip: OFF`. Click → toggles to `Clip: ON`, a slider appears, plane sits mid-height of the model, you can see roof + floors above are clipped away. Drag the slider — clip plane moves up/down. Click button again → plane disappears. Unload model (drop a different one) → control hides while loading.

- [ ] **Step 5: Commit**

```bash
git add src/viewer.ts src/ui/clipper.ts src/main.ts
git commit -m "feat: horizontal section plane with height slider"
```

---

## Task 8b: Camera keybindings — F (fit-to-selection) and R (reset)

**Files:**
- Modify: `src/viewer.ts` (add `fitToSelection`, `resetCamera`, track last selection)
- Create: `src/ui/keybindings.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Track last selection + add camera methods in `src/viewer.ts`**

Add a private field:

```ts
private lastSelection: Selection | null = null;
```

In the highlighter `onHighlight` handler, after emitting the selection, also store it:

```ts
this.lastSelection = { fragmentId: fragId, expressId };
this.onSelection.emit(this.lastSelection);
```

In `onClear`:

```ts
this.lastSelection = null;
this.onSelection.emit(null);
```

Add public methods:

```ts
async fitToSelection(): Promise<void> {
  if (!this.currentModel) return;
  if (!this.lastSelection) {
    // No selection — fit whole model
    const box = new THREE.Box3().setFromObject(this.currentModel);
    await this.world.camera.controls.fitToBox(box, true).catch(() => {});
    return;
  }
  // Find the fragment mesh and box its selected element
  const fragments = this.fragmentsManager.list.get(this.lastSelection.fragmentId);
  if (!fragments) return;
  const box = new THREE.Box3().setFromObject((fragments as any).mesh ?? fragments);
  await this.world.camera.controls.fitToBox(box, true).catch(() => {});
}

resetCamera(): void {
  if (this.currentModel) {
    const box = new THREE.Box3().setFromObject(this.currentModel);
    this.world.camera.controls.fitToBox(box, true).catch(() => {});
  } else {
    this.world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0, true);
  }
}
```

- [ ] **Step 2: Implement `src/ui/keybindings.ts`**

Create `src/ui/keybindings.ts`:

```ts
import type { Viewer } from "../viewer";

export function mountKeybindings(viewer: Viewer): void {
  window.addEventListener("keydown", (e) => {
    // Ignore when typing in an input/textarea
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      void viewer.fitToSelection();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      viewer.resetCamera();
    }
  });
}
```

- [ ] **Step 3: Mount in `src/main.ts`**

```ts
import { mountKeybindings } from "./ui/keybindings";
// inside the async block after mountClipper:
mountKeybindings(viewer);
```

- [ ] **Step 4: Run and verify**

```bash
npm run dev
```

Expected: Load IFC. Click an element. Press **F** → camera flies to frame just that element. Press **R** → camera frames the whole model. Click a different element, press F → camera moves to that one. With nothing selected, F still fits the whole model.

- [ ] **Step 5: Commit**

```bash
git add src/viewer.ts src/ui/keybindings.ts src/main.ts
git commit -m "feat: F (fit-to-selection) and R (reset) camera keybindings"
```

---

## Task 9: WASM-fail blocking screen

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Wrap viewer init in try/catch**

Update `src/main.ts` to handle init failure (the WASM might 404 or fail to instantiate):

```ts
import { Viewer } from "./viewer";
import { mountDropzone } from "./ui/dropzone";
import { mountToolbar } from "./ui/toolbar";
import { mountProperties } from "./ui/properties";
import { mountCategories } from "./ui/categories";
import { mountClipper } from "./ui/clipper";

const viewport = document.getElementById("viewport")!;
const viewer = new Viewer();

(async () => {
  try {
    await viewer.init(viewport);
  } catch (err) {
    document.body.innerHTML = `
      <div style="padding:48px;text-align:center;color:#c9d1d9;background:#0d1117;height:100vh">
        <h1 style="color:#f85149">3D engine failed to initialize</h1>
        <p style="color:#8b949e">${escape((err as Error).message)}</p>
        <p style="color:#8b949e">This usually means <code>web-ifc.wasm</code> didn't load. Check that <code>public/web-ifc.wasm</code> exists.</p>
        <button onclick="location.reload()" style="margin-top:24px;padding:8px 16px;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;cursor:pointer">Reload</button>
      </div>`;
    return;
  }
  mountDropzone(viewer);
  mountToolbar(viewer);
  mountProperties(viewer);
  mountCategories(viewer);
  mountClipper(viewer);
  console.log("viewer ready");
})();

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

(window as any).__viewer = viewer;
```

- [ ] **Step 2: Verify by simulating failure**

Temporarily rename `public/web-ifc.wasm` to `public/web-ifc.wasm.bak`. Run `npm run dev`. Expected: red "3D engine failed to initialize" screen with Reload button. Rename back. Reload — works again.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: blocking error screen if WASM fails to load"
```

---

## Task 10: Smoke test with Playwright-electron

**Files:**
- Create: `playwright.config.ts`, `tests/smoke.spec.ts`, `test-fixtures/tiny.ifc`

- [ ] **Step 1: Add a tiny known-good IFC fixture**

Save the smallest valid IFC2x3 file you can find (e.g., the "minimal" sample from the IFC4 spec). For a quick option: a single `IfcWall` extrusion file from https://github.com/IFCjs/test-ifc-files (~30 KB). Drop it at `test-fixtures/tiny.ifc` and commit it (small enough; it's a binary-friendly text file).

- [ ] **Step 2: Write `playwright.config.ts`**

Create `playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
```

- [ ] **Step 3: Write `tests/smoke.spec.ts`**

Create `tests/smoke.spec.ts`:

```ts
import { test, expect, _electron as electron } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs";

const ROOT = path.resolve(__dirname, "..");

test("app boots, loads fixture, reports elements + categories", async () => {
  // Build first so prod entry exists; or run against dev. Here we use prod for determinism.
  // (Run `npm run build` before `npm test` — see package.json.)
  const electronApp = await electron.launch({
    args: [path.join(ROOT, "dist-electron/main.js")],
    cwd: ROOT,
  });

  const page = await electronApp.firstWindow();
  await page.waitForFunction(() => (window as any).__viewer != null, { timeout: 15_000 });

  const fixture = path.join(ROOT, "test-fixtures/tiny.ifc");
  expect(fs.existsSync(fixture)).toBe(true);
  const buf = fs.readFileSync(fixture);

  // Push the file into the renderer via the exposed viewer.
  const result = await page.evaluate(async (bytes) => {
    const arr = new Uint8Array(bytes as number[]);
    const viewer = (window as any).__viewer;
    await viewer.init?.(document.getElementById("viewport")); // no-op if already init'd
    let elementCount = 0; let categoriesCount = 0;
    viewer.onModelLoaded.on((m: any) => {
      elementCount = m.elementCount;
      categoriesCount = m.categories.size;
    });
    await viewer.loadIfc(arr.buffer);
    return { elementCount, categoriesCount };
  }, Array.from(buf));

  expect(result.elementCount).toBeGreaterThan(0);
  expect(result.categoriesCount).toBeGreaterThan(0);

  await electronApp.close();
});
```

- [ ] **Step 4: Update `package.json` test script**

Change the `test` script:

```json
"test": "npm run build && playwright test"
```

- [ ] **Step 5: Install Playwright browsers (once)**

```bash
npx playwright install
```

- [ ] **Step 6: Run the smoke test**

```bash
npm test
```

Expected: `1 passed`. If the test errors on `electron.launch`, ensure `dist-electron/main.js` exists (i.e., the build step ran). If `__viewer` is undefined, the renderer threw during init — open the saved trace to see why.

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts tests/ test-fixtures/ package.json
git commit -m "test: smoke test boots app, loads fixture, asserts categorization"
```

---

## Task 11: Package as Windows installer

**Files:**
- Modify: `electron-builder` block in `package.json` (already present from Task 2)

- [ ] **Step 1: Build production bundles**

```bash
npm run build
```

Expected: `dist/` (renderer) and `dist-electron/` (main + preload) populated. No errors.

- [ ] **Step 2: Build the installer**

```bash
npm run dist
```

Expected: `release/` contains `IFC Viewer Setup 0.1.0.exe` (NSIS installer) and unpacked `win-unpacked/`. Output ends with `building   target=nsis ...` and no errors.

- [ ] **Step 3: Smoke-test the installer**

Run the `.exe`, follow the installer, launch IFC Viewer from the start menu. Drag an IFC file in. Expected: model loads, all panels work as in dev. Right-click an `.ifc` file in Explorer → "Open with… IFC Viewer" should be available. Double-click an `.ifc` directly — IFC Viewer launches and loads it.

If WASM fails in production, double-check `extraResources` in the `build` block actually places `web-ifc.wasm` somewhere reachable. The renderer fetches it at `./web-ifc.wasm` (relative to `dist/index.html`); since the renderer is bundled to `dist/` and `vite.config.ts` has `base: "./"`, copying `public/web-ifc.wasm` into `dist/` happens automatically (Vite copies `public/` by default). Verify `dist/web-ifc.wasm` exists after `npm run build`.

- [ ] **Step 4: Commit any tweaks**

If you adjusted the build block:

```bash
git add package.json
git commit -m "chore: tune electron-builder packaging"
```

- [ ] **Step 5: Final tag**

```bash
git tag v0.1.0
```

---

## Done

The viewer now:
- Boots as an Electron app
- Accepts IFC files via drag-drop, file dialog, and OS double-click
- Renders the 3D model with orbit/pan/zoom and auto-fit
- Lets the user click elements to inspect properties + property sets
- Provides per-IFC-class visibility toggles and isolate
- Provides a horizontal section plane with height slider
- Surfaces parse + WASM errors with appropriate UI
- Has a Playwright-electron smoke test covering boot + load
- Packages to a Windows NSIS installer with `.ifc` file association

Next steps from the spec's "Open Questions / Future" section can be picked up as separate plans.
