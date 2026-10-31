// Loads Pyodide packages in a fresh module Worker of a hidden sandboxed window, under ADR-0023's CSP,
// with every request but the bundled scheme cancelled; prints timings as JSON lines.
const { readFileSync, existsSync, statSync } = require("node:fs");
const { join, extname, normalize } = require("node:path");
const { app, BrowserWindow, ipcMain, protocol, session } = require("electron");
const SCHEME = "pyprobe";
const dist = process.env.PYPROBE_DIST;
const here = __dirname;
const CSP = ["default-src 'none'", `script-src ${SCHEME}: 'wasm-unsafe-eval'`, `worker-src ${SCHEME}:`,
  `connect-src ${SCHEME}:`, "form-action 'none'", "base-uri 'none'"].join("; ");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
  ".json": "application/json", ".zip": "application/zip", ".whl": "application/zip" };
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath("userData", process.env.PYPROBE_USERDATA);
app.disableHardwareAcceleration();
const blocked = [];
app.whenReady().then(async () => {
  const ses = session.fromPartition("pyprobe", { cache: false });
  ses.protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const [, root, ...rest] = decodeURIComponent(pathname).split("/");
    const base = root === "dist" ? dist : join(here, "page");
    const file = normalize(join(base, ...rest));
    if (!file.startsWith(base) || !existsSync(file) || statSync(file).isDirectory()) return new Response("no", { status: 404 });
    return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": CSP } });
  });
  ses.webRequest.onBeforeRequest((d, cb) => { if (d.url.startsWith(`${SCHEME}:`)) return cb({}); blocked.push(d.url); cb({ cancel: true }); });
  ses.setPermissionRequestHandler((_c, _p, cb) => cb(false));
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true,
    nodeIntegration: false, preload: join(here, "preload.cjs") } });
  const pid = () => win.webContents.getOSProcessId();
  const mem = () => { const m = app.getAppMetrics().find((e) => e.pid === pid()); return m ? Math.round(m.memory.workingSetSize / 1024) : null; };
  let peak = 0; const timer = setInterval(() => { peak = Math.max(peak, mem() ?? 0); }, 50);
  ipcMain.on("probe:result", (_e, line) => { line.peakMb = peak; line.blocked = blocked.splice(0); console.log("RESULT " + JSON.stringify(line)); peak = mem() ?? 0; });
  ipcMain.on("probe:done", () => { clearInterval(timer); app.quit(); });
  await win.loadURL(`${SCHEME}://app/page/index.html`);
});
