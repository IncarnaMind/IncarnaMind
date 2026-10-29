import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A write that does all the User asked ends the Answer with what it wrote (#1635): the change's
 * line is the whole Answer, "Wrote 1 paragraph · Undo", with no reply under it. When the write's
 * check flags a sentence the line counts it before Undo, "Wrote 2 paragraphs · 1 needs a look ·
 * Undo", in the panel and in the page, and the count shows that sentence with its card. The
 * scripted model (src/main/fakeChat/minds.ts) cites the spring tides line and adds it, with a
 * sentence its check finds unsupported for the notes. Set INCARNAMIND_SCREENSHOTS to a folder to
 * also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES =
  "# Tides\n\nSpring tides come at new and full moon, when the Sun and the Moon pull together.\n";

const WORDS = {
  en: {
    line: "Add the tide line",
    notes: "Add the tide notes",
    reply: "Add the tide line, then reply",
    wroteOne: "Wrote 1 paragraph",
    wroteTwo: "Wrote 2 paragraphs",
    titleOne: "Wrote 1 paragraph in",
    titleTwo: "Wrote 2 paragraphs in",
    look: "1 needs a look",
  },
  "zh-CN": {
    line: "加上潮汐那一句",
    notes: "加上潮汐笔记",
    reply: "加上潮汐那一句，然后回复",
    wroteOne: "写入了 1 个段落",
    wroteTwo: "写入了 2 个段落",
    titleOne: "中已写入 1 个段落",
    titleTwo: "中已写入 2 个段落",
    look: "1 处需要留意",
  },
} as const;

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

async function inNewNote(window: Page) {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Notes on the tides.");
  await expect(editor).toContainText("Notes on the tides.");
  return editor;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a write that does all asked ends with its line, which counts what needs a look and shows it (${language})`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Tides.md"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Tides.md")]);

    // Before #1635, every write was followed by a reply: the model still writes one when it
    // doesn't say it is done.
    let editor = await inNewNote(window);
    const replied = await askInAssistant(window, words.reply);
    await expect(replied.getByTestId("assistant-answer-text")).toBeVisible();
    await screenshot(window, `write-ends-reply-${language}`);

    // A clean write: the line is the whole Answer, with no count.
    editor = await inNewNote(window);
    const clean = await askInAssistant(window, words.line);
    await expect(clean.getByTestId("mind-changes-title")).toContainText(words.titleOne);
    await expect(clean.getByTestId("mind-changes-undo")).toBeVisible();
    await expect(clean.getByTestId("assistant-answer-text")).toHaveCount(0);
    await expect(clean.getByTestId("mind-changes-look")).toHaveCount(0);
    const cleanLine = editor.getByTestId("applied-line");
    await expect(cleanLine.getByTestId("applied-count")).toHaveText(words.wroteOne);
    await expect(cleanLine.getByTestId("applied-look")).toHaveCount(0);
    await screenshot(window, `write-ends-clean-${language}`);

    // A write with a sentence its check flagged: the line counts it before Undo, in both places.
    editor = await inNewNote(window);
    const flagged = await askInAssistant(window, words.notes);
    await expect(flagged.getByTestId("assistant-answer-text")).toHaveCount(0);
    await expect(flagged.getByTestId("mind-changes-title")).toContainText(words.titleTwo);
    await expect(flagged.getByTestId("mind-changes-look")).toHaveText(words.look);
    const line = editor.getByTestId("applied-line");
    await expect(line.getByTestId("applied-count")).toHaveText(words.wroteTwo);
    await expect(line.getByTestId("applied-look")).toHaveText(words.look);
    const order = await line.evaluate((element) =>
      [...element.querySelectorAll("[data-testid]")].map((each) =>
        each.getAttribute("data-testid"),
      ),
    );
    expect(order.indexOf("applied-look")).toBeLessThan(order.indexOf("applied-undo"));
    await screenshot(window, `write-ends-flagged-${language}`);
    // At a narrow window the panel's line wraps with the count beside its dot.
    await setWindowSize(app, window, 900, 720);
    await expect(flagged.getByTestId("mind-changes-look")).toBeVisible();
    await screenshot(window, `write-ends-flagged-${language}-narrow`);
    await setWindowSize(app, window, 1440, 900);

    // The count shows the flagged sentence, its card open, from the panel and from the page.
    await pointAndClick(window, flagged.getByTestId("mind-changes-look"));
    const card = window.getByTestId("claim-card");
    await expect(card).toBeVisible();
    const caretIn = () =>
      window.evaluate(
        () => getSelection()?.anchorNode?.parentElement?.closest("p")?.textContent ?? "",
      );
    await expect.poll(caretIn).toContain("no reason");
    await screenshot(window, `write-ends-look-${language}`);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await editor.click();
    await window.keyboard.press("ControlOrMeta+Home");
    await pointAndClick(window, line.getByTestId("applied-look"));
    await expect(card).toBeVisible();
    await expect.poll(caretIn).toContain("no reason");
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // By keyboard: Tab reaches the panel's count, and Enter opens the card with the focus in it.
    const count = flagged.getByTestId("mind-changes-look");
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    const focused = () => count.evaluate((element) => element === document.activeElement);
    for (let presses = 0; presses < 20 && !(await focused()); presses++) {
      await window.keyboard.press("Shift+Tab");
    }
    await expect(count).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(card).toBeVisible();
    await expect
      .poll(() => card.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await window.keyboard.press("Escape");

    // Once the flagged sentence is gone, the count goes: it never stays to lead nowhere.
    await editor.getByText("no reason", { exact: false }).click({ clickCount: 3 });
    await window.keyboard.press("Backspace");
    await expect(editor).not.toContainText("no reason");
    await expect(count).toHaveCount(0, { timeout: 15_000 });
  });
}
