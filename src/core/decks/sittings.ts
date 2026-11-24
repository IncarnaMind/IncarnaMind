/**
 * A deck edited by hand on its slides (#149): each gesture (a drag, a resize, a text box from open
 * to close, a run of arrow-key moves) is one step, patched into the deck's own bytes
 * (../exports/pptxPatch/edits) and written at once where the sitting's writes go (`DeckPlace`,
 * ./places). A sitting begins with the first gesture on a deck, from the version the viewer
 * showed, and lasts while what it wrote is what its place still holds. Undo and Redo take a step
 * back or do it again, and write too. What its place holds changing under it (an agent handing
 * over a newer version, another program saving the file) ends the sitting: nothing is written
 * over that, and its steps can't be undone. A step its place can't take waits, never lost, to be
 * saved as a copy beside the deck.
 */
import type { DeckEdit, DeckSaved, DeckUnwritable } from "../api";
import { hashBytes } from "../documents/files";
import { openPackage, type ZipArchive } from "../documents/formats/zip";
import { InvalidInputError, TranslatableError } from "../errors";
import { PackagePartError } from "../exports/packagePatch/package";
import { Deck } from "../exports/pptxPatch/deck";
import { applyShapeEdits } from "../exports/pptxPatch/edits";
import type { ShapeEdit } from "../exports/pptxPatch/shapeEdit";
import { parseShapeEdits } from "./parse";

/** What writing a sitting's deck did: where it is now, that it changed under it, or why it couldn't. */
export type PlaceWritten =
  | { kind: "written"; documentId: string; saved: DeckSaved }
  | { kind: "changed" }
  | { kind: "unwritable"; why: DeckUnwritable["why"]; name: string };

/** Where a sitting's deck is written: the one seam between editing and the files it writes. */
export interface DeckPlace {
  /**
   * Writes the deck: as a new version or the User's file itself, each time only while its place
   * holds what was last written there (at first, the deck as the sitting read it).
   */
  write(bytes: Uint8Array): Promise<PlaceWritten>;
}

export interface DeckSittingDeps {
  /** The bytes of the Document's file as they are now. */
  read(documentId: string): Promise<Uint8Array>;
  /** Where a sitting that starts on this Document, whose bytes are `bytes`, writes. */
  placeFor(documentId: string, bytes: Uint8Array): DeckPlace;
  /** Saves bytes the deck's place couldn't take as a copy beside it: its Document and place. */
  copyBeside(
    documentId: string,
    bytes: Uint8Array,
  ): Promise<{ documentId: string; saved: DeckSaved; place: DeckPlace }>;
  newId(): string;
}

/** One gesture: the edits it made, as one step to undo. */
interface Step {
  id: string;
  edits: ShapeEdit[];
}

interface Sitting {
  id: string;
  /** The Document the sitting writes to now: the one opened, or the copy saved beside it. */
  documentId: string;
  base: Uint8Array;
  current: Uint8Array;
  place: DeckPlace;
  steps: Step[];
  /** How many of `steps` are done; the rest were undone and can be done again. */
  done: number;
  /** A step its place couldn't take, waiting to be saved as a copy: the deck with it made. */
  waiting: { bytes: Uint8Array; step: Step; done: number } | null;
  /** What its place holds changed under it: nothing more is written. */
  ended: boolean;
  /** Its deck's viewer closed: the next gesture begins another sitting. */
  closed: boolean;
  turn: Promise<unknown>;
}

const changedError = () => new TranslatableError({ key: "error.deck.changed" });

/** How many closed sittings keep their steps for Undo. */
const KEPT_CLOSED = 5;

const sameStored = (a: ZipArchive, b: ZipArchive, name: string) => {
  const x = a.raw(name);
  const y = b.raw(name);
  return (
    x !== undefined &&
    y !== undefined &&
    x.crc32 === y.crc32 &&
    x.size === y.size &&
    Buffer.from(x.data).equals(Buffer.from(y.data))
  );
};

/** How many slides differ from the deck the sitting read, and how many are kept exactly. */
async function slideCounts(base: Uint8Array, now: Uint8Array) {
  const before = openPackage(base);
  const after = openPackage(now);
  const parts = (await Deck.open(now).slides()).map((slide) => slide.part);
  const changed = parts.filter((part) => !sameStored(before, after, part)).length;
  return { changed, kept: parts.length - changed };
}

export function createDeckSittings(deps: DeckSittingDeps) {
  const sittings = new Map<string, Sitting>();

  /** Runs a sitting's writes one after another, so two never write over each other. */
  const inTurn = <T>(sitting: Sitting, run: () => Promise<T>): Promise<T> => {
    const next = sitting.turn.then(run);
    sitting.turn = next.catch(() => undefined);
    return next;
  };

  const requireSitting = (id: unknown): Sitting => {
    const sitting = typeof id === "string" ? sittings.get(id) : undefined;
    if (!sitting) throw new InvalidInputError({ key: "error.deck.noSitting" });
    return sitting;
  };

  async function patched(bytes: Uint8Array, edits: readonly ShapeEdit[]): Promise<Uint8Array> {
    try {
      return await applyShapeEdits(bytes, edits);
    } catch (error) {
      if (error instanceof PackagePartError) {
        throw new TranslatableError({ key: "error.deck.notEditable" }, { cause: error });
      }
      throw error;
    }
  }

  async function saved(
    sitting: Sitting,
    bytes: Uint8Array,
    step: Step,
    deckSaved: DeckSaved,
    documentId: string,
  ): Promise<DeckEdit> {
    sitting.current = bytes;
    sitting.documentId = documentId;
    return {
      kind: "saved",
      sittingId: sitting.id,
      stepId: step.id,
      documentId,
      bytes,
      contentHash: hashBytes(bytes),
      saved: deckSaved,
      slides: await slideCounts(sitting.base, bytes),
    };
  }

  /**
   * Writes the deck with `step` made or taken back; `done` is how many steps are done after it.
   * A place that can't take it keeps it waiting, as the result says.
   */
  async function write(
    sitting: Sitting,
    bytes: Uint8Array,
    step: Step,
    done: number,
  ): Promise<DeckEdit> {
    const written = await sitting.place.write(bytes);
    if (written.kind === "changed") {
      sitting.ended = true;
      throw changedError();
    }
    if (written.kind === "unwritable") {
      sitting.waiting = { bytes, step, done };
      return {
        kind: "unwritable",
        sittingId: sitting.id,
        documentId: sitting.documentId,
        why: written.why,
        name: written.name,
      };
    }
    sitting.waiting = null;
    sitting.done = done;
    return saved(sitting, bytes, step, written.saved, written.documentId);
  }

  async function start(documentId: string, shown: string): Promise<Sitting> {
    const base = await deps.read(documentId);
    // The viewer showed another version than the file holds now: nothing is applied to it.
    if (hashBytes(base) !== shown) throw changedError();
    const sitting: Sitting = {
      id: deps.newId(),
      documentId,
      base,
      current: base,
      place: deps.placeFor(documentId, base),
      steps: [],
      done: 0,
      waiting: null,
      ended: false,
      closed: false,
      turn: Promise.resolve(),
    };
    sittings.set(sitting.id, sitting);
    return sitting;
  }

  /** Throws while a step waits to be saved as a copy: nothing more is made until it is. */
  const requireNothingWaiting = (sitting: Sitting) => {
    if (sitting.ended) throw changedError();
    if (sitting.waiting) throw new InvalidInputError({ key: "error.deck.waiting" });
  };

  return {
    /**
     * Makes one gesture's edits on the deck and writes it. A sitting going on, on this Document,
     * takes it as its next step; otherwise one begins, from the file as it is now, which must be
     * the version the viewer showed (`shown`, its content hash).
     */
    async edit(input: {
      documentId: unknown;
      sittingId: unknown;
      shown: unknown;
      edits: unknown;
    }): Promise<DeckEdit> {
      if (typeof input?.documentId !== "string" || typeof input.shown !== "string") {
        throw new InvalidInputError({ key: "error.deck.noSitting" });
      }
      const edits = parseShapeEdits(input.edits);
      const going = typeof input.sittingId === "string" ? sittings.get(input.sittingId) : undefined;
      const sitting =
        going && !going.ended && !going.closed && going.documentId === input.documentId
          ? going
          : await start(input.documentId, input.shown);
      return inTurn(sitting, async () => {
        requireNothingWaiting(sitting);
        const bytes = await patched(sitting.current, edits);
        const step: Step = { id: deps.newId(), edits };
        sitting.steps = [...sitting.steps.slice(0, sitting.done), step];
        return write(sitting, bytes, step, sitting.steps.length);
      });
    },

    /** Takes back the sitting's newest step that is done, and writes the deck as it was before it. */
    undo(sittingId: unknown, stepId: unknown): Promise<DeckEdit> {
      const sitting = requireSitting(sittingId);
      return inTurn(sitting, async () => {
        requireNothingWaiting(sitting);
        const step = sitting.steps[sitting.done - 1];
        if (!step || step.id !== stepId) throw new InvalidInputError({ key: "error.deck.noStep" });
        const earlier = sitting.steps.slice(0, sitting.done - 1).flatMap((each) => each.edits);
        const bytes = earlier.length > 0 ? await patched(sitting.base, earlier) : sitting.base;
        return write(sitting, bytes, step, sitting.done - 1);
      });
    },

    /** Does the step that was undone last again, and writes the deck. */
    redo(sittingId: unknown, stepId: unknown): Promise<DeckEdit> {
      const sitting = requireSitting(sittingId);
      return inTurn(sitting, async () => {
        requireNothingWaiting(sitting);
        const step = sitting.steps[sitting.done];
        if (!step || step.id !== stepId) throw new InvalidInputError({ key: "error.deck.noStep" });
        return write(sitting, await patched(sitting.current, step.edits), step, sitting.done + 1);
      });
    },

    /**
     * Saves the step its place couldn't take as a copy beside the deck; the sitting goes on in
     * that copy, which the viewer shows from then on.
     */
    saveCopy(sittingId: unknown): Promise<DeckEdit> {
      const sitting = requireSitting(sittingId);
      return inTurn(sitting, async () => {
        const { waiting } = sitting;
        if (!waiting) throw new InvalidInputError({ key: "error.deck.noStep" });
        const copy = await deps.copyBeside(sitting.documentId, waiting.bytes);
        sitting.place = copy.place;
        sitting.waiting = null;
        sitting.done = waiting.done;
        return saved(sitting, waiting.bytes, waiting.step, copy.saved, copy.documentId);
      });
    },

    /**
     * The deck's viewer closed: a gesture after this begins another sitting. Its steps can still
     * be undone while what it wrote is what its place holds.
     */
    close(sittingId: unknown): void {
      const sitting = typeof sittingId === "string" ? sittings.get(sittingId) : undefined;
      if (!sitting) return;
      sitting.closed = true;
      if (sitting.steps.length === 0) sittings.delete(sitting.id);
      // Each holds its deck twice in memory: the oldest closed ones go, their steps with them.
      const closed = [...sittings.values()].filter((each) => each.closed);
      for (const old of closed.slice(0, Math.max(0, closed.length - KEPT_CLOSED))) {
        sittings.delete(old.id);
      }
    },

    /** Every sitting on a Document ends: it was put back as it was, or changed elsewhere. */
    endOn(documentId: string): void {
      for (const sitting of sittings.values()) {
        if (sitting.documentId === documentId) sitting.ended = true;
      }
    },
  };
}

export type DeckSittings = ReturnType<typeof createDeckSittings>;
