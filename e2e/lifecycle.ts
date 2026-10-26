import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { chromium, type ElectronApplication, expect, type Page } from "@playwright/test";
import { isRecord } from "../src/core/errors";
import { APP_ARGS, homeEnv, KEYCHAIN_ARGS } from "../tests/helpers/home";

export function mainExecutable(): string {
  const packaged = process.env.INCARNAMIND_PACKAGED_APP;
  if (packaged === undefined) return require("electron") as unknown as string;
  if (!packaged.trim()) throw new Error("The packaged executable path is empty.");
  return resolve(packaged);
}

function mainPreloads(args: string[]): { preloads: string[]; remaining: string[] } {
  const preloads: string[] = [];
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-r" || arg === "--require") {
      const file = args[++index];
      if (!file) throw new Error("The lifecycle preload has no file path.");
      preloads.push(resolve(file));
    } else if (arg?.startsWith("--require=")) {
      preloads.push(resolve(arg.slice("--require=".length)));
    } else if (arg !== undefined) remaining.push(arg);
  }
  return { preloads, remaining };
}

export const mainArguments = (args: string[] = []): string[] => [
  ...KEYCHAIN_ARGS,
  "--no-sandbox",
  ...(process.env.INCARNAMIND_PACKAGED_APP ? mainPreloads(args).remaining : args),
  ...(process.env.INCARNAMIND_PACKAGED_APP ? [] : [resolve(__dirname, "..")]),
  ...APP_ARGS,
];

export const lifecycleHomeEnv = (home: string): Record<string, string> => ({
  ...homeEnv(home),
  TMPDIR: home,
  TMP: home,
  TEMP: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
});

export async function assertPackagedMain(app: ElectronApplication): Promise<void> {
  const executable = process.env.INCARNAMIND_PACKAGED_APP;
  if (!executable) return;
  const actual = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    executable: process.execPath,
    lifecycleMain: (globalThis as { incarnamindLifecycleMain?: { realMain: string } })
      .incarnamindLifecycleMain,
  }));
  const key = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  expect(actual.packaged).toBe(true);
  expect(key(actual.executable)).toBe(key(executable));
  expect(key(actual.appPath)).toBe(key(join(actual.resourcesPath, "app.asar")));
  expect(actual.lifecycleMain?.realMain).toBe(join(actual.appPath, "out", "main", "index.js"));
}

export function startLifecycleCopy(
  dataDir: string,
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): ChildProcess {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name))
      env[name] = value;
  }
  Object.assign(env, lifecycleHomeEnv(home), {
    INCARNAMIND_DATA_DIR: dataDir,
    INCARNAMIND_TEST_HOOKS: "1",
    INCARNAMIND_TEST_EMBEDDER: "fake",
    INCARNAMIND_TEST_TRANSCRIBER: "fake",
    INCARNAMIND_TEST_AUDIO: "fake",
    INCARNAMIND_TEST_CONNECTOR_REGISTRY: "http://127.0.0.1:9",
    ...extraEnv,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.INCARNAMIND_CHATGPT_PROFILE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.NODE_OPTIONS;
  if (process.env.INCARNAMIND_PACKAGED_APP)
    env.INCARNAMIND_TEST_MAIN_PRELOADS = JSON.stringify(mainPreloads(args).preloads);
  return spawn(mainExecutable(), mainArguments(args), { env, stdio: "ignore", detached: true });
}

export const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        fail(new Error("The lifecycle test has no listening port."));
        return;
      }
      server.close(() => done(address.port));
    });
  });

/** Zero while the copy has not opened its DevTools listener. */
export async function windowsOf(port: number): Promise<number> {
  try {
    const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (!Array.isArray(targets)) throw new Error("The copy returned no DevTools targets.");
    return targets.filter(
      (each) =>
        isRecord(each) &&
        each.type === "page" &&
        typeof each.url === "string" &&
        each.url.startsWith("file://"),
    ).length;
  } catch (error) {
    if (error instanceof TypeError && error.message === "fetch failed") return 0;
    throw error;
  }
}

export async function inCopyWindow(
  port: number | undefined,
  use: (window: Page) => Promise<void>,
): Promise<void> {
  if (port === undefined) throw new Error("The copy has no DevTools port.");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const window = browser.contexts()[0]?.pages()[0];
    if (!window) throw new Error("The copy has no window.");
    await window.getByTestId("plus-menu").waitFor();
    await use(window);
  } finally {
    await browser.close();
  }
}

export interface ListedCopy {
  pid: number;
  args: string;
}

const windowsInventory = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$tag = $env:INCARNAMIND_PROCESS_TAG
$folder = $env:INCARNAMIND_PROCESS_FOLDER
$rows = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.CommandLine -and
  $_.ExecutablePath.StartsWith($folder, [System.StringComparison]::OrdinalIgnoreCase) -and
  $_.CommandLine.Contains($tag)
} | ForEach-Object { @{ pid = [int]$_.ProcessId; args = [string]$_.CommandLine } })
ConvertTo-Json -InputObject $rows -Compress
`;

export function listedCopies(tag: string, executable = mainExecutable()): ListedCopy[] {
  if (!tag || /\s/.test(tag))
    throw new Error("A lifecycle process tag must be one nonempty argument.");
  const directory =
    process.platform === "darwin" ? dirname(dirname(executable)) : dirname(executable);
  const prefix = resolve(directory) + sep;
  if (process.platform === "win32") {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsInventory],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, INCARNAMIND_PROCESS_TAG: tag, INCARNAMIND_PROCESS_FOLDER: prefix },
      },
    );
    const rows: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
    if (!Array.isArray(rows))
      throw new Error("The Windows lifecycle process inventory is not a list.");
    return rows.map((row) => {
      if (
        !isRecord(row) ||
        !Number.isSafeInteger(row.pid) ||
        typeof row.pid !== "number" ||
        row.pid <= 0 ||
        typeof row.args !== "string" ||
        !row.args.includes(tag)
      )
        throw new Error("The Windows lifecycle process inventory has an invalid row.");
      return { pid: row.pid, args: row.args };
    });
  }
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("The lifecycle process inventory cannot identify this user.");
  const output = execFileSync("ps", ["-A", "-ww", "-o", "uid=", "-o", "pid=", "-o", "args="], {
    encoding: "utf8",
  });
  return output.split("\n").flatMap((line) => {
    const [, owner, pid, args = ""] = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/) ?? [];
    return pid && Number(owner) === uid && args.startsWith(prefix) && args.includes(tag)
      ? [{ pid: Number(pid), args }]
      : [];
  });
}

export const copiesWith = (tag: string, relaunching = false): number[] =>
  listedCopies(tag).flatMap(({ pid, args }) =>
    !args.includes("--type=") || (relaunching && args.includes("--type=relauncher")) ? [pid] : [],
  );

export function killCopies(tag: string, executable = mainExecutable()): number[] {
  for (const { pid } of listedCopies(tag, executable)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ESRCH") throw error;
    }
  }
  return listedCopies(tag, executable).map(({ pid }) => pid);
}
