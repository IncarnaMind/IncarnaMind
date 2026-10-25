import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, DocumentStatus } from "../src/core/api";
import { encryptedOfficeFile } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import {
  askInAssistant,
  checkCard,
  useLocalChatModel as connectLocalChatModel,
  copyFrom,
  createDataFolder,
  dismissChatSetup,
  expectDotsBetweenParts,
  interceptOpenDialog,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setGroupBeside,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/**
 * Every Answer, check and Verify run says which files in its scope couldn't
 * be read, and why (#740): a Folder with a .doc, a password-protected .docx
 * and a scan, besides a file that reads. "3 files couldn't be read · Show"
 * lists each with its reason, and the Library shows the file in a format not
 * read. Nothing shows when everything was read. English and Chinese. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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
  "Locked.docx": encryptedOfficeFile(),
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
      ["Locked.docx", /Password-protected/],
      ["Scan.pdf", /A scan with no text that could be recognized/],
    ],
  },
  "zh-CN": {
    count: "3 个文件未能读取",
    reasons: [
      ["Contract.doc", /暂不支持此格式（\.doc）/],
      ["Locked.docx", /已设置密码/],
      ["Scan.pdf", /扫描件，未识别出文字/],
    ],
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
    await expect(rows.filter({ hasText: "Locked.docx" })).toHaveAttribute(
      "data-reason",
      "password",
    );
    await expect(rows.filter({ hasText: "Scan.pdf" })).toHaveAttribute("data-reason", "scan");

    // A Document's name opens it; a file in a format not read isn't a Document. A scan that
    // text recognition found nothing in has nothing to read again.
    await expect(rows.getByTestId("unread-file-open")).toHaveText(["Locked.docx", "Scan.pdf"]);
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

    // The Library shows the file in a format not read, with the same reason.
    await setGroupBeside(window, true);
    const unread = window.getByTestId("library-unread");
    await expect(unread).toContainText(
      language === "en" ? "1 file couldn’t be read" : "1 个文件未能读取",
    );
    await unread.getByTestId("library-unread-show").click();
    await expect(unread.getByTestId("unread-file")).toHaveText(
      language === "en" ? /Contract\.doc: Format not read yet/ : /Contract\.doc：暂不支持此格式/,
    );

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
