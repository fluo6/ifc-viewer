import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const srcDir = resolve(root, "node_modules/web-ifc");
const destDir = resolve(root, "public");

// web-ifc 0.0.77 ships single- and multi-threaded WASM, but no separate MT
// worker script. Keep public/ exactly aligned with the installed package so a
// stale worker from an older version can never be packaged beside new WASM.
const files = [
  "web-ifc.wasm",
  "web-ifc-node.wasm",
  "web-ifc-mt.wasm",
  "web-ifc-mt.worker.js",
];

mkdirSync(destDir, { recursive: true });
let copied = 0;
for (const f of files) {
  const src = resolve(srcDir, f);
  const dest = resolve(destDir, f);
  if (!existsSync(src)) {
    if (existsSync(dest)) {
      unlinkSync(dest);
      console.log(`[copy-wasm] removed stale -> ${f}`);
    }
    if (f === "web-ifc.wasm") {
      throw new Error(`[copy-wasm] required file not found: ${src}`);
    }
    continue;
  }
  copyFileSync(src, dest);
  console.log(`[copy-wasm] copied -> ${basename(src)}`);
  copied++;
}
if (copied === 0) {
  console.warn(
    "[copy-wasm] nothing copied (run after npm install)",
  );
}
