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
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type FigureCheckAttributes,
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

const evidence = (documentId = "report", quote = "The rate is 38.6%."): CitationAttributes => ({
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

const check = (
  id: string,
  text: string,
  from = "36.8%",
  choices = [{ wording: "38.6%", evidence: evidence() }],
): ClaimCheckAttributes => ({
  id,
  request: `request-${id}`,
  action: "check-against-documents",
  state: "contradicted",
  reason: null,
  detail: null,
  providerId: "anthropic",
  modelId: "claude-haiku-5-5",
  text,
  evidence: choices[0]?.evidence ?? null,
  correction: { from, choices },
  says: "The Document says 38.6%, not 36.8%.",
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-01-01T00:00:00.000Z",
});

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

describe("Correct a contradiction from the Documents", () => {
  test("replaces only the old substring, cites it, and keeps a supported check on the corrected sentence", () => {
    const attrs = check("one", "The rate is 36.8%.");
    const { editor } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "block-one" },
        content: [marked("The rate is 36.8%.", attrs)],
      },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`The rate is 38.6% ${INLINE_NODE}.`);
    expect(generatedText(editor)).toEqual(["38.6%"]);
    expect(citationsOf(editor)).toHaveLength(1);
    expect(claim(editor, "one").shown.state).toBe("supported");
    expect(claim(editor, "one").check).toMatchObject({
      state: "supported",
      text: `The rate is 38.6% ${INLINE_NODE}.`,
      evidence: { documentId: "report" },
      correction: null,
    });
    expect(recordAiUse).toHaveBeenCalledWith([
      expect.objectContaining({
        mindId: "mind",
        kind: "edit-with-ai-accepted",
        characters: 5,
        blockIds: ["block-one"],
      }),
    ]);
  });

  test("settles the owning figure and updates every child to the corrected sentence", () => {
    const text = "The rate is 36.8%.";
    const reading = readFigures("36.8%", { language: "en" })[0];
    if (!reading) throw new Error("The fixture has no figure.");
    const figure: FigureCheckAttributes = {
      ...check("figure", text),
      id: "figure-1",
      locator: {
        kind: "text",
        from: { blockId: "block-one", offset: 12 },
        to: { blockId: "block-one", offset: 17 },
      },
      reading,
      calculated: null,
      sourceInput: null,
      roundedFrom: null,
      difference: null,
      footing: [],
    };
    const attrs = { ...check("one", text), figures: [figure], remainder: null };
    const { editor, doc } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "block-one" },
        content: [marked(text, attrs)],
      },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    const corrected = claim(editor, "one");
    expect(corrected.shown.state).toBe("supported");
    expect(corrected.check.figures).toHaveLength(1);
    expect(corrected.check.figures?.[0]).toMatchObject({
      state: "supported",
      text: `The rate is 38.6% ${INLINE_NODE}.`,
      evidence: { documentId: "report" },
      correction: null,
    });
    expect(corrected.check.remainder).toBeNull();

    const occurrences = figuresInMind(doc.getXmlFragment(MIND_CONTENT_FIELD));
    expect(occurrences).toHaveLength(1);
    expect(corrected.check.figures?.[0]?.id).toBe(occurrences[0]?.id);
    expect(corrected.check.figures?.[0]?.reading.chars).toBe("38.6%");
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

  test("puts a new Citation at the sentence's end, not between the corrected value and its context", () => {
    const attrs = check("one", "The rate is 36.8% in Q3.");
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The rate is 36.8% in Q3.", attrs)] },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`The rate is 38.6% in Q3 ${INLINE_NODE}.`);
    expect(claim(editor, "one").check.text).toBe(`The rate is 38.6% in Q3 ${INLINE_NODE}.`);
  });

  test("retains an existing Citation of the same Passage instead of inserting a duplicate", () => {
    const source = evidence();
    const attrs = check("one", `The rate is 36.8%${INLINE_NODE}.`);
    const { editor } = editorWith([
      {
        type: "paragraph",
        content: [marked("The rate is 36.8%", attrs), citation(source), marked(".", attrs)],
      },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(citationsOf(editor)).toHaveLength(1);
    expect(citationsOf(editor)[0]).toMatchObject(source);
    expect(textOf(editor)).toBe(`The rate is 38.6%${INLINE_NODE}.`);
  });

  test("maps the old words past an inline footnote without moving or deleting it", () => {
    const attrs = check("one", `See ${INLINE_NODE} the rate is 36.8%.`);
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

    expect(textOf(editor)).toBe(`See ${INLINE_NODE} the rate is 38.6% ${INLINE_NODE}.`);
    expect(editor.state.doc.firstChild?.child(1).type.name).toBe(FOOTNOTE_NODE);
    expect(claim(editor, "one").shown.state).toBe("supported");
  });

  test("uses the first, newest Document's choice when two Documents disagree", () => {
    const attrs = check("one", "The rate is 36.8%.", "36.8%", [
      { wording: "38.6%", evidence: evidence("newer") },
      { wording: "39.4%", evidence: evidence("older") },
    ]);
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The rate is 36.8%.", attrs)] },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toContain("38.6%");
    expect(textOf(editor)).not.toContain("39.4%");
    expect(claim(editor, "one").check.evidence?.documentId).toBe("newer");
  });

  test("does not add a space between Chinese wording and its Citation", () => {
    const attrs = check("one", "比率是 36.8%。", "36.8%", [
      { wording: "百分之三十八点六", evidence: evidence("报告") },
    ]);
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("比率是 36.8%。", attrs)] },
    ]);

    expect(applyCorrection(editor, "mind", claim(editor, "one"))).toBe(true);

    expect(textOf(editor)).toBe(`比率是 百分之三十八点六${INLINE_NODE}。`);
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
    expect(useNotices.getState().errors.at(-1)?.message).toBe("claim.correction.moved");
    expect(recordAiUse).not.toHaveBeenCalled();
  });

  test("a repeated old substring is not guessed at", () => {
    const attrs = check("one", "36.8% was above 36.8%.");
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("36.8% was above 36.8%.", attrs)] },
    ]);

    expect(correctionFor(editor, claim(editor, "one"))).toBeNull();
    expect(correctableClaims(editor)).toHaveLength(0);
  });

  test("bulk correction changes two sentences in one Undo and restores both original checks", () => {
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
      `The first rate is 38.6% ${INLINE_NODE}.\nThe second rate is 38.6% ${INLINE_NODE}.`,
    );
    expect(claim(editor, "first").shown.state).toBe("supported");
    expect(claim(editor, "second").shown.state).toBe("supported");

    const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
    expect(manager?.undoStack).toHaveLength(1);
    manager?.undo();

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

  test("the badge counts only correctable contradictions, not unsupported or older marks", () => {
    const valid = check("valid", "The rate is 36.8%.");
    const legacy = { ...check("legacy", "The old rate is 36.8%."), correction: null };
    const unsupported = {
      ...check("unsupported", "An unsupported sentence."),
      state: "unsupported" as const,
      correction: null,
      evidence: null,
    };
    const { editor } = editorWith([
      { type: "paragraph", content: [marked("The rate is 36.8%.", valid)] },
      { type: "paragraph", content: [marked("The old rate is 36.8%.", legacy)] },
      { type: "paragraph", content: [marked("An unsupported sentence.", unsupported)] },
    ]);

    expect(correctableClaims(editor).map((each) => each.check.id)).toEqual(["valid"]);
    expect(correctContradictions(editor, "mind")).toBe(1);
    expect(claim(editor, "legacy").shown.state).toBe("contradicted");
    expect(claim(editor, "unsupported").shown.state).toBe("unsupported");
  });
});
