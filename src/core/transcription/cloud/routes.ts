/**
 * Where meeting audio is transcribed (#141), as the core decides it: on this computer by default,
 * or by the cloud service the User chose in Settings › Meetings or on the first-recording sheet,
 * with their own key. OpenAI's is the key of the OpenAI provider in Settings › Models; Soniox
 * asks for its own, kept in the keychain.
 *
 * Choosing a service is the consent to send it meeting audio (ADR-0022): the "transcription"
 * flow. Every chunk of audio passes `sending` before it goes: the send gate (Local mode, the
 * consent still standing), the route still the one chosen, and its key still there. Any of them
 * changing stops the cloud before the next chunk. The audio is counted against the monthly cap
 * before it is sent (../../cost/meter).
 */
import { createHash } from "node:crypto";
import { strayKeyCharacter } from "../../../shared/apiKey";
import type { CloudStream, Logger } from "../../adapters";
import type {
  CloudTranscriptionRoute,
  SetTranscriptionKeyInput,
  TranscriptionRoute,
  TranscriptionServiceStatus,
} from "../../api";
import type { Consent } from "../../consent";
import type { Meter } from "../../cost/meter";
import { InvalidInputError, isRecord, LocalModeError, SecretStorageError } from "../../errors";
import { readApiKey } from "../../providers/apiKey";
import { TRANSCRIPTION_SERVICES } from "../../providers/catalog/transcription";
import type { Secrets } from "../../secrets";
import { createSendGate } from "../../sendGate";
import type { SettingsStore } from "../../settings";

const SENDS = ["meeting-audio"] as const;

/** A request that reads nothing of the User's, to check a service's own key before it is kept. */
const KEY_CHECKS: Partial<Record<CloudTranscriptionRoute, string>> = {
  soniox: "https://api.soniox.com/v1/models",
};
const KEY_CHECK_TIMEOUT_MS = 15_000;

const keyName = (route: CloudTranscriptionRoute) => `transcription:${route}:api-key`;
const fingerprint = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex");

export const isCloudRoute = (route: unknown): route is CloudTranscriptionRoute =>
  typeof route === "string" && Object.hasOwn(TRANSCRIPTION_SERVICES, route);

export interface CloudAudioMeter {
  /** Counts audio about to be sent; false, counting nothing, when it would pass the monthly cap. */
  add(ms: number): boolean;
}

/**
 * Where a stretch of recording goes: the chosen service, ready to open streams; or this computer,
 * because the month is at the cap, the service refused its key, or Local mode is on.
 */
export type CloudStart =
  | { route: CloudTranscriptionRoute; stream: CloudStream; meter: CloudAudioMeter }
  | { route: CloudTranscriptionRoute; refused: "cap" | "key" | "local-mode" };

/**
 * Whether audio may go to a route now. "local-mode": “Keep everything on this computer” is on;
 * "stopped": the route isn't the one chosen any more, its key is gone, or its consent is.
 */
export type CloudSending = "ok" | "local-mode" | "stopped";

export interface CloudTranscriptionOptions {
  settings: SettingsStore;
  secrets: Secrets;
  consent: Consent;
  meter: Meter;
  localOnly(): boolean;
  /** The key of the saved chat provider for a catalog entry, with its row. */
  providerKey(catalogId: string): Promise<{ providerId: string; apiKey: string } | null>;
  /** Silero VAD's file, downloaded first if needed: OpenAI's turns need it. */
  vadFile(): Promise<string>;
  log: Logger;
  fetch?: typeof fetch;
}

export type CloudTranscription = ReturnType<typeof createCloudTranscription>;

export function createCloudTranscription(options: CloudTranscriptionOptions) {
  const { settings, secrets, consent, meter, log } = options;
  const request = options.fetch ?? fetch;
  const gate = createSendGate(consent, options.localOnly);
  const chosen = () => settings.get().device.transcriptionRoute;
  // By fingerprint, read ahead: the gate runs per chunk and can't wait for the keychain.
  const keys = new Map<CloudTranscriptionRoute, string>();
  // Until the key changes, so each Meeting doesn't start with a refusal and a gap.
  const refused = new Set<CloudTranscriptionRoute>();

  async function keyOf(
    route: CloudTranscriptionRoute,
  ): Promise<{ providerId: string; apiKey: string } | null> {
    if (TRANSCRIPTION_SERVICES[route].key === "provider") return options.providerKey(route);
    const apiKey = await secrets.tryGet(keyName(route));
    return apiKey ? { providerId: route, apiKey } : null;
  }

  function remember(route: CloudTranscriptionRoute, apiKey: string | null): void {
    const now = apiKey === null ? null : fingerprint(apiKey);
    if (keys.get(route) !== now) refused.delete(route);
    if (now === null) keys.delete(route);
    else keys.set(route, now);
  }

  consent.registry.register({
    id: "transcription",
    sends: SENDS,
    async services() {
      const route = chosen();
      return isCloudRoute(route) ? [TRANSCRIPTION_SERVICES[route].service] : [];
    },
  });

  const list = async (): Promise<TranscriptionServiceStatus[]> =>
    Promise.all(
      Object.values(TRANSCRIPTION_SERVICES).map(async (service) => {
        const key = await keyOf(service.route);
        remember(service.route, key?.apiKey ?? null);
        return {
          route: service.route,
          name: service.name,
          model: service.model,
          perHour: service.perHour,
          key: service.key,
          hasKey: key !== null,
          liveSpeakers: service.liveSpeakers,
          keyUrl: service.keyUrl ?? null,
        };
      }),
    );

  function sending(route: CloudTranscriptionRoute): CloudSending {
    if (chosen() !== route || !keys.has(route)) return "stopped";
    try {
      gate.check("transcription", TRANSCRIPTION_SERVICES[route].service);
      return "ok";
    } catch (error) {
      return error instanceof LocalModeError ? "local-mode" : "stopped";
    }
  }

  return {
    list,

    sending,

    /** The User chose where meeting audio is transcribed: a cloud service, chosen, is allowed. */
    chose(route: TranscriptionRoute | null): void {
      if (isCloudRoute(route))
        consent.choose(["transcription"], TRANSCRIPTION_SERVICES[route].service);
    },

    /** A choice the User can make now: a cloud service needs its key. */
    async check(route: unknown): Promise<void> {
      if (!isCloudRoute(route)) return;
      if (options.localOnly())
        throw new InvalidInputError({ key: "error.transcription.localMode" });
      if (!(await keyOf(route))) {
        throw new InvalidInputError({
          key: "error.transcription.noKey",
          values: { service: TRANSCRIPTION_SERVICES[route].name },
        });
      }
    },

    /** The User revoked a flow to a service: a route it was the consent for is chosen no more. */
    revoked(flowId: string, serviceId: string): void {
      const route = chosen();
      if (flowId !== "transcription" || !isCloudRoute(route)) return;
      if (TRANSCRIPTION_SERVICES[route].service.id === serviceId) {
        settings.update({ device: { transcriptionRoute: "local" } });
      }
    },

    /**
     * Reads the keys again, after a provider was saved or deleted: a chosen route whose key went
     * is chosen no more. Resolves to whether that changed the route.
     */
    async refreshKeys(): Promise<boolean> {
      await list();
      const route = chosen();
      if (!isCloudRoute(route) || keys.has(route)) return false;
      settings.update({ device: { transcriptionRoute: "local" } });
      return true;
    },

    /** The service refused the route's key: the next Meetings go to this computer until it changes. */
    refuse(route: CloudTranscriptionRoute): void {
      refused.add(route);
    },

    async setKey(input: unknown): Promise<TranscriptionServiceStatus[]> {
      const given = isRecord(input) ? (input as Partial<SetTranscriptionKeyInput>) : {};
      const route = given.route;
      if (!isCloudRoute(route) || TRANSCRIPTION_SERVICES[route].key !== "own") {
        throw new InvalidInputError({ key: "error.transcription.noOwnKey" });
      }
      const apiKey = typeof given.apiKey === "string" ? readApiKey(given.apiKey) : "";
      if (!apiKey) throw new InvalidInputError({ key: "error.transcription.keyMissing" });
      // Checked before the key goes to the service: one it can't keep shouldn't leave at all.
      const storage = secrets.status();
      if (!storage.canSave) throw new SecretStorageError(storage.protection);
      const check = KEY_CHECKS[route];
      if (check) {
        let status: number;
        try {
          status = (
            await request(check, {
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
            })
          ).status;
        } catch (error) {
          log.warn("transcription.keyCheckFailed", {
            route,
            message: error instanceof Error ? error.message : String(error),
          });
          throw new InvalidInputError({
            key: "error.transcription.unreachable",
            values: { service: TRANSCRIPTION_SERVICES[route].name },
          });
        }
        if (status === 401 || status === 403) {
          throw new InvalidInputError({
            key: "error.transcription.keyRefused",
            values: { service: TRANSCRIPTION_SERVICES[route].name },
          });
        }
      }
      await secrets.set(keyName(route), apiKey);
      return list();
    },

    async removeKey(route: unknown): Promise<TranscriptionServiceStatus[]> {
      if (!isCloudRoute(route))
        throw new InvalidInputError({ key: "error.transcription.unknownService" });
      if (TRANSCRIPTION_SERVICES[route].key === "own") await secrets.delete(keyName(route));
      keys.delete(route);
      if (chosen() === route) settings.update({ device: { transcriptionRoute: "local" } });
      return list();
    },

    /**
     * Where a stretch of recording starting now is transcribed: the chosen cloud service, ready
     * to open streams, or null for this computer.
     */
    async start(): Promise<CloudStart | null> {
      const route = chosen();
      if (!isCloudRoute(route)) return null;
      const service = TRANSCRIPTION_SERVICES[route];
      const key = await keyOf(route);
      remember(route, key?.apiKey ?? null);
      if (!key) return null;
      if (strayKeyCharacter(key.apiKey)) {
        refused.add(route);
        return { route, refused: "key" };
      }
      const now = sending(route);
      if (now === "local-mode") return { route, refused: "local-mode" };
      if (now !== "ok") return null;
      if (refused.has(route)) return { route, refused: "key" };
      const audio = meter.audio({
        providerId: key.providerId,
        modelId: service.model,
        perHour: service.perHour,
      });
      if (!audio.add(0)) return { route, refused: "cap" };
      const stream: CloudStream =
        route === "openai"
          ? {
              service: "openai",
              model: service.model,
              apiKey: key.apiKey,
              vad: await options.vadFile(),
            }
          : { service: "soniox", model: service.model, apiKey: key.apiKey };
      return { route, stream, meter: audio };
    },
  };
}
