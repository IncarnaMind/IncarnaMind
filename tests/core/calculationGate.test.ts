import { describe, expect, test } from "vitest";
import { checkGenerate } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const SOURCE = "Net debt is 600. Adjusted EBITDA is 100.";
const DOCUMENT = { name: "Invented accounts.md", contents: `# Invented accounts\n\n${SOURCE}\n` };
const CLAIM = "Net debt is 2.0x adjusted EBITDA.";

async function fixture({
  repair = false,
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
}: {
  repair?: boolean;
  claim?: string;
  source?: string;
  stated?: string;
  required?: readonly string[];
  verdict?: "supported" | "unsupported";
  topic?: "found" | "not found";
  cite?: boolean;
  as?: "times";
  directInputs?: boolean;
  decidingSource?: { name: string; contents: string; quote: string };
} = {}) {
  const calls: ModelCall[] = [];
  let verdicts = 0;
  const model = scriptedModel(
    (call): ScriptedReply => {
      calls.push(call);
      const searched = call.results.filter((result) => result.tool === "search_documents");
      if (searched.length === 0)
        return {
          calls: [{ tool: "search_documents", input: { query: "net debt adjusted EBITDA" } }],
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
                  { marker: 1, passage: decision.id, quote: decidingSource?.quote ?? source },
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
                    formula: "debt / ebitda",
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
          "The accounts support the sentence. [^1]",
          ...(required?.map((number) => `Calculation: ${number}`) ?? []),
        ].join("\n"),
      };
    },
    { generate: checkGenerate({ [claim]: { judgement: claim === CLAIM ? "conflict" : "same" } }) },
  );
  const { core } = await setUpWithDocuments(model, [
    { ...DOCUMENT, contents: `# Invented accounts\n\n${source}\n` },
    ...(decidingSource ? [decidingSource] : []),
  ]);
  core.on("consent.requested", (event) => void core.respondToConsent(event.requestId, true));
  await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "synthetic-test-key",
    modelId: "claude-haiku-5-5",
  });
  return { result: await core.checkClaim({ claim }), calls, verdicts: () => verdicts };
}

describe("a check cannot substitute a model verdict for derived arithmetic", () => {
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
