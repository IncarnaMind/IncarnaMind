import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  center,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  focusRingShows,
  frontMind,
  launchApp,
  markSteps,
  nameMind,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sizeAssistant,
  tabTo,
} from "./app";

/**
 * Under an Answer, Write as a note comes first and names what it does; Add to note names the
 * Mind it adds to when the Mind is the User's and empty, or the Answer is a long one with
 * Citations, and the ▾ keeps the other Minds and New note. That button is the one way to do it.
 */
const WORDS = {
  en: {
    mind: "Keyboard only",
    longMind: "Quarterly board pack for the harbour authority, revised after the audit review",
    typed: "Spring tides come twice a month.",
    short: "What do tides do",
    long: "What do tides do with four citations",
    named: (mind: string) => `Add to “${mind}”`,
    write: "Write as a note",
    writeLabel: "Write this Answer as a note, beside it",
    tip: "Write this as a note",
    command: "Write the Answer as a note",
    plain: "Add to note",
    added: (mind: string) => `Added to “${mind}”`,
  },
  "zh-CN": {
    mind: "仅用键盘",
    longMind: "港务局董事会季度材料汇编：审计委员会审阅之后的修订版及附件说明",
    typed: "大潮每个月出现两次。",
    short: "tides 是什么",
    long: "四条引用 tides",
    named: (mind: string) => `添加到“${mind}”`,
    write: "写成笔记",
    writeLabel: "把这条回答写成笔记，在旁边打开",
    tip: "把这条写成笔记",
    command: "把回答写成笔记",
    plain: "添加到笔记",
    added: (mind: string) => `已添加到“${mind}”`,
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

async function start(language: Language, examples = false, { document = true } = {}) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources, examples });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await setLanguage(window, language);
  const path = join(sources, "Tides.pdf");
  await writeFile(
    path,
    buildPdf([{ lines: ["Tides and the Moon", "Every tides document says tides rise and fall."] }]),
  );
  if (document) await addDocuments(window, [path]);
  return { app, window, tides: path };
}

const editorOf = (window: Page) => frontMind(window).getByTestId("mind-editor");

async function emptyMind(window: Page, name: string) {
  await newMind(window);
  await nameMind(window, name);
}

async function mindWithText(window: Page, name: string, text: string) {
  await newMind(window);
  await window.keyboard.type(text);
  await nameMind(window, name);
}

for (const language of LANGUAGES) {
  const w = WORDS[language];

  test(`in an empty note, Write as a note comes first and Add to note names the note; nothing is written until it is pressed, and Undo and ⌘Z take it out (${language})`, async () => {
    const { app, window } = await start(language);
    await emptyMind(window, w.mind);
    const answer = await askInAssistant(window, w.short);
    await pointAt(window, answer.getByTestId("assistant-answer-text"));

    const add = answer.getByTestId("answer-add");
    await expect(add).toHaveText(w.named(w.mind));
    await expect(add).toHaveAttribute("title", new RegExp(w.mind));
    const [named, more, copy] = await Promise.all([
      center(add),
      center(answer.getByTestId("answer-add-to")),
      center(answer.getByTestId("answer-copy")),
    ]);
    expect(named.x).toBeLessThan(more.x);
    expect(more.x).toBeLessThan(copy.x);
    expect(Math.abs(named.y - copy.y)).toBeLessThan(2);

    // Write as a note comes first, labelled, before Add to note's named button.
    const write = answer.getByTestId("answer-write-note");
    await expect(write).toHaveText(w.write);
    expect((await center(write)).x).toBeLessThan((await center(add)).x);

    const editor = editorOf(window);
    await expect(editor).toHaveText("");

    // The other Minds and New note stay behind the ▾.
    await pointAndClick(window, answer.getByTestId("answer-add-to"));
    await expect(window.getByTestId("add-to-picker")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("add-to-picker")).toHaveCount(0);
    await expect(editor).toHaveText("");

    await pointAt(window, answer.getByTestId("assistant-answer-text"));
    await pointAndClick(window, add);
    await expect(answer.getByTestId("answer-added")).toContainText(w.added(w.mind));
    await expect(editor).not.toHaveText("");

    await pointAndClick(window, answer.getByTestId("answer-added-undo"));
    await expect(editor).toHaveText("");
    await expect(add).toHaveText(w.named(w.mind));

    await pointAt(window, answer.getByTestId("assistant-answer-text"));
    await pointAndClick(window, add);
    await expect(editor).not.toHaveText("");
    await pointAndClick(window, editor.locator(":scope > p").first());
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor).toHaveText("");
    await app.close();
  });

  test(`in a note with text, only a long Answer with Citations names the note; a short one leaves Add to note plain (${language})`, async () => {
    const { app, window } = await start(language);
    await mindWithText(window, w.mind, w.typed);

    const short = await askInAssistant(window, w.short);
    await pointAt(window, short.getByTestId("assistant-answer-text"));
    await expect(short.getByTestId("answer-add")).toHaveText(w.plain);
    expect((await center(short.getByTestId("answer-add"))).x).toBeLessThan(
      (await center(short.getByTestId("answer-copy"))).x,
    );

    const long = await askInAssistant(window, w.long);
    await pointAt(window, long.getByTestId("assistant-answer-text"));
    await expect(long.getByTestId("answer-add")).toHaveText(w.named(w.mind));
    expect((await center(long.getByTestId("answer-add"))).x).toBeLessThan(
      (await center(long.getByTestId("answer-copy"))).x,
    );
    for (const each of [short, long]) {
      await pointAt(window, each.getByTestId("assistant-answer-text"));
      expect((await center(each.getByTestId("answer-write-note"))).x).toBeLessThan(
        (await center(each.getByTestId("answer-add-to"))).x,
      );
      expect((await center(each.getByTestId("answer-add-to"))).x).toBeLessThan(
        (await center(each.getByTestId("answer-copy"))).x,
      );
    }
    await pointAndClick(window, long.getByTestId("answer-add"));
    await expect(long.getByTestId("answer-added")).toContainText(w.added(w.mind));
    await app.close();
  });

  test(`at 320 and 280 px Write as a note and Add to note keep their words, a long name is cut with its tooltip, and Copy keeps only its icon; wider, Copy says its word too (${language})`, async () => {
    const { app, window } = await start(language);
    await mindWithText(window, w.mind, w.typed);
    const answer = await askInAssistant(window, w.long);
    const write = answer.getByTestId("answer-write-note");
    const add = answer.getByTestId("answer-add");
    const more = answer.getByTestId("answer-add-to");
    const copy = answer.getByTestId("answer-copy");
    const label = (button: Locator) => button.locator(".assistant-answer-action-label");

    for (const width of [320, 280]) {
      await sizeAssistant(window, width);
      await pointAt(window, answer.getByTestId("assistant-answer-text"));
      await expect(write, `labelled at ${width}`).toHaveText(w.write);
      await expect(label(write)).toBeVisible();
      await expect(add, `named at ${width}`).toHaveText(w.named(w.mind));
      await expect(label(copy)).toBeHidden();
      await expect(copy).toHaveAttribute("aria-label", /\S/);
      await expect(copy).toHaveAttribute("title", /\S/);
      expect((await center(copy)).width, `icon-only at ${width}`).toBeLessThanOrEqual(28);
      const boxes = await Promise.all([write, add, more, copy].map(center));
      for (const [at, box] of boxes.entries()) {
        expect(Math.abs(box.y - (boxes[0]?.y ?? 0)), `one row at ${width}`).toBeLessThan(2);
        const next = boxes[at + 1];
        if (next) expect(box.x + box.width).toBeLessThanOrEqual(next.x + 1);
      }
      const thread = await center(window.getByTestId("assistant-thread"));
      const last = boxes[3];
      expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(thread.x + thread.width);
    }

    await write.focus();
    for (const button of [write, add, more, copy]) {
      await expect(button).toBeFocused();
      expect(await focusRingShows(window)).toBe(true);
      await window.keyboard.press("Tab");
    }

    await sizeAssistant(window, 420);
    await pointAt(window, answer.getByTestId("assistant-answer-text"));
    await expect(label(copy)).toBeVisible();
    await expect(write).toHaveText(w.write);
    await expect(add).toHaveText(w.named(w.mind));
    await app.close();
  });

  test(`with no Mind open, Add to note is not named and asks which Mind (${language})`, async () => {
    const { app, window } = await start(language);
    await pointAndClick(window, window.getByTestId("open-library"));
    await expect(window.getByTestId("mind-tab")).toHaveCount(0);
    const answer = await askInAssistant(window, w.long);
    await pointAt(window, answer.getByTestId("assistant-answer-text"));
    await expect(answer.getByTestId("answer-add")).toHaveText(w.plain);
    await pointAndClick(window, answer.getByTestId("answer-add"));
    await expect(window.getByTestId("add-to-picker")).toBeVisible();
    await window.keyboard.press("Escape");
    await app.close();
  });

  test(`by keyboard Write as a note is the first stop, then the named button, which adds with Enter, and focus lands on Undo (${language})`, async () => {
    const { app, window } = await start(language);
    await emptyMind(window, w.mind);
    const answer = await askInAssistant(window, w.short);
    const write = answer.getByTestId("answer-write-note");
    const add = answer.getByTestId("answer-add");
    await tabTo(window, write);
    await expect(write).toBeFocused();
    expect(await focusRingShows(window)).toBe(true);
    await tabTo(window, add);
    await expect(add).toBeFocused();
    expect(await focusRingShows(window)).toBe(true);
    await tabTo(window, answer.getByTestId("answer-add-to"));
    await tabTo(window, answer.getByTestId("answer-copy"));
    await tabTo(window, add);
    await window.keyboard.press("Enter");
    await expect(answer.getByTestId("answer-added")).toContainText(w.added(w.mind));
    await expect(answer.getByTestId("answer-added-undo")).toBeFocused();
    await app.close();
  });

  test(`a long Mind title is cut with the whole title in the tooltip, and the row holds at 320 and 280 px (${language})`, async () => {
    const { app, window } = await start(language);
    await emptyMind(window, w.longMind);
    const answer = await askInAssistant(window, w.short);
    await pointAt(window, answer.getByTestId("assistant-answer-text"));
    const add = answer.getByTestId("answer-add");
    await expect(add).toHaveAttribute("title", new RegExp(w.longMind));

    for (const width of [320, 280]) {
      await sizeAssistant(window, width);
      await pointAt(window, answer.getByTestId("assistant-answer-text"));
      const actions = answer.getByTestId("answer-actions");
      const label = answer.getByTestId("answer-add-label");
      expect(
        await label.evaluate((el) => el.scrollWidth > el.clientWidth),
        `the title is cut at ${width}`,
      ).toBe(true);
      const row = await center(actions);
      const [named, more, copy] = await Promise.all([
        center(add),
        center(answer.getByTestId("answer-add-to")),
        center(answer.getByTestId("answer-copy")),
      ]);
      expect(Math.abs(named.y - copy.y), `one row at ${width}`).toBeLessThan(2);
      expect(Math.abs(more.y - copy.y)).toBeLessThan(2);
      expect(named.x + named.width).toBeLessThanOrEqual(more.x + 1);
      expect(more.x + more.width).toBeLessThanOrEqual(copy.x + 1);
      expect(copy.x + copy.width).toBeLessThanOrEqual(row.x + row.width + 1);
      const thread = window.getByTestId("assistant-thread");
      expect(await thread.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await app.close();
  });

  test(`one control writes an Answer as a note: the action row's own, with no second link under it (${language})`, async () => {
    const { app, window, tides } = await start(language, true, { document: false });
    // Their own file, then their own Answer, in the example's Note: a first run's first Answer.
    await markSteps(window, { indexed: true });
    await expectReadyDocuments(window, 2);
    await window.getByTestId("first-open-ready").click();
    await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done");
    await addDocuments(window, [tides]);
    const answer = await askInAssistant(window, w.short);

    // One way to write it as a note: the action row's button, in the Answer's own row.
    const actions = answer.getByTestId("answer-actions");
    const write = actions.getByTestId("answer-write-note");
    await expect(write).toHaveText(w.write);
    await expect(answer.getByRole("button", { name: w.writeLabel })).toHaveCount(1);
    await expect(answer.getByTestId("answer-add-label")).toHaveText(w.plain);
    // One Write as a note on screen; the second link's words are gone, and stay gone past the
    // moment that link used to come in (it was offered once the Answer was done).
    await expect(answer.getByText(w.write, { exact: true })).toHaveCount(1);
    await expect
      .poll(
        async () => {
          await window.waitForTimeout(400);
          return answer.getByText(w.tip, { exact: true }).count();
        },
        { timeout: 10_000 },
      )
      .toBe(0);
    await expect(window.getByTestId("tip")).toHaveCount(0);

    // ⌘K reaches it too, by the words it does it by.
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(w.command);
    await expect(
      window.getByTestId("palette-item").filter({ hasText: w.command }).first(),
    ).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("palette")).toHaveCount(0);

    // And the keyboard alone makes the note.
    await write.focus();
    await window.keyboard.press("Enter");
    await expect(editorOf(window)).toContainText(/answer this/i);
    await expect(answer).toHaveAttribute("data-status", "done");
    await app.close();
  });
}
