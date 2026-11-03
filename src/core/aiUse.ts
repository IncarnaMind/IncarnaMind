/**
 * The record of AI use (#292): each time the AI put something into a Mind, or
 * proposed it and the User turned it down, and what became of it. Universities
 * and publishers ask writers to declare how they used AI; once the User edits
 * AI text it no longer shows as generated, so the record is kept from the
 * start. In the alpha it only records.
 *
 * What it holds, in the `ai_use` table: the kind of use, the model (or the
 * outside agent, by its name, #352), the size in characters, when, the stable ids of the Blocks the insertion made (ADR-0003)
 * and a hash of each Block's text as inserted. Never the text itself, of the
 * AI's or of the Mind's. It is never sent anywhere, whatever the usage-data
 * setting (ADR-0014): this module has no network, no data flow and no usage
 * event, and a test keeps it so.
 *
 * Outcomes ("edited by the User", "deleted") come from comparing the Mind's
 * Blocks, found by id, with the hashes. That runs off the keystroke path: a
 * stored update only notes that its Mind changed, and the comparison runs
 * once the Mind has been quiet for a moment, when the record is read, and
 * when the core closes.
 */
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  type AiUseCleared,
  type AiUseEntry,
  type AiUseKind,
  type AiUseOutcome,
  type AiUseStatus,
  aiUseKinds,
  BLOCK_ID_ATTRIBUTE,
} from "./api";
import { InvalidInputError, isRecord } from "./errors";
import type { MindContent } from "./mindContent";
import { parseIds, parseMindId } from "./minds";
import type { Database } from "./storage";

/** How long a Mind must stay unchanged before its Blocks are compared with the record. */
const QUIET_MS = 2_000;
/** The most entries one call records. */
const MAX_INPUTS = 500;
const MAX_NAME_CHARACTERS = 200;

interface TrackedBlock {
  id: string;
  /** Hash of the Block's text when it was inserted; null until the Block has been seen in the Mind. */
  hash: string | null;
}

interface Row {
  id: string;
  mind_id: string;
  kind: string;
  outcome: string;
  provider_id: string | null;
  model_id: string | null;
  agent: string | null;
  characters: number;
  blocks: string;
  occurred_at: string;
}

const COLUMNS =
  "id, mind_id, kind, outcome, provider_id, model_id, agent, characters, blocks, occurred_at";

const isKind = (value: unknown): value is AiUseKind => aiUseKinds.some((kind) => kind === value);

const isOutcome = (value: string): value is AiUseOutcome =>
  value === "kept" || value === "edited" || value === "deleted" || value === "rejected";

/** The text of a Block and what it holds, without attributes, so only the User's words and structure count. */
function textOf(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .map((part: { insert: unknown }) => (typeof part.insert === "string" ? part.insert : "￼"))
      .join("");
  }
  if (node instanceof Y.XmlElement) {
    return `<${node.nodeName}>${node.toArray().map(textOf).join("")}</${node.nodeName}>`;
  }
  return "";
}

const hashOf = (element: Y.XmlElement) =>
  createHash("sha256").update(textOf(element)).digest("hex");

/** The hash of each wanted Block that is in the Mind, at any depth. */
function hashBlocks(blocks: Y.XmlFragment, wanted: ReadonlySet<string>): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const id = child.getAttribute(BLOCK_ID_ATTRIBUTE);
      if (typeof id === "string" && wanted.has(id)) found.set(id, hashOf(child));
      visit(child);
    }
  };
  visit(blocks);
  return found;
}

function parseBlocks(json: string): TrackedBlock[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): TrackedBlock[] =>
      isRecord(item) && typeof item.id === "string"
        ? [{ id: item.id, hash: typeof item.hash === "string" ? item.hash : null }]
        : [],
    );
  } catch {
    return [];
  }
}

/**
 * What became of an insertion. A Block not seen in the Mind yet (its update is
 * still on its way) counts for nothing; of those seen, all gone is "deleted",
 * any gone or changed is "edited", and the rest is "kept".
 */
function outcomeOf(
  blocks: readonly TrackedBlock[],
  found: ReadonlyMap<string, string>,
  before: AiUseOutcome,
): AiUseOutcome {
  const seen = blocks.filter((block) => block.hash !== null);
  if (seen.length === 0) return before;
  const gone = seen.filter((block) => !found.has(block.id)).length;
  if (gone === seen.length) return "deleted";
  const changed = seen.some((block) => {
    const now = found.get(block.id);
    return now !== undefined && now !== block.hash;
  });
  return gone > 0 || changed ? "edited" : "kept";
}

function parseText(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_NAME_CHARACTERS) {
    throw new InvalidInputError(`${what} must be text.`);
  }
  return value;
}

interface Parsed {
  mindId: string;
  kind: AiUseKind;
  providerId: string | null;
  modelId: string | null;
  agent: string | null;
  characters: number;
  blockIds: string[];
  occurredAt: string | null;
}

function parseInput(input: unknown): Parsed {
  if (!isRecord(input)) throw new InvalidInputError("A record of AI use must be an object.");
  if (!isKind(input.kind)) throw new InvalidInputError("That isn't a kind of AI use.");
  const { characters } = input;
  if (typeof characters !== "number" || !Number.isInteger(characters) || characters < 0) {
    throw new InvalidInputError("characters must be a whole number, 0 or more.");
  }
  let occurredAt: string | null = null;
  if (input.occurredAt !== undefined) {
    if (typeof input.occurredAt !== "string" || Number.isNaN(Date.parse(input.occurredAt))) {
      throw new InvalidInputError("occurredAt must be a date and time.");
    }
    occurredAt = new Date(input.occurredAt).toISOString();
  }
  return {
    mindId: parseMindId(input.mindId),
    kind: input.kind,
    providerId: parseText(input.providerId, "providerId"),
    modelId: parseText(input.modelId, "modelId"),
    agent: parseText(input.agent, "agent"),
    characters,
    // A rejected proposal made no Blocks, so there is nothing to follow.
    blockIds:
      input.kind === "assistant-change-rejected" ? [] : parseIds(input.blockIds, "blockIds"),
    occurredAt,
  };
}

export interface AiUseOptions {
  db: Database;
  now: () => string;
  content: MindContent;
  /** Throws `NotFoundError` unless the Mind exists. */
  requireMind(mindId: string): void;
  changed(status: AiUseStatus): void;
  reportError(error: unknown): void;
}

export function createAiUse(options: AiUseOptions) {
  const { db, content } = options;

  /** Minds with entries that follow Blocks, so a Mind without any costs a stored update nothing. */
  const followed = new Set<string>();
  const loadFollowed = () => {
    followed.clear();
    const rows = db.all<{ mind_id: string }>(
      `SELECT DISTINCT mind_id FROM ai_use
       WHERE deleted_at IS NULL AND outcome <> 'rejected' AND blocks <> '[]'`,
    );
    for (const row of rows) followed.add(row.mind_id);
  };
  loadFollowed();

  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const toEntry = (row: Row): AiUseEntry => ({
    id: row.id,
    mindId: row.mind_id,
    kind: isKind(row.kind) ? row.kind : "answer-added",
    outcome: isOutcome(row.outcome) ? row.outcome : "kept",
    providerId: row.provider_id,
    modelId: row.model_id,
    agent: row.agent,
    characters: row.characters,
    blockIds: parseBlocks(row.blocks).map((block) => block.id),
    occurredAt: row.occurred_at,
  });

  const status = (): AiUseStatus => ({
    entries:
      db.get<{ n: number }>("SELECT count(*) AS n FROM ai_use WHERE deleted_at IS NULL")?.n ?? 0,
  });
  const announce = () => options.changed(status());

  /** Compares one Mind's Blocks with its entries and stores what changed. */
  const refreshMind = (mindId: string) => {
    // A Mind in Recently deleted keeps its content out of reach: its entries stay as they were.
    if (!db.get("SELECT 1 FROM minds WHERE id = ? AND deleted_at IS NULL", [mindId])) return;
    const rows = db.all<Row>(
      `SELECT ${COLUMNS} FROM ai_use
       WHERE mind_id = ? AND deleted_at IS NULL AND outcome <> 'rejected' AND blocks <> '[]'`,
      [mindId],
    );
    if (rows.length === 0) return;
    const entries = rows.map((row) => ({ row, blocks: parseBlocks(row.blocks) }));
    const wanted = new Set(entries.flatMap((entry) => entry.blocks.map((block) => block.id)));
    const found = content.peek(mindId, (blocks) => hashBlocks(blocks, wanted));
    const at = options.now();
    db.transaction(() => {
      for (const { row, blocks } of entries) {
        let baselined = false;
        const tracked = blocks.map((block): TrackedBlock => {
          const hash = found.get(block.id);
          if (block.hash === null && hash !== undefined) {
            baselined = true;
            return { id: block.id, hash };
          }
          return block;
        });
        const before = isOutcome(row.outcome) ? row.outcome : "kept";
        const outcome = outcomeOf(tracked, found, before);
        if (!baselined && outcome === before) continue;
        db.run("UPDATE ai_use SET outcome = ?, blocks = ?, updated_at = ? WHERE id = ?", [
          outcome,
          JSON.stringify(tracked),
          at,
          row.id,
        ]);
      }
    });
  };

  const refreshDirty = () => {
    for (const mindId of [...dirty]) {
      dirty.delete(mindId);
      try {
        refreshMind(mindId);
      } catch (error) {
        options.reportError(error);
      }
    }
  };

  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    /** A Mind's content was stored. Only notes it; the comparison waits for quiet. */
    contentStored(mindId: string): void {
      if (!followed.has(mindId)) return;
      dirty.add(mindId);
      stopTimer();
      timer = setTimeout(() => {
        timer = undefined;
        refreshDirty();
      }, QUIET_MS);
      // A pending comparison must not keep the app from quitting; close runs it.
      timer.unref?.();
    },

    record(inputs: unknown): AiUseEntry[] {
      if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) {
        throw new InvalidInputError(`Record up to ${MAX_INPUTS} uses of AI at a time.`);
      }
      const parsed = inputs.map(parseInput);
      for (const mindId of new Set(parsed.map((each) => each.mindId))) options.requireMind(mindId);

      const wanted = new Map<string, Set<string>>();
      for (const each of parsed) {
        const ids = wanted.get(each.mindId) ?? new Set<string>();
        for (const id of each.blockIds) ids.add(id);
        wanted.set(each.mindId, ids);
      }
      // As inserted: the Mind's update comes before the record, so the Blocks are normally here.
      const present = new Map<string, Map<string, string>>();
      for (const [mindId, ids] of wanted) {
        if (ids.size > 0)
          present.set(
            mindId,
            content.peek(mindId, (b) => hashBlocks(b, ids)),
          );
      }

      const at = options.now();
      const entries = db.transaction(() =>
        parsed.map((each): AiUseEntry => {
          const id = randomUUID();
          const hashes = present.get(each.mindId);
          const blocks: TrackedBlock[] = each.blockIds.map((blockId) => ({
            id: blockId,
            hash: hashes?.get(blockId) ?? null,
          }));
          const outcome: AiUseOutcome =
            each.kind === "assistant-change-rejected" ? "rejected" : "kept";
          const occurredAt = each.occurredAt ?? at;
          db.run(
            `INSERT INTO ai_use
               (id, mind_id, kind, outcome, provider_id, model_id, agent, characters, blocks,
                occurred_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              each.mindId,
              each.kind,
              outcome,
              each.providerId,
              each.modelId,
              each.agent,
              each.characters,
              JSON.stringify(blocks),
              occurredAt,
              at,
              at,
            ],
          );
          return {
            id,
            mindId: each.mindId,
            kind: each.kind,
            outcome,
            providerId: each.providerId,
            modelId: each.modelId,
            agent: each.agent,
            characters: each.characters,
            blockIds: each.blockIds,
            occurredAt,
          };
        }),
      );
      for (const each of parsed) if (each.blockIds.length > 0) followed.add(each.mindId);
      if (entries.length > 0) announce();
      return entries;
    },

    list(mindId?: unknown): AiUseEntry[] {
      const only = mindId === undefined ? undefined : parseMindId(mindId);
      for (const id of only ? [only] : [...followed]) {
        try {
          refreshMind(id);
        } catch (error) {
          options.reportError(error);
        }
      }
      dirty.clear();
      const rows = only
        ? db.all<Row>(
            `SELECT ${COLUMNS} FROM ai_use WHERE mind_id = ? AND deleted_at IS NULL
             ORDER BY occurred_at, rowid`,
            [only],
          )
        : db.all<Row>(
            `SELECT ${COLUMNS} FROM ai_use WHERE deleted_at IS NULL ORDER BY occurred_at, rowid`,
          );
      return rows.map(toEntry);
    },

    status,

    clear(): AiUseCleared {
      const clearedAt = options.now();
      const { entries: count } = status();
      db.run("UPDATE ai_use SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL", [
        clearedAt,
        clearedAt,
      ]);
      followed.clear();
      dirty.clear();
      if (count > 0) announce();
      return { clearedAt, count };
    },

    restore(clearedAt: unknown): AiUseStatus {
      if (typeof clearedAt !== "string" || clearedAt === "") {
        throw new InvalidInputError("clearedAt must be the time the record was cleared.");
      }
      db.run("UPDATE ai_use SET deleted_at = NULL, updated_at = ? WHERE deleted_at = ?", [
        options.now(),
        clearedAt,
      ]);
      loadFollowed();
      announce();
      return status();
    },

    /** Compares what is waiting, then stops: nothing runs after the core closes. */
    close(): void {
      stopTimer();
      refreshDirty();
    },
  };
}
