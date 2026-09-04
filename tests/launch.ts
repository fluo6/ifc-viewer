import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, type ElectronApplication } from "playwright";

export const REPO = path.resolve(__dirname, "..");

/** IFC used by the e2e tests. Override with IFC_FIXTURE. */
export const FIXTURE_IFC =
  process.env.IFC_FIXTURE ??
  "C:\\Users\\fujial\\Documents\\264034 - Centre for Jewish Life\\rhino\\rhino-ifc-20260728\\_qto\\264034-TTW-11-RH-ST-001-[01] - PAC IFC Model.ifc";

export const fixtureExists = (): boolean => existsSync(FIXTURE_IFC);

/**
 * Launch the packaged renderer under Electron.
 *
 * The app takes a single-instance lock (electron/main.ts) and quits outright
 * if it cannot get one. That lock is scoped to the userData directory, so each
 * run gets a fresh temp dir -- otherwise a test collides with a previous run
 * still shutting down, or with a viewer the developer has open, and the launch
 * dies with an opaque WebSocket ECONNRESET.
 */
export async function launchViewer(): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "ifc-viewer-e2e-"));
  const softwareRenderingArgs =
    process.platform === "linux"
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
      : [];
  return electron.launch({
    args: [".", ...softwareRenderingArgs, `--user-data-dir=${userDataDir}`],
    cwd: REPO,
  });
}

/** Wait for main.ts to finish wiring up and expose the viewer. */
export async function readyWindow(app: ElectronApplication) {
  const win = await app.firstWindow();
  await win.waitForFunction(
    () => (window as any).__viewer !== undefined,
    undefined,
    { timeout: 60_000 },
  );
  return win;
}
