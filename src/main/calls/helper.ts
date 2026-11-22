import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import type { EngineModule } from "../../core/engineModules";
import { MAC_WATCHER, WINDOWS_WATCHER } from "./watcher";

/** How long the engine check waits for the watcher's first line. */
const FIRST_LINE_MS = 10_000;

/** The helper beside app.asar, or where npm run call-watcher left it for development. */
export function callWatcherPath(platform = process.platform): string | null {
  const name = platform === "darwin" ? MAC_WATCHER : platform === "win32" ? WINDOWS_WATCHER : null;
  if (name === null) return null;
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), "native", "callWatcher", ".build", name);
}

/**
 * The packaged app's engine check of the call watcher (#208): it starts and says which processes
 * use a microphone now, which asks no permission, then ends when its input closes.
 */
export function callWatcherCheck(path: string): EngineModule<boolean> {
  return {
    name: "the call watcher",
    load: () =>
      new Promise((resolve, reject) => {
        const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`no line in ${FIRST_LINE_MS} ms`));
        }, FIRST_LINE_MS);
        const done = () => {
          clearTimeout(timer);
          child.stdin.end();
        };
        child.on("error", (error) => {
          done();
          reject(error);
        });
        child.on("exit", (code) => {
          done();
          reject(new Error(`it ended with code ${code ?? "none"} before saying anything`));
        });
        createInterface({ input: child.stdout }).once("line", (line) => {
          child.removeAllListeners("exit");
          done();
          try {
            const { exact } = JSON.parse(line) as { exact?: unknown };
            if (typeof exact !== "boolean")
              throw new Error("the call watcher returned no microphone snapshot");
            resolve(exact);
          } catch {
            reject(new Error("the call watcher returned an invalid microphone snapshot"));
          }
        });
      }),
  };
}
