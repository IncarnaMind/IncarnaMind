/**
 * An Answer's stored usage counts every model call it made (#2817): its own requests, and each
 * judge's question it asked on the way, the claimed-change check read from a reply that didn't
 * hold to its schema too. A judgement of its sentences after it ends is not the Answer's.
 */
import { describe, expect, test } from "vitest";
import { type AnswerTools, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import { countingJudges, type JudgeQuestion } from "../../src/core/answers/judge";
import type { AnswerUsage } from "../../src/core/api";
import { endsAtLimit } from "../../src/core/providers/outputLimits";
import type { TokenUsage } from "../../src/core/runs/engine";
import { askAssistant } from "../helpers/assistant";
import { askAndFinish, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import {
  claimCheckReply,
  type GeneratedReply,
  type ModelCall,
  type ReportedUsage,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/** Tokens a request reports: `input` in, a tenth of it out. */
const reported = (input: number): ReportedUsage => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: input / 10, text: input / 10, reasoning: undefined },
});

/** What the Answer should store for requests that reported these inputs. */
const stored = (...inputs: number[]): AnswerUsage => {
  const input = inputs.reduce((sum, each) => sum + each, 0);
  return {
    inputTokens: input,
    outputTokens: input / 10,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
};

const SPRING = "Spring tides happen at new moon and at full moon.";
const TIDES = {
  name: "Tides.md",
  contents: `# Tides\n\n${SPRING}\n\nNeap tides happen at the quarter moons.\n`,
};
const WRITES_THEN_CITES = { answerPaths: { writesThenCites: () => true } };

/** Records each judge's question a model was asked. */
const asking = () => {
  const asked: (JudgeQuestion | undefined)[] = [];
  return {
    asked,
    heard: <T>(question: JudgeQuestion | undefined, reply: T) => {
      asked.push(question);
      return reply;
    },
  };
};

describe("An Answer's stored usage", { timeout: 30_000 }, () => {
  // protects=the judgement of a working note beside cite counts in the Answer's usage, and the judgement of its sentences after it ends does not; fails_when=the working-text call's tokens are left out, or the later judgement's are added (#2817).
  test("counts the judgement of its working, beside its own requests", async () => {
    const { asked, heard } = asking();
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return {
            calls: [{ tool: "search_documents", input: { query: "spring tides" } }],
            usage: reported(100),
          };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: "Spring tides come at new and full moon[^1].\n\nCitations need to be recorded now.",
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
          usage: reported(200),
        };
      },
      {
        generate: (call): GeneratedReply =>
          heard(
            call.question,
            call.question === "working-text"
              ? { text: JSON.stringify({ parts: ["working"] }), usage: reported(400) }
              : { text: JSON.stringify({ sentences: [] }), usage: reported(90_000) },
          ),
      },
    );
    const { core, client, mind } = await setUpWithDocuments(model, [TIDES], WRITES_THEN_CITES);

    const { finished } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(asked).toContain("working-text");
    expect(finished.usage).toEqual(stored(100, 200, 400));
  });

  // protects=the one request for an Answer's Citations counts in its usage; fails_when=its tokens are left out (#2817).
  test("counts its request for the Citations it left out", async () => {
    const { asked, heard } = asking();
    const answer = "Long ago, traders carried tea along the old Horse Road to Tibet [^1].";
    const model = scriptedModel(
      (call) => {
        if (call.question === "unmarked-quotes")
          return heard(call.question, { text: '{"citations":[]}', usage: reported(300) });
        if (!call.results.some((result) => result.tool === "search_documents")) {
          return {
            calls: [{ tool: "search_documents", input: { query: "tea" } }],
            usage: reported(100),
          };
        }
        return { text: answer, usage: reported(200) };
      },
      {
        generate: (call) =>
          heard(call.question, { text: '{"sentences":[]}', usage: reported(90_000) }),
      },
    );
    const { core, client, mind } = await setUpWithDocuments(model, [
      {
        name: "Tea.md",
        contents: "# Tea\n\nTraders carried tea along the Tea Horse Road to Tibet.\n",
      },
    ]);

    const { finished } = await askAndFinish(core, client, mind.id, "How did tea reach Tibet?");

    expect(asked).toContain("unmarked-quotes");
    expect(finished.usage).toEqual(stored(100, 200, 300));
  });

  // protects=the claimed-change check's tokens count in the Answer's usage when its reply doesn't hold to the schema and is read as JSON; fails_when=the salvaged reply's tokens are lost, as they were (#2817).
  test("counts the claimed-change check, read from a reply in a code fence", async () => {
    const { asked, heard } = asking();
    const claim = "I've added the summary to “Q3 review”.";
    const model = scriptedModel(
      (call) =>
        call.tools.length > 0
          ? { error: { status: 400, message: "this model does not support tools" } }
          : { text: `${claim}\n\n## Summary\n\nGood.`, usage: reported(200) },
      {
        generate: (call) => {
          const verdict = claimCheckReply(call, [{ sentence: claim, kind: "added" }]);
          return heard(
            call.question,
            "text" in verdict
              ? { text: `\`\`\`json\n${verdict.text}\n\`\`\``, usage: reported(500) }
              : verdict,
          );
        },
      },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Q3 review" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [heading(2, "Summary"), note("The quarter was good.")]);
    await client.settled();
    const finished = new Promise<AnswerUsage>((resolve) =>
      core.on("answer.finished", ({ usage }) => resolve(usage)),
    );

    const answer = await askAssistant(core, { text: "write a summary page", mindId: mind.id });

    expect(answer.steps?.unbackedClaims).toEqual(["added"]);
    // Nothing was changed, so the check also asks whether the reply says the request is done.
    expect(asked).toEqual(["claimed-changes", "request-done"]);
    const requests = model.doStreamCalls.filter((call) => !call.tools?.length).length;
    expect(await finished).toEqual(stored(...Array(requests).fill(200), 500, 500));
  });

  // protects=a local model's retries of its quotes and its figures count where the Answer counts its own requests; fails_when=either retry's tokens are left out, as they were (#2817).
  test("counts a local model's retries of its quotes and its figures", async () => {
    const margin = "Gross margin 41.2% 38.9%";
    const figure = {
      marker: 1,
      label: "Change in gross margin",
      formula: "gm2025 - gm2024",
      inputs: [
        { name: "gm2025", label: "Gross margin 2025", citation: 1, number: "41.2%" },
        { name: "gm2024", label: "Gross margin 2024", citation: 1, number: "38.9%" },
      ],
    };
    const calculated: unknown[][] = [];
    const documents: AnswerTools = {
      documentCount: 1,
      async searchDocuments() {
        return {
          text: `<passage id="P1" document="Acme Annual Report 2025" pages="2">\n${margin}\n</passage>`,
          passageCount: 1,
        };
      },
      cite: () => "Recorded [^1].",
      hasRecord: () => true,
      unfoundQuotes: () => [
        { marker: 1, passage: "P1", quote: "Gross margins 41.2 and 38.9", text: margin },
      ],
      correctQuote: () => true,
      calculate(figures) {
        calculated.push([...figures]);
        return "";
      },
      figureProblems: () =>
        calculated.length < 2
          ? [
              {
                marker: 1,
                given: JSON.stringify(figure),
                problems: ['[=1] gm2025: the quote has no number "42.1%".'],
                passages: [{ id: "P1", text: margin }],
              },
            ]
          : [],
    };
    const { asked, heard } = asking();
    const model = scriptedModel((call) => {
      if (call.question === "quote-retry")
        return heard(call.question, {
          text: JSON.stringify({ quotes: [{ marker: 1, quote: margin }] }),
          usage: reported(300),
        });
      if (call.question === "figure-retry")
        return heard(call.question, {
          text: JSON.stringify({ calculations: [figure] }),
          usage: reported(400),
        });
      return {
        text: JSON.stringify({
          answer: "Gross margin rose [=1][^1].",
          citations: [
            { marker: 1, passage: "P1", location: "p. 2", quote: "Gross margins 41.2 and 38.9" },
          ],
          calculations: [
            { ...figure, inputs: [{ ...figure.inputs[0], number: "42.1%" }, figure.inputs[1]] },
          ],
        }),
        usage: reported(1_000),
      };
    });
    const counted: TokenUsage[] = [];
    const events = createAiSdkAnswerEngine().generate({
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
    });

    // As the Answer counts them: its own requests' usage events, and its judges' calls.
    for await (const event of countingJudges(events, (usage) => counted.push(usage))) {
      if (event.type === "usage") counted.push(event.usage);
    }

    expect(asked).toEqual(["quote-retry", "figure-retry"]);
    const sum = (key: keyof TokenUsage) =>
      counted.reduce((total, each) => total + (each[key] ?? 0), 0);
    expect({ inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens") }).toEqual({
      inputTokens: 1_700,
      outputTokens: 170,
    });
  });
});
