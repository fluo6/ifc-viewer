import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:open-ifc"),
  readFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke("file:read", filePath),
  onOpenFile: (handler: (filePath: string) => void) => {
    ipcRenderer.on("open-file", (_event, filePath: string) => handler(filePath));
  },
});

declare global {
  interface Window {
    electron: {
      openFileDialog: () => Promise<string | null>;
      readFile: (filePath: string) => Promise<ArrayBuffer>;
      onOpenFile: (handler: (filePath: string) => void) => void;
    };
  }
}
