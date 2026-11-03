import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";

const fixtureSource = readFileSync(new URL("../../e2e/updateFailure.cjs", import.meta.url), "utf8");

function loadFixture(marker: "before" | "during" | "after") {
  const folder = join("fixture", "signals");
  const signal = join(folder, "quit-2022");
  let present = marker === "before";
  let notify: () => void = () => {
    throw new Error("The fixture has not subscribed to its signal.");
  };
  const close = vi.fn();
  const watch = vi.fn((_folder: string, onChange: () => void) => {
    notify = onChange;
    if (marker === "during") present = true;
    return { close };
  });
  const quit = vi.fn();
  const app = Object.assign(new EventEmitter(), {
    quit,
    relaunch: vi.fn(),
    hasSingleInstanceLock: () => false,
    commandLine: { getSwitchValue: () => "" },
    whenReady: () => new Promise<void>(() => undefined),
  });
  const autoUpdater = new EventEmitter();
  const modules: Record<string, unknown> = {
    "node:fs": {
      appendFileSync: vi.fn(),
      existsSync: (file: string) => file === signal && present,
      watch,
    },
    "node:path": { join },
    "node:module": { createRequire: () => () => ({ autoUpdater }) },
    "node:sqlite": {},
    electron: {
      app,
      autoUpdater: new EventEmitter(),
      BrowserWindow: {},
      dialog: {},
      shell: {},
    },
    "node:child_process": { execFile: vi.fn() },
    "./lifecycleVisibility.cjs": { createVisibilitySampler: () => vi.fn() },
  };
  runInNewContext(fixtureSource, {
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected fixture dependency: ${name}`);
      return modules[name];
    },
    process: {
      env: {
        INCARNAMIND_TEST_UPDATE_FOLDER: folder,
        INCARNAMIND_TEST_UPDATE_APP: "fixture-app",
        INCARNAMIND_PACKAGED_APP: "1",
      },
      pid: 2022,
      argv: [],
      execPath: "fixture-app",
      resourcesPath: "fixture-resources",
    },
  });
  return {
    quit,
    watch,
    close,
    notify: () => notify(),
    arrive: () => {
      present = true;
    },
  };
}

test("uses an existing signal immediately without subscribing", () => {
  const fixture = loadFixture("before");

  expect(fixture.quit).toHaveBeenCalledTimes(1);
  expect(fixture.watch).not.toHaveBeenCalled();
});

test("uses a signal created during watch registration even without an event", () => {
  const fixture = loadFixture("during");

  expect(fixture.quit).toHaveBeenCalledTimes(1);
  expect(fixture.close).toHaveBeenCalledTimes(1);
});

test("waits through unrelated events and consumes a later signal only once", () => {
  const fixture = loadFixture("after");
  fixture.notify();
  expect(fixture.quit).not.toHaveBeenCalled();
  expect(fixture.close).not.toHaveBeenCalled();

  fixture.arrive();
  fixture.notify();
  fixture.notify();

  expect(fixture.quit).toHaveBeenCalledTimes(1);
  expect(fixture.close).toHaveBeenCalledTimes(1);
});
