import type { Logger, RoomSpeakerReviewer } from "../adapters";
import type {
  CoreApi,
  Document,
  Meeting,
  MeetingSpeakerReviewQuote,
  MeetingSpeakerReviewResult,
} from "../api";
import { hashBytes } from "../documents/files";
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
import { roomReviewLines, roomReviewSuggestions } from "./roomReviewSuggestions";

const USD_PER_HOUR = 0.1;
const MAX_MS = 300 * 60_000;
const LEDGER = "meeting.speakerReviewCleanup";
// Soniox automatically deletes async files and transcripts after 30 days. Allow time for a job to finish.
const RECEIPT_TTL_MS = 31 * 24 * 60 * 60_000;
const FIRST_RETRY_MS = 60_000;
const LONGEST_RETRY_MS = 60 * 60_000;
type Grant = NonNullable<Awaited<ReturnType<CloudTranscription["speakerReviewGrant"]>>>;
type ReviewInput = Parameters<CoreApi["reviewMeetingSpeakers"]>[0];
type Reason = MeetingSpeakerReviewQuote["reason"];

function unavailable(reason: Reason) {
  const key = {
    platform: "error.meeting.roomReviewPlatform",
    people: "error.meeting.roomReviewPeople",
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
  heardCallAudio(id: string): boolean;
  recording(
    parts: AudioPart[],
    durationMs: number,
    signal: AbortSignal,
    source?: AudioPart["source"],
  ): Promise<Blob>;
  roomReviewer?: RoomSpeakerReviewer;
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
    {
      onDevice: boolean;
      selfMatch?: ReviewInput["selfMatch"];
      stop: AbortController;
      promise: Promise<MeetingSpeakerReviewResult>;
      valid?: () => boolean;
    }
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
  let retryDelay = FIRST_RETRY_MS;

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

  function inspect(id: unknown, requested?: AudioPart["source"]) {
    const meeting = options.meeting(id);
    const reason = local(meeting);
    const doc = meeting.transcript?.documentId
      ? options.document(meeting.transcript.documentId)
      : undefined;
    const kept =
      reason || !doc ? [] : options.parts(meeting.id).filter((part) => part.durationMs > 0);
    const room = kept.some((p) => p.source === "microphone") && !options.heardCallAudio(meeting.id);
    const source = room ? "microphone" : "system";
    const parts = kept.filter((p) => p.source === source);
    const durationMs = parts.reduce(
      (end, part) => Math.max(end, part.offsetMs + part.durationMs),
      0,
    );
    const problem: Reason =
      reason ??
      (!doc?.contentHash ||
      doc.status !== "ready" ||
      (requested !== undefined && requested !== source)
        ? "transcript"
        : durationMs === 0
          ? "audio"
          : durationMs > MAX_MS
            ? "duration"
            : source === "system" && options.localOnly()
              ? "local"
              : null);
    return {
      doc,
      room,
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
  function writeReceipts(book: Record<string, unknown>) {
    if (Object.keys(book).length) settings.writeDeviceValue(LEDGER, book);
    else settings.deleteDeviceValue(LEDGER);
  }
  const keep = (
    reference: string,
    signature: string,
    expiresAt: number,
    cleanup: SonioxReviewCleanup | null,
  ) => {
    if (lifetime.aborted) return;
    const book = receiptBook();
    if (cleanup) book[reference] = { signature, expiresAt, cleanup };
    else delete book[reference];
    writeReceipts(book);
  };

  function receiptsToClean() {
    const book = receiptBook();
    const now = Date.parse(options.now());
    let changed = false;
    const receipts = [];
    for (const [id, entry] of Object.entries(book)) {
      if (activeReceipts.has(id)) continue;
      if (
        !isRecord(entry) ||
        typeof entry.signature !== "string" ||
        !isRecord(entry.cleanup) ||
        entry.cleanup.referenceId !== id ||
        (typeof entry.expiresAt === "number" && entry.expiresAt <= now)
      ) {
        delete book[id];
        changed = true;
        continue;
      }
      const expiresAt =
        typeof entry.expiresAt === "number" && Number.isFinite(entry.expiresAt)
          ? entry.expiresAt
          : now + RECEIPT_TTL_MS;
      if (expiresAt !== entry.expiresAt) {
        book[id] = { ...entry, expiresAt };
        changed = true;
      }
      const resource = (part: unknown) =>
        typeof part === "string" || part === true ? part : undefined;
      const file = resource(entry.cleanup.file);
      const transcription = resource(entry.cleanup.transcription);
      const cleanup: SonioxReviewCleanup = {
        referenceId: id,
        ...(file && { file }),
        ...(transcription && { transcription }),
      };
      receipts.push({ id, signature: entry.signature, expiresAt, cleanup });
    }
    if (changed) writeReceipts(book);
    return receipts;
  }

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
      const receipts = receiptsToClean();
      if (!receipts.length) return;
      const grant = await cloud.speakerReviewGrant();
      if (!grant || lifetime.aborted) return;
      for (const { id, signature, expiresAt, cleanup } of receipts) {
        if (signature !== grant.signature) continue;
        const left = await cleanupSonioxReview({
          apiKey: grant.apiKey,
          fetch: gatedFetch(grant),
          cleanup,
          signal: lifetime,
        });
        keep(id, signature, expiresAt, left);
      }
    } catch {
      if (!lifetime.aborted) {
        options.log.warn("meeting.reviewCleanupWaiting", {});
      }
    } finally {
      recovering = false;
      if (!lifetime.aborted && Object.keys(receiptBook()).length) schedule();
      else retryDelay = FIRST_RETRY_MS;
    }
  }
  function schedule() {
    if (retry || lifetime.aborted) return;
    retry = setTimeout(() => {
      retry = undefined;
      void recover();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, LONGEST_RETRY_MS);
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
  async function prepare(id: string, state = inspect(id, "system")) {
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

  const revision = (version: string) => hashBytes(new TextEncoder().encode(version));

  async function checkRoom(id: string, stop: AbortController, selfMatch: ReviewInput["selfMatch"]) {
    const reviewer = options.roomReviewer;
    const { doc, room, parts, durationMs, problem } = inspect(id, "microphone");
    if (!room || !doc || problem) throw unavailable(problem ?? "audio");
    if (!reviewer) throw unavailable("platform");
    const version = snapshot(doc);
    const valid = () => {
      const current = inspect(id, "microphone");
      return current.room && !current.problem && !!current.doc && version === snapshot(current.doc);
    };
    const active = running.get(id);
    if (active) active.valid = valid;
    const cues = await options.cues(doc);
    const lines = roomReviewLines(cues, doc.speakers);
    if (lines.reason || !valid()) throw unavailable(lines.reason ?? "transcript");
    if (lines.selfLabels || selfMatch) {
      if (
        !selfMatch ||
        !lines.selfLabels?.includes(selfMatch.label) ||
        selfMatch.revision !== revision(version)
      )
        throw unavailable("transcript");
    }
    const audio = await options.recording(parts, durationMs, stop.signal, "microphone");
    stop.signal.throwIfAborted();
    if (!valid()) throw unavailable("transcript");
    const turns = await reviewer.separate(id, audio, stop.signal).catch((error: unknown) => {
      stop.signal.throwIfAborted();
      options.log.warn("meeting.roomSpeakerReview", {
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw new InvalidInputError({ key: "error.meeting.roomReviewFailed" });
    });
    stop.signal.throwIfAborted();
    if (!valid()) throw unavailable("transcript");
    const suggestions = roomReviewSuggestions(lines, doc.speakers, turns, selfMatch?.label);
    return {
      source: "microphone" as const,
      reviewedSpeakers: doc.speakers,
      documentId: doc.id,
      contentHash: doc.contentHash,
      suggestions: suggestions ?? [],
      ...(suggestions === null && { uncertainSpeakers: true as const }),
    };
  }

  async function run(id: string, stop: AbortController, reuseOnly: boolean) {
    const { signal } = stop;
    const { doc, parts, durationMs, grant, budget, cached, reason } = await prepare(id);
    signal.throwIfAborted();
    if (reason || !grant || !doc) throw unavailable(reason);
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
    if (cached || reuseOnly) {
      if (cached && valid()) return cached;
      throw unavailable("transcript");
    }
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
    const expiresAt = Date.parse(options.now()) + RECEIPT_TTL_MS;
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
          if (reference) keep(reference, grant.signature, expiresAt, cleanup);
        },
        onSubmission: (state) => {
          if (lifetime.aborted) return;
          if (state === "dispatched" && !grant.valid()) return;
          submitted = state === "dispatched";
          settle(submitted);
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
      const state = inspect(id);
      if (state.room) {
        const doc = state.doc;
        const lines =
          !state.problem && options.roomReviewer && doc
            ? roomReviewLines(await options.cues(doc), doc.speakers)
            : undefined;
        const reason =
          state.problem ??
          (!options.roomReviewer ? "platform" : !lines ? "transcript" : lines.reason);
        return {
          available: !reason,
          ...(!reason &&
            lines?.selfLabels &&
            doc && {
              selfMatch: { labels: lines.selfLabels, revision: revision(snapshot(doc)) },
            }),
          reason,
          estimatedUsd: 0,
          durationMs: state.durationMs,
          ...(options.roomReviewer && { roomDownloadBytes: options.roomReviewer.downloadBytes() }),
        };
      }
      const { reason, durationMs, estimatedUsd, cached } = await prepare(id, state);
      return {
        available: reason === null,
        reason,
        durationMs,
        estimatedUsd: cached ? 0 : estimatedUsd,
        ...(cached && { cached: true }),
      };
    },
    review(input: ReviewInput) {
      if (!isRecord(input) || input.confirmed !== true)
        throw new InvalidInputError({ key: "error.meeting.reviewConsent" });
      const { id } = options.meeting(input.meetingId);
      const current = running.get(id);
      const onDevice = input.onDevice === true;
      const selfMatch = input.selfMatch;
      if (
        (selfMatch !== undefined &&
          (!onDevice ||
            !isRecord(selfMatch) ||
            typeof selfMatch.label !== "string" ||
            typeof selfMatch.revision !== "string")) ||
        (current &&
          (current.selfMatch?.label !== selfMatch?.label ||
            current.selfMatch?.revision !== selfMatch?.revision)) ||
        (input.onDevice !== undefined && !onDevice) ||
        (onDevice && input.reuseOnly) ||
        (current && current.onDevice !== onDevice)
      )
        throw unavailable("transcript");
      if (current) return current.promise;
      const stop = new AbortController();
      const work = Promise.resolve().then(() => {
        stop.signal.throwIfAborted();
        return onDevice ? checkRoom(id, stop, selfMatch) : run(id, stop, input.reuseOnly === true);
      });
      const promise = work
        .catch((error: unknown) => {
          if (stop.signal.aborted && error === stop.signal.reason)
            throw new InvalidInputError({ key: "error.meeting.reviewCancelled" });
          throw error;
        })
        .finally(() => running.delete(id));
      running.set(id, { onDevice, selfMatch, stop, promise });
      return promise;
    },
    async cancel(id: string) {
      const pending = running.get(id);
      if (!pending) return;
      pending.stop.abort();
      try {
        await pending.promise;
      } catch (error) {
        if (
          !(
            error instanceof InvalidInputError &&
            error.wording?.key === "error.meeting.reviewCancelled"
          )
        )
          throw error;
      }
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
