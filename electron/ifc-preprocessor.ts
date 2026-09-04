import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SourceIdentity {
  path: string;
  size: number;
  mtimeMs: number;
}

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

export interface IfcConverter {
  convert(
    sourcePath: string,
    outputPath: string,
    onProgress?: (progress: number, stage: string) => void,
  ): Promise<void>;
}

export const DEFAULT_CONVERTER_VERSIONS: Record<string, string> = {
  components: "3.4.8",
  fragments: "3.4.7",
  webIfc: "0.0.77",
};

export const DEFAULT_CONVERTER_SETTINGS: Record<string, unknown> = {
  coordinateToOrigin: true,
  excludeOpenings: true,
  raw: false,
};

export function cacheKey(
  source: SourceIdentity,
  versions: Record<string, string> = DEFAULT_CONVERTER_VERSIONS,
  settings: Record<string, unknown> = DEFAULT_CONVERTER_SETTINGS,
): string {
  const normPath = path.resolve(source.path).replace(/\\/g, "/");
  const sortedVersions = Object.keys(versions)
    .sort()
    .reduce<Record<string, string>>((acc, k) => {
      acc[k] = String(versions[k]);
      return acc;
    }, {});
  const sortedSettings = Object.keys(settings)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = settings[k];
      return acc;
    }, {});

  const payload = JSON.stringify({
    path: normPath,
    size: source.size,
    mtimeMs: Math.round(source.mtimeMs),
    versions: sortedVersions,
    settings: sortedSettings,
  });

  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function writeCacheAtomically(
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, bytes);
    await fs.promises.rename(tmpPath, target);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

export class IfcPreprocessorService {
  private cacheMap = new Map<string, string>();

  constructor(
    private cacheDir: string,
    private converter?: IfcConverter,
    private versions: Record<string, string> = DEFAULT_CONVERTER_VERSIONS,
    private settings: Record<string, unknown> = DEFAULT_CONVERTER_SETTINGS,
  ) {}

  async getFileSize(sourcePath: string): Promise<number> {
    const stat = await fs.promises.stat(sourcePath);
    return stat.size;
  }

  getCachePath(cacheId: string): string | null {
    return this.cacheMap.get(cacheId) ?? null;
  }

  async prepare(
    sourcePath: string,
    onProgress?: (event: PreprocessProgress) => void,
  ): Promise<PreparedIfc> {
    const stat = await fs.promises.stat(sourcePath);
    const source: SourceIdentity = {
      path: sourcePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };

    const id = cacheKey(source, this.versions, this.settings);
    const filename = path.basename(sourcePath);
    const target = path.join(this.cacheDir, `${id}.frag`);

    try {
      const cacheStat = await fs.promises.stat(target);
      if (cacheStat.size > 0) {
        this.cacheMap.set(id, target);
        return {
          cacheId: id,
          filename,
          cacheHit: true,
        };
      }
    } catch {
      // Cache miss
    }

    if (!this.converter) {
      throw new Error("No IFC converter configured for preprocessor");
    }

    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    const tmpTarget = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

    try {
      await this.converter.convert(sourcePath, tmpTarget, (progress, stage) => {
        onProgress?.({
          cacheId: id,
          progress,
          stage,
        });
      });

      const tmpStat = await fs.promises.stat(tmpTarget);
      if (tmpStat.size === 0) {
        throw new Error("Conversion resulted in empty fragment file");
      }

      await fs.promises.rename(tmpTarget, target);
      this.cacheMap.set(id, target);

      return {
        cacheId: id,
        filename,
        cacheHit: false,
      };
    } catch (err) {
      try {
        await fs.promises.unlink(tmpTarget);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  async readPrepared(cacheId: string): Promise<ArrayBuffer> {
    const cachedFile =
      this.cacheMap.get(cacheId) ?? path.join(this.cacheDir, `${cacheId}.frag`);

    const resolved = path.resolve(cachedFile);
    if (!resolved.startsWith(path.resolve(this.cacheDir))) {
      throw new Error("Unknown or expired cache ID");
    }

    try {
      const buf = await fs.promises.readFile(resolved);
      this.cacheMap.set(cacheId, resolved);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      throw new Error(`Unknown or expired cache ID: ${cacheId}`);
    }
  }
}

export class UtilityProcessConverter implements IfcConverter {
  constructor(
    private workerScriptPath: string,
    private wasmDirectory: string,
  ) {}

  async convert(
    sourcePath: string,
    outputPath: string,
    onProgress?: (progress: number, stage: string) => void,
  ): Promise<void> {
    let electron: any;
    try {
      electron = require("electron");
    } catch {
      throw new Error("Electron is not available");
    }

    const utilityProcess = electron.utilityProcess;
    if (!utilityProcess) {
      throw new Error("utilityProcess is not available in this Electron process");
    }

    return new Promise<void>((resolve, reject) => {
      let child: any = null;
      try {
        child = utilityProcess.fork(this.workerScriptPath);
      } catch (err) {
        reject(err);
        return;
      }

      child.on("message", (msg: { type: string; progress?: number; stage?: string; message?: string }) => {
        if (msg.type === "progress") {
          onProgress?.(msg.progress ?? 0, msg.stage ?? "processing");
        } else if (msg.type === "complete") {
          try {
            child?.kill();
          } catch {
            // ignore
          }
          resolve();
        } else if (msg.type === "error") {
          try {
            child?.kill();
          } catch {
            // ignore
          }
          reject(new Error(msg.message ?? "Conversion failed"));
        }
      });

      child.on("exit", (code: number | null) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`Preprocessor worker exited with code ${code}`));
        }
      });

      child.postMessage({
        sourcePath,
        outputPath,
        wasmDirectory: this.wasmDirectory,
        settings: DEFAULT_CONVERTER_SETTINGS,
      });
    });
  }
}
