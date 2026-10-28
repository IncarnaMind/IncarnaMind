import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { checkGenerate } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const LANGUAGES = [
  {
    language: "en",
    source: "Net debt is 600. Adjusted EBITDA is 100.",
    claim: "Net debt is 2.0x adjusted EBITDA.",
    stated: "2.0x",
  },
  {
    language: "zh-CN",
    source: "净负债为600。调整后EBITDA为100。",
    claim: "净负债为调整后EBITDA的2.0倍。",
    stated: "2.0倍",
  },
] as const;
type Example = (typeof LANGUAGES)[number];
type Failure = "malformed JSON" | "invalid schema" | "unrecorded input";
const FAILURES: Failure[] = ["malformed JSON", "invalid schema", "unrecorded input"];

const calculation = (stated: string, citation = 1) => ({
  figures: [
    {
      marker: 1,
      label: "Net debt to adjusted EBITDA",
      formula: "debt / ebitda",
      stated,
      relation: "equals",
      inputs: [
        { name: "debt", label: "Net debt", citation, position: 1 },
        { name: "ebitda", label: "Adjusted EBITDA", citation: 1, position: 2 },
      ],
    },
  ],
});

const MALFORMED = `${JSON.stringify(calculation("2.0x"))}]}`;

function brokenInput(failure: Failure, stated: string): unknown {
  return failure === "invalid schema"
    ? { figures: 17 }
    : calculation(stated, failure === "unrecorded input" ? 999 : 1);
}

async function fixture(
  example: Example,
  inputs: readonly unknown[],
  {
    malformedAt = 0,
    refuses = false,
    suffix,
  }: { malformedAt?: number; refuses?: boolean; suffix?: string } = {},
) {
  const calls: ModelCall[] = [];
  const wireInputs: string[] = [];
  const model = scriptedModel(
    (call): ScriptedReply => {
      calls.push(call);
      const searched = call.results.filter((result) => result.tool === "search_documents");
      if (searched.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: example.claim } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(searched.at(-1)?.text ?? "").find((entry) =>
          entry.text.includes(example.source),
        );
        if (!passage) throw new Error("The synthetic accounts were not searched.");
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, quote: example.source }] },
            },
          ],
        };
      }
      const attempts = call.results.filter((result) => result.tool === "calculate").length;
      if (attempts < inputs.length)
        return { calls: [{ tool: "calculate", input: inputs[attempts] }] };
      return {
        text: refuses
          ? "I cannot repair the calculation, so I cannot check this sentence."
          : `Verdict: supported\nThe accounts support this sentence. [^1]\nCalculation: ${example.stated}`,
      };
    },
    { generate: checkGenerate({ [example.claim]: { judgement: "conflict" } }) },
  );
  const wrapped = wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
              transform(part, controller) {
                if (part.type === "tool-call" && part.toolName === "calculate") {
                  const input =
                    wireInputs.length + 1 === malformedAt
                      ? suffix === undefined
                        ? MALFORMED
                        : `${part.input}${suffix}`
                      : part.input;
                  wireInputs.push(input);
                  controller.enqueue({ ...part, input });
                } else controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
  const { core } = await setUpWithDocuments(
    model,
    [{ name: "Invented accounts.md", contents: `# Invented accounts\n\n${example.source}\n` }],
    { createChatModel: () => wrapped },
  );
  core.on("consent.requested", (event) => void core.respondToConsent(event.requestId, true));
  await core.updateSettings({ user: { language: example.language } });
  await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "synthetic-test-key",
    modelId: "claude-haiku-5-5",
  });
  const result = await core.checkClaim({ claim: example.claim });
  const feedback = calls.at(-1)?.results.filter((entry) => entry.tool === "calculate") ?? [];
  return { result, calls, wireInputs, feedback };
}

describe.each(LANGUAGES)("a rejected calculation input ($language)", (example) => {
  test.each(FAILURES)("repairs %s on the next tool step and checks the result", async (failure) => {
    const { result, calls, wireInputs, feedback } = await fixture(
      example,
      [brokenInput(failure, example.stated), calculation(example.stated)],
      { malformedAt: failure === "malformed JSON" ? 1 : 0 },
    );
    expect(feedback).toHaveLength(2);
    expect(feedback[0]?.text).toMatch(
      failure === "malformed JSON"
        ? /JSON parsing failed/
        : failure === "invalid schema"
          ? /Invalid input for tool calculate/
          : /999.*isn't recorded/,
    );
    expect(feedback[1]?.text).toMatch(/^Recorded/);
    expect(calls).toHaveLength(5);
    expect(calls[3]?.results.filter((entry) => entry.tool === "calculate")).toHaveLength(1);
    expect(wireInputs).toHaveLength(2);
    if (failure === "malformed JSON") {
      expect(wireInputs[0]).toBe(MALFORMED);
      expect(() => JSON.parse(wireInputs[0] ?? "")).toThrow(SyntaxError);
    }
    expect(result.verdict).toBe("contradicted");
    if (result.verdict === "not-checked")
      throw new Error("The repaired arithmetic was not checked.");
    expect(result.calculation).toMatchObject({
      agrees: false,
      stated: example.stated,
      figure: { value: 6 },
    });
  });

  test("an extra closing object is re-asked with its exact parse error", async () => {
    const { result, wireInputs, feedback } = await fixture(
      example,
      [calculation(example.stated), calculation(example.stated)],
      { malformedAt: 1, suffix: "}" },
    );
    expect(() => JSON.parse(wireInputs[0] ?? "")).toThrow(SyntaxError);
    expect(feedback[0]?.text).toContain("JSON parsing failed");
    expect(feedback[1]?.text).toMatch(/^Recorded/);
    expect(result.verdict).toBe("contradicted");
  });

  test("a second failed input exhausts the single repair", async () => {
    const { result, feedback } = await fixture(example, [
      brokenInput("unrecorded input", example.stated),
      brokenInput("unrecorded input", example.stated),
      calculation(example.stated),
    ]);
    expect(feedback).toHaveLength(3);
    expect(feedback[2]?.text).not.toMatch(/^Recorded/);
    expect(result.verdict).toBe("not-checked");
  });

  test("a valid repair may use a new marker", async () => {
    const repaired = calculation(example.stated);
    const figure = repaired.figures[0];
    if (!figure) throw new Error("The synthetic calculation is missing.");
    figure.marker = 2;
    const { result, feedback } = await fixture(example, [
      brokenInput("unrecorded input", example.stated),
      repaired,
    ]);
    expect(feedback).toHaveLength(2);
    expect(feedback[1]?.text).toMatch(/^Recorded \[=2\]/);
    expect(result.verdict).toBe("contradicted");
  });

  test.each(FAILURES)("cannot accept a Supported verdict after unresolved %s", async (failure) => {
    const { result, calls, feedback } = await fixture(
      example,
      [brokenInput(failure, example.stated)],
      { malformedAt: failure === "malformed JSON" ? 1 : 0 },
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.text).not.toMatch(/^Recorded/);
    expect(calls).toHaveLength(4);
    expect(result.verdict).toBe("not-checked");
  });

  test("stays Not checked when the model refuses the parse-error repair turn", async () => {
    const { result, calls, feedback } = await fixture(example, [calculation(example.stated)], {
      malformedAt: 1,
      refuses: true,
    });
    expect(feedback[0]?.text).toMatch(/JSON parsing failed/);
    expect(calls).toHaveLength(4);
    expect(result.verdict).toBe("not-checked");
  });

  test.each(FAILURES)(
    "does not use an earlier marker after a replacement has %s",
    async (failure) => {
      const { result, calls, feedback } = await fixture(
        example,
        [calculation(example.stated), brokenInput(failure, example.stated)],
        { malformedAt: failure === "malformed JSON" ? 2 : 0 },
      );
      expect(feedback).toHaveLength(2);
      expect(feedback[0]?.text).toMatch(/^Recorded/);
      expect(feedback[1]?.text).not.toMatch(/^Recorded/);
      expect(calls).toHaveLength(5);
      expect(result.verdict).toBe("not-checked");
    },
  );

  test("a valid unrelated figure cannot decide the claim", async () => {
    const unrelated = {
      figures: [
        {
          marker: 1,
          label: "Adjusted EBITDA",
          formula: "ebitda",
          stated: "100",
          relation: "equals",
          inputs: [{ name: "ebitda", label: "Adjusted EBITDA", citation: 1, position: 2 }],
        },
      ],
    };
    const { result, calls, feedback } = await fixture(example, [unrelated]);
    expect(feedback[0]?.text).toMatch(/^Recorded/);
    expect(calls).toHaveLength(4);
    expect(result.verdict).toBe("not-checked");
  });
});
