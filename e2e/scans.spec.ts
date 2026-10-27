import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { FakeScanScript } from "../src/core/documents/scan/fake";
import { buildPdf } from "../tests/helpers/pdf";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  useLocalChatModel,
} from "./app";

const SCANS = join(__dirname, "../tests/fixtures/scans");
const picture = (id: string) => readFileSync(join(SCANS, `${id}.jpg`));
/** What the real model read on each page of the set, with each line's box (see eval/ocr/record.check.ts). */
const read = JSON.parse(readFileSync(join(SCANS, "read.json"), "utf8")) as FakeScanScript;
/** Its lines and their boxes, without the words the model happened to be unsure of. */
const linesOf = (id: string) =>
  (read.pages[id]?.lines ?? []).map((line) =>
    typeof line === "string" ? line : { text: line.text, quad: line.quad },
  );

/** Each language's scan, the Question about it, and the words the app shows. */
const CASES = {
  en: {
    pages: ["en-clean", "en-noisy"],
    unsure: ["convenience"],
    marked: ["convenience"],
    washed: "Either party may terminate this Agreement for convenience",
    question: "Can either party terminate for convenience?",
    reading: "Reading 2 scanned pages…",
    scan: "Text read from a scan · 1 word may be misread",
  },
  "zh-CN": {
    pages: ["zh-clean", "zh-noisy"],
    unsure: ["租赁"],
    // Each Chinese character is a word of its own.
    marked: ["租", "赁"],
    washed: "房屋租赁合同",
    question: "押金什么时候退还？",
    reading: "正在识别 2 页扫描件…",
    scan: "从扫描件识别的文字 · 2 处可能识别有误",
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

/** Asks a Question in the assistant, beside a new Mind, and waits for its Answer to finish. */
async function ask(window: Page, text: string) {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  return askInAssistant(window, text);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a scanned PDF is read page by page, a Question about it gets a checked Citation, and the viewer washes the quote on the page's picture (${language})`, async () => {
    const chosen = CASES[language];
    // What the stand-in for the text recognition model reads on each page.
    const script = join(sources, "scans.json");
    await writeFile(
      script,
      JSON.stringify({
        pages: Object.fromEntries(
          chosen.pages.map((id, index) => [
            index + 1,
            { lines: linesOf(id), unsure: [...chosen.unsure] },
          ]),
        ),
      }),
    );
    const file = join(sources, "Scan.pdf");
    await writeFile(file, buildPdf(chosen.pages.map((id) => ({ scan: picture(id) }))));
    const { app, window } = await launchApp(dataDir, { fakeChat: true, scans: script });
    await dismissChatSetup(window);
    await window.evaluate(async (chosenLanguage) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosenLanguage } });
    }, language);
    await useLocalChatModel(window);

    // Its status says its scanned pages are being read, then it is ready.
    await window.getByTestId("add-documents-input").setInputFiles([file]);
    const row = window.getByTestId("document-list-item");
    await expect(row.getByTestId("document-status")).toContainText(chosen.reading);
    await expect(row).toHaveAttribute("data-status", "ready", { timeout: 20_000 });

    const answer = await ask(window, chosen.question);
    const citation = answer.getByTestId("citation");
    await expect(citation).toHaveAttribute("data-check", "found");

    // Its card says the quote was read from a scan, and marks a word that may be misread.
    await citation.getByTestId("citation-chip").hover();
    const card = window.getByTestId("citation-card");
    await expect(card.getByTestId("citation-scan")).toHaveText(chosen.scan);
    await expect(card.getByTestId("citation-unsure-word")).toHaveText([...chosen.marked]);

    // Opened, the viewer washes the quote on the page's picture, over the line it was read from.
    await citation.getByTestId("citation-chip").click();
    const viewer = window.getByTestId("viewer");
    const page = viewer.locator('[data-page-number="1"]');
    const highlights = page.locator("[data-quote-highlight]");
    await expect(highlights.first()).toBeVisible();
    await expect(highlights.first()).toBeInViewport();
    const box = await highlights.first().boundingBox();
    const pageBox = await page.boundingBox();
    expect(box && pageBox).toBeTruthy();
    if (box && pageBox) {
      expect(box.x).toBeGreaterThanOrEqual(pageBox.x);
      expect(box.y).toBeGreaterThanOrEqual(pageBox.y);
      expect(box.x + box.width).toBeLessThanOrEqual(pageBox.x + pageBox.width + 1);
    }
    // It lies over the line read, as the model placed it on the picture.
    expect((await highlights.allTextContents()).join("")).toContain(chosen.washed);
    // The text read lies over the picture as a PDF's own text does: it can be selected.
    await highlights.first().dblclick();
    const selected = await window.evaluate(() => globalThis.getSelection()?.toString() ?? "");
    expect(selected.trim().length).toBeGreaterThan(0);
    expect(chosen.washed).toContain(selected.trim());
    await app.close();
  });
}

const LANE = {
  en: { line: "Reading 1 scan, 2 waiting", one: "Reading 1 scan…" },
  "zh-CN": { line: "正在识别 1 个扫描件，2 个排队中", one: "正在识别 1 个扫描件…" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  // protects=a text PDF added after three scans is ready while they are still read, and the sidebar says how many scans are read and how many wait, in English and Chinese (#1502); fails_when=the text PDF waits behind the scans, or the line counts pages or Documents instead of scans; no_claim=how many scans a computer reads at once, which the unit tests cover.
  test(`a text PDF is ready while scans are still read, and the sidebar says how many scans wait (${language})`, async () => {
    const script = join(sources, "scans.json");
    const lines = { lines: linesOf("en-clean") };
    await writeFile(
      script,
      JSON.stringify({
        pages: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((page) => [page, lines])),
      }),
    );
    const scan = buildPdf([1, 2, 3, 4, 5, 6, 7, 8].map(() => ({ scan: picture("en-clean") })));
    const files = ["Scan A.pdf", "Scan B.pdf", "Scan C.pdf"].map((name) => join(sources, name));
    for (const file of files) await writeFile(file, scan);
    const text = join(sources, "Board minutes.pdf");
    await writeFile(
      text,
      buildPdf([{ lines: ["The board approved the draft budget for 2026-27."] }]),
    );
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      scans: script,
      scansAtOnce: 1,
    });
    await dismissChatSetup(window);
    await window.evaluate(async (chosenLanguage) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosenLanguage } });
    }, language);
    // With a model chosen, no asking for a model takes the status row.
    await useLocalChatModel(window);

    await window.getByTestId("add-documents-input").setInputFiles([...files, text]);
    const rows = window.getByTestId("document-list-item");
    const status = window.getByTestId("processing-status");
    await expect(status).toHaveAttribute("title", LANE[language].line);
    const minutes = rows.filter({ hasText: "Board minutes" });
    await expect(minutes).toHaveAttribute("data-status", "ready");
    // Ready while the scans are still read: the last of them is still queued.
    await expect(rows.filter({ hasText: "Scan C" })).toHaveAttribute("data-status", "queued");

    await expect(status).toHaveAttribute("title", LANE[language].one, { timeout: 30_000 });
    for (const name of ["Scan A", "Scan B", "Scan C"]) {
      await expect(rows.filter({ hasText: name })).toHaveAttribute("data-status", "ready", {
        timeout: 30_000,
      });
    }
    await expect(status).toHaveCount(0);
    await app.close();
  });
}
