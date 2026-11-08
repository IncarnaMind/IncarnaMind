import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  boxBottom,
  boxesOverlap,
  boxOf,
  boxRight,
  catchCopies,
  changeOnScreen,
  closeSettings,
  copied,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectReadyDocuments,
  frontMind,
  launchApp,
  nameMind,
  newMind,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * An outside agent proposes changes to a Note (#352): the User lets it where they connect it,
 * the agent reads the Note by name over MCP and proposes a rewrite, and the change waits in the
 * Note with the agent's name until the User accepts it, which ⌘Z takes back. The home folder is
 * a temporary one, and copying is caught in the page.
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

/** Two sentences the agent adds with no Citation. */
const NEAP = "Neap tides come at the first and third quarters of the moon.";
const RANGE = "Their range is the smallest of the month.";

/** Saves a screenshot when INCARNAMIND_SCREENSHOTS names a folder for them. */
async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** A Folder "Coast" with one Document in it; its id. */
async function withCoast(window: Page): Promise<string> {
  const tides = join(sources, "Tides.md");
  await writeFile(
    tides,
    "# Tides\n\nSpring tides happen twice a month, at new moon and full moon, when the sun and the moon pull in line.\n",
  );
  const coast = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Coast", description: "The sea." });
    await bridge.addDocuments([path], { groupId: folder.id });
    return folder.id;
  }, tides);
  await expectReadyDocuments(window, 1);
  return coast;
}

test("an agent the User lets propose changes: its change waits in the Note with its name, Accept applies it and ⌘Z takes it back", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    const coast = await withCoast(window);
    await catchCopies(window);
    await acceptPlainTextKeys(window);

    await newMind(window);
    await nameMind(window, "Field notes");
    await enterContent(window);
    await window.keyboard.type("Tides rise twice a day.");
    await window.keyboard.press("Enter");
    await window.keyboard.type("The harbour office posts the times each week.");
    const editor = frontMind(window).getByTestId("mind-editor");
    await expect(editor.locator(":scope > p")).toHaveText([
      "Tides rise twice a day.",
      "The harbour office posts the times each week.",
    ]);
    const mindId = await frontMind(window).getAttribute("data-mind-id");
    await window.evaluate(
      async (place) => {
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.moveToFolder({
          mindIds: [place.mindId],
          folderId: place.folderId,
        });
      },
      { mindId: mindId ?? "", folderId: coast },
    );

    const page = await openSettings(window, "agents");
    await page.getByTestId("agents-enabled").click();
    await page
      .getByTestId("agents-list")
      .locator('[data-client="other"]')
      .getByTestId("agent-connect")
      .click();
    const dialog = window.getByTestId("connect-agent-dialog");
    await dialog.getByTestId("connect-agent-name").fill("Research assistant agent");
    await dialog.getByTestId("agent-folder").check();
    const propose = dialog.getByTestId("agent-propose");
    await expect(propose).not.toBeChecked();
    await expect(dialog).toContainText("Let it propose changes to the notes in these Folders");
    await propose.check();
    await shot(window, "agent-proposals-connect");
    await dialog.getByTestId("connect-agent-allow").click();
    const row = page.locator('[data-testid="agent-pairing"][data-name="Research assistant agent"]');
    await expect(row.getByTestId("agent-pairing-proposes")).toHaveText(
      "Can propose changes to notes there, which wait for you",
    );
    await shot(window, "agent-proposals-row");
    const settings = JSON.parse(await copied(window)) as {
      mcpServers: { incarnamind: { command: string; args: string[]; env: Record<string, string> } };
    };
    const server = settings.mcpServers.incarnamind;
    await closeSettings(window);

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
      const read = await agent.callTool({
        name: "read_mind",
        arguments: { mindId, named: true },
      });
      const named = read.structuredContent as { markdown: string; version: string };
      expect(named.markdown).toContain("¶1 Tides rise twice a day.");
      const proposed = await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version: named.version,
          changes: [
            { paragraph: "¶1", text: "Tides rise and fall two times a day." },
            { paragraph: "¶1+", text: `${NEAP} ${RANGE}` },
          ],
        },
      });
      expect(proposed.isError ?? false).toBe(false);
    } finally {
      await agent.close();
    }

    // They wait: the Note's bar and each change's own bar name the agent, and the change's bar
    // counts the sentences it would leave with no Citation.
    await expect(window.getByTestId("proposals-count")).toHaveText("2 changes waiting");
    await expect(window.getByTestId("proposals-agents")).toHaveText(
      "Proposed by Research assistant agent",
    );
    await pointAndClick(window, editor.locator("ins.proposal-insert").first());
    const bar = window.getByTestId("change-bar");
    await expect(bar.getByTestId("change-bar-author")).toHaveText(
      "Proposed by Research assistant agent",
    );
    await expect(bar.getByTestId("change-bar-uncited")).toHaveText("1 sentence with no Citation");
    await shot(window, "agent-proposals-waiting-en");

    await pointAndClick(window, bar.getByTestId("change-accept"));
    await expect(editor.locator(":scope > p").first()).toHaveText(
      "Tides rise and fall two times a day.",
    );
    await expect(window.getByTestId("proposals-count")).toHaveText("1 change waiting");
    await expect
      .poll(() =>
        window.evaluate(async () =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listAiUse()
          ).map((entry) => [entry.kind, entry.agent]),
        ),
      )
      .toEqual([["outside-agent-change-accepted", "Research assistant agent"]]);

    await editor.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(window.getByTestId("proposals-count")).toHaveText("2 changes waiting");
    await expect(editor.locator("del.proposal-delete")).toHaveText("twice");

    // Each click on the count selects the next sentence with no Citation, then the first again.
    const added = editor.locator("p.proposal-node--insert");
    const selected = () => window.evaluate(() => document.getSelection()?.toString().trim() ?? "");
    const cycles = async (count: string) => {
      await pointAndClick(window, added);
      const uncited = bar.getByTestId("change-bar-uncited");
      await expect(uncited).toHaveText(count);
      for (const sentence of [NEAP, RANGE, NEAP]) {
        await pointAndClick(window, uncited);
        await expect.poll(selected).toBe(sentence);
      }
    };
    await cycles("2 sentences with no Citation");
    await shot(window, "agent-proposals-uncited-en");

    await setLanguage(window, "zh-CN");
    await expect(window.getByTestId("proposals-agents")).toHaveText(
      "Research assistant agent 建议",
    );
    await cycles("2 句没有引用");
    await expect(bar.getByTestId("change-bar-author")).toHaveText("Research assistant agent 建议");
    await shot(window, "agent-proposals-uncited-zh");

    // The User edits the word the rewrite replaces: out of date, it can only be rejected, since
    // IncarnaMind can't ask the agent to make it again.
    await pointAndClick(window, editor.locator("del.proposal-delete"));
    await window.keyboard.type("x");
    const stale = window.getByTestId("change-out-of-date");
    await expect(stale.getByTestId("change-reject")).toBeVisible();
    await expect(stale.getByTestId("change-regenerate")).toHaveCount(0);
    await shot(window, "agent-proposals-out-of-date-zh");
    await pointAndClick(window, stale.getByTestId("change-reject"));
    await expect(window.getByTestId("proposals-count")).toHaveText("1 处修订待处理");

    // A bar never cuts its place or its author short (#2409): a name of 24 characters shows whole
    // beside a count of the uncited sentences and Accept · Reject, and the bar takes a second
    // line, clear of its change and the line after it, at a narrow and a wide window.
    for (const width of [1440, 900]) {
      for (const language of ["en", "zh-CN"] as const) {
        await setWindowSize(app, window, width, 900);
        await setLanguage(window, language);
        await pointAndClick(window, added);
        await expect(bar).toHaveAccessibleName(
          language === "en" ? "Change 1 of 1" : "第 1 处修订，共 1 处",
        );
        const author = bar.getByTestId("change-bar-author");
        await expect(author).toHaveText(
          language === "en"
            ? "Proposed by Research assistant agent"
            : "Research assistant agent 建议",
        );
        await expect(bar.getByTestId("change-bar-uncited")).toHaveText(
          language === "en" ? "2 sentences with no Citation" : "2 句没有引用",
        );
        await expect(bar.getByTestId("change-accept")).toBeVisible();
        await expect(bar.getByTestId("change-reject")).toBeVisible();

        const fits = (part: Locator) =>
          part.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
        const where = `${width} ${language}`;
        expect
          .soft(await fits(bar.locator(".change-bar-position")), `${where}: the place`)
          .toBe(true);
        expect.soft(await fits(author), `${where}: the author`).toBe(true);
        const row = await boxOf(bar.locator(".change-bar-row"));
        const line = await boxOf(bar.locator(".change-bar-position"));
        expect
          .soft(row.height, `${where}: the bar's second line`)
          .toBeGreaterThanOrEqual(line.height * 2);

        const { change, next } = await changeOnScreen(editor, added);
        const card = await boxOf(bar);
        expect.soft(next, `${where}: a line after the change`).not.toBeNull();
        expect.soft(boxesOverlap(card, change), `${where}: over its change`).toBe(false);
        if (next) expect.soft(boxesOverlap(card, next), `${where}: over the next line`).toBe(false);
        const page = await boxOf(window.locator(".mind-tab-page:visible"));
        expect.soft(card.x, `${where}: inside the page`).toBeGreaterThanOrEqual(page.x);
        expect
          .soft(boxRight(card), `${where}: inside the page`)
          .toBeLessThanOrEqual(boxRight(page) + 1);
        expect
          .soft(boxBottom(card), `${where}: above the page's foot`)
          .toBeLessThanOrEqual(boxBottom(page) + 1);
        await shot(window, `change-bar-${language}-${width}`);
      }
    }
  } finally {
    await app.close();
  }
});
