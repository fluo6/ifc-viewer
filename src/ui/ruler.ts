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
  viewer.onMeasureSnapChanged.on(render);

  // The canvas, not #viewport: the dropzone, clipper and ruler overlays are all
  // children of #viewport, so listening there would drop a measurement point
  // every time the user clicked this bar's own buttons.
  const canvas = document.querySelector("#viewport canvas");
  const viewport = document.getElementById("viewport");

  // Orbiting fires a click too: press, drag, release on the canvas all dispatch
  // click, so without a movement threshold an orbit drops a phantom point and
  // every later click is off by one. OBF.Highlighter guards the same case with
  // the same 5px threshold.
  const DRAG_THRESHOLD_PX = 5;
  let pressedAt: { x: number; y: number } | null = null;

  canvas?.addEventListener("pointerdown", (e) => {
    const ev = e as PointerEvent;
    pressedAt = { x: ev.clientX, y: ev.clientY };
  });

  canvas?.addEventListener("click", async (e) => {
    const ev = e as MouseEvent;
    const from = pressedAt;
    pressedAt = null;
    if (!viewer.isMeasureMode()) return;
    if (from) {
      const dx = ev.clientX - from.x;
      const dy = ev.clientY - from.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) return;
    }
    await viewer.placeMeasurePoint();
    render();
  });

  function render() {
    const on = viewer.isMeasureMode();
    viewport?.classList.toggle("measuring", on);
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
      hint.textContent = `click two points · snap: ${
        viewer.isMeasureSnapActive() ? "vertex" : "face"
      } · Esc cancels`;
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
