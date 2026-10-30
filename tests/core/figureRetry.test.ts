/**
 * Structured output's one request to fix calculated figures (src/core/answers/figureRetry.ts):
 * a local model's figures that couldn't be worked out are asked for once more, and those
 * it gives again are taken as `calculate` takes them. On the Answer engine, whose
 * Documents' Tools stand in for the core's: no model in Ollama is offered
 * calculate until the evaluation (#441) says so.
 */
import { describe, expect, test } from "vitest";
import {
  type AnswerEngineEvent,
  type AnswerTools,
  createAiSdkAnswerEngine,
} from "../../src/core/answers/engine";
import { endsAtLimit } from "../../src/core/providers/outputLimits";
import { promptOf, scriptedModel } from "../helpers/models";

const MARGIN = "Gross margin 41.2% 38.9%";
const PROBLEM = '[=1] gm2025: the quote has no number "42.1%"; it has 41.2%, 38.9%.';
const FIGURE = {
  marker: 1,
  label: "Change in gross margin",
  formula: "gm2025 - gm2024",
  inputs: [
    { name: "gm2025", label: "Gross margin 2025", citation: 1, number: "41.2%" },
    { name: "gm2024", label: "Gross margin 2024", citation: 1, number: "38.9%" },
  ],
};

/**
 * Asks with a small local model's window, as the model layer hands it out; the retry request gets
 * `retry` (none: no JSON), cut off at its limit when `cut`.
 */
async function ask(retry?: object, cut = false) {
  const given: unknown[][] = [];
  const documents: AnswerTools = {
    documentCount: 1,
    async searchDocuments() {
      return {
        text: `<passage id="P1" document="Acme Annual Report 2025" pages="2">\n${MARGIN}\n</passage>`,
        passageCount: 1,
      };
    },
    cite: () => "Recorded [^1].",
    hasRecord: () => true,
    calculate(figures) {
      given.push([...figures]);
      return "";
    },
    // The first figures had one in error; a later call fixes it.
    figureProblems: () =>
      given.length < 2
        ? [
            {
              marker: 1,
              given: JSON.stringify(FIGURE),
              problems: [PROBLEM],
              passages: [{ id: "P1", text: MARGIN }],
            },
          ]
        : [],
  };
  const model = scriptedModel((call) =>
    call.system.startsWith("You fix the calculated figures")
      ? { text: retry ? JSON.stringify(retry) : "I can't.", cutOff: cut }
      : {
          text: JSON.stringify({
            answer: "Gross margin rose [=1][^1].",
            citations: [{ marker: 1, passage: "P1", location: "p. 2", quote: MARGIN }],
            calculations: [
              { ...FIGURE, inputs: [{ ...FIGURE.inputs[0], number: "42.1%" }, FIGURE.inputs[1]] },
            ],
          }),
        },
  );
  const events: AnswerEngineEvent[] = [];
  for await (const event of createAiSdkAnswerEngine().generate({
    instructions: () => "Answer from the Passages.",
    messages: [{ role: "user", content: "How did gross margin change?" }],
    question: "How did gross margin change?",
    model: endsAtLimit(model),
    documents,
    tools: [],
    support: "structured-output",
    window: { tokens: 8_192, outputTokens: 1_024 },
    retryQuotes: true,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return { events, given, model };
}

describe("A local model's figures that couldn't be worked out", { timeout: 30_000 }, () => {
  test("are asked for once more, with why and their Passages; one it fixes is taken, its marker read as calculate reads it", async () => {
    const { events, given, model } = await ask({ calculations: [{ ...FIGURE, marker: "[=1]" }] });

    expect(events).toContainEqual({ type: "phase", phase: "checking-figures" });
    expect(events).toContainEqual({
      type: "figures-retried",
      retry: { figures: 1, recovered: 1, durationMs: expect.any(Number) },
    });
    expect(given[1]).toEqual([{ ...FIGURE, marker: "[=1]" }]);
    const prompt = promptOf(model, 1)
      .map((message) => message.text)
      .join("\n");
    expect(prompt).toContain(`Why it couldn't be worked out: ${PROBLEM}`);
    expect(prompt).toContain(`<passage id="P1">\n${MARGIN}\n</passage>`);
    expect(events.at(-1)).toEqual({ type: "finished" });
  });

  test("stay out when the request gives nothing back", async () => {
    const { events, given } = await ask();

    expect(given).toHaveLength(1);
    expect(events).toContainEqual({
      type: "figures-retried",
      retry: { figures: 1, recovered: 0, durationMs: expect.any(Number) },
    });
  });

  // protects=a request to fix figures cut at its output limit reads nothing: calculate never gets a cut figure; fails_when=the start of a cut reply, a figure with part of its inputs, is worked out (#2275).
  test("stay out when the reply was cut at its limit, though it began with a fix", async () => {
    const fixed = { calculations: [{ ...FIGURE, marker: "[=1]" }] };

    const { events, given } = await ask(fixed, true);

    expect(given).toHaveLength(1);
    expect(events).toContainEqual({
      type: "figures-retried",
      retry: { figures: 1, recovered: 0, durationMs: expect.any(Number) },
    });
  });
});
