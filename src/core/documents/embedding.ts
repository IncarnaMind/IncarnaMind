/**
 * Embeds Documents' Passages with the current embedding model, one Document
 * after another: the built-in model one Passage at a time (ADR-0009: batches
 * were no faster, and changed int8 results), an API provider in batches. A
 * Document's status goes from "embedding" to "ready"; while the model can't
 * be used it waits as "waiting-for-model". Only the Document whose turn it is
 * is shown as embedding; the others stored as "embedding" wait their turn,
 * shown as queued (`isEmbedding`). Each batch of vectors is stored as it
 * comes, so a quit loses at most one batch's work. A Document is only ready
 * once every live Passage has its vector: a new version stored during its
 * turn takes another.
 *
 * The model each Document's vectors come from is recorded with them
 * (documents.embedding_model, and their size in documents.embedding_dimensions).
 * When the User switches model, every Document goes back to "embedding", and
 * keeps its old vectors until its turn comes: then they are dropped and the
 * new model's written. Switching back before that costs nothing for the
 * Documents not yet reached. Vectors from two models are never left in one Document.
 *
 * While embeddings are off (the default), no Document is queued here: each is
 * ready once its keyword index is (see ./index).
 */
import { EmbeddingUnavailableError, type SearchEmbedder } from "../embedding/active";
import type { Database } from "../storage";
import { encodeVector, type VectorIndex } from "./vectors";

/** Progress reaches the UI at most this often per Document. */
const PROGRESS_INTERVAL_MS = 500;

export interface EmbeddingQueueOptions {
  db: Database;
  now: () => string;
  model: SearchEmbedder;
  vectors: VectorIndex;
  /** Pushes a Document's current state as a "document.status" event. */
  announce(documentId: string): void;
  /** A Document just became ready (e.g. for automatic tagging). Called before it is announced. */
  onReady?: (documentId: string) => void;
  /**
   * It became ready, embedded in `ms` (by `performance.now()`) once the model had loaded; null
   * when an earlier turn embedded part of it (held for a Meeting, paused, or the model
   * unavailable part way), so this turn took only the rest.
   */
  onEmbedded?: (documentId: string, ms: number | null) => void;
  /**
   * The Document's Linked folder is paused: it is left "embedding" until it
   * is resumed, which queues it again.
   */
  isPaused?: (documentId: string) => boolean;
  reportError?: (error: unknown) => void;
}

export interface EmbeddingQueue {
  /**
   * Queues a Document whose status is "embedding". Returns whether its turn
   * came at once: then it has been announced as being embedded.
   */
  enqueue(documentId: string): boolean;
  /**
   * Whether this is the Document being embedded now. The others stored as
   * "embedding" are waiting their turn: they are shown as queued.
   */
  isEmbedding(documentId: string): boolean;
  /**
   * Holds embedding back, while a Meeting is recorded (#135): the Document
   * being embedded stops after the batch in flight and waits first in line.
   */
  hold(held: boolean): void;
  /** Moves every Document waiting for the model on to "embedding", and queues it. */
  resumeWaiting(): void;
  /**
   * The model changed: work under way stops without storing anything more,
   * and the queue empties. The caller queues Documents again.
   */
  restart(): void;
  /** Stops working: Documents keep their status, so the next start picks them up. */
  close(): void;
}

type Outcome = "done" | "skipped" | "model-unavailable";

interface DocumentState {
  status: string;
  name: string;
  embedding_model: string | null;
  embedding_dimensions: number | null;
}

export function createEmbeddingQueue(options: EmbeddingQueueOptions): EmbeddingQueue {
  const { db, now, model, vectors, announce } = options;
  const reportError = options.reportError ?? ((error) => console.error(error));
  const queue: string[] = [];
  let running = false;
  let closed = false;
  let held = false;
  /** The Document whose turn it is, from its model loading to its last vector. */
  let current: string | undefined;
  /** Counts model switches: work started under an earlier count stops. */
  let generation = 0;

  const stateOf = (id: string) =>
    db.get<DocumentState>(
      `SELECT status, name, embedding_model, embedding_dimensions FROM documents
       WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );

  const setStatus = (id: string, status: string, from: string) =>
    db.run("UPDATE documents SET status = ?, updated_at = ? WHERE id = ? AND status = ?", [
      status,
      now(),
      id,
      from,
    ]);

  /** Whether any of the Document's live Passages has no vector yet. */
  const unembedded = (id: string) =>
    db.get(
      `SELECT 1 FROM passages
       WHERE document_id = ? AND deleted_at IS NULL AND embedding IS NULL LIMIT 1`,
      [id],
    ) !== undefined;

  /** The model can't be used: every Document being embedded waits for it again. */
  function park(): void {
    queue.length = 0;
    const embedding = db.all<{ id: string }>(
      "SELECT id FROM documents WHERE deleted_at IS NULL AND status = 'embedding' ORDER BY created_at, rowid",
    );
    for (const { id } of embedding) {
      setStatus(id, "waiting-for-model", "embedding");
      announce(id);
    }
  }

  function fail(id: string, message: string): void {
    db.run(
      `UPDATE documents SET status = 'failed', failure_reason = 'processing-error',
         failure_message = ?, updated_at = ?
       WHERE id = ? AND status = 'embedding'`,
      [message, now(), id],
    );
    announce(id);
  }

  /** The Document's vectors come from another model: drop them, and record the current one. */
  function startOver(id: string): void {
    db.transaction(() => {
      db.run(
        "UPDATE passages SET embedding = NULL WHERE document_id = ? AND deleted_at IS NULL AND embedding IS NOT NULL",
        [id],
      );
      db.run(
        `UPDATE documents SET embedding_model = ?, embedding_dimensions = NULL, updated_at = ?
         WHERE id = ?`,
        [model.id, now(), id],
      );
    });
    vectors.removeDocument(id);
  }

  /**
   * Embeds a Document, as its turn: until now it was shown as queued. If it
   * stops part way (processed again, paused, or the model switched), it is
   * announced again, as whatever it is now.
   */
  async function embedDocument(id: string): Promise<Outcome> {
    const document = stateOf(id);
    if (document?.status !== "embedding" || options.isPaused?.(id)) return "skipped";
    current = id;
    announce(id);
    let outcome: Outcome = "skipped";
    try {
      outcome = await embedPassages(id, document);
      return outcome;
    } finally {
      if (current === id) current = undefined;
      if (outcome === "skipped" && !closed) announce(id);
    }
  }

  async function embedPassages(id: string, document: DocumentState): Promise<Outcome> {
    // Embeddings are off: nothing is loaded, and turning them off made it ready.
    if (!model.enabled()) return "skipped";
    const started = generation;
    const stopped = () => closed || generation !== started;
    if (!(await model.load())) return stopped() ? "skipped" : "model-unavailable";
    if (stopped()) return "skipped";
    const begun = performance.now();
    let dimensions = document.embedding_dimensions;
    if (document.embedding_model !== model.id) {
      startOver(id);
      dimensions = null;
    }
    // Its first vector of this version and model sets its dimensions: none yet, it is all to do.
    const whole = dimensions === null;
    const passages = db.all<{ seq: number; text: string }>(
      `SELECT seq, text FROM passages
       WHERE document_id = ? AND deleted_at IS NULL AND embedding IS NULL
       ORDER BY position`,
      [id],
    );
    let announced = Date.now();
    for (let at = 0; at < passages.length; at += model.batchSize) {
      const batch = passages.slice(at, at + model.batchSize);
      let embedded: Float32Array[];
      try {
        embedded = await model.embedPassages(
          document.name,
          batch.map((passage) => passage.text),
        );
      } catch (error) {
        if (stopped()) return "skipped";
        if (error instanceof EmbeddingUnavailableError) return "model-unavailable";
        fail(id, `Embedding failed: ${error instanceof Error ? error.message : String(error)}`);
        return "done";
      }
      // Deleted, or processed again, or the model switched, or paused, meanwhile.
      if (stopped() || stateOf(id)?.status !== "embedding" || options.isPaused?.(id)) {
        return "skipped";
      }
      const size = embedded[0]?.length ?? 0;
      if (dimensions !== null && size !== dimensions) {
        fail(
          id,
          `The embedding model returned ${size} numbers per vector instead of ${dimensions}.`,
        );
        return "done";
      }
      // Only live Passages get vectors: a new version may have replaced these meanwhile.
      const stored = db.transaction(() => {
        if (dimensions === null) {
          db.run("UPDATE documents SET embedding_dimensions = ? WHERE id = ?", [BigInt(size), id]);
        }
        return batch.flatMap((passage, index) => {
          const vector = embedded[index] as Float32Array;
          const row = db.get<{ seq: number }>(
            `UPDATE passages SET embedding = ? WHERE seq = ? AND deleted_at IS NULL
             RETURNING seq`,
            [encodeVector(vector), BigInt(passage.seq)],
          );
          return row ? [{ seq: row.seq, vector }] : [];
        });
      });
      dimensions = size;
      for (const { seq, vector } of stored) vectors.add(id, seq, vector);
      if (held) {
        if (!queue.includes(id)) queue.unshift(id);
        return "skipped";
      }
      if (Date.now() - announced >= PROGRESS_INTERVAL_MS) {
        announced = Date.now();
        announce(id);
      }
    }
    // A new version, extracted during the last batch, has Passages still to embed: it isn't
    // ready, and takes another turn, which reads what is stored now.
    if (unembedded(id)) {
      if (!queue.includes(id)) queue.push(id);
      return "skipped";
    }
    setStatus(id, "ready", "embedding");
    if (stateOf(id)?.status === "ready") {
      options.onEmbedded?.(id, whole ? performance.now() - begun : null);
      try {
        options.onReady?.(id);
      } catch (error) {
        reportError(error); // the Document is ready all the same
      }
    }
    announce(id);
    return "done";
  }

  /** The next Document in line, unless the queue is closed or held. */
  const next = () => (closed || held ? undefined : queue.shift());

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let id = next(); id !== undefined; id = next()) {
        if ((await embedDocument(id)) === "model-unavailable") {
          if (!closed) park();
          break;
        }
      }
    } catch (error) {
      if (!closed) reportError(error);
    } finally {
      running = false;
    }
    // Something may have been queued while the last Document was finishing.
    if (!closed && !held && queue.length > 0) void pump();
  }

  function enqueue(documentId: string): boolean {
    if (closed || queue.includes(documentId)) return false;
    const already = current === documentId; // e.g. a new version, while the old one is embedded
    queue.push(documentId);
    // Idle, the queue starts on it before returning: its turn has come.
    void pump();
    return !already && current === documentId;
  }

  return {
    enqueue,

    isEmbedding: (documentId) => current === documentId,

    resumeWaiting() {
      if (closed) return;
      const waiting = db.all<{ id: string }>(
        `SELECT id FROM documents WHERE deleted_at IS NULL AND status = 'waiting-for-model'
         ORDER BY created_at, rowid`,
      );
      for (const { id } of waiting) {
        setStatus(id, "embedding", "waiting-for-model");
        if (!enqueue(id)) announce(id);
      }
    },

    hold(value) {
      held = value;
      if (!held && !closed) void pump();
    },

    restart() {
      generation++;
      queue.length = 0;
      // What was under way stops at its next step: nothing is being embedded meanwhile.
      current = undefined;
    },

    close() {
      closed = true;
      queue.length = 0;
    },
  };
}
