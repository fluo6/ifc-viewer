import type { Viewer } from "../viewer";

export function mountKeybindings(viewer: Viewer): void {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
    ) {
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "z" || e.key === "Z" || e.key === "Home") {
      e.preventDefault();
      void viewer.zoomToFit(true);
    } else if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      void viewer.fitToSelection();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      viewer.resetCamera();
    } else if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      viewer.setMeasureMode(!viewer.isMeasureMode());
    } else if (e.key === "g" || e.key === "G") {
      e.preventDefault();
      viewer.setGridVisible(!viewer.isGridVisible());
    } else if (e.key === "b" || e.key === "B") {
      e.preventDefault();
      viewer.setBackEdges(!viewer.backEdgesOn());
    } else if (e.key === "x" || e.key === "X") {
      e.preventDefault();
      void viewer.setXray(!viewer.xrayOn());
    }
  });
}
