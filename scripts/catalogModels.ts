/**
 * Writes src/core/providers/catalog/models.json, the catalog's model facts,
 * from models.dev's api.json (MIT), checked against LiteLLM's model list (MIT),
 * with mandatory-reasoning facts from OpenRouter: `node scripts/catalogModels.ts`.
 * It runs on a maintainer's computer, never in the app, and the app reads
 * only the file it writes. With `--models-dev <file>` and `--litellm <file>`
 * it reads copies instead of fetching them; --openrouter reads its model-list copy.
 *
 * For each catalog provider it keeps models.dev's chat models (text in, text
 * out, a context window, and not something else by LiteLLM's mode) with
 * their facts, and lists the ids either source knows as something else
 * (embeddings, speech, images, video, realtime), which the app never offers.
 * An id LiteLLM says answers by another API than chat (a completion model, or
 * a chat model that answers in audio) is in neither list: the app doesn't
 * know it as a chat model, so it waits under "Other models".
 * Where LiteLLM disagrees on Tools, images, JSON schema or limits, it prints
 * the difference and changes nothing: ./src/core/providers/catalog/overrides.ts
 * is where a person corrects a fact.
 *
 * `npm run catalog:update` is this script. After writing, it prints what
 * changed since the file it replaced: new and removed models, changed prices,
 * limits and abilities, and a provider's default (./providers.ts roles) whose
 * model changed or disappeared. `--diff-file <file>` also writes that diff
 * as Markdown, for the weekly pull request (.github/workflows/catalog-update.yml).
 * Overrides are never touched: they live in their own file.
 *
 * Both sources' licences ask for their notice to go with the data: it is
 * written to resources/notices/model-catalog.txt, which ships in the app's
 * resources folder (electron-builder.yml).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "../src/shared/record";
import { openRouterReasoningFacts } from "../src/core/providers/openrouterReasoning";
import type {
  CatalogModel,
  GeneratedProviderModels,
  ModelInput,
  Price,
  PriceTier,
} from "../src/core/providers/catalog/types";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(root, "src/core/providers/catalog/models.json");
const NOTICE_FILE = join(root, "resources/notices/model-catalog.txt");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Each model set's id at models.dev and at LiteLLM (`litellm_provider`). A set is a catalog
 * provider's models, or, for a provider with regions whose model lists differ, one region's:
 * the first endpoint's set is the provider's id, another's is "<provider>/<endpoint>" (see
 * catalog/index). `prices: false` leaves the source's prices out: models.dev gives every
 * price in US dollars, and a provider that bills in yuan has them in overrides.ts instead.
 */
const SOURCES: Record<
  string,
  { modelsDev: string; litellm: string; litellmAlso?: string; prices?: false }
> = {
  anthropic: { modelsDev: "anthropic", litellm: "anthropic" },
  // LiteLLM files OpenAI's completion models under their own provider.
  openai: { modelsDev: "openai", litellm: "openai", litellmAlso: "text-completion-openai" },
  google: { modelsDev: "google", litellm: "gemini" },
  openrouter: { modelsDev: "openrouter", litellm: "openrouter" },
  mistral: { modelsDev: "mistral", litellm: "mistral" },
  xai: { modelsDev: "xai", litellm: "xai" },
  deepseek: { modelsDev: "deepseek", litellm: "deepseek", prices: false },
  qwen: { modelsDev: "alibaba-cn", litellm: "dashscope", prices: false },
  "qwen/intl": { modelsDev: "alibaba", litellm: "dashscope" },
  kimi: { modelsDev: "moonshotai-cn", litellm: "moonshot", prices: false },
  "kimi/intl": { modelsDev: "moonshotai", litellm: "moonshot" },
  glm: { modelsDev: "zhipuai", litellm: "zai", prices: false },
  "glm/intl": { modelsDev: "zai", litellm: "zai" },
  siliconflow: { modelsDev: "siliconflow-cn", litellm: "siliconflow", prices: false },
  "siliconflow/intl": { modelsDev: "siliconflow", litellm: "siliconflow" },
  groq: { modelsDev: "groq", litellm: "groq" },
  together: { modelsDev: "togetherai", litellm: "together_ai" },
  fireworks: { modelsDev: "fireworks-ai", litellm: "fireworks_ai" },
  cerebras: { modelsDev: "cerebras", litellm: "cerebras" },
  cohere: { modelsDev: "cohere", litellm: "cohere_chat" },
  venice: { modelsDev: "venice", litellm: "venice" },
  bedrock: { modelsDev: "amazon-bedrock", litellm: "bedrock_mantle" },
  cloudflare: { modelsDev: "cloudflare-workers-ai", litellm: "cloudflare" },
};

const MIT = (copyright: string) =>
  [
    "MIT License",
    "",
    copyright,
    "",
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
    "",
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  ].join("\n");

/** The notice that goes with the generated facts. */
const NOTICE = [
  "IncarnaMind's model catalog (src/core/providers/catalog/models.json) is generated from",
  "models.dev and checked against LiteLLM's model list, under these licences. The rest of",
  "IncarnaMind is under its own licence (Apache-2.0).",
  "",
  "models.dev: https://github.com/anomalyco/models.dev",
  "",
  MIT("Copyright (c) 2025 models.dev"),
  "",
  "LiteLLM (model_prices_and_context_window.json): https://github.com/BerriAI/litellm",
  "",
  MIT("Copyright (c) 2023 Berri AI"),
  "",
].join("\n");

interface ModelsDevModel {
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    /** Prices for a longer prompt: `tier.size` is the prompt length a request is over. */
    tiers?: {
      input?: number;
      output?: number;
      cache_read?: number;
      tier?: { type?: string; size?: number };
    }[];
  };
  status?: string;
}

interface LiteLlmEntry {
  litellm_provider?: string;
  mode?: string;
  supported_endpoints?: string[];
  supported_output_modalities?: string[];
  max_input_tokens?: number;
  max_output_tokens?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_response_schema?: boolean;
}

const INPUTS: readonly ModelInput[] = ["text", "image", "pdf", "audio", "video"];
const CHAT_MODES = new Set(["chat", "responses"]);

/** LiteLLM's entries of one provider, by model id (its key without a provider or size prefix). */
function litellmEntries(all: Record<string, LiteLlmEntry>, provider: string) {
  const entries = new Map<string, LiteLlmEntry>();
  for (const [key, entry] of Object.entries(all)) {
    if (entry.litellm_provider !== provider) continue;
    const id = key.split("/").at(-1) ?? key;
    // A key without a prefix wins over a prefixed one for the same id.
    if (!entries.has(id) || !key.includes("/")) entries.set(id, entry);
  }
  return entries;
}

/** Whether LiteLLM says the model answers by another API than chat: by completion, or in audio. */
const answersElsewhere = (entry: LiteLlmEntry | undefined): boolean =>
  entry?.mode === "completion" ||
  (entry !== undefined &&
    CHAT_MODES.has(entry.mode ?? "") &&
    entry.supported_endpoints?.includes("/v1/chat/completions") === true &&
    entry.supported_output_modalities?.includes("audio") === true);

/** Whether models.dev's entry is a chat model: text in, text only out, a context window. */
function readsAndWritesText(model: ModelsDevModel): boolean {
  const input = model.modalities?.input ?? [];
  const output = model.modalities?.output ?? [];
  return (
    input.includes("text") &&
    output.length === 1 &&
    output[0] === "text" &&
    (model.limit?.context ?? 0) > 0
  );
}

/** models.dev's prices by prompt length, lowest threshold first; other kinds of tier are left out. */
function tiersOf(cost: ModelsDevModel["cost"]): PriceTier[] {
  const tiers: PriceTier[] = [];
  for (const { tier, input, output, cache_read } of cost?.tiers ?? []) {
    if (tier?.type !== "context" || tier.size === undefined) continue;
    if (input === undefined || output === undefined) continue;
    tiers.push({
      above: tier.size,
      input,
      output,
      ...(cache_read !== undefined && { cacheRead: cache_read }),
    });
  }
  return tiers.sort((a, b) => a.above - b.above);
}

function factsOf(id: string, model: ModelsDevModel, prices: boolean): CatalogModel {
  const { context = 0, input: maxInput, output: maxOutput } = model.limit ?? {};
  const cost = model.cost;
  const tiers = tiersOf(cost);
  const status =
    model.status === "deprecated"
      ? "deprecated"
      : model.status === "alpha" || model.status === "beta"
        ? "preview"
        : undefined;
  return {
    id,
    name: model.name ?? id,
    input: INPUTS.filter((each) => model.modalities?.input?.includes(each)),
    tools: model.tool_call === true,
    ...(model.structured_output !== undefined && {
      structuredOutput: model.structured_output ? ("json_schema" as const) : ("none" as const),
    }),
    reasoning: model.reasoning === true,
    ...(model.temperature !== undefined && { temperature: model.temperature }),
    context,
    // models.dev gives an input limit where the provider has one below the window.
    ...(maxInput !== undefined && maxInput > 0 && maxInput < context && { maxInput }),
    ...(maxOutput !== undefined && maxOutput > 0 && { maxOutput }),
    ...(prices &&
      cost?.input !== undefined &&
      cost.output !== undefined && {
        price: {
          currency: "USD" as const,
          input: cost.input,
          output: cost.output,
          ...(cost.cache_read !== undefined && { cacheRead: cost.cache_read }),
          ...(tiers.length > 0 && { tiers }),
        },
      }),
    ...(status && { status }),
  };
}

/** Where LiteLLM says otherwise than the facts, as lines to print. */
function disagreements(provider: string, model: CatalogModel, entry: LiteLlmEntry): string[] {
  const lines: string[] = [];
  const differ = (what: string, ours: unknown, theirs: unknown) => {
    if (theirs !== undefined && ours !== theirs) {
      lines.push(`${provider}/${model.id}: ${what} is ${ours} here, ${theirs} in LiteLLM`);
    }
  };
  differ("Tools", model.tools, entry.supports_function_calling);
  differ("reading images", model.input?.includes("image"), entry.supports_vision);
  if (model.structuredOutput !== undefined) {
    differ("JSON schema", model.structuredOutput === "json_schema", entry.supports_response_schema);
  }
  differ("the input limit", model.maxInput ?? model.context, entry.max_input_tokens);
  differ("the output limit", model.maxOutput, entry.max_output_tokens);
  return lines;
}

/** The generated facts of every catalog provider, and the disagreements found. */
export function generateModels(
  modelsDev: Record<string, { models?: Record<string, ModelsDevModel> }>,
  litellm: Record<string, LiteLlmEntry>,
  openRouter: readonly Record<string, unknown>[] = [],
): { providers: Record<string, GeneratedProviderModels>; disagreements: string[] } {
  const providers: Record<string, GeneratedProviderModels> = {};
  const found: string[] = [];
  for (const [id, source] of Object.entries(SOURCES)) {
    const entries = litellmEntries(litellm, source.litellm);
    if (source.litellmAlso) {
      for (const [modelId, entry] of litellmEntries(litellm, source.litellmAlso)) {
        if (!entries.has(modelId)) entries.set(modelId, entry);
      }
    }
    const models: CatalogModel[] = [];
    const nonChat = new Set<string>();
    const cannotAnswer: GeneratedProviderModels["cannotAnswer"] = {};
    for (const [modelId, model] of Object.entries(modelsDev[source.modelsDev]?.models ?? {})) {
      const mode = entries.get(modelId)?.mode;
      if (answersElsewhere(entries.get(modelId))) continue;
      if (!readsAndWritesText(model) || (mode !== undefined && !CHAT_MODES.has(mode))) {
        nonChat.add(modelId);
        continue;
      }
      const facts = factsOf(modelId, model, source.prices !== false);
      const listed = id === "openrouter" ? openRouter.find((each) => each.id === modelId) : undefined;
      models.push({ ...facts, ...(listed && openRouterReasoningFacts(listed)) });
      const entry = entries.get(modelId);
      if (entry) found.push(...disagreements(id, facts, entry));
    }
    const chat = new Set(models.map((model) => model.id));
    for (const [modelId, entry] of entries) {
      const other = entry.mode && !CHAT_MODES.has(entry.mode) && !answersElsewhere(entry);
      if (other && !chat.has(modelId)) nonChat.add(modelId);
      if (answersElsewhere(entry) && !chat.has(modelId)) {
        cannotAnswer[modelId] = entry.mode === "completion" ? "completion" : "audio";
      }
    }
    providers[id] = {
      models: models.sort((a, b) => a.id.localeCompare(b.id)),
      cannotAnswer: Object.fromEntries(
        Object.entries(cannotAnswer).sort(([a], [b]) => a.localeCompare(b)),
      ),
      nonChat: [...nonChat].sort((a, b) => a.localeCompare(b)),
    };
  }
  return { providers, disagreements: found };
}

/** Provider id to role to the model id a person chose for it (providers.ts). */
export type Roles = Record<string, Partial<Record<string, string>>>;

export interface CatalogDiff {
  added: string[];
  removed: string[];
  /** One line per changed fact, such as "openai/gpt-6: input price $2 -> $3". */
  changed: string[];
  /** A provider role that points at a model that changed or is gone. */
  defaults: string[];
}

type Generated = Record<string, GeneratedProviderModels>;

const money = (value: number | undefined, currency = "USD") =>
  value === undefined ? "none" : `${currency === "USD" ? "$" : `${currency} `}${value}`;
const tokens = (value: number | undefined) => (value === undefined ? "none" : String(value));
const list = (value: readonly string[] | undefined) => (value?.length ? value.join(", ") : "none");
const tiersText = (price: Price | undefined) => {
  if (!price?.tiers?.length) return "none";
  const at = (value: number | undefined) => money(value, price.currency);
  return price.tiers
    .map(
      (tier) =>
        `over ${tier.above} tokens ${at(tier.input)} in / ${at(tier.output)} out / ${at(tier.cacheRead)} cached`,
    )
    .join("; ");
};

/** The differences between two entries of one model, one phrase each. */
function changesOf(before: CatalogModel, after: CatalogModel): string[] {
  const phrases: string[] = [];
  const differ = (what: string, was: string, now: string) => {
    if (was !== now) phrases.push(`${what} ${was} -> ${now}`);
  };
  const was = before.price;
  const now = after.price;
  const per = (field: "input" | "output" | "cacheRead", label: string) =>
    differ(`${label} price`, money(was?.[field], was?.currency), money(now?.[field], now?.currency));
  if (was && now) differ("price currency", was.currency, now.currency);
  per("input", "input");
  per("output", "output");
  per("cacheRead", "cached input");
  differ("prices by prompt length", tiersText(was), tiersText(now));
  differ("context", tokens(before.context), tokens(after.context));
  differ("input limit", tokens(before.maxInput), tokens(after.maxInput));
  differ("output limit", tokens(before.maxOutput), tokens(after.maxOutput));
  differ("reads", list(before.input), list(after.input));
  differ("Tools", String(before.tools), String(after.tools));
  differ(
    "structured output",
    before.structuredOutput ?? "unknown",
    after.structuredOutput ?? "unknown",
  );
  differ("reasoning", String(before.reasoning), String(after.reasoning));
  differ("forced Tool choice", String(before.forcedToolChoice), String(after.forcedToolChoice));
  differ("small-call reasoning", JSON.stringify(before.thinkingOff), JSON.stringify(after.thinkingOff));
  differ(
    "temperature",
    String(before.temperature ?? "unknown"),
    String(after.temperature ?? "unknown"),
  );
  differ("status", before.status ?? "current", after.status ?? "current");
  return phrases;
}

/**
 * What changed between the catalog's facts as they were and as they would be:
 * new and removed models, changed facts, and the defaults (the roles in
 * providers.ts) that point at a model that changed or is gone.
 */
export function diffModels(before: Generated, after: Generated, roles: Roles = {}): CatalogDiff {
  const diff: CatalogDiff = { added: [], removed: [], changed: [], defaults: [] };
  const changedBy = new Map<string, string[]>();
  const gone = new Set<string>();
  for (const providerId of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const was = new Map((before[providerId]?.models ?? []).map((each) => [each.id, each]));
    const now = new Map((after[providerId]?.models ?? []).map((each) => [each.id, each]));
    for (const [id, model] of now) {
      const old = was.get(id);
      if (!old) {
        const price = model.price
          ? `, ${money(model.price.input, model.price.currency)} in / ${money(model.price.output, model.price.currency)} out per million tokens`
          : "";
        diff.added.push(`${providerId}/${id} (${model.name}${price}, context ${model.context})`);
        continue;
      }
      const phrases = changesOf(old, model);
      if (phrases.length === 0) continue;
      changedBy.set(`${providerId}/${id}`, phrases);
      for (const phrase of phrases) diff.changed.push(`${providerId}/${id}: ${phrase}`);
    }
    for (const id of was.keys()) {
      if (now.has(id)) continue;
      gone.add(`${providerId}/${id}`);
      diff.removed.push(`${providerId}/${id}`);
    }
  }
  for (const [providerId, own] of Object.entries(roles)) {
    for (const [role, id] of Object.entries(own)) {
      if (!id) continue;
      const key = `${providerId}/${id}`;
      if (gone.has(key)) {
        diff.defaults.push(`${providerId} ${role}: ${id} is no longer in the sources`);
      } else if (changedBy.has(key)) {
        diff.defaults.push(`${providerId} ${role}: ${id} changed (${changedBy.get(key)?.join("; ")})`);
      }
    }
  }
  return diff;
}

export const isEmpty = (diff: CatalogDiff) =>
  diff.added.length + diff.removed.length + diff.changed.length + diff.defaults.length === 0;

/** The diff as Markdown, which reads as text in a terminal too. */
export function formatDiff(diff: CatalogDiff): string {
  if (isEmpty(diff)) return "No changes to the catalog's model facts.\n";
  const section = (title: string, lines: string[]) =>
    lines.length === 0
      ? []
      : [`### ${title} (${lines.length})`, "", ...lines.map((l) => `- ${l}`), ""];
  return [
    ...(diff.defaults.length > 0
      ? [
          "### A default changed",
          "",
          ...diff.defaults.map((l) => `- ${l}`),
          "",
          "A changed default needs the evaluation that cites it before this is merged.",
          "",
        ]
      : []),
    ...section("New models", diff.added),
    ...section("Removed models", diff.removed),
    ...section("Changed prices, limits and abilities", diff.changed),
  ].join("\n");
}

/** Provider roles from providers.ts, which holds only types and data. */
async function loadRoles(): Promise<Roles> {
  const file = join(root, "src/core/providers/catalog/providers.ts");
  const { CATALOG_PROVIDERS } = (await import(pathToFileURL(file).href)) as {
    CATALOG_PROVIDERS: readonly { id: string; roles: Roles[string] }[];
  };
  return Object.fromEntries(CATALOG_PROVIDERS.map((each) => [each.id, each.roles]));
}

async function load(flag: string, url: string): Promise<unknown> {
  const at = process.argv.indexOf(flag);
  const file = at === -1 ? undefined : process.argv[at + 1];
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const modelsDev = (await load("--models-dev", MODELS_DEV_URL)) as Parameters<
    typeof generateModels
  >[0];
  const litellm = (await load("--litellm", LITELLM_URL)) as Record<string, LiteLlmEntry>;
  const listing = await load("--openrouter", OPENROUTER_URL);
  if (!isRecord(listing) || !Array.isArray(listing.data)) throw new Error("Invalid OpenRouter model list");
  const { providers, disagreements: found } = generateModels(modelsDev, litellm, listing.data.filter(isRecord));
  const before: Generated = existsSync(OUTPUT)
    ? (JSON.parse(readFileSync(OUTPUT, "utf8")) as { providers: Generated }).providers
    : {};
  writeFileSync(OUTPUT, `${JSON.stringify({ providers }, null, 2)}\n`);
  execFileSync("npx", ["biome", "format", "--write", OUTPUT], { cwd: root, stdio: "inherit" });
  mkdirSync(dirname(NOTICE_FILE), { recursive: true });
  writeFileSync(NOTICE_FILE, NOTICE);
  for (const [id, { models, nonChat }] of Object.entries(providers)) {
    console.log(`${id}: ${models.length} chat models, ${nonChat.length} others`);
  }
  const diff = diffModels(before, providers, await loadRoles());
  const text = formatDiff(diff);
  console.log(`\n${text}`);
  const at = process.argv.indexOf("--diff-file");
  const diffFile = at === -1 ? undefined : process.argv[at + 1];
  if (diffFile) writeFileSync(diffFile, text);
  if (found.length > 0) {
    console.log("\nLiteLLM disagrees (nothing changed; correct a fact in overrides.ts):");
    for (const line of found) console.log(`  ${line}`);
  }
}
