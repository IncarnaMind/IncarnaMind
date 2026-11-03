import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type ElectronApplication, expect } from "@playwright/test";
import { packagedExecutable } from "./app";

const run = promisify(execFile);

const unpacked = join(
  dirname(packagedExecutable),
  "resources",
  "app.asar.unpacked",
  "node_modules",
);
const sha256 = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

async function engineProcess(app: ElectronApplication, name: string): Promise<number> {
  const processes = await app.evaluate(({ app: electron }) =>
    electron
      .getAppMetrics()
      .map((each) => ({ pid: each.pid, label: `${each.name} ${each.serviceName}` })),
  );
  const found = processes.find((each) => each.label.includes(name));
  expect(found, `no "${name}" process among ${JSON.stringify(processes)}`).toBeDefined();
  return found?.pid as number;
}

const powershell = async (command: string) =>
  (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command])).stdout;

/**
 * What the speech engine's process loaded, once it has decoded (#2152): one ONNX Runtime library,
 * the app's own, which the process's environment keeps from writing usage events. The process
 * is found by the name it was started with.
 */
export async function expectSpeechEngineOnTheAppsRuntime(app: ElectronApplication): Promise<void> {
  const pid = await engineProcess(app, "transcription");
  const appRuntime = join(
    unpacked,
    "onnxruntime-node",
    "bin",
    "napi-v6",
    "win32",
    "x64",
    "onnxruntime.dll",
  );

  const modules = await powershell(
    `(Get-Process -Id ${pid}).Modules | Where-Object { $_.ModuleName -ieq 'onnxruntime.dll' } | ForEach-Object { $_.FileName + '|' + $_.FileVersionInfo.FileVersion }`,
  );
  const loaded = modules.split(/\r?\n/).filter(Boolean);
  expect(loaded, `onnxruntime.dll modules of process ${pid}: ${modules}`).toHaveLength(1);
  const [file, version] = (loaded[0] as string).split("|") as [string, string];
  const appVersion = (
    await powershell(`(Get-Item '${appRuntime}').VersionInfo.FileVersion`)
  ).trim();
  expect(appVersion).not.toBe("");
  expect(version).toBe(appVersion);
  expect(await sha256(file)).toBe(await sha256(appRuntime));
}
