import type { Logger } from "../adapters";
import type {
  Document,
  Meeting,
  MeetingSpeakerReviewQuote,
  MeetingSpeakerReviewResult,
} from "../api";
import type { Cue } from "../documents/formats/vtt";
import { InvalidInputError, isRecord } from "../errors";
import type { SettingsStore } from "../settings";
import type { CloudTranscription } from "../transcription/cloud/routes";
import {
  cleanupSonioxReview,
  reviewSonioxAudio,
  type SonioxReviewCleanup,
  SonioxReviewCleanupError,
} from "../transcription/cloud/sonioxReview";
import type { AudioPart } from "./audioFiles";
import { reviewSuggestions } from "./reviewSuggestions";

const USD_PER_HOUR = 0.1;
const MAX_MS = 300 * 60_000;
const LEDGER = "meeting.speakerReviewCleanup";
type Grant = NonNullable<Awaited<ReturnType<CloudTranscription["speakerReviewGrant"]>>>;
type Reason = MeetingSpeakerReviewQuote["reason"];

function unavailable(reason: Reason) {
  const key = {
    audio: "error.meeting.audioGone",
    cap: "error.meeting.reviewCap",
    transcript: "error.meeting.reviewChanged",
    local: "error.transcription.localMode",
    duration: "error.meeting.reviewDuration",
    soniox: "error.meeting.reviewService",
  } as const;
  return new InvalidInputError({ key: reason ? key[reason] : "error.meeting.reviewChanged" });
}

export function createMeetingSpeakerReview(options: {
  parts(id: string): AudioPart[];
  recording(parts: AudioPart[], durationMs: number, signal: AbortSignal): Promise<Blob>;
  now(): string;
  meeting(id: unknown): Meeting;
  document(id: string): Document | undefined;
  cues(doc: Document): Promise<Cue[]>;
  localOnly(): boolean;
  cloud: Pick<CloudTranscription, "speakerReviewGrant" | "reviewBudget">;
  settings: Pick<SettingsStore, "readDeviceValue" | "writeDeviceValue" | "deleteDeviceValue">;
  request: typeof fetch;
  lifetime: AbortSignal;
  log: Logger;
}) {
  const { settings, cloud, lifetime } = options;
  const running = new Map<
    string,
    { stop: AbortController; promise: Promise<MeetingSpeakerReviewResult>; valid?: () => boolean }
  >();
  const activeReceipts = new Set<string>();
  let cache: {
    id: string;
    signature: string;
    snapshot: string;
    result: MeetingSpeakerReviewResult;
  } | null = null;
  let recovering = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function local(meeting: Meeting): Reason {
    if (
      meeting.kind !== "meeting" ||
      meeting.status !== "stopped" ||
      meeting.transcript?.state !== "saved" ||
      meeting.transcript.separating ||
      !meeting.transcript.documentId
    )
      return "transcript";
    if (
      !meeting.audio.kept ||
      (meeting.audio.expiresAt && meeting.audio.expiresAt <= options.now())
    )
      return "audio";
    return null;
  }

  function inspect(id: unknown) {
    const meeting = options.meeting(id);
    const reason = local(meeting);
    const doc = meeting.transcript?.documentId
      ? options.document(meeting.transcript.documentId)
      : undefined;
    const parts =
      reason || !doc
        ? []
        : options
            .parts(meeting.id)
            .filter((part) => part.source === "system" && part.durationMs > 0);
    const durationMs = parts.reduce(
      (end, part) => Math.max(end, part.offsetMs + part.durationMs),
      0,
    );
    const problem: Reason =
      reason ??
      (!doc?.contentHash || doc.status !== "ready"
        ? "transcript"
        : durationMs === 0
          ? "audio"
          : durationMs > MAX_MS
            ? "duration"
            : options.localOnly()
              ? "local"
              : null);
    return {
      doc,
      parts,
      durationMs,
      problem,
      estimatedUsd: (durationMs * USD_PER_HOUR) / 3_600_000,
    };
  }

  const receiptBook = () => {
    const raw = settings.readDeviceValue(LEDGER);
    return isRecord(raw) ? raw : {};
  };
  const keep = (reference: string, signature: string, cleanup: SonioxReviewCleanup | null) => {
    if (lifetime.aborted) return;
    const book = receiptBook();
    if (cleanup) book[reference] = { signature, cleanup };
    else delete book[reference];
    if (Object.keys(book).length) settings.writeDeviceValue(LEDGER, book);
    else settings.deleteDeviceValue(LEDGER);
  };

  const gatedFetch =
    (grant: Grant): typeof fetch =>
    (url, init) => {
      if (lifetime.aborted || !grant.valid())
        throw unavailable(options.localOnly() ? "local" : "soniox");
      return options.request(url, init);
    };

  async function recover() {
    if (recovering || lifetime.aborted || !Object.keys(receiptBook()).length) return;
    recovering = true;
    try {
      const grant = await cloud.speakerReviewGrant();
      if (!grant || lifetime.aborted) return;
      for (const [id, entry] of Object.entries(receiptBook())) {
        if (
          activeReceipts.has(id) ||
          !isRecord(entry) ||
          entry.signature !== grant.signature ||
          !isRecord(entry.cleanup) ||
          entry.cleanup.referenceId !== id
        )
          continue;
        const resource = (part: unknown) =>
          typeof part === "string" || part === true ? part : undefined;
        const file = resource(entry.cleanup.file);
        const transcription = resource(entry.cleanup.transcription);
        const cleanup: SonioxReviewCleanup = {
          referenceId: id,
          ...(file && { file }),
          ...(transcription && { transcription }),
        };
        const left = await cleanupSonioxReview({
          apiKey: grant.apiKey,
          fetch: gatedFetch(grant),
          cleanup,
          signal: lifetime,
        });
        keep(id, grant.signature, left);
        if (left) schedule();
      }
    } catch {
      if (!lifetime.aborted) {
        options.log.warn("meeting.reviewCleanupWaiting", {});
        schedule();
      }
    } finally {
      recovering = false;
    }
  }
  function schedule() {
    if (retry || lifetime.aborted) return;
    retry = setTimeout(() => {
      retry = undefined;
      void recover();
    }, 60_000);
    retry.unref();
  }
  lifetime.addEventListener(
    "abort",
    () => {
      clearTimeout(retry);
      for (const work of running.values()) work.stop.abort();
      cache = null;
    },
    { once: true },
  );
  if (Object.keys(receiptBook()).length) schedule();

  const snapshot = (doc: Document) => JSON.stringify([doc.id, doc.contentHash, doc.speakers]);
  async function prepare(id: string) {
    const state = inspect(id);
    const grant = state.problem ? null : await cloud.speakerReviewGrant();
    const budget = cloud.reviewBudget(state.estimatedUsd);
    const cached =
      grant &&
      cache?.id === id &&
      cache.signature === grant.signature &&
      state.doc &&
      cache.snapshot === snapshot(state.doc)
        ? cache.result
        : null;
    const reason: Reason =
      state.problem ?? (!grant ? "soniox" : !cached && !budget.allowed() ? "cap" : null);
    return { ...state, grant, budget, cached, reason };
  }

  async function run(id: string, stop: AbortController) {
    const { signal } = stop;
    const { doc, parts, durationMs, grant, budget, cached, reason } = await prepare(id);
    signal.throwIfAborted();
    if (reason || !grant || !doc) throw unavailable(reason);
    if (cached) return cached;
    const version = snapshot(doc);
    const valid = () => {
      if (!grant.valid()) return false;
      const live = options.meeting(id);
      const current = options.document(doc.id);
      return (
        !local(live) &&
        live.transcript?.documentId === doc.id &&
        !!current &&
        version === snapshot(current)
      );
    };
    const entry = running.get(id);
    if (entry) entry.valid = valid;
    const cues = await options.cues(doc);
    const audio = await options.recording(parts, durationMs, signal);
    signal.throwIfAborted();
    if (!valid()) throw unavailable("transcript");
    const settle = budget.reserve();
    if (!settle) throw unavailable("cap");
    let reference = "";
    let submitted = false;
    try {
      const tokens = await reviewSonioxAudio({
        apiKey: grant.apiKey,
        audio,
        signal,
        fetch: gatedFetch(grant),
        saveCleanup: (cleanup) => {
          if (cleanup) {
            reference = cleanup.referenceId;
            activeReceipts.add(reference);
          }
          if (reference) keep(reference, grant.signature, cleanup);
        },
        onSubmitted: () => {
          submitted = true;
          if (!lifetime.aborted) settle(true);
        },
      });
      signal.throwIfAborted();
      if (!valid()) throw unavailable("transcript");
      const result = {
        documentId: doc.id,
        contentHash: doc.contentHash,
        suggestions: reviewSuggestions(cues, doc.speakers, tokens),
      };
      cache = { id, signature: grant.signature, snapshot: version, result };
      return result;
    } catch (error) {
      if (error instanceof InvalidInputError) throw error;
      if (signal.aborted) throw new InvalidInputError({ key: "error.meeting.reviewCancelled" });
      throw new InvalidInputError({
        key:
          error instanceof SonioxReviewCleanupError
            ? "error.meeting.reviewCleanup"
            : "error.meeting.reviewFailed",
      });
    } finally {
      if (!lifetime.aborted) {
        if (!submitted) settle(false);
        if (reference && Object.hasOwn(receiptBook(), reference)) schedule();
      }
      activeReceipts.delete(reference);
    }
  }

  return {
    async quote(id: string): Promise<MeetingSpeakerReviewQuote> {
      const { reason, durationMs, estimatedUsd } = await prepare(id);
      return { available: reason === null, reason, durationMs, estimatedUsd };
    },
    review(input: { meetingId: string; confirmed: true }) {
      if (!isRecord(input) || input.confirmed !== true)
        throw new InvalidInputError({ key: "error.meeting.reviewConsent" });
      const { id } = options.meeting(input.meetingId);
      const current = running.get(id);
      if (current) return current.promise;
      const stop = new AbortController();
      const promise = run(id, stop).finally(() => running.delete(id));
      running.set(id, { stop, promise });
      return promise;
    },
    cancel(id: string) {
      running.get(id)?.stop.abort();
    },
    changed() {
      for (const work of running.values()) {
        try {
          if (work.valid && !work.valid()) work.stop.abort();
        } catch {
          work.stop.abort();
        }
      }
      if (cache) {
        try {
          if (local(options.meeting(cache.id))) cache = null;
        } catch {
          cache = null;
        }
      }
    },
    recover,
  };
}
