import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreApi, CoreBridge } from "../src/core/api";
import { docxOf, xlsxOf } from "../tests/helpers/office";
import { buildPdf, type PdfPage } from "../tests/helpers/pdf";
import { para, pptxOf, sp, xfrm } from "../tests/helpers/pptx";
import {
  acceptPlainTextKeys,
  addDocuments,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  newMind,
  paletteFound,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  stubClipboard,
} from "./app";

/*
 * Selecting a range of cells in a sheet (#118), a whole slide, or an area of a page:
 * each goes into the composer as its own chip, its Citation is checked where the User
 * picked it, and Add to note and Copy put the cells in the note or on the clipboard.
 */

const REVENUE = xlsxOf([
  {
    name: "Revenue",
    rows: [
      ["Revenue by segment"],
      ["£m, unaudited"],
      [],
      ["", "Q1", "Q2", "Q3", "9 months"],
      ["2025"],
      [],
      ["Stores", 1412, 1438, 1446, 4296],
      ["Online", 318, 326, 341, 985],
      ["Wholesale", 96, 98, 101, 295],
      [],
      ["2026"],
      ["Stores", 1431, 1452, 1470, 4353],
      ["Online", 352, 361, 329, 1042],
      ["Wholesale", 99, 97, 92, 288],
    ],
  },
]);

const DECK = pptxOf({
  slides: ["Q3 at a glance", "Cash and the final dividend"].map((title, index) => ({
    shapes: sp({
      spPr: xfrm(914400, 914400, 7315200, 1828800),
      body: para(index === 0 ? title : "Closing cash £1.42m after Q2, down 8% on Q1."),
    }),
  })),
});

/** 220 rows of a wide sheet: its block of rows ends well before row 20. */
const WIDE = xlsxOf([
  {
    name: "Wide",
    rows: [
      ["Segment", "Q1", "Q2", "Q3", "Q4", "H1", "H2", "Y1", "Y2"],
      ...Array.from({ length: 220 }, (_, at) => [
        `Row ${at + 1}`,
        ...Array.from({ length: 8 }, (_, column) => `${1234567890 + at * 100 + column}`),
      ]),
    ],
  },
]);

/** A header the sheet starts below its first ten rows. */
const LATE_HEADER = xlsxOf([
  {
    name: "Late",
    rows: [...Array.from({ length: 12 }, () => []), ["Name", "Value"], ["A", "1"], ["B", "2"]],
  },
]);

/** A cell that would be markup if the copy wrote its own HTML. */
const ESCAPING = xlsxOf([
  {
    name: "Cells",
    rows: [
      ["Head", "Value"],
      ["<b>x</b>", "1"],
    ],
  },
]);

/** A slide with no words at all: its shape draws nothing. */
const BARE_DECK = pptxOf({
  slides: [
    { shapes: sp({ spPr: xfrm(914400, 914400, 7315200, 1828800) }) },
    {
      shapes: sp({
        spPr: xfrm(914400, 914400, 7315200, 1828800),
        body: para("Cash and the final dividend"),
      }),
    },
  ],
});

/** A page whose chart is drawn as bars, its labels and figures in its text layer. */
const CHART: PdfPage = {
  lines: ["Promoted share of grocery sales"],
  placed: [
    { text: "Northwind 34.0", x: 100, y: 520 },
    { text: "Brightmart 31.6", x: 100, y: 490 },
    { text: "Harrow Foods 28.9", x: 100, y: 460 },
    { text: "Calder Grocers 26.2", x: 100, y: 430 },
  ],
  drawn: [
    { rectangle: [260, 515, 120, 20], gray: 0.7 },
    { rectangle: [260, 485, 100, 20], gray: 0.7 },
    { rectangle: [260, 455, 84, 20], gray: 0.7 },
    { rectangle: [260, 425, 70, 20], gray: 0.7 },
  ],
};

/** A page whose figure is a picture: no text under it, so nothing there to check. */
const PICTURE: PdfPage = { image: true, lines: ["Figure 1. Closing cash by month"] };

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

interface Setup {
  app: Awaited<ReturnType<typeof launchApp>>["app"];
  window: Page;
}

/** The app with the scripted model, a new Mind, and the files added and read. */
async function setUp({
  files,
  model = true,
  localModel,
  language = "en",
  textOnly = false,
  mind = true,
}: {
  files: { name: string; bytes: Uint8Array | Buffer }[];
  model?: boolean;
  /** The local model to set up, when it isn't the fake one: an unknown one, say. */
  localModel?: string;
  language?: "en" | "zh-CN";
  textOnly?: boolean;
  mind?: boolean;
}): Promise<Setup> {
  const paths: string[] = [];
  for (const file of files) {
    const path = join(sources, file.name);
    await writeFile(path, file.bytes);
    paths.push(path);
  }
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  if (textOnly) {
    // A catalog model that reads text alone: the area chip says it can't be used.
    await acceptPlainTextKeys(window);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreApi }).incarnamind;
      await bridge.saveChatProvider({
        kind: "openai",
        apiKey: "sk-proj-a-made-up-key",
        modelId: "gpt-4",
      });
    });
  } else if (model) {
    await connectLocalChatModel(window, localModel);
  }
  await setLanguage(window, language);
  await addDocuments(window, paths);
  await expectReadyDocuments(window, paths.length);
  if (mind) {
    await newMind(window);
    await window.keyboard.type("Ranges");
  }
  return { app, window };
}

/** Opens the Document from the sidebar list, beside the Mind. */
async function openDocument(window: Page, name: RegExp | string): Promise<void> {
  const item = window.getByTestId("document-list-item").filter({ hasText: name });
  await pointAndClick(window, item.getByTestId("open-document"));
}

const cell = (window: Page, reference: string) =>
  window.getByTestId("viewer-grid").locator(`td[data-ref="${reference}"]`);

/** Drags from one cell to another, as selecting a range of cells does. */
async function dragCells(window: Page, from: string, to: string): Promise<void> {
  const start = await cell(window, from).boundingBox();
  const end = await cell(window, to).boundingBox();
  if (!start || !end) throw new Error("A cell to select isn't in view.");
  await window.mouse.move(start.x + 6, start.y + 6, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(end.x + end.width - 6, end.y + end.height - 6, { steps: 12 });
  await window.mouse.up();
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
}

const tableChip = (window: Page) => window.getByTestId("composer-table-chip");
const areaChip = (window: Page) => window.getByTestId("composer-area-chip");

test("a sheet range makes a table chip with its header row, and the Question keeps it", async () => {
  const { window } = await setUp({ files: [{ name: "Revenue.xlsx", bytes: REVENUE }] });
  await openDocument(window, /Revenue/);
  await dragCells(window, "B12", "E14");

  await expect(window.getByTestId("viewer-selection-size")).toHaveText("3 rows × 4 columns");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));

  await expect(tableChip(window)).toBeVisible();
  await expect(tableChip(window).getByTestId("composer-table-chip-show")).toHaveText(
    "Revenue · rows 12–14",
  );
  await expect(tableChip(window)).toHaveAttribute("data-check", "found");
  await expect(tableChip(window)).toHaveAttribute(
    "title",
    /Revenue · rows 12–14\nRevenue\nQuote found in Revenue · rows 12–14/,
  );
  await expect(window.getByTestId("composer-input")).toBeFocused();

  await tableChip(window).hover();
  const preview = window.getByTestId("composer-table-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Q1");
  await expect(preview).toContainText("9 months");
  await expect(preview).toContainText("1431");
  // The rows' names, as the board's table shows them.
  await expect(preview).toContainText("Stores");
  await expect(preview).toContainText("Online");

  await window.keyboard.type("How did stores do?");
  await window.keyboard.press("Enter");
  const question = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(question.getByTestId("assistant-question-quote")).toContainText(
    "Revenue · rows 12–14",
  );
  await expect(question).toContainText("How did stores do?");
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 45_000,
  });
});

test("Add to note puts the range in the note as a table, and Copy gives TSV with the header row", async () => {
  const { window } = await setUp({ files: [{ name: "Revenue.xlsx", bytes: REVENUE }] });
  await openDocument(window, /Revenue/);
  await dragCells(window, "B12", "E14");

  const copied = await stubClipboard(window);
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));
  const table = window
    .locator('[data-testid="mind-pane"]:visible')
    .locator(".mind-editor table")
    .first();
  await expect(table).toBeVisible();
  await expect(table.locator("th").first()).toHaveText("Q1");
  await expect(table).toContainText("1431");
  const citation = window
    .locator('[data-testid="mind-pane"]:visible')
    .getByTestId("citation-chip")
    .first();
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(citation).toHaveAttribute("aria-label", /rows 12–14/);

  await openDocument(window, /Revenue/);
  await dragCells(window, "B12", "E14");
  await pointAndClick(window, window.getByTestId("viewer-selection-copy"));
  await expect(window.getByTestId("copied-line")).toContainText("Copied as TSV, with its citation");
  const lines = (await copied())["text/plain"]?.split("\n") ?? [];
  expect(lines.slice(0, 4)).toEqual([
    "Q1\tQ2\tQ3\t9 months",
    "1431\t1452\t1470\t4353",
    "352\t361\t329\t1042",
    "99\t97\t92\t288",
  ]);
  expect(lines).toContain("Sources");
  expect(lines.at(-1)).toMatch(/\[1\] Revenue, Revenue, rows 12–14/);
});

test("a slide offers Ask about this slide on hover, and the chip names the deck and the slide", async () => {
  const { window } = await setUp({ files: [{ name: "Board pack.pptx", bytes: DECK }] });
  await openDocument(window, /Board pack/);
  const slide = window.getByTestId("viewer-slide").first();
  await slide.hover();
  const ask = slide.getByTestId("viewer-slide-ask");
  await expect(ask).toHaveText("Ask about this slide");
  await pointAndClick(window, ask);

  const chip = window.getByTestId("composer-slide-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("Board pack · slide 1");
  await expect(chip.getByTestId("composer-slide-chip-show")).toHaveText("Board pack · slide 1");
  await expect(chip).toHaveAttribute("data-check", "found");
  await expect(window.getByTestId("composer-input")).toBeFocused();

  await window.keyboard.type("What is on this slide?");
  await window.keyboard.press("Enter");
  const question = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(question.getByTestId("assistant-question-quote")).toContainText(
    "Board pack · slide 1",
  );
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 45_000,
  });
});

test("a slide with no words is asked about as its picture", async () => {
  const { window } = await setUp({ files: [{ name: "Charts.pptx", bytes: BARE_DECK }] });
  await openDocument(window, /Charts/);
  const slide = window.getByTestId("viewer-slide").first();
  await slide.hover();
  await pointAndClick(window, slide.getByTestId("viewer-slide-ask"));

  const chip = window.getByTestId("composer-slide-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-check", "cant-check");
  await expect(chip).toHaveAttribute("title", /Picture, not checked/);
  await expect(chip).toHaveAttribute("title", /This model can’t read pictures/);
  const thumbnail = window.getByTestId("composer-slide-thumbnail");
  await expect(thumbnail).toBeVisible();
  // The picture is the slide's drawing, not the frame around it: its height is the sheet's, not
  // the article's, which also holds the slide's number and notes.
  const sheet = await slide.locator(".viewer-deck-sheet").boundingBox();
  const article = await slide.boundingBox();
  const shot = await thumbnail.evaluate((image) => {
    const picture = image as HTMLImageElement;
    return {
      width: picture.naturalWidth,
      height: picture.naturalHeight,
      density: globalThis.devicePixelRatio,
    };
  });
  if (!sheet || !article) throw new Error("The slide isn't in view.");
  const scale = shot.width / shot.density / sheet.width;
  expect(shot.height / shot.density).toBeCloseTo(sheet.height * scale, 0);
  expect(article.height).toBeGreaterThan(sheet.height + 8);
  // The hover button is not in the picture: its corner of the slide is blank, though it sat there.
  const button = await slide.getByTestId("viewer-slide-ask").boundingBox();
  if (!button) throw new Error("The slide's Ask button isn't in view.");
  const dark = await thumbnail.evaluate(
    (image, { button: at, sheet: box }) => {
      const picture = image as HTMLImageElement;
      const ratio = picture.naturalWidth / box.width;
      const canvas = document.createElement("canvas");
      canvas.width = picture.naturalWidth;
      canvas.height = picture.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) return -1;
      context.drawImage(picture, 0, 0);
      const x = Math.max(0, Math.floor((at.x - box.x) * ratio));
      const y = Math.max(0, Math.floor((at.y - box.y) * ratio));
      const width = Math.max(1, Math.ceil(at.width * ratio));
      const height = Math.max(1, Math.ceil(at.height * ratio));
      if (x + width > canvas.width || y + height > canvas.height) return -2;
      const pixels = context.getImageData(x, y, width, height).data;
      let dark = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const luminance =
          0.2126 * (pixels[index] ?? 0) +
          0.7152 * (pixels[index + 1] ?? 0) +
          0.0722 * (pixels[index + 2] ?? 0);
        if (luminance < 200) dark += 1;
      }
      return dark;
    },
    { button, sheet },
  );
  expect(dark).toBe(0);

  await window.keyboard.type("What is on this slide?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 45_000,
  });
});

/** Draws the rectangle over part of a page of the viewer, the area mode already on. */
async function dragAreaOver(
  window: Page,
  page: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = await window
    .getByTestId("viewer")
    .locator(`[data-area-unit="${page}"], [data-area-unit=""], .viewer-text-page`)
    .first()
    .boundingBox();
  if (!box) throw new Error("The page isn't in view.");
  const at = (point: { x: number; y: number }) => ({
    x: box.x + box.width * point.x,
    y: box.y + box.height * point.y,
  });
  const start = at(from);
  const end = at(to);
  await window.mouse.move(start.x, start.y, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(end.x, end.y, { steps: 12 });
  await window.mouse.up();
}

/** Draws an area over part of a page of the viewer, with the header's dashed square. */
async function dragArea(
  window: Page,
  page: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await pointAndClick(window, window.getByTestId("viewer-area-select"));
  await dragAreaOver(window, page, from, to);
  await expect(areaChip(window)).toBeVisible();
}

test("an area over a chart's words is found, and its picture goes into the composer", async () => {
  const { window } = await setUp({
    files: [{ name: "Chart.pdf", bytes: buildPdf([CHART]) }],
  });
  await openDocument(window, /Chart/);
  await expect(window.getByTestId("viewer").locator(".textLayer")).toContainText("Northwind");
  // A pick answers as the mouse is released: its cursor changes while the picture is taken, and
  // goes back when the chip arrives.
  await window.getByTestId("viewer").evaluate((viewer) => {
    const seen: string[] = [];
    (globalThis as unknown as { cursorStyles: string[] }).cursorStyles = seen;
    const read = () => {
      const span = viewer.querySelector<HTMLElement>(".textLayer span");
      seen.push(span ? getComputedStyle(span).cursor : getComputedStyle(viewer).cursor);
    };
    read();
    new MutationObserver(read).observe(viewer, { attributes: true, attributeFilter: ["class"] });
  });
  await dragArea(window, 1, { x: 0.1, y: 0.15 }, { x: 0.9, y: 0.55 });

  await expect(areaChip(window).getByTestId("composer-area-chip-show")).toHaveText("Figure · p. 1");
  await expect(areaChip(window)).toHaveAttribute("data-check", "found");
  await expect(areaChip(window)).toHaveAttribute(
    "title",
    /Figure · p\. 1\nChart\nThe figure’s words were found on p\. 1/,
  );
  await expect(window.getByTestId("composer-area-thumbnail")).toBeVisible();
  await expect(window.getByTestId("viewer-area-select")).toHaveAttribute("aria-pressed", "false");
  const cursors = await window.evaluate(
    () => (globalThis as unknown as { cursorStyles: string[] }).cursorStyles,
  );
  // Over a page's words the I-beam gives way to progress while the picture is taken.
  expect(cursors[0]).toBe("text");
  expect(cursors).toContain("progress");
  expect(cursors.at(-1)).toBe("text");

  // With a Note beside it, the viewer is 425px wide: every control still fits, the last of them
  // inside the header's edge rather than scrolled out of it.
  const header = await window.getByTestId("viewer-header").boundingBox();
  const menu = await window
    .getByTestId("viewer-header")
    .getByTestId("document-file-menu")
    .boundingBox();
  if (!header || !menu) throw new Error("The viewer's header isn't in view.");
  expect(menu.x + menu.width).toBeLessThanOrEqual(header.x + header.width);
});

test("an area over a picture can't be checked, and says Picture, not checked", async () => {
  const { window } = await setUp({
    files: [{ name: "Picture.pdf", bytes: buildPdf([PICTURE]) }],
  });
  await openDocument(window, /Picture/);
  await dragArea(window, 1, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.6 });

  await expect(areaChip(window).getByTestId("composer-area-chip-show")).toHaveText("Figure · p. 1");
  await expect(areaChip(window)).toHaveAttribute("data-check", "cant-check");
  await expect(areaChip(window)).toHaveAttribute(
    "title",
    /Figure · p\. 1\nPicture\nPicture, not checked/,
  );
});

test("with a text-only model, the area chip's tooltip says the model can't read pictures", async () => {
  const { window } = await setUp({
    files: [{ name: "Picture.pdf", bytes: buildPdf([PICTURE]) }],
    textOnly: true,
  });
  await openDocument(window, /Picture/);
  await dragArea(window, 1, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.6 });

  await expect(areaChip(window)).toHaveAttribute(
    "title",
    /This model can’t read pictures\. Choose a model that can, to ask about one\.$/,
  );
});

test("a model whose ability to read pictures isn't known gets the same warning", async () => {
  // The local server lists fake-model; this model isn't in its list, so nothing is known of it.
  const { window } = await setUp({
    files: [{ name: "Picture.pdf", bytes: buildPdf([PICTURE]) }],
    localModel: "missing-model",
  });
  await openDocument(window, /Picture/);
  await dragArea(window, 1, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.6 });

  await expect(areaChip(window)).toHaveAttribute("title", /Picture, not checked/);
  await expect(areaChip(window)).toHaveAttribute(
    "title",
    /This model can’t read pictures\. Choose a model that can, to ask about one\.$/,
  );
});

test("a model that reads pictures shows no warning on the area chip", async () => {
  const { window } = await setUp({
    files: [{ name: "Picture.pdf", bytes: buildPdf([PICTURE]) }],
    model: false,
  });
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreApi }).incarnamind;
    await bridge.saveChatProvider({
      kind: "openai",
      apiKey: "sk-proj-a-made-up-key",
      modelId: "gpt-4.1",
    });
  });
  await openDocument(window, /Picture/);
  await dragArea(window, 1, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.6 });

  await expect(areaChip(window)).toHaveAttribute("title", /Picture, not checked/);
  await expect(areaChip(window)).not.toHaveAttribute("title", /can.t read pictures/);
});

test("the sheet, slide and area controls and their chips read in Chinese", async () => {
  const { window } = await setUp({
    files: [
      { name: "Revenue.xlsx", bytes: REVENUE },
      { name: "Board pack.pptx", bytes: DECK },
    ],
    language: "zh-CN",
  });
  await openDocument(window, /Revenue/);
  await dragCells(window, "B12", "E14");
  await expect(window.getByTestId("viewer-selection-size")).toHaveText("3 行 × 4 列");
  await expect(window.getByTestId("viewer-selection-ask")).toContainText("就此提问");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));
  await expect(tableChip(window).getByTestId("composer-table-chip-show")).toHaveText(
    "Revenue · 第 12–14 行",
  );
  await expect(window.getByTestId("composer-table-chip-remove")).toHaveAttribute(
    "aria-label",
    "不针对这段内容",
  );

  await openDocument(window, /Board pack/);
  const slide = window.getByTestId("viewer-slide").first();
  await slide.hover();
  await expect(slide.getByTestId("viewer-slide-ask")).toHaveText("就这张幻灯片提问");

  await openDocument(window, /Board pack/);
  await expect(window.getByTestId("viewer-area-select")).toHaveAttribute("aria-label", "选择区域");
  // A sheet picks cells instead: no area control (#118).
  await openDocument(window, /Revenue/);
  await expect(window.getByTestId("viewer-area-select")).toHaveCount(0);
});

test("中文：表格区域得到已核对的引用，添加到笔记是表格，复制为 TSV", async () => {
  const { window } = await setUp({
    files: [{ name: "Revenue.xlsx", bytes: REVENUE }],
    language: "zh-CN",
  });
  await openDocument(window, /Revenue/);
  await dragCells(window, "B12", "E14");
  await expect(window.getByTestId("viewer-selection-size")).toHaveText("3 行 × 4 列");
  await expect(window.getByTestId("viewer-selection-add")).toHaveText("添加到笔记");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));

  await expect(tableChip(window).getByTestId("composer-table-chip-show")).toHaveText(
    "Revenue · 第 12–14 行",
  );
  await expect(tableChip(window)).toHaveAttribute("data-check", "found");
  await window.keyboard.type("门店表现如何？");
  await window.keyboard.press("Enter");
  const question = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(question.getByTestId("assistant-question-quote")).toContainText(
    "Revenue · 第 12–14 行",
  );
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 45_000,
  });

  const copied = await stubClipboard(window);
  await openDocument(window, /Revenue/);
  await dragCells(window, "B12", "E14");
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));
  const table = window
    .locator('[data-testid="mind-pane"]:visible')
    .locator(".mind-editor table")
    .first();
  await expect(table.locator("th").first()).toHaveText("Q1");
  const citation = window
    .locator('[data-testid="mind-pane"]:visible')
    .getByTestId("citation-chip")
    .first();
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(citation).toHaveAttribute("aria-label", /第 12–14 行/);

  await openDocument(window, /Revenue/);
  await dragCells(window, "B12", "E14");
  await pointAndClick(window, window.getByTestId("viewer-selection-copy"));
  await expect(window.getByTestId("copied-line")).toContainText("已复制为 TSV，含引用");
  const lines = (await copied())["text/plain"]?.split("\n") ?? [];
  expect(lines[0]).toBe("Q1\tQ2\tQ3\t9 months");
  expect(lines[1]).toBe("1431\t1452\t1470\t4353");
  expect(lines).toContain("来源");
});

test("中文：就幻灯片提问，问题带着这张幻灯片", async () => {
  const { window } = await setUp({
    files: [{ name: "Board pack.pptx", bytes: DECK }],
    language: "zh-CN",
  });
  await openDocument(window, /Board pack/);
  const slide = window.getByTestId("viewer-slide").first();
  await slide.hover();
  const ask = slide.getByTestId("viewer-slide-ask");
  await expect(ask).toHaveText("就这张幻灯片提问");
  await pointAndClick(window, ask);
  await expect(window.getByTestId("composer-slide-chip")).toContainText(
    "Board pack · 第 1 张幻灯片",
  );
  await expect(window.getByTestId("composer-slide-chip")).toHaveAttribute("data-check", "found");
  await window.keyboard.type("这张幻灯片讲了什么？");
  await window.keyboard.press("Enter");
  const question = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(question.getByTestId("assistant-question-quote")).toContainText(
    "Board pack · 第 1 张幻灯片",
  );
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 45_000,
  });
});

test("中文：区域里的文字已核对，图片区域为未核对，纯文本模型的提示", async () => {
  const { window } = await setUp({
    files: [
      { name: "Chart.pdf", bytes: buildPdf([CHART]) },
      { name: "Picture.pdf", bytes: buildPdf([PICTURE]) },
    ],
    language: "zh-CN",
  });
  await openDocument(window, /Chart/);
  await expect(window.getByTestId("viewer").locator(".textLayer")).toContainText("Northwind");
  await dragArea(window, 1, { x: 0.1, y: 0.15 }, { x: 0.9, y: 0.55 });
  await expect(areaChip(window).getByTestId("composer-area-chip-show")).toHaveText("图 · 第 1 页");
  await expect(areaChip(window)).toHaveAttribute("data-check", "found");
  await expect(areaChip(window)).toHaveAttribute(
    "title",
    /图 · 第 1 页\nChart\n已在第 1 页找到图中的文字/,
  );

  await openDocument(window, /Picture/);
  await dragArea(window, 1, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.6 });
  await expect(areaChip(window).last().getByTestId("composer-area-chip-show")).toHaveText(
    "图 · 第 1 页",
  );
  await expect(areaChip(window).last()).toHaveAttribute("data-check", "cant-check");
  await expect(areaChip(window).last()).toHaveAttribute(
    "title",
    /图 · 第 1 页\nPicture\n图片，未核对/,
  );

  // A model that reads text alone says so on the chip it can't use.
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreApi }).incarnamind;
    await bridge.saveChatProvider({
      kind: "openai",
      apiKey: "sk-proj-a-made-up-key",
      modelId: "gpt-4",
    });
  });
  // Read again, as the app reads a saved provider at its next start: the model now in use reads no pictures.
  await window.reload();
  await expect(areaChip(window).last()).toBeVisible({ timeout: 20_000 });
  await expect(areaChip(window).last()).toHaveAttribute(
    "title",
    /这个模型无法读取图片。要询问图片，请选择能读取图片的模型。$/,
  );
});

test("the keys select cells and reach the range's menu, and ⌘K has its actions", async () => {
  const { window } = await setUp({ files: [{ name: "Revenue.xlsx", bytes: REVENUE }] });
  await openDocument(window, /Revenue/);
  // A press puts the focus on the grid's key control, as a cell selection has it.
  await pointAndClick(window, cell(window, "B12"));
  await window.keyboard.press("ArrowRight");
  await window.keyboard.press("Shift+ArrowRight");
  await window.keyboard.press("ControlOrMeta+/");
  await expect(window.getByTestId("viewer-selection-size")).toHaveText("1 row × 2 columns");
  await expect(window.getByTestId("viewer-selection-ask")).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(window.getByTestId("viewer-selection-add")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("viewer-selection-menu")).toHaveCount(0);

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("these cells");
  await expect(paletteFound(window).filter({ hasText: "Ask about these cells" })).toHaveCount(1);
  await expect(
    paletteFound(window).filter({ hasText: "Copy these cells with their citation" }),
  ).toHaveCount(1);
});

test("⌥ while dragging picks an area, without the header's button", async () => {
  const { window } = await setUp({
    files: [{ name: "Chart.pdf", bytes: buildPdf([CHART]) }],
  });
  await openDocument(window, /Chart/);
  await window.keyboard.down("Alt");
  await dragAreaOver(window, 1, { x: 0.1, y: 0.15 }, { x: 0.9, y: 0.55 });
  await window.keyboard.up("Alt");
  await expect(areaChip(window)).toBeVisible();
  await expect(areaChip(window)).toHaveAttribute("data-check", "found");
  await expect(window.getByTestId("viewer-area-select")).toHaveAttribute("aria-pressed", "false");
});

test("an area of a Markdown file is found by the words under it", async () => {
  const notes = [
    "# Survey",
    "",
    "The site map shows four gauges along the estuary.",
    "The river rose 0.4 metres in March, the highest this year.",
    "",
  ].join("\n");
  const { window } = await setUp({ files: [{ name: "Survey.md", bytes: Buffer.from(notes) }] });
  await openDocument(window, /Survey/);
  await expect(window.getByTestId("viewer").locator(".viewer-text-page")).toContainText(
    "four gauges",
  );
  await dragArea(window, 1, { x: 0.1, y: 0.35 }, { x: 0.9, y: 0.75 });
  await expect(areaChip(window).getByTestId("composer-area-chip-show")).toHaveText(
    "Figure · § Survey",
  );
  await expect(areaChip(window)).toHaveAttribute("data-check", "found");
});

test("a range of cells in a CSV is cited to its rows, without a sheet name", async () => {
  const csv = "Region,Q1,Q2\nNorth,120,150\nSouth,80,91\nEast,60,72\n";
  const { window } = await setUp({ files: [{ name: "Sales.csv", bytes: Buffer.from(csv) }] });
  await openDocument(window, /Sales/);
  await dragCells(window, "B2", "C3");
  await expect(window.getByTestId("viewer-selection-size")).toHaveText("2 rows × 2 columns");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));
  await expect(tableChip(window).getByTestId("composer-table-chip-show")).toHaveText("rows 2–3");
  await expect(tableChip(window)).toHaveAttribute("data-check", "found");
  await tableChip(window).hover();
  await expect(window.getByTestId("composer-table-preview")).toContainText("Q1");
  await expect(window.getByTestId("composer-table-preview")).toContainText("120");
});

test("a sheet range across a block edge is found, not refused", async () => {
  const { window } = await setUp({ files: [{ name: "Wide.xlsx", bytes: WIDE }] });
  await openDocument(window, /Wide/);
  await dragCells(window, "B2", "B20");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));

  await expect(tableChip(window)).toBeVisible();
  await expect(tableChip(window)).toHaveAttribute("data-check", "found");
  await expect(tableChip(window).getByTestId("composer-table-chip-show")).toHaveText(
    "Wide · rows 2–20",
  );
  await expect(window.getByTestId("error-notice")).toHaveCount(0);
});

test("a range that starts at the sheet's header row is found", async () => {
  const { window } = await setUp({ files: [{ name: "Wide.xlsx", bytes: WIDE }] });
  await openDocument(window, /Wide/);
  await dragCells(window, "A1", "B5");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));

  await expect(tableChip(window)).toBeVisible();
  await expect(tableChip(window)).toHaveAttribute("data-check", "found");
  await expect(tableChip(window).getByTestId("composer-table-chip-show")).toHaveText(
    "Wide · rows 1–5",
  );
  await expect(window.getByTestId("error-notice")).toHaveCount(0);
});

test("a sheet's header below its first ten rows still comes with the range", async () => {
  const { window } = await setUp({ files: [{ name: "Late.xlsx", bytes: LATE_HEADER }] });
  await openDocument(window, /Late/);
  await dragCells(window, "A14", "B14");
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));

  await expect(tableChip(window)).toHaveAttribute("data-check", "found");
  await tableChip(window).hover();
  const preview = window.getByTestId("composer-table-preview");
  await expect(preview).toContainText("Name");
  await expect(preview).toContainText("Value");
  await expect(preview).toContainText("A");
});

test("copying a range escapes its cells and pastes back as a Citation", async () => {
  const { window } = await setUp({ files: [{ name: "Cells.xlsx", bytes: ESCAPING }] });
  await openDocument(window, /Cells/);
  const copied = await stubClipboard(window);
  await dragCells(window, "A1", "B2");
  await pointAndClick(window, window.getByTestId("viewer-selection-copy"));
  await expect(window.getByTestId("copied-line")).toContainText("Copied as TSV, with its citation");

  const stored = await copied();
  const html = stored["text/html"] ?? "";
  expect(html).toContain("<table");
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).not.toContain("<b>x</b>");
  expect(html).toContain("Cells");

  // Pasted into a Note, it comes back as a table with its Citation: the schema and footnotes, as
  // Copy with citation does for words.
  const editor = window.locator('[data-testid="mind-pane"]:visible').getByTestId("mind-editor");
  await editor.click();
  await window.evaluate(
    ({ html, text }) => {
      const pane = [...document.querySelectorAll<HTMLElement>('[data-testid="mind-pane"]')].find(
        (each) => each.getBoundingClientRect().width > 0,
      );
      const target = pane?.querySelector<HTMLElement>('[data-testid="mind-editor"]');
      if (!target) throw new Error("The Note isn't open.");
      const data = new DataTransfer();
      data.setData("text/html", html);
      data.setData("text/plain", text);
      (document.activeElement ?? target).dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { html, text: stored["text/plain"] ?? "" },
  );

  const note = window.locator('[data-testid="mind-pane"]:visible');
  await expect(note.locator(".mind-editor table").first()).toContainText("<b>x</b>");
  await expect(note.getByTestId("citation-chip").first()).toHaveAttribute("data-check", "found");
  await expect(note.getByTestId("citation-chip").first()).toHaveAttribute("aria-label", /rows 1–2/);
});

test("the keyboard picks the page in view as an area", async () => {
  const { window } = await setUp({
    files: [{ name: "Chart.pdf", bytes: buildPdf([CHART]) }],
  });
  await openDocument(window, /Chart/);
  await expect(window.getByTestId("viewer").locator(".textLayer")).toContainText("Northwind");
  await pointAndClick(window, window.getByTestId("viewer-area-select"));
  // The button hands the viewer the focus, so Enter takes the page in view.
  await expect(window.getByTestId("viewer-area-select")).toHaveAttribute("aria-pressed", "true");
  await window.keyboard.press("Enter");
  await expect(areaChip(window)).toBeVisible();
  await expect(areaChip(window)).toHaveAttribute("data-check", "found");
  await expect(areaChip(window).getByTestId("composer-area-chip-show")).toHaveText("Figure · p. 1");
});

test("the arrows make part of a page, and Enter takes it", async () => {
  const { window } = await setUp({ files: [{ name: "Chart.pdf", bytes: buildPdf([CHART]) }] });
  await openDocument(window, /Chart/);
  await expect(window.getByTestId("viewer").locator(".textLayer")).toContainText("Northwind");
  await pointAndClick(window, window.getByTestId("viewer-area-select"));
  await window.keyboard.press("ArrowRight");
  await expect(window.getByTestId("viewer-area-drawing")).toBeVisible();
  await window.keyboard.press("Shift+ArrowDown");
  await window.keyboard.press("Enter");
  await expect(areaChip(window)).toBeVisible();

  await pointAndClick(window, window.getByTestId("composer-area-chip-show"));
  const region = await window.getByTestId("viewer-area-region").boundingBox();
  const page = await window
    .getByTestId("viewer")
    .locator('[data-area-unit="1"]')
    .first()
    .boundingBox();
  if (!region || !page) throw new Error("The region isn't drawn.");
  expect(region.width).toBeLessThan(page.width * 0.9);
});

test("a zoomed page's keyboard area catches only the part in view", async () => {
  const { window } = await setUp({
    files: [{ name: "Zoom.pdf", bytes: buildPdf([CHART, { lines: ["Second page"] }]) }],
  });
  await openDocument(window, /Zoom/);
  await expect(window.getByTestId("viewer").locator(".textLayer").first()).toContainText(
    "Northwind",
  );
  for (let step = 0; step < 4; step++) await window.getByTestId("pdf-zoom-in").click();
  const scroller = await window.getByTestId("pdf-scroller").boundingBox();
  const page = await window
    .getByTestId("viewer")
    .locator('[data-area-unit="1"]')
    .first()
    .boundingBox();
  if (!scroller || !page) throw new Error("The page isn't in view.");
  expect(page.width).toBeGreaterThan(scroller.width + 20);

  await pointAndClick(window, window.getByTestId("viewer-area-select"));
  await window.keyboard.press("Enter");
  await expect(areaChip(window)).toBeVisible();
  const width = await window
    .getByTestId("composer-area-thumbnail")
    .evaluate((image) => (image as HTMLImageElement).naturalWidth);
  // The capture is in the window's pixels: a Retina screen counts two for each of the viewer's.
  const density = await window.evaluate(() => globalThis.devicePixelRatio);
  expect(width / density).toBeLessThanOrEqual(scroller.width + 1);
});

test("an area of a Word page and of a slide is found where it is", async () => {
  const report = docxOf([
    { text: "Field report", heading: 1 },
    { text: "The river rose 0.4 metres in March, the highest this year." },
  ]);
  const { window } = await setUp({
    files: [
      { name: "Field report.docx", bytes: report },
      { name: "Board pack.pptx", bytes: DECK },
    ],
  });
  await openDocument(window, /Field report/);
  await expect(window.getByTestId("viewer")).toContainText("0.4 metres");
  await dragArea(window, 1, { x: 0.15, y: 0.15 }, { x: 0.85, y: 0.5 });
  await expect(areaChip(window).getByTestId("composer-area-chip-show")).toHaveText(
    "Figure · § Field report",
  );
  await expect(areaChip(window)).toHaveAttribute("data-check", "found");
  await pointAndClick(window, window.getByTestId("composer-area-chip-remove"));

  await openDocument(window, /Board pack/);
  await expect(window.getByTestId("viewer-slide").first()).toContainText("Q3 at a glance");
  await dragArea(window, 1, { x: 0.05, y: 0.08 }, { x: 0.7, y: 0.35 });
  await expect(areaChip(window).getByTestId("composer-area-chip-show")).toHaveText(
    "Figure · slide 1",
  );
  await expect(areaChip(window)).toHaveAttribute("data-check", "found");
});

test("a range over three blocks of rows is refused in rows' words, not pages'", async () => {
  const LONG = xlsxOf([
    {
      name: "Long",
      rows: [
        ["Ref", "Value"],
        ...Array.from({ length: 220 }, (_, at) => [`R${at + 1}`, String(at + 1)]),
      ],
    },
  ]);
  const { window } = await setUp({ files: [{ name: "Long.xlsx", bytes: LONG }] });
  await openDocument(window, /Long/);
  await pointAndClick(window, cell(window, "B2"));
  // The sheet draws only the rows in view: go to the bottom, where row 221 is drawn.
  await window.getByTestId("viewer-grid").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(cell(window, "B221")).toBeVisible();
  await window.keyboard.down("Shift");
  await pointAndClick(window, cell(window, "B221"));
  await window.keyboard.up("Shift");
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  await pointAndClick(window, window.getByTestId("viewer-selection-ask"));
  await expect(window.getByTestId("error-notice")).toContainText(
    "A Citation covers two blocks of rows of a sheet at most. Select fewer rows.",
  );
  await expect(window.getByTestId("composer-table-chip")).toHaveCount(0);
});

test("opening an area chip outlines the region it cites", async () => {
  const { window } = await setUp({
    files: [{ name: "Chart.pdf", bytes: buildPdf([CHART]) }],
  });
  await openDocument(window, /Chart/);
  await expect(window.getByTestId("viewer").locator(".textLayer")).toContainText("Northwind");
  await dragArea(window, 1, { x: 0.1, y: 0.15 }, { x: 0.9, y: 0.55 });
  await pointAndClick(window, window.getByTestId("composer-area-chip-show"));

  const region = window.getByTestId("viewer-area-region");
  await expect(region).toBeVisible();
  const page = await window
    .getByTestId("viewer")
    .locator('[data-area-unit="1"]')
    .first()
    .boundingBox();
  const box = await region.boundingBox();
  if (!page || !box) throw new Error("The region isn't drawn.");
  expect(box.x).toBeGreaterThanOrEqual(page.x - 1);
  expect(box.y).toBeGreaterThanOrEqual(page.y - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(page.x + page.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(page.y + page.height + 1);
  expect(box.width).toBeLessThan(page.width * 0.95);
});

test("an area of a file with no headings is just Figure, with no empty place", async () => {
  const notes = "The river rose 0.4 metres in March, the highest this year.\n";
  const { window } = await setUp({ files: [{ name: "Notes.md", bytes: Buffer.from(notes) }] });
  await openDocument(window, /Notes/);
  await expect(window.getByTestId("viewer").locator(".viewer-text-page")).toContainText(
    "0.4 metres",
  );
  await dragArea(window, 1, { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.5 });
  const chip = areaChip(window);
  await expect(chip.getByTestId("composer-area-chip-show")).toHaveText("Figure");
  await expect(chip).not.toHaveAttribute("title", /Figure ·\s/);
  await expect(chip).toHaveAttribute("data-check", "found");
  await expect(chip).toHaveAttribute("title", /The figure’s words were found\./);
});

test("a picture area in a file with sections is cited to its own section, not the first", async () => {
  const notes = [
    "# One",
    "",
    "The first river rose 0.1 metres.",
    "",
    "# Two",
    "",
    "The second river rose 0.9 metres.",
    "",
  ].join("\n");
  const { window } = await setUp({ files: [{ name: "Rivers.md", bytes: Buffer.from(notes) }] });
  await openDocument(window, /Rivers/);
  await expect(window.getByTestId("viewer").locator(".viewer-text-page")).toContainText(
    "0.9 metres",
  );
  // To the right of the second section's words, where its page has only blank space: the
  // picture's place is the section those words are in, never the Document's first.
  await dragArea(window, 1, { x: 0.9, y: 0.88 }, { x: 0.99, y: 0.97 });
  const chip = areaChip(window);
  await expect(chip.getByTestId("composer-area-chip-show")).toHaveText("Figure · § Two");
  await expect(chip).toHaveAttribute("data-check", "cant-check");
  await expect(chip).toHaveAttribute("title", /Picture, not checked/);
});

test("中文：侧边有笔记时，520–540 像素宽的 PDF 工具栏也放得下", async () => {
  const sixPages = buildPdf([
    CHART,
    ...Array.from({ length: 5 }, (_, at) => ({ lines: [`Page ${at + 2}`] })),
  ]);
  const { window } = await setUp({
    files: [{ name: "Six.pdf", bytes: sixPages }],
    language: "zh-CN",
  });
  await openDocument(window, /Six/);
  await expect(window.getByTestId("viewer").locator(".textLayer").first()).toContainText(
    "Northwind",
  );
  // The split beside the Note, at the width where the page count and Select area meet.
  await window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const groups = document.querySelector('[data-testid="tab-groups"]');
    if (!groups) throw new Error("The split isn't there.");
    const room = groups.getBoundingClientRect().width - 1;
    await bridge.changeLayout("main", { type: "resize", widths: [room - wanted, wanted] });
  }, 528);
  await expect
    .poll(() => window.getByTestId("viewer").evaluate((el) => el.getBoundingClientRect().width))
    .toBeCloseTo(528, 0);
  await pointAndClick(window, window.getByTestId("viewer-area-select"));
  await expect(window.getByTestId("viewer-header")).toContainText("共 6 页");
  const header = window.getByTestId("viewer-header");
  const scroll = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
  const box = await header.boundingBox();
  const menu = await header.getByTestId("document-file-menu").boundingBox();
  if (!box || !menu) throw new Error("The toolbar isn't in view.");
  expect(menu.x + menu.width).toBeLessThanOrEqual(box.x + box.width);
});
