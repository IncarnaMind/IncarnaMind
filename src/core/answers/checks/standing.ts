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
import {
  checkText,
  everySentence,
  figuresNow,
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

/** A line as a file's check reads it: a table row whole with its headings, else the sentence. */
export function claimOf(
  sentence: SelectedSentence,
  verification: Verification | null,
): ReturnType<typeof checkText> | undefined {
  const row = tableClaim(sentence, workbookCellsOf(verification));
  if (row === "not-a-claim") return undefined;
  return row ?? checkText(sentence);
}

/** What a line's check is given: its claim, and what stands above it. */
export const saidOf = (sentence: SelectedSentence, verification: Verification | null) =>
  claimOf(sentence, verification) ?? { claim: sentence.text, context: sentence.context };

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

/** The fingerprint of all a line is judged with (`ClaimCheckBasis.judgedWith`). */
export function judgedWithOf(
  sentence: SelectedSentence,
  verification: Verification | null,
): string {
  const { claim, context } = saidOf(sentence, verification);
  return createHash("sha256").update(`${claim}\n\n${context}`).digest("base64url").slice(0, 22);
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
  element: Y.XmlElement;
  from: number;
  to: number;
  sentence: string;
  citations: SelectedSentence["citations"];
  noteText?: string;
  place?: RecordCitePlace;
}

/** How each stored result in `blocks` shows for `reader` now. */
export function readingOf(blocks: Y.XmlFragment, reader: Reader) {
  const { figureContexts } = figuresNow(blocks);
  const note = recordCiteNote(blocks);
  const verification = blocks.doc
    ? (readVerification(blocks.doc.getMap<unknown>(MIND_SETTINGS_FIELD)) ?? null)
    : null;
  let sentences: SelectedSentence[] | undefined;
  const judgedAt = (place: Pick<MarkedPlace, "element" | "from" | "to">) => () => {
    sentences ??= everySentence(blocks, { headings: true });
    const sentence = sentences.find(
      (each) => each.element === place.element && each.from < place.to && each.to > place.from,
    );
    return sentence ? judgedWithOf(sentence, verification) : null;
  };
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
        judgedWith: judgedAt(marked),
      }),
  };
}
