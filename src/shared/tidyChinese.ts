/**
 * Tidying Chinese typography in text a User wrote (docs/agents/zh-CN.md, rules 2–4): one space
 * between Chinese and Latin letters or numbers, full-width punctuation in Chinese sentences, and
 * Chinese quotation marks. It never touches code; callers leave code blocks and code runs out.
 *
 * `before` and `after` are the characters just outside the text, where it is one run of a
 * paragraph: a punctuation mark at its end goes by the word it really follows.
 */
export interface TidyContext {
  before?: string;
  after?: string;
  /** false: leave a run's outer edges to the caller, which joins the runs itself. Default true. */
  edgeSpaces?: boolean;
  /** Whether the text's own first edge takes a context space; default true. */
  leading?: boolean;
  /** Whether the text's own last edge takes a context space; default true. */
  trailing?: boolean;
}

const HAN = /\p{Script=Han}/u;
const HAN_CHAR = /\p{Script=Han}/u;
const WORD_CHAR = /[A-Za-z0-9À-ɏ]/u;
const DIGIT = /\p{Nd}/u;

const FULL_WIDTH_PUNCTUATION = "，。：；？！（）、“”‘’《》";
const FULL_WIDTH = new Set([...FULL_WIDTH_PUNCTUATION]);

const isHan = (char: string | undefined) => char !== undefined && HAN_CHAR.test(char);
const isWord = (char: string | undefined) => char !== undefined && WORD_CHAR.test(char);
const isDigit = (char: string | undefined) => char !== undefined && DIGIT.test(char);
const isSpace = (char: string | undefined) => char === " " || char === "\t" || char === "\n";

/** The last character before `at` that isn't a space; `context` when the text has none. */
function before(text: string, at: number, context: TidyContext): string | undefined {
  for (let index = at - 1; index >= 0; index--) {
    const char = text[index];
    if (!isSpace(char)) return char;
  }
  return context.before;
}

/** The first character after `at` that isn't a space; `context` when the text has none. */
function after(text: string, at: number, context: TidyContext): string | undefined {
  for (let index = at + 1; index < text.length; index++) {
    const char = text[index];
    if (!isSpace(char)) return char;
  }
  return context.after;
}

/** Whether the token ending just before `at` has a digit in it: `5kg`, `Model3`, `report2.docx`. */
function tokenHasDigit(text: string, at: number): boolean {
  let found = false;
  for (let index = at - 1; index >= 0; index--) {
    const char = text[index] ?? "";
    if (!/[A-Za-z0-9._%+-]/.test(char)) break;
    if (isDigit(char)) found = true;
  }
  return found;
}

/** Whether the pair of parentheses starting at `at` is whole: no other parenthesis inside. */
function closedAt(text: string, at: number): number {
  for (let index = at + 1; index < text.length; index++) {
    if (text[index] === "(") return -1;
    if (text[index] === ")") return index;
  }
  return -1;
}

/**
 * Half-width punctuation that belongs to Chinese text becomes full-width: after a Chinese
 * character, or a parenthesis in a paragraph that is Chinese. A mark inside a number, a time, an
 * address or English text stays half-width.
 */
function fullWidthPunctuation(
  text: string,
  context: TidyContext,
  skip: (index: number) => boolean = () => false,
): string {
  const chinese = HAN.test(text);
  const replaced = new Map<number, string>();
  let at = 0;
  for (const char of text) {
    const index = at;
    at += char.length;
    if (skip(index)) continue;
    const previous = before(text, index, context);
    const next = after(text, index, context);
    const convert = (mark: string) => replaced.set(index, mark);
    switch (char) {
      case ",":
        // A comma in Chinese text, even after a Latin word or address: `main.py，运行`; a number's
        // comma stays, and so does an English paragraph's. A measurement or model name with a
        // digit in it marks the text as mixed Chinese too (`5kg，Model3`).
        if ((isHan(previous) || chinese || tokenHasDigit(text, index)) && !isDigit(next)) {
          convert("，");
        }
        break;
      case ".":
        // A decimal point, a file name's dot and an address's dot keep their place.
        if (isHan(previous) && !isDigit(next)) convert("。");
        break;
      case ":":
        if (isHan(previous) && !isDigit(previous) && !isDigit(next)) convert("：");
        break;
      case ";":
        if (isHan(previous)) convert("；");
        break;
      case "?":
        if (isHan(previous)) convert("？");
        break;
      case "!":
        if (isHan(previous)) convert("！");
        break;
      case "(": {
        const close = closedAt(text, index);
        // An English paragraph keeps its parentheses; a Chinese one writes them full-width.
        if (close !== -1 && skip(close)) break;
        if (isHan(previous) || (chinese && close !== -1)) {
          convert("（");
          replaced.set(close, "）");
        }
        break;
      }
      case ")":
        // Whole pairs are handled with their "("; a lone ")" after Chinese text is too.
        if (isHan(previous) && !replaced.has(index)) convert("）");
        break;
      default:
        break;
    }
  }
  if (replaced.size === 0) return text;
  let out = "";
  at = 0;
  for (const char of text) {
    out += replaced.get(at) ?? char;
    at += char.length;
  }
  return out;
}

/**
 * Straight quotation marks become Chinese ones, in a paragraph that is Chinese: “ ” and ‘ ’.
 * A straight mark outside a protected name pairs with one on the other side of it, so quotes
 * around an email or a file name become curly while the name stays as written.
 */
function curlyQuotes(text: string, chinese: boolean, skip: (index: number) => boolean): string {
  if (!chinese) return text;
  let out = text.replaceAll("「", "“").replaceAll("」", "”");
  out = out.replaceAll("『", "‘").replaceAll("』", "’");
  const doubles: number[] = [];
  let at = 0;
  for (const char of out) {
    if (char === '"' && !skip(at)) doubles.push(at);
    at += char.length;
  }
  // An unpaired mark in this run may close one in another run: leaves both as they are.
  if (doubles.length > 0 && doubles.length % 2 === 0) {
    const replaced = new Map<number, string>();
    doubles.forEach((index, order) => {
      replaced.set(index, order % 2 === 0 ? "“" : "”");
    });
    let built = "";
    at = 0;
    for (const char of out) {
      built += replaced.get(at) ?? char;
      at += char.length;
    }
    out = built;
  }
  let open = true;
  out = out.replace(/'(?![A-Za-z])|(?<![A-Za-z])'/g, (match, offset: number) => {
    if (skip(offset)) return match;
    const mark = open ? "‘" : "’";
    open = !open;
    return mark;
  });
  return out;
}

/** No space next to full-width punctuation, as Chinese text sets it. */
function withoutSpacesBesideFullWidth(text: string, context: TidyContext): string {
  const mark = (char: string | undefined) => char !== undefined && FULL_WIDTH.has(char);
  let out = text;
  if (mark(context.before)) out = out.replace(/^[ \t]+/u, "");
  if (mark(context.after)) out = out.replace(/[ \t]+$/u, "");
  out = out
    .replace(/[ \t]+(?=[，。：；？！（）、“”‘’《》])/gu, "")
    .replace(/(?<=[，。：；？！（）、“”‘’《》])[ \t]+/gu, "");
  return out;
}

/** One space between a Chinese character and a Latin letter or a digit, either way. */
function spacesBetweenScripts(text: string, context: TidyContext): string {
  let out = text;
  out = out.replace(/(\p{Script=Han})(?=[A-Za-z0-9])/gu, "$1 ");
  out = out.replace(/([A-Za-z0-9])(?=\p{Script=Han})/gu, "$1 ");
  if (context.edgeSpaces === false) return out;
  if (out.length > 0) {
    if (context.leading !== false) {
      const first = out[0];
      if (isHan(first) && isWord(context.before)) out = ` ${out}`;
      if (isWord(first) && isHan(context.before)) out = ` ${out}`;
    }
    if (context.trailing !== false) {
      const last = out.at(-1);
      if (isHan(last) && isWord(context.after)) out = `${out} `;
      if (isWord(last) && isHan(context.after)) out = `${out} `;
    }
  }
  return out;
}

/**
 * File names, web and email addresses, and paths: settings a tidy must leave
 * exactly as written. Each protects what punctuation could change, not the
 * words a clause uses to reach it: a file's extension, the domain of an email
 * or address, or the whole path, so the Chinese around it is still tidied.
 */
const FILE_EXTENSION =
  "(?:docx?|pdf|xlsx?|pptx?|txt|md|csv|tsv|png|jpe?g|gif|svg|zip|json|html?|xml|ya?ml|toml|py|ts|tsx|js|jsx|mp3|mp4|mov|wav|rtf|pages|numbers|key|ppt|doc|xls|epub|tex|bib)";
const ADDRESSES: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s,;，。；：！？、()（）“”‘’《》\p{Script=Han}]+/giu,
  /@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/gu,
  new RegExp(`[A-Za-z0-9._%+'-]+\\.${FILE_EXTENSION}(?![A-Za-z0-9])`, "giu"),
  new RegExp(`\\.${FILE_EXTENSION}(?![A-Za-z0-9])`, "giu"),
  /[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?:[/\\?#][^\s,;，。；：！？、()（）“”‘’《》\p{Script=Han}]*)?/gu,
  /(?<=\p{Script=Han})\.[A-Za-z]{2,}(?:[/\\?#][^\s,;，。；：！？、()（）“”‘’《》]*)?/gu,
  /[A-Za-z0-9._%+'-]+(?:[\\/][A-Za-z0-9._%+'-]+)+/gu,
  /[A-Za-z]:\\[^\s,;，。；：！？、()（）“”‘’《》]+/gu,
  /www\.[^\s,;，。；：！？、()（）“”‘’《》\p{Script=Han}]+/giu,
];

/** Where an address, a file name or a path is, so the tidy leaves those characters alone. */
function protectedRanges(text: string): { start: number; end: number }[] {
  // No address, file name or path can start without one of these: a long run of Chinese
  // text skips the scans, which would otherwise try every character.
  if (!/[.\\/@]/.test(text)) return [];
  const found: { start: number; end: number }[] = [];
  for (const pattern of ADDRESSES) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const start = match.index ?? 0;
      found.push({ start, end: start + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of found) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** One stretch of ordinary text, tidied as it is. */
function tidyPiece(text: string, context: TidyContext): string {
  const out = withoutSpacesBesideFullWidth(text, context);
  return spacesBetweenScripts(out, context);
}

/** `text` set as Chinese text is: spaces between scripts, full-width punctuation, Chinese quotes. */
export function tidyChinese(text: string, context: TidyContext = {}): string {
  if (text === "") return text;
  const ranges = protectedRanges(text);
  const protectedChars = new Uint8Array(text.length);
  for (const range of ranges) protectedChars.fill(1, range.start, range.end);
  const inRange = (index: number) => protectedChars[index] === 1;
  // Full-width punctuation sees the whole run, so a pair around a protected address still pairs.
  const punctuated = fullWidthPunctuation(text, context, inRange);
  // A name marks the text as mixed Chinese even without a Han character: `"zhang@example.com"`.
  const quoted = curlyQuotes(punctuated, HAN.test(text) || ranges.length > 0, inRange);
  if (ranges.length === 0) return tidyPiece(quoted, context);
  let out = "";
  let at = 0;
  const piece = (from: number, to: number) => {
    if (to <= from) return;
    // A piece beside a protected name is still inside the run: its edge takes a space even when
    // the run's own outer edges are left to the caller (a Note joins its runs itself).
    const outerLeading = context.edgeSpaces !== false && context.leading !== false;
    const outerTrailing = context.edgeSpaces !== false && context.trailing !== false;
    out += tidyPiece(quoted.slice(from, to), {
      before: from > 0 ? quoted[from - 1] : context.before,
      after: to < quoted.length ? quoted[to] : context.after,
      edgeSpaces: true,
      leading: from > 0 || outerLeading,
      trailing: to < quoted.length || outerTrailing,
    });
  };
  for (const range of ranges) {
    piece(at, range.start);
    out += quoted.slice(range.start, range.end);
    at = range.end;
  }
  piece(at, quoted.length);
  return out;
}
