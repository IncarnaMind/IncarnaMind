import { useEffect, useState } from "react";
import { create } from "zustand";
import type { CloudTranscriptionRoute, TranscriptionServiceStatus } from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { core } from "./core";
import { formatMoney, joinMeta } from "./cost";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { useAppStore } from "./store";
import type { Read } from "./useRead";

/** What the newest read of the cloud services that can transcribe meeting audio (#141) gave. */
type ServicesRead =
  | { state: "loading" }
  | { state: "ready"; services: TranscriptionServiceStatus[] }
  | { state: "failed"; problem: string };

interface TranscriptionServicesState {
  read: ServicesRead;
  /** The newest read whose outcome `read` holds; one begun earlier that ends later changes nothing. */
  applied: number;
  /** The newest read hasn't ended. */
  reading: boolean;
  /** Begins a read of the list and returns its number; its outcome is `read` if it is still the newest. */
  load(): number;
  /** Keeps a service's own key once it accepts it; what went wrong, in words, otherwise. */
  setKey(route: CloudTranscriptionRoute, apiKey: string): Promise<string | null>;
  removeKey(route: CloudTranscriptionRoute): Promise<string | null>;
}

/**
 * The one owner of the list: every view reads it from here, and only the newest read's result or
 * failure changes it, so a read that was overtaken can't undo a newer one or rewrite what it says.
 */
export const useTranscriptionServices = create<TranscriptionServicesState>()((set) => {
  let newest = 0;
  const end = (mine: number, read: ServicesRead) => {
    if (mine === newest) set({ read, applied: mine, reading: false });
  };
  const attempt = async (action: () => Promise<TranscriptionServiceStatus[]>) => {
    const mine = ++newest;
    set({ reading: true });
    try {
      end(mine, { state: "ready", services: await action() });
      return null;
    } catch (error) {
      if (mine === newest) set({ reading: false });
      return errorMessage(error, translateNow);
    }
  };
  return {
    read: { state: "loading" },
    applied: 0,
    reading: false,
    load() {
      const mine = ++newest;
      set({ reading: true });
      core.listTranscriptionServices().then(
        (services) => end(mine, { state: "ready", services }),
        (error: unknown) => {
          console.error("The transcription services couldn't be listed.", error);
          end(mine, { state: "failed", problem: errorMessage(error, translateNow) });
        },
      );
      return mine;
    },
    setKey: (route, apiKey) => attempt(() => core.setTranscriptionKey({ route, apiKey })),
    removeKey: (route) => attempt(() => core.removeTranscriptionKey(route)),
  };
});

/**
 * The services as a view of them: loading, ready or failed. It reads the list when it mounts, as
 * a key may have come or gone; `reads` false only looks, for a view whose caller reads for it.
 * `fresh` waits for the read this view began, not a list read earlier.
 */
export function useTranscriptionServicesRead(
  reads = true,
  fresh = false,
): Read<TranscriptionServiceStatus[]> {
  const read = useTranscriptionServices((state) => state.read);
  const applied = useTranscriptionServices((state) => state.applied);
  const reading = useTranscriptionServices((state) => state.reading);
  const [mine, setMine] = useState<number | null>(null);
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    setMine(reads ? useTranscriptionServices.getState().load() : null);
  }, [reads]);
  // A problem the User asked to try again stays while the new read goes on, not the card behind it.
  const waiting = fresh && reads && (mine === null || applied < mine);
  if (waiting && !(retried && read.state === "failed")) return { state: "loading" };
  if (read.state === "failed") {
    return {
      state: "failed",
      problem: read.problem,
      retrying: reading,
      retry: () => {
        setRetried(true);
        setMine(useTranscriptionServices.getState().load());
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
