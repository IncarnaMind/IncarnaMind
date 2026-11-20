import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import {
  type Citation,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import { ClaimChecks, shownClaims } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  fixableAt,
  fixInstructionOf,
  fixSentence,
  fixSentences,
  offersFixSentence,
} from "../../src/renderer/src/fixSentence";
import { useNotices } from "../../src/renderer/src/notices";
import { askedSentenceOf } from "../../src/renderer/src/unsupportedFixes";
import { checkWithParts } from "../../src/shared/claimParts";

/*
 * Fix the sentence (#3383): offered where the check found a quote, never where it found none; the
 * model's rewrite, asked with the quote and what the check said, replaces the sentence, and the
 * new sentence alone is checked again.
 */

const edits = vi.hoisted(() => ({
  asked: [] as { action: string; instruction?: string; range?: { from: number; to: number } }[],
  rewrite: null as string | null,
}));
const checks = vi.hoisted(() => ({ asked: [] as unknown[] }));
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    recordAiUse: () => Promise.resolve([]),
    checkSentences: (input: unknown) => {
      checks.asked.push(input);
      return Promise.resolve({ kind: "checked", sentences: 1, checked: 1, smallModel: false });
    },
  },
}));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  useEdits: { getState: () => ({ pending: {} }) },
  // As the core's edit lands in the editor: the sentence's words replaced by the model's.
  requestEdit: (
    editor: Editor,
    _mindId: string,
    _doc: Y.Doc,
    action: string,
    instruction?: string,
    range?: { from: number; to: number },
  ) => {
    edits.asked.push({ action, ...(instruction && { instruction }), ...(range && { range }) });
    if (!range || edits.rewrite === null) return Promise.resolve(false);
    editor.view.dispatch(editor.state.tr.insertText(edits.rewrite, range.from, range.to));
    return Promise.resolve(true);
  },
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

const QUOTE = "The terminal opened in September 2025, six months later than planned.";

const evidence = (quote = QUOTE): Citation => ({
  passageId: "passage-review",
  documentId: "review",
  documentName: "Annual review",
  contentHash: "hash-review",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

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
  end: number,
  verdict: "supported" | "contradicted" | "unsupported",
  extra: Partial<ClaimCheckPart> = {},
): ClaimCheckPart => ({
  span: { start: 0, end },
  kind: "fact",
  verdict,
  evidence: verdict === "unsupported" ? [] : [evidence()],
  decidingEvidence: verdict === "unsupported" ? null : 0,
  says: verdict === "contradicted" ? "It opened six months late." : null,
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

const contradicted = (id: string, text: string, from = "on schedule") =>
  checkWithParts(basis(id, text), [
    part(text.length, "contradicted", {
      correction: {
        from,
        choices: [{ wording: "six months later than planned", evidence: evidence() }],
      },
    }),
  ]);

const notFound = (id: string, text: string) =>
  checkWithParts(basis(id, text), [part(text.length, "unsupported")]);

const marked = (text: string, attrs: ClaimCheckAttributes): JSONContent => ({
  type: "text",
  text,
  marks: [{ type: CLAIM_CHECK_MARK, attrs }],
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

const LATE = "The terminal opened on schedule.";
const ALONE = "The company plans a route to Norway.";

beforeEach(() => {
  edits.asked.length = 0;
  edits.rewrite = null;
  checks.asked.length = 0;
  useNotices.setState({ errors: [], confirmation: null });
});

describe("Fix the sentence", () => {
  test("is offered where the check found a quote, and never where it found none", () => {
    const { editor } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [marked(LATE, contradicted("late", LATE))],
      },
      {
        type: "paragraph",
        attrs: { id: "two" },
        content: [marked(ALONE, notFound("alone", ALONE))],
      },
    ]);

    expect(offersFixSentence(editor, claim(editor, "late"))).toBe(true);
    expect(offersFixSentence(editor, claim(editor, "alone"))).toBe(false);
    editor.commands.setTextSelection(3);
    expect(fixableAt(editor)?.check.id).toBe("late");
    editor.commands.setTextSelection(LATE.length + 6);
    expect(fixableAt(editor)).toBeNull();
  });

  test("asks with the quote, what the check said and its own words as a hint, never splicing them in", () => {
    const { editor } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [marked(LATE, contradicted("late", LATE))],
      },
    ]);

    expect(fixInstructionOf(editor, claim(editor, "late"))).toBe(
      `Its check found that the Documents say otherwise. The quote it found: “${QUOTE}”. What the check said: It opened six months late. The check suggested changing “on schedule” to “six months later than planned”: words to draw on, not to paste in as they are.`,
    );
  });

  test("puts the model's rewrite in the sentence's place and checks the new sentence alone again", async () => {
    const after = "The second sentence stays.";
    const { editor, doc } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [marked(LATE, contradicted("late", LATE)), { type: "text", text: ` ${after}` }],
      },
    ]);
    edits.rewrite = "The terminal opened six months later than planned.";

    await fixSentence(editor, "mind", doc, claim(editor, "late"));

    expect(edits.asked).toEqual([
      expect.objectContaining({ action: "fix-sentence", range: { from: 1, to: LATE.length + 1 } }),
    ]);
    expect(editor.state.doc.textContent).toBe(`${edits.rewrite} ${after}`);
    expect(checks.asked).toEqual([
      expect.objectContaining({
        action: "check-against-documents",
        from: { blockId: "one", offset: 0 },
        to: { blockId: "one", offset: edits.rewrite.length },
      }),
    ]);
  });

  test("fixes every sentence with a quote one after another, each its own request, and counts how they ended", async () => {
    const other = "The second terminal opened on schedule.";
    const { editor, doc } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [marked(LATE, contradicted("late", LATE))],
      },
      {
        type: "paragraph",
        attrs: { id: "two" },
        content: [marked(ALONE, notFound("alone", ALONE))],
      },
      {
        type: "paragraph",
        attrs: { id: "three" },
        content: [marked(other, contradicted("other", other))],
      },
    ]);
    edits.rewrite = "It opened six months later than planned.";

    await fixSentences(editor, "mind", doc);

    // Not found gets no rewrite; each of the others is its own request, the second after the first.
    expect(edits.asked.map((each) => each.action)).toEqual(["fix-sentence", "fix-sentence"]);
    expect(editor.state.doc.textContent).toBe(`${edits.rewrite}${ALONE}${edits.rewrite}`);
    expect(checks.asked).toHaveLength(2);
    // The scripted check writes no verdict here, so neither new sentence is Supported yet.
    expect(useNotices.getState().confirmation).toMatchObject({
      message: "claim.fix.doneMany",
      params: { fixed: 0, needsLook: 2 },
    });
  });

  test("goes to the User's own AI with the quote it rests on", () => {
    const { editor } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [marked(LATE, contradicted("late", LATE))],
      },
      {
        type: "paragraph",
        attrs: { id: "two" },
        content: [marked(ALONE, notFound("alone", ALONE))],
      },
    ]);

    expect(askedSentenceOf(editor, claim(editor, "late"))).toMatchObject({ quote: QUOTE });
    expect(askedSentenceOf(editor, claim(editor, "alone"))).not.toHaveProperty("quote");
  });
});
