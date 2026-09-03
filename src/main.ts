import { Viewer } from "./viewer";
import { mountDropzone } from "./ui/dropzone";
import { mountToolbar } from "./ui/toolbar";
import { mountProperties } from "./ui/properties";
import { mountCategories } from "./ui/categories";
import { mountClipper } from "./ui/clipper";
import { mountEdges } from "./ui/edges";
import { mountRuler } from "./ui/ruler";
import { mountKeybindings } from "./ui/keybindings";
import { mountExport } from "./ui/export";

const viewport = document.getElementById("viewport")!;
const viewer = new Viewer();

void (async () => {
  try {
    await viewer.init(viewport);
  } catch (err) {
    document.body.innerHTML = `
      <div style="padding:48px;text-align:center;color:#c9d1d9;background:#0d1117;height:100vh">
        <h1 style="color:#f85149">3D engine failed to initialize</h1>
        <p style="color:#8b949e">${escape((err as Error).message)}</p>
        <p style="color:#8b949e">This usually means <code>web-ifc.wasm</code> didn't load. Check that <code>public/web-ifc.wasm</code> exists.</p>
        <button onclick="location.reload()" style="margin-top:24px;padding:8px 16px;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;cursor:pointer">Reload</button>
      </div>`;
    return;
  }
  mountDropzone(viewer);
  mountToolbar(viewer);
  mountExport(viewer);
  mountProperties(viewer);
  mountCategories(viewer);
  mountClipper(viewer);
  mountEdges(viewer);
  mountRuler(viewer);
  mountKeybindings(viewer);
  console.log("viewer ready");
})();

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

(window as any).__viewer = viewer;
