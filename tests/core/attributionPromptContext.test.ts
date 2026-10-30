import { describe, expect, test } from "vitest";
import { claimPrompt } from "../../src/core/answers/checks/prompt";
import type { ClaimPartPlan } from "../../src/core/api";

const A = "daffb511-3924-4b93-b869-7505c1ec974b";
const B = "50284d59-31ad-45a2-9540-20f9b07f09b4";
const CASES = [
  {
    language: "en",
    name: "Atlas",
    prefix: "According to Atlas",
    fact: "Nora lives in Oslo",
    join: ", ",
    between: "; ",
    end: ".",
  },
  {
    language: "zh-CN",
    name: "登记册",
    prefix: "据登记册",
    fact: "诺拉住在奥斯陆",
    join: "，",
    between: "；",
    end: "。",
  },
] as const;

describe.each(CASES)("$language ordinary target position in full Source context", (row) => {
  const clause = `${row.prefix}${row.join}${row.fact}`;
  const original = [clause, clause, clause].join(row.between) + row.end;
  const starts = [0, clause.length + row.between.length, (clause.length + row.between.length) * 2];
  const sources: ClaimPartPlan[] = starts.map((start, index) => ({
    kind: "fact",
    span: { start, end: start + row.prefix.length },
    facet: { kind: "source", selectedDocumentId: index === 1 ? B : A },
  }));
  const parts: ClaimPartPlan[] = starts.map((start) => ({
    kind: "fact",
    span: { start: start + row.prefix.length + row.join.length, end: start + clause.length },
  }));
  const input = {
    claim: row.fact,
    originalClaim: original,
    context: original,
    sourceContext: sources,
    sourceDocuments: [
      { id: A, name: row.name },
      { id: B, name: row.name },
    ],
    language: row.language,
    checkedAt: "2026-10-30T12:00:00.000Z",
  };

  test("identical second and third facts preserve their active exact span and words", () => {
    const second = parts[1];
    const third = parts[2];
    if (!second || !third) throw new Error("Both repeated ordinary targets are required.");
    const secondPrompt = claimPrompt({ ...input, parts: [second] });
    const thirdPrompt = claimPrompt({ ...input, parts: [third] });
    expect(secondPrompt).not.toBe(thirdPrompt);
    for (const [prompt, own, other] of [
      [secondPrompt, second, third],
      [thirdPrompt, third, second],
    ] as const) {
      expect(prompt).toContain(`"span":${JSON.stringify(own.span)}`);
      expect(prompt).toContain(`"text":${JSON.stringify(row.fact)}`);
      expect(prompt).not.toContain(`"span":${JSON.stringify(other.span)}`);
      expect(prompt).toContain(original);
      expect(prompt).toContain(A);
      expect(prompt).toContain(B);
    }
  });

  test("a whole ordinary sentence keeps its current prompt unchanged", () => {
    const plain = { claim: row.fact, language: row.language };
    expect(
      claimPrompt({
        ...plain,
        originalClaim: row.fact,
        parts: [{ kind: "fact", span: { start: 0, end: row.fact.length } }],
      }),
    ).toBe(claimPrompt(plain));
  });

  test("unavailable Source choices never gain invented document tokens or names", () => {
    const prompt = claimPrompt({ ...input, parts: parts.slice(1, 2), sourceDocuments: [] });
    expect(prompt).toContain(original);
    expect(prompt).not.toContain(A);
    expect(prompt).not.toContain(B);
    expect(prompt).not.toContain('"documentName":');
    expect(prompt).not.toContain("<source-choices>");
  });
});
