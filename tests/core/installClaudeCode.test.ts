import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ClaudeCodeAdapterInstallResult,
  ClaudeCodeAuthCheck,
  ClaudeCodeInstaller,
  ClaudeCodeSignInResult,
} from "../../src/core/adapters";
import type { ClaudeCodeInstallState } from "../../src/core/api";
import { createTempDataFolder, startCore } from "../helpers/core";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface StandInControls {
  installer: ClaudeCodeInstaller;
  binary: string | null;
  root: boolean;
  auth: ClaudeCodeAuthCheck;
  installCalls: number;
  signInCalls: number;
  authCalls: number;
  findGate: ReturnType<typeof deferred<string | null>> | null;
  authGate: ReturnType<typeof deferred<ClaudeCodeAuthCheck>> | null;
  installGate: ReturnType<typeof deferred<ClaudeCodeAdapterInstallResult>> | null;
  signInGate: ReturnType<typeof deferred<ClaudeCodeSignInResult>> | null;
  onStageRef: { fn?: (stage: "downloading" | "installing") => void };
}

function createStandIn(): StandInControls {
  const controls: StandInControls = {
    binary: null,
    root: false,
    auth: { kind: "signed-out" },
    installCalls: 0,
    signInCalls: 0,
    authCalls: 0,
    findGate: null,
    authGate: null,
    installGate: null,
    signInGate: null,
    onStageRef: {},
    installer: {
      installDirectoryDisplay: "~/.local/bin",
      isRoot: () => controls.root,
      async findBinary() {
        if (controls.findGate) return controls.findGate.promise;
        return controls.binary;
      },
      async install({ signal, onStage }) {
        controls.installCalls++;
        controls.onStageRef.fn = onStage;
        onStage?.("downloading");
        const gate = controls.installGate;
        if (!gate) {
          controls.binary = "/tmp/fake-home/.local/bin/claude";
          return { kind: "installed", binaryPath: controls.binary };
        }
        return new Promise<ClaudeCodeAdapterInstallResult>((resolve) => {
          const onAbort = () => resolve({ kind: "cancelled" });
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          void gate.promise.then((result) => {
            signal.removeEventListener("abort", onAbort);
            if (result.kind === "installed") controls.binary = result.binaryPath;
            resolve(result);
          });
        });
      },
      async startSignIn({ signal }) {
        controls.signInCalls++;
        const gate = controls.signInGate;
        if (!gate) return { kind: "signed-in" };
        return new Promise<ClaudeCodeSignInResult>((resolve) => {
          const onAbort = () => resolve({ kind: "cancelled" });
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          void gate.promise.then((result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          });
        });
      },
      async checkAuth() {
        controls.authCalls++;
        if (controls.authGate) return controls.authGate.promise;
        return controls.auth;
      },
    },
  };
  return controls;
}

async function waitForState(
  states: ClaudeCodeInstallState[],
  predicate: (state: ClaudeCodeInstallState) => boolean,
): Promise<ClaudeCodeInstallState> {
  for (let i = 0; i < 100; i++) {
    const match = states.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for state. Seen: ${JSON.stringify(states)}`);
}

describe("Claude Code one-press installation through CoreApi (#3638)", () => {
  it("reports unsupported when no installer adapter is supplied", async () => {
    const data = await createTempDataFolder();
    const core = await startCore(data);
    try {
      const avail = await core.getClaudeCodeInstallAvailability();
      expect(avail.supported).toBe(false);
      expect(await core.getClaudeCodeInstallState()).toEqual({ kind: "idle" });
      expect(await core.installClaudeCode()).toEqual({ kind: "failed", reason: "unsupported" });
    } finally {
      await core.close();
      await rm(data, { recursive: true, force: true });
    }
  });

  it("downloads nothing before press, records ADR-0022 consent on press, reports progress, and hands off to browser sign-in", async () => {
    const data = await createTempDataFolder();
    const home = await createTempDataFolder();
    const standIn = createStandIn();
    standIn.installGate = deferred<ClaudeCodeAdapterInstallResult>();
    standIn.signInGate = deferred<ClaudeCodeSignInResult>();
    const core = await startCore(data, {
      claudeCodeInstaller: standIn.installer,
      paths: { home },
      agents: { applications: [] },
    });
    const seen: ClaudeCodeInstallState[] = [];
    core.on("claudeCodeInstall.changed", (next) => seen.push(next));

    try {
      // Nothing downloaded or consented before the User presses Install.
      expect(await core.getClaudeCodeInstallAvailability()).toEqual({
        supported: true,
        installed: false,
        cliAgentPresent: false,
        directory: "~/.local/bin",
      });
      const flowsBefore = await core.listDataFlows();
      expect(flowsBefore.filter((f) => f.flow.id === "agent-install")).toEqual([]);
      expect(standIn.installCalls).toBe(0);

      // Press Install: consent is recorded and progress starts.
      const started = await core.installClaudeCode();
      expect(started).toEqual({
        kind: "installing",
        stage: "downloading",
        directory: "~/.local/bin",
      });
      const flowsAfter = await core.listDataFlows();
      const installEntries = flowsAfter.filter((f) => f.flow.id === "agent-install");
      expect(installEntries).toHaveLength(1);
      expect(installEntries[0]?.consent).toBe("accepted");
      expect(installEntries[0]?.chosen).toBe(true);

      // Progress advances to installing stage.
      standIn.onStageRef.fn?.("installing");
      await waitForState(seen, (s) => s.kind === "installing" && s.stage === "installing");

      // Finish install -> hands off to browser sign-in.
      standIn.installGate.resolve({
        kind: "installed",
        binaryPath: join(home, ".local", "bin", "claude"),
      });
      await waitForState(seen, (s) => s.kind === "awaiting-sign-in");
      expect(standIn.signInCalls).toBe(1);

      // "I've signed in" before browser sign-in completes reports notYet.
      expect(await core.checkClaudeCodeAuth()).toEqual({ kind: "awaiting-sign-in", notYet: true });

      // Once signed in, checkClaudeCodeAuth transitions to signed-in and stops waiting.
      standIn.auth = { kind: "signed-in" };
      expect(await core.checkClaudeCodeAuth()).toEqual({ kind: "signed-in" });
      expect((await core.getClaudeCodeInstallAvailability()).installed).toBe(true);
      expect((await core.getClaudeCodeInstallAvailability()).cliAgentPresent).toBe(true);
    } finally {
      await core.close();
      await rm(data, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("leaves an already-installed claude untouched without downloading or recording download consent", async () => {
    const data = await createTempDataFolder();
    const home = await createTempDataFolder();
    const standIn = createStandIn();
    standIn.binary = join(home, ".local", "bin", "claude");
    standIn.auth = { kind: "signed-in" };
    const core = await startCore(data, {
      claudeCodeInstaller: standIn.installer,
      paths: { home },
      agents: { applications: [] },
    });

    try {
      const avail = await core.getClaudeCodeInstallAvailability();
      expect(avail.installed).toBe(true);
      expect(avail.cliAgentPresent).toBe(true);
      const clients = await core.listAgentClients();
      expect(clients.find((c) => c.id === "claude-code")?.installed).toBe(true);

      const next = await core.installClaudeCode();
      expect(next).toEqual({ kind: "signed-in" });
      expect(standIn.installCalls).toBe(0);
      expect((await core.listDataFlows()).filter((f) => f.flow.id === "agent-install")).toEqual([]);
    } finally {
      await core.close();
      await rm(data, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("offers install when only Claude Desktop is present", async () => {
    const data = await createTempDataFolder();
    const home = await createTempDataFolder();
    const apps = await createTempDataFolder();
    if (process.platform === "darwin") {
      await mkdir(join(apps, "Claude.app"), { recursive: true });
    } else if (process.platform === "win32") {
      await mkdir(join(apps, "AnthropicClaude"), { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(apps, "AnthropicClaude", "claude.exe"), "");
    } else {
      await mkdir(join(apps, "com.anthropic.Claude.desktop"), { recursive: true });
    }
    const standIn = createStandIn();
    const core = await startCore(data, {
      claudeCodeInstaller: standIn.installer,
      paths: { home },
      agents: { applications: [apps] },
    });
    try {
      const clients = await core.listAgentClients();
      expect(clients.find((c) => c.id === "claude-desktop")?.installed).toBe(true);
      const avail = await core.getClaudeCodeInstallAvailability();
      expect(avail.supported).toBe(true);
      expect(avail.cliAgentPresent).toBe(false);
    } finally {
      await core.close();
      await rm(data, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(apps, { recursive: true, force: true });
    }
  });

  it("cancels cleanly mid-install and supports a clean retry", async () => {
    const data = await createTempDataFolder();
    const home = await createTempDataFolder();
    const standIn = createStandIn();
    standIn.installGate = deferred<ClaudeCodeAdapterInstallResult>();
    const core = await startCore(data, {
      paths: { home },
      claudeCodeInstaller: standIn.installer,
      agents: { applications: [] },
    });
    const seen: ClaudeCodeInstallState[] = [];
    core.on("claudeCodeInstall.changed", (next) => seen.push(next));

    try {
      await core.installClaudeCode();
      expect((await core.getClaudeCodeInstallState()).kind).toBe("installing");
      expect(await core.cancelClaudeCodeInstall()).toEqual({ kind: "idle" });
      expect(standIn.installCalls).toBe(1);

      // Retry succeeds cleanly.
      standIn.installGate = null;
      standIn.auth = { kind: "signed-in" };
      await core.installClaudeCode();
      await waitForState(seen, (s) => s.kind === "signed-in");
      expect(standIn.installCalls).toBe(2);
    } finally {
      await core.close();
      await rm(data, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("surfaces installer failures, refuses in Local mode without downloading, and detects a plan without Claude Code", async () => {
    const data = await createTempDataFolder();
    const home = await createTempDataFolder();
    const standIn = createStandIn();
    const core = await startCore(data, {
      paths: { home },
      claudeCodeInstaller: standIn.installer,
      agents: { applications: [] },
    });
    const seen: ClaudeCodeInstallState[] = [];
    core.on("claudeCodeInstall.changed", (next) => seen.push(next));

    try {
      // Local mode refuses before touching network or recording consent.
      await core.setLocalOnly(true);
      expect(await core.installClaudeCode()).toEqual({ kind: "failed", reason: "local-mode" });
      expect(standIn.installCalls).toBe(0);
      await core.setLocalOnly(false);

      // Network failure during install.
      standIn.installGate = deferred<ClaudeCodeAdapterInstallResult>();
      await core.installClaudeCode();
      standIn.installGate.resolve({ kind: "failed", reason: "network" });
      await waitForState(seen, (s) => s.kind === "failed" && s.reason === "network");

      // Retry succeeds, but signed-in plan does not include Claude Code.
      standIn.installGate = null;
      standIn.signInGate = deferred<ClaudeCodeSignInResult>();
      standIn.auth = { kind: "signed-out" };
      await core.installClaudeCode();
      await waitForState(seen, (s) => s.kind === "awaiting-sign-in");
      standIn.signInGate.resolve({ kind: "no-plan" });
      await waitForState(seen, (s) => s.kind === "no-plan");

      // "Try another account" reopens browser sign-in.
      standIn.signInGate = deferred<ClaudeCodeSignInResult>();
      const reopened = await core.openClaudeCodeSignIn();
      expect(reopened).toEqual({ kind: "awaiting-sign-in" });
      standIn.auth = { kind: "signed-in" };
      standIn.signInGate.resolve({ kind: "signed-in" });
      await waitForState(seen, (s) => s.kind === "signed-in");
      expect(await core.resetClaudeCodeInstall()).toEqual({ kind: "idle" });
    } finally {
      await core.close();
      await rm(data, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("prevents concurrent double-press installs even while findBinary is pending", async () => {
    const data = await createTempDataFolder();
    const home = await createTempDataFolder();
    const standIn = createStandIn();
    standIn.findGate = deferred<string | null>();
    standIn.installGate = deferred<ClaudeCodeAdapterInstallResult>();
    const core = await startCore(data, {
      paths: { home },
      claudeCodeInstaller: standIn.installer,
      agents: { applications: [] },
    });

    try {
      const first = core.installClaudeCode();
      const second = core.installClaudeCode();
      standIn.findGate.resolve(null);
      standIn.findGate = null;
      await Promise.all([first, second]);
      expect(standIn.installCalls).toBe(1);
      await core.cancelClaudeCodeInstall();
    } finally {
      await core.close();
      await rm(data, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("surfaces sign-in failures, never treats exit 0 without positive auth status as signed in, refuses root, and honours Local mode on every path", async () => {
    const data = await createTempDataFolder();
    const home = await createTempDataFolder();
    const standIn = createStandIn();
    const core = await startCore(data, {
      paths: { home },
      claudeCodeInstaller: standIn.installer,
      agents: { applications: [] },
    });
    const seen: ClaudeCodeInstallState[] = [];
    core.on("claudeCodeInstall.changed", (next) => seen.push(next));

    try {
      // Running as root refuses before touching network or recording consent.
      standIn.root = true;
      expect(await core.installClaudeCode()).toEqual({ kind: "failed", reason: "root" });
      expect(standIn.installCalls).toBe(0);
      const flowsBefore = await core.listDataFlows();
      expect(flowsBefore.find((f) => f.flow.id === "agent-install")).toBeUndefined();
      standIn.root = false;

      // Local mode turned on mid-install cancels immediately and reports local-mode.
      standIn.installGate = deferred<ClaudeCodeAdapterInstallResult>();
      await core.installClaudeCode();
      expect((await core.getClaudeCodeInstallState()).kind).toBe("installing");
      await core.setLocalOnly(true);
      await waitForState(seen, (s) => s.kind === "failed" && s.reason === "local-mode");
      standIn.installGate = null;

      // Local mode also blocks sign-in when binary already exists or on "Try another account".
      standIn.binary = "/opt/homebrew/bin/claude";
      standIn.auth = { kind: "signed-out" };
      expect(await core.installClaudeCode()).toEqual({ kind: "failed", reason: "local-mode" });
      expect(await core.openClaudeCodeSignIn()).toEqual({ kind: "failed", reason: "local-mode" });
      expect(standIn.signInCalls).toBe(0);
      await core.setLocalOnly(false);

      // Sign-in command failing surfaces a plain sign-in-failed state instead of staying on awaiting-sign-in.
      seen.length = 0;
      standIn.signInGate = deferred<ClaudeCodeSignInResult>();
      await core.openClaudeCodeSignIn();
      standIn.signInGate.resolve({ kind: "failed", detail: "spawn-error" });
      await waitForState(seen, (s) => s.kind === "failed" && s.reason === "sign-in-failed");

      // Sign-in exiting 0 when checkAuth still reports signed-out or unknown is NOT treated as signed in.
      seen.length = 0;
      standIn.auth = { kind: "unknown" };
      standIn.signInGate = deferred<ClaudeCodeSignInResult>();
      await core.openClaudeCodeSignIn();
      standIn.signInGate.resolve({ kind: "signed-in" });
      await waitForState(seen, (s) => s.kind === "failed" && s.reason === "sign-in-failed");

      // Cancelling or pressing Install again after the installer exits while checkAuth() is still
      // pending neither runs a second handoff nor opens sign-in.
      standIn.binary = null;
      standIn.installCalls = 0;
      standIn.signInCalls = 0;
      standIn.authCalls = 0;
      standIn.installGate = deferred<ClaudeCodeAdapterInstallResult>();
      standIn.authGate = deferred<ClaudeCodeAuthCheck>();
      await core.installClaudeCode();
      standIn.installGate.resolve({
        kind: "installed",
        binaryPath: "/tmp/fake-home/.local/bin/claude",
      });
      standIn.installGate = null;
      for (let i = 0; i < 50 && standIn.authCalls === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(standIn.authCalls).toBe(1);

      // A second Install press in this post-install auth-probe window starts nothing.
      await core.installClaudeCode();
      expect(standIn.installCalls).toBe(1);
      expect(standIn.authCalls).toBe(1);

      // Cancelling in this window returns idle immediately and resolving auth opens NO sign-in.
      expect(await core.cancelClaudeCodeInstall()).toEqual({ kind: "idle" });
      standIn.authGate.resolve({ kind: "signed-out" });
      standIn.authGate = null;
      await new Promise((r) => setTimeout(r, 30));
      expect(await core.getClaudeCodeInstallState()).toEqual({ kind: "idle" });
      expect(standIn.signInCalls).toBe(0);
    } finally {
      await core.close();
      await rm(data, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
