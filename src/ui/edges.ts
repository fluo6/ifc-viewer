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

  const edgesBtn = document.createElement("button");
  edgesBtn.id = "edges-toggle";
  edgesBtn.className = "mini";
  edgesBtn.addEventListener("click", () => {
    viewer.setEdges(!viewer.edgesOn());
    render();
  });
  root.appendChild(edgesBtn);

  const hiddenLinesBtn = document.createElement("button");
  hiddenLinesBtn.id = "hidden-lines-toggle";
  hiddenLinesBtn.className = "mini";
  hiddenLinesBtn.addEventListener("click", () => {
    viewer.setHiddenLines(!viewer.hiddenLinesOn());
    render();
  });
  root.appendChild(hiddenLinesBtn);

  render();

  function render() {
    edgesBtn.textContent = viewer.edgesOn() ? "Edges: ON" : "Edges: OFF";
    hiddenLinesBtn.textContent = viewer.hiddenLinesOn()
      ? "Hidden lines: ON"
      : "Hidden lines: OFF";
  }
}
