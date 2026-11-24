import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCommandOnPath } from "../../src/main/claudeBinary";
import {
  createClaudeCodeInstaller,
  isTrustedInstallerUrl,
} from "../../src/main/claudeCodeInstaller";

describe("createClaudeCodeInstaller host adapter (#3638)", () => {
  it("fetches only Anthropic's official HTTPS installer URL, preserves SUDO_USER, refuses as root, and detects the installed binary", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "im-installer-home-"));
    const fetchedUrls: string[] = [];
    const fakeScript = [
      "#!/bin/bash",
      "set -e",
      'if [ "${SUDO_USER:-}" != "alice" ]; then echo "SUDO_USER missing" >&2; exit 2; fi',
      'if [ -n "${ELECTRON_RUN_AS_NODE:-}" ]; then echo "ELECTRON_RUN_AS_NODE leaked" >&2; exit 3; fi',
      'mkdir -p "$HOME/.claude/downloads" "$HOME/.local/bin"',
      'echo "Setting up Claude Code..."',
      'printf \'#!/bin/sh\\necho "{\\"loggedIn\\":false,\\"authMethod\\":\\"none\\"}"\\nexit 1\\n\' > "$HOME/.local/bin/claude"',
      'chmod +x "$HOME/.local/bin/claude"',
      'rm -rf "$HOME/.claude/downloads"',
    ].join("\n");

    try {
      // Refuses when the app itself runs as root, without fetching anything.
      const asRoot = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin", DISABLE_AUTOUPDATER: "1" },
        isRoot: () => true,
        fetch: async (url) => {
          fetchedUrls.push(url);
          return new Response(fakeScript, { status: 200 });
        },
      });
      expect(await asRoot.install({ signal: new AbortController().signal })).toEqual({
        kind: "failed",
        reason: "root",
      });
      expect(fetchedUrls).toHaveLength(0);

      const installer = createClaudeCodeInstaller({
        home,
        env: {
          PATH: "/usr/bin:/bin",
          SUDO_USER: "alice",
          ELECTRON_RUN_AS_NODE: "1",
          DISABLE_AUTOUPDATER: "1",
        },
        isRoot: () => false,
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

  it("prefers the login shell's PATH over ~/.local/bin/claude and detects claude present only on the login shell's PATH", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "im-installer-path-"));
    const home = join(root, "home");
    const brewBin = join(root, "homebrew", "bin");
    const localBin = join(home, ".local", "bin");
    await mkdir(brewBin, { recursive: true });
    await mkdir(localBin, { recursive: true });

    const brewClaude = join(brewBin, "claude");
    const brewHelper = join(brewBin, "im-test-node-helper");
    const localClaude = join(localBin, "claude");
    await writeFile(
      brewHelper,
      '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\'\n',
      "utf8",
    );
    await chmod(brewHelper, 0o755);
    await writeFile(brewClaude, "#!/bin/sh\nim-test-node-helper\n", "utf8");
    await chmod(brewClaude, 0o755);

    try {
      // Only on login shell PATH (process.env.PATH has no claude, ~/.local/bin/claude absent).
      // checkAuth also executes with the login shell's PATH so `im-test-node-helper` resolves.
      const installer = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin" },
        environment: async () => ({ PATH: `${brewBin}:/usr/bin:/bin` }),
      });
      expect(await installer.findBinary()).toBe(brewClaude);
      expect(await installer.checkAuth()).toEqual({ kind: "signed-in" });

      // Even if ~/.local/bin/claude also exists, login shell PATH wins for both installer and ownAi.
      await writeFile(localClaude, "#!/bin/sh\necho local\n", "utf8");
      await chmod(localClaude, 0o755);
      expect(await installer.findBinary()).toBe(brewClaude);
      expect(
        await resolveCommandOnPath("claude", {
          environment: async () => ({ PATH: `${brewBin}:/usr/bin:/bin` }),
          home,
        }),
      ).toBe(brewClaude);

      // Without claude on login shell PATH, falls back to ~/.local/bin/claude.
      expect(
        await resolveCommandOnPath("claude", {
          environment: async () => ({ PATH: "/usr/bin:/bin" }),
          home,
        }),
      ).toBe(localClaude);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates every manual redirect hop, allows trusted claude.ai hops even with empty response.url, and refuses untrusted, HTTP, or empty Location redirects", async () => {
    expect(isTrustedInstallerUrl("https://claude.ai/install.sh")).toBe(true);
    expect(
      isTrustedInstallerUrl("https://downloads.claude.ai/claude-code-releases/bootstrap.sh"),
    ).toBe(true);
    expect(isTrustedInstallerUrl("http://claude.ai/install.sh")).toBe(false);
    expect(isTrustedInstallerUrl("https://evil.example/install.sh")).toBe(false);
    expect(isTrustedInstallerUrl("https://claude.ai.evil.example/install.sh")).toBe(false);

    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "im-installer-redirect-"));
    try {
      const marker = join(home, "ran.txt");

      // 1. Trusted 302 redirect (claude.ai -> downloads.claude.ai) with empty response.url (as Electron net.fetch returns).
      const visited: string[] = [];
      const redirectOk = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin" },
        isRoot: () => false,
        fetch: async (url, init) => {
          expect(init?.redirect).toBe("manual");
          visited.push(url);
          if (url === "https://claude.ai/install.sh") {
            return new Response(null, {
              status: 302,
              headers: {
                location: "https://downloads.claude.ai/claude-code-releases/bootstrap.sh",
              },
            });
          }
          return new Response(
            `#!/bin/bash\nmkdir -p "$HOME/.local/bin"\nprintf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/claude"\nchmod +x "$HOME/.local/bin/claude"\n`,
            { status: 200 },
          );
        },
      });
      expect(await redirectOk.install({ signal: new AbortController().signal })).toEqual({
        kind: "installed",
        binaryPath: join(home, ".local", "bin", "claude"),
      });
      expect(visited).toEqual([
        "https://claude.ai/install.sh",
        "https://downloads.claude.ai/claude-code-releases/bootstrap.sh",
      ]);

      // Remove binary for refusal checks.
      await rm(join(home, ".local"), { recursive: true, force: true });

      // 2. Untrusted redirect target is refused before following or executing.
      const evilVisited: string[] = [];
      const evilRedirect = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin" },
        isRoot: () => false,
        fetch: async (url) => {
          evilVisited.push(url);
          if (url === "https://claude.ai/install.sh") {
            return new Response(null, {
              status: 302,
              headers: { location: "https://evil.example/install.sh" },
            });
          }
          return new Response(`#!/bin/bash\ntouch "${marker}"\n`, { status: 200 });
        },
      });
      expect(await evilRedirect.install({ signal: new AbortController().signal })).toEqual({
        kind: "failed",
        reason: "network",
      });
      expect(evilVisited).toEqual(["https://claude.ai/install.sh"]);
      expect(existsSync(marker)).toBe(false);

      // 3. Plain HTTP downgrade redirect is refused before following.
      const httpRedirect = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin" },
        isRoot: () => false,
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://downloads.claude.ai/bootstrap.sh" },
          }),
      });
      expect(await httpRedirect.install({ signal: new AbortController().signal })).toEqual({
        kind: "failed",
        reason: "network",
      });

      // 4. Redirect with empty/missing Location header is refused.
      const missingLocation = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin" },
        isRoot: () => false,
        fetch: async () => new Response(null, { status: 302 }),
      });
      expect(await missingLocation.install({ signal: new AbortController().signal })).toEqual({
        kind: "failed",
        reason: "network",
      });
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
        isRoot: () => false,
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

  it("requires positive auth JSON (never exit 0 alone) and does not misclassify bare 'subscription' errors as no-plan", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "im-installer-auth-"));
    try {
      const networkFail = createClaudeCodeInstaller({
        home,
        env: { PATH: "/usr/bin:/bin" },
        isRoot: () => false,
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

      // Unparseable stdout with exit code 0 must NEVER be treated as signed in.
      await writeFile(claudeBin, '#!/bin/sh\necho "not json"\nexit 0\n', "utf8");
      await chmod(claudeBin, 0o755);
      const checker = createClaudeCodeInstaller({ home, env: { PATH: "/usr/bin:/bin" } });
      expect(await checker.checkAuth()).toEqual({ kind: "unknown" });

      // Non-zero sign-in error merely mentioning "subscription" is failed, NOT no-plan.
      await writeFile(
        claudeBin,
        '#!/bin/sh\necho "Failed to fetch subscription metadata: ECONNRESET" >&2\nexit 1\n',
        "utf8",
      );
      expect(await checker.startSignIn({ signal: new AbortController().signal })).toEqual({
        kind: "failed",
        detail: "exit-1",
      });

      // Free plan without Claude Code.
      await writeFile(
        claudeBin,
        '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"free"}\'\n',
        "utf8",
      );
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

  it("spawns claude commands from paths containing spaces (including Windows .cmd shims)", async () => {
    const home = await mkdtemp(join(tmpdir(), "im-installer-spaces-"));
    const spacedBin = join(home, "Jane Doe bin");
    try {
      await mkdir(spacedBin, { recursive: true });
      if (process.platform === "win32") {
        await writeFile(
          join(spacedBin, "claude.cmd"),
          [
            "@echo off",
            'if "%1 %2"=="auth status" (echo {"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"} & exit /b 0)',
            "exit /b 0",
          ].join("\r\n"),
          "utf8",
        );
      } else {
        const script = join(spacedBin, "claude");
        await writeFile(
          script,
          [
            "#!/bin/sh",
            'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\'; fi',
            "exit 0",
          ].join("\n"),
          "utf8",
        );
        await chmod(script, 0o755);
      }
      const sep = process.platform === "win32" ? ";" : ":";
      const installer = createClaudeCodeInstaller({
        home,
        env: {
          ...process.env,
          PATH: `${spacedBin}${sep}${process.env.PATH ?? ""}`,
        },
      });
      expect(await installer.checkAuth()).toEqual({ kind: "signed-in" });
      expect(await installer.startSignIn({ signal: new AbortController().signal })).toEqual({
        kind: "signed-in",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
