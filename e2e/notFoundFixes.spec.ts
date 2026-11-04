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
  film,
  launchApp,
  motionSettled,
  newMind,
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
const DIFFERENT = "Harbours publish forecasts (6).";
const PORTS = "Harbours publish (6) for (3) ports.";
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

/** Holds the scripted "-slow-check" model's work until `held` is false again, which lets it go. */
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
    const choose = card.getByTestId("claim-choose-citation");
    await expect(choose).toHaveText(t("claim.chooseCitation"));
    await capture(window, `after-choose-offer-${language}-1440`);
    await film(window, async () => {
      await pointAndClick(window, choose);
      const picker = window.getByTestId("citation-document-picker");
      await expect(picker).toBeVisible();
      // One Document, never a Folder.
      await expect(picker.getByTestId("citation-document-section")).toHaveCount(1);
      await window.getByTestId("citation-document-search").fill("Harbour");
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
      await expect(cite).toHaveText(t("claim.useAsCitation"));
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
    await pointAndClick(window, absent.getByTestId("claim-choose-citation"));
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
    await pointAndClick(window, third.getByTestId("claim-choose-citation"));
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
    await pointAndClick(window, card.getByTestId("claim-choose-citation"));
    // No picker: the close Passage's Document opens at the Passage, its words shown.
    const viewer = window.getByTestId("viewer").filter({ visible: true });
    await expect(viewer.getByTestId("viewer-header")).toContainText("Harbour times");
    await expect(viewer.locator("[data-quote-highlight]")).toContainText("12 months");
    await expect(window.getByTestId("citation-document-picker")).toHaveCount(0);
    const line = window.getByTestId("citation-pick-line");
    await expect(line).toContainText(t("claim.chooseCitation.hint"));
    await expect(line).toContainText(DIFFERENT);
    await expect(line.getByTestId("citation-pick-cancel")).toHaveText(
      t("claim.chooseCitation.cancel"),
    );
    // Under the viewer's toolbar, above the page, so it covers none of the words to select.
    const [top, toolbar, page] = [
      await line.boundingBox(),
      await viewer.getByTestId("viewer-header").boundingBox(),
      await viewer.getByTestId("viewer-text").boundingBox(),
    ];
    if (!top || !toolbar || !page) throw new Error("The waiting line isn't laid out.");
    expect(Math.abs(top.y - (toolbar.y + toolbar.height))).toBeLessThan(2);
    expect(page.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
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
    // Note chosen, so Enter reads it.
    await pointAndClick(window, editor.getByText("publish forecasts"));
    await runCommand(window, "check.againstDocument", t("claim.checkAgainstDocument"));
    const documents = window.getByTestId("document-or-folder-picker");
    await expect(documents).toBeVisible();
    await expect(documents.locator('[role="option"][aria-selected="true"]')).toContainText(
      "Seabirds",
    );
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("claim-card")).toContainText("Seabirds");
    await app.close();
  });

  test(`Rewrite with what the Documents say writes the Passage's figure, cited, with one Undo, and keeps what it can't (${language})`, async () => {
    test.setTimeout(300_000);
    const { app, window, editor } = await launchNote(
      language,
      1440,
      undefined,
      FILES,
      "fake-model-slow-check",
    );
    const card = await checkSentence(window, editor, DIFFERENT);
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
      expect(await noteText(editor)).toBe(DIFFERENT);
      await holdModel(app, false);
      await expect.poll(() => noteText(editor)).toBe("Harbours publish forecasts (12￼).");
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
    await expect.poll(() => noteText(editor)).toBe(DIFFERENT);
    await expect(window.getByTestId("claim-mark").last()).toHaveAttribute(
      "data-check",
      "unsupported",
    );

    // A figure the Passage doesn't give stays out: the sentence is kept as written.
    const ports = await checkSentence(window, editor, PORTS);
    await pointAndClick(window, ports.getByTestId("claim-rewrite"));
    await expect(window.getByTestId("error-notice-message")).toContainText(t("claim.rewrite.kept"));
    expect(await noteText(editor)).toBe(`${DIFFERENT}\n${PORTS}`);
    await setWindowSize(app, window, 900, 900);
    await capture(window, `after-rewrite-kept-${language}-900`);

    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  test(`a narrow window keeps the card's new actions inside it (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window, editor } = await launchNote(language, 900);
    const card = await checkSentence(window, editor, DIFFERENT);
    for (const [id, key] of [
      ["claim-choose-citation", "claim.chooseCitation"],
      ["claim-rewrite", "claim.rewrite"],
    ] as const) {
      const action = card.getByTestId(id);
      await expect(action).toHaveText(t(key));
      const [inner, outer] = [await action.boundingBox(), await card.boundingBox()];
      if (!inner || !outer) throw new Error("The card isn't laid out.");
      expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
    }
    await capture(window, `after-rewrite-offer-${language}-900`);
    // ⌘K reaches it, for the sentence at the caret.
    await window.keyboard.press("Escape");
    await pointAndClick(window, editor.getByText("publish forecasts"));
    await runCommand(window, "check.rewrite", t("claim.rewrite"));
    await expect.poll(() => noteText(editor)).toBe("Harbours publish forecasts (12￼).");
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
  await pointAndClick(window, card.getByTestId("claim-choose-citation"));
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
  await pointAndClick(window, editor.getByText("publish forecasts"));
  await window.keyboard.press("ControlOrMeta+Shift+K");
  await pointAndClick(
    window,
    window.getByTestId("claim-card").getByTestId("claim-choose-citation"),
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
      // An amount under a cent says so, never "$0.01" or "$0.00".
      await expect(stop).toContainText(
        language === "en"
          ? "Stopped after under $0.01; this read may spend up to $0.50."
          : "已花不到 $0.01 后停止，这次读取最多可花 $0.50。",
      );
      const words = await linesOf(stop.locator(".meta-part").first());
      const action = await card.getByTestId("claim-read-continue").boundingBox();
      const lastWords = words.at(-1);
      const firstWords = words[0];
      if (!action || !lastWords || !firstWords) throw new Error("The stop line isn't laid out.");
      // Continue starts its own line, under the words, in either language.
      expect(action.y).toBeGreaterThan(lastWords.top);
      expect(Math.abs(action.x - firstWords.left)).toBeLessThan(4);
      await capture(window, `after-stop-line-${language}-${width}`);

      // Continue asks before it reads again: the question's last line is no stub.
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
