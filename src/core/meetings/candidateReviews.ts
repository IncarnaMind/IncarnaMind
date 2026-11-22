import { translate } from "../../shared/i18n";
import { partsOf, shownSpeaker, speakerOf } from "../../shared/speakers";
import { transcriptCueLines } from "../../shared/units";
import type { Document, Meeting, MeetingSummarySource } from "../api";
import type { createDocuments } from "../documents";
import { hashBytes } from "../documents/files";
import { isRecord, NotFoundError } from "../errors";
import type { Language } from "../language";
import {
  type CandidateReviewScope,
  candidateReviewNotReady,
  candidateReviewUnavailable,
  createCandidateReviews,
} from "./candidateReviewLifecycle";
import type { createMeetings } from "./index";
import { candidateSurvives } from "./summaryCandidates";
import { summaryCandidateUnavailable } from "./summaryCorrections";
import type { meetingSummaryRoute } from "./summaryRoute";
import {
  meetingSummarySources,
  type TranscriptActionLine,
  transcriptActionLine,
  transcriptActionSources,
} from "./summarySources";

interface Options {
  meetings: Pick<
    ReturnType<typeof createMeetings>,
    | "get"
    | "storedSummary"
    | "summaryCandidateReview"
    | "summaryItemEvidence"
    | "saveCandidateReview"
    | "addTranscriptAction"
    | "addSummaryCandidate"
    | "undoAddSummaryCandidate"
  >;
  documents: Pick<ReturnType<typeof createDocuments>, "currentVersion" | "pageTexts">;
  summaryRoute: Pick<
    ReturnType<typeof meetingSummaryRoute>,
    "selected" | "allowed" | "reviewCandidates"
  >;
  meetingSummaryDocument(meetingId: string, documentId: string): Document | null;
  walledFolder(mindId: string): string | null;
  language(): Language;
  extract(documentId: string): Promise<void>;
  readTranscript(documentId: string): Promise<Uint8Array>;
  pendingSpeakers(meetingId: string): Promise<void> | null;
  closed(): boolean;
  failed(meetingId: string, error: unknown): void;
}

export function createMeetingCandidateReview({
  meetings,
  documents,
  summaryRoute,
  meetingSummaryDocument,
  walledFolder,
  language,
  extract,
  readTranscript,
  pendingSpeakers,
  closed,
  failed,
}: Options) {
  function summaryCandidateReview(meetingId: string) {
    try {
      return meetings.summaryCandidateReview(meetingId);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async function currentSummaryCues(meetingId: string, documentId: string) {
    try {
      if (!meetingSummaryDocument(meetingId, documentId)) return null;
      await extract(documentId);
      const doc = meetingSummaryDocument(meetingId, documentId);
      if (!doc?.contentHash || documents.currentVersion(documentId) !== doc.contentHash)
        return null;
      const bytes = await readTranscript(documentId);
      const current = meetingSummaryDocument(meetingId, documentId);
      if (current?.contentHash !== doc.contentHash || hashBytes(bytes) !== doc.contentHash)
        return null;
      const units = documents.pageTexts(documentId, doc.contentHash, null, null);
      return { documentId, contentHash: doc.contentHash, units, cues: transcriptCueLines(units) };
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        (isRecord(error) &&
          (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM"))
      )
        return null;
      throw error;
    }
  }

  function currentTranscriptCues(
    meetingId: string,
    checked: Awaited<ReturnType<typeof currentSummaryCues>>,
  ) {
    if (!checked) return null;
    try {
      const doc = meetingSummaryDocument(meetingId, checked.documentId);
      return doc?.contentHash === checked.contentHash ? checked.cues : null;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  function candidateReviewMeeting(scope: CandidateReviewScope) {
    if (closed()) return null;
    try {
      const meeting = meetings.get(scope.meetingId);
      const doc = meetingSummaryDocument(scope.meetingId, scope.documentId);
      if (
        doc?.contentHash !== scope.contentHash ||
        meeting.mindId !== scope.mindId ||
        meetings.storedSummary(scope.meetingId)?.documentId !== scope.documentId ||
        meeting.transcript?.state !== "saved" ||
        meeting.summary?.state !== "ready" ||
        walledFolder(meeting.mindId) !== scope.wall ||
        summaryRoute.selected(meeting) !== scope.route ||
        !summaryRoute.allowed(meeting, scope.route) ||
        JSON.stringify(meeting.summary.items ?? []) !== JSON.stringify(scope.items)
      )
        return null;
      return { meeting, doc };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  const candidateReviews = createCandidateReviews({
    current: (scope) => candidateReviewMeeting(scope) !== null,
    async input(scope) {
      const pass = pendingSpeakers(scope.meetingId);
      if (pass) {
        await pass;
        if (!candidateReviewMeeting(scope)) return null;
      }
      const indexed = await currentSummaryCues(scope.meetingId, scope.documentId);
      const current = candidateReviewMeeting(scope);
      if (!current || indexed?.contentHash !== scope.contentHash || !indexed.cues.length)
        return null;
      const speakers = current.doc.speakers;
      const utterances = indexed.cues.map(({ label, ...cue }) => {
        if (!label) return { ...cue, speaker: null };
        const voice = speakerOf(speakers, cue.startMs, label);
        const oneVoice = partsOf(speakers, { ...cue, label }).every(
          (part) => speakerOf(speakers, part.startMs, label) === voice,
        );
        const speaker = oneVoice
          ? shownSpeaker(speakers, cue.startMs, label, (key, params) =>
              translate(language(), key, params),
            )
          : null;
        return { ...cue, speaker };
      });
      const established = scope.items.flatMap((item) => {
        if (item.corrected) return [];
        const source = meetings.summaryItemEvidence(scope.meetingId, item.id);
        if (source?.documentId !== scope.documentId) return [];
        const anchored = source.quotes.filter((quote) => typeof quote !== "string");
        return meetingSummarySources(indexed.units, anchored).map(({ text }) => text);
      });
      return { utterances, items: scope.items, established };
    },
    generate(scope, input, signal) {
      const current = candidateReviewMeeting(scope);
      if (!current) throw candidateReviewUnavailable();
      return summaryRoute.reviewCandidates(current.meeting, scope.route, input, signal);
    },
    save(scope, sources, input) {
      return meetings.saveCandidateReview(
        scope,
        sources.filter((each) => candidateSurvives({ sources: each }, input.utterances)),
      );
    },
    failed,
  });

  async function cachedSummaryCandidates(meetingId: string) {
    const review = summaryCandidateReview(meetingId)?.review;
    if (!review?.candidates.length) return [];
    const checked = await currentSummaryCues(meetingId, review.documentId);
    const cues = currentTranscriptCues(meetingId, checked);
    const current = summaryCandidateReview(meetingId)?.review;
    if (
      !cues ||
      current?.documentId !== review.documentId ||
      current.contentHash !== review.contentHash ||
      checked?.contentHash !== current.contentHash
    )
      return [];
    return current.candidates.filter((candidate) => candidateSurvives(candidate, cues));
  }

  function newReviewScope(meetingId: string): CandidateReviewScope | "not-ready" | null {
    if (closed()) return null;
    let meeting: Meeting;
    try {
      meeting = meetings.get(meetingId);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    if (meeting.kind !== "meeting") return null;
    const documentId = meeting.transcript?.documentId;
    if (
      !documentId ||
      meeting.status !== "stopped" ||
      meeting.transcript?.state !== "saved" ||
      meeting.summary?.state !== "ready"
    )
      return "not-ready";

    const doc = meetingSummaryDocument(meetingId, documentId);
    const route = summaryRoute.selected(meeting);
    if (
      !doc?.contentHash ||
      meetings.storedSummary(meetingId)?.documentId !== documentId ||
      !route ||
      !summaryRoute.allowed(meeting, route)
    )
      return null;
    return {
      meetingId,
      mindId: meeting.mindId,
      documentId,
      contentHash: doc.contentHash,
      route,
      wall: walledFolder(meeting.mindId),
      items: meeting.summary.items ?? [],
    };
  }

  async function reviewMeetingSummaryCandidates(meetingId: string) {
    if (summaryCandidateReview(meetingId)?.review) return cachedSummaryCandidates(meetingId);
    const scope = newReviewScope(meetingId);
    if (scope === "not-ready") throw candidateReviewNotReady();
    if (!scope) throw candidateReviewUnavailable();
    return candidateReviews.review(scope);
  }

  return {
    changed: candidateReviews.changed,
    close: candidateReviews.close,
    canReview(meetingId: string) {
      const scope = newReviewScope(meetingId);
      return scope !== null && scope !== "not-ready";
    },
    get: cachedSummaryCandidates,
    review: reviewMeetingSummaryCandidates,
    async addTranscriptAction(meetingId: string, documentId: string, source: MeetingSummarySource) {
      if (!isRecord(source)) throw summaryCandidateUnavailable();
      const checked = await currentSummaryCues(meetingId, documentId);
      const doc = checked && meetingSummaryDocument(meetingId, documentId);
      if (
        !doc ||
        !checked ||
        doc.contentHash !== checked.contentHash ||
        meetings.get(meetingId).transcript?.state !== "saved"
      )
        throw summaryCandidateUnavailable();
      const line = transcriptActionLine(checked.cues, doc.speakers, source);
      if (!line) throw summaryCandidateUnavailable();
      return meetings.addTranscriptAction(meetingId, documentId, checked.contentHash, line);
    },
    async transcriptActionSources(
      meetingId: string,
      documentId: string,
      line: TranscriptActionLine,
    ) {
      const checked = await currentSummaryCues(meetingId, documentId);
      const doc = checked && meetingSummaryDocument(meetingId, documentId);
      return checked && doc && doc.contentHash === checked.contentHash
        ? transcriptActionSources(checked.cues, doc.speakers, line)
        : [];
    },
    async add(meetingId: string, candidateId: number) {
      if (!Number.isSafeInteger(candidateId) || candidateId <= 0)
        throw summaryCandidateUnavailable();
      const state = summaryCandidateReview(meetingId);
      if (state?.accepted.some(({ candidate }) => candidate.id === candidateId))
        return meetings.get(meetingId);
      const review = state?.review;
      const candidate = review?.candidates.find(({ id }) => id === candidateId);
      if (!review || !candidate) throw summaryCandidateUnavailable();
      const checked = await currentSummaryCues(meetingId, review.documentId);
      const cues = currentTranscriptCues(meetingId, checked);
      if (
        !cues ||
        checked?.contentHash !== review.contentHash ||
        !candidateSurvives(candidate, cues)
      )
        throw summaryCandidateUnavailable();
      return meetings.addSummaryCandidate(meetingId, {
        documentId: review.documentId,
        contentHash: review.contentHash,
        route: review.route,
        candidate,
      });
    },
    async undo(meetingId: string, candidateId: number) {
      if (!Number.isSafeInteger(candidateId) || candidateId <= 0)
        throw summaryCandidateUnavailable();
      const state = summaryCandidateReview(meetingId);
      if (!state) throw summaryCandidateUnavailable();
      const accepted = state.accepted.find(({ candidate }) => candidate.id === candidateId);
      if (!accepted) {
        if (state.review?.candidates.some(({ id }) => id === candidateId))
          return meetings.get(meetingId);
        throw summaryCandidateUnavailable();
      }
      const review = state.review;
      const checked =
        accepted.documentId === review?.documentId &&
        accepted.contentHash === review.contentHash &&
        accepted.route === review.route
          ? await currentSummaryCues(meetingId, accepted.documentId)
          : null;
      const cues = currentTranscriptCues(meetingId, checked);
      return meetings.undoAddSummaryCandidate(
        meetingId,
        candidateId,
        !!cues && candidateSurvives(accepted.candidate, cues),
      );
    },
  };
}
