import type { Viewer } from "../viewer";

export function mountClipper(viewer: Viewer): void {
  const root = document.getElementById("clipper")!;
  root.style.display = "none";

  let enabled = false;
  let min = 0;
  let max = 1;

  viewer.onModelLoaded.on(() => {
    const r = viewer.getModelHeightRange();
    if (!r) return;
    min = r.min;
    max = r.max;
    enabled = false;
    root.style.display = "flex";
    render();
  });
  viewer.onModelUnloaded.on(() => {
    root.style.display = "none";
    enabled = false;
    viewer.setClippingPlane(false);
  });

  function render() {
    root.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "mini";
    btn.textContent = enabled ? "Clip: ON" : "Clip: OFF";
    btn.addEventListener("click", () => {
      enabled = !enabled;
      viewer.setClippingPlane(enabled, (min + max) / 2);
      render();
    });
    root.appendChild(btn);

    if (enabled) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String((max - min) / 200);
      slider.value = String((min + max) / 2);
      slider.style.width = "180px";
      slider.addEventListener("input", () => {
        viewer.setClippingPlane(true, parseFloat(slider.value));
      });
      root.appendChild(slider);
    }
  }
}
