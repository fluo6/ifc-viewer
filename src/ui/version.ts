declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

export function mountVersion(): void {
  const footer = document.getElementById("footer");
  if (!footer) return;

  let versionEl = document.getElementById("version-info");
  if (!versionEl) {
    versionEl = document.createElement("div");
    versionEl.id = "version-info";
    footer.appendChild(versionEl);
  }

  const version =
    typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.1.0";
  const rawBuildTime =
    typeof __BUILD_TIME__ !== "undefined"
      ? __BUILD_TIME__
      : new Date().toISOString();

  const d = new Date(rawBuildTime);
  const pad = (n: number) => String(n).padStart(2, "0");
  const formattedTime = !isNaN(d.getTime())
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : rawBuildTime;

  versionEl.textContent = `v${version} • Built: ${formattedTime}`;
  versionEl.title = `IFC Viewer v${version} (Built: ${formattedTime})`;
}
