import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = resolve(root, "node_modules/web-ifc/web-ifc.wasm");
const destDir = resolve(root, "public");
const dest = resolve(destDir, "web-ifc.wasm");

if (!existsSync(src)) {
  console.warn(`[copy-wasm] not found: ${src} — skipping (run after npm install)`);
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-wasm] copied -> ${dest}`);
