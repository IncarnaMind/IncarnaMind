import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type * as Y from "yjs";
import type { CoreBridge } from "../src/core/api";
import {
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  frontMindName,
  launchApp,
  mindNode,
  motionSettled,
  newMind,
  openPageMenu,
  paletteOffers,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/*
 * Note basics (#1935): find and replace, a Note duplicated from its menu, a
 * table of contents, printing's way in, and tidying Chinese text. Each by the
 * mouse and the keyboard, in English and Chinese.
 */
/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await target.screenshot({ path: join(folder, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function startMind(language: "en" | "zh-CN" = "en", width = 1280) {
  const running = await launchApp(dataDir);
  const { app, window } = running;
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 700);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  return { ...running, editor };
}

/** Writes Blocks into the Mind in front through the core, as an edit from another device arrives. */
async function write(window: Page, blocks: Y.XmlElement[]): Promise<void> {
  const update = Array.from(blocksUpdate(blocks));
  await window.evaluate(async (bytes) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [mind] = await core.listMinds();
    if (!mind) throw new Error("There is no Note.");
    await core.applyMindUpdate(mind.id, new Uint8Array(bytes));
  }, update);
}

/** Names the Note in front through the core. */
async function rename(window: Page, title: string): Promise<void> {
  await window.evaluate(async (name) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [mind] = await core.listMinds();
    if (!mind) throw new Error("There is no Note.");
    await core.renameMind(mind.id, name);
  }, title);
}

const citationNode = () =>
  mindNode("citation", {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Tides",
    contentHash: "hash",
    pageFrom: "1",
    pageTo: "1",
    quote: "Spring tides happen at new moon.",
    check: "found",
  });

test("find and replace: Match case and Whole word, Replace and Replace all, the line with Undo, and every Citation kept", async () => {
  const { window, editor } = await startMind();
  const paragraphs = Array.from({ length: 20 }, () =>
    mindNode("paragraph", { id: randomUUID() }, ["A tide rises.", citationNode()]),
  );
  await write(window, paragraphs);
  const chips = editor.getByTestId("citation-chip");
  await expect(chips).toHaveCount(20);

  await window.keyboard.press("ControlOrMeta+f");
  const field = window.getByTestId("find-field");
  const count = window.getByTestId("find-count");
  await expect(field).toBeFocused();
  await field.fill("tide");
  await expect(count).toHaveText("1 of 20");

  // Match case: the text is lower case already, so a capital finds nothing.
  await window.getByTestId("find-match-case").click();
  await expect(window.getByTestId("find-match-case")).toHaveAttribute("aria-pressed", "true");
  await field.fill("TIDE");
  await expect(count).toHaveText("No matches");
  await field.fill("tide");
  await expect(count).toHaveText("1 of 20");
  await window.getByTestId("find-match-case").click();

  // Whole word: "tid" is inside the word, so it doesn't match.
  await window.getByTestId("find-whole-word").click();
  await field.fill("tid");
  await expect(count).toHaveText("No matches");
  await field.fill("tide");
  await expect(count).toHaveText("1 of 20");
  await window.getByTestId("find-whole-word").click();

  // ⌥⌘F shows Replace. Replace all is one step, and its line offers Undo.
  await window.keyboard.press("ControlOrMeta+Alt+f");
  const replacement = window.getByTestId("replace-field");
  await expect(replacement).toBeVisible();
  await replacement.fill("wave");
  await window.getByTestId("replace-all").click();
  const line = window.getByTestId("find-replaced");
  await expect(line).toHaveText("Replaced 20 · Undo");
  await screenshot(window, "note-find-replace-en");
  await expect(editor).toContainText("A wave rises.");
  await expect(chips).toHaveCount(20);

  // The line's Undo takes every replacement back, and the Citations were never touched.
  await line.click();
  await expect(editor).toContainText("A tide rises.");
  await expect(line).toHaveCount(0);
  await expect(chips).toHaveCount(20);

  // Replace replaces one and goes on.
  await window.getByTestId("replace-one").click();
  await expect(window.getByTestId("find-replaced")).toHaveText("Replaced 1 · Undo");
  await expect(editor).toContainText("A wave rises.");
  await window.getByTestId("find-replaced").click();
  await expect(editor).toContainText("A tide rises.");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("find-bar")).toHaveCount(0);

  // In Chinese the line says the same in its own words.
  await setLanguage(window, "zh-CN");
  await window.keyboard.press("ControlOrMeta+Alt+f");
  await expect(window.getByTestId("replace-field")).toBeVisible();
  await window.getByTestId("find-field").fill("tide");
  await window.getByTestId("replace-field").fill("wave");
  await window.getByTestId("replace-all").click();
  await expect(window.getByTestId("find-replaced")).toHaveText("已替换 20 处 · 撤销");
  await screenshot(window, "note-find-replace-zh");
  await expect(chips).toHaveCount(20);
  await window.getByTestId("find-replaced").click();
  await expect(editor).toContainText("A tide rises.");
});

test("Duplicate in the Note's menu makes “{name} (copy)” with its Citations, opens it, and Undo sends it to Recently deleted", async () => {
  const { window, editor } = await startMind();
  await write(
    window,
    Array.from({ length: 3 }, () =>
      mindNode("paragraph", { id: randomUUID() }, ["At new moon.", citationNode()]),
    ),
  );
  await rename(window, "Tide notes");
  await expect(frontMindName(window)).toHaveText("Tide notes");
  await expect(editor.getByTestId("citation-chip")).toHaveCount(3);

  const menu = await openPageMenu(window);
  await expect(menu.getByTestId("mind.duplicate")).toBeVisible();
  await pointAndClick(window, menu.getByTestId("mind.duplicate"));

  await expect(frontMindName(window)).toHaveText("Tide notes (copy)");
  await expect(window.getByTestId("mind-tab")).toHaveCount(2);
  await expect(
    frontMind(window).getByTestId("mind-editor").getByTestId("citation-chip"),
  ).toHaveCount(3);
  await expect(window.getByTestId("undo-line")).toContainText("Duplicated “Tide notes”");

  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(frontMindName(window)).toHaveText("Tide notes");
  await expect(window.getByTestId("mind-tab")).toHaveCount(1);
});

test("a table of contents from the slash menu follows the headings as they change, and an entry jumps to its heading", async () => {
  const { window, editor } = await startMind();
  await window.keyboard.type("/h1");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Spring tides");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Body text");
  await window.keyboard.press("Enter");
  await window.keyboard.type("/toc");
  await expect(window.getByTestId("slash-item-contents")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  const contents = editor.getByTestId("table-of-contents");
  await expect(contents).toBeVisible();
  await screenshot(editor, "note-toc-en");
  const entries = contents.getByTestId("table-of-contents-entry");
  await expect(entries).toHaveText(["Spring tides"]);

  // A heading added below is in it as it is written.
  await editor.locator("p").filter({ hasText: "Body text" }).click();
  await window.keyboard.press("End");
  await window.keyboard.press("Enter");
  await window.keyboard.type("/h2");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Neap tides");
  await expect(entries).toHaveText(["Spring tides", "Neap tides"]);

  // An entry jumps to its heading: typing goes on in it.
  await entries.nth(1).click();
  await window.keyboard.type("!");
  await expect(editor.locator("h2")).toHaveText("!Neap tides");

  // ⌘K reaches the TOC, Print and Tidy; the Note's menu has Duplicate and Tidy.
  expect(await paletteOffers(window, "mind.tableOfContents", "table of contents")).toBe(1);
  expect(await paletteOffers(window, "mind.print", "Print")).toBe(1);
  expect(await paletteOffers(window, "mind.tidy", "Tidy Chinese text")).toBe(1);
  const menu = await openPageMenu(window);
  await motionSettled(window);
  await screenshot(window, "note-page-menu-en");
  await expect(menu.getByTestId("mind.tidy")).toBeVisible();
  await expect(menu.getByTestId("mind.duplicate")).toBeVisible();
  await window.keyboard.press("Escape");

  // In Chinese the block and its entries speak Chinese.
  await setLanguage(window, "zh-CN");
  await expect(contents).toContainText("目录");
  await expect(entries).toHaveText(["Spring tides", "!Neap tides"]);
});

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1600] as const) {
    test(`the new Note basics hold their layout at ${width} px in ${language}`, async () => {
      const { window, editor } = await startMind(language, width);
      const view = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));

      const menu = await openPageMenu(window);
      await motionSettled(window);
      const menuBox = await menu.boundingBox();
      expect(menuBox).not.toBeNull();
      expect(menuBox?.x).toBeGreaterThanOrEqual(0);
      expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(view.width + 1);
      await screenshot(window, `note-menu-${language}-${width}`);
      await window.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await motionSettled(window);

      await window.keyboard.press("ControlOrMeta+Alt+f");
      await expect(window.getByTestId("replace-field")).toBeVisible();
      const bar = await window.getByTestId("find-bar").boundingBox();
      expect(bar).not.toBeNull();
      expect(bar?.x).toBeGreaterThanOrEqual(0);
      expect((bar?.x ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(view.width + 1);
      await screenshot(window, `note-find-${language}-${width}`);
      await window.keyboard.press("Escape");
      await expect(window.getByTestId("find-bar")).toHaveCount(0);

      await window.keyboard.press("End");
      await window.keyboard.press("Enter");
      await window.keyboard.type("/h1");
      await window.keyboard.press("Enter");
      await window.keyboard.type(language === "zh-CN" ? "潮汐" : "Spring tides");
      await window.keyboard.press("Enter");
      await window.keyboard.type(language === "zh-CN" ? "/目录" : "/toc");
      await window.keyboard.press("Enter");
      const contents = editor.getByTestId("table-of-contents");
      await expect(contents).toBeVisible();
      const contentsBox = await contents.boundingBox();
      expect(contentsBox?.x).toBeGreaterThanOrEqual(0);
      expect((contentsBox?.x ?? 0) + (contentsBox?.width ?? 0)).toBeLessThanOrEqual(view.width + 1);
      await screenshot(editor, `note-toc-${language}-${width}`);
    });
  }
}

test("Tidy Chinese text sets spaces and full-width punctuation in the whole Note or the selection, with a line and Undo", async () => {
  const { window, editor } = await startMind("zh-CN");
  const line = "导出为Word文件,你好。";
  await window.keyboard.type(line);
  const paragraph = editor.locator("p").first();
  await expect(paragraph).toHaveText(line);

  // On the selection only: "Word文件" gets its space, the comma after it stays.
  await slideSelect(window, paragraph, "Word文件");
  const menu = await openPageMenu(window);
  await pointAndClick(window, menu.getByTestId("mind.tidy"));
  await expect(paragraph).toHaveText("导出为 Word 文件,你好。");
  await expect(window.getByTestId("undo-line")).toContainText("已整理 1 处 · 撤销");
  await motionSettled(window);
  await screenshot(window, "note-tidy-zh");
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(paragraph).toHaveText(line);

  // The whole Note: the space and the full-width comma.
  await paragraph.click();
  await window.keyboard.press("End");
  await runCommand(window, "mind.tidy", "整理中文排版");
  await expect(paragraph).toHaveText("导出为 Word 文件，你好。");
  await expect(window.getByTestId("undo-line")).toContainText("已整理 1 处 · 撤销");
  await motionSettled(window);
  await screenshot(window, "note-tidy-zh");
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(paragraph).toHaveText(line);

  // The English line says it too.
  await setLanguage(window, "en");
  await runCommand(window, "mind.tidy", "Tidy Chinese text");
  await expect(paragraph).toHaveText("导出为 Word 文件，你好。");
  await expect(window.getByTestId("undo-line")).toContainText("Tidied 1 place · Undo");
});
