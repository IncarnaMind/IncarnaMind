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
 * Where ONNX Runtime keeps its device id and queue of usage events, as its own code chooses
 * (core/platform/posix/device_id.cc): under Application Support on macOS, and in the cache folder on
 * Linux. Its Windows library only writes ETW events and keeps no folder.
 */
export function modelRuntimeFolderPath({
  platform,
  home,
  env,
}: ModelRuntimeFolderEnvironment): string | null {
  if (platform === "darwin") return join(home, "Library", "Application Support", FOLDER);
  if (platform === "linux") {
    const cache = env.XDG_CACHE_HOME;
    return join(cache && isAbsolute(cache) ? cache : join(home, ".cache"), FOLDER);
  }
  return null;
}

/** Looks only at whether the folder is there, never at what is in it. */
export function createModelRuntimeFolder(
  environment: ModelRuntimeFolderEnvironment,
): ModelRuntimeFolder {
  return {
    async find() {
      const path = modelRuntimeFolderPath(environment);
      if (path === null) return null;
      try {
        return (await stat(path)).isDirectory() ? path : null;
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
  };
}
