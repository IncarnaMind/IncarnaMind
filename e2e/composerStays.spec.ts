import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  tabMenu,
} from "./app";

/**
 * The assistant's composer stays whatever is in focus (#621, part of #258): in
 * a Document's tab, in the Library, on Home. The Question searches All
 * Documents, and Add to note asks which Mind, in place, opening it beside the
 * tab the User is in. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

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

async function start(width: number, height: number, language: "en" | "zh-CN" = "en") {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, width, height);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  if (language !== "en") await setLanguage(window, language);
  return { app, window };
}

/** A Mind, named, and one Note typed as a person does. */
async function writeMind(window: Page, title: string, note: string): Promise<Locator> {
  await newMind(window);
  await enterContent(window);
  await nameMind(window, title);
  await window.keyboard.type(note);
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator("p")).toHaveText([note]);
  return editor;
}

/** Asks from whatever is in focus, with ⌘J: the Answer once it is written. */
async function ask(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  const input = window.getByTestId("composer-input");
  await expect(input).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  const answer = answers.last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  return answer;
}

test("a follow-up from a Document's tab is answered from All Documents, and Add to note asks which Mind, adds there, and Undo takes it out", async () => {
  // Narrow, the groups share one strip: the cited page comes to the front and the Mind is out of sight.
  const { app, window } = await start(900, 760);
  const mindEditor = await writeMind(window, "Tide notes", "Spring tides come twice a month.");
  const first = await askInAssistant(window, "When do spring tides happen?");
  await expect(first.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");

  await pointAndClick(window, first.getByTestId("citation-chip"));
  const card = window.getByTestId("citation-card");
  if (await card.isVisible()) await pointAndClick(window, card.getByTestId("citation-open"));
  await expect(window.getByTestId("viewer")).toBeVisible();
  const shown = window.locator('[data-testid="document-tab"][aria-selected="true"]');
  await expect(shown).toHaveCount(1);
  const documentTabId = await shown.getAttribute("data-tab-id");
  await expect(mindEditor).toBeHidden();

  // The composer stays, and the empty line it replaced is gone with it.
  const composer = window.getByTestId("composer");
  await expect(composer).toBeVisible();
  await expect(window.getByTestId("assistant-no-mind")).toHaveCount(0);
  await expect(window.getByTestId("composer-scope-all")).toBeVisible();
  await screenshot(window, "composer-stays-document-en");

  const second = await ask(window, "And when are neap tides?");
  await expect(second.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
  await expect(second.getByTestId("answer-steps")).toHaveText("Searched All Documents · 1 source");
  // The same conversation: both Questions are in it.
  await expect(window.getByTestId("assistant-question")).toHaveCount(2);
  await expect(shown).toHaveCount(1);

  // No Mind in focus: Add to note asks which, in place.
  await pointAt(window, second.getByTestId("assistant-answer-text"));
  const add = second.getByTestId("answer-add");
  await expect(add).toHaveAttribute("title", "Choose a Mind to add it to");
  await pointAndClick(window, add);
  const picker = window.getByTestId("add-to-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("add-to-search")).toBeFocused();
  await expect(picker.getByTestId("add-to-option").last()).toContainText("New Mind");
  await screenshot(window, "composer-stays-picker-en");
  // The keyboard reaches the list: ↓ to the Mind, Enter adds.
  await window.keyboard.press("ArrowDown");
  await expect(picker.getByTestId("add-to-option").first()).toHaveAttribute(
    "aria-selected",
    "false",
  );
  await window.keyboard.press("ArrowUp");
  await expect(picker.getByTestId("add-to-option").first()).toContainText("Tide notes");
  await window.keyboard.press("Enter");
  await expect(picker).toBeHidden();

  // It opens beside the Document's tab, never replacing it, and holds the Answer.
  await expect(second.getByTestId("answer-added")).toContainText("Added to “Tide notes”");
  await expect(window.locator(`[data-tab-id="${documentTabId}"]`)).toHaveCount(1);
  await expect(window.getByTestId("mind-tab").filter({ hasText: "Tide notes" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(mindEditor).toContainText("Your Documents answer this");

  // One step takes it back.
  await pointAndClick(window, second.getByTestId("answer-added-undo"));
  await expect(mindEditor.locator(":scope > p")).toHaveText(["Spring tides come twice a month."]);
  await app.close();
});

test("with the Library in front and no Mind open, a Question is answered from All Documents, and Add to note → New Mind makes a Mind beside the Library", async () => {
  const { app, window } = await start(1440, 900);
  await pointAndClick(window, window.getByTestId("open-library"));
  await expect(window.getByTestId("library-tab")).toHaveAttribute("aria-selected", "true");
  await expect(window.getByTestId("mind-tab")).toHaveCount(0);

  await expect(window.getByTestId("assistant-reads")).toHaveText("Searches All Documents");
  await expect(window.getByTestId("composer")).toBeVisible();
  await expect(window.getByTestId("assistant-no-mind")).toHaveCount(0);
  await screenshot(window, "composer-stays-library-en");

  const answer = await ask(window, "When do spring tides happen?");
  await expect(answer.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
  await expect(answer.getByTestId("answer-steps")).toHaveText("Searched All Documents · 1 source");

  await pointAt(window, answer.getByTestId("assistant-answer-text"));
  await pointAndClick(window, answer.getByTestId("answer-add"));
  const picker = window.getByTestId("add-to-picker");
  await expect(picker).toBeVisible();
  await pointAndClick(window, picker.getByTestId("add-to-option").last());
  await expect(answer.getByTestId("answer-added")).toHaveCount(0);

  // A Mind holding the Answer opened beside the Library, which is still there.
  await expect(window.getByTestId("library-tab")).toHaveCount(1);
  const tab = window.getByTestId("mind-tab");
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(window.getByTestId("mind-editor")).toContainText("Your Documents answer this");

  await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.delete"));
  await expect(tab).toHaveCount(0);
  await expect(window.getByTestId("library-tab")).toHaveCount(1);
  await app.close();
});

test("in Chinese: the composer stays in the Library, and the line says what it searches", async () => {
  const { app, window } = await start(1440, 900, "zh-CN");
  await pointAndClick(window, window.getByTestId("open-library"));
  await expect(window.getByTestId("assistant-reads")).toHaveText("搜索全部文档");
  await expect(window.getByTestId("composer")).toBeVisible();
  await expect(window.getByTestId("composer-scope-all")).toBeVisible();
  await screenshot(window, "composer-stays-library-zh");
  await app.close();
});

test("clicking + New Mind and then the composer at once: what is typed, and the focus, carry over to the Mind's composer", async () => {
  const { app, window } = await start(1440, 900);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  // No wait for the Mind: the window's composer is there, and the Mind's takes over from it.
  const text = "When do spring tides happen, and why do they come twice a month?";
  await window.getByTestId("composer-input").click();
  await window.keyboard.type(text);
  await expect(window.getByTestId("mind-editor")).toBeVisible();
  await expect(window.getByTestId("composer")).toHaveCount(1);
  await expect(window.getByTestId("composer-input")).toHaveValue(text);
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(" Thanks.");
  await expect(window.getByTestId("composer-input")).toHaveValue(`${text} Thanks.`);
  await app.close();
});
