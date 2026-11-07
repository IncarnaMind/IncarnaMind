/**
 * Decision models on hosts other than TypeSafe's Jev (#1907): Decider, d1-ultra, Clef and the
 * rest, through OpenRouter, Perplexity, Liquid AI, Cloudflare Workers AI, OpenAI or Alibaba Cloud
 * (../providers/catalog/decisions.ts). Each tags and organizes Documents as Jev does (./jev.ts),
 * with the probability that each Tag applies.
 *
 * A host's own key lives in the keychain, never in SQLite; Cloudflare's account ID and the Model
 * Studio workspace are per device, like the key. A host that uses a chat provider's key reads it
 * from that provider. Its requests are the "tagging" and "classification" data flows, to the
 * host's service: nothing is sent before the User accepts them.
 */
import type {
  CloudReadPermit,
  DecisionHostStatus,
  ExternalService,
  SetDecisionKeyInput,
} from "../api";
import type { Consent } from "../consent";
import { InvalidInputError, isRecord, LocalModeError, TaggingNotReadyError } from "../errors";
import { decisionGroupClassifier, reviewBandFor } from "../library/classifier";
import { parseApiKey } from "../providers/apiKey";
import {
  DECISION_HOST_ENTRIES,
  DECISION_HOSTS,
  type DecisionHost,
  type DecisionHostAddress,
  decisionEndpoint,
  decisionModelOf,
  decisionOrigin,
  decisionService,
  isDecisionHost,
  validAccount,
} from "../providers/catalog/decisions";
import { askJev, JevRequestError } from "../providers/jev";
import { classifyProviderError } from "../providers/providerErrors";
import { redactMessage } from "../redact";
import type { Secrets } from "../secrets";
import { createSendGate } from "../sendGate";
import type { SettingsStore } from "../settings";
import type { TagClassifier } from "./classify";
import { decisionsFromProbabilities, jevState, tagQuestions } from "./jev";

/** A per-device value, outside `DeviceSettings`: the accounts the hosts ask for, by host. */
const ACCOUNTS_KEY = "decisionHosts";
const keyName = (host: DecisionHost) => `decision:${host}:api-key`;

const TAGGING_RETRIES = 2;
const TAGGING_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 30_000;

interface HostKey {
  apiKey: string;
  /** The chat provider's endpoint id (Qwen's "cn" or "intl"); null for a key of the host's own. */
  region: string | null;
}

export interface DecisionHostsOptions {
  settings: SettingsStore;
  secrets: Secrets;
  consent: Consent;
  /** The key of the saved chat provider for a catalog entry, with its region. */
  providerKey(catalogId: string): Promise<{ apiKey: string; endpoint: string | null } | null>;
  localOnly(): boolean;
  signal: AbortSignal;
  /** Where each host's requests go instead of its own origin (tests use a local fake). */
  origins?: Partial<Record<DecisionHost, string>>;
}

export type DecisionHosts = ReturnType<typeof createDecisionHosts>;

export function createDecisionHosts(options: DecisionHostsOptions) {
  const { settings, secrets, consent, signal } = options;
  const gate = createSendGate(consent, options.localOnly);

  /** The account each host asks for, with the region its key was for when it was saved. */
  const saved = (): Partial<Record<DecisionHost, DecisionHostAddress>> => {
    const value = settings.readDeviceValue(ACCOUNTS_KEY);
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      DECISION_HOSTS.flatMap((host) => {
        const each = value[host];
        if (!isRecord(each) || typeof each.account !== "string") return [];
        return [
          [
            host,
            { account: each.account, region: typeof each.region === "string" ? each.region : null },
          ],
        ];
      }),
    );
  };
  const writeAccount = (host: DecisionHost, address: DecisionHostAddress | null) => {
    const { [host]: _left, ...rest } = saved();
    settings.writeDeviceValue(ACCOUNTS_KEY, address === null ? rest : { ...rest, [host]: address });
  };
  const accountOf = (host: DecisionHost) => saved()[host]?.account ?? null;

  async function keyOf(host: DecisionHost): Promise<HostKey | null> {
    const entry = DECISION_HOST_ENTRIES[host];
    if (entry.key === "provider" && entry.provider) {
      const saved = await options.providerKey(entry.provider);
      return saved && { apiKey: saved.apiKey, region: saved.endpoint };
    }
    const apiKey = await secrets.tryGet(keyName(host));
    return apiKey ? { apiKey, region: null } : null;
  }

  /**
   * Where a host's requests go, as saved with its account: consent, the Privacy page and the
   * requests all name this one address, whatever key is saved since.
   */
  const addressOf = (host: DecisionHost): DecisionHostAddress =>
    saved()[host] ?? { account: null, region: null };

  /** The service a host sends Document text to: no keychain read, for the checks that can't wait. */
  const savedService = (host: DecisionHost): ExternalService | null =>
    decisionService(host, addressOf(host));

  /**
   * A chat provider's key for another region than the account was saved with (another Qwen key)
   * would be sent where consent doesn't name: the host waits until its account is saved again.
   */
  const keyFitsAccount = (host: DecisionHost, key: HostKey) =>
    !DECISION_HOST_ENTRIES[host].account ||
    DECISION_HOST_ENTRIES[host].key !== "provider" ||
    addressOf(host).region === key.region;

  const isReady = (host: DecisionHost, key: HostKey | null) =>
    key !== null &&
    (!DECISION_HOST_ENTRIES[host].account || accountOf(host) !== null) &&
    keyFitsAccount(host, key);

  const endpointOf = (host: DecisionHost, model: string, address: DecisionHostAddress) =>
    decisionEndpoint(
      host,
      model,
      address,
      options.origins?.[host] ?? decisionOrigin(host, address),
    );

  async function statusOf(host: DecisionHost): Promise<DecisionHostStatus> {
    const entry = DECISION_HOST_ENTRIES[host];
    const key = await keyOf(host);
    const address = addressOf(host);
    return {
      host,
      name: entry.name,
      key: entry.key,
      provider: entry.provider ?? null,
      account: entry.account ? { kind: entry.account, value: address.account } : null,
      hasKey: key !== null,
      ready: isReady(host, key),
      models: entry.models.map(({ id, name, maker }) => ({ id, name, maker })),
      service: savedService(host),
      keyUrl: entry.keyUrl,
      pricingUrl: entry.pricingUrl,
    };
  }

  const list = () => Promise.all(DECISION_HOSTS.map(statusOf));

  /** What a host needs to take a request now, or why it can't, in the words the User reads. */
  async function connection(host: DecisionHost, modelId: string) {
    const entry = DECISION_HOST_ENTRIES[host];
    const key = await keyOf(host);
    if (!key) {
      throw new TaggingNotReadyError({
        key: "error.tagging.decisionKeyMissing",
        values: { provider: entry.name.en },
      });
    }
    if (!decisionModelOf(host, modelId)) {
      throw new TaggingNotReadyError({
        key: "error.tagging.decisionModelGone",
        values: { provider: entry.name.en, model: modelId },
      });
    }
    const address = addressOf(host);
    const endpoint = endpointOf(host, modelId, address);
    const service = decisionService(host, address);
    if (!endpoint || !service || !keyFitsAccount(host, key)) {
      throw new TaggingNotReadyError({
        key: "error.tagging.decisionAccountMissing",
        values: { provider: entry.name.en },
      });
    }
    return { apiKey: key.apiKey, endpoint, service };
  }

  /** Asks one question about a fixed text, nothing of the User's: the check of a key before it is kept. */
  async function check(host: DecisionHost, apiKey: string, address: DecisionHostAddress) {
    const model = DECISION_HOST_ENTRIES[host].models[0];
    const endpoint = model && endpointOf(host, model.id, address);
    if (!model || !endpoint) return;
    try {
      await askJev({
        baseUrl: endpoint.url,
        endpoint,
        apiKey,
        model: model.id,
        state: "IncarnaMind is checking that it can reach this service.",
        questions: {
          connection_check: { type: "noul", instructions: "Is this text a connection check?" },
        },
        signal,
        retries: 0,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const refused = classifyProviderError(error);
      throw new InvalidInputError({
        key: refused.kind === "auth" ? "error.decision.keyRefused" : "error.decision.checkFailed",
        values: {
          provider: DECISION_HOST_ENTRIES[host].name.en,
          // A host may echo what it was sent: the key never reaches the screen.
          message: redactMessage(
            error instanceof JevRequestError ? error.message : refused.message,
            [apiKey],
          ),
        },
      });
    }
  }

  return {
    list,

    /** The service a host sends Document text to; null while it can't be worked out (no account yet). */
    service: savedService,

    /** The hosts that can take requests now, best first as the catalog orders them. */
    async ready(): Promise<DecisionHost[]> {
      const keys = await Promise.all(DECISION_HOSTS.map(keyOf));
      return DECISION_HOSTS.filter((host, at) => isReady(host, keys[at] ?? null));
    },

    /**
     * Keeps a host's own key and the account it asks for, once the host accepts them; a key of a
     * chat provider's is kept there, so only the account is. Throws `InvalidInputError` when the
     * host refuses the key or the account isn't one, and `LocalModeError` in Local mode, where
     * nothing goes to a cloud service; nothing is kept then.
     */
    async setKey(input: unknown): Promise<DecisionHostStatus[]> {
      if (!isRecord(input) || !isDecisionHost(input.host)) {
        throw new InvalidInputError({ key: "error.decision.unknownHost" });
      }
      const host = input.host;
      const entry = DECISION_HOST_ENTRIES[host];
      const given: Partial<SetDecisionKeyInput> = input;
      const apiKey = entry.key === "own" ? parseApiKey(given.apiKey) : undefined;
      const account = typeof given.account === "string" ? given.account.trim() : accountOf(host);
      if (entry.account && (!account || !validAccount(host, account))) {
        throw new InvalidInputError({
          key:
            entry.account === "cloudflare-account"
              ? "error.decision.cloudflareAccount"
              : "error.decision.alibabaWorkspace",
        });
      }
      if (options.localOnly()) throw new LocalModeError();
      const current = await keyOf(host);
      const key = apiKey ?? current?.apiKey;
      if (!key) {
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: entry.name.en },
        });
      }
      const address = { account, region: current?.region ?? null };
      await check(host, key, address);
      if (apiKey !== undefined) await secrets.set(keyName(host), apiKey);
      if (entry.account) writeAccount(host, address);
      return list();
    },

    /** Forgets what a host keeps on this device: its own key and its account. */
    async removeKey(host: unknown): Promise<DecisionHostStatus[]> {
      if (!isDecisionHost(host)) {
        throw new InvalidInputError({ key: "error.decision.unknownHost" });
      }
      if (DECISION_HOST_ENTRIES[host].account) writeAccount(host, null);
      await secrets.delete(keyName(host));
      return list();
    },

    /** Whether a host can take a tagging request now: ready, its flow allowed. */
    async canRun(host: DecisionHost): Promise<boolean> {
      if (!isReady(host, await keyOf(host))) return false;
      const service = savedService(host);
      return service !== null && consent.status("tagging", service) === "accepted";
    },

    /** A quick check, with nothing to wait for: false when the host certainly can't tag. */
    mightBeReady(host: DecisionHost): boolean {
      const service = savedService(host);
      return service !== null && consent.status("tagging", service) === "accepted";
    },

    /**
     * A model on a host as the tagger, once the User has accepted the tagging flow to it. Throws
     * TaggingNotReadyError, ConsentDeclinedError or ConsentNeededError; nothing is sent then.
     */
    async prepare(host: DecisionHost, modelId: string): Promise<TagClassifier> {
      const { apiKey, endpoint, service } = await connection(host, modelId);
      await consent.ensure("tagging", service);
      const band = reviewBandFor(modelId);
      return {
        local: false,
        async decide({ tags, excerpt, signal: stop }) {
          const probabilities = await askJev({
            beforeSend: () => gate.check("tagging", service),
            baseUrl: endpoint.url,
            endpoint,
            apiKey,
            model: modelId,
            state: jevState(excerpt),
            questions: tagQuestions(tags, endpoint.bothCriteria === true),
            signal: AbortSignal.any([stop, signal]),
            retries: TAGGING_RETRIES,
            timeoutMs: TAGGING_TIMEOUT_MS,
          });
          return { decisions: decisionsFromProbabilities(tags, probabilities, band), newTags: [] };
        },
      };
    },

    /** A model on a host for Organize, with the Library's own consent or a run's permit. */
    async prepareGroups(host: DecisionHost, modelId: string, permit?: CloudReadPermit) {
      const { apiKey, endpoint, service } = await connection(host, modelId);
      const permitted = permit?.flow === "classification" && permit.serviceId === service.id;
      if (!permitted) await consent.ensure("classification", service);
      return decisionGroupClassifier({
        beforeSend: () => {
          // A run's permit stands for the consent, never for Local mode turned on meanwhile.
          if (!permitted) gate.check("classification", service);
          else if (options.localOnly()) throw new LocalModeError();
        },
        baseUrl: endpoint.url,
        endpoint,
        apiKey,
        model: modelId,
        local: false,
        usePageImages: false,
      });
    },
  };
}
