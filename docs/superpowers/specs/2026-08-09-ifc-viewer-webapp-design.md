# IFC Viewer LAN Web App Design

## Goal

Make the existing IFC Viewer available as a browser application on the host's
LAN while preserving the Electron desktop app. A user on another machine can
open `http://<host-ip>:2710`, choose or drag an IFC file from that machine,
inspect it locally in the browser, and download an XLSX export.

## Scope and constraints

- LAN-only deployment; no authentication, public internet exposure, or remote
  IFC storage is included.
- The browser bundle remains the same Vite/TypeScript renderer and uses the
  existing client-side `web-ifc` WASM pipeline.
- Electron behavior and native file association remain unchanged.
- The host serves static files only; IFC contents and generated workbooks stay
  on the user's browser except when the user explicitly downloads a workbook.
- Port `2710` is the default published port and must be configurable for hosts
  with a conflict.

## Architecture

The renderer gets a small runtime-neutral file capability boundary:

- In Electron, the existing preload IPC methods continue to read a selected
  host path and save an XLSX path through native dialogs.
- In a normal browser, `Open IFC…` invokes a hidden `<input type="file">`
  restricted to `.ifc`; the selected `File` is passed to `Viewer.loadIfc`.
- The existing drag/drop path remains available in both runtimes.
- Browser export serializes the existing workbook model to XLSX in memory and
  triggers an object-URL download with the model filename. Electron continues
  using `writeXlsx` over IPC.
- Runtime capability checks are centralized so the UI does not show misleading
  Electron-only error messages in a browser.

## Deployment

Add a production image and compose definition following Lizzie Secret's
production pattern:

1. A multi-stage Node image installs dependencies and runs the Vite renderer
   build.
2. An nginx Alpine stage serves `dist/` on container port 80.
3. Compose publishes `${IFC_VIEWER_PORT:-2710}:80` and includes a lightweight
   HTTP health check.
4. The compose file does not require host-directory mounts, secrets, a backend,
   or privileged access. A separate development command may continue using
   Vite on localhost.

The README documents building/starting the service, finding the host LAN IP,
opening the firewall port, changing the port, and stopping/updating the
container. It explicitly warns that LAN access is unauthenticated.

## Error handling

- Reject non-IFC selections with the existing toast mechanism.
- Report browser download failures and file-read/load failures without
  breaking the viewer.
- Keep the WASM initialization failure screen useful for both `http://` and
  Electron loads.
- Do not log IFC file contents, paths, or generated workbook data.

## Verification

- TypeScript/build checks pass for renderer and Electron targets.
- Existing Playwright tests remain green.
- Add browser-mode tests covering file-input loading and XLSX download while
  retaining Electron capability guards.
- Build the production container and verify its health endpoint and published
  port with a local HTTP request.
- Confirm the browser bundle references assets with paths that work when
  served by nginx, not only through the Vite dev server.

## Non-goals and future options

Authentication, TLS, reverse-proxy hostname setup, server-side model storage,
multi-user sessions, and collaborative viewing are intentionally deferred.
They can be layered later behind the same static frontend if remote access
needs to extend beyond a trusted LAN.
