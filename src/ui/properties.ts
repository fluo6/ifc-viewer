import type { Viewer } from "../viewer";

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
    const direct = await viewer.getProperties(sel.expressId);
    const psets = await viewer.getPropertySets(sel.expressId);
    root.innerHTML = "";
    root.appendChild(renderHeader(sel.expressId, direct));
    root.appendChild(renderDirect(direct));
    for (const pset of psets) root.appendChild(renderPset(pset));
  });

  function reset() {
    root.innerHTML = `<div class="muted" style="padding:8px">Click an element to inspect.</div>`;
  }
}

function renderHeader(
  expressId: number,
  direct: Record<string, unknown> | null,
): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText =
    "padding:8px;border-bottom:1px solid #30363d;margin-bottom:6px";
  const type = (direct as any)?.type ?? "Element";
  const name = (direct as any)?.Name?.value ?? "(unnamed)";
  el.innerHTML = `<div style="color:#c9d1d9;font-weight:600">${escape(String(name))}</div>
                  <div class="muted">#${expressId} · ${escape(String(type))}</div>`;
  return el;
}

function renderDirect(direct: Record<string, unknown> | null): HTMLElement {
  const el = document.createElement("details");
  el.open = true;
  el.innerHTML = `<summary>Attributes</summary>`;
  const body = document.createElement("div");
  body.style.cssText = "padding:4px 12px";
  if (direct) {
    for (const [k, v] of Object.entries(direct)) {
      if (k === "expressID" || k === "type") continue;
      const val = (v as any)?.value ?? v;
      if (val === null || typeof val === "object") continue;
      body.appendChild(row(k, String(val)));
    }
  }
  el.appendChild(body);
  return el;
}

function renderPset(pset: {
  name: string;
  props: Record<string, unknown>;
}): HTMLElement {
  const el = document.createElement("details");
  el.innerHTML = `<summary>${escape(pset.name)}</summary>`;
  const body = document.createElement("div");
  body.style.cssText = "padding:4px 12px";
  for (const [k, v] of Object.entries(pset.props)) {
    body.appendChild(row(k, v == null ? "—" : String(v)));
  }
  el.appendChild(body);
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
