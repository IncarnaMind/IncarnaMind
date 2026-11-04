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
  MIND_SETTINGS_FIELD,
  type RewriteFromDocumentsResult,
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
import { writeVerification } from "../../src/shared/verification";

const { core } = vi.hoisted(() => ({
  core: {
    recordAiUse: vi.fn(() => Promise.resolve([])),
    checkSentences: vi.fn(() => Promise.resolve({ kind: "cancelled" })),
    rewriteFromDocuments: vi.fn(),
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

const { offersRewrite, rewriteWithDocuments } = await import("../../src/renderer/src/rewriteFix");
const { citeChosenWords, useCitationPick } = await import("../../src/renderer/src/citationPick");
const { useChecks } = await import("../../src/renderer/src/checks");

const SENTENCE = "Rent is 1100 dollars.";
const LINE = "Rent is 1250 dollars monthly.";

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
  core.rewriteFromDocuments.mockReset();
  noteBusy.mockClear();
  useNotices.setState({ errors: [], confirmation: null });
  useChecks.setState({ running: {}, rewriting: {} });
  useCitationPick.setState({ pick: null, asked: null });
});

const REWRITTEN: RewriteFromDocumentsResult = {
  kind: "rewritten",
  correction: { from: "1100", choices: [{ wording: "1250", evidence }] },
  providerId: "openai",
  modelId: "gpt-6-luna",
};

describe("Rewrite with what the Documents say", () => {
  test("is offered on a sentence with no Citation whose check found a close Passage", () => {
    const offered = editorWith([marked(SENTENCE, unsupported())]);
    expect(offersRewrite(offered.editor, offered.doc, claim(offered.editor))).toBe(true);
    for (const check of [
      unsupported({ evidence: null }),
      unsupported({ state: "contradicted" }),
      unsupported({ text: "Rent is 1100 dollars a month." }),
    ]) {
      const { editor, doc } = editorWith([marked(SENTENCE, check)]);
      expect(offersRewrite(editor, doc, claim(editor))).toBe(false);
    }
    const cited = editorWith([
      marked("Rent is 1100 dollars", unsupported()),
      { type: CITATION_NODE, attrs: evidence },
      marked(".", unsupported()),
    ]);
    expect(offersRewrite(cited.editor, cited.doc, claim(cited.editor))).toBe(false);
  });

  test("is not offered in a Note made to verify someone else's file, whose words it keeps", () => {
    const { editor, doc } = editorWith([marked(SENTENCE, unsupported())]);
    expect(offersRewrite(editor, doc, claim(editor))).toBe(true);
    writeVerification(doc.getMap(MIND_SETTINGS_FIELD), {
      documentId: "their-report",
      documentName: "Their report",
      pages: {},
      claims: null,
      comments: false,
    });
    expect(offersRewrite(editor, doc, claim(editor))).toBe(false);
  });

  test("writes the Passage's words as AI text, cites it before the stop and checks again, in one step of Undo", async () => {
    core.rewriteFromDocuments.mockResolvedValue(REWRITTEN);
    const { editor, doc } = editorWith([marked(SENTENCE, unsupported())]);

    expect(await rewriteWithDocuments(editor, "mind", doc, claim(editor))).toBe(true);

    expect(core.rewriteFromDocuments).toHaveBeenCalledWith({
      mindId: "mind",
      checkId: "check-rent",
      model: null,
    });
    expect(textOf(editor)).toBe(`Rent is 1250 dollars${INLINE_NODE}.`);
    expect(aiText(editor)).toEqual(["1250"]);
    expect(citationsIn(editor)).toEqual([expect.objectContaining({ quote: LINE, check: "found" })]);
    expect(core.checkSentences).toHaveBeenCalledTimes(1);
    expect(core.recordAiUse).toHaveBeenCalledWith([
      // By the model that wrote the words, not the one that checked the sentence.
      expect.objectContaining({
        mindId: "mind",
        kind: "edit-with-ai-accepted",
        characters: 4,
        providerId: "openai",
        modelId: "gpt-6-luna",
      }),
    ]);
    expect(undoManager(editor)?.undoStack).toHaveLength(1);
    verdictLands(editor, unsupported({ state: "supported", text: "Rent is 1250 dollars." }));
    expect(claim(editor).shown.state).toBe("supported");

    undoManager(editor)?.undo();

    expect(textOf(editor)).toBe(SENTENCE);
    expect(citationsIn(editor)).toEqual([]);
    expect(claim(editor).check).toMatchObject({
      id: "check-rent",
      state: "unsupported",
      text: SENTENCE,
    });
  });

  test("keeps the sentence, saying so, when the core keeps it", async () => {
    core.rewriteFromDocuments.mockResolvedValue({ kind: "kept" });
    const { editor, doc } = editorWith([marked(SENTENCE, unsupported())]);

    expect(await rewriteWithDocuments(editor, "mind", doc, claim(editor))).toBe(false);

    expect(textOf(editor)).toBe(SENTENCE);
    expect(citationsIn(editor)).toEqual([]);
    expect(errors()).toEqual(["claim.rewrite.kept"]);
    expect(core.checkSentences).not.toHaveBeenCalled();
  });

  test("writes nothing over words the User changed while the model worked", async () => {
    let answer: (result: RewriteFromDocumentsResult) => void = () => undefined;
    core.rewriteFromDocuments.mockReturnValue(
      new Promise<RewriteFromDocumentsResult>((resolve) => {
        answer = resolve;
      }),
    );
    const { editor, doc } = editorWith([marked(SENTENCE, unsupported())]);
    const asked = rewriteWithDocuments(editor, "mind", doc, claim(editor));
    // A second ask while the first works sends nothing.
    expect(await rewriteWithDocuments(editor, "mind", doc, claim(editor))).toBe(false);
    expect(core.rewriteFromDocuments).toHaveBeenCalledTimes(1);
    editor.commands.insertContentAt(9, "about ");
    answer(REWRITTEN);

    expect(await asked).toBe(false);

    expect(textOf(editor)).toBe("Rent is about 1100 dollars.");
    expect(aiText(editor)).toEqual([]);
    expect(errors()).toEqual(["error.check.partChanged"]);
  });
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

test("Rewrite writes nothing once the sentence was given a Citation while the model worked", async () => {
  let answer: (result: RewriteFromDocumentsResult) => void = () => undefined;
  core.rewriteFromDocuments.mockReturnValue(
    new Promise<RewriteFromDocumentsResult>((resolve) => {
      answer = resolve;
    }),
  );
  const { editor, doc } = editorWith([marked(SENTENCE, unsupported())]);
  const asked = rewriteWithDocuments(editor, "mind", doc, claim(editor));
  editor.commands.insertContentAt(SENTENCE.length, { type: CITATION_NODE, attrs: evidence });
  answer(REWRITTEN);

  expect(await asked).toBe(false);

  expect(textOf(editor)).toBe(`Rent is 1100 dollars${INLINE_NODE}.`);
  expect(aiText(editor)).toEqual([]);
  expect(errors()).toEqual(["error.check.partChanged"]);
});

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
    useChecks.setState({ running: {}, rewriting: { mind: "check-other" } });

    expect(await citeChosenWords(pick, rent, () => Promise.resolve(CITED))).toBe(false);

    expect(citationsIn(editor)).toEqual([]);
    expect(noteBusy).toHaveBeenCalledWith("mind");
    expect(core.checkSentences).not.toHaveBeenCalled();
    useChecks.setState({ running: {}, rewriting: {} });
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
