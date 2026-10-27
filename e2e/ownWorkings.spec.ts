import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openDocumentMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * A Document the User keeps as their own workings (#897): "Don't cite this
 * Document" in the shared Document menu, in the sidebar and the Library, a
 * "Not cited" label beside its name, Undo by the undo line and ⌘Z, and, in a
 * check of a sentence only that file states, the card's own line. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (target: Page | Locator, name: string) => {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const REPORT = buildPdf([
  { lines: ["Annual report", "Revenue was $1,482.6 million in 2025, up from $1,231.0 million."] },
]);
const FIGURE = "Penguins nest on the harbour cliffs.";

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

async function addReportAndWorkings(window: Page) {
  await writeFile(join(sources, "Annual report.pdf"), REPORT);
  await writeFile(
    join(sources, "Workings.csv"),
    "Item,2024,2025\nRevenue (USD million),1231.0,1482.6\nOperating margin,0.18,0.21\n",
  );
  await writeFile(join(sources, "Field notes.txt"), `${FIGURE}\n`);
  await dismissChatSetup(window);
  await addDocuments(window, [
    join(sources, "Annual report.pdf"),
    join(sources, "Workings.csv"),
    join(sources, "Field notes.txt"),
  ]);
}

const sidebarRow = (window: Page, name: string) =>
  window.getByTestId("document-list-item").filter({ hasText: name });

const libraryRow = (window: Page, name: string) =>
  window
    .getByTestId("library")
    .getByTestId("library-document")
    .filter({ has: window.getByTestId("library-document-name").getByText(name, { exact: true }) });

async function openLibraryMenu(row: Locator): Promise<void> {
  await row.hover();
  await row.getByTestId("document-file-menu").click();
}

test("Don't cite this Document in the sidebar: the label shows beside its name, Undo and ⌘Z take it back, and the menu says Cite this Document again", async () => {
  const { window } = await launchApp(dataDir);
  await addReportAndWorkings(window);
  const workings = sidebarRow(window, "Workings");
  const report = sidebarRow(window, "Annual report");
  const label = workings.getByTestId("document-not-cited");
  await expect(label).toHaveCount(0);

  await openDocumentMenu(workings);
  const item = workings.getByTestId("document.dontCite");
  await expect(item).toHaveText("Don’t cite this Document");
  await expect(item).toHaveAttribute(
    "title",
    "Read for context only: never cited or used as evidence.",
  );
  await expect(workings.getByTestId("document.citeAgain")).toHaveCount(0);
  await pointAndClick(window, item);

  await expect(label).toHaveText("Not cited");
  await expect(report.getByTestId("document-not-cited")).toHaveCount(0);
  const undo = window.getByTestId("undo-line");
  await expect(undo.getByTestId("undo-message")).toHaveText("“Workings” won’t be cited");
  const [name, labelBox, row] = await Promise.all([
    workings.getByTestId("row-text").boundingBox(),
    label.boundingBox(),
    workings.boundingBox(),
  ]);
  if (!name || !labelBox || !row) throw new Error("The row isn't laid out.");
  expect(labelBox.x).toBeGreaterThanOrEqual(name.x + name.width);
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(row.x + row.width);
  expect(labelBox.height).toBeLessThanOrEqual(row.height);
  await screenshot(window.getByTestId("sidebar"), "not-cited-sidebar-en");

  await window.keyboard.press("ControlOrMeta+z");
  await expect(label).toHaveCount(0);
  await openDocumentMenu(workings);
  await pointAndClick(window, workings.getByTestId("document.dontCite"));
  await expect(label).toBeVisible();
  await openDocumentMenu(workings);
  const again = workings.getByTestId("document.citeAgain");
  await expect(again).toHaveText("Cite this Document again");
  await expect(workings.getByTestId("document.dontCite")).toHaveCount(0);
  await pointAndClick(window, again);
  await expect(label).toHaveCount(0);
  await expect(undo.getByTestId("undo-message")).toHaveText("“Workings” can be cited again");
  await undo.getByTestId("undo-action").click();
  await expect(label).toBeVisible();
});

test("In the Library and in Chinese: the same menu item and label, one Undo for several Documents, and the label holds at the narrowest window", async () => {
  const { app, window } = await launchApp(dataDir);
  await addReportAndWorkings(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  await window.getByTestId("open-library").click();
  const workings = libraryRow(window, "Workings");
  const notes = libraryRow(window, "Field notes");
  await expect(workings).toBeVisible();

  await openLibraryMenu(workings);
  const item = workings.getByTestId("document.dontCite");
  await expect(item).toHaveText("不作为引用来源");
  await expect(item).toHaveAttribute("title", "只用来理解问题，不会被引用，也不作为核对依据。");
  await pointAndClick(window, item);
  const label = workings.getByTestId("document-not-cited");
  await expect(label).toHaveText("不引用");
  await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
    "“Workings”不再作为引用来源",
  );
  const report = libraryRow(window, "Annual report");
  const [name, tags, labelBox, rowBox, reportTags] = await Promise.all([
    workings.getByTestId("library-document-name").boundingBox(),
    workings.getByTestId("document-tags").boundingBox(),
    label.boundingBox(),
    workings.boundingBox(),
    report.getByTestId("document-tags").boundingBox(),
  ]);
  if (!name || !tags || !labelBox || !rowBox || !reportTags) {
    throw new Error("The row isn't laid out.");
  }
  expect(labelBox.x).toBeGreaterThanOrEqual(name.x + name.width);
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(tags.x);
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(labelBox.height).toBeLessThan(24);
  expect(reportTags.x).toBeCloseTo(tags.x, 0);
  await screenshot(window.getByTestId("library"), "not-cited-library-zh-narrow");

  await expect(sidebarRow(window, "Workings").getByTestId("document-not-cited")).toHaveText(
    "不引用",
  );

  await window.keyboard.press("ControlOrMeta+z");
  await expect(label).toHaveCount(0);
  await pointAndClick(window, workings.getByTestId("library-document-name"), {
    modifiers: ["ControlOrMeta"],
  });
  await pointAndClick(window, notes.getByTestId("library-document-name"), {
    modifiers: ["ControlOrMeta"],
  });
  await openLibraryMenu(notes);
  await pointAndClick(window, notes.getByTestId("document.dontCite"));
  await expect(notes.getByTestId("document-not-cited")).toHaveText("不引用");
  await expect(label).toHaveText("不引用");
  await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
    "2 个文档不再作为引用来源",
  );
  await window.keyboard.press("ControlOrMeta+z");
  await expect(label).toHaveCount(0);
  await expect(notes.getByTestId("document-not-cited")).toHaveCount(0);
});

test("In the Library, marking the first Document moves no column", async () => {
  const { window } = await launchApp(dataDir);
  await addReportAndWorkings(window);
  await window.getByTestId("open-library").click();
  const workings = libraryRow(window, "Workings");
  const report = libraryRow(window, "Annual report");
  await expect(workings).toBeVisible();
  const columns = async () => {
    const boxes = await Promise.all(
      [workings, report].flatMap((row) =>
        [
          "library-document-name",
          "document-tags",
          "library-document-format",
          "library-document-added",
        ].map(async (id) => (await row.getByTestId(id).boundingBox())?.x),
      ),
    );
    if (boxes.some((x) => x === undefined)) throw new Error("A column isn't laid out.");
    return boxes;
  };
  const before = await columns();

  await openLibraryMenu(workings);
  await pointAndClick(window, workings.getByTestId("document.dontCite"));
  await expect(workings.getByTestId("document-not-cited")).toBeVisible();

  expect(await columns()).toEqual(before);
});

test("A long name gives way before the label, with an ellipsis, in the sidebar and the Library", async () => {
  const { app, window } = await launchApp(dataDir);
  const long = `Harbour sediment survey, east basin transects, combined field notes and the committee's comments on the revised method, final version for the board`;
  await writeFile(join(sources, `${long}.txt`), "Spring tides come twice a month.\n");
  await dismissChatSetup(window);
  await addDocuments(window, [join(sources, `${long}.txt`)]);
  await setWindowSize(app, window, 900, 720);
  const sidebar = sidebarRow(window, "Harbour sediment");
  await openDocumentMenu(sidebar);
  await pointAndClick(window, sidebar.getByTestId("document.dontCite"));
  await window.mouse.move(700, 600);
  await window.getByTestId("open-library").click();
  const listed = libraryRow(window, long);
  await expect(listed).toBeVisible();

  for (const [row, nameId] of [
    [sidebar, "row-text"],
    [listed, "library-document-name"],
  ] as const) {
    const label = row.getByTestId("document-not-cited");
    await expect(label).toBeVisible();
    const name = row.getByTestId(nameId);
    const [labelBox, nameBox, rowBox] = await Promise.all([
      label.boundingBox(),
      name.boundingBox(),
      row.boundingBox(),
    ]);
    if (!labelBox || !nameBox || !rowBox) throw new Error("The row isn't laid out.");
    expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(labelBox.x);
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    expect(labelBox.width).toBeGreaterThan(30);
  }
});

test("A sentence only the marked file states is Unsupported, and its card says so, in English and Chinese", async () => {
  const { window } = await launchApp(dataDir, { fakeChat: true });
  await useLocalChatModel(window);
  await addReportAndWorkings(window);
  await openDocumentMenu(sidebarRow(window, "Field notes"));
  await pointAndClick(window, sidebarRow(window, "Field notes").getByTestId("document.dontCite"));
  const notes = sidebarRow(window, "Field notes");
  await expect(notes.getByTestId("document-not-cited")).toBeVisible();
  await expect(notes.getByTestId("tag-marks")).toBeVisible();
  const [marks, notCited] = await Promise.all([
    notes.getByTestId("tag-marks").boundingBox(),
    notes.getByTestId("document-not-cited").boundingBox(),
  ]);
  if (!marks || !notCited) throw new Error("The row isn't laid out.");
  expect(notCited.x + notCited.width).toBeLessThanOrEqual(marks.x);

  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(FIGURE);
  const line = editor.locator(":scope > p").first();
  await expect(line).toHaveText(FIGURE);
  await slideSelect(window, line, "Penguins", { line, words: "cliffs." });
  const menu = window.getByTestId("selection-menu");
  await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));

  const mark = window.getByTestId("claim-mark");
  await expect(mark).toHaveAttribute("data-check", "unsupported");
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-badge")).toHaveText("Needs a look · Unsupported");
  await expect(card.getByTestId("claim-own-workings")).toHaveText(
    "Only your own working file says this.",
  );
  await expect(card.getByTestId("claim-nothing")).toHaveCount(0);
  await screenshot(window, "not-cited-card-en");

  await setLanguage(window, "zh-CN");
  await expect(card.getByTestId("claim-own-workings")).toHaveText("只有你自己的工作文件这样写。");
  await screenshot(window, "not-cited-card-zh");
});
