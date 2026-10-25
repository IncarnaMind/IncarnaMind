/**
 * The cloud services that transcribe meeting audio with the User's own key (#141), as
 * IncarnaMind knows them before it sends them anything: the model, what an hour costs (so the
 * monthly cap counts it) and where the audio goes.
 */
import type { CloudTranscriptionRoute, ExternalService, Money } from "../../api";
import { QWEN_REALTIME_PATH } from "../../transcription/cloud/protocol";
import { catalogProvider, endpointOf } from "./providers";
import type { Localized } from "./types";

/** Pinned in one place: OpenAI renamed its live transcription models in July 2026. */
export const OPENAI_LIVE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
export const SONIOX_REALTIME_MODEL = "stt-rt-v5";

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
  /** "provider": the key of the chat provider of the same name in Settings › Models. */
  key: "provider" | "own";
  liveSpeakers: boolean;
  keyUrl?: string;
  /** When a person last checked this entry against the service's own pages (YYYY-MM-DD). */
  checked: string;
}

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
    checked: "2026-10-18",
  },
  soniox: {
    route: "soniox",
    name: "Soniox",
    model: SONIOX_REALTIME_MODEL,
    perHour: { currency: "USD", amount: 0.12 },
    service: { id: "https://stt-rt.soniox.com", name: "Soniox" },
    recipient: { en: "Soniox", zh: "Soniox" },
    key: "own",
    liveSpeakers: true,
    keyUrl: "https://console.soniox.com",
    checked: "2026-10-18",
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
    checked: "2026-10-25",
  },
};

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
