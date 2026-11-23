import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  catchCopies,
  copied,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  slideSelect,
  urlsOpened,
  writeNote,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");
test.skip(process.platform === "win32", "The stand-in for Claude Code starts from a shell script.");

/*
 * The input at a Note's foot (#3627): with no model set up and Claude Code connected, the User
 * selects words, says what to change and presses Return; the change lands in the Note at once,
 * with nothing opened or copied; the line above the input says what the AI is doing and then
 * what it did; Stop stops it; a failure says why; a connection that may only read is let to
 * propose changes in place; and the Note's conversation opens on request. A Node script stands
 * in for `claude`, reaching IncarnaMind only through the settings it was given.
 */

let dataDir: string;
let sources: string;
let home: string;
let bin: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});
test.afterEach(async () => {
  for (const folder of [dataDir, sources, home, bin]) await removeDataFolder(folder);
});

/** What the stand-in does at its next start. */
const nextRun = (mode: "change" | "outside" | "explain" | "wait" | "signed-out") =>
  writeFile(join(bin, "mode"), mode);

async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

/** Each shot at 1440 wide in English and 900 wide in Chinese, then back to English. */
async function both(
  app: Parameters<typeof setWindowSize>[0],
  window: Page,
  name: string,
  zh: () => Promise<void>,
) {
  await shot(window, `${name}-en`);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 760);
  await zh();
  await shot(window, `${name}-zh-CN`);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
}

/** "Kestrel Bay" with its report, and Claude Code connected to it, allowed to propose changes. */
async function connected(window: Page): Promise<{ folderId: string; pairingId: string }> {
  const report = join(sources, "Annual report 2025.md");
  await writeFile(
    report,
    "# Annual report 2025\n\nIn 2025 the harbour handled 1,240 ship calls.\n",
  );
  const made = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
    await bridge.addDocuments([path], { groupId: folder.id });
    await bridge.setAgentsEnabled(true);
    const claude = await bridge.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    return { folderId: folder.id, pairingId: claude.pairing.id };
  }, report);
  await expectReadyDocuments(window, 1);
  return made;
}

async function open(window: Page, mindId: string) {
  const folderRow = sidebarFolder(window, "Kestrel Bay").getByTestId("folder-row");
  if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
    await pointAndClick(window, folderRow);
  }
  await pointAndClick(
    window,
    window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
  );
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
}

/** Selects `words` in the paragraph that holds them, with the mouse. */
const selectIn = (window: Page, words: string) =>
  slideSelect(window, frontMind(window).locator("p", { hasText: words }).first(), words);

const FIRST = "The harbour handled 1,240 ship calls in 2025.";
const SECOND = "Harbour pilots went on strike in July.";

test("a request at a Note's foot changes the selected words at once, says what it does, stops, fails with a line, lets a read-only agent propose, and keeps the conversation", async () => {
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    await setWindowSize(app, window, 1440, 900);
    const { folderId, pairingId } = await connected(window);
    const mindId = await writeNote(window, "Harbour notes", [{ text: FIRST }, { text: SECOND }], {
      folderId,
    });
    await open(window, mindId);
    const box = window.locator('[data-testid="tab-group"][data-focused] [data-testid="note-ask"]');
    const input = box.getByTestId("note-ask-input");
    const line = box.getByTestId("note-ask-line");
    const send = async (words: string) => {
      await pointAndClick(window, input);
      await window.keyboard.type(words);
      await window.keyboard.press("Enter");
    };

    // The Note has its own input, where the pill would have asked.
    await expect(input).toHaveAttribute("placeholder", "Describe a change…");
    await expect(window.getByTestId("own-ai-pill")).toHaveCount(0);
    await both(app, window, "note-ask-input", async () => {
      await expect(input).toHaveAttribute("placeholder", "描述要做的修改…");
    });

    // Words selected and a change asked: it lands at once, in them alone, nothing opened or copied.
    await selectIn(window, "ship calls in 2025.");
    await expect(box.getByTestId("note-ask-quote")).toContainText("ship calls in 2025.");
    await nextRun("change");
    await send("Put these in capitals");
    await expect(line).toHaveText("Changed 1 paragraph in this note.");
    await expect(frontMind(window)).toContainText("The harbour handled 1,240 SHIP CALLS IN 2025.");
    await expect(frontMind(window)).toContainText(SECOND);
    expect(await urlsOpened(app)).toEqual([]);
    expect(await copied(window)).toBe("");
    await both(app, window, "note-ask-done", async () => {
      await expect(line).toHaveText("在这篇笔记中修改了 1 段。");
    });

    // While it works: the line says so and Send is Stop, which stops it.
    await nextRun("wait");
    await send("Make it shorter");
    await expect(line).toHaveAttribute("data-state", "working");
    const stop = box.getByTestId("note-ask-stop");
    await expect(stop).toBeVisible();
    await both(app, window, "note-ask-working", async () => {
      await expect(stop).toHaveAttribute("aria-label", "停止");
    });
    await pointAndClick(window, stop);
    await expect(line).toHaveText("Stopped.");

    // A failure says why in one line.
    await nextRun("signed-out");
    await send("Make it shorter");
    await expect(line).toHaveText(
      "Claude Code isn’t signed in on this computer. Sign in to it in a terminal, then send it again.",
    );
    await both(app, window, "note-ask-failure", async () => {
      await expect(line).toHaveText(
        "Claude Code 尚未在这台电脑上登录。在终端中登录后，再发送一次。",
      );
    });

    // An explanation answers where the User asked, and changes nothing.
    await nextRun("explain");
    await send("What does this count?");
    await expect(line).toContainText("It counts the ship calls the harbour handled in 2025.");

    // The conversation opens on request: each request that went, and its reply.
    await pointAndClick(window, box.getByTestId("note-ask-conversation-toggle"));
    const conversation = box.getByTestId("note-ask-conversation");
    await expect(conversation.getByTestId("note-ask-turn")).toHaveCount(3);
    await expect(conversation).toContainText("Put these in capitals");
    await both(app, window, "note-ask-conversation", async () => {
      await expect(box.getByTestId("note-ask-conversation-toggle")).toHaveText("隐藏对话");
    });
    await pointAndClick(window, box.getByTestId("note-ask-conversation-toggle"));

    // A connection that may only read is let to propose changes here, and the request goes again.
    await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateAgent(id, { propose: false });
    }, pairingId);
    await selectIn(window, "in July.");
    await nextRun("change");
    await send("Put these in capitals");
    await expect(line).toContainText("Claude Code may only read. Let it propose changes?");
    await expect(box.getByTestId("note-ask-allow")).toHaveText("Allow");
    await both(app, window, "note-ask-permission", async () => {
      await expect(line).toContainText("Claude Code 只能读取。允许它提出修改吗？");
    });
    await pointAndClick(window, box.getByTestId("note-ask-allow"));
    await expect(line).toHaveText("Changed 1 paragraph in this note.");
    await expect(frontMind(window)).toContainText("Harbour pilots went on strike IN JULY.");
    const propose = await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.getAgents()).pairings.find((each) => each.id === id)?.propose;
    }, pairingId);
    expect(propose).toBe(true);

    // A change beyond the words selected waits for the User, its bar clear of the input.
    await selectIn(window, "strike");
    await nextRun("outside");
    await send("Put these in capitals");
    await expect(line).toHaveText("1 change waits for you in “Harbour notes”.");
    await pointAndClick(window, frontMind(window).locator("ins[data-proposal-id]").first());
    const bar = window.getByTestId("change-bar");
    const clearOfInput = async () => {
      await expect(bar).toBeVisible();
      const [barBox, inputBox] = [await bar.boundingBox(), await box.boundingBox()];
      expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual(inputBox?.y ?? 0);
    };
    await clearOfInput();
    await both(app, window, "note-ask-waiting", async () => {
      await expect(line).toHaveText("“Harbour notes”中有 1 处修改等你确认。");
      await clearOfInput();
    });
  } finally {
    await app.close();
  }
});
