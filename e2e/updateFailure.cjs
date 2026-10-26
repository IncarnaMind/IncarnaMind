const { appendFileSync, existsSync, watch, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");
const { DatabaseSync } = require("node:sqlite");
const { app, BrowserWindow, dialog } = require("electron");
const childProcess = require("node:child_process");

const folder = process.env.INCARNAMIND_TEST_UPDATE_FOLDER;
const first = process.env.INCARNAMIND_TEST_UPDATE_FIRST === "1";
const appFolder = process.env.INCARNAMIND_TEST_UPDATE_APP;
delete process.env.INCARNAMIND_TEST_UPDATE_FIRST;

const dataHeld = () => {
  const db = new DatabaseSync(join(process.env.INCARNAMIND_DATA_DIR, "instance.owner"));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN");
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return false;
  } catch (error) {
    if (error.errcode % 256 === 5) return true;
    throw error;
  } finally {
    db.close();
  }
};
const record = (kind, extra = {}) =>
  appendFileSync(
    join(folder, "events.jsonl"),
    `${JSON.stringify({ kind, pid: process.pid, native: app.hasSingleInstanceLock(), ...extra })}\n`,
  );

// Only the external updater/signature and native dialogs are fixtures; the built main owns quitting and locks.
Object.defineProperty(app, "isPackaged", { value: true });
Object.defineProperty(process, "resourcesPath", { value: join(appFolder, "resources") });
const execFile = childProcess.execFile;
childProcess.execFile = (file, args, ...rest) => {
  if (file === "/usr/bin/codesign" && args[0] === "--display") {
    rest.at(-1)(null, "", "Authority=Developer ID Application: fixture");
    return;
  }
  return execFile(file, args, ...rest);
};
childProcess.execFile[Symbol.for("nodejs.util.promisify.custom")] =
  execFile[Symbol.for("nodejs.util.promisify.custom")];
const fromApp = createRequire(join(appFolder, "package.json"));
const { autoUpdater } = fromApp("electron-updater");
record("start", { first, args: process.argv });
app.on("browser-window-created", (_event, window) => {
  record("window-created");
  window.webContents.on("did-finish-load", () =>
    record("window-loaded", { url: window.webContents.getURL() }),
  );
});
autoUpdater.checkForUpdates = async () => {
  if (!first) return null;
  return {
    isUpdateAvailable: true,
    updateInfo: { version: "0.1.0-fixture" },
    downloadPromise: new Promise((resolve) => {
      if (existsSync(join(folder, "begin"))) return resolve();
      const watcher = watch(folder, () => {
        if (!existsSync(join(folder, "begin"))) return;
        watcher.close();
        resolve();
      });
    }),
  };
};
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
dialog.showErrorBox = (title, content) =>
  record("startup-problem", { title, content, ready: app.isReady(), dataHeld: dataHeld() });
dialog.showMessageBoxSync = (options) => {
  record("problem", {
    options,
    dataHeld: dataHeld(),
    visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  });
  return 0;
};
const relaunch = app.relaunch.bind(app);
app.relaunch = (options) => {
  record("relaunch", { options, dataHeld: dataHeld() });
  relaunch(options);
};
autoUpdater.quitAndInstall = () => {
  if (process.env.INCARNAMIND_TEST_UPDATE_SUCCEEDS === "1") {
    const delay = Number(process.env.INCARNAMIND_TEST_UPDATE_QUIT_DELAY ?? "0");
    if (delay > 0) {
      app.releaseSingleInstanceLock();
      app.once("will-quit", () => {
        record("quit-delayed", { dataHeld: dataHeld() });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      });
    }
    record("install", { dataHeld: dataHeld() });
    writeFileSync(join(folder, "installing"), "");
    if (process.platform === "linux" || delay > 0) {
      childProcess
        .spawn(
          process.execPath,
          process.argv
            .slice(1)
            .map((arg) =>
              arg.startsWith("--remote-debugging-port=")
                ? `--remote-debugging-port=${process.env.INCARNAMIND_TEST_UPDATE_NEXT_PORT}`
                : arg,
            ),
          {
            env: process.env,
            detached: true,
            stdio: "ignore",
          },
        )
        .unref();
    } else app.relaunch({ args: process.argv.slice(1) });
    app.quit();
    return;
  }
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  app.emit("before-quit", event);
  record("install", { dataHeld: dataHeld(), prevented: event.defaultPrevented });
  const fail = () => {
    record("installer-error", { dataHeld: dataHeld() });
    autoUpdater.emit("error", new Error("The local installer fixture failed."));
  };
  if (process.platform === "linux") {
    const watcher = watch(folder, () => {
      if (!existsSync(join(folder, "fail"))) return;
      watcher.close();
      fail();
    });
  } else app.once("second-instance", () => setImmediate(fail));
  writeFileSync(join(folder, "installing"), "");
};
app.on("quit", () => record("quit"));
