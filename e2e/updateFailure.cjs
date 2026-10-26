const { appendFileSync, existsSync, watch, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");
const { DatabaseSync } = require("node:sqlite");
const { app, autoUpdater: nativeUpdater, BrowserWindow, dialog } = require("electron");
const childProcess = require("node:child_process");

const folder = process.env.INCARNAMIND_TEST_UPDATE_FOLDER;
const first = process.env.INCARNAMIND_TEST_UPDATE_FIRST === "1";
const appFolder = process.env.INCARNAMIND_TEST_UPDATE_APP;
const scenario = process.env.INCARNAMIND_TEST_UPDATE_SCENARIO;
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
if (!process.env.INCARNAMIND_PACKAGED_APP) {
  Object.defineProperty(app, "isPackaged", { value: true });
  Object.defineProperty(process, "resourcesPath", { value: join(appFolder, "resources") });
}
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
const fromApp = createRequire(
  join(process.env.INCARNAMIND_PACKAGED_APP ? app.getAppPath() : appFolder, "package.json"),
);
const { autoUpdater } = fromApp("electron-updater");
record("start", {
  first,
  args: process.argv,
  executable: process.execPath,
  packaged: app.isPackaged,
  successor: process.env.INCARNAMIND_TEST_UPDATE_SUCCESSOR === "1",
});
app.on("browser-window-created", (_event, window) => {
  record("window-created");
  window.webContents.on("did-finish-load", () => {
    window.setContentSize(1280, 660);
    record("window-loaded", { url: window.webContents.getURL() });
  });
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
  if (scenario) {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(join(folder, "dismiss-problem"))) Atomics.wait(pause, 0, 0, 5);
  }
  return 0;
};
const relaunch = app.relaunch.bind(app);
app.relaunch = (options) => {
  record("relaunch", { options, dataHeld: dataHeld() });
  relaunch(options);
};
autoUpdater.quitAndInstall = () => {
  if (scenario) {
    record("install-requested", { dataHeld: dataHeld() });
    writeFileSync(join(folder, "install-requested"), "");
    if (scenario === "pending") return;
    if (scenario === "base-error" || scenario === "squirrel-error") {
      if (scenario === "squirrel-error") {
        for (const window of BrowserWindow.getAllWindows()) window.close();
        record("windows-closed");
      }
      afterFile("fail", () => {
        record("installer-error", { dataHeld: dataHeld() });
        autoUpdater.emit("error", new Error("The local installer fixture failed."));
      });
      return;
    }
    if (scenario !== "installing") throw new Error(`Unknown install scenario: ${scenario}`);
    nativeUpdater.emit("before-quit-for-update");
    record("native-install-begun", { dataHeld: dataHeld() });
    writeFileSync(join(folder, "installing"), "");
    afterFile("start-successor", () => {
      const args = successorArgs();
      if (process.platform !== "linux") {
        if (process.platform === "win32") args.push("--updated");
        app.relaunch({ args });
        return;
      }
      const env = {
        ...process.env,
        INCARNAMIND_TEST_UPDATE_SUCCESSOR: "1",
        APPIMAGE_SILENT_INSTALL: "true",
      };
      childProcess.spawn(process.execPath, args, { env, detached: true, stdio: "ignore" }).unref();
    });
    afterFile("finish-install", () => app.quit());
    return;
  }
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
  const watcher = watch(folder, () => {
    if (!existsSync(join(folder, "fail"))) return;
    watcher.close();
    fail();
  });
  writeFileSync(join(folder, "installing"), "");
};
app.on("quit", () => record("quit"));

function afterFile(name, use) {
  const file = join(folder, name);
  if (existsSync(file)) return use();
  const watcher = watch(folder, () => {
    if (!existsSync(file)) return;
    watcher.close();
    use();
  });
}

function successorArgs() {
  return process.argv
    .slice(1)
    .map((arg) =>
      arg.startsWith("--remote-debugging-port=")
        ? `--remote-debugging-port=${process.env.INCARNAMIND_TEST_UPDATE_NEXT_PORT}`
        : arg,
    );
}

if (scenario === "pending" && first) {
  afterFile("ordinary-quit", () => {
    app.once("before-quit", () => {
      record("activate-during-quit");
      app.emit("activate", {}, false);
    });
    app.quit();
  });
}
for (const kind of ["before-quit", "will-quit"]) app.on(kind, () => record(kind));
