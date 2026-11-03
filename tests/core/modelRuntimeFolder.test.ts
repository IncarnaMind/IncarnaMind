import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";

const FOLDER = "/home/priya/.cache/Microsoft/DeveloperTools/.onnxruntime";

async function setUp({ there = true, earlier = true, failing = false } = {}) {
  const dataDir = await createTempDataFolder();
  const shown: string[] = [];
  const warned: string[] = [];
  let present = there;
  const adapters = {
    log: {
      info: () => undefined,
      warn: (event: string) => void warned.push(event),
      error: () => undefined,
    },
    shell: {
      openPath: async () => undefined,
      showItemInFolder: (path: string) => void shown.push(path),
    },
    modelRuntimeFolder: {
      find: async () => {
        if (failing) throw new Error("EACCES: permission denied");
        return present ? FOLDER : null;
      },
    },
  };
  startCore(dataDir, adapters).close();
  if (earlier) {
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run(
      "UPDATE schema_migrations SET applied_at = '2026-10-15T09:00:00.000Z' WHERE version = 1",
    );
    db.close();
  }
  return { core: startCore(dataDir, adapters), shown, warned, remove: () => (present = false) };
}

describe("the runtime's folder, shown on Privacy", () => {
  test("is the folder's path for an install older than this build, while the folder is there", async () => {
    const { core } = await setUp();
    expect(await core.getModelRuntimeFolder()).toBe(FOLDER);
  });

  test("is nothing once the folder is gone", async () => {
    const { core, remove } = await setUp();
    remove();
    expect(await core.getModelRuntimeFolder()).toBeNull();
  });

  test("is nothing for an older install without the folder", async () => {
    const { core } = await setUp({ there: false });
    expect(await core.getModelRuntimeFolder()).toBeNull();
  });

  test("is nothing on a new install, whoever made the folder", async () => {
    const { core } = await setUp({ earlier: false });
    expect(await core.getModelRuntimeFolder()).toBeNull();
  });

  test("is nothing, and logged, when the folder can't be looked at", async () => {
    const { core, warned } = await setUp({ failing: true });
    expect(await core.getModelRuntimeFolder()).toBeNull();
    expect(warned.filter((event) => event.startsWith("modelRuntimeFolder"))).toEqual([
      "modelRuntimeFolder.lookFailed",
    ]);
  });

  test("shows the folder in the file manager", async () => {
    const { core, shown } = await setUp();
    await core.showModelRuntimeFolder();
    expect(shown).toEqual([FOLDER]);
  });

  test("shows nothing once the folder is gone, or on a new install", async () => {
    const gone = await setUp();
    gone.remove();
    await gone.core.showModelRuntimeFolder();
    const fresh = await setUp({ earlier: false });
    await fresh.core.showModelRuntimeFolder();
    expect([...gone.shown, ...fresh.shown]).toEqual([]);
  });
});
