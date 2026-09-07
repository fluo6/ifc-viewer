import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { WorkbookModel } from "./xlsx-writer";
import type { PreparedIfc, PreprocessProgress } from "./ifc-preprocessor";

contextBridge.exposeInMainWorld("electron", {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
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
  getIfcFileSize: (filePath: string): Promise<number> =>
    ipcRenderer.invoke("ifc:get-size", filePath),
  prepareIfc: (filePath: string): Promise<PreparedIfc> =>
    ipcRenderer.invoke("ifc:prepare", filePath),
  readPreparedIfc: (cacheId: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke("ifc:read-prepared", cacheId),
  onIfcPreprocessProgress: (
    handler: (event: PreprocessProgress) => void,
  ): (() => void) => {
    const listener = (
      _event: unknown,
      data: PreprocessProgress,
    ) => {
      handler(data);
    };
    ipcRenderer.on("ifc:progress", listener);
    return () => {
      ipcRenderer.removeListener("ifc:progress", listener);
    };
  },
});
