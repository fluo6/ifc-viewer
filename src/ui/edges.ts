import type { Viewer } from "../viewer";

/**
 * Outline rendering toggle.
 *
 * Unlike the clipper this stays mounted with no model loaded and keeps its
 * state across loads: edges are a display preference, not an operation on a
 * particular model.
 */
export function mountEdges(viewer: Viewer): void {
  const root = document.getElementById("edges")!;

  const btn = document.createElement("button");
  btn.className = "mini";
  btn.addEventListener("click", () => {
    viewer.setEdges(!viewer.edgesOn());
    render();
  });
  root.appendChild(btn);
  render();

  function render() {
    btn.textContent = viewer.edgesOn() ? "Edges: ON" : "Edges: OFF";
  }
}
