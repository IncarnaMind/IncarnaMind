import { cleanApiKey } from "../../../shared/apiKey";

/**
 * Key prefixes that name their service, as its own pages show them: Anthropic's keys
 * (platform.claude.com/docs/en/manage-claude/authentication), OpenRouter's example key
 * (openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key), xAI's
 * `XAI_API_KEY` example (docs.x.ai/build/overview), OpenAI's project keys and the marker every
 * one of its keys carries, and Google's AIza keys and the AQ. keys AI Studio now makes (a Google
 * staff reply, discuss.ai.google.dev/t/171571). A bare `sk-` names nobody: DeepSeek, Kimi, Qwen,
 * SiliconFlow and the relays all issue it, so their keys are never recognised, and a service
 * with no prefix of its own accepts any key.
 */
const OWN_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["sk-ant-"],
  openrouter: ["sk-or-"],
  xai: ["xai-"],
  google: ["AQ.", "AIza"],
};

const OPENAI = /^sk-(?:proj|None)-|^sk-[\w-]*T3BlbkFJ/;

export type KeyCheck =
  | { ok: true }
  /** The key's prefix names another service. */
  | { ok: false; service: string }
  /** The service's keys always start with one of `prefixes`, and this key doesn't. */
  | { ok: false; service: null; prefixes: readonly string[] };

function serviceNamedBy(key: string): string | null {
  for (const [catalogId, prefixes] of Object.entries(OWN_PREFIXES)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) return catalogId;
  }
  return OPENAI.test(key) ? "openai" : null;
}

export function checkKey(catalogId: string, key: string): KeyCheck {
  const given = cleanApiKey(key);
  if (given === "") return { ok: true };
  const named = serviceNamedBy(given);
  if (named !== null) return named === catalogId ? { ok: true } : { ok: false, service: named };
  const prefixes = OWN_PREFIXES[catalogId];
  if (prefixes && !prefixes.some((prefix) => given.startsWith(prefix))) {
    return { ok: false, service: null, prefixes };
  }
  return { ok: true };
}

export const serviceOfKey = (key: string): string | null => serviceNamedBy(cleanApiKey(key));
