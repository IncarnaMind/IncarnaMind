/**
 * A model's change to a Note, written the same way by every feature that writes one (#2796):
 * Edit with AI, the assistant's Note tools, an outside agent, Compare Documents, Regenerate a
 * change and Regenerate an edited Answer. Each write is tried on a copy of the Note and checked
 * there; only then does it reach the Note, as Proposals of the change's one request (ADR-0003):
 *
 * - **One check, in one order** (`refusalOf`). A part refused refuses the whole change: what it
 *   wrote is taken back, it writes nothing more, and the writer is told the one reason.
 * - **Only Proposals.** A write may add Proposals and nothing else: the User's text, accepted text
 *   whoever wrote it, reads as it did (`usersBlocks`), or the change is refused as "changed". The only
 *   Blocks it may take out whole are those its revision keeps for rejecting it to put back.
 * - **A target on every Proposal** (`ProposalRef.target`), so one over text the User has edited
 *   since is out of date, whichever feature made it.
 * - **One record** of where it came from (`ProposalRequest`), made at `now()` and written with its
 *   Proposals, never for a write that left none.
 * - **A Checkpoint exactly when the Note's text changes.** A change that applies at once, with
 *   its Undo, saves one just before it first reaches the Note, whoever wrote it and however much
 *   it takes out; one that waits for the User saves none, and accepting or applying it saves one
 *   then. Its writer saves it (`ChangeInput.checkpoint`): as its first write reaches the Note, or,
 *   for a staged change that may end waiting, at its end once it knows (#2814).
 *
 * Most writers write a change at once (`start`): each write goes into a copy of the Note as it is,
 * then again into the Note itself, as its own client, so a refusal leaves the Note untouched and
 * its state vector doesn't grow. Edit with AI writes as the model writes, while the User may type
 * (`startOn`): into one copy of the Note as the model read it, each write merged in as Yjs merges
 * two devices' edits (`forkChanges`), so the User's edits stay theirs and a Proposal over words
 * they changed arrives out of date.
 */
import * as Y from "yjs";
import {
  pendingProposals,
  recordProposalRequest,
  resolveProposals,
  revisedBlockIds,
} from "../../shared/proposals";
import {
  type ChangeRefusalKind,
  type EditCause,
  MIND_CONTENT_FIELD,
  type ProposalRequest,
  type WordChangeRequest,
} from "../api";
import type { MindContent } from "../mindContent";
import { docOf, forkChanges, usersBlocks } from "./merge";
import type { Written } from "./write";

type Timeless<T> = T extends unknown ? Omit<T, "createdAt"> : never;

/** Who or what made a change, as its record keeps it; when is the module's to say. */
export type Made = Timeless<Exclude<ProposalRequest, WordChangeRequest>>;

/** A change's record: where it came from, made `at`. */
export const recordOf = (made: Made, at: Date): ProposalRequest => ({
  ...made,
  createdAt: at.toISOString(),
});

/** What the one check reads of what a write wrote: `Written`'s flags. */
export type WriteReport = Pick<
  Written,
  "notPlaced" | "misnamed" | "droppedTypedTag" | "takesMissingNumber" | "unmadeTable" | "unplaced"
> & {
  /** Where the write went wrong, as its writer names the place: an outside agent's paragraph. */
  at?: string;
};

export type ChangeRefusal = (
  | { kind: Exclude<ChangeRefusalKind, "unplaced"> }
  | { kind: "unplaced"; quotes: string[] }
) & { at?: string };

/** A change refused by the check, or because it would change the User's text. */
export type Refused = ChangeRefusal | { kind: "changed" };

/** Why a change is refused, the same for every writer, in the order `changeRefusals` lists; null when it isn't. */
export function refusalOf(report: WriteReport): ChangeRefusal | null {
  const at = report.at === undefined ? {} : { at: report.at };
  if (report.notPlaced) return { kind: "not-placed", ...at };
  if (report.misnamed) return { kind: "misnamed", ...at };
  if (report.droppedTypedTag) return { kind: "typed-tag", ...at };
  if (report.takesMissingNumber) return { kind: "missing-number", ...at };
  if (report.unmadeTable) return { kind: "no-table", ...at };
  if (report.unplaced && report.unplaced.length > 0) {
    return { kind: "unplaced", quotes: report.unplaced, ...at };
  }
  return null;
}

/** What a write did to the Blocks it was given, and what its writer takes from it. */
export interface Wrote<T> extends WriteReport {
  changed: boolean;
  value: T;
}

/** What became of a write: it reached the Note, with its `value` from there; it changed nothing; or the change is refused. */
export type Outcome<T> = { kind: "written"; value: T } | { kind: "unchanged" } | Refused;

export interface ChangeInput {
  mindId: string;
  /** Its request's id: one a change already wrote under goes on writing that change. */
  request: string;
  made: Made;
  /**
   * Given, this saves a Checkpoint of the Note just before the change first reaches it: for a
   * writer whose change applies at once as it starts (`add_to_mind`, a revision of waiting text).
   * A staged writer that may end waiting saves its own, once it knows (#2814, ./apply in edits).
   */
  checkpoint?(): void;
}

export interface Change {
  readonly request: string;
  /** Some of it reached the Note. */
  readonly wrote: boolean;
  /** Why it was refused; null while it isn't. A change refused writes nothing more. */
  readonly refused: Refused | null;
  /** Writes more of the change: `write` writes in the Blocks it is given and says what it wrote. */
  write<T>(write: (blocks: Y.XmlFragment) => Wrote<T>): Outcome<T>;
  /** Checks the change as its writer reads it once it is all written: refused, what it wrote goes. */
  finish(report: WriteReport): Refused | null;
  /** Takes back what it wrote. */
  takeBack(): void;
}

/** A change merged from a copy of the Note (`startOn`). */
export interface MergedChange extends Omit<Change, "write"> {
  /**
   * `write` as `Change` has it; `cause`, read once it is written, is what the window that asked for
   * the change is told of it (Edit with AI).
   */
  write<T>(write: (blocks: Y.XmlFragment) => Wrote<T>, cause?: () => EditCause): Outcome<T>;
}

/** A Note's copy, made from `base`, its whole state as the model read it. */
export interface NoteCopy {
  base: Uint8Array;
  doc: Y.Doc;
  blocks: Y.XmlFragment;
}

/** A copy of a Note, from its whole state (`MindContent.state`). Close it with `doc.destroy()`. */
export function copyOf(state: Uint8Array): NoteCopy {
  const doc = docOf(state);
  return { base: state, doc, blocks: doc.getXmlFragment(MIND_CONTENT_FIELD) };
}

export interface ChangesOptions {
  /** The Notes as the writer reads and writes them, each in one Yjs transaction. */
  notes: Pick<MindContent, "read" | "edit">;
  now(): Date;
}

export function createChanges(options: ChangesOptions) {
  const { notes } = options;

  /** What a change does around each write, however the write reaches the Note. */
  function around(input: ChangeInput) {
    const { mindId, request } = input;
    const mine = (ref: { request: string }) => ref.request === request;
    let at: Date | null = null;
    let checkpointed = false;
    const state: { wrote: boolean; refused: Refused | null } = { wrote: false, refused: null };

    const takeBack = () => {
      if (!state.wrote) return;
      notes.edit(mindId, (blocks) => {
        resolveProposals(blocks, mine, "reject");
      });
    };

    const refuse = (why: Refused): Refused => {
      state.refused = why;
      takeBack();
      return why;
    };

    /** Writes in `blocks`, in a transaction of `doc`, with its record once it has Proposals there. */
    const writeIn = <T>(
      doc: Y.Doc,
      blocks: Y.XmlFragment,
      write: (blocks: Y.XmlFragment) => Wrote<T>,
    ): Wrote<T> =>
      doc.transact(() => {
        const wrote = write(blocks);
        if (wrote.changed && pendingProposals(blocks).some(mine)) {
          at ??= options.now();
          recordProposalRequest(doc, request, recordOf(input.made, at));
        }
        return wrote;
      });

    return {
      state,
      takeBack,
      refuse,
      writeIn,

      /** Writes in a copy, and checks there what it wrote: refused, unchanged, or ready for the Note. */
      tryIn<T>(
        doc: Y.Doc,
        blocks: Y.XmlFragment,
        write: (blocks: Y.XmlFragment) => Wrote<T>,
      ): Refused | { kind: "unchanged" } | { kind: "tried"; value: T } {
        const before = usersBlocks(blocks);
        const wrote = writeIn(doc, blocks, write);
        const refused = refusalOf(wrote);
        if (refused) return refuse(refused);
        if (!wrote.changed) return { kind: "unchanged" };
        // What a revision keeps for its Reject to put back is the only text it may take out whole.
        const kept = revisedBlockIds(blocks, request);
        const read = (rows: ReturnType<typeof usersBlocks>) =>
          JSON.stringify(rows.filter((row) => row.id === null || !kept.has(row.id)));
        if (read(usersBlocks(blocks)) !== read(before)) return refuse({ kind: "changed" });
        const untargeted = pendingProposals(blocks).find(
          (ref) => mine(ref) && ref.target === undefined,
        );
        if (untargeted) {
          throw new Error(`Proposal ${untargeted.id} of request ${request} records no target.`);
        }
        return { kind: "tried", value: wrote.value };
      },

      /** Just before a write reaches the Note: a Checkpoint, the first time one of a change that applies at once does. */
      reaching(): void {
        if (checkpointed || !input.checkpoint) return;
        checkpointed = true;
        input.checkpoint();
      },

      handle<W extends Change["write"] | MergedChange["write"]>(write: W) {
        return {
          request,
          get wrote() {
            return state.wrote;
          },
          get refused() {
            return state.refused;
          },
          write,
          finish(report: WriteReport): Refused | null {
            if (state.refused) return state.refused;
            const why = refusalOf(report);
            return why && refuse(why);
          },
          takeBack,
        };
      },
    };
  }

  /** A change whose every write is tried on a copy of the Note as it is, then written again there. */
  function start(input: ChangeInput): Change {
    const { mindId, request } = input;
    const change = around(input);
    return change.handle(<T>(write: (blocks: Y.XmlFragment) => Wrote<T>): Outcome<T> => {
      if (change.state.refused) return change.state.refused;
      const copy = docOf(
        notes.read(mindId, (blocks) => {
          if (!blocks.doc) throw new Error(`Note ${mindId} has no document.`);
          return Y.encodeStateAsUpdate(blocks.doc);
        }),
      );
      let tried: ReturnType<typeof change.tryIn<T>>;
      try {
        tried = change.tryIn(copy, copy.getXmlFragment(MIND_CONTENT_FIELD), write);
      } finally {
        copy.destroy();
      }
      if (tried.kind !== "tried") return tried;
      change.reaching();
      const value = notes.edit(mindId, (blocks) => {
        const doc = blocks.doc;
        if (!doc) throw new Error(`Note ${mindId} has no document.`);
        try {
          return change.writeIn(doc, blocks, write).value;
        } catch (error) {
          // The copy took it, so only a writer that answered differently the second time gets here.
          resolveProposals(blocks, (ref) => ref.request === request, "reject");
          console.error(
            `Proposals: request ${request} failed in the Note after its copy took it; its changes were rejected`,
            error,
          );
          throw error;
        }
      });
      change.state.wrote = true;
      return { kind: "written", value };
    });
  }

  /**
   * A change written into `copy`, the Note as the model read it, each write merged into the Note
   * as it is then (`merge`).
   */
  function startOn(
    copy: NoteCopy,
    input: ChangeInput,
    merge: Pick<MindContent, "state" | "apply">,
  ): MergedChange {
    const { mindId } = input;
    const change = around(input);
    return change.handle(
      <T>(write: (blocks: Y.XmlFragment) => Wrote<T>, cause?: () => EditCause): Outcome<T> => {
        if (change.state.refused) return change.state.refused;
        const tried = change.tryIn(copy.doc, copy.blocks, write);
        if (tried.kind !== "tried") return tried;
        const update = forkChanges(copy.base, copy.doc, merge.state(mindId));
        if (!update) return change.refuse({ kind: "changed" });
        change.reaching();
        merge.apply(mindId, update, cause?.());
        change.state.wrote = true;
        return { kind: "written", value: tried.value };
      },
    );
  }

  return { start, startOn };
}

export type Changes = ReturnType<typeof createChanges>;
