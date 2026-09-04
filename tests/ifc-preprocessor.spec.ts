import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cacheKey,
  writeCacheAtomically,
  IfcPreprocessorService,
  type SourceIdentity,
  type IfcConverter,
} from "../electron/ifc-preprocessor";

test.describe("ifc-preprocessor cache contract", () => {
  const versions = {
    components: "3.4.8",
    fragments: "3.4.7",
    webIfc: "0.0.77",
  };
  const settings = {
    coordinateToOrigin: true,
    excludeOpenings: true,
  };

  test("cacheKey is deterministic and changes on any identity, version, or setting change", () => {
    const baseSource: SourceIdentity = {
      path: "/models/building.ifc",
      size: 1024 * 1024 * 60,
      mtimeMs: 1700000000000,
    };

    const baseKey = cacheKey(baseSource, versions, settings);
    expect(typeof baseKey).toBe("string");
    expect(baseKey.length).toBe(64);
    expect(cacheKey(baseSource, versions, settings)).toBe(baseKey);

    expect(
      cacheKey({ ...baseSource, path: "/models/other.ifc" }, versions, settings),
    ).not.toBe(baseKey);

    expect(
      cacheKey({ ...baseSource, size: baseSource.size + 1 }, versions, settings),
    ).not.toBe(baseKey);

    expect(
      cacheKey({ ...baseSource, mtimeMs: baseSource.mtimeMs + 10 }, versions, settings),
    ).not.toBe(baseKey);

    expect(
      cacheKey(baseSource, { ...versions, fragments: "3.4.8" }, settings),
    ).not.toBe(baseKey);

    expect(
      cacheKey(baseSource, versions, { ...settings, excludeOpenings: false }),
    ).not.toBe(baseKey);
  });

  test("writeCacheAtomically writes file and cleans up temporary file on failure", async () => {
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ifc-cache-test-"),
    );
    try {
      const target = path.join(tmpDir, "test-output.frag");
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      await writeCacheAtomically(target, data);
      const readBack = await fs.promises.readFile(target);
      expect(Buffer.from(readBack)).toEqual(Buffer.from(data));

      const updatedData = new Uint8Array([6, 7, 8]);
      await writeCacheAtomically(target, updatedData);
      const readBackUpdated = await fs.promises.readFile(target);
      expect(Buffer.from(readBackUpdated)).toEqual(Buffer.from(updatedData));

      await expect(
        writeCacheAtomically("/invalid-root-dir-that-does-not-exist/forbidden.frag", data),
      ).rejects.toThrow();

      const files = await fs.promises.readdir(tmpDir);
      expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("IfcPreprocessorService orchestrates cache hits, misses, and failure atomicity", async () => {
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ifc-service-test-"),
    );
    const sourceDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ifc-source-test-"),
    );

    try {
      const sourcePath = path.join(sourceDir, "sample.ifc");
      await fs.promises.writeFile(sourcePath, Buffer.alloc(100, 0x41));

      let convertCalls = 0;
      const fakeConverter: IfcConverter = {
        convert: async (_src, outPath, onProgress) => {
          convertCalls++;
          onProgress?.(50, "parsing");
          onProgress?.(100, "compressing");
          await fs.promises.writeFile(outPath, Buffer.from("converted-fragment-bytes"));
        },
      };

      const service = new IfcPreprocessorService(
        tmpDir,
        fakeConverter,
        versions,
        settings,
      );

      const progressEvents: Array<{ progress: number; stage: string }> = [];
      const res1 = await service.prepare(sourcePath, (ev) => {
        progressEvents.push({ progress: ev.progress, stage: ev.stage });
      });

      expect(res1.cacheHit).toBe(false);
      expect(res1.filename).toBe("sample.ifc");
      expect(convertCalls).toBe(1);
      expect(progressEvents.length).toBeGreaterThan(0);

      const buffer = await service.readPrepared(res1.cacheId);
      expect(Buffer.from(buffer).toString("utf-8")).toBe("converted-fragment-bytes");

      const res2 = await service.prepare(sourcePath);
      expect(res2.cacheHit).toBe(true);
      expect(res2.cacheId).toBe(res1.cacheId);
      expect(convertCalls).toBe(1);

      const failingConverter: IfcConverter = {
        convert: async () => {
          throw new Error("synthetic converter crash");
        },
      };

      const failingSource = path.join(sourceDir, "failing.ifc");
      await fs.promises.writeFile(failingSource, Buffer.alloc(50, 0x42));

      const failingService = new IfcPreprocessorService(
        tmpDir,
        failingConverter,
        versions,
        settings,
      );

      await expect(failingService.prepare(failingSource)).rejects.toThrow(
        "synthetic converter crash",
      );

      const cachedAfterFail = await service.readPrepared(res1.cacheId);
      expect(Buffer.from(cachedAfterFail).toString("utf-8")).toBe(
        "converted-fragment-bytes",
      );

      const cacheDirFiles = await fs.promises.readdir(tmpDir);
      expect(cacheDirFiles.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);

      await expect(service.readPrepared("unknown-cache-id")).rejects.toThrow(
        "Unknown or expired cache ID",
      );
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
      await fs.promises.rm(sourceDir, { recursive: true, force: true });
    }
  });
});
