/**
 * A call-help reply asked in the form whose facts stand apart (#2847), read into the words the User
 * sees and its check reads. A fact line's mark ("> ") and the reply's own line's ("= ") come off, so
 * no surface draws them as Markdown: in an option a fact or own line is known by its place between
 * the line to say and the "→" line, and a short line takes a list's mark. A marker on a line to say
 * or an own line comes off, as one on a "→" line does. A fact or own line the model wrote outside an
 * option goes into the option it belongs to, so the text kept reads the same way again.
 */
import { withoutMarkerRuns as withoutCitations } from "./answerSentences";
import { EFFECT_MARK, LINE_MARK, plainLine, RECOMMENDED_MARK } from "./meetingHelp";

export const FACT_MARK = /^(?:>|＞)\s*/;
export const OWN_MARK = /^(?:=|＝)\s*/;
/** A line that is so far only the start of a mark, while the reply is written: not yet a line. */
const MARK_ONLY = /^(?:[-*•>＞=＝]|\d+[.)]?)$/;
const SKIPPED = /^(?:\[\^\d{1,4}\]:|#+\s)/;
const BEFORE_MARK = /^\s*(?:\*\*|__)?\s*/;

/** `line` with `mark` taken off its words, put in place of it, its indent and bold kept. */
function marked(line: string, mark: RegExp, put = ""): string {
  const before = BEFORE_MARK.exec(line)?.[0] ?? "";
  return `${before}${put}${line.slice(before.length).replace(mark, "")}`;
}

export interface FactLinesText {
  /** The lines read. */
  lines: string[];
  /** For each line read, the index of the line it was as written. */
  origin: number[];
}

/**
 * The lines of a reply in the form, as read. `sayRead` reads a line to say as every option's is
 * read (without a pair of quotation marks the model wrapped it in whole).
 */
export function factLinesText(
  written: readonly string[],
  layout: { shape: "options" | "lines"; leadIn: boolean; streaming: boolean },
  sayRead: (line: string) => string,
): FactLinesText {
  const out: { line: string; origin: number }[] = [];
  const last = written.length - 1;
  if (layout.shape === "lines") {
    for (const [index, raw] of written.entries()) {
      const plain = plainLine(raw);
      if (layout.streaming && index === last && MARK_ONLY.test(plain)) continue;
      const own = OWN_MARK.test(plain);
      const mark = own ? OWN_MARK : FACT_MARK.test(plain) ? FACT_MARK : LINE_MARK;
      let line = raw;
      if (EFFECT_MARK.test(plain)) line = withoutCitations(raw);
      else if (own || mark.test(plain)) line = marked(raw, mark, "- ");
      out.push({ line: own ? withoutCitations(line) : line, origin: index });
    }
  } else {
    /** An option's line to say has come, and its "→" line not yet. */
    let open = false;
    /** Where the "→" line of the option before is, among the lines read. */
    let closedAt: number | null = null;
    /** Fact and own lines before any option, for the first that comes. */
    let held: { line: string; origin: number }[] = [];
    let started = false;
    for (const [index, raw] of written.entries()) {
      const plain = plainLine(raw);
      if (plain === "" || SKIPPED.test(plain)) {
        out.push({ line: raw, origin: index });
        continue;
      }
      if (layout.streaming && index === last && MARK_ONLY.test(plain)) continue;
      if (EFFECT_MARK.test(plain)) {
        out.push({ line: withoutCitations(raw), origin: index });
        if (open) closedAt = out.length - 1;
        open = false;
        started = true;
        continue;
      }
      const fact = FACT_MARK.test(plain);
      const own = OWN_MARK.test(plain);
      if (fact || own || (open && !RECOMMENDED_MARK.test(plain))) {
        const mark = own ? OWN_MARK : fact ? FACT_MARK : LINE_MARK;
        const words = mark.test(plain) ? marked(raw, mark) : raw;
        const each = { line: own ? withoutCitations(words) : words, origin: index };
        if (open) out.push(each);
        else if (closedAt !== null) out.splice(closedAt++, 0, each);
        else held.push(each);
        started = true;
        continue;
      }
      if (layout.leadIn && !started && !RECOMMENDED_MARK.test(plain)) {
        out.push({ line: raw, origin: index });
        started = true;
        continue;
      }
      out.push({ line: withoutCitations(sayRead(raw)), origin: index }, ...held);
      held = [];
      open = true;
      closedAt = null;
      started = true;
    }
    // With no option after them, the first is read as an option's line to say, as it is read again.
    const [first, ...rest] = held;
    if (first) out.push({ ...first, line: withoutCitations(first.line) }, ...rest);
  }
  return { lines: out.map(({ line }) => line), origin: out.map(({ origin }) => origin) };
}
