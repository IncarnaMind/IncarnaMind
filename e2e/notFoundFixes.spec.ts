import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { type MessageKey, type MessageParams, translate } from "../src/shared/i18n";
import {
  addDocuments,
  capture,
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  film,
  launchApp,
  motionSettled,
  newMind,
  openCardMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  wordsBox,
} from "./app";

/**
 * A sentence the check didn't find (#1554): Choose the Citation… opens a Document beside the
 * Note, where the words selected become its Citation and the check judges it on them; the
 * assistant runs it through the command list. The scripted model finds a sentence that shares
 * three words with a line.
 */

const OWN = "Harbours publish the times of high water every 12 months.";
const ELSEWHERE = "Penguins nest on the harbour cliffs every spring.";
const ABSENT = "Whales sing in the deep bay.";
const DIFFERENT = "Harbours forecast tides for 6 months.";

let dataDirs: string[];
let sources: string;
test.beforeEach(async () => {
  dataDirs = [];
  sources = await createDataFolder();
});
test.afterEach(async () => {
  for (const dataDir of dataDirs) await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const FILES = [
  { name: "Harbour times.txt", contents: `Harbour times\n\n${OWN}\n` },
  { name: "Seabirds.txt", contents: ELSEWHERE },
];

/** The app in `language`, the Documents added, and a new Note: its scope `scope` when given. */
async function launchNote(
  language: "en" | "zh-CN",
  width = 1440,
  scope?: string,
  files: readonly { name: string; contents: string }[] = FILES,
) {
  for (const file of files) await writeFile(join(sources, file.name), file.contents);
  const dataDir = await createDataFolder();
  dataDirs.push(dataDir);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await dismissChatSetup(window);
  await chooseScriptedModel(window, "fake-model");
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await addDocuments(
    window,
    files.map((file) => join(sources, file.name)),
  );
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  if (scope) {
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type(`@${scope}`);
    await expect(window.getByTestId("scope-picker")).toBeVisible();
    await window.keyboard.press("Enter");
  }
  return { app, window, editor };
}

/**
 * Types `claim` as a new last paragraph of the Note and checks it, then opens its card from the
 * keyboard with the caret in it: a mark's place among the others is no guide to its sentence.
 */
async function checkSentence(window: Page, editor: Locator, claim: string): Promise<Locator> {
  const written = (await noteText(editor)) !== "";
  const marks = window.getByTestId("claim-mark");
  const before = await marks.count();
  await pointAndClick(window, editor.locator(":scope > p").last());
  // At the Note's end, wherever in the last line the click put the caret: ⌘↓ on a Mac, Ctrl+End
  // elsewhere, as each system's text fields take it.
  await expect(async () => {
    await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    expect(
      await editor.evaluate((dom) => {
        const { state } = (dom as unknown as { editor: Editor }).editor;
        return state.selection.empty && state.selection.to === state.doc.content.size - 1;
      }),
    ).toBe(true);
  }).toPass();
  if (written) await window.keyboard.press("Enter");
  await window.keyboard.type(claim);
  const line = editor.locator(":scope > p").last();
  const words = claim.split(" ");
  await slideSelect(window, line, words.slice(0, 2).join(" "), {
    line,
    words: words.slice(-2).join(" "),
  });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  await expect(marks).toHaveCount(before + 1);
  await expect(marks.and(window.locator('[data-check="checking"]'))).toHaveCount(0);
  await motionSettled(window);
  await pointAndClick(window, line.getByText(words.slice(0, 2).join(" ")));
  await window.keyboard.press("ControlOrMeta+Shift+K");
  const card = window.getByTestId("claim-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "unsupported");
  return card;
}

/**
 * Drags across a Document's words as a person does, from the first letter of `from` to just past
 * the last of `to`, once the view has settled; a person who sees the drag stop short drags again.
 */
async function dragAcross(window: Page, view: Locator, from: string, to: string): Promise<void> {
  await expect(view).toContainText(to);
  await motionSettled(window);
  await expect(async () => {
    const start = await wordsBox(view, from);
    const end = await wordsBox(view, to);
    await window.mouse.move(start.left - 6, start.y, { steps: 4 });
    await window.mouse.move(start.left + 1, start.y, { steps: 2 });
    await window.mouse.down();
    await window.mouse.move(end.right - 1, end.y, { steps: 12 });
    await window.mouse.up();
    expect(
      await window.evaluate(() => getSelection()?.toString().replace(/\s+/g, " ").trim()),
    ).toBe(OWN);
  }).toPass({ timeout: 20_000 });
}

/** Selects the Document's sentence `OWN` in the viewer's page, not in the line naming the sentence. */
const selectOwn = (window: Page) =>
  dragAcross(
    window,
    window.getByTestId("viewer-text").filter({ visible: true }),
    "Harbours publish",
    "12 months.",
  );

/** The sentence's text as the Note holds it, a Citation as U+FFFC. */
const noteText = (editor: Locator) =>
  editor.evaluate((dom) => {
    const note = (dom as unknown as { editor: Editor }).editor;
    return note.state.doc.textBetween(0, note.state.doc.content.size, "\n", "￼").trim();
  });

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);

  test(`Choose the Citation… cites words selected in the Document, and the check judges the sentence on them (${language})`, async () => {
    test.setTimeout(300_000);
    const { app, window, editor } = await launchNote(language, 1440, "Seabirds");
    const card = await checkSentence(window, editor, OWN);
    // Under the card's ⋯, after its two buttons (#2869).
    const choose = (await openCardMenu(window, card)).getByTestId("claim-choose-citation");
    await expect(choose).toHaveText(t("claim.chooseCitation"));
    await capture(window, `after-choose-offer-${language}-1440`);
    await film(window, async () => {
      await pointAndClick(window, choose);
      const picker = window.getByTestId("citation-document-picker");
      await expect(picker).toBeVisible();
      // One Document, never a Folder, in words that say so.
      await expect(picker.getByTestId("citation-document-section")).toHaveCount(1);
      const search = window.getByTestId("citation-document-search");
      await expect(search).toHaveAttribute(
        "placeholder",
        language === "en" ? "Find a Document" : "查找文档",
      );
      await search.fill("Lighthouse");
      await expect(picker).toContainText(
        language === "en" ? "No Document matches" : "没有匹配的文档",
      );
      await search.fill("Harbour");
      await pointAndClick(window, picker.getByText("Harbour times", { exact: true }));
      const viewer = window.getByTestId("viewer");
      await expect(viewer).toBeVisible();
      const line = viewer.getByTestId("citation-pick-line");
      await expect(line).toContainText(t("claim.chooseCitation.hint"));
      await expect(line.getByTestId("citation-pick-other")).toHaveText(
        t("claim.chooseCitation.other"),
      );
      await expect(line).toContainText(OWN);
      await selectOwn(window);
      const menu = window.getByTestId("viewer-selection-menu");
      await expect(menu).toBeVisible();
      const cite = menu.getByTestId("viewer-selection-cite");
      await expect(cite).toContainText(t("claim.useAsCitation"));
      await expect(menu.getByRole("menuitem").first()).toHaveAttribute(
        "data-testid",
        "viewer-selection-cite",
      );
      await capture(window, `after-use-as-citation-${language}-1440`);
      await pointAndClick(window, cite);
      await expect(window.getByTestId("claim-mark").last()).toHaveAttribute(
        "data-check",
        "supported",
      );
    });
    expect(await noteText(editor)).toBe(`${OWN.slice(0, -1)}￼.`);
    await expect(window.getByTestId("citation-pick-line")).toHaveCount(0);
    await expect(window.getByTestId("undo-message")).toHaveText(t("claim.chosenCitation.done"));
    await capture(window, `after-chosen-supported-${language}-1440`);
    // Undo takes the Citation back with the check the sentence had.
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect.poll(() => noteText(editor)).toBe(OWN);
    await expect(window.getByTestId("claim-mark").last()).toHaveAttribute(
      "data-check",
      "unsupported",
    );

    // Words that don't back the sentence give it the card of a cited sentence nothing backs.
    const absent = await checkSentence(window, editor, ABSENT);
    await pointAndClick(
      window,
      (await openCardMenu(window, absent)).getByTestId("claim-choose-citation"),
    );
    await window.getByTestId("citation-document-search").fill("Harbour");
    await pointAndClick(
      window,
      window.getByTestId("citation-document-picker").getByText("Harbour times", { exact: true }),
    );
    await selectOwn(window);
    // Enter takes the words selected, as Use as Citation does.
    await window.keyboard.press("Enter");
    await expect.poll(() => noteText(editor)).toBe(`${OWN}\n${ABSENT.slice(0, -1)}￼.`);
    await expect(
      window.getByTestId("claim-mark").and(window.locator('[data-check="checking"]')),
    ).toHaveCount(0);
    await pointAndClick(window, editor.getByText("Whales sing"));
    await window.keyboard.press("ControlOrMeta+Shift+K");
    // The words don't back it: the card of a cited sentence nothing backs, with its Citation.
    const cited = window.getByTestId("claim-card");
    await expect(cited.getByTestId("claim-badge")).toHaveAttribute("data-check", "unsupported");
    await expect(cited.getByTestId("claim-cited")).toBeVisible();
    await capture(window, `after-chosen-unsupported-${language}-1440`);
    await window.keyboard.press("Escape");
    // Selected again, the words offer no Use as Citation: nothing waits for one.
    await selectOwn(window);
    await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
    await expect(window.getByTestId("viewer-selection-cite")).toHaveCount(0);
    await window.keyboard.press("Escape");

    // Cancel stops the wait.
    const third = await checkSentence(window, editor, "Gulls sleep on the old pier.");
    await pointAndClick(
      window,
      (await openCardMenu(window, third)).getByTestId("claim-choose-citation"),
    );
    await window.getByTestId("citation-document-search").fill("Harbour");
    await pointAndClick(
      window,
      window.getByTestId("citation-document-picker").getByText("Harbour times", { exact: true }),
    );
    await pointAndClick(window, window.getByTestId("citation-pick-cancel"));
    await expect(window.getByTestId("citation-pick-line")).toHaveCount(0);
    await selectOwn(window);
    await expect(window.getByTestId("viewer-selection-cite")).toHaveCount(0);
    await app.close();
  });
}

/**
 * Chooses `name` in the card's picker of Documents for the sentence's Citation, from its ⋯, where
 * Search all Documents is the card's first button.
 */
async function chooseIn(window: Page, card: Locator, name: string): Promise<void> {
  await pointAndClick(
    window,
    (await openCardMenu(window, card)).getByTestId("claim-choose-citation"),
  );
  await pickDocument(window, name);
}

/** Chooses `name` in the picker Choose the Citation… opened, and the sentence waits in it. */
async function pickDocument(window: Page, name: string): Promise<void> {
  await window.getByTestId("citation-document-search").fill(name);
  await pointAndClick(
    window,
    window.getByTestId("citation-document-picker").getByText(name, { exact: true }),
  );
  await expect(window.getByTestId("citation-pick-line")).toBeVisible();
}

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  test(`at 900 px the words become the Citation with ⌘/ and Enter, and the Note comes back to the front (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor } = await launchNote(language, 900, "Seabirds");
    const card = await checkSentence(window, editor, OWN);
    await chooseIn(window, card, "Harbour times");
    // One group at this width: the Document is in front of the Note.
    await expect(editor).toBeHidden();
    await selectOwn(window);
    await window.keyboard.press("ControlOrMeta+/");
    await expect(window.getByTestId("viewer-selection-cite")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(editor).toBeVisible();
    await expect.poll(() => noteText(editor)).toBe(`${OWN.slice(0, -1)}￼.`);
    await expect(window.getByTestId("undo-message")).toHaveText(t("claim.chosenCitation.done"));
    await expect(window.getByTestId("error-notice-message")).toHaveCount(0);
    await app.close();
  });
}

test("closing the Note's tab ends the wait: the Document offers no Use as Citation", async () => {
  test.setTimeout(240_000);
  const { app, window, editor } = await launchNote("en", 1440, "Seabirds");
  const card = await checkSentence(window, editor, OWN);
  await chooseIn(window, card, "Harbour times");
  const line = window.getByTestId("citation-pick-line");
  await expect(line).toBeVisible();
  await pointAndClick(window, window.getByTestId("mind-tab").getByTestId("tab-close"));
  await expect(window.getByTestId("mind-tab")).toHaveCount(0);
  await expect(line).toHaveCount(0);
  await selectOwn(window);
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  await expect(window.getByTestId("viewer-selection-cite")).toHaveCount(0);
  await app.close();
});

test("closing the Document's tab ends the wait: opened again, it offers no Use as Citation", async () => {
  test.setTimeout(240_000);
  const { app, window, editor } = await launchNote("en", 1440, "Seabirds");
  const card = await checkSentence(window, editor, OWN);
  await chooseIn(window, card, "Harbour times");
  const line = window.getByTestId("citation-pick-line");
  await pointAndClick(
    window,
    window.getByRole("tab").filter({ hasText: "Harbour times" }).getByTestId("tab-close"),
  );
  await expect(line).toHaveCount(0);
  await pointAndClick(
    window,
    window
      .getByTestId("document-list-item")
      .filter({ hasText: "Harbour times" })
      .getByTestId("open-document"),
  );
  await expect(window.getByTestId("viewer-text").filter({ visible: true })).toContainText(
    "12 months",
  );
  await expect(line).toHaveCount(0);
  await selectOwn(window);
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  await expect(window.getByTestId("viewer-selection-cite")).toHaveCount(0);
  await app.close();
});

/** A sheet past the 20,000 rows the viewer reads, so it says it stopped there, above its tabs. */
const PORT_ROWS = `Port,Ships\nNorth,12\nSouth,8\n${Array.from(
  { length: 20_003 },
  (_, row) => `Berth ${row + 1},1`,
).join("\n")}\n`;

/** Whether two laid-out boxes share any point. */
const overlap = (
  one: { x: number; y: number; width: number; height: number },
  other: { x: number; y: number; width: number; height: number },
) =>
  one.x < other.x + other.width &&
  other.x < one.x + one.width &&
  one.y < other.y + other.height &&
  other.y < one.y + one.height;

for (const [language, cells] of [
  ["en", "Select the cells that say this"],
  ["zh-CN", "选中能支持这句话的单元格"],
] as const) {
  test(`in a sheet the line asks for cells above the sheet's tabs, and Enter, Enter cites the cells selected (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor } = await launchNote(language, 1440, "Seabirds", [
      ...FILES,
      { name: "Ports.csv", contents: PORT_ROWS },
    ]);
    const card = await checkSentence(window, editor, OWN);
    await chooseIn(window, card, "Ports");
    const line = window.getByTestId("citation-pick-line");
    await expect(line.getByRole("status")).toHaveText(cells);
    const tabs = window.getByTestId("viewer-sheet-tabs").filter({ visible: true });
    const cut = window.getByTestId("viewer-sheet-truncated").filter({ visible: true });
    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, 900);
      // One group under 1,000 px: the sheet's tab is brought to the front, as a person would.
      await pointAndClick(window, window.getByTestId("document-tab").filter({ hasText: "Ports" }));
      await expect(line).toBeVisible();
      await motionSettled(window);
      const [lineBox, tabsBox, cutBox] = [
        await line.boundingBox(),
        await tabs.boundingBox(),
        await cut.boundingBox(),
      ];
      if (!lineBox || !tabsBox || !cutBox) throw new Error("The sheet's foot isn't laid out.");
      // Above everything along the sheet's foot: its row-limit line, then its tabs.
      for (const under of [cutBox, tabsBox]) {
        expect(overlap(lineBox, under), `${width} px`).toBe(false);
        expect(lineBox.y + lineBox.height, `${width} px`).toBeLessThanOrEqual(under.y);
      }
      await capture(window, `after-sheet-line-${language}-${width}`);
    }
    await pointAndClick(window, window.getByTestId("viewer-grid").locator('td[data-ref="B2"]'));
    await window.keyboard.press("Shift+ArrowDown");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("viewer-selection-cite")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect.poll(() => noteText(editor)).toBe(`${OWN.slice(0, -1)}￼.`);
    await expect(line).toHaveCount(0);
    await app.close();
  });
}

/** Files the Document named `name` in a new Folder that keeps its work inside it, as the Library's menu does. */
const wallOff = (window: Page, name: string) =>
  window.evaluate(async (named) => {
    const core = (
      globalThis as unknown as {
        incarnamind: {
          listDocuments(): Promise<{ id: string; name: string }[]>;
          createLibraryGroup(input: { name: string; description: string }): Promise<{ id: string }>;
          assignDocumentGroup(documentId: string, groupId: string): Promise<unknown>;
          updateLibraryGroup(
            id: string,
            patch: { name: string; description: string; keepInside: boolean },
          ): Promise<unknown>;
        };
      }
    ).incarnamind;
    const document = (await core.listDocuments()).find((each) => each.name === named);
    if (!document) throw new Error(`No Document ${named}.`);
    const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
    await core.assignDocumentGroup(document.id, folder.id);
    await core.updateLibraryGroup(folder.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
  }, name);

test("a Document filed behind a Folder wall the Note is outside is never cited or opened for its sentence", async () => {
  test.setTimeout(240_000);
  const { app, window, editor } = await launchNote("en");
  const card = await checkSentence(window, editor, DIFFERENT);
  // Looked for in every Document: Choose the Citation… is the card's first button.
  const choose = card.getByTestId("claim-choose-citation");
  await pointAndClick(window, choose);
  await pickDocument(window, "Harbour times");
  const line = window.getByTestId("citation-pick-line");
  // The chosen Document goes behind a wall while the sentence waits in it.
  await wallOff(window, "Harbour times");
  await selectOwn(window);
  await pointAndClick(
    window,
    window.getByTestId("viewer-selection-menu").getByTestId("viewer-selection-cite"),
  );
  await expect(window.getByTestId("error-notice-message")).toContainText(
    "This Folder keeps its work inside it.",
  );
  expect(await noteText(editor)).toBe(DIFFERENT);
  await pointAndClick(window, line.getByTestId("citation-pick-cancel"));
  await expect(line).toHaveCount(0);

  // Asked again, Choose the Citation… opens the picker, where that Document can't be chosen.
  await pointAndClick(window, editor.getByText("forecast tides"));
  await window.keyboard.press("ControlOrMeta+Shift+K");
  await pointAndClick(window, choose);
  const picker = window.getByTestId("citation-document-picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator('[role="option"][aria-disabled="true"]')).toContainText(
    "Harbour times",
  );
  await expect(picker.locator('[role="option"]:not([aria-disabled])')).toContainText("Seabirds");
  await app.close();
});

test("the assistant opens a Document it names for the sentence's Citation", async () => {
  test.setTimeout(300_000);
  const { app, window, editor } = await launchNote("en", 1440, "Seabirds");
  await checkSentence(window, editor, ABSENT);
  await window.keyboard.press("Escape");
  await pointAndClick(window, editor.getByText("deep bay"));
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("The source is the Harbour times");
  await window.keyboard.press("Enter");
  const viewer = window.getByTestId("viewer");
  await expect(viewer).toBeVisible();
  await selectOwn(window);
  await expect(window.getByTestId("viewer-selection-cite")).toBeVisible();
  // Esc closes the menu, then ends the wait.
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("viewer-selection-menu")).toHaveCount(0);
  await expect(window.getByTestId("citation-pick-line")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("citation-pick-line")).toHaveCount(0);
  await app.close();
});
