const { appendFileSync, existsSync, watch } = require("node:fs");
const { join } = require("node:path");
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
