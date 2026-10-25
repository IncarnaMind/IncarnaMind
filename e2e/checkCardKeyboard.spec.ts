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
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  tokenColor,
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
    alreadyStart: "The harbour records tide tables each",
    alreadyEnd: " year.",
    alreadyCited: "The harbour records tide tables each year.",
    widenStart: "The harbour publishes tide tables every twelve",
    widenEnd: " months for the crews.",
    widenCited: "The harbour publishes tide tables every twelve months",
    widenSentence: "The harbour publishes tide tables every twelve months for the crews.",
    replaceStart: "The harbour files tide tables every",
    replaceEnd: " season.",
    replaceSentence: "The harbour files tide tables every season.",
    checking: "The harbour is checking this sentence now.",
    listFirst: "First point",
    listSecond: "Second point",
    cellA: "Cell A",
    cellB: "Cell B",
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
    alreadyStart: "港口每年记录潮汐",
    alreadyEnd: "表。",
    alreadyCited: "港口每年记录潮汐表。",
    widenStart: "港口每十二个月为船员",
    widenEnd: "公布一次潮汐表。",
    widenCited: "港口每十二个月",
    widenSentence: "港口每十二个月为船员公布一次潮汐表。",
    replaceStart: "港口每个季度公布潮汐",
    replaceEnd: "表。",
    replaceSentence: "港口每个季度公布潮汐表。",
    checking: "港口正在核对这句话。",
    listFirst: "第一点",
    listSecond: "第二点",
    cellA: "单元格甲",
    cellB: "单元格乙",
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

/** The words of the table cell the caret is in. */
const cellAtCaret = (editor: Locator) =>
  editor.evaluate((dom) => {
    const node = dom.ownerDocument.getSelection()?.anchorNode ?? null;
    const element = node instanceof Element ? node : node?.parentElement;
    return element?.closest("td, th")?.textContent?.trim() ?? "";
  });

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
    const evidenceOf = (passageId: string, quote: string) => ({ ...passage, passageId, quote });
    const citedMark = check("check-cited", "unsupported", cited, {
      unsupported: { reason: words.citedWhy, covered: null, uncovered: null },
    });
    const alreadyMark = check("check-already", "supported", words.alreadyCited, {
      evidence: evidenceOf("passage-already", words.alreadyCited),
    });
    const widenMark = check("check-widen", "supported", words.widenSentence, {
      evidence: evidenceOf("passage-widen", words.widenSentence),
    });
    const replaceMark = check("check-replace", "supported", words.replaceSentence, {
      evidence: evidenceOf("passage-replace", words.replaceSentence),
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
        // A Citation on the Passage the check found, one the check found more of, and one that doesn't hold.
        paragraph(
          marked(words.alreadyStart, alreadyMark),
          {
            type: "citation",
            attrs: {
              ...evidenceOf("passage-already-cite", words.alreadyCited),
              check: "found",
            },
          },
          marked(words.alreadyEnd, alreadyMark),
        ),
        paragraph(
          marked(words.widenStart, widenMark),
          {
            type: "citation",
            attrs: { ...evidenceOf("passage-widen-cite", words.widenCited), check: "found" },
          },
          marked(words.widenEnd, widenMark),
        ),
        paragraph(
          marked(words.replaceStart, replaceMark),
          {
            type: "citation",
            attrs: {
              ...evidenceOf("passage-replace-cite", words.replaceSentence),
              check: "not-found",
            },
          },
          marked(words.replaceEnd, replaceMark),
        ),
        paragraph(marked(words.checking, check("check-checking", "checking", words.checking))),
        {
          type: "bulletList",
          content: [words.listFirst, words.listSecond].map((text) => ({
            type: "listItem",
            content: [paragraph({ type: "text", text })],
          })),
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [words.cellA, words.cellB].map((text) => ({
                type: "tableHeader",
                content: [paragraph({ type: "text", text })],
              })),
            },
          ],
        },
      ],
    );
    await expect(window.getByTestId("claim-mark")).toHaveCount(10);
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
      if (index === 0) {
        const ring = await actions.first().evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            shown: element.matches(":focus-visible"),
            width: style.outlineWidth,
            line: style.outlineStyle,
            color: style.outlineColor,
          };
        });
        expect(ring).toEqual({
          shown: true,
          width: "2px",
          line: "solid",
          color: await tokenColor(window, "--color-accent"),
        });
      }
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

    // A Citation already on the Passage, a wider clause to widen to, and a Citation to replace.
    const variants = [
      {
        sentence: words.alreadyCited,
        starts: words.alreadyStart,
        first: "claim-cited",
        label: "claim.alreadyCited.open" as MessageKey,
      },
      {
        sentence: words.widenSentence,
        starts: words.widenStart,
        first: "claim-widen-citation",
        label: "claim.widenCitation" as MessageKey,
      },
      {
        sentence: words.replaceSentence,
        starts: words.replaceStart,
        first: "claim-replace-citation",
        label: "claim.replaceCitation" as MessageKey,
      },
    ] as const;
    for (const variant of variants) {
      await cursorIn(editor, variant.starts);
      await focusSettled(window, editor);
      const caret = await caretOf(editor);
      await showCheckFromCommand(window, t("claim.showCard"));
      await expect(card).toHaveAttribute("data-check", "supported");
      const actions = card.locator("button");
      const count = await actions.count();
      await expect(actions.first()).toBeFocused();
      expect(await actions.first().getAttribute("data-testid")).toBe(variant.first);
      const name =
        variant.first === "claim-cited"
          ? t(variant.label, {
              number: (await card.getByTestId("claim-already-chip").textContent()) ?? "",
            })
          : t(variant.label);
      await expect(actions.first()).toHaveAccessibleName(name);
      for (let at = 1; at <= count; at++) {
        await window.keyboard.press("Tab");
        await expect(actions.nth(at % count)).toBeFocused();
      }
      await window.keyboard.press("Shift+Tab");
      await expect(actions.last()).toBeFocused();
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(editor).toBeFocused();
      expect(await caretOf(editor)).toBe(caret);
    }

    // The shortcut opens the card the same way.
    await cursorIn(editor, words.supported.slice(0, 20));
    await focusSettled(window, editor);
    const caret = await caretOf(editor);
    await window.keyboard.press("ControlOrMeta+Shift+KeyK");
    await expect(card).toHaveAttribute("data-check", "supported");
    await expect(card.locator("button").first()).toBeFocused();

    // ⌘K, on top of the card: Esc closes the palette, the innermost thing open, not the card behind it.
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("palette")).toHaveCount(0);
    await expect(card).toBeVisible();
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

    // A card still checking has no action: its mark keeps the focus, and Tab moves on past the card.
    await cursorIn(editor, words.checking.slice(0, 20));
    await focusSettled(window, editor);
    const checkingCaret = await caretOf(editor);
    await showCheckFromCommand(window, t("claim.showCard"));
    await expect(card).toHaveAttribute("data-check", "checking");
    const checkingMark = window.locator('[data-testid="claim-mark"][data-claim="check-checking"]');
    await expect(checkingMark).toBeFocused();
    // The verdict arrives while its card is open: the mark keeps the focus, and the card its place.
    await editor.evaluate(
      (dom, evidence) => {
        const note = (dom as unknown as { editor: Editor }).editor;
        const { doc, schema } = note.state;
        const mark = schema.marks.claimCheck;
        if (!mark) throw new Error("No claim checks.");
        let from = -1;
        let to = -1;
        let found = false;
        let attrs: Record<string, unknown> = {};
        doc.descendants((node, pos) => {
          const own = node.isText
            ? node.marks.find((each) => each.type.name === "claimCheck")
            : undefined;
          if (!found && own?.attrs.id === "check-checking") {
            found = true;
            from = pos;
            to = pos + node.nodeSize;
            attrs = own.attrs;
          }
        });
        if (!found) throw new Error("No checking sentence.");
        const next = mark.create({ ...attrs, state: "supported", evidence });
        note.view.dispatch(note.state.tr.removeMark(from, to, mark).addMark(from, to, next));
      },
      evidenceOf("passage-checking", words.checking),
    );
    await expect(card).toHaveAttribute("data-check", "supported");
    await expect(checkingMark).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(card.locator(":focus")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(editor).toBeFocused();
    expect(await caretOf(editor)).toBe(checkingCaret);

    // A card opened under the mouse takes no focus, and Tab in the text keeps its meanings.
    await pointAndClick(
      window,
      window.locator('[data-testid="claim-mark"][data-claim="check-supported"]'),
    );
    await expect(card).toHaveAttribute("data-check", "supported");
    await expect(card.locator(":focus")).toHaveCount(0);
    await expect(editor).toBeFocused();
    await cursorIn(editor, words.listSecond);
    await window.keyboard.press("Tab");
    await expect(editor.locator("ul ul > li")).toHaveText(words.listSecond);
    await expect(card).toBeVisible();
    await cursorIn(editor, words.cellA);
    await window.keyboard.press("Tab");
    await expect.poll(() => cellAtCaret(editor)).toBe(words.cellB);
    await expect(card).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(editor).toBeFocused();

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
