import { describe, expect, test } from "vitest";
import type { CitationAttributes, ClaimCheckPart } from "../../src/core/api";
import { pendingPart, readClaimFacet, readPartPlans } from "../../src/shared/claimParts";
import { namePartCitations } from "../../src/shared/signOffs";

const documentId = "b4d3eb25-b511-48d6-b49f-0f964dd62755";
const citationId = "47f1e019-0148-4f73-9c6b-f87e659db10d";

describe("A source part's display references", () => {
  test.each([
    ["According to Residents, Nora lives in Oslo.", "According to Residents", "Residents"],
    ["据居民记录，诺拉住在奥斯陆。", "据居民记录", "居民记录"],
  ])("keeps the exact named words as offsets: %s", (text, prefix, name) => {
    const start = text.indexOf(name);
    const facet = {
      kind: "source",
      named: { start, end: start + name.length },
      candidates: [{ documentId, citationId }],
      selectedDocumentId: documentId,
    };
    const plans = [{ kind: "fact", span: { start: 0, end: prefix.length }, facet }];
    const read = readPartPlans(JSON.parse(JSON.stringify(plans)), text);
    expect(read).toEqual(plans);
    const source = read?.[0]?.facet;
    if (source?.kind !== "source" || !source.named) throw new Error("No named-source range.");
    expect(text.slice(source.named.start, source.named.end)).toBe(name);
    expect(JSON.stringify(source)).not.toContain(name);
  });

  test.each([
    { named: { start: -1, end: 5 } },
    { named: { start: 5, end: 5 } },
    { named: { start: 0.5, end: 4 } },
    { named: { start: 0, end: 4, text: "Name" } },
    { candidates: [{ documentId }] },
    { named: { start: 0, end: 4 }, candidates: [{ documentId: "title" }] },
    { named: { start: 0, end: 4 }, candidates: [{ documentId, citationId: "marker-1" }] },
    { named: { start: 0, end: 4 }, candidates: [{ documentId }, { documentId }] },
    { named: { start: 0, end: 4 }, candidates: [{ documentId, period: "2024" }] },
  ])("rejects malformed metadata instead of dropping it", (fields) => {
    expect(readClaimFacet({ kind: "source", ...fields })).toBeNull();
  });

  test.each([
    { start: 0, end: 5 },
    { start: 5, end: 12 },
    { start: 6, end: 7 },
  ])("rejects a label outside its own part or inside an atom", (named) => {
    expect(
      readPartPlans(
        [{ kind: "fact", span: { start: 5, end: 11 }, facet: { kind: "source", named } }],
        "From 𝑁ora, rate 5%.",
      ),
    ).toBeNull();
  });

  const receipt: CitationAttributes = {
    id: citationId,
    documentId,
    documentName: "Residents",
    contentHash: "version-one",
    passageId: "passage",
    pageFrom: null,
    pageTo: null,
    location: null,
    quote: "As at March 2024, Nora lives in Oslo.",
    check: "found",
    checkReason: null,
  };
  const source = (evidence: CitationAttributes[]): ClaimCheckPart => ({
    ...pendingPart({
      span: { start: 0, end: 21 },
      kind: "fact",
      facet: {
        kind: "source",
        named: { start: 13, end: 21 },
        candidates: [{ documentId, citationId }],
      },
    }),
    verdict: "supported",
    evidence,
  });

  test("candidate references follow the canonical Citation id on copy and recheck", () => {
    const first = namePartCitations([source([receipt])]);
    const one = first[0];
    if (one?.facet?.kind !== "source") throw new Error("No source row.");
    const id = one.evidence[0]?.id;
    expect(id).toBeTypeOf("string");
    expect(id).not.toBe(citationId);
    expect(one.facet.candidates).toEqual([{ documentId, citationId: id }]);
    expect(namePartCitations([source([receipt])], first)).toEqual(first);
    const copy = namePartCitations(first)[0];
    if (copy?.facet?.kind !== "source") throw new Error("No copied source row.");
    expect(copy.evidence[0]?.id).not.toBe(id);
    expect(copy.facet.candidates).toEqual([{ documentId, citationId: copy.evidence[0]?.id }]);
  });

  test.each([
    { evidence: [] },
    { evidence: [{ ...receipt, check: "not-found" as const }] },
    { evidence: [{ ...receipt, documentId: crypto.randomUUID() }] },
    { evidence: [receipt, { ...receipt, quote: "Another period is stated here." }] },
  ])("does not invent a candidate receipt from absent or ambiguous evidence", ({ evidence }) => {
    const row = namePartCitations([source(evidence)])[0];
    if (row?.facet?.kind !== "source") throw new Error("No source row.");
    expect(row.facet.candidates).toEqual([{ documentId }]);
  });
});
