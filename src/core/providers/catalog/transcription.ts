/**
 * The cloud services that transcribe meeting audio live with the User's own key (#141, #866), as
 * IncarnaMind knows them before it sends them anything: the model, what an hour costs (so the
 * monthly cap counts it), where the audio goes and the languages it transcribes.
 */

import { isDeepgramHost } from "../../../shared/deepgram";
import type { CloudTranscriptionRoute, ExternalService, Money } from "../../api";
import {
  ASSEMBLYAI_MODEL,
  DEEPGRAM_MODEL,
  DEEPGRAM_URL,
  ELEVENLABS_MODEL,
  GEMINI_LIVE_MODEL,
  GLADIA_MODEL,
  QWEN_REALTIME_PATH,
  SPEECHMATICS_MODEL,
  XAI_STT_MODEL,
} from "../../transcription/cloud/protocol";
import { serviceAt } from "../service";
import { catalogProvider, endpointOf } from "./providers";
import type { Localized } from "./types";

/** Pinned in one place: OpenAI renamed its live transcription models in July 2026. */
export const OPENAI_LIVE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
// v5 wrote a sum said in pounds as dollars (#1031), and Soniox retires it on 2026-12-15.
export const SONIOX_REALTIME_MODEL = "stt-rt-v6";

/**
 * Model Studio's real-time speech models. Only the first is used: it switches between
 * Chinese and English. The others are catalog entries, not choices in the interface.
 */
export const QWEN_REALTIME_MODELS = [
  "fun-asr-realtime",
  "paraformer-realtime-v2",
  "qwen3-asr-flash-realtime",
] as const;
export const QWEN_REALTIME_MODEL = QWEN_REALTIME_MODELS[0];

/** What a cloud service does with the audio it is sent, in its own agreement's words. */
export interface TranscriptionDataUse {
  summary: Localized;
  url: Localized;
}

/**
 * The price of the words to know, in `perHour`'s currency: for each hour of audio sent with them,
 * or for each million tokens of them, sent with every stream's setup.
 */
export interface WordsCost {
  perHour?: number;
  perMillionTokens?: number;
}

export interface TranscriptionService {
  route: CloudTranscriptionRoute;
  name: string;
  model: string;
  perHour: Money;
  /** The price in a region (by the id of the provider's endpoint in the catalog), where it differs. */
  perHourIn?: Readonly<Record<string, Money>>;
  service: ExternalService;
  recipient: Localized;
  dataUse?: TranscriptionDataUse;
  /** What a stream that sends the meeting's words to know (#1031) costs besides, where it does. */
  wordsCost?: WordsCost;
  /**
   * "provider": the key of a chat provider in Settings › Models, the catalog's `provider` (the
   * route's own id when absent); "own": a key of its own, kept in the keychain.
   */
  key: "provider" | "own";
  provider?: string;
  liveSpeakers: boolean;
  keyUrl?: string;
  billingUrl?: string;
  /** What it transcribes, as ISO 639 codes: a language a User speaks that isn't here is warned of. */
  languages: readonly string[];
  /** When a person last checked this entry against the service's own pages (YYYY-MM-DD). */
  checked: string;
}

const SONIOX_LANGUAGES = [
  "af",
  "sq",
  "ar",
  "az",
  "eu",
  "be",
  "bn",
  "bs",
  "bg",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "kn",
  "kk",
  "ko",
  "lv",
  "lt",
  "mk",
  "ms",
  "ml",
  "mr",
  "no",
  "fa",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sw",
  "sv",
  "tl",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
  "cy",
];

/** Nova-3's multilingual set, which `language=multi` switches between. */
const DEEPGRAM_LANGUAGES = [
  "af",
  "ar",
  "be",
  "bn",
  "bs",
  "bg",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "kn",
  "ko",
  "lv",
  "lt",
  "mk",
  "ms",
  "mr",
  "no",
  "fa",
  "pl",
  "pt",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "tl",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "vi",
  "xh",
  "zu",
];

/** Universal-3.6 Pro Realtime's 32. */
const ASSEMBLYAI_LANGUAGES = [
  "af",
  "ar",
  "yue",
  "ca",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "he",
  "hi",
  "it",
  "ja",
  "ko",
  "zh",
  "mr",
  "no",
  "nn",
  "fa",
  "pt",
  "ro",
  "ru",
  "es",
  "sv",
  "tr",
  "ur",
  "vi",
  "xh",
  "zu",
];

/** Gemini 3.5 Transcribe Live's table at https://aistudio.google.com/docs/live-api/live-transcribe. */
const GEMINI_LANGUAGES = [
  "af",
  "am",
  "ar",
  "hy",
  "as",
  "az",
  "be",
  "bn",
  "bs",
  "bg",
  "rup",
  "my",
  "yue",
  "ca",
  "ceb",
  "km",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fa",
  "tl",
  "fi",
  "fr",
  "gl",
  "ka",
  "de",
  "el",
  "gu",
  "ha",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "it",
  "ja",
  "jv",
  "kea",
  "kn",
  "kk",
  "ko",
  "ky",
  "lv",
  "ln",
  "lt",
  "mk",
  "ms",
  "ml",
  "mt",
  "zh",
  "mr",
  "mn",
  "ne",
  "no",
  "or",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sd",
  "sk",
  "sl",
  "es",
  "sw",
  "sv",
  "tg",
  "te",
  "th",
  "tr",
  "uk",
  "uz",
  "vi",
];

/** Scribe's list, which the models page gives for Scribe v2 Realtime, as ISO 639-1 codes where there is one. */
const ELEVENLABS_LANGUAGES = [
  "af",
  "am",
  "ar",
  "hy",
  "as",
  "ast",
  "az",
  "be",
  "bn",
  "bs",
  "bg",
  "my",
  "yue",
  "ca",
  "ceb",
  "ny",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "tl",
  "fi",
  "fr",
  "ff",
  "gl",
  "lg",
  "ka",
  "de",
  "el",
  "gu",
  "ha",
  "he",
  "hi",
  "hu",
  "is",
  "ig",
  "id",
  "ga",
  "it",
  "ja",
  "jv",
  "kea",
  "kn",
  "kk",
  "km",
  "ko",
  "ku",
  "ky",
  "lo",
  "lv",
  "ln",
  "lt",
  "luo",
  "lb",
  "mk",
  "ms",
  "ml",
  "mt",
  "zh",
  "mi",
  "mr",
  "mn",
  "ne",
  "nso",
  "no",
  "oc",
  "or",
  "ps",
  "fa",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sn",
  "sd",
  "si",
  "sk",
  "sl",
  "so",
  "es",
  "sw",
  "sv",
  "ta",
  "tg",
  "te",
  "th",
  "tr",
  "uk",
  "umb",
  "ur",
  "uz",
  "vi",
  "cy",
  "wo",
  "xh",
  "zu",
];

/** Solaria-1's, at https://docs.gladia.io/chapters/language/supported-languages (its "jw" is Javanese, "jv"). */
const GLADIA_LANGUAGES = [
  "af",
  "sq",
  "am",
  "ar",
  "hy",
  "as",
  "az",
  "ba",
  "eu",
  "be",
  "bn",
  "bs",
  "br",
  "bg",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fo",
  "fi",
  "fr",
  "gl",
  "ka",
  "de",
  "el",
  "gu",
  "ht",
  "ha",
  "haw",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "it",
  "ja",
  "jv",
  "kn",
  "kk",
  "km",
  "ko",
  "lo",
  "la",
  "lv",
  "ln",
  "lt",
  "lb",
  "mk",
  "mg",
  "ms",
  "ml",
  "mt",
  "mi",
  "mr",
  "mn",
  "my",
  "ne",
  "no",
  "nn",
  "oc",
  "ps",
  "fa",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sa",
  "sr",
  "sn",
  "sd",
  "si",
  "sk",
  "sl",
  "so",
  "es",
  "su",
  "sw",
  "sv",
  "tl",
  "tg",
  "ta",
  "tt",
  "te",
  "th",
  "bo",
  "tr",
  "tk",
  "uk",
  "ur",
  "uz",
  "vi",
  "cy",
  "wo",
  "yi",
  "yo",
];

/** grok-voice-transcribe-2.0's table at https://docs.x.ai/developers/model-capabilities/audio/speech-to-text. */
const XAI_LANGUAGES = [
  "ar",
  "bs",
  "bg",
  "yue",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "tl",
  "fi",
  "fr",
  "de",
  "el",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "mk",
  "ms",
  "no",
  "fa",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "es",
  "sv",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
];

export const TRANSCRIPTION_SERVICES: Readonly<
  Record<CloudTranscriptionRoute, TranscriptionService>
> = {
  openai: {
    route: "openai",
    name: "OpenAI",
    model: OPENAI_LIVE_TRANSCRIPTION_MODEL,
    perHour: { currency: "USD", amount: 1.02 },
    service: { id: "https://api.openai.com", name: "OpenAI" },
    recipient: { en: "OpenAI", zh: "OpenAI" },
    key: "provider",
    liveSpeakers: false,
    // The session is set up for these two (../../transcription/cloud/openai), whatever else Whisper knows.
    languages: ["en", "zh"],
    checked: "2026-11-05",
  },
  soniox: {
    route: "soniox",
    name: "Soniox",
    model: SONIOX_REALTIME_MODEL,
    perHour: { currency: "USD", amount: 0.12 },
    wordsCost: { perMillionTokens: 4 },
    service: { id: "https://stt-rt.soniox.com", name: "Soniox" },
    recipient: { en: "Soniox", zh: "Soniox" },
    key: "own",
    liveSpeakers: true,
    keyUrl: "https://console.soniox.com",
    billingUrl: "https://console.soniox.com",
    languages: SONIOX_LANGUAGES,
    checked: "2026-11-09",
  },
  qwen: {
    route: "qwen",
    name: "Qwen",
    model: QWEN_REALTIME_MODEL,
    // Beijing: ¥0.00033 a second. Singapore: $0.00009 a second.
    perHour: { currency: "CNY", amount: 1.188 },
    perHourIn: { intl: { currency: "USD", amount: 0.324 } },
    // Beijing's; the region of the key decides (`qwenRegion`).
    service: { id: "https://dashscope.aliyuncs.com", name: "Qwen (Alibaba Cloud)" },
    recipient: { en: "Alibaba Cloud", zh: "阿里云" },
    dataUse: {
      summary: {
        en: "Alibaba Cloud’s agreements say input and output data from API calls isn’t used for model training or optimization.",
        zh: "阿里云的协议写明，API 调用的输入输出数据不会用于模型训练或优化。",
      },
      url: {
        en: "https://docs.agent.bailian.aliyun.com/en/resources/agreements",
        zh: "https://docs.agent.bailian.aliyun.com/zh/resources/agreements",
      },
    },
    key: "provider",
    liveSpeakers: false,
    // Chinese with its dialects, Cantonese among them, English and Japanese.
    languages: ["zh", "yue", "en", "ja"],
    checked: "2026-11-05",
  },
  deepgram: {
    route: "deepgram",
    name: "Deepgram",
    model: DEEPGRAM_MODEL,
    // Nova-3 Multilingual, $0.0092 a minute, and its speakers, $0.0020.
    perHour: { currency: "USD", amount: 0.672 },
    // Keyterm prompting, $0.0013 a minute.
    wordsCost: { perHour: 0.078 },
    service: { id: "https://api.deepgram.com", name: "Deepgram" },
    recipient: { en: "Deepgram", zh: "Deepgram" },
    dataUse: {
      summary: {
        en: "IncarnaMind asks Deepgram to leave meeting audio out of its model improvement, so Deepgram keeps it only as long as transcribing it takes.",
        zh: "IncarnaMind 要求 Deepgram 不把会议音频用于改进模型，Deepgram 只在转写所需的时间内保留音频。",
      },
      url: {
        en: "https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program",
        zh: "https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program",
      },
    },
    key: "own",
    liveSpeakers: true,
    keyUrl: "https://console.deepgram.com",
    billingUrl: "https://console.deepgram.com",
    languages: DEEPGRAM_LANGUAGES,
    checked: "2026-11-09",
  },
  assemblyai: {
    route: "assemblyai",
    name: "AssemblyAI",
    model: ASSEMBLYAI_MODEL,
    // Universal-3.6 Pro Realtime, $0.45 an hour, and its speaker labels, $0.12.
    perHour: { currency: "USD", amount: 0.57 },
    service: { id: "https://streaming.assemblyai.com", name: "AssemblyAI" },
    recipient: { en: "AssemblyAI", zh: "AssemblyAI" },
    dataUse: {
      summary: {
        en: "AssemblyAI may train its models on the audio unless you opt out in its Data Controls; opted out, it keeps no audio or transcript of a live meeting.",
        zh: "除非你在 AssemblyAI 的数据控制中选择退出，否则它可能用音频训练模型；退出后，它不保留实时会议的音频和转写稿。",
      },
      url: {
        en: "https://www.assemblyai.com/docs/data-retention-and-model-training",
        zh: "https://www.assemblyai.com/docs/data-retention-and-model-training",
      },
    },
    key: "own",
    liveSpeakers: true,
    keyUrl: "https://www.assemblyai.com/dashboard",
    billingUrl: "https://www.assemblyai.com/dashboard",
    languages: ASSEMBLYAI_LANGUAGES,
    checked: "2026-11-05",
  },
  gemini: {
    route: "gemini",
    name: "Gemini",
    model: GEMINI_LIVE_MODEL,
    // Google's estimate for its paid tier: $0.005 a minute of audio in, $0.004 of text out.
    perHour: { currency: "USD", amount: 0.54 },
    service: { id: "https://generativelanguage.googleapis.com", name: "Google" },
    recipient: { en: "Google", zh: "Google" },
    dataUse: {
      summary: {
        en: "On a free key, Google may use the meeting audio to improve its products, with human review; on a paid key it doesn’t.",
        zh: "使用免费密钥时，Google 可能用会议音频改进其产品并经人工审阅；使用付费密钥则不会。",
      },
      url: {
        en: "https://ai.google.dev/gemini-api/terms",
        zh: "https://ai.google.dev/gemini-api/terms",
      },
    },
    key: "provider",
    provider: "google",
    liveSpeakers: false,
    languages: GEMINI_LANGUAGES,
    checked: "2026-11-07",
  },
  elevenlabs: {
    route: "elevenlabs",
    name: "ElevenLabs",
    model: ELEVENLABS_MODEL,
    perHour: { currency: "USD", amount: 0.39 },
    wordsCost: { perHour: 0.08 },
    service: { id: "https://api.elevenlabs.io", name: "ElevenLabs" },
    recipient: { en: "ElevenLabs", zh: "ElevenLabs" },
    dataUse: {
      summary: {
        en: "ElevenLabs trains its models on the audio unless you turn off “Improve the models for everyone” in its settings, and keeps the audio and its text by default.",
        zh: "除非你在 ElevenLabs 的设置中关闭“Improve the models for everyone”，否则它会用音频训练模型；默认还会保留音频和转写文字。",
      },
      url: {
        en: "https://elevenlabs.io/docs/help-center/legal/is-my-data-used-to-improve-eleven-labs-ai-models",
        zh: "https://elevenlabs.io/docs/help-center/legal/is-my-data-used-to-improve-eleven-labs-ai-models",
      },
    },
    key: "own",
    liveSpeakers: false,
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    billingUrl: "https://elevenlabs.io/app/subscription",
    languages: ELEVENLABS_LANGUAGES,
    checked: "2026-11-09",
  },
  speechmatics: {
    route: "speechmatics",
    name: "Speechmatics",
    model: SPEECHMATICS_MODEL,
    // The Enhanced model's real-time price.
    perHour: { currency: "USD", amount: 0.4 },
    service: { id: "https://global.rt.speechmatics.com", name: "Speechmatics" },
    recipient: { en: "Speechmatics", zh: "Speechmatics" },
    dataUse: {
      summary: {
        en: "Speechmatics keeps no real-time audio or text and doesn’t train on them, unless your workspace opted in to its model-training discount, which lets it keep and use them.",
        zh: "Speechmatics 不保留实时音频和文字，也不用它们训练模型；但如果你的工作区开启了模型训练折扣，它可以保留并使用这些数据。",
      },
      url: {
        en: "https://www.speechmatics.com/terms-and-conditions",
        zh: "https://www.speechmatics.com/terms-and-conditions",
      },
    },
    key: "own",
    liveSpeakers: true,
    keyUrl: "https://portal.speechmatics.com/settings/api-keys",
    billingUrl: "https://portal.speechmatics.com",
    // Its Mandarin and English pack (../../transcription/cloud/speechmatics), which the stream asks for.
    languages: ["en", "zh"],
    checked: "2026-11-07",
  },
  gladia: {
    route: "gladia",
    name: "Gladia",
    model: GLADIA_MODEL,
    // Gladia prices only in euros, €0.68 an hour; counted high, so the cap never counts less.
    perHour: { currency: "USD", amount: 0.82 },
    service: { id: "https://api.gladia.io", name: "Gladia" },
    recipient: { en: "Gladia", zh: "Gladia" },
    dataUse: {
      summary: {
        en: "Gladia trains its models on the audio unless you opt out in your account, and keeps the audio: a year on the free plan, three weeks on a paid one.",
        zh: "除非你在 Gladia 账户中选择退出，否则它会用音频训练模型；它还会保留音频：免费套餐保留一年，付费套餐保留三周。",
      },
      url: {
        en: "https://www.gladia.io/general-terms-of-use",
        zh: "https://www.gladia.io/general-terms-of-use",
      },
    },
    key: "own",
    liveSpeakers: false,
    keyUrl: "https://app.gladia.io/apikeys",
    billingUrl: "https://app.gladia.io/settings/billing",
    languages: GLADIA_LANGUAGES,
    checked: "2026-11-07",
  },

  xai: {
    route: "xai",
    name: "xAI",
    model: XAI_STT_MODEL,
    perHour: { currency: "USD", amount: 0.2 },
    service: { id: "https://api.x.ai", name: "xAI" },
    recipient: { en: "xAI", zh: "xAI" },
    dataUse: {
      summary: {
        en: "xAI keeps the audio for 30 days for abuse checks, and its terms ask for zero data retention when audio holds personal data, as a meeting’s does: turn zero data retention on for your xAI team before you choose it.",
        zh: "xAI 会将音频保留 30 天用于滥用审查；其条款要求含有个人数据（会议音频就是）时开启零数据保留：请先为你的 xAI 团队开启零数据保留，再选择它。",
      },
      url: {
        en: "https://x.ai/legal/terms-of-service-enterprise",
        zh: "https://x.ai/legal/terms-of-service-enterprise",
      },
    },
    key: "provider",
    liveSpeakers: true,
    languages: XAI_LANGUAGES,
    checked: "2026-11-07",
  },
};

/** Where a Deepgram-compatible server sends the audio: Deepgram's own, Cloudflare's, or the User's. */
export interface DeepgramServer {
  url: string;
  /** Null for a server on this computer: the audio doesn't leave it. */
  service: ExternalService | null;
  recipient: Localized;
  perHour: Money;
  /** Only Deepgram's own server is known to charge for the words to know. */
  wordsCost: WordsCost | null;
  dataUse: TranscriptionDataUse | null;
  /** Deepgram's own and Cloudflare's take a key; the User's own server may not. */
  needsKey: boolean;
}

const CLOUDFLARE = "api.cloudflare.com";

export function deepgramServer(url: string | null): DeepgramServer {
  const address = url ?? DEEPGRAM_URL;
  const host = new URL(address).hostname;
  const { deepgram } = TRANSCRIPTION_SERVICES;
  if (isDeepgramHost(host)) {
    return {
      url: address,
      service: { id: `https://${host}`, name: deepgram.service.name },
      recipient: deepgram.recipient,
      perHour: deepgram.perHour,
      wordsCost: deepgram.wordsCost ?? null,
      dataUse: deepgram.dataUse ?? null,
      needsKey: true,
    };
  }
  if (host === CLOUDFLARE) {
    return {
      url: address,
      service: { id: `https://${CLOUDFLARE}`, name: "Cloudflare" },
      recipient: { en: "Cloudflare", zh: "Cloudflare" },
      // Workers AI's Deepgram Nova-3 over a WebSocket.
      perHour: { currency: "USD", amount: 0.552 },
      wordsCost: null,
      dataUse: {
        summary: {
          en: "Cloudflare doesn’t train AI models on what Workers AI transcribes, and keeps it only as long as the request takes.",
          zh: "Cloudflare 不会用 Workers AI 转写的内容训练 AI 模型，只在请求所需的时间内保留。",
        },
        url: {
          en: "https://developers.cloudflare.com/workers-ai/platform/privacy/",
          zh: "https://developers.cloudflare.com/workers-ai/platform/privacy/",
        },
      },
      needsKey: true,
    };
  }
  const service = serviceAt(address.replace(/^ws/, "http"), host);
  return {
    url: address,
    service,
    recipient: { en: host, zh: host },
    // A server of the User's own costs nothing per hour that IncarnaMind could count.
    perHour: { currency: "USD", amount: 0 },
    wordsCost: null,
    dataUse: null,
    needsKey: false,
  };
}

/** The Qwen provider's region a key is for: where its audio goes and what the audio costs there. */
export interface QwenRegion {
  /** The id of the endpoint in the catalog: "cn" (Beijing) or "intl" (Singapore). */
  id: string;
  label: Localized;
  url: string;
  service: ExternalService;
  perHour: Money;
}

/** The region of a Qwen provider row, by its endpoint id: the catalog's first, left out. */
export function qwenRegion(endpointId: string | null): QwenRegion {
  const provider = catalogProvider("qwen");
  const endpoint = provider && endpointOf(provider, endpointId);
  if (!endpoint) throw new Error("The catalog has no Qwen provider.");
  const base = new URL(endpoint.baseUrl);
  const { perHour, perHourIn } = TRANSCRIPTION_SERVICES.qwen;
  return {
    id: endpoint.id,
    label: endpoint.label,
    url: `wss://${base.host}${QWEN_REALTIME_PATH}`,
    service: { id: base.origin, name: TRANSCRIPTION_SERVICES.qwen.service.name },
    perHour: perHourIn?.[endpoint.id] ?? perHour,
  };
}
