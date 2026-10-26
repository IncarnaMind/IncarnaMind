import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
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
  sidebarFolder,
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

async function start(
  width: number,
  height: number,
  language: "en" | "zh-CN" = "en",
  additional: readonly string[] = [],
) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, width, height);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await addDocuments(window, [join(sources, "Tides.pdf"), ...additional]);
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

async function storedScopes(window: Page) {
  return window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [conversation] = await bridge.listConversations();
    if (!conversation) return [];
    const { messages } = await bridge.getConversation(conversation.id);
    return messages.flatMap((message) => {
      if (message.kind !== "question") return [];
      const scope = message.scope ?? { folderIds: [], tagIds: [], documentIds: [] };
      return [
        {
          folderIds: [...scope.folderIds],
          tagIds: [...scope.tagIds],
          documentIds: [...scope.documentIds].sort(),
        },
      ];
    });
  });
}

async function openCitation(window: Page, answer: Locator, keyboard = false) {
  const chip = answer.getByTestId("citation-chip").first();
  if (keyboard) {
    await chip.focus();
    await window.keyboard.press("Enter");
  } else {
    await pointAndClick(window, chip);
  }
  const card = window.getByTestId("citation-card");
  if (await card.isVisible()) {
    const open = card.getByTestId("citation-open");
    if (keyboard) {
      await open.focus();
      await window.keyboard.press("Enter");
    } else {
      await pointAndClick(window, open);
    }
  }
  await expect(window.getByTestId("viewer")).toBeVisible();
}

for (const language of ["en", "zh-CN"] as const) {
  test(`an explicit Document scope survives checking a Citation and a follow-up (${language})`, async () => {
    const cedarFinal = join(sources, "Cedar final.txt");
    const cedarNotes = join(sources, "Cedar notes.txt");
    await writeFile(
      cedarFinal,
      "Neap tides are the smallest of the month.\nSpring tides happen at new moon and at full moon.\n",
    );
    await writeFile(
      cedarNotes,
      "The Cedar review notes the same tide dates.\nSpring tides happen at new moon and at full moon.\n",
    );
    const { app, window } = await start(1600, 900, language, [cedarFinal, cedarNotes]);
    try {
      await writeMind(window, "Tide notes", "Check the Cedar evidence before asking again.");
      await pointAndClick(window, window.getByTestId("open-library"));
      const library = window.getByTestId("library");
      const finalRow = library.getByTestId("library-document").filter({ hasText: "Cedar final" });
      const notesRow = library.getByTestId("library-document").filter({ hasText: "Cedar notes" });
      await pointAndClick(window, finalRow.locator("[data-row-main]"), {
        modifiers: ["ControlOrMeta"],
      });
      await pointAndClick(window, notesRow.locator("[data-row-main]"), {
        modifiers: ["ControlOrMeta"],
      });
      await expect(library.getByTestId("library-selection")).toBeVisible();
      const expectedIds = [
        await finalRow.getAttribute("data-document-id"),
        await notesRow.getAttribute("data-document-id"),
      ]
        .filter((id): id is string => id !== null)
        .sort();
      expect(expectedIds).toHaveLength(2);
      await pointAndClick(
        window,
        library.getByTestId("library-selection").locator('[data-command="document.ask"]'),
      );
      const composer = window.getByTestId("composer");
      const chips = composer.getByTestId("scope-chip");
      await expect(chips).toHaveCount(2);
      const restricted = { folderIds: [], tagIds: [], documentIds: expectedIds };
      const everywhere = { folderIds: [], tagIds: [], documentIds: [] };

      const first = await ask(window, "When do spring tides happen?");
      await expect(first.getByTestId("answer-steps")).toContainText(
        language === "en" ? "Searched 2 files" : "已搜索所选的 2 个文件",
      );
      await expect(first.getByTestId("citation-chip").first()).toHaveAttribute(
        "data-check",
        "found",
      );
      expect(await storedScopes(window)).toEqual([restricted]);

      await setWindowSize(app, window, 900, 760);
      await openCitation(window, first);
      const citedId = await window
        .locator('[data-testid="document-tab"][aria-selected="true"]')
        .getAttribute("data-document-id");
      if (!citedId) throw new Error("The cited Document tab has no id.");
      await screenshot(window, `citation-scope-${language}`);
      await expect(chips).toHaveCount(2);
      await openCitation(window, first, true);
      await expect(chips).toHaveCount(2);
      const second = await ask(window, "And when are neap tides?");
      await expect(second.getByTestId("answer-steps")).toContainText(
        language === "en" ? "Searched 2 files" : "已搜索所选的 2 个文件",
      );
      expect(await storedScopes(window)).toEqual([restricted, restricted]);

      await pointAndClick(window, window.getByTestId("open-library"));
      await expect(composer.getByTestId("composer-scope-all")).toHaveText(
        language === "en" ? "All Documents" : "全部文档",
      );
      await ask(window, "When do spring tides happen, anywhere?");
      expect(await storedScopes(window)).toEqual([restricted, restricted, everywhere]);
      await pointAndClick(window, window.getByTestId("sidebar-home"));
      await expect(composer.getByTestId("composer-scope-all")).toHaveText(
        language === "en" ? "All Documents" : "全部文档",
      );
      await ask(window, "When do spring tides happen, anywhere?");
      expect(await storedScopes(window)).toEqual([restricted, restricted, everywhere, everywhere]);

      await pointAndClick(window, window.getByTestId("open-library"));
      await pointAndClick(
        window,
        library.locator(`[data-document-id="${citedId}"] [data-row-main]`),
      );
      await expect(window.getByTestId("viewer")).toBeVisible();
      await expect(composer.getByTestId("composer-scope-all")).toHaveText(
        language === "en" ? "All Documents" : "全部文档",
      );
      const direct = await ask(window, "When do spring tides happen, anywhere?");
      await expect(direct.getByTestId("answer-steps")).toContainText(
        language === "en" ? "Searched All Documents" : "已搜索全部文档",
      );
      expect(await storedScopes(window)).toEqual([
        restricted,
        restricted,
        everywhere,
        everywhere,
        everywhere,
      ]);

      await pointAndClick(window, window.getByTestId("mind-tab").filter({ hasText: "Tide notes" }));
      await newMind(window);
      await openCitation(window, first);
      await expect(composer.getByTestId("composer-scope-all")).toHaveText(
        language === "en" ? "All Documents" : "全部文档",
      );
      const defaultAnswer = await ask(window, "When do spring tides happen, anywhere?");
      await expect(defaultAnswer.getByTestId("answer-steps")).toContainText(
        language === "en" ? "Searched All Documents" : "已搜索全部文档",
      );
      expect(await storedScopes(window)).toEqual([
        restricted,
        restricted,
        everywhere,
        everywhere,
        everywhere,
        everywhere,
      ]);
      const tideTab = window.getByTestId("mind-tab").filter({ hasText: "Tide notes" });
      await pointAndClick(window, tideTab);
      await expect(tideTab).toHaveAttribute("aria-selected", "true");
      await expect(window.getByTestId("mind-editor")).toBeVisible();
      await expect(chips).toHaveCount(2);
      await openCitation(window, first, true);
      await expect(chips).toHaveCount(2);

      for (let index = 0; index < 2; index++) {
        await pointAndClick(window, chips.first().getByTestId("scope-chip-remove"));
      }
      await expect(composer.getByTestId("composer-scope-all")).toHaveText(
        language === "en" ? "All Documents" : "全部文档",
      );
      const third = await ask(window, "When do spring tides happen, anywhere?");
      await expect(third.getByTestId("answer-steps")).toContainText(
        language === "en" ? "Searched All Documents" : "已搜索全部文档",
      );
      expect(await storedScopes(window)).toEqual([
        restricted,
        restricted,
        everywhere,
        everywhere,
        everywhere,
        everywhere,
        everywhere,
      ]);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Folder Note's own Folder scope survives Citation inspection (${language})`, async () => {
    const cedarFinal = join(sources, "Cedar final.txt");
    await writeFile(cedarFinal, "Spring tides happen at new moon and at full moon.\n");
    const { app, window } = await start(900, 760, language, [cedarFinal]);
    try {
      const folderId = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const folder = await bridge.createLibraryGroup({ name: "Cedar review", description: "" });
        const document = (await bridge.listDocuments()).find((each) => each.name === "Cedar final");
        if (!document) throw new Error("Cedar final is missing.");
        await bridge.assignDocumentGroup(document.id, folder.id);
        return folder.id;
      });
      const folder = sidebarFolder(window, "Cedar review");
      await folder.getByTestId("folder-row").click({ button: "right" });
      await folder.getByTestId("folder.newMind").click();
      const composer = window.getByTestId("composer");
      const chips = composer.getByTestId("scope-chip");
      await expect(chips).toHaveAttribute("data-id", folderId);
      await expect(chips).toHaveAttribute("data-own", "true");
      const expected = { folderIds: [folderId], tagIds: [], documentIds: [] };

      const first = await ask(window, "When do spring tides happen?");
      await expect(first.getByTestId("citation-chip").first()).toHaveAttribute(
        "data-check",
        "found",
      );
      expect(await storedScopes(window)).toEqual([expected]);
      await openCitation(window, first);
      await expect(chips).toHaveText("Cedar review");
      await expect(chips).toHaveAttribute("data-id", folderId);
      await expect(chips).toHaveAttribute("data-own", "true");
      await ask(window, "When do spring tides happen, again?");
      expect(await storedScopes(window)).toEqual([expected, expected]);
    } finally {
      await app.close();
    }
  });
}

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
