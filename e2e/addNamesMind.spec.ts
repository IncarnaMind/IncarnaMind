import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  coreOf,
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
 * Under an Answer, Add to note names the Mind it adds to when the Mind is empty or the Answer is
 * a long one with Citations; the ▾ keeps the other Minds and New Mind. One tip says so on the
 * first Answer with Citations, at most twice on a device.
 */
const WORDS = {
  en: {
    mind: "Keyboard only",
    longMind: "Quarterly board pack for the harbour authority, revised after the audit review",
    typed: "Spring tides come twice a month.",
    short: "What do tides do",
    forty: "What do tides do with forty citations",
    named: (mind: string) => `Add to “${mind}”`,
    plain: "Add to note",
    added: (mind: string) => `Added to “${mind}”`,
    tip: "Write this as a note",
  },
  "zh-CN": {
    mind: "仅用键盘",
    longMind: "港务局董事会季度材料汇编：审计委员会审阅之后的修订版及附件说明",
    typed: "大潮每个月出现两次。",
    short: "tides 是什么",
    forty: "四十条引用 tides",
    named: (mind: string) => `添加到“${mind}”`,
    plain: "添加到笔记",
    added: (mind: string) => `已添加到“${mind}”`,
    tip: "把这条写成笔记",
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

async function start(language: Language, examples = false) {
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

const center = async (target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
};

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

  test(`in an empty Mind, Add to note names the Mind and comes first; nothing is written until it is pressed, and Undo and ⌘Z take it out (${language})`, async () => {
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

    // New Mind would fill this same empty Mind, so it isn't offered beside the named button.
    await expect(answer.getByTestId("answer-new-mind")).toHaveCount(0);

    const editor = editorOf(window);
    await expect(editor).toHaveText("");

    // The other Minds and New Mind stay behind the ▾.
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

  test(`in a Mind with text, only a long Answer with Citations names the Mind; a short one keeps Copy first (${language})`, async () => {
    const { app, window } = await start(language);
    await mindWithText(window, w.mind, w.typed);

    const short = await askInAssistant(window, w.short);
    await pointAt(window, short.getByTestId("assistant-answer-text"));
    await expect(short.getByTestId("answer-add")).toHaveText(w.plain);
    expect((await center(short.getByTestId("answer-copy"))).x).toBeLessThan(
      (await center(short.getByTestId("answer-add"))).x,
    );

    const long = await askInAssistant(window, w.forty, { timeout: 120_000 });
    await pointAt(window, long.getByTestId("assistant-answer-text"));
    await expect(long.getByTestId("answer-add")).toHaveText(w.named(w.mind));
    expect((await center(long.getByTestId("answer-add"))).x).toBeLessThan(
      (await center(long.getByTestId("answer-copy"))).x,
    );
    for (const each of [short, long]) {
      await pointAt(window, each.getByTestId("assistant-answer-text"));
      expect((await center(each.getByTestId("answer-add-to"))).x).toBeLessThan(
        (await center(each.getByTestId("answer-new-mind"))).x,
      );
    }
    await pointAndClick(window, long.getByTestId("answer-add"));
    await expect(long.getByTestId("answer-added")).toContainText(w.added(w.mind));
    await app.close();
  });

  test(`at 320 and 280 px Copy and New Mind keep only their icons, with names and tooltips, so the named Add to note keeps its whole name; wider, they say their words (${language})`, async () => {
    const { app, window } = await start(language);
    await mindWithText(window, w.mind, w.typed);
    const answer = await askInAssistant(window, w.forty, { timeout: 120_000 });
    const add = answer.getByTestId("answer-add");
    const more = answer.getByTestId("answer-add-to");
    const copy = answer.getByTestId("answer-copy");
    const newMind = answer.getByTestId("answer-new-mind");
    const label = (button: Locator) => button.locator(".assistant-answer-action-label");

    for (const width of [320, 280]) {
      await sizeAssistant(window, width);
      await pointAt(window, answer.getByTestId("assistant-answer-text"));
      await expect(add, `named at ${width}`).toHaveText(w.named(w.mind));
      expect(
        await answer
          .getByTestId("answer-add-label")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
        `the name isn't cut at ${width}`,
      ).toBe(true);
      for (const button of [copy, newMind]) {
        await expect(label(button)).toBeHidden();
        await expect(button).toHaveAttribute("aria-label", /\S/);
        await expect(button).toHaveAttribute("title", /\S/);
        expect((await center(button)).width, `icon-only at ${width}`).toBeLessThanOrEqual(28);
      }
      const boxes = await Promise.all([add, more, copy, newMind].map(center));
      for (const [at, box] of boxes.entries()) {
        expect(Math.abs(box.y - (boxes[0]?.y ?? 0)), `one row at ${width}`).toBeLessThan(2);
        const next = boxes[at + 1];
        if (next) expect(box.x + box.width).toBeLessThanOrEqual(next.x + 1);
      }
      const thread = await center(window.getByTestId("assistant-thread"));
      const last = boxes[3];
      expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(thread.x + thread.width);
    }

    await more.focus();
    await window.keyboard.press("Shift+Tab");
    for (const button of [add, more, copy, newMind]) {
      await expect(button).toBeFocused();
      expect(await focusRingShows(window)).toBe(true);
      await window.keyboard.press("Tab");
    }

    await sizeAssistant(window, 420);
    await pointAt(window, answer.getByTestId("assistant-answer-text"));
    for (const button of [copy, newMind]) await expect(label(button)).toBeVisible();
    await expect(add).toHaveText(w.named(w.mind));
    await app.close();
  });

  test(`with no Mind open, Add to note is not named and asks which Mind (${language})`, async () => {
    const { app, window } = await start(language);
    await pointAndClick(window, window.getByTestId("open-library"));
    await expect(window.getByTestId("mind-tab")).toHaveCount(0);
    const answer = await askInAssistant(window, w.forty, { timeout: 120_000 });
    await pointAt(window, answer.getByTestId("assistant-answer-text"));
    await expect(answer.getByTestId("answer-add")).toHaveText(w.plain);
    await pointAndClick(window, answer.getByTestId("answer-add"));
    await expect(window.getByTestId("add-to-picker")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("tip")).toHaveCount(0);
    await app.close();
  });

  test(`by keyboard the named button is the first stop, shows its focus and adds with Enter, and focus lands on Undo (${language})`, async () => {
    const { app, window } = await start(language);
    await emptyMind(window, w.mind);
    const answer = await askInAssistant(window, w.short);
    const add = answer.getByTestId("answer-add");
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

  test(`the tip shows under the first own Answer with no own note; ✕ closes it and it never shows again (${language})`, async () => {
    const { app, window } = await start(language, true);
    await window.getByTestId("first-open-ready").click();
    await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done");
    await expect(window.getByTestId("tip")).toHaveCount(0);
    const answer = await askInAssistant(window, w.short);
    const tip = window.getByTestId("tip");
    await expect(tip).toHaveText(w.tip);
    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 800);
      await expect(tip).toBeVisible();
      const box = await center(tip);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await setWindowSize(app, window, 1440, 900);
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
    await newMind(window);
    await expect(window.getByTestId("start-connect-app")).toHaveCount(0);
    await newMind(window);
    await expect(window.getByTestId("start-connect-app")).toBeVisible();
    await app.close();
  });

  test(`the line for the tip is kept while the Answer is written, so nothing moves when the tip comes (${language})`, async () => {
    const { app, window } = await start(language);
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
    await (await coreOf(window)).evaluate((core) => core.updateSettings({ device: { tips: { "add-answer": 1 } } }));
    await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(1);
    expect(await (await coreOf(window)).evaluate(async (core) => (await core.getSettings()).device.tips["add-answer"])).toBe(2);

    await reload(window);
    await expect(window.getByTestId("tip")).toHaveCount(0);
    await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(0);

    await reload(window);
    await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(0);
    await expect(window.getByTestId("tip-room")).toHaveCount(0);
    await app.close();
  });

  test(`Write this as a note performs the existing new-note action by keyboard and closes the tip (${language})`, async () => {
    const { app, window } = await start(language);
    const answer = await askInAssistant(window, w.short);
    const write = window.getByTestId("tip-write-note");
    await expect(write).toHaveText(w.tip);
    await write.focus();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("mind-editor")).toContainText(/tides/i);
    await expect(window.getByTestId("tip")).toHaveCount(0);
    await expect(answer).toHaveAttribute("data-status", "done");
    await reload(window);
    await askInAssistant(window, w.short);
    await expect(window.getByTestId("tip")).toHaveCount(0);
    await app.close();
  });
}
