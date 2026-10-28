import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";
import { homeEnv } from "../../tests/helpers/home";

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

/**
 * What ONNX Runtime reads to keep its telemetry off by itself: a CI run, or its own tests. The app
 * is started without them, so a missing opt-out of the app's own shows up in a CI run too (#2145).
 */
const RUNTIME_SELF_OPT_OUT = new Set([
  "CI",
  "TF_BUILD",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "CODEBUILD_BUILD_ID",
  "BUILDKITE",
  "TEAMCITY_VERSION",
  "APPVEYOR",
  "BITBUCKET_BUILD_NUMBER",
  "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI",
  "ORT_RUNNING_UNIT_TESTS",
  "ORT_DISABLE_TELEMETRY",
]);

export async function launchPackaged(
  home: string,
  data: string,
  {
    speech,
    testHooks,
    documents,
  }: { speech?: string; testHooks?: boolean; documents?: boolean } = {},
): Promise<ElectronApplication> {
  const temp = join(home, "Temp");
  await mkdir(temp, { recursive: true });
  if (documents) await mkdir(join(home, "Documents"), { recursive: true });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !/KEY|TOKEN|SECRET|PASSWORD/.test(name) &&
      !RUNTIME_SELF_OPT_OUT.has(name)
    ) {
      env[name] = value;
    }
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
      ...homeEnv(home),
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
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

/**
 * Where ONNX Runtime keeps its device id and its queue of usage events under the app's home folder
 * (#2145): Application Support on macOS, and the cache folder on Linux, which the app's XDG_CACHE_HOME
 * puts at ~/.cache. It makes the folder when it starts, so a home without it never ran with
 * telemetry on. The Windows library keeps none.
 */
export const runtimeTelemetryFolders = (home: string): string[] => {
  const folder = join("Microsoft", "DeveloperTools", ".onnxruntime");
  if (process.platform === "darwin") return [join(home, "Library", "Application Support", folder)];
  if (process.platform === "linux") return [join(home, ".cache", folder)];
  return [];
};
