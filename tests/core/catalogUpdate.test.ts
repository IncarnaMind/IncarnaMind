import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { diffModels, formatDiff, generateModels, isEmpty } from "../../scripts/catalogModels";

type Source = Parameters<typeof generateModels>[0];

const model = (name: string, cost: { input: number; output: number }, context = 200000) => ({
  name,
  tool_call: true,
  reasoning: false,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context, output: 8000 },
  cost,
});

/** models.dev as a fixture: the models of the anthropic provider by id. */
const sources = (models: Record<string, ReturnType<typeof model>>): Source => ({
  anthropic: { models },
});

const ROLES = { anthropic: { answers: "sonnet", quickTasks: "haiku" } };

const before = generateModels(
  sources({
    sonnet: model("Sonnet", { input: 3, output: 15 }),
    haiku: model("Haiku", { input: 1, output: 5 }),
    old: model("Old", { input: 2, output: 10 }),
  }),
  {},
).providers;

describe("the catalog update's diff", () => {
  test("the same sources twice give no diff", () => {
    const again = generateModels(
      sources({
        old: model("Old", { input: 2, output: 10 }),
        haiku: model("Haiku", { input: 1, output: 5 }),
        sonnet: model("Sonnet", { input: 3, output: 15 }),
      }),
      {},
    ).providers;
    const diff = diffModels(before, again, ROLES);
    expect(isEmpty(diff)).toBe(true);
    expect(formatDiff(diff)).toBe("No changes to the catalog's model facts.\n");
  });

  test("a new model is listed with its price and context", () => {
    const after = generateModels(
      sources({
        sonnet: model("Sonnet", { input: 3, output: 15 }),
        haiku: model("Haiku", { input: 1, output: 5 }),
        old: model("Old", { input: 2, output: 10 }),
        fresh: model("Fresh", { input: 4, output: 20 }, 1000000),
      }),
      {},
    ).providers;
    const diff = diffModels(before, after, ROLES);
    expect(diff.added).toEqual([
      "anthropic/fresh (Fresh, $4 in / $20 out per million tokens, context 1000000)",
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.defaults).toEqual([]);
  });

  test("a price change and a context change name the model and both values", () => {
    const after = generateModels(
      sources({
        sonnet: model("Sonnet", { input: 3, output: 15 }),
        haiku: model("Haiku", { input: 1, output: 5 }),
        old: model("Old", { input: 2.5, output: 10 }, 400000),
      }),
      {},
    ).providers;
    const diff = diffModels(before, after, ROLES);
    expect(diff.changed).toEqual([
      "anthropic/old: input price $2 -> $2.5",
      "anthropic/old: context 200000 -> 400000",
    ]);
    expect(diff.defaults).toEqual([]);
  });

  test("a removed model is listed", () => {
    const after = generateModels(
      sources({
        sonnet: model("Sonnet", { input: 3, output: 15 }),
        haiku: model("Haiku", { input: 1, output: 5 }),
      }),
      {},
    ).providers;
    const diff = diffModels(before, after, ROLES);
    expect(diff.removed).toEqual(["anthropic/old"]);
    expect(diff.defaults).toEqual([]);
  });

  test("a changed or removed default is called out, with the rule to cite an evaluation", () => {
    const after = generateModels(
      sources({
        sonnet: model("Sonnet", { input: 4, output: 15 }),
        old: model("Old", { input: 2, output: 10 }),
      }),
      {},
    ).providers;
    const diff = diffModels(before, after, ROLES);
    expect(diff.defaults).toEqual([
      "anthropic answers: sonnet changed (input price $3 -> $4)",
      "anthropic quickTasks: haiku is no longer in the sources",
    ]);
    const text = formatDiff(diff);
    expect(text).toContain("### A default changed");
    expect(text).toContain("needs the evaluation that cites it before this is merged");
    expect(text.indexOf("A default changed")).toBeLessThan(text.indexOf("Removed models"));
  });
});

describe("the catalog's reading of ids that answer by another API", () => {
  const audio = {
    ...model("Audio", { input: 2, output: 8 }),
    modalities: { input: ["text", "audio"], output: ["text", "audio"] },
  };

  test("a completion model, and a chat model that answers in audio, are in neither list", () => {
    const { providers } = generateModels(
      {
        openai: {
          models: {
            "gpt-4.1": model("GPT-4.1", { input: 2, output: 8 }),
            "gpt-audio": audio,
            "babbage-002": model("Babbage", { input: 0.4, output: 0.4 }),
            "whisper-1": { ...model("Whisper", { input: 1, output: 1 }), limit: { context: 0 } },
          },
        },
      },
      {
        "gpt-4.1": { litellm_provider: "openai", mode: "chat" },
        "babbage-002": { litellm_provider: "openai", mode: "completion" },
        "gpt-audio": {
          litellm_provider: "openai",
          mode: "chat",
          supported_endpoints: ["/v1/chat/completions", "/v1/realtime"],
          supported_output_modalities: ["text", "audio"],
        },
        "gpt-davinci": { litellm_provider: "openai", mode: "completion" },
        "text-embedding-3-small": { litellm_provider: "openai", mode: "embedding" },
      },
    );
    expect(providers.openai?.models.map((each) => each.id)).toEqual(["gpt-4.1"]);
    expect(providers.openai?.nonChat).toEqual(["text-embedding-3-small", "whisper-1"]);
    expect(providers.openai?.cannotAnswer).toEqual({
      "babbage-002": "completion",
      "gpt-audio": "audio",
      "gpt-davinci": "completion",
    });
  });
});

describe("Running the update with Node", () => {
  test("Node loads the catalog's providers, presets among them, with the resolve hook the script runs with", () => {
    const root = resolve(__dirname, "../..");
    const catalog = pathToFileURL(join(root, "src/core/providers/catalog/providers.ts")).href;
    const ids = execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "./scripts/tsResolve.mjs",
        "--input-type=module",
        "-e",
        `const { CATALOG_PROVIDERS } = await import(${JSON.stringify(catalog)}); console.log(CATALOG_PROVIDERS.map((each) => each.id).join(","));`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(ids.trim().split(",")).toContain("groq");
  });
});

// protects=weekly regeneration keeps listing-derived reasoning constraints; fails_when=a mandatory model loses its effort or Claude forced-choice restriction; no_claim=model quality.
test("catalog generation reads mandatory reasoning from OpenRouter's listing", () => {
  const ids = ["anthropic/claude-future", "vendor/future"];
  const base = {
    openrouter: {
      models: Object.fromEntries(ids.map((id) => [id, model(id, { input: 1, output: 1 })])),
    },
  };
  const generated = generateModels(
    base,
    {},
    ids.map((id) => ({
      id,
      reasoning: { mandatory: true, supported_efforts: ["high", "minimal"] },
    })),
  );
  const models = generated.providers.openrouter?.models;
  expect(models?.find((m) => m.id === ids[0])).toMatchObject({
    thinkingOff: { openrouter: { reasoning: { effort: "minimal" } } },
    forcedToolChoice: false,
  });
  expect(models?.find((m) => m.id === ids[1])).toMatchObject({
    thinkingOff: { openrouter: { reasoning: { effort: "minimal" } } },
  });
  expect(models?.find((m) => m.id === ids[1])?.forcedToolChoice).toBeUndefined();
  const diff = diffModels(generateModels(base, {}).providers, generated.providers);
  expect(diff.changed.join("\n")).toContain("small-call reasoning");
  expect(diff.changed.join("\n")).toContain("forced Tool choice");
});

test("Node can load the shared OpenRouter listing reader used by catalog regeneration", () => {
  const root = resolve(__dirname, "../..");
  const output = execFileSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "./scripts/tsResolve.mjs",
      "--input-type=module",
      "-e",
      'import { openRouterReasoningFacts } from "./src/core/providers/openrouterReasoning.ts"; console.log(JSON.stringify(openRouterReasoningFacts({ id:"anthropic/claude-future", reasoning:{ mandatory:true, supported_efforts:["high","low"] } })));',
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(JSON.parse(output)).toMatchObject({
    thinkingOff: { openrouter: { reasoning: { effort: "low" } } },
    forcedToolChoice: false,
  });
});
