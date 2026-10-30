import { describe, expect, test } from "vitest";
import { STRICT_INSTRUCTIONS } from "../../src/core/answers/checks/prompt";
import { checkGenerate } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const SOURCE = "Net debt is 600. Adjusted EBITDA is 100.";
const DOCUMENT = { name: "Invented accounts.md", contents: `# Invented accounts\n\n${SOURCE}\n` };
const CLAIM = "Net debt is 2.0x adjusted EBITDA.";

async function fixture({
  repair = false,
  formula = "debt / ebitda",
  pdf = false,
  quote,
  claim = CLAIM,
  source = SOURCE,
  stated = "2.0x",
  required,
  verdict = "supported",
  topic = "found",
  cite = true,
  as,
  directInputs = false,
  decidingSource,
  judgement,
  confirmationError,
  strict,
  says = "The accounts support the sentence. [^1]",
}: {
  repair?: boolean;
  formula?: string;
  pdf?: boolean;
  quote?: string;
  claim?: string;
  source?: string;
  stated?: string;
  required?: readonly string[];
  verdict?: "supported" | "unsupported" | "contradicted";
  topic?: "found" | "not found";
  cite?: boolean;
  as?: "times";
  directInputs?: boolean;
  decidingSource?: { name: string; contents: string; quote: string };
  judgement?: "same" | "conflict" | "neither";
  confirmationError?: { status: number; message: string };
  strict?: "same" | "conflict" | "neither";
  says?: string | null;
} = {}) {
  const calls: ModelCall[] = [];
  const comparisons: string[] = [];
  const confirmationPrompts: string[] = [];
  let verdicts = 0;
  const generate = checkGenerate({
    [claim]: {
      judgement: judgement ?? (claim === CLAIM ? "conflict" : "same"),
      ...(strict && { strict: { text: strict } }),
    },
  });
  const model = scriptedModel(
    (call): ScriptedReply => {
      calls.push(call);
      const searched = call.results.filter((result) => result.tool === "search_documents");
      if (searched.length === 0)
        return {
          calls: [{ tool: "search_documents", input: { query: source } }],
        };
      const shown = searched.flatMap((result) => shownPassages(result.text));
      const passage = shown.find((passage) => passage.text.includes(source));
      if (!passage) throw new Error("Synthetic source was not searched.");
      const decision = decidingSource
        ? shown.find((entry) => entry.text.includes(decidingSource.quote))
        : passage;
      if (!decision && decidingSource)
        return { calls: [{ tool: "search_documents", input: { query: decidingSource.quote } }] };
      if (!decision) throw new Error("The deciding synthetic source was not searched.");
      if (cite && !call.results.some((result) => result.tool === "cite"))
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  {
                    marker: 1,
                    passage: decision.id,
                    quote: decidingSource?.quote ?? quote ?? source,
                  },
                ],
              },
            },
          ],
        };
      if (repair && verdicts > 0 && !call.results.some((result) => result.tool === "calculate"))
        return {
          calls: [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Net debt to adjusted EBITDA",
                    formula,
                    stated,
                    relation: "equals",
                    ...(as && { as }),
                    inputs: [
                      {
                        name: "debt",
                        label: "Net debt",
                        ...(directInputs
                          ? { passage: passage.id, quote: source }
                          : { citation: 1 }),
                        position: 1,
                      },
                      {
                        name: "ebitda",
                        label: "Adjusted EBITDA",
                        ...(directInputs
                          ? { passage: passage.id, quote: source }
                          : { citation: 1 }),
                        position: 2,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        };
      verdicts++;
      return {
        text: [
          `Verdict: ${verdict}`,
          `Topic: ${topic}`,
          ...(says ? [says] : []),
          ...(required?.map((number) => `Calculation: ${number}`) ?? []),
        ].join("\n"),
      };
    },
    {
      generate: (call) => {
        comparisons.push(call.system);
        confirmationPrompts.push(call.prompt);
        if (confirmationError && call.prompt.includes("Quantity to confirm:"))
          return { error: confirmationError };
        return generate(call);
      },
    },
  );
  const { core } = await setUpWithDocuments(model, [
    pdf
      ? { name: "Invented accounts.pdf", contents: buildPdf([{ lines: [source] }]) }
      : { ...DOCUMENT, contents: `# Invented accounts\n\n${source}\n` },
    ...(decidingSource ? [decidingSource] : []),
  ]);
  core.on("consent.requested", (event) => void core.respondToConsent(event.requestId, true));
  await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "synthetic-test-key",
    modelId: "claude-haiku-5-5",
  });
  return {
    result: await core.checkClaim({ claim }),
    calls,
    comparisons,
    confirmationPrompts,
    verdicts: () => verdicts,
  };
}

describe("a check cannot substitute a model verdict for derived arithmetic", () => {
  test.each([
    ["The total is 20.", "The first amount is 10. The second amount is 20."],
    ["总额为20。", "第一笔金额为10。第二笔金额为20。"],
  ])("a matching addend cannot prove the total: %s", async (claim, source) => {
    const { result, comparisons, verdicts } = await fixture({ claim, source, strict: "neither" });
    expect(result.verdict).toBe("not-checked");
    expect(verdicts()).toBe(2);
    expect(comparisons.filter((each) => each === STRICT_INSTRUCTIONS)).toHaveLength(1);
  });

  test.each([
    ["The total is 20.", "The first amount is 10. The second amount is 20."],
    ["总额为20。", "第一笔金额为10。第二笔金额为20。"],
  ])("a matching addend is contradicted only by the calculation: %s", async (claim, source) => {
    const { result } = await fixture({
      claim,
      source,
      strict: "neither",
      repair: true,
      stated: "20",
      formula: "debt + ebitda",
    });
    expect(result).toMatchObject({
      verdict: "contradicted",
      calculation: { agrees: false, figure: { value: 30 } },
    });
  });

  test.each([
    ["The total is 30.", "The first amount is 10. The second amount is 20."],
    ["总额为30。", "第一笔金额为10。第二笔金额为20。"],
  ])(
    "a valid calculation supports a total not printed in its inputs: %s",
    async (claim, source) => {
      const { result, comparisons } = await fixture({
        claim,
        source,
        repair: true,
        stated: "30",
        formula: "debt + ebitda",
      });
      expect(result).toMatchObject({
        verdict: "supported",
        calculation: { agrees: true, figure: { value: 30 } },
      });
      expect(comparisons).not.toContain(STRICT_INSTRUCTIONS);
    },
  );

  test.each([
    ["The combined amount is 20.", "The fee is 10. The total is 20."],
    ["合计金额为20。", "费用为10。总额为20。"],
  ])("strict comparison can confirm an ambiguous direct quantity: %s", async (claim, source) => {
    const { result, comparisons, confirmationPrompts, verdicts } = await fixture({
      claim,
      source,
      strict: "same",
    });
    expect(result.verdict).toBe("supported");
    expect(verdicts()).toBe(1);
    expect(comparisons.filter((each) => each === STRICT_INSTRUCTIONS)).toHaveLength(1);
    expect(confirmationPrompts.some((each) => each.includes("Quantity to confirm:"))).toBe(true);
  });

  test.each([401, 429])(
    "a confirmation failure during a calculation's Supported re-evaluation keeps its provider reason: %s",
    async (status) => {
      const { result, confirmationPrompts } = await fixture({
        claim: "Net debt is 600 and 6.0x adjusted EBITDA.",
        stated: "6.0x",
        required: ["6.0x"],
        repair: true,
        as: "times",
        verdict: "unsupported",
        topic: "not found",
        says: null,
        confirmationError: { status, message: status === 429 ? "Rate limited" : "Invalid API key" },
      });
      expect(result).toMatchObject({
        verdict: "not-checked",
        reason: status === 429 ? "rate-limit" : "failed",
      });
      expect(
        confirmationPrompts.filter((each) => each.includes("Quantity to confirm:")),
      ).toHaveLength(1);
    },
  );

  test("one direct quantity is confirmed once beside an already calculated one", async () => {
    const { result, confirmationPrompts } = await fixture({
      claim: "Net debt is 600 and 6.0x adjusted EBITDA.",
      stated: "6.0x",
      required: ["6.0x"],
      repair: true,
      as: "times",
      strict: "same",
    });
    expect(result).toMatchObject({ verdict: "supported", calculation: { agrees: true } });
    const confirmed = confirmationPrompts.filter((each) => each.includes("Quantity to confirm:"));
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toContain('"chars":"600"');
  });

  test.each([
    ["The combined amount is 20.", "The total is 20."],
    ["合计金额为20。", "总额为20。"],
    ["The combined amount is £20.", "The total is £20. The margin is 10%."],
    ["合计金额为20英镑。", "总额为20英镑。利润率为10%。"],
  ])("one number in the quantity's unit needs no extra comparison: %s", async (claim, source) => {
    const { result, comparisons, verdicts } = await fixture({ claim, source });
    expect(result.verdict).toBe("supported");
    expect(verdicts()).toBe(1);
    expect(comparisons).not.toContain(STRICT_INSTRUCTIONS);
  });

  test.each(["600", "600.0"])(
    "a repeated amount on one cited page has no arbitrary unit-warning quote: %s",
    async (amount) => {
      const { result } = await fixture({
        claim: "Net debt is £600.",
        source: `The other company has a balance of ${amount}. Net debt is 600.`,
        quote: `The other company has a balance of ${amount}.`,
        pdf: true,
      });
      expect(result.verdict).toBe("unsupported");
      if (result.verdict === "unsupported") expect(result.unsupported?.quoted).toBeUndefined();
    },
  );

  test.each([
    ["Harbours publish the times every 6 months.", "Harbours publish the times every 12 months."],
    ["港口每6个月公布时间表。", "港口每12个月公布时间表。"],
  ])("a directly contradicted figure keeps its evidence check: %s", async (claim, source) => {
    const { result, verdicts, comparisons } = await fixture({
      claim,
      source,
      verdict: "contradicted",
      judgement: "conflict",
    });
    expect(result.verdict).toBe("contradicted");
    expect(verdicts()).toBe(1);
    expect(comparisons).toContain(STRICT_INSTRUCTIONS);
  });

  test.each(["The lighthouse was built in 1867.", "灯塔建于1867年。"])(
    "an unrelated dated claim keeps its ordinary Unsupported result: %s",
    async (claim) => {
      const { result, calls } = await fixture({ claim, verdict: "unsupported" });
      expect(result.verdict).toBe("unsupported");
      expect(calls.some((call) => call.prompt.includes("The numerical check is incomplete"))).toBe(
        false,
      );
    },
  );

  test.each([
    ["The total is 30.", "The first amount is 10. The second amount is 20."],
    ["总额为30。", "第一笔金额为10。第二笔金额为20。"],
  ])("a derived total cannot bypass the strict contradiction look: %s", async (claim, source) => {
    const { result, comparisons, calls } = await fixture({
      claim,
      source,
      verdict: "contradicted",
      judgement: "conflict",
      strict: "neither",
    });
    expect(comparisons).toContain(STRICT_INSTRUCTIONS);
    expect(result).toMatchObject({ verdict: "unsupported", calculation: null });
    expect(
      calls.flatMap((call) => call.results).some((result) => result.tool === "calculate"),
    ).toBe(false);
  });

  test("asks once and stays Not checked when the model still omits the calculation", async () => {
    const { result, verdicts } = await fixture();
    expect(result.verdict).toBe("not-checked");
    expect(verdicts()).toBe(2);
  });

  test("the requested calculation contradicts the wrong figure even if the model still says Supported", async () => {
    const { result, calls } = await fixture({ repair: true });
    expect(result.verdict).toBe("contradicted");
    if (result.verdict === "not-checked") throw new Error("The arithmetic was not checked.");
    expect(result.calculation).toMatchObject({
      agrees: false,
      stated: "2.0x",
      figure: { value: 6 },
    });
    expect(
      calls.flatMap((call) => call.results).some((result) => result.tool === "calculate"),
    ).toBe(true);
  });

  test.each([
    [
      "Net debt is £600 and 6.0x adjusted EBITDA; finance costs are 8.0x revenue; the company is based in London.",
      "not-checked",
    ],
    [
      "Net debt is £600 and 6.0x adjusted EBITDA, and the company is based in London.",
      "unsupported",
    ],
  ])("a unit gap in a direct input cannot settle the rest: %s", async (claim, verdict) => {
    const { result } = await fixture({
      source: `${SOURCE} Finance costs are 300. Revenue is 100.`,
      claim,
      stated: "6.0x",
      required: ["6.0x"],
      repair: true,
      as: "times",
      directInputs: true,
      decidingSource: {
        name: "Address.md",
        contents: "# Address\n\nThe company is based in London.",
        quote: "The company is based in London.",
      },
    });
    expect(result.verdict).toBe(verdict);
    if (result.verdict === "unsupported")
      expect(result.unsupported?.quoted?.quote).toContain("600");
  });

  test.each(["600", "600.0"])(
    "an ambiguous amount (%s) in a unit warning does not quote another company",
    async (amount) => {
      const { result, calls } = await fixture({
        claim: "Net debt is £600 and 6.0x adjusted EBITDA.",
        stated: "6.0x",
        repair: true,
        as: "times",
        directInputs: true,
        decidingSource: {
          name: "Other company.md",
          contents: `# Other company\n\nThe other company has a balance of ${amount}.`,
          quote: `The other company has a balance of ${amount}.`,
        },
      });
      expect(result.verdict).toBe("unsupported");
      if (result.verdict === "unsupported") expect(result.unsupported?.quoted).toBeUndefined();
      expect(
        calls.flatMap((call) => call.results).some((result) => result.tool === "calculate"),
      ).toBe(true);
    },
  );

  test("a quantity starting after a citation is not mistaken for a pinpoint page", async () => {
    const { result, verdicts } = await fixture({
      claim: "Under [2024] UKSC 5, 60 of the appeals succeeded.",
    });
    expect(result.verdict).toBe("not-checked");
    expect(verdicts()).toBe(2);
  });

  test("a parenthetical clause after a citation does not hide an uncalculated quantity", async () => {
    const { result, verdicts } = await fixture({
      claim: "Under [2024] UKSC 5, 60, representing all successful appeals, were upheld.",
    });
    expect(result.verdict).toBe("not-checked");
    expect(verdicts()).toBe(2);
  });

  test("a closed citation pinpoint needs no arithmetic", async () => {
    const { result, verdicts } = await fixture({
      claim: "See [2024] UKSC 5, 60.",
      verdict: "unsupported",
    });
    expect(result.verdict).toBe("unsupported");
    expect(verdicts()).toBe(1);
  });

  test("a US citation with a pinpoint needs no arithmetic for the legal proposition", async () => {
    const { result, verdicts, calls } = await fixture({
      claim:
        "Brown v. Board of Education, 347 U.S. 483, 495 (1954) held that segregation was unlawful.",
      source: "Segregation was unlawful.",
    });
    expect(result.verdict).toBe("supported");
    expect(verdicts()).toBe(1);
    expect(calls.some((call) => call.prompt.includes("The numerical check is incomplete"))).toBe(
      false,
    );
    expect(
      calls.flatMap((call) => call.results).some((result) => result.tool === "calculate"),
    ).toBe(false);
  });

  test.each([
    "Under [2024] UKSC 5, net debt is 2.0x adjusted EBITDA.",
    "根据 [2024] UKSC 5，净负债为调整后EBITDA的2.0倍。",
  ])("a case reference does not hide the derived fact: %s", async (claim) => {
    const { result, verdicts } = await fixture({ claim });
    expect(result.verdict).toBe("not-checked");
    expect(verdicts()).toBe(2);
  });

  test("a stated amount binds to its factual span, not the same number in a court reference", async () => {
    const { result } = await fixture({
      claim: "Under [2024] UKSC 5, net debt is 5.0x adjusted EBITDA.",
      stated: "5",
      repair: true,
      as: "times",
    });
    expect(result).toMatchObject({
      verdict: "contradicted",
      calculation: { stated: "5.0x", agrees: false },
    });
  });

  test("a declared calculation is still required when the reply says its topic was not found", async () => {
    const { result, verdicts } = await fixture({
      verdict: "unsupported",
      topic: "not found",
      required: ["2.0x"],
    });
    expect(result.verdict).toBe("not-checked");
    expect(verdicts()).toBe(3);
  });

  test("a quoted covenant limit still needs the ratio calculated", async () => {
    const { result, verdicts } = await fixture({
      source: `${SOURCE} The covenant limit is 2.0x.`,
      claim: "Net debt to adjusted EBITDA is within the 2.0x covenant.",
      required: ["2.0x"],
      repair: true,
    });
    expect(result.verdict).toBe("contradicted");
    expect(verdicts()).toBe(2);
  });

  test.each([{ required: ["6.0x"] }, { required: ["6.0x", "6.0x"] }])(
    "one calculation cannot settle two derived quantities when it declares %j",
    async ({ required }) => {
      const { result } = await fixture({
        source: `${SOURCE} Finance costs are 300. Revenue is 100.`,
        claim: "Net debt is 6.0x adjusted EBITDA and finance costs are 6.0x revenue.",
        stated: "6.0x",
        required,
        repair: true,
      });
      expect(result.verdict).toBe("not-checked");
    },
  );

  test("one valid receipt cannot turn an adverse verdict into Supported with another quantity unresolved", async () => {
    const { result } = await fixture({
      source: `${SOURCE} Finance costs are 300. Revenue is 100.`,
      claim: "Net debt is 6.0x adjusted EBITDA and finance costs are 8.0x revenue.",
      stated: "6.0x",
      required: ["6.0x"],
      verdict: "unsupported",
      topic: "not found",
      says: null,
      repair: true,
      as: "times",
    });
    expect(result.verdict).toBe("not-checked");
  });

  test("an unrelated bare amount cannot stand in for a calculated multiple", async () => {
    const { result, verdicts } = await fixture({
      source: `${SOURCE} The review fee is 2.0.`,
      required: ["none"],
    });
    expect(result.verdict).toBe("not-checked");
    expect(verdicts()).toBe(2);
  });

  test("a directly stated sentence is not asked for arithmetic when the model omits cite", async () => {
    const { verdicts, calls } = await fixture({
      claim: "Net debt is 600.",
      verdict: "unsupported",
      required: ["none"],
      cite: false,
    });
    expect(verdicts()).toBe(1);
    expect(
      calls.some((call) =>
        JSON.stringify(call.options.prompt).includes("The numerical check is incomplete"),
      ),
    ).toBe(false);
  });

  test("a directly quoted quantity needs no extra request", async () => {
    const { result, verdicts, calls } = await fixture({ claim: "Net debt is 600." });
    expect(result.verdict).toBe("supported");
    expect(verdicts()).toBe(1);
    expect(
      calls.flatMap((call) => call.results).some((result) => result.tool === "calculate"),
    ).toBe(false);
  });
});
