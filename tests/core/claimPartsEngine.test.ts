import { describe, expect, test } from "vitest";
import { periodCounts, statedFigure } from "../../src/core/answers/checks/calculated";
import { readClaimParts } from "../../src/core/answers/checks/claims";
import { readEvidence, readVerdict } from "../../src/core/answers/checks/prompt";
import { wholeNumberWords } from "../../src/shared/numberWords";
import { listedSentences, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, scriptedModel } from "../helpers/models";

type Part = { kind: "fact" | "opinion"; text: string };
type Outcome = {
  quotes: string[];
  sourceQuotes?: string[];
  judgement?: "same" | "conflict" | "neither";
  reply?: string;
  calculation?: {
    as?: "number" | "currency";
    stated: string;
    formula: string;
    inputs: { name: string; quote: string; number: string }[];
  };
};

const INCREASES = "SUM(MAX(SIGN(r2023-r2022),0),MAX(SIGN(r2024-r2023),0),MAX(SIGN(r2025-r2024),0))";

async function check(
  claim: string,
  parts: Part[],
  outcomes: Record<string, Outcome>,
  language: "en" | "zh-CN" = "en",
  context?: string,
) {
  const calls: ModelCall[] = [];
  const judgements: string[] = [];
  const quotes = [
    ...new Set(
      Object.values(outcomes).flatMap(
        (outcome) =>
          outcome.sourceQuotes ?? [
            ...outcome.quotes,
            ...(outcome.calculation?.inputs.map((input) => input.quote) ?? []),
          ],
      ),
    ),
  ];
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      const outcome = outcomes[sentenceOf(call)] ?? { quotes: [] };
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: quotes.join(" ") } }] };
      const shown = searches.flatMap((result) => shownPassages(result.text));
      if (outcome.quotes.length && !call.results.some((result) => result.tool === "cite")) {
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: outcome.quotes.map((quote, index) => ({
                  marker: index + 1,
                  passage: shown.find((passage) => passage.text.includes(quote))?.id,
                  quote,
                })),
              },
            },
          ],
        };
      }
      if (outcome.calculation && !call.results.some((result) => result.tool === "calculate")) {
        return {
          calls: [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Consecutive annual increases",
                    relation: "equals",
                    as: "number",
                    ...outcome.calculation,
                    inputs: outcome.calculation.inputs.map((input) => ({
                      ...input,
                      label: input.name,
                      passage: shown.find((passage) => passage.text.includes(input.quote))?.id,
                    })),
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        text:
          outcome.reply ??
          `Verdict: supported\nScope: none, same\nTopic: found\nRoles: none, same\nThe Documents establish this.\nEvidence: ${JSON.stringify(outcome.quotes.map((_, index) => index + 1))}\nCalculation: ${outcome.calculation?.stated ?? "none"}`,
      };
    },
    {
      generate: (call) => {
        if (call.system.startsWith("You sort the sentences"))
          return {
            text: JSON.stringify({
              sentences: listedSentences(call.prompt).map(({ number }) => ({ number, parts })),
            }),
          };
        if (call.system.startsWith("Compare a sentence")) {
          judgements.push(call.system);
          const target = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(call.prompt)?.[1] ?? "";
          return { text: outcomes[target]?.judgement ?? "neither" };
        }
        return { text: JSON.stringify({ passage: null }) };
      },
    },
  );
  const { core } = await setUpWithDocuments(
    model,
    quotes.map((quote, index) => ({
      name: `source-${index + 1}.md`,
      contents: `# Source ${index + 1}\n\n${quote}\n`,
    })),
  );
  core.on("consent.requested", (event) => void core.respondToConsent(event.requestId, true));
  await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "synthetic-test-key",
    modelId: "claude-haiku-5-5",
  });
  await core.updateSettings({ user: { language } });
  return { result: await core.checkClaim({ claim, context }), calls, judgements };
}

describe("literal sentence parts", () => {
  test.each([
    [
      "We think it is risky because costs rose 40%, and we find the timing unfortunate.",
      "We think it is risky",
      "costs rose 40%",
      "we find the timing unfortunate",
    ],
    [
      "我们认为风险很高，因为成本上涨了40%，而且我们觉得时机不妥。",
      "我们认为风险很高",
      "成本上涨了40%",
      "我们觉得时机不妥",
    ],
  ])(
    "retains two omitted opinions around a checked fact: %s",
    async (claim, prefix, fact, suffix) => {
      const parts: Part[] = [
        { kind: "opinion", text: prefix },
        { kind: "fact", text: fact },
        { kind: "opinion", text: suffix },
      ];
      const quote = fact.startsWith("costs") ? "In 2025, costs rose 40%." : "2025年成本上涨了40%。";
      const { result, calls } = await check(claim, parts, { [fact]: { quotes: [quote] } });
      expect(
        result.verdict,
        result.verdict === "not-checked"
          ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
          : undefined,
      ).toBe("supported");
      expect(result.parts?.map((part) => [part.kind, part.verdict])).toEqual([
        ["opinion", null],
        ["fact", "supported"],
        ["opinion", null],
      ]);
      expect(result.parts?.map((part) => claim.slice(part.span.start, part.span.end))).toEqual([
        prefix,
        fact,
        suffix,
      ]);
      expect(result.parts?.[1]?.evidence.map((citation) => citation.quote)).toEqual([quote]);
      expect([...new Set(calls.map(sentenceOf))]).toEqual([fact]);
      expect(result.parts?.[1]?.coverage).toBeUndefined();
    },
  );

  test("keeps independent facts and their separate Sources without quantified coverage", async () => {
    const first = "Rook's North branch opened in March 2025";
    const second = "its South branch opened in July 2025";
    const claim = `${first} and ${second}.`;
    const { result } = await check(
      claim,
      [
        { kind: "fact", text: first },
        { kind: "fact", text: second },
      ],
      {
        [first]: { quotes: ["Rook's North branch opened in March 2025."] },
        [second]: { quotes: ["Rook's South branch opened in July 2025."] },
      },
    );
    expect(
      result.verdict,
      result.verdict === "not-checked"
        ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
        : undefined,
    ).toBe("supported");
    expect(result.parts).toHaveLength(2);
    expect(result.parts?.map((part) => part.evidence.length)).toEqual([1, 1]);
    expect(result.parts?.every((part) => part.coverage === undefined)).toBe(true);
    expect(result.versions).toHaveLength(2);
  });

  test("a legal prefix binds later literal parts but a neighbouring paragraph does not", async () => {
    const first = "rent is paid";
    const second = "the Landlord maintains the roof";
    const claim = `Under [2024] UKSC 5, ${first} and ${second}.`;
    const plans: Part[] = [
      { kind: "fact", text: first },
      { kind: "fact", text: second },
    ];
    const outcomes = {
      [first]: { quotes: ["The contract says rent is paid."] },
      [second]: { quotes: ["The Landlord maintains the roof."] },
    };
    const legal = await check(claim, plans, outcomes);
    expect(legal.result.verdict).toBe("supported");
    expect(legal.result.parts?.map((part) => part.citedCaseUnchecked)).toEqual([true, true]);
    const ordinary = await check(
      `${first} and ${second}.`,
      plans,
      outcomes,
      "en",
      "A neighbouring sentence mentions [2024] UKSC 5.",
    );
    expect(ordinary.result.verdict).toBe("supported");
    expect(ordinary.result.parts?.map((part) => part.citedCaseUnchecked)).toEqual([false, false]);
  });

  test.each([
    ["Rook's North branch opened\nin March 2025", "its South branch opened in July 2025"],
    ["北区分店于2025年3月\n开业", "南区分店于2025年7月开业"],
  ])("literal parts preserve a hard break: %s", async (first, second) => {
    const claim = `${first} and ${second}.`;
    const { result } = await check(
      claim,
      [
        { kind: "fact", text: first },
        { kind: "fact", text: second },
      ],
      {
        [first]: { quotes: [first.replaceAll("\n", " ") + "."] },
        [second]: { quotes: [second + "."] },
      },
    );
    expect(result.verdict).toBe("supported");
    expect(result.parts?.map((part) => claim.slice(part.span.start, part.span.end))).toEqual([
      first,
      second,
    ]);
  });

  test("an explicit standalone check preserves two distinct opinion spans", async () => {
    const first = "We find this risky";
    const second = "we find the timing unfortunate";
    const claim = `${first}, and ${second}.`;
    const { result } = await check(
      claim,
      [
        { kind: "opinion", text: first },
        { kind: "opinion", text: second },
      ],
      {
        [first]: {
          quotes: ["This is a proposal."],
          reply: "Verdict: unsupported\nEvidence: [1]\nCalculation: none",
        },
        [second]: {
          quotes: ["It will be discussed on Tuesday."],
          reply: "Verdict: unsupported\nEvidence: [1]\nCalculation: none",
        },
      },
    );
    expect(result.verdict).toBe("unsupported");
    expect(
      result.parts?.map((part) => [
        claim.slice(part.span.start, part.span.end),
        part.kind,
        part.verdict,
      ]),
    ).toEqual([
      [first, "opinion", "unsupported"],
      [second, "opinion", "unsupported"],
    ]);
  });

  test("a single literal fact retains every complementary checked quote", async () => {
    const claim = "Rook operated North and South branches.";
    const quotes = ["Rook operated the North branch.", "Rook operated the South branch."];
    const { result } = await check(claim, [{ kind: "fact", text: claim }], { [claim]: { quotes } });
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.evidence.map((citation) => citation.quote)).toEqual(quotes);
    expect(new Set(result.parts?.[0]?.evidence.map((citation) => citation.documentId)).size).toBe(
      2,
    );
  });

  test("an unfound named quote cannot be replaced by an earlier valid marker", async () => {
    const claim = "The North branch operated.";
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [claim],
        reply: "Verdict: supported\nEvidence: [1, 99]\nCalculation: none",
      },
    });
    expect(
      result.verdict,
      result.verdict === "not-checked"
        ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
        : undefined,
    ).toBe("not-checked");
    expect(result.parts?.[0]?.verdict).toBe("not-checked");
  });

  test.each(["en", "zh-CN"] as const)(
    "typed forecast certainty retains Source words and exact %s reason",
    async (language) => {
      const claim =
        language === "en"
          ? "Larch's revenue will reach GBP 10 million in 2027."
          : "Larch 2027年的收入将达到1000万英镑。";
      const quote =
        language === "en"
          ? "Larch forecasts 2027 revenue of GBP 10 million."
          : "Larch预测2027年的收入为1000万英镑。";
      const { result } = await check(
        claim,
        [{ kind: "fact", text: claim }],
        {
          [claim]: {
            quotes: [quote],
            reply:
              "Verdict: unsupported\nTopic: found\nReason kind: forecast-certainty\nEvidence: [1]\nCalculation: none",
          },
        },
        language,
      );
      expect(
        result.verdict,
        result.verdict === "not-checked"
          ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
          : undefined,
      ).toBe("unsupported");
      expect(result.parts?.[0]?.unsupported).toMatchObject({
        kind: "forecast-certainty",
        reason:
          language === "en"
            ? "The Document forecasts this but doesn't say it will happen"
            : "文档只是作出预测，没有说这一定会发生",
        quoted: { quote },
      });
    },
  );

  test("two established events do not prove their causal link", async () => {
    const claim = "Costs rose, profits fell, and the cost rise caused the fall.";
    const quotes = ["Costs rose in 2025.", "Profits fell in 2025."];
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes,
        reply:
          "Verdict: unsupported\nTopic: found\nReason kind: unbacked-cause\nEvidence: [1, 2]\nCalculation: none",
      },
    });
    expect(
      result.verdict,
      result.verdict === "not-checked"
        ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
        : undefined,
    ).toBe("unsupported");
    expect(result.parts?.[0]?.unsupported).toMatchObject({
      kind: "unbacked-cause",
      reason: "The Documents state both, but not that one caused the other.",
    });
    expect(result.parts?.[0]?.evidence).toHaveLength(2);
  });

  test.each([true, false])(
    "quantified members keep domain evidence separate, complete=%s",
    async (complete) => {
      const claim = "All stores passed the inspection.";
      const quotes = [
        "North passed the inspection.",
        "North and South are the complete store network.",
      ];
      const coverage = {
        unit: "stores",
        quantifier: "all",
        complete,
        members: [
          { label: "North", verdict: "supported", evidence: [1] },
          { label: "South", verdict: "unsupported", evidence: [] },
        ],
        domainEvidence: [2],
      };
      const { result } = await check(claim, [{ kind: "fact", text: claim }], {
        [claim]: {
          quotes,
          reply: `Verdict: supported\nTopic: found\nEvidence: [1, 2]\nCoverage: ${JSON.stringify(coverage)}\nCalculation: none`,
        },
      });
      expect(
        result.verdict,
        result.verdict === "not-checked"
          ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
          : undefined,
      ).toBe("unsupported");
      expect(
        result.parts?.[0]?.coverage?.members.map((member) => [
          member.label,
          member.verdict,
          member.evidence.length,
        ]),
      ).toEqual([
        ["North", "supported", 1],
        ["South", "unsupported", 0],
      ]);
      expect(result.parts?.[0]?.coverage?.domainEvidence.map((citation) => citation.quote)).toEqual(
        [quotes[1]],
      );
    },
  );

  test.each([
    ["all", "unsupported"],
    ["most", "supported"],
  ] as const)(
    "%s keeps an unknown fourth member in the denominator",
    async (quantifier, expected) => {
      const claim = `${quantifier === "all" ? "All" : "Most"} stores passed the inspection.`;
      const quotes = [
        "North passed the inspection.",
        "South passed the inspection.",
        "East passed the inspection.",
        "North, South, East and West are the complete store network.",
      ];
      const coverage = {
        unit: "stores",
        quantifier,
        complete: true,
        members: ["North", "South", "East"]
          .map((label, index) => ({ label, verdict: "supported", evidence: [index + 1] }))
          .concat([{ label: "West", verdict: "not-checked", evidence: [] }]),
        domainEvidence: [4],
      };
      const { result } = await check(claim, [{ kind: "fact", text: claim }], {
        [claim]: {
          quotes,
          reply: `Verdict: supported\nTopic: found\nEvidence: [1,2,3,4]\nCoverage: ${JSON.stringify(coverage)}\nCalculation: none`,
        },
      });
      expect(result.verdict).toBe(expected);
      expect(result.parts?.[0]?.coverage).toMatchObject({
        quantifier,
        complete: true,
        members: expect.any(Array),
      });
      expect(result.parts?.[0]?.coverage?.members).toHaveLength(4);
    },
  );

  test.each([
    ["three", "Elm recorded three consecutive years of revenue growth ending in 2025."],
    ["三年", "截至2025年，榆木公司的收入连续三年增长。"],
  ])("a derived count %s has a real receipt", async (stated, claim) => {
    const inputs = [100, 110, 120, 130].map((number, index) => ({
      name: `r${2022 + index}`,
      number: String(number),
      quote: `Revenue for ${2022 + index} was GBP ${number}.`,
    }));
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [],
        calculation: {
          stated,
          inputs,
          formula: INCREASES,
        },
      },
    });
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.calculation).toMatchObject({
      stated: expect.stringContaining(stated[0] ?? ""),
      agrees: true,
      figure: { value: 3, inputs: expect.any(Array) },
    });
    expect(result.parts?.[0]?.calculation?.figure.inputs).toHaveLength(4);
  });

  test.each([
    "Elm recorded three consecutive years of revenue growth ending in 2025.",
    "截至2025年，榆木公司的收入连续三年增长。",
  ])("annual inputs without calculation cannot establish the count: %s", async (claim) => {
    const quotes = [2022, 2023, 2024, 2025].map(
      (year, index) => `Revenue for ${year} was ${100 + index * 10}.`,
    );
    const { result } = await check(claim, [{ kind: "fact", text: claim }], { [claim]: { quotes } });
    expect(result.verdict).toBe("not-checked");
    expect(result.parts?.[0]?.calculation).toBeNull();
  });

  test.each([
    [
      "Elm recorded three consecutive years of revenue growth ending in 2025.",
      "Elm recorded 3 consecutive years of revenue growth ending in 2025.",
    ],
    ["截至2025年，榆木公司的收入连续三年增长。", "截至2025年，榆木公司的收入连续3年增长。"],
    ["Elm's revenue rose in 2025.", "Elm's revenue rose in 2025."],
    ["Three stores reported last year.", "Three stores reported last year."],
  ])(
    "a directly quoted count or calendar statement needs no arithmetic: %s",
    async (claim, quote) => {
      const { result, calls } = await check(claim, [{ kind: "fact", text: claim }], {
        [claim]: { quotes: [quote] },
      });
      expect(result.verdict).toBe("supported");
      expect(calls.some((call) => call.results.some((result) => result.tool === "calculate"))).toBe(
        false,
      );
    },
  );

  test("direct months contradict only after the existing two confirmations", async () => {
    const claim = "The lease lasts 6 months.";
    const { result, judgements } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: ["The lease lasts 12 months."],
        judgement: "conflict",
        reply:
          "Verdict: contradicted\nScope: none, same\nTopic: found\nRoles: none, same\nIt lasts 12 months rather than 6 months. [^1]\nEvidence: [1]\nCalculation: none",
      },
    });
    expect(result.verdict).toBe("contradicted");
    expect(judgements).toHaveLength(2);
  });

  test("a computed count that disagrees cannot become Supported", async () => {
    const claim = "Elm recorded three consecutive years of revenue growth ending in 2025.";
    const inputs = [100, 110, 105, 130].map((number, index) => ({
      name: `r${2022 + index}`,
      number: String(number),
      quote: `Revenue for ${2022 + index} was GBP ${number}.`,
    }));
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [],
        calculation: {
          stated: "three",
          inputs,
          formula: INCREASES,
        },
      },
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.parts?.[0]?.calculation).toMatchObject({ agrees: false, figure: { value: 2 } });
  });

  test.each([
    [100, 110, 110, 130, 2],
    [100, 100, 100, 100, 0],
  ])(
    "flat annual steps have a numeric count without division by zero: %j",
    async (a, b, c, d, count) => {
      const claim = "Elm recorded three consecutive years of revenue growth ending in 2025.";
      const inputs = [a, b, c, d].map((number, index) => ({
        name: `r${2022 + index}`,
        number: String(number),
        quote: `Revenue for ${2022 + index} was GBP ${number}.`,
      }));
      const { result } = await check(claim, [{ kind: "fact", text: claim }], {
        [claim]: { quotes: [], calculation: { stated: "three", inputs, formula: INCREASES } },
      });
      expect(result.verdict).toBe("contradicted");
      expect(result.parts?.[0]?.calculation).toMatchObject({
        agrees: false,
        figure: { value: count, unit: { kind: "plain" }, inputs: expect.any(Array) },
      });
      expect(result.parts?.[0]?.calculation?.figure.inputs).toHaveLength(4);
    },
  );

  test("a dimensionless SIGN result is not a monetary amount", async () => {
    const claim = "The balance is GBP 1.";
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [],
        calculation: {
          stated: "GBP 1",
          formula: "SIGN(balance)",
          inputs: [{ name: "balance", number: "100", quote: "The balance is GBP 100." }],
        },
      },
    });
    expect(
      result.verdict,
      JSON.stringify({ verdict: result.verdict, calculation: result.parts?.[0]?.calculation }),
    ).toBe("not-checked");
  });

  test("a genuine currency result retains its matching monetary unit", async () => {
    const claim = "The balance is GBP 100.";
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [],
        calculation: {
          as: "currency",
          stated: "GBP 100",
          formula: "SUM(balance)",
          inputs: [{ name: "balance", number: "100", quote: claim }],
        },
      },
    });
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.calculation).toMatchObject({
      agrees: true,
      figure: { value: 100, unit: { kind: "currency", code: "GBP" } },
    });
  });

  test("an unavailable base-year input quote cannot provide a count receipt", async () => {
    const claim = "Elm recorded three consecutive years of revenue growth ending in 2025.";
    const inputs = [100, 110, 120, 130].map((number, index) => ({
      name: `r${2022 + index}`,
      number: String(number),
      quote: `Revenue for ${2022 + index} was GBP ${number}.`,
    }));
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [],
        sourceQuotes: inputs.slice(1).map((input) => input.quote),
        calculation: {
          stated: "three",
          inputs,
          formula: INCREASES,
        },
      },
    });
    expect(result.verdict).toBe("not-checked");
  });
});

describe("structural part and declared-count readers", () => {
  test("a literal span retains UTF16 positions after an astral character", () => {
    const sentence = "🌳 我认为时机不妥，但成本上涨了40%。";
    const literal = "成本上涨了40%";
    expect(
      readClaimParts(
        JSON.stringify({ sentences: [{ number: 1, parts: [{ kind: "fact", text: literal }] }] }),
        [{ number: 1, text: sentence }],
      )?.get(1),
    ).toEqual([
      {
        kind: "fact",
        span: { start: sentence.indexOf(literal), end: sentence.indexOf(literal) + literal.length },
      },
    ]);
  });

  test.each([
    { claims: [1] },
    { sentences: [] },
    { sentences: [{ number: 2, parts: [] }] },
    { sentences: [{ number: 1, parts: [{ kind: "fact", text: "rewritten" }] }] },
    {
      sentences: [
        {
          number: 1,
          parts: [
            { kind: "fact", text: "second" },
            { kind: "fact", text: "first" },
          ],
        },
      ],
    },
  ])("rejects missing or rewritten inventories: %j", (reply) => {
    expect(
      readClaimParts(JSON.stringify(reply), [{ number: 1, text: "first and second" }]),
    ).toBeNull();
  });

  test.each([
    ["three", 3],
    ["one hundred and twenty-eight", 128],
    ["four five", null],
    ["three years", null],
    ["three and four", null],
  ])("whole number words %s", (word, value) => {
    expect(wholeNumberWords(String(word))).toBe(value);
  });

  test.each([
    ["three", "three years, then three consecutive years.", null],
    ["three", "Three consecutive years.", null],
    ["三年", "收入连续三年增长。", 3],
  ])("reads only an exact unique declared count %s", (stated, sentence, value) => {
    expect(
      statedFigure(String(sentence), String(stated), { language: "zh-CN" })?.value ?? null,
    ).toBe(value);
  });

  test("engine-placed Citation markers do not corrupt metadata JSON", () => {
    const coverage = {
      unit: "stores",
      quantifier: "all",
      complete: false,
      members: [
        { label: "North", verdict: "supported", evidence: [1] },
        { label: "South", verdict: "unsupported", evidence: [] },
      ],
      domainEvidence: [2],
    };
    expect(
      readVerdict(
        `Verdict: unsupported\nEvidence: [1,2][^1]\nCoverage: ${JSON.stringify(coverage)}[^2]`,
      ),
    ).toMatchObject({ evidence: [1, 2], coverage });
  });

  test.each([
    ["three consecutive years", 3, "year"],
    ["four successive quarters", 4, "quarter"],
    ["6 months", 6, "month"],
    ["two weeks", 2, "week"],
    ["five days", 5, "day"],
    ["连续三年", 3, "year"],
    ["三个月", 3, "month"],
    ["两周", 2, "week"],
    ["三天", 3, "day"],
    ["连续三季度", 3, "quarter"],
  ])("count-unit grammar %s", (text, value, unit) => {
    expect(periodCounts(String(text), {})).toMatchObject([
      { value, unit: { kind: "other", word: unit } },
    ]);
  });
  test.each(["2025年3月1日", "2025年第三季度", "year 2025", "three stores reported last year"])(
    "calendar or nonadjacent words stay out: %s",
    (text) => {
      expect(periodCounts(text, {})).toEqual([]);
    },
  );

  test("display markers do not turn Calculation none into an arithmetic declaration", () => {
    expect(readVerdict("Verdict: supported\nCalculation: none[^1][^2]")?.calculations).toEqual([]);
    expect(readVerdict("Verdict: supported\nCalculation: 2.0x[=1]")?.calculations).toEqual([
      "2.0x",
    ]);
    expect(readVerdict("Verdict: supported\nCalculation: [1]")?.calculations).toEqual(["[1]"]);
    const quote = "The Source prints [^1] and [=2] literally.";
    expect(readEvidence(JSON.stringify({ passage: "P1", quote }))?.quote).toBe(quote);
    expect(
      readClaimParts(
        JSON.stringify({ sentences: [{ number: 1, parts: [{ kind: "fact", text: quote }] }] }),
        [{ number: 1, text: quote }],
      )?.get(1),
    ).toEqual([{ kind: "fact", span: { start: 0, end: quote.length } }]);
  });

  test("a bare array is not a completed calculation", async () => {
    const claim = "The lease lasts 3 years.";
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: { quotes: [claim], reply: "Verdict: supported\nEvidence: [1]\nCalculation: [1]" },
    });
    expect(result.verdict).toBe("not-checked");
  });

  test("invalid evidence and coverage declarations remain invalid", () => {
    expect(readVerdict("Verdict: supported\nEvidence: [1, 1]")?.evidence).toBeNull();
    expect(
      readVerdict('Verdict: supported\nCoverage: {"unit":"stores","members":[]}')?.coverage,
    ).toBeNull();
  });
});
