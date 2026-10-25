import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { type MessageKey, type MessageParams, translate } from "../src/shared/i18n";
import { comparableSentence } from "../src/shared/sentences";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A sentence's check card is a non-modal dialog (#1762): the "Show the check
 * for this sentence" command in ⌘K opens it with the focus on its first
 * action, Tab and Shift+Tab move through the actions in reading order and
 * wrap inside it, and Esc closes it with the caret back in the sentence. The
 * checks are written into the page, so no model is involved.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const WORDS = {
  en: {
    supported: "Spring tides happen at new moon and at full moon.",
    partlyStart: "Staff may work from home",
    partlyEnd: " two days a week.",
    partlyCovered: "home working two days a week",
    partlyUncovered: "staff in general",
    citedStart: "Harbours publish the times of high water",
    citedEnd: " every twelve months.",
    citedWhy: "Your Citation covers the yearly figure, not the planning advice.",
    contradicted: "The agreement says the facilities end in 2027.",
    says: "The agreement says the facilities end on 14 February 2029.",
    notChecked: "The model was not able to check this one.",
    nothing: "Penguins nest on the harbour cliffs.",
  },
  "zh-CN": {
    supported: "春潮发生在新月和满月。",
    partlyStart: "员工每周可以在家办公",
    partlyEnd: "两天。",
    partlyCovered: "每周在家办公两天",
    partlyUncovered: "所有员工",
    citedStart: "港口每 12 个月公布一次高潮时间",
    citedEnd: "，让船员提前计划。",
    citedWhy: "你的引用只支持每年的数据，不支持计划建议。",
    contradicted: "协议规定这些贷款在 2027 年到期。",
    says: "协议规定这些贷款在 2029 年 2 月 14 日到期。",
    notChecked: "模型这次没能核对这一句。",
    nothing: "企鹅在港口悬崖上筑巢。",
  },
} as const;

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

const claimMark = (
  id: string,
  state: string,
  text: string,
  checkedAt: string,
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
    checkedAt,
    ...extra,
  },
});
const marked = (text: string, mark: object) => ({ type: "text", text, marks: [mark] });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });

/** The caret of the Mind, as a position in its document. */
const caretOf = (editor: Locator) =>
  editor.evaluate((dom) => (dom as unknown as { editor: Editor }).editor.state.selection.head);

/** Puts the caret inside the sentence that starts with `wanted`, as the User would have typed it there. */
const cursorIn = (editor: Locator, wanted: string) =>
  editor.evaluate((dom, start) => {
    const note = (dom as unknown as { editor: Editor }).editor;
    let at = -1;
    note.state.doc.descendants((node, pos) => {
      const index = node.isText ? (node.text?.indexOf(start) ?? -1) : -1;
      if (at < 0 && index >= 0) at = pos + index + 1;
    });
    if (at < 0) throw new Error(`No sentence starting “${start}”.`);
    note.chain().focus().setTextSelection(at).run();
  }, wanted);

/** The "Show the check for this sentence" command, typed in ⌘K and run with Enter. */
async function showCheckFromCommand(window: Page, label: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(label);
  const palette = window.getByTestId("palette");
  await expect(palette.locator('[data-key="command:check.showCard"]')).toBeVisible();
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveAttribute(
    "data-key",
    "command:check.showCard",
  );
  await window.keyboard.press("Enter");
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a check card opens from the keyboard, its actions take Tab and wrap, and Esc gives the caret back (${language})`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    const partly = `${words.partlyStart}${words.partlyEnd}`;
    const cited = `${words.citedStart}${words.citedEnd}`;
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const passage = {
      passageId: "passage-1",
      documentId: tides?.id,
      documentName: "Tides",
      contentHash: tides?.contentHash,
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Harbours publish the times of high water every 12 months.",
      check: "found",
      checkReason: null,
    };

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    // Checked after the Document was added, so the card offers no "added since" line.
    const checkedAt = new Date(Date.now() + 60_000).toISOString();
    const check = (id: string, state: string, text: string, extra: Record<string, unknown> = {}) =>
      claimMark(id, state, text, checkedAt, extra);
    const citedMark = check("check-cited", "unsupported", cited, {
      unsupported: { reason: words.citedWhy, covered: null, uncovered: null },
    });
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        paragraph(
          marked(
            words.supported,
            check("check-supported", "supported", words.supported, { evidence: passage }),
          ),
        ),
        paragraph(
          marked(
            partly,
            check("check-partly", "unsupported", partly, {
              unsupported: {
                reason: null,
                covered: words.partlyCovered,
                uncovered: words.partlyUncovered,
                quoted: passage,
              },
            }),
          ),
        ),
        paragraph(
          marked(words.citedStart, citedMark),
          { type: "citation", attrs: passage },
          marked(words.citedEnd, citedMark),
        ),
        paragraph(
          marked(
            words.contradicted,
            check("check-contradicted", "contradicted", words.contradicted, {
              evidence: passage,
              says: words.says,
            }),
          ),
        ),
        paragraph(
          marked(
            words.notChecked,
            check("check-not-checked", "not-checked", words.notChecked, { reason: "refused" }),
          ),
        ),
        paragraph(marked(words.nothing, check("check-nothing", "unsupported", words.nothing))),
      ],
    );
    await expect(window.getByTestId("claim-mark")).toHaveCount(6);
    const card = window.getByTestId("claim-card");

    const states = [
      {
        check: "supported",
        sentence: words.supported,
        starts: words.supported.slice(0, 20),
        first: "claim-add-citation" as const,
        label: "claim.addAsCitation" as MessageKey,
      },
      {
        check: "unsupported",
        sentence: partly,
        starts: words.partlyStart,
        first: "claim-open" as const,
        label: "citation.open.page" as MessageKey,
      },
      {
        check: "unsupported",
        sentence: cited,
        starts: words.citedStart.slice(0, 20),
        first: "claim-cited" as const,
        label: "claim.openCitation" as MessageKey,
        number: 1,
      },
      {
        check: "contradicted",
        sentence: words.contradicted,
        starts: words.contradicted.slice(0, 20),
        first: "claim-open" as const,
        label: "citation.open.page" as MessageKey,
      },
      {
        check: "not-checked",
        sentence: words.notChecked,
        starts: words.notChecked.slice(0, 20),
        first: "claim-check-again" as const,
        label: "claim.checkAgain" as MessageKey,
      },
      {
        check: "unsupported",
        sentence: words.nothing,
        starts: words.nothing.slice(0, 20),
        first: "claim-cut-sentence" as const,
        label: "claim.cutSentence" as MessageKey,
      },
    ] as const;

    for (const [index, state] of states.entries()) {
      await cursorIn(editor, state.starts);
      await focusSettled(window, editor);
      const caret = await caretOf(editor);
      await showCheckFromCommand(window, t("claim.showCard"));
      await expect(card).toHaveAttribute("data-check", state.check);
      await expect(card).toHaveAccessibleName(
        t("claim.card.label", {
          state: t(`claim.state.${state.check}` as MessageKey),
          sentence: comparableSentence(state.sentence),
        }),
      );

      const actions = card.locator("button");
      const count = await actions.count();
      expect(count, "the card has an action").toBeGreaterThan(0);
      const firstName =
        "number" in state ? t(state.label, { number: state.number }) : t(state.label);
      // The first action in reading order takes the focus, and it is read out by name.
      await expect(actions.first()).toBeFocused();
      await expect(actions.first()).toHaveAccessibleName(firstName);
      expect(await actions.first().getAttribute("data-testid")).toBe(state.first);
      await screenshot(window, `card-keyboard-${index}-${language}`);

      // Tab visits every action in reading order, then wraps to the first.
      for (let at = 1; at <= count; at++) {
        await window.keyboard.press("Tab");
        await expect(actions.nth(at % count)).toBeFocused();
      }
      // Shift+Tab from the first action wraps to the last.
      await window.keyboard.press("Shift+Tab");
      await expect(actions.last()).toBeFocused();

      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(editor).toBeFocused();
      expect(await caretOf(editor), "the caret is where it was").toBe(caret);
    }

    // The shortcut opens the card the same way.
    await cursorIn(editor, words.supported.slice(0, 20));
    await focusSettled(window, editor);
    const caret = await caretOf(editor);
    await window.keyboard.press("ControlOrMeta+Shift+KeyK");
    await expect(card).toHaveAttribute("data-check", "supported");
    await expect(card.locator("button").first()).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(editor).toBeFocused();
    expect(await caretOf(editor)).toBe(caret);

    // Tab out of the text reaches the margin mark (past the sentence's Citation chip); Enter on it
    // opens the card with the focus on its first action.
    const mark = window.getByTestId("claim-mark").first();
    await focusSettled(window, editor);
    for (
      let pressed = 0;
      pressed < 5 && !(await mark.evaluate((each) => each === document.activeElement));
      pressed++
    ) {
      await window.keyboard.press("Tab");
    }
    await expect(mark).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(card).toHaveAttribute("data-check", "supported");
    await expect(card.locator("button").first()).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(editor).toBeFocused();
    expect(await caretOf(editor)).toBe(caret);

    // A narrow window keeps the card and its focused action in view.
    await setWindowSize(app, window, 900, 900);
    await cursorIn(editor, words.supported.slice(0, 20));
    await focusSettled(window, editor);
    await showCheckFromCommand(window, t("claim.showCard"));
    await expect(card.locator("button").first()).toBeFocused();
    await screenshot(window, `card-keyboard-narrow-${language}`);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await app.close();
  });
}
