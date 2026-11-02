import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * The kinds of file a first add takes beside PDF and Office (#762): a picture
 * read as a scanned page is, cited as "Read from a picture"; an RTF or HTML
 * file read as text with its headings; and an old Office or Pages file, which
 * says the plain next step and shows where it is. The text recognition model
 * is the test build's stand-in, scripted with what a real model read.
 */

const SCANS = join(__dirname, "../tests/fixtures/scans");
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const picture = readFileSync(join(SCANS, "en-clean.jpg"));

const RTF = String.raw`{\rtf1\ansi\ansicpg1252\deff0
{\fonttbl{\f0 Helvetica;}}
{\stylesheet{\s1\outlinelevel0\sbasedon0\snext0 Heading 1;}{\s2\outlinelevel1\sbasedon0\snext1 Heading 2;}}
\pard\s1\b\fs32 Harbour rules\par
\pard\fs24 The harbour master keeps the records.\par
\pard\s2 Scope\par
\pard A fine applies to every berth.\par
}
`;

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Harbour notice</title></head>
<body><h1>Harbour notice</h1><p>The harbour master publishes the tide tables.
<h2>Fees</h2><ul><li>Berthing &amp; mooring: 42</ul></body></html>
`;

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

/** Asks a Question in the assistant, beside a new Mind, and waits for its Answer to finish. */
async function ask(window: Page, text: string) {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  return askInAssistant(window, text);
}

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a picture is read on this computer, cited as read from a picture and washed where its quote is; RTF and HTML files read with their headings; a file it can't take says the next step (${language}, ${width}px)`, async () => {
    const lines =
      language === "en" ? ["Revenue by quarter", "Q2 2026 44.9"] : ["季度营收", "第二季度 44.9"];
    const question =
      language === "en"
        ? "What revenue was reported in the second quarter?"
        : "第二季度的营收是多少？";
    const script = join(sources, "picture.json");
    await writeFile(script, JSON.stringify({ pages: { "1": { lines } } }));
    const pictureFile = join(sources, "Whiteboard.jpg");
    await writeFile(pictureFile, picture);
    const rtfFile = join(sources, "Harbour rules.rtf");
    await writeFile(rtfFile, RTF);
    const htmlFile = join(sources, "notice.html");
    await writeFile(htmlFile, HTML);
    const old = join(sources, "Contract.doc");
    await writeFile(old, "an old .doc");
    const pages = join(sources, "Report.pages");
    await writeFile(pages, "a Pages document");
    const { app, window } = await launchApp(dataDir, { fakeChat: true, scans: script });
    await setWindowSize(app, window, width, 900);
    await dismissChatSetup(window);
    if (language !== "en") await setLanguage(window, language);
    await useLocalChatModel(window);

    // The picture's status says its text is being read, then it is ready.
    await window.getByTestId("add-documents-input").setInputFiles([pictureFile]);
    const row = window.getByTestId("document-list-item").filter({ hasText: "Whiteboard" });
    await expect(row).toHaveAttribute("data-status", "ready", { timeout: 30_000 });

    // A Question about it is answered with a Citation whose card says where the text came from.
    const answer = await ask(window, question);
    const citation = answer.getByTestId("citation");
    await expect(citation).toHaveAttribute("data-check", "found");
    await citation.getByTestId("citation-chip").hover();
    const card = window.getByTestId("citation-card");
    await expect(card.getByTestId("citation-scan")).toHaveAttribute("data-from", "picture");
    await expect(card.getByTestId("citation-scan")).toHaveText(
      language === "en" ? "Read from a picture" : "从图片中识别",
    );
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `picture-citation-${language}.png`) });
    }

    // Opened, the viewer shows the picture itself with the quote washed where it is in it.
    await card.getByTestId("citation-open").click();
    const viewer = window.getByTestId("viewer");
    await expect(viewer.getByTestId("image-picture")).toBeVisible();
    const page = viewer.locator('[data-page-number="1"]');
    const highlight = page.locator("[data-quote-highlight]").first();
    await expect(highlight).toBeVisible();
    await expect(highlight).toBeInViewport();
    const box = await highlight.boundingBox();
    const pageBox = await page.boundingBox();
    expect(box && pageBox).toBeTruthy();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(pageBox?.x ?? 0);
    expect(box?.y ?? 0).toBeGreaterThanOrEqual(pageBox?.y ?? 0);
    // Its zoom works as a PDF's does.
    const level = viewer.getByTestId("image-zoom-level");
    const before = await level.textContent();
    await viewer.getByTestId("image-zoom-in").click();
    await expect(level).not.toHaveText(before ?? "");
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `picture-viewer-${language}.png`) });
    }

    // An RTF and an HTML file read as text with their headings, in the viewer and its outline.
    await window.getByTestId("add-documents-input").setInputFiles([rtfFile, htmlFile]);
    for (const [name, words] of [
      ["Harbour rules", ["Harbour rules", "Scope"]],
      ["notice", ["Harbour notice", "Fees", "Berthing & mooring: 42"]],
    ] as const) {
      const added = window.getByTestId("document-list-item").filter({ hasText: name });
      await expect(added).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
      await added.getByTestId("open-document").click();
      for (const word of words) {
        await expect(window.getByTestId("viewer")).toContainText(word);
      }
      await expect(window.getByTestId("viewer-outline-button")).toBeVisible();
    }

    // Two files it can't take: the next step each, and where each is.
    await window.getByTestId("add-documents-input").setInputFiles([old, pages]);
    const skipped = window.getByTestId("sidebar").getByTestId("skipped-files");
    await expect(skipped).toContainText(language === "en" ? "Skipped 2 files" : "已跳过 2 个文件");
    await skipped.getByTestId("skipped-files-show").click();
    const rows = skipped.getByTestId("skipped-file");
    await expect(rows).toHaveCount(2);
    const docRow = rows.filter({ hasText: "Contract.doc" });
    const pagesRow = rows.filter({ hasText: "Report.pages" });
    const bridge = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.officeConverter()).available;
    });
    if (bridge) {
      await expect(docRow).toContainText("Convert a copy to .docx with LibreOffice");
      await expect(docRow.getByTestId("skipped-convert")).toBeVisible();
    } else {
      await expect(docRow).toContainText(
        language === "en"
          ? "Save it as .docx in Word, then add it"
          : "请在 Word 中另存为 .docx，然后再添加",
      );
      await expect(docRow.getByTestId("skipped-convert")).toHaveCount(0);
    }
    await expect(pagesRow).toContainText(
      language === "en"
        ? "Export it as PDF from Pages, then add it"
        : "请从 Pages 导出为 PDF，然后再添加",
    );
    await expect(docRow.getByTestId("skipped-show")).toBeVisible();
    await expect(pagesRow.getByTestId("skipped-show")).toBeVisible();
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `skipped-files-${language}.png`) });
    }
    await app.close();
  });
}
