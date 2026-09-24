import type { ClipAxis, ClipMode, Viewer } from "../viewer";

export function mountClipper(viewer: Viewer): void {
  const root = document.getElementById("clipper")!;
  root.style.display = "none";

  let boxPanelOpen = false;
  let boxPanel: HTMLElement | null = null;

  viewer.onModelLoaded.on(() => {
    root.style.display = "flex";
    boxPanelOpen = false;
    removeBoxPanel();
    render();
  });

  viewer.onModelUnloaded.on(() => {
    root.style.display = "none";
    boxPanelOpen = false;
    removeBoxPanel();
    viewer.clearClipping();
  });

  let isSliderInteraction = false;

  function finishSliderInteraction() {
    if (!isSliderInteraction) return;
    isSliderInteraction = false;
    render();
    if (boxPanelOpen) renderBoxPanel();
  }

  function trackSliderInteraction(slider: HTMLInputElement) {
    slider.addEventListener("pointerdown", () => {
      isSliderInteraction = true;
    });
    slider.addEventListener("keydown", () => {
      isSliderInteraction = true;
    });
    slider.addEventListener("keyup", finishSliderInteraction);
    slider.addEventListener("input", finishSliderInteraction);
    slider.addEventListener("blur", finishSliderInteraction);
  }

  window.addEventListener("pointerup", finishSliderInteraction);
  window.addEventListener("pointercancel", finishSliderInteraction);

  viewer.onClippingChanged.on(() => {
    if (isSliderInteraction || viewer.isDraggingGizmo) return;
    render();
    if (boxPanelOpen) {
      renderBoxPanel();
    }
  });

  viewer.onSelection.on(() => {
    const fitBtn = root.querySelector<HTMLButtonElement>(".box-fit-btn");
    if (fitBtn) {
      fitBtn.disabled = !viewer.getSelection();
    }
    const popoverFitBtn = boxPanel?.querySelector<HTMLButtonElement>(".popover-fit-btn");
    if (popoverFitBtn) {
      popoverFitBtn.disabled = !viewer.getSelection();
    }
  });

  function removeBoxPanel() {
    if (boxPanel) {
      boxPanel.remove();
      boxPanel = null;
    }
  }

  function render() {
    const state = viewer.getClippingState();
    root.innerHTML = "";

    // 1. Primary Toggle
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "clipper-toggle";
    toggleBtn.className = `mini ${state.enabled ? "active" : ""}`;
    toggleBtn.textContent = state.enabled ? "Clip: ON" : "Clip: OFF";
    toggleBtn.title = "Toggle clipping planes (C)";
    toggleBtn.addEventListener("click", () => {
      const nextEnabled = !state.enabled;
      if (nextEnabled) {
        const bounds = viewer.getModelBoundingBox();
        if (bounds) {
          const centerY = (bounds.min.y + bounds.max.y) / 2;
          viewer.setClippingState({
            enabled: true,
            planePos: (state as any).planePos || centerY,
          } as any);
        } else {
          viewer.setClippingState({ enabled: true });
        }
      } else {
        viewer.setClippingState({ enabled: false });
        removeBoxPanel();
        boxPanelOpen = false;
      }
    });
    root.appendChild(toggleBtn);

    if (!state.enabled) {
      removeBoxPanel();
      return;
    }

    // 2. Mode Selector (Plane | Slice | Box)
    const modeGroup = document.createElement("div");
    modeGroup.className = "btn-group mini-group";

    const modes: { id: ClipMode; label: string; title: string }[] = [
      { id: "plane", label: "Plane", title: "Single cutting plane along an axis" },
      { id: "slice", label: "Slice", title: "Two parallel planes isolating a section slab" },
      { id: "box", label: "Box", title: "3D Section Box with 6 clipping boundaries" },
    ];

    for (const m of modes) {
      const btn = document.createElement("button");
      btn.className = `mini ${state.mode === m.id ? "active" : ""}`;
      btn.textContent = m.label;
      btn.title = m.title;
      btn.addEventListener("click", () => {
        if (state.mode !== m.id) {
          if (m.id === "box") {
            boxPanelOpen = true;
          } else {
            boxPanelOpen = false;
            removeBoxPanel();
          }
          viewer.setClippingState({ mode: m.id });
        }
      });
      modeGroup.appendChild(btn);
    }
    root.appendChild(modeGroup);

    // 3. Mode-specific controls
    if (state.mode === "plane") {
      renderPlaneControls(state);
    } else if (state.mode === "slice") {
      renderSliceControls(state);
    } else if (state.mode === "box") {
      renderBoxControls(state);
    }

    // 4. Helper Toggle (eye icon)
    const helperBtn = document.createElement("button");
    helperBtn.className = `mini ${state.showHelper ? "active" : ""}`;
    helperBtn.textContent = "👁";
    helperBtn.title = "Toggle 3D clipping helper wireframes in viewport";
    helperBtn.addEventListener("click", () => {
      viewer.setClippingState({ showHelper: !state.showHelper });
    });
    root.appendChild(helperBtn);
  }


  // Helper math to avoid Three.js dependency
  function getNormal(rot: {x:number, y:number, z:number, w:number}) {
    // Rotates (0, 0, -1) by quaternion
    const x = rot.x, y = rot.y, z = rot.z, w = rot.w;
    return {
      x: -2 * (x * z + y * w),
      y: -2 * (y * z - x * w),
      z: -(1 - 2 * (x * x + y * y))
    };
  }

  function getProjectedRange(rot: {x:number, y:number, z:number, w:number}) {
    const bounds = viewer.getModelBoundingBox();
    if (!bounds) return { min: -10, max: 10 };
    const n = getNormal(rot);
    const corners = [
      {x: bounds.min.x, y: bounds.min.y, z: bounds.min.z},
      {x: bounds.max.x, y: bounds.min.y, z: bounds.min.z},
      {x: bounds.min.x, y: bounds.max.y, z: bounds.min.z},
      {x: bounds.max.x, y: bounds.max.y, z: bounds.min.z},
      {x: bounds.min.x, y: bounds.min.y, z: bounds.max.z},
      {x: bounds.max.x, y: bounds.min.y, z: bounds.max.z},
      {x: bounds.min.x, y: bounds.max.y, z: bounds.max.z},
      {x: bounds.max.x, y: bounds.max.y, z: bounds.max.z},
    ];
    let min = Infinity, max = -Infinity;
    for (const c of corners) {
      const dot = c.x * n.x + c.y * n.y + c.z * n.z;
      if (dot < min) min = dot;
      if (dot > max) max = dot;
    }
    return { min, max };
  }

  function renderPlaneControls(state: ReturnType<typeof viewer.getClippingState>) {
    const axisGroup = document.createElement("div");
    axisGroup.className = "btn-group mini-group";
    
    // X, Y, Z presets
    const presets = [
      { id: "X", rot: { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } },
      { id: "Y", rot: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 } },
      { id: "Z", rot: { x: 0, y: 0, z: 0, w: 1 } }
    ];
    
    for (const p of presets) {
      const btn = document.createElement("button");
      btn.className = "mini";
      btn.textContent = p.id;
      btn.addEventListener("click", () => {
        viewer.setClippingState({ transform: { position: state.transform.position, rotation: p.rot } } as any);
      });
      axisGroup.appendChild(btn);
    }
    root.appendChild(axisGroup);

    // Flip
    const flipBtn = document.createElement("button");
    flipBtn.className = "mini";
    flipBtn.textContent = "⇅ Flip";
    flipBtn.addEventListener("click", () => {
      const r = state.transform.rotation;
      // 180 deg around local X: w'= -x, x'= w, y'= -z, z'= y
      const flipped = { x: r.w, y: -r.z, z: r.y, w: -r.x };
      viewer.setClippingState({ transform: { position: state.transform.position, rotation: flipped } } as any);
    });
    root.appendChild(flipBtn);

    const range = getProjectedRange(state.transform.rotation);
    const n = getNormal(state.transform.rotation);
    const currentOffset = state.transform.position.x * n.x + state.transform.position.y * n.y + state.transform.position.z * n.z;

    const span = range.max - range.min || 1;
    const step = String(span / 200);

    const offsetLbl = document.createElement("label");
    offsetLbl.textContent = "Offset";
    root.appendChild(offsetLbl);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "clip-slider";
    slider.min = String(range.min);
    slider.max = String(range.max);
    slider.step = step;
    slider.value = String(currentOffset);
    trackSliderInteraction(slider);

    const valSpan = document.createElement("span");
    valSpan.className = "clip-val";
    valSpan.textContent = `${currentOffset.toFixed(2)}m`;

    slider.addEventListener("input", () => {
      const val = parseFloat(slider.value);
      valSpan.textContent = `${val.toFixed(2)}m`;
      const p = { x: n.x * val, y: n.y * val, z: n.z * val };
      viewer.setClippingState({ transform: { position: p, rotation: state.transform.rotation } } as any);
    });

    root.appendChild(slider);
    root.appendChild(valSpan);
  }

  function renderSliceControls(state: ReturnType<typeof viewer.getClippingState>) {
    renderPlaneControls(state);

    const depthLbl = document.createElement("label");
    depthLbl.textContent = "Depth";
    root.appendChild(depthLbl);

    const range = getProjectedRange(state.transform.rotation);
    const span = range.max - range.min || 1;

    const depthSlider = document.createElement("input");
    depthSlider.type = "range";
    depthSlider.className = "clip-slider clip-slider-max";
    depthSlider.min = "0.01";
    depthSlider.max = String(span);
    depthSlider.step = String(span / 200);
    depthSlider.value = String(state.sliceDepth || span / 2);
    trackSliderInteraction(depthSlider);

    const valSpan = document.createElement("span");
    valSpan.className = "clip-val";
    valSpan.textContent = `${parseFloat(depthSlider.value).toFixed(2)}m`;

    depthSlider.addEventListener("input", () => {
      const val = parseFloat(depthSlider.value);
      valSpan.textContent = `${val.toFixed(2)}m`;
      viewer.setClippingState({ sliceDepth: val } as any);
    });

    root.appendChild(depthSlider);
    root.appendChild(valSpan);
  }

  function renderBoxControls(state: ReturnType<typeof viewer.getClippingState>) {
    const panelBtn = document.createElement("button");
    panelBtn.className = `mini ${boxPanelOpen ? "active" : ""}`;
    panelBtn.textContent = `Box Controls ${boxPanelOpen ? "▴" : "▾"}`;
    panelBtn.title = "Open 3D Section Box sliders panel";
    panelBtn.addEventListener("click", () => {
      boxPanelOpen = !boxPanelOpen;
      panelBtn.textContent = `Box Controls ${boxPanelOpen ? "▴" : "▾"}`;
    panelBtn.title = "Open 3D Section Box sliders panel";
      panelBtn.classList.toggle("active", boxPanelOpen);
      if (boxPanelOpen) renderBoxPanel();
      else removeBoxPanel();
    });
    root.appendChild(panelBtn);

    const fitBtn = document.createElement("button");
    fitBtn.className = "mini box-fit-btn";
    fitBtn.textContent = "Fit Selection";
    fitBtn.disabled = !viewer.getSelection();
    fitBtn.addEventListener("click", async () => {
      const ok = await viewer.fitSectionBoxToSelection(0.4);
      if (ok && boxPanelOpen) renderBoxPanel();
    });
    root.appendChild(fitBtn);

    const resetBtn = document.createElement("button");
    resetBtn.className = "mini box-reset-btn";
    resetBtn.textContent = "Reset Box";
    resetBtn.addEventListener("click", () => {
      viewer.resetSectionBox();
      if (boxPanelOpen) renderBoxPanel();
    });
    root.appendChild(resetBtn);

    if (boxPanelOpen) renderBoxPanel();
  }

  function renderBoxPanel() {
    const state = viewer.getClippingState();
    if (!state.enabled || state.mode !== "box") {
      removeBoxPanel();
      return;
    }

    if (!boxPanel) {
      boxPanel = document.createElement("div");
      boxPanel.id = "section-box-panel";
      document.body.appendChild(boxPanel);
    }
    boxPanel.innerHTML = "";

    const header = document.createElement("div");
    header.className = "box-header";
    header.innerHTML = `<span><strong>Section Box</strong> (3D Cut)</span>`;

    const closeBtn = document.createElement("button");
    closeBtn.className = "mini box-close-btn";
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", () => {
      boxPanelOpen = false;
      removeBoxPanel();
      render();
    });
    header.appendChild(closeBtn);
    boxPanel.appendChild(header);

    const dims = [
      { id: "X", key: "x" as const },
      { id: "Y", key: "y" as const },
      { id: "Z", key: "z" as const }
    ];

    const bounds = viewer.getModelBoundingBox();
    const span = bounds ? Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) : 10;
    const step = String(span / 200);

    for (const d of dims) {
      const row = document.createElement("div");
      row.className = "box-row";

      const axisTag = document.createElement("span");
      axisTag.className = "box-axis";
      axisTag.textContent = d.id;
      row.appendChild(axisTag);

      const valSpan = document.createElement("span");
      valSpan.className = "clip-val";
      valSpan.textContent = `${(state.boxSize[d.key] || span).toFixed(2)}m`;

      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "box-slider";
      slider.min = "0.01";
      slider.max = String(span * 2);
      slider.step = step;
      slider.value = String(state.boxSize[d.key] || span);
      trackSliderInteraction(slider);

      slider.addEventListener("input", () => {
        const val = parseFloat(slider.value);
        valSpan.textContent = `${val.toFixed(2)}m`;
        const updated = { ...state.boxSize, [d.key]: val };
        viewer.setClippingState({ boxSize: updated } as any);
      });

      row.appendChild(slider);
      row.appendChild(valSpan);
      boxPanel.appendChild(row);
    }
  }
}
