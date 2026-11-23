import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimChange,
  type ClaimCheckAttributes,
  GENERATED_MARK,
  MIND_CONTENT_FIELD,
  PROPOSAL_INSERT_MARK,
} from "../../src/core/api";
import { useChecks } from "../../src/renderer/src/checks";
import { placeChange } from "../../src/renderer/src/editor/changePlacement";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import {
  ClaimChecks,
  paragraphPlaces,
  shownClaims,
} from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { useNotices } from "../../src/renderer/src/notices";
import { acceptChange, changeAt, changeToMake } from "../../src/renderer/src/ownChange";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { INLINE_NODE } from "../../src/shared/sentences";

/*
 * The change the User's own AI gives with a check (#3715) is offered only where it can be written:
 * the card, ⌘K and Accept ask one test. It is written word by word, so a Citation or a worked-out
 * figure between the words it changes stays exactly where it was; words it takes out that hold one
 * are refused, and the card leads with asking the AI instead.
 */

const { recordAiUse } = vi.hoisted(() => ({ recordAiUse: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../src/renderer/src/core", () => ({
  core: { recordAiUse, checkSentences: () => Promise.resolve({ kind: "checked" }) },
}));
const edits = vi.hoisted(() => ({ pending: {} as Record<string, unknown> }));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  requestEdit: vi.fn(),
  useEdits: { getState: () => ({ pending: edits.pending }) },
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/handedFiles", () => ({ checksHandedFile: () => false }));
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

const MIND = "mind";

/** A check by the User's own AI that found the sentence overstated and gave `change`. */
const overstated = (text: string, change: ClaimChange): ClaimCheckAttributes => ({
  id: "own",
  request: "request-own",
  action: "check-against-documents",
  state: "unsupported",
  reason: null,
  detail: null,
  providerId: null,
  modelId: "Claude Code",
  text,
  evidence: null,
  says: null,
  unsupported: { reason: "The quotes say less.", covered: null, uncovered: null },
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-01-01T00:00:00.000Z",
  change,
});

type MarkJSON = { type: string; attrs: Record<string, unknown> };

const marked = (text: string, attrs: ClaimCheckAttributes, more: MarkJSON[] = []): JSONContent => ({
  type: "text",
  text,
  marks: [{ type: CLAIM_CHECK_MARK, attrs: { ...attrs } }, ...more],
});

const source: CitationAttributes = {
  passageId: "passage-report",
  documentId: "report",
  documentName: "Harbour report",
  contentHash: "hash-report",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: "The pontoon takes one boat at a time until 2027.",
  check: "found",
  checkReason: null,
};
const citation: JSONContent = { type: CITATION_NODE, attrs: source };

const figure = calculatedFigureNode(
  {
    label: "Growth",
    formula: "",
    inputs: [],
    value: 0.2,
    unit: { kind: "percent" },
    approximate: false,
    shown: "20.0%",
    show: { language: "en", as: "percent", decimals: 1, scale: null },
    literals: [],
    engine: FORMULA_VERSION,
    written: null,
    analysis: { analysis: 1, result: "growth" },
  },
  "figure",
  "run-1",
);

function editorWith(content: JSONContent[]): { editor: Editor; doc: Y.Doc } {
  const blocks = [{ type: "paragraph", attrs: { id: "block" }, content }];
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

const claim = (editor: Editor) => {
  const found = shownClaims(editor.state).find((each) => each.check.id === "own");
  if (!found) throw new Error("No shown claim.");
  return found;
};

/** The paragraph's text, a Citation or figure as the object character. */
const textOf = (editor: Editor) => {
  let found = "";
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    found = paragraphPlaces(node, pos).text;
    return false;
  });
  return found;
};

const nodesOf = (editor: Editor) => {
  const names: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isInline && !node.isText) names.push(node.type.name);
    return true;
  });
  return names;
};

const generatedText = (editor: Editor) => {
  const found: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === GENERATED_MARK))
      found.push(node.text ?? "");
    return true;
  });
  return found;
};

const errors = () => useNotices.getState().errors.map((each) => each.message);

beforeEach(() => {
  recordAiUse.mockClear();
  edits.pending = {};
  useChecks.setState({ running: {} });
  useNotices.setState({ errors: [], confirmation: null });
});

describe("Accept writes the change and keeps every Citation and figure where it is", () => {
  test("a change inside the sentence leaves it checked, waiting for its AI's next check", () => {
    const text = "The ferry runs every 30 minutes all summer.";
    const replace = "every 30 minutes all summer";
    const written = "on spring tides in July and August";
    const { editor, doc } = editorWith([
      marked(text, overstated(text, { replace, with: written })),
    ]);

    expect(acceptChange(editor, MIND, doc, claim(editor), false)).toBe(true);

    expect(claim(editor).sentence.text).toBe(text.replace(replace, written));
    expect(claim(editor).shown.state).toBe("needs-recheck");
  });

  test("a change of the whole sentence, up to the stop after its Citation, keeps the Citation before the stop", () => {
    const text = "The pontoon takes two boats at a time.";
    const written = "The pontoon takes one boat at a time until 2027.";
    const attrs = overstated(text, { replace: text, with: written });
    const { editor, doc } = editorWith([
      marked("The pontoon takes two boats at a time", attrs),
      citation,
      marked(".", attrs),
    ]);
    expect(placeChange(editor.state, claim(editor)).ok).toBe(true);

    expect(acceptChange(editor, MIND, doc, claim(editor), false)).toBe(true);

    expect(textOf(editor)).toBe(`The pontoon takes one boat at a time until 2027${INLINE_NODE}.`);
    expect(nodesOf(editor)).toEqual([CITATION_NODE]);
    expect(claim(editor).sentence.text).toBe(written);
    expect(claim(editor).shown.state).toBe("needs-recheck");
    expect(generatedText(editor)).toEqual(["one", "boat", " until 2027"]);
  });

  test("a change around a Citation in the middle of the sentence keeps it after the words it cites", () => {
    const text = "Revenue rose 8% in Q3 and margins fell.";
    const attrs = overstated(text, { replace: "8% in Q3", with: "9% in Q4" });
    const { editor, doc } = editorWith([
      marked("Revenue rose 8%", attrs),
      citation,
      marked(" in Q3 and margins fell.", attrs),
    ]);

    expect(acceptChange(editor, MIND, doc, claim(editor), false)).toBe(true);

    expect(textOf(editor)).toBe(`Revenue rose 9%${INLINE_NODE} in Q4 and margins fell.`);
    expect(nodesOf(editor)).toEqual([CITATION_NODE]);
  });

  test("a change beside a worked-out figure keeps the figure", () => {
    const text = "Growth was 20.0% in Q3.";
    const attrs = overstated(text, { replace: "20.0% in Q3", with: "20.0% in Q4" });
    const { editor, doc } = editorWith([
      marked("Growth was ", attrs),
      figure,
      marked(" in Q3.", attrs),
    ]);

    expect(acceptChange(editor, MIND, doc, claim(editor), false)).toBe(true);

    expect(textOf(editor)).toBe(`Growth was ${INLINE_NODE} in Q4.`);
    expect(nodesOf(editor)).toEqual([figure.type]);
  });
});

describe("a change that can't be written is never offered", () => {
  test.each([
    [
      "takes out words a Citation stands in",
      "Revenue rose 8% in Q3.",
      { replace: "rose 8% in Q3", with: "fell" },
      (attrs: ClaimCheckAttributes) => [
        marked("Revenue rose 8%", attrs),
        citation,
        marked(" in Q3.", attrs),
      ],
    ],
    [
      "takes out a worked-out figure",
      "Growth was 20.0% in Q3.",
      { replace: "Growth was 20.0%", with: "Growth was 25.0%" },
      (attrs: ClaimCheckAttributes) => [
        marked("Growth was ", attrs),
        figure,
        marked(" in Q3.", attrs),
      ],
    ],
  ] as const)(
    "one that %s: refused, and Accept leaves the Note as it was",
    (_, text, change, content) => {
      const { editor, doc } = editorWith(content(overstated(text, change)));
      const before = editor.state.doc.toJSON();

      expect(changeToMake(editor, MIND, claim(editor))).toEqual({ ok: false, why: "inside" });
      expect(changeAt(editor, MIND)).toBeNull();
      expect(acceptChange(editor, MIND, doc, claim(editor), false)).toBe(false);

      expect(editor.state.doc.toJSON()).toEqual(before);
      expect(errors()).toEqual(["claim.change.inside"]);
    },
  );

  test("a change waiting for the User over the words: refused, and says so", () => {
    const text = "The pontoon takes two boats at a time.";
    const attrs = overstated(text, { replace: "two boats", with: "one boat" });
    const { editor, doc } = editorWith([
      marked("The pontoon takes ", attrs),
      marked("two boats", attrs, [
        { type: PROPOSAL_INSERT_MARK, attrs: { id: "change", request: "request" } },
      ]),
      marked(" at a time.", attrs),
    ]);

    expect(changeToMake(editor, MIND, claim(editor))).toEqual({ ok: false, why: "review" });
    expect(acceptChange(editor, MIND, doc, claim(editor), false)).toBe(false);
    expect(errors()).toEqual(["claim.change.underReview"]);
  });

  test("while a check or an edit runs in the Note: not offered, nor by ⌘K, and Accept says why", () => {
    const text = "The pontoon takes two boats at a time.";
    const { editor, doc } = editorWith([
      marked(text, overstated(text, { replace: "two boats", with: "one boat" })),
    ]);
    editor.commands.setTextSelection(5);
    expect(changeAt(editor, MIND)).not.toBeNull();

    useChecks.setState({ running: { [MIND]: { requestId: "r", action: "whole-mind" } } });
    expect(changeToMake(editor, MIND, claim(editor))).toEqual({ ok: false, why: "checking" });
    expect(changeAt(editor, MIND)).toBeNull();
    expect(acceptChange(editor, MIND, doc, claim(editor), false)).toBe(false);
    expect(errors()).toEqual(["error.check.partChecking"]);

    useChecks.setState({ running: {} });
    edits.pending = { [MIND]: {} };
    expect(changeToMake(editor, MIND, claim(editor))).toEqual({ ok: false, why: "editing" });
    expect(changeAt(editor, MIND)).toBeNull();
  });

  test("words to change that aren't the sentence's any more: says the words changed", () => {
    const text = "The pontoon takes two boats at a time.";
    const { editor, doc } = editorWith([
      marked(text, overstated(text, { replace: "three boats", with: "one boat" })),
    ]);

    expect(changeToMake(editor, MIND, claim(editor))).toEqual({ ok: false, why: "changed" });
    expect(acceptChange(editor, MIND, doc, claim(editor), false)).toBe(false);
    expect(errors()).toEqual(["error.check.partChanged"]);
  });
});
