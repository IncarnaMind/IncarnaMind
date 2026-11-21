import type { MeetingSummaryCandidate, MeetingSummaryItem, MeetingSummarySource } from "../api";
import { InvalidInputError, TranslatableError } from "../errors";
import type { MeetingCandidateReviewInput } from "./candidateReview";

export interface CandidateReviewScope {
  meetingId: string;
  mindId: string;
  documentId: string;
  contentHash: string;
  route: string;
  wall: string | null;
  items: readonly MeetingSummaryItem[];
}

interface Options {
  current(scope: CandidateReviewScope): boolean;
  input(scope: CandidateReviewScope): Promise<MeetingCandidateReviewInput | null>;
  generate(
    scope: CandidateReviewScope,
    input: MeetingCandidateReviewInput,
    signal: AbortSignal,
  ): Promise<MeetingSummarySource[][]>;
  save(
    scope: CandidateReviewScope,
    sources: MeetingSummarySource[][],
    input: MeetingCandidateReviewInput,
  ): MeetingSummaryCandidate[];
  failed(meetingId: string, error: unknown): void;
}

export function candidateReviewUnavailable() {
  return new InvalidInputError({ key: "error.meeting.summaryCandidateReviewUnavailable" });
}

export function candidateReviewNotReady() {
  return new InvalidInputError({ key: "error.meeting.summaryCandidateReviewNotReady" });
}

export function createCandidateReviews(options: Options) {
  let closed = false;
  const active = new Map<
    string,
    {
      scope: CandidateReviewScope;
      stop: AbortController;
      reply: Promise<MeetingSummaryCandidate[]>;
    }
  >();

  async function complete(scope: CandidateReviewScope, signal: AbortSignal) {
    const current = () => {
      signal.throwIfAborted();
      if (closed || !options.current(scope)) throw candidateReviewUnavailable();
    };
    try {
      current();
      const input = await options.input(scope);
      current();
      if (!input) throw candidateReviewUnavailable();
      const sources = await options.generate(scope, input, signal);
      current();
      const checked = await options.input(scope);
      current();
      if (!checked || JSON.stringify(checked) !== JSON.stringify(input))
        throw candidateReviewUnavailable();
      return options.save(scope, sources, checked);
    } catch (error) {
      if (signal.aborted || closed || !options.current(scope)) throw candidateReviewUnavailable();
      options.failed(scope.meetingId, error);
      if (
        error instanceof TranslatableError &&
        (error.wording?.key === "error.meeting.candidateReviewTooLong" ||
          error.wording?.key === "error.meeting.candidateReviewIncomplete" ||
          error.wording?.key === "error.meeting.summaryCandidateReviewUnavailable")
      )
        throw error;
      throw new TranslatableError({ key: "error.meeting.candidateReviewFailed" });
    }
  }

  return {
    review(scope: CandidateReviewScope): Promise<MeetingSummaryCandidate[]> {
      if (closed) return Promise.reject(candidateReviewUnavailable());
      const { meetingId } = scope;
      const existing = active.get(meetingId);
      if (existing) {
        if (!existing.stop.signal.aborted && options.current(existing.scope)) return existing.reply;
        existing.stop.abort();
      }
      const stop = new AbortController();
      const aborted = Promise.withResolvers<never>();
      const stopReply = () => aborted.reject(candidateReviewUnavailable());
      stop.signal.addEventListener("abort", stopReply, { once: true });
      const work = Promise.resolve().then(() => complete(scope, stop.signal));
      const reply = Promise.race([work, aborted.promise]).finally(() => {
        stop.signal.removeEventListener("abort", stopReply);
        if (active.get(meetingId)?.stop === stop) active.delete(meetingId);
      });
      active.set(meetingId, { scope, stop, reply });
      return reply;
    },

    changed() {
      if (closed) return;
      for (const { scope, stop } of active.values()) {
        if (!stop.signal.aborted && !options.current(scope)) stop.abort();
      }
    },

    close() {
      closed = true;
      for (const { stop } of active.values()) stop.abort();
      active.clear();
    },
  };
}
