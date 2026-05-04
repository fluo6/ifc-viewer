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

    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      void viewer.fitToSelection();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      viewer.resetCamera();
    }
  });
}
