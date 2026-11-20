import { create } from "zustand";
import type {
  MeetingSpeakerReviewQuote,
  MeetingSpeakerReviewResult,
  MeetingSpeakerSuggestion,
} from "../../core/api";
import { parseTranscriptSpeakers, withSpeakerChosen } from "../../shared/speakers";
import { core } from "./core";
import { describeError } from "./errors";

type ReviewPhase =
  | { kind: "quoting" }
  | { kind: "quote"; quote: MeetingSpeakerReviewQuote }
  | { kind: "running" }
  | { kind: "cancelling" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown }
  | {
      kind: "result";
      result: MeetingSpeakerReviewResult;
      decisions: Readonly<Record<number, "accepted" | "kept" | "stale" | "failed">>;
      applying: number | null;
    };

interface Review {
  documentId: string;
  owner: string | null;
  phase: ReviewPhase;
}

export const useMeetingSpeakerReview = create<Readonly<Record<string, Review>>>(() => ({}));

const reviewOf = (meetingId: string) => useMeetingSpeakerReview.getState()[meetingId];
const setReview = (meetingId: string, review: Review) =>
  useMeetingSpeakerReview.setState({ [meetingId]: review });

function update(meetingId: string, previous: ReviewPhase, phase: ReviewPhase) {
  const review = reviewOf(meetingId);
  if (review?.phase === previous) setReview(meetingId, { ...review, phase });
}

function failed(error: unknown): ReviewPhase {
  const { wording, reason, call } = describeError(error);
  if (!wording) console.warn("Meeting speaker review failed", { call, reason });
  return { kind: "failed", error };
}

export function openSpeakerReview(meetingId: string, documentId: string, owner: string) {
  const review = reviewOf(meetingId);
  if (
    review?.documentId === documentId &&
    (review.phase.kind !== "quote" || review.owner === owner)
  ) {
    setReview(meetingId, { ...review, owner });
  } else void quoteSpeakerReview(meetingId, documentId, owner);
}

export function hideSpeakerReview(meetingId: string, owner: string) {
  const review = reviewOf(meetingId);
  if (review?.owner === owner) setReview(meetingId, { ...review, owner: null });
}

export async function quoteSpeakerReview(meetingId: string, documentId: string, owner: string) {
  const phase = { kind: "quoting" } as const;
  setReview(meetingId, { documentId, owner, phase });
  try {
    const quote = await core.getMeetingSpeakerReview(meetingId);
    update(meetingId, phase, { kind: "quote", quote });
  } catch (error) {
    update(meetingId, phase, failed(error));
  }
}

export async function runSpeakerReview(meetingId: string, selfLabel?: string) {
  const review = reviewOf(meetingId);
  if (review?.phase.kind !== "quote" || !review.phase.quote.available) return;
  const match = review.phase.quote.selfMatch;
  if (match && (!selfLabel || !match.labels.includes(selfLabel))) return;
  const phase = { kind: "running" } as const;
  setReview(meetingId, { ...review, phase });
  try {
    const result = await core.reviewMeetingSpeakers({
      meetingId,
      confirmed: true,
      ...(match && selfLabel && { selfMatch: { label: selfLabel, revision: match.revision } }),
      ...(review.phase.quote.roomDownloadBytes !== undefined && { onDevice: true as const }),
      ...(review.phase.quote.cached && { reuseOnly: true as const }),
    });
    update(meetingId, phase, { kind: "result", result, decisions: {}, applying: null });
  } catch (error) {
    update(meetingId, phase, failed(error));
  }
}

export async function cancelSpeakerReview(meetingId: string) {
  const review = reviewOf(meetingId);
  if (review?.phase.kind !== "running") return;
  const phase = { kind: "cancelling" } as const;
  setReview(meetingId, { ...review, phase });
  try {
    await core.cancelMeetingSpeakerReview(meetingId);
    update(meetingId, phase, { kind: "cancelled" });
  } catch (error) {
    update(meetingId, phase, failed(error));
  }
}

export async function decideSpeakerSuggestion(
  meetingId: string,
  index: number,
  apply?: (
    suggestion: MeetingSpeakerSuggestion,
    result: MeetingSpeakerReviewResult,
  ) => Promise<"accepted" | "stale" | "failed">,
) {
  const review = reviewOf(meetingId);
  if (review?.phase.kind !== "result" || review.phase.applying !== null) return;
  const { phase } = review;
  const decision = phase.decisions[index];
  const suggestion = phase.result.suggestions[index];
  if (!suggestion || decision === "kept" || decision === "stale") return;
  const applying = { ...phase, applying: index };
  if (apply) update(meetingId, phase, applying);
  const next = apply ? await apply(suggestion, phase.result) : "kept";
  const { result } = phase;
  const updated =
    next === "accepted" && result.reviewedSpeakers !== undefined
      ? {
          ...result,
          reviewedSpeakers: parseTranscriptSpeakers(
            withSpeakerChosen(
              result.reviewedSpeakers,
              [],
              { startMs: suggestion.startMs, label: suggestion.fileLabel },
              { label: suggestion.suggestedLabel },
              false,
            ),
          ).speakers,
        }
      : result;
  update(meetingId, apply ? applying : phase, {
    ...phase,
    applying: null,
    result: updated,
    decisions: { ...phase.decisions, [index]: next },
  });
}

function discardReviews(keep: (meetingId: string, review: Review) => boolean) {
  useMeetingSpeakerReview.setState((state) => {
    const entries = Object.entries(state);
    const kept = entries.filter(([meetingId, review]) => keep(meetingId, review));
    return kept.length === entries.length ? state : Object.fromEntries(kept);
  }, true);
}

core.on("meetings.changed", (meetings) => {
  const documents = new Map(
    meetings.map((meeting) => [meeting.id, meeting.transcript?.documentId]),
  );
  discardReviews((meetingId, review) => documents.get(meetingId) === review.documentId);
});
core.on("documents.removed", (removed) => {
  const ids = new Set(removed);
  discardReviews((_meetingId, review) => !ids.has(review.documentId));
});
core.on("document.status", (document) => {
  if (document.fileStatus === "missing") {
    discardReviews((_meetingId, review) => review.documentId !== document.id);
  }
});
