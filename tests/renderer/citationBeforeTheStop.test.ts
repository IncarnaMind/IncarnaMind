/**
 * A Citation a check's card adds goes before the closing punctuation of the sentence it cites,
 * after the Citations already there, whether the sentence already has none, one or two before its
 * stop, and whether Citations already stand after the stop (an AI wrote them there): the Citation
 * is never put after the stop, and the ones after it are not moved.
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
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ resolveProposalsIn: vi.fn() }));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ documents: [], minds: [], settings: { language: "en" } }) },
}));

const { addAsCitation, addPartCitations } = await import("../../src/renderer/src/checks");

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});

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

const EXAMPLES = [
  {
    language: "en",
    words: "Recyclers collect scrap metal and plastic every week",
    stop: ".",
    gap: " ",
    next: " At the time they used no AI.",
    found: "Recyclers gather metal and plastic weekly.",
  },
  {
    language: "zh-CN",
    words: "回收商每周收集废金属和塑料",
    stop: "。",
    gap: "",
    next: "当时他们没有使用人工智能。",
    found: "回收商每周收集金属和塑料。",
  },
] as const;

function noteOf(
  example: (typeof EXAMPLES)[number],
  before: number,
  after: number,
  partEndsAt: "sentence" | "words",
) {
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
  const sentence = `${example.words}${example.stop}`;
  const found = { ...source("new", example.found), id: "new" };
  const part: ClaimCheckPart = {
    span: { start: 0, end: partEndsAt === "sentence" ? sentence.length : example.words.length },
    kind: "fact",
    verdict: "supported",
    evidence: [found],
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    versions: [],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
  };
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
    evidence: found,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [{ documentId: "results", contentHash: "v1" }],
    excluded: [],
    checkedAt: "2026-10-29T12:00:00.000Z",
    parts: [part],
  };
  const marked = (words: string): JSONContent => ({
    type: "text",
    text: words,
    marks: [{ type: CLAIM_CHECK_MARK, attrs: check }],
  });
  const cite = (name: string): JSONContent => ({
    type: CITATION_NODE,
    attrs: { ...source(name, `Another quote, ${name}, about recycling.`), id: name },
  });
  const content: JSONContent[] = [
    marked(example.words),
    ...Array.from({ length: before }, (_, at) => cite(`before${at + 1}`)),
    marked(example.stop),
    ...(after > 0 && example.gap ? [{ type: "text", text: example.gap }] : []),
    ...Array.from({ length: after }, (_, at) => cite(`after${at + 1}`)),
    { type: "text", text: example.next },
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
      footing: "not-yet-known",
      versions: null,
      folderId: null,
      scope: null,
    }).claims;
    if (!shown) throw new Error("The sentence lost its check.");
    return shown;
  };
  /** The paragraph as text, each Citation written as [its id]. */
  const written = () => {
    let text = "";
    editor.state.doc.firstChild?.forEach((node) => {
      text +=
        node.type.name === CITATION_NODE ? `[${node.attrs.id ?? node.attrs.passageId}]` : node.text;
    });
    return text;
  };
  return { editor, claim, written, part };
}

/**
 * How the paragraph reads once a Citation of the found Passage is added to the sentence: before
 * the stop, after the Citations before it, or, for a part that ends at its words, right after them.
 */
const readsAs = (
  example: (typeof EXAMPLES)[number],
  before: number,
  after: number,
  added = "[new]",
  atWords = false,
) => {
  const standing = (name: string, count: number) =>
    Array.from({ length: count }, (_, at) => `[${name}${at + 1}]`).join("");
  const stopped = `${example.stop}${after > 0 ? example.gap : ""}${standing("after", after)}${example.next}`;
  return atWords
    ? `${example.words}${added}${standing("before", before)}${stopped}`
    : `${example.words}${standing("before", before)}${added}${stopped}`;
};

for (const example of EXAMPLES)
  describe(example.language, () => {
    describe.each([0, 1, 2])("a sentence with %i Citations before its stop", (before) => {
      describe.each([0, 2])("and %i after it", (after) => {
        // protects=the card's Add as Citation puts the Passage's Citation before the stop, after the ones already there, and never after one that stands after the stop, which stays where it is, one step of Undo; fails_when=it lands after the stop, or after the Citations after it; no_claim=how the card lays the button out.
        test("Add as Citation", () => {
          const { editor, claim, written } = noteOf(example, before, after, "sentence");

          expect(addAsCitation(editor, claim())).toBe(true);

          expect(written()).toBe(readsAs(example, before, after));
          editor.commands.undo();
          expect(written()).toBe(readsAs(example, before, after, ""));
        });

        // protects=a part's Add as Citation and Add all put the Passage before the stop, after the Citations already there, for a part that ends the sentence with its stop, and right after its words for one that ends before them, with Citations after the stop left where they are; fails_when=the Citation lands after the stop or the ones after the stop move; no_claim=none beyond protects.
        test.each([["sentence"], ["words"]] as const)(
          "Add on a part that ends at the %s",
          (partEndsAt) => {
            const { editor, claim, written, part } = noteOf(example, before, after, partEndsAt);

            expect(addPartCitations(editor, claim(), [part])).toBe("added");

            expect(written()).toBe(
              readsAs(example, before, after, "[new]", partEndsAt === "words"),
            );
          },
        );
      });
    });
  });
