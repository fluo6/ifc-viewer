import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // web-ifc ships its wasm-loader inside a CommonJS shim that Vite/Rollup
  // tree-shakes by default — the bundle then has no `require_web_ifc()` and
  // `WebIFCWasm` ends up undefined ("Could not find wasm module..."). Keeping
  // web-ifc in its own chunk and disabling tree-shaking for it preserves the
  // shim so the wasm can load at runtime.
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    // Terser instead of esbuild — esbuild's minifier was dropping the
    // `module.exports = WebIFCWasm` line from web-ifc's CommonJS shim.
    // Terser preserves it. Cuts bundle ~50% and speeds cold start.
    minify: "terser",
    terserOptions: {
      compress: {
        // Don't drop assignments to module.exports / exports.
        unused: false,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("web-ifc")) return "web-ifc";
        },
      },
      treeshake: false,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
