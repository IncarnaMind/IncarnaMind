import { execFileSync } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";

/**
 * The audio output devices macOS holds open for the app's processes. Core Audio keeps a power
 * assertion for every process a device is open for, and `pmset -g assertions` lists them with the
 * process and "audio-out" or "audio-in".
 */
export async function audioOutputsHeldBy(app: ElectronApplication): Promise<string[]> {
  const pids = new Set(
    await app.evaluate(({ app: electron }) => electron.getAppMetrics().map((each) => each.pid)),
  );
  const assertions = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" });
  const held: string[] = [];
  for (const [, pid, resources = ""] of assertions.matchAll(
    /Created for PID: (\d+)\.\s*\n\s*Resources: ([^\n]*)/g,
  )) {
    if (pids.has(Number(pid)) && /\baudio-out\b/.test(resources)) held.push(resources.trim());
  }
  return held;
}
