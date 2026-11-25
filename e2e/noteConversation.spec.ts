import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, TabItem } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  cutIn,
  dismissChatSetup,
  expectReadyDocuments,
  fromConversationMenu,
  frontMind,
  launchApp,
  motionSettled,
  newMind,
  openConversationMenu,
  pointAndClick,
  removeDataFolder,
  secondWindow,
  setLanguage,
  setSidebarShown,
  setWindowSize,
  sidebarFolder,
  slideSelect,
  writeNote,
} from "./app";

/*
 * The Note's conversation in its two places (#3677): upward inside the input's box at the Note's
 * foot, and the window's column left of the tab groups (#3759), one control moving it between them with the
 * conversation, a run going on, and the input's words and focus; the check badge with the Note's
 * own controls at its top right. With the stand-in for Claude Code (no model, no key). Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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

const nextRun = (mode: string) => writeFile(join(bin, "mode"), mode);
/** Each start of the stand-in so far: "--version", "auth status", "run", "run --model haiku". */
const starts = () =>
  readFile(join(bin, "mode.starts"), "utf8").then(
    (text) => text.split("\n").filter(Boolean),
    () => [],
  );
const stepTo = (n: number) => writeFile(join(bin, "mode.step"), String(n));

async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.waitForTimeout(300);
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

const INTERVIEWS: [string, string][] = [
  [
    "Ferry interview 1 – deckhand",
    "Interview with a deckhand on the Kestrel Bay ferry crossing, 3 October 2025.\n\nThe 07:40 crossing leaves late most weeks. Loading the freight vans takes too long.",
  ],
  [
    "Ferry interview 2 – harbour master",
    "Interview with the Kestrel Bay harbour master, 6 October 2025.\n\nThe single ramp at Kestrel Bay is the bottleneck on the early crossing. A second ramp is in the harbour plan for 2027.",
  ],
  [
    "Ferry interview 3 – commuter",
    "Interview with a commuter, 8 October 2025.\n\nI have missed the 08:15 train four times since September because the 07:40 ferry was late.",
  ],
];

/** "Kestrel Bay" with three ferry interviews, and Claude Code connected to it. */
async function connected(window: Page): Promise<string> {
  const paths: string[] = [];
  for (const [name, text] of INTERVIEWS) {
    const path = join(sources, `${name}.md`);
    await writeFile(path, `# ${name}\n\n${text}\n`);
    paths.push(path);
  }
  const folderId = await window.evaluate(async (files) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
    await bridge.addDocuments(files, { groupId: folder.id });
    await bridge.setAgentsEnabled(true);
    await bridge.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    return folder.id;
  }, paths);
  await expectReadyDocuments(window, INTERVIEWS.length);
  return folderId;
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

const outcomesOf = (window: Page, mindId: string) =>
  window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.noteConversation(id)).map((turn) => turn.outcome);
  }, mindId);

async function ended(window: Page, mindId: string, before: number) {
  await expect
    .poll(
      async () => {
        const outcomes = await outcomesOf(window, mindId);
        return outcomes.length > before && outcomes.at(-1) !== "working";
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

const P1 = "The early ferry crossing from Kestrel Bay runs late most weekdays.";
const P2 = "Commuters miss the 08:15 train when it does.";
const P3 = "The harbour plan adds a second ramp in 2027.";

test("the Note's conversation opens upward in its input's box and moves to the window's column at the left and back, keeping a run and the words typed; the check badge stands with the Note's own controls", async () => {
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    const folderId = await connected(window);
    const mindId = await writeNote(
      window,
      "Harbour notes",
      [{ text: P1 }, { text: P2 }, { text: P3 }],
      {
        folderId,
      },
    );
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const box = group.getByTestId("note-ask-box");
    const input = group.getByTestId("note-ask-input");
    const handle = group.getByTestId("note-ask-handle-toggle");
    const panel = group.getByTestId("note-ask-panel");
    const column = window.getByTestId("note-column");
    const badge = group.getByTestId("check-badge-open");

    // The check badge stands with the Note's own controls, left of Show conversation and ⋯: a
    // mark and its count, its words its name; the box is the input row alone.
    await expect(group.getByTestId("note-head-badge").getByTestId("check-badge")).toBeVisible();
    await expect(group.getByTestId("check-badge").locator(".check-badge-quiet")).toHaveText("3");
    await expect(badge).toHaveAccessibleName("Checks: 3 sentences not checked yet");
    await expect(box.getByTestId("note-ask-top")).toHaveCount(0);
    const [badgeBox, toggleBox] = [
      await badge.boundingBox(),
      await group.getByTestId("note-ask-conversation-toggle").boundingBox(),
    ];
    expect((badgeBox?.x ?? 0) + (badgeBox?.width ?? 0)).toBeLessThanOrEqual(toggleBox?.x ?? 0);
    await shot(window, "conversation-badge-rest-en");
    // Its card opens downward from it.
    await pointAndClick(window, badge);
    const card = window.getByTestId("check-card");
    await expect(card).toBeVisible();
    expect((await card.boundingBox())?.y ?? 0).toBeGreaterThan(badgeBox?.y ?? 0);
    await shot(window, "conversation-badge-card-en");
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // A first request: its line, and the handle that opens the conversation upward.
    await nextRun("plan");
    let before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, input);
    await window.keyboard.type("What does the harbour plan add?");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    await expect(group.getByTestId("note-ask-pill-open")).toHaveText(
      "A second ramp at Kestrel Bay, in 2027, so the vans and the foot passengers can board at once.",
    );

    // Upward: the same box grows over the Note's foot, as tall as the conversation needs, its turns
    // no taller than 40% of the window, the reply never again in a row of its own. Its top row is the
    // conversation's name with the move to the left and the fold at its end, and the turns start
    // under it, never behind them (#3765); the conversation ends 12px above the input.
    await pointAndClick(window, handle);
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("note-column-turn")).toHaveCount(1);
    await expect(box.getByTestId("note-ask-pill")).toHaveCount(0);
    await expect(box.getByTestId("note-ask-top")).toHaveCount(0);
    expect(
      (await panel.getByTestId("note-conversation-body").boundingBox())?.height ?? 999,
    ).toBeLessThanOrEqual(900 * 0.4 + 1);
    // Its top row is its name, whose menu holds what the row's icons did (#3765).
    expect(await conversationMenu(window, panel)).toEqual([
      "New conversation",
      "Move to the left",
      "Hide conversation",
    ]);
    await expectPanelEdges(group);
    await shot(window, "conversation-upward-en");

    // Moved to the left with words half-typed and the focus in the input: the window's column, the
    // tab area's full height, holds the conversation and the one input, the words and the focus kept.
    await pointAndClick(window, input);
    await window.keyboard.type("Who asked for a sec");
    await fromConversationMenu(window, panel, "conversation-move-left");
    await expect(column).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(window.getByTestId("note-ask-input")).toHaveCount(1);
    const inColumn = column.getByTestId("note-ask-input");
    await expect(inColumn).toHaveValue("Who asked for a sec");
    await expect(inColumn).toBeFocused();
    await expect(column.getByTestId("note-column-turn")).toHaveCount(1);
    const [columnBox, groupBox] = [await column.boundingBox(), await group.boundingBox()];
    expect(Math.abs((columnBox?.y ?? 0) - (groupBox?.y ?? 99))).toBeLessThanOrEqual(1);
    expect(await conversationMenu(window, column)).toEqual([
      "New conversation",
      "Move back under the note",
      "Hide conversation",
    ]);
    await pointAndClick(window, inColumn);
    await shot(window, "conversation-column-en");

    // And back: upward and open again, the words and the focus kept.
    await fromConversationMenu(window, column, "conversation-move-down");
    await expect(panel).toBeVisible();
    await expect(column).toHaveCount(0);
    await expect(input).toHaveValue("Who asked for a sec");
    await expect(input).toBeFocused();
    await input.fill("");

    // With a run going: it moves with it, and Stop stays in the one input.
    await stepTo(0);
    await nextRun("long");
    before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, input);
    await window.keyboard.type("Summarise the ferry interviews");
    await window.keyboard.press("Enter");
    await expect(group.getByTestId("note-ask-stop")).toBeVisible();
    await stepTo(3);
    await expect(panel.getByTestId("note-column-live")).toContainText("Ferry interview", {
      timeout: 20_000,
    });
    await shot(window, "conversation-running-upward-en");
    await fromConversationMenu(window, panel, "conversation-move-left");
    await expect(column.getByTestId("note-column-live")).toContainText("Ferry interview");
    await expect(column.getByTestId("note-ask-stop")).toBeVisible();
    await shot(window, "conversation-running-column-en");
    await stepTo(99);
    await ended(window, mindId, before);
    await expect(column.getByTestId("note-column-turn")).toHaveCount(2);
    await expect(column.getByTestId("note-column-reply").last()).toContainText(
      "The five interviews agree on one thing",
    );

    // In Chinese, the controls say so in Chinese; in a window too narrow for the column the
    // conversation opens upward in the box, with no move to a column that can't stand there.
    await setLanguage(window, "zh-CN");
    expect(await conversationMenu(window, column)).toEqual(["新对话", "移回笔记下方", "隐藏对话"]);
    await shot(window, "conversation-column-zh-CN");
    await setWindowSize(app, window, 900, 760);
    await expect(panel).toBeVisible();
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    expect(await conversationMenu(window, panel)).toEqual(["新对话", "隐藏对话"]);
    await expectPanelEdges(group);
    await shot(window, "conversation-narrow-zh-CN");
    await setWindowSize(app, window, 1440, 900);
    await fromConversationMenu(window, column, "conversation-move-down");
    expect(await conversationMenu(window, panel)).toEqual(["新对话", "移到左侧", "隐藏对话"]);
    await expectPanelEdges(group);
    await expect(badge).toHaveAccessibleName("核对结果：3 句未核对");
    await shot(window, "conversation-upward-zh-CN");

    // Esc folds it to the line; with no request running it doesn't stop anything.
    await pointAndClick(window, input);
    await window.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(group.getByTestId("note-ask-pill")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("the model in the box comes with the first request's run, and the one chosen is the one the next request runs on", async () => {
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    const folderId = await connected(window);
    const mindId = await writeNote(window, "Harbour notes", [{ text: P1 }, { text: P3 }], {
      folderId,
    });
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const model = group.getByTestId("note-ask-model");
    await expect(input).toBeVisible();
    // Nothing of Claude Code is started to list its models: before a request, none started at all.
    await window.waitForTimeout(2000);
    expect(await starts()).toEqual([]);
    await expect(model).toHaveCount(0);

    await nextRun("plan");
    let before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, input);
    await window.keyboard.type("What does the harbour plan add?");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    // The request's own run brought the list: its default first, as Claude Code names it. What
    // started is the request's checks and its one run, nothing else.
    await expect(model).toHaveText("Sonnet 5.5");
    expect(await starts()).toEqual(["--version", "auth status", "run"]);
    await pointAndClick(window, model);
    const menu = window.getByTestId("note-ask-models");
    await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
    await pointAndClick(window, menu.getByRole("menuitemradio").filter({ hasText: "Haiku" }));
    await expect(model).toHaveText("Haiku 5.5");

    before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, input);
    await window.keyboard.type("And when?");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    expect((await starts()).slice(3)).toEqual(["--version", "auth status", "run --model haiku"]);
    // Claude Code named the model it answered on: the one chosen.
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    const reply = group.getByTestId("note-column-reply").last();
    await expect(reply.locator(".note-column-reply-meta")).toHaveText("Haiku 5.5");
    // Copy is reached from the keyboard alone, shown once it has the focus, and puts the reply's
    // words on the clipboard.
    await pointAndClick(window, input);
    await window.mouse.move(0, 0);
    const copy = reply.getByTestId("note-column-copy");
    for (
      let n = 0;
      n < 12 && !(await copy.evaluate((button) => button === document.activeElement));
      n++
    )
      await window.keyboard.press("Shift+Tab");
    await expect(copy).toBeFocused();
    await expect
      .poll(() =>
        reply.locator(".note-column-reply-meta").evaluate((meta) => getComputedStyle(meta).opacity),
      )
      .toBe("1");
    await window.keyboard.press("Enter");
    const [last] = (
      await window.evaluate(
        (id) =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.noteConversation(id),
        mindId,
      )
    ).slice(-1);
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe((last?.reply ?? "").replace(/\s?\[cite:[a-z0-9]{1,32}\]/g, ""));
  } finally {
    await app.close();
  }
});

test("a Chinese IME composition open as the conversation moves ends in its new place, its letters never left behind", async () => {
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "zh-CN");
    const folderId = await connected(window);
    const mindId = await writeNote(window, "港口笔记", [{ text: P3 }], { folderId });
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = window.getByTestId("note-ask-input");
    await nextRun("plan");
    const before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, input);
    await window.keyboard.type("规划加了什么？");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    // The conversation's place set to the column, then hidden: Show conversation moves the input
    // between the Note's foot and the column, keeping the keyboard in it.
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    await fromConversationMenu(
      window,
      group.getByTestId("note-ask-panel"),
      "conversation-move-left",
    );
    const show = group.getByTestId("note-ask-conversation-toggle");
    await pointAndClick(window, show);
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    await pointAndClick(window, input);
    await window.keyboard.type("坡道");
    // The IME as Chromium hears it: letters composing, then the characters they end as.
    const ime = await window.context().newCDPSession(window);
    await ime.send("Input.imeSetComposition", { text: "gang", selectionStart: 4, selectionEnd: 4 });
    await expect(input).toHaveValue("坡道gang");
    await pointAndClick(window, show);
    await expect(window.getByTestId("note-column")).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("坡道");
    await ime.send("Input.insertText", { text: "港" });
    await expect(input).toHaveValue("坡道港");
    // In the middle of the words: after the move the caret is where the composition began.
    await window.keyboard.press("ArrowLeft");
    await ime.send("Input.imeSetComposition", { text: "kou", selectionStart: 3, selectionEnd: 3 });
    await expect(input).toHaveValue("坡道kou港");
    await pointAndClick(window, show);
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("坡道港");
    expect(await input.evaluate((area: HTMLTextAreaElement) => area.selectionStart)).toBe(2);
    await ime.send("Input.insertText", { text: "口" });
    await expect(input).toHaveValue("坡道口港");
  } finally {
    await app.close();
  }
});

const launched = () =>
  launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });

/** The app open on a Note in the interviews' Folder, the stand-in Claude Code connected. */
async function harbourNote(window: Page): Promise<string> {
  await acceptPlainTextKeys(window);
  await dismissChatSetup(window);
  const folderId = await connected(window);
  const mindId = await writeNote(window, "Harbour notes", [{ text: P1 }, { text: P2 }], {
    folderId,
  });
  await open(window, mindId);
  return mindId;
}

test("while a run goes with the conversation open upward, its line shows once, in the conversation", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const panel = group.getByTestId("note-ask-panel");
    await stepTo(0);
    await nextRun("long");
    const before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type("Summarise the ferry interviews");
    await window.keyboard.press("Enter");
    await stepTo(3);
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    await expect(panel.getByTestId("note-column-live")).toContainText("Ferry interview", {
      timeout: 20_000,
    });
    // The box has no top row then: the line is the conversation's.
    await expect(group.getByTestId("note-ask-top")).toHaveCount(0);
    await expect(group.getByTestId("note-ask-pill")).toHaveCount(0);
    await stepTo(99);
    await ended(window, mindId, before);
  } finally {
    await app.close();
  }
});

test("a run stopped after it read says what it read, and after a restart only that it stopped, which is all that is kept, in English and Chinese", async () => {
  let { app, window } = await launched();
  let mindId = "";
  try {
    await setWindowSize(app, window, 1440, 900);
    mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const panel = group.getByTestId("note-ask-panel");
    await stepTo(0);
    await nextRun("long");
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type("Summarise the ferry interviews");
    await window.keyboard.press("Enter");
    await stepTo(4);
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    await expect(panel.getByTestId("note-column-live")).toContainText("Ferry interview", {
      timeout: 20_000,
    });
    await pointAndClick(window, group.getByTestId("note-ask-stop"));
    await expect(panel.getByTestId("note-column-interrupted")).toHaveText(
      "Stopped. It had read “Harbour notes” and 2 Documents.",
    );
  } finally {
    await app.close();
  }
  ({ app, window } = await launched());
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    const stopped = group.getByTestId("note-ask-panel").getByTestId("note-column-interrupted");
    await expect(stopped).toHaveText("Stopped.");
    await setLanguage(window, "zh-CN");
    await expect(stopped).toHaveText("已停止。");
  } finally {
    await app.close();
  }
});

test("a request that can't start says why where the User typed, whole, with the conversation folded, open upward or in the column, at both widths and in English and Chinese; one that may only read is let to propose from the open conversation", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = window.getByTestId("note-ask-input");
    const problem = window.getByTestId("note-ask-problem");
    const column = window.getByTestId("note-column");
    const send = async (words: string) => {
      await pointAndClick(window, input);
      await window.keyboard.type(words);
      await window.keyboard.press("Enter");
    };
    await nextRun("plan");
    let before = (await outcomesOf(window, mindId)).length;
    await send("What does the harbour plan add?");
    await ended(window, mindId, before);

    const tooOld =
      "Claude Code 2.0.1 is older than IncarnaMind needs (2.1.248 or later). Update it, then send it again.";
    /** The one line, in the input's box, every word of it shown. */
    const shownWhole = async (text: string) => {
      await expect(problem).toHaveCount(1);
      await expect(problem).toHaveText(text);
      await expect(
        window.getByTestId("note-ask-box").getByTestId("note-ask-problem"),
      ).toBeVisible();
      expect(await cutIn(problem)).toEqual([]);
    };
    // Open upward, the request goes nowhere: the line says why, in the box's top row.
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    await expect(group.getByTestId("note-ask-panel")).toBeVisible();
    await nextRun("too-old");
    await send("Make it shorter");
    await shownWhole(tooOld);
    // The words it didn't send stay in the input, to send again.
    await expect(input).toHaveValue("Make it shorter");
    await shot(window, "conversation-problem-upward-en");
    // In the window's column, at its foot; in the narrow window, where the column isn't drawn,
    // above the input of the conversation open upward again, in Chinese.
    await fromConversationMenu(window, group, "conversation-move-left");
    await expect(column).toBeVisible();
    await shownWhole(tooOld);
    await shot(window, "conversation-problem-column-en");
    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 760);
    await expect(group.getByTestId("note-ask-panel")).toBeVisible();
    await expect(column).toHaveCount(0);
    await shownWhole("Claude Code 2.0.1 版本过旧，需要 2.1.248 或更高版本。更新后再发送一次。");
    await shot(window, "conversation-problem-upward-zh-CN");
    // Folded, at both widths: it wraps, never cut.
    await setLanguage(window, "en");
    await fromConversationMenu(window, group, "note-ask-fold");
    await expect(group.getByTestId("note-ask-panel")).toHaveCount(0);
    await shownWhole(tooOld);
    await shot(window, "conversation-problem-folded-en");
    await setWindowSize(app, window, 1440, 900);
    await shownWhole(tooOld);

    // A connection that may only read, asked here while a second window has the conversation
    // open: Allow is in that window's turn, and sends the request again as it was typed, though
    // that window didn't send it.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [pairing] = (await bridge.getAgents()).pairings;
      if (pairing) await bridge.updateAgent(pairing.id, { propose: false });
    });
    const second = await secondWindow(app);
    await setWindowSize(app, second, 1440, 900);
    await open(second, mindId);
    await pointAndClick(
      second,
      second
        .locator('[data-testid="tab-group"][data-focused]')
        .getByTestId("note-ask-conversation-toggle"),
    );
    const secondColumn = second.getByTestId("note-column");
    await expect(secondColumn).toBeVisible();
    await nextRun("change");
    before = (await outcomesOf(window, mindId)).length;
    await input.fill("");
    await send("Put it in capitals");
    await ended(window, mindId, before);
    const last = secondColumn.getByTestId("note-column-turn").last();
    await expect(last.getByTestId("note-ask-problem")).toContainText(
      "Claude Code may only read. Let it propose changes?",
    );
    await expect(last.getByTestId("note-ask-allow")).toHaveText("Allow");
    before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(second, last.getByTestId("note-ask-allow"));
    await ended(window, mindId, before);
    await expect(secondColumn.getByTestId("note-column-turn").last()).toContainText(
      "Put it in capitals",
    );
    await expect(secondColumn.getByTestId("note-column-turn").last()).toContainText(
      "Put the selected words in capitals.",
    );
    await expect(frontMind(second)).toContainText(P2.toUpperCase());
    await second.close();
  } finally {
    await app.close();
  }
});

test("a sent quote leaves the input, a request that can't start keeps the words typed, and a line that says why is whole, names no terminal and has its action, in English and Chinese", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 900, 760);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const quote = group.getByTestId("note-ask-quote");
    const problem = group.getByTestId("note-ask-problem");
    const send = async (words: string) => {
      await pointAndClick(window, input);
      await window.keyboard.type(words);
      await window.keyboard.press("Enter");
    };
    // The last word of the first paragraph, selected with the mouse.
    const selectLastWord = () =>
      slideSelect(window, frontMind(window).locator("p").first(), "weekdays.");

    // The quote goes with the words; the same words selected anew bring it back.
    await selectLastWord();
    await expect(quote).toContainText("weekdays.");
    await nextRun("plan");
    let before = (await outcomesOf(window, mindId)).length;
    await send("What does this mean?");
    await expect(input).toHaveValue("");
    await expect(quote).toHaveCount(0);
    await ended(window, mindId, before);
    await expect(quote).toHaveCount(0);
    await selectLastWord();
    await expect(quote).toContainText("weekdays.");

    // Signed out: nothing is sent, the words stay, and the line has Sign in, in both languages.
    await nextRun("signed-out");
    await send("Make it shorter");
    const signIn = group.getByTestId("note-ask-sign-in");
    await expect(problem).toContainText("Claude Code isn’t signed in on this computer.");
    await expect(problem).not.toContainText("terminal");
    await expect(signIn).toHaveText("Sign in");
    await expect(input).toHaveValue("Make it shorter");
    await expect(quote).toContainText("weekdays.");
    expect(await cutIn(problem)).toEqual([]);
    await shot(window, "problem-signed-out-900-en");
    await setLanguage(window, "zh-CN");
    await expect(problem).toContainText("Claude Code 尚未在这台电脑上登录。");
    await expect(problem).not.toContainText("终端");
    await expect(signIn).toHaveText("登录");
    expect(await cutIn(problem)).toEqual([]);
    await shot(window, "problem-signed-out-900-zh-CN");
    await setLanguage(window, "en");

    // A run that stops part way says so in one line, and Try again sends it again.
    await input.fill("");
    await nextRun("limit");
    before = (await outcomesOf(window, mindId)).length;
    await send("Summarise the note");
    await ended(window, mindId, before);
    await expect(problem).toContainText(
      "Claude Code stopped: your Claude plan or API key has reached its limit.",
    );
    await expect(group.getByTestId("note-ask-try-again")).toHaveText("Try again");
    expect(await cutIn(problem)).toEqual([]);
    await nextRun("plan");
    before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-try-again"));
    await ended(window, mindId, before);
    await expect(problem).toHaveCount(0);
    const turns = await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.noteConversation(id)).map((turn) => turn.request);
    }, mindId);
    expect(turns.at(-1)).toBe("Summarise the note");
  } finally {
    await app.close();
  }
});

test("a sent request shows when it was sent, Send again, Edit and Copy while it is pointed at: Copy takes its words, Edit gives them back to the input to change, Send again asks them anew and starts under the top row, in English and Chinese", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 900, 760);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const panel = group.getByTestId("note-ask-panel");
    const asked = "What does the harbour plan add?";
    let before = (await outcomesOf(window, mindId)).length;
    await nextRun("plan");
    await pointAndClick(window, input);
    await window.keyboard.type(asked);
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    // The newest request: the one in view under the top row.
    const sent = panel.locator(".note-column-sent").last();
    const actions = sent.getByTestId("note-column-sent-actions");
    const pointAt = async () => {
      const box = await sent.locator(".note-column-bubble").boundingBox();
      if (!box) throw new Error("The request isn't shown.");
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    };

    // Unseen until pointed at; then when it was sent, and three actions, each named.
    await window.mouse.move(4, 4);
    await expect(actions).toHaveCSS("opacity", "0");
    await pointAt();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(actions.locator(".note-column-sent-time")).toHaveText(/^\d{1,2}:\d{2}/);
    await expect(actions.getByTestId("note-column-send-again")).toHaveAttribute(
      "aria-label",
      "Send again",
    );
    await expect(actions.getByTestId("note-column-edit")).toHaveAttribute("aria-label", "Edit");
    await expect(actions.getByTestId("note-column-copy-request")).toHaveAttribute(
      "aria-label",
      "Copy",
    );

    // Copy takes the words as they were sent.
    await pointAndClick(window, actions.getByTestId("note-column-copy-request"));
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(asked);

    // Edit gives them back to the input, the keyboard at their end, to change and send anew.
    await pointAndClick(window, actions.getByTestId("note-column-edit"));
    await expect(input).toHaveValue(asked);
    await expect(input).toBeFocused();
    await window.keyboard.type(" And when?");
    await expect(input).toHaveValue(`${asked} And when?`);
    await input.fill("");

    // Send again asks the same words as a new request.
    before = (await outcomesOf(window, mindId)).length;
    await nextRun("plan");
    await pointAt();
    await pointAndClick(window, actions.getByTestId("note-column-send-again"));
    await ended(window, mindId, before);
    await expect(panel.locator(".note-column-bubble")).toHaveText([asked, asked]);
    // The turns overflow the box: the new request starts 8px under the top row, the one before
    // scrolled away above it, rather than its tail left between them.
    const placed = await panel.evaluate((element) => {
      const head = element.querySelector('[data-testid="note-ask-panel-head"]');
      const turns = Array.from(element.querySelectorAll('[data-testid="note-column-turn"]'));
      const [older, newest] = [turns.at(-2), turns.at(-1)];
      if (!head || !older || !newest) return null;
      const under = head.getBoundingClientRect().bottom;
      return {
        newest: newest.getBoundingClientRect().top - under,
        older: older.getBoundingClientRect().bottom - under,
      };
    });
    expect(Math.abs((placed?.newest ?? 0) - 8)).toBeLessThanOrEqual(1);
    expect(placed?.older ?? 1).toBeLessThanOrEqual(0);

    await setLanguage(window, "zh-CN");
    await pointAt();
    await expect(actions.getByTestId("note-column-send-again")).toHaveAttribute(
      "aria-label",
      "再次发送",
    );
    await expect(actions.getByTestId("note-column-edit")).toHaveAttribute("aria-label", "编辑");
    await expect(actions.getByTestId("note-column-copy-request")).toHaveAttribute(
      "aria-label",
      "拷贝",
    );
  } finally {
    await app.close();
  }
});

/** The requests the conversation shows, in order, by their words. */
const requestsIn = (scope: Locator) => scope.locator(".note-column-bubble");

test("while a run goes the input's round button is Stop with nothing typed and Send with words; a request sent then goes into the run, shows at once as sent with Waiting and Copy only, and once its AI takes it at its next step it is a sent request with the reply its own, in English and Chinese", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const stop = group.getByTestId("note-ask-stop");
    const send = group.getByTestId("note-ask-send");
    const panel = group.getByTestId("note-ask-panel");
    const first = "Summarise the note";
    const later = "Also list the dates";
    await stepTo(0);
    await nextRun("queue-step");
    await pointAndClick(window, input);
    await window.keyboard.type(first);
    await window.keyboard.press("Enter");

    // The input works while it runs: Stop while it is empty, Send once words are typed.
    await expect(stop).toBeVisible();
    await expect(send).toHaveCount(0);
    await window.keyboard.type(later);
    await expect(send).toBeEnabled();
    await expect(stop).toHaveCount(0);
    await setLanguage(window, "zh-CN");
    await expect(send).toHaveAttribute("aria-label", "发送");
    await setLanguage(window, "en");
    await input.fill("");
    await expect(stop).toBeVisible();
    await expect(send).toHaveCount(0);

    // Return sends it into the run at once: the conversation opens on it, sent and waiting.
    await window.keyboard.type(later);
    await window.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await expect(stop).toBeVisible();
    await expect(requestsIn(panel)).toHaveText([first, later]);
    const sent = panel.getByTestId("note-column-turn").last();
    const waiting = sent.getByTestId("note-column-waiting");
    await expect(waiting).toHaveText("Waiting");
    await expect(waiting.locator(".note-ask-dots")).toBeVisible();
    expect(await outcomesOf(window, mindId)).toEqual(["working", "waiting"]);
    // Copy is all it offers: its AI has it already.
    await expect(sent.getByTestId("note-column-edit")).toHaveCount(0);
    await expect(sent.getByTestId("note-column-send-again")).toHaveCount(0);
    await pointAndClick(window, sent.getByTestId("note-column-copy-request"));
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(later);
    await setLanguage(window, "zh-CN");
    await expect(waiting).toHaveText("等待中");
    await setLanguage(window, "en");
    await shot(window, "conversation-waiting-en");

    // Taken at the AI's next step: an ordinary sent request, working; the one before ends with
    // its steps and no reply of its own.
    await stepTo(1);
    await expect(waiting).toHaveCount(0);
    await expect(sent.getByTestId("note-column-sent-actions")).toBeAttached();
    const earlier = panel.getByTestId("note-column-turn").first();
    await expect(earlier.getByTestId("note-column-steps-toggle")).toBeVisible();
    await expect(earlier.getByTestId("note-column-reply")).toHaveCount(0);
    await stepTo(2);
    await expect
      .poll(() => outcomesOf(window, mindId), { timeout: 30_000 })
      .toEqual(["landed", "landed"]);
    await expect(sent.getByTestId("note-column-reply")).toContainText(`Answered: ${later}`);
    await expect(earlier.getByTestId("note-column-reply")).toHaveCount(0);
    await expect(stop).toHaveCount(0);
    await expect(send).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a request sent while the AI writes a plain reply waits through it, the reply staying the one before's, then is answered as the next turn under its own request, in Chinese", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNote(window);
    await setLanguage(window, "zh-CN");
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const panel = group.getByTestId("note-ask-panel");
    const first = "港口计划增加了什么？";
    const later = "什么时候建？";
    await stepTo(0);
    await nextRun("queue-turn");
    await pointAndClick(window, input);
    await window.keyboard.type(first);
    await window.keyboard.press("Enter");
    await expect(group.getByTestId("note-ask-stop")).toBeVisible();
    await window.keyboard.type(later);
    await window.keyboard.press("Enter");
    const [earlier, sent] = [
      panel.getByTestId("note-column-turn").first(),
      panel.getByTestId("note-column-turn").last(),
    ];
    await expect(requestsIn(panel)).toHaveText([first, later]);
    await expect(sent.getByTestId("note-column-waiting")).toHaveText("等待中");

    // The reply ends first, and is the earlier request's; the later one still waits, and Stop
    // still stops the run.
    await stepTo(1);
    await expect(earlier.getByTestId("note-column-reply")).toContainText(`已回答：${first}`);
    await expect(sent.getByTestId("note-column-waiting")).toHaveText("等待中");
    await expect(group.getByTestId("note-ask-stop")).toBeVisible();
    expect(await outcomesOf(window, mindId)).toEqual(["landed", "waiting"]);

    // Then the AI takes it as the next turn of the same run, and its reply is its own.
    await stepTo(2);
    await expect(sent.getByTestId("note-column-waiting")).toHaveCount(0);
    await expect(sent.getByTestId("note-column-live")).toContainText("正在写回答。");
    await stepTo(3);
    await expect
      .poll(() => outcomesOf(window, mindId), { timeout: 30_000 })
      .toEqual(["landed", "landed"]);
    await expect(sent.getByTestId("note-column-reply")).toContainText(`已回答：${later}`);
    await expect(earlier.getByTestId("note-column-reply")).not.toContainText(later);
    expect((await starts()).filter((each) => each.startsWith("run"))).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("Stop with a request its AI hasn't taken stops the whole run and leaves that request Not sent, with Send, Edit, Copy and Discard; Esc stops too, in English and Chinese", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const panel = group.getByTestId("note-ask-panel");
    const send = async (words: string) => {
      await pointAndClick(window, input);
      await window.keyboard.type(words);
      await window.keyboard.press("Enter");
    };
    const later = "And add a title";
    await nextRun("wait");
    await send("Make it shorter");
    await expect(group.getByTestId("note-ask-pill-text")).toHaveText("Looking at your note");
    await send(later);
    const unsent = panel.getByTestId("note-column-turn").last();
    await expect(unsent.getByTestId("note-column-waiting")).toBeVisible();
    await pointAndClick(window, group.getByTestId("note-ask-stop"));
    await expect.poll(() => outcomesOf(window, mindId)).toEqual(["stopped", "unsent"]);

    const notSent = unsent.getByTestId("note-column-not-sent");
    await expect(notSent.locator(".note-column-sent-word")).toHaveText("Not sent");
    await expect(panel.getByTestId("note-column-turn").first()).toContainText("Stopped");
    const labels = () =>
      Promise.all(
        ["send", "edit", "copy-request", "discard"].map((id) =>
          notSent.getByTestId(`note-column-${id}`).getAttribute("aria-label"),
        ),
      );
    expect(await labels()).toEqual(["Send", "Edit", "Copy", "Discard"]);
    await shot(window, "conversation-not-sent-en");
    await setLanguage(window, "zh-CN");
    await expect(notSent.locator(".note-column-sent-word")).toHaveText("未发送");
    await expect.poll(labels).toEqual(["发送", "编辑", "拷贝", "舍弃"]);
    await setLanguage(window, "en");

    // Copy takes its words; Edit gives them back to the input.
    await pointAndClick(window, notSent.getByTestId("note-column-copy-request"));
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(later);
    await pointAndClick(window, notSent.getByTestId("note-column-edit"));
    await expect(input).toHaveValue(later);
    await expect(input).toBeFocused();
    await input.fill("");

    // Send asks it as a new request, in its place.
    await nextRun("plan");
    await pointAndClick(window, notSent.getByTestId("note-column-send"));
    await expect
      .poll(() => outcomesOf(window, mindId), { timeout: 30_000 })
      .toEqual(["stopped", "landed"]);
    await expect(requestsIn(panel)).toHaveText(["Make it shorter", later]);
    await expect(panel.getByTestId("note-column-reply").last()).toContainText(
      "A second ramp at Kestrel Bay",
    );
    await expect(panel.getByTestId("note-column-not-sent")).toHaveCount(0);

    // Esc stops a run with a request waiting in it as Stop does; Discard removes that request.
    await nextRun("wait");
    await send("Once more");
    await expect(group.getByTestId("note-ask-stop")).toBeVisible();
    await window.keyboard.type("Never mind");
    await window.keyboard.press("Enter");
    await expect(panel.getByTestId("note-column-waiting")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect
      .poll(() => outcomesOf(window, mindId))
      .toEqual(["stopped", "landed", "stopped", "unsent"]);
    await pointAndClick(window, panel.getByTestId("note-column-discard"));
    await expect(requestsIn(panel)).toHaveText(["Make it shorter", later, "Once more"]);
    expect(await outcomesOf(window, mindId)).toEqual(["stopped", "landed", "stopped"]);
  } finally {
    await app.close();
  }
});

test("New conversation, from the conversation's name: one line marks it at the top, the turns above stay, the AI begins anew with none of the turns above it, greyed while a request runs, kept after a restart, in English and Chinese", async () => {
  let { app, window } = await launched();
  let mindId = "";
  const sessions = () =>
    readFile(join(bin, "mode.sessions"), "utf8").then((text) => text.trim().split("\n"));
  try {
    await setWindowSize(app, window, 900, 760);
    mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const panel = group.getByTestId("note-ask-panel");
    const send = async (words: string, mode: string) => {
      const before = (await outcomesOf(window, mindId)).length;
      await nextRun(mode);
      await pointAndClick(window, input);
      await window.keyboard.type(words);
      await window.keyboard.press("Enter");
      await ended(window, mindId, before);
    };
    await send("What does the harbour plan add?", "plan");
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    await expect(panel).toBeVisible();

    // Greyed while a request runs, as Send again is.
    await stepTo(0);
    await nextRun("long");
    const before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, input);
    await window.keyboard.type("Summarise the ferry interviews");
    await window.keyboard.press("Enter");
    await stepTo(3);
    await expect(panel.getByTestId("note-column-live")).toBeVisible({ timeout: 20_000 });
    await openConversationMenu(window, panel);
    await expect(panel.getByTestId("conversation-new")).toBeDisabled();
    await window.keyboard.press("Escape");
    await stepTo(99);
    await ended(window, mindId, before);

    // Pressed: one line under the top row, the keyboard in the input; pressed again, still one.
    await fromConversationMenu(window, panel, "conversation-new");
    const line = panel.getByTestId("note-conversation-new");
    await expect(line).toHaveText("New conversation");
    await expect(input).toBeFocused();
    await expect
      .poll(async () => {
        const [head, at] = [
          await panel.getByTestId("note-ask-panel-head").boundingBox(),
          await line.boundingBox(),
        ];
        return Math.round((at?.y ?? 0) - ((head?.y ?? 0) + (head?.height ?? 0)));
      })
      .toBe(8);
    await fromConversationMenu(window, panel, "conversation-new");
    await expect(line).toHaveCount(1);

    // The next request begins a new conversation with the AI: it resumes none of the earlier one.
    await send("And when does it open?", "plan");
    const [first, ...rest] = await sessions();
    expect(first).toMatch(/^new /);
    expect(rest.slice(0, -1).every((each) => each === `resume ${first?.slice(4)}`)).toBe(true);
    expect(rest.at(-1)).toMatch(/^new /);
    expect(rest.at(-1)).not.toBe(first);
    await expect(panel.locator(".note-column-bubble")).toHaveText([
      "What does the harbour plan add?",
      "Summarise the ferry interviews",
      "And when does it open?",
    ]);
  } finally {
    await app.close();
  }

  // After a restart the turns above the line and the line are still there.
  ({ app, window } = await launched());
  try {
    await setWindowSize(app, window, 900, 760);
    await dismissChatSetup(window);
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    const panel = group.getByTestId("note-ask-panel");
    await expect(panel.locator(".note-column-bubble")).toHaveCount(3);
    await expect(panel.getByTestId("note-conversation-new")).toHaveCount(1);
    await setLanguage(window, "zh-CN");
    await expect(panel.getByTestId("note-conversation-new")).toHaveText("新对话");
  } finally {
    await app.close();
  }
});

test("the mode by the input names the User's own setting for the AI, offers Asks first and On its own with a sentence each, starts the next request in the one chosen, switches a running request at its next step, says why the AI refused, and goes back to the User's setting, in English and Chinese", async () => {
  const { app, window } = await launched();
  const modes = () =>
    readFile(join(bin, "mode.modes"), "utf8").then((text) => text.trim().split("\n"));
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const pill = group.getByTestId("note-ask-mode-choice");
    const menu = group.getByTestId("note-ask-modes");
    const send = async (words: string, mode: string, wait = true) => {
      const before = (await outcomesOf(window, mindId)).length;
      await nextRun(mode);
      await pointAndClick(window, input);
      await window.keyboard.type(words);
      await window.keyboard.press("Enter");
      if (wait) await ended(window, mindId, before);
    };
    const choose = async (item: string) => {
      await pointAndClick(window, pill);
      await pointAndClick(window, menu.getByTestId(item));
    };

    // Nothing until a request has named the AI's mode; then the User's own, by the model.
    await expect(pill).toHaveCount(0);
    await send("What does the harbour plan add?", "plan");
    await expect(pill).toHaveText("Asks first");
    await pointAndClick(window, pill);
    await expect(menu.locator("p").first()).toHaveText("Before Claude Code acts");
    await expect(menu.getByRole("menuitemradio")).toHaveText([
      "Asks firstAsks you first, except to read.",
      "On its ownActs without asking; a safety check blocks what looks risky.",
    ]);
    await expect(menu.getByTestId("note-ask-mode-default")).toHaveAttribute("aria-checked", "true");
    await window.keyboard.press("Escape");

    // Chosen, the next request starts in it, and the User's setting is offered back.
    await choose("note-ask-mode-auto");
    await expect(pill).toHaveText("On its own");
    await send("When does it open?", "plan");
    expect((await modes()).at(-1)).toBe("start auto");

    // The User's own setting is a third mode: back to it, the pill names it as itself.
    await writeFile(join(bin, "mode.permission"), "acceptEdits");
    await choose("note-ask-mode-yours");
    await send("And the fares?", "plan");
    expect((await modes()).at(-1)).toBe("start acceptEdits");
    await expect(pill).toHaveText("Edits on its own");
    await pointAndClick(window, pill);
    await expect(menu.getByTestId("note-ask-mode-yours")).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByTestId("note-ask-mode-yours")).toContainText(
      "Edits on its own · Your setting",
    );
    await window.keyboard.press("Escape");

    // While a request runs: the AI takes the mode chosen at once; one it refuses says why.
    await stepTo(0);
    const before = (await outcomesOf(window, mindId)).length;
    await send("Summarise the ferry interviews", "long", false);
    await stepTo(3);
    await expect(group.getByTestId("note-ask-stop")).toBeVisible();
    await expect(pill).toHaveText("Edits on its own");
    await choose("note-ask-mode-default");
    await expect(pill).toHaveText("Asks first");
    expect((await modes()).at(-1)).toBe("set default");
    await writeFile(join(bin, "mode.noauto"), "1");
    await choose("note-ask-mode-auto");
    expect((await modes()).at(-1)).toBe("set auto");
    await expect(pill).toHaveText("Asks first");
    await pointAndClick(window, pill);
    await expect(menu.getByTestId("note-ask-mode-auto")).toContainText(
      "Turned off in your Claude Code settings.",
    );
    await window.keyboard.press("Escape");
    await stepTo(99);
    await ended(window, mindId, before);
    // What the pill shows is what the next request starts in.
    await expect(pill).toHaveText("Asks first");
    await send("And the timetable?", "plan");
    expect((await modes()).at(-1)).toBe("start default");

    await setLanguage(window, "zh-CN");
    await expect(pill).toHaveText("先询问");
    await pointAndClick(window, pill);
    await expect(menu.locator("p").first()).toHaveText("Claude Code 行动前");
    await expect(menu.getByTestId("note-ask-mode-auto")).toContainText(
      "你的 Claude Code 设置里关闭了此项。",
    );
    await window.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

test("what a reply made shows under its words, a card each with its kind's icon in a soft tile, its name, its kind and Open, and a press opens it, in English and Chinese", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNote(window);
    // In the Folder the connection may read and propose in, beside the Harbour notes.
    const folderId = await window.evaluate(
      async (id) =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).find(
          (mind) => mind.id === id,
        )?.folderId ?? null,
      mindId,
    );
    const timetable = await writeNote(
      window,
      "Ferry timetable",
      [{ text: "The 07:40 crossing leaves at 07:40." }],
      { folderId },
    );
    await writeFile(join(bin, "mode.other"), timetable);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const panel = group.getByTestId("note-ask-panel");
    const before = (await outcomesOf(window, mindId)).length;
    await nextRun("make");
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type("Write up the delays");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    const reply = panel.getByTestId("note-column-reply").last();
    const cards = reply.getByTestId("note-column-made");
    await expect(cards).toHaveCount(2);

    // Under the reply's words, each card its kind's icon in a soft tile at its left, then its name
    // with its kind under it, and Open.
    const [words, first] = [
      await reply.getByTestId("note-ask-reply").boundingBox(),
      await cards.first().boundingBox(),
    ];
    expect((first?.y ?? 0) - ((words?.y ?? 0) + (words?.height ?? 0))).toBeGreaterThanOrEqual(0);
    const made = cards.first();
    await expect(made.locator(".note-column-made-title")).toHaveText(
      "Ferry delays: what the interviews say",
    );
    await expect(made.locator(".note-column-made-kind")).toHaveText("Note");
    await expect(made.locator(".note-column-made-open")).toHaveText("Open");
    await expect(cards.nth(1).locator(".note-column-made-title")).toHaveText("Ferry timetable");
    await expect(cards.nth(1).locator(".note-column-made-kind")).toHaveText("1 change waits");
    const tile = made.locator(".note-column-made-icon");
    expect(await tile.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    const [tileBox, titleBox] = [
      await tile.boundingBox(),
      await made.locator(".note-column-made-title").boundingBox(),
    ];
    expect((tileBox?.x ?? 99) + (tileBox?.width ?? 0)).toBeLessThanOrEqual(titleBox?.x ?? 0);

    await setLanguage(window, "zh-CN");
    await expect(made.locator(".note-column-made-kind")).toHaveText("笔记");
    await expect(made.locator(".note-column-made-open")).toHaveText("打开");
    await expect(cards.nth(1).locator(".note-column-made-kind")).toHaveText("1 处修改等你确认");

    // A press opens what it made.
    await pointAndClick(window, made);
    await expect(
      window
        .locator('[data-testid="tab-group"][data-focused] [role="tab"][aria-selected="true"]')
        .first(),
    ).toContainText("Ferry delays");
  } finally {
    await app.close();
  }
});

test("a Citation in a reply shows its quote on hover and opens its Document there, as one in the Note does; scrolled, the conversation open upward fades out under its controls, never cut by the box's edge", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    await stepTo(99);
    await nextRun("long");
    const before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type("Summarise the ferry interviews");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);

    // Open, the reply's chips are the Note's own.
    await showConversation(window, 0, true);
    const reply = window.getByTestId("note-ask-reply").last();
    const chip = reply.locator(".citation-marker").first();
    await expect(chip).toBeVisible();
    await chip.hover();
    const card = window.getByTestId("citation-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Ferry interview");
    await shot(window, "reply-citation-card-1440-en");
    await pointAndClick(window, chip);
    await expect(window.getByTestId("viewer-title")).toContainText("Ferry interview");
    await expect(
      window.getByTestId("viewer").locator("[data-quote-highlight]").first(),
    ).toBeVisible();
    await shot(window, "reply-citation-opened-1440-en");

    // At 900 the conversation opens upward, at its end: scrolled, its top fades out.
    await setWindowSize(app, window, 900, 760);
    const panel = window.getByTestId("note-ask-panel");
    await expect(panel).toBeVisible();
    const body = panel.getByTestId("note-conversation-body");
    const masked = () => body.evaluate((element) => getComputedStyle(element).maskImage);
    await expect.poll(() => body.evaluate((element) => element.scrollTop > 0)).toBe(true);
    await expect.poll(masked).not.toBe("none");
    await shot(window, "upward-scrolled-900-en");
    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(masked).toBe("none");
  } finally {
    await app.close();
  }
});

/** Where `part` stands in the conversation it is in: its top and height against the view's. */
const placeIn = (part: Locator) =>
  part.evaluate(
    (element) =>
      new Promise<{ top: number; height: number; view: number; fromEnd: number }>((done) =>
        // Two frames: what keeps the conversation at its end acts after the layout a change brings.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const body = element.closest('[data-testid="note-conversation-body"]');
            const box = body?.getBoundingClientRect();
            const at = element.getBoundingClientRect();
            done({
              top: at.top - (box?.top ?? 0),
              height: at.height,
              view: body?.clientHeight ?? 0,
              fromEnd: body ? body.scrollHeight - body.scrollTop - body.clientHeight : 0,
            });
          }),
        ),
      ),
  );

test("pressed in the column's place, the line above the input opens the conversation at its reply's start, a reply taller than the column too, and keeps it there as it grows; a later request's card keeps its answers put as the turn above settles, and the column follows its end again", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 560);
    const mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    await stepTo(99);
    await nextRun("long");
    let before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type("Summarise the ferry interviews");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    // The conversation's place is the column; closed, the line stands above the input.
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    await fromConversationMenu(window, group, "conversation-move-left");
    const column = window.getByTestId("note-column");
    await fromConversationMenu(window, column, "note-column-close");
    await expect(column).toHaveCount(0);
    await pointAndClick(window, group.getByTestId("note-ask-pill-open"));
    const reply = column.getByTestId("note-column-turn").last().getByTestId("note-column-reply");
    await expect(reply).toContainText("The five interviews agree");
    // The keyboard is in the input, where the next request is typed.
    await expect(column.getByTestId("note-ask-input")).toBeFocused();
    const opened = await placeIn(reply);
    expect(opened.height).toBeGreaterThan(opened.view);
    expect({
      ...opened,
      startInView: opened.top >= 0 && opened.top < opened.view,
      atEnd: opened.fromEnd <= 2,
    }).toMatchObject({ startInView: true, atEnd: false });
    // As the reply still grows at its foot, its start stays where it is.
    for (const grown of ["48px", "0px"]) {
      await column
        .getByTestId("note-column-turn")
        .last()
        .evaluate((turn, padding) => {
          (turn as HTMLElement).style.paddingBottom = padding;
        }, grown);
      expect([grown, (await placeIn(reply)).top]).toEqual([grown, opened.top]);
    }

    // A later request's card: its answers stay put as the turn above grows and shrinks a moment
    // after it shows.
    await nextRun("ask-command");
    before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, column.getByTestId("note-ask-input"));
    await window.keyboard.type("Count the late crossings");
    await window.keyboard.press("Enter");
    const card = column.getByTestId("own-ask-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    const answer = card.getByTestId("own-ask-deny");
    const shown = await placeIn(answer);
    expect(shown.top + shown.height).toBeLessThanOrEqual(shown.view);
    for (const settled of ["48px", "0px"]) {
      await column
        .getByTestId("note-column-turn")
        .nth(-2)
        .evaluate((turn, padding) => {
          (turn as HTMLElement).style.paddingBottom = padding;
        }, settled);
      expect([settled, (await placeIn(answer)).top]).toEqual([settled, shown.top]);
    }
    // And the column follows its end again: the newest turn grows at its foot, the end in view.
    await column
      .getByTestId("note-column-turn")
      .last()
      .evaluate((turn) => {
        (turn as HTMLElement).style.paddingBottom = "48px";
      });
    expect((await placeIn(answer)).fromEnd).toBeLessThanOrEqual(2);
    await pointAndClick(window, answer);
    await ended(window, mindId, before);
  } finally {
    await app.close();
  }
});

test("the conversation moved to the column opens there again after a restart", async () => {
  let { app, window } = await launched();
  let mindId = "";
  try {
    await setWindowSize(app, window, 1440, 900);
    mindId = await harbourNote(window);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    await nextRun("plan");
    const before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type("What does the harbour plan add?");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    await fromConversationMenu(window, group, "conversation-move-left");
    await expect(window.getByTestId("note-column")).toBeVisible();
  } finally {
    await app.close();
  }
  ({ app, window } = await launched());
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    await pointAndClick(window, group.getByTestId("note-ask-conversation-toggle"));
    await expect(window.getByTestId("note-column")).toBeVisible();
    await expect(group.getByTestId("note-ask-panel")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

/** The window's groups hold these items, one each, left to right, the first in focus (#3759). */
async function arrange(window: Page, items: TabItem[]) {
  await window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    let layout = await bridge.getLayout("main");
    for (const group of layout.groups.slice(1)) {
      await bridge.changeLayout("main", { type: "closeGroup", groupId: group.id });
    }
    const [head, ...rest] = wanted;
    if (head)
      await bridge.changeLayout("main", { type: "open", item: head, where: { in: "place" } });
    layout = await bridge.getLayout("main");
    const shown = layout.groups[0]?.activeTabId;
    if (shown) await bridge.changeLayout("main", { type: "closeOthers", tabId: shown });
    for (const item of rest) {
      await bridge.changeLayout("main", { type: "open", item, where: { in: "side" } });
    }
    layout = await bridge.getLayout("main");
    const first = layout.groups[0];
    if (first) await bridge.changeLayout("main", { type: "focus", groupId: first.id });
  }, items);
  await expect(window.getByTestId("tab-group")).toHaveCount(items.length);
  await expect(window.getByTestId("tab-group").first()).toHaveAttribute("data-focused", "true");
}

/** A press in group `index`, as a person moves there: in a Note's text, or in a Document's page. */
async function pressIn(window: Page, index: number) {
  const group = window.getByTestId("tab-group").nth(index);
  const editor = group.getByTestId("mind-editor");
  const target = (await editor.count()) > 0 ? editor : group.locator("[data-group-body]");
  const box = await target.boundingBox();
  if (!box) throw new Error(`Group ${index + 1} isn't on screen.`);
  await window.mouse.move(box.x + 40, box.y + 60);
  await window.mouse.down();
  await window.mouse.up();
  await expect(group).toHaveAttribute("data-focused", "true");
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("It isn't on screen.");
  return box;
}

/**
 * The conversation is the window's one column, the tab area's full height, left of every tab group,
 * showing the request `asked`.
 */
async function expectColumnBeside(window: Page, asked: string) {
  const place = window.getByTestId("note-column-place");
  const column = place.getByTestId("note-column");
  await expect(column).toBeVisible();
  await expect(window.getByTestId("note-column")).toHaveCount(1);
  await motionSettled(window);
  await expect(column.getByTestId("note-column-turn").first()).toContainText(asked);
  const [card, box] = [await boxOf(window.getByTestId("card")), await boxOf(column)];
  expect(Math.abs(box.y - card.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height - (card.y + card.height))).toBeLessThanOrEqual(1);
  const groups = await window
    .getByTestId("tab-group")
    .evaluateAll((sections) => sections.map((each) => each.getBoundingClientRect().toJSON()));
  expect(Math.abs(box.x - card.x)).toBeLessThanOrEqual(1);
  for (const group of groups) expect(group.left).toBeGreaterThanOrEqual(box.x + box.width - 1);
}

/** The Note in group `index` keeps about 490px of text beside the column. */
async function expectReadable(window: Page, index: number) {
  const measure = window
    .getByTestId("tab-group")
    .nth(index)
    .locator('[data-testid="mind-pane"] .mind-measure');
  expect((await boxOf(measure)).width).toBeGreaterThanOrEqual(489);
}

const HARBOUR_ASKED = "What does the harbour plan add?";
const TIMETABLE_ASKED = "When does the 07:40 leave?";

/** Harbour notes and Timetable notes, each with a request answered, and the first interview's id. */
async function twoNotes(window: Page) {
  const folderId = await connected(window);
  const harbour = await writeNote(window, "Harbour notes", [{ text: P1 }, { text: P2 }], {
    folderId,
  });
  const timetable = await writeNote(window, "Timetable notes", [{ text: P3 }], { folderId });
  const documentId = await window.evaluate(async (name) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDocuments()).find((each) => each.name.startsWith(name))?.id ?? "";
  }, INTERVIEWS[0]?.[0] ?? "");
  for (const [mindId, asked, mode] of [
    [harbour, HARBOUR_ASKED, "plan"],
    [timetable, TIMETABLE_ASKED, "timetable"],
  ] as const) {
    await arrange(window, [{ kind: "mind", mindId }]);
    const group = window.getByTestId("tab-group").first();
    await nextRun(mode);
    const before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type(asked);
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
  }
  return { harbour, timetable, documentId };
}

/** Opens or closes the conversation of the Note in group `index` with Show conversation. */
async function showConversation(window: Page, index: number, open: boolean) {
  const toggle = window
    .getByTestId("tab-group")
    .nth(index)
    .getByTestId("note-ask-conversation-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== String(open)) {
    await pointAndClick(window, toggle);
  }
  await expect(toggle).toHaveAttribute("aria-expanded", String(open));
}

/**
 * Where the column doesn't fit, the conversation is open upward in the box at the foot of the Note
 * in group `index`, as wide as its text, its turns under 40% of the window's height, showing
 * `asked`, with no column and no move to one.
 */
async function expectUpward(window: Page, index: number, asked: string) {
  const group = window.getByTestId("tab-group").nth(index);
  const panel = group.getByTestId("note-ask-panel");
  await expect(panel).toBeVisible();
  await expect(window.getByTestId("note-column")).toHaveCount(0);
  const menu = await openConversationMenu(window, group);
  await expect(menu.getByTestId("conversation-new")).toBeVisible();
  await expect(menu.getByTestId("conversation-move-left")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(panel.getByTestId("note-column-turn").first()).toContainText(asked);
  // The groups take their new widths as the column leaves: the box and the text settle together.
  await motionSettled(window);
  await expect
    .poll(async () => {
      const [box, text] = [
        await boxOf(group.getByTestId("note-ask-box")),
        await boxOf(group.locator('[data-testid="mind-pane"] .mind-measure')),
      ];
      return Math.max(
        Math.abs(box.x - text.x),
        Math.abs(box.x + box.width - (text.x + text.width)),
      );
    })
    .toBeLessThanOrEqual(1);
  const height = await window.evaluate(() => globalThis.innerHeight);
  expect((await boxOf(panel.getByTestId("note-conversation-body"))).height).toBeLessThanOrEqual(
    height * 0.4 + 1,
  );
}

/** The items of the conversation's name menu in `scope`, read with it open; it is closed again. */
async function conversationMenu(window: Page, scope: Locator): Promise<string[]> {
  const menu = await openConversationMenu(window, scope);
  const items = await menu.getByRole("menuitem").allInnerTexts();
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return items;
}

/**
 * The conversation open upward in `group`'s box has a top row of its own: its name, which holds
 * its menu, at the words' start, inside the box's rounded corner. The turns start
 * 8px under that row, never behind it, and end 12px above the input; the newest one sent here
 * starts under the row at their end (#3765).
 */
async function expectPanelEdges(group: Locator) {
  const edges = await group.evaluate((element) => {
    const panel = element.querySelector('[data-testid="note-ask-panel"]');
    const head = panel?.querySelector('[data-testid="note-ask-panel-head"]');
    const body = panel?.querySelector<HTMLElement>('[data-testid="note-conversation-body"]');
    const box = element.querySelector('[data-testid="note-ask-box"]');
    const row = element.querySelector('[data-testid="note-ask-row"]');
    const button = head?.querySelector('[data-testid="conversation-name"]');
    const name = button?.querySelector("span")?.getBoundingClientRect();
    if (!panel || !head || !body || !box || !row || !button || !name) return null;
    const top = head.getBoundingClientRect();
    body.scrollTop = 0;
    const bubble = panel.querySelector(".note-column-bubble")?.getBoundingClientRect();
    const above = bubble ? bubble.top - top.bottom : null;
    body.scrollTop = body.scrollHeight;
    const turn = Array.from(body.querySelectorAll('[data-testid="note-column-turn"]')).at(-1);
    // What the last reply shows last: its copy-and-model line, or its one action; the newest turn
    // sent here, given the turns' height, ends at their end.
    const last = turn?.hasAttribute("data-newest")
      ? turn.getBoundingClientRect()
      : Array.from(turn?.children ?? [])
          .map((child) => child.getBoundingClientRect())
          .filter((rect) => rect.height > 0)
          .at(-1);
    // Taller than the turns' height, it shows its end instead.
    const room = Number.parseFloat(body.style.getPropertyValue("--newest-room"));
    const newest =
      turn?.hasAttribute("data-newest") && turn.getBoundingClientRect().height <= room + 1
        ? turn.getBoundingClientRect().top - top.bottom
        : 8;
    // Its left corner rounds as its right one does.
    const frame = box.getBoundingClientRect();
    const radius = Number.parseFloat(getComputedStyle(box).borderTopLeftRadius);
    const pressable = button.getBoundingClientRect();
    const [dx, dy] = [pressable.left - frame.left, pressable.top - frame.top];
    const rowBox = row.getBoundingClientRect();
    if (!bubble || !last || above === null) return null;
    return {
      above,
      newest,
      under: body.getBoundingClientRect().bottom - last.bottom,
      apart: top.bottom <= body.getBoundingClientRect().top + 0.5,
      start: Math.abs(name.left - (rowBox.left + 18)),
      inside: dx >= radius || dy >= radius || Math.hypot(radius - dx, radius - dy) <= radius - 1,
    };
  });
  expect(edges).not.toBeNull();
  expect(Math.abs((edges?.above ?? 0) - 8)).toBeLessThanOrEqual(1);
  expect(Math.abs((edges?.newest ?? 0) - 8)).toBeLessThanOrEqual(1);
  expect(Math.abs((edges?.under ?? 0) - 12)).toBeLessThanOrEqual(1);
  expect(edges?.apart).toBe(true);
  expect(edges?.start).toBeLessThanOrEqual(1);
  expect(edges?.inside).toBe(true);
}

/** The Document in group `index` shows its whole toolbar, with nothing scrolled out of sight. */
async function expectWholeToolbar(window: Page, index: number) {
  const toolbar = window.getByTestId("tab-group").nth(index).getByTestId("viewer-header");
  await expect(toolbar).toBeVisible();
  expect(await toolbar.evaluate((header) => header.scrollWidth - header.clientWidth)).toBe(0);
  await expect(toolbar.getByTestId("document-file-menu")).toBeInViewport({ ratio: 1 });
}

test("the conversation is one column left of every group, and follows the Note in focus: alone, beside a Document either way, two Notes and three groups", async () => {
  const { app, window } = await launched();
  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    // Wide enough for a Note and a Document beside the column where a scrollbar takes room too.
    await setWindowSize(app, window, 1680, 900);
    const { harbour, timetable, documentId } = await twoNotes(window);
    const note = (mindId: string): TabItem => ({ kind: "mind", mindId });
    const document: TabItem = { kind: "document", documentId };

    // A Note alone: Show conversation opens it upward; moved to the left, it is the column.
    await arrange(window, [note(harbour)]);
    await showConversation(window, 0, true);
    await fromConversationMenu(window, window.locator("body"), "conversation-move-left");
    await expectColumnBeside(window, HARBOUR_ASKED);

    // A Note at the left and a Document at the right: the two stay side by side, the column left of
    // both, and a press in the Document leaves it on the Note. The Note keeps about 490px of text,
    // and the Document enough for its whole toolbar.
    await arrange(window, [note(harbour), document]);
    await expectColumnBeside(window, HARBOUR_ASKED);
    await pressIn(window, 1);
    await expectColumnBeside(window, HARBOUR_ASKED);
    const [left, right] = [
      await boxOf(window.getByTestId("tab-group").nth(0)),
      await boxOf(window.getByTestId("tab-group").nth(1)),
    ];
    expect(right.x - (left.x + left.width)).toBeLessThanOrEqual(1);
    expect(right.width).toBeGreaterThanOrEqual(399);
    await expectReadable(window, 0);
    await expectWholeToolbar(window, 1);

    // Dragged narrow, the Document still keeps 400px beside the column. The widths the layout keeps
    // don't change for it, and the groups take them again as the column leaves.
    const kept = () =>
      window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await bridge.getLayout("main")).groups.map((group) => group.width);
      });
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.changeLayout("main", { type: "resize", widths: [0.8, 0.2] });
    });
    await expect.poll(async () => (await kept())[1] ?? 1).toBeLessThan(0.3);
    const stored = await kept();
    const drawnOf = async () => {
      const [note, doc] = [
        await boxOf(window.getByTestId("tab-group").nth(0)),
        await boxOf(window.getByTestId("tab-group").nth(1)),
      ];
      return { doc: doc.width, share: note.width / (note.width + doc.width) };
    };
    await expect.poll(async () => (await drawnOf()).doc).toBeGreaterThanOrEqual(399);
    await expectReadable(window, 0);
    await expectWholeToolbar(window, 1);
    expect(await kept()).toEqual(stored);
    await fromConversationMenu(window, window.locator("body"), "note-column-close");
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    expect(await kept()).toEqual(stored);
    const share = (stored[0] ?? 0) / ((stored[0] ?? 0) + (stored[1] ?? 0));
    await expect.poll(async () => Math.abs((await drawnOf()).share - share)).toBeLessThan(0.01);
    await showConversation(window, 0, true);
    await expectColumnBeside(window, HARBOUR_ASKED);

    // The reverse: the Document at the left, the Note at the right.
    await arrange(window, [document, note(harbour)]);
    await pressIn(window, 1);
    await expectColumnBeside(window, HARBOUR_ASKED);
    await expectReadable(window, 1);
    await expectWholeToolbar(window, 0);
    await pressIn(window, 0);
    await expectColumnBeside(window, HARBOUR_ASKED);

    // Two Notes: the column shows the conversation of the one in focus, and a Note whose
    // conversation is closed closes it.
    await arrange(window, [note(harbour), note(timetable)]);
    await expectColumnBeside(window, HARBOUR_ASKED);
    await pressIn(window, 1);
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    await showConversation(window, 1, true);
    await expectColumnBeside(window, TIMETABLE_ASKED);
    await pressIn(window, 0);
    await expectColumnBeside(window, HARBOUR_ASKED);
    await fromConversationMenu(window, window.locator("body"), "note-column-close");
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    // Closed, the box at the Note's foot says how to see it again, in words.
    await expect(
      window.getByTestId("tab-group").nth(0).getByTestId("note-ask-handle-toggle"),
    ).toHaveAttribute("aria-label", "Show conversation");
    await pressIn(window, 1);
    await expectColumnBeside(window, TIMETABLE_ASKED);
    await pressIn(window, 0);
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    // Side by side, each Note's box says its own last answer, never the other's.
    for (const [index, answer] of [
      [0, "A second ramp at Kestrel Bay"],
      [1, "The 07:40 crossing leaves at about 07:55"],
    ] as const) {
      await expect(
        window.getByTestId("tab-group").nth(index).getByTestId("note-ask-pill-open"),
      ).toContainText(answer);
    }
    await showConversation(window, 0, true);
    await expectColumnBeside(window, HARBOUR_ASKED);

    // Three groups leave neither the Note nor the others their room beside a column: the
    // conversation opens upward in the Note's box instead.
    await arrange(window, [note(harbour), document, note(timetable)]);
    await expectUpward(window, 0, HARBOUR_ASKED);
  } finally {
    await app.close();
  }
});

test("where the column doesn't fit beside the groups, measured on the tab area, the conversation opens upward from the Note's box instead", async () => {
  const { app, window } = await launched();
  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    const { harbour, documentId } = await twoNotes(window);
    const note = (mindId: string): TabItem => ({ kind: "mind", mindId });
    const document: TabItem = { kind: "document", documentId };
    await arrange(window, [note(harbour)]);
    await showConversation(window, 0, true);
    await fromConversationMenu(window, window.locator("body"), "conversation-move-left");
    await expectColumnBeside(window, HARBOUR_ASKED);

    // At 1440 a Note and a Document can't both keep their room beside the column: upward; with
    // the sidebar hidden they can. A press outside folds it, as it folds one opened upward.
    await arrange(window, [note(harbour), document]);
    await expectUpward(window, 0, HARBOUR_ASKED);
    await setSidebarShown(window, false);
    await showConversation(window, 0, true);
    await expectColumnBeside(window, HARBOUR_ASKED);
    await expectReadable(window, 0);
    await expectWholeToolbar(window, 1);
    await setSidebarShown(window, true);

    // At 1280, beside the Note alone, upward beside a Document.
    await setWindowSize(app, window, 1280, 800);
    await expectUpward(window, 0, HARBOUR_ASKED);
    await arrange(window, [note(harbour)]);
    await expectColumnBeside(window, HARBOUR_ASKED);
    await expectReadable(window, 0);

    // Measured on the tab area, not on the window: at 1040 a hidden sidebar leaves the room.
    await setWindowSize(app, window, 1040, 760);
    await expectUpward(window, 0, HARBOUR_ASKED);
    await setSidebarShown(window, false);
    await showConversation(window, 0, true);
    await expectColumnBeside(window, HARBOUR_ASKED);
    // The sidebar's button is in the conversation's top row then, at the window's left.
    await expect(
      window.getByTestId("note-column-place").getByTestId("sidebar-toggle"),
    ).toBeVisible();
    await expect(window.getByTestId("tab-strip").getByTestId("sidebar-toggle")).toHaveCount(0);
    await setSidebarShown(window, true);

    // At the smallest window, upward.
    await setWindowSize(app, window, 900, 760);
    await expectUpward(window, 0, HARBOUR_ASKED);
  } finally {
    await app.close();
  }
});

/** Scrolled to its end, the last line of the Note in `group` stands above the box at its foot. */
async function expectLastLineClear(group: Locator) {
  await expect
    .poll(() =>
      group.evaluate((element) => {
        const scroller = element.querySelector<HTMLElement>('[data-testid="mind-scroller"]');
        const last = Array.from(element.querySelectorAll('[data-testid="mind-editor"] p')).at(-1);
        const box = element.querySelector('[data-testid="note-ask-box"]');
        if (!scroller || !last || !box) return null;
        scroller.scrollTop = scroller.scrollHeight;
        return box.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
      }),
    )
    .toBeGreaterThanOrEqual(0);
}

test("scrolled to its end, a Note's last line stands above its conversation open upward, and above the folded box, at 1440 beside a Document and at 900", async () => {
  const { app, window } = await launched();
  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    const folderId = await connected(window);
    const lines = Array.from({ length: 30 }, (_, n) => ({ text: [P1, P2, P3][n % 3] ?? P1 }));
    const mindId = await writeNote(window, "Harbour notes", lines, { folderId });
    const documentId = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.listDocuments())[0]?.id ?? "";
    });
    await arrange(window, [
      { kind: "mind", mindId },
      { kind: "document", documentId },
    ]);
    const group = window.getByTestId("tab-group").first();
    // Three requests: the conversation reaches its 40%, more than the room the Note's end keeps.
    for (const asked of [HARBOUR_ASKED, "When does it open?", "Who pays for it?"]) {
      await nextRun("plan");
      const before = (await outcomesOf(window, mindId)).length;
      await pointAndClick(window, group.getByTestId("note-ask-input"));
      await window.keyboard.type(asked);
      await window.keyboard.press("Enter");
      await ended(window, mindId, before);
    }

    for (const [width, height] of [
      [1440, 900],
      [900, 760],
    ] as const) {
      await setWindowSize(app, window, width, height);
      const note = window.getByTestId("tab-group").first();
      await showConversation(window, 0, true);
      await expectUpward(window, 0, HARBOUR_ASKED);
      expect((await boxOf(note.getByTestId("note-ask-panel"))).height).toBeGreaterThan(
        height * 0.4 - 2,
      );
      await expectLastLineClear(note);
      await showConversation(window, 0, false);
      await expect(note.getByTestId("note-ask-panel")).toHaveCount(0);
      await expectLastLineClear(note);
    }
  } finally {
    await app.close();
  }
});

test("at 900 px a waiting change's bar stands whole above the Note's input, with the conversation open upward over the Note's foot or folded, docks again each time the box grows or shrinks under it, and its Accept takes the press", async () => {
  const { app, window } = await launched();
  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 760);
    const folderId = await connected(window);
    const lines = Array.from({ length: 30 }, (_, n) => ({ text: [P1, P2, P3][n % 3] ?? P1 }));
    const mindId = await writeNote(window, "Harbour notes", lines, { folderId });
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    await nextRun("plan");
    const before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type(HARBOUR_ASKED);
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);

    // An outside agent's change to the Note's last line waits there.
    const launch = await window.evaluate(async (folder) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const made = await bridge.connectAgent({
        name: "Research assistant",
        folderIds: [folder],
        propose: true,
      });
      return made.launch;
    }, folderId);
    const agent = new Client({ name: "test-agent", version: "1.0.0" });
    await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
    try {
      const read = await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } });
      const { version } = read.structuredContent as { version: string };
      const proposed = await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version,
          changes: [{ paragraph: "¶30", text: `${P3} A covered waiting room comes with it.` }],
        },
      });
      expect(proposed.isError ?? false).toBe(false);
    } finally {
      await agent.close();
    }
    const editor = group.getByTestId("mind-editor");
    const change = editor.locator("ins.proposal-insert").last();
    await expect(change).toContainText("A covered waiting room comes with it.");

    const scroller = group.getByTestId("mind-scroller");
    const bar = window.getByTestId("change-bar");
    const box = group.getByTestId("note-ask-box");
    const stacked = async (element: Locator) =>
      element.evaluate((node) => Number(getComputedStyle(node).zIndex) || 0);
    // A press at its Accept lands on Accept, not on what stands over the Note's foot.
    const pressable = () =>
      bar.getByTestId("change-accept").evaluate((button) => {
        const box = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
        );
      });
    for (const upward of [true, false]) {
      await showConversation(window, 0, upward);
      await expect(group.getByTestId("note-ask-panel")).toHaveCount(upward ? 1 : 0);
      // Scrolled to its end, once the conversation has its height: the Note's end keeps its 160px
      // above the box.
      await expect
        .poll(async () => {
          await scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const [input, changed] = [
            await boxOf(group.getByTestId("note-ask-box")),
            await boxOf(change),
          ];
          return Math.round(input.y - (changed.y + changed.height));
        })
        .toBeGreaterThanOrEqual(150);
      await motionSettled(window);
      // Pointed at, the change shows its bar, with no press that would fold the conversation.
      const at = await change.evaluate((element) => {
        const first = element.getClientRects()[0];
        return first ? { x: first.left + first.width / 2, y: first.top + first.height / 2 } : null;
      });
      if (!at) throw new Error("The change isn't on screen.");
      await window.mouse.move(at.x, at.y);
      await expect(bar).toBeVisible();
      await expect(bar).toHaveCSS("visibility", "visible");
      await motionSettled(window);
      await shot(window, `change-bar-${upward ? "upward" : "folded"}-900-en`);
      const [placed, input, changed] = [await boxOf(bar), await boxOf(box), await boxOf(change)];
      const where = upward ? "open upward" : "folded";
      // Between its change and the box, clear of both, and drawn over the fade the box draws.
      expect(placed.y, where).toBeGreaterThanOrEqual(changed.y + changed.height - 1);
      expect(placed.y + placed.height, where).toBeLessThanOrEqual(input.y);
      expect(await stacked(bar), where).toBeGreaterThan(await stacked(box));
      expect(await pressable(), where).toBe(true);
    }

    // With the cursor resting in the change, put there by the keyboard, and no pointer on it, the
    // bar docks again above the box each time the box grows or shrinks, with no scroll between.
    const dockedAbove = async (where: string) => {
      await motionSettled(window);
      await expect
        .poll(
          async () => {
            const [placed, input] = [await boxOf(bar), await boxOf(box)];
            return Math.round(input.y - (placed.y + placed.height));
          },
          { message: `${where}: the bar's room above the box` },
        )
        .toBe(16);
      const [placed, changed] = [await boxOf(bar), await boxOf(change)];
      expect(placed.y, where).toBeGreaterThanOrEqual(changed.y + changed.height - 1);
      expect(await stacked(bar), where).toBeGreaterThan(await stacked(box));
      expect(await pressable(), where).toBe(true);
    };
    const [text, view] = [
      await boxOf(group.locator('[data-testid="mind-pane"] .mind-measure')),
      await boxOf(scroller),
    ];
    await window.mouse.click(text.x + 40, view.y + view.height / 3);
    await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await expect(bar).toBeVisible();
    await dockedAbove("folded, the cursor in the change");
    await showConversation(window, 0, true);
    await expect(group.getByTestId("note-ask-panel")).toHaveCount(1);
    await dockedAbove("opened upward under the bar");
    await shot(window, "change-bar-cursor-upward-900-en");
    await showConversation(window, 0, false);
    await expect(group.getByTestId("note-ask-panel")).toHaveCount(0);
    await dockedAbove("folded under the bar");
    // A question of the AI's grows the box over the Note's foot by itself.
    await nextRun("ask-command");
    const asked = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type("Check the late crossings and save a table");
    await window.keyboard.press("Enter");
    const card = group.getByTestId("own-ask-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await dockedAbove("a question asked under the bar");
    await shot(window, "change-bar-question-900-en");
    // While it runs, the line of changes waiting shows, under the tab strip that holds the Note's
    // own controls (#3765), its Reject all pressable.
    const waitingLine = group.getByTestId("proposals-bar");
    await expect(waitingLine).toBeVisible();
    const [line, controls] = [
      await boxOf(waitingLine),
      await boxOf(group.getByTestId("note-controls")),
    ];
    expect(line.y).toBeGreaterThanOrEqual(controls.y + controls.height);
    const rejectAll = waitingLine.getByRole("button").last();
    expect(
      await rejectAll.evaluate((button) => {
        const box = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
        );
      }),
    ).toBe(true);
    await pointAndClick(window, card.getByTestId("own-ask-deny"));
    await ended(window, mindId, asked);
    await expect(card).toHaveCount(0);
    await dockedAbove("the question answered");
    // Pressed with the conversation open under it, Accept takes the press, and the conversation
    // stays open.
    await showConversation(window, 0, true);
    await dockedAbove("opened again under the bar");
    await pointAndClick(window, bar.getByTestId("change-accept"));
    await expect(editor.locator("ins.proposal-insert")).toHaveCount(0);
    await expect(editor).toContainText("A covered waiting room comes with it.");
    await expect(group.getByTestId("note-ask-panel")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("the input at a Note's foot stands on the text's edges, wide, narrow and beside comments, in English and Chinese, and the page fades out only just above it", async () => {
  const { app, window } = await launched();
  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    const folderId = await connected(window);
    const mindId = await writeNote(
      window,
      "Harbour notes",
      Array.from({ length: 24 }, (_, n) => ({ text: [P1, P2, P3][n % 3] ?? P1 })),
      { folderId },
    );
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const box = group.getByTestId("note-ask-box");
    const measure = group.locator('[data-testid="mind-pane"] .mind-measure');
    const onTheText = async (where: string) => {
      const [input, text] = [await boxOf(box), await boxOf(measure)];
      expect(Math.abs(input.x - text.x), `${where}: left`).toBeLessThanOrEqual(1);
      expect(
        Math.abs(input.x + input.width - (text.x + text.width)),
        `${where}: right`,
      ).toBeLessThanOrEqual(1);
    };
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      for (const [width, height] of [
        [1440, 900],
        [1280, 800],
        [900, 760],
      ] as const) {
        await setWindowSize(app, window, width, height);
        await expect(box).toBeVisible();
        await onTheText(`${language} ${width} px`);
      }
    }
    await setLanguage(window, "en");

    // Scrolled into the middle, the text runs to the input: only the last pixels above it fade.
    await setWindowSize(app, window, 1440, 900);
    const scroller = group.getByTestId("mind-scroller");
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 3;
    });
    const fade = group.getByTestId("ask-pill-fade");
    const [faded, input, page] = [await boxOf(fade), await boxOf(box), await boxOf(scroller)];
    expect(faded.height).toBeLessThanOrEqual(24);
    expect(Math.abs(faded.y + faded.height - (page.y + page.height))).toBeLessThanOrEqual(1);
    expect(input.y - (page.y + page.height)).toBeLessThanOrEqual(8);

    // With comments beside the text, the text moves left and the input with it.
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await slideSelect(window, group.getByTestId("mind-editor").locator("p").first(), "runs late");
    await pointAndClick(window, window.getByTestId("selection-comment"));
    await window.keyboard.type("Which weekdays?");
    await pointAndClick(window, window.getByTestId("comment-save"));
    await expect(window.locator("[data-comment-card]")).toHaveCount(1);
    await motionSettled(window);
    await onTheText("beside a comment");

    // With the conversation in the window's column, the Note's own foot holds nothing: the Note
    // runs to the page's bottom edge, and nothing fades.
    await showConversation(window, 0, true);
    await fromConversationMenu(window, group, "conversation-move-left");
    await expect(window.getByTestId("note-column")).toBeVisible();
    await expect(fade).toBeHidden();
    const [scrolled, tabPage] = [
      await boxOf(scroller),
      await boxOf(group.locator(".mind-tab-page")),
    ];
    expect(
      Math.abs(scrolled.y + scrolled.height - (tabPage.y + tabPage.height)),
    ).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
  }
});

test("a request that writes into an empty Note starts at its first line, the empty line gone, and Undo brings it back", async () => {
  const { app, window } = await launched();
  try {
    await setWindowSize(app, window, 1440, 900);
    await harbourNote(window);
    await newMind(window, { title: true });
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const editor = group.getByTestId("mind-editor");
    const lines = editor.locator(":scope > :is(h1, h2, h3, p)");
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toHaveJSProperty("tagName", "H1");
    const mindId = (await frontMind(window).getAttribute("data-mind-id")) ?? "";
    await nextRun("summary");
    const before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type("Summarise the ferry interviews");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    await expect(lines.first()).toHaveText("Ferry interviews");
    await expect(lines.first()).toHaveJSProperty("tagName", "H2");
    await expect(lines).toHaveCount(3);
    await expect(editor.getByTestId("applied-count")).toHaveText("Added 2 paragraphs");
    await pointAndClick(window, group.getByTestId("note-ask-undo"));
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toHaveJSProperty("tagName", "H1");
    await expect(lines.first()).toHaveText("");
  } finally {
    await app.close();
  }
});
