import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
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
 * Cite while writing (#281): "/" then Cite… finds a Passage for the sentence
 * being written and puts a checked Citation where the "/" was; Esc leaves the
 * "/" as text; "@" and Link a Document put in a Document chip that opens its
 * Document beside the Note. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
let shots = 0;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  shots++;
  await motionSettled(window);
  const file = `${String(shots).padStart(2, "0")}-${name}.png`;
  await window.screenshot({ path: join(SCREENSHOTS, file) });
};

/** Three short pages: the line about spring tides is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

const TIDE_TABLE = "大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。\n";

const SENTENCE = "Spring tides happen at new moon and at full moon.";

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

/** A launched app with Tides.pdf read (and a Chinese text file too), a new Mind, the cursor in it. */
async function started(language: "en" | "zh-CN" = "en", width = 1600, { chinese = false } = {}) {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const paths = [join(sources, "Tides.pdf")];
  if (chinese) {
    await writeFile(join(sources, "潮汐.txt"), TIDE_TABLE);
    paths.push(join(sources, "潮汐.txt"));
  }
  const running = await launchApp(dataDir);
  const { app, window } = running;
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 760);
  await addDocuments(window, paths);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  return { ...running, editor };
}

/** Cite… chosen with the mouse from the "/" menu already open: the search is open. */
async function chooseCite(window: Page): Promise<Locator> {
  const item = window.getByTestId("slash-item-cite");
  await expect(item).toBeVisible();
  await item.hover();
  await item.click();
  const search = window.getByTestId("cite-search");
  await expect(search).toBeVisible();
  // The menu closes when the item opens the search, rather than staying over it.
  await expect(window.getByTestId("slash-menu")).toHaveCount(0);
  return search;
}

test('"/" offers Cite… first with the sentence being written in it, and a chosen Passage becomes a checked Citation whose card and click open the page', async () => {
  const { app, window, editor } = await started();
  try {
    await window.keyboard.type(`The Moon raises two bulges of water. ${SENTENCE} /`);
    await expect(window.getByTestId("slash-menu")).toBeVisible();
    await expect(window.getByTestId("slash-item-cite")).toHaveAttribute("aria-selected", "true");
    await expect(window.getByTestId("slash-item-cite")).toHaveText(/Cite…$/);
    await expect(window.getByTestId("slash-item-link-document")).toHaveText(/Link a Document$/);
    await screenshot(window, "slash-menu-en");

    const search = await chooseCite(window);
    // The sentence from the last full stop to the caret, all of it selected, so typing replaces it.
    const field = search.getByTestId("cite-query");
    await expect(field).toHaveValue(SENTENCE);
    const chosen = await field.evaluate((element) => {
      const input = element as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd];
    });
    expect(chosen).toEqual([0, SENTENCE.length]);
    await expect(search.getByTestId("cite-scope")).toHaveText("Searches All Documents");

    // Up to six Passages, each with its Document, its Location and the words that match in bold.
    const results = search.getByTestId("cite-result");
    await expect(results.first()).toBeVisible();
    expect(await results.count()).toBeLessThanOrEqual(6);
    const best = results.first();
    await expect(best).toContainText("Tides");
    await expect(best.getByTestId("cite-result-where")).toHaveText(/· p+\. \d/);
    await expect(best.getByTestId("cite-result-text")).toContainText("Spring tides happen");
    expect(await best.locator("b").allInnerTexts()).toEqual(
      expect.arrayContaining(["Spring", "tides"]),
    );
    await motionSettled(window);
    await screenshot(window, "cite-search-en");

    // Enter puts a checked Citation where the "/" was.
    await window.keyboard.press("Enter");
    await expect(search).toHaveCount(0);
    const citation = editor.getByTestId("citation");
    await expect(citation).toHaveCount(1);
    await expect(citation).toHaveAttribute("data-check", "found");
    await expect(citation.getByTestId("citation-chip")).toHaveText("1");
    await expect(editor).not.toContainText("/");
    await expect(editor).toBeFocused();

    // Its card is an Answer's Citation's card, on a hover as on a click, and the Document
    // opens beside the Note.
    await citation.getByTestId("citation-chip").hover();
    await expect(window.getByTestId("citation-card")).toBeVisible();
    await expect(window.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
    await citation.getByTestId("citation-chip").click();
    await expect(window.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
    const groups = window.getByTestId("tab-group");
    await expect(groups).toHaveCount(2);
    await expect(groups.first().getByTestId("mind-tab")).toHaveAttribute("aria-selected", "true");
    await expect(groups.first()).toHaveAttribute("data-focused", "true");
    await expect(groups.nth(1).getByTestId("document-tab")).toHaveAttribute("data-preview", "true");
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
  } finally {
    await app.close();
  }
});

test("Esc closes Cite… and leaves the “/” as typed text, with the caret after it", async () => {
  const { app, window, editor } = await started();
  try {
    await window.keyboard.type(`${SENTENCE} /`);
    const search = await chooseCite(window);
    await expect(search.getByTestId("cite-result").first()).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(editor).toBeFocused();
    // The "/" is text, and typing goes on after it, where the caret was.
    await window.keyboard.type("draft");
    await expect(editor.locator(":scope > p").first()).toHaveText(`${SENTENCE} /draft`);

    // A press elsewhere in the Note closes it too, and the Note keeps the focus.
    await window.keyboard.type(" /");
    const again = await chooseCite(window);
    await expect(again.getByTestId("cite-result").first()).toBeVisible();
    await pointAndClick(window, editor.locator(":scope > p").first());
    await expect(again).toHaveCount(0);
    await expect(editor).toBeFocused();
  } finally {
    await app.close();
  }
});

test("⌘Z takes back a Citation in one step", async () => {
  const { app, window, editor } = await started();
  try {
    await window.keyboard.type(`${SENTENCE} /`);
    await chooseCite(window);
    await expect(window.getByTestId("cite-result").first()).toBeVisible();
    await window.keyboard.press("Enter");
    const citation = editor.getByTestId("citation");
    await expect(citation).toHaveCount(1);
    await expect(editor).toBeFocused();

    await window.keyboard.press("ControlOrMeta+z");
    await expect(citation).toHaveCount(0);
    // The "/" the Citation replaced is back, as it was before it.
    await expect(editor.locator(":scope > p").first()).toHaveText(`${SENTENCE} /`);
  } finally {
    await app.close();
  }
});

test('Link a Document in the "/" menu, and "@", put in a chip that opens its Document beside the Note', async () => {
  await writeFile(
    join(sources, "Harbour times.txt"),
    "Harbours publish the times of high water.\n",
  );
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 760);
    // A Folder and a Tag: a Note's "@" still offers Documents alone, as the composer's offers all.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.createLibraryGroup({ name: "Thesis", description: "" });
      await bridge.createTag({ name: "Review" });
    });
    await addDocuments(window, [join(sources, "Harbour times.txt")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);

    // "/" then Link a Document: the "@" picker opens where the "/" was, Documents only.
    await window.keyboard.type("See /");
    const link = window.getByTestId("slash-item-link-document");
    await expect(link).toBeVisible();
    await link.hover();
    await link.click();
    const picker = window.getByTestId("scope-picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator('[data-kind="folder"], [data-kind="tag"]')).toHaveCount(0);
    await window.keyboard.type("harb");
    await window.keyboard.press("Enter");
    const chips = editor.getByTestId("document-chip");
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveText("Harbour times");
    // Not a Citation: no quote and no check.
    await expect(editor.getByTestId("citation")).toHaveCount(0);

    // A click opens the Document as a preview tab beside the Note.
    await chips.first().hover();
    await chips.first().click();
    await expect(window.getByTestId("viewer-title")).toHaveText("Harbour times");
    const groups = window.getByTestId("tab-group");
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(1).getByTestId("document-tab")).toHaveAttribute("data-preview", "true");

    // "@" alone does the same.
    await groups.first().getByTestId("mind-tab").click();
    await pointAndClick(window, editor.locator(":scope > p").first());
    await window.keyboard.press("End");
    await window.keyboard.type(" and @");
    await expect(picker).toBeVisible();
    await window.keyboard.press("Enter");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toHaveText("Harbour times");

    // The composer's own "@" shows the Folder and the Tag: the Note's offers Documents alone.
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("@");
    const all = window.getByTestId("scope-picker");
    await expect(all).toBeVisible();
    expect(await all.locator('[data-kind="folder"]').count()).toBeGreaterThan(0);
    expect(await all.locator('[data-kind="tag"]').count()).toBeGreaterThan(0);
    await window.keyboard.press("Escape");
    await expect(all).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('"/" finds the existing items by the words Cite… and Link a Document leave them', async () => {
  const { app, window } = await started();
  try {
    // "citation", "source" and "reference" stay the Quote block's and the Bibliography's.
    await window.keyboard.type("/citation");
    await expect(window.getByTestId("slash-item-quote")).toHaveAttribute("aria-selected", "true");
    await expect(window.getByTestId("slash-item-cite")).toHaveCount(0);
    await window.keyboard.press("Escape");
    for (let key = 0; key <= "/citation".length - 1; key++)
      await window.keyboard.press("Backspace");

    await window.keyboard.type("/sources");
    await expect(window.getByTestId("slash-item-bibliography")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(window.getByTestId("slash-item-cite")).toHaveCount(0);
    await window.keyboard.press("Escape");
    for (let key = 0; key <= "/sources".length - 1; key++) await window.keyboard.press("Backspace");

    // "document" finds Link a Document, by the name the issue gives it, and Compare Documents…
    // after it: a Document command is what the word means now.
    await window.keyboard.type("/document");
    await expect(window.getByTestId("slash-item-link-document")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(window.getByTestId("slash-item-compare")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await window.keyboard.press("Escape");
    for (let key = 0; key <= "/document".length - 1; key++)
      await window.keyboard.press("Backspace");

    // Its own name still finds Cite….
    await window.keyboard.type("/cite");
    await expect(window.getByTestId("slash-item-cite")).toHaveAttribute("aria-selected", "true");
  } finally {
    await app.close();
  }
});

test("the “/” menu opened under a resting pointer chooses its first row, not the one under the pointer", async () => {
  const { app, window, editor } = await started();
  try {
    // Where the menu's second row sits, learned from the menu once.
    await window.keyboard.type(" /");
    const second = window.getByTestId("slash-item-link-document");
    await expect(second).toBeVisible();
    const box = await second.boundingBox();
    if (!box) throw new Error("The menu wasn't laid out.");
    await window.keyboard.press("Escape");
    await window.keyboard.press("Backspace");
    await expect(window.getByTestId("slash-menu")).toHaveCount(0);

    // The pointer rests there, without moving, as the menu opens under it.
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.keyboard.type("/");
    await expect(window.getByTestId("slash-menu")).toBeVisible();
    await expect(window.getByTestId("slash-item-cite")).toHaveAttribute("aria-selected", "true");
    await expect(second).toHaveAttribute("aria-selected", "false");
    await expect(editor.locator(":scope > p").first()).toHaveText(" /");
  } finally {
    await app.close();
  }
});

test("the arrows choose among the Passages found, and wrap, before Enter cites the chosen one", async () => {
  await writeFile(join(sources, "Tides.txt"), "Spring tides happen at new moon.\n");
  await writeFile(join(sources, "Tide tables.txt"), "Spring tides happen at full moon too.\n");
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 760);
    await addDocuments(window, [join(sources, "Tides.txt"), join(sources, "Tide tables.txt")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await window.keyboard.type("Spring tides happen at new moon. /");
    const search = await chooseCite(window);
    const results = search.getByTestId("cite-result");
    await expect(results).toHaveCount(2);
    await expect(results.first()).toHaveAttribute("aria-selected", "true");

    await window.keyboard.press("ArrowDown");
    await expect(results.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(results.first()).toHaveAttribute("aria-selected", "false");
    // The arrows wrap around the list.
    await window.keyboard.press("ArrowDown");
    await expect(results.first()).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("ArrowDown");
    const picked = await results.nth(1).getAttribute("data-document-name");
    if (picked === null) throw new Error("The second Passage has no Document name.");

    await window.keyboard.press("Enter");
    const chip = editor.getByTestId("citation").getByTestId("citation-chip");
    await expect(chip).toHaveCount(1);
    expect(await chip.getAttribute("aria-label")).toContain(picked);
  } finally {
    await app.close();
  }
});

test("the search looks in the Mind's Search scope, and with none in every Document", async () => {
  await writeFile(
    join(sources, "Harbour times.txt"),
    "Harbours publish the times of high water.\n",
  );
  await writeFile(
    join(sources, "Seabirds.txt"),
    "Penguins nest on the harbour cliffs every spring.\n",
  );
  const { app, window } = await launchApp(dataDir);
  await useLocalChatModel(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 760);
    await addDocuments(window, [join(sources, "Harbour times.txt"), join(sources, "Seabirds.txt")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);

    // The composer's "@" narrows the Mind's Search scope to one Document.
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("@Seabirds");
    await expect(window.getByTestId("scope-picker")).toBeVisible();
    await window.keyboard.press("Enter");
    const composer = window.getByTestId("composer");
    await expect(composer.getByTestId("scope-chip")).toHaveText("Seabirds");
    await window.keyboard.press("Escape");

    await pointAndClick(window, editor);
    await window.keyboard.type("Harbours publish the times of high water. /");
    const search = await chooseCite(window);
    await expect(search.getByTestId("cite-scope")).toHaveText("Searches Seabirds");
    await expect(search.getByTestId("cite-nothing")).toHaveText(
      "Nothing close. Try other words, or remove the scope.",
    );
    await window.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
    // The "/" went back to text: take it and the space before it out.
    for (let key = 0; key < 2; key++) await window.keyboard.press("Backspace");

    // The scope gone, every Document is searched.
    await window.keyboard.press("ControlOrMeta+j");
    await pointAndClick(window, composer.getByTestId("scope-chip-remove"));
    await expect(composer.getByTestId("composer-scope-all")).toContainText("All Documents");
    await window.keyboard.press("Escape");
    await pointAndClick(window, editor.locator(":scope > p").first());
    await window.keyboard.press("End");
    await window.keyboard.type(" /");
    const widened = await chooseCite(window);
    await expect(widened.getByTestId("cite-scope")).toHaveText("Searches All Documents");
    await expect(widened.getByTestId("cite-result").first()).toContainText("Harbours publish");
  } finally {
    await app.close();
  }
});

test("zh-CN: 引用… and 链接文档, a Chinese sentence finds its Passage, and the strings are the issue's", async () => {
  const { app, window, editor } = await started("zh-CN", 1280, { chinese: true });
  try {
    const sentence = "大潮出现在新月和满月前后。";
    await window.keyboard.type(`${sentence} /`);
    await expect(window.getByTestId("slash-item-cite")).toHaveText(/引用…$/);
    await expect(window.getByTestId("slash-item-link-document")).toHaveText(/链接文档$/);

    const search = await chooseCite(window);
    const field = search.getByTestId("cite-query");
    await expect(field).toHaveAttribute("placeholder", "输入要引用的那段话里的词");
    await expect(field).toHaveValue(sentence);
    await expect(search.getByTestId("cite-scope")).toHaveText("搜索 全部文档");
    const best = search.getByTestId("cite-result").first();
    await expect(best).toContainText("潮汐");
    await expect(best.getByTestId("cite-result-text")).toContainText("大潮出现在新月和满月前后");
    await screenshot(window, "cite-search-zh");

    await window.keyboard.press("Enter");
    await expect(search).toHaveCount(0);
    const citation = editor.getByTestId("citation");
    await expect(citation).toHaveAttribute("data-check", "found");
    await expect(citation.getByTestId("citation-chip")).toHaveText("1");

    // Nothing close, in Chinese.
    await window.keyboard.press("End");
    await window.keyboard.type(" /");
    const second = await chooseCite(window);
    await second.getByTestId("cite-query").fill("企鹅住在海边的悬崖上");
    await expect(second.getByTestId("cite-nothing")).toHaveText(
      "没找到相近的段落。换个说法，或去掉搜索范围。",
    );
  } finally {
    await app.close();
  }
});

test("a Chinese input method composing “/” or “@” opens no menu", async () => {
  const { app, window, editor } = await started("zh-CN");
  const session = await window.context().newCDPSession(window);
  try {
    await pointAndClick(window, editor);
    await window.keyboard.type("输入文字");
    // After a space, where a "/" typed for real opens the menu: the composition is what stops it.
    await session.send("Input.imeSetComposition", {
      text: "shuru /",
      selectionStart: 7,
      selectionEnd: 7,
    });
    await expect(window.getByTestId("slash-menu")).toHaveCount(0);
    await session.send("Input.imeSetComposition", {
      text: "shuru @",
      selectionStart: 7,
      selectionEnd: 7,
    });
    await expect(window.getByTestId("scope-picker")).toHaveCount(0);
    await session.send("Input.insertText", { text: "输入" });
    await expect(window.getByTestId("slash-menu")).toHaveCount(0);
    await expect(window.getByTestId("scope-picker")).toHaveCount(0);

    // The menus still open once the input method is done.
    await window.keyboard.type(" /");
    await expect(window.getByTestId("slash-menu")).toBeVisible();
    await window.keyboard.press("Escape");
  } finally {
    await session.detach();
    await app.close();
  }
});

test("an input method's Esc or Enter in the field leaves the search open, and cites nothing", async () => {
  const { app, window, editor } = await started();
  try {
    await window.keyboard.type("Spring tides flood. /");
    const search = await chooseCite(window);
    await expect(search.getByTestId("cite-result").first()).toBeVisible();
    const field = search.getByTestId("cite-query");

    for (const key of ["Escape", "Enter"]) {
      await field.evaluate(
        (input, typed) =>
          input.dispatchEvent(
            new KeyboardEvent("keydown", { key: typed, isComposing: true, bubbles: true }),
          ),
        key,
      );
      await expect(search).toBeVisible();
    }
    await expect(editor.getByTestId("citation")).toHaveCount(0);

    // The keys do their work once the composition is done.
    await window.keyboard.press("Enter");
    await expect(editor.getByTestId("citation")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("⌘K reaches Cite… and Link a Document", async () => {
  const { app, window, editor } = await started();
  try {
    await window.keyboard.type("Spring tides flood.");
    const palette = window.getByTestId("palette");

    await window.keyboard.press("ControlOrMeta+k");
    await palette.getByTestId("palette-search").fill(">cite a passage");
    const cite = palette.getByTestId("palette-item").filter({ hasText: "Cite a passage…" }).first();
    await expect(cite).toBeVisible();
    await window.keyboard.press("Enter");
    const search = window.getByTestId("cite-search");
    await expect(search).toBeVisible();
    await expect(search.getByTestId("cite-query")).toHaveValue("Spring tides flood.");
    await expect(search.getByTestId("cite-query")).toBeFocused();
    // No "/" was typed, so Esc leaves the Note as it was.
    await window.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(editor.locator(":scope > p").first()).toHaveText("Spring tides flood.");

    await window.keyboard.press("ControlOrMeta+k");
    await palette.getByTestId("palette-search").fill(">link a document");
    const link = palette
      .getByTestId("palette-item")
      .filter({ hasText: "Link a Document…" })
      .first();
    await expect(link).toBeVisible();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("scope-picker")).toBeVisible();
    // The "@" the command typed for the User goes with the picker when it closes unchoosing.
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("scope-picker")).toHaveCount(0);
    await expect(editor.locator(":scope > p").first()).toHaveText("Spring tides flood.");

    // Neither command is offered where the Note's own text isn't: a code block's caret.
    await pointAndClick(window, editor.locator(":scope > p").first());
    await window.keyboard.press("End");
    await window.keyboard.press("Enter");
    await window.keyboard.type("/code");
    await window.keyboard.press("Enter");
    await window.keyboard.type("const tides = 2;");
    await expect(editor.locator("pre")).toHaveCount(1);
    await window.keyboard.press("ControlOrMeta+k");
    await palette.getByTestId("palette-search").fill(">cite a passage");
    await expect(
      palette.getByTestId("palette-item").filter({ hasText: "Cite a passage…" }),
    ).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("cite-search")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a later search shows it is looking, and its rows follow", async () => {
  const { app, window } = await started();
  try {
    await window.keyboard.type("Spring tides flood. /");
    const search = await chooseCite(window);
    await expect(search.getByTestId("cite-result").first()).toBeVisible();

    await search.getByTestId("cite-query").fill("spring tides happen at new moon");
    await expect(search.getByTestId("cite-progress")).toBeVisible();
    await expect(search.getByTestId("cite-result").first()).toContainText("Spring tides happen");
    await expect(search.getByTestId("cite-progress")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1600]) {
    test(`a screenshot of the Cite… search (${language}, ${width} px)`, async () => {
      test.skip(!SCREENSHOTS, "Set INCARNAMIND_SCREENSHOTS to save screenshots.");
      const { app, window, editor } = await started(language, width, { chinese: true });
      try {
        const sentence = language === "zh-CN" ? "大潮出现在新月和满月前后。" : SENTENCE;
        await window.keyboard.type(`${sentence} /`);
        await expect(window.getByTestId("slash-menu")).toBeVisible();
        await screenshot(window, `slash-menu-${language}-${width}`);
        await chooseCite(window);
        await expect(window.getByTestId("cite-result").first()).toBeVisible();
        await screenshot(window, `cite-search-${language}-${width}`);
        // The result chosen: the Citation in the sentence.
        await window.keyboard.press("Enter");
        await expect(editor.getByTestId("citation")).toHaveCount(1);
        await screenshot(window, `cite-cited-${language}-${width}`);
      } finally {
        await app.close();
      }
    });
  }
}
