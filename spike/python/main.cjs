// The spike's Electron main process (#444): a hidden window shaped like the meeting capture
// window, in a session of its own where every request but the bundled files' scheme is
// cancelled, runs Python in a module Worker; the probes below try to get out, and the numbers
// are written to results/. Run it with run.mjs, which starts it twice (storage across runs).
const { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } = require("node:fs");
const { join, extname, normalize } = require("node:path");
const { tmpdir } = require("node:os");
const { app, BrowserWindow, ipcMain, net, protocol, session } = require("electron");

const SCHEME = "pyspike";
const RUN = Number(process.argv.find((arg) => arg.startsWith("--run="))?.slice(6) ?? 1);
const ROWS = [20_000, 50_000];
const here = __dirname;
const results = join(here, "results");
const CSP = [
  "default-src 'none'",
  `script-src ${SCHEME}: 'wasm-unsafe-eval'`,
  `worker-src ${SCHEME}:`,
  `connect-src ${SCHEME}:`,
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".whl": "application/zip",
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.setPath("userData", join(tmpdir(), `incarnamind-pyspike-${process.pid}`));
app.disableHardwareAcceleration();

/** Every request outside the bundled files, as the session saw it before cancelling it. */
const blocked = [];
const navigations = [];
const windows = [];
const downloads = [];

function prepareSession() {
  const ses = session.fromPartition("pyspike", { cache: false });
  ses.protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const file = normalize(join(here, decodeURIComponent(pathname)));
    const inside = file.startsWith(join(here, "dist")) || file.startsWith(join(here, "page"));
    if (!inside || !existsSync(file) || statSync(file).isDirectory()) {
      return new Response("not found", { status: 404 });
    }
    return new Response(readFileSync(file), {
      headers: {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-security-policy": CSP,
      },
    });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith(`${SCHEME}:`)) return callback({});
    blocked.push(details.url);
    callback({ cancel: true });
  });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event, item) => {
    downloads.push(item.getFilename());
    event.preventDefault();
  });
  return ses;
}

function openWindow(ses) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      preload: join(here, "preload.cjs"),
    },
  });
  window.webContents.on("will-navigate", (event, url) => {
    navigations.push(url);
    event.preventDefault();
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.url.startsWith(`${SCHEME}:`)) {
      navigations.push(event.url);
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    windows.push(url);
    return { action: "deny" };
  });
  return window;
}

let window;
let nextRequest = 0;
const waiting = new Map();
ipcMain.on("spike:reply", (_event, requestId, reply) => {
  waiting.get(requestId)?.(reply);
  waiting.delete(requestId);
});

function ask(request, timeoutMs = 60_000) {
  const requestId = ++nextRequest;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      resolve({ ok: false, timedOut: true });
    }, timeoutMs);
    waiting.set(requestId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    window.webContents.send("spike:request", { ...request, requestId });
  });
}

/** The renderer's memory now, in MB: the page and its Worker share its process. */
function rendererMemory() {
  const pid = window.webContents.getOSProcessId();
  const metric = app.getAppMetrics().find((each) => each.pid === pid);
  return metric ? Math.round(metric.memory.workingSetSize / 1024) : null;
}

/** Runs `work`, sampling the renderer's memory every 50 ms; resolves to its result and the peak. */
async function sampled(work) {
  let peak = rendererMemory() ?? 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, rendererMemory() ?? 0);
  }, 50);
  const result = await work();
  clearInterval(timer);
  return { result, peakMb: Math.max(peak, rendererMemory() ?? 0) };
}

/** A probe, with the requests it made that the session cancelled. */
async function probe(request, timeoutMs) {
  const before = blocked.length;
  const reply = await ask(request, timeoutMs);
  // A cancelled request is reported a moment after the call fails.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { ...reply, cancelled: blocked.slice(before) };
}

const python = (code, timeoutMs, globals) => probe({ kind: "python", code, globals }, timeoutMs);

const PYTHON_ESCAPES = {
  jsNames: `import js
{name: hasattr(js, name) for name in ["process", "require", "Buffer", "electron", "spikeBridge", "importScripts"]}`,
  jsEval: `import js
js.eval("typeof process")`,
  jsFunction: `import js
js.Function.new("return typeof process")()`,
  ffiGlobals: `from pyodide.ffi import JsProxy
import js
[name for name in ("process", "require", "electron", "spikeBridge") if getattr(js.globalThis, name, None) is not None]`,
  listRoot: `import os
sorted(os.listdir("/"))`,
  readHosts: `open("/etc/hosts").read()[:40]`,
  readHome: `import os
open(os.path.expanduser("~/.ssh/id_rsa")).read()[:10]`,
  readWindows: `open("C:/Windows/win.ini").read()[:40]`,
  writeTmp: `open("/tmp/pyspike-marker.txt", "w").write("left by the first run")
open("/tmp/pyspike-marker.txt").read()`,
  urllib: `import urllib.request
urllib.request.urlopen("https://example.com/", timeout=5).status`,
  socket: `import socket
connection = socket.create_connection(("example.com", 80), 3)
connection.sendall(b"GET / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n")
reply = connection.recv(64)
f"received {len(reply)} bytes: {reply[:12]!r}"`,
  pyfetch: `from pyodide.http import pyfetch
(await pyfetch("https://example.com/")).status`,
  micropip: `import micropip
"imported"`,
  loadMicropip: `import pyodide_js
await pyodide_js.loadPackage("micropip")
import micropip
"loaded"`,
  subprocess: `import subprocess
subprocess.run(["ls"]).returncode`,
};

const JS_PROBES = [
  "typeofs",
  "eval",
  "newFunction",
  "importNodeFs",
  "importWeb",
  "importScriptsWeb",
  "fetch",
  "fetchDns",
  "fetchFile",
  "xhr",
  "webSocket",
  "eventSource",
  "webTransport",
];

const PAGE_PROBES = ["typeofs", "fetch", "image", "css", "formPost", "navigate", "windowOpen", "download"];

/** A sheet of revenue by region, quarter and product, `rows` long, as CSV. */
function sheet(rows) {
  const regions = ["North", "South", "East", "West", "Central", "Coast", "Hills", "Islands"];
  const quarters = [];
  for (const year of [2024, 2025, 2026]) for (const q of [1, 2, 3, 4]) quarters.push(`${year}Q${q}`);
  const lines = ["region,quarter,product,revenue"];
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let row = 0; row < rows; row++) {
    lines.push(
      `${regions[row % regions.length]},${quarters[Math.floor(random() * quarters.length)]},P${row % 20},${(random() * 10_000).toFixed(2)}`,
    );
  }
  return lines.join("\n");
}

const GROUP_BY = `import io, time
import pandas as pd
started = time.perf_counter()
frame = pd.read_csv(io.StringIO(CSV))
parsed = time.perf_counter()
by_quarter = frame.groupby(["region", "quarter"], as_index=False)["revenue"].sum()
by_quarter = by_quarter.sort_values(["region", "quarter"])
by_quarter["growth"] = by_quarter.groupby("region")["revenue"].pct_change()
fastest = by_quarter.groupby("region")["growth"].mean().sort_values(ascending=False).head(3)
done = time.perf_counter()
{"rows": len(frame), "groups": len(by_quarter), "parse_ms": round((parsed - started) * 1000), "groupby_ms": round((done - parsed) * 1000), "fastest": list(fastest.index)}`;

async function firstRun(report, ses) {
  report.control = {};
  try {
    report.control.mainProcessFetch = (await net.fetch("https://example.com/")).status;
  } catch (error) {
    report.control.mainProcessFetch = String(error);
  }
  // The session's own cancelling, under the page's Content-Security-Policy, which stops the probes first.
  const before = blocked.length;
  try {
    report.control.sandboxSessionFetch = (await ses.fetch("https://example.com/")).status;
  } catch (error) {
    report.control.sandboxSessionFetch = String(error);
  }
  report.control.sandboxSessionCancelled = blocked.slice(before);
  report.memory = { beforeBootMb: rendererMemory() };

  const boot = await probe({ kind: "boot" }, 120_000);
  report.coldStart = { ...boot, windowToReadyMs: Math.round(performance.now() - report.windowOpenedAt) };
  report.memory.atRestMb = rendererMemory();
  report.memory.wasmMb = boot.memory;

  report.performance = {};
  for (const rows of ROWS) {
    const csv = sheet(rows);
    const { result, peakMb } = await sampled(() => python(GROUP_BY, 120_000, { CSV: csv }));
    report.performance[`groupBy${rows}`] = { ...result, peakMb };
  }

  const warm = await probe({ kind: "page", name: "restartWorker" }, 120_000);
  report.warmStart = warm;
  report.memory.afterWarmStartMb = rendererMemory();

  report.escape = {};
  for (const [name, code] of Object.entries(PYTHON_ESCAPES)) {
    report.escape[`python.${name}`] = await python(code, 20_000);
  }
  for (const name of JS_PROBES) {
    report.escape[`worker.${name}`] = await probe({ kind: "js", name }, 20_000);
  }
  for (const name of PAGE_PROBES) {
    report.escape[`page.${name}`] = await probe({ kind: "page", name }, 20_000);
  }
  report.escape["host.tmpMarkerOnDisk"] = existsSync("/tmp/pyspike-marker.txt");

  report.storage = {
    page: await probe({ kind: "page", name: "storageWrite" }),
    worker: await probe({ kind: "js", name: "indexedDbWrite" }),
  };

  report.limits = {};
  const loop = await python("while True:\n    pass", 3_000);
  const loopRecovery = await probe({ kind: "page", name: "restartWorker" }, 120_000);
  const afterLoop = await python("1 + 1", 10_000);
  report.limits.endlessLoop = { reply: loop, recoveryMs: Math.round(loopRecovery.value?.ms ?? -1), after: afterLoop.value };

  const { result: oom, peakMb } = await sampled(() =>
    python(
      `chunks = []
try:
    while True:
        chunks.append(bytearray(128 * 1024 * 1024))
except MemoryError:
    held = len(chunks) * 128
    chunks.clear()
    result = f"MemoryError after {held} MB"
result`,
      120_000,
    ),
  );
  const afterOom = await python("1 + 1", 10_000);
  report.limits.outOfMemory = { reply: oom, peakMb, after: afterOom, windowAlive: !window.isDestroyed() && !window.webContents.isCrashed() };
}

async function secondRun(report) {
  await probe({ kind: "boot" }, 120_000);
  report.storage = {
    page: await probe({ kind: "page", name: "storageRead" }),
    worker: await probe({ kind: "js", name: "indexedDbRead" }),
    python: await python(`import os
os.path.exists("/tmp/pyspike-marker.txt")`),
  };
}

app.whenReady().then(async () => {
  const report = { run: RUN, platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome };
  const ses = prepareSession();
  report.windowOpenedAt = performance.now();
  window = openWindow(ses);
  const ready = new Promise((resolve) => ipcMain.once("spike:ready", (_event, facts) => resolve(facts)));
  await window.loadURL(`${SCHEME}://app/page/index.html`);
  report.renderer = await ready;
  try {
    if (RUN === 1) await firstRun(report, ses);
    else await secondRun(report);
  } catch (error) {
    report.failure = String(error?.stack ?? error);
  }
  report.blocked = blocked;
  report.navigations = navigations;
  report.windows = windows;
  report.downloads = downloads;
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, `${process.platform}-run${RUN}.json`), JSON.stringify(report, null, 2));
  app.exit(0);
});
