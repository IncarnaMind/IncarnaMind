import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  quitAndInstall: vi.fn(),
  showMessageBox: vi.fn(),
  releaseSingleInstanceLock: vi.fn(),
  openBrowser: vi.fn(),
  signed: true,
  prepareNative: true,
  checked: Promise.withResolvers<void>(),
  wrapperDownload: Promise.resolve(),
  autoInstallAtCheck: true,
  quitListenersAtCheck: 0,
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: true,
      releaseSingleInstanceLock: fixture.releaseSingleInstanceLock,
    }),
    autoUpdater: new EventEmitter(),
    BrowserWindow: { getAllWindows: () => [] },
  };
});
vi.mock("../../src/main/autoUpdater", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    autoUpdater: Object.assign(new EventEmitter(), {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      checkForUpdates: fixture.checkForUpdates,
      quitAndInstall: fixture.quitAndInstall,
    }),
  };
});
vi.mock("../../src/main/platform", () => ({ systemBrowser: { open: fixture.openBrowser } }));
vi.mock("../../src/main/systemDialogs", () => ({ showMessageBox: fixture.showMessageBox }));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function") {
      callback(
        null,
        "",
        fixture.signed ? "Authority=Developer ID Application: fixture" : "Signature=adhoc",
      );
    }
  },
}));

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "linux" });
  vi.stubEnv("APPIMAGE", "/tmp/IncarnaMind.AppImage");
  fixture.signed = true;
  fixture.prepareNative = true;
  fixture.checked = Promise.withResolvers<void>();
  fixture.wrapperDownload = Promise.resolve();
  const { app, autoUpdater: native } = await import("electron");
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  app.removeAllListeners();
  native.removeAllListeners();
  sdk.removeAllListeners();
  sdk.autoDownload = false;
  sdk.autoInstallOnAppQuit = true;
  fixture.autoInstallAtCheck = true;
  fixture.quitListenersAtCheck = 0;
  fixture.checkForUpdates.mockImplementation(async () => {
    fixture.autoInstallAtCheck = sdk.autoInstallOnAppQuit;
    fixture.quitListenersAtCheck = app.listenerCount("quit");
    fixture.checked.resolve();
    if (fixture.prepareNative) queueMicrotask(() => native.emit("update-downloaded"));
    return {
      isUpdateAvailable: true,
      updateInfo: { version: "0.1.0-test" },
      downloadPromise: fixture.wrapperDownload,
    };
  });
});
afterEach(async () => {
  const { app, autoUpdater: native } = await import("electron");
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  app.removeAllListeners();
  native.removeAllListeners();
  sdk.removeAllListeners();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start(
  options: {
    response?: number;
    settles?: boolean;
    privacy?: boolean;
    install?: () => void;
    prepare?: (version: string, reopens: boolean) => void;
    settings?: Promise<{ language: "en" }>;
  } = {},
) {
  const asked = Promise.withResolvers<void>();
  const installed = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<void>();
  const order: string[] = [];
  fixture.showMessageBox.mockImplementation(async () => {
    order.push("ready");
    asked.resolve();
    return { response: options.response ?? 1, checkboxChecked: false };
  });
  fixture.quitAndInstall.mockImplementation(() => {
    order.push("install");
    options.install?.();
    installed.resolve();
  });
  const updater = await import("../../src/main/updater");
  const core = {
    getSettings: vi.fn(async () => options.settings ?? { language: "en" as const }),
    getPrivacySettings: vi.fn(async () => ({ automaticUpdateChecks: options.privacy ?? true })),
  };
  const settleQuit = vi.fn(async () => {
    order.push("settle");
    settled.resolve();
    return options.settles ?? true;
  });
  const failed = vi.fn((_error: unknown, _language: string) => failure.resolve());
  const started = vi.fn((reopens: boolean) => order.push(`started:${reopens}`));
  const prepared = vi.fn((version: string, reopens: boolean) => {
    order.push(`prepare:${reopens}`);
    options.prepare?.(version, reopens);
  });
  updater.startAutoUpdates(core, settleQuit, failed, started, prepared);
  return {
    updater,
    core,
    settleQuit,
    failed,
    started,
    prepared,
    order,
    asked: asked.promise,
    installed: installed.promise,
    settled: settled.promise,
    failure: failure.promise,
  };
}

async function downloaded(response: number, settles = true) {
  const run = await start({ response, settles });
  await run.asked;
  return run;
}

const checkpoint = () => new Promise<void>((resume) => setImmediate(resume));

async function quitWithLateSdkListener() {
  const { app } = await import("electron");
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  app.on("quit", () => {
    if (sdk.autoInstallOnAppQuit) sdk.quitAndInstall();
  });
  app.emit("quit");
}

test("a new start during an ordinary quit defers the downloaded install and may reopen", async () => {
  const { updater } = await downloaded(1);
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(updater.canReopenAfterUpdate()).toBe(true);
  expect(sdk.autoInstallOnAppQuit).toBe(false);
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
});

test("a native install owns reopening after quitting is settled", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  const { updater, failed, started, installed } = await downloaded(0);
  await installed;
  const { autoUpdater: native } = await import("electron");
  native.emit("before-quit-for-update");
  expect(started).toHaveBeenCalledExactlyOnceWith(true);
  expect(updater.canReopenAfterUpdate()).toBe(false);
  expect(failed).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).toHaveBeenCalledOnce();
});

test("a prepared Restart awaiting the native installer still permits a requested reopen", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  const { app } = await import("electron");
  const run = await start({
    response: 0,
    install: () => {
      app.emit("quit");
    },
  });
  await run.installed;
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", true);
  expect(run.started).not.toHaveBeenCalled();
  expect(run.updater.canReopenAfterUpdate()).toBe(true);
  expect(sdk.autoInstallOnAppQuit).toBe(false);
});

test("an automatic install on ordinary quit says that its installer will not reopen the app", async () => {
  const { updater, started } = await downloaded(1);
  const { app } = await import("electron");
  app.emit("quit");
  expect(started).toHaveBeenCalledExactlyOnceWith(false);
  expect(updater.canReopenAfterUpdate()).toBe(false);
});

test("keeping the app open during an update restart still allows a later new start", async () => {
  const run = await downloaded(0, false);
  await run.settled;
  await checkpoint();
  expect(run.updater.canReopenAfterUpdate()).toBe(true);
  expect(run.prepared).not.toHaveBeenCalled();
  expect(run.failed).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
});

test.each(["throws", "emits", "emits then throws"] as const)(
  "an installer that %s an error delegates to the single failure/exit path",
  async (how) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
    const run = await start({
      response: 0,
      install: () => {
        const error = new Error("Installer failed");
        if (how === "throws") throw error;
        sdk.emit("error", error);
        if (how === "emits then throws") throw error;
      },
    });
    await run.failure;
    expect(run.failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Installer failed" }),
      "en",
    );
    expect(sdk.autoInstallOnAppQuit).toBe(false);
    expect(run.updater.canReopenAfterUpdate()).toBe(false);
  },
);

test("pending native preparation offers no Restart, leaves quitting uncommitted and permits a requested reopen", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  fixture.prepareNative = false;
  const download = Promise.withResolvers<void>();
  fixture.wrapperDownload = download.promise;
  const run = await start({ response: 0 });
  await fixture.checked.promise;
  download.resolve();
  await download.promise;
  await checkpoint();
  expect(fixture.showMessageBox).not.toHaveBeenCalled();
  expect(run.core.getSettings).not.toHaveBeenCalled();
  expect(run.settleQuit).not.toHaveBeenCalled();
  expect(run.started).not.toHaveBeenCalled();
  expect(run.prepared).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
  expect(run.updater.canReopenAfterUpdate()).toBe(true);
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(sdk.autoInstallOnAppQuit).toBe(false);
});

test("native preparation releases Ready before settling quitting and invoking the installer", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  fixture.prepareNative = false;
  const run = await start({ response: 0 });
  await fixture.checked.promise;
  await checkpoint();
  expect(run.order).toEqual([]);
  const { autoUpdater: native } = await import("electron");
  expect(native.listenerCount("update-downloaded")).toBe(1);
  expect(native.listenerCount("error")).toBe(1);
  native.emit("update-downloaded");
  await run.installed;
  expect(run.order).toEqual(["ready", "settle", "prepare:true", "install"]);
  expect(fixture.showMessageBox).toHaveBeenCalledWith(
    null,
    expect.objectContaining({
      message: "IncarnaMind 0.1.0-test is ready to install",
      buttons: ["Restart now", "Later"],
    }),
  );
  expect(run.settleQuit).toHaveBeenCalledOnce();
  expect(native.listenerCount("update-downloaded")).toBe(0);
  expect(native.listenerCount("error")).toBe(0);
  expect(run.started).not.toHaveBeenCalled();
  expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", true);
  native.emit("before-quit-for-update");
  expect(run.started).toHaveBeenCalledExactlyOnceWith(true);
  expect(run.updater.canReopenAfterUpdate()).toBe(false);
});

test("a native preparation error stops automatic install in the background and leaves the original core callable", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  fixture.prepareNative = false;
  const background = Promise.withResolvers<void>();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => background.resolve());
  const run = await start({ response: 0 });
  await fixture.checked.promise;
  const { autoUpdater: native } = await import("electron");
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  const error = new Error("Native preparation failed");
  native.emit("error", error);
  await background.promise;
  expect(warn).toHaveBeenCalledExactlyOnceWith("The update check failed:", error);
  expect(sdk.autoInstallOnAppQuit).toBe(false);
  expect(fixture.showMessageBox).not.toHaveBeenCalled();
  expect(run.settleQuit).not.toHaveBeenCalled();
  expect(run.failed).not.toHaveBeenCalled();
  expect(run.started).not.toHaveBeenCalled();
  expect(run.prepared).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
  expect(native.listenerCount("update-downloaded")).toBe(0);
  expect(native.listenerCount("error")).toBe(0);
  expect(await run.core.getSettings()).toEqual({ language: "en" });
  expect(run.updater.canReopenAfterUpdate()).toBe(true);
});

test("an unsigned Mac offers its download without waiting for native preparation", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  fixture.signed = false;
  fixture.prepareNative = false;
  const run = await downloaded(1);
  const { autoUpdater: native } = await import("electron");
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(fixture.showMessageBox).toHaveBeenCalledWith(
    null,
    expect.objectContaining({
      message: "IncarnaMind 0.1.0-test is available",
      buttons: ["Download", "Later"],
    }),
  );
  expect(sdk.autoDownload).toBe(false);
  expect(sdk.autoInstallOnAppQuit).toBe(false);
  expect(native.listenerCount("update-downloaded")).toBe(0);
  expect(native.listenerCount("error")).toBe(0);
  expect(run.settleQuit).not.toHaveBeenCalled();
  expect(run.prepared).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
});

test("turning automatic checks off never waits for native preparation or starts the SDK check", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  fixture.prepareNative = false;
  const run = await start({ response: 0, privacy: false });
  await checkpoint();
  const { autoUpdater: native } = await import("electron");
  expect(fixture.checkForUpdates).not.toHaveBeenCalled();
  expect(native.listenerCount("update-downloaded")).toBe(0);
  expect(native.listenerCount("error")).toBe(0);
  expect(fixture.showMessageBox).not.toHaveBeenCalled();
  expect(run.settleQuit).not.toHaveBeenCalled();
  expect(run.prepared).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
});

test("Restart prepares the target before publishing installing or invoking the SDK, once across app quit", async () => {
  const { app } = await import("electron");
  const run = await start({
    response: 0,
    install: () => {
      app.emit("quit");
    },
  });
  await run.installed;
  expect(run.order).toEqual(["ready", "settle", "prepare:true", "started:true", "install"]);
  expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", true);
  expect(fixture.quitAndInstall).toHaveBeenCalledOnce();
});

test.each(["Restart", "ordinary quit"] as const)(
  "failed persistence before %s delegates once and prevents the SDK from installing",
  async (how) => {
    const error = new Error("The install handoff could not be saved");
    const run = await start({
      response: how === "Restart" ? 0 : 1,
      prepare: () => {
        throw error;
      },
    });
    if (how === "ordinary quit") {
      await run.asked;
      await quitWithLateSdkListener();
    }
    await run.failure;
    const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
    expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", how === "Restart");
    expect(run.failed).toHaveBeenCalledExactlyOnceWith(error, "en");
    expect(sdk.autoInstallOnAppQuit).toBe(false);
    expect(fixture.quitAndInstall).not.toHaveBeenCalled();
    expect(run.updater.canReopenAfterUpdate()).toBe(false);
  },
);

test("ordinary quit prepares the target as not reopening before the late SDK quit listener installs", async () => {
  const run = await downloaded(1);
  expect(fixture.autoInstallAtCheck).toBe(false);
  expect(fixture.quitListenersAtCheck).toBeGreaterThan(0);
  await quitWithLateSdkListener();
  await run.installed;
  expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", false);
  expect(run.started).toHaveBeenCalledExactlyOnceWith(false);
  expect(run.order).toEqual(["ready", "prepare:false", "started:false", "install"]);
});

test("an automatic installer error uses the cached language and one failure delegate", async () => {
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  const error = new Error("Automatic install failed");
  const run = await start({
    response: 1,
    install: () => {
      sdk.emit("error", error);
    },
  });
  await run.asked;
  await quitWithLateSdkListener();
  await run.failure;
  expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", false);
  expect(run.failed).toHaveBeenCalledExactlyOnceWith(error, "en");
  expect(sdk.autoInstallOnAppQuit).toBe(false);
  expect(fixture.quitAndInstall).toHaveBeenCalledOnce();
});

test("automatic install stays disabled until both downloads and the language are ready", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  const settings = Promise.withResolvers<{ language: "en" }>();
  const run = await start({ response: 1, settings: settings.promise });
  await fixture.checked.promise;
  await checkpoint();
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(fixture.autoInstallAtCheck).toBe(false);
  expect(run.core.getSettings).toHaveBeenCalledOnce();
  expect(sdk.autoInstallOnAppQuit).toBe(false);
  await quitWithLateSdkListener();
  expect(run.prepared).not.toHaveBeenCalled();
  expect(run.started).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
  settings.resolve({ language: "en" });
  await run.asked;
  expect(sdk.autoInstallOnAppQuit).toBe(true);
  expect(run.settleQuit).not.toHaveBeenCalled();
});
