import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import type { EngineModule } from "../../core/engineModules";
import { MAC_WATCHER } from "./watcher";

/** How long the engine check waits for the watcher's first line. */
const FIRST_LINE_MS = 10_000;

/**
 * Where the macOS call watcher is: in the packaged app's resources, where the packager builds it
 * (scripts/afterPack.mjs), else where `npm run call-watcher` builds it for development.
 */
export function macWatcherPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, MAC_WATCHER)
    : join(app.getAppPath(), "native", "callWatcher", ".build", MAC_WATCHER);
}

/**
 * The packaged app's engine check of the call watcher (#208): it starts and says which processes
 * use a microphone now, which asks no permission, then ends when its input closes.
 */
export function callWatcherCheck(): EngineModule<boolean> {
  return {
    name: "the call watcher",
    load: () =>
      new Promise((resolve, reject) => {
        const child = spawn(macWatcherPath(), [], { stdio: ["pipe", "pipe", "ignore"] });
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
            if (typeof exact !== "boolean") throw new Error(`it said ${line.slice(0, 200)}`);
            resolve(exact);
          } catch (error) {
            reject(error);
          }
        });
      }),
  };
}
