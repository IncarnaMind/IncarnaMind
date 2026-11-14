/**
 * A help button's Answer during a call, as the floating panel shows it: read through the reply's
 * reader (src/shared/helpReplyRead.ts), which says what each line is.
 */
import type {
  AnswerStatus,
  AnswerSteps,
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
import type { MeetingHelpKind } from "../../shared/meetingHelp";

/**
 * An option's sentence as the User would say it, in quotation marks of the panel's own: its reader
 * has taken off a pair the model wrapped it in. The marks close its words, so its Citations follow
 * the closing mark, a space between two of them included.
 */
export function quoted(lead: readonly ReplyPiece[]): ReplyPiece[] {
  const texts = lead.flatMap((piece, index) =>
    piece.kind === "text" && piece.text.trim() !== "" ? [index] : [],
  );
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
 * or short lines.
 */
export function helpParts(
  answer: HelpAnswer,
  kind: MeetingHelpKind,
): { lead: ReplyItem[]; options: ReplyItem[] } {
  const { lead, options } = helpReplyRead(
    answer.text,
    helpLayout(kind, { status: answer.status, textBehind: answer.steps?.textBehind === true }),
  );
  return { lead, options };
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
 * The number each Citation shows with, from 1 in the order the shown items cite them, as the
 * assistant numbers an Answer's: a marker is the core's ("[^9001]" for a figure's input), never
 * the User's. A marker `cited` doesn't know isn't shown, so it takes no number.
 */
export function citationNumbers(
  items: readonly ReplyItem[],
  cited: (marker: number) => boolean,
): Map<number, number> {
  const numbers = new Map<number, number>();
  for (const item of items) {
    for (const piece of [item.lead, ...item.notes, item.effect ?? []].flat()) {
      if (piece.kind === "citation" && !numbers.has(piece.marker) && cited(piece.marker))
        numbers.set(piece.marker, numbers.size + 1);
    }
  }
  return numbers;
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
