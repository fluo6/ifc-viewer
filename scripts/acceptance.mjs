import { _electron as electron } from "playwright";
import { statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const executablePath = path.resolve(root, "release/linux-arm64-unpacked/ifc-viewer");
const fixturePath = "/tmp/large-entities.ifc";
const outDir = path.resolve(root, "docs/verification");

async function run() {
  const stat = statSync(fixturePath);
  console.log(`Testing with fixture: ${fixturePath} (${stat.size} bytes / ${(stat.size / (1024 * 1024)).toFixed(2)} MiB)`);

  const userDataDir = mkdtempSync(path.join(tmpdir(), "ifc-viewer-acceptance-"));
  const app = await electron.launch({
    executablePath,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--user-data-dir=${userDataDir}`],
    cwd: root,
  });

  try {
    const page = await app.firstWindow();
    page.on("console", (msg) => console.log("[renderer console]", msg.type(), msg.text()));
    page.on("pageerror", (err) => console.error("[renderer pageerror]", err));
    await page.waitForFunction(
      () => (window).__viewer?.debugInitialized?.() === true,
      undefined,
      { timeout: 60_000 }
    );
    console.log("App launched and viewer initialized.");

    // Exercise Load 1 (Cache Miss)
    console.log("=== EXERCISE 1: First Load (Cache Miss) ===");
    const t0 = Date.now();
    await page.evaluate(async (path) => {
      const v = window.__viewer;
      await v.loadIfcPath(path);
    }, fixturePath);
    const load1TimeMs = Date.now() - t0;
    const prep1 = await page.evaluate(() => (window).__viewer.debugLastPrepared());
    console.log(`First load completed in ${load1TimeMs} ms. Cache hit: ${prep1.cacheHit}, cacheId: ${prep1.cacheId}`);

    // Verify properties on prepared model
    const streamed = await page.evaluate(() => (window).__viewer.currentIsStreamed);
    const categoriesCount = await page.evaluate(() => (window).__viewer.getCategories().size);
    console.log(`Streamed flag: ${streamed}, Category groups count: ${categoriesCount}`);

    // Exercise Load 2 (Cache Hit)
    console.log("=== EXERCISE 2: Re-open same file (Cache Hit) ===");
    await page.evaluate(async () => {
      await (window).__viewer.unloadIfc();
    });
    const t1 = Date.now();
    await page.evaluate(async (path) => {
      const v = window.__viewer;
      await v.loadIfcPath(path);
    }, fixturePath);
    const load2TimeMs = Date.now() - t1;
    const prep2 = await page.evaluate(() => (window).__viewer.debugLastPrepared());
    console.log(`Second load completed in ${load2TimeMs} ms. Cache hit: ${prep2.cacheHit}, cacheId: ${prep2.cacheId}`);

    // Set fixed camera position for visual comparisons
    console.log("=== CAPTURING SCREENSHOTS AT IDENTICAL CAMERA POSITION ===");
    await page.evaluate(() => {
      const v = window.__viewer;
      v.world.camera.controls.setLookAt(5, 5, 5, 0, 0, 0, false);
      v.world.camera.controls.update(0.016);
    });
    await page.waitForTimeout(1000);

    const viewport = page.locator("#viewport");

    // 1. Normal (COLOR)
    await page.evaluate(() => {
      const v = window.__viewer;
      v.setEdges(false);
      v.setHiddenLines(false);
      v.setClippingPlane(false);
    });
    await page.waitForTimeout(500);
    const style1 = await page.evaluate(() => (window).__viewer.debugPostproductionStyle());
    console.log(`Style 1 (Normal): ${style1}`);
    await viewport.screenshot({ path: path.join(outDir, "normal.png") });

    // 2. Edges (COLOR_PEN)
    await page.evaluate(() => {
      const v = window.__viewer;
      v.setEdges(true);
      v.setHiddenLines(false);
    });
    await page.waitForTimeout(500);
    const style2 = await page.evaluate(() => (window).__viewer.debugPostproductionStyle());
    console.log(`Style 2 (Edges): ${style2}`);
    await viewport.screenshot({ path: path.join(outDir, "edges.png") });

    // 3. Hidden lines (PEN)
    await page.evaluate(() => {
      const v = window.__viewer;
      v.setHiddenLines(true);
    });
    await page.waitForTimeout(500);
    const style3 = await page.evaluate(() => (window).__viewer.debugPostproductionStyle());
    console.log(`Style 3 (Hidden lines): ${style3}`);
    await viewport.screenshot({ path: path.join(outDir, "pen.png") });

    // 4. Clipped PEN
    await page.evaluate(() => {
      const v = window.__viewer;
      const range = v.getModelHeightRange();
      const mid = range ? (range.min + range.max) / 2 : 0;
      v.setClippingPlane(true, mid);
    });
    await page.waitForTimeout(500);
    const style4 = await page.evaluate(() => (window).__viewer.debugPostproductionStyle());
    const clipCount = await page.evaluate(() => (window).__viewer.debugClippingPlaneCount());
    console.log(`Style 4 (Clipped PEN): ${style4}, clipping plane count: ${clipCount}`);
    await viewport.screenshot({ path: path.join(outDir, "clipped-pen.png") });

    console.log("All screenshots captured successfully.");
    console.log(JSON.stringify({
      modelSize: stat.size,
      load1TimeMs,
      cacheHit1: prep1.cacheHit,
      load2TimeMs,
      cacheHit2: prep2.cacheHit,
      streamed,
      categoriesCount,
    }, null, 2));

  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error("Acceptance test failed:", err);
  process.exit(1);
});
