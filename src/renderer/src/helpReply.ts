/**
 * A help button's Answer during a call, as the floating panel shows it: read through the reply's
 * reader (src/shared/helpReplyRead.ts), which says what each line is.
 */
import type {
  AnswerStatus,
  AnswerSteps,
  CitationCheckReason,
  ConversationQuestion,
  MarkedCitation,
  Meeting,
} from "../../core/api";
import type { Language } from "../../core/language";
import { type DateOptions, formatDateTime } from "../../shared/dates";
import {
  helpLayout,
  helpReplyRead,
  type ReplyItem,
  type ReplyPiece,
} from "../../shared/helpReplyRead";
import { isTranscriptLocation, type Translate } from "../../shared/locations";
import type { CallHelpForm, MeetingHelpKind } from "../../shared/meetingHelp";

/**
 * An option's sentence as the User would say it, in quotation marks of the panel's own: its reader
 * has taken off a pair the model wrapped it in. Its Citations stay after the closing mark.
 */
export function quoted(lead: readonly ReplyPiece[]): ReplyPiece[] {
  const texts = lead.flatMap((piece, index) => (piece.kind === "text" ? [index] : []));
  const first = texts[0];
  const last = texts.at(-1);
  if (first === undefined || last === undefined) return [...lead];
  return lead.map((piece, index) => {
    if (piece.kind !== "text") return piece;
    let text = piece.text;
    if (index === first) text = `“${text.trimStart()}`;
    if (index === last) text = `${text.trimEnd()}”`;
    return { kind: "text", text };
  });
}

type HelpAnswer = { text: string; status: AnswerStatus; steps?: { textBehind?: true } | null };

/**
 * What the panel shows of a button's Answer: the line it puts first, then the options, readings
 * or short lines; where its facts stand apart, the fact lines before its options and its closing
 * line too (#2847).
 */
export function helpParts(
  answer: HelpAnswer,
  kind: MeetingHelpKind,
  form?: CallHelpForm,
): { lead: ReplyItem[]; options: ReplyItem[]; opening: ReplyPiece[][]; closing: ReplyPiece[][] } {
  const { lead, options, opening, closing } = helpReplyRead(
    answer.text,
    helpLayout(kind, {
      status: answer.status,
      textBehind: answer.steps?.textBehind === true,
      ...(form && { form }),
    }),
  );
  return { lead, options, opening, closing };
}

export function helpItems(answer: HelpAnswer, kind: MeetingHelpKind): ReplyItem[] {
  const { lead, options } = helpParts(answer, kind);
  return [...lead, ...options];
}

/**
 * Whether a button's Answer has anything to pin or add to the note: it ended with an option,
 * reading or short line, or with the lead-in of "Am I leading them?", which is its answer; the
 * app's own line that the live text is behind isn't.
 */
export function helpToKeep(answer: HelpAnswer, kind: MeetingHelpKind): boolean {
  const { lead, options } = helpParts(answer, kind);
  return (
    answer.status === "done" && (options.length > 0 || (kind === "leading" && lead.length > 0))
  );
}

/**
 * The number each Citation shows with, from 1 in the order the shown lines cite them (the fact
 * lines before the options, `opening`, first), as the assistant numbers an Answer's: a marker is the
 * core's ("[^9001]" for a figure's input), never the User's. A marker `cited` doesn't know isn't
 * shown, so it takes no number.
 */
export function citationNumbers(
  items: readonly ReplyItem[],
  cited: (marker: number) => boolean,
  opening: readonly ReplyPiece[][] = [],
): Map<number, number> {
  const numbers = new Map<number, number>();
  const lines = [
    ...opening,
    ...items.flatMap((item) => [item.lead, ...item.notes, item.effect ?? [], ...item.after]),
  ];
  for (const piece of lines.flat()) {
    if (piece.kind === "citation" && !numbers.has(piece.marker) && cited(piece.marker))
      numbers.set(piece.marker, numbers.size + 1);
  }
  return numbers;
}

/**
 * Whether a help reply's Citation shows ✓ where it is cited (`at`): the sentence check passed the
 * sentence it is cited in there (#2847). A found quote alone shows none, nor does a line too short
 * to be judged, and a marker reused by a sentence that didn't pass keeps the ✓ its own earned.
 */
export const sentencePassed = (citation: Pick<MarkedCitation, "passedAt">, at: number): boolean =>
  citation.passedAt?.includes(at) === true;

const ACTIONABLE = [
  "answer-limit",
  "monthly-limit",
  "answer-limit-unfinished",
  "monthly-limit-unfinished",
  "small-model",
] as const satisfies readonly CitationCheckReason[];

/**
 * Why a help reply's Citation was never checked, where the User can do something about it: the
 * Answer's checking limit or the monthly limit reached, before its sentence or before the model
 * finished it (#2962), or a model too small to judge. Null otherwise, a line the check doesn't
 * judge among them.
 */
export function uncheckedReason(
  citation: Pick<MarkedCitation, "check" | "checkReason">,
): (typeof ACTIONABLE)[number] | null {
  if (citation.check !== "not-checked") return null;
  return ACTIONABLE.find((each) => each === citation.checkReason) ?? null;
}

/**
 * When the call of each cited Transcript started, by Document id, for the ones that show it beside
 * their name (#3005): an earlier call's, and this call's (`thisCall`, its Transcript's id) only when
 * another cited Transcript has the same name.
 */
export function callStarts(
  cited: readonly Pick<MarkedCitation, "documentId" | "documentName" | "location">[],
  meetings: readonly (Pick<Meeting, "kind" | "startedAt"> & {
    transcript: { documentId: string | null } | null;
  })[],
  thisCall: string | null,
): Map<string, string> {
  const transcripts = cited.filter((citation) => isTranscriptLocation(citation.location));
  const starts = new Map<string, string>();
  for (const citation of transcripts) {
    const startedAt = meetings.find(
      (meeting) =>
        meeting.kind === "meeting" && meeting.transcript?.documentId === citation.documentId,
    )?.startedAt;
    if (!startedAt) continue;
    const sameName = transcripts.some(
      (other) =>
        other.documentId !== citation.documentId && other.documentName === citation.documentName,
    );
    if (citation.documentId !== thisCall || sameName) starts.set(citation.documentId, startedAt);
  }
  return starts;
}

const NO_CALLS: ReadonlySet<string> = new Set();

/**
 * The Transcripts a help button's reply is checked without (#3005), as its check reads them: every
 * call's but the one of the Note it was pressed in, and every call's once that Note is gone. None
 * for any other Answer.
 */
export function otherCallsOf(
  question: Pick<ConversationQuestion, "askedFrom"> | undefined,
  answer: { steps: Pick<AnswerSteps, "pressed"> | null },
  meetings: readonly (Pick<Meeting, "kind" | "mindId"> & {
    transcript: { documentId: string | null } | null;
  })[],
): ReadonlySet<string> {
  if (!question || answer.steps?.pressed === undefined) return NO_CALLS;
  const from = question.askedFrom;
  const own = from && !from.deleted ? from.mindId : null;
  return new Set(
    meetings.flatMap((meeting) =>
      meeting.kind === "meeting" && meeting.mindId !== own && meeting.transcript?.documentId
        ? [meeting.transcript.documentId]
        : [],
    ),
  );
}

/** A call's start as a cited Transcript shows it: "started 09:00", "开始于 09:00". */
export const startedLabel = (
  startedAt: string,
  t: Translate,
  language: Language,
  options?: DateOptions,
): string => t("meetings.help.started", { time: formatDateTime(startedAt, language, options) });
