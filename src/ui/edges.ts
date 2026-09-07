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
  hiddenLinesBtn.title =
    "Hidden Line Removal (HLR): Monochrome white surfaces with solid black outlines (pen drawing style)";
  hiddenLinesBtn.addEventListener("click", () => {
    viewer.setHiddenLines(!viewer.hiddenLinesOn());
    render();
  });
  root.appendChild(hiddenLinesBtn);

  const backEdgesBtn = document.createElement("button");
  backEdgesBtn.id = "back-edges-toggle";
  backEdgesBtn.className = "mini";
  backEdgesBtn.title =
    "Toggle Dashed Back Edges for selected element (B) — shows occluded edges as dashed lines through surfaces";
  backEdgesBtn.addEventListener("click", () => {
    viewer.setBackEdges(!viewer.backEdgesOn());
    render();
  });
  root.appendChild(backEdgesBtn);

  const xrayBtn = document.createElement("button");
  xrayBtn.id = "xray-toggle";
  xrayBtn.className = "mini";
  xrayBtn.title =
    "Toggle X-Ray Transparency (X) — makes the whole model semi-transparent so interior elements are visible";
  xrayBtn.addEventListener("click", () => {
    void viewer.setXray(!viewer.xrayOn()).then(render);
  });
  root.appendChild(xrayBtn);

  // Keep button labels in sync with async changes (e.g. model load toggles xray off)
  viewer.onBackEdgesChanged.on(() => render());
  viewer.onXrayChanged.on(() => render());

  render();

  function render() {
    edgesBtn.textContent = viewer.edgesOn() ? "Edges: ON" : "Edges: OFF";
    hiddenLinesBtn.textContent = viewer.hiddenLinesOn()
      ? "Hidden lines: ON"
      : "Hidden lines: OFF";
    backEdgesBtn.textContent = viewer.backEdgesOn()
      ? "Back edges: ON"
      : "Back edges: OFF";
    xrayBtn.textContent = viewer.xrayOn() ? "X-Ray: ON" : "X-Ray: OFF";
  }
}
