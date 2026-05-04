import type { Viewer } from "../viewer";
import { toast } from "./toast";

export function mountToolbar(viewer: Viewer): void {
  const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
  const nameEl = document.getElementById("model-name")!;
  const countEl = document.getElementById("model-count")!;
  const progress = document.getElementById("progress")!;
  const progressBar = document.getElementById("progress-bar") as HTMLElement;

  openBtn.addEventListener("click", async () => {
    if (!window.electron?.openFileDialog) {
      toast("File dialog only works inside the Electron app", "info");
      return;
    }
    const filePath = await window.electron.openFileDialog();
    if (!filePath) return;
    await loadFromPath(viewer, filePath);
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
    const buf = await window.electron.readFile(filePath);
    const filename = filePath.split(/[\\/]/).pop() ?? "model.ifc";
    await viewer.loadIfc(buf, filename);
  } catch (err) {
    toast((err as Error).message);
  }
}
