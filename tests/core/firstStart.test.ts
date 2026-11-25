import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CoreAdapters, LoginItem } from "../../src/core";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { createFakeCallWatcher } from "../../src/main/calls/fakeWatcher";
import { createFileLoginItem } from "../../src/main/loginItem";
import { createTempDataFolder, startCore, startedBefore } from "../helpers/core";

/*
 * A new data folder's first start (#3758): IncarnaMind opens at login, keeps running in the menu
 * bar and offers to take notes when a call starts, each once; a data folder an earlier version
 * started keeps what it had, and one the User turned off stays off.
 */

const backgroundOf = async (core: ReturnType<typeof startCore>) => {
  const { device } = await core.getSettings();
  return {
    openAtLogin: (await core.getOpenAtLogin()).on,
    keepRunning: device.keepRunning,
    callOffers: device.callOffers,
  };
};

function computer(dataDir: string, adapters: Partial<CoreAdapters> = {}) {
  const calls = createFakeCallWatcher();
  const start = () =>
    startCore(dataDir, {
      audioCapture: createFakeCapture(),
      callWatcher: calls,
      loginItem: createFileLoginItem(dataDir),
      ...adapters,
    });
  return { calls, start };
}

const loginItemFile = (dataDir: string) => join(dataDir, "login-item.json");

describe("A new data folder's first start", () => {
  test("opens at login, keeps running in the menu bar and offers to take notes in calls", async () => {
    const dataDir = await createTempDataFolder();
    const { calls, start } = computer(dataDir);
    const core = start();

    expect(await backgroundOf(core)).toEqual({
      openAtLogin: true,
      keepRunning: true,
      callOffers: true,
    });
    // Before any Meeting is set up, the calls are watched.
    expect(calls.watching()).toBe(true);
    // A test build's login item is a file in the data folder, never the computer's own.
    expect(JSON.parse(readFileSync(loginItemFile(dataDir), "utf8"))).toEqual({ on: true });
  });

  test("a data folder an earlier version started is left as it was", async () => {
    const dataDir = await createTempDataFolder();
    startedBefore(dataDir);
    const { calls, start } = computer(dataDir);
    const core = start();

    expect(await backgroundOf(core)).toEqual({
      openAtLogin: false,
      keepRunning: false,
      callOffers: false,
    });
    expect(calls.watching()).toBe(false);
    expect(existsSync(loginItemFile(dataDir))).toBe(false);
  });

  test("each one turned off stays off at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const { calls, start } = computer(dataDir);
    const first = start();
    await first.setOpenAtLogin(false);
    await first.updateSettings({ device: { keepRunning: false, callOffers: false } });
    first.close();

    const next = start();
    expect(await backgroundOf(next)).toEqual({
      openAtLogin: false,
      keepRunning: false,
      callOffers: false,
    });
    expect(calls.watching()).toBe(false);
  });

  test("one turned off alone stays off, and the others stay on", async () => {
    const dataDir = await createTempDataFolder();
    const { start } = computer(dataDir);
    const first = start();
    await first.updateSettings({ device: { callOffers: false } });
    first.close();

    expect(await backgroundOf(start())).toEqual({
      openAtLogin: true,
      keepRunning: true,
      callOffers: false,
    });
  });
});

describe("Where this copy can't do one of them, that one stays off", () => {
  test("a build whose watcher can't tell which app uses the microphone", async () => {
    for (const problem of ["not-on-windows", "no-pactl", "unavailable"] as const) {
      const dataDir = await createTempDataFolder();
      const calls = createFakeCallWatcher();
      const { start } = computer(dataDir, { callWatcher: { ...calls, problem } });
      const core = start();
      expect(await backgroundOf(core)).toEqual({
        openAtLogin: true,
        keepRunning: true,
        callOffers: false,
      });
      expect(calls.watching()).toBe(false);
      core.close();
    }
  });

  test("a copy that can't record, or has no call watcher", async () => {
    for (const adapters of [{ audioCapture: undefined }, { callWatcher: undefined }]) {
      const dataDir = await createTempDataFolder();
      const core = computer(dataDir, adapters).start();
      expect((await core.getSettings()).device).toMatchObject({
        keepRunning: true,
        callOffers: false,
      });
      core.close();
    }
  });

  test("a build the system can't open at login", async () => {
    const dataDir = await createTempDataFolder();
    const core = computer(dataDir, { loginItem: undefined }).start();
    expect(await core.getOpenAtLogin()).toEqual({
      supported: false,
      on: false,
      needsApproval: false,
    });
    expect((await core.getSettings()).device).toMatchObject({
      keepRunning: true,
      callOffers: true,
    });
  });

  test("a login item that fails to register leaves the rest on", async () => {
    const dataDir = await createTempDataFolder();
    const failing: LoginItem = {
      get: () => ({ supported: true, on: false, needsApproval: false }),
      set: () => {
        throw new Error("The autostart folder is read-only.");
      },
      openSettings: async () => undefined,
    };
    const core = computer(dataDir, { loginItem: failing }).start();
    expect(await backgroundOf(core)).toEqual({
      openAtLogin: false,
      keepRunning: true,
      callOffers: true,
    });
  });
});

test("where macOS waits for the User's approval, Settings is told so and nothing else asks", async () => {
  const dataDir = await createTempDataFolder();
  let on = false;
  let settingsOpened = 0;
  const waiting: LoginItem = {
    get: () => ({ supported: true, on, needsApproval: on }),
    set: (next) => {
      on = next;
      return waiting.get();
    },
    openSettings: async () => {
      settingsOpened += 1;
    },
  };
  const core = computer(dataDir, { loginItem: waiting }).start();
  expect(await core.getOpenAtLogin()).toEqual({
    supported: true,
    on: true,
    needsApproval: true,
  });
  expect(settingsOpened).toBe(0);
});
