import { create } from "zustand";
import type {
  CloudTranscriptionRoute,
  TranscriptionRoute,
  TranscriptionServiceStatus,
  TranscriptionServices,
} from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { core } from "./core";
import { formatMoney, joinMeta } from "./cost";
import { useAppStore } from "./store";
import { type Read, useRead } from "./useRead";

interface TranscriptionServicesState {
  /** The cloud services that can transcribe meeting audio (#141), as the newest answer said; null before any. */
  services: TranscriptionServiceStatus[] | null;
  /** The core's revision of `services`; an answer with a lower one is older. */
  revision: number;
  /** Reads the list and resolves with what is held after it; rejects when the core can't answer. */
  load(): Promise<TranscriptionServiceStatus[]>;
  /** Keeps a service's own key, with Deepgram's server, once it accepts it; rejects with why it didn't. */
  setKey(route: CloudTranscriptionRoute, apiKey: string, server?: string): Promise<void>;
  removeKey(route: CloudTranscriptionRoute): Promise<void>;
}

/**
 * The one owner of the list's data. The core says which answer is newer (its revision grows with
 * every committed change), so what is held is the answer with the highest revision, whatever
 * order the reads began or ended in. A read that fails, or a change that does, changes nothing
 * here: a failure belongs to the view that asked.
 */
export const useTranscriptionServices = create<TranscriptionServicesState>()((set, get) => {
  const take = ({ revision, services }: TranscriptionServices) => {
    if (revision >= get().revision) set({ services, revision });
  };
  const change = async (action: () => Promise<TranscriptionServices>) => take(await action());
  return {
    services: null,
    revision: 0,
    async load() {
      take(await core.listTranscriptionServices());
      return get().services ?? [];
    },
    setKey: (route, apiKey, server) =>
      change(() =>
        core.setTranscriptionKey({ route, apiKey, ...(server !== undefined && { server }) }),
      ),
    removeKey: (route) => change(() => core.removeTranscriptionKey(route)),
  };
});

/** What one view knows of the services: the read it owns, which its children draw from. */
export type ServicesView = Read<TranscriptionServiceStatus[]>;

/**
 * The services as one view of them: loading, ready or failed. The view reads the list when it
 * mounts, as a key may have come or gone, and owns that read: its failure stays, with Try again,
 * until the User retries, whatever other views' reads do; only the data is shared, and live. A
 * view that isn't failed shows the data held while its own read goes on, unless `fresh`, which
 * waits for its own read. A view makes this one read for everything it shows and hands the result
 * to its children, which never read for themselves; its Try again reads again for all of them.
 * `reads` false waits for the model to work (the setup card).
 */
export function useTranscriptionServicesRead(reads = true, fresh = false): ServicesView {
  const own = useRead(
    "The transcription services",
    () => useTranscriptionServices.getState().load(),
    [],
    reads,
  );
  const held = useTranscriptionServices((state) => state.services);
  if (own.state === "failed") return own;
  if (own.state === "ready" || (!fresh && held !== null)) {
    return { state: "ready", data: held ?? [] };
  }
  return { state: "loading" };
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

export const ROUTE_LABELS: Record<TranscriptionRoute, MessageKey> = {
  local: "meetings.route.local",
  openai: "meetings.route.openai",
  soniox: "meetings.route.soniox",
  qwen: "meetings.route.qwen",
  deepgram: "meetings.route.deepgram",
  assemblyai: "meetings.route.assemblyai",
  gemini: "meetings.route.gemini",
  elevenlabs: "meetings.route.elevenlabs",
  speechmatics: "meetings.route.speechmatics",
  gladia: "meetings.route.gladia",
  xai: "meetings.route.xai",
};

/** The services as held, or read now when no view has read them yet (the meeting bar's lines). */
async function servicesNow(): Promise<TranscriptionServiceStatus[]> {
  const { services, load } = useTranscriptionServices.getState();
  return services ?? load();
}

/**
 * Where a route's key is changed, in Settings › Models: a key of its own on its row in Your
 * providers, opened to Change key, or the Meeting transcription picker once it is gone; a
 * provider's key in Your providers.
 */
export async function checkTranscriptionKey(route: CloudTranscriptionRoute): Promise<void> {
  const { openSettings } = useAppStore.getState();
  try {
    const service = (await servicesNow()).find((each) => each.route === route);
    if (service?.key !== "own") openSettings("models");
    else openSettings("models", service.hasKey ? `transcription-key:${route}` : "transcription");
  } catch (error) {
    console.error("The transcription services couldn't be read.", error);
    openSettings("models");
  }
}

/** Where credit is added to the account a route's key is for, or its key's settings when none is known. */
export async function addTranscriptionCredit(route: CloudTranscriptionRoute): Promise<void> {
  let url: string | null = null;
  try {
    url = (await servicesNow()).find((each) => each.route === route)?.billingUrl ?? null;
  } catch (error) {
    console.error("The transcription services couldn't be read.", error);
  }
  if (url) window.open(url, "_blank", "noreferrer");
  else await checkTranscriptionKey(route);
}

/**
 * Where a Meeting's recording stays and for how long, said so it holds with a cloud route chosen
 * too: a day, or until the User deletes it with "Keep a meeting's audio" on (#687).
 */
export function useAudioKeptKey(): MessageKey {
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute);
  const kept = useAppStore((state) => state.settings?.device.keepMeetingAudio === true);
  const cloud = route !== undefined && route !== null && route !== "local";
  if (kept) return cloud ? "meetings.audio.keptToDeleteCloud" : "meetings.audio.keptToDelete";
  return cloud ? "meetings.audio.keptCloud" : "meetings.audio.kept";
}

/** "gpt-live-transcribe · about $1.02 an hour · uses your OpenAI key". */
export function serviceMeta(service: TranscriptionServiceStatus, t: Translate, language: Language) {
  const price = formatMoney(service.perHour, language);
  const named = service.key === "provider";
  return joinMeta([
    named ? service.model : "",
    // A server of the User's own costs nothing IncarnaMind can count.
    service.perHour.amount === 0
      ? t("meetings.route.ownServer")
      : t(named ? "meetings.route.perHour" : "meetings.route.perHourFirst", { price }),
    t(named ? "meetings.route.providerKey" : "meetings.route.ownKey", {
      provider: t(ROUTE_LABELS[service.route]),
    }),
    service.region?.[language === "zh-CN" ? "zh" : "en"] ?? "",
    service.liveSpeakers ? t("meetings.route.speakers") : "",
  ]);
}
