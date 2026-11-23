import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeCodeInstaller } from "../../src/main/claudeCodeInstaller";

describe("createClaudeCodeInstaller host adapter (#3638)", () => {
  it("fetches only Anthropic's official HTTPS installer URL, strips SUDO_USER, and detects the installed binary", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "im-installer-home-"));
    const fetchedUrls: string[] = [];
    const fakeScript = [
      "#!/bin/bash",
      "set -e",
      'if [ -n "${SUDO_USER:-}" ]; then echo "SUDO_USER leaked" >&2; exit 2; fi',
      'mkdir -p "$HOME/.claude/downloads" "$HOME/.local/bin"',
      'echo "Setting up Claude Code..."',
      'printf \'#!/bin/sh\\necho "{\\"loggedIn\\":false,\\"authMethod\\":\\"none\\"}"\\nexit 1\\n\' > "$HOME/.local/bin/claude"',
      'chmod +x "$HOME/.local/bin/claude"',
      'rm -rf "$HOME/.claude/downloads"',
    ].join("\n");

    try {
      const installer = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin", SUDO_USER: "root", DISABLE_AUTOUPDATER: "1" },
        fetch: async (url) => {
          fetchedUrls.push(url);
          return new Response(fakeScript, { status: 200 });
        },
      });

      expect(await installer.findBinary()).toBeNull();
      const stages: string[] = [];
      const result = await installer.install({
        signal: new AbortController().signal,
        onStage: (stage) => stages.push(stage),
      });

      expect(fetchedUrls).toEqual(["https://claude.ai/install.sh"]);
      expect(stages).toEqual(["downloading", "installing"]);
      expect(result).toEqual({
        kind: "installed",
        binaryPath: join(home, ".local", "bin", "claude"),
      });
      expect(await installer.findBinary()).toBe(join(home, ".local", "bin", "claude"));
      expect(await installer.checkAuth()).toEqual({ kind: "signed-out" });

      // Calling install again leaves the existing binary untouched and never fetches.
      const second = await installer.install({ signal: new AbortController().signal });
      expect(second).toEqual({
        kind: "already-installed",
        binaryPath: join(home, ".local", "bin", "claude"),
      });
      expect(fetchedUrls).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("cancels cleanly mid-install and removes partial download artifacts so a later retry works", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "im-installer-cancel-"));
    const slowScript = [
      "#!/bin/bash",
      'mkdir -p "$HOME/.claude/downloads"',
      'echo "partial" > "$HOME/.claude/downloads/claude-partial"',
      "sleep 30",
    ].join("\n");

    try {
      const installer = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin", DISABLE_AUTOUPDATER: "1" },
        fetch: async () => new Response(slowScript, { status: 200 }),
      });
      const controller = new AbortController();
      const running = installer.install({ signal: controller.signal });

      // Wait until the stub script has created the partial download artifact.
      for (let i = 0; i < 100 && !existsSync(join(home, ".claude", "downloads")); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(existsSync(join(home, ".claude", "downloads"))).toBe(true);

      controller.abort();
      expect(await running).toEqual({ kind: "cancelled" });
      expect(existsSync(join(home, ".claude", "downloads"))).toBe(false);
      expect(existsSync(join(home, ".claude"))).toBe(false);
      expect(await installer.findBinary()).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("classifies network errors and parses signed-in vs free-plan auth status JSON", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "im-installer-auth-"));
    try {
      const networkFail = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin" },
        fetch: async () => {
          throw new Error("fetch failed: ENOTFOUND claude.ai");
        },
      });
      expect(await networkFail.install({ signal: new AbortController().signal })).toEqual({
        kind: "failed",
        reason: "network",
      });

      const binDir = join(home, ".local", "bin");
      await mkdir(binDir, { recursive: true });
      const claudeBin = join(binDir, "claude");

      // Free plan without Claude Code.
      await writeFile(
        claudeBin,
        '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"free"}\'\n',
        "utf8",
      );
      await chmod(claudeBin, 0o755);
      const checker = createClaudeCodeInstaller({ home, env: { PATH: "/usr/bin:/bin" } });
      expect(await checker.checkAuth()).toEqual({ kind: "no-plan" });

      // Paid subscription.
      await writeFile(
        claudeBin,
        '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\'\n',
        "utf8",
      );
      expect(await checker.checkAuth()).toEqual({ kind: "signed-in" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
