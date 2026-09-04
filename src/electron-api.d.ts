export interface PreparedIfc {
  cacheId: string;
  filename: string;
  cacheHit: boolean;
}

export interface PreprocessProgress {
  cacheId: string;
  progress: number;
  stage: string;
}

declare global {
  interface Window {
    electron: {
      openFileDialog: () => Promise<string | null>;
      readFile: (filePath: string) => Promise<ArrayBuffer>;
      onOpenFile: (handler: (filePath: string) => void) => void;
      saveXlsxDialog: (suggestedName: string) => Promise<string | null>;
      writeXlsx: (filePath: string, model: unknown) => Promise<void>;
      getIfcFileSize: (filePath: string) => Promise<number>;
      prepareIfc: (filePath: string) => Promise<PreparedIfc>;
      readPreparedIfc: (cacheId: string) => Promise<ArrayBuffer>;
      onIfcPreprocessProgress: (
        handler: (event: PreprocessProgress) => void,
      ) => () => void;
    };
  }
}

export {};
