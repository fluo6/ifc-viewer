import { type Viewer, LARGE_IFC_THRESHOLD_BYTES } from "../viewer";
import { toast } from "./toast";

export function mountDropzone(viewer: Viewer): void {
  const root = document.getElementById("app")!;
  const placeholder = document.getElementById("dropzone")!;

  placeholder.classList.add("empty");
  placeholder.textContent =
    "Drop an .ifc file here, or click Open to choose one.";

  // Clicking anywhere in the empty dropzone triggers the file picker
  placeholder.addEventListener("click", () => {
    if (placeholder.classList.contains("empty")) {
      const openBtn = document.getElementById("open-btn") as HTMLButtonElement | null;
      openBtn?.click();
    }
  });

  viewer.onLoadStarted.on(({ filename }) => {
    if (placeholder.classList.contains("empty")) {
      placeholder.textContent = `Loading ${filename}… please wait`;
    }
  });

  viewer.onModelLoaded.on(() => {
    placeholder.classList.remove("empty");
    placeholder.textContent = "";
  });
  viewer.onModelUnloaded.on(() => {
    placeholder.classList.add("empty");
    placeholder.textContent =
      "Drop an .ifc file here, or click Open to choose one.";
  });

  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  window.addEventListener("dragenter", (e) => e.preventDefault());
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) placeholder.classList.remove("dragover");
  });
  window.addEventListener("drop", (e) => e.preventDefault());

  root.addEventListener("dragenter", (e) => {
    stop(e);
    placeholder.classList.add("dragover");
  });
  root.addEventListener("dragover", (e) => {
    stop(e);
    placeholder.classList.add("dragover");
  });
  root.addEventListener("dragleave", (e) => {
    stop(e);
    if (e.target === root || !e.relatedTarget) {
      placeholder.classList.remove("dragover");
    }
  });
  root.addEventListener("drop", async (e) => {
    stop(e);
    placeholder.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".ifc")) {
      toast("Only .ifc files are supported");
      return;
    }
    let electronPath: string | undefined;
    if (typeof window.electron !== "undefined") {
      try {
        electronPath =
          window.electron.getPathForFile?.(file) ??
          ((file as any).path as string | undefined);
      } catch {
        electronPath = (file as any).path as string | undefined;
      }
    }
    if (electronPath && typeof window.electron !== "undefined") {
      try {
        console.log(`[IFC] Dropped electron file "${electronPath}"...`);
        await viewer.loadIfcPath(electronPath);
      } catch (err) {
        console.error("[IFC] Failed to load dropped electron path:", err);
        const msg = (err as Error).message || String(err);
        toast(msg, "error", 8000);
      }
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
    try {
      console.log(
        `[IFC] Dropped file "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} MB)...`,
      );
      await viewer.loadIfc(file);
    } catch (err) {
      console.error("[IFC] Failed to load dropped file:", err);
      const msg = (err as Error).message || String(err);
      toast(msg, "error", 8000);
      const nameEl = document.getElementById("model-name");
      const countEl = document.getElementById("model-count");
      const progress = document.getElementById("progress");
      if (nameEl) {
        nameEl.textContent = "Failed to load model";
        nameEl.classList.add("muted");
      }
      if (countEl) countEl.textContent = `(${msg})`;
      if (progress) progress.classList.add("hidden");
      placeholder.classList.add("empty");
      placeholder.textContent =
        "Drop an .ifc file here, or click Open to choose one.";
    } finally {
      document.body.style.cursor = "";
    }
  });
}
