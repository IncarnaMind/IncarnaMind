import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { openDatabase } from "../src/core/storage";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  agentsToConnect,
  catchCopies,
  copied,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  openSettings,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * Settings → AI (#351): turned on, an agent is connected after one plain
 * confirmation that names what it may read and where that goes; Codex's
 * settings file is written as shown, with Undo; an agent set up by pasting
 * its settings searches, and its activity lists each call; Disconnect stops
 * it. The home folder is a temporary one, so no agent of the User's is
 * touched, and copying is caught in the page, so the machine's clipboard isn't.
 */

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** Saves a screenshot when INCARNAMIND_SCREENSHOTS names a folder for them. */
async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const CODEX_SETTINGS = 'model = "gpt-6-luna"\n';

/** A Folder "Coast" with one Document in it. */
async function withCoast(window: Page) {
  const tides = join(sources, "Tides.md");
  await writeFile(
    tides,
    "# Tides\n\nSpring tides happen twice a month, at new moon and full moon, when the sun and the moon pull in line.\n",
  );
  await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const coast = await bridge.createLibraryGroup({ name: "Coast", description: "The sea." });
    await bridge.addDocuments([path], { groupId: coast.id });
  }, tides);
  await expectReadyDocuments(window, 1);
}

test("off by default with no switch to find; Connect asks once, turns connecting on, writes Codex's settings as shown, and Undo takes them back", async () => {
  await mkdir(join(home, ".codex"));
  const codexSettings = join(home, ".codex", "config.toml");
  await writeFile(codexSettings, CODEX_SETTINGS);
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await withCoast(window);
    const enabled = () =>
      window.evaluate(
        async () =>
          (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgents())
            .enabled,
      );
    expect(await enabled()).toBe(false);
    // Nothing set up: Your AI leads Settings › AI with the agents to connect, and no switch (#3645).
    const page = await openSettings(window, "ai");
    await expect(page.getByTestId("agents-enabled")).toHaveCount(0);
    await expect(page.getByTestId("ai-lede")).toHaveText(
      "Let the AI tool you use read your Documents.",
    );
    const list = page.getByTestId("agents-list");
    // Those found here and the most used, and "Other agent"; the rest are found by typing.
    await expect(list.getByTestId("agent-client")).toHaveCount(8);
    await expect(page.getByTestId("agents-connected")).toContainText("can’t reach IncarnaMind");
    const codex = list.locator('[data-client="codex"]');
    await expect(codex).toContainText("ChatGPT app and Codex");
    await expect(codex).toContainText("Works in the ChatGPT desktop app, not on the web.");
    await expect(codex).toContainText(
      "IncarnaMind adds itself to the settings of the ChatGPT app or Codex",
    );
    await shot(window, "agents-on");
    await codex.getByTestId("agent-connect").click();

    const dialog = window.getByTestId("connect-agent-dialog");
    await expect(dialog).toContainText("Let the ChatGPT app or Codex read your Documents?");
    await expect(dialog).toContainText("some plans may train on it.");
    await expect(dialog.getByTestId("connect-agent-change")).toContainText(codexSettings);
    const skillFile = join(home, ".agents", "skills", "incarnamind", "SKILL.md");
    await expect(dialog.getByTestId("connect-agent-skill")).toContainText(skillFile);
    const allow = dialog.getByTestId("connect-agent-allow");
    // Linux with no keyring running (CI): the dialog asks to keep the key as plain text first.
    await acceptPlainTextKeys(window, dialog);
    // All of the User's Documents and notes is chosen already (#3544); Choose Folders waits for one.
    await expect(dialog.getByTestId("agent-share-all")).toBeChecked();
    await expect(allow).toBeEnabled();
    await dialog.getByTestId("agent-share-folders").check();
    await expect(allow).toBeDisabled();
    await dialog.getByTestId("agent-folder").check();
    // The three lines are in view; what it adds to the file is under Details.
    const allowBox = await allow.boundingBox();
    const viewport = await window.evaluate(() => innerHeight);
    expect((allowBox?.y ?? viewport) + (allowBox?.height ?? 0)).toBeLessThanOrEqual(viewport);
    await shot(window, "agents-connect-dialog-short");
    await dialog.getByTestId("connect-agent-details").locator("summary").first().click();
    await dialog.getByTestId("connect-agent-change-lines").locator("summary").click();
    await shot(window, "agents-connect-dialog");
    await allow.click();
    await expect(dialog).toBeHidden();
    expect(await enabled()).toBe(true);
    await expect(page.getByTestId("agents-enabled")).toHaveCount(0);

    const connected = page
      .getByTestId("agent-pairing")
      .filter({ hasText: "ChatGPT app and Codex" });
    await expect(connected.getByTestId("agent-setup-done")).toContainText(
      "“Allow for this session” lets it hand over more files in the same chat.",
    );
    await expect(connected.getByTestId("agent-pairing-reads")).toHaveText("Reads Coast");
    await expect(connected.getByTestId("agent-pairing-skill")).toContainText("Skill installed");
    expect(await readFile(skillFile, "utf8")).toContain("name: incarnamind");
    await shot(window, "agents-connected");
    const written = await readFile(codexSettings, "utf8");
    expect(written).toContain("[mcp_servers.incarnamind]");
    expect(written.startsWith(CODEX_SETTINGS.trimEnd())).toBe(true);

    await connected.getByTestId("agent-setup-undo").click();
    await expect(page.getByTestId("agent-pairing")).toHaveCount(0);
    expect(await readFile(codexSettings, "utf8")).toBe(CODEX_SETTINGS);
    await expect(readFile(skillFile, "utf8")).rejects.toThrow(/ENOENT/);
  } finally {
    await app.close();
  }
});

test("in the connect dialog a long path breaks at its slashes and no word breaks, in English and Chinese", async () => {
  // A deep home folder, so both paths are longer than the dialog's line.
  const deepHome = join(home, "projects-with-a-long-name", "second-level-folder-name");
  await mkdir(deepHome, { recursive: true });
  const { app, window } = await launchApp(dataDir, { home: deepHome });
  try {
    await dismissChatSetup(window);
    await withCoast(window);
    const page = await openSettings(window, "ai");
    await (await agentsToConnect(page))
      .locator('[data-client="codex"]')
      .getByTestId("agent-connect")
      .click();
    const dialog = window.getByTestId("connect-agent-dialog");
    await dialog.getByTestId("connect-agent-details").locator("summary").first().click();
    await expect(dialog.getByTestId("connect-agent-skill")).toBeVisible();

    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      const paragraphs = [
        dialog.getByTestId("connect-agent-change").locator("p"),
        dialog.getByTestId("connect-agent-skill"),
      ];
      for (const paragraph of paragraphs) {
        await expect(paragraph.locator("code")).toBeVisible();
        const wrapping = await paragraph.evaluate((element) => {
          const topOf = (node: Node, offset: number) => {
            const range = new Range();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            return Math.round(range.getBoundingClientRect().top);
          };
          const path = element.querySelector("code");
          const pathLines = new Set<number>();
          const misplaced: string[] = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent ?? "";
            const inPath = path?.contains(node) ?? false;
            for (let at = 0; at < text.length; at++) {
              const top = topOf(node, at);
              if (inPath) pathLines.add(top);
              if (at === 0 || topOf(node, at - 1) === top) continue;
              // The line broke here. In the path only after a slash (or the hyphen a browser
              // also breaks at); in the prose, never inside a Latin word.
              const before = text[at - 1] ?? "";
              const inside = inPath
                ? !"/\\-".includes(before)
                : /[A-Za-z’']/.test(before) && /[A-Za-z’']/.test(text[at] ?? "");
              if (inside) misplaced.push(text.slice(Math.max(0, at - 6), at + 6));
            }
          }
          return { pathLines: pathLines.size, misplaced };
        });
        expect(wrapping.pathLines, `${language}: the path wraps`).toBeGreaterThan(1);
        expect(wrapping.misplaced, `${language}: a break inside a word or a name`).toEqual([]);
      }
    }
  } finally {
    await app.close();
  }
});

test("an agent set up by pasting its settings searches, its activity shows each call, and Disconnect stops it", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await withCoast(window);
    await catchCopies(window);
    await acceptPlainTextKeys(window);
    const page = await openSettings(window, "ai");
    await (await agentsToConnect(page))
      .locator('[data-client="other"]')
      .getByTestId("agent-connect")
      .click();
    const dialog = window.getByTestId("connect-agent-dialog");
    await expect(dialog).toContainText("Let your agent read your Documents?");
    await expect(dialog.getByTestId("connect-agent-name")).toHaveAttribute(
      "placeholder",
      "My agent",
    );
    await shot(window, "agents-connect-other-en");
    await dialog.getByTestId("agent-share-folders").check();
    await dialog.getByTestId("agent-folder").check();
    await dialog.getByTestId("connect-agent-allow").click();

    const row = page.locator('[data-testid="agent-pairing"][data-name="Other agent"]');
    await expect(row.getByTestId("agent-setup-done")).toContainText("Copied.");
    const settings = JSON.parse(await copied(window)) as {
      mcpServers: { incarnamind: { command: string; args: string[]; env: Record<string, string> } };
    };
    const server = settings.mcpServers.incarnamind;

    const agent = new Client({ name: "test-agent", version: "1.0.0" });
    await agent.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: server.env,
        stderr: "pipe",
      }),
    );
    try {
      await agent.callTool({ name: "search", arguments: { query: "spring tides" } });
      await row.getByTestId("agent-activity-toggle").click();
      await expect(row.getByTestId("agent-activity-call").first()).toContainText(
        "Searched “spring tides” · 1 result",
      );
      await shot(window, "agents-activity");

      // Its Folders change in place.
      await row.getByTestId("agent-folders").click();
      await row.getByTestId("agent-pairing-folders").getByTestId("agent-folder").uncheck();
      await expect(row.getByTestId("agent-pairing-reads")).toHaveText("Reads no Folders yet");

      // Its name renames in place: a double-click, or F2; Esc cancels and leaves Settings open.
      await row.getByTestId("agent-pairing-name").dblclick();
      await row.getByTestId("agent-pairing-rename").fill("Research agent");
      await window.keyboard.press("Enter");
      const renamed = page.getByTestId("agent-pairing").filter({ hasText: "Research agent" });
      await expect(renamed.getByTestId("agent-pairing-name")).toHaveText("Research agent");
      await renamed.getByTestId("agent-pairing-name").focus();
      await window.keyboard.press("F2");
      await renamed.getByTestId("agent-pairing-rename").fill("Something else");
      await window.keyboard.press("Escape");
      await expect(renamed.getByTestId("agent-pairing-name")).toHaveText("Research agent");
      await expect(page).toBeVisible();

      await renamed.getByTestId("agent-disconnect").click();
      await expect(page.getByTestId("agent-pairing")).toHaveCount(0);
    } finally {
      await agent.close();
    }
  } finally {
    await app.close();
  }
});

test("an Other agent's Details show the command, arguments and environment, each copied whole, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await withCoast(window);
    await catchCopies(window);
    await acceptPlainTextKeys(window);
    const page = await openSettings(window, "ai");
    await (await agentsToConnect(page))
      .locator('[data-client="other"]')
      .getByTestId("agent-connect")
      .click();
    const dialog = window.getByTestId("connect-agent-dialog");
    await dialog.getByTestId("agent-share-folders").check();
    await dialog.getByTestId("agent-folder").check();
    await dialog.getByTestId("connect-agent-allow").click();

    const row = page.getByTestId("agent-pairing").filter({ hasText: "Other agent" });
    await expect(row.getByTestId("agent-setup-done")).toContainText("Details shows each part");
    const all = JSON.parse(await copied(window)) as {
      mcpServers: { incarnamind: { command: string; args: string[]; env: Record<string, string> } };
    };
    const server = all.mcpServers.incarnamind;
    const key = server.env.INCARNAMIND_AGENT_TOKEN ?? "";
    expect(key).not.toBe("");

    await row.locator("summary", { hasText: "Details for technical users" }).click();
    const launch = row.getByTestId("agent-launch");
    await expect(launch).toContainText("Command");
    await expect(launch).toContainText("Arguments");
    await expect(launch).toContainText("Environment");
    await expect(launch).toContainText("INCARNAMIND_AGENT_TOKEN=•••••••");
    expect(await launch.innerText()).not.toContain(key);
    await shot(window, "agents-other-details");

    const copyOf = async (id: string) => {
      await launch.getByTestId(`agent-launch-${id}`).getByTestId("agent-launch-copy").click();
      return copied(window);
    };
    const command = await copyOf("command");
    const args = (await copyOf("args")).split("\n");
    const env: Record<string, string> = {};
    for (const name of Object.keys(server.env)) {
      const line = await copyOf(`env-${name}`);
      env[name] = line.slice(name.length + 1);
    }
    expect(command).toBe(server.command);
    expect(args).toEqual(server.args);
    expect(env).toEqual(server.env);
    expect(env.INCARNAMIND_AGENT_TOKEN).toBe(key);

    const agent = new Client({ name: "test-agent", version: "1.0.0" });
    await agent.connect(new StdioClientTransport({ command, args, env, stderr: "pipe" }));
    try {
      const found = await agent.callTool({ name: "search", arguments: { query: "spring tides" } });
      expect(found.isError ?? false).toBe(false);
    } finally {
      await agent.close();
    }

    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: "zh-CN" } });
    });
    await expect(launch).toContainText("命令");
    await expect(launch).toContainText("参数");
    await expect(launch).toContainText("环境变量");
    await expect(launch).toContainText("INCARNAMIND_AGENT_TOKEN=•••••••");
    await shot(window, "agents-other-details-zh");
  } finally {
    await app.close();
  }
});

test("in Chinese the Codex agent is named in Chinese in the list, the dialog and the connected row", async () => {
  await mkdir(join(home, ".codex"));
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await withCoast(window);
    await acceptPlainTextKeys(window);
    await setWindowSize(app, window, 900, 660);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setAgentsEnabled(true);
      await bridge.updateSettings({ user: { language: "zh-CN" } });
    });
    await window.getByRole("button", { name: "设置" }).click();
    const page = await showSettingsPage(window, "ai");
    await (await agentsToConnect(page))
      .locator('[data-client="other"]')
      .getByTestId("agent-connect")
      .click();
    const other = window.getByTestId("connect-agent-dialog");
    await expect(other).toContainText("允许你的智能体读取你的文档？");
    await expect(other.getByTestId("connect-agent-name")).toHaveAttribute(
      "placeholder",
      "我的智能体",
    );
    await shot(window, "agents-connect-other-zh");
    await other.getByRole("button", { name: "取消" }).click();
    await expect(other).toBeHidden();
    const codex = page.getByTestId("agents-list").locator('[data-client="codex"]');
    await shot(window, "agents-codex-name-zh-list");
    await expect(codex).toContainText("IncarnaMind 会把自己添加到 ChatGPT 应用或 Codex 的设置中");
    await codex.getByTestId("agent-connect").click();

    const dialog = window.getByTestId("connect-agent-dialog");
    await shot(window, "agents-codex-name-zh-dialog");
    await expect(dialog).toContainText("允许 ChatGPT 应用或 Codex 读取你的文档？");
    await acceptPlainTextKeys(window, dialog);
    await dialog.getByTestId("agent-share-folders").check();
    await dialog.getByTestId("agent-folder").check();
    await dialog.getByTestId("connect-agent-allow").press("Enter");
    await expect(dialog).toBeHidden();

    const connected = page.getByTestId("agent-pairing").filter({ hasText: "ChatGPT 应用和 Codex" });
    await expect(connected.getByTestId("agent-pairing-name")).toBeFocused();
    await expect(connected.getByTestId("agent-setup-done")).toBeInViewport({ ratio: 1 });
    await shot(window, "agents-codex-name-zh-connected-900");
    await expect(connected.getByTestId("agent-setup-done")).toContainText(
      "选“Allow for this session”（允许本次会话），这次对话里再交付文件就不用逐次确认。",
    );
    await setWindowSize(app, window, 1440, 900);
    await shot(window, "agents-codex-name-zh-connected-wide");
    await expect(connected.getByTestId("agent-setup-done")).toBeVisible();
    await expect(page).not.toContainText("app and");
  } finally {
    await app.close();
  }
});

test("Disconnect takes away the settings file Connect made, and the agent stays among those not on this computer", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await withCoast(window);
    await acceptPlainTextKeys(window);
    const page = await openSettings(window, "ai");
    const list = await agentsToConnect(page);
    await expect(list.getByTestId("agent-client").first()).toBeVisible();
    const order = () =>
      list
        .getByTestId("agent-client")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-client")));
    const before = await order();
    const search = page.getByTestId("agents-list-search");
    await search.fill("workbuddy");
    await list.locator('[data-client="workbuddy"]').getByTestId("agent-connect").click();
    const dialog = window.getByTestId("connect-agent-dialog");
    await acceptPlainTextKeys(window, dialog);
    await dialog.getByTestId("agent-share-folders").check();
    await dialog.getByTestId("agent-folder").check();
    await dialog.getByTestId("connect-agent-allow").click();
    await expect(dialog).toBeHidden();
    expect(await readFile(join(home, ".workbuddy", "mcp.json"), "utf8")).toContain("incarnamind");

    await page.getByTestId("agent-pairing").getByTestId("agent-disconnect").click();
    await expect(page.getByTestId("agent-pairing")).toHaveCount(0);
    await expect(stat(join(home, ".workbuddy"))).rejects.toThrow(/ENOENT/);
    await search.fill("");
    await expect.poll(order).toEqual(before);
  } finally {
    await app.close();
  }
});

test("a Skill the User changed is left out of date, Replace asks first, and Disconnect leaves it and says where", async () => {
  const skillFile = join(home, ".agents", "skills", "incarnamind", "SKILL.md");
  const added = "\nA line the User added.\n";
  let current = "";
  const first = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(first.window);
    await withCoast(first.window);
    await acceptPlainTextKeys(first.window);
    await first.window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const coast = (await bridge.getLibrary()).groups.find((group) => group.name === "Coast");
      await bridge.setAgentsEnabled(true);
      await bridge.setUpAgent({ client: "codex", folderIds: [coast?.id ?? ""] });
    });
    current = await readFile(skillFile, "utf8");
  } finally {
    await first.app.close();
  }
  // As an earlier release left it, with a line the User added: IncarnaMind's text has changed since.
  await writeFile(skillFile, `${current}${added}`);
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  db.run("UPDATE device_settings SET value = ? WHERE key = 'agentSkillFiles'", [
    JSON.stringify({
      ".agents/skills/incarnamind/SKILL.md": createHash("sha256")
        .update("An earlier text.")
        .digest("hex"),
    }),
  ]);
  db.close();

  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    const page = await openSettings(window, "ai");
    const row = page.getByTestId("agent-pairing");
    await expect(row.getByTestId("agent-pairing-skill-old")).toContainText(
      "Skill out of date: you changed it",
    );
    await expect(row.getByTestId("agent-pairing-skill")).toBeHidden();

    // Replace asks first, naming what is lost; Esc keeps the file and leaves Settings open.
    await row.getByTestId("agent-skill-replace").click();
    await expect(row.getByTestId("agent-pairing-skill-old")).toContainText(
      "Replacing discards your changes to the Skill file.",
    );
    await expect(row.getByTestId("agent-skill-replace-cancel")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(row.getByTestId("agent-skill-replace")).toBeFocused();
    await expect(page).toBeVisible();
    expect(await readFile(skillFile, "utf8")).toBe(`${current}${added}`);

    await setLanguage(window, "zh-CN");
    await expect(row.getByTestId("agent-pairing-skill-old")).toContainText(
      "技能已过期：你改过这个文件",
    );
    await setLanguage(window, "en");

    await row.getByTestId("agent-skill-replace").click();
    await row.getByTestId("agent-skill-replace-confirm").click();
    await expect(row.getByTestId("agent-pairing-skill")).toContainText("Skill installed");
    await expect(row.getByTestId("agent-pairing-skill-old")).toBeHidden();
    expect(await readFile(skillFile, "utf8")).toBe(current);

    // Changed again, Disconnect leaves the file, and says where it stays.
    await writeFile(skillFile, `${current}${added}`);
    await row.getByTestId("agent-disconnect").click();
    await expect(page.getByTestId("agent-pairing")).toHaveCount(0);
    await expect(page.getByTestId("agent-skill-left")).toContainText(
      `Disconnected the ChatGPT app or Codex. Its Skill stays at ${join("~", ".agents", "skills", "incarnamind", "SKILL.md")}: you changed it.`,
    );
    expect(await readFile(skillFile, "utf8")).toBe(`${current}${added}`);
  } finally {
    await app.close();
  }
});

test("Local mode pauses agents, and the page reads in Chinese at a narrow window", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 660);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setAgentsEnabled(true);
      await bridge.setLocalOnly(true);
      await bridge.updateSettings({ user: { language: "zh-CN" } });
    });
    await window.getByRole("button", { name: "设置" }).click();
    const page = await showSettingsPage(window, "ai");
    await expect(window.getByTestId("settings-page-title")).toHaveText("AI");
    await expect(page.getByTestId("agents-paused")).toContainText(
      "你的 AI 已暂停：已开启“所有内容都留在这台电脑上”",
    );
    // The switch says so too, where it is.
    await expect(page.getByTestId("embedding-local-only-description")).toContainText(
      "你自己的 AI 也会暂停",
    );
    await shot(window, "agents-paused-zh-narrow");
    // Its link goes to where the switch is, on the same page.
    await page.getByTestId("agents-paused-open").click();
    await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "ai");
    await expect(window.getByTestId("local-only")).toBeFocused();
    // The agents listed first and "Other agent" (其他智能体), and nothing spills out at either width.
    const list = await agentsToConnect(page);
    await expect(list.getByTestId("agent-client")).toHaveCount(8);
    await expect(list.locator('[data-client="other"]')).toContainText("其他智能体");
    await expect(list.locator('[data-client="codex"]')).toContainText("不适用于网页版");
    const fitsPage = () =>
      page
        .getByTestId("settings-page-ai")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    expect(await fitsPage()).toBe(true);
    await setWindowSize(app, window, 1440, 900);
    expect(await fitsPage()).toBe(true);
  } finally {
    await app.close();
  }
});

// protects=a connection whose program has gone since it was made (an AppImage's mount, an app moved) says so in its own row in English and Chinese, and Repair writes its entry again so the line goes; fails_when=the row reads as working while the agent can't start IncarnaMind, or Repair leaves the old program in the agent's settings
test("a connection whose program has moved says so in its row, and Repair writes it again (#3644)", async () => {
  await mkdir(join(home, ".codex"));
  const codexSettings = join(home, ".codex", "config.toml");
  await writeFile(codexSettings, 'model = "gpt-6-luna"\n');
  const first = await launchApp(dataDir, { home });
  let command = "";
  try {
    await dismissChatSetup(first.window);
    await withCoast(first.window);
    await acceptPlainTextKeys(first.window);
    command = await first.window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const coast = (await bridge.getLibrary()).groups.find((group) => group.name === "Coast");
      await bridge.setAgentsEnabled(true);
      const { pairing } = await bridge.setUpAgent({
        client: "codex",
        folderIds: [coast?.id ?? ""],
      });
      return (await bridge.getAgentLaunch(pairing.id)).command;
    });
  } finally {
    await first.app.close();
  }
  // The program Codex was given is gone, as an AppImage's mount is once it quits.
  const gone = join(home, "gone", ".mount_x7Kq", "incarnamind");
  const written = await readFile(codexSettings, "utf8");
  await writeFile(codexSettings, written.replace(JSON.stringify(command), JSON.stringify(gone)));

  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    const page = await openSettings(window, "ai");
    const row = page.getByTestId("agent-pairing");
    const line = row.getByTestId("agent-pairing-repair");
    await expect(line).toContainText(
      "Needs repair: IncarnaMind has moved since the ChatGPT app or Codex was connected",
    );
    await setLanguage(window, "zh-CN");
    await expect(line).toContainText("需要修复：连接");
    await expect(line).toContainText(" 之后，IncarnaMind 换了位置");
    await expect(row.getByTestId("agent-pairing-repair-button")).toHaveText("修复");
    await setLanguage(window, "en");

    await row.getByTestId("agent-pairing-repair-button").click();
    await expect(line).toBeHidden();
    const repaired = await readFile(codexSettings, "utf8");
    expect(repaired).not.toContain(gone);
    expect(repaired.startsWith('model = "gpt-6-luna"')).toBe(true);
  } finally {
    await app.close();
  }
});

// protects=with two apps whose program has gone, Repair all (2) at Your AI's title writes both again in one press, and Disconnect all… asks in place (Keep them, Esc) before it takes IncarnaMind out of every app's settings, in English and Chinese and from ⌘K; fails_when=Repair all leaves one app broken, Disconnect all disconnects without asking or leaves an entry behind, or ⌘K's entry opens Settings without the question
test("two broken connections: Repair all repairs both, and Disconnect all asks in place first (#3644)", async () => {
  await mkdir(join(home, ".codex"));
  const codexSettings = join(home, ".codex", "config.toml");
  const claudeSettings = join(home, ".claude.json");
  await writeFile(codexSettings, 'model = "gpt-6-luna"\n');
  await writeFile(claudeSettings, `${JSON.stringify({ theme: "dark" })}\n`);
  const first = await launchApp(dataDir, { home });
  let command = "";
  try {
    await dismissChatSetup(first.window);
    await acceptPlainTextKeys(first.window);
    command = await first.window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setAgentsEnabled(true);
      await bridge.setUpAgent({ client: "claude-code", folderIds: ["all"], propose: true });
      const { pairing } = await bridge.setUpAgent({ client: "codex", folderIds: ["all"] });
      return (await bridge.getAgentLaunch(pairing.id)).command;
    });
  } finally {
    await first.app.close();
  }
  const gone = join(home, "gone", ".mount_x7Kq", "incarnamind");
  for (const file of [codexSettings, claudeSettings]) {
    const written = await readFile(file, "utf8");
    expect(written).toContain(JSON.stringify(command));
    await writeFile(file, written.replaceAll(JSON.stringify(command), JSON.stringify(gone)));
  }

  const { app, window } = await launchApp(dataDir, { home });
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    const page = await openSettings(window, "ai");
    const section = page.getByTestId("agents-connected");
    const repairAll = section.getByTestId("agents-repair-all");
    await expect(repairAll).toHaveText("Repair all (2)");
    await expect(section.getByTestId("agent-pairing-repair")).toHaveCount(2);
    await shot(window, "repair-all-en");
    await setLanguage(window, "zh-CN");
    await expect(repairAll).toHaveText("全部修复（2 个）");
    await shot(window, "repair-all-zh");
    await setLanguage(window, "en");

    await repairAll.click();
    await expect(section.getByTestId("agent-pairing-repair")).toHaveCount(0);
    await expect(repairAll).toBeHidden();
    for (const file of [codexSettings, claudeSettings]) {
      expect(await readFile(file, "utf8")).not.toContain(gone);
    }

    const opener = section.getByTestId("agents-disconnect-all-open");
    const ask = section.getByTestId("agents-disconnect-all-ask");
    await opener.click();
    await expect(ask).toContainText("Disconnect all 2? What they wrote in IncarnaMind stays.");
    await expect(section.getByTestId("agents-disconnect-all-keep")).toBeFocused();
    await shot(window, "disconnect-all-en");
    await setLanguage(window, "zh-CN");
    await expect(ask).toContainText("断开全部 2 个？");
    await expect(section.getByTestId("agents-disconnect-all-confirm")).toHaveText("全部断开");
    await shot(window, "disconnect-all-zh");
    await setLanguage(window, "en");
    await window.keyboard.press("Escape");
    await expect(ask).toBeHidden();
    await expect(page).toBeVisible();
    await expect(opener).toBeFocused();
    await opener.click();
    await section.getByTestId("agents-disconnect-all-keep").click();
    await expect(ask).toBeHidden();
    await expect(section.getByTestId("agent-pairing")).toHaveCount(2);

    await window.keyboard.press("Escape");
    await expect(page).toBeHidden();
    await runCommand(window, "settings.disconnectAllAgents", "Disconnect all AI apps…");
    await expect(ask).toBeVisible();
    await expect(section.getByTestId("agents-disconnect-all-keep")).toBeFocused();
    await section.getByTestId("agents-disconnect-all-confirm").click();
    await expect(section.getByTestId("agent-pairing")).toHaveCount(0);
    await expect(section.getByTestId("agents-disconnect-all")).toBeHidden();
    const codexLeft = await readFile(codexSettings, "utf8");
    expect(codexLeft).not.toContain(command);
    expect(codexLeft.startsWith('model = "gpt-6-luna"')).toBe(true);
    const claudeLeft = JSON.parse(await readFile(claudeSettings, "utf8")) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(claudeLeft)).not.toContain(command);
    expect(claudeLeft.theme).toBe("dark");
  } finally {
    await app.close();
  }
});
