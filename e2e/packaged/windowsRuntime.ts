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

/** The processes the app started to run a built-in model, by the name each was given. */
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
 * the app's own 1.30 build, which the process's environment keeps from writing usage events; and
 * no event provider of ONNX Runtime registered with Windows by the process, so nothing of the
 * engine's reaches Windows' diagnostic data.
 */
export async function expectSpeechEngineOnTheAppsRuntime(app: ElectronApplication): Promise<void> {
  const pid = await engineProcess(app, "transcription");

  const modules = await powershell(
    `(Get-Process -Id ${pid}).Modules | Where-Object { $_.ModuleName -ieq 'onnxruntime.dll' } | ForEach-Object { $_.FileName + '|' + $_.FileVersionInfo.FileVersion }`,
  );
  const loaded = modules.split(/\r?\n/).filter(Boolean);
  expect(loaded, `onnxruntime.dll modules of process ${pid}: ${modules}`).toHaveLength(1);
  const [file, version] = (loaded[0] as string).split("|") as [string, string];
  expect(version).toMatch(/^1\.30\./);
  expect(await sha256(file)).toBe(
    await sha256(
      join(unpacked, "onnxruntime-node", "bin", "napi-v6", "win32", "x64", "onnxruntime.dll"),
    ),
  );

  const providers = (await run("logman.exe", ["query", "providers", "-pid", String(pid)])).stdout;
  expect(providers, "logman listed no providers for the process").toMatch(/Provider/i);
  expect(providers).not.toMatch(/ONNXRuntime/i);
}
