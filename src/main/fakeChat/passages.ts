/** A Passage of a search result, as the model reads it. */
interface ShownPassage {
  id: string;
  document: string;
  /** A PDF's first page. */
  page: number | null;
  /** Any other kind's: where the Passage is, e.g. "slides 1–5" (ADR-0011). */
  location: string | null;
  text: string;
}

export function passagesIn(result: string): ShownPassage[] {
  const pattern =
    /<passage id="([^"]+)" document="([^"]*)"(?: (?:date|file-created|file-modified)="[^"]*")?(?: pages="(\d+)(?:-\d+)?")?(?: location="([^"]+)")?>\n([\s\S]*?)\n<\/passage>/g;
  return [...result.matchAll(pattern)].map((match) => ({
    id: match[1] as string,
    document: match[2] as string,
    page: match[3] ? Number(match[3]) : null,
    location: match[4] ?? null,
    text: match[5] ?? "",
  }));
}

/** A mark where a new Unit starts in a Passage: "[p. 4] ", "[slide 4] ", "[§ 2.1 Sensitivity] "… */
export const UNIT_MARK =
  /^\[(p\. \d+|slides? [^\]]+|§[^\]]*|[^\]]*rows? [\d–-]+|lines? [\d–-]+)\] /;
/** Where a slide's speaker notes, or a Word comment, start in a Passage. */
export const NOTES_MARK = /^\[(?:speaker notes|comment(?: by [^\]]+)?)\] /;

/** A Question that asks for its quote in quotation marks (#483). */
const QUOTED_WORDS = /\bquotation marks\b|引号/i;
/** A line's lead, up to its first colon or comma, and the clause after it, without its full stop. */
const CLAUSE_AFTER_LEAD = /^(.+?)([,:，：])\s*(.+?)[.!?。！？]?$/u;

/**
 * The record for a Passage: its line that shares the most words with the
 * Question, where that line is (the page, or the Unit a mark before it names,
 * or else the Passage's own location), and the line as the quote. A Question
 * that says "rows" quotes that line and the next, so it covers a range of rows.
 * One that says "quotation marks" (引号) quotes the clause after the line's
 * colon or comma, and `quoted` is that clause with the word before it joined
 * on, as an Answer that puts it in quotation marks writes it.
 */
export function recordFor(
  passage: ShownPassage,
  question: string,
  marker: number,
  /** Breaks a tie between lines that share as many words. */
  prefer: (line: string) => boolean = () => false,
): { record: Record<string, unknown>; shared: number; quoted: string | null } | null {
  const words = question
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length >= 4);
  let page = passage.page;
  let location = passage.location;
  const lines: { line: string; page: number | null; location: string | null }[] = [];
  for (const raw of passage.text.split("\n")) {
    let rest = raw;
    const mark = UNIT_MARK.exec(rest);
    if (mark) {
      const label = mark[1] as string;
      if (label.startsWith("p. ")) page = Number(label.slice(3));
      else location = label;
      rest = rest.slice(mark[0].length);
    }
    rest = rest.replace(NOTES_MARK, "");
    lines.push({ line: rest.trim(), page, location });
  }
  let chosen = -1;
  let best = -1;
  lines.forEach(({ line }, index) => {
    if (!line) return;
    const shared = words.filter((word) => line.toLowerCase().includes(word)).length;
    if (shared > best || (shared === best && prefer(line) && !prefer(lines[chosen]?.line ?? ""))) {
      best = shared;
      chosen = index;
    }
  });
  const picked = lines[chosen];
  if (!picked) return null;
  let quote = picked.line;
  const next = lines[chosen + 1];
  if (/\brows\b/i.test(question) && next?.line && next.location === picked.location) {
    quote = `${quote}\n${next.line}`;
  }
  if (/misquote/i.test(question)) quote = `${quote.replace(/[.!?]$/, "")} and tomorrow.`;
  // A model that quotes what comes after the line's colon or comma, and writes the word before it into its quotation marks.
  let quoted: string | null = null;
  const clause = QUOTED_WORDS.test(question) ? CLAUSE_AFTER_LEAD.exec(picked.line) : null;
  if (clause) {
    const [, lead = "", separator = "", rest = ""] = clause;
    quote = rest;
    quoted = /\p{Script=Han}$/u.test(lead)
      ? `${lead.slice(-2)}${rest}`
      : `${lead.split(/\s+/).at(-1)}${separator === "," || separator === ":" ? " " : ""}${rest}`;
  }
  const record = {
    marker,
    passage: passage.id,
    ...(picked.page !== null && !/\bno page\b/i.test(question)
      ? { pageFrom: picked.page, pageTo: picked.page }
      : picked.location
        ? { location: picked.location }
        : {}),
    quote,
  };
  return { record, shared: best, quoted };
}

const TRANSCRIPT_STAMP = /\[\d{1,2}:\d{2}(?::\d{2})?(?: [^\]\n]+)?\]\s*/g;

/**
 * A transcript repeats what is said, so `cite` may refuse a line as occurring more than once
 * (#1979). Then the record again, quoting its Passage's words, which occur once; otherwise null.
 */
export function withSurroundingWords(
  cited: readonly string[],
  passage: ShownPassage,
  marker: number,
): Record<string, unknown> | null {
  if (!cited.at(-1)?.includes("quote enough surrounding words")) return null;
  return {
    marker,
    passage: passage.id,
    quote: passage.text.replace(TRANSCRIPT_STAMP, ""),
  };
}

export const FOUR_CITATIONS = /\bfour citations\b|四条引用/i;
export const FORTY_CITATIONS = /\bforty citations\b|四十条引用/i;
export const TWELVE_IN_A_ROW = /\btwelve in a row\b|连续十二条/i;

export const citationsAsked = (question: string) =>
  FORTY_CITATIONS.test(question)
    ? 40
    : FOUR_CITATIONS.test(question)
      ? 4
      : TWELVE_IN_A_ROW.test(question)
        ? 12
        : 0;

/**
 * The records for a search result: for the first Passage, or with "each" in
 * the Question, for each Document found, its Passage with the line that
 * shares the most words with the Question, numbered in the order found.
 */
export function recordsFor(result: string, question: string): Record<string, unknown>[] {
  const passages = passagesIn(result);
  const asked = citationsAsked(question);
  if (asked > 0) {
    const first = passages[0];
    return Array.from({ length: asked }, (_, index) =>
      first ? (recordFor(first, question, index + 1)?.record ?? null) : null,
    ).filter((record) => record !== null);
  }
  if (!/\beach\b/i.test(question)) {
    const first = passages[0] && recordFor(passages[0], question, 1);
    return first ? [first.record] : [];
  }
  const documents = [...new Set(passages.map((passage) => passage.document))];
  return documents.flatMap((document, index) => {
    let best: { record: Record<string, unknown>; shared: number } | null = null;
    for (const passage of passages.filter((each) => each.document === document)) {
      const found = recordFor(passage, question, index + 1);
      if (found && (!best || found.shared > best.shared)) best = found;
    }
    return best ? [best.record] : [];
  });
}
