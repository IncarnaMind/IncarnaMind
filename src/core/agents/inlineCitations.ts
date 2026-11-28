/**
 * Inline citations carried inside `propose_changes` and `create_mind` (#3753): an agent writes
 * `[cite:passageId: exact quote]` directly after a claim (or `[cite:path: exact quote]` outside a
 * run grant), saving a separate `cite` round-trip without colliding with Markdown table pipes (`|`)
 * or requiring marker-number indirection. IncarnaMind confirms each quote word for word before
 * minting a token; an unconfirmed quote is never attached and is stripped cleanly so no stray text
 * lands in the Note.
 */

export type ParsedInlineTag =
  | { kind: "sentence"; handle: string; index: number; raw: string }
  | { kind: "passage"; ref: string; quote: string; raw: string }
  | { kind: "file"; ref: string; quote: string; raw: string };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
export const SENTENCE_REF_INNER = /^([a-z2-9]{5})\.([1-9]\d{0,4})$/;
export const SENTENCE_REF_TAG = /^\[cite:([a-z2-9]{5})\.([1-9]\d{0,4})\]$/;

const looksLikePath = (ref: string) =>
  ref.startsWith("/") || ref.startsWith("~") || WINDOWS_DRIVE.test(ref) || ref.includes("\\");

function endOfFence(source: string, from: number, char: string, length: number): number {
  let at = from;
  while (at < source.length) {
    const lineEnd = source.indexOf("\n", at);
    const end = lineEnd === -1 ? source.length : lineEnd + 1;
    const line = source.slice(at, lineEnd === -1 ? source.length : lineEnd);
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
 * Parses `[cite:<passageId>: <quote>]` (or `[cite:<path>: <quote>]`) starting at `at`, supporting
 * balanced `[...]` inside the quote. Leaves minted `[cite:<token>]` tags (which have no separator
 * after the token) untouched by returning null.
 */
function matchInlineTag(source: string, at: number): { tag: ParsedInlineTag; end: number } | null {
  if (!source.startsWith("[cite:", at)) return null;
  const innerStart = at + "[cite:".length;
  let i = innerStart;
  let depth = 0;
  let end = -1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") return null;
    if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      if (depth === 0) {
        end = i + 1;
        break;
      }
      depth--;
    }
    i++;
  }
  if (end === -1) return null;
  const inner = source.slice(innerStart, end - 1);
  const sentenceMatch = SENTENCE_REF_INNER.exec(inner);
  if (sentenceMatch?.[1] && sentenceMatch[2]) {
    return {
      tag: {
        kind: "sentence",
        handle: sentenceMatch[1],
        index: Number(sentenceMatch[2]),
        raw: source.slice(at, end),
      },
      end,
    };
  }
  // Skip the drive colon in a Windows path (`C:\...`) when finding the ref/quote separator.
  const searchFrom = WINDOWS_DRIVE.test(inner) ? 2 : 0;
  const colonAt = inner.indexOf(":", searchFrom);
  const pipeAt = inner.indexOf("|", searchFrom);
  let sep = -1;
  if (colonAt !== -1 && pipeAt !== -1) sep = Math.min(colonAt, pipeAt);
  else if (colonAt !== -1) sep = colonAt;
  else if (pipeAt !== -1) sep = pipeAt;
  if (sep === -1) return null;
  const ref = inner.slice(0, sep).trim();
  const quote = inner.slice(sep + 1).trim();
  if (ref === "" || quote === "") return null;
  return {
    tag: {
      kind: looksLikePath(ref) ? "file" : "passage",
      ref,
      quote,
      raw: source.slice(at, end),
    },
    end,
  };
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

  const stripAt = (after: number): number => {
    let trimmed = out.length;
    while (trimmed > 0 && (out[trimmed - 1] === " " || out[trimmed - 1] === "\t")) trimmed--;
    out = out.slice(0, trimmed);
    let next = after;
    if (out.length === 0 || out[out.length - 1] === "\n") {
      while (next < source.length && (source[next] === " " || source[next] === "\t")) next++;
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
          lineStart = true;
          continue;
        }
      }
    }
    const ch = source[at];
    if (ch === "`") {
      let ticks = 0;
      while (at + ticks < source.length && source[at + ticks] === "`") ticks++;
      const close = endOfCodeSpan(source, at + ticks, ticks);
      if (close !== -1) {
        out += source.slice(at, close);
        lineStart = source[close - 1] === "\n";
        at = close;
        continue;
      }
      out += source.slice(at, at + ticks);
      lineStart = false;
      at += ticks;
      continue;
    }
    if (ch === "[" && source.startsWith("[cite:", at)) {
      const matched = matchInlineTag(source, at);
      if (matched) {
        if (replace === null) {
          found.push(matched.tag);
          out += matched.tag.raw;
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
            lineStart = out.length === 0 || out[out.length - 1] === "\n";
          }
        }
        continue;
      }
    }
    out += ch;
    lineStart = ch === "\n";
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
