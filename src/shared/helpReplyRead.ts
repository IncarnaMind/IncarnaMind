/**
 * A call-help reply as its panel shows it and its check reads it (#2925): the one reader both use,
 * so a Citation is checked on the words the User sees. Which of the reply's markers count is said
 * here too, with where each sits: its place among the reply's markers as written (`at`), by which
 * the check's verdicts are matched to the panel's chips, so none moves to another.
 *
 * An option, known by its form (a line that starts its item, first in the reply or after a blank
 * line or a "→" line, followed directly by its "→" line), that the model wrapped whole in its own
 * quotation marks is read without them: the panel shows every option in quotation marks of its own,
 * and with the model's left on, the check would look for the option's own words on the cited page.
 * A quotation inside an option is still one, and so is a reading's moment, which comes after the
 * line its item starts with, with or without its time.
 */

export interface HelpReplyRead {
  /** The reply's Markdown as read. */
  text: string;
  /** For each marker `text` holds, in order, its place among the reply's markers as written. */
  at: readonly number[];
}

/** A Citation marker as a reply's panel and check count them. */
export const HELP_MARKER = /\[\^\d{1,4}\]/g;
const EFFECT_LINE = /^\s*(?:\*\*|__)?\s*→/;
/** A line's mark and bold before its words, the words in a pair of quotation marks, then its markers. */
const WRAPPED =
  /^(\s*(?:\*\*|__)?\s*(?:★\s*)?(?:\*\*|__)?\s*)(["“「])(.*)(["”」])((?:\s*\[\^\d{1,4}\])*\s*(?:\*\*|__)?\s*)$/u;
/** Each opening mark's closing one, and the marks of its kind that may not stand inside the pair. */
const PAIRS: Readonly<Record<string, { closing: string; kind: RegExp }>> = {
  '"': { closing: '"', kind: /"/u },
  "“": { closing: "”", kind: /[“”]/u },
  "「": { closing: "」", kind: /[「」]/u },
};

/** `line` without the quotation marks its words are wrapped in, when they are its own pair. */
function unwrapped(line: string): string {
  const found = WRAPPED.exec(line);
  if (!found) return line;
  const [, before = "", opening = "", words = "", closing = "", after = ""] = found;
  const pair = PAIRS[opening];
  if (!pair || pair.closing !== closing || pair.kind.test(words) || words.trim() === "")
    return line;
  return `${before}${words}${after}`;
}

export function helpReplyRead(markdown: string): HelpReplyRead {
  const lines = markdown.split("\n");
  const startsItem = (index: number) => {
    const before = lines.slice(0, index);
    const last = before.at(-1);
    return (
      before.every((line) => line.trim() === "") ||
      last?.trim() === "" ||
      EFFECT_LINE.test(last ?? "")
    );
  };
  const text = lines
    .map((line, index) => {
      const next = lines[index + 1];
      const option =
        next !== undefined &&
        EFFECT_LINE.test(next) &&
        !EFFECT_LINE.test(line) &&
        startsItem(index);
      return option ? unwrapped(line) : line;
    })
    .join("\n");
  return { text, at: [...text.matchAll(HELP_MARKER)].map((_, place) => place) };
}
