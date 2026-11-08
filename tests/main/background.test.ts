import { describe, expect, test } from "vitest";
import {
  closingLastWindowQuits,
  keepRunningCopy,
  keptRunning,
  startsWithoutWindow,
} from "../../src/main/background";
import { createTempDataFolder } from "../helpers/core";

describe("Running in the background", () => {
  test("closing the last window quits on Windows and Linux only while the tray icon is off", () => {
    expect(closingLastWindowQuits("win32", false)).toBe(true);
    expect(closingLastWindowQuits("linux", false)).toBe(true);
    expect(closingLastWindowQuits("win32", true)).toBe(false);
    expect(closingLastWindowQuits("linux", true)).toBe(false);
    expect(closingLastWindowQuits("darwin", false)).toBe(false);
  });

  test("a start at login opens no window when IncarnaMind keeps running in the background", () => {
    expect(startsWithoutWindow(true, true)).toBe(true);
    expect(startsWithoutWindow(true, false)).toBe(false);
    expect(startsWithoutWindow(false, true)).toBe(false);
  });

  test("the setting's copy in the data folder is read before the core starts", async () => {
    const dataDir = await createTempDataFolder();
    expect(keptRunning(dataDir)).toBe(false);
    keepRunningCopy(dataDir, true);
    expect(keptRunning(dataDir)).toBe(true);
    keepRunningCopy(dataDir, false);
    expect(keptRunning(dataDir)).toBe(false);
  });
});
