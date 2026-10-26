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
  focusRingShows,
  frontMind,
  launchApp,
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
 * Citations, and the ▾ keeps the other Minds and New note. One tip says so on the first Answer
 * with Citations, at most twice on a device.
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
    plain: "Add to note",
    added: (mind: string) => `Added to “${mind}”`,
    tip: "Add it, and its Citations come too.",
  },
  "zh-CN": {
    mind: "仅用键盘",
    longMind: "港务局董事会季度材料汇编：审计委员会审阅之后的修订版及附件说明",
    typed: "大潮每个月出现两次。",
    short: "tides 是什么",
    long: "四条引用 tides",
    named: (mind: string) => `添加到“${mind}”`,
    write: "写成笔记",
    plain: "添加到笔记",
    added: (mind: string) => `已添加到“${mind}”`,
    tip: "添加后，引用会一起保留。",
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

async function start(language: Language) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await setLanguage(window, language);
  const path = join(sources, "Tides.pdf");
  await writeFile(
    path,
    buildPdf([{ lines: ["Tides and the Moon", "Every tides document says tides rise and fall."] }]),
  );
  await addDocuments(window, [path]);
  return { app, window };
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

const placeOf = async (window: Page, answer: Locator) => ({
  question: (await center(window.getByTestId("assistant-question").last())).y,
  answer: (await center(answer.getByTestId("assistant-answer-text"))).y,
});

/** A reload as a restart is for what the renderer remembers: only the core's settings stay. */
async function reload(window: Page) {
  await window.reload();
  await expect(window.getByTestId("composer")).toBeVisible();
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
    await expect(window.getByTestId("tip")).toHaveCount(0);
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

  test(`the tip shows under the first Answer with Citations; ✕ closes it and it never shows again (${language})`, async () => {
    const { app, window } = await start(language);
    await mindWithText(window, w.mind, w.typed);
    const answer = await askInAssistant(window, w.short);
    const tip = window.getByTestId("tip");
    await expect(tip).toHaveText(w.tip);
    const actions = await center(answer.getByTestId("answer-actions"));
    const shown = await center(tip);
    expect(shown.y).toBeGreaterThanOrEqual(actions.y + actions.height - 1);
    expect(shown.x + shown.width).toBeLessThanOrEqual(actions.x + actions.width + 40);
    // One line, at the default 320 px and at the narrowest 280 px.
    for (const width of [320, 280]) {
      await sizeAssistant(window, width);
      expect((await center(tip)).height, `one line at ${width}`).toBeLessThanOrEqual(24);
    }

    const before = await placeOf(window, answer);
    await pointAndClick(window, window.getByTestId("tip-close"));
    await expect(tip).toHaveCount(0);
    await expect(answer.getByTestId("answer-add")).toBeFocused();
    expect(await placeOf(window, answer), "closing the tip moves nothing").toEqual(before);
    await expect(window.getByTestId("tip-room")).toHaveCount(1);

    await reload(window);
    await askInAssistant(window, w.short);
    await expect(tip).toHaveCount(0);
    await app.close();
  });

  test(`the line for the tip is kept while the Answer is written, so nothing moves when the tip comes (${language})`, async () => {
    const { app, window } = await start(language);
    await mindWithText(window, w.mind, w.typed);
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type(`${w.short} slowly`);
    await window.keyboard.press("Enter");
    const rooms = window.getByTestId("assistant").getByTestId("tip-room");
    await expect(rooms).toHaveCount(1);
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "streaming");
    await expect(rooms).toHaveCount(1);
    const early = await center(rooms);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    const tip = window.getByTestId("tip");
    await expect(tip).toBeVisible();
    const late = await center(rooms);
    expect(late.height).toBe(early.height);
    const shown = await center(tip);
    expect(shown.y).toBeGreaterThanOrEqual(late.y - 1);
    expect(shown.y + shown.height).toBeLessThanOrEqual(late.y + late.height + 1);
    await app.close();
  });

  test(`the tip shows at most twice on a device, and an Answer already written gets none after a reload (${language})`, async () => {
    const { app, window } = await start(language);
    await mindWithText(window, w.mind, w.typed);
    await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(1);

    await reload(window);
    await expect(window.getByTestId("tip")).toHaveCount(0);
    await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(1);

    await reload(window);
    await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(0);
    await expect(window.getByTestId("tip-room")).toHaveCount(0);
    await app.close();
  });

  test(`using the button closes the tip, and it never shows again (${language})`, async () => {
    const { app, window } = await start(language);
    await emptyMind(window, w.mind);
    const answer = await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(1);
    const before = await placeOf(window, answer);
    await pointAt(window, answer.getByTestId("assistant-answer-text"));
    await pointAndClick(window, answer.getByTestId("answer-add"));
    await expect(answer.getByTestId("answer-added")).toContainText(w.added(w.mind));
    await expect(window.getByTestId("tip")).toHaveCount(0);
    expect(await placeOf(window, answer), "adding moves nothing").toEqual(before);
    await pointAndClick(window, answer.getByTestId("answer-added-undo"));
    await expect(answer.getByTestId("answer-add")).toBeVisible();
    expect(await placeOf(window, answer), "Undo moves nothing").toEqual(before);

    await reload(window);
    await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(0);
    await app.close();
  });
}
