/**
 * Automatic tagging (spec #20, "Tagging"), unless Organize tags and files new
 * Documents by itself: once a Document is ready (embedded, so already
 * searchable), its Tags are decided by the model the Tagging setting picks
 * (Automatic, or one chosen by hand, see ../library/tagging), the one Organize
 * uses once there are Folders. With Organize not moving new Documents by
 * itself, this still tags them, and Organize only moves them when asked. One
 * Document at a time, in the order they became ready.
 *
 * - Each Document takes one turn in the background model queue (see
 *   ../backgroundQueue), which other background model work shares and which
 *   gives way to Answers. A call to a model on this computer that an Answer
 *   interrupts leaves its Document waiting, first in line once no Answer is
 *   being written.
 * - Nothing is sent before the User allows the "tagging" data flow to the
 *   tagger's service, which choosing it does (ADR-0022); a local model needs
 *   no consent. Tagging is background work: it never asks.
 * - With no usable tagger (no chat model set up, a missing key or sign-in, or
 *   the flow not allowed) Documents wait as "waiting-for-provider", and are
 *   picked up again whenever that may have changed.
 * - Only automatic links change: Tags the User added or removed on a
 *   Document stay as they are (see `TagsStore.applyAutomatic`).
 * - Where the User stopped Tagging with AI, Documents are "stopped"
 *   and nothing is sent, unless the User asks to re-tag one.
 * - While Organize files new Documents by itself, the Documents it holds are
 *   its own. One it doesn't hold, such as one this tagger had when Organize
 *   began filing new Documents, is still tagged here.
 * - With no Tags defined, a tagger that only chooses from the list (Jev, a
 *   decision model) is skipped and a Document is "no-tags", not "tagged", so it
 *   is checked once a Tag exists (see `tagsDefined`). The chat model names Tags
 *   from what the Document says (./suggest), so it is asked anyway; one it
 *   gives no Tag is "no-tags" too.
 */
import type { DocumentKind, ProviderError } from "../api";
import type { BackgroundCall, BackgroundJob, BackgroundQueue } from "../backgroundQueue";
import {
  ChatNotReadyError,
  ConsentDeclinedError,
  ConsentNeededError,
  InvalidInputError,
  LocalModeError,
  NotFoundError,
  TaggingNotReadyError,
} from "../errors";
import { reachedPlanLimit } from "../library/planPace";
import { classifyProviderError } from "../providers/providerErrors";
import { gateStop } from "../sendGate";
import type { PaceTimers } from "../sources/pace";
import type { Database } from "../storage";
import {
  type DocumentExcerpt,
  excerptFromPassages,
  type TagChoice,
  type TagClassifier,
} from "./classify";
import { type TagsStore, tagsOfDocument } from "./index";
import { type RateLimitPause, rateLimitError } from "./rateLimit";
import { fallbackLine } from "./suggest";
import { isTransient, RETRY_WAIT_MS } from "./transient";

/** What the "tagging" flow sends to the tagger's service: the chat model's or Jev's. */
export const TAGGING_FLOW_SENDS = ["tags", "document-excerpts"] as const;

/** Tagging states as stored (`documents.tagging_status`); "skipped" is worked out from the status. */
export type StoredTaggingState =
  | "pending"
  | "waiting-for-provider"
  | "tagging"
  | "tagged"
  | "no-tags"
  | "failed"
  | "stopped"
  | "off";

/** How many Passages, from the start, are read to build an excerpt. */
const EXCERPT_ROWS = 6;

export interface TaggerOptions {
  db: Database;
  /** Organize tags new Documents itself while it files them by itself; those it has no hold of yet stay with this tagger. */
  enabled?(): boolean;
  /**
   * Whether new Documents are tagged by themselves (#1617). Off, they are "off": nothing is
   * sent for them unless the User asks (a re-tag).
   */
  automatic?(): boolean;
  organizing?(id: string): boolean;
  stopped(id: string): boolean;
  now: () => string;
  tags: TagsStore;
  /** Whether the tagger in use can take a request now. Asks the User nothing. */
  canRun(): Promise<boolean>;
  /**
   * A quick check, with no waiting: false when tagging certainly can't run
   * (no tagger set up, or the User hasn't allowed the flow to its service).
   */
  mightBeReady(): boolean;
  /**
   * The tagger in use, once the User has accepted the tagging flow to its
   * service. Throws ChatNotReadyError, ConsentDeclinedError,
   * ConsentNeededError or TaggingNotReadyError when it can't be used:
   * nothing is sent then.
   */
  prepare(): Promise<TagClassifier>;
  /**
   * Whether the tagger in use names Tags of its own (the chat model), with no waiting: then a
   * Document is tagged even while no Tag exists.
   */
  namesTags?(): boolean;
  /** Pushes "documents.tagged" for these Documents. */
  announce(documentIds: readonly string[]): void;
  /** Tagging made new Tags: the list of Tags is to be read again. */
  tagsMade?(): void;
  reportError(error: unknown): void;
  /** The background model queue, in which tagging each Document takes one turn. */
  background: BackgroundQueue;
  /** The pause a rate limit puts on all Tagging (see ./rateLimit). */
  rateLimit: Pick<RateLimitPause, "pausedUntil" | "pause" | "succeeded" | "refusal" | "refuse">;
  /** Waits before the one retry after a passing error. */
  timers: PaceTimers;
}

interface DocumentRow {
  name: string;
  kind: string;
  page_count: number | null;
  status: string;
  tagging_status: string;
  tagging_error_kind: string | null;
  tagging_error_message: string | null;
  tagging_error_resets_at: string | null;
}

export function createTagger(options: TaggerOptions) {
  const automatic = () => options.automatic?.() !== false;
  const { db, now, tags, announce, background } = options;
  const lifetime = new AbortController();
  const queue: string[] = [];
  /** The Document being tagged, if any. */
  let current: string | null = null;
  /** The tagger's turn in the background queue, while one is queued or running. */
  let turn: BackgroundJob | null = null;
  /**
   * Counts re-tag requests per Document. A result worked out before the
   * latest request is dropped: the run that request queued decides.
   */
  const requests = new Map<string, number>();
  const asked = new Set<string>();
  const organized = (id: string) => options.organizing?.(id) === true;

  const rowOf = (id: string) =>
    db.get<DocumentRow>(
      `SELECT name, kind, page_count, status, tagging_status, tagging_error_kind, tagging_error_message,
         tagging_error_resets_at
       FROM documents WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );

  /** Sets a Document's tagging state. Returns whether it changed. */
  const setState = (
    id: string,
    state: StoredTaggingState,
    error: ProviderError | null = null,
  ): boolean => {
    const row = rowOf(id);
    if (
      !row ||
      (row.tagging_status === state &&
        row.tagging_error_kind === (error?.kind ?? null) &&
        row.tagging_error_message === (error?.message ?? null) &&
        row.tagging_error_resets_at === (error?.resetsAt ?? null))
    ) {
      return false;
    }
    db.run(
      `UPDATE documents SET tagging_status = ?, tagging_error_kind = ?, tagging_error_message = ?,
         tagging_error_resets_at = ?, updated_at = ?
       WHERE id = ?`,
      [state, error?.kind ?? null, error?.message ?? null, error?.resetsAt ?? null, now(), id],
    );
    return true;
  };

  const setStates = (ids: readonly string[], state: StoredTaggingState) => {
    const changed = ids.filter((id) => setState(id, state));
    if (changed.length > 0) announce(changed);
  };

  /** No tagger can be used: every queued Document waits for one, with why when known. */
  function park(error: ProviderError | null = null): void {
    const changed = queue.splice(0).filter((id) => setState(id, "waiting-for-provider", error));
    if (changed.length > 0) announce(changed);
  }

  function excerptOf(id: string, row: DocumentRow): DocumentExcerpt {
    const passages = db.all<{ text: string }>(
      `SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL
       ORDER BY position LIMIT ?`,
      [id, BigInt(EXCERPT_ROWS)],
    );
    return {
      name: row.name,
      kind: row.kind as DocumentKind,
      pageCount: row.page_count,
      text: excerptFromPassages(passages.map((passage) => passage.text)),
    };
  }

  const fail = (id: string, error: unknown) => {
    if (setState(id, "failed", classifyProviderError(error))) announce([id]);
  };

  /**
   * Tags one ready Document. If no tagger can be used after all, it and the
   * rest of the queue wait for one.
   */
  async function tagDocument(id: string, call: BackgroundCall): Promise<void> {
    const request = requests.get(id) ?? 0;
    /**
     * The core closed, the call gave way to an Answer, or a re-tag came in
     * meanwhile: the run that comes next decides instead.
     */
    const stale = () =>
      organized(id) ||
      lifetime.signal.aborted ||
      call.signal.aborted ||
      (requests.get(id) ?? 0) !== request;
    const row = rowOf(id);
    // Tagged meanwhile: Organize did it, in its own turn.
    if (row?.status !== "ready" || row.tagging_status === "tagged") return;
    const definitions = tags.list();
    if (setState(id, "tagging")) announce([id]);

    let choice: TagChoice = { decisions: [], newTags: [] };
    let asked = false;
    if (definitions.length > 0 || options.namesTags?.() === true) {
      let tagger: TagClassifier;
      try {
        tagger = await options.prepare();
      } catch (error) {
        if (lifetime.signal.aborted) return;
        if (
          error instanceof ChatNotReadyError ||
          error instanceof ConsentDeclinedError ||
          error instanceof ConsentNeededError ||
          error instanceof LocalModeError ||
          error instanceof TaggingNotReadyError
        ) {
          // Not allowed, or the tagger went away while this waited: this and the rest wait.
          if (setState(id, "waiting-for-provider")) announce([id]);
          park();
        } else {
          fail(id, error);
        }
        return;
      }
      asked = definitions.length > 0 || tagger.namesTags === true;
      // A model on this computer serves one request at a time: an Answer goes first.
      if (tagger.local) call.runsLocally();
      if (stale()) return;
      const signal = AbortSignal.any([lifetime.signal, call.signal]);
      const decide = async () =>
        asked ? tagger.decide({ tags: definitions, excerpt: excerptOf(id, row), signal }) : choice;
      try {
        try {
          choice = await decide();
        } catch (error) {
          if (!isTransient(error)) throw error;
          await options.timers.sleep(
            RETRY_WAIT_MS.least + Math.random() * RETRY_WAIT_MS.jitter,
            signal,
          );
          choice = await decide();
        }
      } catch (error) {
        if (stale()) return;
        const stopped = gateStop(error);
        const limitedUntil = stopped ? null : options.rateLimit.pause(error);
        const refused = stopped || limitedUntil !== null ? null : options.rateLimit.refuse(error);
        if (stopped instanceof ConsentNeededError || stopped instanceof LocalModeError) {
          // Turned off, or Local mode on, as it was sent (../sendGate): this and the rest wait.
          if (setState(id, "waiting-for-provider")) announce([id]);
          park();
        } else if (limitedUntil !== null) {
          const why = rateLimitError(limitedUntil, error);
          if (setState(id, "waiting-for-provider", why)) announce([id]);
          park(why);
        } else if (reachedPlanLimit(error)) {
          // The plan's limit: this and the rest wait for it to reset (see ../library/planPace).
          const why = classifyProviderError(error);
          if (setState(id, "waiting-for-provider", why)) announce([id]);
          park(why);
        } else if (refused !== null) {
          // The key was refused: this and the rest wait for a key that works, one request made.
          if (setState(id, "waiting-for-provider", refused)) announce([id]);
          park(refused);
        } else {
          fail(id, error);
        }
        return;
      }
      options.rateLimit.succeeded();
    }
    if (stale()) return;
    if (choice.fallback) console.info(fallbackLine(id));

    const { changed, made } = db.transaction(() => {
      // Deleted, or processed again, meanwhile.
      if (rowOf(id)?.status !== "ready") return { changed: false, made: 0 };
      const applied = tags.applyAutomatic(id, choice.decisions, choice.newTags);
      // Asked with no Tag to offer and given none, it is checked again once a Tag exists.
      const found = definitions.length > 0 || tagsOfDocument(db, id).length > 0;
      const settled = setState(id, asked && found ? "tagged" : "no-tags");
      return { changed: settled || applied.changed, made: applied.made };
    });
    if (made > 0) options.tagsMade?.();
    if (changed) announce([id]);
  }

  /** Tags the first Document in the queue, if it can: one turn in the background queue. */
  async function tagNext(call: BackgroundCall): Promise<void> {
    try {
      if (queue.length === 0 || lifetime.signal.aborted) return;
      const limitedUntil = options.rateLimit.pausedUntil();
      if (limitedUntil !== null) {
        park(rateLimitError(limitedUntil));
        return;
      }
      const refused = options.rateLimit.refusal();
      if (refused !== null) {
        park(refused);
        return;
      }
      const ready = await options.canRun();
      if (lifetime.signal.aborted) return;
      if (!ready) {
        park();
        return;
      }
      const id = queue.shift();
      if (id === undefined || organized(id)) return;
      if ((options.stopped(id) || !automatic()) && !asked.has(id)) {
        if (setState(id, automatic() ? "stopped" : "off")) announce([id]);
        return;
      }
      current = id;
      try {
        await tagDocument(id, call);
      } finally {
        current = null;
      }
      if (call.gaveWay && !lifetime.signal.aborted) {
        // Interrupted by an Answer: it waits, first in line, until no Answer is being written.
        if (!queue.includes(id)) queue.unshift(id);
        if (setState(id, "pending")) announce([id]);
      } else {
        asked.delete(id);
      }
    } catch (error) {
      if (lifetime.signal.aborted) return;
      options.reportError(error);
      park();
    }
  }

  /** Queues a turn in the background queue, unless one is queued or running, or nothing waits. */
  function schedule(): void {
    if (turn || queue.length === 0 || lifetime.signal.aborted) return;
    const job: BackgroundJob = {
      kind: "tagging",
      run: async (call) => {
        try {
          await tagNext(call);
        } finally {
          // A turn that gave way runs again, first; otherwise the next Document takes a new
          // turn, after the work queued meanwhile.
          if (!call.gaveWay) {
            turn = null;
            schedule();
          }
        }
      },
    };
    turn = job;
    background.add(job);
  }

  /**
   * Queues a Document. `fresh`: a new request (a re-tag), whose result must
   * replace that of a run already going; otherwise a Document being tagged
   * isn't queued again.
   */
  function enqueue(id: string, fresh = false): void {
    if (lifetime.signal.aborted) return;
    if (fresh) requests.set(id, (requests.get(id) ?? 0) + 1);
    else if (id === current) return;
    if (!queue.includes(id)) queue.push(id);
    schedule();
  }

  /**
   * Queues every ready Document that still needs tagging, or marks them
   * waiting if no tagger can be used. Those where Tagging is stopped are
   * "stopped", and those where it was turned back on are queued again.
   */
  function resume(only?: "no-tags"): void {
    if (lifetime.signal.aborted) return;
    const checkable = tags.list().length > 0;
    if (only && !checkable) return;
    const statuses = only
      ? [only]
      : ["pending", "waiting-for-provider", "failed", "stopped", ...(checkable ? ["no-tags"] : [])];
    const found = db
      .all<{ id: string; tagging_status: string; tagging_error_kind: string | null }>(
        `SELECT id, tagging_status, tagging_error_kind FROM documents
         WHERE deleted_at IS NULL AND status = 'ready'
           AND tagging_status IN (${statuses.map(() => "?").join(", ")})
         ORDER BY created_at, rowid`,
        statuses,
      )
      .filter((row) => !organized(row.id));
    // Off, nothing goes by itself: only what the User asked for is tagged. A Document that
    // failed or was stopped keeps its line and its Retry; only one waiting to go by itself is off.
    const held = automatic() ? [] : found.filter((row) => !asked.has(row.id));
    setStates(
      held
        .filter(
          (row) =>
            row.tagging_status === "pending" || row.tagging_status === "waiting-for-provider",
        )
        .map((row) => row.id),
      "off",
    );
    const rows = found.filter((row) => !held.includes(row));
    const stopped = rows.filter((row) => options.stopped(row.id) && !asked.has(row.id));
    setStates(
      stopped.map((row) => row.id),
      "stopped",
    );
    const rest = rows.filter((row) => !stopped.includes(row));
    if (!options.mightBeReady()) {
      setStates(
        rest.map((row) => row.id),
        "waiting-for-provider",
      );
      return;
    }
    // Queued, they are about to be tagged, not waiting for a model; a plan's pause keeps saying
    // why, and a rate limit's does until it ends.
    const limited = options.rateLimit.pausedUntil() !== null;
    const refused = options.rateLimit.refusal() !== null;
    setStates(
      rest
        .filter(
          (row) =>
            row.tagging_status === "stopped" ||
            row.tagging_status === "no-tags" ||
            (row.tagging_status === "waiting-for-provider" &&
              (row.tagging_error_kind === null ||
                (row.tagging_error_kind === "rate-limit" && !limited) ||
                (row.tagging_error_kind === "auth" && !refused))),
        )
        .map((row) => row.id),
      "pending",
    );
    // Fresh for "no-tags": the run that marked it may not have let go of it yet.
    for (const row of rest) enqueue(row.id, row.tagging_status === "no-tags");
  }

  return {
    /** Picks up after a quit: Documents being tagged start again, and those waiting are queued. */
    start(): void {
      db.run(
        `UPDATE documents SET tagging_status = 'pending', updated_at = ?
         WHERE deleted_at IS NULL AND tagging_status = 'tagging'`,
        [now()],
      );
      resume();
    },

    /**
     * A Document just became ready. Called before its new status is pushed,
     * so that event already says whether it waits for a tagger.
     */
    documentReady(id: string): void {
      if (options.enabled?.() === false || organized(id)) return;
      const row = rowOf(id);
      // Processed again (e.g. by a newer pipeline): the same file keeps its Tags.
      if (!row || row.tagging_status === "tagged") return;
      if (!automatic()) {
        setState(id, "off");
        return;
      }
      if (options.stopped(id)) {
        setState(id, "stopped");
        return;
      }
      if (!options.mightBeReady()) {
        setState(id, "waiting-for-provider");
        return;
      }
      setState(id, "pending");
      enqueue(id);
    },

    /**
     * A model for Tags on another computer was just chosen: the Documents already here that
     * wait to be tagged are "off", so choosing it sends none of them (#2308). Organize, or a
     * re-tag, which the User starts, still does.
     */
    holdExisting(): void {
      const ids = db
        .all<{ id: string }>(
          `SELECT id FROM documents WHERE deleted_at IS NULL AND status = 'ready'
             AND tagging_status IN ('pending', 'waiting-for-provider', 'failed', 'no-tags')`,
        )
        .map((row) => row.id)
        .filter((id) => !organized(id) && !asked.has(id));
      for (const id of ids) {
        const at = queue.indexOf(id);
        if (at !== -1) queue.splice(at, 1);
      }
      setStates(ids, "off");
    },

    /** A Tag may exist now: the Documents checked while there were none are tagged. */
    tagsDefined: () => resume("no-tags"),

    /** The tagger, or whether it can run, may have changed: Documents waiting, or failed, are tried again. */
    resume: () => resume(),

    /**
     * Re-tags Documents (all of them without ids): their automatic Tags are
     * worked out again. Documents still being processed are tagged once ready.
     */
    retag(input: unknown): void {
      if (
        input !== undefined &&
        (!Array.isArray(input) || !input.every((id) => typeof id === "string" && id !== ""))
      ) {
        throw new InvalidInputError("documentIds must be a list of Document ids.");
      }
      const ids =
        input === undefined
          ? db
              .all<{ id: string }>(
                "SELECT id FROM documents WHERE deleted_at IS NULL ORDER BY created_at, rowid",
              )
              .map((row) => row.id)
          : [...new Set(input as string[])];
      const rows = ids.map((id) => {
        const row = rowOf(id);
        if (!row) throw new NotFoundError({ key: "error.document.notFound" });
        return { id, row };
      });
      if (input !== undefined) for (const { id } of rows) asked.add(id);
      const changed: string[] = [];
      const ready = options.mightBeReady();
      for (const { id, row } of rows) {
        if (row.status !== "ready") {
          // Being processed again: tagged afresh once ready. Failed or without text: nothing to tag.
          if (row.tagging_status === "tagged" && setState(id, "pending")) changed.push(id);
          continue;
        }
        if (setState(id, ready ? "pending" : "waiting-for-provider")) changed.push(id);
      }
      if (changed.length > 0) announce(changed);
      if (!ready) return;
      for (const { id, row } of rows) if (row.status === "ready") enqueue(id, true);
    },

    /** The ready Documents whose tagging, or Organize's, couldn't reach the AI model, unless stopped. */
    unreached(): string[] {
      return db
        .all<{ id: string }>(
          `SELECT id FROM documents
           WHERE deleted_at IS NULL AND status = 'ready'
             AND tagging_status = 'failed' AND tagging_error_kind = 'network'
           ORDER BY created_at, rowid`,
        )
        .map((row) => row.id)
        .filter((id) => !options.stopped(id));
    },

    /** Stops: Documents keep their state, and the next start picks them up. */
    close(): void {
      lifetime.abort();
      queue.length = 0;
    },
  };
}
