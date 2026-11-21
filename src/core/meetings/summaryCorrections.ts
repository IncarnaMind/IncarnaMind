import { z } from "zod";
import type { MeetingSummary, MeetingSummaryCandidate, MeetingSummaryItem } from "../api";
import { InvalidInputError } from "../errors";
import type { StoredMeetingSummary } from "./liveSummary";
import { sameCandidateSource } from "./summaryCandidates";
import {
  type StoredSummaryQuote,
  sameSummaryQuote,
  storeSummaryQuote,
  summaryEvidenceCue,
} from "./summaryEvidence";
import type { TranscriptActionLine } from "./summarySources";

const fields = z.strictObject({
  kind: z.enum(["decision", "action"]),
  status: z.enum(["active", "done", "cancelled"]),
  text: z.string().trim().min(1),
});
const replacement = fields.extend({ restoreGenerated: z.literal(true).optional() });
const expected = fields.extend({
  id: z.int().positive(),
  corrected: z.literal(true).optional(),
});

interface ItemEvidence {
  documentId: string;
  quotes: readonly StoredSummaryQuote[];
  line?: TranscriptActionLine;
}

export interface StoredCandidateReview {
  documentId: string;
  contentHash: string;
  route: string;
  candidates: MeetingSummaryCandidate[];
}

export interface StoredSummaryWithReview extends StoredMeetingSummary {
  candidateReview?: StoredCandidateReview;
  lastCandidateId?: number;
}

export interface SummaryCandidateReference {
  candidate: MeetingSummaryCandidate;
  documentId: string;
  contentHash: string;
  route: string;
}

interface Correction {
  item: MeetingSummaryItem;
  source: ItemEvidence | null;
  promotion?: SummaryCandidateReference;
}

export function summaryCandidateUnavailable(): InvalidInputError {
  return new InvalidInputError({ key: "error.meeting.summaryCandidateUnavailable" });
}

function sameSummaryCandidate(a: MeetingSummaryCandidate, b: MeetingSummaryCandidate) {
  return (
    a.sources.length === b.sources.length &&
    a.sources.every((source, index) => {
      const other = b.sources[index];
      return !!other && sameCandidateSource(source, other);
    })
  );
}

export function availableSummaryCandidates(
  stored: StoredSummaryWithReview,
  corrections: readonly Correction[],
): MeetingSummaryCandidate[] {
  const review = stored.candidateReview;
  if (!review) return [];
  const seen = corrections.flatMap(({ promotion }) =>
    promotion && promotion.documentId === review.documentId ? [promotion.candidate] : [],
  );
  const manual = corrections.flatMap(({ source }) =>
    source?.line?.transcriptCue && source.documentId === review.documentId
      ? [source.line.transcriptCue]
      : [],
  );
  const available: MeetingSummaryCandidate[] = [];
  for (const candidate of review.candidates) {
    const [only, second] = candidate.sources;
    if (
      (only && !second && manual.some((cue) => sameCandidateSource(cue, only))) ||
      seen.some(
        (other) =>
          other.id === candidate.id ||
          other.sources.some((earlier) =>
            candidate.sources.some((current) => sameCandidateSource(earlier, current)),
          ),
      )
    )
      continue;
    seen.push(candidate);
    available.push(candidate);
  }
  return available;
}

export function acceptedSummaryCandidates(
  corrections: readonly Correction[],
): SummaryCandidateReference[] {
  return corrections.flatMap(({ promotion }) => (promotion ? [promotion] : []));
}

export function withReviewedCandidates(
  stored: StoredSummaryWithReview,
  corrections: readonly Correction[],
): StoredSummaryWithReview {
  const review = stored.candidateReview;
  if (!review) return stored;
  return {
    ...stored,
    candidateReview: {
      ...review,
      // Keep manually hidden suggestions in the cache so Undo can reveal them.
      candidates: availableSummaryCandidates(
        stored,
        corrections.filter((entry) => entry.promotion),
      ),
    },
  };
}

function promotedFields(candidate: MeetingSummaryCandidate) {
  return {
    kind: "action" as const,
    status: "active" as const,
    text: candidate.sources.map(({ text }) => text).join("\n"),
  };
}

export function promoteSummaryCandidate(
  stored: StoredSummaryWithReview,
  corrections: Correction[],
  checked: SummaryCandidateReference,
): Correction[] {
  const { candidate, documentId, contentHash, route } = checked;
  if (corrections.some(({ promotion }) => promotion?.candidate.id === candidate.id))
    return corrections;
  const available = availableSummaryCandidates(stored, corrections).find(
    ({ id }) => id === candidate.id,
  );
  if (
    stored.candidateReview?.documentId !== documentId ||
    stored.candidateReview.contentHash !== contentHash ||
    stored.candidateReview.route !== route ||
    !available ||
    !sameSummaryCandidate(available, candidate)
  )
    throw summaryCandidateUnavailable();

  const id = nextItemId(stored, corrections, 0);
  return [
    ...corrections,
    {
      item: { id, ...promotedFields(candidate) },
      source: {
        documentId,
        quotes: candidate.sources.map((cue) =>
          storeSummaryQuote(cue.text, [summaryEvidenceCue(cue)]),
        ),
      },
      promotion: checked,
    },
  ];
}

function nextItemId(
  stored: StoredSummaryWithReview | null,
  corrections: Correction[],
  reserved: number,
) {
  const id =
    Math.max(
      reserved,
      stored?.lastItemId ?? 0,
      ...corrections.map(({ item }) => item.id),
      ...(stored?.summary.items?.map((item) => item.id) ?? []),
    ) + 1;
  if (!Number.isSafeInteger(id)) throw summaryCandidateUnavailable();
  return id;
}

export function addTranscriptAction(
  stored: StoredSummaryWithReview | null,
  corrections: Correction[],
  reserved: number,
  documentId: string,
  line: TranscriptActionLine,
) {
  const cue = line.transcriptCue;
  const existing = corrections.find((entry) => {
    if (entry.source?.documentId !== documentId) return false;
    const sources = entry.source.line?.transcriptCue
      ? [entry.source.line.transcriptCue]
      : entry.promotion?.candidate.sources;
    return sources?.length === 1 && sources.some((source) => sameCandidateSource(source, cue));
  });
  if (existing) return { itemId: existing.item.id, corrections };
  const quote = storeSummaryQuote(cue.text, [summaryEvidenceCue(line.parentCue ?? cue)]);
  const generated =
    !line.parentCue &&
    visibleSummary(stored, corrections)?.items?.find((item) => {
      if (item.kind !== "action" || item.text !== cue.text || item.status !== "active")
        return false;
      const evidence = itemEvidence(stored, corrections, item.id);
      return (
        evidence?.documentId === documentId &&
        evidence.quotes.some((other) => sameSummaryQuote(other, quote))
      );
    });
  if (generated) return { itemId: generated.id, corrections };
  const id = nextItemId(stored, corrections, reserved);
  const action: Correction = {
    item: { id, kind: "action", status: "active", text: cue.text },
    source: { documentId, quotes: [quote], line },
  };
  return { itemId: id, corrections: [...corrections, action] };
}

export function undoTranscriptAction(corrections: Correction[], itemId: number) {
  const record = corrections.find(({ item }) => item.id === itemId);
  if (!record) return corrections;
  if (
    !record.source?.line?.transcriptCue ||
    !sameWords(record.item, {
      kind: "action",
      status: "active",
      text: record.source.line.transcriptCue.text,
    })
  )
    throw new InvalidInputError({ key: "error.meeting.summaryItemChanged" });
  return corrections.filter((entry) => entry !== record);
}

export function undoSummaryCandidate(
  stored: StoredSummaryWithReview,
  corrections: Correction[],
  candidateId: number,
  canRestore: boolean,
): { corrections: Correction[]; restored?: MeetingSummaryCandidate } {
  const current = corrections.find(({ promotion }) => promotion?.candidate.id === candidateId);
  const promotion = current?.promotion;
  if (!current || !promotion) {
    if (availableSummaryCandidates(stored, corrections).some(({ id }) => id === candidateId))
      return { corrections };
    throw summaryCandidateUnavailable();
  }
  if (!sameWords(current.item, promotedFields(promotion.candidate))) {
    throw new InvalidInputError({ key: "error.meeting.summaryItemChanged" });
  }
  const restored =
    canRestore &&
    stored.candidateReview?.route === promotion.route &&
    stored.candidateReview.documentId === promotion.documentId &&
    stored.candidateReview.contentHash === promotion.contentHash
      ? promotion.candidate
      : undefined;
  return { corrections: corrections.filter((entry) => entry !== current), restored };
}

export function readCorrections(json: string | null): Correction[] {
  return json === null ? [] : (JSON.parse(json) as Correction[]);
}

export function visibleSummary(
  stored: StoredSummaryWithReview | null,
  corrections: readonly Correction[],
  reviewed = false,
): MeetingSummary | undefined {
  if (!stored && !corrections.length) return undefined;
  const base: MeetingSummary = stored?.summary ?? { state: "ready", text: "", throughMs: 0 };
  const { candidateCount: _count, candidatesReviewed: _reviewed, ...summary } = base;
  const candidateCount =
    reviewed && stored ? availableSummaryCandidates(stored, corrections).length : 0;
  const items = new Map(summary.items?.map((item) => [item.id, item]));
  for (const { item } of corrections) items.set(item.id, { ...item, corrected: true });
  return {
    ...summary,
    ...(summary.state === "failed" &&
      stored &&
      !stored.route.startsWith("builtin:") && { retryAgentId: stored.route }),
    ...(corrections.length && { items: [...items.values()] }),
    ...(reviewed && { candidatesReviewed: true }),
    ...(candidateCount && { candidateCount }),
  };
}

export function itemEvidence(
  stored: StoredSummaryWithReview | null,
  corrections: readonly Correction[],
  id: number,
): ItemEvidence | null {
  const correction = corrections.find(({ item }) => item.id === id);
  if (correction) return correction.source;
  const quotes = stored?.evidence?.[id];
  return stored?.documentId &&
    quotes?.length &&
    stored.summary.items?.some((item) => item.id === id)
    ? { documentId: stored.documentId, quotes }
    : null;
}

const sameWords = (
  a: MeetingSummaryItem,
  b: Pick<MeetingSummaryItem, "text" | "kind" | "status">,
) => a.text === b.text && a.kind === b.kind && a.status === b.status;

export function correctItem(
  stored: StoredSummaryWithReview | null,
  corrections: Correction[],
  was: unknown,
  next: unknown,
): Correction[] {
  const before = expected.safeParse(was);
  const after = replacement.safeParse(next);
  if (!before.success || !after.success)
    throw new InvalidInputError({ key: "error.meeting.summaryItemInvalid" });
  const { id } = before.data;
  const current = visibleSummary(stored, corrections)?.items?.find((item) => item.id === id);
  if (!current || !sameWords(current, before.data) || current.corrected !== before.data.corrected)
    throw new InvalidInputError({ key: "error.meeting.summaryItemChanged" });
  const { restoreGenerated, ...fieldsToSave } = after.data;
  const prior = corrections.find((entry) => entry.item.id === id);
  const rest = corrections.filter((entry) => entry !== prior);
  if (restoreGenerated) {
    const ai = stored?.summary.items?.find((item) => item.id === id);
    if (ai && sameWords(ai, fieldsToSave)) return current.corrected ? rest : corrections;
  }
  if (current.corrected && sameWords(current, fieldsToSave)) return corrections;
  return [
    ...rest,
    {
      item: { id, ...fieldsToSave },
      source: itemEvidence(stored, corrections, id),
      ...(prior?.promotion && { promotion: prior.promotion }),
    },
  ];
}
