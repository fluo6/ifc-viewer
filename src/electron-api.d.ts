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

export {};
