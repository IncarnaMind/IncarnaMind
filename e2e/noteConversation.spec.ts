import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, TabItem } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
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

    // Upward: the same box grows over the Note's foot, as tall as the conversation needs and no
    // taller than 40% of the window, the reply never again in a row of its own. The move to the
    // left and the fold stand at its top right, level with the first request, taking no row; the
    // conversation ends 12px above the input.
    await pointAndClick(window, handle);
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("note-column-turn")).toHaveCount(1);
    await expect(box.getByTestId("note-ask-pill")).toHaveCount(0);
    await expect(box.getByTestId("note-ask-top")).toHaveCount(0);
    expect((await panel.boundingBox())?.height ?? 999).toBeLessThanOrEqual(900 * 0.4 + 1);
    const aside = panel.getByTestId("conversation-move-left");
    await expect(aside).toHaveAttribute("aria-label", "Move to the left");
    const fold = panel.getByTestId("note-ask-fold");
    await expect(fold).toHaveAttribute("aria-label", "Hide conversation");
    const [bubble, asideBox, foldBox, panelBox, turn, row] = [
      await boxOf(panel.locator(".note-column-bubble").first()),
      await boxOf(aside),
      await boxOf(fold),
      await boxOf(panel),
      await boxOf(panel.getByTestId("note-column-turn").last()),
      await boxOf(box.getByTestId("note-ask-row")),
    ];
    for (const control of [asideBox, foldBox]) {
      const middle = control.y + control.height / 2;
      expect(Math.abs(middle - (bubble.y + bubble.height / 2))).toBeLessThanOrEqual(1);
      expect(control.x).toBeGreaterThanOrEqual(bubble.x + bubble.width);
    }
    expect(Math.abs(foldBox.x + foldBox.width - (row.x + row.width - 10))).toBeLessThanOrEqual(1);
    expect(panelBox.y + panelBox.height - (turn.y + turn.height)).toBeLessThanOrEqual(16);
    expect(Math.abs(row.y - (panelBox.y + panelBox.height))).toBeLessThanOrEqual(1);
    await shot(window, "conversation-upward-en");

    // Moved to the left with words half-typed and the focus in the input: the window's column, the
    // tab area's full height, holds the conversation and the one input, the words and the focus kept.
    await pointAndClick(window, input);
    await window.keyboard.type("Who asked for a sec");
    await pointAndClick(window, aside);
    await expect(column).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(window.getByTestId("note-ask-input")).toHaveCount(1);
    const inColumn = column.getByTestId("note-ask-input");
    await expect(inColumn).toHaveValue("Who asked for a sec");
    await expect(inColumn).toBeFocused();
    await expect(column.getByTestId("note-column-turn")).toHaveCount(1);
    const [columnBox, groupBox] = [await column.boundingBox(), await group.boundingBox()];
    expect(Math.abs((columnBox?.y ?? 0) - (groupBox?.y ?? 99))).toBeLessThanOrEqual(1);
    const down = column.getByTestId("conversation-move-down");
    await expect(down).toHaveAttribute("aria-label", "Move back under the note");
    await shot(window, "conversation-column-en");

    // And back: upward and open again, the words and the focus kept.
    await pointAndClick(window, down);
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
    await pointAndClick(window, aside);
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
    await expect(column.getByTestId("conversation-move-down")).toHaveAttribute(
      "aria-label",
      "移回笔记下方",
    );
    await shot(window, "conversation-column-zh-CN");
    await setWindowSize(app, window, 900, 760);
    await expect(panel).toBeVisible();
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    await expect(group.getByTestId("conversation-move-left")).toHaveCount(0);
    await shot(window, "conversation-narrow-zh-CN");
    await setWindowSize(app, window, 1440, 900);
    await pointAndClick(window, column.getByTestId("conversation-move-down"));
    await expect(group.getByTestId("conversation-move-left")).toHaveAttribute(
      "aria-label",
      "移到左侧",
    );
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
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    await pointAndClick(window, input);
    await window.keyboard.type("坡道");
    // The IME as Chromium hears it: letters composing, then the characters they end as.
    const ime = await window.context().newCDPSession(window);
    await ime.send("Input.imeSetComposition", { text: "gang", selectionStart: 4, selectionEnd: 4 });
    await expect(input).toHaveValue("坡道gang");
    await pointAndClick(window, group.getByTestId("conversation-move-left"));
    await expect(window.getByTestId("note-column")).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("坡道");
    await ime.send("Input.insertText", { text: "港" });
    await expect(input).toHaveValue("坡道港");
    // In the middle of the words: after the move the caret is where the composition began.
    await window.keyboard.press("ArrowLeft");
    await ime.send("Input.imeSetComposition", { text: "kou", selectionStart: 3, selectionEnd: 3 });
    await expect(input).toHaveValue("坡道kou港");
    await pointAndClick(
      window,
      window.getByTestId("note-column").getByTestId("conversation-move-down"),
    );
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
    await pointAndClick(window, group.getByTestId("conversation-move-left"));
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
  for (const [mindId, asked] of [
    [harbour, HARBOUR_ASKED],
    [timetable, TIMETABLE_ASKED],
  ] as const) {
    await arrange(window, [{ kind: "mind", mindId }]);
    const group = window.getByTestId("tab-group").first();
    await nextRun("plan");
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
 * in group `index`, as wide as its text and under 40% of the window's height, showing `asked`, with
 * no column and no move to one.
 */
async function expectUpward(window: Page, index: number, asked: string) {
  const group = window.getByTestId("tab-group").nth(index);
  const panel = group.getByTestId("note-ask-panel");
  await expect(panel).toBeVisible();
  await expect(window.getByTestId("note-column")).toHaveCount(0);
  await expect(group.getByTestId("conversation-move-left")).toHaveCount(0);
  await expect(panel.getByTestId("note-column-turn").first()).toContainText(asked);
  const [box, text] = [
    await boxOf(group.getByTestId("note-ask-box")),
    await boxOf(group.locator('[data-testid="mind-pane"] .mind-measure')),
  ];
  expect(Math.abs(box.x - text.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.x + box.width - (text.x + text.width))).toBeLessThanOrEqual(1);
  const height = await window.evaluate(() => globalThis.innerHeight);
  expect((await boxOf(panel)).height).toBeLessThanOrEqual(height * 0.4 + 1);
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
    await setWindowSize(app, window, 1600, 900);
    const { harbour, timetable, documentId } = await twoNotes(window);
    const note = (mindId: string): TabItem => ({ kind: "mind", mindId });
    const document: TabItem = { kind: "document", documentId };

    // A Note alone: Show conversation opens it upward; moved to the left, it is the column.
    await arrange(window, [note(harbour)]);
    await showConversation(window, 0, true);
    await pointAndClick(window, window.getByTestId("conversation-move-left"));
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
    await pointAndClick(window, window.getByTestId("note-column-close"));
    await expect(window.getByTestId("note-column")).toHaveCount(0);
    // Closed, the box at the Note's foot says how to see it again, in words.
    await expect(
      window.getByTestId("tab-group").nth(0).getByTestId("note-ask-handle-toggle"),
    ).toHaveAttribute("aria-label", "Show conversation");
    await pressIn(window, 1);
    await expectColumnBeside(window, TIMETABLE_ASKED);
    await pressIn(window, 0);
    await expect(window.getByTestId("note-column")).toHaveCount(0);
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
    await pointAndClick(window, window.getByTestId("conversation-move-left"));
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

test("the input at a Note's foot stands on the text's edges, wide, narrow and beside comments, and the page fades out only just above it", async () => {
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
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [900, 760],
    ] as const) {
      await setWindowSize(app, window, width, height);
      await expect(box).toBeVisible();
      await onTheText(`${width} px`);
    }

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
