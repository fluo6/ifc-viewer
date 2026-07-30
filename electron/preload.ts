import { contextBridge, ipcRenderer } from "electron";
import type { WorkbookModel } from "./xlsx-writer";

contextBridge.exposeInMainWorld("electron", {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:open-ifc"),
  readFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke("file:read", filePath),
  onOpenFile: (handler: (filePath: string) => void) => {
    ipcRenderer.on("open-file", (_event, filePath: string) => handler(filePath));
  },
  saveXlsxDialog: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke("dialog:save-xlsx", suggestedName),
  writeXlsx: (filePath: string, model: WorkbookModel): Promise<void> =>
    ipcRenderer.invoke("file:write-xlsx", filePath, model),
});

declare global {
  interface Window {
    electron: {
      openFileDialog: () => Promise<string | null>;
      readFile: (filePath: string) => Promise<ArrayBuffer>;
      onOpenFile: (handler: (filePath: string) => void) => void;
      saveXlsxDialog: (suggestedName: string) => Promise<string | null>;
      writeXlsx: (filePath: string, model: unknown) => Promise<void>;
    };
  }
}
