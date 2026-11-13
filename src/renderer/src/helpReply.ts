/**
 * A help button's Answer during a call, as the floating panel shows it: read through the reply's
 * reader (src/shared/helpReplyRead.ts), which says what each line is.
 */
import type { AnswerStatus, CitationCheckReason, MarkedCitation } from "../../core/api";
import {
  helpLayout,
  helpReplyRead,
  type ReplyItem,
  type ReplyPiece,
} from "../../shared/helpReplyRead";
import type { MeetingHelpKind } from "../../shared/meetingHelp";

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
