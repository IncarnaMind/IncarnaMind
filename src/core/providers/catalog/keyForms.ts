import { cleanApiKey } from "../../../shared/apiKey";
import type { Language } from "../../language";

/**
 * Key prefixes that name their service, as its own pages show them: Anthropic's keys
 * (platform.claude.com/docs/en/manage-claude/authentication), OpenRouter's example key
 * (openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key), xAI's
 * `XAI_API_KEY` example (docs.x.ai/build/overview), OpenAI's project keys and the marker every
 * one of its keys carries, and Google's AIza keys and the AQ. keys AI Studio now makes (a Google
 * staff reply, discuss.ai.google.dev/t/171571). A service with no prefix of its own accepts any key.
 */
const OWN_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["sk-ant-"],
  openrouter: ["sk-or-"],
  xai: ["xai-"],
  google: ["AQ.", "AIza"],
};

const OPENAI = /^sk-(?:proj|None)-|^sk-[\w-]*T3BlbkFJ/;

/**
 * Whole forms that name one service with no prefix: GLM's "{id}.{secret}", which BigModel's and
 * Z.ai's own HTTP guides and Zhipu's SDK split at the dot
 * (docs.bigmodel.cn/cn/guide/develop/http/introduction, docs.z.ai/guides/develop/http/introduction).
 * Neither says how long each part is; eight characters each keeps an address ("deepseek.com") out.
 */
const OWN_FORMS: Readonly<Record<string, RegExp>> = {
  glm: /^[0-9A-Za-z]{8,}\.[0-9A-Za-z]{8,}$/,
};

/**
 * Forms several services issue, with those services, the likeliest for each interface language
 * first; a key in one goes nowhere until the User says whose it is (#2865). "Starts with sk-" is
 * all DeepSeek (api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex), Alibaba's Model
 * Studio (help.aliyun.com/zh/model-studio/error-code) and SiliconFlow
 * (docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-KiloCode) document, with no length;
 * Model Studio's newer keys start sk-ws (alibabacloud.com/help/en/model-studio/get-api-key). Its
 * sk-sp- keys are for the Token and Coding Plans, which no route here takes, so they name nobody.
 * Kimi documents no form for its keys.
 */
const SHARED_FORMS: readonly {
  form: RegExp;
  services: Readonly<Record<Language, readonly string[]>>;
}[] = [
  {
    form: /^sk-ws[\w-]*$/,
    services: {
      en: ["qwen", "deepseek", "siliconflow"],
      "zh-CN": ["qwen", "deepseek", "siliconflow"],
    },
  },
  {
    form: /^sk-(?!sp-)[\w-]+$/,
    services: {
      en: ["deepseek", "qwen", "siliconflow"],
      "zh-CN": ["deepseek", "qwen", "siliconflow"],
    },
  },
];

export type KeyCheck =
  | { ok: true }
  /** The key's prefix names another service. */
  | { ok: false; service: string }
  /** The service's keys always start with one of `prefixes`, and this key doesn't. */
  | { ok: false; service: null; prefixes: readonly string[] };

/** What a key's form says of whose it is, read from the key alone: nothing is sent to find out. */
export type KeyForm =
  | { kind: "named"; service: string }
  /** Several services issue the form: the likeliest for the interface language first. */
  | { kind: "shared"; services: readonly string[] }
  | { kind: "unknown" };

function serviceNamedBy(key: string): string | null {
  for (const [catalogId, prefixes] of Object.entries(OWN_PREFIXES)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) return catalogId;
  }
  if (OPENAI.test(key)) return "openai";
  for (const [catalogId, form] of Object.entries(OWN_FORMS)) {
    if (form.test(key)) return catalogId;
  }
  return null;
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

/** The one service a key's form names; null for a form several services share. */
export const serviceOfKey = (key: string): string | null => serviceNamedBy(cleanApiKey(key));

export function formOfKey(key: string, language: Language): KeyForm {
  const given = cleanApiKey(key);
  const named = serviceNamedBy(given);
  if (named !== null) return { kind: "named", service: named };
  const shared = SHARED_FORMS.find(({ form }) => form.test(given));
  return shared ? { kind: "shared", services: shared.services[language] } : { kind: "unknown" };
}
