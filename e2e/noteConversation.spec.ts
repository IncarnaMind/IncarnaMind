import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  cutIn,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  writeNote,
} from "./app";

/*
 * The Note's conversation in its two places (#3677): upward inside the input's box at the Note's
 * foot, and the column at the Note's right, one control moving it between them with the
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

test("the Note's conversation opens upward in its input's box and moves to a column at its right and back, keeping a run and the words typed; the check badge stands with the Note's own controls", async () => {
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

    // Upward: the same box grows over the Note's foot, no taller than 40% of the window; its top row
    // keeps only the move to the right and the fold, never the reply again.
    await pointAndClick(window, handle);
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("note-column-turn")).toHaveCount(1);
    await expect(box.getByTestId("note-ask-pill")).toHaveCount(0);
    expect((await panel.boundingBox())?.height ?? 999).toBeLessThanOrEqual(900 * 0.4 + 1);
    const right = group.getByTestId("conversation-move-right");
    await expect(right).toHaveAttribute("aria-label", "Move to the right");
    await shot(window, "conversation-upward-en");

    // Moved to the right with words half-typed and the focus in the input: the column, the tab
    // group's full height, holds the conversation and the one input, the words and the focus kept.
    await pointAndClick(window, input);
    await window.keyboard.type("Who asked for a sec");
    await pointAndClick(window, right);
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
    await pointAndClick(window, right);
    await expect(column.getByTestId("note-column-live")).toContainText("Ferry interview");
    await expect(column.getByTestId("note-ask-stop")).toBeVisible();
    await shot(window, "conversation-running-column-en");
    await stepTo(99);
    await ended(window, mindId, before);
    await expect(column.getByTestId("note-column-turn")).toHaveCount(2);
    await expect(column.getByTestId("note-column-reply").last()).toContainText(
      "The five interviews agree on one thing",
    );

    // In Chinese, the controls say so in Chinese; in a narrow window the column is a sheet over
    // the Note.
    await setLanguage(window, "zh-CN");
    await expect(column.getByTestId("conversation-move-down")).toHaveAttribute(
      "aria-label",
      "移回笔记下方",
    );
    await shot(window, "conversation-column-zh-CN");
    await setWindowSize(app, window, 900, 760);
    await expect(group.locator(".note-column-over-slot").getByTestId("note-column")).toBeVisible();
    await shot(window, "conversation-narrow-zh-CN");
    await setWindowSize(app, window, 1440, 900);
    await pointAndClick(window, column.getByTestId("conversation-move-down"));
    await expect(group.getByTestId("conversation-move-right")).toHaveAttribute(
      "aria-label",
      "移到右侧",
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
    await pointAndClick(window, group.getByTestId("conversation-move-right"));
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
    // The box's top row keeps only the move and the fold: the line is the conversation's.
    await expect(group.getByTestId("note-ask-handle").getByTestId("note-ask-pill")).toHaveCount(0);
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
    await shot(window, "conversation-problem-upward-en");
    // In the column, at its foot, and in the narrow window's sheet, in Chinese.
    await pointAndClick(window, group.getByTestId("conversation-move-right"));
    await expect(column).toBeVisible();
    await shownWhole(tooOld);
    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 760);
    await expect(group.locator(".note-column-over-slot").getByTestId("note-column")).toBeVisible();
    await shownWhole("Claude Code 2.0.1 版本过旧，需要 2.1.248 或更高版本。更新后再发送一次。");
    await shot(window, "conversation-problem-column-zh-CN");
    // Folded, at both widths: it wraps, never cut.
    await setLanguage(window, "en");
    await pointAndClick(window, column.getByTestId("note-column-close"));
    await expect(column).toHaveCount(0);
    await shownWhole(tooOld);
    await shot(window, "conversation-problem-folded-en");
    await setWindowSize(app, window, 1440, 900);
    await shownWhole(tooOld);

    // A connection that may only read, asked with the conversation open: Allow is in the turn's
    // line, and the request goes again.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [pairing] = (await bridge.getAgents()).pairings;
      if (pairing) await bridge.updateAgent(pairing.id, { propose: false });
    });
    await pointAndClick(window, group.getByTestId("note-ask-conversation-toggle"));
    await expect(column).toBeVisible();
    await nextRun("change");
    before = (await outcomesOf(window, mindId)).length;
    await send("Put it in capitals");
    await ended(window, mindId, before);
    const last = column.getByTestId("note-column-turn").last();
    await expect(last.getByTestId("note-ask-problem")).toContainText(
      "Claude Code may only read. Let it propose changes?",
    );
    await expect(last.getByTestId("note-ask-allow")).toHaveText("Allow");
    before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, last.getByTestId("note-ask-allow"));
    await ended(window, mindId, before);
    await expect(column.getByTestId("note-column-turn").last()).toContainText(
      "Put the selected words in capitals.",
    );
    await expect(frontMind(window)).toContainText(P2.toUpperCase());
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
    await pointAndClick(window, group.getByTestId("conversation-move-right"));
    const column = window.getByTestId("note-column");
    await pointAndClick(window, column.getByTestId("note-column-close"));
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
    await pointAndClick(window, group.getByTestId("conversation-move-right"));
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
