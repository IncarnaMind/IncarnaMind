import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { heldByAnotherCopy, lockInstance } from "../../src/main/instanceLock";
import { createTempDataFolder, startCore } from "../helpers/core";
import { refuseWrites } from "../helpers/failingStorage";
import { note } from "../helpers/minds";

const fixture = vi.hoisted(() => ({
  updater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
  releaseSingleInstanceLock: vi.fn(),
  relaunch: vi.fn(),
  exit: vi.fn(),
  showMessageBox: vi.fn(),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: true,
      releaseSingleInstanceLock: fixture.releaseSingleInstanceLock,
      relaunch: fixture.relaunch,
      exit: fixture.exit,
    }),
    BrowserWindow: { getAllWindows: () => [] },
  };
});
vi.mock("../../src/main/autoUpdater", () => ({ autoUpdater: fixture.updater }));
vi.mock("../../src/main/platform", () => ({ systemBrowser: { open: vi.fn() } }));
vi.mock("../../src/main/systemDialogs", () => ({
  showMessageBox: fixture.showMessageBox,
}));
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
  vi.resetAllMocks();
  vi.stubEnv("APPIMAGE", "/tmp/IncarnaMind.AppImage");
  fixture.showMessageBox.mockResolvedValue({ response: 0 });
  fixture.updater.checkForUpdates.mockResolvedValue({
    isUpdateAvailable: true,
    updateInfo: { version: "0.1.0-test" },
    downloadPromise: Promise.resolve(),
  });
});

afterEach(async () => {
  const { app } = await import("electron");
  app.removeAllListeners();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("the real quit guard keeps SQLite ownership through the install attempt", async () => {
  const dataDir = await createTempDataFolder();
  const report = vi.fn();
  const lock = lockInstance(dataDir, report);
  const core = startCore(dataDir);
  const mind = await core.createMind({ title: "Kept through update" });
  const { guardQuit } = await import("../../src/main/unsavedChanges");
  const { startAutoUpdates } = await import("../../src/main/updater");
  const settled = vi.spyOn(core, "saveChangesAgain");
  const installed = Promise.withResolvers<void>();
  const failed = vi.fn();
  fixture.updater.quitAndInstall.mockImplementation(() => installed.resolve());
  try {
    startAutoUpdates(
      core,
      guardQuit(core, () => null),
      failed,
    );
    await installed.promise;
    expect(settled).toHaveBeenCalledOnce();
    expect(heldByAnotherCopy(dataDir, report)).toBe(true);
    expect(failed).not.toHaveBeenCalled();
    expect((await core.listMinds()).find((it) => it.id === mind.id)?.title).toBe(
      "Kept through update",
    );
    expect(report).not.toHaveBeenCalled();
  } finally {
    core.close();
    lock.release();
  }
});

test.each(["throws", "emits", "emits then throws"] as const)(
  "a declined second start still reopens after the installer %s, and the old core exits owned",
  async (how) => {
    const dataDir = await createTempDataFolder();
    const report = vi.fn();
    const lock = lockInstance(dataDir, report);
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "Kept after failure" });
    const { app } = await import("electron");
    const { guardQuit } = await import("../../src/main/unsavedChanges");
    const { startAutoUpdates, canReopenAfterUpdate } = await import("../../src/main/updater");
    const { reopenAfterQuit, restartAfterFailedUpdate } = await import(
      "../../src/main/startDuringQuit"
    );
    const settled = vi.spyOn(core, "saveChangesAgain");
    const calls: string[] = [];
    const ownership: boolean[] = [];
    const record = (name: string) => {
      calls.push(name);
      ownership.push(heldByAnotherCopy(dataDir, report));
    };
    const exited = Promise.withResolvers<void>();
    app.on("quit", () => lock.release());
    fixture.relaunch.mockImplementation(() => record("relaunch"));
    fixture.exit.mockImplementation(() => {
      record("exit");
      app.emit("quit", {}, 0);
      exited.resolve();
    });
    const startCame = reopenAfterQuit(app, canReopenAfterUpdate, { info: vi.fn() });
    const error = new Error("Installer failed");
    let declined = false;
    let relaunchedBeforeFailure = -1;
    fixture.updater.quitAndInstall.mockImplementation(() => {
      record("install");
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      app.emit("before-quit", event);
      declined = startCame();
      relaunchedBeforeFailure = fixture.relaunch.mock.calls.length;
      const listener = fixture.updater.once.mock.calls.at(-1)?.[1];
      if (how !== "throws" && typeof listener === "function") listener(error);
      if (how !== "emits") throw error;
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      startAutoUpdates(
        core,
        guardQuit(core, () => null),
        () => {
          restartAfterFailedUpdate(
            app,
            () => record("problem"),
            () => {
              record("closeCore");
              core.close();
            },
          );
        },
      );
      await exited.promise;
      expect(settled).toHaveBeenCalledOnce();
      expect(declined).toBe(true);
      expect(relaunchedBeforeFailure).toBe(0);
      expect(calls).toEqual(["install", "problem", "relaunch", "closeCore", "exit"]);
      expect(ownership).toEqual([true, true, true, true, true]);
      expect(fixture.relaunch).toHaveBeenCalledOnce();
      expect(fixture.relaunch.mock.calls[0]?.[0].args).toEqual([
        ...process.argv.slice(1).filter((arg) => arg !== "--started-again-after-stall"),
        "--started-again-after-stall",
      ]);
      expect(heldByAnotherCopy(dataDir, report)).toBe(false);
      expect(fixture.updater.autoInstallOnAppQuit).toBe(false);
      expect(report).not.toHaveBeenCalled();
      const reopened = startCore(dataDir);
      expect((await reopened.listMinds()).map((it) => it.id)).toEqual([mind.id]);
    } finally {
      core.close();
      lock.release();
    }
  },
);

test("Keep open with real refused writes retains ownership and never starts the installer", async () => {
  const dataDir = await createTempDataFolder();
  const report = vi.fn();
  const lock = lockInstance(dataDir, report);
  const core = startCore(dataDir);
  const mind = await core.createMind({ title: "Still editing" });
  const { guardQuit } = await import("../../src/main/unsavedChanges");
  const { startAutoUpdates, canReopenAfterUpdate } = await import("../../src/main/updater");
  const settle = guardQuit(core, () => null);
  const restore = refuseWrites(dataDir);
  await core.addToNote({ mindId: mind.id, blocks: [note("WAITING")], origin: null, model: null });
  fixture.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValue({ response: 2 });
  const settled = Promise.withResolvers<boolean>();
  const failed = vi.fn();
  let restored = false;
  try {
    startAutoUpdates(
      core,
      async () => {
        const quits = await settle();
        settled.resolve(quits);
        return quits;
      },
      failed,
    );
    expect(await settled.promise).toBe(false);
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(fixture.releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(heldByAnotherCopy(dataDir, report)).toBe(true);
    expect(canReopenAfterUpdate()).toBe(true);
    restore();
    restored = true;
    expect(await core.saveChangesAgain()).toBeNull();
  } finally {
    if (!restored) restore();
    core.close();
    lock.release();
  }
});
