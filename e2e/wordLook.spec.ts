import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { longContract } from "../tests/helpers/longContract";
import { paragraph, run, wordFile } from "../tests/helpers/word";
import { contractFile, resumeFile } from "../tests/helpers/wordLookFiles";
import {
  askToChange,
  chooseLook,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  enterContent,
  expectReadyDocuments,
  importWordFile,
  launchApp,
  motionSettled,
  newMind,
  openPageMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let home: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  files = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(files);
});

const fontOf = (target: Locator) =>
  target.evaluate((element) => getComputedStyle(element).fontFamily);

test("a contract imported from Word shows the file's look, and Look › Plain Mind draws it as any Mind, and back", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(
    app,
    window,
    files,
    "Supply agreement v5 (from Northwind).docx",
    contractFile(),
  );

  const editor = window.getByTestId("mind-editor");
  const clause = editor.locator("p", { hasText: "Prices are fixed" });
  const title = editor.locator("[data-word-look]", { hasText: "Supply agreement" }).first();
  await expect(clause).toHaveCSS("text-align", "justify");
  await expect(title).toHaveCSS("text-align", "center");
  await expect(title).toHaveCSS("font-variant-caps", "small-caps");
  expect(await fontOf(title)).toMatch(/^"Book Antiqua"/);
  expect(await fontOf(window.getByTestId("page-menu"))).not.toMatch(/Book Antiqua/);
  if (SCREENSHOTS) {
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-contract.png") });
  }

  // Look is the Note's, beside Style in its ⋯ menu; the group's ⋯ is about the group.
  await pointAndClick(window, window.getByTestId("group-menu"));
  await expect(window.getByTestId("group-menu-items").getByRole("menuitem").first()).toBeVisible();
  await expect(window.getByTestId("look-word")).toHaveCount(0);
  await window.keyboard.press("Escape");
  const menu = await openPageMenu(window);
  const style = menu.getByTestId("page-style");
  const word = menu.getByTestId("look-word");
  await expect(word).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByTestId("look-plain")).toHaveAttribute("aria-checked", "false");
  const [styleBox, wordBox] = [await style.boundingBox(), await word.boundingBox()];
  expect(wordBox && styleBox && wordBox.y > styleBox.y).toBe(true);
  if (SCREENSHOTS) {
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-menu.png") });
  }
  await pointAndClick(window, menu.getByTestId("look-plain"));
  await expect(clause).toHaveCSS("text-align", "start");
  expect(await fontOf(title)).not.toMatch(/Book Antiqua/);
  await expect(clause).toContainText("Prices are fixed for the first twelve months");
  if (SCREENSHOTS) {
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-contract-plain.png") });
  }

  await chooseLook(window, "word");
  await expect(clause).toHaveCSS("text-align", "justify");
  expect(await fontOf(title)).toMatch(/^"Book Antiqua"/);
  if (SCREENSHOTS) {
    await setWindowSize(app, window, 1100, 720);
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-contract-1100.png") });
  }

  await setLanguage(window, "zh-CN");
  const chinese = await openPageMenu(window);
  await expect(chinese).toContainText("外观");
  await expect(chinese.getByTestId("look-word")).toHaveText("Word 文件原样");
  await expect(chinese.getByTestId("look-plain")).toHaveText("普通笔记");
  if (SCREENSHOTS) {
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-menu-zh.png") });
  }
  await app.close();
});

/** A memo set in a face no computer has, so its fonts line reads the same on any machine. */
const MISSING_FONT = "Kestrel Imaginary Serif";
const missingFontFile = () =>
  wordFile({
    styles: `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="${MISSING_FONT}" w:hAnsi="${MISSING_FONT}"/><w:sz w:val="24"/></w:rPr></w:style>`,
    body: [
      paragraph("Memo to the board"),
      paragraph("The supplier holds its prices for the first twelve months."),
    ].join(""),
  });

test("a font this computer lacks is drawn with the nearest of its kind, and the Note's ⋯ and the original's Get info say so, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Board memo.docx", missingFontFile());
  await expectReadyDocuments(window, 1);

  const line = window.getByTestId("mind-editor").locator("p", { hasText: "holds its prices" });
  // Its own face first, then the nearest serifs, the shipped Caladea among them, never downloaded.
  expect(await fontOf(line)).toMatch(
    new RegExp(`^"${MISSING_FONT}", "Times New Roman", .*\\bCaladea\\b.*serif$`),
  );
  const menu = await openPageMenu(window);
  await expect(menu.getByTestId("look-fonts")).toContainText(
    "1 font isn’t installed: shown with the nearest",
  );
  await expect(menu.getByTestId("look-fonts-names")).toHaveText(MISSING_FONT);
  // The file's look is the item the keyboard reaches; a screen reader reads the fonts line with it.
  await expect(menu.getByTestId("look-word")).toHaveAccessibleDescription(
    new RegExp(`^1 font isn’t installed: shown with the nearest\\s*${MISSING_FONT}$`),
  );
  if (SCREENSHOTS) {
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-fonts-menu.png") });
  }
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  const row = window.getByTestId("document-list-item").filter({ hasText: "Board memo" });
  await row.getByTestId("open-document").focus();
  await window.keyboard.press("ControlOrMeta+i");
  const panel = window.getByTestId("info-panel");
  await expect(panel.getByTestId("info-fonts")).toContainText(
    "1 font isn’t installed: shown with the nearest",
  );
  await expect(panel.getByTestId("info-fonts")).toContainText(MISSING_FONT);
  await window.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  await setLanguage(window, "zh-CN");
  const chinese = await openPageMenu(window);
  await expect(chinese.getByTestId("look-fonts")).toContainText(
    "1 种字体未安装，已用最接近的字体显示",
  );
  await expect(chinese.getByTestId("look-fonts-names")).toHaveText(MISSING_FONT);
  await expect(chinese.getByTestId("look-word")).toHaveAccessibleDescription(
    new RegExp(`^1 种字体未安装，已用最接近的字体显示\\s*${MISSING_FONT}$`),
  );
  if (SCREENSHOTS) {
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-fonts-menu-zh.png") });
  }
  await window.keyboard.press("Escape");
  await row.getByTestId("open-document").focus();
  await window.keyboard.press("ControlOrMeta+i");
  await expect(panel.getByTestId("info-fonts")).toContainText("字体");
  await app.close();
});

/** The Answer's ink, the AI grey (DESIGN.md, `ink-answer`). */
const INK_ANSWER = "rgb(59, 64, 72)";

test("a clause the User types takes the clause's look, and an AI change in a justified Book Antiqua clause is in its font and alignment, struck and underlined, its new words in the AI grey", async () => {
  const { app, window } = await launchApp(dataDir, { home, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await importWordFile(
    app,
    window,
    files,
    "Supply agreement v5 (from Northwind).docx",
    contractFile(),
  );
  const editor = window.getByTestId("mind-editor");
  const clause = editor.locator("p", { hasText: "for the first twelve months" });
  await expect(clause).toHaveCSS("text-align", "justify");

  // Enter at the clause's end gives the next its properties, as in Word.
  await clickEndOf(window, clause);
  await window.keyboard.press("Enter");
  await window.keyboard.type("Deliveries are made within five working days of an order.");
  const typed = editor.locator("p", { hasText: "Deliveries are made" });
  await expect(typed).toHaveCSS("text-align", "justify");
  expect(await fontOf(typed)).toMatch(/^"Book Antiqua"/);

  await slideSelect(window, clause, "Prices are fixed for the first twelve months");
  await askToChange(window, "replace fixed with held");
  await expect(clause).toContainText("Prices are held for the first twelve months");
  const grey = clause.locator(".generated-text");
  await expect(grey).toHaveText("held");
  await expect(grey).toHaveCSS("color", INK_ANSWER);
  expect(await fontOf(grey)).toMatch(/^"Book Antiqua"/);
  await expect(typed.locator(".generated-text")).toHaveCount(0);

  await pointAndClick(window, editor.getByTestId("applied-line").getByTestId("applied-review"));
  const removed = clause.locator("del.applied-old");
  const added = clause.locator(".applied-new");
  await expect(removed).toContainText("fixed");
  await expect(added).toContainText("held");
  for (const mark of [removed, added]) {
    expect(await fontOf(mark)).toMatch(/^"Book Antiqua"/);
    expect(await mark.evaluate((element) => getComputedStyle(element).fontSize)).toBe(
      await clause.evaluate((element) => getComputedStyle(element).fontSize),
    );
  }
  await expect(removed).toHaveCSS("text-decoration-line", "line-through");
  await expect(added).toHaveCSS("text-decoration-line", "underline");
  await expect(clause).toHaveCSS("text-align", "justify");
  if (SCREENSHOTS) {
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-proposal.png") });
    await setWindowSize(app, window, 1100, 720);
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-proposal-1100.png") });
    await setLanguage(window, "zh-CN");
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-proposal-zh-1100.png") });
    await setWindowSize(app, window, 1440, 900);
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-proposal-zh.png") });
  }
  await app.close();
});

test("the 304-page contract opens in its look, with one rule a style", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Framework Services Agreement.docx", longContract());

  const editor = window.getByTestId("mind-editor");
  // The title and every clause's heading in: the import has written every Block.
  await expect(editor.locator("h1")).toHaveCount(241, { timeout: 120_000 });
  await expect(editor.locator("p", { hasText: /^240\.11 / })).toHaveCSS("text-align", "justify");
  const rules = await window.evaluate(() =>
    [...document.querySelectorAll(".mind-editor-frame > style")].map(
      (style) => (style as HTMLStyleElement).sheet?.cssRules.length ?? 0,
    ),
  );
  expect(rules).toHaveLength(1);
  expect(rules[0]).toBeLessThan(25);
  await app.close();
});

test("two Word Minds side by side each keep their own look", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "林晓_简历.docx", resumeFile());
  await importWordFile(app, window, files, "Supply agreement.docx", contractFile());
  await window.getByTestId("split-group").click();
  await expect(window.getByRole("region", { name: "Group 2" })).toBeVisible();
  // Split opens the shown Mind beside; the first group goes back to the résumé.
  await window
    .getByRole("region", { name: "Group 1" })
    .getByRole("tab", { name: "林晓_简历" })
    .click();
  const panes = window.locator('[data-testid="mind-pane"]:visible');
  await expect(panes).toHaveCount(2);

  const resume = panes.filter({ hasText: "林　晓" });
  const contract = panes.filter({ hasText: "Supply agreement" });
  const name = resume.locator("[data-word-look]", { hasText: "林　晓" }).first();
  await expect(name).toHaveCSS("text-align", "center");
  expect(await fontOf(name)).toMatch(/华文中宋/);
  expect(await fontOf(name)).not.toMatch(/Book Antiqua/);
  const clause = contract.locator("p", { hasText: "Prices are fixed" });
  await expect(clause).toHaveCSS("text-align", "justify");
  expect(await fontOf(clause)).toMatch(/^"Book Antiqua"/);
  // The bullets' style has contextual spacing: no space between two of them, its space after the last.
  await expect(resume.locator("li p", { hasText: "跟踪 12 家" })).toHaveCSS("margin-bottom", "0px");
  await expect(resume.locator("li p", { hasText: "整理行业数据库" })).not.toHaveCSS(
    "margin-bottom",
    "0px",
  );
  if (SCREENSHOTS) {
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-side-by-side.png") });
  }
  await app.close();
});

const RED = "rgb(192, 0, 0)";

/** A memo whose heading is bold by its style, and whose middle words are a run of their own, red in Arial. */
function memoFile(): Buffer {
  return wordFile({
    styles:
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Lead"><w:name w:val="Lead"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>',
    body: [
      paragraph("Payment terms", { style: "Lead" }),
      paragraph(
        `${run("Invoices are paid ")}<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="C00000"/></w:rPr><w:t>within thirty days of delivery</w:t></w:r>${run(", by bank transfer to the account on the invoice.")}`,
      ),
    ].join(""),
  });
}

/** How words are drawn: the computed style of the innermost element holding them. */
const lookOf = (line: Locator, words: string) =>
  line.evaluate((element, wanted) => {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && node.textContent?.includes(wanted)) {
        const style = getComputedStyle(node.parentElement);
        return {
          weight: Number(style.fontWeight),
          style: style.fontStyle,
          color: style.color,
          font: style.fontFamily,
        };
      }
    }
    throw new Error(`“${wanted}” isn’t in the line.`);
  }, words);

const styleOf = (target: Locator) =>
  target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, font: style.fontFamily };
  });

test("in a red Arial run, ⌘B and ⌘I toggle its words and keep its colour, ⌘B takes off a style's bold, and code and links in it look as in any Mind", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Payment terms.docx", memoFile());

  const editor = window.getByTestId("mind-editor");
  const line = editor.locator("p", { hasText: "Invoices are paid" });
  await expect(line.locator("[data-word-run]")).toHaveText("within thirty days of delivery");
  const before = await lookOf(line, "thirty days");
  expect(before).toMatchObject({ weight: 400, style: "normal", color: RED });
  expect(before.font).toMatch(/^Arial/);

  // The heading's bold comes from its Word style, and ⌘B takes it off like any bold.
  const heading = editor.locator("p", { hasText: "Payment terms" });
  await expect(heading.locator("strong")).toHaveText("Payment terms");
  await slideSelect(window, heading, "Payment terms");
  await window.keyboard.press("ControlOrMeta+B");
  await expect(heading.locator("strong")).toHaveCount(0);
  expect((await lookOf(heading, "Payment terms")).weight).toBe(before.weight);
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(heading.locator("strong")).toHaveText("Payment terms");
  // The selection menu, under the heading, would cover the next line.
  await window.keyboard.press("ArrowRight");
  await expect(window.getByTestId("selection-menu")).toBeHidden();

  await slideSelect(window, line, "thirty days");
  await window.keyboard.press("ControlOrMeta+B");
  await expect(line.locator("strong")).toHaveText("thirty days");
  expect((await lookOf(line, "thirty days")).weight).toBeGreaterThan(before.weight);
  await window.keyboard.press("ControlOrMeta+I");
  await expect(line.locator("em")).toHaveText("thirty days");
  expect(await lookOf(line, "thirty days")).toMatchObject({ style: "italic", color: RED });
  await window.keyboard.press("ControlOrMeta+B");
  await expect(line.locator("strong")).toHaveCount(0);
  expect(await lookOf(line, "thirty days")).toMatchObject({
    weight: before.weight,
    style: "italic",
    color: RED,
    font: before.font,
  });

  await slideSelect(window, line, "delivery");
  await window.keyboard.press("ControlOrMeta+E");
  const code = line.locator("code");
  await expect(code).toHaveText("delivery");
  const codeLook = await styleOf(code);
  expect(codeLook.font).not.toMatch(/Arial/);
  expect(await lookOf(line, "delivery")).toMatchObject(codeLook);

  await slideSelect(window, line, "within");
  await window.keyboard.press("ControlOrMeta+K");
  await expect(window.getByTestId("link-field")).toBeFocused();
  await window.keyboard.type("example.com/terms");
  await window.keyboard.press("Enter");
  const link = line.locator("a");
  await expect(link).toHaveText("within");
  const linkLook = await styleOf(link);
  expect(linkLook.color).not.toBe(RED);
  expect((await lookOf(line, "within")).color).toBe(linkLook.color);
  if (SCREENSHOTS) {
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-marks.png") });
  }
  await app.close();
});

test("a Citation pasted into a clause with a hanging indent sits on the clause's line with its number inside its chip", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Supply agreement.docx", contractFile());
  await expectReadyDocuments(window, 1);
  const documentId = await documentIdOf(window, "Supply agreement");

  const editor = window.getByTestId("mind-editor");
  const clause = editor.locator("p", { hasText: "Prices are fixed" });
  await clickEndOf(window, clause);
  // As copied from an Answer that cites the original.
  await window.evaluate((id) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      `<span data-type="citation" data-document-id="${id}" data-document-name="Supply agreement" data-quote="Prices are fixed for the first twelve months" data-check="found">Supply agreement</span>`,
    );
    data.setData("text/plain", "Supply agreement");
    (document.activeElement ?? document.body).dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  }, documentId);

  const chip = clause.getByTestId("citation-chip");
  await expect(chip).toBeVisible();
  await expect(clause).toContainText("on 45 days’ notice.");
  const [chipBox, numberBox, clauseBox] = await Promise.all([
    chip.boundingBox(),
    chip.getByTestId("citation-chip-text").boundingBox(),
    clause.boundingBox(),
  ]);
  if (!chipBox || !numberBox || !clauseBox) throw new Error("The Citation isn't drawn.");
  expect(numberBox.x).toBeGreaterThanOrEqual(chipBox.x);
  expect(numberBox.x + numberBox.width).toBeLessThanOrEqual(chipBox.x + chipBox.width);
  expect(chipBox.x).toBeGreaterThan(clauseBox.x);
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(clauseBox.x + clauseBox.width);
  expect(await fontOf(chip)).not.toMatch(/Book Antiqua/);
  // The clause still hangs: its number starts left of its text's later lines.
  const indent = await clause.evaluate((element) => getComputedStyle(element).textIndent);
  expect(Number.parseFloat(indent)).toBeLessThan(0);
  if (SCREENSHOTS) {
    await clause.screenshot({ path: join(SCREENSHOTS, "word-look-citation.png") });
  }
  await app.close();
});

test("a Mind written in the app, beside a Word Mind, keeps the app's look and has no Look items", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Supply agreement.docx", contractFile());
  await newMind(window);
  await enterContent(window);
  await window.keyboard.type("Questions for Northwind");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Ask whether prices are fixed for the first year.");
  await window.getByTestId("split-group").click();
  const second = window.getByRole("region", { name: "Group 2" });
  await expect(second).toBeVisible();
  const first = window.getByRole("region", { name: "Group 1" });
  await first.getByRole("tab", { name: "Supply agreement" }).click();
  const panes = window.locator('[data-testid="mind-pane"]:visible');
  await expect(panes).toHaveCount(2);

  const clause = first.locator("p", { hasText: "Prices are fixed" });
  const line = second.locator("p", { hasText: "Ask whether prices" });
  await expect(clause).toHaveCSS("text-align", "justify");
  expect(await fontOf(clause)).toMatch(/^"Book Antiqua"/);
  await expect(line).toHaveCSS("text-align", "start");
  expect(await fontOf(line)).not.toMatch(/Book Antiqua/);
  await expect(second.locator("[data-word-look], [data-word-run]")).toHaveCount(0);
  await expect(second.locator(".mind-editor-frame > style")).toHaveCount(0);
  // Half the window is narrower than the file's page: it zooms down, its body no smaller than 11 px, and the text wraps.
  const sizeOf = (target: Locator) =>
    target.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(await sizeOf(clause)).toBeLessThan(await sizeOf(line));
  expect(await sizeOf(clause)).toBeGreaterThanOrEqual(11);
  const page = await first.locator(".mind-editor-frame").boundingBox();
  const clauseBox = await clause.boundingBox();
  if (!page || !clauseBox) throw new Error("The clause isn't drawn.");
  expect(clauseBox.x + clauseBox.width).toBeLessThanOrEqual(page.x + page.width + 1);
  if (SCREENSHOTS) {
    await window.screenshot({ path: join(SCREENSHOTS, "word-look-beside-native.png") });
  }

  await pointAndClick(window, second.getByTestId("group-menu"));
  const groupMenu = second.getByTestId("group-menu-items");
  await expect(groupMenu.getByRole("menuitem").first()).toBeVisible();
  await expect(window.getByTestId("look-word")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(groupMenu).toBeHidden();
  const nativeTab = second.getByRole("tab", { selected: true });
  await pointAndClick(window, nativeTab, { button: "right" });
  const nativeMenu = nativeTab.getByTestId("tab-actions");
  await expect(nativeMenu.getByTestId("mind.outline")).toBeVisible();
  await expect(nativeMenu.locator('[data-testid^="mind.look"]')).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(nativeMenu).toBeHidden();

  // The Word Mind's own tab offers the other look and the original.
  const wordTab = first.getByRole("tab", { selected: true });
  await pointAndClick(window, wordTab, { button: "right" });
  const wordMenu = wordTab.getByTestId("tab-actions");
  await expect(wordMenu.getByTestId("mind.look.plain")).toBeVisible();
  await expect(wordMenu.getByTestId("mind.look.word")).toHaveCount(0);
  await expect(wordMenu.getByTestId("mind.openOriginal")).toBeVisible();
  await pointAndClick(window, wordMenu.getByTestId("mind.look.plain"));
  await expect(clause).toHaveCSS("text-align", "start");
  await expect(line).toHaveCSS("text-align", "start");
  await app.close();
});

test("⌘K switches the look both ways and opens the original at the caret, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await importWordFile(app, window, files, "Supply agreement.docx", contractFile());
  await expectReadyDocuments(window, 1);

  const editor = window.getByTestId("mind-editor");
  const clause = editor.locator("p", { hasText: "Corran pays each invoice" });
  await pointAndClick(window, clause);
  const palette = window.getByTestId("palette");
  const actions = palette
    .locator('[data-testid="palette-group"][data-group="actions"]')
    .getByTestId("palette-item");
  const runFromPalette = async (words: string, label: string) => {
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(`> ${words}`);
    await expect(actions.first()).toHaveText(label);
    await window.keyboard.press("Enter");
    await expect(palette).toBeHidden();
  };

  // Only the look not shown is offered.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("> look:");
  await expect(actions).toHaveText(["Look: Plain note"]);
  await window.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await runFromPalette("look: plain", "Look: Plain note");
  await expect(clause).toHaveCSS("text-align", "start");
  await runFromPalette("look: the word", "Look: the Word file’s look");
  await expect(clause).toHaveCSS("text-align", "justify");

  await runFromPalette("open the original", "Open the original");
  await expect(window.getByTestId("viewer-title")).toHaveText("Supply agreement");
  await expect(window.getByTestId("mind-pane")).toBeVisible();
  const pages = window.getByTestId("viewer-docx");
  await expect(pages).toHaveAttribute("data-rendered", "yes");
  await expect(
    pages.locator("section.docx > article p", { hasText: "Corran pays each invoice" }),
  ).toBeInViewport();

  await setLanguage(window, "zh-CN");
  await pointAndClick(window, clause);
  await runFromPalette("外观", "外观：普通笔记");
  await expect(clause).toHaveCSS("text-align", "start");
  await runFromPalette("外观", "外观：Word 文件原样");
  await expect(clause).toHaveCSS("text-align", "justify");
  await app.close();
});
