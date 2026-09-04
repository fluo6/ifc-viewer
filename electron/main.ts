import { IfcPreprocessorService, UtilityProcessConverter } from "./ifc-preprocessor";
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import * as fs from "fs";
import { writeWorkbook, type WorkbookModel } from "./xlsx-writer";

// Treat as "dev" only when explicitly told (by scripts/dev.mjs). Running
// unpackaged electron via `electron .` should load the built dist/, not a
// non-existent dev server.
const isDev = process.env.ELECTRON_DEV === "1";
let pendingOpenPath: string | null = null;
let mainWindow: BrowserWindow | null = null;

// (Cross-origin isolation was tried here to unlock web-ifc's multi-threaded
// wasm, but the MT worker spawns sub-workers via URL.createObjectURL(Blob),
// which file:// loads in Chromium reject. Stick to single-threaded wasm.)

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

ipcMain.handle("dialog:save-xlsx", async (_event, suggestedName: string) => {
  const result = await dialog.showSaveDialog({
    title: "Export attributes",
    defaultPath: suggestedName,
    filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle(
  "file:write-xlsx",
  async (_event, filePath: string, model: WorkbookModel) => {
    // Let the rejection reach the renderer: "file is open in Excel" is the
    // common failure and the user needs to be told, not left guessing.
    await writeWorkbook(filePath, model);
  },
);

const cacheDir = path.join(app.getPath("userData"), "ifc-cache");
const wasmDir = isDev
  ? path.join(__dirname, "../public")
  : path.join(process.resourcesPath, "public");
const workerPath = path.join(__dirname, "ifc-preprocess-worker.js");
const converter = new UtilityProcessConverter(workerPath, wasmDir);
const preprocessor = new IfcPreprocessorService(cacheDir, converter);

ipcMain.handle("ifc:get-size", async (_event, filePath: string) => {
  return preprocessor.getFileSize(filePath);
});

ipcMain.handle("ifc:prepare", async (event, filePath: string) => {
  return preprocessor.prepare(filePath, (progress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("ifc:progress", progress);
    }
  });
});

ipcMain.handle("ifc:read-prepared", async (_event, cacheId: string) => {
  return preprocessor.readPrepared(cacheId);
});
