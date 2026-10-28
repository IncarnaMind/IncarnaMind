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
}: {
  repair?: boolean;
  claim?: string;
  source?: string;
  stated?: string;
  required?: readonly string[];
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
      const passage = shownPassages(searched.at(-1)?.text ?? "").find((passage) =>
        passage.text.includes(source),
      );
      if (!passage) throw new Error("Synthetic source was not searched.");
      if (!call.results.some((result) => result.tool === "cite"))
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, quote: source }] },
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
                    inputs: [
                      { name: "debt", label: "Net debt", citation: 1, position: 1 },
                      { name: "ebitda", label: "Adjusted EBITDA", citation: 1, position: 2 },
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
          "Verdict: supported",
          "The accounts support the sentence. [^1]",
          ...(required?.map((number) => `Calculation: ${number}`) ?? []),
        ].join("\n"),
      };
    },
    { generate: checkGenerate({ [claim]: { judgement: "conflict" } }) },
  );
  const { core } = await setUpWithDocuments(model, [
    { ...DOCUMENT, contents: `# Invented accounts\n\n${source}\n` },
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

  test("one calculation cannot settle two derived quantities with the same value", async () => {
    const { result } = await fixture({
      source: `${SOURCE} Finance costs are 300. Revenue is 100.`,
      claim: "Net debt is 6.0x adjusted EBITDA and finance costs are 6.0x revenue.",
      stated: "6.0x",
      required: ["6.0x", "6.0x"],
      repair: true,
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

  test("a directly quoted quantity needs no extra request", async () => {
    const { result, verdicts, calls } = await fixture({ claim: "Net debt is 600." });
    expect(result.verdict).toBe("supported");
    expect(verdicts()).toBe(1);
    expect(
      calls.flatMap((call) => call.results).some((result) => result.tool === "calculate"),
    ).toBe(false);
  });
});
