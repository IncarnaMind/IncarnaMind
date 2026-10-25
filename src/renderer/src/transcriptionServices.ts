import { useEffect } from "react";
import { create } from "zustand";
import type { CloudTranscriptionRoute, TranscriptionServiceStatus } from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { core } from "./core";
import { formatMoney, joinMeta } from "./cost";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { useAppStore } from "./store";

interface TranscriptionServicesState {
  /** The cloud services that can transcribe meeting audio (#141); empty until loaded. */
  services: TranscriptionServiceStatus[];
  load(): Promise<void>;
  /** Keeps a service's own key once it accepts it; what went wrong, in words, otherwise. */
  setKey(route: CloudTranscriptionRoute, apiKey: string): Promise<string | null>;
  removeKey(route: CloudTranscriptionRoute): Promise<string | null>;
}

export const useTranscriptionServices = create<TranscriptionServicesState>()((set) => {
  const attempt = async (action: () => Promise<TranscriptionServiceStatus[]>) => {
    try {
      set({ services: await action() });
      return null;
    } catch (error) {
      return errorMessage(error, translateNow);
    }
  };
  return {
    services: [],
    async load() {
      await attempt(() => core.listTranscriptionServices());
    },
    setKey: (route, apiKey) => attempt(() => core.setTranscriptionKey({ route, apiKey })),
    removeKey: (route) => attempt(() => core.removeTranscriptionKey(route)),
  };
});

/** The services, listed again when a view that offers them opens: a key may have come or gone. */
export function useTranscriptionServicesList(): TranscriptionServiceStatus[] {
  const services = useTranscriptionServices((state) => state.services);
  useEffect(() => {
    void useTranscriptionServices.getState().load();
  }, []);
  return services;
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Where a Meeting's recording stays, said so it holds with a cloud route chosen too. */
export function useAudioKeptKey(): MessageKey {
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute);
  return route && route !== "local" ? "meetings.audio.keptCloud" : "meetings.audio.kept";
}

/** "gpt-live-transcribe · about $1.02 an hour · uses your OpenAI key". */
export function serviceMeta(service: TranscriptionServiceStatus, t: Translate, language: Language) {
  const price = formatMoney(service.perHour, language);
  const named = service.key === "provider";
  return joinMeta([
    named ? service.model : "",
    t(named ? "meetings.route.perHour" : "meetings.route.perHourFirst", { price }),
    t(service.key === "provider" ? "meetings.route.providerKey" : "meetings.route.ownKey", {
      service: service.name,
    }),
    service.liveSpeakers ? t("meetings.route.speakers") : "",
  ]);
}
