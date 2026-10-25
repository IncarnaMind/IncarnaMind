import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  frontMindName,
  launchApp,
  nameMind,
  newMind,
  openPageMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useOutputLocation,
} from "./app";

/*
 * "Write as a note" (#1940): the first, labelled button under every Answer makes a note,
 * opens it beside, writes the Answer in with Undo; Add to note never targets the example;
 * the composer says what it can write; a note lists its chat in its ⋯ and History under its
 * title; and an empty note shows no second "Start in three steps" once the first-run card
 * has been seen. The scripted model answers from the Document, with a Citation.
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
    choose: "Choose a Mind to add it to",
    named: (note: string) => `Add to “${note}”`,
    added: (note: string) => `Added to “${note}”`,
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
    choose: "选择要添加到的 Mind",
    named: (note: string) => `添加到“${note}”`,
    added: (note: string) => `已添加到“${note}”`,
    placeholder: "提问，或说“写一篇关于……的笔记”",
    chat: "这篇笔记的对话",
    startGuide: "三步开始",
    connectApp: "连接应用…",
  },
} as const;
const LANGUAGES = ["en", "zh-CN"] as const;
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

const center = async (target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
};

/** The Answer's opening words, in the thread: what its note says too, whatever the model said. */
const openingOf = async (answer: Locator) =>
  ((await answer.getByTestId("assistant-answer-text").textContent()) ?? "").trim().slice(0, 20);

/** A note of the User's own, with text in it, so Write as a note makes another beside it. */
async function noteWithText(window: Page, name: string) {
  await newMind(window);
  await window.keyboard.type("Harbour notes");
  await nameMind(window, name);
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  for (const width of [900, 1600]) {
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

  test(`Add to note never targets the example, and Add to “{note}” shows only for the User's own note (${language})`, async () => {
    const { app, window } = await start(language, 1600, { examples: true });
    // The first-run card opens on the example note: the card has been seen.
    await expect(window.getByTestId("first-open-steps")).toBeVisible();
    const exampleId = await frontMind(window).getAttribute("data-mind-id");
    const exampleTab = window.locator(`[data-testid="mind-tab"][data-mind-id="${exampleId}"]`);
    const exampleEditor = window
      .locator(`[data-testid="mind-pane"][data-mind-id="${exampleId}"]`)
      .getByTestId("mind-editor");

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
    expect(targets).not.toContain(exampleId);
    await window.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(exampleEditor).not.toContainText(opening);

    // Write as a note makes the User's own note, and leaves the example as it was.
    await pointAndClick(window, answer.getByTestId("answer-write-note"));
    await expect(window.getByTestId("mind-tab")).toHaveCount(2);
    await expect(frontMind(window).getByTestId("mind-editor")).toContainText(opening);
    await expect(exampleTab).not.toHaveAttribute("aria-selected", "true");
    await pointAndClick(window, exampleTab);
    await expect(exampleEditor).not.toContainText(opening);

    // A note of the User's own, empty: Add to note names it.
    await newMind(window);
    await nameMind(window, w.note);
    const empty = await askInAssistant(window, w.question);
    await expect(empty.getByTestId("answer-add-label")).toHaveText(w.named(w.note));
    await app.close();
  });
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  test(`a note made from an Answer lists its chat in its ⋯, which opens it, and History lists that chat under the note's title (${language})`, async () => {
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

    await pointAndClick(window, window.getByTestId("assistant-title"));
    const rows = window
      .getByTestId("assistant-history-popover")
      .getByTestId("assistant-history-row");
    await expect(rows).toHaveCount(1);
    // Under the note's title, not the first Question's words.
    await expect(rows.first()).toContainText(noteName);
    await expect(rows.first()).not.toContainText(w.question);
    await app.close();
  });
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  for (const width of [900, 1600]) {
    test(`an empty note of the User's own shows no second start guide and no Connect an app, once the first-run card has been seen, at ${width} px (${language})`, async () => {
      const { app, window } = await start(language, width, { examples: true });
      await expect(window.getByTestId("first-open-steps")).toBeVisible();
      await newMind(window);
      const editor = frontMind(window).getByTestId("mind-editor");
      await expect(window.getByTestId("start-guide")).toHaveCount(0);
      await expect(window.getByTestId("first-open-steps")).toBeHidden();
      await expect(editor).not.toContainText(w.startGuide);
      await expect(editor).not.toContainText(w.connectApp);
      await app.close();
    });
  }
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  test(`from a first Answer to a Word file takes eight steps or fewer, by mouse and by keyboard (${language})`, async () => {
    const { app, window } = await start(language, 1600);
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
    const entry = window.getByTestId("palette").locator('[data-key="command:assistant.writeNote"]');
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
