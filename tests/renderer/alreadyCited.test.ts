import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, test } from "vitest";
import {
  CITATION_NODE,
  type CitationAttributes,
  type ClaimCheckAttributes,
} from "../../src/core/api";
import { citationDecision } from "../../src/renderer/src/editor/alreadyCited";
import { citationNumbersPlugin } from "../../src/renderer/src/editor/citationNumbers";
import type { ShownClaim } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const schema = getSchema(noteExtensions());

const FIRST = "Staff may work from home two days a week.";
const SECOND = "Probation lasts three months.";
const LINE = "The Employee may work from home two days a week, agreed in advance with the manager.";

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

const state = (
  cited: Partial<CitationAttributes> | null,
  after: Partial<CitationAttributes> | null,
) =>
  EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            text(FIRST),
            ...(cited ? [{ type: CITATION_NODE, attrs: attributes(cited) }] : []),
            text(` ${SECOND}`),
            ...(after ? [{ type: CITATION_NODE, attrs: attributes(after) }] : []),
          ],
        },
      ],
    }),
    plugins: [citationNumbersPlugin()],
  });

function claimOf(
  sentence: { from: number; to: number },
  evidence: Partial<CitationAttributes> | null,
  over: Partial<ClaimCheckAttributes> = {},
  text = "",
): ShownClaim {
  const check = {
    id: "check-1",
    state: "supported",
    evidence: evidence ? attributes(evidence) : null,
    calculation: null,
    ...over,
  } as ClaimCheckAttributes;
  return {
    check,
    from: sentence.from,
    to: sentence.to,
    sentence: { ...sentence, text },
    shown: { state: "supported" },
  } as ShownClaim;
}

// The paragraph's content starts at 1; a Citation is one position.
const firstSentence = (cited: boolean) => ({ from: 1, to: 1 + FIRST.length + (cited ? 1 : 0) });

describe("a sentence that already cites what its check found", () => {
  test("is already cited whatever span the check quoted, the Citation numbered as the Mind numbers it", () => {
    const held = state({}, null);
    for (const quote of [LINE, "may work from home two days a week", "work from home two days"]) {
      const claim = claimOf(firstSentence(true), { quote });
      expect(citationDecision(held, claim)).toMatchObject({
        kind: "already",
        citation: { number: 1 },
      });
    }
  });

  test("is offered the Passage on another page, or another clause, or another Document", () => {
    const held = state({}, null);
    const sentence = firstSentence(true);
    expect(
      citationDecision(held, claimOf(sentence, { quote: LINE, pageFrom: 9, pageTo: 9 })).kind,
    ).toBe("add");
    expect(
      citationDecision(
        held,
        claimOf(sentence, { quote: "Probation lasts three months.", pageFrom: 3 }),
      ).kind,
    ).toBe("add");
    expect(
      citationDecision(held, claimOf(sentence, { documentId: "handbook", quote: LINE })).kind,
    ).toBe("add");
  });

  test("is offered it for a sentence with no Citation of its own, though the next sentence cites it", () => {
    const held = state(null, {});
    expect(citationDecision(held, claimOf(firstSentence(false), { quote: LINE })).kind).toBe("add");
  });

  test("is already cited by the one of several Citations that overlaps", () => {
    const held = state({ documentId: "handbook" }, {});
    const sentence = { from: 1, to: 1 + FIRST.length + 1 + 1 + SECOND.length + 1 };
    expect(citationDecision(held, claimOf(sentence, { quote: LINE }))).toMatchObject({
      kind: "already",
      citation: { number: 2 },
    });
    expect(
      citationDecision(held, claimOf(sentence, { documentId: "handbook", quote: LINE })),
    ).toMatchObject({ kind: "already", citation: { number: 1 } });
  });

  test("offers nothing for a figure worked out or a check that found nothing", () => {
    const held = state({}, null);
    expect(citationDecision(held, claimOf(firstSentence(true), null)).kind).toBe("none");
    const figure = claimOf(
      firstSentence(true),
      { quote: LINE },
      {
        calculation: {} as ClaimCheckAttributes["calculation"],
      },
    );
    expect(citationDecision(held, figure).kind).toBe("none");
  });
});

const CLAUSE_ZH = "员工每周最多可远程办公两天，须提前与经理商定。";

/** A paragraph of one sentence and its Citation, for a sentence in Chinese. */
const zhState = (sentence: string, cited: Partial<CitationAttributes>) =>
  EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [text(sentence), { type: CITATION_NODE, attrs: attributes(cited) }],
        },
      ],
    }),
    plugins: [citationNumbersPlugin()],
  });

describe("what a supported sentence's card offers for the Passage its check found", () => {
  const sentence = firstSentence(true);

  test("Widen the Citation when the clause goes on and the sentence says that more", () => {
    const held = state({ quote: "two days a week" }, null);
    expect(citationDecision(held, claimOf(sentence, { quote: LINE }, {}, LINE))).toMatchObject({
      kind: "widen",
      citation: { number: 1 },
      evidence: { quote: LINE },
    });
  });

  test("Already cited when the Passage says the same words, fewer, or more the sentence doesn't say", () => {
    const held = state({}, null);
    expect(citationDecision(held, claimOf(sentence, { quote: LINE }, {}, FIRST)).kind).toBe(
      "already",
    );
    expect(
      citationDecision(held, claimOf(sentence, { quote: "work from home two days" }, {}, LINE))
        .kind,
    ).toBe("already");
  });

  test("Replace the Citation when the one the sentence has doesn't hold and the check found the right Passage in that Document", () => {
    for (const check of ["not-found", "unsupported", "contradicted"] as const) {
      const held = state(
        { quote: SECOND, check, checkReason: check === "not-found" ? "quote-not-on-pages" : null },
        null,
      );
      expect(citationDecision(held, claimOf(sentence, { quote: LINE }))).toMatchObject({
        kind: "replace",
        citation: { number: 1 },
      });
    }
  });

  test("Replace the Citation that doesn't hold rather than widen it, even when the clause goes on", () => {
    const held = state({ check: "not-found", checkReason: "quote-not-on-pages" }, null);
    expect(citationDecision(held, claimOf(sentence, { quote: LINE }, {}, LINE))).toMatchObject({
      kind: "replace",
      citation: { number: 1 },
    });
  });

  test("replaces only with a Passage that holds the sentence's quoted words", () => {
    const asked = (text: string) => ({ answer: [{ text, found: false }], closest: null });
    const broken = (quotedWords: CitationAttributes["quotedWords"]) =>
      state({ check: "not-found", checkReason: "quoted-words-not-on-pages", quotedWords }, null);
    expect(
      citationDecision(broken(asked("two days a week")), claimOf(sentence, { quote: LINE })),
    ).toMatchObject({ kind: "replace", citation: { number: 1 } });
    expect(
      citationDecision(broken(asked("a notice period")), claimOf(sentence, { quote: LINE })).kind,
    ).toBe("already");
  });

  test("already has a valid Citation when a broken one overlaps the same words, and does not replace it", () => {
    const held = state({ check: "not-found", checkReason: "quote-not-on-pages" }, {});
    const both = { from: 1, to: 1 + FIRST.length + 1 + 1 + SECOND.length + 1 };
    expect(citationDecision(held, claimOf(both, { quote: LINE }))).toMatchObject({
      kind: "already",
      citation: { number: 2 },
    });
  });

  test("Add as Citation when the sentence's Citation holds, is in another Document, or there is none", () => {
    const held = state({ quote: SECOND }, null);
    expect(citationDecision(held, claimOf(sentence, { quote: LINE })).kind).toBe("add");
    const elsewhere = state(
      { quote: SECOND, documentId: "handbook", check: "not-found", checkReason: null },
      null,
    );
    expect(citationDecision(elsewhere, claimOf(sentence, { quote: LINE })).kind).toBe("add");
    expect(citationDecision(state(null, null), claimOf(sentence, { quote: LINE })).kind).toBe(
      "add",
    );
  });

  test("offers nothing for a figure worked out or a check that found nothing", () => {
    const held = state({}, null);
    expect(citationDecision(held, claimOf(sentence, null)).kind).toBe("none");
    const figure = claimOf(
      sentence,
      { quote: LINE },
      { calculation: {} as ClaimCheckAttributes["calculation"] },
    );
    expect(citationDecision(held, figure).kind).toBe("none");
  });

  test("in Chinese, with punctuation and width differences, widens a Citation whose quote is part of the clause", () => {
    const held = zhState(CLAUSE_ZH, { quote: "每周最多可远程办公两天" });
    const claim = claimOf(
      { from: 1, to: 1 + CLAUSE_ZH.length + 1 },
      { quote: "员工每周最多可远程办公两天,须提前与经理商定." },
      {},
      CLAUSE_ZH,
    );
    expect(citationDecision(held, claim)).toMatchObject({
      kind: "widen",
      citation: { number: 1 },
    });
  });
});
