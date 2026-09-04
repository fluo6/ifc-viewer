import { type Viewer, LARGE_IFC_THRESHOLD_BYTES } from "../viewer";
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
    const electronPath = (file as any).path as string | undefined;
    if (electronPath && typeof window.electron !== "undefined") {
      try {
        await viewer.loadIfcPath(electronPath);
      } catch (err) {
        toast((err as Error).message);
      }
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
}
