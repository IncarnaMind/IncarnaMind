/**
 * Automatic tagging with TypeSafe Jev (spec #20, "Tagging"; ADR-0005). When
 * Jev is set up on this device, it decides each Tag for each Document with
 * the probability that the Tag applies, instead of the chat model:
 * - below the review band, the Tag isn't applied;
 * - in the band, it is applied and marked "needs review";
 * - above it, it is applied.
 *
 * Jev's settings are per device, like its key (in the keychain, never in
 * SQLite). Its requests are the "tagging" data flow, to Jev's service:
 * nothing is sent before the User accepts it. A server on this computer
 * needs no consent.
 */
import {
  type ConnectionTestResult,
  type ExternalService,
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_REVIEW_BAND,
  type JevReviewBand,
  type JevSettings,
} from "../api";
import type { Consent } from "../consent";
import { InvalidInputError, isRecord, TaggingNotReadyError } from "../errors";
import { decisionGroupClassifier, reviewBandFor } from "../library/classifier";
import { parseApiKey } from "../providers/apiKey";
import {
  askJev,
  JEV_HOSTED_URL,
  JEV_PATH,
  JEV_SERVICE,
  type JevNoulQuestion,
} from "../providers/jev";
import { normalizeBaseUrl, serviceForUrl } from "../providers/kinds";
import { classifyProviderError } from "../providers/providerErrors";
import type { Secrets } from "../secrets";
import { createSendGate } from "../sendGate";
import type { SettingsStore } from "../settings";
import {
  type DocumentExcerpt,
  documentType,
  excerptFromPassages,
  oneLine,
  type TagClassifier,
  type TagDecision,
  type TagDefinition,
} from "./classify";

const KEY_NAME = "jev:api-key";
/** A per-device value, outside `DeviceSettings`: only these methods change it. */
const SETTINGS_KEY = "jev";

/** One Document per request; a few tries more when Jev is busy or out of reach. */
const TAGGING_RETRIES = 2;
const TAGGING_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;

/** What is stored: null fields mean the defaults. */
interface StoredJev {
  endpoint: string | null;
  model: string | null;
  reviewBand: JevReviewBand;
}

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function isReviewBand(value: unknown): value is JevReviewBand {
  return (
    isRecord(value) &&
    isProbability(value.low) &&
    isProbability(value.high) &&
    value.low > 0 &&
    value.low <= value.high
  );
}

function parseStored(value: unknown): StoredJev | null {
  if (!isRecord(value)) return null;
  const { endpoint, model, reviewBand } = value;
  return {
    endpoint: typeof endpoint === "string" ? endpoint : null,
    model: typeof model === "string" ? model : null,
    reviewBand: isReviewBand(reviewBand) ? reviewBand : { ...JEV_DEFAULT_REVIEW_BAND },
  };
}

/** A base URL, without a trailing `/v1/systemone` if the whole endpoint was pasted; null for TypeSafe's. */
function parseEndpoint(value: unknown): string | null {
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string") throw new InvalidInputError("The server URL must be text.");
  let url = normalizeBaseUrl(value);
  if (url.endsWith(JEV_PATH)) url = url.slice(0, -JEV_PATH.length);
  return url === JEV_HOSTED_URL ? null : url;
}

function parseModel(value: unknown): string | null {
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string" || value.length > 200) {
    throw new InvalidInputError({ key: "error.provider.modelMissing" });
  }
  return value.trim();
}

function parseReviewBand(value: unknown): JevReviewBand {
  if (!isReviewBand(value)) {
    throw new InvalidInputError(
      "The review band runs from a probability above 0 to one no higher than 1, the lower first.",
    );
  }
  return { low: value.low, high: value.high };
}

/** One yes/no question per Tag, keyed by the Tag's id (Jev doesn't see the keys). */
function tagQuestions(tags: readonly TagDefinition[]): Record<string, JevNoulQuestion> {
  return Object.fromEntries(
    tags.map((tag) => {
      const question: JevNoulQuestion = {
        type: "noul",
        instructions: `Does the Tag “${oneLine(tag.name)}” fit this Document as a whole?`,
      };
      // What a yes means: the Tag's own description.
      if (tag.description) question.criteria = { true: oneLine(tag.description) };
      return [tag.id, question];
    }),
  );
}

/** What Jev reads: the Document's name and type, and the beginning of its text. */
const jevState = (excerpt: DocumentExcerpt) => ({
  name: excerpt.name,
  type: documentType(excerpt),
  excerpt: excerpt.text,
});

/** The Tags that apply, given each one's probability and the review band. */
export function decisionsFromProbabilities(
  tags: readonly TagDefinition[],
  probabilities: Readonly<Record<string, number>>,
  band: JevReviewBand,
): TagDecision[] {
  return tags.flatMap((tag) => {
    const probability = probabilities[tag.id];
    if (probability === undefined || probability < band.low) return [];
    return [{ tagId: tag.id, confidence: probability, needsReview: probability < band.high }];
  });
}

/** How much of the excerpt Tev1 gets, in tokens, as Organize gives it (see ../library/classifier). */
const TEV_EXCERPT_TOKENS = 1_000;

/**
 * A local decision model in Ollama as the tagger, while there are no Folders:
 * each Tag a yes or no with its probability, through Ollama's
 * Jev-style endpoint, as Organize asks it (see ../library/classifier). It
 * runs on this computer, so it needs no consent and gives way to Answers.
 */
export function decisionModelTagger(connection: { baseUrl: string; model: string }): TagClassifier {
  return {
    local: true,
    async decide({ tags, excerpt, signal }) {
      // Tev1 reads about 2K tokens, questions included, whatever its window says.
      const text = /^tev1(?::|$)/i.test(connection.model)
        ? excerptFromPassages([excerpt.text], TEV_EXCERPT_TOKENS)
        : excerpt.text;
      const probabilities = await askJev({
        baseUrl: connection.baseUrl,
        apiKey: "ollama",
        model: connection.model,
        state: jevState({ ...excerpt, text }),
        questions: tagQuestions(tags),
        signal,
        retries: 0,
        timeoutMs: TAGGING_TIMEOUT_MS,
      });
      return {
        decisions: decisionsFromProbabilities(tags, probabilities, reviewBandFor(connection.model)),
        newTags: [],
      };
    },
  };
}

export function createJevTagging(options: {
  settings: SettingsStore;
  secrets: Secrets;
  consent: Consent;
  /** Where requests to TypeSafe's hosted Jev go (tests use a local fake). */
  hostedUrl?: string;
  /** Aborts requests when the core closes. */
  signal: AbortSignal;
  localOnly(): boolean;
}) {
  const { settings, secrets, consent, signal } = options;
  const gate = createSendGate(consent, options.localOnly);
  const hostedUrl = options.hostedUrl ?? JEV_HOSTED_URL;

  const stored = () => parseStored(settings.readDeviceValue(SETTINGS_KEY));
  const serviceOf = (endpoint: string | null): ExternalService | null =>
    endpoint === null ? JEV_SERVICE : serviceForUrl(endpoint);
  const baseUrlOf = (endpoint: string | null) => endpoint ?? hostedUrl;

  const status = async (): Promise<JevSettings> => {
    const jev = stored();
    return {
      enabled: jev !== null,
      hasApiKey: jev !== null && (await secrets.tryGet(KEY_NAME)) !== null,
      endpoint: jev?.endpoint ?? null,
      model: jev?.model ?? JEV_DEFAULT_MODEL,
      reviewBand: jev?.reviewBand ?? { ...JEV_DEFAULT_REVIEW_BAND },
      service: serviceOf(jev?.endpoint ?? null),
    };
  };

  /**
   * A quick check, with nothing to wait for: false when Jev certainly can't
   * tag (it isn't set up, or the User hasn't allowed the tagging flow to it:
   * tagging is background work, which never asks).
   */
  const mightBeReady = (): boolean => {
    const jev = stored();
    if (!jev) return false;
    const service = serviceOf(jev.endpoint);
    return !service || consent.status("tagging", service) === "accepted";
  };

  return {
    status,

    /** Whether Jev is set up here: then it, not the chat model, tags Documents. */
    enabled: () => stored() !== null,

    /** The service tagging requests go to while Jev is set up, or null for a local server. */
    service(): ExternalService | null {
      const jev = stored();
      return jev ? serviceOf(jev.endpoint) : null;
    },

    /**
     * Sets Jev up, or changes it: choosing it allows the tagging flow to it
     * (ADR-0022). The key is stored first: if the keychain refuses it, nothing changes.
     */
    async save(input: unknown): Promise<JevSettings> {
      if (!isRecord(input)) throw new InvalidInputError("saveJevSettings expects an object.");
      for (const key of Object.keys(input)) {
        if (!["apiKey", "endpoint", "model", "reviewBand"].includes(key)) {
          throw new InvalidInputError(`Jev has no setting "${key}".`);
        }
      }
      const saved = stored();
      const apiKey = parseApiKey(input.apiKey);
      const next: StoredJev = {
        endpoint:
          input.endpoint === undefined ? (saved?.endpoint ?? null) : parseEndpoint(input.endpoint),
        model: input.model === undefined ? (saved?.model ?? null) : parseModel(input.model),
        reviewBand:
          input.reviewBand === undefined
            ? (saved?.reviewBand ?? { ...JEV_DEFAULT_REVIEW_BAND })
            : parseReviewBand(input.reviewBand),
      };
      if (apiKey === undefined && (saved === null || (await secrets.tryGet(KEY_NAME)) === null)) {
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: "Jev" },
        });
      }
      if (apiKey !== undefined) await secrets.set(KEY_NAME, apiKey);
      settings.writeDeviceValue(SETTINGS_KEY, next);
      const service = serviceOf(next.endpoint);
      if (service) consent.choose(["tagging"], service);
      return status();
    },

    /** Forgets Jev on this device: its settings, then its key. */
    async remove(): Promise<JevSettings> {
      settings.writeDeviceValue(SETTINGS_KEY, null);
      await secrets.delete(KEY_NAME);
      return status();
    },

    mightBeReady,

    /** Whether Jev can take a tagging request now: set up, its key readable, its flow allowed. */
    async canRun(): Promise<boolean> {
      return mightBeReady() && (await secrets.tryGet(KEY_NAME)) !== null;
    },

    /**
     * Jev as the tagger, once the User has accepted the tagging flow to its
     * service. Throws TaggingNotReadyError, ConsentDeclinedError or
     * ConsentNeededError; nothing is sent then.
     */
    async prepare(): Promise<TagClassifier> {
      const jev = stored();
      if (!jev) throw new TaggingNotReadyError({ key: "error.tagging.jevNotSetUp" });
      const apiKey = await secrets.tryGet(KEY_NAME);
      if (!apiKey) throw new TaggingNotReadyError({ key: "error.tagging.jevKeyUnreadable" });
      const service = serviceOf(jev.endpoint);
      if (service) await consent.ensure("tagging", service);
      return {
        // No service to send to: a Jev-compatible server on this computer.
        local: service === null,
        async decide({ tags, excerpt, signal: stop }) {
          const probabilities = await askJev({
            ...(service && { beforeSend: () => gate.check("tagging", service) }),
            baseUrl: baseUrlOf(jev.endpoint),
            apiKey,
            model: jev.model ?? JEV_DEFAULT_MODEL,
            state: jevState(excerpt),
            questions: tagQuestions(tags),
            signal: AbortSignal.any([stop, signal]),
            retries: TAGGING_RETRIES,
            timeoutMs: TAGGING_TIMEOUT_MS,
          });
          return {
            decisions: decisionsFromProbabilities(tags, probabilities, jev.reviewBand),
            newTags: [],
          };
        },
      };
    },

    /** Reuses the saved connection with the Library's separate consent. */
    async prepareGroups() {
      const jev = stored();
      if (!jev) throw new TaggingNotReadyError({ key: "error.tagging.jevNotSetUp" });
      const apiKey = await secrets.tryGet(KEY_NAME);
      if (!apiKey) throw new TaggingNotReadyError({ key: "error.tagging.jevKeyUnreadable" });
      const service = serviceOf(jev.endpoint);
      if (service) await consent.ensure("classification", service);
      return decisionGroupClassifier({
        ...(service && { beforeSend: () => gate.check("classification", service) }),
        baseUrl: baseUrlOf(jev.endpoint),
        apiKey,
        model: jev.model ?? JEV_DEFAULT_MODEL,
        local: service === null,
        // Page images are an explicit Library Ollama setting, not part of the Jev connection.
        usePageImages: false,
        reviewBand: jev.reviewBand,
      });
    },

    /**
     * Asks Jev one question about a fixed text, with the given settings or
     * the saved ones. It sends the key and that text, nothing of the User's,
     * so it needs no consent.
     */
    async test(input: unknown): Promise<ConnectionTestResult> {
      if (input !== undefined && !isRecord(input)) {
        throw new InvalidInputError("testJevConnection expects an object.");
      }
      const saved = stored();
      const endpoint =
        input?.endpoint === undefined ? (saved?.endpoint ?? null) : parseEndpoint(input.endpoint);
      const model = input?.model === undefined ? (saved?.model ?? null) : parseModel(input.model);
      const apiKey = parseApiKey(input?.apiKey) ?? (saved ? await secrets.tryGet(KEY_NAME) : null);
      if (!apiKey)
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: "Jev" },
        });
      try {
        await askJev({
          baseUrl: baseUrlOf(endpoint),
          apiKey,
          model: model ?? JEV_DEFAULT_MODEL,
          state: "IncarnaMind is checking that it can reach this server.",
          questions: {
            connection_check: { type: "noul", instructions: "Is this text a connection check?" },
          },
          signal,
          retries: 0,
          timeoutMs: TEST_TIMEOUT_MS,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: classifyProviderError(error) };
      }
    },
  };
}
