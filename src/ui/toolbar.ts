import { type Viewer, LARGE_IFC_THRESHOLD_BYTES } from "../viewer";
import { toast } from "./toast";

export function mountToolbar(viewer: Viewer): void {
  const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
  const fitBtn = document.getElementById("fit-btn") as HTMLButtonElement | null;
  const fileInput = document.getElementById("model-file-input") as HTMLInputElement;
  const nameEl = document.getElementById("model-name")!;
  const countEl = document.getElementById("model-count")!;
  const progress = document.getElementById("progress")!;
  const progressBar = document.getElementById("progress-bar") as HTMLElement;

  if (fitBtn) {
    fitBtn.addEventListener("click", () => {
      void viewer.zoomToFit(true);
    });
  }

  openBtn.addEventListener("click", async () => {
    if (!window.electron?.openFileDialog) {
      fileInput.click();
      return;
    }
    const filePath = await window.electron.openFileDialog();
    if (!filePath) return;
    await loadFromPath(viewer, filePath);
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    try {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith(".ifc")) {
        toast("Only .ifc files are supported");
        return;
      }
      if (
        file.size > LARGE_IFC_THRESHOLD_BYTES &&
        typeof window.electron !== "undefined"
      ) {
        toast(
          "Files over 50 MiB must be opened using the Open button to enable preprocessing.",
        );
        return;
      }
      console.log(
        `[IFC] Opening file "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} MB)...`,
      );
      await viewer.loadIfc(file);
    } catch (err) {
      console.error("[IFC] Failed to load model:", err);
      const msg = (err as Error).message || String(err);
      toast(msg, "error", 8000);
      nameEl.textContent = "Failed to load model";
      nameEl.classList.add("muted");
      countEl.textContent = `(${msg})`;
      progress.classList.add("hidden");
    } finally {
      document.body.style.cursor = "";
      fileInput.value = "";
    }
  });

  if (window.electron?.onOpenFile) {
    window.electron.onOpenFile(async (filePath) => {
      await loadFromPath(viewer, filePath);
    });
  }

  viewer.onLoadStarted.on(({ filename, size }) => {
    nameEl.textContent = `Loading ${filename}… (0%)`;
    nameEl.classList.remove("muted");
    if (size) {
      countEl.textContent = `(${(size / (1024 * 1024)).toFixed(1)} MB)`;
    } else {
      countEl.textContent = "";
    }
    progress.classList.remove("hidden");
    progressBar.style.width = "5%";
    document.body.style.cursor = "wait";
  });

  viewer.onLoadProgress.on(({ loaded, total }) => {
    progress.classList.remove("hidden");
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    progressBar.style.width = `${pct}%`;
    if (nameEl.textContent?.startsWith("Loading")) {
      nameEl.textContent =
        nameEl.textContent.replace(/\s*\(\d+%\)$/, "") + ` (${pct}%)`;
    }
    if (loaded >= total && total > 0) {
      setTimeout(() => progress.classList.add("hidden"), 400);
    }
  });

  viewer.onModelLoaded.on(({ filename, elementCount }) => {
    document.body.style.cursor = "";
    nameEl.textContent = filename;
    nameEl.classList.remove("muted");
    countEl.textContent = `· ${elementCount} elements`;
    if (fitBtn) fitBtn.disabled = false;
  });

  viewer.onModelUnloaded.on(() => {
    document.body.style.cursor = "";
    nameEl.textContent = "no model loaded";
    nameEl.classList.add("muted");
    countEl.textContent = "";
    if (fitBtn) fitBtn.disabled = true;
  });
}

async function loadFromPath(viewer: Viewer, filePath: string): Promise<void> {
  const nameEl = document.getElementById("model-name")!;
  const countEl = document.getElementById("model-count")!;
  const progress = document.getElementById("progress")!;
  try {
    await viewer.loadIfcPath(filePath);
  } catch (err) {
    console.error("[IFC] Failed to load path:", err);
    const msg = (err as Error).message || String(err);
    toast(msg, "error", 8000);
    nameEl.textContent = "Failed to load model";
    nameEl.classList.add("muted");
    countEl.textContent = `(${msg})`;
    progress.classList.add("hidden");
  } finally {
    document.body.style.cursor = "";
  }
}
