import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  newMind,
  paletteFound,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  stubClipboard,
} from "./app";

/**
 * "Ask about this" (#101): words selected in a Document go into the composer as a quote chip,
 * from the selection menu, ⌘J or ⌘K; the Question keeps them above its own words, and the chip
 * goes with × or Backspace.
 */

const REPEATED = "Margins recover within two quarters.";
const PAPER = buildPdf([
  { lines: ["Grocers studied across the eleven chains.", REPEATED] },
  { lines: ["Pooling the cuts, the recovery peaks in the second quarter.", REPEATED] },
]);

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  home = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

/**
 * The app with the scripted model (none set up with `model: false`), the paper beside a new
 * Mind, and a page's text layer.
 */
async function paperBesideMind({ model = true, name = "Rate cuts", width = 1440 } = {}) {
  const path = join(sources, `${name}.pdf`);
  await writeFile(path, PAPER);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, width, 900);
  await dismissChatSetup(window);
  if (model) await connectLocalChatModel(window);
  await addDocuments(window, [path]);
  await expectReadyDocuments(window, 1);
  await newMind(window);
  await window.keyboard.type("Margins");
  await pointAndClick(
    window,
    window.getByTestId("document-list-item").getByTestId("open-document"),
  );
  const layer = (page: number) =>
    window.getByTestId("viewer").locator(`[data-page-number="${page}"] .textLayer`);
  await expect(layer(2)).toContainText(REPEATED);
  return { app, window, layer };
}

async function select(window: Page, layer: ReturnType<Page["locator"]>, words: string) {
  const all = words.split(" ");
  await slideSelect(window, layer, all.slice(0, 2).join(" "), {
    line: layer,
    words: all.slice(-2).join(" "),
  });
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
}

const chips = (window: Page) => window.getByTestId("composer-quote");

test("Ask about this puts the words in the composer, and the Question keeps them above its own", async () => {
  const { window, layer } = await paperBesideMind();
  // The same words are on page 1 too: the chip must say page 2.
  await select(window, layer(2), "Margins recover within two quarters");

  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));

  await expect(chips(window)).toHaveCount(1);
  await expect(chips(window)).toContainText("“Margins recover within two quarters”");
  await expect(chips(window)).toContainText("Rate cuts p. 2");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What does this mean?");
  await window.keyboard.press("Enter");

  const question = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(question).toContainText("What does this mean?");
  await expect(question.getByTestId("assistant-question-quote")).toContainText(
    "Margins recover within two quarters",
  );
  await expect(question.getByTestId("assistant-question-quote-source")).toHaveText(
    "Rate cuts p. 2",
  );
  await expect(chips(window)).toHaveCount(0);
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 45_000,
  });

  // Asked, the words are let go: no longer drawn, and ⌘J only goes to the composer.
  await expect.poll(() => heldDrawn(window)).toBe(0);
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await expect(chips(window)).toHaveCount(0);
});

const heldDrawn = (window: Page) =>
  window.evaluate(() => CSS.highlights.get("viewer-held-selection")?.size ?? 0);

test("at 900 px, a chip added with the Document's tab in front goes with the words into the Mind's composer, and is asked", async () => {
  const { window, layer } = await paperBesideMind({ width: 900 });
  await expect(window.getByTestId("mind-tab").first()).toHaveAttribute("aria-selected", "false");
  await select(window, layer(1), "Grocers studied across the eleven chains");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What does this mean?");

  await pointAndClick(window, window.getByTestId("mind-tab").first());

  await expect(window.getByTestId("composer-input")).toHaveValue("What does this mean?");
  await expect(chips(window)).toHaveCount(1);
  await window.getByTestId("composer-input").focus();
  await window.keyboard.press("Enter");
  const question = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(question.getByTestId("assistant-question-quote")).toContainText(
    "Grocers studied across the eleven chains",
  );
});

test("with no model set, the waiting Question shows its quote, and Set up later or a quit gives back the words and the chip", async () => {
  const { app, window, layer } = await paperBesideMind({ model: false });
  await select(window, layer(2), "Margins recover within two quarters");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What does this mean?");
  await window.keyboard.press("Enter");

  await expect(window.getByTestId("model-setup")).toBeVisible();
  const waiting = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(waiting.getByTestId("assistant-question-quote")).toContainText(
    "Margins recover within two quarters",
  );
  await pointAndClick(window, window.getByTestId("setup-later"));
  await expect(window.getByTestId("composer-input")).toHaveValue("What does this mean?");
  await expect(chips(window)).toHaveCount(1);

  // Asked again, it waits again; quitting keeps it for the next start.
  await window.getByTestId("composer-input").focus();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("model-setup")).toBeVisible();
  await app.close();
  const again = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(again.app, again.window, 1440, 900);
  await pointAndClick(again.window, again.window.getByTestId("mind-tab").first());
  await expect(again.window.getByTestId("composer-input")).toHaveValue("What does this mean?");
  await expect(chips(again.window)).toHaveCount(1);
  await again.app.close();
});

test("while a Question waits for setup, the same words offer no second Ask, by the menu, ⌘/ or ⌘K, and ⌘J asks about none of it", async () => {
  const { window, layer } = await paperBesideMind({ model: false });
  await select(window, layer(2), "Margins recover within two quarters");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What does this mean?");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("model-setup")).toBeVisible();

  await select(window, layer(2), "Margins recover within two quarters");
  await expect(window.getByTestId("viewer-selection-ask")).toHaveCount(0);
  await expect(window.getByTestId("viewer-selection-add")).toBeVisible();
  await expect(window.getByTestId("viewer-selection-copy")).toBeVisible();
  await window.keyboard.press("ControlOrMeta+/");
  await expect(window.getByTestId("viewer-selection-add")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("viewer-selection-menu")).toHaveCount(0);

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("the selected text");
  await expect(
    paletteFound(window).filter({ hasText: "Add the selected text to note" }),
  ).toHaveCount(1);
  await expect(
    paletteFound(window).filter({ hasText: "Copy the selected text with its citation" }),
  ).toHaveCount(1);
  await expect(paletteFound(window).filter({ hasText: "Ask about the selected text" })).toHaveCount(
    0,
  );
  await window.keyboard.press("Escape");

  // Another line, so a second Ask would show as a second chip once the setup card goes.
  await select(window, layer(1), "Grocers studied across the eleven chains");
  await window.keyboard.press("ControlOrMeta+j");
  await pointAndClick(window, window.getByTestId("setup-later"));
  await expect(window.getByTestId("composer-input")).toHaveValue("What does this mean?");
  await expect(chips(window)).toHaveCount(1);
  await expect(chips(window)).toContainText("“Margins recover within two quarters”");
});

test("while a Question waits for setup, Add to note and Copy with citation stay and Copy works, in Chinese", async () => {
  const { window, layer } = await paperBesideMind({ model: false });
  await setLanguage(window, "zh-CN");
  await select(window, layer(2), "Margins recover within two quarters");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("这句话是什么意思？");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("model-setup")).toBeVisible();

  const copied = await stubClipboard(window);
  await select(window, layer(2), "Margins recover within two quarters");
  await expect(window.getByTestId("viewer-selection-ask")).toHaveCount(0);
  await expect(window.getByTestId("viewer-selection-add")).toHaveText("添加到笔记");
  await expect(window.getByTestId("viewer-selection-copy")).toHaveText("复制（含引用）");
  await pointAndClick(window, window.getByTestId("viewer-selection-copy"));
  await expect(window.getByTestId("copied-line")).toContainText("已复制，含引用");
  expect((await copied())["text/plain"]).toContain("Margins recover within two quarters");
});

test("a long Document name is cut in the chip and above the Question, its page kept whole and the whole name in a tooltip, in Chinese", async () => {
  const name =
    "Quarterly review of regional grocery chains margins after the rate cuts of 2025 final revised edition";
  const { window, layer } = await paperBesideMind({ name });
  await setLanguage(window, "zh-CN");
  await select(window, layer(2), "Margins recover within two quarters");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));
  await expect(window.getByTestId("composer-input")).toBeFocused();

  const chip = chips(window);
  await expect(chip).toHaveAttribute("title", new RegExp(`${name} 第 2 页$`));
  await expect(chip.locator(".quote-chip-where")).toHaveText("第 2 页");
  await expectInside(chip.locator(".quote-chip-where"), chip);

  await window.keyboard.type("这句话是什么意思？");
  await window.keyboard.press("Enter");
  const source = window
    .getByTestId("assistant")
    .getByTestId("assistant-question")
    .last()
    .getByTestId("assistant-question-quote-source");
  await expect(source).toHaveAttribute("title", `${name} 第 2 页`);
  await expectInside(source.locator(".assistant-question-quote-where"), source);
});

/** The page is drawn whole, inside its line, as the name before it is cut to fit. */
async function expectInside(
  inner: ReturnType<Page["locator"]>,
  outer: ReturnType<Page["locator"]>,
) {
  const [box, around] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(box && around && box.x + box.width <= around.x + around.width + 1).toBe(true);
  const fits = await inner.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  expect(fits).toBe(true);
}

test("⌘J and ⌘K ask about the selection, the same words once, and Backspace and × take the chip away, in Chinese", async () => {
  const { window, layer } = await paperBesideMind();
  await setLanguage(window, "zh-CN");
  await select(window, layer(1), "Grocers studied across the eleven chains.");
  await expect(window.getByTestId("viewer-selection-ask")).toContainText("就此提问");

  await window.keyboard.press("ControlOrMeta+j");
  await expect(chips(window)).toHaveCount(1);
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.press("Backspace");
  await expect(chips(window)).toHaveCount(0);

  await select(window, layer(1), "Grocers studied across the eleven chains.");
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("就所选文字提问");
  await window.keyboard.press("Enter");
  await expect(chips(window)).toHaveCount(1);
  await expect(chips(window)).toContainText("第 1 页");
  // The same words asked about again make no second chip.
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await expect(chips(window)).toHaveCount(1);
  await pointAndClick(window, window.getByTestId("composer-quote-remove"));
  await expect(chips(window)).toHaveCount(0);
});
