# IFC Viewer LAN Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the IFC Viewer as a LAN-only browser app on port 2710 while preserving Electron file dialogs and exports.

**Architecture:** Keep the Vite renderer and client-side WASM model processing. Add browser file selection and workbook download capabilities behind runtime checks, then package the static build with nginx in Docker and publish it through compose.

**Tech Stack:** TypeScript, Vite, Electron preload IPC, ExcelJS, Playwright, Docker, nginx Alpine.

## Global Constraints

- LAN-only deployment; no authentication, public internet exposure, or remote IFC storage.
- Browser users load IFC files and generate downloads locally; the host serves static assets only.
- Electron behavior and native file association remain unchanged.
- Default published port is `${IFC_VIEWER_PORT:-2710}`.
- Do not add secrets, backend services, privileged containers, or host-directory mounts.

---

### Task 1: Add browser file selection while preserving Electron

**Files:**
- Modify: `src/ui/toolbar.ts`
- Modify: `src/electron-api.d.ts`
- Modify: `index.html`
- Test: `tests/browser-file-input.spec.ts`

**Interfaces:**
- Browser selection uses `HTMLInputElement#model-file-input` and passes its
  `File` directly to `Viewer.loadIfc`.
- Electron continues calling `window.electron.openFileDialog()` and
  `window.electron.readFile()`.

- [ ] **Step 1: Write a failing browser test** that starts the built renderer
  without an Electron bridge, sets a `.ifc` file on the hidden input, and
  verifies the viewer receives the file and updates the model name.
- [ ] **Step 2: Run the focused Playwright test** with
  `npx playwright test tests/browser-file-input.spec.ts -g "browser file"` and
  confirm it fails because no browser input exists.
- [ ] **Step 3: Add the hidden file input** to `index.html` and wire the Open
  button in `mountToolbar` to use it when `window.electron` is unavailable.
  Validate the extension, call `viewer.loadIfc(file)`, reset the input value so
  the same file can be selected twice, and toast load errors.
- [ ] **Step 4: Update the empty-state copy** so it describes both selecting
  and dragging an IFC file in either runtime.
- [ ] **Step 5: Run the focused test and `npm run typecheck`**; both must pass.

### Task 2: Add browser XLSX download

**Files:**
- Modify: `src/ui/export.ts`
- Modify: `src/electron-api.d.ts`
- Test: `tests/browser-export.spec.ts`

**Interfaces:**
- Browser export builds the existing `WorkbookModel`, calls
  `workbook.xlsx.writeBuffer()`, creates an object URL, and clicks a temporary
  anchor named `<model>.xlsx`.
- Electron export keeps `saveXlsxDialog` and `writeXlsx` unchanged.

- [ ] **Step 1: Write a failing test** with no Electron bridge that loads the
  fixture, clicks Export XLSX, stubs `URL.createObjectURL`, and asserts a
  download anchor is created with an `.xlsx` filename.
- [ ] **Step 2: Run the focused test** and verify the current Electron-only
  guard produces the failure.
- [ ] **Step 3: Extract browser download logic** into a small function in
  `src/ui/export.ts`; use ExcelJS's browser-safe `writeBuffer`, revoke the URL
  in a `finally` block, and preserve the existing busy/disabled/error behavior.
- [ ] **Step 4: Keep the streamed-model and missing-parameter guards** exactly
  as they are, because those constraints apply equally in the browser.
- [ ] **Step 5: Run the focused test, existing export tests, and typecheck.**

### Task 3: Production Docker/nginx packaging

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `nginx.conf`
- Modify: `.dockerignore`
- Test: `tests/web-deployment.spec.ts` (or a shell health check if Docker is
  unavailable in CI)

**Interfaces:**
- `docker compose up -d --build` publishes `${IFC_VIEWER_PORT:-2710}:80`.
- nginx serves the Vite output and returns `200` for `/` and static WASM
  assets.

- [ ] **Step 1: Add a production smoke-test command** that expects an HTTP
  `200` from `/` and confirms `web-ifc.wasm` is reachable.
- [ ] **Step 2: Run the smoke test before adding the image** and record the
  expected failure because no compose service exists.
- [ ] **Step 3: Add a multi-stage Dockerfile** using a Node build stage with
  `npm ci` and `npm run build`, followed by `nginx:alpine` copying `dist/` and
  the project nginx config.
- [ ] **Step 4: Add nginx config** with `try_files $uri $uri/ /index.html`,
  explicit WASM MIME handling, and no proxy/backend routes.
- [ ] **Step 5: Add compose** with `${IFC_VIEWER_PORT:-2710}:80`, a healthcheck
  against `/`, restart policy, and no mounts or secrets.
- [ ] **Step 6: Build and start the container**, run the smoke test, then stop
  it and remove only the project-created container/image if cleanup is needed.

### Task 4: Document LAN operation and verify the complete app

**Files:**
- Modify: `README.md`
- Modify: `playwright.config.ts` only if a browser-server base URL is needed
- Test: `tests/browser-file-input.spec.ts`
- Test: `tests/browser-export.spec.ts`

**Interfaces:**
- README command sequence is `docker compose up -d --build`, browse to
  `http://<host-ip>:2710`, and use `docker compose down` to stop.

- [ ] **Step 1: Add README web-app instructions** covering host IP discovery,
  firewall access to TCP 2710, configurable port, drag/drop/file picker,
  browser downloads, and the unauthenticated LAN-only warning.
- [ ] **Step 2: Run `npm run build`, `npm run typecheck`, and the full
  Playwright suite.**
- [ ] **Step 3: Build the production image and verify `/`, WASM, browser file
  loading, and browser XLSX download against the published port.
- [ ] **Step 4: Run `git diff --check` and report the changed files; leave the
  commit to the user because this workspace's `.git` mount is read-only.

## Self-review checklist

- Browser input, drag/drop, and Electron path all converge on `Viewer.loadIfc`.
- Browser and Electron export paths share workbook construction and differ only
  at the final persistence boundary.
- Docker serves the same built assets used by Electron's packaged renderer.
- The plan contains no server-side IFC persistence, authentication, or secrets.
