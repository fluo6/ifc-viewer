import { formatValue } from "../format";
import type { ElementParameters, ParamGroup, Viewer } from "../viewer";

export function mountProperties(viewer: Viewer): void {
  const root = document.getElementById("properties")!;
  // Bumped by every selection and by unload. The panel is only repainted by
  // the render that still owns the current generation -- lookups are async, so
  // without this an earlier, slower render can resolve last and repaint the
  // panel with the previously selected element.
  let generation = 0;
  reset();

  viewer.onModelUnloaded.on(() => {
    generation++;
    reset();
  });

  viewer.onSelection.on(async (sel) => {
    const mine = ++generation;
    if (!sel) {
      reset();
      return;
    }
    root.innerHTML = `<div class="muted" style="padding:8px">loading…</div>`;

    // Preferred path: the raw-IFC reader, which sees the geometry
    // representation (profile dimensions, extrusion, placement) that the
    // fragments' property store drops. Synchronous today, so it cannot be
    // superseded mid-flight -- the generation check keeps that from becoming a
    // trap if it ever grows an await.
    const params = viewer.getElementParameters(sel.expressId);
    if (params) {
      if (mine !== generation) return;
      render(params.expressId, params.name, params.ifcClass, params.groups);
      return;
    }

    // Fallback: fragments-only properties, i.e. streamed models.
    const direct = await viewer.getProperties(sel.expressId);
    const psets = await viewer.getPropertySets(sel.expressId);
    if (mine !== generation) return; // superseded while we were awaiting
    const groups: ParamGroup[] = [attributesGroup(direct)];
    for (const pset of psets) {
      groups.push({
        name: pset.name,
        rows: Object.entries(pset.props).map(([label, value]) => ({
          label,
          value: formatValue(value),
        })),
      });
    }
    render(
      sel.expressId,
      String(propertyValue(direct, "Name") ?? "(unnamed)"),
      String(direct?.type ?? "Element"),
      groups,
    );
    if (!direct && !psets.length) {
      root.appendChild(note("No parameters available for this element."));
    }
  });

  function render(
    expressId: number,
    name: string,
    ifcClass: string,
    groups: ParamGroup[],
  ) {
    root.innerHTML = "";
    root.appendChild(renderHeader(expressId, name, ifcClass));
    for (const group of groups) root.appendChild(renderGroup(group));
  }

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
  if (group.rows.length === 0) {
    // Say so rather than showing a silently empty box -- an empty section is
    // indistinguishable from a set the viewer failed to read.
    body.innerHTML = `<div class="muted">(no values)</div>`;
  }
  for (const { label, value } of group.rows) {
    body.appendChild(row(label, value));
  }
  el.appendChild(body);
  return el;
}

function attributesGroup(direct: Record<string, unknown> | null): ParamGroup {
  const rows: Array<{ label: string; value: string }> = [];
  if (direct) {
    for (const [k, v] of Object.entries(direct)) {
      if (k === "expressID" || k === "type") continue;
      const val = wrappedValue(v);
      if (val === null || typeof val === "object") continue;
      rows.push({ label: k, value: formatValue(val) });
    }
  }
  return { name: "Attributes", rows };
}

function propertyValue(
  direct: Record<string, unknown> | null,
  name: string,
): unknown {
  return direct ? wrappedValue(direct[name]) : undefined;
}

function wrappedValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("value" in value)) {
    return value;
  }
  return (value as { value: unknown }).value;
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
