import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ModelRuntimeFolder } from "../core";

const FOLDER = join("Microsoft", "DeveloperTools", ".onnxruntime");

export interface ModelRuntimeFolderEnvironment {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Every place ONNX Runtime keeps its device id and queue of usage events, as its own code chooses
 * (core/platform/posix/device_id.cc): under Application Support on macOS, and on Linux in
 * $XDG_CACHE_HOME when that is an absolute path, else in ~/.cache. A start with another
 * environment than the one that made the folder looks in the other place, so both are listed on
 * Linux. Its Windows library only writes ETW events and keeps no folder.
 */
export function modelRuntimeFolderPaths({
  platform,
  home,
  env,
}: ModelRuntimeFolderEnvironment): string[] {
  if (platform === "darwin") return [join(home, "Library", "Application Support", FOLDER)];
  if (platform === "linux") {
    const cache = env.XDG_CACHE_HOME;
    const bases = [cache && isAbsolute(cache) ? cache : undefined, join(home, ".cache")];
    return [...new Set(bases.filter((base) => base !== undefined))].map((base) =>
      join(base, FOLDER),
    );
  }
  return [];
}

/** Looks only at whether the folder is there, never at what is in it. */
export function createModelRuntimeFolder(
  environment: ModelRuntimeFolderEnvironment,
): ModelRuntimeFolder {
  async function isFolder(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  }
  return {
    async find() {
      for (const path of modelRuntimeFolderPaths(environment)) {
        if (await isFolder(path)) return path;
      }
      return null;
    },
  };
}
