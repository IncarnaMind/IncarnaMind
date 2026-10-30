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
function fullWidthPunctuation(text: string, context: TidyContext): string {
  const chinese = HAN.test(text);
  const replaced = new Map<number, string>();
  let at = 0;
  for (const char of text) {
    const index = at;
    at += char.length;
    const previous = before(text, index, context);
    const next = after(text, index, context);
    const convert = (mark: string) => replaced.set(index, mark);
    switch (char) {
      case ",":
        if (isHan(previous) && !isDigit(next)) convert("，");
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

/** Straight quotation marks become Chinese ones, in a paragraph that is Chinese: “ ” and ‘ ’. */
function curlyQuotes(text: string): string {
  if (!HAN.test(text)) return text;
  let out = text.replaceAll("「", "“").replaceAll("」", "”");
  out = out.replaceAll("『", "‘").replaceAll("』", "’");
  // An unpaired mark in this run may close one in another run: leaves both as they are.
  if ((out.match(/"/g) ?? []).length % 2 === 0) {
    let open = true;
    out = out.replace(/"/g, () => {
      const mark = open ? "“" : "”";
      open = !open;
      return mark;
    });
  }
  if ((out.match(/'/g) ?? []).length % 2 === 0) {
    let open = true;
    out = out.replace(/'(?![A-Za-z])|(?<![A-Za-z])'/g, () => {
      const mark = open ? "‘" : "’";
      open = !open;
      return mark;
    });
  }
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
  if (out.length > 0) {
    const first = out[0];
    if (isHan(first) && isWord(context.before)) out = ` ${out}`;
    if (isWord(first) && isHan(context.before)) out = ` ${out}`;
    const last = out.at(-1);
    if (isHan(last) && isWord(context.after)) out = `${out} `;
    if (isWord(last) && isHan(context.after)) out = `${out} `;
  }
  return out;
}

/** `text` set as Chinese text is: spaces between scripts, full-width punctuation, Chinese quotes. */
export function tidyChinese(text: string, context: TidyContext = {}): string {
  if (text === "") return text;
  let out = curlyQuotes(text);
  out = fullWidthPunctuation(out, context);
  out = withoutSpacesBesideFullWidth(out, context);
  out = spacesBetweenScripts(out, context);
  return out;
}
