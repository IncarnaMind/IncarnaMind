import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addToNote,
  askInAssistant,
  clickEndOf,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  linkFolderFromSidebar,
  newMind,
  openSteps,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/**
 * A Citation shows its Document's current name (#532): after a rename on disk and one in
 * IncarnaMind its card, its accessible name, a copy with its Citation and the Bibliography say
 * the new name and Open still goes to its page; once the Document is deleted they say the name
 * it was cited with. The Citation's own attribute is never rewritten.
 */
const FERRY = buildPdf([
  { lines: ["Ferry crossings", "The ferry crosses the bay twice a day."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

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

const bridge = (window: Page) => ({
  names: () =>
    window.evaluate(async () =>
      (
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
      ).map((document) => document.name),
    ),
  remove: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      for (const document of await core.listDocuments()) await core.deleteDocument(document.id);
    }),
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
});

/** What the editor's copy puts on the clipboard with the whole Mind selected. */
const copiedText = (editor: Locator) =>
  editor.evaluate((dom) => {
    (dom as unknown as { editor: Editor }).editor.commands.selectAll();
    const data = new DataTransfer();
    dom.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
    );
    return data.getData("text/plain");
  });

/** The `documentName` each Citation in the Mind stores. */
const storedNames = (editor: Locator) =>
  editor.evaluate((dom) => {
    const names: unknown[] = [];
    (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
      if (node.type.name === "citation") names.push(node.attrs.documentName);
    });
    return names;
  });

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a Citation shows its Document's current name after a rename on disk and in IncarnaMind, and the stored one once it is deleted", async () => {
  const library = join(sources, "Library");
  await mkdir(library);
  await writeFile(join(library, "Ferry.pdf"), FERRY);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1400, 900);
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await linkFolderFromSidebar(app, window, library);
    await expectReadyDocuments(window, 1);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    const answer = await askInAssistant(window, "When do spring tides happen?");
    await addToNote(window, answer);
    const source = (await openSteps(window, answer)).getByTestId("answer-step-source");
    const chip = editor.getByTestId("citation-chip");
    await expect(chip).toHaveCount(1);
    await clickEndOf(window, editor.locator(":scope > p").last());
    await window.keyboard.press("Enter");
    await window.keyboard.type("/biblio");
    await window.keyboard.press("Enter");
    const references = window.getByTestId("references");
    await expect(references).toBeVisible();
    const viewerTitle = window.getByTestId("viewer-title");
    const card = window.getByTestId("citation-card");

    /** Everything that names the Document says `name`, and the card's Open goes to its page. */
    const shows = async (name: string) => {
      await expect(chip).toHaveAttribute(
        "aria-label",
        new RegExp(`^Citation 1: ${escaped(name)}, p\\. 2\\.`),
      );
      await window.mouse.move(0, 0);
      await chip.focus();
      await expect(card).toBeVisible();
      await expect(card.getByText(name, { exact: true })).toBeVisible();
      await expect(card).toHaveAttribute("aria-label", new RegExp(`${escaped(name)}, p\\. 2\\.`));
      // From the card, which closes.
      await card.getByTestId("citation-open").click();
      await expect(card).toHaveCount(0);
      await expect(viewerTitle).toHaveText(name);
      await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
      await expect(references.getByTestId("reference-entry")).toHaveText(`${name}. Cited: p. 2`);
      expect(await copiedText(editor)).toMatch(
        new RegExp(`\\nSources\\n\\[1\\] ${escaped(name)}, p\\. 2$`),
      );
      // The Answer's steps in the assistant name it too.
      await expect(source.locator(".answer-step-source-name")).toHaveText(name);
    };

    await shows("Ferry");

    // Renamed on disk: the name that was the file's follows it.
    await rename(join(library, "Ferry.pdf"), join(library, "Ferry-timetable.pdf"));
    await expect
      .poll(() => bridge(window).names(), { timeout: 15_000 })
      .toEqual(["Ferry-timetable"]);
    await shows("Ferry-timetable");

    // Renamed in IncarnaMind, from the viewer's header.
    await viewerTitle.dblclick();
    const field = window.getByTestId("viewer-title-rename");
    await expect(field).toBeFocused();
    await field.fill("Ferry schedule");
    await window.keyboard.press("Enter");
    await expect(viewerTitle).toHaveText("Ferry schedule");
    await shows("Ferry schedule");

    // In Chinese, the accessible name and the Sources list say it too.
    await bridge(window).language("zh-CN");
    await expect(chip).toHaveAttribute("aria-label", /^引用 1：Ferry schedule，第 2 页。/);
    expect(await copiedText(editor)).toContain("来源\n[1] Ferry schedule，第 2 页");
    await bridge(window).language("en");

    // What the Mind stores is what it stored when it was cited.
    expect(await storedNames(editor)).toEqual(["Ferry"]);

    // Deleted: the name it was cited with, and its Open shows the quote it kept.
    await bridge(window).remove();
    await expect.poll(() => bridge(window).names()).toEqual([]);
    await expect(chip).toHaveAttribute("aria-label", /^Citation 1: Ferry, p\. 2\. Can’t check/);
    await window.mouse.move(0, 0);
    await chip.focus();
    await expect(card).toBeVisible();
    await expect(card.getByText("Ferry, p. 2", { exact: true })).toBeVisible();
    await expect(card.getByTestId("citation-reason")).toHaveText("The Document has been deleted.");
    await expect(card.getByTestId("citation-open")).toHaveText("Show the quoted text");
    await card.getByTestId("citation-open").click();
    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("viewer")).toContainText(
      "This Document has been deleted from IncarnaMind",
    );
    await expect(source.locator(".answer-step-source-name")).toHaveText("Ferry");
    await expect(references.getByTestId("reference-entry")).toHaveText("Ferry. Cited: p. 2");
    expect(await copiedText(editor)).toMatch(/\nSources\n\[1\] Ferry, p\. 2$/);
    expect(await storedNames(editor)).toEqual(["Ferry"]);
  } finally {
    await app.close();
  }
});

test("in a citation style, the References and the Citations ask again and read the new name after a rename", async () => {
  const library = join(sources, "Library");
  await mkdir(library);
  await writeFile(join(library, "Ferry.pdf"), FERRY);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1400, 900);
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await linkFolderFromSidebar(app, window, library);
    await expectReadyDocuments(window, 1);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
    await clickEndOf(window, editor.locator(":scope > p").last());
    await window.keyboard.press("Enter");
    await window.keyboard.type("/biblio");
    await window.keyboard.press("Enter");
    const references = window.getByTestId("references");
    await pointAndClick(window, references.getByTestId("references-style"));
    const picker = window.getByTestId("citation-style-picker");
    await expect(picker.getByTestId("citation-style-search")).toBeFocused();
    await window.keyboard.type("harvard");
    await window.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    await expect(references).toHaveAttribute("data-style", "harvard");
    const entry = references.getByTestId("reference-entry");
    const chip = editor.getByTestId("citation-chip");
    await expect(entry).toContainText("Ferry.");
    await expect(chip).toHaveText("(“Ferry,” no date, p. 2)");

    await rename(join(library, "Ferry.pdf"), join(library, "Ferry-timetable.pdf"));
    await expect(entry).toContainText("Ferry-timetable.");
    await expect(chip).toHaveText("(“Ferry-timetable,” no date, p. 2)");
  } finally {
    await app.close();
  }
});

test("a Citation card names the place of a Document that shares its name, and Open goes to that Document (#1507)", async () => {
  const library = join(sources, "Reading");
  await mkdir(join(library, "2025"), { recursive: true });
  await mkdir(join(library, "2026"), { recursive: true });
  await writeFile(join(library, "2025", "Annual-Report.txt"), "The office is closed in August.\n");
  await writeFile(
    join(library, "2026", "Annual-Report.txt"),
    "Spring tides happen at new moon and at full moon.\n",
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1400, 900);
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await linkFolderFromSidebar(app, window, library);
    await expectReadyDocuments(window, 2);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
    const chip = editor.getByTestId("citation-chip");
    await expect(chip).toHaveCount(1);
    await window.mouse.move(0, 0);
    await chip.focus();
    const card = window.getByTestId("citation-card");
    await expect(card).toBeVisible();
    // The name alone doesn't say which Document: the card names its place too.
    await expect(card).toContainText("Annual-Report · 2026");

    const cited = await window.evaluate(async () => {
      const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const documents = await api.listDocuments();
      return documents.find((document) => document.path.endsWith("2026/Annual-Report.txt"))?.id;
    });
    await card.getByTestId("citation-open").click();
    await expect(card).toHaveCount(0);
    await expect(
      window.locator(`[data-testid="document-tab"][data-document-id="${cited}"]`),
    ).toHaveCount(1);
    await expect(window.getByTestId("viewer-title")).toHaveText("Annual-Report");
  } finally {
    await app.close();
  }
});
