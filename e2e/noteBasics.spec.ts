import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import { CONTENT_SCHEMA_VERSION, type CoreBridge } from "../src/core/api";
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
import { pdfText } from "./pdfText";

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

interface PrintCall {
  text: string;
  lang: string;
  options: unknown;
  pdf: string;
}

const printCalls = (app: ElectronApplication): Promise<PrintCall[]> =>
  app.evaluate(() => (globalThis as unknown as { __printCalls?: PrintCall[] }).__printCalls ?? []);

/**
 * Answers the print dialog where it cannot be: the app's print page prints itself to a PDF as
 * the printer would print it, and the page's text, language and the PDF come back to the test.
 */
async function answerPrintDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const [first] = webContents.getAllWebContents();
    if (!first) throw new Error("There is no window to print from.");
    const prototype = Object.getPrototypeOf(first) as {
      print: (options: unknown, callback: (success: boolean, reason?: string) => void) => void;
    };
    (globalThis as unknown as { __printCalls?: PrintCall[] }).__printCalls = [];
    prototype.print = (options, callback) => {
      const page = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes("print.html"));
      if (!page) {
        callback(false, "The print page didn't open.");
        return;
      }
      void page
        .executeJavaScript("[document.body.innerText, document.documentElement.lang]")
        .then(async ([text, lang]) => {
          const pdf = await page.printToPDF({
            preferCSSPageSize: true,
            printBackground: true,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          });
          (globalThis as unknown as { __printCalls?: PrintCall[] }).__printCalls?.push({
            text: String(text),
            lang: String(lang),
            options,
            pdf: Buffer.from(pdf).toString("base64"),
          });
          callback(true);
        })
        .catch((error: unknown) => callback(false, String(error)));
    };
  });
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
  await expect(editor.getByRole("navigation", { name: "Contents" })).toBeVisible();
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

  // In Chinese the block, its landmark and its entries speak Chinese.
  await setLanguage(window, "zh-CN");
  await expect(contents).toContainText("目录");
  await expect(editor.getByRole("navigation", { name: "目录" })).toBeVisible();
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

test("Tidy Chinese text spaces Latin text beside an address, a date and a file name in the Note", async () => {
  const { window, editor } = await startMind();
  const lines = ["访问https://example.com和Word文件", "截至2026/10/30后", "打开report.docx后"];
  for (const [index, line] of lines.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }

  await runCommand(window, "mind.tidy", "Tidy Chinese text");

  const paragraphs = editor.locator("p");
  await expect(paragraphs).toHaveCount(3);
  await expect(paragraphs.nth(0)).toHaveText("访问 https://example.com 和 Word 文件");
  await expect(paragraphs.nth(1)).toHaveText("截至 2026/10/30 后");
  await expect(paragraphs.nth(2)).toHaveText("打开 report.docx 后");
  await expect(window.getByTestId("undo-line")).toContainText("Tidied 3 places · Undo");
});

test("Tidy says it is working within 100 ms on a large Note", async () => {
  test.setTimeout(180_000);
  const { window, editor } = await startMind();
  const blocks = Array.from({ length: 5_000 }, (_, index) => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", `tidy-${index}`);
    paragraph.insert(0, [new Y.XmlText("导出为Word文件,你好。")]);
    return paragraph;
  });
  await write(window, blocks);
  await expect(editor.locator("p", { hasText: "导出为Word文件,你好。" }).first()).toBeVisible({
    timeout: 60_000,
  });

  // A person's click on the command, then the line that says it is working.
  await window.evaluate(() => {
    const state: { clickedAt: number | null; shownAt: number | null } = {
      clickedAt: null,
      shownAt: null,
    };
    (window as unknown as { __tidyTiming?: typeof state }).__tidyTiming = state;
    const observer = new MutationObserver(() => {
      const line = document.querySelector('[data-testid="undo-note"]');
      if (line?.textContent?.includes("Tidying")) {
        state.shownAt = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    document.addEventListener(
      "click",
      () => {
        if (state.clickedAt === null) state.clickedAt = performance.now();
      },
      { capture: true, once: true },
    );
  });

  await runCommand(window, "mind.tidy", "Tidy Chinese text");
  await expect(editor.locator("p", { hasText: "导出为 Word 文件，你好。" }).first()).toBeVisible({
    timeout: 60_000,
  });
  const timing = await window.evaluate(
    () =>
      (window as unknown as { __tidyTiming?: { clickedAt: number | null; shownAt: number | null } })
        .__tidyTiming,
  );
  expect(timing?.clickedAt).not.toBeNull();
  expect(timing?.shownAt).not.toBeNull();
  expect((timing?.shownAt ?? 0) - (timing?.clickedAt ?? 0)).toBeLessThan(100);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`Print sends the Note's print page to the printer (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window, editor } = await startMind();
    const line = "Printed from the Note. 打印测试。";
    await window.keyboard.type(line);
    await expect(editor.locator("p").first()).toHaveText(line);
    if (language === "zh-CN") await setLanguage(window, "zh-CN");
    await answerPrintDialog(app);

    await runCommand(window, "mind.print", language === "zh-CN" ? "打印" : "Print");
    await expect.poll(() => printCalls(app), { timeout: 30_000 }).toHaveLength(1);
    const [printed] = await printCalls(app);
    expect(printed?.lang).toBe(language);
    expect(printed?.options).toMatchObject({ printBackground: true, silent: false });
    expect(printed?.text).toContain("Printed from the Note.");

    const bytes = Buffer.from(printed?.pdf ?? "", "base64");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((await pdfText(bytes)).join("\n")).toContain("Printed from the Note.");
    // The system dialog itself is the only part no headless run can answer.
    await expect(window.getByTestId("undo-problem")).toHaveCount(0);
  });
}

test("find and replace in a Note a newer version wrote: Replace is off, says why in both languages, and nothing changes", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", "block-1");
    paragraph.insert(0, [new Y.XmlText("tide tide")]);
    doc.getXmlFragment("blocks").push([paragraph]);
    doc.getMap("settings").set("schemaVersion", CONTENT_SCHEMA_VERSION + 1);
    const update = Array.from(Y.encodeStateAsUpdate(doc));
    await window.evaluate(async (bytes) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await core.createMind({ title: "From the other computer" });
      await core.applyMindUpdate(mind.id, new Uint8Array(bytes));
      await core.closeMind(mind.id);
    }, update);
    await window
      .getByTestId("mind-list-item")
      .filter({ hasText: "From the other computer" })
      .click();
    const editor = window.getByTestId("mind-editor");
    await expect(editor).toContainText("tide tide");
    await expect(window.getByTestId("mind-notice-read-only")).toContainText("Read-only");

    await editor.click();
    await window.keyboard.press("ControlOrMeta+Alt+f");
    const bar = window.getByTestId("find-bar");
    await expect(bar).toBeVisible();
    await window.getByTestId("find-field").fill("tide");
    await window.getByTestId("replace-field").fill("wave");
    await expect(window.getByTestId("find-count")).toContainText("2");
    await expect(window.getByTestId("replace-one")).toBeDisabled();
    await expect(window.getByTestId("replace-all")).toBeDisabled();
    await expect(window.getByTestId("find-read-only")).toContainText(
      "A newer IncarnaMind wrote this note",
    );
    await expect(editor).toContainText("tide tide");
    await expect(window.getByTestId("find-replaced")).toHaveCount(0);

    await setLanguage(window, "zh-CN");
    if ((await bar.count()) === 0) {
      await editor.click();
      await window.keyboard.press("ControlOrMeta+Alt+f");
      await window.getByTestId("find-field").fill("tide");
    }
    await expect(window.getByTestId("find-read-only")).toContainText(
      "较新版本的 IncarnaMind 修改过这篇笔记",
    );
    await expect(editor).toContainText("tide tide");
  } finally {
    await app.close();
  }
});

test("after Replace all the find field keeps the keyboard: ⌘Z takes the replacement back and Esc closes the bar", async () => {
  const { app, window } = await startMind("en");
  try {
    const editor = window.getByTestId("mind-editor");
    await window.keyboard.type("tide tide");
    await window.keyboard.press("ControlOrMeta+Alt+f");
    await window.getByTestId("find-field").fill("tide");
    await window.getByTestId("replace-field").fill("wave");
    await window.getByTestId("replace-all").click();
    await expect(editor).toContainText("wave wave");
    await expect(window.getByTestId("find-replaced")).toContainText("Replaced 2");
    await expect(window.getByTestId("find-field")).toBeFocused();

    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor).toContainText("tide tide");
    await expect(window.getByTestId("find-replaced")).toHaveCount(0);

    await window.getByTestId("replace-all").click();
    await expect(editor).toContainText("wave wave");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("find-bar")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("Whole word is off for a Chinese query, and the hint says why, in both languages", async () => {
  const { app, window } = await startMind("en");
  try {
    await window.keyboard.press("ControlOrMeta+Alt+f");
    await window.getByTestId("find-field").fill("潮汐");
    await expect(window.getByTestId("find-whole-word")).toBeDisabled();
    await expect(window.getByTestId("find-whole-word")).toHaveAttribute(
      "title",
      /Chinese text has no word spaces/,
    );
    await setLanguage(window, "zh-CN");
    if ((await window.getByTestId("find-bar").count()) === 0) {
      await window.getByTestId("mind-editor").click();
      await window.keyboard.press("ControlOrMeta+Alt+f");
    }
    await window.getByTestId("find-field").fill("潮汐");
    await expect(window.getByTestId("find-whole-word")).toHaveAttribute(
      "title",
      /中文没有词间空格/,
    );
    await window.getByTestId("find-field").fill("tide");
    await expect(window.getByTestId("find-whole-word")).toBeEnabled();
  } finally {
    await app.close();
  }
});
