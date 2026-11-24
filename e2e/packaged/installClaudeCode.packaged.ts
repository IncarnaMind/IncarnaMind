import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../../src/core/api";
import { dismissChatSetup, openSettings } from "../app";
import { launchPackaged, packagedExecutable, packagedLogLines } from "./app";

test.use({ trace: "off" });
test.setTimeout(5 * 60_000);

const binaryName = process.platform === "win32" ? "claude.exe" : "claude";

function pathKey(): string {
  return Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * Strips any directory on PATH that already contains a `claude` executable so the packaged test
 * always starts from a clean machine with no command-line AI installed, even on a developer
 * workstation that has Claude Code installed globally.
 */
function pathWithoutClaude(): Record<string, string> {
  const key = pathKey();
  const raw = process.env[key] ?? "";
  const candidates =
    process.platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude.bat", "claude.com"]
      : ["claude"];
  const filtered = raw
    .split(delimiter)
    .filter((dir) => dir && !candidates.some((name) => existsSync(join(dir, name))));
  return { [key]: filtered.join(delimiter) };
}

function readWindowsUserPath(): string | null {
  if (process.platform !== "win32") return null;
  const out = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path', 'User')",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return out.status === 0 ? out.stdout.trim() : null;
}

function restoreWindowsUserPath(value: string): void {
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::SetEnvironmentVariable('Path', $env:IM_RESTORE_PATH, 'User')",
    ],
    { env: { ...process.env, IM_RESTORE_PATH: value }, encoding: "utf8", windowsHide: true },
  );
}

async function isolatedHomeEnv(
  root: string,
  home: string,
): Promise<{ env: Record<string, string>; browserOpenedFile: string | null }> {
  const env: Record<string, string> = {
    ...pathWithoutClaude(),
    DISABLE_AUTOUPDATER: "1",
  };
  if (process.platform === "win32") {
    const localAppData = join(home, "AppData", "Local");
    const appData = join(home, "AppData", "Roaming");
    await mkdir(localAppData, { recursive: true });
    await mkdir(appData, { recursive: true });
    env.LOCALAPPDATA = localAppData;
    env.APPDATA = appData;
    return { env, browserOpenedFile: null };
  }
  // Record the exact URL `claude auth login` asks the browser to open without opening a desktop browser.
  const browserOpenedFile = join(root, "browser-opened.txt");
  const opener = join(root, "browser-opener.sh");
  await writeFile(opener, `#!/bin/sh\nprintf "%s\\n" "$1" > "${browserOpenedFile}"\n`, "utf8");
  await chmod(opener, 0o755);
  env.BROWSER = opener;
  return { env, browserOpenedFile };
}

let folders: string[] = [];
let dataFolder: string | null = null;

test.afterEach(async () => {
  const info = test.info();
  if (dataFolder && info.status !== info.expectedStatus) {
    const log = (await packagedLogLines(dataFolder, /./)).join("\n");
    await mkdir(info.outputDir, { recursive: true });
    const path = info.outputPath("app.log");
    await writeFile(path, log);
    await info.attach("app-log", { path, contentType: "text/plain" });
    console.info(`Retained the failing app's data at ${dataFolder}`);
    folders = [];
    dataFolder = null;
    return;
  }
  for (const folder of folders) {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
  folders = [];
  dataFolder = null;
});

test("packaged app installs real Claude Code into a temporary home and reaches the real browser sign-in handoff without signing in (#3638)", async () => {
  test.skip(!existsSync(packagedExecutable), `Build first: ${packagedExecutable}`);

  const root = await mkdtemp(join(tmpdir(), "incarnamind-packaged-install-"));
  const home = join(root, "home");
  const data = join(root, "data");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  folders = [root];
  dataFolder = data;

  const userPathBefore = readWindowsUserPath();
  const { env: extraEnv, browserOpenedFile } = await isolatedHomeEnv(root, home);
  const app = await launchPackaged(home, data, { extraEnv });
  try {
    const window = await app.firstWindow();
    await dismissChatSetup(window);
    await openSettings(window, "ai");

    const installedBinary = join(home, ".local", "bin", binaryName);
    expect(existsSync(installedBinary)).toBe(false);

    // Before pressing Install, the offer is shown and no install consent is recorded.
    const offer = window.getByTestId("claude-code-install-offer");
    await expect(offer).toBeVisible();
    const consentBefore = await window.evaluate(async () => {
      const flows = await (
        globalThis as unknown as { incarnamind: CoreBridge }
      ).incarnamind.listDataFlows();
      return flows.find((each) => each.flow.id === "agent-install")?.consent ?? "not-asked";
    });
    expect(consentBefore).toBe("not-asked");

    // One press starts Anthropic's official installer in the background with no terminal.
    await offer.getByTestId("install-claude-code").click();
    await expect(window.getByTestId("claude-code-install-progress")).toBeVisible();

    // Real installer finishes and reaches the browser sign-in handoff. Stop here; never sign in.
    const signIn = window.getByTestId("claude-code-install-signin");
    await expect(signIn).toBeVisible({ timeout: 3 * 60_000 });
    await expect(signIn).toContainText("Sign in to Claude Code in your browser");

    // Prove the real `claude auth login` subprocess actually launched headless and handed off to Anthropic's OAuth URL.
    if (browserOpenedFile) {
      await expect
        .poll(() => (existsSync(browserOpenedFile) ? readFile(browserOpenedFile, "utf8") : ""), {
          timeout: 20_000,
        })
        .toMatch(/^https:\/\/(claude\.ai|claude\.com)\/.*oauth\/authorize/i);
    } else {
      await window.waitForTimeout(2_000);
      await expect(signIn).toBeVisible();
    }

    // Audit what Anthropic's Windows installer changes in HKCU User PATH outside the temp home.
    if (process.platform === "win32") {
      const userPathAfter = readWindowsUserPath();
      console.info(
        `[windows-user-path-audit] changed=${userPathAfter !== userPathBefore} beforeLen=${userPathBefore?.length ?? 0} afterLen=${userPathAfter?.length ?? 0}`,
      );
    }

    // Official binary is installed under the temporary home and runs cleanly.
    expect(existsSync(installedBinary)).toBe(true);
    const version = spawnSync(installedBinary, ["--version"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, DISABLE_AUTOUPDATER: "1" },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim().length).toBeGreaterThan(0);

    // ADR-0022 consent was recorded on the explicit press.
    const consentAfter = await window.evaluate(async () => {
      const flows = await (
        globalThis as unknown as { incarnamind: CoreBridge }
      ).incarnamind.listDataFlows();
      return flows.find((each) => each.flow.id === "agent-install")?.consent === "accepted";
    });
    expect(consentAfter).toBe(true);

    // Cancel stops `claude auth login` cleanly; since Claude Code is now installed, the offer hides.
    await signIn.getByTestId("claude-code-install-cancel").click();
    await expect(signIn).toHaveCount(0);
    await expect(window.getByTestId("claude-code-install-offer")).toHaveCount(0);
  } finally {
    await app.close();
    if (userPathBefore !== null) {
      const userPathAfter = readWindowsUserPath();
      if (userPathAfter !== userPathBefore) restoreWindowsUserPath(userPathBefore);
    }
  }
});

test("cancelling while the real packaged installer subprocess is running stops the process tree and cleans up (#3638)", async () => {
  test.skip(!existsSync(packagedExecutable), `Build first: ${packagedExecutable}`);

  const root = await mkdtemp(join(tmpdir(), "incarnamind-packaged-cancel-"));
  const home = join(root, "home");
  const data = join(root, "data");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  folders = [root];
  dataFolder = data;

  const { env: extraEnv } = await isolatedHomeEnv(root, home);
  const app = await launchPackaged(home, data, { extraEnv });
  try {
    const window = await app.firstWindow();
    await dismissChatSetup(window);
    await openSettings(window, "ai");

    const downloadsDir = join(home, ".claude", "downloads");
    await window.getByTestId("install-claude-code").click();
    const progress = window.getByTestId("claude-code-install-progress");
    await expect(progress).toBeVisible();

    // Wait until the real installer script has launched and created `~/.claude/downloads` so Cancel
    // provably terminates the running installer process tree rather than only aborting the script fetch.
    await expect
      .poll(() => existsSync(downloadsDir), {
        timeout: 30_000,
        intervals: [50, 100, 200],
      })
      .toBe(true);

    await progress.getByTestId("claude-code-install-cancel").click();

    await expect(window.getByTestId("claude-code-install-offer")).toBeVisible({ timeout: 15_000 });
    expect(existsSync(downloadsDir)).toBe(false);
    expect(existsSync(join(home, ".local", "bin", binaryName))).toBe(false);

    // Confirm no lingering child process recreates partial downloads after Cancel returns.
    await window.waitForTimeout(1_500);
    expect(existsSync(downloadsDir)).toBe(false);
    expect(existsSync(join(home, ".local", "bin", binaryName))).toBe(false);
  } finally {
    await app.close();
  }
});

test("packaged Claude Code install shows plain failure words, Try again, and Anthropic's setup guide when unreachable (#3638)", async () => {
  test.skip(!existsSync(packagedExecutable), `Build first: ${packagedExecutable}`);

  const root = await mkdtemp(join(tmpdir(), "incarnamind-packaged-fail-"));
  const home = join(root, "home");
  const data = join(root, "data");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  folders = [root];
  dataFolder = data;

  const { env: baseIsolated } = await isolatedHomeEnv(root, home);
  const extraEnv = {
    ...baseIsolated,
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
  };
  const app = await launchPackaged(home, data, {
    extraArgs: ["--proxy-server=http://127.0.0.1:9"],
    extraEnv,
  });
  try {
    const window = await app.firstWindow();
    await dismissChatSetup(window);
    await openSettings(window, "ai");

    await window.getByTestId("install-claude-code").click();
    const failed = window.getByTestId("claude-code-install-failed");
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed).toHaveAttribute("data-reason", "network");
    await expect(failed).toContainText("Couldn’t install Claude Code");
    await expect(failed.getByTestId("claude-code-install-retry")).toHaveText("Try again");
    await expect(failed.getByTestId("claude-code-install-guide")).toHaveAttribute(
      "href",
      "https://code.claude.com/docs/en/setup",
    );
    expect(existsSync(join(home, ".local", "bin", binaryName))).toBe(false);
  } finally {
    await app.close();
  }
});
