import type { Viewer } from "../viewer";
import { toast } from "./toast";

export function mountDropzone(viewer: Viewer): void {
  const root = document.getElementById("app")!;
  const placeholder = document.getElementById("dropzone")!;

  placeholder.classList.add("empty");
  placeholder.textContent =
    "Drop an .ifc file here, or click Open to choose one.";

  viewer.onModelLoaded.on(() => placeholder.classList.remove("empty"));
  viewer.onModelUnloaded.on(() => {
    placeholder.classList.add("empty");
    placeholder.textContent =
      "Drop an .ifc file here, or click Open to choose one.";
  });

  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

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
    if (e.target === root) placeholder.classList.remove("dragover");
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
    try {
      await viewer.loadIfc(file);
    } catch (err) {
      toast((err as Error).message);
    }
  });
}
