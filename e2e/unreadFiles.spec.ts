import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, DocumentStatus } from "../src/core/api";
import { MAX_ROWS } from "../src/core/documents/formats/grid";
import { parseCsv } from "../tests/helpers/csv";
import { lockedPdf } from "../tests/helpers/lockedPdf";
import { xlsxOf } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import {
  askInAssistant,
  checkCard,
  useLocalChatModel as connectLocalChatModel,
  copyFrom,
  createDataFolder,
  dismissChatSetup,
  expectDotsBetweenParts,
  exportFromMenu,
  interceptOpenDialog,
  launchApp,
  nameMind,
  newMind,
  openExportOptions,
  pointAndClick,
  pointAt,
  removeDataFolder,
  savedLine,
  setGroupBeside,
  setLanguage,
  useOutputLocation as setOutputLocation,
  setWindowSize,
  slideSelect,
} from "./app";

/**
 * Every Answer, check, Verify run, export and the check record say which files
 * in their scope couldn't be read, and why (#740): a Folder with a .doc, a
 * password-protected PDF and a scan, besides a file that reads. "3 files
 * couldn't be read · Show" lists each with its reason, and the Library shows
 * each file with the same reason. Nothing shows when everything was read.
 * English and Chinese. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

let dataDir: string;
let library: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  library = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(library);
});

const FILES: Record<string, string | Uint8Array> = {
  "Tides.txt": "Spring tides happen at new moon and at full moon.\n",
  "Old/Contract.doc": "binary",
  "Locked.pdf": lockedPdf(["Harbour fees rise in May."], "harbour"),
  "Scan.pdf": buildPdf([{ image: true }]),
};

async function start(
  language: "en" | "zh-CN",
  files: Record<string, string | Uint8Array> = FILES,
  scans?: string,
) {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(library, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    home: library,
    ...(scans && { scans }),
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await setLanguage(window, language);
  await window.evaluate(async (path) => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(path);
  }, library);
  // Found and read to the end: the scan has no text, the .docx wants a password.
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const [linked] = await bridge.listLinkedFolders();
          const documents = await bridge.listDocuments();
          return (
            linked?.status === "watching" &&
            documents.length > 0 &&
            documents.every((each) => each.status !== "queued" && each.status !== "extracting")
          );
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
  await newMind(window);
  return { app, window };
}

const WORDS = {
  en: {
    count: "3 files couldn’t be read",
    reasons: [
      ["Contract.doc", /Format not read yet \(\.doc\)/],
      ["Locked.pdf", /Locked with a password/],
      ["Scan.pdf", /A scan with no text that could be recognized/],
    ],
    library: {
      locked: "Password-protected: remove it in its app, then add the copy",
      scan: "A scan with no text yet",
    },
    markdown: {
      heading: "## What couldn’t be read",
      count: "3 files couldn’t be read",
      reasons: [
        "- Contract.doc: Format not read yet (.doc)",
        "- Locked.pdf: Password-protected. Remove the password and add it again.",
        "- Scan.pdf: A scan with no text that could be recognized",
      ],
    },
    checkRecord: "What couldn’t be read",
  },
  "zh-CN": {
    count: "3 个文件未能读取",
    reasons: [
      ["Contract.doc", /暂不支持此格式（\.doc）/],
      ["Locked.pdf", /已加密/],
      ["Scan.pdf", /扫描件，未识别出文字/],
    ],
    library: {
      locked: "文件设有密码：在它的应用中去掉密码，再添加副本",
      scan: "这是扫描件，暂时没有文字",
    },
    markdown: {
      heading: "## 未能读取的文件",
      count: "3 个文件未能读取",
      reasons: [
        "- Contract.doc：暂不支持此格式（.doc）",
        "- Locked.pdf：已设置密码。请去掉密码后重新添加。",
        "- Scan.pdf：扫描件，未识别出文字",
      ],
    },
    checkRecord: "未能读取的文件",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`an Answer says which files in its scope couldn't be read, and why (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await start(language);
    const answer = await askInAssistant(window, "What do tides do?");
    const line = answer.getByTestId("unread-files");
    await expect(line).toContainText(WORDS[language].count);
    await expect(line.getByTestId("unread-file")).toHaveCount(0);
    await line.getByTestId("unread-files-show").click();
    const rows = line.getByTestId("unread-file");
    await expect(rows).toHaveCount(3);
    for (const [name, reason] of WORDS[language].reasons) {
      await expect(rows.filter({ hasText: name })).toHaveText(reason);
    }
    await expect(rows.filter({ hasText: "Contract.doc" })).toHaveAttribute("data-reason", "format");
    await expect(rows.filter({ hasText: "Locked.pdf" })).toHaveAttribute("data-reason", "password");
    await expect(rows.filter({ hasText: "Scan.pdf" })).toHaveAttribute("data-reason", "scan");

    // A Document's name opens it; a file in a format not read isn't a Document. A scan that
    // text recognition found nothing in has nothing to read again.
    await expect(rows.getByTestId("unread-file-open")).toHaveText(["Locked.pdf", "Scan.pdf"]);
    await expect(rows.getByTestId("unread-file-ocr")).toHaveCount(0);

    // The list holds at the narrowest window and a wide one.
    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 900);
      const box = await answer.boundingBox();
      for (const row of await rows.all()) {
        const rowBox = await row.boundingBox();
        expect(
          rowBox && box && rowBox.x >= box.x && rowBox.x + rowBox.width <= box.x + box.width + 1,
        ).toBe(true);
      }
    }

    await screenshot(window, `answer-unread-${language}`);

    // The Library shows the file in a format not read, with the same reason, and each Document
    // that couldn't be read with its own.
    await setGroupBeside(window, true);
    const unread = window.getByTestId("library-unread");
    await expect(unread).toContainText(
      language === "en" ? "1 file couldn’t be read" : "1 个文件未能读取",
    );
    await unread.getByTestId("library-unread-show").click();
    await expect(unread.getByTestId("unread-file")).toHaveText(
      language === "en" ? /Contract\.doc: Format not read yet/ : /Contract\.doc：暂不支持此格式/,
    );
    const libraryRow = (name: string) =>
      window.getByTestId("library-document").filter({ hasText: name });
    await expect(libraryRow("Locked").getByTestId("library-fix-reason")).toHaveText(
      WORDS[language].library.locked,
    );
    await expect(libraryRow("Scan").getByTestId("library-fix-reason")).toHaveText(
      WORDS[language].library.scan,
    );
    await screenshot(window, `library-unread-${language}`);

    // Clicking a Document's name opens it.
    await rows.filter({ hasText: "Scan.pdf" }).getByTestId("unread-file-open").click();
    await expect(window.getByTestId("viewer-title")).toHaveText("Scan");
    await app.close();
  });
}

async function expectReasons(
  list: Locator,
  frame: Locator,
  language: "en" | "zh-CN",
  app: Awaited<ReturnType<typeof start>>["app"],
  window: Page,
  name: string,
) {
  const rows = list.getByTestId("unread-file");
  await expect(rows).toHaveCount(3);
  for (const [file, reason] of WORDS[language].reasons) {
    await expect(rows.filter({ hasText: file })).toHaveText(reason);
  }
  for (const width of [900, 1600]) {
    await setWindowSize(app, window, width, 900);
    const box = await frame.boundingBox();
    for (const row of await rows.all()) {
      const rowBox = await row.boundingBox();
      expect(
        rowBox && box && rowBox.x >= box.x - 1 && rowBox.x + rowBox.width <= box.x + box.width + 1,
      ).toBe(true);
    }
    await screenshot(window, `${name}-${language}-${width}`);
  }
}

const SENTENCE = "Spring tides happen at new and full moon.";

for (const language of ["en", "zh-CN"] as const) {
  test(`Check against Documents says which files in its scope couldn't be read, and why (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await start(language);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(SENTENCE);
    const line = editor.locator(":scope > p").first();
    await expect(line).toHaveText(SENTENCE);
    const unread = window.getByTestId("checks-unread");
    await expect(unread).toHaveCount(0);

    await slideSelect(window, line, "Spring tides", { line, words: "full moon." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    await expect(window.getByTestId("claim-mark")).not.toHaveAttribute("data-check", "checking");
    await expect(window.getByTestId("badge-stop")).toHaveCount(0);

    // The badge's card says so, under its rows.
    const card = await checkCard(window);
    await expect(unread).toContainText(WORDS[language].count);
    await expect(unread.getByTestId("unread-file")).toHaveCount(0);
    await pointAndClick(window, unread.getByTestId("checks-unread-show"));
    await expectReasons(unread, card, language, app, window, "check");
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Verify run says which files in its scope couldn't be read, and why (${language})`, async () => {
    test.setTimeout(120_000);
    const outside = await createDataFolder();
    try {
      const report = join(outside, "Harbour report.pdf");
      await writeFile(report, buildPdf([{ lines: ["Harbour report", SENTENCE] }]));
      const { app, window } = await start(language);
      await interceptOpenDialog(app, report);
      await pointAndClick(window, window.getByTestId("plus-menu"));
      await pointAndClick(window, window.getByTestId("plus-more"));
      await pointAndClick(window, window.getByTestId("plus-verify-document"));
      await expect(window.getByTestId("check-card").getByTestId("verify-ask")).toBeVisible();
      const card = await checkCard(window);
      await pointAndClick(window, card.getByTestId("verify-check"));
      await expect(card.getByTestId("verify-done")).toContainText(
        language === "en" ? "Checked 1 claim" : "已核对 1 条说法",
      );

      const unread = card.getByTestId("verify-unread");
      await expect(unread).toContainText(WORDS[language].count);
      await pointAndClick(window, unread.getByTestId("verify-unread-show"));
      await expectReasons(unread, card, language, app, window, "verify");
      await app.close();
    } finally {
      await removeDataFolder(outside);
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`beside its PDF, each line of the Verify card wraps only between its parts and none starts or ends with a dot (${language})`, async () => {
    test.setTimeout(120_000);
    const outside = await createDataFolder();
    try {
      const report = join(
        outside,
        "Harbour trade statistics report for the second half of 2026.pdf",
      );
      await writeFile(report, buildPdf([{ lines: ["Harbour report", SENTENCE] }]));
      const { app, window } = await start(language);
      await interceptOpenDialog(app, report);
      await pointAndClick(window, window.getByTestId("plus-menu"));
      await pointAndClick(window, window.getByTestId("plus-more"));
      await pointAndClick(window, window.getByTestId("plus-verify-document"));
      await expect(window.getByTestId("check-card").getByTestId("verify-ask")).toBeVisible();
      const card = await checkCard(window);
      await pointAndClick(window, card.getByTestId("verify-check"));
      await expect(card.getByTestId("verify-done")).toContainText(
        language === "en" ? "Checked 1 claim" : "已核对 1 条说法",
      );
      const unread = card.getByTestId("verify-unread");
      await expect(unread).toContainText(WORDS[language].count);

      // The PDF is open beside the Mind, so the Mind's column is half the window.
      await setWindowSize(app, window, 1440, 900);
      await expect(window.getByTestId("viewer")).toBeVisible();
      await screenshot(window, `verify-wrap-${language}`);
      // The card is 360px wherever it opens, so its short lines fit; metaLines.spec.ts wraps a long one there.
      const lines = await card.locator(".meta-line").all();
      expect(lines.length).toBeGreaterThan(0);
      for (const row of lines) await expectDotsBetweenParts(row);

      // Copied across its parts, a line reads as one line, "A · B", and within a part the browser copies it.
      const whole = unread.locator(".meta-line").first();
      const across = await copyFrom(whole);
      expect(across.taken).toBe(true);
      expect(across.text).not.toContain("\n");
      expect(across.text.split(" · ")).toHaveLength(2);
      expect((await copyFrom(whole, ".meta-part")).taken).toBe(false);
      await app.close();
    } finally {
      await removeDataFolder(outside);
    }
  });
}

/** What the stand-in for the text recognition model reads: page 1 of a scan, but not page 2. */
async function scanScript(folder: string): Promise<string> {
  const script = join(folder, "scans.json");
  await writeFile(
    script,
    JSON.stringify({
      pages: {
        1: { lines: ["Harbour tariff schedule"] },
        2: { fail: "The model failed on this page." },
      },
    }),
  );
  return script;
}

const statusesIn = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { statuses: DocumentStatus[] }).statuses);

for (const language of ["en", "zh-CN"] as const) {
  test(`a scan with pages that weren't read offers Read with OCR, which reads them again (${language})`, async () => {
    test.setTimeout(120_000);
    const scripts = await createDataFolder();
    try {
      const picture = readFileSync(join(__dirname, "../tests/fixtures/scans/en-clean.jpg"));
      const { app, window } = await start(
        language,
        {
          "Tides.txt": FILES["Tides.txt"] as string,
          "Tariffs.pdf": buildPdf([{ scan: picture }, { scan: picture }]),
        },
        await scanScript(scripts),
      );
      const answer = await askInAssistant(window, "What do tides do?");
      const line = answer.getByTestId("unread-files");
      await line.getByTestId("unread-files-show").click();
      const row = line.getByTestId("unread-file");
      await expect(row).toHaveAttribute("data-reason", "pages");
      const action = row.getByTestId("unread-file-ocr");
      await expect(action).toHaveText(language === "en" ? "Read with OCR" : "识别文字");

      await window.evaluate(() => {
        const page = globalThis as unknown as { incarnamind: CoreBridge; statuses: string[] };
        page.statuses = [];
        page.incarnamind.on("document.status", (document) => page.statuses.push(document.status));
      });
      await action.click();
      await expect.poll(() => statusesIn(window)).toContain("extracting");
      // The stand-in fails on page 2 again: the Document waits, as it did, to be read again.
      await expect(row.getByTestId("unread-file-ocr")).toBeVisible();
      await app.close();
    } finally {
      await removeDataFolder(scripts);
    }
  });
}

test("nothing shows when everything in scope was read", async () => {
  const { app, window } = await start("en", { "Tides.txt": FILES["Tides.txt"] as string });
  const answer = await askInAssistant(window, "What do tides do?");
  await expect(answer.getByTestId("unread-files")).toHaveCount(0);

  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(SENTENCE);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Spring tides", { line, words: "full moon." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  await expect(window.getByTestId("claim-mark")).toHaveCount(1);
  await expect((await checkCard(window)).getByTestId("mind-health")).toBeVisible();
  await expect(window.getByTestId("checks-unread")).toHaveCount(0);
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`an export and the check record say which files couldn't be read, and why (${language})`, async () => {
    test.setTimeout(180_000);
    const out = await createDataFolder();
    try {
      const { app, window } = await start(language);
      await nameMind(window, "Harbour");
      const editor = window.getByTestId("mind-editor").filter({ visible: true });
      await editor.click();
      await window.keyboard.type(SENTENCE);
      const line = editor.locator(":scope > p").first();
      await expect(line).toHaveText(SENTENCE);
      await slideSelect(window, line, "Spring tides", { line, words: "full moon." });
      await pointAndClick(
        window,
        window
          .getByTestId("selection-menu")
          .getByTestId("selection-action-check-against-documents"),
      );
      await expect(window.getByTestId("claim-mark")).not.toHaveAttribute("data-check", "checking");
      await expect(window.getByTestId("badge-stop")).toHaveCount(0);

      await setOutputLocation(window, out);

      // The files aren't named until the User asks for them in the export options, for this Mind.
      await openExportOptions(window);
      await expect(window.getByTestId("export-unread-names")).not.toBeChecked();
      await screenshot(window, `export-options-unread-${language}`);
      await pointAndClick(window, window.getByTestId("export-options-close"));

      await exportFromMenu(window, "markdown");
      const done = window.getByTestId("export-result").getByTestId("export-done");
      await expect(done).toContainText(savedLine("Harbour.md", out, language), { timeout: 30_000 });
      const counted = await readFile(join(out, "Harbour.md"), "utf8");
      expect(counted).toContain(WORDS[language].markdown.heading);
      expect(counted).toContain(WORDS[language].markdown.count);
      for (const reason of WORDS[language].markdown.reasons) expect(counted).not.toContain(reason);

      await openExportOptions(window);
      await pointAndClick(window, window.getByTestId("export-unread-names"));
      await pointAndClick(window, window.getByTestId("export-save"));
      await expect(window.getByTestId("export-dialog")).toBeHidden();

      await exportFromMenu(window, "markdown");
      await expect(done).toContainText("Harbour", { timeout: 30_000 });
      const exports = await Promise.all(
        (await readdir(out))
          .filter((name) => name.endsWith(".md"))
          .map(async (name) => readFile(join(out, name), "utf8")),
      );
      const named = exports.find((each) => each.includes(WORDS[language].markdown.reasons[0]));
      if (named === undefined) throw new Error("No export named the files.");
      for (const reason of WORDS[language].markdown.reasons) expect(named).toContain(reason);

      // The check record, its PDF and its CSV: the same count and list.
      const mind = window.getByTestId("mind-row").filter({ hasText: "Harbour" });
      await pointAt(window, mind);
      await pointAndClick(window, mind.getByTestId("mind-menu"));
      const menu = mind.getByTestId("mind-actions");
      await expect(menu.getByTestId("mind.checkRecord")).toBeVisible();
      await pointAndClick(window, menu.getByTestId("mind.checkRecord"));
      await expect(done).toContainText("Harbour", { timeout: 30_000 });
      await expect(done).toContainText(language === "en" ? "and its CSV" : "和 CSV 文件");
      const csvName = (await readdir(out)).find((name) => name.endsWith(".csv"));
      const csv = await readFile(join(out, csvName ?? ""), "utf8");
      const record = parseCsv(csv).find((each) => each[0] === WORDS[language].checkRecord);
      expect(record?.[1]).toContain(WORDS[language].markdown.count);
      for (const [name] of WORDS[language].reasons) expect(record?.[1]).toContain(name);

      if (SCREENSHOTS) {
        await writeFile(join(SCREENSHOTS, `export-count-${language}.md`), counted);
        await writeFile(join(SCREENSHOTS, `export-names-${language}.md`), named);
        await writeFile(join(SCREENSHOTS, `check-record-${language}.csv`), csv);
        const pdfName = (await readdir(out)).find((name) => name.endsWith(".pdf"));
        if (pdfName)
          await copyFile(join(out, pdfName), join(SCREENSHOTS, `check-record-${language}.pdf`));
        await screenshot(window, `export-saved-${language}`);
      }
      await app.close();
    } finally {
      await removeDataFolder(out);
    }
  });
}

/** A workbook Excel reads only in part: two hidden sheets, and rows past the reading limit. */
const WORKBOOK = () =>
  xlsxOf([
    { name: "Visible", rows: [["Region"]] },
    { name: "Q3 raw", state: "hidden", rows: [["Secret"], ["1"]] },
    { name: "Q4 raw", state: "veryHidden", rows: [["Secret"], ["2"]] },
    {
      name: "Big",
      rows: Array.from({ length: MAX_ROWS + 5 }, (_, index) => [`R${index + 1}`, index]),
    },
    { name: "After", rows: [["never read"]] },
  ]);

for (const language of ["en", "zh-CN"] as const) {
  test(`the list names the sheets and rows a workbook didn't read (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await start(language, {
      ...FILES,
      "Budget 2026.xlsx": WORKBOOK(),
    });
    const answer = await askInAssistant(window, "What do tides do?");
    const line = answer.getByTestId("unread-files");
    await expect(line).toContainText(
      language === "en" ? "4 files couldn’t be read" : "4 个文件未能读取",
    );
    await pointAndClick(window, line.getByTestId("unread-files-show"));
    const row = line.getByTestId("unread-file").filter({ hasText: "Budget 2026.xlsx" });
    await expect(row).toHaveAttribute("data-reason", "parts");
    await expect(row).toHaveText(
      language === "en"
        ? /the hidden sheets “Q3 raw”, “Q4 raw” weren’t read; “Big”: rows 20,000\+ weren’t read; “After”: the whole sheet wasn’t read/
        : /隐藏工作表“Q3 raw”、“Q4 raw”未读取；“Big”：第 20,000 行及之后的内容未读取；“After”：整张工作表未读取/,
    );
    await screenshot(window, `answer-workbook-${language}`);
    await app.close();
  });
}
