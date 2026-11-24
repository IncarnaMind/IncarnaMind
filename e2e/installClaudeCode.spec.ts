import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  interceptOpenPath,
  launchApp,
  newMind,
  openSettings,
  removeDataFolder,
  setWindowSize,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Agents are hidden while SHOW_AGENT_CONNECTION is false.");

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const STAND_INS = { fakeChat: true, ollama: "http://127.0.0.1:9", decisions: "http://127.0.0.1:9" };

interface StandInBehavior {
  binary: string | null;
  install: "succeed" | "fail-network" | "hold";
  signIn: "hold" | "signed-in" | "no-plan";
  auth: "signed-out" | "signed-in" | "no-plan" | "missing";
}

interface InstallerStandIn {
  origin: string;
  behavior: StandInBehavior;
  installCalls: number;
  signInCalls: number;
  authCalls: number;
  releaseInstall(outcome?: "succeed" | "fail-network"): void;
  close(): Promise<void>;
}

async function startInstallerStandIn(
  initial?: Partial<StandInBehavior>,
): Promise<InstallerStandIn> {
  const behavior: StandInBehavior = {
    binary: null,
    install: "succeed",
    signIn: "hold",
    auth: "signed-out",
    ...initial,
  };
  let installCalls = 0;
  let signInCalls = 0;
  let authCalls = 0;
  let pendingInstall: ((outcome: "succeed" | "fail-network") => void) | null = null;
  const openSignIns = new Set<() => void>();

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "application/json");
    if (url === "/find") {
      res.end(JSON.stringify({ binary: behavior.binary }));
      return;
    }
    if (url === "/install") {
      installCalls += 1;
      if (behavior.install === "hold") {
        let settled = false;
        const finish = (outcome: "succeed" | "fail-network") => {
          if (settled) return;
          settled = true;
          pendingInstall = null;
          if (outcome === "succeed") {
            behavior.binary = "/tmp/fake-claude";
            res.end(
              JSON.stringify({
                kind: "installed",
                stage: "installing",
                binaryPath: behavior.binary,
              }),
            );
          } else {
            res.end(JSON.stringify({ kind: "failed", reason: "network" }));
          }
        };
        pendingInstall = finish;
        req.on("close", () => {
          settled = true;
          if (pendingInstall === finish) pendingInstall = null;
        });
        return;
      }
      if (behavior.install === "fail-network") {
        res.end(JSON.stringify({ kind: "failed", reason: "network" }));
        return;
      }
      behavior.binary = "/tmp/fake-claude";
      res.end(
        JSON.stringify({ kind: "installed", stage: "installing", binaryPath: behavior.binary }),
      );
      return;
    }
    if (url === "/sign-in") {
      signInCalls += 1;
      if (behavior.signIn === "signed-in") {
        res.end(JSON.stringify({ kind: "signed-in" }));
        return;
      }
      if (behavior.signIn === "no-plan") {
        res.end(JSON.stringify({ kind: "no-plan" }));
        return;
      }
      const closeSignIn = () => {
        if (!res.writableEnded) res.end(JSON.stringify({ kind: "cancelled" }));
      };
      openSignIns.add(closeSignIn);
      req.on("close", () => {
        openSignIns.delete(closeSignIn);
      });
      return;
    }
    if (url === "/auth") {
      authCalls += 1;
      res.end(JSON.stringify({ kind: behavior.auth }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    behavior,
    get installCalls() {
      return installCalls;
    },
    get signInCalls() {
      return signInCalls;
    },
    get authCalls() {
      return authCalls;
    },
    releaseInstall(outcome = "succeed") {
      pendingInstall?.(outcome);
    },
    async close() {
      for (const end of openSignIns) end();
      openSignIns.clear();
      pendingInstall?.("fail-network");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

async function setLanguage(window: Page, language: "en" | "zh-CN"): Promise<void> {
  await window.evaluate(
    (lang) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: lang },
      }),
    language,
  );
}

async function assertNoHorizontalOverflow(window: Page): Promise<void> {
  const overflow = await window.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

let dataDir: string;
let home: string;
let app: ElectronApplication | null = null;
let standIn: InstallerStandIn | null = null;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  await standIn?.close();
  standIn = null;
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

test("First Run offers one-press Claude Code install in EN and ZH-CN when no command-line AI is present, and hides it when one already is (#3638)", async () => {
  standIn = await startInstallerStandIn();
  const launched = await launchApp(dataDir, {
    ...STAND_INS,
    firstRunSetup: true,
    home,
    claudeInstaller: standIn.origin,
  });
  app = launched.app;
  const { window } = launched;
  await interceptOpenPath(app);
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 1440, 900);

  await window.getByTestId("setup-skip").click();
  await expect(window.getByTestId("setup-panel")).toHaveAttribute("data-step", "ai");

  const offer = window.getByTestId("claude-code-install-offer");
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Claude Code");
  await expect(offer).toContainText(
    "Downloads and installs Claude Code from Anthropic into your user folder.",
  );
  await expect(offer.getByTestId("install-claude-code")).toHaveText("Install Claude Code");
  await assertNoHorizontalOverflow(window);
  await shot(window, "first-run-offer-en-1440");

  // Nothing is downloaded before the User presses the button.
  expect(standIn.installCalls).toBe(0);

  // Narrow Chinese viewport.
  await setWindowSize(app, window, 900, 760);
  await setLanguage(window, "zh-CN");
  await expect(offer).toContainText("Claude Code");
  await expect(offer).toContainText("从 Anthropic 下载并安装 Claude Code 到你的用户文件夹。");
  await expect(offer.getByTestId("install-claude-code")).toHaveText("安装 Claude Code");
  await assertNoHorizontalOverflow(window);
  await shot(window, "first-run-offer-zh-900");

  await app.close();
  app = null;

  // When Claude Code is already installed on the machine, the Install offer stays hidden
  // and Claude Code shows its normal Connect button untouched.
  standIn.behavior.binary = "/tmp/fake-claude";
  const installedData = await createDataFolder();
  try {
    const second = await launchApp(installedData, {
      ...STAND_INS,
      firstRunSetup: true,
      home,
      claudeInstaller: standIn.origin,
    });
    app = second.app;
    await second.window.getByTestId("setup-skip").click();
    await expect(second.window.getByTestId("setup-panel")).toHaveAttribute("data-step", "ai");
    await expect(second.window.getByTestId("claude-code-install-offer")).toHaveCount(0);
    await expect(
      second.window.locator('[data-testid="setup-agent"][data-value="claude-code"]'),
    ).toBeVisible();
  } finally {
    await app?.close();
    app = null;
    await removeDataFolder(installedData);
  }
});

test("empty states and Settings › AI offer Install Claude Code, Cancel restores the offer cleanly, and Local mode refuses before downloading (#3638)", async () => {
  standIn = await startInstallerStandIn({ install: "hold" });
  const launched = await launchApp(dataDir, {
    ...STAND_INS,
    home,
    claudeInstaller: standIn.origin,
  });
  app = launched.app;
  const { window } = launched;
  await interceptOpenPath(app);
  await interceptOpenExternal(app);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);

  // Add one Document so Check runs and surfaces the empty-state Checking needs your AI card.
  const docPath = join(home, "North Estuary Report.md");
  await writeFile(
    docPath,
    "# North Estuary Report\n\nSalinity readings stayed stable across all four sampling weeks.\n",
  );
  await window.evaluate(
    (file) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments([file]),
    docPath,
  );
  await expect(window.getByTestId("document-list-item")).toHaveAttribute("data-status", "ready", {
    timeout: 15_000,
  });

  // Note workspace empty states: one-line Composer readiness and Checks panel with disclosure.
  await newMind(window);
  const readiness = window.getByTestId("chat-readiness");
  await expect(readiness).toContainText("Asking needs your AI");
  await expect(readiness.getByTestId("readiness-install-claude-code")).toHaveText(
    "Install Claude Code",
  );
  await expect(readiness.getByTestId("chat-readiness-connect-ai")).toHaveText("Connect your AI");

  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("The northern estuary stations showed stable salinity readings.");
  await window.getByTestId("check-badge-open").click();
  await window.getByTestId("badge-check-mind").click();
  const checksProblem = window.getByTestId("checks-problem");
  await expect(checksProblem).toContainText("Checking needs your AI");
  await expect(checksProblem.getByTestId("checks-install-claude-code")).toHaveText(
    "Install Claude Code",
  );
  await expect(checksProblem.getByTestId("checks-connect-ai")).toHaveText("Connect your AI");
  await expect(checksProblem).toContainText(
    "Downloads and installs Claude Code from Anthropic into your user folder.",
  );
  await shot(window, "empty-states-en-1440");

  await setWindowSize(app, window, 900, 760);
  await setLanguage(window, "zh-CN");
  await expect(readiness).toContainText("提问需要连接你的 AI");
  await expect(checksProblem).toContainText("核对需要连接你的 AI");
  await assertNoHorizontalOverflow(window);
  await shot(window, "empty-states-zh-900");
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);

  // Pressing Install Claude Code on the one-line readiness bar opens Settings › AI beside the
  // disclosure rather than downloading without showing it first.
  await readiness.getByTestId("readiness-install-claude-code").click();
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "ai");
  await expect(window.getByTestId("claude-code-install-offer")).toBeVisible();
  expect(standIn.installCalls).toBe(0);
  await window.keyboard.press("Escape");

  // Pressing Install Claude Code from the Checks card (beside its disclosure) opens Settings › AI
  // and starts installing in one press. The card still says what checking needs, and offers no
  // Check under it while nothing can check (#3756).
  await window.getByTestId("check-badge-open").click();
  await expect(checksProblem).toContainText("Checking needs your AI");
  await expect(window.getByTestId("badge-check-mind")).toHaveCount(0);
  await checksProblem.getByTestId("checks-install-claude-code").click();
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "ai");
  const progress = window.getByTestId("claude-code-install-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Installing Claude Code…");
  await expect(progress.getByTestId("claude-code-install-cancel")).toHaveText("Cancel");
  expect(standIn.installCalls).toBe(1);
  await shot(window, "progress-en-1440");

  // Cancel stops the install and returns cleanly to the Settings › AI offer + Jobs row.
  await progress.getByTestId("claude-code-install-cancel").click();
  await expect(window.getByTestId("claude-code-install-offer")).toBeVisible();
  await expect(window.getByTestId("claude-code-install-offer")).toContainText(
    "Install Claude Code for background work",
  );
  await expect(window.getByTestId("ai-jobs-install-claude-code")).toHaveText("Install Claude Code");
  await shot(window, "settings-offer-en-1440");

  // Pressing the Jobs row link navigates to the offer beside its disclosure; it never downloads directly.
  await window.getByTestId("ai-jobs-install-claude-code").click();
  await expect(window.getByTestId("install-claude-code")).toBeFocused();
  expect(standIn.installCalls).toBe(1);

  // Local mode refuses before any download request is sent, and its action names both steps.
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(true),
  );
  await window.getByTestId("install-claude-code").click();
  const failed = window.getByTestId("claude-code-install-failed");
  await expect(failed).toHaveAttribute("data-reason", "local-mode");
  await expect(failed.getByTestId("claude-code-install-local-mode-off")).toHaveText(
    "Turn it off and install",
  );
  expect(standIn.installCalls).toBe(1);
});

test("failure, retry, browser sign-in handoff, plan without Claude Code, and Connect consent flow (#3638)", async () => {
  standIn = await startInstallerStandIn({ install: "fail-network" });
  const launched = await launchApp(dataDir, {
    ...STAND_INS,
    home,
    claudeInstaller: standIn.origin,
  });
  app = launched.app;
  const { window } = launched;
  await acceptPlainTextKeys(window);
  await interceptOpenPath(app);
  await interceptOpenExternal(app);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);

  await openSettings(window, "ai");

  // Failure path: plain words, Try again, and Anthropic's setup guide link.
  await window.getByTestId("install-claude-code").click();
  const failed = window.getByTestId("claude-code-install-failed");
  await expect(failed).toHaveAttribute("data-reason", "network");
  await expect(failed).toContainText("Couldn’t install Claude Code");
  await expect(failed.getByTestId("claude-code-install-retry")).toHaveText("Try again");
  await expect(failed.getByTestId("claude-code-install-guide")).toHaveAttribute(
    "href",
    "https://code.claude.com/docs/en/setup",
  );
  await shot(window, "failed-en-1440");

  await setLanguage(window, "zh-CN");
  await expect(failed).toContainText("无法安装 Claude Code");
  await expect(failed.getByTestId("claude-code-install-retry")).toHaveText("重试");
  await setLanguage(window, "en");

  // Retry succeeds -> browser sign-in handoff reached, and ADR-0022 consent recorded.
  standIn.behavior.install = "succeed";
  await failed.getByTestId("claude-code-install-retry").click();
  const signIn = window.getByTestId("claude-code-install-signin");
  await expect(signIn).toBeVisible();
  await expect(signIn).toContainText("Sign in to Claude Code in your browser");
  await expect(signIn.getByTestId("claude-code-install-check-auth")).toHaveText("I’ve signed in");
  await expect(signIn.getByTestId("claude-code-install-reopen-signin")).toHaveText(
    "Open sign-in again",
  );
  await shot(window, "signin-handoff-en-1440");

  const consentAllowed = await window.evaluate(async () => {
    const flows = await (
      globalThis as unknown as { incarnamind: CoreBridge }
    ).incarnamind.listDataFlows();
    return flows.find((each) => each.flow.id === "agent-install")?.consent === "accepted";
  });
  expect(consentAllowed).toBe(true);

  // Pressing "I've signed in" before sign-in finishes shows the calm "not yet" hint.
  await signIn.getByTestId("claude-code-install-check-auth").click();
  await expect(window.getByTestId("claude-code-install-signin-not-yet")).toBeVisible();

  // Plan without Claude Code shows plain words and both ways on.
  standIn.behavior.auth = "no-plan";
  await signIn.getByTestId("claude-code-install-check-auth").click();
  const noPlan = window.getByTestId("claude-code-install-no-plan");
  await expect(noPlan).toBeVisible();
  await expect(noPlan).toContainText("Your Anthropic plan doesn’t include Claude Code.");
  await expect(noPlan.getByTestId("claude-code-no-plan-model")).toHaveText(
    "Set up a model in IncarnaMind",
  );
  await expect(noPlan.getByTestId("claude-code-no-plan-desktop")).toHaveText(
    "Keep asking through your desktop app",
  );
  await expect(noPlan.getByTestId("claude-code-no-plan-try-other")).toHaveText(
    "Try another account",
  );
  await shot(window, "no-plan-en-1440");

  await setLanguage(window, "zh-CN");
  await expect(noPlan).toContainText("你当前的 Anthropic 套餐不包含 Claude Code。");
  await expect(noPlan.getByTestId("claude-code-no-plan-model")).toHaveText(
    "在 IncarnaMind 里设置 AI 模型",
  );
  await setLanguage(window, "en");

  // Try another account -> sign in succeeds -> opens the standard Connect consent card!
  await noPlan.getByTestId("claude-code-no-plan-try-other").click();
  await expect(signIn).toBeVisible();
  standIn.behavior.auth = "signed-in";
  await signIn.getByTestId("claude-code-install-check-auth").click();

  const connectDialog = window.getByTestId("connect-agent-dialog");
  await expect(connectDialog).toBeVisible();
  await expect(connectDialog).toContainText("Claude Code");
  await expect(window.getByTestId("claude-code-install-offer")).toHaveCount(0);
  await shot(window, "connect-consent-en-1440");
});
