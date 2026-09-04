import { readSync } from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import * as FRAGS from "@thatopen/fragments";

const IFCOPENINGELEMENT = 3588315303;

interface WorkerInput {
  sourcePath: string;
  outputPath: string;
  wasmDirectory: string;
  settings?: {
    coordinateToOrigin?: boolean;
    excludeOpenings?: boolean;
  };
}

async function main() {
  if (!process.parentPort) {
    console.error("ifc-preprocess-worker must be run as an Electron utility process");
    process.exit(1);
  }

  process.parentPort.on("message", async (event: { data: WorkerInput }) => {
    const { sourcePath, outputPath, wasmDirectory, settings } = event.data;
    let handle: FileHandle | null = null;
    try {
      handle = await open(sourcePath, "r");
      const importer = new FRAGS.IfcImporter();
      const wasmPath = wasmDirectory.endsWith("/") ? wasmDirectory : `${wasmDirectory}/`;
      importer.wasm = { path: wasmPath, absolute: true };

      if (settings?.excludeOpenings !== false) {
        importer.classes.elements.delete(IFCOPENINGELEMENT);
      }

      const chunkSize = 64 * 1024;
      const buffer = new Uint8Array(chunkSize);
      const fd = handle.fd;

      const bytes = await importer.process({
        readFromCallback: true,
        readCallback: (offset: number) => {
          const bytesRead = readSync(fd, buffer, 0, chunkSize, offset);
          return buffer.slice(0, bytesRead);
        },
        raw: false,
        progressCallback: (progress, data) => {
          process.parentPort?.postMessage({
            type: "progress",
            progress,
            stage: String(data ?? "processing"),
          });
        },
      });

      await writeFile(outputPath, bytes);
      process.parentPort.postMessage({ type: "complete" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const userMsg = msg.includes("memory access out of bounds")
        ? "IFC file exceeds available WebAssembly memory (~2 GiB limit)."
        : msg;
      process.parentPort?.postMessage({
        type: "error",
        message: userMsg,
      });
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // ignore
        }
      }
    }
  });
}

void main();
