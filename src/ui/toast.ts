export function toast(message: string, kind: "error" | "info" = "error", ms = 4000): void {
  const host = document.getElementById("toast-host")!;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
