import { getSchema, type JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
} from "../../src/core/api";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  opinionLocations,
  opinionSentenceRanges,
  opinionsIn,
} from "../../src/renderer/src/editor/opinionLocations";
import { writeOpinionSentences } from "../../src/shared/opinions";

const schema = getSchema(noteExtensions());
const part = (
  start: number,
  end: number,
  kind: ClaimCheckPart["kind"] = "opinion",
): ClaimCheckPart => ({
  span: { start, end },
  kind,
  verdict: kind === "opinion" ? null : "supported",
  evidence:
    kind === "opinion"
      ? []
      : [
          {
            passageId: "passage",
            documentId: "results",
            documentName: "Results",
            contentHash: "v1",
            quote: "Revenue rose 8%.",
            pageFrom: 1,
            pageTo: 1,
            location: null,
            check: "found",
            checkReason: null,
          },
        ],
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});
const paragraph = (id: string, text: string, check?: ClaimCheckAttributes): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [
    { type: "text", text, ...(check && { marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] }) },
  ],
});
const note = (...content: JSONContent[]) => schema.nodeFromJSON({ type: "doc", content });
const inventory = (text: string, blockId = "p", occurrence = 0, id = "opinion") => {
  const doc = new Y.Doc();
  writeOpinionSentences(doc, [{ id, text, blockId, occurrence, parts: [part(0, text.length)] }]);
  return doc;
};

describe("left-out opinions in the Note", () => {
  test.each([
    "We think the deal is risky.",
    "我们认为这笔交易风险很大。",
    "We think 🌱 is promising.",
  ])("selects the exact words after another sentence is inserted: %s", (text) => {
    const stored = inventory(text);
    const current = note(paragraph("p", `A separate statement. ${text}`));
    const [opinion] = opinionsIn(current, stored);
    expect(opinion).toBeDefined();
    expect(current.textBetween(opinion?.range.from ?? 0, opinion?.range.to ?? 0)).toBe(text);
    expect(opinion?.id).toBe("opinion");
  });

  test("uses block, exact words and occurrence rather than matching an identical sentence elsewhere", () => {
    const text = "We think the deal is risky.";
    const stored = inventory(text, "p", 1);
    const current = note(paragraph("other", text), paragraph("p", `${text} ${text}`));
    const opinions = opinionsIn(current, stored);
    expect(opinions).toHaveLength(1);
    const expected = opinionLocations(current).find(
      (each) => each.blockId === "p" && each.occurrence === 1,
    );
    expect(opinions[0]?.range).toEqual({ from: expected?.from, to: expected?.to });
    expect(opinionsIn(note(paragraph("p", text)), stored)).toEqual([]);
  });

  test("changed opinion words invalidate the old count and stop hiding a claim from health", () => {
    const text = "We think the deal is risky.";
    const stored = inventory(text);
    const before = note(paragraph("p", text));
    const health = (current: ReturnType<typeof note>) =>
      noteHealth(current, {
        claims: [],
        omitted: opinionSentenceRanges(current, stored),
        citationCheck: (citation) => citation.check,
      });
    expect(health(before).toCheck).toHaveLength(0);
    const after = note(paragraph("p", "We think the deal is safe."));
    expect(opinionsIn(after, stored)).toEqual([]);
    expect(health(after).toCheck).toHaveLength(1);
  });

  test("one mixed opinion counts once and remains separate from the sentence verdict", () => {
    const text = "Revenue rose 8%; we think the deal is risky.";
    const start = text.indexOf("we think");
    const parts = [part(0, start, "fact"), part(start, text.length)];
    const check: ClaimCheckAttributes = {
      id: "mixed",
      request: "r",
      action: "check-against-documents",
      state: "supported",
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
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
      checkedAt: "2026-10-28T20:00:00.000Z",
      parts,
    };
    const current = note(paragraph("p", text, check));
    const stored = new Y.Doc();
    const opinions = opinionsIn(current, stored);
    expect(opinions).toHaveLength(1);
    expect(current.textBetween(opinions[0]?.range.from ?? 0, opinions[0]?.range.to ?? 0)).toBe(
      "we think the deal is risky.",
    );
    expect(opinionSentenceRanges(current, stored)).toEqual([]);
    const claims = claimsOf(current, { versions: null, folderId: null, scope: null });
    const health = noteHealth(current, {
      claims: claims.claims,
      citationCheck: (citation) => citation.check,
    });
    expect(health.supported).toBe(1);
    expect(health.toCheck).toHaveLength(0);
  });
});
