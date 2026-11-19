/**
 * Every model that calls Tools is offered `calculate`, the workbook Tools and the Analysis Tool,
 * and in claim checks `calculate` and, with a sheet among the Documents, the Analysis Tool
 * (ADR-0021, #3282, #3357), whatever its provider; a model whose own facts switch `calculate` off
 * is offered none of them, and nor is a model on this computer, whose window depends on its memory.
 * Through the core's public interface, in English and in Chinese, with a scripted model that only
 * answers, and a stub of Ollama's API.
 */
import { describe, expect, test } from "vitest";
import type { SaveChatProviderInput } from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import type { ModelFactsLayer } from "../../src/core/providers/capabilities";
import { ANALYSIS_TOOLS, WORKBOOK_TOOLS } from "../../src/core/tools";
import { isCheckRun } from "../helpers/checks";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { GIB, QWEN35_9B, setUpLocalModel, TIDES } from "../helpers/localModels";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { xlsxOf } from "../helpers/office";
import { startOllamaServer } from "../helpers/ollama";

const SALES = xlsxOf([
  {
    name: "Sales",
    rows: [
      ["Region", "2024", "2025"],
      ["North", 120, 150],
    ],
  },
]);

const PROVIDERS: Record<string, { provider: SaveChatProviderInput; facts?: ModelFactsLayer }> = {
  "Claude Haiku 5.5": {
    provider: { kind: "anthropic", apiKey: "sk-test", modelId: "claude-haiku-5-5" },
  },
  "GPT-6 Luna": { provider: { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" } },
  "Gemini 3.8 Flash": {
    provider: { kind: "google", apiKey: "test-key", modelId: "gemini-3.8-flash" },
  },
  "DeepSeek Flash": {
    provider: { kind: "deepseek", apiKey: "sk-test", modelId: "deepseek-flash" },
  },
  "GPT-6.1 Sol through OpenRouter": {
    provider: { kind: "openrouter", apiKey: "sk-or-test", modelId: "openai/gpt-6.1-sol" },
  },
  "DeepSeek Flash, calculate switched off": {
    provider: { kind: "deepseek", apiKey: "sk-test", modelId: "deepseek-flash" },
    facts: { calculates: false },
  },
};

const WATCHED = ["calculate", WORKBOOK_TOOLS.trace, WORKBOOK_TOOLS.whatIf, ANALYSIS_TOOLS.run];
const CHECKED = ["calculate", ANALYSIS_TOOLS.run];

/** A core with the workbook, a stand-in Analysis runtime and `provider`, and the Tools each request offered. */
async function setUp({
  provider,
  facts,
}: {
  provider: SaveChatProviderInput;
  facts?: ModelFactsLayer;
}) {
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call)
        ? { text: "Verdict: unsupported\nEvidence: []" }
        : { text: "North sold 150 in 2025." };
    },
    { generate: () => ({ text: "{}" }) },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: createFakeAnalysisRuntime({ answer: () => ({ output: {} }) }),
    answerPaths: { retrievesFirst: () => false },
    ...(facts && { modelFacts: () => facts }),
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
    ["Claude Haiku 5.5", WATCHED, CHECKED],
    ["GPT-6 Luna", WATCHED, CHECKED],
    ["Gemini 3.8 Flash", WATCHED, CHECKED],
    ["DeepSeek Flash", WATCHED, CHECKED],
    ["GPT-6.1 Sol through OpenRouter", WATCHED, CHECKED],
    ["DeepSeek Flash, calculate switched off", [], []],
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

describe("A model in Ollama", () => {
  test.each([
    ["on this computer, in a window of 32,768 tokens", QWEN35_9B, false],
    ["in Ollama's cloud", { ...QWEN35_9B, name: "qwen3.5:397b-cloud", remote: true }, true],
  ] as const)("%s: an Answer is offered calculate: %s", async (_, model, offered) => {
    const ollama = await startOllamaServer({
      models: [model],
      reply: () => ({ content: "Spring tides come at new moon and at full moon." }),
    });
    const { core } = await setUpLocalModel(ollama, model.name, {
      memory: 64 * GIB,
      documents: [{ name: "Tides.md", contents: TIDES }],
    });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));

    const asked = await core.askInConversation({ text: "When are spring tides?" });
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
    await answerEnded(core, asked.answerId);
    const tools = ollama.chats.flatMap((chat) =>
      ((chat.body.tools as { function: { name: string } }[] | undefined) ?? []).map(
        (tool) => tool.function.name,
      ),
    );
    expect(tools).toContain("search_documents");
    expect(tools.includes("calculate")).toBe(offered);
  });
});
