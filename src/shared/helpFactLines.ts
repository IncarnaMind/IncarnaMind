/**
 * A call-help reply asked in the form whose facts stand apart (#2847), read into the words the User
 * sees and its check reads. A fact line's mark ("> ") and the reply's own line's ("= ") come off, so
 * no surface draws them as Markdown, and a short line takes a list's mark. A marker on a line to say,
 * an own line or a "→" line comes off, unless the line quotes words the quote check reads
 * (./quotedSpans).
 *
 * The text kept keeps the model's order (#2847): no line goes into an option it wasn't written in.
 * Without its marks, a line is known again by its place:
 * - between an option's line to say and its "→" line, a fact or own line of that option;
 * - right after a "→" line, with no blank line between, a fact or own line of the option above;
 * - before the first line to say, in a paragraph of its own whose every line cites, a fact line of
 *   the reply's own, no option's;
 * - once the reply has ended, in the last paragraph after the last option with nothing that cites,
 *   the reply's closing line. While it is written, the closing line is known by its "= ".
 * So the text read reads the same way again, and a reply whose last option never had its "→" line
 * reads that line as its closing line once it ends.
 */
import { MARKER, withoutMarkerRuns } from "./answerSentences";
import { EFFECT_MARK, LINE_MARK, plainLine, RECOMMENDED_MARK } from "./meetingHelp";
import { holdsQuote } from "./quotedSpans";
import { quoteAsFact, sameWordsOf } from "./turnedFacts";

export const FACT_MARK = /^(?:>|＞)\s*/;
export const OWN_MARK = /^(?:=|＝)\s*/;
/** A line that is so far only the start of a mark, while the reply is written: not yet a line. */
const MARK_ONLY = /^(?:[-*•>＞=＝]|\d+[.)]?)$/;
const SKIPPED = /^(?:\[\^\d{1,4}\]:|#+\s)/;
const BEFORE_MARK = /^\s*(?:\*\*|__)?\s*/;
const CITES = new RegExp(MARKER.source);

/** `line` with `mark` taken off its words, put in place of it, its indent and bold kept. */
function marked(line: string, mark: RegExp, put = ""): string {
  const before = BEFORE_MARK.exec(line)?.[0] ?? "";
  return `${before}${put}${line.slice(before.length).replace(mark, "")}`;
}

/** `line` without its Citation markers, unless it quotes words the quote check reads by them. */
const withoutCitations = (line: string) => (holdsQuote(line) ? line : withoutMarkerRuns(line));

/**
 * What a line of an options reply in the form is: an option's line to say (or a remark), a fact or
 * own line of an option before its "→" line (`inner`, a fact line a Document's Citation on its line
 * to say turned into among them) or after it (`after`), a "→" line, a fact line before the first
 * option (`opening`), the reply's closing line, the line put first, or a blank line, a heading or a
 * footnote's definition (`other`).
 */
export type FactLineRole =
  | "say"
  | "inner"
  | "effect"
  | "after"
  | "opening"
  | "closing"
  | "lead-in"
  | "other";

export interface FactLinesText {
  /** The lines read. */
  lines: string[];
  /** For each line read, the index of the line it was as written. */
  origin: number[];
  /** For each line read of an options reply, what it is; none for short lines. */
  roles: FactLineRole[];
  /**
   * For each line read, the place of its first marker among the markers of the line it was as
   * written: a line turned from a Citation on a line to say starts where that marker stood.
   */
  offset: number[];
}

interface FactLinesLayout {
  shape: "options" | "lines";
  leadIn: boolean;
  streaming: boolean;
  /** Whether the reply has ended: done, stopped or failed. */
  ended: boolean;
  /** A recorded Document Citation's quote, by marker; nothing for a line of a call (#2847). */
  quoteOf?: (marker: number) => string | null;
}

/**
 * The lines of a reply in the form, as read. `sayRead` reads a line to say as every option's is
 * read (without a pair of quotation marks the model wrapped it in whole).
 */
export function factLinesText(
  written: readonly string[],
  layout: FactLinesLayout,
  sayRead: (line: string) => string,
): FactLinesText {
  if (layout.shape === "options") return optionsText(written, layout, sayRead);
  const out: { line: string; origin: number }[] = [];
  const last = written.length - 1;
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
  return {
    lines: out.map(({ line }) => line),
    origin: out.map(({ origin }) => origin),
    roles: [],
    offset: out.map(() => 0),
  };
}

function optionsText(
  written: readonly string[],
  layout: FactLinesLayout,
  sayRead: (line: string) => string,
): FactLinesText {
  const last = written.length - 1;
  const plain = written.map(plainLine);
  const blank = (at: number) => plain[at] === "";
  const dropped = (at: number) =>
    layout.streaming && at === last && MARK_ONLY.test(plain[at] ?? "");
  const words = (at: number) =>
    at <= last && !blank(at) && !SKIPPED.test(plain[at] ?? "") && !dropped(at);
  const arrow = (at: number) => EFFECT_MARK.test(plain[at] ?? "");
  const star = (at: number) => RECOMMENDED_MARK.test(plain[at] ?? "");
  const fact = (at: number) => FACT_MARK.test(plain[at] ?? "");
  const own = (at: number) => OWN_MARK.test(plain[at] ?? "");
  const cites = (at: number) => CITES.test(written[at] ?? "");
  const later = (from: number) =>
    Array.from({ length: Math.max(0, last - from + 1) }, (_, step) => from + step).filter(words);

  /** A fact line before the first line to say, which stands apart from every option. */
  const opens = (at: number): boolean => {
    if (star(at) || own(at) || !cites(at)) return false;
    // Something must follow it, or, ended, it is read as a line to say, as before.
    const more = later(at + 1).some((next) => !(fact(next) && cites(next)));
    if (fact(at)) return !layout.ended || more;
    // Without its mark: a paragraph of its own whose every line cites, with more after it.
    let end = at;
    while (end < last && !blank(end + 1)) end++;
    for (let line = at; line <= end; line++) {
      if (words(line) && (arrow(line) || star(line) || own(line) || !cites(line))) return false;
    }
    return end < last && later(end + 1).length > 0;
  };
  /** The last paragraph, once the reply has ended: nothing in it or after it cites or is an option. */
  const closes = (at: number) =>
    layout.ended &&
    later(at).every((line) => !arrow(line) && !star(line) && !fact(line) && !cites(line));

  const roles: (FactLineRole | null)[] = [];
  let phase: "before" | "open" | "closed" | "closing" = "before";
  let leadDone = !layout.leadIn;
  for (let at = 0; at <= last; at++) {
    if (dropped(at)) roles.push(null);
    else if (!words(at)) roles.push("other");
    else if (arrow(at)) {
      roles.push("effect");
      phase = "closed";
      leadDone = true;
    } else if (phase === "before") {
      if (!leadDone && !star(at)) {
        roles.push("lead-in");
        leadDone = true;
      } else if (opens(at)) roles.push("opening");
      else {
        roles.push("say");
        phase = "open";
        leadDone = true;
      }
    } else if (phase === "open") roles.push(star(at) ? "say" : "inner");
    else if (phase === "closing") roles.push("closing");
    else if (star(at)) {
      roles.push("say");
      phase = "open";
    } else if (fact(at) || own(at) || roles[at - 1] === "effect" || roles[at - 1] === "after") {
      roles.push("after");
    } else if (closes(at)) {
      roles.push("closing");
      phase = "closing";
    } else {
      roles.push("say");
      phase = "open";
    }
  }

  const read = written.map((raw, at): string => {
    const role = roles[at];
    if (role === "other" || role === null || role === undefined) return raw;
    if (role === "effect") return withoutCitations(raw);
    const p = plain[at] ?? "";
    if (role === "say") {
      const mark = own(at) ? OWN_MARK : fact(at) ? FACT_MARK : null;
      return withoutCitations(sayRead(mark ? marked(raw, mark) : raw));
    }
    if (role === "opening" || role === "lead-in") {
      if (own(at)) return withoutCitations(marked(raw, OWN_MARK));
      return fact(at) ? marked(raw, FACT_MARK) : raw;
    }
    const mark = own(at) ? OWN_MARK : fact(at) ? FACT_MARK : LINE_MARK;
    const line = mark.test(p) ? marked(raw, mark) : raw;
    return own(at) ? withoutCitations(line) : line;
  });

  // The reply's own lines at its end, after its last option's "→" line, are its closing line.
  const lastArrow = roles.lastIndexOf("effect");
  if (lastArrow !== -1 && !roles.slice(lastArrow).some((role) => role === "say")) {
    for (let at = last; at > lastArrow; at--) {
      const role = roles[at];
      if (role === "other" || role === null || role === "closing") continue;
      if (role !== "after" || CITES.test(read[at] ?? "")) break;
      roles[at] = "closing";
    }
  }

  const turned = layout.quoteOf
    ? turnedLines(written, roles, read, layout.quoteOf, layout.streaming)
    : new Map();
  const out: { line: string; origin: number; role: FactLineRole; offset?: number }[] = [];
  const blankBefore = (origin: number) => {
    const previous = out.at(-1);
    if (previous && previous.line.trim() !== "") out.push({ line: "", origin, role: "other" });
  };
  for (let at = 0; at <= last; at++) {
    const role = roles[at];
    if (role === null || role === undefined) continue;
    if (role === "other" && blank(at)) {
      // A fact or own line after a "→" line stays in that option's paragraph.
      const next = roles.slice(at + 1).find((each, step) => !blank(at + 1 + step) && each !== null);
      if (next === "after") continue;
      out.push({ line: written[at] ?? "", origin: at, role });
      continue;
    }
    const previous = out.findLast((each) => each.line.trim() !== "")?.role;
    // The fact lines before the first option, and the closing line, are paragraphs of their own.
    if (role === "opening" ? previous !== "opening" : previous === "opening") blankBefore(at);
    else if (role === "closing" && previous !== "closing") blankBefore(at);
    out.push({ line: read[at] ?? "", origin: at, role });
    for (const each of turned.get(at) ?? []) out.push({ ...each, role: "inner" });
  }
  return {
    lines: out.map(({ line }) => line),
    origin: out.map(({ origin }) => origin),
    roles: out.map(({ role }) => role),
    offset: out.map(({ offset }) => offset ?? 0),
  };
}

const markersIn = (line: string) =>
  [...line.matchAll(new RegExp(MARKER.source, "g"))].map((found) => Number(found[1]));

/**
 * The fact lines a Document's Citation left on an option's line to say or "→" line turns into
 * (#2847), by the line of the option they go after: its last fact or own line, else its line to
 * say, so they stand above its "→" line. None where the line quotes words the quote check reads
 * (it keeps its marker), or where a line of the option already holds that Citation or its words;
 * a line with those words whose markers back nothing takes the Citation instead (`read` changes).
 * `quoteOf` gives a recorded Document Citation's quote, and nothing for a line of a call. While the
 * reply is written, an option still open turns nothing yet: its next fact line would go above the
 * turned line and move it, so the turned line waits for the option's "→" line.
 */
function turnedLines(
  written: readonly string[],
  roles: readonly (FactLineRole | null)[],
  read: string[],
  quoteOf: (marker: number) => string | null,
  streaming: boolean,
): Map<number, { line: string; origin: number; offset: number }[]> {
  const turned = new Map<number, { line: string; origin: number; offset: number }[]>();
  for (const [at, role] of roles.entries()) {
    if (role !== "say") continue;
    const inner: number[] = [];
    let arrowAt: number | null = null;
    let open = true;
    for (let next = at + 1; next < roles.length; next++) {
      const each = roles[next];
      if (each === "inner") inner.push(next);
      else if (each === "effect") {
        arrowAt = next;
        open = false;
        break;
      } else if (each !== "other" && each !== null) {
        open = false;
        break;
      }
    }
    if (streaming && open) continue;
    const said = read[at] ?? "";
    const lines: { line: string; origin: number; offset: number; marker: number }[] = [];
    for (const source of arrowAt === null ? [at] : [at, arrowAt]) {
      const raw = written[source] ?? "";
      if (holdsQuote(raw)) continue;
      const all = markersIn(raw);
      for (const marker of new Set(all)) {
        const quote = quoteOf(marker);
        if (quote === null || lines.some((each) => each.marker === marker)) continue;
        const words = quoteAsFact(quote, said);
        const holds = inner.some((line) =>
          markersIn(read[line] ?? "").some((each) => {
            const theirs = each === marker ? quote : quoteOf(each);
            return theirs !== null && sameWordsOf(theirs) === sameWordsOf(quote);
          }),
        );
        if (holds) continue;
        const same = inner.find((line) =>
          [sameWordsOf(words), sameWordsOf(quote)].includes(sameWordsOf(read[line] ?? "")),
        );
        if (same !== undefined) {
          if (markersIn(read[same] ?? "").every((each) => quoteOf(each) === null)) {
            read[same] = `${withoutMarkerRuns(read[same] ?? "").trimEnd()} [^${marker}]`;
          }
          continue;
        }
        lines.push({
          line: `${words} [^${marker}]`,
          origin: source,
          offset: all.indexOf(marker),
          marker,
        });
      }
    }
    if (lines.length > 0) {
      turned.set(
        inner.at(-1) ?? at,
        lines.map(({ marker: _marker, ...each }) => each),
      );
    }
  }
  return turned;
}
