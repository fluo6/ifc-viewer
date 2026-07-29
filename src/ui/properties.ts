import type { ElementParameters, ParamGroup, Viewer } from "../viewer";

export function mountProperties(viewer: Viewer): void {
  const root = document.getElementById("properties")!;
  reset();

  viewer.onModelUnloaded.on(reset);

  viewer.onSelection.on(async (sel) => {
    if (!sel) {
      reset();
      return;
    }
    root.innerHTML = `<div class="muted" style="padding:8px">loading…</div>`;

    // Preferred path: the raw-IFC reader, which sees the geometry
    // representation (profile dimensions, extrusion, placement) that the
    // fragments' property store drops.
    const params = viewer.getElementParameters(sel.expressId);
    if (params) {
      root.innerHTML = "";
      root.appendChild(renderHeader(params.expressId, params.name, params.ifcClass));
      for (const group of params.groups) root.appendChild(renderGroup(group));
      return;
    }

    // Fallback: fragments-only properties (streamed models).
    const direct = await viewer.getProperties(sel.expressId);
    const psets = await viewer.getPropertySets(sel.expressId);
    root.innerHTML = "";
    root.appendChild(
      renderHeader(
        sel.expressId,
        String((direct as any)?.Name?.value ?? "(unnamed)"),
        String((direct as any)?.type ?? "Element"),
      ),
    );
    root.appendChild(renderDirect(direct));
    for (const pset of psets) {
      root.appendChild(
        renderGroup({
          name: pset.name,
          rows: Object.entries(pset.props).map(([label, value]) => ({
            label,
            value: value == null ? "—" : String(value),
          })),
        }),
      );
    }
    if (!direct && !psets.length) {
      root.appendChild(note("No parameters available for this element."));
    }
  });

  function reset() {
    root.innerHTML = `<div class="muted" style="padding:8px">Click an element to inspect.</div>`;
  }
}

function renderHeader(
  expressId: number,
  name: string,
  ifcClass: string,
): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText =
    "padding:8px;border-bottom:1px solid #30363d;margin-bottom:6px";
  el.innerHTML = `<div style="color:#c9d1d9;font-weight:600">${escape(name)}</div>
                  <div class="muted">#${expressId} · ${escape(ifcClass)}</div>`;
  return el;
}

function renderGroup(group: ParamGroup): HTMLElement {
  const el = document.createElement("details");
  el.open = group.open !== false;
  el.innerHTML = `<summary>${escape(group.name)}</summary>`;
  const body = document.createElement("div");
  body.style.cssText = "padding:4px 12px";
  for (const { label, value } of group.rows) {
    body.appendChild(row(label, value));
  }
  el.appendChild(body);
  return el;
}

function renderDirect(direct: Record<string, unknown> | null): HTMLElement {
  const rows: Array<{ label: string; value: string }> = [];
  if (direct) {
    for (const [k, v] of Object.entries(direct)) {
      if (k === "expressID" || k === "type") continue;
      const val = (v as any)?.value ?? v;
      if (val === null || typeof val === "object") continue;
      rows.push({ label: k, value: String(val) });
    }
  }
  return renderGroup({ name: "Attributes", rows });
}

function note(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "muted";
  el.style.cssText = "padding:8px";
  el.textContent = text;
  return el;
}

function row(k: string, v: string): HTMLElement {
  const r = document.createElement("div");
  r.style.cssText =
    "display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-size:11px";
  r.innerHTML = `<span class="muted">${escape(k)}</span><span style="color:#c9d1d9;text-align:right;word-break:break-word">${escape(v)}</span>`;
  return r;
}

function escape(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}
