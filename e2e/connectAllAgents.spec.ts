import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { installAgent } from "../tests/helpers/agentInstalls";
import {
  acceptPlainTextKeys,
  catchCopies,
  copied,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  interceptOpenExternal,
  interceptOpenPath,
  launchApp,
  motionSettled,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * Connect several AI apps on this computer in one press (#3644):
 * - First Run (#3791): one list with only the first app ticked; the User ticks the others, and one
 *   Connect writes file apps at once, leaves install-link apps waiting with their one button, and
 *   a settings-paste app with Copy and its settings under Details; Undo takes the press back.
 * - Settings › AI: "Connect all N" opens the same sheet as a dialog, connects all found apps under
 *   one Folder choice, and gives each app its own row.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const STAND_INS = { fakeChat: true, ollama: "http://127.0.0.1:9", decisions: "http://127.0.0.1:9" };
const CODEX_BEFORE = 'model = "gpt-6-luna"\n';
const CLAUDE_BEFORE = '{\n  "theme": "light"\n}\n';

let dataDir: string;
let home: string;
let apps: string;
let sources: string;
let app: ElectronApplication | null = null;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  apps = await realpath(await createDataFolder());
  sources = await realpath(await createDataFolder());
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), CODEX_BEFORE);
  await writeFile(join(home, ".claude.json"), CLAUDE_BEFORE);
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(apps);
  await removeDataFolder(sources);
});

async function shot(window: Page, name: string, width: number, height: number) {
  if (!SCREENSHOTS || !app) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await setWindowSize(app, window, width, height);
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}-${width}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`first run: connects all four found apps in one press (${language})`, async () => {
    const folders = { applications: apps, commands: apps, home };
    await installAgent("codex", folders, "command");
    await installAgent("claude-code", folders, "command");
    await installAgent("cursor", folders, "app");
    await installAgent("zed", folders, "app");

    const launched = await launchApp(dataDir, {
      ...STAND_INS,
      firstRunSetup: true,
      home,
      agentApps: [apps],
    });
    app = launched.app;
    const { window } = launched;
    await interceptOpenPath(app);
    await interceptOpenExternal(app);
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    await catchCopies(window);

    // Move through Language/Work step to Your AI step in the chosen language.
    if (language === "zh-CN") {
      await setLanguage(window, "zh-CN");
    }
    const panel = window.getByTestId("setup-panel");
    // Step 1: Work (skip to Your AI step)
    if ((await panel.getAttribute("data-step")) === "work") {
      await window.getByTestId("setup-skip").click();
    }
    await expect(panel).toHaveAttribute("data-step", "ai");

    // One list of the four, only Claude Code ticked (#3791); the User ticks the rest.
    const row = (id: string) => panel.locator(`[data-testid="setup-app"][data-value="${id}"]`);
    await expect(panel.getByTestId("setup-app")).toHaveCount(3);
    await panel.getByTestId("setup-apps-more").click();
    await expect(panel.getByTestId("setup-app")).toHaveCount(4);
    await expect(panel.locator('[data-testid="setup-app-tick"]:checked')).toHaveCount(1);
    await expect(row("claude-code").getByTestId("setup-app-tick")).toBeChecked();
    for (const id of ["codex", "cursor", "zed"])
      await row(id).getByTestId("setup-app-tick").check();
    await panel.getByTestId("setup-consent-details").click();
    await expect(panel.getByTestId("setup-consent-more")).toBeVisible();
    await shot(window, `first-run-sheet-${language}`, 1440, 900);
    await shot(window, `first-run-sheet-${language}`, 900, 700);
    await setWindowSize(app, window, 1440, 900);

    // One press: two written at once, Cursor waiting for its own Install, Zed for a paste.
    await panel.getByTestId("setup-connect").click();
    const done = panel.getByTestId("setup-done");
    const doneRow = (id: string) =>
      done.locator(`[data-testid="setup-done-row"][data-client="${id}"]`);
    await expect(doneRow("codex")).not.toHaveAttribute("data-left");
    await expect(doneRow("claude-code")).not.toHaveAttribute("data-left");
    await expect(doneRow("cursor")).toHaveAttribute("data-left", "true");
    await expect(doneRow("zed")).toHaveAttribute("data-left", "true");
    // The step stays while two still need the User, and says so in plain words.
    await expect(panel.getByTestId("setup-next")).toBeDisabled();
    await shot(window, `first-run-result-${language}`, 1440, 900);
    await shot(window, `first-run-result-${language}`, 900, 700);
    await setWindowSize(app, window, 1440, 900);

    // Cursor's link opened once, and its one button opens it again.
    const linksBefore = (await urlsOpened(app)).filter((u) => u.startsWith("cursor://")).length;
    expect(linksBefore).toBe(1);
    await doneRow("cursor").getByTestId("setup-done-open").click();
    await expect
      .poll(
        async () =>
          (await urlsOpened(app as ElectronApplication)).filter((u) => u.startsWith("cursor://"))
            .length,
      )
      .toBe(2);

    // Zed's settings show only under Details, the key hidden, while Copy puts the real ones on the
    // clipboard.
    const details = doneRow("zed").getByTestId("setup-done-details");
    await expect(details.locator("pre")).toBeHidden();
    await details.locator("summary").click();
    const zedShown = await details.locator("pre").innerText();
    await doneRow("zed").getByTestId("setup-done-copy").click();
    const copiedText = await copied(window);
    expect(copiedText).toContain("incarnamind");
    expect(copiedText).not.toBe(zedShown);

    // Both settings files were written, and Undo takes every connection of the press back.
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain("incarnamind");
    expect(await readFile(join(home, ".claude.json"), "utf8")).toContain("incarnamind");
    await panel.getByTestId("setup-undo").click();
    await expect(panel.getByTestId("setup-apps")).toBeVisible();
    await expect
      .poll(() => readFile(join(home, ".codex", "config.toml"), "utf8"))
      .toBe(CODEX_BEFORE);
  });

  test(`settings: Connect all opens one sheet, connects each app with its own row (${language})`, async () => {
    const folders = { applications: apps, commands: apps, home };
    await installAgent("codex", folders, "command");
    await installAgent("claude-code", folders, "command");
    await installAgent("zed", folders, "app");

    const launched = await launchApp(dataDir, { ...STAND_INS, home, agentApps: [apps] });
    app = launched.app;
    const { window } = launched;
    await interceptOpenPath(app);
    await interceptOpenExternal(app);
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await catchCopies(window);

    // Create one Folder so the sheet offers All vs Choose Folders.
    const tides = join(sources, "Tides.md");
    await writeFile(tides, "# Tides\n\nSpring tides happen twice a month.\n");
    await window.evaluate(async (path) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const coast = await bridge.createLibraryGroup({ name: "Coast", description: "The sea." });
      await bridge.addDocuments([path], { groupId: coast.id });
    }, tides);
    await expectReadyDocuments(window, 1);
    const page = await openSettings(window, "ai");
    if (language === "zh-CN") {
      await setLanguage(window, "zh-CN");
    }
    const offerRow = page.getByTestId("agents-connect-all-row");
    await expect(offerRow).toBeVisible();
    await shot(window, `settings-offer-${language}`, 1440, 900);
    await shot(window, `settings-offer-${language}`, 900, 700);
    await setWindowSize(app, window, 1440, 900);

    await offerRow.getByTestId("agents-connect-all").click();
    const dialog = window.getByTestId("connect-many-dialog");
    await expect(dialog).toBeVisible();
    await acceptPlainTextKeys(window, dialog);
    await shot(window, `settings-dialog-all-${language}`, 1440, 900);
    await shot(window, `settings-dialog-all-${language}`, 900, 700);
    await setWindowSize(app, window, 1440, 900);
    await dialog.getByTestId("agent-share-folders").check();
    await dialog.getByTestId("agent-folder").check();
    await shot(window, `settings-dialog-${language}`, 1440, 900);
    await dialog.getByTestId("connect-many-allow").click();

    await expect(dialog.getByTestId("connect-many-result")).toBeVisible();
    await expect(dialog.locator('[data-client="codex"][data-outcome="connected"]')).toBeVisible();
    await expect(
      dialog.locator('[data-client="claude-code"][data-outcome="connected"]'),
    ).toBeVisible();
    await expect(dialog.locator('[data-client="zed"][data-outcome="copy"]')).toBeVisible();
    await dialog.getByTestId("connect-many-done").click();
    await expect(dialog).toBeHidden();

    // Every connected app has its own row, and Disconnect all removes every entry and Skill copy.
    await expect(page.getByTestId("agent-pairing")).toHaveCount(3);
    await expect(page.getByTestId("agents-connect-all-row")).toHaveCount(0);
    await page.getByTestId("agents-disconnect-all-open").click();
    await page.getByTestId("agents-disconnect-all-confirm").click();
    await expect(page.getByTestId("agent-pairing")).toHaveCount(0);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe(CODEX_BEFORE);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(CLAUDE_BEFORE);
    await expect(stat(join(home, ".claude", "skills", "incarnamind", "SKILL.md"))).rejects.toThrow(
      /ENOENT/,
    );
  });

  test(`Settings › AI: one app fails while the others connect, and Try again recovers it (${language})`, async () => {
    const folders = { applications: apps, commands: apps, home };
    await installAgent("codex", folders, "command");
    await installAgent("claude-code", folders, "command");
    await installAgent("cursor", folders, "app");
    // Put a directory at ~/.claude.json so Claude Code's setup fails cleanly on every OS while Codex and Cursor succeed.
    await rm(join(home, ".claude.json"), { force: true });
    await mkdir(join(home, ".claude.json"));

    const launched = await launchApp(dataDir, { ...STAND_INS, home, agentApps: [apps] });
    app = launched.app;
    const { window } = launched;
    await interceptOpenPath(app);
    await interceptOpenExternal(app);
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);

    const page = await openSettings(window, "ai");
    if (language === "zh-CN") {
      await setLanguage(window, "zh-CN");
    }
    await page.getByTestId("agents-connect-all").click();
    const dialog = window.getByTestId("connect-many-dialog");
    await expect(dialog).toBeVisible();
    await acceptPlainTextKeys(window, dialog);
    await dialog.getByTestId("connect-many-allow").click();

    await expect(dialog.getByTestId("connect-many-result")).toBeVisible();
    await expect(dialog.locator('[data-client="codex"][data-outcome="connected"]')).toBeVisible();
    await expect(dialog.locator('[data-client="cursor"][data-outcome="opened"]')).toBeVisible();
    const failed = dialog.locator('[data-client="claude-code"][data-outcome="failed"]');
    await expect(failed).toBeVisible();
    await shot(window, `settings-partial-failed-${language}`, 1440, 900);
    await shot(window, `settings-partial-failed-${language}`, 900, 700);
    await setWindowSize(app, window, 1440, 900);

    // Fix the file and press Try again for Claude Code alone; it connects without touching Codex or Cursor.
    await rm(join(home, ".claude.json"), { recursive: true, force: true });
    await writeFile(join(home, ".claude.json"), CLAUDE_BEFORE);
    await failed.getByTestId("connect-many-retry").click();
    await expect(
      dialog.locator('[data-client="claude-code"][data-outcome="connected"]'),
    ).toBeVisible();
    await dialog.getByTestId("connect-many-done").click();
    await expect(page.getByTestId("agent-pairing")).toHaveCount(3);
  });
}
