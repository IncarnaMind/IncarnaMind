/**
 * History (#113): Checkpoints of each Mind (CONTEXT.md), compared and
 * restored. A Checkpoint is the Mind's whole Yjs document, saved apart from
 * its stored updates, so compacting a Mind (../mindContent) never touches it.
 *
 * - One is saved just before every AI change (`save`, from the renderer and
 *   the core's own features), and once a Mind has been left alone for
 *   `CHECKPOINT_IDLE_MS`. A state already saved isn't saved again: the Yjs
 *   snapshot, which holds what was deleted, is compared with the last one's.
 * - Idle ones thin out as they age (./thinning); the others are kept for good.
 * - The Document versions a Checkpoint's Citations quote are retained (#79),
 *   so a restored Citation still checks; thinning one releases them.
 * - Restoring brings a Checkpoint's Blocks back as a new change, after saving
 *   one of the Mind as it is: nothing is rolled back, and both stay. Changes
 *   that were waiting in it don't come back: it reads as History showed it.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { figureRunsFor, installFigureRuns } from "../../shared/figureRuns";
import { resolveProposals } from "../../shared/proposals";
import { citationElementId, isMine, signOffsOf } from "../../shared/signOffs";
import { nodeOf, topLevelBlocks } from "../answers/blocks";
import { citationSentences } from "../answers/checks/sentences";
import { addCitedUnits, addCitedVersions, type CitedUnits } from "../answers/citedVersions";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  CHECKPOINT_IDLE_MS,
  CHECKPOINT_REASONS,
  type Checkpoint,
  type CheckpointList,
  type CheckpointReason,
  CITATION_NODE,
  type CitationAttributes,
  CONTENT_SCHEMA_VERSION,
  MIND_CONTENT_FIELD,
  type MindComparison,
  RECENTLY_DELETED_DAYS,
  type RenamedCheckpoint,
  type RestoredCheckpoint,
  WORD_CHANGE_ID,
} from "../api";
import type { RetainVersion, VersionRetention } from "../documents/retention";
import { InvalidInputError, isRecord, MindReadOnlyError, NotFoundError } from "../errors";
import type { MindContent } from "../mindContent";
import { docOf } from "../proposals/merge";
import type { Database } from "../storage";
import { compareVersions } from "./compare";
import { idleToThin } from "./thinning";

export interface CheckpointsOptions {
  db: Database;
  now(): string;
  content: Pick<MindContent, "storedState" | "peek" | "edit" | "contentVersion">;
  retention: Pick<VersionRetention, "retain" | "release">;
  rebuildFigureRetention(mindId: string): void;
  /** The Mind's id, once it is known to exist, not deleted, and of a kind this version writes. */
  requireMind(mindId: unknown): string;
  changed(mindId: string): void;
  /** Stops an Answer being written in the Mind, keeping what it has. */
  stopAnswer(mindId: string, answerId: string): void;
  /** Marks the Mind's Answers left "streaming" with nothing writing them as stopped. */
  settleAnswers(mindId: string): void;
  reportError(error: unknown): void;
  /** The User, whose own checks a restore counts (#1933). */
  personId(): string | null;
}

interface Row {
  id: string;
  mind_id: string;
  reason: string;
  created_at: string;
  name: string | null;
  detail: string | null;
}

const COLUMNS = "id, mind_id, reason, created_at, name, detail";

const isReason = (value: unknown): value is CheckpointReason =>
  CHECKPOINT_REASONS.some((reason) => reason === value);

function parseReason(value: unknown): CheckpointReason {
  if (!isReason(value))
    throw new InvalidInputError(`"${String(value)}" isn't why a Checkpoint is saved.`);
  return value;
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "")
    throw new InvalidInputError(`${what} must be an id.`);
  return value;
}

/** A row as a Checkpoint. A reason a newer version wrote reads as a kept one's, never as idle. */
const toCheckpoint = (row: Row): Checkpoint => ({
  id: row.id,
  mindId: row.mind_id,
  reason: isReason(row.reason) ? row.reason : "others",
  createdAt: row.created_at,
  name: row.name,
  file: row.detail,
});

const streamingAnswers = (blocks: Y.XmlFragment): string[] =>
  blocks.toArray().flatMap((block) => {
    if (!(block instanceof Y.XmlElement) || block.nodeName !== ANSWER_BLOCK) return [];
    const id = block.getAttribute(BLOCK_ID_ATTRIBUTE);
    return block.getAttribute("status") === "streaming" && typeof id === "string" ? [id] : [];
  });

/** The versions of Documents the Citations in a Mind's document quote, and their Units. */
function citedIn(doc: Y.Doc): RetainVersion[] {
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const versions = new Map<string, Set<string> | "any">();
  addCitedVersions(blocks, versions);
  const units: CitedUnits[] = [];
  addCitedUnits(blocks, new Set(versions.keys()), units);
  return units.flatMap(({ documentId, contentHash, pageFrom, pageTo }) =>
    contentHash ? [{ documentId, contentHash, pageFrom, pageTo }] : [],
  );
}

const CITATION_ID = "id" satisfies keyof CitationAttributes;

/**
 * A restore never changes the User's marks. It copies each Citation it brings back, so one without
 * an id of its own first takes the one it goes by in every version (`citationElementId`): a mark
 * made on it, before or after this restore, then finds it however it was edited or deleted.
 */
function nameCitations(blocks: Y.XmlFragment): void {
  for (const block of blocks.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    for (const node of block.createTreeWalker(
      (each) => each instanceof Y.XmlElement && each.nodeName === CITATION_NODE,
    )) {
      if (!(node instanceof Y.XmlElement) || typeof node.getAttribute(CITATION_ID) === "string")
        continue;
      const id = citationElementId(node);
      if (id) node.setAttribute(CITATION_ID, id);
    }
  }
}

export function createCheckpoints(options: CheckpointsOptions) {
  const { db, content, retention } = options;
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const docOfCheckpoint = (mindId: string, checkpointId: unknown): Y.Doc => {
    const row = db.get<{ data: Uint8Array }>(
      "SELECT data FROM mind_checkpoints WHERE id = ? AND mind_id = ? AND deleted_at IS NULL",
      [parseId(checkpointId, "A Checkpoint"), mindId],
    );
    if (!row) throw new NotFoundError({ key: "error.history.gone" });
    return docOf(row.data);
  };

  /** Thins a Mind's idle Checkpoints out, and forgets those thinned long enough ago. */
  const thin = (mindId: string) => {
    const idle = db.all<Row>(
      `SELECT ${COLUMNS} FROM mind_checkpoints
       WHERE mind_id = ? AND reason = 'idle' AND name IS NULL AND deleted_at IS NULL`,
      [mindId],
    );
    const at = options.now();
    const gone = idleToThin(
      idle.map((row) => ({ id: row.id, createdAt: row.created_at })),
      new Date(at),
    );
    for (const id of gone) {
      db.run(
        `UPDATE mind_checkpoints SET data = ?, snapshot = ?, deleted_at = ?, updated_at = ?
         WHERE id = ?`,
        [new Uint8Array(), new Uint8Array(), at, at, id],
      );
      retention.release("checkpoint", id);
    }
    const forgotten = new Date(Date.parse(at) - RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000);
    db.run(
      "DELETE FROM mind_checkpoints WHERE mind_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?",
      [mindId, forgotten.toISOString()],
    );
  };

  const newest = (mindId: string) =>
    db.get<Row & { snapshot: Uint8Array }>(
      `SELECT ${COLUMNS}, snapshot FROM mind_checkpoints
       WHERE mind_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [mindId],
    );

  const sameState = (saved: Uint8Array, snapshot: Y.Snapshot) =>
    saved.byteLength > 0 && Y.equalSnapshots(Y.decodeSnapshot(saved), snapshot);

  /**
   * Saves the Mind as it is, or for one sent as `file`, as it was when it was read for sending
   * (`sentState`): a sent one is always its own.
   */
  const save = (
    mindInput: unknown,
    reasonInput: unknown,
    sent: { file: string; state: Uint8Array } | null = null,
  ): Checkpoint => {
    const reason = parseReason(reasonInput);
    const mindId = options.requireMind(mindInput);
    options.rebuildFigureRetention(mindId);
    const state = sent?.state ?? content.storedState(mindId);
    const file = sent?.file ?? null;
    const doc = docOf(state);
    try {
      const snapshot = Y.snapshot(doc);
      const last = newest(mindId);
      if (last && file === null && sameState(last.snapshot, snapshot)) {
        if (last.reason !== "idle" || reason === "idle") return toCheckpoint(last);
        // Now the state before an AI change: kept for good.
        db.run("UPDATE mind_checkpoints SET reason = ?, updated_at = ? WHERE id = ?", [
          reason,
          options.now(),
          last.id,
        ]);
        options.changed(mindId);
        return { ...toCheckpoint(last), reason };
      }
      const id = randomUUID();
      const at = options.now();
      db.transaction(() => {
        db.run(
          `INSERT INTO mind_checkpoints
             (id, mind_id, reason, data, snapshot, created_at, updated_at, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, mindId, reason, state, Y.encodeSnapshot(snapshot), at, at, file],
        );
        retention.retain("checkpoint", id, citedIn(doc));
        if (reason === "idle") thin(mindId);
      });
      options.changed(mindId);
      return { id, mindId, reason, createdAt: at, name: null, file };
    } finally {
      doc.destroy();
    }
  };

  const saveIdle = (mindId: string) => {
    try {
      save(mindId, "idle");
    } catch (error) {
      // Deleted meanwhile: nothing to keep.
      if (!(error instanceof NotFoundError)) options.reportError(error);
    }
  };

  return {
    save,

    /** The Note was sent as `file`, as `state` held it: a Checkpoint of it as it went, kept for good. */
    sent(mindId: string, file: string, state: Uint8Array): Checkpoint {
      return save(mindId, "export", { file, state });
    },

    rename(mindInput: unknown, checkpointInput: unknown, nameInput: unknown): RenamedCheckpoint {
      const mindId = options.requireMind(mindInput);
      const checkpointId = parseId(checkpointInput, "A Checkpoint");
      const row = db.get<Row>(
        `SELECT ${COLUMNS} FROM mind_checkpoints
         WHERE id = ? AND mind_id = ? AND deleted_at IS NULL`,
        [checkpointId, mindId],
      );
      if (!row) throw new NotFoundError({ key: "error.history.gone" });
      const name = (typeof nameInput === "string" && nameInput.trim()) || null;
      db.run("UPDATE mind_checkpoints SET name = ?, updated_at = ? WHERE id = ?", [
        name,
        options.now(),
        checkpointId,
      ]);
      options.changed(mindId);
      return { checkpoint: toCheckpoint({ ...row, name }), was: row.name };
    },

    list(mindInput: unknown): CheckpointList {
      const mindId = options.requireMind(mindInput);
      const rows = db.all<Row>(
        `SELECT ${COLUMNS} FROM mind_checkpoints
         WHERE mind_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC`,
        [mindId],
      );
      const last = newest(mindId);
      let current: string | null = null;
      if (last) {
        const doc = docOf(content.storedState(mindId));
        try {
          if (sameState(last.snapshot, Y.snapshot(doc))) current = last.id;
        } finally {
          doc.destroy();
        }
      }
      return { checkpoints: rows.map(toCheckpoint), current };
    },

    compare(input: unknown): MindComparison {
      if (!isRecord(input)) throw new InvalidInputError("compareCheckpoints expects an object.");
      const mindId = options.requireMind(input.mindId);
      const earlier = docOfCheckpoint(mindId, input.from);
      try {
        const from = earlier.getXmlFragment(MIND_CONTENT_FIELD);
        if (input.to === null || input.to === undefined) {
          return content.peek(mindId, (blocks) => compareVersions(from, blocks));
        }
        const later = docOfCheckpoint(mindId, input.to);
        try {
          return compareVersions(from, later.getXmlFragment(MIND_CONTENT_FIELD));
        } finally {
          later.destroy();
        }
      } finally {
        earlier.destroy();
      }
    },

    restore(mindInput: unknown, checkpointId: unknown): RestoredCheckpoint {
      const mindId = options.requireMind(mindInput);
      if (content.contentVersion(mindId) > CONTENT_SCHEMA_VERSION) {
        throw new MindReadOnlyError({ key: "error.mind.newerVersionEdit" });
      }
      const old = docOfCheckpoint(mindId, checkpointId);
      const preview = docOf(content.storedState(mindId));
      try {
        const restoreBlocks = (blocks: Y.XmlFragment) => {
          const kept = old.getXmlFragment(MIND_CONTENT_FIELD);
          nameCitations(kept);
          const restored = kept
            .toArray()
            .flatMap((node) => (node instanceof Y.XmlHook ? [] : [node.clone()]));
          blocks.delete(0, blocks.length);
          blocks.insert(0, restored);
          // As History showed it: without the changes still waiting in it then, but someone's
          // from the Word file it was imported from, which stay theirs to resolve (#108).
          resolveProposals(blocks, (change) => !change.id.startsWith(WORD_CHANGE_ID), "reject");
        };
        const previewBlocks = preview.getXmlFragment(MIND_CONTENT_FIELD);
        restoreBlocks(previewBlocks);
        const runs = figureRunsFor(old, topLevelBlocks(previewBlocks).map(nodeOf));
        installFigureRuns(preview, runs);
        // An Answer being written would go on into Blocks the restore replaces.
        for (const answerId of content.peek(mindId, streamingAnswers)) {
          options.stopAnswer(mindId, answerId);
        }
        const before = save(mindId, "restore");
        content.edit(mindId, (blocks) => {
          if (!blocks.doc) throw new Error("The Mind has no content document.");
          installFigureRuns(blocks.doc, runs);
          restoreBlocks(blocks);
        });
        // One that was being written when the Checkpoint was saved comes back stopped.
        options.settleAnswers(mindId);
        const personId = options.personId();
        const checkedLeftOut = content.peek(mindId, (blocks) => {
          if (!blocks.doc) return 0;
          const held = citationSentences(blocks);
          return signOffsOf(blocks.doc).filter(
            (record) =>
              record.target.kind === "citation" &&
              !held.has(record.target.id) &&
              isMine(record, personId),
          ).length;
        });
        return { before, checkedLeftOut };
      } finally {
        preview.destroy();
        old.destroy();
      }
    },

    /** A Mind's content was stored: its idle Checkpoint waits for it to stay unchanged. */
    edited(mindId: string): void {
      clearTimeout(idleTimers.get(mindId));
      const timer = setTimeout(() => {
        idleTimers.delete(mindId);
        saveIdle(mindId);
      }, CHECKPOINT_IDLE_MS);
      // A Checkpoint still to come must not keep the app from quitting.
      timer.unref?.();
      idleTimers.set(mindId, timer);
    },

    close(): void {
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
    },
  };
}
