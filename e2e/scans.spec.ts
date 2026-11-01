import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { FakeScanScript } from "../src/core/documents/scan/fake";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSteps,
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
    badge: "Check the page",
    matches: "Matches the page",
    checked: "Checked on the page by you",
    where: "(scan), p. 1",
    checkLine: "1 can’t be checked",
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
    badge: "请核对原页",
    matches: "原页无误",
    checked: "已由你对照原页核对",
    where: "（扫描件），第 1 页",
    checkLine: "1 处无法核对",
  },
} as const;

/** Each language's scan of a figure a word may have misread, the Questions, and what the app shows. */
const FIGURES = {
  en: {
    page: "en-noisy",
    line: "Ferry passengers rose to 74,450 between June and August, against 61,200 a year earlier.",
    state: "How many ferry passengers were there? State the figure.",
    grow: "How much did ferry passengers grow?",
    card: "It comes from “74,450”",
    unclear: "The scan is unclear, so I can't work that figure out",
    badge: "Check the page",
  },
  "zh-CN": {
    page: "zh-noisy",
    line: "夏季渡轮乘客增至 74,450 人次，上年为 61,200 人次。",
    state: "夏季渡轮乘客有多少人？写出数字。",
    grow: "夏季渡轮乘客增长了多少？",
    card: "它来自“74,450”",
    unclear: "扫描件上的这个数字识别不清",
    badge: "请核对原页",
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

/** Opens a scanned Citation's card, from its chip in `where`. */
async function cardOf(window: Page, chip: Locator): Promise<Locator> {
  await chip.hover();
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  return card;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a scanned PDF is read page by page, and a quote with a word it may have misread asks for a look at the page (${language})`, async () => {
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
    // The quote is in the text the scan gave, but a word of it may be misread: it asks for a look
    // at the page instead of the found check.
    await expect(citation).toHaveAttribute("data-check", "cant-check");
    // The Answer's check line counts it with the Citations that can't be checked, not as found.
    const steps = await openSteps(window, answer);
    await expect(steps.locator('[data-step="check"]')).toContainText(chosen.checkLine);

    // Its card says what to check, names the Document as a scan, and marks the word that may be
    // misread, over the picture of the page with the quote washed and the word outlined.
    const card = await cardOf(window, citation.getByTestId("citation-chip"));
    await expect(card.getByTestId("citation-badge")).toContainText(chosen.badge);
    await expect(card.getByTestId("citation-scan")).toHaveText(chosen.scan);
    await expect(card.getByTestId("citation-unsure-word")).toHaveText([...chosen.marked]);
    await expect(card.getByTestId("citation-card-head")).toContainText(chosen.where);
    await expect(card.getByTestId("citation-scan-picture")).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("citation-scan-page")).toBeVisible();
    await expect(card.getByTestId("citation-scan-unsure").first()).toBeAttached();
    await expect(card.getByTestId("citation-matches-page")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

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
    // The margin mark asks for the page too, in the same quiet grey.
    const margin = viewer.getByTestId("viewer-quote-mark");
    await expect(margin).toHaveAttribute("data-check", "cant-check");
    // The text read lies over the picture as a PDF's own text does: it can be selected.
    await highlights.first().dblclick();
    const selected = await window.evaluate(() => globalThis.getSelection()?.toString() ?? "");
    expect(selected.trim().length).toBeGreaterThan(0);
    expect(chosen.washed).toContain(selected.trim());

    // The card's own Open brings the page back with the quote washed, as the chip does.
    await window.getByTestId("document-tab").getByTestId("tab-close").first().click();
    await expect(viewer).toHaveCount(0);
    const openCard = await cardOf(window, citation.getByTestId("citation-chip"));
    await openCard.getByTestId("citation-open").click();
    await expect(window.getByTestId("viewer")).toBeVisible();
    await expect(
      window.getByTestId("viewer").locator("[data-quote-highlight]").first(),
    ).toBeVisible();

    // In a Note, the User compares the quote with the page: Matches the page makes it found, and
    // ⌘Z takes that back.
    await addToNote(window, answer);
    const inNote = window.getByTestId("mind-editor").getByTestId("citation").last();
    await expect(inNote).toHaveAttribute("data-check", "cant-check");
    const noteCard = await cardOf(window, inNote.getByTestId("citation-chip"));
    await noteCard.getByTestId("citation-matches-page").click();
    await expect(inNote).toHaveAttribute("data-check", "found");
    const checked = await cardOf(window, inNote.getByTestId("citation-chip"));
    await expect(checked.getByTestId("citation-page-checked")).toHaveText(chosen.checked);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("citation-card")).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(inNote).toHaveAttribute("data-check", "cant-check");
    await app.close();
  });

  test(`a figure an Answer read from a scan's unsure word is not a quoted one, and calculate refuses it (${language})`, async () => {
    const chosen = FIGURES[language];
    // The line the stand-in reads as unsure, kept first as the scripted model cites the first line
    // of a Chinese Question.
    const lines = [{ text: chosen.line }, ...linesOf(chosen.page).slice(1)];
    const script = join(sources, "scans.json");
    await writeFile(script, JSON.stringify({ pages: { 1: { lines, unsure: ["74,450"] } } }));
    const file = join(sources, "Harbour report.pdf");
    await writeFile(file, buildPdf([{ scan: picture(chosen.page) }]));
    const { app, window } = await launchApp(dataDir, { fakeChat: true, scans: script });
    await dismissChatSetup(window);
    await window.evaluate(async (chosenLanguage) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosenLanguage } });
    }, language);
    // A model measured to use calculate (ADR-0021): the scripted model answers in its place.
    await acceptPlainTextKeys(window);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
    });
    await window.getByTestId("add-documents-input").setInputFiles([file]);
    await expect(window.getByTestId("document-list-item")).toHaveAttribute("data-status", "ready", {
      timeout: 20_000,
    });

    // The Answer states the figure from the quote, so it shows the quiet unchecked wash and "?".
    const answer = await ask(window, chosen.state);
    const citation = answer.getByTestId("citation");
    await expect(citation).toHaveAttribute("data-check", "cant-check");
    const mark = answer.getByTestId("unchecked-figure-mark");
    await expect(mark).toHaveAttribute("data-word", "74,450");
    await expect(answer.getByTestId("unchecked-figure")).toHaveCount(1);

    // Its card says which word it came from, and opens the page to check it.
    await mark.click();
    const card = window.getByTestId("unchecked-figure-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText(chosen.card);
    await expect(card.getByTestId("unchecked-figure-open")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // calculate won't take the number as an input: the model is told so in one line, and says the
    // scan is unclear instead of working with it.
    const grew = await ask(window, chosen.grow);
    await expect(grew).toContainText(chosen.unclear);
    await expect(grew.getByTestId("answer-figures")).toHaveCount(0);
    await app.close();
  });
}

/** The first scan is read for longer than a slow runner needs to find the two behind it. */
const FIRST_SCAN_PAGES = 30;

const LANE = {
  en: { line: "Reading 1 scan, 2 waiting", one: "Reading 1 scan…" },
  "zh-CN": { line: "正在识别 1 个扫描件，2 个排队中", one: "正在识别 1 个扫描件…" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  // protects=a text PDF added after three scans is ready while they are still read, and the sidebar says how many scans are read and how many wait, in English and Chinese (#1502); fails_when=the text PDF waits behind the scans, or the line counts pages or Documents instead of scans; no_claim=how many scans a computer reads at once, which the unit tests cover.
  test(`a text PDF is ready while scans are still read, and the sidebar says how many scans wait (${language})`, async () => {
    test.setTimeout(120_000);
    const script = join(sources, "scans.json");
    const lines = { lines: linesOf("en-clean") };
    const pagesOf = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    await writeFile(
      script,
      JSON.stringify({
        pages: Object.fromEntries(pagesOf(FIRST_SCAN_PAGES).map((page) => [page, lines])),
      }),
    );
    const scanOf = (pages: number) =>
      buildPdf(pagesOf(pages).map(() => ({ scan: picture("en-clean") })));
    const files: string[] = [];
    for (const [name, pages] of [
      ["Scan A.pdf", FIRST_SCAN_PAGES],
      ["Scan B.pdf", 8],
      ["Scan C.pdf", 8],
    ] as const) {
      const file = join(sources, name);
      await writeFile(file, scanOf(pages));
      files.push(file);
    }
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
    await expect(status).toHaveAttribute("title", LANE[language].line, { timeout: 30_000 });
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
