import { describe, expect, test } from "vitest";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import type { ClaimPartPlan } from "../../src/core/api";
import { checkWithParts } from "../../src/shared/claimParts";
import { listedSentences, requestedFigures, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { manualClock } from "../helpers/core";
import { writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

type Scenario = {
  language: "en" | "zh-CN";
  claim: string;
  facets: {
    text: string;
    kind: "source" | "speaker" | "time";
    citation?: number;
    sourceName?: string;
  }[];
  facts: { text: string; quote: string; source: string }[];
  remainder?: { text: string; verdict: "supported" | "unsupported"; citation: number };
};

const CASES: Scenario[] = [
  {
    language: "en",
    claim: "According to Residents, Nora lives in Oslo.",
    facets: [{ text: "According to Residents", kind: "source", sourceName: "Residents" }],
    facts: [
      {
        text: "Nora lives in Oslo.",
        quote: "In 2026, Nora lives in Oslo.",
        source: "Residents.md",
      },
    ],
  },
  {
    language: "zh-CN",
    claim: "据居民记录，诺拉住在奥斯陆。",
    facets: [{ text: "据居民记录", kind: "source", sourceName: "居民记录" }],
    facts: [{ text: "诺拉住在奥斯陆。", quote: "2026年，诺拉住在奥斯陆。", source: "居民记录.md" }],
  },
  {
    language: "en",
    claim: "Currently, Nora lives in Oslo.",
    facets: [{ text: "Currently", kind: "time" }],
    facts: [
      {
        text: "Nora lives in Oslo.",
        quote: "In 2026, Nora lives in Oslo.",
        source: "Residents.md",
      },
    ],
  },
  {
    language: "zh-CN",
    claim: "目前，诺拉住在奥斯陆。",
    facets: [{ text: "目前", kind: "time" }],
    facts: [{ text: "诺拉住在奥斯陆。", quote: "2026年，诺拉住在奥斯陆。", source: "居民记录.md" }],
  },
];

function plansFor(row: Scenario): ClaimPartPlan[] {
  return [
    ...row.facets.map(
      ({ text, kind }): ClaimPartPlan => ({
        kind: "fact",
        span: { start: row.claim.indexOf(text), end: row.claim.indexOf(text) + text.length },
        facet: { kind },
      }),
    ),
    ...row.facts.map(
      ({ text }): ClaimPartPlan => ({
        kind: "fact",
        span: { start: row.claim.indexOf(text), end: row.claim.indexOf(text) + text.length },
      }),
    ),
  ].sort((a, b) => a.span.start - b.span.start);
}

async function setUp(row: Scenario, plans: ClaimPartPlan[] = plansFor(row)) {
  const frames: ModelCall[] = [];
  let omitFacets = false;
  let omittedFacet: number | undefined;
  let malformed = false;
  const wire = plans.map((plan) => ({
    kind: plan.kind,
    text: row.claim.slice(plan.span.start, plan.span.end),
    ...(plan.facet && { facet: plan.facet }),
  }));
  const model = scriptedModel(
    (call) => {
      frames.push(call);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return {
          text: `Parts: ${JSON.stringify(wire)}`,
          calls: [
            {
              tool: "search_documents",
              input: { query: row.facts.map((fact) => fact.quote).join(" ") },
            },
          ],
        };
      if (!call.results.some((result) => result.tool === "cite")) {
        const shown = searches.flatMap((result) => shownPassages(result.text));
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: row.facts.map((fact, index) => {
                  const passage = shown.find((each) => each.text.includes(fact.quote));
                  if (!passage)
                    throw new Error(`The check did not find its exact quote: ${fact.quote}`);
                  return { marker: index + 1, passage: passage.id, quote: fact.quote };
                }),
              },
            },
          ],
        };
      }
      const target = sentenceOf(call);
      const index = Math.max(
        0,
        row.facts.findIndex((fact) => fact.text === target),
      );
      const figures = requestedFigures(call);
      const facets = `Facets: ${JSON.stringify({
        items: row.facets
          .filter((_, at) => at !== omittedFacet)
          .map((facet) => ({
            text: facet.text,
            kind: facet.kind,
            ...(facet.kind === "source" && { sourceName: facet.sourceName }),
            occurrence: 1,
            verdict: "supported",
            scope: "same",
            topic: "found",
            roles: "same",
            says: row.facts[(facet.citation ?? 1) - 1]?.quote ?? null,
            evidence: [facet.citation ?? 1],
            ...(facet.kind === "time" && {
              time: "present",
              period: { start: "2026-01-01", end: "2026-12-31", precision: "year" },
            }),
          })),
      })}`;
      if (malformed) return { text: facets };
      return {
        text: [
          "Verdict: supported",
          "Scope: none, same",
          "Topic: found",
          "Roles: none, same",
          "Calculation: none",
          `Evidence: [${index + 1}]`,
          `${row.facts[index]?.quote} [^${index + 1}]`,
          ...(figures.length
            ? [
                `Figures: ${JSON.stringify({
                  items: figures.map((figure) => ({
                    id: figure.id,
                    verdict: "supported",
                    scope: "same",
                    topic: "found",
                    roles: "same",
                    says: null,
                    reading: figure.reading,
                    relation: "equals",
                    source: { citation: index + 1, number: figure.shown },
                    calculation: null,
                  })),
                  remainder: row.remainder
                    ? { ...row.remainder, scope: "same", topic: "found", roles: "same", says: null }
                    : null,
                })}`,
              ]
            : []),
          ...(!omitFacets ? [facets] : []),
        ].join("\n"),
      };
    },
    {
      generate: (call) => ({
        text: JSON.stringify({
          sentences: listedSentences(call.prompt).map(({ number }) => ({ number, parts: wire })),
        }),
      }),
    },
  );
  const sources = [...new Set(row.facts.map((fact) => fact.source))].map((name) => ({
    name,
    contents: row.facts
      .filter((fact) => fact.source === name)
      .map((fact) => fact.quote)
      .join("\n\n"),
  }));
  const setup = await setUpWithDocuments(model, sources, {
    now: manualClock("2026-10-30T12:00:00.000Z").now,
  });
  await setup.core.updateSettings({ user: { language: row.language } });
  const blockId = "attribution-parts";
  writeMind(setup.client, [
    { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: row.claim }] },
  ]);
  await setup.client.settled();
  const owner = () => {
    const check = markedSentences(setup.client.blocks)[0]?.check;
    if (!check) throw new Error("The Note has no checked sentence.");
    return check;
  };
  const check = () =>
    setup.core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: setup.mind.id,
      action: "check-against-documents",
      from: { blockId, offset: 0 },
      to: { blockId, offset: row.claim.length },
    });
  const select = (plan: ClaimPartPlan) =>
    setup.core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: setup.mind.id,
      action: "check-against-documents",
      from: { blockId, offset: 0 },
      to: { blockId, offset: row.claim.length },
      part: { id: owner().id, span: plan.span },
    });
  return {
    ...setup,
    row,
    frames,
    plans,
    owner,
    check,
    select,
    omit: () => {
      omitFacets = true;
    },
    omitOne: (at: number) => {
      omittedFacet = at;
    },
    malformed: () => {
      malformed = true;
    },
  };
}

describe("attribution parts share an existing assertion Run", () => {
  test.each(CASES)(
    "$language cached $facets.0.kind stays in the whole assertion Run",
    async (row) => {
      const setup = await setUp(row);
      await setup.check();
      expect(setup.owner().state).toBe("supported");
      setup.frames.length = 0;
      await setup.check();
      expect(setup.owner().parts).toHaveLength(2);
      expect(setup.owner().parts?.every((part) => part.verdict === "supported")).toBe(true);
      expect(setup.frames).toHaveLength(3);
      expect(setup.frames.every((call) => sentenceOf(call) === row.claim)).toBe(true);
    },
  );

  test.each(CASES)(
    "$language selected $facets.0.kind retains the ordinary sibling",
    async (row) => {
      const setup = await setUp(row);
      await setup.check();
      const before = setup.owner().parts;
      const facet = setup.plans.find((plan) => plan.facet);
      if (!facet) throw new Error("The fixture has no facet.");
      setup.frames.length = 0;
      await setup.select(facet);
      const after = setup.owner().parts;
      expect(after?.find((part) => !part.facet)).toEqual(before?.find((part) => !part.facet));
      expect(after?.find((part) => part.facet)?.verdict).toBe("supported");
      expect(setup.frames).toHaveLength(3);
      expect(setup.frames.every((call) => sentenceOf(call) === row.claim)).toBe(true);
    },
  );

  test.each(CASES.slice(0, 2))(
    "$language two assertions never run the shared prefix separately",
    async (base) => {
      const first = base.facts[0];
      if (!first) throw new Error("The shared prefix fixture has no governing fact.");
      const row: Scenario =
        base.language === "en"
          ? {
              ...base,
              claim: "According to Residents, Nora lives in Oslo and the branch is open.",
              facts: [
                { ...first, text: "Nora lives in Oslo" },
                {
                  text: "the branch is open.",
                  quote: "The branch is open.",
                  source: "Residents.md",
                },
              ],
            }
          : {
              ...base,
              claim: "据居民记录，诺拉住在奥斯陆，而且分行已营业。",
              facts: [
                { ...first, text: "诺拉住在奥斯陆" },
                { text: "分行已营业。", quote: "分行已营业。", source: "居民记录.md" },
              ],
            };
      const setup = await setUp(row);
      await setup.core.findMindClaims({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        mode: "all",
      });
      await setup.core.checkMind({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        mode: "all",
      });
      expect(setup.owner().parts).toHaveLength(3);
      expect(setup.owner().parts?.every((part) => part.verdict === "supported")).toBe(true);
      expect(setup.frames).toHaveLength(6);
      expect(
        setup.frames.every((call) => !row.facets.some((facet) => sentenceOf(call) === facet.text)),
      ).toBe(true);
      for (const call of setup.frames) expect(call.prompt).toContain(row.claim);
    },
  );
});

const NUMERIC: Scenario[] = [
  {
    language: "en",
    claim: "Currently, revenue was £20.",
    facets: [{ text: "Currently", kind: "time" }],
    facts: [
      {
        text: "revenue was £20.",
        quote: "In 2026, the current revenue was £20.",
        source: "Revenue.md",
      },
    ],
  },
  {
    language: "zh-CN",
    claim: "目前，收入为20英镑。",
    facets: [{ text: "目前", kind: "time" }],
    facts: [{ text: "收入为20英镑。", quote: "2026年，当前收入为20英镑。", source: "收入.md" }],
  },
];

describe("native figures retain the exact part owner", () => {
  test.each(NUMERIC)(
    "$language a qualifier remainder is not duplicated inside the ordinary fact",
    async (base) => {
      const row = {
        ...base,
        remainder: { text: base.facets[0]?.text ?? "", verdict: "supported" as const, citation: 1 },
      };
      const setup = await setUp(row);
      await setup.check();
      expect(setup.owner().state).toBe("supported");
      const ordinary = setup.owner().parts?.find((part) => !part.facet);
      expect(ordinary?.figures).toHaveLength(1);
      expect(ordinary?.figures?.[0]?.sourceInput?.citation.quote).toBe(base.facts[0]?.quote);
      expect(ordinary?.remainder).toBeNull();
      expect(setup.owner().parts?.find((part) => part.facet)?.verdict).toBe("supported");
      expect(setup.frames).toHaveLength(3);
    },
  );

  test.each(NUMERIC)("$language an independent remainder is preserved", async (base) => {
    const suffix = base.language === "en" ? "the covenant holds" : "契约仍有效";
    const claim = base.claim.replace(
      /[。.]$/,
      base.language === "en" ? ` and ${suffix}.` : `，而且${suffix}。`,
    );
    const fact = base.facts[0];
    if (!fact) throw new Error("The native fixture has no fact.");
    const row: Scenario = {
      ...base,
      claim,
      facts: [
        { ...fact, text: claim.slice(base.facets[0]?.text.length ?? 0).replace(/^[，,]\s*/, "") },
      ],
      remainder: { text: suffix, verdict: "unsupported", citation: 1 },
    };
    const setup = await setUp(row);
    await setup.check();
    const ordinary = setup.owner().parts?.find((part) => !part.facet);
    expect(ordinary?.figures?.[0]?.result.verdict).toBe("supported");
    expect(ordinary?.remainder?.verdict).toBe("unsupported");
    expect(setup.owner().state).toBe("unsupported");
  });

  test.each(NUMERIC)(
    "$language missing facet output cannot hide behind supported figures",
    async (row) => {
      const setup = await setUp(row);
      setup.omit();
      await setup.check();
      expect(setup.owner().parts?.find((part) => !part.facet)?.figures?.[0]?.result.verdict).toBe(
        "supported",
      );
      expect(setup.owner().parts?.find((part) => part.facet)?.verdict).toBe("not-checked");
      expect(setup.owner().state).toBe("not-checked");
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s native numbers inside the facet stay on that facet",
    async (language) => {
      const prefix = language === "en" ? "The current rate is 5%" : "当前利率为5%";
      const fact = language === "en" ? "the covenant holds." : "契约仍有效。";
      const row: Scenario = {
        language,
        claim: `${prefix}${language === "en" ? ", and " : "，而且"}${fact}`,
        facets: [{ text: prefix, kind: "time" }],
        facts: [
          {
            text: fact,
            quote:
              language === "en"
                ? "In 2026, the current rate is 5%, and the covenant holds."
                : "2026年，当前利率为5%，而且契约仍有效。",
            source: "Rates.md",
          },
        ],
        remainder: { text: fact.replace(/[。.]$/, ""), verdict: "supported", citation: 1 },
      };
      const setup = await setUp(row);
      await setup.check();
      const parts = setup.owner().parts;
      expect(parts?.find((part) => part.facet)?.figures).toHaveLength(1);
      expect(parts?.find((part) => part.facet)?.figures?.[0]?.reading.chars).toBe("5%");
      expect(parts?.find((part) => !part.facet)?.figures ?? []).toHaveLength(0);
      expect(parts?.find((part) => !part.facet)?.verdict).toBe("supported");
      expect(setup.owner().state).toBe("supported");
    },
  );
});

describe("facet result failure safety", () => {
  test.each(CASES.slice(0, 2))(
    "$language a failed selected Run cannot reuse parsed Supported facets",
    async (row) => {
      const setup = await setUp(row);
      await setup.check();
      const before = setup.owner().parts?.find((part) => !part.facet);
      const plan = setup.plans.find((part) => part.facet);
      if (!plan) throw new Error("The fixture has no facet.");
      setup.malformed();
      await setup.select(plan);
      expect(setup.owner().parts?.find((part) => part.facet)?.verdict).toBe("not-checked");
      expect(setup.owner().parts?.find((part) => !part.facet)).toEqual(before);
      expect(setup.owner().state).toBe("not-checked");
    },
  );
});

describe("literal facets and saved source choices", () => {
  test.each(CASES.slice(0, 2))(
    "$language an unchanged new sort retains the existing chosen Document",
    async (row) => {
      const setup = await setUp(row);
      await setup.core.findMindClaims({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        mode: "all",
      });
      await setup.check();
      const document = setup.documents[0];
      const [marked] = markedSentences(setup.client.blocks);
      if (!document || !marked?.check.parts)
        throw new Error("The source choice fixture is missing.");
      setup.client.doc.transact(() =>
        markSentence(
          marked.element,
          marked.from,
          marked.to,
          checkWithParts(
            marked.check,
            marked.check.parts?.map((part) =>
              part.facet?.kind === "source"
                ? { ...part, facet: { ...part.facet, selectedDocumentId: document.id } }
                : part,
            ) ?? [],
          ),
        ),
      );
      await setup.client.settled();
      await setup.core.checkMind({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        mode: "all",
      });
      expect(setup.owner().parts?.find((part) => part.facet)?.facet).toEqual({
        kind: "source",
        selectedDocumentId: document.id,
      });
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s interleaved named-source facets keep separate ordinary assertions",
    async (language) => {
      const row: Scenario =
        language === "en"
          ? {
              language,
              claim:
                "According to Residents, Nora lives in Oslo; the branch is open, according to Branches.",
              facets: [
                { text: "According to Residents", kind: "source", sourceName: "Residents" },
                {
                  text: "according to Branches",
                  kind: "source",
                  citation: 2,
                  sourceName: "Branches",
                },
              ],
              facts: [
                {
                  text: "Nora lives in Oslo",
                  quote: "In 2026, Nora lives in Oslo.",
                  source: "Residents.md",
                },
                { text: "the branch is open", quote: "The branch is open.", source: "Branches.md" },
              ],
            }
          : {
              language,
              claim: "据居民记录，诺拉住在奥斯陆；分行已营业，据分行记录。",
              facets: [
                { text: "据居民记录", kind: "source", sourceName: "居民记录" },
                { text: "据分行记录", kind: "source", citation: 2, sourceName: "分行记录" },
              ],
              facts: [
                {
                  text: "诺拉住在奥斯陆",
                  quote: "2026年，诺拉住在奥斯陆。",
                  source: "居民记录.md",
                },
                { text: "分行已营业", quote: "分行已营业。", source: "分行记录.md" },
              ],
            };
      const setup = await setUp(row);
      await setup.core.findMindClaims({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        mode: "all",
      });
      await setup.core.checkMind({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        mode: "all",
      });
      const facets = setup.owner().parts?.filter((part) => part.facet);
      expect(facets).toHaveLength(2);
      expect(facets?.map((part) => part.evidence[0]?.documentId)).toEqual(
        setup.documents.map((document) => document.id),
      );
      expect(setup.frames).toHaveLength(6);
      expect(
        setup.frames.every((call) => !row.facets.some((facet) => sentenceOf(call) === facet.text)),
      ).toBe(true);
      for (const call of setup.frames) expect(call.prompt).toContain(row.claim);
      setup.omitOne(1);
      await setup.core.checkMind({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        mode: "all",
      });
      expect(
        setup
          .owner()
          .parts?.filter((part) => part.facet)
          .map((part) => part.verdict),
      ).toEqual(["supported", "not-checked"]);
      expect(
        setup
          .owner()
          .parts?.filter((part) => !part.facet)
          .map((part) => part.verdict),
      ).toEqual(["supported", "supported"]);
    },
  );
});

describe("selected native facts keep the exact saved siblings", () => {
  test.each(NUMERIC)(
    "$language one figure recheck leaves its facet and other native occurrence unchanged",
    async (base) => {
      const row: Scenario =
        base.language === "en"
          ? {
              ...base,
              claim: "Currently, revenue was £20 and costs were £10.",
              facts: [
                {
                  text: "revenue was £20 and costs were £10.",
                  quote: "In 2026, the current revenue was £20 and current costs were £10.",
                  source: "Revenue.md",
                },
              ],
            }
          : {
              ...base,
              claim: "目前，收入为20英镑，成本为10英镑。",
              facts: [
                {
                  text: "收入为20英镑，成本为10英镑。",
                  quote: "2026年，当前收入为20英镑，成本为10英镑。",
                  source: "收入.md",
                },
              ],
            };
      const setup = await setUp(row);
      await setup.check();
      const before = setup.owner();
      const first = before.parts?.find((part) => !part.facet)?.figures?.[0];
      const sibling = before.parts?.find((part) => !part.facet)?.figures?.[1];
      if (!first || !sibling)
        throw new Error("The fixture does not contain two numeric occurrences.");
      setup.frames.length = 0;
      await setup.core.checkMind({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        mode: "all",
        figureIds: [first.id],
      });
      expect(setup.owner().parts?.find((part) => part.facet)).toEqual(
        before.parts?.find((part) => part.facet),
      );
      const figures = setup.owner().parts?.find((part) => !part.facet)?.figures;
      expect(figures?.map((figure) => figure.id)).toEqual([first.id, sibling.id]);
      expect(figures?.find((figure) => figure.id === sibling.id)).toEqual(sibling);
      expect(figures?.find((figure) => figure.id === first.id)?.result.verdict).toBe("supported");
      expect(setup.frames).toHaveLength(3);
      expect(setup.frames.flatMap(requestedFigures).every((figure) => figure.id === first.id)).toBe(
        true,
      );
    },
  );
});

describe("a new facet inventory needs its ordinary governing target", () => {
  test.each(["en", "zh-CN"] as const)(
    "%s refuses a qualifier-only inventory without its assertion",
    async (language) => {
      const claim = language === "en" ? "The current rate is 5%." : "当前利率为5%。";
      const qualifier = language === "en" ? "current" : "当前";
      const row: Scenario = {
        language,
        claim,
        facets: [{ text: qualifier, kind: "time" }],
        facts: [
          {
            text: claim,
            quote:
              language === "en" ? "In 2026, the current rate is 5%." : "2026年，当前利率为5%。",
            source: "Rates.md",
          },
        ],
      };
      const start = claim.indexOf(qualifier);
      const setup = await setUp(row, [
        { kind: "fact", span: { start, end: start + qualifier.length }, facet: { kind: "time" } },
      ]);
      await setup.check();
      expect(setup.owner().parts).toHaveLength(1);
      expect(setup.owner().parts?.[0]?.facet?.kind).toBe("time");
      expect(setup.owner().parts?.every((part) => part.facet !== undefined)).toBe(true);
      expect(setup.owner().state).toBe("not-checked");
      expect(setup.owner().reason).toBe("malformed");
    },
  );
});
