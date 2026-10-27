import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow, Rectangle } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepWindowPlace } from "../../src/main/windowState";

vi.mock("electron", () => ({ screen: {} }));

const CHILD = fileURLToPath(new URL("../helpers/windowStateChild.mjs", import.meta.url));
const SOURCE = fileURLToPath(new URL("../../src/main/windowState.ts", import.meta.url));
const LATEST = { x: 100, y: 120, width: 1440, height: 660 };
class Window extends EventEmitter {
  bounds: Rectangle = { x: 0, y: 0, width: 1280, height: 800 };
  destroyed = false;
  minimized = false;
  fullScreen = false;
  reads = 0;
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  isFullScreen() {
    return this.fullScreen;
  }
  isMaximized() {
    return false;
  }
  getNormalBounds() {
    this.reads++;
    return { ...this.bounds };
  }
  electronWindow(): BrowserWindow {
    return this as unknown as BrowserWindow;
  }
}

let folder: string;
let dataDir: string;
let home: string;
const children = new Set<ChildProcess>();
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "incarnamind-window-state-"));
  dataDir = join(folder, "data");
  home = join(folder, "home");
  await mkdir(dataDir);
  await mkdir(home);
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("close", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  children.clear();
  await rm(folder, { recursive: true, force: true });
});

function runChild(mode: "resize" | "close") {
  // A child contains the real Node dispatch failure that fake timers cannot reproduce (#1244).
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: home,
      TMP: home,
      TEMP: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      XDG_DATA_HOME: home,
      APPDATA: home,
      LOCALAPPDATA: home,
    };
    for (const name of ["SystemRoot", "WINDIR"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", CHILD, SOURCE, mode, dataDir],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

function saved(): unknown {
  return JSON.parse(readFileSync(join(dataDir, "window.json"), "utf8"));
}
function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
}

describe("the window's saved place", () => {
  for (const mode of ["resize", "close"] as const) {
    it(`keeps the latest bounds without a timer error when ${mode} arrives just before its save callback`, async () => {
      const result = await runChild(mode);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      const report: unknown = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        mode,
        interrupted: true,
        errors: [],
        boundsReads: 1,
        saved: { bounds: LATEST, maximized: false },
      });
    });
  }

  it("saves the latest bounds after a burst of moves and resizes", () => {
    fakeTimers();
    const window = new Window();
    keepWindowPlace(window.electronWindow(), dataDir);
    window.emit("resize");
    vi.advanceTimersByTime(400);
    window.bounds = { ...LATEST };
    window.emit("move");
    window.emit("resize");
    expect(existsSync(join(dataDir, "window.json"))).toBe(false);
    vi.advanceTimersByTime(100);
    expect(existsSync(join(dataDir, "window.json"))).toBe(false);
    vi.runAllTimers();
    expect(saved()).toEqual({ bounds: LATEST, maximized: false });
    expect(window.reads).toBe(1);
  });

  it("saves at close, leaves the queued callback harmless, and still saves after a cancelled close", () => {
    fakeTimers();
    const window = new Window();
    keepWindowPlace(window.electronWindow(), dataDir);
    window.emit("resize");
    window.emit("close");
    expect(saved()).toEqual({ bounds: window.bounds, maximized: false });
    vi.runAllTimers();
    expect(window.reads).toBe(1);
    window.bounds = { ...LATEST };
    window.emit("resize");
    vi.runAllTimers();
    expect(saved()).toEqual({ bounds: LATEST, maximized: false });
    expect(window.reads).toBe(2);
  });

  it("keeps a resize that reenters while reading the window's bounds", () => {
    fakeTimers();
    const window = new Window();
    const read = window.getNormalBounds.bind(window);
    vi.spyOn(window, "getNormalBounds").mockImplementationOnce(() => {
      const before = read();
      window.bounds = { ...LATEST };
      window.emit("resize");
      return before;
    });
    keepWindowPlace(window.electronWindow(), dataDir);
    window.emit("resize");
    vi.runAllTimers();
    expect(saved()).toEqual({ bounds: LATEST, maximized: false });
    expect(window.reads).toBe(2);
  });

  for (const state of ["destroyed", "minimized", "fullScreen"] as const) {
    it(`keeps the last useful place when the window is ${state}`, () => {
      fakeTimers();
      const window = new Window();
      keepWindowPlace(window.electronWindow(), dataDir);
      window.emit("close");
      const previous = saved();
      window[state] = true;
      window.bounds = { ...LATEST };
      window.emit("resize");
      vi.runAllTimers();
      expect(saved()).toEqual(previous);
      expect(window.reads).toBe(1);
    });
  }
});
