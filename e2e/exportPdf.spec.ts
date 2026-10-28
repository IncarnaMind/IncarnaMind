import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type * as Y from "yjs";
import {
  CHART_NODE,
  type CitationAttributes,
  type CitationLocation,
  type CoreBridge,
  type Document,
} from "../src/core/api";
import type { ChartAttributes, ChartValue } from "../src/shared/charts";
import {
  addDocuments,
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  interceptOpenDialog,
  interceptOpenPath,
  interceptShowItemInFolder,
  launchApp,
  type MindChild,
  mindNode,
  motionSettled,
  nameMind,
  newMind,
  openOptions,
  openSavedPage,
  pathsOpened,
  pathsShown,
  pointAndClick,
  removeDataFolder,
  savedLine,
  savedPath,
  setWindowSize,
  useOutputLocation,
  WINDOW_SIZE,
} from "./app";
import { pdfPictures, pdfText } from "./pdfText";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await target.screenshot({ path: join(folder, `${name}.png`) });
}

const bridge = (window: Page) => ({
  documents: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    ),
  saveWebPage: (address: string, html: string) =>
    window.evaluate(
      ([at, page]) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveWebPage({
          address: at,
          html: page,
        }),
      [address, html] as const,
    ),
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
  /** Adds Blocks to a Mind, as an edit from another device arrives. */
  write: (mindId: string, update: Uint8Array) =>
    window.evaluate(
      ([id, bytes]) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.applyMindUpdate(
          id,
          new Uint8Array(bytes),
        ),
      [mindId, Array.from(update)] as const,
    ),
});

const paragraph = (...children: MindChild[]) =>
  mindNode("paragraph", { id: randomUUID() }, children);

type Cited = Pick<Document, "id" | "name" | "contentHash">;

function citationAttributes(
  document: Cited,
  page: number,
  check: "found" | "not-found",
  location: CitationLocation | null = null,
): CitationAttributes {
  return {
    passageId: "passage-1",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: page,
    pageTo: page,
    location,
    quote: "Spring tides happen at new moon.",
    check,
    checkReason: check === "found" ? null : "quote-not-on-pages",
  };
}

const citation = (...given: Parameters<typeof citationAttributes>) =>
  mindNode("citation", { ...citationAttributes(...given) });

const cell = (kind: "tableHeader" | "tableCell", ...children: MindChild[]) =>
  mindNode(kind, { colspan: 1, rowspan: 1 }, [paragraph(...children)]);

const ARTICLE = readFile(join(__dirname, "../tests/fixtures/web/article.html"), "utf8");
const ADDRESS = "https://reader.example/tea";

/** Text compared without its spaces and line breaks, which fonts and wrapping decide. */
const unspaced = (text: string) => text.replace(/\s+/g, "");

/** Opens a new Mind titled `title`, and adds the two Documents it cites. Returns its id. */
async function setUpMind(window: Page, folder: string, title: string) {
  await newMind(window);
  await nameMind(window, title);
  const mindId = await window.getByTestId("mind-pane").getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind is open.");
  await writeFile(join(folder, "Tides.txt"), "Spring tides happen at new moon.");
  await writeFile(join(folder, "潮汐.txt"), "大潮出现在新月和满月前后。");
  await addDocuments(window, [join(folder, "Tides.txt"), join(folder, "潮汐.txt")]);
  return mindId;
}

async function documentNamed(window: Page, name: string): Promise<Document> {
  const found = (await bridge(window).documents()).find((each) => each.name === name);
  if (!found) throw new Error(`No Document named ${name}.`);
  return found;
}

/** Export as PDF, from the Export button's menu, while Word is still the last format. */
async function exportAsPdf(window: Page): Promise<void> {
  await exportFromMenu(window, "pdf");
}

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

test("a Mind with English and Chinese Citations, a table and maths prints as a PDF whose text, footnotes and all, is as it should be", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  const mindId = await setUpMind(window, sources, "Tides 潮汐");
  const saved = await bridge(window).saveWebPage(ADDRESS, await ARTICLE);
  if (saved.outcome !== "saved") throw new Error("The web page wasn't saved.");
  await expect
    .poll(async () => (await bridge(window).documents()).map((each) => each.status))
    .toEqual(["ready", "ready", "ready"]);
  const tides = await documentNamed(window, "Tides");
  const chinese = await documentNamed(window, "潮汐");
  const web = await documentNamed(window, "Tea - The Open Encyclopedia");
  await bridge(window).write(
    mindId,
    blocksUpdate([
      mindNode("heading", { id: randomUUID(), level: 1 }, ["Spring tides"]),
      paragraph(
        "Spring tides happen at new moon and at full moon",
        citation(tides, 1, "found"),
        ".",
      ),
      paragraph("大潮出现在新月和满月前后", citation(chinese, 1, "found"), "。"),
      paragraph(
        "The pull that raises them falls off as ",
        mindNode("inlineMath", { latex: "1/r^3" }),
        ", faster than gravity:",
      ),
      mindNode("blockMath", { id: randomUUID(), latex: "F = G\\frac{m_1 m_2}{r^2}" }),
      mindNode("table", { id: randomUUID() }, [
        mindNode("tableRow", {}, [
          cell("tableHeader", "Tide 潮"),
          cell("tableHeader", "Range 潮差"),
        ]),
        mindNode("tableRow", {}, [
          cell("tableCell", "Spring 大潮"),
          cell("tableCell", "4 m", citation(tides, 1, "found")),
        ]),
        mindNode("tableRow", {}, [
          cell("tableCell", "Neap 小潮"),
          cell("tableCell", "2 m", citation(chinese, 1, "not-found")),
        ]),
      ]),
      paragraph(
        "Tea reached Europe through Portuguese merchants",
        citation(web, 1, "found", {
          kind: "section",
          heading: "History",
          paragraphs: { from: 3, to: 3 },
        }),
        ".",
      ),
    ]),
  );
  await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(5);

  // Export as PDF: the Mind says so, and the file is there.
  const out = await createDataFolder();
  await useOutputLocation(window, out);
  await exportAsPdf(window);
  const path = await savedPath(window, "Tides 潮汐.pdf");
  const pdf = await readFile(path);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const shots = process.env.INCARNAMIND_SCREENSHOTS;
  if (shots) await writeFile(join(shots, "export-golden.pdf"), pdf);

  // One page: the body, then its footnotes at its foot, then its number. Each footnote names
  // its Document and Location; the web page's, its site, its address and the day the quoted
  // version was fetched. The Chinese copies as Chinese, and the maths as maths.
  const fetched = web.web?.versions[0]?.fetchedAt ?? "";
  const accessed = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(fetched));
  const golden = [
    "Spring tides",
    "Spring tides happen at new moon and at full moon1.",
    "大潮出现在新月和满月前后2。",
    "The pull that raises them falls off as 1/𝑟3, faster than gravity:",
    "𝐹 = 𝐺𝑚1𝑚2𝑟2",
    "Tide 潮 Range 潮差",
    "Spring 大潮 4 m3",
    "Neap 小潮 2 m4",
    "Tea reached Europe through Portuguese merchants5.",
    "1 Tides, p. 1",
    "2 潮汐, p. 1",
    "3 Tides, p. 1",
    "4 潮汐, p. 1 [unverified]",
    `5 Tea, The Open Encyclopedia, § History, ¶ 3, ${ADDRESS}, accessed ${accessed}`,
    "1",
  ].join("\n");
  expect((await pdfText(pdf)).map(unspaced)).toEqual([unspaced(golden)]);

  // Open and Show in Finder go to the system's apps: stood in for here.
  await interceptOpenPath(app);
  await interceptShowItemInFolder(app);
  const result = window.getByTestId("export-result");
  await pointAndClick(window, result.getByTestId("export-open"));
  await expect.poll(() => pathsOpened(app)).toEqual([path]);
  await pointAndClick(window, result.getByTestId("export-show"));
  await expect.poll(() => pathsShown(app)).toEqual([path]);

  // A quote not found is said under the line; Show takes the User to its Citation.
  await expect(result.getByTestId("export-unverified")).toHaveText(
    "1 quote not found, marked unverified · Show",
  );
  await pointAndClick(window, result.getByTestId("export-unverified-show"));
  const notFound = window
    .getByTestId("mind-editor")
    .locator('[data-testid="citation"][data-check="not-found"]')
    .getByTestId("citation-chip");
  await expect(notFound).toBeFocused();
  await app.close();
  await removeDataFolder(out);
});

test("a Mind with one chart prints its picture, drawn at twice its size, its caption, and its sources as footnotes", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  const mindId = await setUpMind(window, sources, "Tides 潮汐");
  await expect
    .poll(async () => (await bridge(window).documents()).map((each) => each.status))
    .toEqual(["ready", "ready"]);
  const tides = await documentNamed(window, "Tides");
  const chinese = await documentNamed(window, "潮汐");
  const value = (shown: string, row: number, cited: CitationAttributes | null): ChartValue => ({
    shown,
    value: Number(shown),
    unit: null,
    scale: null,
    citation: cited,
    from: { kind: "cell", row, column: 1 },
  });
  const chart: ChartAttributes = {
    kind: "bar",
    title: "Tidal range 潮差",
    drawn: null,
    source: { kind: "table", blockId: null },
    data: {
      labelHeading: "Tide 潮",
      series: ["Range 潮差 (m)"],
      cutFrom: null,
      cutRows: [],
      rows: [
        { label: "Spring 大潮", values: [value("4", 1, citationAttributes(tides, 1, "found"))] },
        { label: "Neap 小潮", values: [value("2", 2, citationAttributes(chinese, 1, "found"))] },
        { label: "Mean 平均", values: [value("3", 3, null)] },
      ],
    },
  };
  await bridge(window).write(
    mindId,
    blocksUpdate([mindNode(CHART_NODE, { id: randomUUID(), ...chart })]),
  );
  await expect(window.getByTestId("mind-editor").getByTestId("chart-point")).toHaveCount(3);

  const out = await createDataFolder();
  await useOutputLocation(window, out);
  await exportAsPdf(window);
  const pdf = await readFile(await savedPath(window, "Tides 潮汐.pdf"));
  const shots = process.env.INCARNAMIND_SCREENSHOTS;
  if (shots) await writeFile(join(shots, "export-chart.pdf"), pdf);

  // The picture, as Word has it: the app draws it at twice the page's width, for print.
  const [pictures] = await pdfPictures(pdf);
  expect(pictures).toEqual([{ width: 1200, height: expect.any(Number) }]);
  // Under it, its caption, then its sources: each a footnote naming its Document and
  // Location, numbered with the rest, and the value with no Citation said in words.
  const golden = [
    "Chart: Tidal range 潮差",
    "Source: 1,2 1 value has no Citation.",
    "1 Tides, p. 1",
    "2 潮汐, p. 1",
    "1",
  ].join("\n");
  expect((await pdfText(pdf)).map(unspaced)).toEqual([unspaced(golden)]);

  // In Chinese, the words are Chinese.
  await bridge(window).language("zh-CN");
  await exportFromMenu(window);
  await expect(window.getByTestId("export-done")).toContainText(
    savedLine("Tides 潮汐 2.pdf", out, "zh-CN"),
    {
      timeout: 30_000,
    },
  );
  const chineseText = await pdfText(await readFile(join(out, "Tides 潮汐 2.pdf")));
  expect(chineseText.map(unspaced)).toEqual([
    unspaced(
      [
        "图表：Tidal range 潮差",
        "数据来源：1,2 1 个数值没有引用。",
        "1 Tides，第 1 页",
        "2 潮汐，第 1 页",
        "1",
      ].join("\n"),
    ),
  ]);
  await app.close();
  await removeDataFolder(out);
});

test("a long Mind breaks into pages: each footnote is on the page of its marker, and a table's heading row comes again on each page it reaches", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  const mindId = await setUpMind(window, sources, "A long Mind");
  const tides = await documentNamed(window, "Tides");
  const chinese = await documentNamed(window, "潮汐");
  const words = (count: number) =>
    Array.from({ length: count }, (_, index) => ["tide", "moon", "water", "shore"][index % 4]).join(
      " ",
    );
  const blocks: Y.XmlElement[] = [];
  for (let number = 1; number <= 40; number++) {
    // Every seventh paragraph runs to many lines, so some split between pages.
    const length = number % 7 === 0 ? 160 : 12 + (number % 5) * 8;
    blocks.push(
      paragraph(
        `Paragraph ${number} opens`,
        citation(tides, number, "found"),
        ` ${words(length)}.`,
      ),
    );
  }
  const rows = Array.from({ length: 45 }, (_, index) =>
    mindNode("tableRow", {}, [
      cell("tableCell", `Row ${index + 1} cell`, citation(chinese, index + 1, "found")),
      cell("tableCell", "大潮出现在新月和满月前后"),
    ]),
  );
  blocks.push(
    mindNode("table", { id: randomUUID() }, [
      mindNode("tableRow", {}, [cell("tableHeader", "Tide 潮"), cell("tableHeader", "Note 注")]),
      ...rows,
    ]),
  );
  await bridge(window).write(mindId, blocksUpdate(blocks));
  await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(85);

  const out = await createDataFolder();
  await useOutputLocation(window, out);
  await exportAsPdf(window);
  const pdf = await readFile(await savedPath(window, "A long Mind.pdf"));
  const shots = process.env.INCARNAMIND_SCREENSHOTS;
  if (shots) await writeFile(join(shots, "export-long.pdf"), pdf);
  const pages = (await pdfText(pdf)).map((page) => page.replace(/\s+/g, " "));

  expect(pages.length).toBeGreaterThanOrEqual(4);
  const numbers = (page: string, pattern: RegExp) =>
    [...page.matchAll(pattern)].map((match) => Number(match[1])).sort((a, b) => a - b);
  const seen = { paragraphs: [] as number[], rows: [] as number[] };
  pages.forEach((page, index) => {
    // A paragraph's marker is in its first line, with its number; its note is on that page.
    const paragraphs = numbers(page, /Paragraph (\d+) opens/g);
    expect(numbers(page, /\d+ Tides, p\. (\d+)/g), `page ${index + 1}`).toEqual(paragraphs);
    const here = numbers(page, /Row (\d+) cell/g);
    expect(numbers(page, /\d+ 潮汐, p\. (\d+)/g), `page ${index + 1}`).toEqual(here);
    if (here.length > 0) expect(page).toContain("Tide 潮 Note 注");
    expect(page.trim().endsWith(String(index + 1))).toBe(true);
    seen.paragraphs.push(...paragraphs);
    seen.rows.push(...here);
  });
  // Nothing is lost or doubled between pages.
  expect(seen.paragraphs).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  expect(seen.rows).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
  expect(pages.filter((page) => page.includes("Row ")).length).toBeGreaterThanOrEqual(2);
  await app.close();
  await removeDataFolder(out);
});

test("Export options remembers the format and its options; Export and ⇧⌘E use them; the result line says where the file went, and what to do when it can't be saved", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Tides");
  await pointAndClick(window, window.getByTestId("mind-editor"));
  await window.keyboard.type("Spring tides come twice a month.");
  const out = await createDataFolder();
  await useOutputLocation(window, out);

  const exportButton = window.getByTestId("export-mind");
  await expect(exportButton).toHaveAttribute("data-format", "docx");
  const exportMenu = window.getByTestId("export-menu");
  await pointAndClick(window, exportButton);
  await expect(exportMenu.getByRole("menuitem")).toHaveText([
    /^Word \(\.docx\)(⇧⌘E|Ctrl\+Shift\+E)$/,
    "Not checked since your last edit · Check first",
    "PDF",
    "More formats",
    /^Citation style/,
    "Export options…",
  ]);
  await window.keyboard.press("Escape");

  // The sheet opens with the options last saved; Cancel leaves them so.
  const sheet = window.getByTestId("export-dialog");
  await openOptions(window, "Export options");
  const format = sheet.getByTestId("export-format");
  await expect(format).toHaveValue("docx");
  await expect(sheet.getByTestId("export-format-note")).toHaveText(
    "Citations become Word footnotes, each naming its Document and Location.",
  );
  // Word's review choices (#107), on to begin with; a Mind made here has no import to track edits since.
  await expect(sheet.getByTestId("export-pending-note")).toHaveText(
    "Changes waiting for you go in as IncarnaMind’s tracked changes.",
  );
  await expect(sheet.getByTestId("export-mark-ai-text-mark")).toBeChecked();
  await expect(sheet.getByTestId("export-comment-failed-checks")).toBeChecked();
  await expect(sheet.getByTestId("export-track-changes")).toHaveCount(0);
  await expect(sheet.getByTestId("export-save-to")).toHaveText(
    (await realpath(out)).split(/[\\/]/).at(-1) ?? "",
  );
  await screenshot(window, "export-options-en-wide");
  await format.selectOption("pdf");
  await expect(sheet.getByTestId("export-format-note")).toHaveText(
    "Citations become footnotes with the Document and Location.",
  );
  await expect(sheet.getByTestId("export-mark-ai-text")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
  await openOptions(window, "Export options");
  await expect(format).toHaveValue("docx");

  // PDF, with the Questions, saved: Export and ⇧⌘E make a PDF now, and the sheet remembers.
  await format.selectOption("pdf");
  const questions = sheet.getByTestId("export-include-questions");
  await questions.check();
  await sheet.getByTestId("export-save").click();
  await expect(sheet).toBeHidden();
  await expect(exportButton).toHaveAttribute("data-format", "pdf");
  await openOptions(window, "Export options");
  await expect(format).toHaveValue("pdf");
  await expect(questions).toBeChecked();
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await pointAndClick(window, window.getByTestId("mind-editor"));
  await window.keyboard.press("ControlOrMeta+Shift+E");
  const result = window.getByTestId("export-result");
  const first = await savedPath(window, "Tides.pdf");
  await screenshot(window, "export-result-en-wide");
  await exportFromMenu(window);
  await savedPath(window, "Tides 2.pdf");
  expect((await readFile(first)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect((await readdir(out)).sort()).toEqual(["Tides 2.pdf", "Tides.pdf"]);
  await pointAndClick(window, result.getByTestId("export-dismiss"));
  await expect(result).toHaveCount(0);

  // The save location has gone, folder and all: the line says so, and Change output location…
  // saves it somewhere else.
  const gone = join(sources, "Exports", "Tides");
  await mkdir(gone, { recursive: true });
  await useOutputLocation(window, gone);
  await rm(join(sources, "Exports"), { recursive: true });
  await exportFromMenu(window);
  const problem = result.getByTestId("export-problem");
  await expect(problem).toHaveText(
    "Couldn’t save: the folder isn’t there any more · Change output location…",
  );
  await interceptOpenDialog(app, out);
  await pointAndClick(window, problem.getByTestId("export-change-location"));
  await savedPath(window, "Tides 3.pdf");

  // In Chinese, at the narrowest window, the sheet and the line fit, in Chinese.
  await bridge(window).language("zh-CN");
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await pointAndClick(window, exportButton);
  await expect(exportMenu.getByRole("menuitem")).toHaveText([
    /^PDF(⇧⌘E|Ctrl\+Shift\+E)$/,
    "Word（.docx）",
    "上次编辑后未核对 · 先核对",
    "更多格式",
    /^引用格式/,
    "导出选项…",
  ]);
  await window.keyboard.press("Escape");
  await openOptions(window, "导出选项");
  await expect(sheet.getByTestId("export-format-note")).toHaveText(
    "引用会成为脚注，写明文档和位置。",
  );
  await format.selectOption("docx");
  await expect(sheet.getByTestId("export-pending-note")).toHaveText(
    "尚未接受的修订会以 IncarnaMind 的修订写入。",
  );
  await expect(sheet.getByTestId("export-mark-ai-text")).toHaveAccessibleName(
    "标出 IncarnaMind 写的内容？",
  );
  const [sheetBox, windowWidth] = await Promise.all([
    sheet.boundingBox(),
    window.evaluate(() => globalThis.innerWidth),
  ]);
  if (!sheetBox) throw new Error("The sheet isn't laid out.");
  expect(sheetBox.x).toBeGreaterThanOrEqual(0);
  expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(windowWidth);
  await motionSettled(window);
  await screenshot(window, "export-options-zh-narrow");
  await window.keyboard.press("Escape");
  await exportFromMenu(window);
  await expect(result.getByTestId("export-done")).toContainText(
    savedLine("Tides 4.pdf", out, "zh-CN"),
    {
      timeout: 30_000,
    },
  );
  await screenshot(window, "export-result-zh-narrow");
  await app.close();
  await removeDataFolder(out);
});

test("Export as HTML saves one .html file whose footnotes link both ways, and the sheet offers the format", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
  await dismissChatSetup(window);
  const mindId = await setUpMind(window, sources, "Tides 潮汐");
  await expect
    .poll(async () => (await bridge(window).documents()).map((each) => each.status))
    .toEqual(["ready", "ready"]);
  const tides = await documentNamed(window, "Tides");
  const chinese = await documentNamed(window, "潮汐");
  await bridge(window).write(
    mindId,
    blocksUpdate([
      paragraph(
        "Spring tides happen at new moon",
        citation(tides, 1, "found"),
        ". 大潮出现在新月前后",
        citation(chinese, 1, "found"),
        citation(tides, 1, "found"),
        "。",
      ),
      paragraph("大潮出现在新月和满月前后", citation(chinese, 1, "not-found"), "。"),
    ]),
  );
  await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(4);
  const out = await createDataFolder();
  await useOutputLocation(window, out);

  await exportFromMenu(window, "html");
  const path = await savedPath(window, "Tides 潮汐.html");
  const html = await readFile(path, "utf8");
  expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(html).toContain('<sup class="note-ref" id="ref-1"><a href="#note-1">1</a></sup>');
  expect(html).toContain('<li id="note-2">潮汐, p. 1');
  expect(html).toContain('<a class="backref" href="#ref-2"');
  expect(html).not.toMatch(/<script|<link|src="http/);

  const reader = await openSavedPage(app, path);
  try {
    for (const width of [1280, 390]) {
      await setWindowSize(app, reader, width, 844);
      await expect(reader.locator("main > p").filter({ has: reader.locator("#ref-1") })).toHaveText(
        "Spring tides happen at new moon1. 大潮出现在新月前后2,3。",
      );
      expect(
        await reader
          .locator("sup.note-ref")
          .evaluateAll((markers) =>
            markers.map((marker) => getComputedStyle(marker, "::before").content),
          ),
      ).not.toContain('","');
      await screenshot(reader, `html-citation-separators-${width}`);
    }
    await reader.locator("#ref-2 a").click();
    await expect(reader).toHaveURL(/#note-2$/);
    await reader.locator("#note-2 .backref").click();
    await expect(reader).toHaveURL(/#ref-2$/);
  } finally {
    await reader.close();
  }

  // Export now makes HTML, and the sheet offers the format with its note.
  await expect(window.getByTestId("export-mind")).toHaveAttribute("data-format", "html");
  await openOptions(window, "Export options");
  const sheet = window.getByTestId("export-dialog");
  await expect(sheet.getByTestId("export-format")).toHaveValue("html");
  await expect(sheet.getByTestId("export-format-note")).toHaveText(
    "Opens in any browser; Citations become linked footnotes.",
  );
  await app.close();
  await removeDataFolder(out);
});
