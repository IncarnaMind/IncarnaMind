/**
 * The one naming rule for Minds and conversations: the first line of what the
 * User wrote or asked, cut to about this many characters.
 */
export const NAME_LENGTH = 60;

/** The fewest characters a cut at a clause mark keeps, so an opening like "Yes, but" isn't all that is left. */
const MIN_CLAUSE = 16;

const trailingMarks = /[\s.,;:!?…。，；：！？、\-–—]+$/u;

/** `text` without the marks a sentence ends with, so a name taken from a sentence ends on its words. */
export const withoutTrailingMarks = (text: string): string => text.replace(trailingMarks, "");

/** Where the text's words begin and end, in any language (Chinese and Japanese included). */
const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** Words a name never ends on: each starts something a cut leaves unsaid, and is dropped whole. */
const DANGLING_WORDS: ReadonlySet<string> = new Set([
  ...(
    "a an the of to in on at for from with without by as and or but nor plus than that which " +
    "who whom whose if so per via into onto between among during while when where what how why " +
    "its their our your"
  ).split(" "),
  ..."的 和 与 及 或 并 且 而 但 若 如 则 以 把 被 为 之 对 从 向 在 比".split(" "),
  ...(
    "以及 并且 而且 或者 因为 所以 如果 但是 然而 同时 其中 关于 对于 根据 按照 通过 为了 由于 " +
    "还是 加上 另外 此外"
  ).split(" "),
]);

/**
 * How many characters of `text` end on a word, at most `limit`; `limit` itself
 * when the first word is longer. It counts whole characters, so none is broken.
 */
function wordEnd(text: string, limit: number): number {
  const parts = Array.from(words.segment(text));
  const joined = (index: number) => {
    const [before, part, after] = [parts[index - 1], parts[index], parts[index + 1]];
    return part?.segment === "-" && before?.isWordLike && after?.isWordLike;
  };
  let characters = 0;
  let end = 0;
  for (const [index, { segment }] of parts.entries()) {
    characters += Array.from(segment).length;
    if (characters > limit) break;
    // A hyphen joins the words around it ("full-time"), which a cut keeps whole.
    if (!joined(index) && !joined(index + 1)) end = characters;
  }
  return end > 0 ? end : limit;
}

/**
 * `text` without the words a cut leaves hanging at its end ("…per year, plus"),
 * and without trailing marks. Only a whole word of the list goes, never part of one.
 */
function withoutDanglingEnd(text: string): string {
  let kept = text.replace(trailingMarks, "");
  for (;;) {
    let last: { segment: string; index: number } | undefined;
    for (const part of words.segment(kept)) if (part.isWordLike) last = part;
    if (!last || !DANGLING_WORDS.has(last.segment.toLowerCase())) return kept;
    const rest = kept.slice(0, last.index).replace(trailingMarks, "");
    if (rest === "") return kept;
    kept = rest;
  }
}

/** Whether the character at `index` ends a clause: a Chinese mark, or a comma, semicolon or colon before a space. */
function endsClause(characters: readonly string[], index: number): boolean {
  const mark = characters[index];
  if (mark === undefined) return false;
  return "，；：。？！".includes(mark) || (",;:".includes(mark) && characters[index + 1] === " ");
}

/**
 * The text's first line, cut to about `NAME_LENGTH` characters without trailing
 * punctuation, at a word (Chinese words too). The cut never leaves a half
 * sentence: it falls back to the last clause mark when that keeps at least half
 * of the cut ("…per year" rather than "…per year, plus"), and drops a word such as
 * "the" or "plus", or a Chinese 的 or 和, left at its end. Empty when the text has
 * no first line.
 */
export function cutTitle(raw: string): string {
  const first = (raw.split(/\r?\n/).find((line) => line.trim() !== "") ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(first);
  if (characters.length <= NAME_LENGTH) return first.replace(trailingMarks, "");
  const end = wordEnd(first, NAME_LENGTH);
  for (let index = end - 1; index >= Math.max(MIN_CLAUSE, end / 2); index--) {
    if (endsClause(characters, index)) {
      return withoutDanglingEnd(characters.slice(0, index).join(""));
    }
  }
  return withoutDanglingEnd(characters.slice(0, end).join(""));
}

/**
 * `text` cut to at most `limit` characters at a word, as `cutTitle` cuts,
 * for a name that has room for more than a title, such as a file's.
 */
export function cutAtWord(text: string, limit: number): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return withoutDanglingEnd(characters.slice(0, wordEnd(text, limit)).join(""));
}

/**
 * `name` shortened to one line: kept whole if `fits` says it fits, else cut and ended with "…",
 * so the longest start that fits shows. `atWords` cuts at a word, as English needs; without it,
 * anywhere, as Chinese reads, where a character is a cut a reader accepts.
 */
export function fitName(name: string, fits: (text: string) => boolean, atWords = true): string {
  if (fits(name)) return name;
  const characters = Array.from(name);
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(`${characters.slice(0, middle).join("")}…`)) low = middle;
    else high = middle - 1;
  }
  const shown = Math.max(low, 1);
  const kept = withoutDanglingEnd(
    characters.slice(0, atWords ? wordEnd(name, shown) : shown).join(""),
  );
  return `${kept || characters.slice(0, shown).join("")}…`;
}

const wide =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const columnsOf = (character: string): number => (wide.test(character) ? 2 : 1);

/**
 * `text` cut in the middle to at most `max` columns, ended and joined by "…", so its start and its
 * end stay: a web address keeps its site and its page, a file its extension. A Latin character is
 * a column and a Chinese, Japanese or Korean one two, as they are drawn.
 */
export function shortenMiddle(text: string, max: number): string {
  const characters = Array.from(text);
  if (characters.reduce((sum, character) => sum + columnsOf(character), 0) <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  const kept = (from: readonly string[], room: number): string[] => {
    const taken: string[] = [];
    let used = 0;
    for (const character of from) {
      used += columnsOf(character);
      if (used > room) break;
      taken.push(character);
    }
    return taken;
  };
  return `${kept(characters, head).join("")}…${kept(characters.toReversed(), tail).toReversed().join("")}`;
}

/** Wide enough for a name that reads, narrow enough that a sentence holding it stays in a few lines in a half-width group or the sidebar. */
export const NAME_IN_LINE_COLUMNS = 40;

/** A name inside a line or sentence, cut in the middle; the line's own words are never cut. */
export const nameInLine = (name: string): string => shortenMiddle(name, NAME_IN_LINE_COLUMNS);

/** What a Mind is called: the title the User typed, else its first line of text. Empty when it has neither. */
export const mindName = (mind: { title: string; autoTitle: string }): string =>
  mind.title || mind.autoTitle;

/**
 * What a conversation is called: the title the User typed, else its own name (its first
 * Question, cut, or the model's short title). Empty when it has neither: "New chat".
 */
export const conversationName = (conversation: { title: string; autoTitle: string }): string =>
  conversation.title || conversation.autoTitle;

/** The first of "{name} 2", "{name} 3"… that none of `taken` is; null when none of `taken` is `name`. */
export function numberedName(name: string, taken: readonly string[]): string | null {
  const names = new Set(taken.map((each) => each.trim().toLocaleLowerCase()));
  if (name.trim() === "" || !names.has(name.trim().toLocaleLowerCase())) return null;
  for (let next = 2; ; next++) {
    const numbered = `${name} ${next}`;
    if (!names.has(numbered.toLocaleLowerCase())) return numbered;
  }
}
