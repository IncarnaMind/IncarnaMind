import { cleanApiKey } from "../../../shared/apiKey";
import type { Language } from "../../language";

/**
 * Key prefixes that name their service, as its own pages show them: Anthropic's keys
 * (platform.claude.com/docs/en/manage-claude/authentication), OpenRouter's example key
 * (openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key), xAI's
 * `XAI_API_KEY` example (docs.x.ai/build/overview), OpenAI's project keys and the marker every
 * one of its keys carries, and Google's AIza keys and the AQ. keys AI Studio now makes (a Google
 * staff reply, discuss.ai.google.dev/t/171571). A service with no prefix of its own accepts any key.
 * Each has one host, so a key in one of these forms can go there at once.
 */
const OWN_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["sk-ant-"],
  openrouter: ["sk-or-"],
  xai: ["xai-"],
  google: ["AQ.", "AIza"],
};

const OPENAI = /^sk-(?:proj|None)-|^sk-[\w-]*T3BlbkFJ/;

/**
 * GLM's "{id}.{secret}", which BigModel's and Z.ai's own HTTP guides and Zhipu's SDK split at the
 * dot (docs.bigmodel.cn/cn/guide/develop/http/introduction,
 * docs.z.ai/guides/develop/http/introduction). It names GLM but not which of its two platforms
 * made it. Neither says how long each part is; eight characters each keeps an address
 * ("deepseek.com") out.
 */
const GLM = /^[0-9A-Za-z]{8,}\.[0-9A-Za-z]{8,}$/;

/** Where a key may go: a service, and for one with a host per region, the region chosen. */
export interface KeyTarget {
  service: string;
  /** The catalog endpoint id; null where the service has one host, or the User picks it later. */
  region: string | null;
}

const to = (service: string, region: string | null = null): KeyTarget => ({ service, region });

/**
 * Forms that don't decide where a key goes, with where it may, the likeliest for each interface
 * language first. A key in one goes nowhere until the User says where (#2865), and the first of
 * each names its host. "Starts with sk-" is all DeepSeek
 * (api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex), Alibaba's Model Studio
 * (help.aliyun.com/zh/model-studio/error-code) and SiliconFlow
 * (docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-KiloCode) document, with no length.
 * Model Studio's newer keys start sk-ws (alibabacloud.com/help/en/model-studio/get-api-key), in
 * either region. Its sk-sp- keys are for the Token and Coding Plans, which no route here takes,
 * so they match nothing. Kimi documents no form for its keys.
 */
const ASKED_FORMS: readonly {
  form: RegExp;
  targets: Readonly<Record<Language, readonly KeyTarget[]>>;
}[] = [
  {
    form: GLM,
    targets: {
      en: [to("glm", "intl"), to("glm", "cn")],
      "zh-CN": [to("glm", "cn"), to("glm", "intl")],
    },
  },
  {
    form: /^sk-ws[\w-]*$/,
    targets: {
      en: [to("qwen", "intl"), to("qwen", "cn"), to("deepseek"), to("siliconflow")],
      "zh-CN": [to("qwen", "cn"), to("qwen", "intl"), to("deepseek"), to("siliconflow")],
    },
  },
  {
    form: /^sk-(?!sp-)[\w-]+$/,
    targets: {
      en: [to("deepseek"), to("qwen"), to("siliconflow")],
      "zh-CN": [to("deepseek"), to("qwen"), to("siliconflow")],
    },
  },
];

export type KeyCheck =
  | { ok: true }
  /** The key's prefix names another service. */
  | { ok: false; service: string }
  /** The service's keys always start with one of `prefixes`, and this key doesn't. */
  | { ok: false; service: null; prefixes: readonly string[] };

/** What a key's form says of where it goes, read from the key alone: nothing is sent to find out. */
export type KeyForm =
  /** The form names a service with one host: the key can go there at once. */
  | { kind: "named"; service: string }
  /** The form leaves where it goes open: ask about the first target, the likeliest. */
  | { kind: "ask"; targets: readonly KeyTarget[] }
  | { kind: "unknown" };

function prefixService(key: string): string | null {
  for (const [catalogId, prefixes] of Object.entries(OWN_PREFIXES)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) return catalogId;
  }
  return OPENAI.test(key) ? "openai" : null;
}

function serviceNamedBy(key: string): string | null {
  return prefixService(key) ?? (GLM.test(key) ? "glm" : null);
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

/**
 * The one service a key's form names, for a provider's form to move to (it sends nothing until
 * the User does); null for a form several services share.
 */
export const serviceOfKey = (key: string): string | null => serviceNamedBy(cleanApiKey(key));

export function formOfKey(key: string, language: Language): KeyForm {
  const given = cleanApiKey(key);
  const named = prefixService(given);
  if (named !== null) return { kind: "named", service: named };
  const asked = ASKED_FORMS.find(({ form }) => form.test(given));
  return asked ? { kind: "ask", targets: asked.targets[language] } : { kind: "unknown" };
}
