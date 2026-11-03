const { appendFileSync, existsSync, watch } = require("node:fs");
const { basename, join } = require("node:path");
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
  window.webContents.on("did-start-loading", () =>
    record("window-loading", { windowId, url: window.webContents.getURL() }),
  );
  window.webContents.on("did-finish-load", () =>
    record("window-loaded", { windowId, url: window.webContents.getURL() }),
  );
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, url, isMainFrame) =>
    record("window-load-failed", { windowId, errorCode, errorDescription, url, isMainFrame }),
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

if (mode === "held-storage") {
  const sqlite = require("node:sqlite");
  const Database = sqlite.DatabaseSync;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  // As a slow disk does on a first start (#2104): the main thread stays in the content database's
  // open until the test releases it.
  sqlite.DatabaseSync = class extends Database {
    constructor(file, ...rest) {
      if (!held && basename(String(file)) === "incarnamind.db") {
        held = true;
        const windows = BrowserWindow.getAllWindows();
        record("storage-held", {
          visibleWindows: windows.filter((window) => window.isVisible()).length,
          pages: windows.map((window) => window.webContents.getURL()),
        });
        while (!existsSync(join(folder, "release"))) Atomics.wait(pause, 0, 0, 50);
      }
      super(file, ...rest);
    }
  };
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
