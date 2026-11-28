/**
 * Pairing-scoped sentence Citation handles for one-call writing (#3753): when an agent passes
 * `cited: true` to `search` or `read_passages`, every complete sentence of a Passage receives a
 * short, random, pairing-scoped handle (`[cite:k3x9a.2]`). When written in `propose_changes` or
 * `create_mind`, IncarnaMind looks up the exact sentence, verifies reach and runs `citeQuote`
 * against the live Document, and mints a real persistent Citation token — no separate `cite` call,
 * no re-typed quotes, and no SQLite writes on read.
 */
import { randomBytes } from "node:crypto";

/** Same unambiguous 32-char alphabet as `./citations` (no 0, 1, l or o): 5 bits per char. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const HANDLE_LENGTH = 5;
const MAX_ENTRIES = 2_000;
const MAX_SENTENCE_CHARS = 1_000;

const HAS_WORD_CHAR = /\p{L}|\p{N}/u;
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

export interface PassageSentenceSpan {
  /** 1-based sentence index within the full Passage text. */
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface PassageCiteEntry {
  handle: string;
  pairingId: string;
  passageId: string;
  contentHash: string;
  spans: readonly PassageSentenceSpan[];
}

export interface PassageCiteLookup {
  passageId: string;
  contentHash: string;
  quote: string;
}

/** Splits `fullText` line-by-line into trimmed sentence spans with exact character offsets. */
export function sentenceSpansOf(fullText: string): PassageSentenceSpan[] {
  const spans: PassageSentenceSpan[] = [];
  let lineStart = 0;
  while (lineStart < fullText.length) {
    const nl = fullText.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? fullText.length : nl;
    const line = fullText.slice(lineStart, lineEnd);
    if (line.trim() !== "") {
      for (const { segment, index: segOffset } of sentenceSegmenter.segment(line)) {
        const leading = segment.length - segment.trimStart().length;
        const trimmed = segment.trim();
        if (
          trimmed.length === 0 ||
          trimmed.length > MAX_SENTENCE_CHARS ||
          !HAS_WORD_CHAR.test(trimmed)
        ) {
          continue;
        }
        const start = lineStart + segOffset + leading;
        const end = start + trimmed.length;
        spans.push({ index: spans.length + 1, start, end, text: trimmed });
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return spans;
}

/**
 * Renders `fullText.slice(windowStart, windowEnd)` with `[cite:<handle>.<n>] ` prefixed before
 * every sentence span lying completely inside `[windowStart, windowEnd]`.
 */
export function formatCitedWindow(
  fullText: string,
  windowStart: number,
  windowEnd: number,
  entry: Pick<PassageCiteEntry, "handle" | "spans">,
  ellipsis = false,
): string {
  const start = Math.max(0, windowStart);
  const end = Math.min(fullText.length, windowEnd);
  let out = "";
  let cursor = start;
  for (const span of entry.spans) {
    if (span.end <= start) continue;
    if (span.start >= end) break;
    if (span.start < start || span.end > end) continue;
    out += fullText.slice(cursor, span.start);
    out += `[cite:${entry.handle}.${span.index}] `;
    cursor = span.start;
  }
  out += fullText.slice(cursor, end);
  if (!ellipsis || (start === 0 && end === fullText.length)) return out;
  return `${start > 0 ? "…" : ""}${out.trim()}${end < fullText.length ? "…" : ""}`;
}

/**
 * Prefixes each matched sentence inside a Transcript's `timedText` with its `[cite:<handle>.<n>] `
 * handle, placing the first handle before the line's `[time speaker] ` mark and any later sentence
 * handles at their sentence boundary within the turn.
 */
export function formatCitedTimedText(
  timedText: string,
  entry: Pick<PassageCiteEntry, "handle" | "spans">,
): string {
  const lines = timedText.split("\n");
  let nextSpan = 0;
  return lines
    .map((line) => {
      const prefix = /^(?:…)?(?:\[[^\]]+\]\s+)+/.exec(line)?.[0] ?? "";
      const body = line.slice(prefix.length);
      if (!body.trim()) return line;
      let cursor = 0;
      let out = "";
      let taggedFirst = false;
      for (let i = nextSpan; i < entry.spans.length; i++) {
        const span = entry.spans[i];
        if (!span) continue;
        const at = body.indexOf(span.text, cursor);
        if (at === -1) {
          if (taggedFirst) break;
          continue;
        }
        if (!taggedFirst && body.slice(0, at).trim() === "") {
          out = `[cite:${entry.handle}.${span.index}] ${prefix}${body.slice(0, at + span.text.length)}`;
          taggedFirst = true;
        } else {
          if (!taggedFirst) {
            out = prefix + body.slice(0, at);
            taggedFirst = true;
          } else {
            out += body.slice(cursor, at);
          }
          out += `[cite:${entry.handle}.${span.index}] ${span.text}`;
        }
        cursor = at + span.text.length;
        nextSpan = i + 1;
      }
      return taggedFirst ? out + body.slice(cursor) : line;
    })
    .join("\n");
}

function newHandle(): string {
  const bytes = randomBytes(HANDLE_LENGTH);
  let handle = "";
  for (const byte of bytes) handle += ALPHABET[byte % ALPHABET.length];
  return handle;
}

/** Bounded in-memory LRU registry of pairing-scoped sentence Citation handles (#3753). */
export function createPassageCiteRegistry() {
  const byKey = new Map<string, PassageCiteEntry>();
  const byHandle = new Map<string, PassageCiteEntry>();
  /** Every `(pairingId, handle)` ever allocated in this session so evicted handles never alias a new Passage. */
  const allocated = new Set<string>();

  const keyOf = (pairingId: string, passageId: string, contentHash: string) =>
    `${pairingId}\u0000${passageId}\u0000${contentHash}`;
  const handleKeyOf = (pairingId: string, handle: string) => `${pairingId}\u0000${handle}`;

  const touch = (entry: PassageCiteEntry) => {
    const k = keyOf(entry.pairingId, entry.passageId, entry.contentHash);
    const hk = handleKeyOf(entry.pairingId, entry.handle);
    byKey.delete(k);
    byKey.set(k, entry);
    byHandle.delete(hk);
    byHandle.set(hk, entry);
  };

  const evictIfFull = () => {
    while (byKey.size > MAX_ENTRIES) {
      const oldest = byKey.entries().next().value;
      if (!oldest) break;
      const [k, entry] = oldest;
      byKey.delete(k);
      byHandle.delete(handleKeyOf(entry.pairingId, entry.handle));
    }
  };

  return {
    indexPassage(
      pairingId: string,
      passageId: string,
      contentHash: string,
      fullText: string,
    ): PassageCiteEntry {
      const k = keyOf(pairingId, passageId, contentHash);
      const existing = byKey.get(k);
      if (existing) {
        touch(existing);
        return existing;
      }
      let handle = newHandle();
      while (allocated.has(handleKeyOf(pairingId, handle))) {
        handle = newHandle();
      }
      const entry: PassageCiteEntry = {
        handle,
        pairingId,
        passageId,
        contentHash,
        spans: sentenceSpansOf(fullText),
      };
      allocated.add(handleKeyOf(pairingId, handle));
      byKey.set(k, entry);
      byHandle.set(handleKeyOf(pairingId, handle), entry);
      evictIfFull();
      return entry;
    },

    lookup(pairingId: string, handle: string, index: number): PassageCiteLookup | null {
      const entry = byHandle.get(handleKeyOf(pairingId, handle));
      if (!entry) return null;
      touch(entry);
      const span = entry.spans[index - 1];
      if (!span) return null;
      return {
        passageId: entry.passageId,
        contentHash: entry.contentHash,
        quote: span.text,
      };
    },
  };
}

export type PassageCiteRegistry = ReturnType<typeof createPassageCiteRegistry>;
