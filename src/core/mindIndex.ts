/**
 * The words inside Minds, for ⌘K's "In your notes": each Mind's top-level
 * Blocks as plain text in `mind_blocks`, their words in a keyword index
 * segmented as Passages' are (./documents/keywords), so Chinese is found as in
 * Documents.
 *
 * Typing never waits on it: a stored update only notes its Mind, whose Blocks
 * are read again once it has been quiet for a moment (every few seconds while
 * typing goes on), before a search, and when the core closes. Only Blocks
 * whose text or place changed are written. Minds never read, or stored to
 * after they were last read (a quit in between), are read in the background
 * after the core starts.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { perBlock } from "../shared/memo";
import { cutAtWord, cutTitle } from "../shared/naming";
import { BLOCK_ID_ATTRIBUTE, type MindTextMatch } from "./api";
import { keywordText } from "./documents/keywords";
import { InvalidInputError } from "./errors";
import type { MindContent } from "./mindContent";
import { blockText } from "./mindText";
import type { Database } from "./storage";
import { excerptOf, searchTerms, termQuery } from "./wordSearch";

const QUIET_MS = 500;
const MAX_WAIT_MS = 3_000;
/** How long the background walk reads before it lets the core answer requests again. */
const WALK_SLICE_MS = 10;
const MAX_MINDS = 20;

const IN = "IN (SELECT value FROM json_each(?))";

interface ReadBlock {
  blockId: string;
  kind: string;
  position: number;
  text: string;
}

interface StoredBlock {
  seq: number;
  block_id: string;
  kind: string;
  position: number;
  text: string;
  deleted: number;
}

export interface LeadingLine {
  kind: string;
  text: string;
}

const LEADING_LINES = 2;
/** Enough for a row that cuts it to one line, without carrying a pasted paragraph whole. */
const LINE_LENGTH = 300;

const firstLine = (text: string) => {
  const line = text
    .split("\n")
    .find((each) => each.trim() !== "")
    ?.trim();
  return line && cutAtWord(line, LINE_LENGTH);
};

function leadingLinesOf(blocks: readonly Pick<ReadBlock, "kind" | "text">[]): LeadingLine[] {
  const lines: LeadingLine[] = [];
  for (const block of blocks) {
    const text = firstLine(block.text);
    if (text) lines.push({ kind: block.kind, text });
    if (lines.length === LEADING_LINES) break;
  }
  return lines;
}

/**
 * The line Home's Recent shows under a Mind's name: its first line, or the next one when the
 * first is its title heading, or is the name or the line the name was cut from.
 */
export function lineUnderName(lines: readonly LeadingLine[], name: string): string | undefined {
  const [first, second] = lines;
  if (!first) return undefined;
  const named = first.kind === "heading" || first.text === name || cutTitle(first.text) === name;
  return named ? second?.text : first.text;
}

/** A Block's words, read again only once a change touches it: a long Note is read after each burst of typing. */
const textOfBlock = perBlock(blockText);

function readTopLevel(blocks: Y.XmlFragment): ReadBlock[] {
  const read: ReadBlock[] = [];
  const seen = new Set<string>();
  blocks.toArray().forEach((child, position) => {
    if (!(child instanceof Y.XmlElement)) return;
    const id: unknown = child.getAttribute(BLOCK_ID_ATTRIBUTE);
    // The editor gives a Block its id just after making it: it is read once it has one.
    if (typeof id !== "string" || id === "" || seen.has(id)) return;
    seen.add(id);
    read.push({ blockId: id, kind: child.nodeName, position, text: textOfBlock(child) });
  });
  return read;
}

/** Drops the words of Minds deleted permanently. Run in the transaction that purges them. */
export function forgetMindBlocks(db: Database, mindIds: readonly string[], at: string): void {
  const list = JSON.stringify(mindIds);
  db.run(
    `UPDATE mind_blocks SET text = '', updated_at = ?, deleted_at = ?
     WHERE mind_id ${IN} AND deleted_at IS NULL`,
    [at, at, list],
  );
  db.run(
    `UPDATE mind_block_reads SET updated_at = ?, deleted_at = ?
     WHERE mind_id ${IN} AND deleted_at IS NULL`,
    [at, at, list],
  );
}

export function createMindIndex(options: {
  db: Database;
  now: () => string;
  content: Pick<MindContent, "peek">;
  reportError(error: unknown): void;
}) {
  const { db, now, content } = options;
  const dirty = new Set<string>();
  let leading: Map<string, LeadingLine[]> | null = null;
  /** The Minds the walk has still to read; null until they are looked up. */
  let unread: string[] | null = null;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let longest: ReturnType<typeof setTimeout> | undefined;
  let walking: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const staleMinds = () =>
    db
      .all<{ id: string }>(
        `SELECT m.id FROM minds m
         LEFT JOIN mind_block_reads r ON r.mind_id = m.id AND r.deleted_at IS NULL
         WHERE m.deleted_at IS NULL AND m.kind = 'mind' AND (
           r.updated_at IS NULL OR EXISTS (
             SELECT 1 FROM mind_updates u
             WHERE u.mind_id = m.id AND u.deleted_at IS NULL AND u.created_at > r.updated_at))
         ORDER BY m.updated_at DESC`,
      )
      .map((row) => row.id);

  const toRead = (): string[] => {
    unread ??= staleMinds();
    return unread;
  };

  const indexWords = (seq: number, text: string) => {
    db.run("DELETE FROM mind_blocks_fts WHERE rowid = ?", [BigInt(seq)]);
    if (text !== "") {
      db.run("INSERT INTO mind_blocks_fts (rowid, text) VALUES (?, ?)", [
        BigInt(seq),
        keywordText(text),
      ]);
    }
  };

  const read = (mindId: string) => {
    const live = db.get(
      "SELECT 1 FROM minds WHERE id = ? AND kind = 'mind' AND deleted_at IS NULL",
      [mindId],
    );
    // A Mind in Recently deleted keeps its rows as they were, for when it is restored.
    if (!live) return;
    const blocks = content.peek(mindId, readTopLevel);
    leading?.set(mindId, leadingLinesOf(blocks));
    const stored = new Map(
      db
        .all<StoredBlock>(
          `SELECT seq, block_id, kind, position, text, deleted_at IS NOT NULL AS deleted
           FROM mind_blocks WHERE mind_id = ?`,
          [mindId],
        )
        .map((row) => [row.block_id, row]),
    );
    const at = now();
    db.transaction(() => {
      for (const block of blocks) {
        const row = stored.get(block.blockId);
        stored.delete(block.blockId);
        if (!row) {
          const added = db.get<{ seq: number }>(
            `INSERT INTO mind_blocks
               (id, mind_id, block_id, kind, position, text, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
            [randomUUID(), mindId, block.blockId, block.kind, block.position, block.text, at, at],
          );
          if (added) indexWords(added.seq, block.text);
          continue;
        }
        const textChanged = row.deleted === 1 || row.text !== block.text;
        if (!textChanged && row.kind === block.kind && row.position === block.position) continue;
        db.run(
          `UPDATE mind_blocks SET kind = ?, position = ?, text = ?, updated_at = ?, deleted_at = NULL
           WHERE seq = ?`,
          [block.kind, block.position, block.text, at, row.seq],
        );
        if (textChanged) indexWords(row.seq, block.text);
      }
      for (const row of stored.values()) {
        if (row.deleted === 1) continue;
        db.run("UPDATE mind_blocks SET text = '', updated_at = ?, deleted_at = ? WHERE seq = ?", [
          at,
          at,
          row.seq,
        ]);
      }
      db.run(
        `INSERT INTO mind_block_reads (id, mind_id, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (mind_id) WHERE deleted_at IS NULL DO UPDATE SET updated_at = excluded.updated_at`,
        [randomUUID(), mindId, at, at],
      );
    });
  };

  const readSafely = (mindId: string) => {
    try {
      read(mindId);
    } catch (error) {
      options.reportError(error);
    }
  };

  /** Reads the Minds stored to since they were last read, so what was just typed is found. */
  const readChanged = () => {
    clearTimeout(quiet);
    clearTimeout(longest);
    quiet = undefined;
    longest = undefined;
    for (const mindId of [...dirty]) {
      dirty.delete(mindId);
      readSafely(mindId);
    }
  };

  const walk = () => {
    walking = undefined;
    if (closed) return;
    const left = toRead();
    const until = performance.now() + WALK_SLICE_MS;
    do {
      const mindId = left.shift();
      if (mindId !== undefined) readSafely(mindId);
    } while (left.length > 0 && performance.now() < until);
    if (left.length > 0) {
      walking = setTimeout(walk, 0);
      walking.unref?.();
    }
  };

  /** Each Mind's best Block for an FTS5 query, best Mind first. */
  const bestBlocks = (match: string, mindIds: readonly string[] | null, limit: number) =>
    db.all<{ mind_id: string; block_id: string; position: number; text: string }>(
      // MATERIALIZED: bm25() can only be worked out before the rows are grouped.
      `WITH scored AS MATERIALIZED (
         SELECT b.mind_id, b.seq, bm25(mind_blocks_fts) AS score
         FROM mind_blocks_fts
         JOIN mind_blocks b ON b.seq = mind_blocks_fts.rowid
         JOIN minds m ON m.id = b.mind_id
         WHERE mind_blocks_fts MATCH ? AND b.deleted_at IS NULL AND m.deleted_at IS NULL
           ${mindIds ? `AND b.mind_id ${IN}` : ""})
       SELECT b.mind_id, b.block_id, b.position, b.text FROM (
         SELECT seq, min(score) AS best FROM scored GROUP BY mind_id ORDER BY best LIMIT ?
       ) top
       JOIN mind_blocks b ON b.seq = top.seq
       ORDER BY top.best`,
      [match, ...(mindIds ? [JSON.stringify(mindIds)] : []), BigInt(limit)],
    );

  const mindsWith = (term: readonly string[]) =>
    db
      .all<{ mind_id: string }>(
        `SELECT DISTINCT b.mind_id FROM mind_blocks_fts
         JOIN mind_blocks b ON b.seq = mind_blocks_fts.rowid
         WHERE mind_blocks_fts MATCH ? AND b.deleted_at IS NULL`,
        [termQuery(term)],
      )
      .map((row) => row.mind_id);

  /** The Minds that hold every term, in any of their Blocks. */
  const mindsWithEvery = (terms: readonly (readonly string[])[]) => {
    const [first, ...rest] = terms;
    let common = first ? mindsWith(first) : [];
    for (const term of rest) {
      if (common.length === 0) break;
      const ids = new Set(mindsWith(term));
      common = common.filter((id) => ids.has(id));
    }
    return common;
  };

  const headingAbove = (mindId: string, position: number) =>
    db
      .get<{ text: string }>(
        `SELECT text FROM mind_blocks
         WHERE mind_id = ? AND kind = 'heading' AND position < ? AND deleted_at IS NULL
         ORDER BY position DESC LIMIT 1`,
        [mindId, position],
      )
      ?.text.split("\n")[0] ?? "";

  return {
    /** Starts the background walk, off the start-up path. */
    start(): void {
      walking = setTimeout(walk, 0);
      walking.unref?.();
    },

    contentStored(mindId: string): void {
      if (closed) return;
      dirty.add(mindId);
      clearTimeout(quiet);
      quiet = setTimeout(readChanged, QUIET_MS);
      quiet.unref?.();
      if (longest === undefined) {
        longest = setTimeout(readChanged, MAX_WAIT_MS);
        longest.unref?.();
      }
    },

    /** See `CoreApi.searchMinds`. */
    search(query: unknown): MindTextMatch[] {
      if (typeof query !== "string") throw new InvalidInputError("A search must be text.");
      const terms = searchTerms(query);
      if (terms.length === 0) return [];
      readChanged();
      const found = bestBlocks(terms.map(termQuery).join(" AND "), null, MAX_MINDS);
      // A Mind holding every word, though in different Blocks, comes after those with one that holds them all.
      if (terms.length > 1 && found.length < MAX_MINDS) {
        const shown = new Set(found.map((row) => row.mind_id));
        const others = mindsWithEvery(terms).filter((id) => !shown.has(id));
        if (others.length > 0) {
          const any = terms.map(termQuery).join(" OR ");
          found.push(...bestBlocks(any, others, MAX_MINDS - found.length));
        }
      }
      return found.map((row) => ({
        mindId: row.mind_id,
        blockId: row.block_id,
        heading: headingAbove(row.mind_id, row.position),
        // On one line, so the excerpt's offsets stay those of the text.
        ...excerptOf(row.text.replaceAll("\n", " "), terms),
      }));
    },

    /**
     * Each Mind's first lines of text, as typed a moment ago. They are read from the index once,
     * then kept: only a Mind stored to since is read again.
     */
    leadingLines(): ReadonlyMap<string, readonly LeadingLine[]> {
      if (!leading) {
        const rows = db.all<{ mind_id: string; kind: string; text: string }>(
          `SELECT mind_id, kind, text FROM (
             SELECT b.mind_id, b.kind, b.text,
               ROW_NUMBER() OVER (PARTITION BY b.mind_id ORDER BY b.position) AS n
             FROM mind_blocks b JOIN minds m ON m.id = b.mind_id
             WHERE b.deleted_at IS NULL AND m.deleted_at IS NULL AND trim(b.text) <> '')
           WHERE n <= ?
           ORDER BY mind_id, n`,
          [BigInt(LEADING_LINES)],
        );
        const filled = new Map<string, LeadingLine[]>();
        for (const row of rows) {
          const lines = filled.get(row.mind_id) ?? [];
          lines.push(...leadingLinesOf([row]));
          filled.set(row.mind_id, lines);
        }
        leading = filled;
      }
      readChanged();
      return leading;
    },

    /** Reads the Minds just stored to, and stops. Run before the database closes. */
    close(): void {
      if (closed) return;
      clearTimeout(walking);
      unread = [];
      readChanged();
      closed = true;
    },
  };
}
