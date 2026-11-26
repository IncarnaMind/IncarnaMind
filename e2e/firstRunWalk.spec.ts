import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge, WorkKind } from "../src/core/api";
import { EXAMPLE_SETS } from "../src/core/exampleSets";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import { installAgent } from "../tests/helpers/agentInstalls";
import {
  acceptPlainTextKeys,
  checkNote,
  createDataFolder,
  frontMindName,
  interceptOpenExternal,
  interceptOpenPath,
  launchApp,
  newMind,
  removeDataFolder,
  setWindowSize,
  useLocalChatModel,
} from "./app";
import { type InstallerStandIn, startInstallerStandIn } from "./claudeInstaller";

test.skip(!SHOW_AGENT_CONNECTION, "Agents are hidden while SHOW_AGENT_CONNECTION is false.");
test.skip(process.platform === "win32", "The stand-in for Claude Code starts from a shell script.");

/*
 * End-to-end coverage for every finding from the new-person first-run walk (#3819), in English and
 * Simplified Chinese, through the window as a User sees it.
 */

type Language = "en" | "zh-CN";
const LANGUAGES: readonly Language[] = ["en", "zh-CN"];
const STAND_INS = { ollama: "http://127.0.0.1:9", decisions: "http://127.0.0.1:9" };
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let home: string;
let apps: string;
let bin: string;
let modeFile: string;
let app: ElectronApplication | null = null;
let installer: InstallerStandIn | null = null;

async function closeApp(): Promise<void> {
  await app?.close();
  app = null;
}

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  apps = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  modeFile = join(home, "own-ai-mode.txt");
  await writeFile(modeFile, "explain");
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});

test.afterEach(async () => {
  await closeApp();
  await installer?.close();
  installer = null;
  for (const folder of [dataDir, home, apps, bin]) await removeDataFolder(folder);
});

const say = (language: Language, key: Parameters<typeof translate>[1], params = {}) =>
  translate(language, key, params);

async function setLanguage(window: Page, language: Language): Promise<void> {
  await window.evaluate(
    (chosen) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: chosen },
      }),
    language,
  );
}

async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

async function start(
  windowSize: { width: number; height: number },
  options: {
    language: Language;
    firstRunSetup?: boolean;
    examples?: boolean;
    installer?: InstallerStandIn;
    ownAi?: boolean;
    agentApps?: boolean;
  },
): Promise<Page> {
  const launched = await launchApp(dataDir, {
    ...STAND_INS,
    firstRunSetup: options.firstRunSetup ?? true,
    examples: options.examples ?? true,
    home,
    agentApps: options.agentApps === false ? [] : [apps],
    ...(options.installer && { claudeInstaller: options.installer.origin }),
    ...(options.ownAi && {
      ownAi: join(bin, "claude"),
      extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: modeFile },
    }),
  });
  app = launched.app;
  await acceptPlainTextKeys(launched.window);
  await interceptOpenPath(app);
  await interceptOpenExternal(app);
  await setWindowSize(app, launched.window, windowSize.width, windowSize.height);
  await setLanguage(launched.window, options.language);
  return launched.window;
}

for (const language of LANGUAGES) {
  test(`no AI app: opening sentence, Install progress & sign-in handoff, and ⌘J leads to Connect without opening model setup (${language})`, async () => {
    test.setTimeout(120_000);
    installer = await startInstallerStandIn({ install: "hold" });
    const window = await start(
      language === "en" ? { width: 1440, height: 900 } : { width: 900, height: 760 },
      { language, installer },
    );

    await window.getByTestId("setup-skip").click();
    const panel = window.getByTestId("setup-panel");
    await expect(panel).toHaveAttribute("data-step", "ai");

    // Box 1: opening sentence fits a person with no AI app on the computer.
    await expect(panel).toContainText(say(language, "setupPage.ai.lead.none"));
    if (language === "en") {
      await expect(panel).not.toContainText("works with an AI app you have");
    }
    await shot(window, `walk-no-ai-${language}`);

    // Box 3: Install shows stage progress + bar while running without growing the row, then fixed
    // sign-in line + Reopen.
    const row = panel.getByTestId("setup-install-row");
    const heightBeforeInstall = (await row.boundingBox())?.height ?? 0;
    await row.getByTestId("setup-install-claude-code").click();
    await expect(row.getByTestId("setup-install-line")).toContainText(
      say(language, "setupPage.ai.install.downloading"),
    );
    await expect(row.getByTestId("setup-install-progress")).toBeVisible();
    const heightWhileInstalling = (await row.boundingBox())?.height ?? 0;
    expect(Math.abs(heightWhileInstalling - heightBeforeInstall)).toBeLessThanOrEqual(1);
    await shot(window, `walk-install-progress-${language}`);

    installer.releaseInstall("succeed");
    const line = row.getByTestId("setup-install-line");
    await expect(line).toHaveText(say(language, "setupPage.ai.install.signIn"));
    await expect(line).not.toContainText("in in");
    await expect(row.getByTestId("setup-install-reopen")).toHaveText(
      say(language, "agents.install.signIn.reopen"),
    );
    await expect(row.getByTestId("setup-install-signed-in")).toHaveText(
      say(language, "agents.install.signIn.done"),
    );
    await shot(window, `walk-install-signin-${language}`);

    // Clicking "Open sign-in again" triggers the handoff again cleanly.
    const beforeReopen = installer.signInCalls;
    await row.getByTestId("setup-install-reopen").click();
    await expect.poll(() => installer?.signInCalls).toBe(beforeReopen + 1);
    await expect(row.getByTestId("setup-install-signed-in")).toBeVisible();

    // Finish setup without connecting an AI app, landing on the example Note.
    await panel.getByTestId("setup-skip").click();
    await expect(panel).toHaveAttribute("data-step", "meetings");
    await panel.getByTestId("setup-skip").click();
    await expect(window.getByTestId("setup-page")).toHaveCount(0);
    await expect(window.getByTestId("example-line")).toBeVisible();

    // Box 2: ⌘J on the example Note focuses Connect your AI and never opens model-setup.
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("note-ask-connect")).toBeFocused();
    await expect(window.getByTestId("model-setup")).toHaveCount(0);
    await expect(window.getByTestId("assistant")).toBeHidden();

    // Box 2 on Home: ⌘J focuses Connect your AI on Home and never opens model-setup.
    await window.getByTestId("sidebar-home").click();
    await expect(window.getByTestId("home")).toBeVisible();
    await window.getByTestId("home-greeting").click();
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("home-ask-connect")).toBeFocused();
    await expect(window.getByTestId("model-setup")).toHaveCount(0);
    await expect(window.getByTestId("assistant")).toBeHidden();

    // Box 2 exception: a profile that already has a model set up is unchanged.
    await useLocalChatModel(window);
    await window.getByTestId("home-greeting").click();
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
  });

  test(`AI apps found: consent names apps & write permission, Details puts technical info last folded, awaiting Install never shows Connected, and Set up later looks identical (${language})`, async () => {
    test.setTimeout(120_000);
    // Start with 1 app found (Cursor alone — no extra Claude Code install) for singular consent
    // and baseline "Set up later" style right after clicking Skip on WorkStep.
    await installAgent("cursor", { applications: apps, commands: apps, home });
    const size = language === "en" ? { width: 1440, height: 900 } : { width: 900, height: 760 };
    let window = await start(size, { language });
    await window.getByTestId("setup-skip").click();
    let panel = window.getByTestId("setup-panel");
    await expect(panel).toHaveAttribute("data-step", "ai");

    const oneAppSkipStyle = await panel.getByTestId("setup-skip").evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });

    // Box 4 (1 app): names Cursor, singular, states writing & proposing when ticked by default.
    const consent = panel.getByTestId("setup-consent");
    await expect(consent).toContainText(
      say(language, "setupPage.ai.consent.one.write", { agent: "Cursor" }),
    );
    await expect(consent).not.toContainText("They ");
    await expect(consent).not.toContainText("its AI model");

    // Box 7: Details reads top-down in plain words; technical details are last and folded.
    await panel.getByTestId("setup-consent-details").click();
    const box = panel.getByTestId("setup-consent-more");
    await expect(box).toBeVisible();
    const technical = box.getByTestId("setup-consent-technical");
    await expect(technical).toBeVisible();
    await expect(technical).not.toHaveAttribute("open", "");
    const isLast = await box.evaluate(
      (el) => el.lastElementChild?.getAttribute("data-testid") === "setup-consent-technical",
    );
    expect(isLast).toBe(true);
    await shot(window, `walk-details-one-app-${language}`);

    // Unticking propose updates the consent sentence to read-only immediately.
    await box.getByTestId("setup-consent-propose").uncheck();
    await expect(consent).toContainText(
      say(language, "setupPage.ai.consent.one", { agent: "Cursor" }),
    );
    await box.getByTestId("setup-consent-propose").check();

    await closeApp();

    // Now test 2 apps found on a fresh dataDir (Claude Desktop + Claude Code installed):
    // Box 4 (many), Box 5 (awaiting Install never shows Connected · Undo), Box 6 ("Set up later").
    const secondData = await createDataFolder();
    try {
      await installAgent("claude-desktop", { applications: apps, commands: apps, home });
      await installAgent("claude-code", { applications: apps, commands: apps, home }, "command");
      await writeFile(join(home, ".claude.json"), "{}\n");
      const prevData = dataDir;
      dataDir = secondData;
      window = await start(size, { language });
      dataDir = prevData;
      await window.getByTestId("setup-skip").click();
      panel = window.getByTestId("setup-panel");
      await expect(panel).toHaveAttribute("data-step", "ai");

      const twoAppSkipStyle = await panel.getByTestId("setup-skip").evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color };
      });
      expect(twoAppSkipStyle).toEqual(oneAppSkipStyle);

      // Tick Claude Desktop too -> consent names Claude Code and Claude in plural.
      const claudeRow = panel.locator('[data-testid="setup-app"][data-value="claude-desktop"]');
      await claudeRow.getByTestId("setup-app-tick").check();
      const joined = language === "zh-CN" ? "Claude Code 和 Claude" : "Claude Code and Claude";
      await expect(panel.getByTestId("setup-consent")).toContainText(
        say(language, "setupPage.ai.consent.many.write", { agents: joined }),
      );
      await shot(window, `walk-two-apps-${language}`);

      // Untick Claude Code so only Claude Desktop is connected -> opens bundle (awaiting Install),
      // NEVER showing "Connected · Undo", also after Set up later -> Back.
      const codeRow = panel.locator('[data-testid="setup-app"][data-value="claude-code"]');
      await codeRow.getByTestId("setup-app-tick").uncheck();
      await panel.getByTestId("setup-connect").click();
      const doneRow = panel.locator('[data-testid="setup-done-row"][data-client="claude-desktop"]');
      await expect(doneRow).toContainText(
        say(language, "setupPage.ai.row.install", { agent: "Claude" }),
      );
      await expect(doneRow).not.toContainText(say(language, "setupPage.ai.connected"));
      await expect(panel.getByTestId("setup-next")).toBeDisabled();
      await shot(window, `walk-awaiting-install-${language}`);

      await panel.getByTestId("setup-skip").click();
      await expect(panel).toHaveAttribute("data-step", "meetings");
      await panel.getByTestId("setup-back").click();
      await expect(panel).toHaveAttribute("data-step", "ai");
      await expect(claudeRow.getByTestId("setup-app-waiting")).toHaveText(
        say(language, "setupPage.ai.row.install", { agent: "Claude" }),
      );
      await expect(claudeRow.getByTestId("setup-app-connected")).toHaveCount(0);
      await expect(claudeRow).not.toContainText(say(language, "setupPage.ai.connected"));
      await shot(window, `walk-awaiting-after-back-${language}`);
    } finally {
      await closeApp();
      await removeDataFolder(secondData);
    }
  });

  test(`steps keep position and work picks across close/reopen, and same install keeps card order (${language})`, async () => {
    test.setTimeout(120_000);
    const size = language === "en" ? { width: 1440, height: 900 } : { width: 900, height: 760 };
    let window = await start(size, { language });
    const panel = window.getByTestId("setup-panel");
    await expect(panel).toHaveAttribute("data-step", "work");

    // Box 9: capture the card order on first open.
    const orderFirst = await panel
      .getByTestId("setup-work")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-value")));

    // Box 8: pick Legal + Meetings, advance to Your AI, then close the window.
    await panel.locator('[data-testid="setup-work"][data-value="legal"]').click();
    await panel.locator('[data-testid="setup-work"][data-value="meetings"]').click();
    await panel.getByTestId("setup-next").click();
    await expect(panel).toHaveAttribute("data-step", "ai");
    await closeApp();

    // Reopen -> returns directly to Your AI step, and Back shows the kept picks and same card order.
    window = await start(size, { language });
    const reopenedPanel = window.getByTestId("setup-panel");
    await expect(reopenedPanel).toHaveAttribute("data-step", "ai");
    await reopenedPanel.getByTestId("setup-back").click();
    await expect(reopenedPanel).toHaveAttribute("data-step", "work");
    await expect(
      reopenedPanel.locator('[data-testid="setup-work"][data-value="legal"] input'),
    ).toBeChecked();
    await expect(
      reopenedPanel.locator('[data-testid="setup-work"][data-value="meetings"] input'),
    ).toBeChecked();
    const orderSecond = await reopenedPanel
      .getByTestId("setup-work")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-value")));
    expect(orderSecond).toEqual(orderFirst);
  });

  test(`Legal example has a contradicted mark and foot line; first request keeps sidebar calm; quit and reopen keeps the Note in front (${language})`, async () => {
    test.setTimeout(150_000);
    await installAgent("claude-code", { applications: apps, commands: apps, home }, "command");
    await writeFile(join(home, ".claude.json"), "{}\n");
    const size = language === "en" ? { width: 1440, height: 900 } : { width: 900, height: 760 };
    let window = await start(size, { language, ownAi: true });

    // Pick Legal -> connect Claude Code -> skip Meetings -> lands on the Legal example Note.
    const panel = window.getByTestId("setup-panel");
    await panel.locator('[data-testid="setup-work"][data-value="legal"]').click();
    await panel.getByTestId("setup-next").click();
    await expect(panel).toHaveAttribute("data-step", "ai");
    await panel.getByTestId("setup-connect").click();
    await expect(panel).toHaveAttribute("data-step", "meetings");
    await panel.getByTestId("setup-skip").click();
    await expect(window.getByTestId("setup-page")).toHaveCount(0);

    // Box 10: Legal example opens with 1 contradicted check mark and the "one figure" foot line.
    await expect(frontMindName(window)).toHaveText(EXAMPLE_SETS.contracts[language].title);
    await expect(window.getByTestId("example-line")).toContainText(
      say(language, "examples.line.credit"),
    );
    await expect(
      window.locator('[data-testid="claim-mark"][data-check="contradicted"]'),
    ).toHaveCount(1, { timeout: 15_000 });
    await shot(window, `walk-legal-example-${language}`);

    // Box 11 (Chinese): inline mark has gap before next sentence; every Question ends in U+FF1F.
    if (language === "zh-CN") {
      const questions = await window
        .locator('[data-testid="mind-editor"] [data-testid="question"] .question-text')
        .allTextContents();
      expect(questions.length).toBeGreaterThan(0);
      for (const question of questions) {
        expect(question.trim().endsWith("？")).toBe(true);
        expect(question).not.toContain("?");
      }
      const gap = await window.evaluate(() => {
        const mark = document.querySelector<HTMLElement>(
          '.claim-mark--inline[data-check="contradicted"]',
        );
        const room = document.querySelector<HTMLElement>(".claim-inline-room");
        if (!mark || !room) return null;
        const markRect = mark.getBoundingClientRect();
        const roomRect = room.getBoundingClientRect();
        return {
          trailing: roomRect.right - markRect.right,
          paddingRight: Number.parseFloat(getComputedStyle(room).paddingRight),
        };
      });
      expect(gap).not.toBeNull();
      expect(gap?.trailing ?? 0).toBeGreaterThanOrEqual(3);
    }

    // Box 12: first request in the example does NOT add Library/Documents or shrink Examples.
    const sidebar = window.getByTestId("sidebar");
    await expect(sidebar.getByTestId("not-in-a-folder-title")).toHaveText(
      say(language, "sidebar.examples"),
    );
    await expect(sidebar.getByTestId("library-nav")).toHaveCount(0);
    await expect(sidebar.getByTestId("examples-section")).toHaveCount(0);
    const docsBefore = await sidebar.getByTestId("document-list-item").count();
    expect(docsBefore).toBeGreaterThan(0);
    const input = window.getByTestId("note-ask-input");
    await expect(input).toBeVisible();
    await input.fill(language === "zh-CN" ? "说明一下这段条款" : "Explain the notice period");
    await input.press("Enter");
    await expect(window.getByTestId("note-ask-pill")).toHaveAttribute("data-state", "landed", {
      timeout: 25_000,
    });
    await expect(sidebar.getByTestId("not-in-a-folder-title")).toHaveText(
      say(language, "sidebar.examples"),
    );
    await expect(sidebar.getByTestId("library-nav")).toHaveCount(0);
    await expect(sidebar.getByTestId("examples-section")).toHaveCount(0);
    await expect(sidebar.getByTestId("document-list-item")).toHaveCount(docsBefore);
    await shot(window, `walk-after-first-ask-${language}`);

    // Box 13: quit and reopen keeps the Note the User was in in front (not Home).
    await closeApp();
    window = await start(size, { language, ownAi: true });
    await expect(window.getByTestId("mind-pane")).toBeVisible();
    await expect(frontMindName(window)).toHaveText(EXAMPLE_SETS.contracts[language].title);
    await expect(window.getByTestId("home")).toHaveCount(0);
    await shot(window, `walk-reopened-note-${language}`);

    // Also verify a User-created Note stays in front across quit and reopen.
    await newMind(window);
    await window.keyboard.type(language === "zh-CN" ? "我的复盘笔记" : "My review note");
    await expect(frontMindName(window)).toHaveText(
      language === "zh-CN" ? "我的复盘笔记" : "My review note",
    );
    await closeApp();
    window = await start(size, { language, ownAi: true });
    await expect(window.getByTestId("mind-pane")).toBeVisible();
    await expect(frontMindName(window)).toHaveText(
      language === "zh-CN" ? "我的复盘笔记" : "My review note",
    );
    await expect(window.getByTestId("home")).toHaveCount(0);
  });
}

test("every Your work answer opens an example with one contradicted mark, foot line, and checks cleanly on Claude Code", async () => {
  test.setTimeout(240_000);
  await installAgent("claude-code", { applications: apps, commands: apps, home }, "command");
  await writeFile(join(home, ".claude.json"), "{}\n");
  await writeFile(modeFile, "check");
  const cases: readonly { work: WorkKind; group: keyof typeof EXAMPLE_SETS }[] = [
    { work: "legal", group: "contracts" },
    { work: "research", group: "papers" },
    { work: "reports", group: "reports" },
    { work: "meetings", group: "meetings" },
    { work: "finance", group: "credit" },
  ];
  for (const { work, group } of cases) {
    const dir = await createDataFolder();
    const prev = dataDir;
    dataDir = dir;
    try {
      const window = await start({ width: 900, height: 760 }, { language: "zh-CN", ownAi: true });
      const panel = window.getByTestId("setup-panel");
      await panel.locator(`[data-testid="setup-work"][data-value="${work}"]`).click();
      await panel.getByTestId("setup-next").click();
      await expect(panel).toHaveAttribute("data-step", "ai");
      await panel.getByTestId("setup-connect").click();
      await expect(panel).toHaveAttribute("data-step", "meetings");
      await panel.getByTestId("setup-skip").click();
      await expect(window.getByTestId("setup-page")).toHaveCount(0);
      await expect(frontMindName(window)).toHaveText(EXAMPLE_SETS[group]["zh-CN"].title);
      await expect(window.getByTestId("example-line")).toContainText(
        say("zh-CN", "examples.line.credit"),
      );
      await expect(
        window.locator('[data-testid="claim-mark"][data-check="contradicted"]'),
      ).toHaveCount(1, { timeout: 15_000 });

      // Wait for the example's Documents to finish processing before pressing Check.
      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              const docs = await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listDocuments();
              return docs.length > 0 && docs.every((each) => each.status === "ready");
            }),
          { timeout: 30_000 },
        )
        .toBe(true);

      // Press Check on the example Note: marks land on Claude Code without a beyond-reach refusal.
      await checkNote(window);
      await expect
        .poll(
          () => window.locator('[data-testid="claim-mark"][data-check="unsupported"]').count(),
          { timeout: 25_000 },
        )
        .toBeGreaterThan(0);
      await expect(window.getByTestId("checks-asked")).toHaveCount(0);
    } finally {
      await closeApp();
      dataDir = prev;
      await removeDataFolder(dir);
    }
  }
});
