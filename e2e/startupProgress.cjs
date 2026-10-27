const { appendFileSync, existsSync, watch } = require("node:fs");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { app, BrowserWindow, dialog } = require("electron");
const { createVisibilitySampler } = require("./lifecycleVisibility.cjs");

const folder = process.env.INCARNAMIND_TEST_STARTUP_DIR;
if (!folder) throw new Error("A lifecycle fixture folder is required.");
const mode = process.env.INCARNAMIND_TEST_STARTUP_MODE;
const record = (kind, extra = {}) =>
  appendFileSync(
    join(folder, "events.jsonl"),
    `${JSON.stringify({ kind, at: new Date().toISOString(), pid: process.pid, ...extra })}\n`,
  );

// #2104: the app's startup steps and the main thread's lag join the window's load events, so a
// start that stops before its page loads names what it was doing.
globalThis.incarnamindStartupProbe = {
  step: (name, extra = {}) => record(`main-${name}`, extra),
};
let beats = 0;
let recordedBeats = 0;
const beatStart = performance.now();
setInterval(() => {
  beats++;
  if (recordedBeats >= 240) return;
  const lagMs = Math.round(performance.now() - (beatStart + beats * 250));
  if (lagMs >= 100 || beats % 8 === 0) {
    recordedBeats++;
    record("heartbeat", { tick: beats, lagMs });
  }
}, 250).unref();

let gone = 0;
app.on("child-process-gone", (_event, details) => {
  if (gone >= 10) return;
  gone++;
  record("child-process-gone", {
    process: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
    name: details.name,
  });
});

record("start", {
  mode,
  args: process.argv,
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  executable: process.execPath,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? null,
  },
});
const sampleVisibility = createVisibilitySampler(BrowserWindow, record);
app.whenReady().then(() => {
  record("native-ready");
  sampleVisibility();
  setImmediate(sampleVisibility);
  setInterval(sampleVisibility, 250).unref();
});

app.getPreferredSystemLanguages = () => [process.env.INCARNAMIND_TEST_STARTUP_LANGUAGE || "en"];
dialog.showErrorBox = (title, content) =>
  record("problem", {
    title,
    content,
    visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  });
app.on("browser-window-created", (_event, window) => {
  const windowId = window.id;
  record("window-created", { windowId });
  setImmediate(() => {
    if (window.isDestroyed()) return;
    record("window-main-yield", {
      windowId,
      loading: window.webContents.isLoading(),
      rendererPid: window.webContents.getOSProcessId(),
      url: window.webContents.getURL(),
    });
  });
  for (const event of ["dom-ready", "did-stop-loading"])
    window.webContents.on(event, () => record(event, { windowId }));
  window.webContents.on("preload-error", (_event, preloadPath, error) =>
    record("window-preload-error", { windowId, preloadPath, message: error.message }),
  );
  window.webContents.on("render-process-gone", (_event, details) =>
    record("window-renderer-gone", { windowId, ...details }),
  );
  for (const event of ["unresponsive", "responsive"])
    window.on(event, () => record(event, { windowId }));
  window.webContents.on("did-start-navigation", (details, url, isInPlace, isMainFrame) =>
    record("window-navigation-started", {
      windowId,
      url: details?.url ?? url,
      isSameDocument: details?.isSameDocument ?? isInPlace,
      isMainFrame: details?.isMainFrame ?? isMainFrame,
    }),
  );
  let sampled = false;
  window.webContents.on("did-start-loading", () => {
    record("window-loading", { windowId, url: window.webContents.getURL() });
    if (sampled) return;
    sampled = true;
    for (const delay of [250, 1_000, 2_500, 4_000]) {
      const due = performance.now() + delay;
      setTimeout(() => {
        if (window.isDestroyed()) return;
        let rendererPid;
        try {
          rendererPid = window.webContents.getOSProcessId();
        } catch {
          rendererPid = null;
        }
        record("renderer-sample", {
          windowId,
          dueInMs: delay,
          lateMs: Math.round(performance.now() - due),
          rendererPid,
          loading: window.webContents.isLoading(),
          crashed: window.webContents.isCrashed(),
          url: window.webContents.getURL(),
        });
      }, delay);
    }
  });
  let consoleErrors = 0;
  window.webContents.on("console-message", (details, level, message, line) => {
    const severity = details?.level ?? (level === 3 ? "error" : undefined);
    if (severity !== "error" || consoleErrors >= 20) return;
    consoleErrors++;
    record("window-console-error", {
      windowId,
      message: String(details?.message ?? message ?? "").slice(0, 300),
      url: String(details?.sourceId ?? "").slice(0, 300),
      line: details?.lineNumber ?? line,
    });
  });
  window.webContents.on("did-finish-load", () =>
    record("window-loaded", { windowId, url: window.webContents.getURL() }),
  );
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, url, isMainFrame) =>
    record("window-load-failed", { windowId, errorCode, errorDescription, url, isMainFrame }),
  );
  window.webContents.on(
    "did-fail-provisional-load",
    (_event, errorCode, errorDescription, url, isMainFrame) =>
      record("window-provisional-load-failed", {
        windowId,
        errorCode,
        errorDescription,
        url,
        isMainFrame,
      }),
  );
  window.setContentSize(1280, 660);
  window.once("ready-to-show", () => {
    record("window", { windowId: window.id, bounds: window.getContentBounds() });
    setImmediate(sampleVisibility);
  });
  window.on("closed", () => {
    record("window-closed", { windowId: window.id });
    setImmediate(sampleVisibility);
  });
});

let hidden = false;
watch(folder, () => {
  if (hidden || !existsSync(join(folder, "hide"))) return;
  hidden = true;
  for (const window of BrowserWindow.getAllWindows()) window.hide();
  record("hidden");
  sampleVisibility();
}).unref();

if (mode === "slow") {
  const ready = app.whenReady.bind(app);
  const continued = new Promise((done) => {
    const check = () => {
      if (existsSync(join(folder, "continue"))) {
        watcher.close();
        done();
      }
    };
    const watcher = watch(folder, check);
    check();
  });
  app.whenReady = () => ready().then(() => continued);
  setTimeout(() => record("delay-elapsed"), 12_000);
}

if (mode === "quitting") {
  app.once("will-quit", () => {
    record("quitting-blocked");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  const watcher = watch(folder, () => {
    if (existsSync(join(folder, "quit"))) {
      watcher.close();
      app.quit();
    }
  });
}
