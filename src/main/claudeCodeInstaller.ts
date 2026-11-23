import { type ChildProcess, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdtemp, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  ClaudeCodeAdapterInstallResult,
  ClaudeCodeAuthCheck,
  ClaudeCodeInstaller,
  ClaudeCodeSignInResult,
} from "../core/adapters";
import { stopProcessTree } from "../core/execution";

/** Official unmodified Anthropic Claude Code installer URLs over HTTPS (#3638). */
const MAC_LINUX_INSTALLER_URL = "https://claude.ai/install.sh";
const WINDOWS_INSTALLER_URL = "https://claude.ai/install.ps1";

const FETCH_TIMEOUT_MS = 30_000;
const AUTH_STATUS_TIMEOUT_MS = 15_000;
const CANCEL_EXIT_WAIT_MS = 3_000;
const MAX_CAPTURE_BYTES = 16 * 1024;

const NETWORK_ERROR_RE =
  /curl:|wget:|Invoke-RestMethod|Invoke-WebRequest|Could not resolve|Connection refused|Download failed|unreachable|timed out|not available in your region|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|ERR_PROXY|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i;
const CHECKSUM_ERROR_RE = /Checksum verification failed/i;
const UNSUPPORTED_ERROR_RE =
  /Unsupported operating system|Unsupported architecture|32-bit Windows/i;
const NO_PLAN_RE =
  /does not include|not included|subscription|upgrade your plan|free plan|no.*access.*claude code|billing_error|plan does not support/i;

export interface ClaudeCodeInstallerOptions {
  home: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const binaryNameFor = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "claude.exe" : "claude";

const installDirectoryDisplayFor = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "%USERPROFILE%\\.local\\bin" : "~/.local/bin";

async function isRunnableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  if (platform === "win32") return true;
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name.toUpperCase() && typeof value === "string") return value;
  }
  return "";
}

function childEnvironment(
  base: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Never inherit sudo or Electron Node-mode flags into Anthropic's user-space installer.
  delete env.SUDO_USER;
  delete env.ELECTRON_RUN_AS_NODE;
  env.HOME = home;
  if (platform === "win32") env.USERPROFILE = home;
  return env;
}

function classifyInstallFailure(text: string): "network" | "checksum" | "unsupported" | "failed" {
  if (CHECKSUM_ERROR_RE.test(text)) return "checksum";
  if (UNSUPPORTED_ERROR_RE.test(text)) return "unsupported";
  if (NETWORK_ERROR_RE.test(text)) return "network";
  return "failed";
}

function parseAuthStatusJson(output: string): ClaudeCodeAuthCheck | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.loggedIn === false) return { kind: "signed-out" };
    if (record.loggedIn === true) {
      const method = typeof record.authMethod === "string" ? record.authMethod : "";
      const sub = typeof record.subscriptionType === "string" ? record.subscriptionType.trim() : "";
      if (method === "claude.ai" && /^(free|none)$/i.test(sub)) return { kind: "no-plan" };
      return { kind: "signed-in" };
    }
    return null;
  } catch {
    return null;
  }
}

async function waitForChildOrCancel(
  child: ChildProcess,
  signal: AbortSignal,
): Promise<{ code: number | null; spawnError?: Error } | "cancel-timeout"> {
  const closed = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, spawnError: error }));
    child.once("close", (code) => resolve({ code }));
  });
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveTimeout: (() => void) | undefined;
  const cancelTimedOut = new Promise<"cancel-timeout">((resolve) => {
    resolveTimeout = () => resolve("cancel-timeout");
  });
  const onAbort = () => {
    stopProcessTree(child);
    cancelTimer = setTimeout(() => resolveTimeout?.(), CANCEL_EXIT_WAIT_MS);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([closed, cancelTimedOut]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearTimeout(cancelTimer);
  }
}

export function createClaudeCodeInstaller(
  options: ClaudeCodeInstallerOptions,
): ClaudeCodeInstaller {
  const platform = options.platform ?? process.platform;
  const baseEnv = options.env ?? process.env;
  const doFetch =
    options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const home = options.home;
  const binaryName = binaryNameFor(platform);
  const localBinDir = join(home, ".local", "bin");
  const localBinaryPath = join(localBinDir, binaryName);

  async function findBinary(): Promise<string | null> {
    if (await isRunnableFile(localBinaryPath, platform)) return localBinaryPath;
    const pathValue = envValue(baseEnv, "PATH");
    const names =
      platform === "win32"
        ? (envValue(baseEnv, "PATHEXT") || ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
            .map((ext) => `claude${ext}`)
        : ["claude"];
    for (const dir of pathValue.split(delimiter).filter(Boolean)) {
      if (!isAbsolute(dir)) continue;
      for (const name of names) {
        const candidate = join(dir, name);
        if (await isRunnableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  }

  return {
    installDirectoryDisplay: installDirectoryDisplayFor(platform),
    findBinary,

    async install({ signal, onStage }): Promise<ClaudeCodeAdapterInstallResult> {
      const existing = await findBinary();
      if (existing !== null) return { kind: "already-installed", binaryPath: existing };
      if (signal.aborted) return { kind: "cancelled" };

      onStage?.("downloading");
      const installerUrl = platform === "win32" ? WINDOWS_INSTALLER_URL : MAC_LINUX_INSTALLER_URL;
      let scriptText: string;
      try {
        const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
        const response = await doFetch(installerUrl, { signal: fetchSignal, redirect: "follow" });
        if (!response.ok) {
          return { kind: "failed", reason: "network" };
        }
        scriptText = await response.text();
        if (!scriptText.trim()) return { kind: "failed", reason: "network" };
      } catch (error: unknown) {
        if (signal.aborted) return { kind: "cancelled" };
        const text = error instanceof Error ? `${error.name}: ${error.message}` : "";
        return { kind: "failed", reason: classifyInstallFailure(text || "fetch failed") };
      }

      if (signal.aborted) return { kind: "cancelled" };

      const claudeDir = join(home, ".claude");
      const downloadsDir = join(claudeDir, "downloads");
      const localShareClaudeDir = join(home, ".local", "share", "claude");
      const hadClaudeDir = existsSync(claudeDir);
      const hadDownloadsDir = existsSync(downloadsDir);
      const hadLocalShareClaudeDir = existsSync(localShareClaudeDir);
      const hadLocalBin = existsSync(localBinaryPath);
      const tempDir = await mkdtemp(join(tmpdir(), "incarnamind-claude-install-"));
      const scriptFile = join(tempDir, platform === "win32" ? "install.ps1" : "install.sh");

      const cleanupPartial = async () => {
        if (!hadDownloadsDir) {
          await rm(downloadsDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (!hadLocalShareClaudeDir) {
          await rm(localShareClaudeDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (!hadClaudeDir) {
          // Only removes an empty directory; never deletes any user data.
          await rmdir(claudeDir).catch(() => undefined);
        }
        if (!hadLocalBin) {
          await rm(localBinaryPath, { force: true }).catch(() => undefined);
        }
      };

      try {
        await writeFile(scriptFile, scriptText, { mode: 0o600, encoding: "utf8" });
        const env = childEnvironment(baseEnv, home, platform);
        const command =
          platform === "win32"
            ? existsSync(
                join(
                  envValue(env, "SystemRoot") || "C:\\Windows",
                  "System32",
                  "WindowsPowerShell",
                  "v1.0",
                  "powershell.exe",
                ),
              )
              ? join(
                  envValue(env, "SystemRoot") || "C:\\Windows",
                  "System32",
                  "WindowsPowerShell",
                  "v1.0",
                  "powershell.exe",
                )
              : "powershell.exe"
            : existsSync("/bin/bash")
              ? "/bin/bash"
              : "bash";
        const args =
          platform === "win32"
            ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile]
            : [scriptFile];

        const child = spawn(command, args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: platform !== "win32",
          windowsHide: true,
        });

        let output = "";
        let settingUp = false;
        const append = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (output.length < MAX_CAPTURE_BYTES) output += text;
          if (!settingUp && /Setting up Claude Code/i.test(text)) {
            settingUp = true;
            onStage?.("installing");
          }
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);

        const result = await waitForChildOrCancel(child, signal);

        if (signal.aborted || result === "cancel-timeout") {
          stopProcessTree(child);
          await cleanupPartial();
          return { kind: "cancelled" };
        }
        if (result.spawnError || result.code !== 0) {
          await cleanupPartial();
          const detail = result.spawnError ? result.spawnError.message : output;
          return { kind: "failed", reason: classifyInstallFailure(detail) };
        }

        const installedPath = await findBinary();
        if (!installedPath) {
          return { kind: "failed", reason: "failed" };
        }
        return { kind: "installed", binaryPath: installedPath };
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async startSignIn({ signal }): Promise<ClaudeCodeSignInResult> {
      const binary = await findBinary();
      if (!binary) return { kind: "failed", detail: "missing-binary" };
      if (signal.aborted) return { kind: "cancelled" };

      const env = childEnvironment(baseEnv, home, platform);
      const child = spawn(binary, ["auth", "login"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
        windowsHide: true,
      });

      let output = "";
      const append = (chunk: Buffer) => {
        if (output.length < MAX_CAPTURE_BYTES) output += chunk.toString("utf8");
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const result = await waitForChildOrCancel(child, signal);

      if (signal.aborted || result === "cancel-timeout") {
        stopProcessTree(child);
        return { kind: "cancelled" };
      }
      if (result.spawnError) return { kind: "failed", detail: result.spawnError.name };
      if (result.code === 0) return { kind: "signed-in" };
      if (NO_PLAN_RE.test(output)) return { kind: "no-plan" };
      return { kind: "failed", detail: `exit-${result.code ?? "unknown"}` };
    },

    async checkAuth(): Promise<ClaudeCodeAuthCheck> {
      const binary = await findBinary();
      if (!binary) return { kind: "missing" };

      const env = childEnvironment(baseEnv, home, platform);
      const child = spawn(binary, ["auth", "status", "--json"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
        windowsHide: true,
      });

      let output = "";
      const append = (chunk: Buffer) => {
        if (output.length < MAX_CAPTURE_BYTES) output += chunk.toString("utf8");
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const closed = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
        child.once("error", (error) => resolve({ code: null, spawnError: error }));
        child.once("close", (code) => resolve({ code }));
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), AUTH_STATUS_TIMEOUT_MS);
      });
      const result = await Promise.race([closed, timedOut]);
      clearTimeout(timer);

      if (result === "timeout") {
        stopProcessTree(child);
        return { kind: "unknown" };
      }
      if (result.spawnError) {
        const code = "code" in result.spawnError ? result.spawnError.code : undefined;
        return code === "ENOENT" ? { kind: "missing" } : { kind: "unknown" };
      }
      const parsed = parseAuthStatusJson(output);
      if (parsed) return parsed;
      if (result.code === 0) return { kind: "signed-in" };
      if (result.code === 1) return { kind: "signed-out" };
      return { kind: "unknown" };
    },
  };
}
