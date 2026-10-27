import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import {
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
} from "../../src/core/api";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import {
  HEALTH_PARTS,
  type HealthPart,
  healthSummary,
  type NoteHealth,
  noteHealth,
} from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import type { KeptMark } from "../../src/shared/claimChecks";
import { sentenceKey } from "../../src/shared/mindCheck";

const schema = getSchema(noteExtensions());

const text = (value: string, ...marks: JSONContent["marks"][]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks: marks.flatMap((each) => each ?? []) }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const heading = (value: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [text(value)],
});
const citation = (check: CitationAttributes["check"]): JSONContent => ({
  type: CITATION_NODE,
  attrs: { documentId: "results", documentName: "Q3 results", quote: "38.6%", check },
});
const table = (...cells: JSONContent[]): JSONContent => ({
  type: "table",
  content: [
    {
      type: "tableRow",
      content: cells.map((cell) => ({ type: "tableCell", content: [cell] })),
    },
  ],
});

/** A sentence's check, as its mark holds it. */
function checked(
  sentence: string,
  state: ClaimCheckAttributes["state"],
  reason: ClaimCheckAttributes["reason"] = null,
  more: Partial<ClaimCheckAttributes> = {},
): JSONContent {
  const check: ClaimCheckAttributes = {
    id: `check-${sentence.length}-${state}`,
    request: "r1",
    action: "check-against-documents",
    state,
    reason,
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
    versions: [],
    excluded: [],
    checkedAt: "2026-10-12T09:00:00.000Z",
    ...more,
  };
  return text(sentence, [{ type: CLAIM_CHECK_MARK, attrs: check }]);
}

const docOf = (...blocks: JSONContent[]) => schema.nodeFromJSON({ type: "doc", content: blocks });

/** The Mind's health as its header counts it. */
function healthOf(
  doc: ProseMirrorNode,
  { skipped = [], kept }: { skipped?: readonly string[]; kept?: readonly KeptMark[] } = {},
): NoteHealth {
  const claims = claimsOf(doc, { versions: null, folderId: null, scope: null });
  return noteHealth(doc, {
    claims: claims.claims,
    citationCheck: (attributes) => attributes.check,
    skipped: new Set(skipped),
    kept: kept ?? claims.kept,
  });
}

const parts = (health: NoteHealth): Record<HealthPart, number> =>
  Object.fromEntries(HEALTH_PARTS.map((part) => [part, health[part].length])) as Record<
    HealthPart,
    number
  >;

const NOTHING = {
  found: 0,
  notFound: 0,
  unsupported: 0,
  contradicted: 0,
  toCheck: 0,
  noCitation: 0,
};

describe("A Mind's health", () => {
  test("counts its Citations, and its claims: every one no check covers is to check, whatever its Citation (#1909)", () => {
    const doc = docOf(
      heading("Recommendation"),
      paragraph(
        text("Hold the facility at its current limit and ask Northwind for a margin report."),
      ),
      heading("Why"),
      paragraph(checked("Northwind's gross margin fell from 41.8% to 38.6% in Q3.", "supported")),
      paragraph(
        text("Net leverage was 3.1× at the end of the quarter, "),
        citation("found"),
        text(" inside the 3.5× limit in clause 7.1."),
      ),
      paragraph(
        checked("Online sales grew 12% in the quarter.", "unsupported"),
        text(" "),
        checked("The facilities end in 2027, so refinancing is the first risk.", "contradicted"),
      ),
      paragraph(text("Calder Grocers needed a covenant waiver in September.")),
    );

    expect(parts(healthOf(doc))).toEqual({
      ...NOTHING,
      found: 1,
      unsupported: 1,
      contradicted: 1,
      toCheck: 3,
      noCitation: 1,
    });
  });

  test("a check that failed or no longer holds is not checked yet (#1909)", () => {
    const doc = docOf(
      paragraph(text("The quote isn't on the page it cites "), citation("not-found"), text(".")),
      paragraph(
        checked("The rate limit stopped this sentence's check.", "not-checked", "rate-limit"),
      ),
      paragraph(
        // Edited since it was checked: its mark holds the text it was checked as.
        text("Edited: "),
        {
          ...checked("Online sales grew 12% in the quarter.", "supported"),
          text: "Online sales grew 15% in the quarter.",
        },
      ),
    );

    const health = healthOf(doc);
    expect(parts(health)).toEqual({ ...NOTHING, notFound: 1, toCheck: 3 });
    expect(health.checkable).toBe(3);
  });

  test("a failed check on a plain note is a claim to check, as a plain note with no check is (#1909)", () => {
    const failed = docOf(
      paragraph(
        checked("The rate limit stopped this sentence's check.", "not-checked", "rate-limit"),
      ),
    );
    expect(healthOf(failed).toCheck).toHaveLength(1);
    const plain = docOf(paragraph(text("Spring tides come at full moon.")));
    expect(healthOf(plain).toCheck).toHaveLength(1);
  });

  // protects=a Citation's state shows only on its marker, so every Citation is counted and reachable, in sentences with a verdict too; fails_when=a Citation in an unsupported, contradicted or unchecked sentence stops counting, or such a sentence also counts as having no Citation; no_claim=how the card sets it.
  test("counts every Citation, also those in a sentence with a verdict of its own", () => {
    const doc = docOf(
      paragraph(
        checked("Online sales grew 12% in the quarter.", "unsupported"),
        citation("not-found"),
        citation("not-found"),
        citation("found"),
        text(" "),
        checked("The facilities end in 2027, so refinancing is the first risk.", "contradicted"),
        citation("not-found"),
      ),
      paragraph(
        checked("The rate limit stopped this sentence's check.", "not-checked", "rate-limit"),
        citation("found"),
      ),
    );

    expect(parts(healthOf(doc))).toEqual({
      ...NOTHING,
      found: 2,
      notFound: 3,
      unsupported: 1,
      contradicted: 1,
      toCheck: 1,
    });
  });

  test("leaves out changes still waiting, Questions, headings and short lines", () => {
    const change = { id: "c1", request: "r1", target: "x" };
    const doc = docOf(
      paragraph(text("The tides are strong at full moon."), {
        ...text(" A sentence the AI would add, with its Citation"),
        marks: [{ type: "proposalInsert", attrs: change }],
      }),
      {
        type: "paragraph",
        attrs: { proposal: { ...change, id: "c2", kind: "insert" } },
        content: [text("A whole paragraph the AI would add, still waiting.")],
      },
      { type: "question", content: [text("What makes the tides strong?")] },
      heading("A heading that claims a lot about tides"),
      paragraph(text("Thanks!")),
    );

    expect(parts(healthOf(doc))).toEqual({ ...NOTHING, toCheck: 1 });
  });

  // protects=a sentence the User keeps as their own view (#1111) counts as nothing to fix and isn't one to check, while its Citation still counts, until its words change; fails_when=it counts to check, or its Citation stops counting; no_claim=how the card sets it.
  test("leaves out a sentence kept as the User's own view, its Citation still counted, until it is edited", () => {
    const sentence = "Online sales grew 12% in the quarter.";
    const kept = checked(sentence, "unsupported", null, { kept: true });
    const doc = docOf(paragraph(kept, citation("found")));
    const edited = docOf(paragraph({ ...kept, text: "Online sales grew 15% in the quarter." }));

    expect(parts(healthOf(doc))).toEqual({ ...NOTHING, found: 1 });
    expect(healthOf(doc).toCheck).toHaveLength(0);
    expect(parts(healthOf(edited))).toEqual({ ...NOTHING, toCheck: 1 });
  });

  test("follows the User's edits: a Citation added to a sentence counts it found", () => {
    const before = docOf(paragraph(text("Spring tides come at full moon.")));
    const after = docOf(
      paragraph(text("Spring tides come at full moon "), citation("found"), text(".")),
    );

    expect(parts(healthOf(before))).toEqual({ ...NOTHING, toCheck: 1 });
    expect(parts(healthOf(after))).toEqual({ ...NOTHING, found: 1, toCheck: 1 });
  });

  test("counts the claims a check reads, and those the last whole-Mind check found make no claim (#737, #1909)", () => {
    const opinion = "We think the tides are lovely in spring.";
    const doc = docOf(
      paragraph(checked("Spring tides come at full moon.", "supported")),
      paragraph(text("Neap tides come at the quarter moons "), citation("found"), text(". ")),
      { type: "paragraph", attrs: { id: "answer" }, content: [text(opinion)] },
      paragraph(text("The harbour master thinks the tides are lovely in spring.")),
      paragraph(text("Thanks!")),
      heading("A heading that claims a lot about tides"),
    );

    expect(healthOf(doc).toCheck).toHaveLength(3);
    expect(healthOf(doc, { skipped: [sentenceKey(opinion)] }).toCheck).toHaveLength(2);
  });

  test("a sentence is in one part only: a claim with a Citation or no Citation is counted once", () => {
    const doc = docOf(
      paragraph(checked("Spring tides come at full moon.", "supported")),
      paragraph(text("Neap tides come at the quarter moons "), citation("found"), text(".")),
      {
        type: "paragraph",
        attrs: { id: "answer" },
        content: [text("The harbour master thinks the tides are lovely in spring.")],
      },
    );
    const health = healthOf(doc);

    expect(health.toCheck).toHaveLength(2);
    expect(health.noCitation).toHaveLength(1);
    for (const at of health.toCheck) expect(health.noCitation).not.toContain(at);
  });

  test("a kept sentence's same words elsewhere don't hide a contradicted mark (#1909)", () => {
    const sentence = "Online sales grew 12% in the quarter.";
    const doc = docOf(
      paragraph(checked(sentence, "unsupported", null, { kept: true })),
      paragraph(checked(sentence, "contradicted")),
    );
    const health = healthOf(doc);
    expect(parts(health)).toEqual({ ...NOTHING, contradicted: 1 });
    expect(health.toCheck).toHaveLength(0);
    expect(health.kept).toHaveLength(1);
    expect(healthSummary(health, { running: false, problem: false, unread: 0 })).toMatchObject({
      kind: "left",
    });
  });

  test("a shown verdict counts before isClaim: a contradicted figure in a table cell and a contradicted short line (#1909)", () => {
    const cell = docOf(table(paragraph(checked("100", "contradicted"))));
    expect(parts(healthOf(cell))).toEqual({ ...NOTHING, contradicted: 1 });
    expect(healthOf(cell).checkable).toBe(1);
    const short = docOf(paragraph(checked("Next steps", "contradicted")));
    expect(parts(healthOf(short))).toEqual({ ...NOTHING, contradicted: 1 });
    const figure = docOf(paragraph(checked("38.6%", "unsupported")));
    expect(parts(healthOf(figure))).toEqual({ ...NOTHING, unsupported: 1 });
  });

  test("a sentence the last whole-Mind check skipped and a later check marked still counts (#1909)", () => {
    const sentence = "Spring tides come at full moon.";
    const doc = docOf(paragraph(checked(sentence, "not-checked", "failed")));
    const health = healthOf(doc, { skipped: [sentenceKey(sentence)] });
    expect(parts(health)).toEqual({ ...NOTHING, toCheck: 1 });
    expect(health.failed).toHaveLength(1);
  });

  test("the card says everything is checked only with nothing left, a claim with no Citation too (#1909, #1941, D266)", () => {
    const cited = healthOf(
      docOf(paragraph(checked("Spring tides come at full moon.", "supported"), citation("found"))),
    );
    expect(healthSummary(cited, { running: false, problem: false, unread: 0 })).toEqual({
      kind: "all",
    });
    expect(cited.checkedAt).toBe("2026-10-12T09:00:00.000Z");
    expect(healthSummary(cited, { running: true, problem: false, unread: 0 })).toBeNull();
    expect(healthSummary(cited, { running: false, problem: true, unread: 0 })).toBeNull();
    // A narrowed check that couldn't read a file keeps the note's state amber (D266).
    expect(healthSummary(cited, { running: false, problem: false, unread: 1 })).toBeNull();
    const uncited = healthOf(
      docOf(paragraph(checked("Spring tides come at full moon.", "supported"))),
    );
    expect(healthSummary(uncited, { running: false, problem: false, unread: 0 })).toEqual({
      kind: "left",
      summary: {
        supported: 1,
        look: { claims: 0, contradicted: 0, unsupported: 0, notFound: 0 },
        toCheck: 0,
        noCitation: 1,
      },
    });
  });

  // The failing case a note with one Citation and three claims without one showed: "1 Citation
  // found · 3 with no Citation · Everything checked" (#1941).
  test("a note with one Citation and three claims without one names the three as still to cite (#1941)", () => {
    const health = healthOf(
      docOf(
        paragraph(checked("Spring tides come at full moon.", "supported"), citation("found")),
        paragraph(checked("Neap tides come at the quarter moons.", "supported")),
        paragraph(checked("The tides follow the moon's pull.", "supported")),
        paragraph(checked("The harbour master watches the tides.", "supported")),
      ),
    );

    expect(health.supported).toBe(4);
    expect(health.noCitation).toHaveLength(3);
    expect(healthSummary(health, { running: false, problem: false, unread: 0 })).toEqual({
      kind: "left",
      summary: {
        supported: 4,
        look: { claims: 0, contradicted: 0, unsupported: 0, notFound: 0 },
        toCheck: 0,
        noCitation: 3,
      },
    });
  });

  test("the card's summary counts what its rows show: supported, what needs a look by reason, and what is left (#1941)", () => {
    const health = healthOf(
      docOf(
        paragraph(checked("Spring tides come at full moon.", "supported"), citation("found")),
        paragraph(checked("Online sales grew 12% in the quarter.", "unsupported")),
        paragraph(
          checked("The facilities end in 2027, so refinancing is the first risk.", "contradicted"),
        ),
        paragraph(text("The quote isn't on the page it cites "), citation("not-found"), text(".")),
        paragraph(checked("Neap tides come at the quarter moons.", "supported")),
      ),
    );

    expect(healthSummary(health, { running: false, problem: false, unread: 0 })).toEqual({
      kind: "left",
      summary: {
        supported: 2,
        look: { claims: 2, contradicted: 1, unsupported: 1, notFound: 0 },
        toCheck: 1,
        noCitation: 1,
      },
    });
  });

  // A claim with two missing Citations, and a claim with a verdict problem and a missing
  // Citation: the headline counts claims, once each, and the reason counts the Citations.
  test("the Needs-a-look headline counts claims once and names the Citations in its reason (#1941)", () => {
    const twice = healthOf(
      docOf(
        paragraph(
          checked("Spring tides come at full moon.", "supported"),
          citation("not-found"),
          citation("not-found"),
        ),
      ),
    );
    expect(healthSummary(twice, { running: false, problem: false, unread: 0 })).toMatchObject({
      kind: "left",
      summary: {
        supported: 1,
        look: { claims: 1, contradicted: 0, unsupported: 0, notFound: 2 },
      },
    });

    const both = healthOf(
      docOf(
        paragraph(
          checked("Online sales grew 12% in the quarter.", "unsupported"),
          citation("not-found"),
        ),
      ),
    );
    expect(healthSummary(both, { running: false, problem: false, unread: 0 })).toMatchObject({
      kind: "left",
      summary: {
        supported: 0,
        look: { claims: 1, contradicted: 0, unsupported: 1, notFound: 1 },
      },
    });
  });

  test("says nothing about a check with nothing to read, or one that runs or shows a problem (#1915, #1941)", () => {
    const empty = healthOf(docOf(paragraph(text("Thanks!"))));
    expect(healthSummary(empty, { running: false, problem: false, unread: 0 })).toBeNull();
    const checking = healthOf(
      docOf(paragraph(checked("Spring tides come at full moon.", "checking"))),
    );
    expect(parts(checking)).toEqual(NOTHING);
    expect(checking.checkable).toBe(1);
    expect(checking.checking).toHaveLength(1);
    expect(checking.toCheck).toHaveLength(0);
    expect(healthSummary(checking, { running: false, problem: false, unread: 0 })).toBeNull();
  });

  test("counts a table cell's claim, on its own line (#1909)", () => {
    const doc = docOf(
      table(
        paragraph(text("Revenue, LTM, was strong")),
        paragraph(text("Net leverage was 2.4× at the end of the quarter")),
      ),
    );
    const health = healthOf(doc);

    expect(health.toCheck).toHaveLength(2);
    expect(health.tableCells).toEqual(health.toCheck);
  });
});
