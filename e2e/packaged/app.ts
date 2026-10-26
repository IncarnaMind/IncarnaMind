import { existsSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";

const root = resolve(__dirname, "../..");
export const packagedExecutable =
  process.env.INCARNAMIND_PACKAGED_APP ??
  join(
    root,
    "dist",
    process.arch === "arm64" ? "mac-arm64" : "mac",
    "IncarnaMind.app/Contents/MacOS/IncarnaMind",
  );
const modelCache = process.env.INCARNAMIND_MODEL_CACHE;

export async function launchPackaged(
  home: string,
  data: string,
  { speech, testHooks }: { speech?: string; testHooks?: boolean } = {},
): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/KEY|TOKEN|SECRET|PASSWORD/.test(name)) env[name] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    executablePath: packagedExecutable,
    args: [
      "--use-mock-keychain",
      ...(speech
        ? [
            // Chromium's fake microphone plays this file; its audio service reads it only unsandboxed.
            "--no-sandbox",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${speech}`,
          ]
        : []),
    ],
    env: {
      ...env,
      HOME: home,
      INCARNAMIND_DATA_DIR: data,
      ...(testHooks ? { INCARNAMIND_TEST_HOOKS: "1" } : {}),
    },
  });
}

export async function copyModelsIn(dataDir: string): Promise<void> {
  if (modelCache !== undefined && existsSync(join(modelCache, "models"))) {
    await cp(join(modelCache, "models"), join(dataDir, "models"), { recursive: true });
  }
}

export async function copyModelsOut(dataDir: string): Promise<void> {
  if (modelCache !== undefined && existsSync(join(dataDir, "models"))) {
    await cp(join(dataDir, "models"), join(modelCache, "models"), { recursive: true });
  }
}

export async function packagedLogLines(dataDir: string, match: RegExp): Promise<string[]> {
  const logs = join(dataDir, "logs");
  const files = existsSync(logs) ? await readdir(logs) : [];
  return (await Promise.all(files.map((file) => readFile(join(logs, file), "utf8"))))
    .flatMap((text) => text.split("\n"))
    .filter((line) => match.test(line));
}
