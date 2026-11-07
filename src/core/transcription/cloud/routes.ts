/**
 * Where meeting audio is transcribed (#141, #866), as the core decides it: on this computer by
 * default, or live by the cloud service the User chose in Settings › Meetings or on the
 * first-recording sheet, with their own key. OpenAI's, Qwen's, Gemini's, Mistral's and xAI's is
 * the key of their provider in Settings › Models; Soniox, Deepgram, AssemblyAI, ElevenLabs,
 * Speechmatics and Gladia ask for their own, kept in the keychain. Deepgram's server can be
 * Cloudflare Workers AI's or the User's own.
 *
 * Choosing a service is the consent to send it meeting audio (ADR-0022): the "transcription"
 * flow. Every chunk of audio passes `sending` before it goes: the send gate (Local mode, the
 * consent still standing), the route still the one chosen, and its key and server still there.
 * Any of them changing stops the cloud before the next chunk; a new key for the same place
 * opens the stream again on it. The audio is counted against the monthly cap before it is sent
 * (../../cost/meter).
 */
import { createHash } from "node:crypto";
import { strayKeyCharacter } from "../../../shared/apiKey";
import { isDeepgramHost } from "../../../shared/deepgram";
import type { CloudStream, Logger } from "../../adapters";
import type {
  CloudTranscriptionRoute,
  ExternalService,
  Money,
  SetTranscriptionKeyInput,
  TranscriptionRoute,
  TranscriptionServices,
} from "../../api";
import type { Consent } from "../../consent";
import type { Meter } from "../../cost/meter";
import { InvalidInputError, isRecord, LocalModeError, SecretStorageError } from "../../errors";
import { readApiKey } from "../../providers/apiKey";
import { billingUrlOf, catalogProvider, endpointOf } from "../../providers/catalog/providers";
import {
  deepgramServer,
  qwenRegion,
  TRANSCRIPTION_SERVICES,
  type TranscriptionDataUse,
  type TranscriptionService,
} from "../../providers/catalog/transcription";
import type { Localized } from "../../providers/catalog/types";
import { isLoopbackHost } from "../../providers/service";
import type { Secrets } from "../../secrets";
import { createSendGate } from "../../sendGate";
import type { SettingsStore } from "../../settings";
import { ASSEMBLYAI_AUTH } from "./assemblyai";
import { ELEVENLABS_AUTH } from "./elevenlabs";
import { DEEPGRAM_URL } from "./protocol";
import { authHeaders, BEARER, type CloudAuth } from "./socket";

const SENDS = ["meeting-audio"] as const;

interface KeyCheck {
  url: string;
  auth: CloudAuth;
  /** A GET when absent. */
  method?: "POST";
  /** JSON. */
  body?: string;
}

/**
 * A request that reads nothing of the User's, to check a service's own key before it is kept.
 * Gladia has none: its key is first tried by a Meeting.
 */
const KEY_CHECKS: Partial<Record<CloudTranscriptionRoute, KeyCheck>> = {
  soniox: { url: "https://api.soniox.com/v1/models", auth: BEARER },
  // A token for one minute's stream, which is never used.
  assemblyai: {
    url: "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60",
    auth: ASSEMBLYAI_AUTH,
  },
  // A single-use token for a real-time session, which is never used and lapses in 15 minutes.
  elevenlabs: {
    url: "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
    auth: ELEVENLABS_AUTH,
    method: "POST",
  },
  // A temporary key for one minute's real-time session, which is never used.
  speechmatics: {
    url: "https://mp.speechmatics.com/v1/jwts?type=rt",
    auth: BEARER,
    method: "POST",
    body: JSON.stringify({ ttl: 60 }),
  },
};
/** Deepgram's own servers are asked for the key's projects; Cloudflare's and the User's aren't asked. */
const deepgramKeyCheck = (server: string | null): KeyCheck | null => {
  const host = new URL(server ?? DEEPGRAM_URL).hostname;
  return isDeepgramHost(host)
    ? { url: `https://${host}/v1/projects`, auth: { header: "Authorization", prefix: "Token " } }
    : null;
};
const KEY_CHECK_TIMEOUT_MS = 15_000;

const keyName = (route: CloudTranscriptionRoute) => `transcription:${route}:api-key`;
/** The key a service refused, as its fingerprint and where it was sent: kept until the key changes. */
const refusalName = (route: CloudTranscriptionRoute) => `transcription:${route}:refused`;
// Kept outside DeviceSettings, so only choosing a route changes them, and a restart keeps them.
const CONFIRMED_SERVICE = "transcriptionConfirmedService";
const CHOOSE_AGAIN = "transcriptionChooseAgain";
/** Deepgram's server, where it isn't Deepgram's own. */
const DEEPGRAM_SERVER = "transcriptionDeepgramServer";
const fingerprint = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex");

export const isCloudRoute = (route: unknown): route is CloudTranscriptionRoute =>
  typeof route === "string" && Object.hasOwn(TRANSCRIPTION_SERVICES, route);

/** Languages as their ISO 639 code, under the names systems still give some of them. */
const ALIASES: Readonly<Record<string, string>> = { iw: "he", in: "id", fil: "tl", nb: "no" };

/** The languages of BCP 47 tags, each once: "zh-Hans-CN" and "zh-TW" are both "zh". */
export function languagesOf(tags: readonly string[]): string[] {
  const codes = tags.flatMap((tag) => {
    const base = tag.toLowerCase().split(/[-_]/)[0] ?? "";
    return /^[a-z]{2,3}$/.test(base) && base !== "und" ? [ALIASES[base] ?? base] : [];
  });
  return [...new Set(codes)];
}

export interface CloudAudioMeter {
  /** Counts audio about to be sent; false, counting nothing, when it would pass the monthly cap. */
  add(ms: number): boolean;
}

/**
 * Where a stretch of recording goes: the chosen service, ready to open streams; or this computer,
 * because the month is at the cap, the service refused its key, Local mode is on, or the key now
 * sends somewhere the User hasn't chosen.
 */
export type CloudStart =
  | { route: CloudTranscriptionRoute; stream: CloudStream; meter: CloudAudioMeter }
  | { route: CloudTranscriptionRoute; refused: "cap" | "key" | "local-mode" | "moved" };

/**
 * Whether audio may go to a route now. "local-mode": “Keep everything on this computer” is on;
 * "stopped": the route isn't the one chosen any more, its key is gone, or its consent is;
 * "moved": its key now sends the audio somewhere the User hasn't chosen (Qwen's key is for
 * another region, Deepgram's server is another), so the route was set back to this computer
 * until they choose it again; "renew": a new key (or address) for the same service, which the
 * stream is to be opened again with.
 */
export type CloudSending = "ok" | "local-mode" | "stopped" | "moved" | "renew";

interface ServiceKey {
  providerId: string;
  apiKey: string;
  /** Qwen's region, by the id of its endpoint; Deepgram's server, by its address. */
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
  /** The languages the User speaks, as BCP 47 tags: the interface's, then the computer's. */
  languages(): readonly string[];
  log: Logger;
  fetch?: typeof fetch;
}

/** Where a route's audio goes now and on what terms: Qwen's by its key's region, Deepgram's by its server. */
interface Destination {
  /** What consent is for: null for a server on this computer, which needs none. */
  service: ExternalService | null;
  /** The same place, also for a server on this computer. */
  id: string;
  url: string | null;
  recipient: Localized;
  perHour: Money;
  dataUse: TranscriptionDataUse | null;
  region: Localized | null;
}

export type CloudTranscription = ReturnType<typeof createCloudTranscription>;

/**
 * A server address as the User may paste it, as Deepgram's WebSocket address: http(s) becomes
 * ws(s), a bare host gets Deepgram's path, and audio goes unencrypted only to this computer.
 */
export function deepgramAddress(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidInputError({ key: "error.provider.urlInvalid", values: { url: raw } });
  }
  const protocol = { "http:": "ws:", "https:": "wss:" }[url.protocol] ?? url.protocol;
  if (protocol !== "ws:" && protocol !== "wss:") {
    throw new InvalidInputError({ key: "error.transcription.serverScheme" });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InvalidInputError({ key: "error.provider.urlExtras" });
  }
  if (protocol === "ws:" && !isLoopbackHost(url.hostname)) {
    throw new InvalidInputError({ key: "error.transcription.serverEncrypted" });
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${protocol}//${url.host}${path === "" ? "/v1/listen" : path}`;
}

export function createCloudTranscription(options: CloudTranscriptionOptions) {
  const { settings, secrets, consent, meter, log } = options;
  const request = options.fetch ?? fetch;
  const gate = createSendGate(consent, options.localOnly);
  const chosen = () => settings.get().device.transcriptionRoute;
  // By fingerprint and where it sends, read ahead: the gate runs per chunk and can't wait for the
  // keychain.
  const keys = new Map<CloudTranscriptionRoute, { fingerprint: string; endpoint: string | null }>();
  // The refusals read from the keychain, by route: each Meeting doesn't start with one and a gap.
  const refusals = new Map<CloudTranscriptionRoute, string | null>();
  // The service the User last chose the route for: Qwen's key can later be one for another region.
  const confirmedValue = settings.readDeviceValue(CONFIRMED_SERVICE);
  let confirmed = typeof confirmedValue === "string" ? confirmedValue : null;
  // Set back to this computer because its key began to send elsewhere; until the User chooses again.
  const movedValue = settings.readDeviceValue(CHOOSE_AGAIN);
  let moved = isCloudRoute(movedValue) ? movedValue : null;
  // Grows with every committed change to what `list` says; a failed change leaves it alone.
  let revision = 0;

  const providerOf = (route: CloudTranscriptionRoute) =>
    TRANSCRIPTION_SERVICES[route].provider ?? route;

  function deepgramServerSaved(): string | null {
    const value = settings.readDeviceValue(DEEPGRAM_SERVER);
    return typeof value === "string" ? value : null;
  }

  async function keyOf(route: CloudTranscriptionRoute): Promise<ServiceKey | null> {
    if (TRANSCRIPTION_SERVICES[route].key === "provider") {
      return options.providerKey(providerOf(route));
    }
    const apiKey = await secrets.tryGet(keyName(route));
    if (route !== "deepgram") return apiKey ? { providerId: route, apiKey, endpoint: null } : null;
    const server = deepgramServer(deepgramServerSaved());
    if (!apiKey && server.needsKey) return null;
    return { providerId: route, apiKey: apiKey ?? "", endpoint: server.url };
  }

  function remember(route: CloudTranscriptionRoute, key: ServiceKey | null): void {
    if (key) keys.set(route, { fingerprint: fingerprint(key.apiKey), endpoint: key.endpoint });
    else keys.delete(route);
  }

  function destination(route: CloudTranscriptionRoute): Destination {
    const service = TRANSCRIPTION_SERVICES[route];
    const endpoint = keys.get(route)?.endpoint ?? null;
    if (route === "qwen") {
      const region = qwenRegion(endpoint);
      return {
        service: region.service,
        id: region.service.id,
        url: region.url,
        recipient: service.recipient,
        perHour: region.perHour,
        dataUse: service.dataUse ?? null,
        region: region.label,
      };
    }
    if (route === "deepgram") {
      const server = deepgramServer(endpoint ?? deepgramServerSaved());
      return {
        service: server.service,
        id: server.service?.id ?? new URL(server.url).origin,
        url: server.url,
        recipient: server.recipient,
        perHour: server.perHour,
        dataUse: server.dataUse,
        region: null,
      };
    }
    return {
      service: service.service,
      id: service.service.id,
      url: null,
      recipient: service.recipient,
      perHour: service.perHour,
      dataUse: service.dataUse ?? null,
      region: null,
    };
  }

  // A route chosen before the service was kept (OpenAI or Soniox, whose service never changes)
  // has nothing to compare.
  const movedAway = (route: CloudTranscriptionRoute) =>
    confirmed !== null && destination(route).id !== confirmed;

  function setBack(route: CloudTranscriptionRoute): void {
    moved = route;
    settings.writeDeviceValue(CHOOSE_AGAIN, route);
    settings.update({ device: { transcriptionRoute: "local" } });
  }

  /** The refusal a key would be: its fingerprint and the address it went to. */
  const refusalOf = (apiKey: string, url: string | null) => `${fingerprint(apiKey)} ${url ?? ""}`;

  async function refusedNow(route: CloudTranscriptionRoute): Promise<string | null> {
    if (!refusals.has(route)) refusals.set(route, await secrets.tryGet(refusalName(route)));
    return refusals.get(route) ?? null;
  }

  /** The User saved the key again: the next Meeting tries it, even the same key (an account put right). */
  async function forgetRefusal(route: CloudTranscriptionRoute): Promise<void> {
    refusals.set(route, null);
    await secrets.delete(refusalName(route));
  }

  consent.registry.register({
    id: "transcription",
    sends: SENDS,
    async services() {
      const route = chosen();
      if (!isCloudRoute(route)) return [];
      remember(route, await keyOf(route));
      const { service } = destination(route);
      return service ? [service] : [];
    },
  });

  function billingUrl(route: CloudTranscriptionRoute, key: ServiceKey | null): string | null {
    const service = TRANSCRIPTION_SERVICES[route];
    if (service.key === "own") return service.billingUrl ?? null;
    const provider = catalogProvider(providerOf(route));
    if (!provider) return null;
    const endpoint = key?.endpoint ?? null;
    return (
      billingUrlOf(provider, endpoint) ??
      endpointOf(provider, endpoint)?.keyUrl ??
      provider.keyUrl ??
      null
    );
  }

  const spokenIn = (service: TranscriptionService) =>
    languagesOf(options.languages()).filter((code) => service.languages.includes(code));

  const readServices = () => {
    const spoken = languagesOf(options.languages());
    return Promise.all(
      Object.values(TRANSCRIPTION_SERVICES).map(async (service) => {
        const key = await keyOf(service.route);
        remember(service.route, key);
        const where = destination(service.route);
        const server = service.route === "deepgram" ? deepgramServerSaved() : null;
        return {
          route: service.route,
          name: service.name,
          recipient: where.recipient,
          model: service.model,
          perHour: where.perHour,
          region: key ? where.region : null,
          dataUse: where.dataUse,
          key: service.key,
          hasKey: key !== null,
          liveSpeakers: service.liveSpeakers,
          keyUrl: service.keyUrl ?? null,
          billingUrl: billingUrl(service.route, key),
          server,
          keyOptional: server !== null && !deepgramServer(server).needsKey,
          keyChecked:
            service.route === "deepgram"
              ? deepgramKeyCheck(server) !== null
              : KEY_CHECKS[service.route] !== undefined,
          languages: [...service.languages],
          missingLanguages: spoken.filter((code) => !service.languages.includes(code)),
          chooseAgain: key !== null && moved === service.route,
        };
      }),
    );
  };

  // Stamped with the revision it began at, so it never claims a state newer than what it saw. A
  // change committed meanwhile answers with its own, higher revision, and whoever holds both
  // keeps that one.
  const list = async (): Promise<TranscriptionServices> => {
    const at = revision;
    return { revision: at, services: await readServices() };
  };

  function sending(route: CloudTranscriptionRoute, stream: CloudStream | null): CloudSending {
    if (chosen() !== route) return moved === route ? "moved" : "stopped";
    const current = keys.get(route);
    if (!current) return "stopped";
    // Before the stream's own checks: a stream open to the old region is "moved" from the first
    // chunk the new key is read for, whenever the route itself is set back.
    if (movedAway(route)) return "moved";
    const where = destination(route);
    if (stream) {
      if (stream.service !== route) return "stopped";
      if ("url" in stream && stream.url !== where.url) {
        // Qwen's other region is "moved" above; the same one at another address is no longer it.
        return route === "qwen" ? "stopped" : "renew";
      }
      if (current.fingerprint !== fingerprint(stream.apiKey)) return "renew";
    }
    // A server on this computer gets audio that never leaves it; Local mode still stops it, as any route.
    if (!where.service) return options.localOnly() ? "local-mode" : "ok";
    try {
      gate.check("transcription", where.service);
      return "ok";
    } catch (error) {
      return error instanceof LocalModeError ? "local-mode" : "stopped";
    }
  }

  async function checkKey(route: CloudTranscriptionRoute, apiKey: string, server: string | null) {
    const check = route === "deepgram" ? deepgramKeyCheck(server) : (KEY_CHECKS[route] ?? null);
    if (!check) return;
    const name = TRANSCRIPTION_SERVICES[route].name;
    let status: number;
    try {
      status = (
        await request(check.url, {
          headers: {
            ...authHeaders(apiKey, check.auth),
            ...(check.body !== undefined && { "content-type": "application/json" }),
          },
          ...(check.method && { method: check.method }),
          ...(check.body !== undefined && { body: check.body }),
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
        values: { service: name },
      });
    }
    if (status === 401 || status === 403) {
      throw new InvalidInputError({
        key: "error.transcription.keyRefused",
        values: { service: name },
      });
    }
  }

  return {
    list,

    sending,

    /** The User chose where meeting audio is transcribed: a cloud service, chosen, is allowed. */
    chose(route: TranscriptionRoute | null): void {
      moved = null;
      settings.deleteDeviceValue(CHOOSE_AGAIN);
      if (!isCloudRoute(route)) return;
      const where = destination(route);
      if (where.service) consent.choose(["transcription"], where.service);
      confirmed = where.id;
      settings.writeDeviceValue(CONFIRMED_SERVICE, where.id);
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
      if (destination(route).service?.id === serviceId) {
        settings.update({ device: { transcriptionRoute: "local" } });
      }
    },

    /**
     * Reads the keys again, after a provider was saved or deleted: a chosen route whose key went
     * is chosen no more, and one whose key now sends somewhere other than the service the User
     * chose it for (Qwen's, for another region) is set back to this computer until they choose it
     * again, as consent is for where the audio goes (ADR-0022). `saved` is the catalog id of a
     * provider whose key the User just saved: its route tries that key again, as saving a
     * meeting service's own key does. Resolves to whether that changed the route.
     */
    async refreshKeys(saved: string | null = null): Promise<boolean> {
      revision += 1;
      for (const service of Object.values(TRANSCRIPTION_SERVICES)) {
        if (service.key === "provider" && providerOf(service.route) === saved) {
          await forgetRefusal(service.route);
        }
      }
      await list();
      const route = chosen();
      if (!isCloudRoute(route)) return false;
      if (!keys.has(route)) {
        settings.update({ device: { transcriptionRoute: "local" } });
        return true;
      }
      if (!movedAway(route)) return false;
      setBack(route);
      return true;
    },

    /**
     * The service refused the key a stream was opened with: Meetings go to this computer until
     * the key changes, after a restart too.
     */
    refuse(route: CloudTranscriptionRoute, stream: CloudStream): void {
      const refusal = refusalOf(stream.apiKey, "url" in stream ? stream.url : null);
      refusals.set(route, refusal);
      secrets.set(refusalName(route), refusal).catch((error: unknown) => {
        // Remembered until the app quits: the next start tries the key once more.
        log.warn("transcription.refusalUnsaved", {
          route,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },

    async setKey(input: unknown): Promise<TranscriptionServices> {
      const given = isRecord(input) ? (input as Partial<SetTranscriptionKeyInput>) : {};
      const route = given.route;
      if (!isCloudRoute(route) || TRANSCRIPTION_SERVICES[route].key !== "own") {
        throw new InvalidInputError({ key: "error.transcription.noOwnKey" });
      }
      const server =
        route === "deepgram" && typeof given.server === "string" && given.server.trim() !== ""
          ? deepgramAddress(given.server)
          : null;
      const saved = server === DEEPGRAM_URL ? null : server;
      const apiKey = typeof given.apiKey === "string" ? readApiKey(given.apiKey) : "";
      const keyOptional = saved !== null && !deepgramServer(saved).needsKey;
      if (!apiKey && !keyOptional) {
        throw new InvalidInputError({ key: "error.transcription.keyMissing" });
      }
      // Checked before the key goes to the service: one it can't keep shouldn't leave at all.
      const storage = secrets.status();
      if (apiKey && !storage.canSave) throw new SecretStorageError(storage.protection);
      // Local mode sends nothing, so the key is kept unchecked; its service checks it at the first stream.
      if (apiKey && !options.localOnly()) await checkKey(route, apiKey, saved);
      // The key is for its server alone: another server never gets the one kept before.
      if (apiKey) await secrets.set(keyName(route), apiKey);
      else await secrets.delete(keyName(route));
      await forgetRefusal(route);
      if (route === "deepgram") {
        if (saved) settings.writeDeviceValue(DEEPGRAM_SERVER, saved);
        else settings.deleteDeviceValue(DEEPGRAM_SERVER);
      }
      revision += 1;
      remember(route, await keyOf(route));
      // Another server is somewhere the User hasn't chosen: Meetings wait until they choose it.
      if (chosen() === route && movedAway(route)) setBack(route);
      return list();
    },

    async removeKey(route: unknown): Promise<TranscriptionServices> {
      if (!isCloudRoute(route))
        throw new InvalidInputError({ key: "error.transcription.unknownService" });
      if (TRANSCRIPTION_SERVICES[route].key === "own") await secrets.delete(keyName(route));
      if (route === "deepgram") settings.deleteDeviceValue(DEEPGRAM_SERVER);
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
      if (strayKeyCharacter(key.apiKey)) return { route, refused: "key" };
      const now = sending(route, null);
      if (now === "moved") {
        setBack(route);
        return { route, refused: "moved" };
      }
      if (now === "local-mode") return { route, refused: "local-mode" };
      if (now !== "ok") return null;
      const where = destination(route);
      if ((await refusedNow(route)) === refusalOf(key.apiKey, where.url)) {
        return { route, refused: "key" };
      }
      const audio = meter.audio({
        providerId: key.providerId,
        modelId: service.model,
        perHour: where.perHour,
      });
      if (!audio.add(0)) return { route, refused: "cap" };
      const { model } = service;
      const { apiKey } = key;
      const url = where.url ?? "";
      const stream: CloudStream =
        route === "qwen"
          ? { service: "qwen", model, apiKey, url }
          : route === "deepgram"
            ? { service: "deepgram", model, apiKey, url }
            : route === "openai"
              ? { service: "openai", model, apiKey, vad: await options.vadFile() }
              : route === "gladia"
                ? { service: "gladia", model, apiKey, languages: spokenIn(service) }
                : { service: route, model, apiKey };
      return { route, stream, meter: audio };
    },
  };
}
