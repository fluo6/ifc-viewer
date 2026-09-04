import { type Viewer, LARGE_IFC_THRESHOLD_BYTES } from "../viewer";
import { toast } from "./toast";

export function mountToolbar(viewer: Viewer): void {
  const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
  const fileInput = document.getElementById("model-file-input") as HTMLInputElement;
  const nameEl = document.getElementById("model-name")!;
  const countEl = document.getElementById("model-count")!;
  const progress = document.getElementById("progress")!;
  const progressBar = document.getElementById("progress-bar") as HTMLElement;

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
    fileInput.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".ifc")) {
      toast("Only .ifc files are supported");
      return;
    }
    if (file.size > LARGE_IFC_THRESHOLD_BYTES) {
      toast(
        "Files over 50 MiB must be opened using the Open button to enable preprocessing.",
      );
      return;
    }
    try {
      await viewer.loadIfc(file);
    } catch (err) {
      toast((err as Error).message);
    }
  });

  if (window.electron?.onOpenFile) {
    window.electron.onOpenFile(async (filePath) => {
      await loadFromPath(viewer, filePath);
    });
  }

  viewer.onLoadProgress.on(({ loaded, total }) => {
    progress.classList.remove("hidden");
    const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    if (loaded >= total && total > 0) {
      setTimeout(() => progress.classList.add("hidden"), 400);
    }
  });

  viewer.onModelLoaded.on(({ filename, elementCount }) => {
    nameEl.textContent = filename;
    nameEl.classList.remove("muted");
    countEl.textContent = `· ${elementCount} elements`;
  });

  viewer.onModelUnloaded.on(() => {
    nameEl.textContent = "no model loaded";
    nameEl.classList.add("muted");
    countEl.textContent = "";
  });
}

async function loadFromPath(viewer: Viewer, filePath: string): Promise<void> {
  try {
    await viewer.loadIfcPath(filePath);
  } catch (err) {
    toast((err as Error).message);
  }
}
