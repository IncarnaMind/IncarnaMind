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
  checkVersion: "0.1.0-test",
  userData: "",
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: true,
      runningUnderARM64Translation: false,
      releaseSingleInstanceLock: fixture.releaseSingleInstanceLock,
      getPath: () => fixture.userData,
    }),
    autoUpdater: new EventEmitter(),
    BrowserWindow: { getAllWindows: () => [] },
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
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdtemp } = await import("node:fs/promises");
  fixture.userData = await mkdtemp(join(tmpdir(), "incarnamind-updater-data-"));
  const { UpdaterAppFixture, UpdaterSdkFixture } = await import("../helpers/updaterSdk");
  const sdk = Object.assign(
    new UpdaterSdkFixture(
      new UpdaterAppFixture(join(tmpdir(), "incarnamind-updater-unit"), app),
      () => fixture.quitAndInstall(),
      "0.1.0-test",
    ),
    { checkForUpdates: fixture.checkForUpdates, quitAndInstall: fixture.quitAndInstall },
  );
  vi.doMock("../../src/main/autoUpdater", () => ({ autoUpdater: sdk }));
  app.removeAllListeners();
  native.removeAllListeners();
  sdk.removeAllListeners();
  sdk.autoDownload = false;
  sdk.autoInstallOnAppQuit = true;
  fixture.checkVersion = "0.1.0-test";
  fixture.autoInstallAtCheck = true;
  fixture.quitListenersAtCheck = 0;
  fixture.checkForUpdates.mockImplementation(async () => {
    fixture.autoInstallAtCheck = sdk.autoInstallOnAppQuit;
    fixture.quitListenersAtCheck = app.listenerCount("quit");
    fixture.checked.resolve();
    const downloadPromise = fixture.wrapperDownload.then(async () => {
      await sdk.completeFixtureDownload();
      if (fixture.prepareNative) queueMicrotask(() => native.emit("update-downloaded"));
    });
    return {
      isUpdateAvailable: true,
      updateInfo: { version: fixture.checkVersion },
      downloadPromise,
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
  const { rm } = await import("node:fs/promises");
  await rm(fixture.userData, { recursive: true, force: true });
});

async function start(
  options: {
    response?: number;
    settles?: boolean;
    privacy?: boolean;
    install?: () => void;
    prepare?: (version: string, reopens: boolean) => void;
    settings?: Promise<{ language: "en" | "zh-CN" }>;
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
  const failed = vi.fn((_error: unknown, _language: string, _reopens: boolean) =>
    failure.resolve(),
  );
  const started = vi.fn((reopens: boolean) => order.push(`started:${reopens}`));
  const prepared = vi.fn((version: string, reopens: boolean) => {
    order.push(`prepare:${reopens}`);
    options.prepare?.(version, reopens);
  });
  const done = updater.startAutoUpdates(core, settleQuit, failed, started, prepared);
  return {
    done,
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
  app.emit("quit", {}, 0);
}

test("a new start during an ordinary quit reopens without claiming the downloaded install was cancelled", async () => {
  const { updater } = await downloaded(1);
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(updater.canReopenAfterUpdate()).toBe(true);
  expect(sdk.autoInstallOnAppQuit).toBe(true);
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
});

test("a native install owns reopening after quitting is settled", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
  const { updater, failed, started, installed } = await downloaded(0);
  await installed;
  const { autoUpdater: native } = await import("electron");
  native.emit("before-quit-for-update");
  expect(started).toHaveBeenCalledExactlyOnceWith(true);
  expect(updater.canReopenAfterUpdate()).toBe(false);
  expect(failed).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).toHaveBeenCalledOnce();
});

test("a committed Restart awaiting the native install cannot reopen the old core", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
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
  expect(run.updater.canReopenAfterUpdate()).toBe(false);
  expect(sdk.autoInstallOnAppQuit).toBe(true);
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
      true,
    );
    expect(sdk.autoInstallOnAppQuit).toBe(true);
    expect(run.updater.canReopenAfterUpdate()).toBe(false);
  },
);

test("pending native preparation offers no Restart, leaves quitting uncommitted and permits a requested reopen", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
  fixture.prepareNative = false;
  const download = Promise.withResolvers<void>();
  fixture.wrapperDownload = download.promise;
  const run = await start({ response: 0 });
  await fixture.checked.promise;
  download.resolve();
  await download.promise;
  await checkpoint();
  expect(fixture.showMessageBox).not.toHaveBeenCalled();
  expect(run.core.getSettings).toHaveBeenCalledOnce();
  expect(run.settleQuit).not.toHaveBeenCalled();
  expect(run.started).not.toHaveBeenCalled();
  expect(run.prepared).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
  expect(run.updater.canReopenAfterUpdate()).toBe(true);
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(sdk.autoInstallOnAppQuit).toBe(true);
});

test("native preparation releases Ready before settling quitting and invoking the installer", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
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

test("a native preparation error is reported in the background and leaves the original core callable", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
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
  expect(sdk.autoInstallOnAppQuit).toBe(true);
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
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
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
  expect(sdk.autoInstallOnAppQuit).toBe(true);
  expect(native.listenerCount("update-downloaded")).toBe(0);
  expect(native.listenerCount("error")).toBe(0);
  expect(run.settleQuit).not.toHaveBeenCalled();
  expect(run.prepared).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
});

// Every version after 0.1.0-alpha.5 is for Apple silicon only (#2199).
test("an Intel Mac is told once for each new version that it can't install it, with nothing to download", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "x64" });
  fixture.signed = false;
  fixture.prepareNative = false;
  const intelNotice = (version: string) =>
    expect.objectContaining({
      message: `IncarnaMind ${version} needs a Mac with Apple silicon, so this Mac can’t install it. Your notes and Documents stay where they are.`,
      buttons: ["Got it"],
    });

  const first = await start();
  await first.done;
  expect(fixture.showMessageBox).toHaveBeenCalledExactlyOnceWith(null, intelNotice("0.1.0-test"));
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(sdk.autoDownload).toBe(false);

  await (await start()).done;
  expect(fixture.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(fixture.showMessageBox).toHaveBeenCalledOnce();

  fixture.checkVersion = "0.1.0-next";
  await (await start({ settings: Promise.resolve({ language: "zh-CN" }) })).done;
  expect(fixture.showMessageBox).toHaveBeenCalledTimes(2);
  expect(fixture.showMessageBox).toHaveBeenLastCalledWith(
    null,
    expect.objectContaining({
      message:
        "IncarnaMind 0.1.0-next 需要搭载 Apple 芯片的 Mac，这台 Mac 无法安装。你的笔记和文档都会原样保留。",
      buttons: ["知道了"],
    }),
  );
  expect(fixture.openBrowser).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
});

test("an Apple silicon Mac is offered the new version's download, as before", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
  fixture.signed = false;
  fixture.prepareNative = false;
  const run = await start({ response: 0 });
  await run.done;
  expect(fixture.showMessageBox).toHaveBeenCalledExactlyOnceWith(
    null,
    expect.objectContaining({
      message: "IncarnaMind 0.1.0-test is available",
      buttons: ["Download", "Later"],
    }),
  );
  expect(fixture.openBrowser).toHaveBeenCalledExactlyOnceWith(
    "https://github.com/IncarnaMind/IncarnaMind/releases/tag/v0.1.0-test",
  );
});

test("turning automatic checks off never waits for native preparation or starts the SDK check", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
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
  "failed persistence before %s delegates once without changing the SDK install flag",
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
    expect(run.failed).toHaveBeenCalledExactlyOnceWith(error, "en", how === "Restart");
    expect(sdk.autoInstallOnAppQuit).toBe(true);
    expect(fixture.quitAndInstall).toHaveBeenCalledTimes(how === "Restart" ? 0 : 1);
    expect(run.updater.canReopenAfterUpdate()).toBe(false);
  },
);

test("ordinary quit prepares the target as not reopening before the late SDK quit listener installs", async () => {
  const run = await downloaded(1);
  expect(fixture.autoInstallAtCheck).toBe(true);
  expect(fixture.quitListenersAtCheck).toBeGreaterThan(0);
  await quitWithLateSdkListener();
  await run.installed;
  expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", false);
  expect(run.started).toHaveBeenCalledExactlyOnceWith(false);
  expect(run.order).toEqual(["ready", "prepare:false", "started:false", "install"]);
});

test("an automatic installer error keeps the requested quit and cached language", async () => {
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
  expect(run.failed).toHaveBeenCalledExactlyOnceWith(error, "en", false);
  expect(run.started).toHaveBeenCalledExactlyOnceWith(false);
  expect(sdk.autoInstallOnAppQuit).toBe(true);
  expect(fixture.quitAndInstall).toHaveBeenCalledOnce();
});

for (const language of ["en", "zh-CN"] as const) {
  test.each(["installer", "persistence"] as const)(
    `a quit-time %s failure preserves a requested reopen and its cached language (${language})`,
    async (source) => {
      const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
      const error = new Error("The prepared update failed");
      const run = await start({
        response: 1,
        settings: Promise.resolve({ language }),
        install: () => {
          if (source === "installer") sdk.emit("error", error);
        },
        prepare: () => {
          if (source === "persistence") throw error;
        },
      });
      await run.asked;
      expect(run.updater.canReopenAfterUpdate()).toBe(true);
      await quitWithLateSdkListener();
      await run.failure;
      expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", true);
      expect(run.started).toHaveBeenCalledExactlyOnceWith(true);
      expect(run.failed).toHaveBeenCalledExactlyOnceWith(error, language, true);
      expect(sdk.autoInstallOnAppQuit).toBe(true);
    },
  );
}

test("language is cached before the SDK starts and its standard automatic install remains enabled", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
  const settings = Promise.withResolvers<{ language: "en" }>();
  const run = await start({ response: 1, settings: settings.promise });
  await checkpoint();
  const { autoUpdater: sdk } = await import("../../src/main/autoUpdater");
  expect(run.core.getSettings).toHaveBeenCalledOnce();
  expect(fixture.checkForUpdates).not.toHaveBeenCalled();
  expect(sdk.autoInstallOnAppQuit).toBe(true);
  expect(run.prepared).not.toHaveBeenCalled();
  expect(fixture.quitAndInstall).not.toHaveBeenCalled();
  settings.resolve({ language: "en" });
  await run.asked;
  expect(sdk.autoInstallOnAppQuit).toBe(true);
  expect(run.settleQuit).not.toHaveBeenCalled();
});

test("Restart persists and displays the completed download’s target, not earlier check metadata", async () => {
  fixture.checkVersion = "0.9.0-check";
  const run = await downloaded(0);
  await run.installed;
  expect(run.prepared).toHaveBeenCalledExactlyOnceWith("0.1.0-test", true);
  expect(fixture.showMessageBox).toHaveBeenCalledWith(
    null,
    expect.objectContaining({ message: "IncarnaMind 0.1.0-test is ready to install" }),
  );
});
