import { randomUUID } from "node:crypto";
import { copyFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CitationAttributes, CoreBridge, Document } from "../src/core/api";
import { openDatabase } from "../src/core/storage";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  type MindChild,
  mindNode,
  nameMind,
  newMind,
  openOptions,
  openSavedPage,
  pointAndClick,
  removeDataFolder,
  requestsMade,
  savedPath,
  setLanguage,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

const core = (window: Page) => ({
  documents: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    ),
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

/** A Citation of `quote` on line `line` of a text file, as an Answer makes it. */
function citation(document: Document, quote: string, line: number, check: "found" | "not-found") {
  const attributes: CitationAttributes = {
    passageId: "passage-1",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "lines", from: line, to: line },
    quote,
    check,
    checkReason: check === "found" ? null : "quote-not-on-pages",
  };
  return mindNode("citation", { ...attributes });
}

const paragraph = (...children: MindChild[]) =>
  mindNode("paragraph", { id: randomUUID() }, children);

async function resize(app: ElectronApplication, page: Page, width: number, height: number) {
  const window = await app.browserWindow(page);
  await window.evaluate((win, size) => win.setContentSize(size.width, size.height), {
    width,
    height,
  });
  await expect
    .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
    .toEqual([width, height]);
}

let dataDir: string;
let sources: string;
let home: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  home = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
  await removeDataFolder(out);
});

test("a web page to share: the sheet offers it, and the file loads nothing and opens each Citation's card by keyboard and as a sheet at 375px", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Tides");
  const mindId = await window.getByTestId("mind-pane").getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind is open.");
  await writeFile(
    join(sources, "Tides.txt"),
    "Spring tides come twice a month, at new and full moon.\n\nNeap tides fall between them.\n",
  );
  await addDocuments(window, [join(sources, "Tides.txt")]);
  const [tides] = await core(window).documents();
  if (!tides) throw new Error("No Tides.");
  await core(window).write(
    mindId,
    blocksUpdate([
      paragraph(
        "Spring tides follow the moon",
        citation(tides, "Spring tides come twice a month", 1, "found"),
        ".",
      ),
      paragraph(
        "Neap tides come between",
        citation(tides, "Neap tides fall between them", 3, "found"),
        ".",
      ),
      paragraph(
        "Tides stop in winter",
        citation(tides, "Tides stop in winter", 1, "not-found"),
        ".",
      ),
    ]),
  );
  await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(3);
  await useOutputLocation(window, out);

  // No citation style: the page numbers each Citation.
  await openOptions(window, "Export options");
  const sheet = window.getByTestId("export-dialog");
  const format = sheet.getByTestId("export-format");
  await expect(format.locator("option")).toContainText(["HTML", "Web page to share (.html)"]);
  await format.selectOption("share-page");
  const cards = sheet.getByTestId("export-citation-cards");
  const line = sheet.getByTestId("export-checked-line");
  await expect(cards).toBeChecked();
  await expect(line).not.toBeChecked();
  await expect(sheet.getByTestId("export-citation-style")).toHaveCount(0);
  await pointAndClick(window, cards);
  await expect(cards).not.toBeChecked();
  await expect(line).toHaveCount(0);
  await expect(sheet.getByTestId("export-citation-style")).toBeVisible();
  await pointAndClick(window, cards);
  await pointAndClick(window, line);
  await expect(line).toBeChecked();
  await pointAndClick(window, sheet.getByTestId("export-save"));
  await expect(sheet).toBeHidden();
  await expect(window.getByTestId("export-mind")).toHaveAttribute("data-format", "share-page");

  await exportFromMenu(window);
  const page = await openSavedPage(app, await savedPath(window, "Tides.html"));

  // Nothing but the file was asked for, and the page's policy refuses a request it tries.
  await expect(page.locator(".shared-foot a")).toHaveText("Citations checked with IncarnaMind");
  expect(
    await page.evaluate(() =>
      fetch("https://example.com/").then(
        () => "loaded",
        () => "refused",
      ),
    ),
  ).toBe("refused");
  const requests = await requestsMade(app);
  expect(requests.some((url) => url.startsWith("file:"))).toBe(true);
  expect(requests.filter((url) => !url.startsWith("file:"))).toEqual([]);

  const markers = page.locator("main a.cite");
  await expect(markers).toHaveCount(3);
  await expect(markers.first()).toHaveAttribute("role", "button");
  await expect(markers.first()).toHaveAccessibleName("Citation 1: Tides, line 1");
  await page.keyboard.press("Tab");
  await expect(markers.first()).toBeFocused();
  await page.keyboard.press("Enter");
  const first = page.locator("#card-1");
  await expect(first).toBeVisible();
  await expect(first).toBeFocused();
  await expect(first).toHaveAccessibleName("Citation 1: Tides, line 1");
  await expect(markers.first()).toHaveAttribute("aria-expanded", "true");
  const marker = await markers.first().boundingBox();
  const card = await first.boundingBox();
  if (!marker || !card) throw new Error("The marker or its card isn't shown.");
  expect(card.y).toBeGreaterThanOrEqual(marker.y + marker.height);
  expect(card.y - (marker.y + marker.height)).toBeLessThanOrEqual(16);
  expect(card.x).toBeLessThanOrEqual(marker.x);
  expect(card.x + card.width).toBeGreaterThan(marker.x);
  await expect(first.locator("mark.quote")).toHaveText("Spring tides come twice a month");

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#card-2")).toBeFocused();
  await expect(first).toBeHidden();
  await page.keyboard.press("ArrowRight");
  const third = page.locator("#card-3");
  await expect(third).toBeFocused();
  await expect(third.locator(".card-heading")).toHaveText("Quote not found on line 1");
  await page.keyboard.press("ArrowRight");
  await expect(third).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(first).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first.locator(".card-close")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first.locator(".card-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(first).toBeHidden();
  await expect(markers.first()).toBeFocused();
  await expect(markers.first()).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press(" ");
  await expect(first).toBeVisible();
  await page.mouse.click(1000, 700);
  await expect(first).toBeHidden();

  await resize(app, page, 375, 720);
  await pointAndClick(page, markers.nth(1));
  const second = page.locator("#card-2");
  await expect(second).toBeVisible();
  await expect(page.locator(".scrim")).toBeVisible();
  await expect(second.locator(".card-swipe")).toHaveText("Swipe down or tap outside to close.");
  const sheetBox = await second.boundingBox();
  if (!sheetBox) throw new Error("The card isn't shown.");
  expect(Math.abs(sheetBox.x)).toBeLessThanOrEqual(1);
  // Beside a classic scrollbar (Linux, Windows) the sheet spans what is left of the width.
  const room = await page.evaluate(() => document.documentElement.clientWidth);
  expect(Math.abs(sheetBox.width - room)).toBeLessThanOrEqual(1);
  expect(Math.abs(sheetBox.y + sheetBox.height - 720)).toBeLessThanOrEqual(1);
  expect(
    await second.locator(".card-source .date").evaluate((date) => date.getClientRects().length),
  ).toBe(1);
  const grab = await second.locator(".card-grab").boundingBox();
  if (!grab) throw new Error("The sheet has no grab bar.");
  await page.mouse.move(grab.x + grab.width / 2, grab.y + 2);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width / 2, grab.y + 140, { steps: 6 });
  await page.mouse.up();
  await expect(second).toBeHidden();
  await expect(page.locator(".scrim")).toBeHidden();

  await pointAndClick(page, markers.nth(1));
  await expect(second).toBeVisible();
  await page.mouse.click(187, 20);
  await expect(second).toBeHidden();
  await pointAndClick(page, markers.nth(1));
  await page.keyboard.press("Escape");
  await expect(second).toBeHidden();
  expect((await requestsMade(app)).filter((url) => !url.startsWith("file:"))).toEqual([]);
  await page.close();

  await setLanguage(window, "zh-CN");
  await openOptions(window, "导出选项");
  await expect(sheet.getByTestId("export-format").locator("option:checked")).toHaveText(
    "可分享的网页（.html）",
  );
  await expect(sheet.getByText("读者可以打开每条引用")).toBeVisible();
  await expect(sheet.getByText("在页脚注明“引用已由 IncarnaMind 核对”")).toBeVisible();
  await app.close();
});

/** The saved pages' sizes, by their Document's name, as the data folder's database has them. */
function savedPages(dataFolder: string): Record<string, { width: number; height: number }> {
  const db = openDatabase(join(dataFolder, "incarnamind.db"));
  try {
    const rows = db.all<{ name: string; width: number; height: number }>(
      `SELECT d.name, p.width, p.height FROM cited_pages p JOIN documents d ON d.id = p.document_id
       WHERE p.deleted_at IS NULL AND p.image_type IS NOT NULL`,
    );
    return Object.fromEntries(rows.map(({ name, ...size }) => [name, size]));
  } finally {
    db.close();
  }
}

test("page pictures: the sheet says what goes in the file and updates as a Document is unticked; a PDF's card carries a crop and a slide's the slide", async () => {
  test.setTimeout(240_000);
  const library = await realpath(sources);
  const deck = "Quarterly Research Update.pptx";
  const fixtures = join(__dirname, "..", "tests", "fixtures", "formats");
  for (const file of [
    "Coastal Flood Risk Review.docx",
    deck,
    "Regional Revenue.xlsx",
    "Orders.csv",
  ]) {
    await copyFile(join(fixtures, file), join(library, file));
  }
  await writeFile(
    join(library, "Tide Gauges.pdf"),
    buildPdf([
      { lines: ["Tide gauges"] },
      { lines: ["Felixstowe", "The Felixstowe gauges recorded the highest readings of the year."] },
    ]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [
    join(library, "Coastal Flood Risk Review.docx"),
    join(library, deck),
    join(library, "Regional Revenue.xlsx"),
    join(library, "Orders.csv"),
    join(library, "Tide Gauges.pdf"),
  ]);
  await newMind(window);
  await nameMind(window, "Gauges");
  await addToNote(
    window,
    await askInAssistant(
      window,
      "Compare each: the western fastest growth, the barrier crest halves damage, and West totals in rows.",
    ),
  );
  await addToNote(
    window,
    await askInAssistant(window, "Which gauges recorded the highest readings?"),
  );
  await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(5);
  await expect
    .poll(() => Object.keys(savedPages(dataDir)).sort(), { timeout: 60_000 })
    .toEqual(expect.arrayContaining(["Quarterly Research Update", "Tide Gauges"]));
  await useOutputLocation(window, out);

  await openOptions(window, "Export options");
  const sheet = window.getByTestId("export-dialog");
  await sheet.getByTestId("export-format").selectOption("share-page");
  const contents = sheet.getByTestId("share-contents");
  await expect(contents.locator("p").first()).toHaveText(
    "In the file: 5 quotes and 2 page pictures from 5 Documents. Anyone with the file can read these; Documents aren’t included.",
  );
  await expect(contents.getByTestId("share-document")).toHaveCount(5);
  await expect(contents.getByTestId("share-size")).toHaveText(/^The file will be about \d/);
  const gauges = contents.getByTestId("share-document").filter({ hasText: "Tide Gauges" });
  await expect(gauges).toContainText("1 quote · 1 picture");
  await pointAndClick(window, gauges.getByRole("checkbox"));
  await expect(gauges).toContainText("1 quote · as text only");
  await expect(contents.locator("p").first()).toContainText(
    "5 quotes and 1 page picture from 5 Documents.",
  );
  await pointAndClick(window, gauges.getByRole("checkbox"));
  await expect(gauges.getByRole("checkbox")).toBeChecked();
  await pointAndClick(window, sheet.getByTestId("export-save"));
  await expect(sheet).toBeHidden();

  await exportFromMenu(window);
  const page = await openSavedPage(app, await savedPath(window, "Gauges.html"));
  const pictureOf = (name: string) =>
    page
      .locator("section.card", { has: page.locator(".card-source", { hasText: name }) })
      .locator(".card-picture svg");
  const sizes = savedPages(dataDir);
  for (const name of ["Tide Gauges", deck.replace(".pptx", "")]) {
    const picture = pictureOf(name);
    await expect(picture).toHaveCount(1);
    // The card points at the page's one copy of the picture, which the browser decodes.
    const drawn = await picture.evaluate(async (svg) => {
      const id = svg.querySelector("use")?.getAttribute("href") ?? "";
      const href = document.querySelector(id)?.getAttribute("href") ?? "";
      const image = new Image();
      image.src = href.startsWith("data:image/webp;base64,") ? href : "";
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
    const saved = sizes[name];
    if (!saved) throw new Error(`${name}'s page wasn't saved.`);
    if (name === "Tide Gauges") {
      expect(drawn[0] ?? 0).toBeLessThanOrEqual(Math.min(saved.width, 1600));
      expect(drawn[1] ?? 0).toBeLessThanOrEqual(saved.height / 3);
    } else {
      const scale = Math.min(saved.width, 1600) / saved.width;
      expect(drawn).toEqual([Math.min(saved.width, 1600), Math.round(saved.height * scale)]);
    }
  }
  // Opened, the card draws the picture at its width.
  const gaugesCard = page.locator("section.card", {
    has: page.locator(".card-source", { hasText: "Tide Gauges" }),
  });
  const number = ((await gaugesCard.getAttribute("id")) ?? "").replace("card-", "");
  await page.locator(`main a.cite[data-card="${number}"]`).click();
  await expect(gaugesCard).toBeVisible();
  const shown = await pictureOf("Tide Gauges").boundingBox();
  const card = await gaugesCard.boundingBox();
  expect(shown?.width ?? 0).toBeGreaterThan((card?.width ?? 0) / 2);
  expect(shown?.height ?? 0).toBeGreaterThan(20);
  expect((await requestsMade(app)).filter((url) => !url.startsWith("file:"))).toEqual([]);
  await page.close();

  await setLanguage(window, "zh-CN");
  await openOptions(window, "导出选项");
  await expect(sheet.getByTestId("share-contents").locator("p").first()).toHaveText(
    "文件中包含：来自 5 个文档的 5 处引文和 2 张页面截图。收到文件的人都能看到这些，文档本身不包含在内。",
  );
  await app.close();
});

test("export options keeps its title, ×, Cancel and Save options in view at 1,100 px while the body scrolls, in English and Chinese", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Tides");
  const mindId = await window.getByTestId("mind-pane").getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind is open.");
  const names = ["Tides", "Currents", "Swells", "Winds", "Moon"];
  const paths = names.map((name) => join(sources, `${name}.txt`));
  for (const [index, path] of paths.entries()) {
    await writeFile(path, `${names[index]} rise and fall twice a day.\n`);
  }
  await addDocuments(window, paths);
  const documents = await core(window).documents();
  await core(window).write(
    mindId,
    blocksUpdate(
      names.map((name) => {
        const document = documents.find((each) => each.name === name);
        if (!document) throw new Error(`No ${name}.`);
        return paragraph(
          `${name} each day`,
          citation(document, `${name} rise and fall`, 1, "found"),
          ".",
        );
      }),
    ),
  );
  await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(5);
  await useOutputLocation(window, out);

  const sheet = window.getByTestId("export-dialog");
  const body = sheet.getByTestId("export-options-body");
  const viewport = () => window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const inside = (
    box: { x: number; y: number; width: number; height: number },
    size: { width: number; height: number },
  ) =>
    box.x >= -0.5 &&
    box.y >= -0.5 &&
    box.x + box.width <= size.width + 0.5 &&
    box.y + box.height <= size.height + 0.5;
  const focused = () =>
    window.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const box = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-testid") ?? element.textContent?.trim() ?? "",
        inside:
          box.top >= -0.5 &&
          box.left >= -0.5 &&
          box.bottom <= innerHeight + 0.5 &&
          box.right <= innerWidth + 0.5,
      };
    });

  for (const [width, height] of [
    [1100, 720],
    [1100, 760],
  ] as const) {
    for (const language of ["en", "zh-CN"] as const) {
      await resize(app, window, width, height);
      await setLanguage(window, language);
      await expect(window.getByTestId("export-mind")).toHaveText(
        language === "en" ? "Export" : "导出",
      );
      const title = language === "en" ? "Export options" : "导出选项";
      await openOptions(window, title);
      await sheet.getByTestId("export-format").selectOption("share-page");
      await expect(sheet.getByTestId("share-document")).toHaveCount(5);

      // #1017: the sheet opens with its × focused.
      await sheet.getByTestId("export-options-close").focus();
      const order: string[] = [];
      for (let step = 0; step < 12; step++) {
        const now = await focused();
        if (!now) throw new Error("Nothing has the focus.");
        order.push(now.id);
        expect(now.inside).toBe(true);
        if (now.id === "export-save") break;
        await window.keyboard.press("Tab");
      }
      expect(order.slice(0, 6)).toEqual([
        "export-options-close",
        "export-format",
        "export-citation-cards",
        "export-checked-line",
        "export-include-questions",
        "export-save-to-change",
      ]);
      expect(order.slice(6)).toEqual([language === "en" ? "Cancel" : "取消", "export-save"]);
      expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

      const line = sheet.getByTestId("export-checked-line");
      await pointAndClick(window, line);
      await expect(line).toBeChecked();

      const size = await viewport();
      const frame = await sheet.boundingBox();
      if (!frame) throw new Error("The sheet isn't shown.");
      expect(Math.abs(frame.y - 44)).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.x - (size.width - 520) / 2)).toBeLessThanOrEqual(1);
      expect(frame.y + frame.height).toBeLessThanOrEqual(size.height - 23.5);
      for (const control of [
        sheet.locator("#export-title"),
        sheet.getByTestId("export-options-close"),
        sheet.getByRole("button", { name: language === "en" ? "Cancel" : "取消" }),
        sheet.getByTestId("export-save"),
      ]) {
        const box = await control.boundingBox();
        if (!box) throw new Error("A control of the sheet isn't shown.");
        expect(inside(box, size)).toBe(true);
      }
      const room = await body.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      expect(room.scrollHeight).toBeGreaterThan(room.clientHeight);

      const bodyBox = await body.boundingBox();
      if (!bodyBox) throw new Error("The body isn't shown.");
      const saveBox = await sheet.getByTestId("export-save").boundingBox();
      const titleBox = await sheet.locator("#export-title").boundingBox();
      await window.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
      await window.mouse.wheel(0, -400);
      await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
      await window.mouse.wheel(0, 400);
      await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      if (!saveBox || !titleBox) throw new Error("A control of the sheet isn't shown.");
      expect(await sheet.getByTestId("export-save").boundingBox()).toEqual(saveBox);
      expect(await sheet.locator("#export-title").boundingBox()).toEqual(titleBox);
      await window.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(window.getByRole("dialog")).toHaveCount(0);
    }
  }

  await resize(app, window, 1440, 900);
  await setLanguage(window, "en");
  await expect(window.getByTestId("export-mind")).toHaveText("Export");
  await openOptions(window, "Export options");
  await sheet.getByTestId("export-format").selectOption("share-page");
  await expect(sheet.getByTestId("share-document")).toHaveCount(5);
  const wideSize = await viewport();
  const wide = await sheet.boundingBox();
  if (!wide) throw new Error("The sheet isn't shown.");
  expect(Math.abs(wide.width - 520)).toBeLessThanOrEqual(1);
  expect(Math.abs(wide.y - 44)).toBeLessThanOrEqual(1);
  for (const control of [
    sheet.locator("#export-title"),
    sheet.getByTestId("export-options-close"),
    sheet.getByRole("button", { name: "Cancel" }),
    sheet.getByTestId("export-save"),
  ]) {
    const box = await control.boundingBox();
    if (!box) throw new Error("A control of the sheet isn't shown.");
    expect(inside(box, wideSize)).toBe(true);
  }
  const room = await body.evaluate((element) => [element.scrollHeight, element.clientHeight]);
  expect(room[0]).toBe(room[1]);
  await app.close();
});

test("the shared page's Notes list is compact and each line links back to its Citation, in English and Chinese, and holds at 375 px", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Tides");
  const mindId = await window.getByTestId("mind-pane").getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind is open.");
  await writeFile(
    join(sources, "Tides.txt"),
    "Spring tides come twice a month, at new and full moon.\n\nNeap tides fall between them.\n",
  );
  await addDocuments(window, [join(sources, "Tides.txt")]);
  const [tides] = await core(window).documents();
  if (!tides) throw new Error("No Tides.");
  await core(window).write(
    mindId,
    blocksUpdate([
      paragraph(
        "Spring tides follow the moon",
        citation(tides, "Spring tides come twice a month", 1, "found"),
        ".",
      ),
      paragraph(
        "Neap tides come between",
        citation(tides, "Neap tides fall between them", 3, "found"),
        ".",
      ),
    ]),
  );
  await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(2);
  await useOutputLocation(window, out);
  await openOptions(window, "Export options");
  const sheet = window.getByTestId("export-dialog");
  await sheet.getByTestId("export-format").selectOption("share-page");
  await pointAndClick(window, sheet.getByTestId("export-save"));
  await expect(sheet).toBeHidden();
  await exportFromMenu(window);
  const page = await openSavedPage(app, await savedPath(window, "Tides.html"));

  const look = (target: Page) =>
    target.locator(".notes").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        font: style.fontFamily.split(",")[0]?.trim().replaceAll('"', "") ?? "",
        size: style.fontSize,
      };
    });
  await expect(page.locator(".notes h2")).toHaveText("Notes");
  expect(await look(page)).toEqual({ font: "system-ui", size: "12px" });
  const serif = await page
    .locator("main")
    .evaluate((element) => getComputedStyle(element).fontFamily.split(",")[0]?.trim() ?? "");
  expect(serif).not.toBe("system-ui");
  const lines = page.locator(".notes li");
  await expect(lines).toHaveCount(2);
  await expect(lines.first()).toContainText(
    "1 · Tides, line 1 · “Spring tides come twice a month”",
  );
  await expect(lines.nth(1)).toContainText("2 · Tides, line 3 · “Neap tides fall between them”");
  for (const number of [1, 2]) {
    await expect(page.locator(`.notes #note-${number} a.backref`)).toHaveAttribute(
      "href",
      `#ref-${number}`,
    );
    await expect(page.locator(`main a.cite[href="#note-${number}"]`)).toHaveCount(1);
  }

  await resize(app, page, 375, 720);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const line = await lines.first().boundingBox();
  if (!line) throw new Error("The first note isn't shown.");
  expect(line.width).toBeLessThanOrEqual(375);
  await expect(page.locator(".notes")).toBeVisible();
  await page.close();

  await setLanguage(window, "zh-CN");
  await expect(window.getByTestId("export-mind")).toHaveText("导出");
  await openOptions(window, "导出选项");
  await expect(sheet.getByTestId("export-format").locator("option:checked")).toHaveText(
    "可分享的网页（.html）",
  );
  await pointAndClick(window, sheet.getByTestId("export-save"));
  await expect(sheet).toBeHidden();
  await exportFromMenu(window);
  const done = window.getByTestId("export-result").getByTestId("export-done");
  await expect(done).toContainText("已保存“Tides 2.html”到");
  const zh = await openSavedPage(app, (await done.getAttribute("title")) ?? "");
  await expect(zh.locator(".notes h2")).toHaveText("注释");
  expect(await look(zh)).toEqual({ font: "system-ui", size: "12px" });
  await expect(zh.locator(".notes li").first()).toContainText(
    "1 · Tides，第 1 行 · “Spring tides come twice a month”",
  );
  await zh.locator(".notes #note-2 a.backref").click();
  await expect(zh).toHaveURL(/#ref-2$/);
  await zh.close();
  await app.close();
});
