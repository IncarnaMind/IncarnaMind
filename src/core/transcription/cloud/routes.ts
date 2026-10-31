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
  ExternalService,
  SetTranscriptionKeyInput,
  TranscriptionRoute,
  TranscriptionServices,
} from "../../api";
import type { Consent } from "../../consent";
import type { Meter } from "../../cost/meter";
import { InvalidInputError, isRecord, LocalModeError, SecretStorageError } from "../../errors";
import { readApiKey } from "../../providers/apiKey";
import { qwenRegion, TRANSCRIPTION_SERVICES } from "../../providers/catalog/transcription";
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

interface ServiceKey {
  providerId: string;
  apiKey: string;
  endpoint: string | null;
}

export interface CloudTranscriptionOptions {
  settings: SettingsStore;
  secrets: Secrets;
  consent: Consent;
  meter: Meter;
  localOnly(): boolean;
  /** The key of the saved chat provider for a catalog entry, with its row. */
  providerKey(catalogId: string): Promise<ServiceKey | null>;
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
  // By fingerprint and the region of its provider, read ahead: the gate runs per chunk and can't
  // wait for the keychain.
  const keys = new Map<CloudTranscriptionRoute, { fingerprint: string; endpoint: string | null }>();
  // Until the key changes, so each Meeting doesn't start with a refusal and a gap.
  const refused = new Set<CloudTranscriptionRoute>();
  // Grows with every committed change to what `list` says; a failed change leaves it alone.
  let revision = 0;

  async function keyOf(route: CloudTranscriptionRoute): Promise<ServiceKey | null> {
    if (TRANSCRIPTION_SERVICES[route].key === "provider") return options.providerKey(route);
    const apiKey = await secrets.tryGet(keyName(route));
    return apiKey ? { providerId: route, apiKey, endpoint: null } : null;
  }

  function remember(route: CloudTranscriptionRoute, key: ServiceKey | null): void {
    const was = keys.get(route);
    const now = key && { fingerprint: fingerprint(key.apiKey), endpoint: key.endpoint };
    if (was?.fingerprint !== now?.fingerprint || was?.endpoint !== now?.endpoint) {
      refused.delete(route);
    }
    if (now) keys.set(route, now);
    else keys.delete(route);
  }

  /** Where a route's audio goes: Qwen's address is the host of its key's region. */
  const serviceNow = (route: CloudTranscriptionRoute): ExternalService =>
    route === "qwen"
      ? qwenRegion(keys.get(route)?.endpoint ?? null).service
      : TRANSCRIPTION_SERVICES[route].service;

  consent.registry.register({
    id: "transcription",
    sends: SENDS,
    async services() {
      const route = chosen();
      if (!isCloudRoute(route)) return [];
      remember(route, await keyOf(route));
      return [serviceNow(route)];
    },
  });

  const readServices = () =>
    Promise.all(
      Object.values(TRANSCRIPTION_SERVICES).map(async (service) => {
        const key = await keyOf(service.route);
        remember(service.route, key);
        const region = service.route === "qwen" && key ? qwenRegion(key.endpoint) : null;
        return {
          route: service.route,
          name: service.name,
          recipient: service.recipient,
          model: service.model,
          perHour: region?.perHour ?? service.perHour,
          region: region?.label ?? null,
          dataUse: service.dataUse ?? null,
          key: service.key,
          hasKey: key !== null,
          liveSpeakers: service.liveSpeakers,
          keyUrl: service.keyUrl ?? null,
        };
      }),
    );

  // Stamped with the revision it began at, so it never claims a state newer than what it saw. A
  // change committed meanwhile answers with its own, higher revision, and whoever holds both
  // keeps that one.
  const list = async (): Promise<TranscriptionServices> => {
    const at = revision;
    return { revision: at, services: await readServices() };
  };

  function sending(route: CloudTranscriptionRoute, stream: CloudStream | null): CloudSending {
    if (chosen() !== route) return "stopped";
    const current = keys.get(route);
    if (!current) return "stopped";
    if (stream) {
      if (stream.service !== route) return "stopped";
      if (current.fingerprint !== fingerprint(stream.apiKey)) return "stopped";
      if (
        route === "qwen" &&
        (stream.service !== "qwen" || qwenRegion(current.endpoint).url !== stream.url)
      ) {
        return "stopped";
      }
    }
    try {
      gate.check("transcription", serviceNow(route));
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
      if (isCloudRoute(route)) consent.choose(["transcription"], serviceNow(route));
    },

    /** A choice the User can make now: a cloud service needs its key. */
    async check(route: unknown): Promise<void> {
      if (!isCloudRoute(route)) return;
      if (options.localOnly())
        throw new InvalidInputError({ key: "error.transcription.localMode" });
      const key = await keyOf(route);
      remember(route, key);
      if (!key) {
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
      if (serviceNow(route).id === serviceId) {
        settings.update({ device: { transcriptionRoute: "local" } });
      }
    },

    /**
     * Reads the keys again, after a provider was saved or deleted: a chosen route whose key went
     * is chosen no more. Resolves to whether that changed the route.
     */
    async refreshKeys(): Promise<boolean> {
      revision += 1;
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

    async setKey(input: unknown): Promise<TranscriptionServices> {
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
      revision += 1;
      return list();
    },

    async removeKey(route: unknown): Promise<TranscriptionServices> {
      if (!isCloudRoute(route))
        throw new InvalidInputError({ key: "error.transcription.unknownService" });
      if (TRANSCRIPTION_SERVICES[route].key === "own") await secrets.delete(keyName(route));
      keys.delete(route);
      revision += 1;
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
      remember(route, key);
      if (!key) return null;
      if (strayKeyCharacter(key.apiKey)) {
        refused.add(route);
        return { route, refused: "key" };
      }
      const now = sending(route, null);
      if (now === "local-mode") return { route, refused: "local-mode" };
      if (now !== "ok") return null;
      if (refused.has(route)) return { route, refused: "key" };
      const region = route === "qwen" ? qwenRegion(key.endpoint) : null;
      const audio = meter.audio({
        providerId: key.providerId,
        modelId: service.model,
        perHour: region?.perHour ?? service.perHour,
      });
      if (!audio.add(0)) return { route, refused: "cap" };
      const { model } = service;
      const { apiKey } = key;
      const stream: CloudStream = region
        ? { service: "qwen", model, apiKey, url: region.url }
        : route === "openai"
          ? { service: "openai", model, apiKey, vad: await options.vadFile() }
          : { service: "soniox", model, apiKey };
      return { route, stream, meter: audio };
    },
  };
}
