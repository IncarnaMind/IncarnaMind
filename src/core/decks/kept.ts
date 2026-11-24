/**
 * A deck of the User's own as it stood before each sitting of editing it by hand (#149, ADR-0010
 * 2026-11-24): kept whole in the data folder's "Kept decks", the newest `MAX_KEPT` for each
 * Document, so the User can put the deck back as it was. A newer one lets the oldest go, and the
 * line that says what was saved says so too.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../storage";

/** The data folder's folder of kept decks, one folder a Document. */
export const KEPT_DECKS_FOLDER = "Kept decks";
/** How many earlier states of one deck are kept. */
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
}

interface Row {
  id: string;
  document_id: string;
  file: string;
  content_hash: string;
  size: number | bigint;
  created_at: string;
}

const COLUMNS = "id, document_id, file, content_hash, size, created_at";

const toKept = (row: Row): KeptDeck => ({
  id: row.id,
  documentId: row.document_id,
  file: row.file,
  contentHash: row.content_hash,
  size: Number(row.size),
  keptAt: row.created_at,
});

export function createKeptDecks(options: { db: Database; dataDir: string; now(): string }) {
  const { db, dataDir, now } = options;

  const of = (documentId: string): KeptDeck[] =>
    db
      .all<Row>(
        `SELECT ${COLUMNS} FROM deck_kept WHERE document_id = ? AND deleted_at IS NULL
         ORDER BY created_at, rowid`,
        [documentId],
      )
      .map(toKept);

  const forget = async (kept: KeptDeck): Promise<void> => {
    const at = now();
    db.run("UPDATE deck_kept SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, kept.id]);
    await rm(join(dataDir, kept.file), { force: true });
  };

  return {
    /** The Document's kept states, the oldest first. */
    of,

    byId(keptId: unknown): KeptDeck | null {
      if (typeof keptId !== "string") return null;
      const row = db.get<Row>(
        `SELECT ${COLUMNS} FROM deck_kept WHERE id = ? AND deleted_at IS NULL`,
        [keptId],
      );
      return row ? toKept(row) : null;
    },

    /** Where a new kept state's file goes, relative to the data folder. */
    fileFor: (documentId: string, keptId: string): string =>
      join(KEPT_DECKS_FOLDER, documentId, `${keptId}.pptx`),

    /**
     * Records a state as kept, its file written already, and lets the oldest go past `MAX_KEPT`:
     * the ones let go, for the line to say.
     */
    async keep(
      documentId: string,
      input: { id: string; file: string; contentHash: string; size: number },
    ): Promise<KeptDeck[]> {
      const at = now();
      db.run(
        `INSERT INTO deck_kept (id, document_id, file, content_hash, size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.id, documentId, input.file, input.contentHash, BigInt(input.size), at, at],
      );
      const all = of(documentId);
      const letGo = all.slice(0, Math.max(0, all.length - MAX_KEPT));
      for (const each of letGo) await forget(each);
      return letGo;
    },

    /** Forgets the kept states of Documents the Library deleted for good, and their files. */
    async dropGone(exists: (documentId: string) => boolean): Promise<void> {
      const documents = db.all<{ document_id: string }>(
        "SELECT DISTINCT document_id FROM deck_kept WHERE deleted_at IS NULL",
      );
      for (const { document_id: documentId } of documents) {
        if (exists(documentId)) continue;
        for (const each of of(documentId)) await forget(each);
        await rm(join(dataDir, KEPT_DECKS_FOLDER, documentId), { recursive: true, force: true });
      }
    },
  };
}

export type KeptDecks = ReturnType<typeof createKeptDecks>;
