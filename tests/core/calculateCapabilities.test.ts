/**
 * What each model measured to use `calculate` is offered beside it (ADR-0021, #441): Claude and
 * OpenAI's models get `calculate`, the workbook Tools, the Analysis Tool and `calculate` in claim
 * checks; DeepSeek Flash gets `calculate` in Answers only, since only that was measured; DeepSeek
 * V4 Pro, never measured, gets none of them. Through the core's public interface, in English
 * and in Chinese, with a scripted model that only answers.
 */
import { describe, expect, test } from "vitest";
import type { SaveChatProviderInput } from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { ANALYSIS_TOOLS, WORKBOOK_TOOLS } from "../../src/core/tools";
import { isCheckRun } from "../helpers/checks";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { xlsxOf } from "../helpers/office";

const SALES = xlsxOf([
  {
    name: "Sales",
    rows: [
      ["Region", "2024", "2025"],
      ["North", 120, 150],
    ],
  },
]);

const PROVIDERS: Record<string, SaveChatProviderInput> = {
  "Claude Haiku 5.5": { kind: "anthropic", apiKey: "sk-test", modelId: "claude-haiku-5-5" },
  "GPT-6 Luna": { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" },
  "DeepSeek Flash": { kind: "deepseek", apiKey: "sk-test", modelId: "deepseek-flash" },
  "DeepSeek V4 Pro": { kind: "deepseek", apiKey: "sk-test", modelId: "deepseek-v4-pro" },
};

const WATCHED = ["calculate", WORKBOOK_TOOLS.trace, WORKBOOK_TOOLS.whatIf, ANALYSIS_TOOLS.run];

/** A core with the workbook, a stand-in Analysis runtime and `provider`, and the Tools each request offered. */
async function setUp(provider: SaveChatProviderInput) {
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call)
        ? { text: "Verdict: unsupported\nAbsence: no" }
        : { text: "North sold 150 in 2025." };
    },
    { generate: () => ({ text: "{}" }) },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: createFakeAnalysisRuntime({ answer: () => ({ output: {} }) }),
    answerPaths: { retrievesFirst: () => false },
  });
  const saved = await core.saveChatProvider(provider);
  if (saved.service) {
    await core.allowDataFlow("chat", saved.service.id);
    await core.allowDataFlow("checks", saved.service.id);
  }
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, "Sales.xlsx", SALES)]);
  const offered = (filter: (call: ModelCall) => boolean) =>
    WATCHED.filter((name) => calls.filter(filter).some((call) => call.tools.includes(name)));
  const requested = (filter: (call: ModelCall) => boolean) =>
    calls
      .filter(filter)
      .filter((call) => call.tools.includes("search_documents") || call.tools.includes("cite"))
      .length;
  return { core, offered, requested };
}

describe.each([
  ["en", "How much did North sell in 2025?", "North sold 150 in 2025."],
  ["zh", "North区域2025年销售了多少？", "North区域2025年销售了150。"],
])("Tools beside calculate, in %s", (_, question, claim) => {
  test.each([
    ["Claude Haiku 5.5", WATCHED, ["calculate"]],
    ["GPT-6 Luna", WATCHED, ["calculate"]],
    ["DeepSeek Flash", ["calculate"], []],
    ["DeepSeek V4 Pro", [], []],
  ])("%s: an Answer is offered %j, a claim check %j", async (name, inAnswers, inChecks) => {
    const provider = PROVIDERS[name];
    if (!provider) throw new Error(`No provider ${name}.`);
    const { core, offered, requested } = await setUp(provider);

    const asked = await core.askInConversation({ text: question, analyse: true });
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
    await answerEnded(core, asked.answerId);
    expect(requested((call) => !isCheckRun(call))).toBeGreaterThan(0);
    expect(offered((call) => !isCheckRun(call))).toEqual(inAnswers);

    await core.checkClaim({ claim });
    expect(requested(isCheckRun)).toBeGreaterThan(0);
    expect(offered(isCheckRun)).toEqual(inChecks);
  });
});
