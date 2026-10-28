import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createModelRuntimeFolder,
  modelRuntimeFolderPath,
} from "../../src/main/modelRuntimeFolder";

describe("where ONNX Runtime keeps its usage data", () => {
  it("is under Application Support on macOS", () => {
    expect(modelRuntimeFolderPath({ platform: "darwin", home: "/Users/priya", env: {} })).toBe(
      "/Users/priya/Library/Application Support/Microsoft/DeveloperTools/.onnxruntime",
    );
  });

  it("is in the cache folder on Linux, the XDG one when it is absolute", () => {
    const folder = (env: NodeJS.ProcessEnv) =>
      modelRuntimeFolderPath({ platform: "linux", home: "/home/priya", env });
    expect(folder({})).toBe("/home/priya/.cache/Microsoft/DeveloperTools/.onnxruntime");
    expect(folder({ XDG_CACHE_HOME: "/var/cache/priya" })).toBe(
      "/var/cache/priya/Microsoft/DeveloperTools/.onnxruntime",
    );
    expect(folder({ XDG_CACHE_HOME: "cache" })).toBe(
      "/home/priya/.cache/Microsoft/DeveloperTools/.onnxruntime",
    );
  });

  it("is nowhere on Windows, where the library only writes ETW events", () => {
    expect(
      modelRuntimeFolderPath({ platform: "win32", home: "C:\\Users\\priya", env: {} }),
    ).toBeNull();
  });
});

describe("finding the folder", () => {
  const find = async (setUp: (home: string) => Promise<void>) => {
    const home = await mkdtemp(join(tmpdir(), "incarnamind-runtime-"));
    await setUp(home);
    return createModelRuntimeFolder({ platform: "linux", home, env: {} }).find();
  };
  const folder = (home: string) =>
    join(home, ".cache", "Microsoft", "DeveloperTools", ".onnxruntime");

  it("returns its path when it is there", async () => {
    let path = "";
    const found = await find(async (home) => {
      path = folder(home);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "deviceid"), "00000000-0000-4000-8000-000000000000");
    });
    expect(found).toBe(path);
  });

  it("returns nothing when it isn't", async () => {
    expect(await find(async () => undefined)).toBeNull();
  });

  it("returns nothing when a file is in its place", async () => {
    expect(
      await find(async (home) => {
        await mkdir(join(home, ".cache", "Microsoft", "DeveloperTools"), { recursive: true });
        await writeFile(folder(home), "");
      }),
    ).toBeNull();
  });
});
