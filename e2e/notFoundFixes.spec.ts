import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { type MessageKey, type MessageParams, translate } from "../src/shared/i18n";
import {
  addDocuments,
  capture,
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  film,
  launchApp,
  motionSettled,
  newMind,
  openCardMenu,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  slideSelect,
  wordsBox,
} from "./app";

/**
 * A sentence the check didn't find (#1554): Choose the Citation… opens a Document beside the
 * Note, where the words selected become its Citation and the check judges it on them; Rewrite
 * with what the Documents say writes a close Passage's figure over the sentence's, cited, with one
 * Undo, and keeps a sentence it can't rewrite from the Passage alone; the assistant runs both
 * through the command list. The scripted model finds a sentence that shares three words with a
 * line, and judges a nearer line different when it has another number.
 */

const OWN = "Harbours publish the times of high water every 12 months.";
const ELSEWHERE = "Penguins nest on the harbour cliffs every spring.";
const ABSENT = "Whales sing in the deep bay.";
const DIFFERENT = "Harbours forecast tides for 6 months.";
const TIDE_TABLES = "北码头潮汐时刻表";

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

/**
 * A sentence of what a line gives another figure for, which a rewrite may write. It shares two
 * longer words with the line, after the figure: enough to be the line's close Passage, too few for
 * the scripted check to call it contradicted; and a duration is no figure checked on its own.
 */
const DRY = "The bay is dry for 2 months of summer.";
const DRY_FILES = [
  ...FILES,
  { name: "Bay.txt", contents: "Bay\n\nThe bay is dry for 3 months of summer.\n" },
];
const DRY_REWRITTEN = "The bay is dry for 3 months of summer￼.";
/** The same, with a rate the line doesn't name after a comma: Rewrite is offered, and the core keeps it. */
const DRY_EVERY_YEAR = "The bay is dry for 2 months of summer, every year.";

/** The app in `language`, the Documents added, and a new Note: its scope `scope` when given. */
async function launchNote(
  language: "en" | "zh-CN",
  width = 1440,
  scope?: string,
  files: readonly { name: string; contents: string }[] = FILES,
  model = "fake-model",
) {
  for (const file of files) await writeFile(join(sources, file.name), file.contents);
  const dataDir = await createDataFolder();
  dataDirs.push(dataDir);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await dismissChatSetup(window);
  await chooseScriptedModel(window, model);
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

/** Holds the scripted model's judgements and rewrites until `held` is false again, which lets them go. */
const holdModel = (app: ElectronApplication, held: boolean) =>
  app.evaluate((_electron, on) => {
    const model = (
      globalThis as unknown as { incarnamindSlowCheck: { hold: boolean; release(): void } }
    ).incarnamindSlowCheck;
    model.hold = on;
    if (!on) model.release();
  }, held);

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

  test(`with a close Passage, Choose the Citation… opens its Document at it, and another Document is one click away (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor } = await launchNote(language);
    const card = await checkSentence(window, editor, DIFFERENT);
    await expect(card.getByTestId("claim-differs")).toBeVisible();
    // Its words before the figure aren't the line's, so no rewrite could keep to the rules.
    await expect(card.getByTestId("claim-rewrite")).toHaveCount(0);
    await pointAndClick(
      window,
      (await openCardMenu(window, card)).getByTestId("claim-choose-citation"),
    );
    // No picker: the close Passage's Document opens at the Passage, its words shown.
    const viewer = window.getByTestId("viewer").filter({ visible: true });
    await expect(viewer.getByTestId("viewer-header")).toContainText("Harbour times");
    await expect(viewer.locator("[data-quote-highlight]")).toContainText("12 months");
    await expect(window.getByTestId("citation-document-picker")).toHaveCount(0);
    const line = window.getByTestId("citation-pick-line");
    // Its first line names the sentence; then what to select, Choose another Document… and Cancel.
    await expect(line.locator(".citation-pick-line-sentence")).toHaveText(
      language === "en" ? `For “${DIFFERENT}”` : `用于“${DIFFERENT}”`,
    );
    await expect(line.getByRole("status")).toHaveText(
      language === "en" ? "Select the words that say this" : "选中能支持这句话的文字",
    );
    await expect(line.getByTestId("citation-pick-cancel")).toHaveText(
      t("claim.chooseCitation.cancel"),
    );
    // At the viewer's foot, over the page, whose last line scrolls clear of it.
    const [box, pane] = [await line.boundingBox(), await viewer.boundingBox()];
    if (!box || !pane) throw new Error("The waiting line isn't laid out.");
    expect(Math.abs(pane.y + pane.height - (box.y + box.height) - 24)).toBeLessThan(4);
    await viewer.locator(".viewer-backdrop").evaluate((scroll) => {
      scroll.scrollTop = scroll.scrollHeight;
    });
    const last = await wordsBox(viewer.getByTestId("viewer-text"), "12 months.");
    expect(last.y).toBeLessThan(box.y);
    await capture(window, `after-choose-waiting-${language}-1440`);

    // Choose another Document… opens the shared picker; the sentence waits in the one chosen.
    await pointAndClick(window, line.getByTestId("citation-pick-other"));
    const picker = window.getByTestId("citation-document-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId("citation-document-section")).toHaveCount(1);
    // Esc closes the picker first, and the sentence still waits.
    await window.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(line).toBeVisible();
    await pointAndClick(window, line.getByTestId("citation-pick-other"));
    await window.getByTestId("citation-document-search").fill("Seabirds");
    await pointAndClick(window, picker.getByText("Seabirds", { exact: true }));
    await expect(viewer.getByTestId("viewer-header")).toContainText("Seabirds");
    await expect(viewer).toContainText("Penguins nest");
    await expect(line).toContainText(DIFFERENT);
    await setWindowSize(app, window, 900, 900);
    await capture(window, `after-choose-another-${language}-900`);
    // Then Esc ends the wait, and the Note is as it was.
    await window.keyboard.press("Escape");
    await expect(line).toHaveCount(0);
    await setWindowSize(app, window, 1440, 900);
    await expect.poll(() => noteText(editor)).toBe(DIFFERENT);

    // ⌘K's one Check against a Document… opens the picker with the Document open beside the
    // Note chosen, so Enter reads it, though a newer Document heads the list.
    await writeFile(join(sources, "Moorings.txt"), "Moorings are let by the season.");
    await window.getByTestId("add-documents-input").setInputFiles([join(sources, "Moorings.txt")]);
    await expectReadyDocuments(window, 3);
    await pointAndClick(window, editor.getByText("forecast tides"));
    await runCommand(window, "check.againstDocument", t("claim.checkAgainstDocument"));
    const documents = window.getByTestId("document-or-folder-picker");
    await expect(documents).toBeVisible();
    const documentRows = documents.locator('[role="option"][data-scope-kind="document"]');
    await expect(documentRows.first()).toContainText("Moorings");
    await expect(documents.locator('[role="option"][aria-selected="true"]')).toContainText(
      "Seabirds",
    );
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("claim-card")).toContainText("Seabirds");
    await expect(
      window.getByTestId("claim-mark").and(window.locator('[data-check="checking"]')),
    ).toHaveCount(0);
    await window.keyboard.press("Escape");

    // So does ⌘K's Choose the Citation…, for a sentence with no close Passage.
    await checkSentence(window, editor, ABSENT);
    await window.keyboard.press("Escape");
    await pointAndClick(window, editor.getByText("deep bay"));
    await runCommand(window, "check.chooseCitation", t("claim.chooseCitation"));
    const citationDocuments = window.getByTestId("citation-document-picker");
    await expect(citationDocuments).toBeVisible();
    await expect(citationDocuments.locator('[role="option"]').first()).toContainText("Moorings");
    await expect(citationDocuments.locator('[role="option"][aria-selected="true"]')).toContainText(
      "Seabirds",
    );
    await app.close();
  });

  test(`Rewrite with what the Documents say writes the Passage's figure, cited, with one Undo, and keeps what it can't (${language})`, async () => {
    test.setTimeout(300_000);
    const { app, window, editor } = await launchNote(
      language,
      1440,
      undefined,
      DRY_FILES,
      "fake-model-slow-check",
    );
    const card = await checkSentence(window, editor, DRY);
    await expect(card.getByTestId("claim-differs")).toBeVisible();
    const rewrite = card.getByTestId("claim-rewrite");
    await expect(rewrite).toHaveText(t("claim.rewrite"));
    await capture(window, `after-rewrite-offer-${language}-1440`);
    await film(window, async () => {
      await holdModel(app, true);
      await pointAndClick(window, rewrite);
      // While its model works, the sentence's mark shows the dot a running check shows.
      await expect(window.getByTestId("claim-mark").last()).toHaveAttribute(
        "data-check",
        "checking",
      );
      expect(await noteText(editor)).toBe(DRY);
      await holdModel(app, false);
      await expect.poll(() => noteText(editor)).toBe(DRY_REWRITTEN);
      // Checked again on its Citation: the scripted model judges no cited sentence it doesn't
      // list, so the verdict a real model gives is in the live test.
      await expect(window.getByTestId("claim-mark").last()).toHaveAttribute(
        "data-check",
        /^(supported|unsupported)$/,
      );
      await pointAndClick(window, window.getByTestId("claim-mark").last());
      await expect(window.getByTestId("claim-card").getByTestId("claim-cited")).toBeVisible();
      await window.keyboard.press("Escape");
    });
    await expect(window.getByTestId("undo-message")).toHaveText(t("claim.rewrite.done"));
    await capture(window, `after-rewrite-supported-${language}-1440`);
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect.poll(() => noteText(editor)).toBe(DRY);
    await expect(window.getByTestId("claim-mark").last()).toHaveAttribute(
      "data-check",
      "unsupported",
    );

    // A rate the Passage doesn't name stays out: the sentence is kept as written.
    const kept = await checkSentence(window, editor, DRY_EVERY_YEAR);
    await pointAndClick(window, kept.getByTestId("claim-rewrite"));
    await expect(window.getByTestId("error-notice-message")).toContainText(t("claim.rewrite.kept"));
    expect(await noteText(editor)).toBe(`${DRY}\n${DRY_EVERY_YEAR}`);
    await setWindowSize(app, window, 900, 900);
    await capture(window, `after-rewrite-kept-${language}-900`);

    await app.close();
  });
}

const SEABIRDS = "Seabirds nest on the bay cliffs every spring.";

test("a check, the Note's Check or an edit asked for while a rewrite works waits for it, and the rewrite lands", async () => {
  test.setTimeout(300_000);
  const t = (key: MessageKey) => translate("en", key);
  const { app, window, editor } = await launchNote(
    "en",
    1440,
    undefined,
    DRY_FILES,
    "fake-model-slow-check",
  );
  const card = await checkSentence(window, editor, DRY);
  await holdModel(app, true);
  await pointAndClick(window, card.getByTestId("claim-rewrite"));
  await expect(window.getByTestId("claim-mark").last()).toHaveAttribute("data-check", "checking");
  const marks = await window.getByTestId("claim-mark").count();
  // Another sentence, written and selected while the model works.
  await pointAndClick(window, editor.locator(":scope > p").last());
  await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await window.keyboard.press("Enter");
  await window.keyboard.type(SEABIRDS);
  const other = editor.locator(":scope > p").last();
  const busy = window.getByTestId("edit-problem");
  const select = () =>
    slideSelect(window, other, "Seabirds nest", { line: other, words: "every spring." });
  const close = async () => {
    await pointAndClick(window, window.getByTestId("edit-problem-close"));
    await expect(busy).toHaveCount(0);
  };
  await select();
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  await expect(busy).toContainText(t("edit.problem.busy"));
  await close();
  await runCommand(window, "mind.check", t("mindCheck.command"));
  await expect(busy).toContainText(t("edit.problem.busy"));
  await close();
  await select();
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-shorten"),
  );
  await expect(busy).toContainText(t("edit.problem.busy"));
  await close();
  // Nothing else started: no sentence was checked, and the rewrite writes its reply.
  await expect(window.getByTestId("claim-mark")).toHaveCount(marks);
  await holdModel(app, false);
  await expect.poll(() => noteText(editor)).toBe(`${DRY_REWRITTEN}\n${SEABIRDS}`);
  await expect(window.getByTestId("undo-message")).toHaveText(t("claim.rewrite.done"));
  await expect(window.getByTestId("error-notice-message")).toHaveCount(0);
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  test(`a narrow window keeps the card's new actions inside it (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window, editor } = await launchNote(language, 900, undefined, DRY_FILES);
    const card = await checkSentence(window, editor, DRY);
    // The rewrite is the card's first button; Choose the Citation… waits under its ⋯ (#2869).
    const rewrite = card.getByTestId("claim-rewrite");
    await expect(rewrite).toHaveText(t("claim.rewrite"));
    await expect(card.locator(".citation-card-actions button").first()).toHaveAttribute(
      "data-testid",
      "claim-rewrite",
    );
    const [inner, outer] = [await rewrite.boundingBox(), await card.boundingBox()];
    if (!inner || !outer) throw new Error("The card isn't laid out.");
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
    const menu = await openCardMenu(window, card);
    const choose = menu.getByTestId("claim-choose-citation");
    await expect(choose).toHaveText(t("claim.chooseCitation"));
    const item = await choose.boundingBox();
    if (!item) throw new Error("The menu isn't laid out.");
    expect(item.x + item.width).toBeLessThanOrEqual(
      await window.evaluate(() => globalThis.innerWidth),
    );
    await capture(window, `after-rewrite-offer-${language}-900`);
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    // ⌘K reaches it, for the sentence at the caret.
    await window.keyboard.press("Escape");
    await pointAndClick(window, editor.getByText("dry for"));
    await runCommand(window, "check.rewrite", t("claim.rewrite"));
    await expect.poll(() => noteText(editor)).toBe(DRY_REWRITTEN);
    await app.close();
  });
}

const EACH_YEAR = "Harbours publish the times of high water every 12 months, each year.";

/**
 * Two sentences whose checks found the line `OWN` and called them unsupported, as a real model may
 * where the scripted one never does: one that gives the line's figure of what the line gives it
 * for, and one with the same figure and a rate the line doesn't name, which the card offers a
 * rewrite for. The scripted rewrite finds nothing to change in either.
 */
async function writeChecksOnTheLine(window: Page, editor: Locator): Promise<void> {
  const evidence = await window.evaluate(async (quote) => {
    const core = (
      globalThis as unknown as {
        incarnamind: {
          listDocuments(): Promise<{ id: string; name: string }[]>;
          citeSelection(input: {
            documentId: string;
            parts: { unit: null; text: string }[];
          }): Promise<Record<string, unknown>>;
        };
      }
    ).incarnamind;
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour times");
    if (!document) throw new Error("The harbour times weren't added.");
    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: null, text: quote }],
    });
    return { ...cited, documentId: document.id, documentName: document.name };
  }, OWN);
  const paragraph = (id: string, text: string) => ({
    type: "paragraph",
    content: [
      {
        type: "text",
        text,
        marks: [
          claimMark(id, "unsupported", text, {
            evidence,
            reason: null,
            detail: null,
            says: null,
            unsupported: null,
            calculation: null,
            citedCaseUnchecked: false,
            citedCaseFound: false,
          }),
        ],
      },
    ],
  });
  await editor.evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
    },
    [paragraph("check-same", OWN), paragraph("check-each-year", EACH_YEAR)],
  );
  await motionSettled(window);
}

/**
 * Opens the card of the sentence with `words` from the keyboard, once the caret is in it: the
 * editor takes the click's caret a moment after the page shows it.
 */
async function openCardAt(window: Page, editor: Locator, words: string): Promise<void> {
  await pointAndClick(window, editor.getByText(words));
  await expect
    .poll(() =>
      editor.evaluate(
        (dom, held) =>
          (
            dom as unknown as { editor: Editor }
          ).editor.state.selection.$head.parent.textContent.includes(held),
        words,
      ),
    )
    .toBe(true);
  await window.keyboard.press("ControlOrMeta+Shift+K");
}

for (const [language, same, none] of [
  [
    "en",
    "Nothing to change: the Documents give the same value.",
    "Couldn’t rewrite this sentence from the Documents, so it stays as you wrote it.",
  ],
  ["zh-CN", "无需改动：文档中的数值与这句话相同。", "无法按文档改写这句话，已保留原句。"],
] as const) {
  test(`Rewrite says the Documents give the same value only when they do, as no failure, and Choose the Citation… stays (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor } = await launchNote(language);
    await writeChecksOnTheLine(window, editor);
    const card = window.getByTestId("claim-card");
    for (const [words, said] of [
      ["12 months.", same],
      ["each year", none],
    ] as const) {
      await openCardAt(window, editor, words);
      await expect(card.getByTestId("claim-sentence")).toContainText(words);
      await pointAndClick(window, card.getByTestId("claim-rewrite"));
      await expect(window.getByTestId("copied-line")).toHaveText(said);
      await capture(window, `after-rewrite-${said === same ? "same" : "none"}-${language}-1440`);
      await expect(window.getByTestId("error-notice-message")).toHaveCount(0);
      expect(await noteText(editor)).toBe(`${OWN}\n${EACH_YEAR}`);
      await openCardAt(window, editor, words);
      const menu = await openCardMenu(window, card);
      await expect(menu.getByTestId("claim-choose-citation")).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await window.keyboard.press("Escape");
    }
    await app.close();
  });
}

/** Chooses `name` in the card's picker of Documents for the sentence's Citation. */
async function chooseIn(window: Page, card: Locator, name: string): Promise<void> {
  await pointAndClick(
    window,
    (await openCardMenu(window, card)).getByTestId("claim-choose-citation"),
  );
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
  await pointAndClick(
    window,
    (await openCardMenu(window, card)).getByTestId("claim-choose-citation"),
  );
  const line = window.getByTestId("citation-pick-line");
  await expect(line).toBeVisible();
  // The close Passage's Document goes behind a wall while the sentence waits in it.
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
  await pointAndClick(
    window,
    (await openCardMenu(window, window.getByTestId("claim-card"))).getByTestId(
      "claim-choose-citation",
    ),
  );
  const picker = window.getByTestId("citation-document-picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator('[role="option"][aria-disabled="true"]')).toContainText(
    "Harbour times",
  );
  await expect(picker.locator('[role="option"]:not([aria-disabled])')).toContainText("Seabirds");
  await app.close();
});

test("the assistant checks the sentence against a Document it names, and opens one for its Citation", async () => {
  test.setTimeout(300_000);
  const { app, window, editor } = await launchNote("en", 1440, "Seabirds");
  await checkSentence(window, editor, OWN);
  await window.keyboard.press("Escape");
  await pointAndClick(window, editor.getByText("high water"));
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Check this sentence against the Harbour times");
  await window.keyboard.press("Enter");
  const ask = window.getByTestId("document-check-ask");
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("“Harbour times”");
  await pointAndClick(window, ask.getByTestId("document-check-read"));
  await expect(window.getByTestId("claim-mark").last()).toHaveAttribute("data-check", "supported");

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

/** The left edge and top of each line box the element's text is laid out in. */
const linesOf = (target: Locator) =>
  target.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const lines = new Map<number, { left: number; right: number }>();
    for (const rect of range.getClientRects()) {
      if (rect.width === 0) continue;
      const top = Math.round(rect.top);
      const line = lines.get(top);
      lines.set(top, {
        left: Math.min(line?.left ?? rect.left, rect.left),
        right: Math.max(line?.right ?? rect.right, rect.right),
      });
    }
    return [...lines.entries()].sort(([a], [b]) => a - b).map(([top, box]) => ({ top, ...box }));
  });

const claimMark = (
  id: string,
  state: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "claimCheck",
  attrs: {
    id,
    request: "check-1",
    action: "check-against-documents",
    state,
    text,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  },
});

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  for (const width of [900, 1440]) {
    test(`a whole read's stop line and its question hold their places (${language}, ${width} px)`, async () => {
      test.setTimeout(240_000);
      // A name as long as one that left "句子？" alone on the question's last line.
      const { app, window, editor } = await launchNote(language, width, undefined, [
        { name: `${TIDE_TABLES}.txt`, contents: `${OWN}\n` },
      ]);
      const documents = await window.evaluate(() =>
        (
          globalThis as unknown as {
            incarnamind: { listDocuments(): Promise<{ id: string; name: string }[]> };
          }
        ).incarnamind.listDocuments(),
      );
      const harbour = documents.find((each) => each.name === TIDE_TABLES);
      if (!harbour) throw new Error("The tide tables weren't added.");
      const detail = JSON.stringify({
        most: { amount: 0.5, currency: "USD" },
        spent: { amount: 0.0048, currency: "USD" },
      });
      const stopped = claimMark("check-stopped", "not-checked", ABSENT, {
        action: "check-against-document",
        reason: "read-budget",
        detail,
        scope: {
          folderId: null,
          widened: false,
          chosen: { folderIds: [], tagIds: [], documentIds: [harbour.id] },
        },
        parts: [
          {
            span: { start: 0, end: ABSENT.length },
            kind: "fact",
            verdict: "not-checked",
            evidence: [],
            decidingEvidence: null,
            says: null,
            unsupported: null,
            calculation: null,
            reason: "read-budget",
            detail,
            versions: [],
            excluded: [],
            citedCaseUnchecked: false,
            citedCaseFound: false,
          },
        ],
      });
      await editor.evaluate(
        (dom, content) => {
          (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
        },
        [{ type: "paragraph", content: [{ type: "text", text: ABSENT, marks: [stopped] }] }],
      );
      await motionSettled(window);
      // A sentence not checked has no mark on the page: its card opens from the keyboard.
      await pointAndClick(window, editor.getByText("deep bay"));
      await window.keyboard.press("ControlOrMeta+Shift+K");
      const card = window.getByTestId("claim-card");
      const stop = card.getByTestId("claim-read-stopped");
      // It says what it spent, under a cent as such; the most it may spend is on Read the rest.
      await expect(stop).toContainText(
        language === "en" ? "Stopped · Under $0.01 spent" : "已停止 · 已花费不到 $0.01",
      );
      await expect(card.getByTestId("claim-read-continue")).toHaveText(
        language === "en" ? "Read the rest · up to $0.50" : "读取其余部分 · 最多 $0.50",
      );
      const words = await linesOf(stop.locator(".meta-part").first());
      const action = await card.getByTestId("claim-read-continue").boundingBox();
      const lastWords = words.at(-1);
      const firstWords = words[0];
      if (!action || !lastWords || !firstWords) throw new Error("The stop line isn't laid out.");
      // Read the rest starts its own line, under the words, in either language.
      expect(action.y).toBeGreaterThan(lastWords.top);
      expect(Math.abs(action.x - firstWords.left)).toBeLessThan(4);
      await capture(window, `after-stop-line-${language}-${width}`);

      // Read the rest asks before it reads again: the question's last line is no stub.
      await pointAndClick(window, card.getByTestId("claim-read-continue"));
      const title = card.getByTestId("document-check-ask").locator(".check-card-ask-title");
      await expect(title).toHaveText(t("claim.readAsk.one", { scope: TIDE_TABLES }));
      const lines = await linesOf(title);
      const [first] = lines;
      const last = lines.at(-1);
      // "句子？" alone on the last line was a fifth of the line above it.
      if (first && last && lines.length > 1) {
        expect(last.right - last.left).toBeGreaterThan((first.right - first.left) / 2);
      }
      await capture(window, `after-ask-${language}-${width}`);
      await app.close();
    });
  }
}
