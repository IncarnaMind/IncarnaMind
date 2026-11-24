import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
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
    // Nothing of Claude Code is started to list its models: before a request, the box has none.
    await window.waitForTimeout(1000);
    await expect(model).toHaveCount(0);

    await nextRun("plan");
    let before = (await outcomesOf(window, mindId)).length;
    await pointAndClick(window, input);
    await window.keyboard.type("What does the harbour plan add?");
    await window.keyboard.press("Enter");
    await ended(window, mindId, before);
    // The request's own run brought the list: its default first, as Claude Code names it.
    await expect(model).toHaveText("Sonnet 5.5");
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
    // Claude Code named the model it answered on: the one chosen.
    await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
    const reply = group.getByTestId("note-column-reply").last();
    await expect(reply.locator(".note-column-reply-meta")).toHaveText("Haiku 5.5");
    // Copy puts the reply's words on the clipboard.
    await reply.hover();
    await pointAndClick(window, reply.getByTestId("note-column-copy"));
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
    await ime.send("Input.imeSetComposition", { text: "kou", selectionStart: 3, selectionEnd: 3 });
    await pointAndClick(
      window,
      window.getByTestId("note-column").getByTestId("conversation-move-down"),
    );
    await expect(input).toBeFocused();
    await ime.send("Input.insertText", { text: "口" });
    await expect(input).toHaveValue("坡道港口");
  } finally {
    await app.close();
  }
});
