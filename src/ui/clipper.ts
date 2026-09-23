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
    slider.addEventListener("change", finishSliderInteraction);
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

  function renderPlaneControls(state: ReturnType<typeof viewer.getClippingState>) {
    // Axis Buttons: X, Y, Z
    const axisGroup = document.createElement("div");
    axisGroup.className = "btn-group mini-group";
    const axes: ClipAxis[] = ["x", "y", "z"];
    for (const ax of axes) {
      const btn = document.createElement("button");
      btn.className = `mini ${(state as any).axis === ax ? "active" : ""}`;
      btn.textContent = ax.toUpperCase();
      btn.title = `Cut along ${ax.toUpperCase()} axis`;
      btn.addEventListener("click", () => {
        if ((state as any).axis !== ax) {
          viewer.setClippingState({ axis: ax } as any);
        }
      });
      axisGroup.appendChild(btn);
    }
    root.appendChild(axisGroup);

    // Flip button
    const flipBtn = document.createElement("button");
    flipBtn.className = `mini ${(state as any).inverted ? "active" : ""}`;
    flipBtn.textContent = "⇅ Flip";
    flipBtn.title = "Invert cutting normal direction";
    flipBtn.addEventListener("click", () => {
      viewer.setClippingState({ inverted: !(state as any).inverted } as any);
    });
    root.appendChild(flipBtn);

    // Position slider
    const range = { min: 0, max: 1 };
    const span = range.max - range.min || 1;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "clip-slider";
    slider.min = String(range.min);
    slider.max = String(range.max);
    slider.step = String(span / 200);
    slider.value = String((state as any).planePos);
    slider.style.width = "100px";
    trackSliderInteraction(slider);

    const valSpan = document.createElement("span");
    valSpan.className = "clip-val";
    valSpan.textContent = `${(state as any).axis.toUpperCase()}: ${(state as any).planePos.toFixed(2)}m`;

    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value);
      valSpan.textContent = `${(state as any).axis.toUpperCase()}: ${v.toFixed(2)}m`;
      viewer.setClippingState({ planePos: v } as any);
    });

    root.appendChild(slider);
    root.appendChild(valSpan);
  }

  function renderSliceControls(state: ReturnType<typeof viewer.getClippingState>) {
    // Axis Buttons: X, Y, Z
    const axisGroup = document.createElement("div");
    axisGroup.className = "btn-group mini-group";
    const axes: ClipAxis[] = ["x", "y", "z"];
    for (const ax of axes) {
      const btn = document.createElement("button");
      btn.className = `mini ${(state as any).axis === ax ? "active" : ""}`;
      btn.textContent = ax.toUpperCase();
      btn.title = `Slice along ${ax.toUpperCase()} axis`;
      btn.addEventListener("click", () => {
        if ((state as any).axis !== ax) {
          viewer.setClippingState({ axis: ax } as any);
        }
      });
      axisGroup.appendChild(btn);
    }
    root.appendChild(axisGroup);

    const range = { min: 0, max: 1 };
    const span = range.max - range.min || 1;
    const step = String(span / 200);

    // Min slider
    const minLabel = document.createElement("span");
    minLabel.className = "clip-label";
    minLabel.textContent = "Min";
    root.appendChild(minLabel);

    const minSlider = document.createElement("input");
    minSlider.type = "range";
    minSlider.className = "clip-slider clip-slider-min";
    minSlider.min = String(range.min);
    minSlider.max = String(range.max);
    minSlider.step = step;
    minSlider.value = String((state as any).sliceMin);
    minSlider.style.width = "70px";
    trackSliderInteraction(minSlider);

    const minVal = document.createElement("span");
    minVal.className = "clip-val";
    minVal.textContent = `${(state as any).sliceMin.toFixed(2)}m`;

    minSlider.addEventListener("input", () => {
      const v = parseFloat(minSlider.value);
      minVal.textContent = `${v.toFixed(2)}m`;
      viewer.setClippingState({ sliceMin: v } as any);
    });

    root.appendChild(minSlider);
    root.appendChild(minVal);

    // Max slider
    const maxLabel = document.createElement("span");
    maxLabel.className = "clip-label";
    maxLabel.textContent = "Max";
    root.appendChild(maxLabel);

    const maxSlider = document.createElement("input");
    maxSlider.type = "range";
    maxSlider.className = "clip-slider clip-slider-max";
    maxSlider.min = String(range.min);
    maxSlider.max = String(range.max);
    maxSlider.step = step;
    maxSlider.value = String((state as any).sliceMax);
    maxSlider.style.width = "70px";
    trackSliderInteraction(maxSlider);

    const maxVal = document.createElement("span");
    maxVal.className = "clip-val";
    maxVal.textContent = `${(state as any).sliceMax.toFixed(2)}m`;

    maxSlider.addEventListener("input", () => {
      const v = parseFloat(maxSlider.value);
      maxVal.textContent = `${v.toFixed(2)}m`;
      viewer.setClippingState({ sliceMax: v } as any);
    });

    root.appendChild(maxSlider);
    root.appendChild(maxVal);
  }

  function renderBoxControls(state: ReturnType<typeof viewer.getClippingState>) {
    // Popover toggle button
    const panelBtn = document.createElement("button");
    panelBtn.className = `mini ${boxPanelOpen ? "active" : ""}`;
    panelBtn.textContent = `Box Controls ${boxPanelOpen ? "▴" : "▾"}`;
    panelBtn.title = "Open 3D Section Box sliders panel";
    panelBtn.addEventListener("click", () => {
      boxPanelOpen = !boxPanelOpen;
      panelBtn.textContent = `Box Controls ${boxPanelOpen ? "▴" : "▾"}`;
      panelBtn.classList.toggle("active", boxPanelOpen);
      if (boxPanelOpen) {
        renderBoxPanel();
      } else {
        removeBoxPanel();
      }
    });
    root.appendChild(panelBtn);

    // Fit to selection button
    const fitBtn = document.createElement("button");
    fitBtn.className = "mini box-fit-btn";
    fitBtn.textContent = "Fit Selection";
    fitBtn.title = "Fit Section Box tightly around the selected element";
    fitBtn.disabled = !viewer.getSelection();
    fitBtn.addEventListener("click", async () => {
      const ok = await viewer.fitSectionBoxToSelection(0.4);
      if (ok && boxPanelOpen) {
        renderBoxPanel();
      }
    });
    root.appendChild(fitBtn);

    // Reset box button
    const resetBtn = document.createElement("button");
    resetBtn.className = "mini box-reset-btn";
    resetBtn.textContent = "Reset Box";
    resetBtn.title = "Reset Section Box to full model extents";
    resetBtn.addEventListener("click", () => {
      viewer.resetSectionBox();
      if (boxPanelOpen) {
        renderBoxPanel();
      }
    });
    root.appendChild(resetBtn);

    if (boxPanelOpen) {
      renderBoxPanel();
    }
  }

  function renderBoxPanel() {
    const state = viewer.getClippingState();
    if (!state.enabled || state.mode !== "box") {
      removeBoxPanel();
      return;
    }

    const bounds = viewer.getModelBoundingBox();
    if (!bounds) return;

    if (!boxPanel) {
      boxPanel = document.createElement("div");
      boxPanel.id = "section-box-panel";
      document.body.appendChild(boxPanel);
    }
    boxPanel.innerHTML = "";

    // Header
    const header = document.createElement("div");
    header.className = "box-header";
    header.innerHTML = `<span><strong>Section Box</strong> (3D Cut)</span>`;

    const closeBtn = document.createElement("button");
    closeBtn.className = "mini box-close-btn";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Close panel";
    closeBtn.addEventListener("click", () => {
      boxPanelOpen = false;
      removeBoxPanel();
      render();
    });
    header.appendChild(closeBtn);
    boxPanel.appendChild(header);

    // Axis rows: X, Y, Z
    const axisConfigs: {
      axis: ClipAxis;
      minKey: "x" | "y" | "z";
      modelMin: number;
      modelMax: number;
      curMin: number;
      curMax: number;
    }[] = [
      {
        axis: "x",
        minKey: "x",
        modelMin: bounds.min.x,
        modelMax: bounds.max.x,
        curMin: (state as any).boxMin.x,
        curMax: (state as any).boxMax.x,
      },
      {
        axis: "y",
        minKey: "y",
        modelMin: bounds.min.y,
        modelMax: bounds.max.y,
        curMin: (state as any).boxMin.y,
        curMax: (state as any).boxMax.y,
      },
      {
        axis: "z",
        minKey: "z",
        modelMin: bounds.min.z,
        modelMax: bounds.max.z,
        curMin: (state as any).boxMin.z,
        curMax: (state as any).boxMax.z,
      },
    ];

    for (const cfg of axisConfigs) {
      const row = document.createElement("div");
      row.className = "box-row";

      const axisTag = document.createElement("span");
      axisTag.className = "box-axis";
      axisTag.textContent = cfg.axis.toUpperCase();
      row.appendChild(axisTag);

      const span = cfg.modelMax - cfg.modelMin || 1;
      const step = String(span / 200);

      // Min slider
      const minLbl = document.createElement("label");
      minLbl.textContent = "Min";
      row.appendChild(minLbl);

      const minSlider = document.createElement("input");
      minSlider.type = "range";
      minSlider.className = "box-slider";
      minSlider.min = String(cfg.modelMin);
      minSlider.max = String(cfg.modelMax);
      minSlider.step = step;
      minSlider.value = String(cfg.curMin);
      trackSliderInteraction(minSlider);

      const minVal = document.createElement("span");
      minVal.className = "clip-val";
      minVal.textContent = `${cfg.curMin.toFixed(2)}m`;

      minSlider.addEventListener("input", () => {
        const val = parseFloat(minSlider.value);
        minVal.textContent = `${val.toFixed(2)}m`;
        const updatedMin = { ...(viewer.getClippingState() as any).boxMin, [cfg.minKey]: val };
        viewer.setClippingState({ boxMin: updatedMin } as any);
      });

      row.appendChild(minSlider);
      row.appendChild(minVal);

      // Max slider
      const maxLbl = document.createElement("label");
      maxLbl.textContent = "Max";
      row.appendChild(maxLbl);

      const maxSlider = document.createElement("input");
      maxSlider.type = "range";
      maxSlider.className = "box-slider";
      maxSlider.min = String(cfg.modelMin);
      maxSlider.max = String(cfg.modelMax);
      maxSlider.step = step;
      maxSlider.value = String(cfg.curMax);
      trackSliderInteraction(maxSlider);

      const maxVal = document.createElement("span");
      maxVal.className = "clip-val";
      maxVal.textContent = `${cfg.curMax.toFixed(2)}m`;

      maxSlider.addEventListener("input", () => {
        const val = parseFloat(maxSlider.value);
        maxVal.textContent = `${val.toFixed(2)}m`;
        const updatedMax = { ...(viewer.getClippingState() as any).boxMax, [cfg.minKey]: val };
        viewer.setClippingState({ boxMax: updatedMax } as any);
      });

      row.appendChild(maxSlider);
      row.appendChild(maxVal);

      boxPanel.appendChild(row);
    }

    // Actions in panel
    const actions = document.createElement("div");
    actions.className = "box-actions";

    const fitBtn = document.createElement("button");
    fitBtn.className = "mini popover-fit-btn";
    fitBtn.textContent = "Fit to Selection";
    fitBtn.disabled = !viewer.getSelection();
    fitBtn.addEventListener("click", async () => {
      const ok = await viewer.fitSectionBoxToSelection(0.4);
      if (ok) renderBoxPanel();
    });
    actions.appendChild(fitBtn);

    const resetBtn = document.createElement("button");
    resetBtn.className = "mini";
    resetBtn.textContent = "Reset Extents";
    resetBtn.addEventListener("click", () => {
      viewer.resetSectionBox();
      renderBoxPanel();
    });
    actions.appendChild(resetBtn);

    boxPanel.appendChild(actions);
  }
}
