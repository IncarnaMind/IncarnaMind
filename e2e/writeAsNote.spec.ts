import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  center,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  frontMindName,
  launchApp,
  markSteps,
  nameMind,
  newMind,
  openPageMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  tabMenu,
  useOutputLocation,
} from "./app";

/*
 * "Write as a note" (#1940): the first, labelled button under every Answer makes a note,
 * opens it beside, writes the Answer in with Undo; Add to note never targets the example,
 * by the picker, ⌘⇧A or a viewer selection; the composer says what it can write; a note
 * lists its chat in its ⋯ and History under its title, also after the tab closes and after
 * a restart; an empty note keeps no second start guide once the first-run card was seen,
 * and keeps it until then. The scripted model answers from the Document, with a Citation.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const WORDS = {
  en: {
    note: "Harbour notes",
    question: "When do spring tides happen?",
    write: "Write as a note",
    plain: "Add to note",
    choose: "Choose a note to add it to",
    named: (note: string) => `Add to “${note}”`,
    added: (note: string) => `Added to “${note}”`,
    kept: "Kept the Block you edited",
    placeholder: "Ask, or say ‘write a note on…’",
    chat: "This note’s chat",
    startGuide: "Start in three steps",
    connectApp: "Connect an app…",
  },
  "zh-CN": {
    note: "港口笔记",
    question: "大潮 tides 什么时候出现？",
    write: "写成笔记",
    plain: "添加到笔记",
    choose: "选择要添加到的笔记",
    named: (note: string) => `添加到“${note}”`,
    added: (note: string) => `已添加到“${note}”`,
    kept: "保留了 1 个你编辑过的块",
    placeholder: "提问，或说“写一篇关于……的笔记”",
    chat: "这篇笔记的对话",
    startGuide: "三步开始",
    connectApp: "连接应用…",
  },
} as const;
const LANGUAGES = ["en", "zh-CN"] as const;
const WIDTHS = [900, 1600] as const;
type Language = (typeof LANGUAGES)[number];

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** The app with the scripted model, a PDF to answer from, and the window and language asked for. */
async function start(language: Language, width: number, { examples = false } = {}) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, examples });
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await setWindowSize(app, window, width, 760);
  await setLanguage(window, language);
  if (!examples) {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
  }
  return { app, window };
}

/** The Answer's opening words, in the thread: what its note says too, whatever the model said. */
const openingOf = async (answer: Locator) =>
  ((await answer.getByTestId("assistant-answer-text").textContent()) ?? "").trim().slice(0, 20);

/** A note of the User's own, with text in it, so Write as a note makes another beside it. */
async function noteWithText(window: Page, name: string) {
  await newMind(window);
  await window.keyboard.type("Harbour notes");
  await nameMind(window, name);
}

/** The example's Mind id and tab, from the note the app opens on. */
async function exampleTaken(window: Page) {
  await expect(window.getByTestId("first-open-steps")).toBeVisible();
  const mindId = await frontMind(window).getAttribute("data-mind-id");
  return {
    mindId,
    tab: window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`),
    editor: window
      .locator(`[data-testid="mind-pane"][data-mind-id="${mindId}"]`)
      .getByTestId("mind-editor"),
  };
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  for (const width of WIDTHS) {
    test(`Write as a note is the first, labelled button under an Answer: it makes a note beside it with Undo, and the composer says it can write, at ${width} px (${language})`, async () => {
      const { app, window } = await start(language, width);
      await noteWithText(window, w.note);
      const input = window.getByTestId("composer-input");
      await expect(input).toHaveAttribute("placeholder", w.placeholder);

      const answer = await askInAssistant(window, w.question);
      const opening = await openingOf(answer);
      const write = answer.getByTestId("answer-write-note");
      const add = answer.getByTestId("answer-add");
      const copy = answer.getByTestId("answer-copy");
      await expect(write).toHaveText(w.write);
      await expect(answer.getByTestId("answer-add-label")).toHaveText(w.plain);
      const writeBox = await center(write);
      const addBox = await center(add);
      const copyBox = await center(copy);
      expect(writeBox.x).toBeLessThan(addBox.x);
      expect(addBox.x).toBeLessThan(copyBox.x);
      expect(Math.abs(writeBox.y - copyBox.y)).toBeLessThan(2);

      const tabs = window.getByTestId("mind-tab");
      await expect(tabs).toHaveCount(1);
      await pointAndClick(window, write);
      // The second note opens beside the first, and the Answer is in it at once.
      await expect(tabs).toHaveCount(2);
      await expect(frontMind(window).getByTestId("mind-editor")).toContainText(opening);
      await expect(frontMindName(window)).not.toHaveText(/^(Untitled|未命名)$/);
      const made = ((await frontMindName(window).textContent()) ?? "").trim();
      await expect(answer.getByTestId("answer-added")).toContainText(w.added(made));
      expect(await frontMind(window).getByTestId("proposal-bar").count()).toBe(0);

      // Undo takes the Answer back out; the note it made stays, and Delete would take it back.
      await pointAndClick(window, answer.getByTestId("answer-added-undo"));
      await expect(frontMind(window).getByTestId("mind-editor")).not.toContainText(opening);
      await expect(write).toBeVisible();
      await app.close();
    });
  }
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  test(`Undo keeps a Block the User edited after it went in, and says so (${language})`, async () => {
    const { app, window } = await start(language, 1600);
    // A note with text in front, so the Answer makes another through the core, whose Undo is the one that keeps edits.
    await noteWithText(window, w.note);
    const answer = await askInAssistant(window, w.question);
    await pointAndClick(window, answer.getByTestId("answer-write-note"));
    const editor = frontMind(window).getByTestId("mind-editor");
    await expect(editor).not.toHaveText("");

    // The User changes the words that went in.
    await pointAndClick(window, editor.locator(":scope > p").first());
    await window.keyboard.press("End");
    await window.keyboard.type(" (mine)");
    await expect(editor).toContainText("(mine)");

    await pointAndClick(window, answer.getByTestId("answer-added-undo"));
    // What was edited stays; Undo says it kept it.
    await expect(editor).toContainText("(mine)");
    await expect(window.getByTestId("undo-note")).toHaveText(w.kept);
    await app.close();
  });
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  for (const width of WIDTHS) {
    test(`Add to note never targets the example, and Add to “{note}” shows only for the User's own note, at ${width} px (${language})`, async () => {
      const { app, window } = await start(language, width, { examples: true });
      const example = await exampleTaken(window);

      const answer = await askInAssistant(window, w.question);
      const opening = await openingOf(answer);
      const add = answer.getByTestId("answer-add");
      // The example is in focus: Add to note doesn't name it, and asks where instead.
      await expect(answer.getByTestId("answer-add-label")).toHaveText(w.plain);
      await expect(add).toHaveAttribute("title", w.choose);
      await pointAndClick(window, add);
      const picker = window.getByTestId("add-to-picker");
      await expect(picker).toBeVisible();
      const targets = await picker
        .getByTestId("add-to-option")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-target")));
      expect(targets).not.toContain(example.mindId);
      await window.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(example.editor).not.toContainText(opening);

      // ⌘⇧A with the example in focus asks which note too, and writes nothing into it.
      await pointAndClick(window, answer.getByTestId("assistant-answer-text"));
      await window.keyboard.press("ControlOrMeta+Shift+A");
      await expect(picker).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(example.editor).not.toContainText(opening);

      // Write as a note makes the User's own note, and leaves the example as it was.
      await pointAndClick(window, answer.getByTestId("answer-write-note"));
      await expect(window.getByTestId("mind-tab")).toHaveCount(2);
      await expect(frontMind(window).getByTestId("mind-editor")).toContainText(opening);
      await expect(example.tab).not.toHaveAttribute("aria-selected", "true");
      await pointAndClick(window, example.tab);
      await expect(example.editor).not.toContainText(opening);

      // A note of the User's own, empty: Add to note names it.
      await newMind(window);
      await nameMind(window, w.note);
      const empty = await askInAssistant(window, w.question);
      await expect(empty.getByTestId("answer-add-label")).toHaveText(w.named(w.note));
      await app.close();
    });
  }
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  test(`a note made from an Answer lists its chat in its ⋯, which opens it, and History lists that chat under the note's title, also closed and after a restart (${language})`, async () => {
    const { app, window } = await start(language, 1600);
    const answer = await askInAssistant(window, w.question);
    await pointAndClick(window, answer.getByTestId("answer-write-note"));
    await expect(frontMindName(window)).not.toHaveText(/^(Untitled|未命名)$/);
    const noteName = ((await frontMindName(window).textContent()) ?? "").trim();
    expect(noteName).not.toBe("");

    const menu = await openPageMenu(window);
    const chat = menu.getByTestId("mind.openChat");
    await expect(chat).toHaveText(w.chat);
    await pointAndClick(window, chat);
    await expect(menu).toHaveCount(0);
    await expect(window.getByTestId("assistant-question").last()).toContainText(w.question);

    // Closed, the note's title stays in History, read from what is stored for the note.
    await pointAndClick(
      window,
      window.getByRole("tab", { selected: true }).getByTestId("tab-close"),
    );
    await expect(window.getByTestId("mind-tab")).toHaveCount(0);
    await pointAndClick(window, window.getByTestId("assistant-title"));
    const rows = window
      .getByTestId("assistant-history-popover")
      .getByTestId("assistant-history-row");
    await expect(rows).toHaveCount(1);
    // Under the note's title, not the first Question's words.
    await expect(rows.first()).toContainText(noteName);
    await expect(rows.first()).not.toContainText(w.question);
    await app.close();

    // Restarted on the same data, the note is there before it is opened: its stored link names it.
    const again = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(again.window);
    await setLanguage(again.window, language);
    await pointAndClick(again.window, again.window.getByTestId("assistant-title"));
    await expect(
      again.window
        .getByTestId("assistant-history-popover")
        .getByTestId("assistant-history-row")
        .first(),
    ).toContainText(noteName);
    await again.app.close();
  });
}

test("two notes from one chat name it by the first, and deleting that one moves to the next", async () => {
  const { app, window } = await start("en", 1600);
  const first = await askInAssistant(window, "When do spring tides happen?");
  await pointAndClick(window, first.getByTestId("answer-write-note"));
  await expect(frontMindName(window)).not.toHaveText(/^(Untitled|未命名)$/);
  await nameMind(window, "First note");
  const second = await askInAssistant(window, "Why are neap tides weaker?");
  await pointAndClick(window, second.getByTestId("answer-write-note"));
  await expect(frontMindName(window)).not.toHaveText(/^(Untitled|未命名)$/);
  await nameMind(window, "Second note");

  const history = async () => {
    await pointAndClick(window, window.getByTestId("assistant-title"));
    const rows = window
      .getByTestId("assistant-history-popover")
      .getByTestId("assistant-history-row");
    await expect(rows).toHaveCount(1);
    return rows.first();
  };
  await expect(await history()).toContainText("First note");
  await window.keyboard.press("Escape");

  // Deleted, the first note no longer names the chat: the second does.
  await pointAndClick(window, window.getByTestId("mind-tab").filter({ hasText: "First note" }));
  await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.delete"));
  await expect(window.getByTestId("mind-tab")).toHaveCount(1);
  await expect(await history()).toContainText("Second note");
  await app.close();
});

test("a note the assistant wrote is named in History by its title once its tab is closed", async () => {
  const { app, window } = await start("en", 1600);
  // A note with text in front, so the assistant's request writes a new note of its own.
  await noteWithText(window, "Harbour notes");
  await askInAssistant(window, "Write a summary of my leases");
  const made = window.getByTestId("mind-tab").filter({ hasText: "Summary" });
  await expect(made).toHaveCount(1, { timeout: 15_000 });
  await pointAndClick(window, made);
  await expect(made).toHaveAttribute("aria-selected", "true");
  await pointAndClick(window, made.getByTestId("tab-close"));
  await pointAndClick(window, window.getByTestId("assistant-title"));
  await expect(
    window.getByTestId("assistant-history-popover").getByTestId("assistant-history-row").first(),
  ).toContainText("Summary");
  await app.close();
});

for (const language of LANGUAGES) {
  const w = WORDS[language];

  for (const width of WIDTHS) {
    test(`an empty note keeps the start guide until the first-run card has been seen, and loses it after, at ${width} px (${language})`, async () => {
      const { app, window } = await start(language, width, { examples: true });
      const example = await exampleTaken(window);
      // The card has been seen, so no second guide in the User's own empty note.
      await newMind(window);
      const guide = window.getByTestId("start-guide");
      await expect(guide).toHaveCount(0);

      // A device where the card never showed keeps the guide; showing it takes the guide away.
      await pointAndClick(window, example.tab.getByTestId("tab-close"));
      await markSteps(window, { seen: false });
      await newMind(window);
      const emptyId = await frontMind(window).getAttribute("data-mind-id");
      await expect(guide).toBeVisible();
      await expect(guide).toContainText(w.startGuide);
      await expect(guide).toContainText(w.connectApp);
      await pointAndClick(
        window,
        window.getByTestId("mind-list-item").filter({ has: window.getByTestId("example-chip") }),
      );
      await expect(window.getByTestId("first-open-steps")).toBeVisible();
      await pointAndClick(
        window,
        window.locator(`[data-testid="mind-tab"][data-mind-id="${emptyId}"]`),
      );
      await expect(guide).toHaveCount(0);
      await app.close();
    });
  }
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  for (const width of WIDTHS) {
    test(`from a first Answer to a Word file takes eight steps or fewer, by mouse and by keyboard, at ${width} px (${language})`, async () => {
      const { app, window } = await start(language, width);
      await useOutputLocation(window, sources);
      await newMind(window);
      const answer = await askInAssistant(window, w.question);
      const opening = await openingOf(answer);
      const write = answer.getByTestId("answer-write-note");
      const done = window.getByTestId("export-result").getByTestId("export-done");

      // By mouse: Write as a note, Export, Word.
      let steps = 0;
      const click = async (target: Locator) => {
        steps++;
        await pointAndClick(window, target);
      };
      await click(write);
      await click(window.getByTestId("export-mind"));
      await click(window.getByTestId("export-menu").getByTestId("export-as-docx"));
      await expect(done).toBeVisible();
      expect(steps, "the mouse path's steps").toBeLessThanOrEqual(8);

      // By keyboard: ⌘K writes the last Answer as a note, then ⇧⌘E exports it as Word.
      let keys = 0;
      const press = async (key: string) => {
        keys++;
        await window.keyboard.press(key);
      };
      const back = await askInAssistant(window, w.question);
      await press("ControlOrMeta+k");
      keys++; // typing the command's name
      await window.keyboard.type(w.write);
      const entry = window
        .getByTestId("palette")
        .locator('[data-key="command:assistant.writeNote"]');
      await expect(entry).toBeVisible();
      await expect(entry).toHaveAttribute("aria-selected", "true");
      await press("Enter");
      // The first note was empty, so the mouse path filled it; this Answer makes the second.
      await expect(window.getByTestId("mind-tab")).toHaveCount(2);
      await expect(frontMind(window).getByTestId("mind-editor")).toContainText(opening);
      await expect(back.getByTestId("answer-added")).toBeVisible();
      await press("ControlOrMeta+Shift+E");
      await expect(done).toBeVisible();
      expect(keys, "the keyboard path's steps").toBeLessThanOrEqual(8);

      // Both exports wrote their Word file.
      await expect
        .poll(async () => (await readdir(sources)).filter((name) => name.endsWith(".docx")).length)
        .toBe(2);
      await app.close();
    });
  }
}
