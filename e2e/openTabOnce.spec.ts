import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  launchApp,
  newMind,
  openDocumentAt,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A Document is open in one tab: opening it again, from a Citation's card, goes
 * to that tab, wherever it is, and Open the page keeps it if it is a preview.
 */

/** Three short pages: the line about spring tides is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);
const QUOTE = "Spring tides happen at new moon and at full moon.";

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

/** Asks in the assistant, beside a new Mind, for an Answer that cites Tides, page 2. */
async function askAboutTides(window: Page) {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  const answer = await askInAssistant(window, "When do spring tides happen?");
  return answer.getByTestId("citation-chip");
}

/** Hovers the Citation and chooses Open in its card, as a person does. */
async function openThePage(window: Page, chip: Locator) {
  await chip.hover();
  await window.getByTestId("citation-card").getByTestId("citation-open").click();
  await expect(window.getByTestId("citation-card")).toHaveCount(0);
}

const tabsOf = (window: Page, title: string) =>
  window.getByTestId("document-tab").filter({ hasText: title });

for (const width of [1440, 960]) {
  test(`at ${width}px, Open the page twice on a Citation leaves one tab, kept; the page is shown at its quote again`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await setWindowSize(app, window, width, 800);
    const chip = await askAboutTides(window);

    await openThePage(window, chip);
    await expect(tabsOf(window, "Tides")).toHaveCount(1);
    await expect(tabsOf(window, "Tides")).toHaveAttribute("data-preview", "true");

    // The User reads the Document: its group has the keyboard's focus, and the page is
    // somewhere else when the Citation is opened again.
    await window.keyboard.press("ControlOrMeta+2");
    const page = window.getByTestId("pdf-page-number");
    await page.fill("3");
    await page.press("Enter");
    await expect(page).toHaveValue("3");
    await expect(tabsOf(window, "Tides")).toHaveAttribute("data-preview", "true");

    await openThePage(window, chip);
    await expect(tabsOf(window, "Tides")).toHaveCount(1);
    await expect(tabsOf(window, "Tides")).not.toHaveAttribute("data-preview");
    await expect(page).toHaveValue("2");
    const highlights = window
      .getByTestId("viewer")
      .locator('[data-page-number="2"] [data-quote-highlight]');
    await expect(highlights).toHaveText([QUOTE]);
    await expect(highlights.first()).toBeInViewport();
    await app.close();
  });
}

test("a Document previewed in another group, behind that group's other tab, is shown there at its quote and kept", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await setWindowSize(app, window, 1440, 800);
  const chip = await askAboutTides(window);

  // Tides is a preview in the group to the right of the Mind, at its first page; a new Mind
  // opened in that group comes in front of it.
  await openDocumentAt(window, { documentId: await documentIdOf(window, "Tides") });
  const groups = window.getByTestId("tab-group");
  await expect(groups).toHaveCount(2);
  await window.keyboard.press("ControlOrMeta+2");
  await newMind(window);
  const right = groups.nth(1);
  await expect(right.getByRole("tab")).toHaveCount(2);
  await expect(right.getByRole("tab", { selected: true })).not.toContainText("Tides");

  // Back in the first Mind, as a Citation in it is opened.
  await window.keyboard.press("ControlOrMeta+1");
  await openThePage(window, chip);

  await expect(groups).toHaveCount(2);
  await expect(tabsOf(window, "Tides")).toHaveCount(1);
  await expect(right.getByRole("tab", { selected: true })).toContainText("Tides");
  await expect(right.getByRole("tab")).toHaveCount(2);
  await expect(tabsOf(window, "Tides")).not.toHaveAttribute("data-preview");
  await expect(right.getByTestId("pdf-page-number")).toHaveValue("2");
  const highlights = right.locator('[data-page-number="2"] [data-quote-highlight]');
  await expect(highlights).toHaveText([QUOTE]);
  await expect(highlights.first()).toBeInViewport();
  await app.close();
});

test("a Document in a tab behind the Mind, in the Mind's own group, moves to the group beside it, and the Mind stays in view", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await setWindowSize(app, window, 1440, 800);
  const chip = await askAboutTides(window);

  // Open in a new tab, from the sidebar's menu, puts Tides in the Mind's group; then the Mind is shown again.
  await pointAndClick(
    window,
    window.getByTestId("document-list-item").getByTestId("open-document"),
    {
      button: "right",
    },
  );
  const menu = window.getByTestId("document-file-actions");
  await expect(menu).toBeVisible();
  await pointAndClick(window, menu.getByTestId("document.openTab"));
  const groups = window.getByTestId("tab-group");
  await expect(groups).toHaveCount(1);
  await expect(tabsOf(window, "Tides")).toHaveCount(1);
  await pointAndClick(window, groups.first().getByTestId("mind-tab"));
  await expect(groups.first().getByTestId("mind-tab")).toHaveAttribute("aria-selected", "true");

  await openThePage(window, chip);

  // One tab, in a new group to the right, at its quote; the Mind stays shown where it was.
  await expect(groups).toHaveCount(2);
  await expect(tabsOf(window, "Tides")).toHaveCount(1);
  await expect(groups.first().getByTestId("document-tab")).toHaveCount(0);
  await expect(groups.first().getByTestId("mind-tab")).toHaveAttribute("aria-selected", "true");
  const right = groups.nth(1);
  await expect(right.getByTestId("document-tab")).toHaveAttribute("aria-selected", "true");
  await expect(right.getByTestId("pdf-page-number")).toHaveValue("2");
  const highlights = right.locator('[data-page-number="2"] [data-quote-highlight]');
  await expect(highlights).toHaveText([QUOTE]);
  await expect(highlights.first()).toBeInViewport();
  await app.close();
});
