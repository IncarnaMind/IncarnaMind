/**
 * Inline citations carried inside `propose_changes`, `create_mind`, and `save_as_word` (#3753):
 * - sentence handles from `cited: true` (`[cite:<handle>.<n>]`, plus lists/ranges such as
 *   `[cite:<handle>.2-3]` or `[cite:<handle>.2, <handle>.3]`)
 * - inline exact quotes (`[cite:passageId: exact quote]` or `[cite:path: exact quote]`, with
 *   ASCII or full-width `:`/`：` and `|`/`｜` separators)
 * Every non-minted `[cite:…]` tag (including malformed or unclosed tags and bare handles without
 * `.n`) is parsed and either confirmed word-for-word into real minted tokens or stripped cleanly
 * with a plain-words report so no raw `[cite:…]` text or `[quote not found]` lands in the Note.
 */

export interface SentenceRef {
  handle: string;
  index: number;
}

export type ParsedInlineTag =
  | { kind: "sentence"; handle: string; index: number; raw: string }
  | { kind: "sentence-list"; refs: readonly SentenceRef[]; raw: string }
  | { kind: "passage"; ref: string; quote: string; raw: string }
  | { kind: "file"; ref: string; quote: string; raw: string }
  | { kind: "malformed"; raw: string };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const MINTED_TOKEN_INNER = /^[a-z0-9]{8}$/;
export const SENTENCE_REF_INNER = /^([a-z2-9]{5,6})\.([1-9]\d{0,4})$/;
export const SENTENCE_REF_TAG = /^\[cite:([a-z2-9]{5,6})\.([1-9]\d{0,4})\]$/;
export const SENTENCE_REF_GLOBAL = /\[cite:([a-z2-9]{5,6})\.([1-9]\d{0,4})\]/g;
export const CITATION_OR_HANDLE_TAG = /\[cite:([a-z0-9]{1,32}|[a-z2-9]{5,6}\.[1-9]\d{0,4})\]/g;
export const CITATION_OR_HANDLE_EXACT = /^\[cite:([a-z0-9]{1,32}|[a-z2-9]{5,6}\.[1-9]\d{0,4})\]$/;

const LIST_ITEM_WITH_HANDLE =
  /^([a-z2-9]{5,6})\.([1-9]\d{0,4})(?:\s*[-–—]\s*(?:([a-z2-9]{5,6})\.)?([1-9]\d{0,4}))?$/;
const LIST_ITEM_SHORTHAND = /^\.?([1-9]\d{0,4})(?:\s*[-–—]\s*\.?([1-9]\d{0,4}))?$/;
const MAX_RANGE_SPAN = 20;
const MAX_LIST_REFS = 40;
const QUOTE_SEPARATORS = new Set([":", "：", "|", "｜"]);

const looksLikePath = (ref: string) =>
  ref.startsWith("/") || ref.startsWith("~") || WINDOWS_DRIVE.test(ref) || ref.includes("\\");

function findQuoteSeparator(inner: string): number {
  const from = WINDOWS_DRIVE.test(inner) ? 2 : 0;
  for (let i = from; i < inner.length; i++) {
    if (QUOTE_SEPARATORS.has(inner[i] ?? "")) return i;
  }
  return -1;
}

function parseSentenceList(inner: string): SentenceRef[] | null {
  const parts = inner
    .split(/[,，、;；]+/)
    .map((each) => each.trim())
    .filter((each) => each !== "");
  if (parts.length === 0) return null;
  const refs: SentenceRef[] = [];
  let lastHandle: string | null = null;
  for (const part of parts) {
    const full = LIST_ITEM_WITH_HANDLE.exec(part);
    if (full?.[1] && full[2]) {
      const handle = full[1];
      const start = Number(full[2]);
      const endHandle = full[3];
      const end = full[4] ? Number(full[4]) : start;
      if (endHandle && endHandle !== handle) return null;
      if (end < start || end - start + 1 > MAX_RANGE_SPAN) return null;
      for (let index = start; index <= end; index++) {
        refs.push({ handle, index });
        if (refs.length > MAX_LIST_REFS) return null;
      }
      lastHandle = handle;
      continue;
    }
    const short = lastHandle ? LIST_ITEM_SHORTHAND.exec(part) : null;
    if (short?.[1] && lastHandle) {
      const start = Number(short[1]);
      const end = short[2] ? Number(short[2]) : start;
      if (end < start || end - start + 1 > MAX_RANGE_SPAN) return null;
      for (let index = start; index <= end; index++) {
        refs.push({ handle: lastHandle, index });
        if (refs.length > MAX_LIST_REFS) return null;
      }
      continue;
    }
    return null;
  }
  return refs.length > 0 ? refs : null;
}

function endOfFence(source: string, from: number, char: string, length: number): number {
  let at = from;
  while (at < source.length) {
    const lineEnd = source.indexOf("\n", at);
    const end = lineEnd === -1 ? source.length : lineEnd + 1;
    const rawLine = source.slice(at, lineEnd === -1 ? source.length : lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    let i = 0;
    while (i < 3 && i < line.length && line[i] === " ") i++;
    let run = 0;
    while (i + run < line.length && line[i + run] === char) run++;
    if (run >= length && /^[ \t]*$/.test(line.slice(i + run))) return end;
    at = end;
  }
  return source.length;
}

function endOfCodeSpan(source: string, from: number, ticks: number): number {
  let at = from;
  while (at < source.length) {
    if (source[at] === "\n" && source[at + 1] === "\n") return -1;
    if (source[at] === "`") {
      let run = 0;
      while (at + run < source.length && source[at + run] === "`") run++;
      if (run === ticks) return at + run;
      at += run;
      continue;
    }
    at++;
  }
  return -1;
}

/**
 * Parses a `[cite:...` tag starting at `at`. Returns `null` only for valid 8-character minted
 * tokens (`[cite:<token>]`), which `tokensIn` resolves directly. Every other `[cite:...` form —
 * sentence handles, handle lists/ranges, inline quotes, bare handles without `.n`, malformed tags,
 * and unclosed tags — returns a `ParsedInlineTag`.
 */
function matchInlineTag(
  source: string,
  at: number,
  lineUnclosedBrackets: number,
  inTableRow: boolean,
): { tag: ParsedInlineTag; end: number } | null {
  if (!source.startsWith("[cite:", at)) return null;
  const innerStart = at + "[cite:".length;
  let i = innerStart;
  let depth = 0;
  let end = -1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") {
      const stop = i > at && source[i - 1] === "\r" ? i - 1 : i;
      return { tag: { kind: "malformed", raw: source.slice(at, stop) }, end: stop };
    }
    if (ch === "[") {
      // A new `[cite:` before the current tag closes means the earlier tag had an unbalanced `[`.
      if (!isEscaped(source, i) && source.startsWith("[cite:", i)) {
        const raw = source.slice(at, i).trimEnd();
        return { tag: { kind: "malformed", raw }, end: i };
      }
      if (!isEscaped(source, i)) depth++;
    } else if (ch === "]" && !isEscaped(source, i)) {
      if (depth === 0) {
        end = i + 1;
        break;
      }
      depth--;
    }
    i++;
  }
  if (end === -1) {
    return { tag: { kind: "malformed", raw: source.slice(at) }, end: source.length };
  }

  let inner = source.slice(innerStart, end - 1);
  if (MINTED_TOKEN_INNER.test(inner)) return null;

  // When a quote itself contains an unescaped bare `]` (e.g. `Step 1] open gate.`), extend to an
  // unescaped closing `]` on the same line only if nothing after `end` crosses a sentence break,
  // another `[`, an escaped `\]`, or a table cell boundary, and prose before `[cite:` didn't open `[`.
  const afterClose = source[end];
  const looksCompleteBeforeProse =
    /[.!?。！？]$/.test(inner.trimEnd()) &&
    (afterClose === "." || afterClose === "。" || afterClose === " " || afterClose === "\t");
  if (
    !looksCompleteBeforeProse &&
    lineUnclosedBrackets === 0 &&
    !SENTENCE_REF_INNER.test(inner) &&
    parseSentenceList(inner) === null &&
    findQuoteSeparator(inner) !== -1
  ) {
    let scan = end;
    let lastRight = -1;
    while (scan < source.length) {
      const ch = source[scan];
      if (ch === "\n" || ch === "[" || (inTableRow && ch === "|")) break;
      if (
        (ch === "." || ch === "!" || ch === "?" || ch === "。" || ch === "！" || ch === "？") &&
        (source[scan + 1] === " " || source[scan + 1] === "\t")
      ) {
        break;
      }
      if (ch === "]" && !isEscaped(source, scan)) lastRight = scan;
      scan++;
    }
    if (lastRight !== -1) {
      end = lastRight + 1;
      inner = source.slice(innerStart, end - 1);
    }
  }

  const raw = source.slice(at, end);
  const sentenceMatch = SENTENCE_REF_INNER.exec(inner);
  if (sentenceMatch?.[1] && sentenceMatch[2]) {
    return {
      tag: {
        kind: "sentence",
        handle: sentenceMatch[1],
        index: Number(sentenceMatch[2]),
        raw,
      },
      end,
    };
  }
  const list = parseSentenceList(inner);
  if (list) {
    return { tag: { kind: "sentence-list", refs: list, raw }, end };
  }
  const sep = findQuoteSeparator(inner);
  if (sep !== -1) {
    const ref = inner.slice(0, sep).trim();
    const quote = inner.slice(sep + 1).trim();
    if (ref !== "" && quote !== "") {
      return {
        tag: {
          kind: looksLikePath(ref) ? "file" : "passage",
          ref,
          quote,
          raw,
        },
        end,
      };
    }
  }
  return { tag: { kind: "malformed", raw }, end };
}

function isEscaped(source: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Scans `source` outside fenced code blocks and inline code spans, rewriting inline quote tags. */
function scanOne(
  source: string,
  replace: ((tag: ParsedInlineTag) => string | null) | null,
  found: ParsedInlineTag[],
): string {
  let out = "";
  let at = 0;
  let lineStart = true;
  let lineUnclosedBrackets = 0;
  let inTableRow = false;

  const resetLine = () => {
    lineStart = true;
    lineUnclosedBrackets = 0;
    inTableRow = false;
  };

  const stripAt = (after: number): number => {
    const atLineEnd =
      after >= source.length ||
      source[after] === "\n" ||
      (source[after] === "\r" && source[after + 1] === "\n");
    let trimmed = out.length;
    while (trimmed > 0 && (out[trimmed - 1] === " " || out[trimmed - 1] === "\t")) trimmed--;
    const trailing = out.slice(trimmed);
    const keepHardBreak = atLineEnd && /^ {2,}$/.test(trailing);
    const followedByNextTag = after < source.length && source.startsWith("[cite:", after);
    if (!keepHardBreak) {
      out = out.slice(0, trimmed);
      if (
        followedByNextTag &&
        trailing.length > 0 &&
        out.length > 0 &&
        out[out.length - 1] !== "\n"
      ) {
        out += " ";
      }
    }
    let next = after;
    if (out.length === 0 || out[out.length - 1] === "\n") {
      while (next < source.length && (source[next] === " " || source[next] === "\t")) next++;
      // Prevent stripping a leading tag from turning non-fence text into a Markdown code fence.
      if (FENCE_OPEN.test(source.slice(next))) out += "\\";
    }
    return next;
  };

  while (at < source.length) {
    if (lineStart) {
      const fence = FENCE_OPEN.exec(source.slice(at));
      if (fence?.[1]) {
        const mark = fence[1];
        const info = fence[2] ?? "";
        if (mark[0] !== "`" || !info.includes("`")) {
          const newline = source.indexOf("\n", at);
          const bodyStart = newline === -1 ? source.length : newline + 1;
          const end =
            newline === -1
              ? source.length
              : endOfFence(source, bodyStart, mark[0] ?? "`", mark.length);
          out += source.slice(at, end);
          at = end;
          resetLine();
          continue;
        }
      }
      inTableRow = /^ {0,3}\|/.test(source.slice(at, at + 4));
    }
    const ch = source[at];
    if (ch === "`") {
      let ticks = 0;
      while (at + ticks < source.length && source[at + ticks] === "`") ticks++;
      const close = endOfCodeSpan(source, at + ticks, ticks);
      if (close !== -1) {
        out += source.slice(at, close);
        if (source[close - 1] === "\n") resetLine();
        else lineStart = false;
        at = close;
        continue;
      }
      out += source.slice(at, at + ticks);
      lineStart = false;
      at += ticks;
      continue;
    }
    if (ch === "[" && !isEscaped(source, at) && source.startsWith("[cite:", at)) {
      const matched = matchInlineTag(source, at, lineUnclosedBrackets, inTableRow);
      if (matched) {
        if (replace === null) {
          found.push(matched.tag);
          out += source.slice(at, matched.end);
          at = matched.end;
          lineStart = false;
        } else {
          const put = replace(matched.tag);
          if (put !== null) {
            out += put;
            at = matched.end;
            lineStart = false;
          } else {
            at = stripAt(matched.end);
            // Keep lineStart tied to the original source line, not post-strip output spacing.
            lineStart = false;
          }
        }
        continue;
      }
    }
    if (ch === "[" && !isEscaped(source, at)) {
      lineUnclosedBrackets++;
    } else if (ch === "]" && !isEscaped(source, at) && lineUnclosedBrackets > 0) {
      lineUnclosedBrackets--;
    }
    out += ch;
    if (ch === "\n") resetLine();
    else lineStart = false;
    at++;
  }
  return out;
}

export function findInlineQuoteTags(texts: readonly string[]): ParsedInlineTag[] {
  const found: ParsedInlineTag[] = [];
  for (const each of texts) scanOne(each, null, found);
  return found;
}

export function rewriteInlineQuoteTags(
  texts: readonly string[],
  resolve: (tag: ParsedInlineTag) => string | null,
): string[] {
  const dummy: ParsedInlineTag[] = [];
  return texts.map((each) => scanOne(each, resolve, dummy));
}
