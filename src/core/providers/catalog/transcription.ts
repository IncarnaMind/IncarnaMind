/**
 * The cloud services that transcribe meeting audio with the User's own key (#141), as
 * IncarnaMind knows them before it sends them anything: the model, what an hour costs (so the
 * monthly cap counts it) and where the audio goes.
 */
import type { CloudTranscriptionRoute, ExternalService, Money } from "../../api";

/** Pinned in one place: OpenAI renamed its live transcription models in July 2026. */
export const OPENAI_LIVE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
export const SONIOX_REALTIME_MODEL = "stt-rt-v5";

export interface TranscriptionService {
  route: CloudTranscriptionRoute;
  name: string;
  model: string;
  perHour: Money;
  service: ExternalService;
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
    key: "own",
    liveSpeakers: true,
    keyUrl: "https://console.soniox.com",
    checked: "2026-10-18",
  },
};
