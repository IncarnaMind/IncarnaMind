import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment, yUndoPluginKey } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CITATION_NODE,
  type CitationAttributes,
  type CitedSelection,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  GENERATED_MARK,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import {
  ClaimChecks,
  paragraphPlaces,
  shownClaims,
} from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { registerMindEditor } from "../../src/renderer/src/editor/openEditors";
import { useNotices } from "../../src/renderer/src/notices";
import { INLINE_NODE } from "../../src/shared/sentences";

const { core } = vi.hoisted(() => ({
  core: {
    recordAiUse: vi.fn(() => Promise.resolve([])),
    checkSentences: vi.fn(() => Promise.resolve({ kind: "cancelled" })),
  },
}));
vi.mock("../../src/renderer/src/core", () => ({ core }));
const { noteBusy } = vi.hoisted(() => ({ noteBusy: vi.fn() }));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  noteBusy,
  resolveProposalsIn: vi.fn(),
  useEdits: { getState: () => ({ pending: {} }) },
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn(() => null) }));
vi.mock("../../src/renderer/src/i18n", () => ({
  languageNow: () => "en",
  translateNow: (key: string) => key,
}));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ reportError: vi.fn(), openDocument: vi.fn() }) },
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

const { citeChosenWords, useCitationPick } = await import("../../src/renderer/src/citationPick");
const { useChecks } = await import("../../src/renderer/src/checks");

const SENTENCE = "Rent is 1100 dollars.";
const LINE = "Rent is 1250 dollars.";

const evidence: CitationAttributes = {
  passageId: "passage-rent",
  documentId: "rent",
  documentName: "Rent",
  contentHash: "hash-rent",
  pageFrom: null,
  pageTo: null,
  location: null,
  quote: LINE,
  check: "found",
  checkReason: null,
};

const unsupported = (extra: Partial<ClaimCheckAttributes> = {}): ClaimCheckAttributes => ({
  id: "check-rent",
  request: "request-rent",
  action: "check-against-documents",
  state: "unsupported",
  reason: null,
  detail: null,
  providerId: "anthropic",
  modelId: "claude-haiku-5-5",
  text: SENTENCE,
  evidence,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-11-04T00:00:00.000Z",
  ...extra,
});

const marked = (text: string, attrs: ClaimCheckAttributes): JSONContent => ({
  type: "text",
  text,
  marks: [{ type: CLAIM_CHECK_MARK, attrs }],
});

function editorWith(content: JSONContent[]): { editor: Editor; doc: Y.Doc } {
  const blocks = [{ type: "paragraph", attrs: { id: "rent-block" }, content }];
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
  const unregister = registerMindEditor("mind", editor);
  onTestFinished(() => {
    unregister();
    editor.destroy();
    doc.destroy();
  });
  return { editor, doc };
}

const claim = (editor: Editor) => {
  const found = shownClaims(editor.state).find((each) => each.check.id === "check-rent");
  if (!found) throw new Error("No shown claim.");
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

const citationsIn = (editor: Editor) => {
  const found: CitationAttributes[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs as CitationAttributes);
    return true;
  });
  return found;
};

const aiText = (editor: Editor) => {
  const found: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === GENERATED_MARK)) {
      found.push(node.text ?? "");
    }
    return true;
  });
  return found;
};

const undoManager = (editor: Editor) => yUndoPluginKey.getState(editor.state)?.undoManager;

/** The check's new verdict, written as the core writes one: over the whole paragraph, outside the Note's Undo. */
function verdictLands(editor: Editor, check: ClaimCheckAttributes): void {
  const type = editor.state.schema.marks[CLAIM_CHECK_MARK];
  if (!type) throw new Error("No check mark.");
  const end = editor.state.doc.content.size - 1;
  editor.view.dispatch(
    editor.state.tr
      .removeMark(1, end, type)
      .addMark(1, end, type.create(check))
      .setMeta("addToHistory", false),
  );
}

const errors = () => useNotices.getState().errors.map((each) => each.message);

beforeEach(() => {
  core.recordAiUse.mockClear();
  core.checkSentences.mockClear();
  noteBusy.mockClear();
  useNotices.setState({ errors: [], confirmation: null });
  useChecks.setState({ running: {} });
  useCitationPick.setState({ pick: null, asked: null });
});

const CITED: CitedSelection = {
  quote: LINE,
  passageId: "passage-rent",
  contentHash: "hash-rent",
  pageFrom: null,
  pageTo: null,
  location: null,
  check: "found",
  checkReason: null,
};

const pick = { mindId: "mind", checkId: "check-rent", documentId: "rent", sentence: SENTENCE };
const rent = { id: "rent", name: "Rent" };

describe("Use as Citation", () => {
  test("cites the words where they were found, before the stop, and checks the sentence again in every Document, in one step of Undo", async () => {
    const { editor } = editorWith([marked(SENTENCE, unsupported({ evidence: null }))]);
    useCitationPick.setState({ pick });

    expect(await citeChosenWords(pick, rent, () => Promise.resolve(CITED))).toBe(true);

    expect(textOf(editor)).toBe(`Rent is 1100 dollars${INLINE_NODE}.`);
    expect(citationsIn(editor)).toEqual([
      expect.objectContaining({ documentId: "rent", quote: LINE, check: "found" }),
    ]);
    expect(aiText(editor)).toEqual([]);
    expect(core.checkSentences).toHaveBeenCalledWith(
      expect.objectContaining({ mindId: "mind", allDocuments: true }),
    );
    expect(useCitationPick.getState().pick).toBeNull();
    expect(undoManager(editor)?.undoStack).toHaveLength(1);
    verdictLands(editor, unsupported({ id: "check-rent", state: "supported", evidence }));
    expect(claim(editor).shown.state).toBe("supported");

    undoManager(editor)?.undo();

    // A verdict that rested on the Citation goes with it: the sentence is unsupported again.
    expect(citationsIn(editor)).toEqual([]);
    expect(claim(editor).check).toMatchObject({
      id: "check-rent",
      state: "unsupported",
      evidence: null,
    });
  });

  test("asks for the words' Citation for the Note the sentence is in, which a Folder wall may refuse", async () => {
    editorWith([marked(SENTENCE, unsupported({ evidence: null }))]);
    useCitationPick.setState({ pick });
    const cite = vi.fn((_mindId: string) => Promise.resolve(CITED));

    expect(await citeChosenWords(pick, rent, cite)).toBe(true);

    expect(cite).toHaveBeenCalledWith("mind");
  });

  test("refuses words a scan may have misread, and cites nothing", async () => {
    const { editor } = editorWith([marked(SENTENCE, unsupported({ evidence: null }))]);
    useCitationPick.setState({ pick });

    expect(
      await citeChosenWords(pick, rent, () =>
        Promise.resolve({ ...CITED, check: "cant-check", checkReason: "unsure-word" }),
      ),
    ).toBe(false);

    expect(citationsIn(editor)).toEqual([]);
    expect(errors()).toEqual(["viewer.selection.refused.unsure"]);
    expect(core.checkSentences).not.toHaveBeenCalled();
    // The sentence still waits: the User can select other words.
    expect(useCitationPick.getState().pick).toEqual(pick);
  });

  test("cites nothing while another fix works on the Note, which says it is busy", async () => {
    const { editor } = editorWith([marked(SENTENCE, unsupported({ evidence: null }))]);
    useCitationPick.setState({ pick });
    useChecks.setState({
      running: { mind: { requestId: "check-other", action: "check-against-documents" } },
    });

    expect(await citeChosenWords(pick, rent, () => Promise.resolve(CITED))).toBe(false);

    expect(citationsIn(editor)).toEqual([]);
    expect(noteBusy).toHaveBeenCalledWith("mind");
    expect(core.checkSentences).not.toHaveBeenCalled();
    useChecks.setState({ running: {} });
    expect(await citeChosenWords(pick, rent, () => Promise.resolve(CITED))).toBe(true);
  });

  test("cites nothing once the sentence has a Citation of its own, and stops waiting", async () => {
    const { editor } = editorWith([
      marked("Rent is 1100 dollars", unsupported({ evidence: null })),
      { type: CITATION_NODE, attrs: evidence },
      marked(".", unsupported({ evidence: null })),
    ]);
    useCitationPick.setState({ pick });

    expect(await citeChosenWords(pick, rent, () => Promise.resolve(CITED))).toBe(false);

    expect(citationsIn(editor)).toHaveLength(1);
    expect(errors()).toEqual(["error.check.partChanged"]);
    expect(useCitationPick.getState().pick).toBeNull();
  });
});
