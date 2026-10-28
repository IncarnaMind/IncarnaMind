import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createModelRuntimeFolder,
  modelRuntimeFolderPaths,
} from "../../src/main/modelRuntimeFolder";

const SUFFIX = join("Microsoft", "DeveloperTools", ".onnxruntime");

describe("where ONNX Runtime keeps its usage data", () => {
  it("is under Application Support on macOS, whatever XDG says", () => {
    expect(
      modelRuntimeFolderPaths({
        platform: "darwin",
        home: "/Users/priya",
        env: { XDG_CACHE_HOME: "/var/cache/priya" },
      }),
    ).toEqual([join("/Users/priya/Library/Application Support", SUFFIX)]);
  });

  it("is in the cache folder on Linux: XDG's when it is absolute, then ~/.cache", () => {
    const folders = (env: NodeJS.ProcessEnv) =>
      modelRuntimeFolderPaths({ platform: "linux", home: "/home/priya", env });
    expect(folders({})).toEqual([join("/home/priya/.cache", SUFFIX)]);
    expect(folders({ XDG_CACHE_HOME: "/var/cache/priya" })).toEqual([
      join("/var/cache/priya", SUFFIX),
      join("/home/priya/.cache", SUFFIX),
    ]);
    expect(folders({ XDG_CACHE_HOME: "/home/priya/.cache" })).toEqual([
      join("/home/priya/.cache", SUFFIX),
    ]);
    expect(folders({ XDG_CACHE_HOME: "cache" })).toEqual([join("/home/priya/.cache", SUFFIX)]);
  });

  it("is nowhere on Windows, where the library only writes ETW events", () => {
    expect(
      modelRuntimeFolderPaths({ platform: "win32", home: "C:\\Users\\priya", env: {} }),
    ).toEqual([]);
  });
});

describe("finding the folder", () => {
  async function temporaryHome() {
    const home = await mkdtemp(join(tmpdir(), "incarnamind-runtime-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    return home;
  }
  const find = (home: string, env: NodeJS.ProcessEnv = {}) =>
    createModelRuntimeFolder({ platform: "linux", home, env }).find();

  it("returns its path when it is there, and never opens what is in it", async () => {
    const home = await temporaryHome();
    const path = join(home, ".cache", SUFFIX);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "deviceid"), "");
    expect(await find(home)).toBe(path);
  });

  it("finds the one under ~/.cache when XDG names another place", async () => {
    const home = await temporaryHome();
    const path = join(home, ".cache", SUFFIX);
    await mkdir(path, { recursive: true });
    expect(await find(home, { XDG_CACHE_HOME: join(home, "elsewhere") })).toBe(path);
  });

  it("returns nothing when it isn't there", async () => {
    expect(await find(await temporaryHome())).toBeNull();
  });

  it("returns nothing when a file is in its place", async () => {
    const home = await temporaryHome();
    await mkdir(join(home, ".cache", "Microsoft", "DeveloperTools"), { recursive: true });
    await writeFile(join(home, ".cache", SUFFIX), "");
    expect(await find(home)).toBeNull();
  });
});
