import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import * as fs from "fs";

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
