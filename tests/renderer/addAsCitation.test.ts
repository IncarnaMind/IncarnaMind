import { type Editor, getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { describe, expect, test, vi } from "vitest";
import { CITATION_NODE, type CitationAttributes } from "../../src/core/api";
import {
  citationNumbersPlugin,
  numberedCitations,
} from "../../src/renderer/src/editor/citationNumbers";
import type { ShownClaim } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ resolveProposalsIn: vi.fn() }));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));

const { addAsCitation, replaceCitation, widenCitation } = await import(
  "../../src/renderer/src/checks"
);

const schema = getSchema(noteExtensions());

const SENTENCE = "Staff may work from home two days a week.";
const LINE = "The Employee may work from home two days a week, agreed in advance.";

const attributes = (over: Partial<CitationAttributes>): CitationAttributes => ({
  passageId: null,
  documentId: "contract",
  documentName: "Contract",
  contentHash: "v1",
  pageFrom: 2,
  pageTo: 2,
  location: null,
  quote: "may work from home two days a week",
  check: "found",
  checkReason: null,
  ...over,
});

const text = (value: string): JSONContent => ({ type: "text", text: value });

function editorHolding(cited: Partial<CitationAttributes> | null) {
  let state = EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            text(SENTENCE),
            ...(cited ? [{ type: CITATION_NODE, attrs: attributes(cited) }] : []),
          ],
        },
      ],
    }),
    plugins: [citationNumbersPlugin()],
  });
  const dispatched: Transaction[] = [];
  const editor = {
    get state() {
      return state;
    },
    view: {
      dispatch(tr: Transaction) {
        dispatched.push(tr);
        state = state.apply(tr);
      },
    },
  } as unknown as Editor;
  return { editor, dispatched };
}

const countCitations = (state: EditorState) => {
  let count = 0;
  state.doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) count++;
  });
  return count;
};

const claimFound = (evidence: Partial<CitationAttributes>): ShownClaim =>
  ({
    check: { id: "check-1", state: "supported", evidence: attributes(evidence), calculation: null },
    from: 1,
    to: 1 + SENTENCE.length,
    sentence: { from: 1, to: 1 + SENTENCE.length + 1, text: SENTENCE },
    shown: { state: "supported" },
  }) as unknown as ShownClaim;

describe("Add as Citation", () => {
  test("adds nothing when the sentence already cites those words, whatever span the check quoted", () => {
    const { editor, dispatched } = editorHolding({});
    expect(addAsCitation(editor, claimFound({ quote: LINE }))).toBe(false);
    expect(dispatched).toHaveLength(0);
    expect(countCitations(editor.state)).toBe(1);
  });

  test("adds the Passage as a second Citation when it is another clause of the Document", () => {
    const { editor, dispatched } = editorHolding({});
    const other = claimFound({ quote: "Probation lasts three months.", pageFrom: 3, pageTo: 3 });
    expect(addAsCitation(editor, other)).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(countCitations(editor.state)).toBe(2);
  });

  test("adds the first Citation to a sentence with none", () => {
    const { editor } = editorHolding(null);
    expect(addAsCitation(editor, claimFound({ quote: LINE }))).toBe(true);
    expect(countCitations(editor.state)).toBe(1);
  });

  test("adds nothing when the sentence's Citation doesn't hold and would be replaced", () => {
    const { editor } = editorHolding({ check: "not-found", checkReason: "quote-not-on-pages" });
    expect(addAsCitation(editor, claimFound({ quote: "Probation lasts three months." }))).toBe(
      false,
    );
    expect(countCitations(editor.state)).toBe(1);
  });
});

const onlyCitation = (state: EditorState) => {
  const [citation] = numberedCitations(state);
  if (!citation) throw new Error("No Citation.");
  return citation;
};

const foundEvidence = (over: Partial<CitationAttributes>) => {
  const evidence = claimFound(over).check.evidence;
  if (!evidence) throw new Error("The check found nothing.");
  return evidence;
};

const QUOTED_WORDS: CitationAttributes["quotedWords"] = {
  answer: [{ text: "three months", found: false }],
  closest: null,
};

describe("Widen the Citation and Replace the Citation", () => {
  test("widening keeps the one Citation and takes the clause's Passage, words, Place and version", () => {
    const { editor } = editorHolding({
      passageId: "passage-OLD",
      verdict: "The contract says two days a week, p. 2",
      quotedWords: QUOTED_WORDS,
    });
    expect(
      widenCitation(editor, {
        citation: onlyCitation(editor.state),
        evidence: foundEvidence({
          passageId: "passage-NEW",
          quote: LINE,
          pageFrom: 5,
          pageTo: 5,
          location: { kind: "page", from: 5, to: 5 },
          contentHash: "v2",
        }),
      }),
    ).toBe(true);
    expect(countCitations(editor.state)).toBe(1);
    expect(onlyCitation(editor.state).attributes).toMatchObject({
      passageId: "passage-NEW",
      documentId: "contract",
      quote: LINE,
      pageFrom: 5,
      pageTo: 5,
      location: { kind: "page", from: 5, to: 5 },
      contentHash: "v2",
      check: "found",
      checkReason: null,
      verdict: null,
      quotedWords: null,
    });
  });

  test("replacing keeps the one Citation, points it at the Passage the check found, and clears the old verdict", () => {
    const { editor } = editorHolding({
      passageId: "passage-OLD",
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
      verdict: "The contract says three months, p. 2",
      quotedWords: QUOTED_WORDS,
    });
    expect(
      replaceCitation(editor, {
        citation: onlyCitation(editor.state),
        evidence: foundEvidence({
          passageId: "passage-NEW",
          quote: "Probation lasts three months.",
          pageFrom: 6,
          pageTo: 6,
          location: { kind: "page", from: 6, to: 6 },
          contentHash: "v3",
        }),
      }),
    ).toBe(true);
    expect(countCitations(editor.state)).toBe(1);
    expect(onlyCitation(editor.state).attributes).toMatchObject({
      passageId: "passage-NEW",
      documentId: "contract",
      quote: "Probation lasts three months.",
      pageFrom: 6,
      pageTo: 6,
      location: { kind: "page", from: 6, to: 6 },
      contentHash: "v3",
      check: "found",
      checkReason: null,
      verdict: null,
      quotedWords: QUOTED_WORDS,
    });
  });

  test("does not replace with a Passage that doesn't hold the sentence's quoted words", () => {
    const { editor } = editorHolding({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
      quotedWords: { answer: [{ text: "agreed in advance", found: false }], closest: null },
    });
    expect(
      replaceCitation(editor, {
        citation: onlyCitation(editor.state),
        evidence: foundEvidence({ quote: "Probation lasts three months." }),
      }),
    ).toBe(false);
    expect(onlyCitation(editor.state).attributes).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
    });
  });
});
