import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment, yUndoPluginKey } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";
import { markedSentences } from "../../src/core/answers/checks/sentences";
import {
  CITATION_NODE,
  type Citation,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  FOOTNOTE_NODE,
  GENERATED_MARK,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import {
  applyCorrection,
  correctableClaims,
  correctContradictions,
  correctionFor,
} from "../../src/renderer/src/correctionFixes";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import {
  ClaimChecks,
  paragraphPlaces,
  setClaimContext,
  shownClaims,
} from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { useNotices } from "../../src/renderer/src/notices";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { checkWithParts } from "../../src/shared/claimParts";
import { readFigures } from "../../src/shared/figures";
import { INLINE_NODE } from "../../src/shared/sentences";

const { recordAiUse } = vi.hoisted(() => ({ recordAiUse: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../src/renderer/src/core", () => ({ core: { recordAiUse } }));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  useEdits: { getState: () => ({ pending: {} }) },
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/i18n", () => ({
  languageNow: () => "en",
  translateNow: (key: string) => key,
}));

const dom = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
Object.assign(globalThis, {
  window: dom.defaultView,
  document: dom,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

const evidence = (documentId = "report", quote = "The rate is 38.6%."): Citation => ({
  passageId: `passage-${documentId}`,
  documentId,
  documentName: documentId,
  contentHash: `hash-${documentId}`,
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

type Choices = { wording: string; evidence: CitationAttributes }[];

const basis = (id: string, text: string): ClaimCheckAttributes => ({
  id,
  request: `request-${id}`,
  action: "check-against-documents",
  state: "checking",
  reason: null,
  detail: null,
  providerId: "anthropic",
  modelId: "claude-haiku-5-5",
  text,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-01-01T00:00:00.000Z",
});

const part = (
  start: number,
  end: number,
  verdict: "supported" | "contradicted" | "unsupported",
  extra: Partial<ClaimCheckPart> = {},
): ClaimCheckPart => ({
  span: { start, end },
  kind: "fact",
  verdict,
  evidence: verdict === "unsupported" ? [] : [evidence()],
  decidingEvidence: verdict === "unsupported" ? null : 0,
  says: verdict === "contradicted" ? "The Document says 38.6%, not 36.8%." : null,
  unsupported: verdict === "unsupported" ? { reason: null, covered: null, uncovered: null } : null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
  ...extra,
});

const contradictedPart = (
  start: number,
  end: number,
  from = "36.8%",
  choices: Choices = [{ wording: "38.6%", evidence: evidence() }],
) =>
  part(start, end, "contradicted", {
    evidence: choices.map((choice) => choice.evidence),
    correction: { from, choices },
  });

/** A check of one part, as a check of the Note writes it. */
const check = (
  id: string,
  text: string,
  from = "36.8%",
  choices: Choices = [{ wording: "38.6%", evidence: evidence() }],
): ClaimCheckAttributes =>
  checkWithParts(basis(id, text), [contradictedPart(0, text.length, from, choices)]);

const marked = (text: string, attrs: ClaimCheckAttributes): JSONContent => ({
  type: "text",
  text,
  marks: [{ type: CLAIM_CHECK_MARK, attrs }],
});

const citation = (attrs: CitationAttributes): JSONContent => ({
  type: CITATION_NODE,
  attrs,
});

function editorWith(blocks: JSONContent[]): { editor: Editor; doc: Y.Doc } {
  const seed = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content: blocks },
  });
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(seed.state.doc, doc.getXmlFragment(MIND_CONTENT_FIELD));
  seed.destroy();
  const editor = new Editor({
    element: document.createElement("div"),
    content: { type: "doc", content: blocks },
    extensions: [
      ...noteExtensions(),
      ClaimChecks,
      CitationNumbers,
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => {
    editor.destroy();
    doc.destroy();
  });
  return { editor, doc };
}

const claim = (editor: Editor, id: string) => {
  const found = shownClaims(editor.state).find((each) => each.check.id === id);
  if (!found) throw new Error(`No shown claim ${id}.`);
  return found;
};

const textOf = (editor: Editor) => {
  const blocks: string[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    blocks.push(paragraphPlaces(node, pos).text);
    return false;
  });
  return blocks.join("\n");
};

const citationsOf = (editor: Editor) => {
  const found: CitationAttributes[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs as CitationAttributes);
    return true;
  });
  return found;
};

const generatedText = (editor: Editor) => {
  const found: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === GENERATED_MARK)) {
      found.push(node.text ?? "");
    }
    return true;
  });
  return found;
};

beforeEach(() => {
  recordAiUse.mockClear();
  useNotices.setState({ errors: [], confirmation: null });
});

const undoManager = (editor: Editor) => yUndoPluginKey.getState(editor.state)?.undoManager;

describe("Correct a contradiction from the Documents", () => {
  test("replaces only the old words, cites them before the stop, and keeps the sentence Supported", () => {
    const attrs = check("one", "The rate is 36.8%.");
    const { editor } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "block-one" },
        content: [marked("The rate is 36.8%.", attrs)],
      },
    ]);
    expect(claim(editor, "one").shown.state).toBe("contradicted");

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`The rate is 38.6%${INLINE_NODE}.`);
    expect(generatedText(editor)).toEqual(["38.6%"]);
    expect(citationsOf(editor)).toEqual([expect.objectContaining({ documentId: "report" })]);
    const corrected = claim(editor, "one");
    expect(corrected.shown.state).toBe("supported");
    expect(corrected.check).toMatchObject({
      state: "supported",
      text: "The rate is 38.6%.",
      evidence: { documentId: "report" },
      parts: [{ span: { start: 0, end: 18 }, verdict: "supported" }],
    });
    expect(corrected.check.correction).toBeUndefined();
    expect(recordAiUse).toHaveBeenCalledWith([
      expect.objectContaining({
        mindId: "mind",
        kind: "edit-with-ai-accepted",
        characters: 5,
        blockIds: ["block-one"],
      }),
    ]);

    undoManager(editor)?.undo();

    expect(textOf(editor)).toBe("The rate is 36.8%.");
    expect(claim(editor, "one").shown.state).toBe("contradicted");
    expect(claim(editor, "one").check.correction).toEqual(attrs.correction);
  });

  test("settles the owning figure and gives every figure its id in the corrected sentence", () => {
    const text = "The rate is 36.8%.";
    const reading = readFigures("36.8%", { language: "en" })[0];
    if (!reading) throw new Error("The fixture has no figure.");
    const source = evidence();
    const contradicted = contradictedPart(0, text.length);
    const attrs = checkWithParts(basis("one", text), [
      {
        ...contradicted,
        figures: [
          {
            id: JSON.stringify(["text", "block-one", "old", 12, 17, "36.8%"]),
            locator: {
              kind: "text",
              from: { blockId: "block-one", offset: 12 },
              to: { blockId: "block-one", offset: 17 },
            },
            reading: { ...reading, start: 12, end: 17 },
            calculated: null,
            context: text,
            sourceInput: null,
            roundedFrom: null,
            difference: 0.018,
            footing: [],
            result: {
              verdict: "contradicted",
              evidence: source,
              correction: contradicted.correction,
              says: "The Document says 38.6%.",
              unsupported: null,
              calculation: null,
              citedCaseUnchecked: false,
              citedCaseFound: false,
              versions: [],
              excluded: [],
            },
          },
        ],
        remainder: null,
      },
    ]);
    const { editor, doc } = editorWith([
      { type: "paragraph", attrs: { id: "block-one" }, content: [marked(text, attrs)] },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    const corrected = claim(editor, "one");
    expect(corrected.shown.state).toBe("supported");
    const occurrences = figuresInMind(doc.getXmlFragment(MIND_CONTENT_FIELD));
    expect(occurrences.map((occurrence) => occurrence.reading.chars)).toEqual(["38.6%"]);
    expect(corrected.check.figures?.map((figure) => figure.id)).toEqual(
      occurrences.map((occurrence) => occurrence.id),
    );
    expect(corrected.check.figures?.[0]).toMatchObject({
      state: "supported",
      reading: { chars: "38.6%" },
      evidence: { documentId: "report" },
    });
    const figureContexts = new Map(
      occurrences.map((occurrence) => [occurrence.id, occurrence.context]),
    );
    setClaimContext(editor.view, {
      versions: null,
      folderId: null,
      scope: null,
      figureContexts,
      figurePlaces: null,
    });
    expect(claim(editor, "one").shown.state).toBe("supported");

    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc));
    const [stored] = markedSentences(reopened.getXmlFragment(MIND_CONTENT_FIELD));
    if (!stored) throw new Error("The reopened Note has no checked sentence.");
    expect(
      claimCheckShown(stored.check, {
        text: corrected.sentence.text,
        versions: null,
        folderId: null,
        scope: null,
        figureContexts,
      }),
    ).toEqual({ state: "supported" });
    reopened.destroy();
  });

  test("changes the words in the contradicted part, not the same words in another part", () => {
    const text = "Sales rose 36.8%, and the rate is 36.8%.";
    const choices = [{ wording: "40.25%", evidence: evidence("report", "The rate is 40.25%.") }];
    const attrs = checkWithParts(basis("one", text), [
      part(0, 16, "supported"),
      contradictedPart(22, 39, "36.8%", choices),
    ]);
    const { editor } = editorWith([{ type: "paragraph", content: [marked(text, attrs)] }]);
    expect(claim(editor, "one").check.correction?.choices[0]?.wording).toBe("40.25%");

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`Sales rose 36.8%, and the rate is 40.25%${INLINE_NODE}.`);
    expect(claim(editor, "one").check).toMatchObject({
      state: "supported",
      text: "Sales rose 36.8%, and the rate is 40.25%.",
      parts: [
        { span: { start: 0, end: 16 }, verdict: "supported" },
        { span: { start: 22, end: 40 }, verdict: "supported" },
      ],
    });
  });

  test("moves the parts after the old words by the new wording's length", () => {
    const text = "The rate is 36.8%, and the board approved the plan.";
    const choices = [{ wording: "40.25%", evidence: evidence("report", "The rate is 40.25%.") }];
    const attrs = checkWithParts(basis("one", text), [
      contradictedPart(0, 17, "36.8%", choices),
      part(23, 50, "supported", { evidence: [evidence("minutes", "The board approved it.")] }),
    ]);
    const { editor } = editorWith([{ type: "paragraph", content: [marked(text, attrs)] }]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    const corrected = claim(editor, "one");
    expect(corrected.shown.state).toBe("supported");
    expect(corrected.check.parts?.map((each) => each.span)).toEqual([
      { start: 0, end: 18 },
      { start: 24, end: 51 },
    ]);
    expect(corrected.check.text.slice(24, 51)).toBe("the board approved the plan");
  });

  test("puts a new Citation at the sentence's end, not between the corrected value and its context", () => {
    const attrs = check("one", "The rate is 36.8% in Q3.");
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The rate is 36.8% in Q3.", attrs)] },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`The rate is 38.6% in Q3${INLINE_NODE}.`);
    expect(claim(editor, "one").check.text).toBe("The rate is 38.6% in Q3.");
  });

  test("keeps an existing Citation of the same Passage instead of adding a second", () => {
    const source = evidence();
    const attrs = check("one", "The rate is 36.8%.");
    const { editor } = editorWith([
      {
        type: "paragraph",
        content: [marked("The rate is 36.8%", attrs), citation(source), marked(".", attrs)],
      },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(citationsOf(editor)).toEqual([expect.objectContaining(source)]);
    expect(textOf(editor)).toBe(`The rate is 38.6%${INLINE_NODE}.`);
    expect(claim(editor, "one").shown.state).toBe("supported");
  });

  test("finds the old words past an inline footnote without moving or deleting it", () => {
    const text = `See ${INLINE_NODE} the rate is 36.8%.`;
    const attrs = check("one", text);
    const { editor } = editorWith([
      {
        type: "paragraph",
        content: [
          marked("See ", attrs),
          {
            type: FOOTNOTE_NODE,
            attrs: { id: "note" },
            content: [{ type: "text", text: "A footnote" }],
          },
          marked(" the rate is 36.8%.", attrs),
        ],
      },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`See ${INLINE_NODE} the rate is 38.6%${INLINE_NODE}.`);
    expect(editor.state.doc.firstChild?.child(1).type.name).toBe(FOOTNOTE_NODE);
    expect(claim(editor, "one").shown.state).toBe("supported");
  });

  test("uses the first, newest Document's choice when two Documents disagree", () => {
    const attrs = check("one", "The rate is 36.8%.", "36.8%", [
      { wording: "38.6%", evidence: evidence("newer") },
      { wording: "39.4%", evidence: evidence("older", "The rate is 39.4%.") },
    ]);
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The rate is 36.8%.", attrs)] },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`The rate is 38.6%${INLINE_NODE}.`);
    expect(citationsOf(editor).map((each) => each.documentId)).toEqual(["newer"]);
    expect(claim(editor, "one").check.evidence?.documentId).toBe("newer");
  });

  test("adds no space between Chinese wording and its Citation", () => {
    const attrs = check("one", "比率是 36.8%。", "36.8%", [
      { wording: "百分之三十八点六", evidence: evidence("报告", "比率是百分之三十八点六。") },
    ]);
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("比率是 36.8%。", attrs)] },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`比率是 百分之三十八点六${INLINE_NODE}。`);
    expect(claim(editor, "one").shown.state).toBe("supported");
  });

  test("corrects a check of the whole sentence, as the background watch writes it", () => {
    const whole: ClaimCheckAttributes = {
      ...basis("one", "The rate is 36.8%."),
      state: "contradicted",
      evidence: evidence(),
      correction: { from: "36.8%", choices: [{ wording: "38.6%", evidence: evidence() }] },
      says: "The Document says 38.6%, not 36.8%.",
    };
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The rate is 36.8%.", whole)] },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`The rate is 38.6%${INLINE_NODE}.`);
    expect(claim(editor, "one").check).toMatchObject({
      state: "supported",
      text: "The rate is 38.6%.",
      evidence: { documentId: "report" },
    });
    expect(claim(editor, "one").check.correction).toBeUndefined();
  });

  test("a sentence whose words no longer match gets a problem and no edit", () => {
    const attrs = check("one", "The rate is 36.8%.");
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The rate was 36.8%.", attrs)] },
    ]);
    const current = claim(editor, "one");
    expect(current.shown.state).toBe("needs-recheck");
    expect(correctionFor(editor, current)).toBeNull();

    expect(applyCorrection(editor, "mind", current)).toBe(false);

    expect(textOf(editor)).toBe("The rate was 36.8%.");
    expect(useNotices.getState().errors.at(-1)?.message).toBe("error.check.partChanged");
    expect(recordAiUse).not.toHaveBeenCalled();
  });

  test("old words repeated in their part are not guessed at", () => {
    const attrs = check("one", "36.8% was above 36.8%.");
    const valid = check("valid", "The rate is 36.8%.");
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("36.8% was above 36.8%.", attrs)] },
      { type: "paragraph", content: [marked("The rate is 36.8%.", valid)] },
    ]);

    expect(correctionFor(editor, claim(editor, "one"))).toBeNull();
    expect(correctableClaims(editor).map((each) => each.check.id)).toEqual(["valid"]);
  });

  test("bulk correction changes two sentences in one Undo and restores both checks", () => {
    const first = check("first", "The first rate is 36.8%.");
    const second = check("second", "The second rate is 36.8%.");
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The first rate is 36.8%.", first)] },
      { type: "paragraph", content: [marked("The second rate is 36.8%.", second)] },
    ]);
    const before = textOf(editor);
    let updates = 0;
    editor.on("update", () => updates++);

    expect(correctContradictions(editor, "mind")).toBe(2);
    expect(updates).toBe(1);
    expect(textOf(editor)).toBe(
      `The first rate is 38.6%${INLINE_NODE}.\nThe second rate is 38.6%${INLINE_NODE}.`,
    );
    expect(claim(editor, "first").shown.state).toBe("supported");
    expect(claim(editor, "second").shown.state).toBe("supported");

    expect(undoManager(editor)?.undoStack).toHaveLength(1);
    undoManager(editor)?.undo();

    expect(textOf(editor)).toBe(before);
    expect(claim(editor, "first")).toMatchObject({
      shown: { state: "contradicted" },
      check: { state: "contradicted", correction: first.correction },
    });
    expect(claim(editor, "second")).toMatchObject({
      shown: { state: "contradicted" },
      check: { state: "contradicted", correction: second.correction },
    });
    expect(generatedText(editor)).toEqual([]);
    expect(citationsOf(editor)).toEqual([]);
  });

  test("the badge counts only sentences a correction makes Supported", () => {
    const valid = check("valid", "The rate is 36.8%.");
    const legacy = checkWithParts(basis("legacy", "The old rate is 36.8%."), [
      part(0, 22, "contradicted"),
    ]);
    const unsupported = checkWithParts(basis("unsupported", "An unsupported sentence."), [
      part(0, 24, "unsupported"),
    ]);
    const mixed = "The rate is 36.8%, and costs fell.";
    const halfway = checkWithParts(basis("halfway", mixed), [
      contradictedPart(0, 17),
      part(23, 33, "unsupported"),
    ]);
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The rate is 36.8%.", valid)] },
      { type: "paragraph", content: [marked("The old rate is 36.8%.", legacy)] },
      { type: "paragraph", content: [marked("An unsupported sentence.", unsupported)] },
      { type: "paragraph", content: [marked(mixed, halfway)] },
    ]);
    expect(claim(editor, "halfway").shown.state).toBe("contradicted");

    expect(correctableClaims(editor).map((each) => each.check.id)).toEqual(["valid"]);
    expect(correctContradictions(editor, "mind")).toBe(1);
    expect(claim(editor, "valid").shown.state).toBe("supported");
    expect(claim(editor, "legacy").shown.state).toBe("contradicted");
    expect(claim(editor, "unsupported").shown.state).toBe("unsupported");
    expect(claim(editor, "halfway").shown.state).toBe("contradicted");
  });
});
