/**
 * The hosts of decision models other than TypeSafe's own Jev (../jev.ts): small models that answer
 * typed questions (a yes or no, one of several options) with calibrated probabilities instead of
 * text (#1907). Each is reached with the User's key: a chat provider's in Settings › Models
 * (OpenRouter, OpenAI, Alibaba Cloud's Model Studio through the Qwen key), or one of its own.
 *
 * Read from each host's own documentation on 2026-11-07:
 * - OpenRouter: `POST https://openrouter.ai/api/v1/systemone`, TypeSafe's protocol. It refuses a
 *   yes-or-no question with only a "true" criterion (docs/research/decision-models-refresh-2026-10-25.md).
 * - Perplexity: `POST https://api.perplexity.ai/v1/decisions`, the same body and answers.
 * - Liquid AI: `POST https://api.liquid.ai/decisions/v1/systemone`.
 * - Cloudflare Workers AI: `POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}`,
 *   the same body with `model` "clef" or "clef-flash"; at most 64 questions a request.
 * - OpenAI: `POST https://api.openai.com/v1/decisions`, a shape of its own (see ../jev.ts).
 * - Alibaba Cloud Model Studio: `POST https://{workspace}.{region}.maas.aliyuncs.com/compatible-mode/v1/systemone`,
 *   Beijing or Singapore by the key's region; at most 16 questions a request.
 */
import type { ExternalService } from "../../api";
import type { DecisionEndpoint } from "../jev";
import type { Localized } from "./types";

export const DECISION_HOSTS = [
  "openrouter",
  "perplexity",
  "liquid",
  "cloudflare",
  "openai",
  "alibaba",
] as const;
export type DecisionHost = (typeof DECISION_HOSTS)[number];

export const isDecisionHost = (value: unknown): value is DecisionHost =>
  typeof value === "string" && (DECISION_HOSTS as readonly string[]).includes(value);

export interface DecisionModel {
  /** What a request names. */
  id: string;
  name: string;
  /** Who made it, where that isn't the host. */
  maker: string;
  /** US dollars per million input tokens; output is free on every host. */
  inputPerMillion: number | null;
}

export interface DecisionHostEntry {
  host: DecisionHost;
  name: Localized;
  /**
   * "provider": the key of the chat provider `provider` in Settings › Models; "own": a key of its
   * own, kept in the keychain.
   */
  key: "provider" | "own";
  provider?: string;
  /** What else the host needs: Cloudflare's account ID, or the Model Studio workspace. */
  account?: "cloudflare-account" | "alibaba-workspace";
  protocol: "systemone" | "openai";
  bothCriteria?: boolean;
  maxQuestions?: number;
  keyUrl: string;
  pricingUrl: string;
  /** Best first: the first is chosen when the host is set up from the sorting picker. */
  models: readonly DecisionModel[];
  /** When a person last checked this entry against the host's own pages (YYYY-MM-DD). */
  checked: string;
}

const CHECKED = "2026-11-07";

export const DECISION_HOST_ENTRIES: Readonly<Record<DecisionHost, DecisionHostEntry>> = {
  openrouter: {
    host: "openrouter",
    name: { en: "OpenRouter", zh: "OpenRouter" },
    key: "provider",
    provider: "openrouter",
    protocol: "systemone",
    bothCriteria: true,
    keyUrl: "https://openrouter.ai/settings/keys",
    pricingUrl: "https://openrouter.ai/models?output_modalities=decisions",
    models: [
      {
        id: "perplexity/pplx-decider-v1.2",
        name: "Decider v1.2",
        maker: "Perplexity",
        inputPerMillion: 0.02,
      },
      { id: "liquid/d1-ultra", name: "d1-ultra", maker: "Liquid AI", inputPerMillion: 0.042 },
      { id: "typesafe/jev-1.14", name: "Jev 1.14", maker: "TypeSafe", inputPerMillion: 0.042 },
      { id: "cloudflare/clef", name: "Clef", maker: "Cloudflare", inputPerMillion: 0.24 },
      {
        id: "microsoft/microsoft-decision-1",
        name: "Microsoft-Decision-1",
        maker: "Microsoft",
        inputPerMillion: 0.042,
      },
      {
        id: "inception/mercury-decide",
        name: "Mercury Decide",
        maker: "Inception",
        inputPerMillion: 0.02,
      },
      {
        id: "openai/gpt-6-luna-decisions",
        name: "GPT-6 Luna Decisions",
        maker: "OpenAI",
        inputPerMillion: 0.1,
      },
      { id: "nace-ai/drex-max", name: "Drex Max", maker: "Nace.AI", inputPerMillion: 0.06 },
      {
        id: "perplexity/pplx-decider-flash-v1.2",
        name: "Decider Flash v1.2",
        maker: "Perplexity",
        inputPerMillion: 0.01,
      },
    ],
    checked: CHECKED,
  },
  perplexity: {
    host: "perplexity",
    name: { en: "Perplexity", zh: "Perplexity" },
    key: "own",
    protocol: "systemone",
    maxQuestions: 128,
    keyUrl: "https://console.perplexity.ai/project/keys",
    pricingUrl: "https://docs.perplexity.ai/docs/decisions/quickstart",
    models: [
      { id: "pplx-decider-v1.2", name: "Decider v1.2", maker: "Perplexity", inputPerMillion: 0.02 },
      {
        id: "pplx-decider-flash-v1.2",
        name: "Decider Flash v1.2",
        maker: "Perplexity",
        inputPerMillion: 0.01,
      },
    ],
    checked: CHECKED,
  },
  liquid: {
    host: "liquid",
    name: { en: "Liquid AI", zh: "Liquid AI" },
    key: "own",
    protocol: "systemone",
    keyUrl: "https://console.liquid.ai",
    pricingUrl: "https://www.liquid.ai/pricing",
    models: [
      { id: "d1-ultra", name: "d1-ultra", maker: "Liquid AI", inputPerMillion: 0.042 },
      { id: "d1.1", name: "d1.1", maker: "Liquid AI", inputPerMillion: null },
    ],
    checked: CHECKED,
  },
  cloudflare: {
    host: "cloudflare",
    name: { en: "Cloudflare Workers AI", zh: "Cloudflare Workers AI" },
    key: "own",
    account: "cloudflare-account",
    protocol: "systemone",
    maxQuestions: 64,
    keyUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    pricingUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    models: [
      { id: "clef", name: "Clef", maker: "Cloudflare", inputPerMillion: 0.24 },
      { id: "clef-flash", name: "Clef-Flash", maker: "Cloudflare", inputPerMillion: 0.038 },
    ],
    checked: CHECKED,
  },
  openai: {
    host: "openai",
    name: { en: "OpenAI", zh: "OpenAI" },
    key: "provider",
    provider: "openai",
    protocol: "openai",
    maxQuestions: 400,
    keyUrl: "https://platform.openai.com/api-keys",
    pricingUrl: "https://developers.openai.com/api/docs/guides/decisions",
    models: [
      { id: "gpt-6-luna", name: "GPT-6 Luna Decisions", maker: "OpenAI", inputPerMillion: 0.1 },
    ],
    checked: CHECKED,
  },
  alibaba: {
    host: "alibaba",
    name: { en: "Alibaba Cloud", zh: "阿里云" },
    key: "provider",
    provider: "qwen",
    account: "alibaba-workspace",
    protocol: "systemone",
    maxQuestions: 16,
    keyUrl: "https://www.alibabacloud.com/help/en/model-studio/decision-model-api",
    pricingUrl: "https://www.alibabacloud.com/help/en/model-studio/decision-model-preview",
    models: [
      {
        id: "decision-model-preview",
        name: "Decision model preview",
        maker: "Alibaba Cloud",
        inputPerMillion: null,
      },
    ],
    checked: CHECKED,
  },
};

/** Where a host's requests go: what its key, account and region say. */
export interface DecisionHostAddress {
  /** Cloudflare's account ID, or the Model Studio workspace. */
  account: string | null;
  /** The chat provider's endpoint for a provider key with regions (Qwen's "cn" is Beijing). */
  region: string | null;
}

const ORIGINS: Record<Exclude<DecisionHost, "alibaba">, string> = {
  openrouter: "https://openrouter.ai",
  perplexity: "https://api.perplexity.ai",
  liquid: "https://api.liquid.ai",
  cloudflare: "https://api.cloudflare.com",
  openai: "https://api.openai.com",
};

const alibabaRegion = (region: string | null) =>
  region === "cn" ? "cn-beijing" : "ap-southeast-1";

/** The origin requests go to, which consent is recorded for; null while the account is missing. */
export function decisionOrigin(host: DecisionHost, address: DecisionHostAddress): string | null {
  if (host !== "alibaba") return ORIGINS[host];
  return address.account
    ? `https://${address.account}.${alibabaRegion(address.region)}.maas.aliyuncs.com`
    : null;
}

export function decisionService(
  host: DecisionHost,
  address: DecisionHostAddress,
): ExternalService | null {
  const origin = decisionOrigin(host, address);
  const entry = DECISION_HOST_ENTRIES[host];
  return origin ? { id: origin, name: entry.name.en } : null;
}

/**
 * The full URL of a host's decision endpoint for a model, at `origin` (the host's own, or a
 * stand-in in tests); null while the account is missing.
 */
export function decisionUrl(
  host: DecisionHost,
  model: string,
  address: DecisionHostAddress,
  origin: string | null = decisionOrigin(host, address),
): string | null {
  if (!origin) return null;
  switch (host) {
    case "openrouter":
      return `${origin}/api/v1/systemone`;
    case "perplexity":
      return `${origin}/v1/decisions`;
    case "liquid":
      return `${origin}/decisions/v1/systemone`;
    case "cloudflare":
      return address.account
        ? `${origin}/client/v4/accounts/${encodeURIComponent(address.account)}/ai/run/@cf/cloudflare/${encodeURIComponent(model)}`
        : null;
    case "openai":
      return `${origin}/v1/decisions`;
    case "alibaba":
      return `${origin}/compatible-mode/v1/systemone`;
  }
}

const CLOUDFLARE_ACCOUNT = /^[0-9a-f]{32}$/i;
const ALIBABA_WORKSPACE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function validAccount(host: DecisionHost, value: string): boolean {
  const account = DECISION_HOST_ENTRIES[host].account;
  if (account === "cloudflare-account") return CLOUDFLARE_ACCOUNT.test(value);
  if (account === "alibaba-workspace") return ALIBABA_WORKSPACE.test(value);
  return false;
}

export const decisionModelOf = (host: DecisionHost, modelId: string): DecisionModel | undefined =>
  DECISION_HOST_ENTRIES[host].models.find((model) => model.id === modelId);

/** Where and how to ask a model on a host, at its own origin or another (tests, the evaluation); null while the account is missing. */
export function decisionEndpoint(
  host: DecisionHost,
  model: string,
  address: DecisionHostAddress,
  origin: string | null = decisionOrigin(host, address),
): DecisionEndpoint | null {
  const entry = DECISION_HOST_ENTRIES[host];
  const url = decisionUrl(host, model, address, origin);
  if (!url) return null;
  return {
    url,
    protocol: entry.protocol,
    ...(entry.bothCriteria && { bothCriteria: true }),
    ...(entry.maxQuestions !== undefined && { maxQuestions: entry.maxQuestions }),
  };
}
