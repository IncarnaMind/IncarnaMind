import { useEffect, useState } from "react";
import { create } from "zustand";
import type {
  CloudTranscriptionRoute,
  TranscriptionServiceStatus,
  TranscriptionServices,
} from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { core } from "./core";
import { formatMoney, joinMeta } from "./cost";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { useAppStore } from "./store";
import type { Read } from "./useRead";

/** What the newest answer about the cloud services that can transcribe meeting audio (#141) said. */
type ServicesRead =
  | { state: "loading" }
  | { state: "ready"; services: TranscriptionServiceStatus[] }
  | { state: "failed"; problem: string };

interface TranscriptionServicesState {
  read: ServicesRead;
  /** The core's revision of the answer in `read`; an answer with a lower one is older. */
  revision: number;
  /** Reads begun and not yet ended. */
  reading: number;
  /** Reads the list. Resolves when this read has ended, whatever it gave; it never rejects. */
  load(): Promise<void>;
  /** Keeps a service's own key once it accepts it; what went wrong, in words, otherwise. */
  setKey(route: CloudTranscriptionRoute, apiKey: string): Promise<string | null>;
  removeKey(route: CloudTranscriptionRoute): Promise<string | null>;
}

const LOADING: ServicesRead = { state: "loading" };

/**
 * The one owner of the list: every view reads it from here. The core says which answer is newer
 * (its revision grows with every committed change), so the answer held is the one with the
 * highest revision, whatever order the reads began or ended in; a change that failed changes
 * nothing.
 */
export const useTranscriptionServices = create<TranscriptionServicesState>()((set, get) => {
  const take = ({ revision, services }: TranscriptionServices) => {
    if (revision >= get().revision) set({ read: { state: "ready", services }, revision });
  };
  const change = async (action: () => Promise<TranscriptionServices>) => {
    try {
      take(await action());
      return null;
    } catch (error) {
      return errorMessage(error, translateNow);
    }
  };
  return {
    read: LOADING,
    revision: 0,
    reading: 0,
    async load() {
      const began = get().read;
      set((state) => ({ reading: state.reading + 1 }));
      try {
        take(await core.listTranscriptionServices());
      } catch (error) {
        console.error("The transcription services couldn't be listed.", error);
        // A failure speaks for what the read began from: an answer that landed since is newer.
        if (get().read === began) {
          set({ read: { state: "failed", problem: errorMessage(error, translateNow) } });
        }
      } finally {
        set((state) => ({ reading: state.reading - 1 }));
      }
    },
    setKey: (route, apiKey) => change(() => core.setTranscriptionKey({ route, apiKey })),
    removeKey: (route) => change(() => core.removeTranscriptionKey(route)),
  };
});

/**
 * The services as a view of them: loading, ready or failed. It reads the list when it mounts, as
 * a key may have come or gone; `reads` false only looks, for a view whose caller reads for it.
 * `fresh` waits until the reads this view began have ended, not for a list read earlier.
 */
export function useTranscriptionServicesRead(
  reads = true,
  fresh = false,
): Read<TranscriptionServiceStatus[]> {
  const read = useTranscriptionServices((state) => state.read);
  const reading = useTranscriptionServices((state) => state.reading > 0);
  const [own, setOwn] = useState({ armed: false, begun: 0, ended: 0 });
  const begin = () => {
    setOwn((now) => ({ ...now, begun: now.begun + 1 }));
    void useTranscriptionServices
      .getState()
      .load()
      .then(() => setOwn((now) => ({ ...now, ended: now.ended + 1 })));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: it reads when `reads` turns on.
  useEffect(() => {
    setOwn((now) => ({ ...now, armed: reads }));
    if (reads) begin();
  }, [reads]);
  const [retried, setRetried] = useState(false);
  // A problem the User asked to try again stays while the new read goes on, not the card behind it.
  const waiting = fresh && reads && (!own.armed || own.ended < own.begun);
  if (waiting && !(retried && read.state === "failed")) return { state: "loading" };
  if (read.state === "failed") {
    return {
      state: "failed",
      problem: read.problem,
      retrying: reading,
      retry: () => {
        setRetried(true);
        begin();
      },
    };
  }
  return read.state === "ready" ? { state: "ready", data: read.services } : { state: "loading" };
}

const NONE: TranscriptionServiceStatus[] = [];

/** The services the newest read gave, none while it is loading or failed: a view that says a failure uses `useTranscriptionServicesRead`. */
export function useTranscriptionServicesList(reads = true): TranscriptionServiceStatus[] {
  const read = useTranscriptionServicesRead(reads);
  return read.state === "ready" ? read.data : NONE;
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
