const { appendFileSync, existsSync, watch } = require("node:fs");
const { join } = require("node:path");
const { app, BrowserWindow, dialog } = require("electron");

const folder = process.env.INCARNAMIND_TEST_STARTUP_DIR;
if (!folder) throw new Error("A lifecycle fixture folder is required.");
const mode = process.env.INCARNAMIND_TEST_STARTUP_MODE;
const record = (kind, extra = {}) =>
  appendFileSync(
    join(folder, "events.jsonl"),
    `${JSON.stringify({ kind, pid: process.pid, ...extra })}\n`,
  );

record("start", {
  mode,
  args: process.argv,
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  executable: process.execPath,
});
app.getPreferredSystemLanguages = () => [process.env.INCARNAMIND_TEST_STARTUP_LANGUAGE || "en"];
dialog.showErrorBox = (title, content) =>
  record("problem", {
    title,
    content,
    visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  });
app.on("browser-window-created", (_event, window) => {
  window.setContentSize(1280, 660);
  window.once("ready-to-show", () => record("window", { bounds: window.getContentBounds() }));
  window.on("show", () => record("shown", { visible: window.isVisible() }));
});

let hidden = false;
watch(folder, () => {
  if (hidden || !existsSync(join(folder, "hide"))) return;
  hidden = true;
  for (const window of BrowserWindow.getAllWindows()) window.hide();
  record("hidden");
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
