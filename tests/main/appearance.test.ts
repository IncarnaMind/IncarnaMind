import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The kept choice the next launch paints its first frame in (#1262): Electron's theme follows the
 * core's setting, a copy is kept in the data folder, and a copy that is missing or broken is read
 * as Same as system rather than stopping the launch.
 */

const electron = vi.hoisted(() => ({
  nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
}));
vi.mock("electron", () => electron);

const { followAppearance, startAppearance, storedAppearance } = await import(
  "../../src/main/appearance"
);

let dataDir: string;
let core: Core | undefined;
beforeEach(async () => {
  dataDir = await createTempDataFolder();
  electron.nativeTheme.themeSource = "system";
});
afterEach(async () => {
  core?.close();
  core = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

const kept = async () => JSON.parse(await readFile(join(dataDir, "appearance.json"), "utf8"));

describe("the kept appearance", () => {
  test("is Same as system before the User has chosen, and when its copy is broken or unknown", async () => {
    expect(storedAppearance(dataDir)).toBe("system");
    await writeFile(join(dataDir, "appearance.json"), "{not json");
    expect(storedAppearance(dataDir)).toBe("system");
    await writeFile(join(dataDir, "appearance.json"), JSON.stringify({ appearance: "sepia" }));
    expect(storedAppearance(dataDir)).toBe("system");
  });

  test("a launch gives Electron the kept choice before its first window", async () => {
    await writeFile(join(dataDir, "appearance.json"), JSON.stringify({ appearance: "dark" }));
    startAppearance(dataDir);
    expect(electron.nativeTheme.themeSource).toBe("dark");
  });

  test("Electron follows the core's setting, and the next launch keeps it", async () => {
    const started = startCore(dataDir);
    core = started;
    const log = { exception: vi.fn() };
    followAppearance(started, dataDir, log);

    await started.updateSettings({ device: { appearance: "dark" } });
    expect(electron.nativeTheme.themeSource).toBe("dark");
    expect(await kept()).toEqual({ appearance: "dark" });

    await started.updateSettings({ device: { appearance: "system" } });
    expect(electron.nativeTheme.themeSource).toBe("system");
    expect(storedAppearance(dataDir)).toBe("system");
    expect(log.exception).not.toHaveBeenCalled();
  });
});
