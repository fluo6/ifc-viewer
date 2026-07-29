/**
 * Bundles scripts/check-parameters.ts with esbuild and runs it on node.
 *
 * The output lands inside node_modules/.cache so `require("web-ifc")` still
 * resolves (web-ifc is left external — its node build loads its wasm relative
 * to its own __dirname, which bundling would break).
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outfile = resolve(root, "node_modules/.cache/check-parameters.cjs");

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(__dirname, "check-parameters.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["web-ifc"],
  outfile,
  logLevel: "warning",
});

const result = spawnSync(
  process.execPath,
  ["--max-old-space-size=4096", outfile, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
