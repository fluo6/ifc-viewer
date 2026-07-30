import type { Viewer } from "../viewer";

export function mountRuler(viewer: Viewer): void {
  const root = document.getElementById("ruler")!;
  root.style.display = "none";

  viewer.onModelLoaded.on(() => {
    root.style.display = "flex";
    render();
  });

  viewer.onModelUnloaded.on(() => {
    root.style.display = "none";
  });

  // Keeps the bar in step however the mode was changed — button or `m` key.
  viewer.onMeasureModeChanged.on(render);

  // The canvas, not #viewport: the dropzone, clipper and ruler overlays are all
  // children of #viewport, so listening there would drop a measurement point
  // every time the user clicked this bar's own buttons.
  const canvas = document.querySelector("#viewport canvas");
  canvas?.addEventListener("click", () => {
    viewer.placeMeasurePoint();
    render();
  });

  function render() {
    const on = viewer.isMeasureMode();
    root.innerHTML = "";

    const toggle = document.createElement("button");
    toggle.id = "ruler-toggle";
    toggle.className = "mini";
    toggle.textContent = on ? "Measure: ON" : "Measure: OFF";
    toggle.addEventListener("click", () => viewer.setMeasureMode(!on));
    root.appendChild(toggle);

    if (on) {
      const hint = document.createElement("span");
      hint.className = "muted";
      hint.textContent = "click two points · Esc cancels";
      root.appendChild(hint);
    }

    if (viewer.measurementCount() > 0) {
      const clear = document.createElement("button");
      clear.id = "ruler-clear";
      clear.className = "mini";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => {
        viewer.clearMeasurements();
        render();
      });
      root.appendChild(clear);
    }
  }
}
