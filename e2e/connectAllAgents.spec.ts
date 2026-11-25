import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
 * Connect every AI app on this computer in one press (#3644):
 * - First Run: when 2+ apps are found, "All N on this computer" starts chosen with one consent
 *   sheet; unticking an app updates the button count; Allow connects file apps silently (with Undo),
 *   opens install-link apps (with Open again), and shows a hidden-token paste box (with Copy).
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

    // "All 4 on this computer" starts selected by default with all 4 apps ticked.
    const allTile = window.getByTestId("setup-agent-all");
    await expect(allTile).toBeVisible();
    await expect(allTile.locator("input[type=radio]")).toBeChecked();
    await expect(window.getByTestId("connect-many-app")).toHaveCount(4);
    const allowAll = window.getByTestId("setup-agent-allow-all");
    await expect(allowAll).toBeEnabled();
    await expect(allowAll).toContainText(
      language === "en" ? "Allow and connect 4" : "允许并连接 4 个",
    );

    // Open Details and verify per-app previews; untick Zed and verify button count drops to 3.
    await window.getByTestId("connect-many-details").locator("summary").first().click();
    await expect(window.getByTestId("connect-many-app-detail")).toHaveCount(4);
    await shot(window, `first-run-sheet-${language}`, 1440, 900);
    await shot(window, `first-run-sheet-${language}`, 900, 700);
    await setWindowSize(app, window, 1440, 900);

    const zedCheckbox = window.locator(
      '[data-testid="connect-many-app"][data-client="zed"] input[type=checkbox]',
    );
    await zedCheckbox.uncheck();
    await expect(allowAll).toContainText(
      language === "en" ? "Allow and connect 3" : "允许并连接 3 个",
    );
    await zedCheckbox.check();
    await expect(allowAll).toContainText(
      language === "en" ? "Allow and connect 4" : "允许并连接 4 个",
    );

    // Press Allow and connect 4: two written silently, one opened (Cursor), one paste box (Zed).
    await allowAll.click();
    const result = window.getByTestId("connect-many-result");
    await expect(result).toBeVisible();
    await expect(result.locator('[data-client="codex"][data-outcome="connected"]')).toBeVisible();
    await expect(
      result.locator('[data-client="claude-code"][data-outcome="connected"]'),
    ).toBeVisible();
    await expect(result.locator('[data-client="cursor"][data-outcome="opened"]')).toBeVisible();
    await expect(result.locator('[data-client="zed"][data-outcome="copy"]')).toBeVisible();
    await shot(window, `first-run-result-${language}`, 1440, 900);
    await shot(window, `first-run-result-${language}`, 900, 700);
    await setWindowSize(app, window, 1440, 900);

    // Cursor link opened once, and "Open Cursor again" re-opens it.
    const linksBefore = (await urlsOpened(app)).filter((u) => u.startsWith("cursor://")).length;
    expect(linksBefore).toBe(1);
    await result.locator('[data-client="cursor"]').getByTestId("connect-many-open-again").click();
    await expect
      .poll(
        async () =>
          (await urlsOpened(app as ElectronApplication)).filter((u) => u.startsWith("cursor://"))
            .length,
      )
      .toBe(2);

    // Zed paste box hides the token visually, while Copy puts the real token on the clipboard.
    const zedShown = await result
      .locator('[data-client="zed"]')
      .getByTestId("connect-many-paste-text")
      .innerText();
    await result.locator('[data-client="zed"]').getByTestId("connect-many-copy").click();
    const copiedText = await copied(window);
    expect(copiedText).toContain("incarnamind");
    expect(copiedText).not.toBe(zedShown);

    // Both settings files were written, and Undo on Codex restores config.toml cleanly.
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain("incarnamind");
    expect(await readFile(join(home, ".claude.json"), "utf8")).toContain("incarnamind");
    await result.locator('[data-client="codex"]').getByTestId("connect-many-undo").click();
    await expect(result.locator('[data-client="codex"][data-outcome="undone"]')).toBeVisible();
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe(CODEX_BEFORE);
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
}
