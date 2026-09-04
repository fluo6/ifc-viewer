import type { Viewer } from "../viewer";

export function mountCategories(viewer: Viewer): void {
  const root = document.getElementById("categories")!;
  reset();

  viewer.onModelUnloaded.on(reset);

  viewer.onModelLoaded.on(({ categories }) => {
    root.innerHTML = "";
    const header = document.createElement("div");
    header.style.cssText =
      "padding:6px 4px;display:flex;justify-content:space-between;align-items:center";
    header.innerHTML = `<strong>Categories</strong>`;
    const showAll = document.createElement("button");
    showAll.className = "mini";
    showAll.textContent = "show all";
    header.appendChild(showAll);
    root.appendChild(header);

    showAll.addEventListener("click", async () => {
      await viewer.showAllCategories();
      for (const cb of root.querySelectorAll<HTMLInputElement>(
        "input[type=checkbox]",
      )) {
        cb.checked = true;
      }
    });

    const sorted = [...categories.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );
    for (const [name, ids] of sorted) {
      root.appendChild(renderRow(viewer, name, ids.length));
    }
  });

  function reset() {
    root.innerHTML = `<div class="muted" style="padding:8px">Load an IFC to see categories.</div>`;
  }
}

function renderRow(viewer: Viewer, name: string, count: number): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:11px";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;
  cb.addEventListener("change", async () => {
    await viewer.setCategoryVisible(name, cb.checked);
  });

  const label = document.createElement("span");
  label.textContent = `${name} (${count})`;
  label.style.cssText =
    "flex:1;color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  label.title = name;

  const isoBtn = document.createElement("button");
  isoBtn.className = "mini";
  isoBtn.textContent = "iso";
  isoBtn.title = "Isolate (hide all others)";
  isoBtn.addEventListener("click", async () => {
    await viewer.isolateCategory(name);
    const all = row.parentElement!.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]",
    );
    for (const x of all) x.checked = false;
    cb.checked = true;
  });

  row.append(cb, label, isoBtn);
  return row;
}
