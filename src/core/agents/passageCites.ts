/**
 * Pairing-scoped sentence Citation handles for one-call writing (#3753): when an agent passes
 * `cited: true` to `search` or `read_passages`, every complete sentence of a Passage receives a
 * short, random, pairing-scoped handle (`[cite:k3x9a2.2]`). Each handle carries a random per-run
 * prefix so handles from an earlier run never alias a new Passage after a restart, and each
 * pairing has its own bounded LRU of Passage entries.
 */
import { randomCiteCode } from "./citations";

const RUN_PREFIX_LENGTH = 2;
const PASSAGE_CODE_LENGTH = 4;
export const MAX_ENTRIES_PER_PAIRING = 2_000;
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

/**
 * Splits `fullText` line-by-line into trimmed non-empty sentence spans with exact character
 * offsets. Shared between sentence Citation indexing and `sentencesOf` in `access.ts`.
 */
export function sentenceSpansOf(
  fullText: string,
  options?: { maxChars?: number; requireWord?: boolean },
): PassageSentenceSpan[] {
  const maxChars = options?.maxChars ?? Number.POSITIVE_INFINITY;
  const requireWord = options?.requireWord ?? false;
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
          trimmed.length > maxChars ||
          (requireWord && !HAS_WORD_CHAR.test(trimmed))
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

interface PairingStore {
  byKey: Map<string, PassageCiteEntry>;
  byHandle: Map<string, PassageCiteEntry>;
  /** Every handle allocated for this pairing in this run so evicted handles never alias a new Passage. */
  allocated: Set<string>;
}

/** Per-pairing bounded LRU registry of sentence Citation handles with a per-run prefix (#3753). */
export function createPassageCiteRegistry(options?: {
  maxPerPairing?: number;
  runPrefix?: string;
}) {
  const maxPerPairing = Math.max(1, options?.maxPerPairing ?? MAX_ENTRIES_PER_PAIRING);
  const runPrefix = options?.runPrefix ?? randomCiteCode(RUN_PREFIX_LENGTH);
  const perPairing = new Map<string, PairingStore>();

  const storeOf = (pairingId: string): PairingStore => {
    let store = perPairing.get(pairingId);
    if (!store) {
      store = { byKey: new Map(), byHandle: new Map(), allocated: new Set() };
      perPairing.set(pairingId, store);
    }
    return store;
  };

  const keyOf = (passageId: string, contentHash: string) => `${passageId}\u0000${contentHash}`;

  const touch = (store: PairingStore, entry: PassageCiteEntry) => {
    const k = keyOf(entry.passageId, entry.contentHash);
    store.byKey.delete(k);
    store.byKey.set(k, entry);
    store.byHandle.delete(entry.handle);
    store.byHandle.set(entry.handle, entry);
  };

  const evictIfFull = (store: PairingStore) => {
    while (store.byKey.size > maxPerPairing) {
      const oldest = store.byKey.entries().next().value;
      if (!oldest) break;
      const [k, entry] = oldest;
      store.byKey.delete(k);
      store.byHandle.delete(entry.handle);
    }
  };

  return {
    runPrefix,

    indexPassage(
      pairingId: string,
      passageId: string,
      contentHash: string,
      fullText: string,
    ): PassageCiteEntry {
      const store = storeOf(pairingId);
      const k = keyOf(passageId, contentHash);
      const existing = store.byKey.get(k);
      if (existing) {
        touch(store, existing);
        return existing;
      }
      let handle = `${runPrefix}${randomCiteCode(PASSAGE_CODE_LENGTH)}`;
      while (store.allocated.has(handle)) {
        handle = `${runPrefix}${randomCiteCode(PASSAGE_CODE_LENGTH)}`;
      }
      const entry: PassageCiteEntry = {
        handle,
        pairingId,
        passageId,
        contentHash,
        spans: sentenceSpansOf(fullText, { maxChars: MAX_SENTENCE_CHARS, requireWord: true }),
      };
      store.allocated.add(handle);
      store.byKey.set(k, entry);
      store.byHandle.set(handle, entry);
      evictIfFull(store);
      return entry;
    },

    lookup(pairingId: string, handle: string, index: number): PassageCiteLookup | null {
      if (!handle.startsWith(runPrefix)) return null;
      const store = perPairing.get(pairingId);
      if (!store) return null;
      const entry = store.byHandle.get(handle);
      if (!entry) return null;
      touch(store, entry);
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
