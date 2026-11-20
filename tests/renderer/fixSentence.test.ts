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
const checks = vi.hoisted(() => ({
  asked: [] as unknown[],
  /** What the check writes into the Note, as the core's result reaches the editor. */
  answer: null as ((input: CheckInput) => void) | null,
}));
type CheckInput = {
  from: { blockId: string; offset: number };
  to: { blockId: string; offset: number };
};
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    recordAiUse: () => Promise.resolve([]),
    checkSentences: (input: CheckInput) => {
      checks.asked.push(input);
      checks.answer?.(input);
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
    // The words go; a marker keeps its place, as the core keeps it.
    let end = range.to;
    editor.state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (node.isInline && !node.isText && pos < end) end = Math.max(range.from, pos);
    });
    editor.view.dispatch(editor.state.tr.insertText(edits.rewrite, range.from, end));
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

/** Answers each check with `verdict`, written over the words it was asked about and kept out of Undo, as a result is. */
function answerWith(editor: Editor, verdict: "supported" | "unsupported") {
  checks.answer = ({ from, to }) => {
    const at = (place: { blockId: string; offset: number }) => {
      let found = -1;
      editor.state.doc.forEach((node, pos) => {
        if (node.attrs.id === place.blockId) found = pos + 1 + place.offset;
      });
      return found;
    };
    const start = at(from);
    const end = at(to);
    const text = editor.state.doc.textBetween(start, end);
    const attrs = checkWithParts(basis(`checked-${start}`, text), [
      part(text.length, verdict, verdict === "supported" ? { evidence: [evidence()] } : {}),
    ]);
    const type = editor.state.schema.marks[CLAIM_CHECK_MARK];
    if (!type) throw new Error("No claim check mark.");
    editor.view.dispatch(
      editor.state.tr
        .removeMark(start, end, type)
        .addMark(start, end, type.create(attrs))
        .setMeta("addToHistory", false),
    );
  };
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
  checks.answer = null;
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
    answerWith(editor, "unsupported");

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
    answerWith(editor, "unsupported");

    await fixSentences(editor, "mind", doc);

    // Not found gets no rewrite; each of the others is its own request, the second after the first.
    expect(edits.asked.map((each) => each.action)).toEqual(["fix-sentence", "fix-sentence"]);
    expect(editor.state.doc.textContent).toBe(`${edits.rewrite}${ALONE}${edits.rewrite}`);
    expect(checks.asked).toHaveLength(2);
    // Neither new sentence is Supported: the line that says so carries no tick.
    expect(useNotices.getState().confirmation).toMatchObject({
      message: "claim.fix.doneMany",
      params: { fixed: 0, needsLook: 2 },
      look: true,
    });
  });

  test("says a new sentence that still needs a look once its check has landed, with no tick", async () => {
    const { editor, doc } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [marked(LATE, contradicted("late", LATE))],
      },
    ]);
    edits.rewrite = "The terminal opened later than planned.";
    answerWith(editor, "unsupported");
    const write = checks.answer;
    // The check's result reaches the editor after the request that asked for it has returned.
    checks.answer = (input) => setTimeout(() => write?.(input), 20);

    const ended = fixSentence(editor, "mind", doc, claim(editor, "late"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useNotices.getState().confirmation).toBeNull();

    expect(await ended).toBe("needs-look");
    expect(useNotices.getState().confirmation).toMatchObject({
      message: "claim.fix.needsLook",
      look: true,
    });
  });

  test("cites the quote it rests on once the new sentence is Supported by it, and one Undo brings back the old words and their check", async () => {
    const { editor, doc } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [marked(LATE, contradicted("late", LATE))],
      },
    ]);
    edits.rewrite = "The terminal opened six months later than planned.";
    answerWith(editor, "supported");

    expect(await fixSentence(editor, "mind", doc, claim(editor, "late"))).toBe("fixed");

    const citations: { quote: unknown; foundByCheck: unknown }[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "citation")
        citations.push({ quote: node.attrs.quote, foundByCheck: node.attrs.foundByCheck });
    });
    expect(citations).toEqual([{ quote: QUOTE, foundByCheck: true }]);
    // The sentence keeps the check that found it Supported: the Citation adds no words to check.
    expect(shownClaims(editor.state).map((each) => each.shown.state)).toEqual(["supported"]);
    expect(useNotices.getState().confirmation).toBeNull();

    editor.commands.undo();

    expect(editor.state.doc.textContent).toBe(LATE);
    expect(shownClaims(editor.state).map((each) => [each.check.id, each.shown.state])).toEqual([
      ["late", "contradicted"],
    ]);
  });

  test("leaves a cited sentence's Citations as they are", async () => {
    const { editor, doc } = editorWith([
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [
          marked(LATE, contradicted("late", LATE)),
          { type: "citation", attrs: { ...evidence("The terminal is run by the port.") } },
        ],
      },
    ]);
    edits.rewrite = "The terminal opened six months later than planned.";
    answerWith(editor, "supported");

    await fixSentence(editor, "mind", doc, claim(editor, "late"));

    const quotes: unknown[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "citation") quotes.push(node.attrs.quote);
    });
    expect(quotes).toEqual(["The terminal is run by the port."]);
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
