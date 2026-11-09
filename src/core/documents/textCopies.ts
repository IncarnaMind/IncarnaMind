/**
 * Copies of a checked file by their text (#2216): a Document is one when it
 * holds nearly all of the checked file's text, whatever its format or bytes,
 * so a resaved Word file, a PDF printed from it or a bundle holding it isn't
 * read as evidence for the file's own claims.
 *
 * The measure is containment (Broder, "On the resemblance and containment of
 * documents", 1997): the share of the checked text's shingles, runs of five
 * tokens, that the other Document's text holds too. It is worked out on this
 * computer from the text processing stores, with no model, and the same two
 * texts always give the same share. A token is a word, or one Chinese or
 * Japanese character, so nothing depends on spaces between words or on the
 * platform's word segmenter.
 *
 * Each version's fingerprint is stored with its text: how many distinct
 * shingles it has, and the one in eight whose hash ends in three zero bits (a
 * fixed-rate sample, as FracMinHash takes, so samples of texts of any length
 * compare). A check compares samples to find the few Documents that may hold
 * the checked text, then decides each by the exact share, from both stored texts.
 */
import { CJK, foldRadicals, INVISIBLE } from "../../shared/text";
import type { Database } from "../storage";

/** #2216's measured pairs: copies hold 94.7% of the checked text and more, other Documents 84.7% and less. */
export const SAME_TEXT_SHARE = 0.9;

/**
 * In shingles, about as many words or Chinese characters. A shorter text is matched by its bytes
 * only: below it, #2216's reply quoting two paragraphs held up to 83% of the file, and one
 * rewritten sentence took a copy under the bar.
 */
export const SAME_TEXT_SHORTEST = 200;

const SHINGLE_TOKENS = 5;
const SAMPLE_MASK = 0b111;

/** Far enough under the bar that the sample of a text at the shortest length, about 25 hashes, doesn't miss a copy. */
const SAMPLE_SHARE = 0.6;

/** Whole shingle sets kept between checks: a check's searches and the watch ask about the same few many times. */
const KEPT_TEXTS = 8;

const TOKEN = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}\\p{M}])+`, "gu");

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function tokenHash(token: string): number {
  let hash = FNV_OFFSET;
  for (let at = 0; at < token.length; at++) {
    hash = Math.imul(hash ^ token.charCodeAt(at), FNV_PRIME);
  }
  return hash >>> 0;
}

/** MurmurHash3's finaliser: FNV's low bits, which the sample is taken by, are uneven without it. */
function finalise(hash: number): number {
  let mixed = hash ^ (hash >>> 16);
  mixed = Math.imul(mixed, 0x85ebca6b);
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

const INVISIBLE_CHARACTERS = new RegExp(
  `[${[...INVISIBLE].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}]`,
  "gu",
);
const LINE_END_HYPHEN = /(\p{L})[-‐][^\S\n]*\n\s*(?=\p{Ll})/gu;

/**
 * A text's shingles, as hashes, distinct and ascending. Read as the text normaliser reads it for
 * comparing (NFKC, CJK radicals folded, invisible characters dropped, a word split by a hyphen at a
 * line's end joined) and lowercased, so line wrapping, spacing and punctuation don't count. Not by
 * `normaliseText` itself, which keeps every character's offsets and takes 40 times as long.
 */
export function shinglesOf(units: readonly { text: string }[]): Uint32Array {
  const text = foldRadicals(
    units
      .map((unit) => unit.text)
      .join("\n")
      .normalize("NFKC"),
  )
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(LINE_END_HYPHEN, "$1")
    .toLowerCase();
  const tokens = (text.match(TOKEN) ?? []).map(tokenHash);
  const count = tokens.length - SHINGLE_TOKENS + 1;
  if (count <= 0) return new Uint32Array(0);
  const hashes = new Uint32Array(count);
  for (let start = 0; start < count; start++) {
    let hash = FNV_OFFSET;
    for (let at = start; at < start + SHINGLE_TOKENS; at++) {
      hash = Math.imul(hash ^ (tokens[at] as number), FNV_PRIME);
    }
    hashes[start] = finalise(hash);
  }
  hashes.sort();
  let distinct = 0;
  for (let at = 0; at < hashes.length; at++) {
    if (at === 0 || hashes[at] !== hashes[at - 1]) hashes[distinct++] = hashes[at] as number;
  }
  return hashes.slice(0, distinct);
}

/** The share of `of`'s hashes that `within` holds too; both distinct and ascending. */
export function heldShare(of: Uint32Array, within: Uint32Array): number {
  if (of.length === 0) return 0;
  let held = 0;
  let at = 0;
  for (const hash of of) {
    while (at < within.length && (within[at] as number) < hash) at++;
    if (at < within.length && within[at] === hash) held++;
  }
  return held / of.length;
}

/** The rule, on two whole texts' shingles: whether `other` holds the checked text. */
export function holdsText(checked: Uint32Array, other: Uint32Array): boolean {
  return checked.length >= SAME_TEXT_SHORTEST && heldShare(checked, other) >= SAME_TEXT_SHARE;
}

const sampleOf = (shingles: Uint32Array) => shingles.filter((hash) => (hash & SAMPLE_MASK) === 0);

/** Little-endian, so a fingerprint reads the same on every device. */
function sampleBytes(sample: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(sample.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < sample.length; index++) {
    view.setUint32(index * 4, sample[index] as number, true);
  }
  return bytes;
}

function sampleFrom(bytes: Uint8Array): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sample = new Uint32Array(Math.floor(bytes.byteLength / 4));
  for (let index = 0; index < sample.length; index++) {
    sample[index] = view.getUint32(index * 4, true);
  }
  return sample;
}

export interface TextVersion {
  documentId: string;
  contentHash: string;
}

interface Fingerprint {
  shingles: number;
  sample: Uint32Array;
}

const inList = (column: string) => `${column} IN (SELECT value FROM json_each(?))`;

export type TextCopies = ReturnType<typeof createTextCopies>;

export function createTextCopies(db: Database, now: () => string) {
  const kept = new Map<string, Uint32Array>();
  const keyOf = (version: TextVersion) => `${version.documentId}\n${version.contentHash}`;
  const keep = (version: TextVersion, shingles: Uint32Array) => {
    kept.delete(keyOf(version));
    kept.set(keyOf(version), shingles);
    for (const oldest of kept.keys()) {
      if (kept.size <= KEPT_TEXTS) break;
      kept.delete(oldest);
    }
    return shingles;
  };

  const unitsOf = (version: TextVersion) =>
    db.all<{ text: string }>(
      `SELECT text FROM document_pages
       WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL ORDER BY page`,
      [version.documentId, version.contentHash],
    );

  const wholeText = (version: TextVersion) =>
    kept.get(keyOf(version)) ?? keep(version, shinglesOf(unitsOf(version)));

  // A Verify asks the same of every claim. A Document deleted or restored changes the answer
  // without a fingerprint being recorded or forgotten, so the Library's state is part of the key.
  const answers = new Map<string, string[]>();
  const libraryState = () =>
    db.get<{ state: string }>(
      `SELECT COUNT(*) || ' ' || SUM(deleted_at IS NULL) || ' ' || COALESCE(MAX(updated_at), '')
         AS state FROM documents`,
    )?.state ?? "";
  const remember = (asked: string, found: string[]) => {
    answers.set(asked, found);
    for (const oldest of answers.keys()) {
      if (answers.size <= KEPT_TEXTS) break;
      answers.delete(oldest);
    }
    return found;
  };

  function record(version: TextVersion, units: readonly { text: string }[]): Fingerprint {
    answers.clear();
    const shingles = keep(version, shinglesOf(units));
    const sample = sampleOf(shingles);
    const at = now();
    db.run(
      `INSERT INTO text_fingerprints (id, document_id, content_hash, shingles, sample,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (document_id, content_hash) WHERE deleted_at IS NULL
       DO UPDATE SET shingles = excluded.shingles, sample = excluded.sample,
         updated_at = excluded.updated_at`,
      [
        crypto.randomUUID(),
        version.documentId,
        version.contentHash,
        BigInt(shingles.length),
        sampleBytes(sample),
        at,
        at,
      ],
    );
    return { shingles: shingles.length, sample };
  }

  /** A live Document's current version whose text is stored but not fingerprinted. */
  function nextMissing(): TextVersion | null {
    const row = db.get<{ id: string; content_hash: string }>(
      `SELECT d.id, d.content_hash FROM documents d
       WHERE d.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM document_pages p
                     WHERE p.document_id = d.id AND p.content_hash = d.content_hash
                       AND p.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM text_fingerprints f
                         WHERE f.document_id = d.id AND f.content_hash = d.content_hash
                           AND f.deleted_at IS NULL)
       ORDER BY d.created_at, d.rowid LIMIT 1`,
    );
    return row ? { documentId: row.id, contentHash: row.content_hash } : null;
  }

  function fingerprintOf(version: TextVersion): Fingerprint {
    const row = db.get<{ shingles: number; sample: Uint8Array }>(
      `SELECT shingles, sample FROM text_fingerprints
       WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL`,
      [version.documentId, version.contentHash],
    );
    return row
      ? { shingles: Number(row.shingles), sample: sampleFrom(row.sample) }
      : record(version, unitsOf(version));
  }

  return {
    record,

    forget(version: TextVersion): void {
      answers.clear();
      kept.delete(keyOf(version));
      db.run("DELETE FROM text_fingerprints WHERE document_id = ? AND content_hash = ?", [
        version.documentId,
        version.contentHash,
      ]);
    },

    /** For a Document deleted for good. */
    forgetDocument(documentId: string): void {
      answers.clear();
      for (const key of [...kept.keys()]) {
        if (key.startsWith(`${documentId}\n`)) kept.delete(key);
      }
      db.run("DELETE FROM text_fingerprints WHERE document_id = ?", [documentId]);
    },

    /** Fingerprints the next Document whose text was stored before fingerprints were; false when none is left. */
    fillNext(): boolean {
      const next = nextMissing();
      if (!next) return false;
      record(next, unitsOf(next));
      return true;
    },

    /**
     * The Documents among `candidates` (null: every live one), but not in
     * `skip`, whose current version holds nearly all of the text of one of the
     * checked versions. A checked version shorter than `SAME_TEXT_SHORTEST`, or
     * with no text stored, matches nothing. Only fingerprinted Documents are
     * compared: a check waits for `fillNext` to reach every one first.
     */
    holding(
      checked: readonly TextVersion[],
      candidates: readonly string[] | null,
      skip: ReadonlySet<string>,
    ): string[] {
      const asked = JSON.stringify([
        libraryState(),
        checked.map(keyOf),
        candidates,
        [...skip].sort(),
      ]);
      const known = answers.get(asked);
      if (known) return [...known];
      const sources = checked
        .map((version) => ({ version, fingerprint: fingerprintOf(version) }))
        .filter(({ fingerprint }) => fingerprint.shingles >= SAME_TEXT_SHORTEST);
      if (sources.length === 0) return [...remember(asked, [])];
      // A text with fewer shingles than the bar's share of the checked text's can't hold it.
      const enough = (fingerprint: Fingerprint) =>
        Math.ceil(fingerprint.shingles * SAME_TEXT_SHARE);
      const rows = db.all<{
        id: string;
        content_hash: string;
        shingles: number;
        sample: Uint8Array;
      }>(
        `SELECT d.id, d.content_hash, f.shingles, f.sample FROM documents d
         JOIN text_fingerprints f ON f.document_id = d.id AND f.content_hash = d.content_hash
           AND f.deleted_at IS NULL
         WHERE d.deleted_at IS NULL AND f.shingles >= ?
           ${candidates === null ? "" : `AND ${inList("d.id")}`}
         ORDER BY d.created_at, d.rowid`,
        [
          BigInt(Math.min(...sources.map(({ fingerprint }) => enough(fingerprint)))),
          ...(candidates === null ? [] : [JSON.stringify(candidates)]),
        ],
      );
      const found = rows.flatMap((row) => {
        if (skip.has(row.id)) return [];
        const other: TextVersion = { documentId: row.id, contentHash: row.content_hash };
        const sample = sampleFrom(row.sample);
        const holds = sources.some(
          ({ version, fingerprint }) =>
            keyOf(version) !== keyOf(other) &&
            Number(row.shingles) >= enough(fingerprint) &&
            heldShare(fingerprint.sample, sample) >= SAMPLE_SHARE &&
            holdsText(wholeText(version), wholeText(other)),
        );
        return holds ? [row.id] : [];
      });
      return [...remember(asked, found)];
    },
  };
}
