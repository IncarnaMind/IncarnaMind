/**
 * A deck of the User's own as it stood before each sitting of editing it by hand (#149, ADR-0010
 * 2026-11-24): kept whole in the data folder's "Kept decks", so the User can put the deck back as
 * it was. For each Document: its first state (the file as it was before IncarnaMind first changed
 * it), kept while the deck is in the Library, and its newest others up to `MAX_KEPT` in all; a
 * state already kept isn't kept twice. Each sitting names the state it began from, which Put back
 * as it was writes back. What goes is let go only after a write succeeds, and that line says so.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../storage";

/** The data folder's folder of kept decks, one folder a Document. */
export const KEPT_DECKS_FOLDER = "Kept decks";
/** How many states of one deck are kept, its first among them. */
export const MAX_KEPT = 10;

export interface KeptDeck {
  id: string;
  documentId: string;
  /** Relative to the data folder. */
  file: string;
  contentHash: string;
  size: number;
  /** When it was kept, as the deck stood then. ISO 8601, UTC. */
  keptAt: string;
  /** The deck as it was before IncarnaMind first changed it. */
  first: boolean;
}

interface Row {
  id: string;
  document_id: string;
  file: string;
  content_hash: string;
  size: number | bigint;
  first: number | bigint;
  created_at: string;
}

const COLUMNS = "id, document_id, file, content_hash, size, first, created_at";

const toKept = (row: Row): KeptDeck => ({
  id: row.id,
  documentId: row.document_id,
  file: row.file,
  contentHash: row.content_hash,
  size: Number(row.size),
  keptAt: row.created_at,
  first: Number(row.first) === 1,
});

/** How much older than the start an unnamed kept file must be to be taken out. */
const SWEEP_MARGIN_MS = 60 * 60_000;

export function createKeptDecks(options: { db: Database; dataDir: string; now(): string }) {
  const { db, dataDir, now } = options;

  /** In the order they were kept: by insertion, as a clock moved back can't reorder it. */
  const of = (documentId: string): KeptDeck[] =>
    db
      .all<Row>(
        `SELECT ${COLUMNS} FROM deck_kept WHERE document_id = ? AND deleted_at IS NULL ORDER BY rowid`,
        [documentId],
      )
      .map(toKept);

  const forget = async (kept: KeptDeck): Promise<void> => {
    const at = now();
    db.run("UPDATE deck_kept SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, kept.id]);
    await rm(join(dataDir, kept.file), { force: true });
  };

  const one = (sql: string, values: readonly string[]): KeptDeck | null => {
    const row = db.get<Row>(sql, values);
    return row ? toKept(row) : null;
  };

  /** The state the Document's latest sitting began from: what Put back as it was writes. */
  const ofSitting = (documentId: string): KeptDeck | null =>
    one(
      `SELECT ${COLUMNS} FROM deck_kept WHERE document_id = ? AND deleted_at IS NULL
       AND sitting IS NOT NULL ORDER BY sitting DESC LIMIT 1`,
      [documentId],
    );

  return {
    /** The Document's kept states, the oldest first. */
    of,

    byId: (keptId: unknown): KeptDeck | null =>
      typeof keptId === "string"
        ? one(`SELECT ${COLUMNS} FROM deck_kept WHERE id = ? AND deleted_at IS NULL`, [keptId])
        : null,

    /** The Document's state with these bytes, if one is kept already. */
    find(documentId: string, contentHash: string): KeptDeck | null {
      return of(documentId).find((each) => each.contentHash === contentHash) ?? null;
    },

    ofSitting,

    /** The deck as it was before IncarnaMind first changed it. */
    firstOf: (documentId: string): KeptDeck | null =>
      one(
        `SELECT ${COLUMNS} FROM deck_kept WHERE document_id = ? AND deleted_at IS NULL AND first = 1`,
        [documentId],
      ),

    /** Where a new kept state's file goes, relative to the data folder. */
    fileFor: (documentId: string, keptId: string): string =>
      join(KEPT_DECKS_FOLDER, documentId, `${keptId}.pptx`),

    /**
     * Records a state as kept, its file written already: the Document's first if it has none.
     * Lets nothing go: see `letGo`.
     */
    add(
      documentId: string,
      input: { id: string; file: string; contentHash: string; size: number },
    ): void {
      const at = now();
      const first =
        db.get(
          "SELECT 1 AS one FROM deck_kept WHERE document_id = ? AND deleted_at IS NULL AND first = 1",
          [documentId],
        ) === undefined;
      db.run(
        `INSERT INTO deck_kept (id, document_id, file, content_hash, size, first, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          documentId,
          input.file,
          input.contentHash,
          BigInt(input.size),
          first ? 1n : 0n,
          at,
          at,
        ],
      );
    },

    /** A sitting began from this state: Put back as it was now writes it. */
    beganFrom(keptId: string): void {
      const kept = one(`SELECT ${COLUMNS} FROM deck_kept WHERE id = ?`, [keptId]);
      if (!kept) return;
      const last = db.get<{ last: number | bigint | null }>(
        "SELECT MAX(sitting) AS last FROM deck_kept WHERE document_id = ?",
        [kept.documentId],
      )?.last;
      db.run("UPDATE deck_kept SET sitting = ?, updated_at = ? WHERE id = ?", [
        BigInt(Number(last ?? 0) + 1),
        now(),
        keptId,
      ]);
    },

    /**
     * Once a write that kept a state has succeeded: lets the Document's oldest states past
     * `MAX_KEPT` go, never its first nor the one its latest sitting began from. Returns those let
     * go, for the line to say.
     */
    async letGo(documentId: string): Promise<KeptDeck[]> {
      const sitting = ofSitting(documentId)?.id;
      const others = of(documentId).filter((each) => !each.first && each.id !== sitting);
      const keep = MAX_KEPT - (of(documentId).length - others.length);
      const gone = others.slice(0, Math.max(0, others.length - keep));
      for (const each of gone) await forget(each);
      return gone;
    },

    /**
     * Forgets the kept states of Documents the Library deleted for good, with their folders.
     * `before`: at start, also a file in a live Document's folder no kept state names (one a
     * crash left between writing it and recording it), if an hour older than that time: a write
     * under way now is never touched, on a disk whose file times are coarse too. A link in the
     * folder is never followed.
     */
    async dropGone(exists: (documentId: string) => boolean, before?: number): Promise<void> {
      const documents = db.all<{ document_id: string }>(
        "SELECT DISTINCT document_id FROM deck_kept WHERE deleted_at IS NULL",
      );
      const root = join(dataDir, KEPT_DECKS_FOLDER);
      for (const { document_id: documentId } of documents) {
        if (exists(documentId)) continue;
        for (const each of of(documentId)) await forget(each);
        await rm(join(root, documentId), { recursive: true, force: true });
      }
      if (before === undefined) return;
      const named = new Set(
        db
          .all<{ file: string }>("SELECT file FROM deck_kept WHERE deleted_at IS NULL")
          .map((row) => join(dataDir, row.file)),
      );
      for (const folder of await readdir(root).catch(() => [] as string[])) {
        const at = join(root, folder);
        const info = await lstat(at).catch(() => null);
        if (!info?.isDirectory()) continue;
        if (!exists(folder)) {
          await rm(at, { recursive: true, force: true });
          continue;
        }
        for (const name of await readdir(at).catch(() => [] as string[])) {
          const file = join(at, name);
          const stat = await lstat(file).catch(() => null);
          if (!stat?.isFile() || named.has(file) || stat.mtimeMs >= before - SWEEP_MARGIN_MS)
            continue;
          await rm(file, { force: true });
        }
      }
    },
  };
}

export type KeptDecks = ReturnType<typeof createKeptDecks>;
