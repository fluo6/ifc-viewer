import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  // Six specs launch a real Electron app and two of them run a full parameter
  // extraction over ~1300 elements. Unbounded parallelism starves them of CPU
  // and the launch handshake times out, which was already seen flaking.
  workers: 2,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
