/**
 * Add as Citation on a part's row (#2174): a supported part's Passage is cited right after that
 * part's words, never on the whole sentence, as one step of Undo; Add all cites every part that
 * isn't cited yet, as one step; and a Passage the sentence already cites stays Already cited.
 */
import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { partDecisions } from "../../src/renderer/src/editor/alreadyCited";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ resolveProposalsIn: vi.fn() }));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ documents: [], minds: [], settings: { language: "en" } }) },
}));

const { addPartCitations } = await import("../../src/renderer/src/checks");

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});

const CASES = [
  {
    language: "en",
    first: "Revenue rose 8% in May",
    second: "costs fell in June",
    sentence: "Revenue rose 8% in May; costs fell in June.",
    quotes: ["Revenue rose 8% in May.", "Costs fell in June."],
  },
  {
    language: "zh-CN",
    first: "五月收入增长了8%",
    second: "六月成本下降了",
    sentence: "五月收入增长了8%；六月成本下降了。",
    quotes: ["五月收入增长了8%。", "六月成本下降了。"],
  },
] as const;

const source = (passageId: string, quote: string): CitationAttributes => ({
  passageId,
  documentId: "results",
  documentName: "Results",
  contentHash: "v1",
  quote,
  pageFrom: 1,
  pageTo: 1,
  location: null,
  check: "found",
  checkReason: null,
});

const supported = (start: number, end: number, evidence: CitationAttributes): ClaimCheckPart => ({
  span: { start, end },
  kind: "fact",
  verdict: "supported",
  evidence: [{ ...evidence, id: `receipt-${evidence.passageId}` }],
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});

function setUp(example: (typeof CASES)[number], citedAtEnd?: CitationAttributes) {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({
    fontStyle: "",
    fontWeight: "",
    fontSize: "",
    fontFamily: "",
  }));
  const { sentence, first, second, quotes } = example;
  const passages = [source("first", quotes[0]), source("second", quotes[1])];
  const at = sentence.indexOf(second);
  const parts = [
    supported(0, first.length, passages[0] as CitationAttributes),
    supported(at, at + second.length, passages[1] as CitationAttributes),
  ];
  const check: ClaimCheckAttributes = {
    id: "check",
    request: "run",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text: sentence,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [{ documentId: "results", contentHash: "v1" }],
    excluded: [],
    checkedAt: "2026-10-29T12:00:00.000Z",
    parts,
  };
  const content: JSONContent[] = [
    { type: "text", text: sentence, marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] },
    ...(citedAtEnd ? [{ type: CITATION_NODE, attrs: { ...citedAtEnd, id: "cited" } }] : []),
  ];
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(
    getSchema(noteExtensions()).nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", attrs: { id: "p" }, content }],
    }),
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  const editor = new Editor({
    element: globalThis.document.createElement("div"),
    editorProps: { handleScrollToSelection: () => true },
    extensions: [
      ...noteExtensions(),
      CitationNumbers,
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  cleanup.push(() => {
    editor.destroy();
    doc.destroy();
  });
  const claim = () => {
    const [shown] = claimsOf(editor.state.doc, {
      versions: null,
      folderId: null,
      scope: null,
    }).claims;
    if (!shown) throw new Error("The sentence lost its check.");
    return shown;
  };
  /** The paragraph as text, each Citation written as [its Passage]. */
  const written = () => {
    let text = "";
    editor.state.doc.firstChild?.forEach((node) => {
      text += node.type.name === CITATION_NODE ? `[${node.attrs.passageId}]` : (node.text ?? "");
    });
    return text;
  };
  const decisions = () =>
    (claim().check.parts ?? []).map((part) =>
      partDecisions(editor.state, claim(), part).map(({ decision }) => decision.kind),
    );
  return { editor, claim, written, decisions, parts };
}

for (const example of CASES)
  describe(example.language, () => {
    const { sentence, first, second } = example;
    const end = sentence.slice(sentence.indexOf(second) + second.length);
    const between = sentence.slice(first.length, sentence.indexOf(second));

    // protects=a part's Passage goes right after that part's words, the sentence keeps its check and parts, the other part still offers its add, and one Undo takes back that add alone (#2174); fails_when=the Citation lands at the sentence's end or on the whole sentence, the check is dropped, or Undo takes back more or less; no_claim=how the card lays the button out.
    test("Add as Citation on a row cites that part's words, as one Undo", () => {
      const { editor, claim, written, decisions, parts } = setUp(example);
      expect(decisions()).toEqual([["add"], ["add"]]);

      expect(addPartCitations(editor, claim(), [parts[0] as ClaimCheckPart])).toBe(true);
      expect(written()).toBe(`${first}[first]${between}${second}${end}`);
      expect(claim().check.parts).toEqual(parts);
      expect(claim().shown).toEqual({ state: "supported" });
      expect(decisions()).toEqual([["already"], ["add"]]);

      editor.commands.undo();
      expect(written()).toBe(sentence);
      expect(decisions()).toEqual([["add"], ["add"]]);
    });

    // protects=Add all cites every part that isn't cited yet, each after its own words, as one step of Undo (#2174); fails_when=a Citation goes on the whole sentence, one part is missed, or Undo takes back only one; no_claim=none beyond protects.
    test("Add all cites each part after its words, as one Undo", () => {
      const { editor, claim, written, decisions, parts } = setUp(example);

      expect(addPartCitations(editor, claim(), parts)).toBe(true);
      expect(written()).toBe(`${first}[first]${between}${second}[second]${end}`);
      expect(decisions()).toEqual([["already"], ["already"]]);
      expect(claim().shown).toEqual({ state: "supported" });

      editor.commands.undo();
      expect(written()).toBe(sentence);
    });

    // protects=a Passage the sentence already cites is Already cited for its part, so Add all adds only the other part's (#2174); fails_when=the same Passage is cited twice; no_claim=none beyond protects.
    test("a Passage already cited stays Already cited, and Add all adds only the rest", () => {
      const { editor, claim, written, decisions, parts } = setUp(
        example,
        source("first", example.quotes[0]),
      );
      expect(decisions()).toEqual([["already"], ["add"]]);

      expect(addPartCitations(editor, claim(), parts)).toBe(true);
      expect(written()).toBe(`${first}${between}${second}[second]${end}[first]`);
    });
  });
