const {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  watch,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");
const { DatabaseSync } = require("node:sqlite");
const { app, autoUpdater: nativeUpdater, BrowserWindow, dialog, shell } = require("electron");
const childProcess = require("node:child_process");
const { createVisibilitySampler } = require("./lifecycleVisibility.cjs");

const folder = process.env.INCARNAMIND_TEST_UPDATE_FOLDER;
const first = process.env.INCARNAMIND_TEST_UPDATE_FIRST === "1";
const appFolder = process.env.INCARNAMIND_TEST_UPDATE_APP;
const scenario = process.env.INCARNAMIND_TEST_UPDATE_SCENARIO;
if (scenario === "unreadable-record") require("./instanceUpdateRead.cjs");
const language = process.env.INCARNAMIND_TEST_UPDATE_LANGUAGE;
let nativePrepared = false;
let readyPrompts = 0;
let installRequests = 0;
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
const sampleVisibility = createVisibilitySampler(BrowserWindow, record);
shell.openExternal = async (url) => record("external-open", { url });
if (language) app.getPreferredSystemLanguages = () => [language];

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
  join(
    process.env.INCARNAMIND_PACKAGED_APP ? join(process.resourcesPath, "app.asar") : appFolder,
    "package.json",
  ),
);
const { autoUpdater } = fromApp("electron-updater");
if (scenario === "auto-quit-error" && first) {
  autoUpdater.install = (isSilent, isForceRunAfter) => {
    installRequests += 1;
    record("auto-install-on-quit", {
      isSilent,
      isForceRunAfter,
      autoDownload: autoUpdater.autoDownload,
      autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
      dataHeld: dataHeld(),
    });
    autoUpdater.emit("error", new Error("The local automatic installer fixture failed."));
    record("auto-install-failed", {
      autoDownload: autoUpdater.autoDownload,
      autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
    });
    return false;
  };
}
record("start", {
  first,
  args: process.argv,
  executable: process.execPath,
  packaged: app.isPackaged,
  successor: process.env.INCARNAMIND_TEST_UPDATE_SUCCESSOR === "1",
  debugPort: app.commandLine.getSwitchValue("remote-debugging-port"),
});
app.on("browser-window-created", (_event, window) => {
  const windowId = window.id;
  if (scenario === "target-crash" && !first) {
    record("target-before-ready-crash", {
      version: app.getVersion(),
      dataHeld: dataHeld(),
      visibleWindows: BrowserWindow.getAllWindows().filter((item) => item.isVisible()).length,
    });
    process.kill(process.pid, "SIGKILL");
    return;
  }
  window.setContentSize(1280, 660);
  record("window-created", { windowId });
  window.on("closed", () => record("window-closed", { windowId }));
  window.on("ready-to-show", () => {
    record("window-ready-to-show", { windowId });
    setImmediate(sampleVisibility);
  });
});
autoUpdater.checkForUpdates = async () => {
  if (!first) return null;
  const sha512 = Buffer.alloc(64).toString("base64");
  const updateInfo = {
    version: process.env.INCARNAMIND_TEST_UPDATE_VERSION || "0.1.0-fixture",
    files: [{ url: "fixture-installer", sha512 }],
    path: "fixture-installer",
    sha512,
  };
  if (scenario?.startsWith("pending")) {
    afterFile("prepare-native", prepareNative);
    afterFile("fail-native-preparation", () => {
      record("native-preparation-error");
      nativeUpdater.emit("error", new Error("The local native preparation fixture failed."));
    });
    afterFile("check-preparation", () => {
      setImmediate(() =>
        record("preparation-checkpoint", { nativePrepared, readyPrompts, installRequests }),
      );
    });
  }
  return {
    isUpdateAvailable: true,
    updateInfo,
    downloadPromise: new Promise((resolve) => {
      afterFile("begin", () => {
        record("wrapper-ready");
        autoUpdater.emit("update-downloaded", {
          ...updateInfo,
          downloadedFile: join(folder, "fixture-installer"),
        });
        record("wrapper-downloaded", {
          version: updateInfo.version,
          autoDownload: autoUpdater.autoDownload,
          autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
        });
        if (scenario === "auto-quit-error") {
          const { BaseUpdater } = fromApp("electron-updater/out/BaseUpdater");
          const before = app.listenerCount("quit");
          BaseUpdater.prototype.addQuitHandler.call(autoUpdater);
          record("auto-quit-listener", {
            added: app.listenerCount("quit") - before,
            autoDownload: autoUpdater.autoDownload,
            autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
          });
        }
        resolve();
        if (process.platform === "darwin" && !scenario?.startsWith("pending"))
          setImmediate(prepareNative);
      });
    }),
  };
};
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (
    options.type === "info" &&
    (options.message === "The update will finish the next time you quit IncarnaMind." ||
      options.message === "下次退出 IncarnaMind 时将完成更新。")
  ) {
    record("pending-update", {
      options,
      dataHeld: dataHeld(),
      visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
    });
    return { response: 0, checkboxChecked: false };
  }
  if (options.type === "error") {
    record("startup-problem", {
      title: options.message,
      content: options.detail,
      options,
      ready: app.isReady(),
      dataHeld: dataHeld(),
      visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
    });
    return {
      response:
        process.env.INCARNAMIND_TEST_UPDATE_REPAIR_ACTION === "download"
          ? options.defaultId
          : options.cancelId,
      checkboxChecked: false,
    };
  }
  if (options.type === "warning") {
    record("unsaved-question", { options, dataHeld: dataHeld() });
    return { response: options.cancelId, checkboxChecked: false };
  }
  readyPrompts += 1;
  record("ready-prompt", { options, nativePrepared });
  return {
    response: scenario === "auto-quit-error" ? options.cancelId : 0,
    checkboxChecked: false,
  };
};
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
  installRequests += 1;
  if (scenario) {
    record("install-requested", { dataHeld: dataHeld() });
    writeFileSync(join(folder, "install-requested"), "");
    if (scenario === "pending" || scenario === "pending-error") return;
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
    if (!["installing", "pending-install", "post-install"].includes(scenario))
      throw new Error(`Unknown install scenario: ${scenario}`);
    nativeUpdater.emit("before-quit-for-update");
    record("native-install-begun", { dataHeld: dataHeld() });
    writeFileSync(join(folder, "installing"), "");
    if (scenario !== "post-install") launchSuccessor(process.platform === "linux");
    app.once("quit", () => {
      record("install-quit-held", { dataHeld: dataHeld() });
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(join(folder, "finish-install"))) Atomics.wait(pause, 0, 0, 5);
    });
    app.quit();
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
    launchSuccessor(process.platform === "linux" || delay > 0);
    nativeUpdater.emit("before-quit-for-update");
    app.quit();
    return;
  }
  throw new Error("An install fixture needs its lifecycle scenario or a success result.");
};
app.on("quit", () => record("quit"));

function afterFile(name, use) {
  const file = join(folder, name);
  if (existsSync(file)) return use();
  let used = false;
  const consume = () => {
    if (used || !existsSync(file)) return;
    used = true;
    watcher.close();
    use();
  };
  const watcher = watch(folder, consume);
  consume();
}

function successorArgs() {
  const args = process.argv.slice(1).map((arg) => {
    if (arg === process.env.INCARNAMIND_TEST_APP_DIR)
      return process.env.INCARNAMIND_TEST_UPDATED_APP_DIR || arg;
    return arg.startsWith("--remote-debugging-port=")
      ? `--remote-debugging-port=${process.env.INCARNAMIND_TEST_UPDATE_NEXT_PORT}`
      : arg;
  });
  if (process.platform === "win32") args.push("--updated");
  return args;
}

function launchSuccessor(beforeExit) {
  const args = successorArgs();
  const executable = process.env.INCARNAMIND_PACKAGED_UPDATED_APP || process.execPath;
  const changes = {
    INCARNAMIND_TEST_UPDATE_SUCCESSOR: "1",
    ...(process.env.INCARNAMIND_TEST_UPDATED_APP_DIR && {
      INCARNAMIND_TEST_APP_DIR: process.env.INCARNAMIND_TEST_UPDATED_APP_DIR,
      INCARNAMIND_TEST_UPDATE_APP: process.env.INCARNAMIND_TEST_UPDATED_APP_DIR,
    }),
    ...(process.env.INCARNAMIND_PACKAGED_UPDATED_APP && {
      INCARNAMIND_PACKAGED_APP: process.env.INCARNAMIND_PACKAGED_UPDATED_APP,
    }),
    ...(process.platform === "linux" && { APPIMAGE_SILENT_INSTALL: "true" }),
  };
  if (beforeExit) {
    // A pipe would lose the child's later output when this installing parent exits.
    const stderr = openSync(join(folder, "early-successor.stderr.log"), "a", 0o600);
    try {
      childProcess
        .spawn(executable, args, {
          env: { ...process.env, ...changes },
          detached: true,
          stdio: ["ignore", "ignore", stderr],
        })
        .unref();
    } finally {
      closeSync(stderr);
    }
    return;
  }
  const previous = Object.fromEntries(
    Object.keys(changes).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, changes);
    app.relaunch({ args, execPath: executable });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function prepareNative() {
  nativePrepared = true;
  record("native-prepared");
  nativeUpdater.emit("update-downloaded");
}

function quitAndActivate() {
  app.once("before-quit", () => {
    record("activate-during-quit");
    app.emit("activate", {}, false);
  });
  app.quit();
}

if (scenario === "pending" && first)
  for (const name of ["ordinary-quit", "ordinary-quit-again"]) afterFile(name, quitAndActivate);
if (scenario === "auto-quit-error" && first) afterFile("ordinary-quit-reopen", quitAndActivate);
afterFile(`quit-${process.pid}`, () => app.quit());
for (const kind of ["before-quit", "will-quit"]) app.on(kind, () => record(kind));
app.whenReady().then(() => {
  record("ready", {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    version: app.getVersion(),
    dataHeld: dataHeld(),
    debugPort: app.commandLine.getSwitchValue("remote-debugging-port"),
  });
  sampleVisibility();
  setInterval(sampleVisibility, 250).unref();
});
