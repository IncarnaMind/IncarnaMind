import { create } from "zustand";
import type {
  MeetingSpeakerReviewQuote,
  MeetingSpeakerReviewResult,
  MeetingSpeakerSuggestion,
} from "../../core/api";
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

export function openSpeakerReview(meetingId: string, owner: string) {
  const review = reviewOf(meetingId);
  if (review && (review.phase.kind !== "quote" || review.owner === owner)) {
    setReview(meetingId, { ...review, owner });
  } else void quoteSpeakerReview(meetingId, owner);
}

export function hideSpeakerReview(meetingId: string, owner: string) {
  const review = reviewOf(meetingId);
  if (review?.owner === owner) setReview(meetingId, { ...review, owner: null });
}

export async function quoteSpeakerReview(meetingId: string, owner: string) {
  const phase = { kind: "quoting" } as const;
  setReview(meetingId, { owner, phase });
  try {
    const quote = await core.getMeetingSpeakerReview(meetingId);
    update(meetingId, phase, { kind: "quote", quote });
  } catch (error) {
    update(meetingId, phase, failed(error));
  }
}

export async function runSpeakerReview(meetingId: string) {
  const review = reviewOf(meetingId);
  if (review?.phase.kind !== "quote" || !review.phase.quote.available) return;
  const phase = { kind: "running" } as const;
  setReview(meetingId, { ...review, phase });
  try {
    const result = await core.reviewMeetingSpeakers({ meetingId, confirmed: true });
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
  update(meetingId, apply ? applying : phase, {
    ...phase,
    applying: null,
    decisions: { ...phase.decisions, [index]: next },
  });
}
