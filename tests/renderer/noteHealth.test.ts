import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import { CITATION_NODE, type CitationAttributes } from "../../src/core/api";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import {
  HEALTH_PARTS,
  type HealthPart,
  noteHealth,
} from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { sentenceKey } from "../../src/shared/mindCheck";
import { checked } from "../helpers/claimChecks";

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

const docOf = (...blocks: JSONContent[]) => schema.nodeFromJSON({ type: "doc", content: blocks });

/** The Mind's health as its header counts it, part by part. */
function healthOf(doc: ProseMirrorNode): Record<HealthPart, number> {
  const { claims, kept } = claimsOf(doc, { versions: null, folderId: null, scope: null });
  const health = noteHealth(doc, claims, (attributes) => attributes.check, kept);
  return Object.fromEntries(HEALTH_PARTS.map((part) => [part, health[part].length])) as Record<
    HealthPart,
    number
  >;
}

/**
 * The sentences "not checked yet": claims with no check that have a Citation or that an Answer
 * wrote (the blocks with the ids in `answered`), but not those the last whole-Mind check found make none.
 */
function uncheckedIn(
  doc: ProseMirrorNode,
  skipped: readonly string[] = [],
  answered: readonly string[] = [],
): number {
  const { claims, kept } = claimsOf(doc, { versions: null, folderId: null, scope: null });
  return noteHealth(
    doc,
    claims,
    (attributes) => attributes.check,
    new Set([...skipped, ...kept]),
    (blockId) => typeof blockId === "string" && answered.includes(blockId),
  ).unchecked.length;
}

const NOTHING = {
  found: 0,
  notFound: 0,
  unsupported: 0,
  contradicted: 0,
  noCitation: 0,
  recheck: 0,
  notChecked: 0,
};

describe("A Mind's health", () => {
  test("counts its Citations, and its sentences checked or with no Citation, as the design's paper", () => {
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

    expect(healthOf(doc)).toEqual({
      ...NOTHING,
      found: 1,
      unsupported: 1,
      contradicted: 1,
      noCitation: 3,
    });
  });

  test("counts Citations not found, and checks that need a re-check or weren't made", () => {
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

    expect(healthOf(doc)).toEqual({ ...NOTHING, notFound: 1, notChecked: 1, recheck: 1 });
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

    expect(healthOf(doc)).toEqual({
      ...NOTHING,
      found: 2,
      notFound: 3,
      unsupported: 1,
      contradicted: 1,
      notChecked: 1,
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

    expect(healthOf(doc)).toEqual({ ...NOTHING, noCitation: 1 });
  });

  // protects=a sentence the User keeps as their own view (#1111) counts as nothing to fix and isn't one to check, while its Citation still counts, until its words change; fails_when=it counts unsupported or unchecked, or its Citation stops counting; no_claim=how the card sets it.
  test("leaves out a sentence kept as the User's own view, its Citation still counted, until it is edited", () => {
    const sentence = "Online sales grew 12% in the quarter.";
    const kept = checked(sentence, "unsupported", null, { kept: true });
    const doc = docOf(paragraph(kept, citation("found")));
    const edited = docOf(paragraph({ ...kept, text: "Online sales grew 15% in the quarter." }));

    expect(healthOf(doc)).toEqual({ ...NOTHING, found: 1 });
    expect(uncheckedIn(doc)).toBe(0);
    expect(healthOf(edited)).toEqual({ ...NOTHING, recheck: 1 });
  });

  test("follows the User's edits: a Citation added to a sentence counts it found", () => {
    const before = docOf(paragraph(text("Spring tides come at full moon.")));
    const after = docOf(
      paragraph(text("Spring tides come at full moon "), citation("found"), text(".")),
    );

    expect(healthOf(before)).toEqual({ ...NOTHING, noCitation: 1 });
    expect(healthOf(after)).toEqual({ ...NOTHING, found: 1 });
  });

  test("knows which claims were never checked: those with a Citation or an Answer wrote, not plain notes, those checked, short ones, or those the last whole-Mind check found make no claim (#737)", () => {
    const opinion = "We think the tides are lovely in spring.";
    const doc = docOf(
      paragraph(checked("Spring tides come at full moon.", "supported")),
      paragraph(text("Neap tides come at the quarter moons "), citation("found"), text(". ")),
      { type: "paragraph", attrs: { id: "answer" }, content: [text(opinion)] },
      paragraph(text("The harbour master thinks the tides are lovely in spring.")),
      paragraph(text("Thanks!")),
      heading("A heading that claims a lot about tides"),
    );

    expect(uncheckedIn(doc, [], ["answer"])).toBe(2);
    expect(uncheckedIn(doc, [sentenceKey(opinion)], ["answer"])).toBe(1);
    // Without an Answer's text, only the cited claim is one to check.
    expect(uncheckedIn(doc)).toBe(1);
  });

  test("a sentence is in one part only: a plain claim has no Citation, a cited or Answer-written one is not checked yet", () => {
    const doc = docOf(
      paragraph(text("Spring tides come at full moon.")),
      paragraph(text("Neap tides come at the quarter moons "), citation("found"), text(".")),
      {
        type: "paragraph",
        attrs: { id: "answer" },
        content: [text("The harbour master thinks the tides are lovely in spring.")],
      },
    );
    const { claims, kept } = claimsOf(doc, { versions: null, folderId: null, scope: null });
    const health = noteHealth(
      doc,
      claims,
      (attributes) => attributes.check,
      kept,
      (blockId) => blockId === "answer",
    );

    expect(health.unchecked).toHaveLength(2);
    expect(health.noCitation).toHaveLength(1);
    for (const at of health.unchecked) expect(health.noCitation).not.toContain(at);
  });
});
