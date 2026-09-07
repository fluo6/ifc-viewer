import type { Viewer } from "../viewer";

/**
 * Ground grid toggle button.
 *
 * Allows toggling the ground grid on and off with visual feedback and keybinding support (G).
 */
export function mountGrid(viewer: Viewer): void {
  const root = document.getElementById("grid-controls");
  if (!root) return;

  const btn = document.createElement("button");
  btn.id = "grid-toggle";
  btn.className = "mini";
  btn.title = "Toggle Ground Grid (G)";
  btn.addEventListener("click", () => {
    viewer.setGridVisible(!viewer.isGridVisible());
  });
  root.appendChild(btn);

  viewer.onGridVisibleChanged.on(() => {
    render();
  });

  render();

  function render() {
    btn.textContent = viewer.isGridVisible() ? "Grid: ON" : "Grid: OFF";
  }
}
