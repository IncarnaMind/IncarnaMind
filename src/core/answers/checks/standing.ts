/**
 * Whether a Note's stored results still stand, for whoever reads them (#3412): what a line is
 * judged with, and the one reading the core gives a stored result, as `claimCheckShown` shows it.
 * Carrying a result to a file's next version, the counts an outside agent is told, a record of the
 * Note's checks and Check this Note's choice of what to check again all read results through it.
 */
import { createHash } from "node:crypto";
import type * as Y from "yjs";
import {
  type ClaimCheckShown,
  claimCheckShown,
  type NoteFooting,
} from "../../../shared/claimChecks";
import { isVerifiedBlock, readVerification, type Verification } from "../../../shared/verification";
import { type ClaimCheckAttributes, MIND_SETTINGS_FIELD, type SearchScope } from "../../api";
import type { RecordCitePlace } from "../../recordCites/referents";
import { headingsAbove } from "./figureOccurrences";
import {
  checkText,
  everySentence,
  figuresNow,
  markedSentences,
  noteTextOf,
  noteTextOfMarked,
  recordCiteNote,
  type SelectedSentence,
} from "./sentences";
import { tableClaim, type WorkbookCells } from "./verifyTables";

// A total's footing is worked out, never a model's check of it: what a run sends reads each total's
// own check alone, so one that couldn't be made is sent whether a cell out in another check holds
// it at Checking or its cells don't add up (#2998). A reading that shows footings gives its own.
const NO_FOOTING: NoteFooting = new Map();

function workbookCellsOf(verification: Verification | null): WorkbookCells | undefined {
  const workbook = verification?.workbook;
  if (!workbook) return undefined;
  return {
    formulas: new Set(workbook.formulaBlocks),
    typed: workbook.typedBlocks ? new Set(workbook.typedBlocks) : null,
  };
}

/** The slide a deck's line is on, as the file holds it (#3455); null for a line of no slide. */
export function slideOf(
  sentence: SelectedSentence,
  verification: Verification | null,
): number | null {
  const page = verification?.pages[sentence.blockId];
  return page !== undefined && verification?.slides?.[String(page)] !== undefined ? page : null;
}

/**
 * What a deck's line is checked with, by the file's check and the Note's own alike (#3455): its
 * claim, a table row whole with its headings, read with its slide as the file holds it, which
 * says what a number in a box of its own is, in place of the lines above it in the Note; undefined
 * for a line of no slide.
 */
export function deckSaidOf(
  sentence: SelectedSentence,
  verification: Verification | null,
): (ReturnType<typeof checkText> & { onSlide: number }) | undefined {
  const slide = slideOf(sentence, verification);
  const held = slide === null ? undefined : verification?.slides?.[String(slide)];
  if (slide === null || held === undefined) return undefined;
  const row = tableClaim(sentence, workbookCellsOf(verification));
  const said = row === null || row === "not-a-claim" ? checkText(sentence) : row;
  return { ...said, context: held, onSlide: slide };
}

/** A line as a file's check reads it: a table row whole with its headings, else the sentence. */
export function claimOf(
  sentence: SelectedSentence,
  verification: Verification | null,
): (ReturnType<typeof checkText> & { onSlide?: number }) | undefined {
  const row = tableClaim(sentence, workbookCellsOf(verification));
  if (row === "not-a-claim") return undefined;
  return deckSaidOf(sentence, verification) ?? row ?? checkText(sentence);
}

/**
 * What a line's check is given: its claim, and what it is read with: a deck's line its slide
 * (`deckSaidOf`), a table row whole, else the sentence with what stands above it.
 */
export const saidOf = (
  sentence: SelectedSentence,
  verification: Verification | null,
): ReturnType<typeof checkText> & { onSlide?: number } =>
  deckSaidOf(sentence, verification) ??
  claimOf(sentence, verification) ?? { claim: sentence.text, context: sentence.context };

/**
 * What a result stands on, of what its check was given (`said`): the claim and what frames its
 * line, a deck's line its slide, else the headings it is under (#3455). The other lines above it
 * and the rest of its paragraph are sent only for what the claim's words refer to, which adds
 * nothing to what it says; were they in, editing one claim would put every finding after it
 * behind Needs re-check.
 */
export function standsOn(
  said: { claim: string; context: string; onSlide?: number },
  sentence: SelectedSentence,
): { claim: string; context: string } {
  if (said.onSlide !== undefined) return said;
  return { claim: said.claim, context: headingsAbove(sentence.element).join("\n\n") };
}

/** The fingerprint of what a result stands on (`standsOn`, `ClaimCheckBasis.judgedWith`). */
export const fingerprintOf = ({ claim, context }: { claim: string; context: string }): string =>
  createHash("sha256").update(`${claim}\n\n${context}`).digest("base64url").slice(0, 22);

/** A letter or digit: a line with none states nothing to sort. */
const WORDS = /[\p{L}\p{N}]/u;

/**
 * The lines a file's check sorts into claims, in the Note's order, each with the claim it is judged
 * as: a table row whole with its headings, anchored to its first cell, else the sentence.
 */
export function fileCheckLines(
  blocks: Y.XmlFragment,
  verification: Verification,
): (SelectedSentence & { said: string })[] {
  const doc = blocks.doc;
  if (!doc) return [];
  return everySentence(blocks, { headings: true }).flatMap((sentence) => {
    if (!isVerifiedBlock(doc, verification, sentence.blockId)) return [];
    const said = claimOf(sentence, verification)?.claim;
    // The model decides which lines state a claim, a short one with a figure too (#3412).
    return said !== undefined && WORDS.test(said) ? [{ ...sentence, said }] : [];
  });
}

/** The fingerprint of what a line's result stands on (`ClaimCheckBasis.judgedWith`). */
export function judgedWithOf(
  sentence: SelectedSentence,
  verification: Verification | null,
): string {
  return fingerprintOf(standsOn(saidOf(sentence, verification), sentence));
}

const verificationIn = (blocks: Y.XmlFragment): Verification | null =>
  blocks.doc ? (readVerification(blocks.doc.getMap<unknown>(MIND_SETTINGS_FIELD)) ?? null) : null;

/**
 * What each result in `blocks` that keeps what it was judged with would be judged with now, by
 * the result's id: the one source of it, for the core's readings and the window's (#3455).
 */
export function judgedNow(blocks: Y.XmlFragment): Map<string, string> {
  const judged = new Map<string, string>();
  const marks = markedSentences(blocks).filter(({ check }) => check.judgedWith !== undefined);
  if (marks.length === 0) return judged;
  const verification = verificationIn(blocks);
  const sentences = everySentence(blocks, { headings: true });
  for (const { element, from, to, check } of marks) {
    if (judged.has(check.id)) continue;
    const sentence = sentences.find(
      (each) => each.element === element && each.from < to && each.to > from,
    );
    if (sentence) judged.set(check.id, judgedWithOf(sentence, verification));
  }
  return judged;
}

/** Whoever reads a Note's results, and the Note's Documents and settings as they are now. */
export interface Reader {
  /** Each live Document's current version, by id; null while they aren't known. */
  versions: ReadonlyMap<string, string> | null;
  folderId: string | null;
  scope: SearchScope | null;
  /** The Documents the reader reaches: an outside agent's; null for the User, who reaches all. */
  reach: ReadonlySet<string> | null;
  footing?: NoteFooting;
}

/** A stored result's place, as `checkedSentences` gives one. */
interface MarkedPlace {
  sentence: string;
  citations: SelectedSentence["citations"];
  noteText?: string;
  place?: RecordCitePlace;
}

/** How each stored result in `blocks` shows for `reader` now. */
export function readingOf(blocks: Y.XmlFragment, reader: Reader) {
  const { figureContexts } = figuresNow(blocks);
  const note = recordCiteNote(blocks);
  const verification = verificationIn(blocks);
  let judged: Map<string, string> | undefined;
  const now = {
    footing: reader.footing ?? NO_FOOTING,
    versions: reader.versions,
    folderId: reader.folderId,
    scope: reader.scope,
    figureContexts,
    reach: reader.reach,
  };
  return {
    /** A sentence's result, read with the sentence as the Note holds it now. */
    ofSentence: (sentence: SelectedSentence, check: ClaimCheckAttributes): ClaimCheckShown =>
      claimCheckShown(check, {
        ...now,
        text: sentence.text,
        citations: sentence.citations,
        note: note({ blockId: sentence.blockId, from: sentence.from }),
        noteText: () => noteTextOf(sentence),
        judgedWith: () => judgedWithOf(sentence, verification),
      }),
    /** A result at its mark, read with the sentences its mark is in. */
    ofMarked: (marked: MarkedPlace, check: ClaimCheckAttributes): ClaimCheckShown =>
      claimCheckShown(check, {
        ...now,
        text: marked.sentence,
        citations: marked.citations,
        note: note(marked.place),
        ...noteTextOfMarked(marked),
        judgedWith: () => {
          judged ??= judgedNow(blocks);
          return judged.get(check.id) ?? null;
        },
      }),
  };
}
