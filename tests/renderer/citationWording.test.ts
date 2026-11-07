/**
 * Use the Document's wording (#2605): a quote that differs from the page only in the kind of its
 * quotation marks is changed to the page's own words in one step, with Undo, and the Citation is
 * found by matching the new words against the Document's wording. The sentence is then checked
 * again like any edit, so its verdict is the check's and never the action's.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment, yUndoPluginKey } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { applyCitationWording, citationWordingFix } from "../../src/renderer/src/citationWording";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import { ClaimChecks, paragraphPlaces } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { saidInLine } from "../../src/renderer/src/lineNames";
import { useNotices } from "../../src/renderer/src/notices";
import { useUndo } from "../../src/renderer/src/undo";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { INLINE_NODE } from "../../src/shared/sentences";

const asked = vi.hoisted(() => ({ checks: [] as unknown[] }));
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    checkSentences: (input: unknown) => {
      asked.checks.push(input);
      return Promise.resolve({ kind: "checked", sentences: 1, checked: 1, smallModel: false });
    },
  },
}));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  requestEdit: vi.fn(),
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

const SENTENCE = "The policy says “the vendor’s ‘soft weight’ rule applies to 4 orders”";
const WORDS = "the vendor’s ‘soft weight’ rule applies to 4 orders";
const PAGE = "the vendor’s “soft weight” rule applies to 4 orders";

const check = (text: string): ClaimCheckAttributes => ({
  id: "check-one",
  request: "request-one",
  action: "check-against-documents",
  state: "unsupported",
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

const attributes = (documentWording: string = PAGE): CitationAttributes => ({
  passageId: "passage-1",
  documentId: "policy",
  documentName: "Policy",
  contentHash: "v1",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: PAGE,
  check: "not-found",
  checkReason: "quoted-words-not-on-pages",
  quotedWords: {
    answer: [{ text: WORDS, found: false }],
    closest: [
      { text: "Section 4: ", found: false },
      { text: PAGE, found: true },
      { text: ".", found: false },
    ],
    documentWording,
  },
});

function editorWith(citation: CitationAttributes): { editor: Editor; doc: Y.Doc } {
  const blocks: JSONContent[] = [
    {
      type: "paragraph",
      attrs: { id: "block-one" },
      content: [
        {
          type: "text",
          text: SENTENCE,
          marks: [{ type: CLAIM_CHECK_MARK, attrs: check(SENTENCE) }],
        },
        { type: CITATION_NODE, attrs: citation },
      ],
    },
  ];
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

/** Where the Citation node is. */
function citationAt(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === CITATION_NODE) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error("No Citation.");
  return found;
}

const citations = (editor: Editor) => {
  const found: CitationAttributes[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs as CitationAttributes);
    return true;
  });
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

const claimChecks = (editor: Editor) => {
  const found: ClaimCheckAttributes[] = [];
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === CLAIM_CHECK_MARK) found.push(mark.attrs as ClaimCheckAttributes);
    }
    return true;
  });
  return found;
};

const lineSaid = () => {
  const line = useUndo.getState().line;
  const t = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
  return line?.change ? saidInLine(t, line.change.said).message : null;
};

beforeEach(() => {
  asked.checks.length = 0;
  useNotices.setState({ errors: [], confirmation: null });
  useUndo.setState({ done: [], undone: [], line: null, running: null, making: 0, places: [] });
});

describe("Use the Document's wording", () => {
  test("is offered only while the quote differs in nothing but its marks", () => {
    const { editor } = editorWith(attributes());
    expect(citationWordingFix(editor, citationAt(editor))).toMatchObject({
      wording: PAGE,
      claim: expect.objectContaining({ check: expect.objectContaining({ id: "check-one" }) }),
    });

    const changed = editorWith(attributes("the vendor’s “hard weight” rule applies to 4 orders"));
    expect(citationWordingFix(changed.editor, citationAt(changed.editor))).toBeNull();
  });

  test("puts the page's own words in the sentence and finds the Citation: a text match, not a verdict", () => {
    const { editor, doc } = editorWith(attributes());
    expect(applyCitationWording(editor, "mind-one", doc, citationAt(editor))).toBe(true);

    expect(textOf(editor)).toBe(
      `The policy says “the vendor’s “soft weight” rule applies to 4 orders”${INLINE_NODE}`,
    );
    expect(citations(editor)[0]).toMatchObject({
      check: "found",
      checkReason: null,
      quotedWords: null,
    });
    // The action says nothing of the sentence: its check is what gives a verdict.
    expect(claimChecks(editor)[0]).toMatchObject({ state: "unsupported", id: "check-one" });
    expect(lineSaid()).toBe("Used the Document’s wording");
  });

  test("checks the sentence again like any edit", async () => {
    const { editor, doc } = editorWith(attributes());
    applyCitationWording(editor, "mind-one", doc, citationAt(editor));

    await vi.waitFor(() => expect(asked.checks).toHaveLength(1));
    expect(asked.checks[0]).toMatchObject({
      action: "check-against-documents",
      from: { blockId: "block-one", offset: 0 },
    });
    // Only the check says how the sentence stands; nothing in the action set Supported.
    expect(claimChecks(editor)[0]?.state).toBe("unsupported");
  });

  test("one Undo brings back the sentence and the Citation exactly", () => {
    const { editor, doc } = editorWith(attributes());
    applyCitationWording(editor, "mind-one", doc, citationAt(editor));
    expect(textOf(editor)).toContain("“soft weight” rule");

    yUndoPluginKey.getState(editor.state)?.undoManager.undo();

    expect(textOf(editor)).toBe(`${SENTENCE}${INLINE_NODE}`);
    expect(citations(editor)[0]).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
      quotedWords: attributes().quotedWords,
    });
    expect(claimChecks(editor)[0]?.id).toBe("check-one");
  });

  test("is not offered when the quote has moved out of the sentence", () => {
    const { editor } = editorWith(attributes());
    const at = citationAt(editor);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "block-one" },
          content: [{ type: "text", text: "Something else entirely." }],
        },
      ],
    });
    expect(citationWordingFix(editor, at)).toBeNull();
  });
});
