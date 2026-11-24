/**
 * A deck of the User's own as it stood before each sitting of editing it by hand (#149, ADR-0010
 * 2026-11-24): kept whole in the data folder's "Kept decks", so the User can put the deck back as
 * it was. For each Document, the first state kept (the file as it was before IncarnaMind first
 * wrote it) stays while the deck is in the Library, with the newest others up to `MAX_KEPT` in all,
 * and the others across every deck up to `MAX_KEPT_BYTES`; a state already kept isn't kept twice.
 * What goes is let go only after a write succeeds, and the line that says what was saved says so.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../storage";

/** The data folder's folder of kept decks, one folder a Document. */
export const KEPT_DECKS_FOLDER = "Kept decks";
/** How many states of one deck are kept, its first among them. */
export const MAX_KEPT = 10;
/** How large the kept states other than each deck's first may be together. */
export const MAX_KEPT_BYTES = 2 * 1024 ** 3;

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

export function createKeptDecks(options: {
  db: Database;
  dataDir: string;
  now(): string;
  /** `MAX_KEPT_BYTES`, smaller in a test. */
  maxBytes?: number;
}) {
  const { db, dataDir, now } = options;
  const maxBytes = options.maxBytes ?? MAX_KEPT_BYTES;

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

  /** Every Document's kept states but its first, oldest first. */
  const others = (): KeptDeck[] =>
    db
      .all<Row>(
        `SELECT ${COLUMNS} FROM deck_kept AS k WHERE deleted_at IS NULL AND rowid <> (
           SELECT rowid FROM deck_kept WHERE document_id = k.document_id AND deleted_at IS NULL
           ORDER BY created_at, rowid LIMIT 1)
         ORDER BY created_at, rowid`,
      )
      .map(toKept);

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

    /** The Document's state with these bytes, if one is kept already. */
    find(documentId: string, contentHash: string): KeptDeck | null {
      return of(documentId).find((each) => each.contentHash === contentHash) ?? null;
    },

    /** Where a new kept state's file goes, relative to the data folder. */
    fileFor: (documentId: string, keptId: string): string =>
      join(KEPT_DECKS_FOLDER, documentId, `${keptId}.pptx`),

    /** Records a state as kept, its file written already. Lets nothing go: see `letGo`. */
    add(
      documentId: string,
      input: { id: string; file: string; contentHash: string; size: number },
    ): void {
      const at = now();
      db.run(
        `INSERT INTO deck_kept (id, document_id, file, content_hash, size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.id, documentId, input.file, input.contentHash, BigInt(input.size), at, at],
      );
    },

    /**
     * Once a write that kept a state has succeeded: lets the Document's states past `MAX_KEPT` go,
     * never its first, then the oldest others of every deck past `MAX_KEPT_BYTES`. Returns the
     * Document's own let go, for the line to say.
     */
    async letGo(documentId: string): Promise<KeptDeck[]> {
      const all = of(documentId);
      const gone = all.slice(1, Math.max(1, all.length - (MAX_KEPT - 1)));
      for (const each of gone) await forget(each);
      let total = others().reduce((sum, each) => sum + each.size, 0);
      for (const each of others()) {
        if (total <= maxBytes) break;
        await forget(each);
        if (each.documentId === documentId) gone.push(each);
        total -= each.size;
      }
      return gone;
    },

    /**
     * Forgets the kept states of Documents the Library deleted for good, and takes out any file in
     * "Kept decks" no kept state names (one a crash left between writing it and recording it).
     */
    async dropGone(exists: (documentId: string) => boolean): Promise<void> {
      const documents = db.all<{ document_id: string }>(
        "SELECT DISTINCT document_id FROM deck_kept WHERE deleted_at IS NULL",
      );
      for (const { document_id: documentId } of documents) {
        if (exists(documentId)) continue;
        for (const each of of(documentId)) await forget(each);
        await rm(join(dataDir, KEPT_DECKS_FOLDER, documentId), { recursive: true, force: true });
      }
      const named = new Set(
        db
          .all<{ file: string }>("SELECT file FROM deck_kept WHERE deleted_at IS NULL")
          .map((row) => join(dataDir, row.file)),
      );
      const root = join(dataDir, KEPT_DECKS_FOLDER);
      for (const folder of await readdir(root).catch(() => [] as string[])) {
        const inside = await readdir(join(root, folder)).catch(() => [] as string[]);
        const left = inside.filter((name) => !named.has(join(root, folder, name)));
        for (const name of left)
          await rm(join(root, folder, name), { recursive: true, force: true });
        if (left.length === inside.length)
          await rm(join(root, folder), { recursive: true, force: true });
      }
    },
  };
}

export type KeptDecks = ReturnType<typeof createKeptDecks>;
