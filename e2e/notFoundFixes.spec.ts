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
const DIFFERENT = "Harbours publish forecasts monthly (6).";
const PORTS = "Harbours publish (6) for 3 ports.";

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
async function launchNote(language: "en" | "zh-CN", width = 1440, scope?: string) {
  for (const file of FILES) await writeFile(join(sources, file.name), file.contents);
  const dataDir = await createDataFolder();
  dataDirs.push(dataDir);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await dismissChatSetup(window);
  await chooseScriptedModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await addDocuments(
    window,
    FILES.map((file) => join(sources, file.name)),
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

/** Types `claim` as the Note's last paragraph and checks it, then opens its card. */
async function checkSentence(window: Page, editor: Locator, claim: string): Promise<Locator> {
  await pointAndClick(window, editor);
  await window.keyboard.press("ControlOrMeta+End");
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
  const mark = window.getByTestId("claim-mark").last();
  await expect(mark).toHaveAttribute("data-check", "unsupported");
  await motionSettled(window);
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card).toBeVisible();
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

/** Selects the Document's sentence `OWN` in the viewer. */
const selectOwn = (window: Page) =>
  dragAcross(window, window.getByTestId("viewer"), "Harbours publish", "12 months.");

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
    await window.keyboard.press("ControlOrMeta+End");
    await window.keyboard.press("Enter");
    const absent = await checkSentence(window, editor, ABSENT);
    await pointAndClick(window, absent.getByTestId("claim-choose-citation"));
    await window.getByTestId("citation-document-search").fill("Harbour");
    await pointAndClick(
      window,
      window.getByTestId("citation-document-picker").getByText("Harbour times", { exact: true }),
    );
    await selectOwn(window);
    await pointAndClick(window, window.getByTestId("viewer-selection-cite"));
    const mark = window.getByTestId("claim-mark").last();
    await expect(mark).toHaveAttribute("data-check", "unsupported");
    await setWindowSize(app, window, 900, 900);
    await motionSettled(window);
    await pointAndClick(window, mark);
    await expect(window.getByTestId("claim-card").getByTestId("claim-cited")).toBeVisible();
    await capture(window, `after-chosen-unsupported-${language}-900`);
    // Selected again, the words offer no Use as Citation: nothing waits for one.
    await selectOwn(window);
    await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
    await expect(window.getByTestId("viewer-selection-cite")).toHaveCount(0);
    await window.keyboard.press("Escape");

    // Cancel stops the wait, and so does Esc.
    await window.keyboard.press("ControlOrMeta+End");
    await window.keyboard.press("Enter");
    const third = await checkSentence(window, editor, ELSEWHERE.replace("Penguins", "Puffins"));
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

  test(`Rewrite with what the Documents say writes the Passage's figure, cited, with one Undo, and keeps what it can't (${language})`, async () => {
    test.setTimeout(300_000);
    const { app, window, editor } = await launchNote(language);
    const card = await checkSentence(window, editor, DIFFERENT);
    await expect(card.getByTestId("claim-differs")).toBeVisible();
    const rewrite = card.getByTestId("claim-rewrite");
    await expect(rewrite).toHaveText(t("claim.rewrite"));
    await capture(window, `after-rewrite-offer-${language}-1440`);
    await film(window, async () => {
      await pointAndClick(window, rewrite);
      await expect.poll(() => noteText(editor)).toBe("Harbours publish forecasts monthly (12￼).");
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
    await window.keyboard.press("ControlOrMeta+End");
    await window.keyboard.press("Enter");
    const ports = await checkSentence(window, editor, PORTS);
    await pointAndClick(window, ports.getByTestId("claim-rewrite"));
    await expect(window.getByTestId("error-notice-message")).toHaveText(t("claim.rewrite.kept"));
    expect(await noteText(editor)).toBe(`${DIFFERENT}\n${PORTS}`);
    await setWindowSize(app, window, 900, 900);
    await capture(window, `after-rewrite-kept-${language}-900`);

    // ⌘K reaches it, for the sentence at the caret.
    await pointAndClick(window, editor.locator(":scope > p").first());
    await runCommand(window, "check.rewrite", t("claim.rewrite"));
    await expect
      .poll(() => noteText(editor))
      .toBe(`Harbours publish forecasts monthly (12￼).\n${PORTS}`);
    await app.close();
  });
}

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

  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.press("Enter");
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
      const { app, window, editor } = await launchNote(language, width);
      const documents = await window.evaluate(() =>
        (
          globalThis as unknown as {
            incarnamind: { listDocuments(): Promise<{ id: string; name: string }[]> };
          }
        ).incarnamind.listDocuments(),
      );
      const harbour = documents.find((each) => each.name === "Harbour times");
      if (!harbour) throw new Error("Harbour times wasn't added.");
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
      await pointAndClick(window, window.getByTestId("claim-mark").first());
      const card = window.getByTestId("claim-card");
      const stop = card.getByTestId("claim-read-stopped");
      // An amount under a cent shows in cents.
      await expect(stop).toContainText(
        t("claim.reason.read-budget", { spent: "$0.01", most: "$0.50" }),
      );
      const words = await linesOf(stop.locator(".meta-part").first());
      const action = await card.getByTestId("claim-read-continue").boundingBox();
      const lastWords = words.at(-1);
      const firstWords = words[0];
      if (!action || !lastWords || !firstWords) throw new Error("The stop line isn't laid out.");
      // Continue starts its own line, under the words, in either language.
      expect(action.y).toBeGreaterThan(lastWords.top);
      expect(Math.abs(action.x - firstWords.left)).toBeLessThan(2);
      await capture(window, `after-stop-line-${language}-${width}`);

      // Continue asks before it reads again: the question's last line is no stub.
      await pointAndClick(window, card.getByTestId("claim-read-continue"));
      const title = card.getByTestId("document-check-ask").locator(".check-card-ask-title");
      await expect(title).toHaveText(t("claim.readAsk.one", { scope: "Harbour times" }));
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
