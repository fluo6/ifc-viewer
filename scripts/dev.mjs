import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const PORT = 5173;

function waitForPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = createConnection(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("vite never came up"));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

const vite = spawn(npx, ["vite"], { stdio: "inherit", shell: false });
const tsc = spawn(npx, ["tsc", "-p", "tsconfig.electron.json", "--watch"], {
  stdio: "inherit", shell: false,
});

await waitForPort(PORT);

await new Promise((r) => setTimeout(r, 1500));

const electron = spawn(npx, ["electron", "."], { stdio: "inherit", shell: false });

const cleanup = () => {
  vite.kill(); tsc.kill(); electron.kill();
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
electron.on("exit", cleanup);
