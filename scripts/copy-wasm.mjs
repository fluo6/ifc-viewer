import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const srcDir = resolve(root, "node_modules/web-ifc");
const destDir = resolve(root, "public");

// Copy both single-threaded and multi-threaded wasm. The IfcLoader/web-ifc
// pair may request either one depending on the runtime — if the MT variant
// is requested but missing, web-ifc falls back to a stub that produces
// "memory access out of bounds" errors when parsing.
const files = ["web-ifc.wasm", "web-ifc-mt.wasm", "web-ifc-mt.worker.js"];

mkdirSync(destDir, { recursive: true });
let copied = 0;
for (const f of files) {
  const src = resolve(srcDir, f);
  if (!existsSync(src)) {
    console.warn(`[copy-wasm] not found: ${src} — skipping`);
    continue;
  }
  copyFileSync(src, resolve(destDir, f));
  console.log(`[copy-wasm] copied -> ${basename(src)}`);
  copied++;
}
if (copied === 0) {
  console.warn(
    "[copy-wasm] nothing copied (run after npm install)",
  );
}
