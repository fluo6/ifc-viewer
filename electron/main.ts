import { app, BrowserWindow, ipcMain, dialog, session } from "electron";
import * as path from "path";
import * as fs from "fs";

// Treat as "dev" only when explicitly told (by scripts/dev.mjs). Running
// unpackaged electron via `electron .` should load the built dist/, not a
// non-existent dev server.
const isDev = process.env.ELECTRON_DEV === "1";
let pendingOpenPath: string | null = null;
let mainWindow: BrowserWindow | null = null;

function enableCrossOriginIsolation() {
  // Cross-origin isolation lets the renderer use SharedArrayBuffer, which
  // unlocks web-ifc's multi-threaded wasm path (~2-3x faster on big IFCs).
  // For file:// loads we have to inject COOP/COEP headers ourselves.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Cross-Origin-Embedder-Policy": ["require-corp"],
        "Cross-Origin-Resource-Policy": ["cross-origin"],
      },
    });
  });
}

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

  app.on("open-file", (event, openPath) => {
    event.preventDefault();
    if (mainWindow) {
      mainWindow.webContents.send("open-file", openPath);
    } else {
      pendingOpenPath = openPath;
    }
  });

  app.whenReady().then(() => {
    enableCrossOriginIsolation();
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

ipcMain.handle("file:read", async (_event, filePath: string) => {
  const data = await fs.promises.readFile(filePath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});
