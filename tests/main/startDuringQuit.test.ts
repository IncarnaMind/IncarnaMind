import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { reopenAfterQuit, startAgainIfStalled } from "../../src/main/startDuringQuit";

const quitEvent = () => ({
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
});

describe("a start that reaches a copy while it quits", () => {
  const quittingApp = (canReopen = true) => {
    const app = Object.assign(new EventEmitter(), { relaunch: vi.fn() });
    const logged: unknown[] = [];
    const startCame = reopenAfterQuit(
      app as unknown as Parameters<typeof reopenAfterQuit>[0],
      () => canReopen,
      { info: (...entry: unknown[]) => logged.push(entry) },
    );
    return { app, startCame, logged };
  };

  test("waits while the windows close, and has the app opened again once this copy has ended", () => {
    const { app, startCame, logged } = quittingApp();
    app.emit("before-quit", quitEvent());
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(startCame()).toBe(true);
    expect(startCame()).toBe(true);
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.relaunch).toHaveBeenCalledWith({ args: process.argv.slice(1) });
    expect(logged).toEqual([["app.reopenAfterQuit", { reopens: true }]]);
  });

  test("shows the window while the quit waits on the User's answer, and the answer decides", () => {
    const { app, startCame } = quittingApp();
    const asking = quitEvent();
    app.emit("before-quit", asking);
    asking.preventDefault();
    expect(startCame()).toBe(false);
    app.emit("before-quit", quitEvent());
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  test("after a quit the User called off, a start shows the window, and a later quit still reopens", () => {
    const { app, startCame } = quittingApp();
    const asking = quitEvent();
    app.emit("before-quit", asking);
    asking.preventDefault();
    // The User keeps IncarnaMind open: no quit follows.
    expect(startCame()).toBe(false);
    expect(startCame()).toBe(false);
    expect(app.relaunch).not.toHaveBeenCalled();

    app.emit("before-quit", quitEvent());
    expect(startCame()).toBe(true);
    expect(app.relaunch).toHaveBeenCalledOnce();
  });

  test("shows the window when nothing is quitting", () => {
    const { app, startCame } = quittingApp();
    expect(startCame()).toBe(false);
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  test("leaves opening to an update that installs on this quit", () => {
    const { app, startCame, logged } = quittingApp(false);
    app.emit("before-quit", quitEvent());
    expect(startCame()).toBe(true);
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(logged).toEqual([["app.reopenAfterQuit", { reopens: false }]]);
  });

  test("an AppImage opens again from the AppImage, whose mounted files go when it quits", () => {
    vi.stubEnv("APPIMAGE", "/home/someone/IncarnaMind.AppImage");
    try {
      const { app, startCame } = quittingApp();
      app.emit("before-quit", quitEvent());
      startCame();
      expect(app.relaunch).toHaveBeenCalledWith({
        args: process.argv.slice(1),
        execPath: "/home/someone/IncarnaMind.AppImage",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a copy that took the data folder from one that was quitting", () => {
  const argv = process.argv;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    process.argv = argv;
    vi.useRealTimers();
  });

  const startingApp = (ready: boolean) => {
    const calls: unknown[][] = [];
    const app = {
      whenReady: () => (ready ? Promise.resolve() : new Promise<void>(() => undefined)),
      releaseSingleInstanceLock: () => calls.push(["releaseSingleInstanceLock"]),
      relaunch: (options: unknown) => calls.push(["relaunch", options]),
      exit: (code: number) => calls.push(["exit", code]),
    };
    const logged: unknown[] = [];
    startAgainIfStalled(
      app as unknown as Parameters<typeof startAgainIfStalled>[0],
      () => calls.push(["letGoOfFolder"]),
      () => calls.push(["showProblem"]),
      { error: (...entry: unknown[]) => logged.push(entry) },
    );
    return { calls, logged };
  };

  test("goes on as usual once it is ready", async () => {
    const { calls, logged } = startingApp(true);
    await Promise.resolve();
    vi.runAllTimers();
    expect(calls).toEqual([]);
    expect(logged).toEqual([]);
  });

  test("with no `ready`, lets go of Electron's lock and then the folder, and starts again", () => {
    const { calls, logged } = startingApp(false);
    vi.runAllTimers();
    expect(calls).toEqual([
      ["releaseSingleInstanceLock"],
      ["letGoOfFolder"],
      ["relaunch", { args: [...argv.slice(1), "--started-again-after-stall"] }],
      ["exit", 0],
    ]);
    expect(logged).toEqual([["app.startStalled", { again: false }]]);
  });

  test("started again and stalled again, it shows the problem and quits", () => {
    process.argv = [...argv, "--started-again-after-stall"];
    const { calls, logged } = startingApp(false);
    vi.runAllTimers();
    expect(calls).toEqual([
      ["releaseSingleInstanceLock"],
      ["letGoOfFolder"],
      ["showProblem"],
      ["exit", 0],
    ]);
    expect(logged).toEqual([["app.startStalled", { again: true }]]);
  });

  test("a copy started again that opens later on doesn't pass the mark on", () => {
    process.argv = [...argv, "--started-again-after-stall"];
    const app = Object.assign(new EventEmitter(), { relaunch: vi.fn() });
    const startCame = reopenAfterQuit(
      app as unknown as Parameters<typeof reopenAfterQuit>[0],
      () => true,
      { info: () => undefined },
    );
    app.emit("before-quit", quitEvent());
    startCame();
    expect(app.relaunch).toHaveBeenCalledWith({ args: argv.slice(1) });
  });
});
