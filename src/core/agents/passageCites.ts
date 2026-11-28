/**
 * Pairing-scoped sentence Citation handles for one-call writing (#3753): when an agent passes
 * `cited: true` to `search` or `read_passages`, every complete sentence of a Passage receives a
 * short, random, pairing-scoped handle (`[cite:k3x9a2.2]`). Each handle carries a random per-run
 * prefix so handles from an earlier run never alias a new Passage after a restart, and each
 * pairing has its own bounded LRU of Passage entries.
 */
import { CITE_ALPHABET, randomCiteCode } from "./citations";

const RUN_PREFIX_LENGTH = 2;
const PASSAGE_CODE_LENGTH = 4;
const PASSAGE_CODE_SPACE = CITE_ALPHABET.length ** PASSAGE_CODE_LENGTH;
const PASSAGE_CODE_STRIDE = 681_493;
export const MAX_ENTRIES_PER_PAIRING = 2_000;
const MAX_SENTENCE_CHARS = 1_000;

function randomMask(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] ?? 0) & (PASSAGE_CODE_SPACE - 1);
}

function encodePassageCode(value: number): string {
  let n = value & (PASSAGE_CODE_SPACE - 1);
  let code = "";
  for (let i = 0; i < PASSAGE_CODE_LENGTH; i++) {
    code = (CITE_ALPHABET[n & 31] ?? "a") + code;
    n >>>= 5;
  }
  return code;
}

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
  mask: number;
  seq: number;
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
      store = { byKey: new Map(), byHandle: new Map(), mask: randomMask(), seq: 0 };
      perPairing.set(pairingId, store);
    }
    return store;
  };

  const nextHandleFor = (store: PairingStore): string => {
    // Full-period permutation over 32^4 = 1,048,576 codes: O(1) time, O(1) memory, and zero reuse
    // across a million Passages per pairing.
    const slot =
      (Math.imul(store.seq, PASSAGE_CODE_STRIDE) + store.mask) & (PASSAGE_CODE_SPACE - 1);
    store.seq = (store.seq + 1) & (PASSAGE_CODE_SPACE - 1);
    return `${runPrefix}${encodePassageCode(slot)}`;
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
      let handle = nextHandleFor(store);
      for (let tries = 0; tries < maxPerPairing && store.byHandle.has(handle); tries++) {
        handle = nextHandleFor(store);
      }
      const entry: PassageCiteEntry = {
        handle,
        pairingId,
        passageId,
        contentHash,
        spans: sentenceSpansOf(fullText, { maxChars: MAX_SENTENCE_CHARS, requireWord: true }),
      };
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
