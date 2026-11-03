import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  placeAssistant,
  pointAndClick,
  removeDataFolder,
  setGroupBeside,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * The composer with long text (DESIGN.md, Composer › Height; the canvas
 * boards Final-54 and Final-63): short text sits beside the controls; once it
 * runs past one line it takes the full width and the controls go in a row
 * under it (#214). It grows to 8 lines then scrolls; from 4 lines Expand opens
 * a tall editor and Esc returns; a long paste is a chip that can be put back,
 * viewed, or saved as a Document that Answers cite (#117). Driven as a person
 * would. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const PARAGRAPHS = {
  en: "Dr Hale sent her comments this morning and I want every one of them answered from my own Documents. Quote the passage that answers each comment and give the page, and if nothing in my Documents answers it, say so plainly rather than guessing, because I will reply to her before Thursday.",
  "zh-CN":
    "黑尔博士今天早上发来了她的意见，我希望每一条都能根据我自己的文档来回答。请引用回答每条意见的段落并注明页码；如果我的文档里没有任何内容能回答，请直接说明，不要猜测，因为我周四之前就要回复她。",
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

const bridge = (window: Page) => ({
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
});

async function newMind(window: Page, title: string) {
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  await nameMind(window, title);
  await enterContent(window);
  await window.keyboard.type("Notes.");
}

/** The widths that matter: the text field's against the composer's inside, and where the controls are. */
async function layoutOf(composer: Locator) {
  return composer.evaluate((element) => {
    const box = (selector: string) =>
      element.querySelector(selector)?.getBoundingClientRect() ?? null;
    const outer = element.getBoundingClientRect();
    const input = box('[data-testid="composer-input"]');
    const controls = box(".composer-controls");
    if (!input || !controls) throw new Error("The composer has no input or controls.");
    return {
      outerLeft: outer.left,
      outerRight: outer.right,
      inputLeft: input.left,
      inputRight: input.right,
      inputTop: input.top,
      inputBottom: input.bottom,
      controlsTop: controls.top,
      controlsRight: controls.right,
    };
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`long text uses the full width of the composer, and the controls go under it, at a narrow and a wide window, with and without the viewer (${language})`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await bridge(window).language(language);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window, "Long text");
    const composer = window.getByTestId("composer");
    const input = composer.getByTestId("composer-input");

    for (const [width, viewer] of [
      [1440, false],
      [1440, true],
      [1000, false],
      [1000, true],
    ] as const) {
      await setWindowSize(app, window, width, 900);
      // Docked on the right in the wide window; at the bottom in the narrow one, where the
      // card keeps the room for the viewer beside the Mind (#253).
      await placeAssistant(window, { dock: width < 1400 ? "bottom" : "right" });
      await setGroupBeside(window, viewer);
      await pointAndClick(window, input);
      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.press("Backspace");

      // One short line: beside the controls, as on Final-63.
      await window.keyboard.type(language === "en" ? "Why?" : "为什么？");
      let layout = await layoutOf(composer);
      // (Beside the controls only where the composer has the room: with the viewer open at
      // the narrow size it is about 380px, and the controls are under even an empty field.)
      const roomy = layout.outerRight - layout.outerLeft > 520;
      if (roomy) {
        expect(layout.controlsTop, `${width} ${viewer} short`).toBeLessThan(layout.inputBottom);
        expect(layout.inputRight).toBeLessThan(layout.controlsRight - 60);
      }

      // A long paragraph: the full width, the controls in a row under it, as on Final-54.
      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.type(PARAGRAPHS[language]);
      layout = await layoutOf(composer);
      expect(layout.controlsTop).toBeGreaterThanOrEqual(layout.inputBottom - 1);
      // The text field reaches the composer's right edge (its padding aside): no column reserved.
      expect(layout.outerRight - layout.inputRight).toBeLessThanOrEqual(12);
      expect(layout.inputLeft - layout.outerLeft).toBeLessThanOrEqual(20);
      // The Ask button is at the right end of its own row.
      expect(layout.outerRight - layout.controlsRight).toBeLessThanOrEqual(12);
      // Every line of it is inside the field: the last word is as far right as the field allows.
      const widest = await input.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return Math.max(...[...range.getClientRects()].map((rect) => rect.right));
      });
      expect(widest).toBeLessThanOrEqual(layout.inputRight + 1);
      await screenshot(window, `composer-long-${language}-${width}${viewer ? "-viewer" : ""}`);

      // Deleted back to a few words, it goes beside the controls again.
      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.type(language === "en" ? "Again" : "再问");
      layout = await layoutOf(composer);
      if (roomy) expect(layout.controlsTop).toBeLessThan(layout.inputBottom);
    }
    await app.close();
  });
}

test("the composer grows to 8 lines then scrolls; from 4 lines Expand opens a tall editor and Esc returns", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window, "Growing");
  const composer = window.getByTestId("composer");
  const input = composer.getByTestId("composer-input");
  const expand = composer.getByTestId("composer-expand");
  const height = async () => Math.round((await input.boundingBox())?.height ?? 0);

  await pointAndClick(window, input);
  await expect(expand).toHaveCount(0);
  const one = await height();
  for (const line of ["one", "two", "three"]) {
    await window.keyboard.type(line);
    await window.keyboard.press("Shift+Enter");
  }
  // Three lines and a caret on a fourth: Expand appears at 4 lines.
  await expect(expand).toBeVisible();
  const four = await height();
  expect(four).toBeGreaterThan(one + 40);
  for (let line = 0; line < 8; line++) {
    await window.keyboard.type("more");
    await window.keyboard.press("Shift+Enter");
  }
  // Eight lines at 20px and 8px of padding, then it scrolls.
  expect(await height()).toBeLessThanOrEqual(168);
  expect(await input.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await screenshot(window, "composer-eight-lines");

  // Expand: a tall editor; the text keeps the focus; Esc returns it, the next Esc goes to the note.
  await pointAndClick(window, expand);
  await expect(composer).toHaveAttribute("data-expanded", "true");
  await expect(input).toBeFocused();
  // Over the lower 60% of the window (styles.css), as tall as the screen lets the window be.
  const tall = await window.evaluate(() => Math.floor(globalThis.innerHeight * 0.6 - 128));
  expect(await height()).toBeGreaterThanOrEqual(tall);
  expect(await height()).toBeGreaterThan(168);
  await screenshot(window, "composer-expanded");
  await window.keyboard.press("Escape");
  await expect(composer).not.toHaveAttribute("data-expanded", "true");
  await expect(input).toBeFocused();
  expect(await height()).toBeLessThanOrEqual(168);
  await window.keyboard.press("Escape");
  await expect(input).not.toBeFocused();
  await app.close();
});

/** Puts text on the clipboard and pastes it with the keyboard, as a person would. */
async function paste(app: ElectronApplication, window: Page, text: string) {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  await window.keyboard.press("ControlOrMeta+v");
}

const LONG_PASTE = Array.from(
  { length: 74 },
  (_, line) =>
    `${line + 1}. Spring tides happen at new moon and at full moon, and the harbour master logs entry ${line + 1}.`,
).join("\n");

test("a long paste becomes a chip that can be viewed, put back, or saved as a Document that is cited", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window, "Pastes");
  const composer = window.getByTestId("composer");
  const input = composer.getByTestId("composer-input");
  const chip = composer.getByTestId("composer-paste");
  await pointAndClick(window, input);

  // A short paste stays text; a long one is a chip, and not in the text.
  await paste(app, window, "A short line.");
  await expect(input).toHaveValue("A short line.");
  await expect(chip).toHaveCount(0);
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.press("Backspace");
  await paste(app, window, LONG_PASTE);
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("Pasted text · 74 lines");
  await expect(input).toHaveValue("");
  await expect(composer.getByTestId("composer-ask")).toBeEnabled();

  // Its menu: View, Put back in the text, Save as a Document.
  await pointAndClick(window, composer.getByTestId("composer-paste-menu-button"));
  const menu = window.getByTestId("composer-paste-menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "View",
    "Put back in the text",
    /Save as a Document/,
  ]);
  await screenshot(window, "composer-paste-menu");
  await pointAndClick(window, menu.getByTestId("paste-view"));
  const view = window.getByTestId("composer-paste-view");
  await expect(view).toContainText("74. Spring tides");
  await window.keyboard.press("Escape");
  await expect(view).toHaveCount(0);

  // Put back in the text: the chip goes, the words are in the field.
  await pointAndClick(window, composer.getByTestId("composer-paste-menu-button"));
  await pointAndClick(window, menu.getByTestId("paste-put-back"));
  await expect(chip).toHaveCount(0);
  await expect(input).toHaveValue(LONG_PASTE);
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.press("Backspace");

  // Paste again and save it as a Document: the chip becomes a Document in the Search scope.
  await paste(app, window, LONG_PASTE);
  await pointAndClick(window, composer.getByTestId("composer-paste-menu-button"));
  await pointAndClick(window, menu.getByTestId("paste-save"));
  await expect(chip).toHaveCount(0);
  await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
  await expect(composer.getByTestId("scope-chip")).toContainText("1. Spring tides");

  // Asked, its Answer cites the saved text, checked against it.
  await pointAndClick(window, input);
  await window.keyboard.type("When do spring tides happen?");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).first();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await app.close();
});

test("a pasted chip is asked with: its words go into the Question", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window, "Ask with a chip");
  const composer = window.getByTestId("composer");
  const input = composer.getByTestId("composer-input");
  await pointAndClick(window, input);
  await window.keyboard.type("Summarise this:");
  await paste(app, window, LONG_PASTE);
  await expect(composer.getByTestId("composer-paste")).toHaveCount(1);
  await window.keyboard.type(` ${PARAGRAPHS.en}`);
  await screenshot(window, "composer-chip-long");
  await pointAndClick(window, composer.getByTestId("composer-paste-menu-button"));
  await screenshot(window, "composer-chip-long-menu");
  await window.keyboard.press("Escape");
  await pointAndClick(window, input);
  await window.keyboard.press("Enter");
  const question = window.getByTestId("assistant-question");
  await expect(question).toContainText("Summarise this:");
  await expect(question).toContainText("74. Spring tides");
  await expect(composer.getByTestId("composer-paste")).toHaveCount(0);
  await app.close();
});
