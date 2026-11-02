/**
 * A small Markdown reader for the Document viewer, for CommonMark and the
 * GitHub extensions people write notes in: headings (# and underlined),
 * paragraphs with hard line breaks, emphasis, strikethrough, code, links
 * (inline, by reference, and bare web addresses), images, lists (nested,
 * numbered from any number, and task lists), quotes holding any of these,
 * fenced and indented code with its language, tables with their alignment,
 * front matter and rules. It never produces HTML: the view renders this tree
 * with React, which escapes all text, so raw HTML in a file stays text.
 *
 * Every piece of text points back into the source (`start`/`end`), so a quote
 * found in the source can be highlighted where it is rendered.
 */
import {
  type CellRange,
  delimiterRow,
  type TableAlign,
  tableCellRanges,
} from "../../../shared/markdownTables";

export type Inline =
  | { kind: "text"; start: number; end: number }
  | { kind: "code"; start: number; end: number }
  | { kind: "strong" | "em" | "strike"; children: Inline[] }
  /** `href` is null for links the viewer won't follow (only http, https and mailto are). */
  | { kind: "link"; href: string | null; children: Inline[] }
  /** `src` as written: a path beside the file, a web address, or a `data:` URL. */
  | { kind: "image"; src: string; alt: string }
  /** A hard line break: two spaces or a backslash at the end of a line. */
  | { kind: "break" };

export type Align = TableAlign;

export interface ListItem {
  /** The item's first paragraph. */
  inlines: Inline[];
  /** A task list item's box: ticked or not; null for an ordinary item. */
  checked: boolean | null;
  /** What follows in the item: nested lists, more paragraphs, code. */
  children: Block[];
}

export type Block =
  /** `section`: a "#" heading that starts a section, as the file's Units count them (core/documents/formats/text). */
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[]; section: boolean }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  /** Shown verbatim in a monospaced font: code, with its language if it names one. */
  | { kind: "verbatim"; start: number; end: number; language?: string }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  /** YAML front matter at the top of the file, shown as it is. */
  | { kind: "frontMatter"; start: number; end: number }
  | { kind: "rule" };

/** A line, or what is left of one inside a quote or a list item. */
interface Line {
  start: number;
  /** Excludes the line break. */
  end: number;
  text: string;
  /** The whole line as written, for telling which "#" headings start sections. */
  raw: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( {0,3})(?:([-*+])|(\d{1,9})([.)]))(?:[ \t]+|$)/;
const TASK = /^\[([ xX])\][ \t]+/;
const DEFINITION =
  /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const BLANK = /^[ \t]*$/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const SAFE_LINK = /^(?:https?:|mailto:)/i;
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<]+/i;

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    // A Windows line end's "\r" isn't part of the line's text.
    const textEnd = end > start && source[end - 1] === "\r" ? end - 1 : end;
    const text = source.slice(start, textEnd);
    lines.push({ start, end: textEnd, text, raw: text });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

/** A line with its first `count` columns of indentation taken off. */
function outdent(line: Line, count: number): Line {
  let taken = 0;
  while (taken < count && taken < line.text.length && line.text[taken] === " ") taken++;
  if (taken < count && line.text[taken] === "\t") taken++;
  return { ...line, start: line.start + taken, text: line.text.slice(taken) };
}

/** How far a line is indented, in columns (a tab counts as 4). */
function indentOf(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns++;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

interface Context {
  source: string;
  /** Reference link definitions, by their label in lower case. */
  definitions: Map<string, string>;
  /** Text the file holds is shown as words, not read for emphasis, code or links (#762). */
  literal?: boolean;
}

/** Whether a line starts a block, so it ends a paragraph before it. */
function interrupts(text: string): boolean {
  if (FENCE.test(text) || HEADING.test(text) || RULE.test(text) || QUOTE.test(text)) return true;
  const item = LIST_ITEM.exec(text);
  // A numbered item interrupts a paragraph only if it starts at 1, and no empty item does.
  return !!item && text.slice(item[0].length).trim() !== "" && (!item[3] || item[3] === "1");
}

/** The cells of a table row, as ranges of the source, split at "|" outside code and escapes. */
function tableCells(line: Line): CellRange[] {
  return tableCellRanges(line.text).map(({ start, end }) => ({
    start: line.start + start,
    end: line.start + end,
  }));
}

/**
 * Inlines for lines that read as one run of text, joined by their line
 * breaks: a hard break where a line ends in two spaces or a backslash.
 */
function joinLines(context: Context, lines: readonly Line[]): Inline[] {
  const inlines: Inline[] = [];
  lines.forEach((line, index) => {
    let start = line.start;
    while (start < line.end && /[ \t]/.test(context.source[start] as string)) start++;
    let end = line.end;
    const last = index === lines.length - 1;
    let hard = false;
    if (!last) {
      if (context.source[end - 1] === "\\") {
        hard = true;
        end--;
      } else if (/ {2,}$/.test(line.text)) hard = true;
    }
    while (end > start && /[ \t]/.test(context.source[end - 1] as string)) end--;
    inlines.push(...parseInlines(context, start, end));
    if (!last) {
      // The line break: a real character of the source, shown as a space, or a hard break.
      inlines.push(hard ? { kind: "break" } : { kind: "text", start: line.end, end: line.end + 1 });
    }
  });
  return inlines;
}

/** Reference definitions ("[label]: url") anywhere outside code, which links use. */
function readDefinitions(lines: readonly Line[]): {
  definitions: Map<string, string>;
  at: Set<number>;
} {
  const definitions = new Map<string, string>();
  const at = new Set<number>();
  let fence: string | null = null;
  lines.forEach((line) => {
    const marker = FENCE.exec(line.text);
    if (fence !== null) {
      if (marker && line.text.trim().startsWith(fence) && /^[`~]+$/.test(line.text.trim()))
        fence = null;
      return;
    }
    if (marker) {
      fence = (marker[1] as string)[0] === "`" ? "```" : "~~~";
      return;
    }
    const definition = DEFINITION.exec(line.text);
    if (definition) {
      const label = (definition[1] as string).trim().toLowerCase();
      if (!definitions.has(label)) definitions.set(label, definition[2] as string);
      at.add(line.start);
    }
  });
  return { definitions, at };
}

/**
 * The index of each heading that starts a section, in reading order, as the
 * file's Units count them (only "#" headings, nested in lists too): the
 * outline and Citations go to them by it.
 */
export function sectionHeadings(blocks: readonly Block[]): Map<Block, number> {
  const headings = new Map<Block, number>();
  const visit = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.kind === "heading" && block.section) headings.set(block, headings.size);
      else if (block.kind === "quote") visit(block.blocks);
      else if (block.kind === "list") for (const item of block.items) visit(item.children);
    }
  };
  visit(blocks);
  return headings;
}

export function parseMarkdown(source: string, options: { literal?: boolean } = {}): Block[] {
  const lines = splitLines(source);
  const { definitions, at } = readDefinitions(lines);
  const context: Context = { source, definitions, ...(options.literal && { literal: true }) };
  const blocks: Block[] = [];
  let from = 0;
  // Front matter: "---" on the first line, closed by "---" or "...", holding no "#" heading
  // (which the file's Units would count as a section).
  if (lines[0]?.text === "---") {
    const close = lines.findIndex(
      (line, index) => index > 0 && index < 200 && (line.text === "---" || line.text === "..."),
    );
    const inside = lines.slice(1, close);
    if (close > 1 && !inside.some((line) => HEADING.test(line.text))) {
      blocks.push({
        kind: "frontMatter",
        start: (lines[1] as Line).start,
        end: (lines[close - 1] as Line).end,
      });
      from = close + 1;
    }
  }
  blocks.push(
    ...parseBlocks(
      context,
      lines.slice(from).filter((line) => !at.has(line.start)),
    ),
  );
  return blocks;
}

/** The blocks of some lines: the whole file, or what is inside a quote or a list item. */
function parseBlocks(context: Context, lines: readonly Line[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  const lineAt = (at: number) => lines[at] as Line;

  while (index < lines.length) {
    const line = lineAt(index);
    const { text } = line;

    if (BLANK.test(text)) {
      index++;
      continue;
    }

    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[1] as string;
      const language = (fence[2] ?? "")
        .trim()
        .split(/\s+/)[0]
        ?.replace(/^\{\.?|\}$/g, "");
      let close = index + 1;
      while (close < lines.length) {
        const candidate = lineAt(close).text.trim();
        if (candidate.startsWith(marker) && /^[`~]+$/.test(candidate)) break;
        close++;
      }
      const first = lines[index + 1];
      const last = lines[Math.min(close, lines.length) - 1];
      if (first && last && close > index + 1) {
        blocks.push({
          kind: "verbatim",
          start: first.start,
          end: last.end,
          ...(language ? { language: language.toLowerCase() } : {}),
        });
      }
      index = close + 1;
      continue;
    }

    const heading = HEADING.exec(text);
    if (heading) {
      const level = (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6;
      let end = line.end;
      // A closing run of #s isn't part of the heading.
      const closing = /[ \t]+#+[ \t]*$|[ \t]+$/.exec(text.slice(heading[0].length));
      if (closing) end = line.start + heading[0].length + closing.index;
      blocks.push({
        kind: "heading",
        level,
        inlines: parseInlines(context, line.start + heading[0].length, end),
        section: HEADING.test(line.raw),
      });
      index++;
      continue;
    }

    if (RULE.test(text)) {
      blocks.push({ kind: "rule" });
      index++;
      continue;
    }

    const below = lines[index + 1];
    const align = text.includes("|") && below ? delimiterRow(below.text) : null;
    if (align) {
      const head = tableCells(line);
      if (head.length === align.length) {
        const rows: Inline[][][] = [];
        index += 2;
        while (index < lines.length) {
          const row = lineAt(index);
          if (BLANK.test(row.text) || !row.text.includes("|") || interrupts(row.text)) break;
          const cells = tableCells(row);
          rows.push(
            align.map((_, column) => {
              const cell = cells[column];
              return cell ? parseInlines(context, cell.start, cell.end) : [];
            }),
          );
          index++;
        }
        blocks.push({
          kind: "table",
          align,
          head: head.map((cell) => parseInlines(context, cell.start, cell.end)),
          rows,
        });
        continue;
      }
    }

    if (QUOTE.test(text)) {
      // The quote's lines without their markers; a line without one carries on its paragraph.
      const inside: Line[] = [];
      while (index < lines.length) {
        const quoted = lineAt(index);
        const marker = QUOTE.exec(quoted.text);
        if (marker) {
          inside.push({
            ...quoted,
            start: quoted.start + marker[0].length,
            text: quoted.text.slice(marker[0].length),
          });
        } else if (
          !BLANK.test(quoted.text) &&
          !interrupts(quoted.text) &&
          inside.length > 0 &&
          !BLANK.test((inside.at(-1) as Line).text)
        ) {
          inside.push(quoted);
        } else break;
        index++;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(context, inside) });
      continue;
    }

    const item = LIST_ITEM.exec(text);
    if (item) {
      const { block, next } = parseList(context, lines, index);
      blocks.push(block);
      index = next;
      continue;
    }

    if (indentOf(text) >= 4) {
      // Indented code: up to the last indented line before a line that isn't.
      let last = index;
      let at = index;
      while (at < lines.length) {
        const candidate = lineAt(at);
        if (BLANK.test(candidate.text)) at++;
        else if (indentOf(candidate.text) >= 4) {
          last = at;
          at++;
        } else break;
      }
      const code = outdent(line, 4);
      blocks.push({ kind: "verbatim", start: code.start, end: lineAt(last).end });
      index = last + 1;
      continue;
    }

    // A paragraph, or an underlined (setext) heading.
    const paragraph = [line];
    index++;
    let underline: 1 | 2 | null = null;
    while (index < lines.length) {
      const next = lineAt(index);
      const setext = SETEXT.exec(next.text);
      if (setext) {
        underline = (setext[1] as string)[0] === "=" ? 1 : 2;
        index++;
        break;
      }
      if (BLANK.test(next.text) || interrupts(next.text)) break;
      paragraph.push(next);
      index++;
    }
    blocks.push(
      underline
        ? {
            kind: "heading",
            level: underline,
            inlines: joinLines(context, paragraph),
            section: false,
          }
        : { kind: "paragraph", inlines: joinLines(context, paragraph) },
    );
  }
  return blocks;
}

/** A list starting at `start`: its items, each with what is nested in it. */
function parseList(
  context: Context,
  lines: readonly Line[],
  start: number,
): { block: Block; next: number } {
  const first = LIST_ITEM.exec((lines[start] as Line).text) as RegExpExecArray;
  const ordered = first[2] === undefined;
  const marker = ordered ? first[4] : first[2];
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] as Line;
    const item = LIST_ITEM.exec(line.text);
    if (!item || (item[2] === undefined) !== ordered || (ordered ? item[4] : item[2]) !== marker) {
      break;
    }
    // The item's own lines: its first, then those indented under its text, and lazy ones.
    const rest = line.text.slice(item[0].length);
    const content = BLANK.test(rest)
      ? (item[1] as string).length + item[0].trim().length + 1
      : item[0].length;
    const own: Line[] = [{ ...line, start: line.start + item[0].length, text: rest }];
    index++;
    let blank = false;
    while (index < lines.length) {
      const next = lines[index] as Line;
      if (BLANK.test(next.text)) {
        blank = true;
        own.push(next);
        index++;
        continue;
      }
      if (indentOf(next.text) >= content) {
        own.push(outdent(next, content));
        blank = false;
        index++;
        continue;
      }
      if (!blank && !interrupts(next.text) && !LIST_ITEM.test(next.text)) {
        own.push(next); // a lazy continuation of the item's paragraph
        index++;
        continue;
      }
      break;
    }
    // Blank lines at the end belong between items, not in this one.
    while (own.length > 1 && BLANK.test((own.at(-1) as Line).text)) own.pop();
    const task = TASK.exec(rest);
    if (task) {
      const taskLine = own[0] as Line;
      own[0] = {
        ...taskLine,
        start: taskLine.start + task[0].length,
        text: taskLine.text.slice(task[0].length),
      };
    }
    const blocks = parseBlocks(context, own);
    const lead = blocks[0]?.kind === "paragraph" ? blocks.shift() : undefined;
    items.push({
      inlines: lead?.kind === "paragraph" ? lead.inlines : [],
      checked: task ? task[1] !== " " : null,
      children: blocks,
    });
    // A blank line may come between items of one list.
    let ahead = index;
    while (ahead < lines.length && BLANK.test((lines[ahead] as Line).text)) ahead++;
    if (ahead > index && ahead < lines.length && LIST_ITEM.test((lines[ahead] as Line).text)) {
      index = ahead;
    }
  }
  return {
    block: { kind: "list", ordered, start: ordered ? Number(first[3]) : 1, items },
    next: index,
  };
}

const isWordCharacter = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char);
const isSpace = (char: string | undefined) => !char || /\s/u.test(char);

/** The closing delimiter for emphasis opened at `from`, or -1. */
function closingDelimiter(source: string, delimiter: string, from: number, end: number): number {
  if (isSpace(source[from])) return -1;
  let at = source.indexOf(delimiter, from);
  while (at >= 0 && at + delimiter.length <= end) {
    const single = delimiter.length === 1;
    const doubled = single && (source[at + 1] === delimiter || source[at - 1] === delimiter);
    const underscoreInsideWord =
      delimiter[0] === "_" && isWordCharacter(source[at + delimiter.length]);
    if (at > from && !isSpace(source[at - 1]) && !doubled && !underscoreInsideWord) return at;
    at = source.indexOf(delimiter, at + delimiter.length);
  }
  return -1;
}

/** The `]` closing a bracket opened at `open`, with brackets inside balanced, or -1. */
function closingBracket(source: string, open: number, end: number): number {
  let depth = 0;
  for (let at = open; at < end; at++) {
    const char = source[at];
    if (char === "\\") at++;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return at;
  }
  return -1;
}

/** A link's destination after "](": up to its ")", with parentheses inside balanced. */
function destination(
  source: string,
  open: number,
  end: number,
): { href: string; close: number } | null {
  let at = open;
  while (at < end && /[ \t]/.test(source[at] as string)) at++;
  if (source[at] === "<") {
    const close = source.indexOf(">", at);
    if (close < 0 || close >= end) return null;
    const after = source.indexOf(")", close);
    return after >= 0 && after < end ? { href: source.slice(at + 1, close), close: after } : null;
  }
  let depth = 0;
  const from = at;
  for (; at < end; at++) {
    const char = source[at] as string;
    if (char === "\\") at++;
    else if (char === "(") depth++;
    else if (char === ")") {
      if (depth === 0) break;
      depth--;
    } else if (/\s/.test(char)) break;
  }
  const href = source.slice(from, at);
  // An optional title, then the ")".
  const close = source.indexOf(")", at);
  if (close < 0 || close >= end) return null;
  const between = source.slice(at, close).trim();
  if (between && !/^(?:"[^"]*"|'[^']*'|\([^)]*\))$/.test(between)) return null;
  return { href, close };
}

/** A web address written as it is, without the punctuation after it. */
function bareUrl(source: string, at: number, end: number): number {
  const match = BARE_URL.exec(source.slice(at, end));
  if (!match) return -1;
  let url = match[0];
  // Trailing punctuation, and a ")" with no "(" in the address, end a sentence, not the address.
  for (;;) {
    const trimmed = url.replace(/[.,:;!?"'*_~]+$/, "");
    if (
      trimmed.endsWith(")") &&
      (trimmed.match(/\(/g) ?? []).length < (trimmed.match(/\)/g) ?? []).length
    ) {
      url = trimmed.slice(0, -1);
      continue;
    }
    url = trimmed;
    break;
  }
  return url.length > 0 ? at + url.length : -1;
}

/** Parses the inline Markdown in `source` from `start` to `end`. */
function parseInlines(context: Context, start: number, end: number): Inline[] {
  const { source } = context;
  // A converted file's text is the words it holds: no "*", "_", "`" or "[" is markup.
  if (context.literal) return [{ kind: "text", start, end }];
  const inlines: Inline[] = [];
  let textStart = start;
  let at = start;
  const flush = (upTo: number) => {
    if (textStart < upTo) inlines.push({ kind: "text", start: textStart, end: upTo });
  };

  while (at < end) {
    const char = source[at] as string;

    if (char === "\\" && at + 1 < end && ESCAPABLE.test(source[at + 1] as string)) {
      flush(at);
      textStart = at + 1; // the escaped character starts the next run of text
      at += 2;
      continue;
    }

    if (char === "`") {
      let run = 1;
      while (source[at + run] === "`") run++;
      const fence = "`".repeat(run);
      let close = source.indexOf(fence, at + run);
      while (close >= 0 && source[close + run] === "`")
        close = source.indexOf(fence, close + run + 1);
      if (close >= 0 && close + run <= end) {
        flush(at);
        inlines.push({ kind: "code", start: at + run, end: close });
        at = close + run;
        textStart = at;
      } else {
        at += run;
      }
      continue;
    }

    if (char === "*" || char === "_" || (char === "~" && source[at + 1] === "~")) {
      const leftOk = char !== "_" || !isWordCharacter(source[at - 1]);
      const strike = char === "~";
      const strong = !strike && source[at + 1] === char;
      const delimiter = strike ? "~~" : strong ? char + char : char;
      const close = leftOk ? closingDelimiter(source, delimiter, at + delimiter.length, end) : -1;
      if (close >= 0) {
        flush(at);
        inlines.push({
          kind: strike ? "strike" : strong ? "strong" : "em",
          children: parseInlines(context, at + delimiter.length, close),
        });
        at = close + delimiter.length;
        textStart = at;
      } else {
        at += delimiter.length;
      }
      continue;
    }

    if (char === "<") {
      // An autolink: <https://example.com> or <name@example.com>.
      const close = source.indexOf(">", at);
      const inside = close > at && close < end ? source.slice(at + 1, close) : "";
      if (
        /^(?:https?:\/\/|mailto:)[^\s<>]+$/i.test(inside) ||
        /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(inside)
      ) {
        flush(at);
        const href =
          inside.includes("@") && !/^mailto:/i.test(inside) && !inside.includes("//")
            ? `mailto:${inside}`
            : inside;
        inlines.push({
          kind: "link",
          href,
          children: [{ kind: "text", start: at + 1, end: close }],
        });
        at = close + 1;
        textStart = at;
        continue;
      }
    }

    if (
      (char === "h" || char === "H" || char === "w" || char === "W") &&
      !isWordCharacter(source[at - 1])
    ) {
      const urlEnd = bareUrl(source, at, end);
      if (urlEnd > at) {
        flush(at);
        const url = source.slice(at, urlEnd);
        inlines.push({
          kind: "link",
          href: /^www\./i.test(url) ? `https://${url}` : url,
          children: [{ kind: "text", start: at, end: urlEnd }],
        });
        at = urlEnd;
        textStart = at;
        continue;
      }
    }

    if (char === "[" || (char === "!" && source[at + 1] === "[")) {
      const image = char === "!";
      const open = image ? at + 1 : at;
      const closeBracket = closingBracket(source, open, end);
      if (closeBracket >= 0) {
        let href: string | undefined;
        let after = closeBracket + 1;
        if (source[closeBracket + 1] === "(") {
          const target = destination(source, closeBracket + 2, end);
          if (target) {
            href = target.href;
            after = target.close + 1;
          }
        } else {
          // By reference: [text][label], [label][], or [label] alone.
          const label = /^\[([^\]]*)\]/.exec(source.slice(closeBracket + 1, end));
          const name = (label?.[1] || source.slice(open + 1, closeBracket)).trim().toLowerCase();
          const defined = context.definitions.get(name);
          if (defined !== undefined) {
            href = defined;
            after = closeBracket + 1 + (label?.[0].length ?? 0);
          }
        }
        if (href !== undefined) {
          flush(at);
          if (image) {
            inlines.push({ kind: "image", src: href, alt: source.slice(open + 1, closeBracket) });
          } else {
            inlines.push({
              kind: "link",
              href: SAFE_LINK.test(href) ? href : null,
              children: parseInlines(context, open + 1, closeBracket),
            });
          }
          at = after;
          textStart = at;
          continue;
        }
      }
    }

    at++;
  }
  flush(end);
  return inlines;
}
