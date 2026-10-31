/**
 * The evaluation's settings, from environment variables only (see
 * eval/README.md). Keys are read from INCARNAMIND_EVAL_* variables and never
 * from OPENAI_API_KEY and the like, so a key set for other tools can't make a
 * run spend money by accident.
 */
import { join } from "node:path";
import {
  type ChatProviderKind,
  type CitationSupport,
  chatProviderKinds,
  type RerankingModelDefinition,
  type SaveChatProviderInput,
} from "../../src/core";
import { endpointUrl } from "../../src/core/providers/kinds";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { evalCache } from "./cache";
import { RERANKING_MODEL_CANDIDATES } from "./rerankingModels";

/** The chat model the Citation part asks Questions with. */
export interface ChatSettings {
  kind: ChatProviderKind;
  modelId: string;
  apiKey: string | null;
  baseUrl: string | null;
  /**
   * A hosted provider's endpoint, by its id in the app's catalog, e.g. "intl"
   * for Kimi International (INCARNAMIND_EVAL_CHAT_ENDPOINT). Null: its first.
   */
  endpoint: string | null;
  /**
   * "ollama" only: the context window, `num_ctx`, every request carries
   * instead of the one chosen from this computer's memory, so local runs are
   * comparable (INCARNAMIND_EVAL_CHAT_NUM_CTX). Null: the app's choice.
   */
  numCtx: number | null;
  /**
   * "ollama" only: how the model cites instead of the app's rule, to compare
   * citing modes (INCARNAMIND_EVAL_CHAT_CITING). Null: the app's rule.
   */
  citing: CitationSupport | null;
}

const citingModes: readonly CitationSupport[] = ["tools", "structured-output", "none"];

const cloudEmbeddingKinds = ["openai", "google"] as const;
export type CloudEmbeddingKind = (typeof cloudEmbeddingKinds)[number];

/** A cloud embedding model, reported next to the built-in one (never gating). */
export interface CloudEmbeddingSettings {
  kind: CloudEmbeddingKind;
  modelId: string;
  apiKey: string;
  /** An OpenAI-compatible server instead of OpenAI's API ("openai" only). */
  baseUrl: string | null;
}

export interface EvalConfig {
  /** The repository root: the evaluation set and the sample PDFs are read from here. */
  root: string;
  /** Where the built-in embedding model is downloaded once and kept between runs. Outside the repo. */
  cacheDir: string;
  /** Each run writes its reports into a new folder in here. */
  resultsDir: string;
  /** Keep the temporary data folders, for looking into a run. */
  keepData: boolean;
  chat: ChatSettings | null;
  /** The model that judges Answers where an eval asks one (INCARNAMIND_EVAL_JUDGE_*); null: the chat model. */
  judge: ChatSettings | null;
  cloudEmbedding: CloudEmbeddingSettings | null;
  /**
   * Reranking candidates whose reranked modes to report next to the built-in
   * one's, which always runs and gates (INCARNAMIND_EVAL_RERANK); none by default.
   */
  rerank: RerankingModelDefinition[];
  /**
   * The built-in reranking model runs on the CPU, as on a computer with no GPU
   * (INCARNAMIND_EVAL_RERANK_CPU=1); otherwise on the GPU where it can, as in the app.
   */
  rerankOnCpu: boolean;
  /** Each language needs at least this many Citations for the Citation targets to count. */
  minCitations: number;
  /** At most this many rounds of Questions to reach `minCitations`. */
  maxRounds: number;
  /** An Answer that takes longer is stopped and counted as failed. */
  answerTimeoutMs: number;
  /**
   * Only these Questions are asked, by id, each once: a short check
   * (INCARNAMIND_EVAL_QUESTIONS). Retrieval still scores every Question, and
   * a run that asks only some never gates on Citations. Null: all of them.
   */
  questionIds: string[] | null;
  /**
   * How many of keyword search's best the search Tool's reranker sees in
   * Answers' searches, or "off" for none (INCARNAMIND_EVAL_RERANK_DEPTH). Null: the app's.
   */
  rerankDepth: number | "off" | null;
  /** How many Passages a search hands the model (INCARNAMIND_EVAL_MAX_PASSAGES). Null: the app's. */
  maxPassages: number | null;
  /** Whether the every-format set runs too (INCARNAMIND_EVAL_FORMATS: on by default). */
  formats: boolean;
  /**
   * Whether keyword + rewrites and keyword + sub-questions also run with a
   * local chat model (INCARNAMIND_EVAL_LOCAL_QUERY_MODES: off by default), which
   * would make a call per Question per mode.
   */
  localQueryModes: boolean;
  /** The sets `npm run eval:dump` dumps (INCARNAMIND_EVAL_DUMP_SETS: all three by default). */
  dumpSets: DumpSet[];
}

export const DUMP_SETS = ["gating", "formats", "hard"] as const;
export type DumpSet = (typeof DUMP_SETS)[number];

type Env = Readonly<Record<string, string | undefined>>;

const PREFIX = "INCARNAMIND_EVAL_";

function value(env: Env, name: string): string | null {
  const raw = env[`${PREFIX}${name}`]?.trim();
  return raw ? raw : null;
}

function positiveInteger(env: Env, name: string, fallback: number): number {
  const raw = value(env, name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${PREFIX}${name} must be a whole number of at least 1, not "${raw}".`);
  }
  return parsed;
}

export function chatSettings(
  env: Env,
  role: "CHAT" | "JUDGE" | "SECOND_JUDGE" | "HARNESS_CHECK" = "CHAT",
): ChatSettings | null {
  const kind = value(env, `${role}_KIND`);
  const modelId = value(env, `${role}_MODEL`);
  const apiKey = value(env, `${role}_KEY`);
  const baseUrl = value(env, `${role}_BASE_URL`);
  const endpoint = value(env, `${role}_ENDPOINT`);
  if (kind === null) {
    if (modelId || apiKey || baseUrl || endpoint) {
      throw new Error(
        `Set ${PREFIX}${role}_KIND too, or none of the ${PREFIX}${role}_* variables.`,
      );
    }
    return null;
  }
  // The ChatGPT plan signs in through a browser, which a run can't do.
  const allowed = chatProviderKinds.filter((each) => each !== "chatgpt");
  const found = allowed.find((each) => each === kind);
  if (!found) {
    throw new Error(`${PREFIX}${role}_KIND must be one of ${allowed.join(", ")}, not "${kind}".`);
  }
  if (!modelId) throw new Error(`Set ${PREFIX}${role}_MODEL to the model to ask, e.g. a model id.`);
  if ((found === "openai" || found === "anthropic" || found === "google") && !apiKey) {
    throw new Error(`Set ${PREFIX}${role}_KEY to an API key for ${found}.`);
  }
  if (found === "openai-compatible" && !baseUrl) {
    throw new Error(`Set ${PREFIX}${role}_BASE_URL to the server's URL.`);
  }
  const numCtx =
    value(env, `${role}_NUM_CTX`) === null ? null : positiveInteger(env, `${role}_NUM_CTX`, 1);
  const citingValue = value(env, `${role}_CITING`);
  const citing = citingModes.find((each) => each === citingValue) ?? null;
  if (citingValue !== null && !citing) {
    throw new Error(
      `${PREFIX}${role}_CITING must be one of ${citingModes.join(", ")}, not "${citingValue}".`,
    );
  }
  if ((numCtx !== null || citing !== null) && found !== "ollama") {
    throw new Error(`${PREFIX}${role}_NUM_CTX and ${PREFIX}${role}_CITING only apply to "ollama".`);
  }
  return { kind: found, modelId, apiKey, baseUrl, endpoint, numCtx, citing };
}

/** The chat provider the app is given for `chat`, as the User adds one in Settings. */
export const chatProviderOf = (chat: ChatSettings): SaveChatProviderInput => ({
  kind: chat.kind,
  modelId: chat.modelId,
  ...(chat.apiKey !== null && { apiKey: chat.apiKey }),
  ...(chat.baseUrl !== null && { baseUrl: chat.baseUrl }),
  ...(chat.endpoint !== null && { endpoint: chat.endpoint }),
});

/** A model for `chat` made outside the app's settings (the judge's), at its endpoint. */
export const chatModelSpecOf = (chat: ChatSettings): ChatModelSpec => ({
  kind: chat.kind,
  modelId: chat.modelId,
  apiKey: chat.apiKey,
  baseUrl: chat.baseUrl ?? (chat.endpoint === null ? null : endpointUrl(chat.kind, chat.endpoint)),
  endpoint: chat.endpoint,
});

function cloudEmbeddingSettings(env: Env): CloudEmbeddingSettings | null {
  const kind = value(env, "EMBED_KIND");
  const modelId = value(env, "EMBED_MODEL");
  const apiKey = value(env, "EMBED_KEY");
  const baseUrl = value(env, "EMBED_BASE_URL");
  if (kind === null) {
    if (modelId || apiKey || baseUrl) {
      throw new Error(`Set ${PREFIX}EMBED_KIND too, or none of the ${PREFIX}EMBED_* variables.`);
    }
    return null;
  }
  const found = cloudEmbeddingKinds.find((each) => each === kind);
  if (!found) {
    throw new Error(
      `${PREFIX}EMBED_KIND must be one of ${cloudEmbeddingKinds.join(", ")}, not "${kind}".`,
    );
  }
  if (!modelId) throw new Error(`Set ${PREFIX}EMBED_MODEL, e.g. text-embedding-3-small.`);
  if (!apiKey) throw new Error(`Set ${PREFIX}EMBED_KEY to an API key for ${found}.`);
  if (baseUrl && found !== "openai") {
    throw new Error(`${PREFIX}EMBED_BASE_URL only applies to "openai".`);
  }
  return { kind: found, modelId, apiKey, baseUrl };
}

/** "all", or candidates' ids separated by commas, e.g. "mmarco-minilm,bge-m3". */
function rerankCandidates(env: Env): RerankingModelDefinition[] {
  const raw = value(env, "RERANK");
  if (raw === null) return [];
  if (raw === "all") return [...RERANKING_MODEL_CANDIDATES];
  return raw.split(",").map((each) => {
    const id = each.trim();
    const found = RERANKING_MODEL_CANDIDATES.find((candidate) => candidate.id === id);
    if (!found) {
      throw new Error(
        `${PREFIX}RERANK takes "all" or some of ${RERANKING_MODEL_CANDIDATES.map((candidate) => candidate.id).join(", ")}, not "${id}".`,
      );
    }
    return found;
  });
}

/** Question ids separated by commas, e.g. "en-07,zh-02", each once; null when not set. */
function questionIds(env: Env): string[] | null {
  const raw = value(env, "QUESTIONS");
  if (raw === null) return null;
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((each) => each.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) {
    throw new Error(
      `${PREFIX}QUESTIONS takes Question ids separated by commas, e.g. "en-07,zh-02".`,
    );
  }
  return ids;
}

/** A whole number of at least 1, or "off". */
function rerankDepth(env: Env): number | "off" | null {
  const raw = value(env, "RERANK_DEPTH");
  if (raw === null) return null;
  if (raw === "off") return "off";
  return positiveInteger(env, "RERANK_DEPTH", 1);
}

function maxPassages(env: Env): number | null {
  return value(env, "MAX_PASSAGES") === null ? null : positiveInteger(env, "MAX_PASSAGES", 1);
}

/** "on" (the default) or "off". */
function formatsOn(env: Env): boolean {
  const raw = value(env, "FORMATS");
  if (raw === null || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(`${PREFIX}FORMATS must be "on" or "off", not "${raw}".`);
}

/** "off" (the default) or "on". */
function localQueryModesOn(env: Env): boolean {
  const raw = value(env, "LOCAL_QUERY_MODES");
  if (raw === null || raw === "off") return false;
  if (raw === "on") return true;
  throw new Error(`${PREFIX}LOCAL_QUERY_MODES must be "on" or "off", not "${raw}".`);
}

/** "gating", "formats" and "hard", some or all, separated by commas; all by default. */
function dumpSets(env: Env): DumpSet[] {
  const raw = value(env, "DUMP_SETS");
  if (raw === null) return [...DUMP_SETS];
  return [
    ...new Set(
      raw.split(",").map((each) => {
        const found = DUMP_SETS.find((set) => set === each.trim());
        if (!found) {
          throw new Error(
            `${PREFIX}DUMP_SETS takes some of ${DUMP_SETS.join(", ")}, not "${each.trim()}".`,
          );
        }
        return found;
      }),
    ),
  ];
}

export function readConfig(root: string, env: Env = process.env): EvalConfig {
  return {
    root,
    cacheDir: evalCache(env),
    resultsDir: join(root, "eval", "results"),
    keepData: value(env, "KEEP_DATA") === "1",
    chat: chatSettings(env),
    judge: chatSettings(env, "JUDGE"),
    cloudEmbedding: cloudEmbeddingSettings(env),
    rerank: rerankCandidates(env),
    rerankOnCpu: value(env, "RERANK_CPU") === "1",
    minCitations: positiveInteger(env, "MIN_CITATIONS", 30),
    maxRounds: positiveInteger(env, "MAX_ROUNDS", 3),
    answerTimeoutMs: positiveInteger(env, "ANSWER_TIMEOUT_S", 300) * 1000,
    questionIds: questionIds(env),
    rerankDepth: rerankDepth(env),
    maxPassages: maxPassages(env),
    formats: formatsOn(env),
    localQueryModes: localQueryModesOn(env),
    dumpSets: dumpSets(env),
  };
}
