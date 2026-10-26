import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  updater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
  showMessageBox: vi.fn(),
  nativeOn: vi.fn(),
  appOn: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, releaseSingleInstanceLock: vi.fn(), on: fixture.appOn },
  autoUpdater: { on: fixture.nativeOn },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../src/main/autoUpdater", () => ({ autoUpdater: fixture.updater }));
vi.mock("../../src/main/platform", () => ({ systemBrowser: { open: vi.fn() } }));
vi.mock("../../src/main/systemDialogs", () => ({ showMessageBox: fixture.showMessageBox }));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function") {
      callback(null, "", "Authority=Developer ID Application: fixture");
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("APPIMAGE", "/tmp/IncarnaMind.AppImage");
  fixture.updater.autoDownload = false;
  fixture.updater.autoInstallOnAppQuit = false;
  fixture.updater.checkForUpdates.mockResolvedValue({
    isUpdateAvailable: true,
    updateInfo: { version: "0.1.0-test" },
    downloadPromise: Promise.resolve(),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function downloaded(response: number, settles = true) {
  const asked = Promise.withResolvers<void>();
  const installed = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  fixture.showMessageBox.mockImplementation(async () => {
    asked.resolve();
    return { response, checkboxChecked: false };
  });
  fixture.updater.quitAndInstall.mockImplementation(() => installed.resolve());
  const updater = await import("../../src/main/updater");
  const release = vi.fn();
  const started = vi.fn();
  updater.startAutoUpdates(
    {
      getSettings: async () => ({ language: "en" }),
      getPrivacySettings: async () => ({ automaticUpdateChecks: true }),
    },
    async () => {
      settled.resolve();
      return settles;
    },
    release,
    started,
  );
  await asked.promise;
  return { updater, release, started, installed: installed.promise, settled: settled.promise };
}

test("a new start during an ordinary quit defers the downloaded install and may reopen", async () => {
  const { updater } = await downloaded(1);
  expect(updater.canReopenAfterUpdate()).toBe(true);
  expect(fixture.updater.autoInstallOnAppQuit).toBe(false);
  expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
});

test("a native install owns reopening after quitting is settled", async () => {
  const { updater, release, installed } = await downloaded(0);
  await installed;
  const listener = fixture.nativeOn.mock.calls.find(
    ([name]) => name === "before-quit-for-update",
  )?.[1];
  expect(typeof listener).toBe("function");
  if (typeof listener === "function") listener();
  expect(updater.canReopenAfterUpdate()).toBe(false);
  expect(release).not.toHaveBeenCalled();
  expect(fixture.updater.quitAndInstall).toHaveBeenCalledOnce();
});

test("a restart waiting for the native update to be ready still permits a requested reopen", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  const { updater, installed } = await downloaded(0);
  await installed;
  expect(updater.canReopenAfterUpdate()).toBe(true);
  expect(fixture.updater.autoInstallOnAppQuit).toBe(false);
});

test("an automatic install on ordinary quit says that its installer will not reopen the app", async () => {
  const { updater, started } = await downloaded(1);
  const listener = fixture.appOn.mock.calls.find(([name]) => name === "quit")?.[1];
  expect(typeof listener).toBe("function");
  if (typeof listener === "function") listener();
  expect(started).toHaveBeenCalledExactlyOnceWith(false);
  expect(updater.canReopenAfterUpdate()).toBe(false);
});

test("keeping the app open during an update restart still allows a later new start", async () => {
  const { updater, release, settled } = await downloaded(0, false);
  await settled;
  await Promise.resolve();
  expect(updater.canReopenAfterUpdate()).toBe(true);
  expect(release).not.toHaveBeenCalled();
  expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
});

test.each(["throws", "emits"])(
  "an installer that %s an error delegates to the single failure/exit path",
  async (how) => {
    const failed = Promise.withResolvers<void>();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.updater.quitAndInstall.mockImplementationOnce(() => {
      failed.resolve();
      const error = new Error("Installer failed");
      if (how === "throws") throw error;
      const listener = fixture.updater.once.mock.calls.at(-1)?.[1];
      expect(typeof listener).toBe("function");
      if (typeof listener === "function") listener(error);
    });
    const { updater, release } = await downloaded(0);
    await failed.promise;
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Installer failed" }),
      "en",
    );
    expect(fixture.updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.canReopenAfterUpdate()).toBe(false);
  },
);
