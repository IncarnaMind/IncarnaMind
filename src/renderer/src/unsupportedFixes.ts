/**
 * The fixes for a sentence found unsupported or contradicted, from its card and
 * ⌘K. With a Citation (#1111): Cut the unsupported part, an Edit with AI that
 * applies at once with Undo. With none: Cut it, which takes the whole sentence
 * out with no model. Either: Search all Documents, its check again in every
 * Document, while it searched less than all; and Keep as my view, which makes
 * the sentence the User's own, as Mark as mine does, and keeps its check from
 * showing or counting. A contradicted sentence can be kept as the User's view
 * too (#1768). A figure worked out that disagrees with the sentence's number can
 * be used instead (#1247). Each is one step of Undo.
 */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type * as Y from "yjs";
import { CLAIM_CHECK_MARK, type ClaimCalculation, type ClaimCheckAttributes } from "../../core/api";
import { detectLanguage } from "../../core/documents/textLanguage";
import { checkedScope, saysNotFound } from "../../shared/claimChecks";
import {
  type FigureContext,
  figureContextOf,
  figureLanguageTag,
  readFigures,
} from "../../shared/figures";
import { figureNumber } from "../../shared/formula";
import type { MessageKey } from "../../shared/i18n";
import { INLINE_NODE } from "../../shared/sentences";
import { checkAgain, useChecks } from "./checks";
import { makeMine } from "./editor/aiText";
import { citationsOf } from "./editor/alreadyCited";
import { markOf, paragraphPlaces, type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { writeSentenceCheck } from "./editor/figurePlaces";
import { requestEdit, useEdits } from "./editWithAi";
import { translateNow } from "./i18n";
import { useNotices } from "./notices";

/**
 * Whether a check is of a cited sentence nothing backs: not one where the
 * Documents say something different, one only the User's own workings say,
 * or one citing a court decision no Document holds, which have cards of their own.
 */
export function offersFixes(editor: Editor, claim: ShownClaim): boolean {
  const { check } = claim;
  return (
    claim.kind !== "chart" &&
    claim.shown.state === "unsupported" &&
    check.evidence === null &&
    !check.citedCaseUnchecked &&
    !check.excluded.some((left) => left.reason === "own-workings") &&
    citationsOf(editor.state, claim).length > 0
  );
}

/** The part a check named that the sentence's Citations don't support; null when it named none. */
export const uncoveredOf = (claim: ShownClaim): string | null =>
  claim.check.unsupported?.covered ? claim.check.unsupported.uncovered : null;

/**
 * Whether a check is of a sentence with no Citation that nothing in the Documents backs, whatever its
 * card says of what was found: not a court decision, which has a card of its own. Never in a Mind
 * that can't be edited.
 */
export function offersNotFound(editor: Editor, claim: ShownClaim): boolean {
  return (
    editor.isEditable &&
    claim.kind !== "chart" &&
    claim.shown.state === "unsupported" &&
    !claim.check.citedCaseUnchecked &&
    citationsOf(editor.state, claim).length === 0
  );
}

/** Whether nothing in its scope was about the sentence (`saysNotFound`), with its Citations as the Mind has them now. */
export const notFoundIn = (editor: Editor, claim: ShownClaim): boolean =>
  saysNotFound(claim.shown, claim.check, citationsOf(editor.state, claim).length);

/**
 * Whether the card offers Find sources: an unsupported sentence it can quote nothing for, with no
 * court decision and none of the cited-sentence fixes, so searching papers and the web could help.
 */
export function offersFindSources(editor: Editor, claim: ShownClaim): boolean {
  return (
    claim.kind !== "chart" &&
    claim.shown.state === "unsupported" &&
    claim.check.evidence === null &&
    !claim.check.citedCaseUnchecked &&
    !offersFixes(editor, claim)
  );
}

/** The words of the sentence a check is about. */
export const sentenceOf = (editor: Editor, claim: ShownClaim): string =>
  editor.state.doc.textBetween(claim.sentence.from, claim.sentence.to, " ", " ").trim();

/**
 * The word a check's mark and card are headed with: "Not found" apart from "Unsupported", and
 * "Record cite" for a Supported sentence one of whose own record cites needs a look.
 */
export const checkStateKey = (editor: Editor, claim: ShownClaim): MessageKey =>
  markOf(claim) !== claim.shown.state
    ? "claim.state.recordCite"
    : notFoundIn(editor, claim)
      ? "claim.state.notFound"
      : `claim.state.${claim.shown.state}`;

export function offersKeepAsView(editor: Editor, claim: ShownClaim): boolean {
  return claim.kind !== "chart" && editor.isEditable && claim.shown.state === "contradicted";
}

/** A number a check's calculated figure disagrees with, and the figure to write in its place. */
export interface FigureFix {
  /** Its characters in the sentence's text, as the check read them. */
  from: number;
  to: number;
  /** The figure as the check worked it out. */
  shown: string;
}

/** How a sentence writes its numbers, as the check read it (the core's `documentFigureContext`). */
const contextOf = (sentence: string): FigureContext =>
  figureContextOf(sentence, figureLanguageTag(detectLanguage(sentence.slice(0, 20_000))));

/**
 * The one number of a sentence that a check's calculated figure disagrees
 * with (#1247). Null when they agree, when the sentence no longer writes it,
 * or when more than one of its numbers is written as it, so the card can't
 * tell which number the check means.
 */
export function figureFix(
  calculation: ClaimCalculation | null,
  sentence: string,
): FigureFix | null {
  // A limit the figure breaks is the sentence's own number, not one to replace with the figure.
  if (!calculation || calculation.agrees || calculation.relation) return null;
  const written = readFigures(sentence, contextOf(sentence)).filter(
    (figure) => figure.chars === calculation.stated,
  );
  const [only] = written;
  return only && written.length === 1
    ? {
        from: only.start,
        to: only.end,
        shown: figureNumber(calculation.figure.shown, calculation.figure.show.language),
      }
    : null;
}

/** Whether the card offers Use {figure}: a figure worked out that disagrees with the sentence (#1247). */
export function offersUseFigure(editor: Editor, claim: ShownClaim): boolean {
  const { shown } = claim;
  return (
    claim.kind !== "chart" &&
    editor.isEditable &&
    (shown.state === "supported" || shown.state === "contradicted") &&
    figureFix(claim.check.calculation, claim.sentence.text) !== null
  );
}

const claimAt = (editor: Editor, offered: (editor: Editor, claim: ShownClaim) => boolean) => {
  const { from, to } = editor.state.selection;
  return (
    shownClaims(editor.state).find(
      (claim) => claim.sentence.from <= from && to <= claim.sentence.to && offered(editor, claim),
    ) ?? null
  );
};

/** The cited sentence nothing backs that the selection is in, for ⌘K; null for none. */
export const unsupportedAt = (editor: Editor): ShownClaim | null => claimAt(editor, offersFixes);

/** The sentence with no Citation that nothing backs that the selection is in, for ⌘K; null for none. */
export const notFoundAt = (editor: Editor): ShownClaim | null => claimAt(editor, offersNotFound);

/** The unsupported sentence the selection is in whose card offers Find sources; null for none. */
export const findSourcesAt = (editor: Editor): ShownClaim | null =>
  claimAt(editor, offersFindSources);

/** The contradicted sentence the selection is in, for ⌘K; null for none. */
export const contradictedAt = (editor: Editor): ShownClaim | null =>
  claimAt(editor, offersKeepAsView);

/** The sentence whose check worked out a figure it disagrees with, for ⌘K; null for none. */
export const figureAt = (editor: Editor): ShownClaim | null => claimAt(editor, offersUseFigure);

export const fixesFree = (mindId: string): boolean =>
  !useEdits.getState().pending[mindId] && !useChecks.getState().running[mindId];

/** Takes the part the Citations don't support out of the sentence, keeping them on the rest. */
export function cutUnsupported(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
): Promise<boolean> {
  const uncovered = uncoveredOf(claim);
  if (!uncovered) return Promise.resolve(false);
  return requestEdit(editor, mindId, doc, "cut-unsupported", uncovered, {
    from: claim.sentence.from,
    to: claim.sentence.to,
  });
}

/** Whether its check searched less than every Document, so one could still back it: as its card says. */
export const searchedLess = (claim: ShownClaim): boolean =>
  checkedScope(claim.check.scope) !== null;

export const searchAllDocuments = (editor: Editor, mindId: string, doc: Y.Doc, claim: ShownClaim) =>
  checkAgain(editor, mindId, doc, claim, true);

const wordsAt = (doc: ProseMirrorNode, from: number, to: number) => {
  let words = "";
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) words += (node.text ?? "").slice(Math.max(from, pos) - pos, to - pos);
    else if (node.isInline) {
      words += node.type.name === "hardBreak" ? "\n" : INLINE_NODE;
      return false;
    }
    return true;
  });
  return words;
};

/**
 * Takes the whole sentence out, with the space that kept it from its neighbour, or its paragraph when
 * it is all the paragraph says. No model: one step of Undo brings back the words and their check.
 * Says so and cuts nothing when the words at the sentence's place aren't the sentence.
 */
export function cutSentence(editor: Editor, claim: ShownClaim): void {
  const { state } = editor;
  const { from, to } = claim.sentence;
  // Read from the document again, so a range that has drifted from its words is never deleted.
  if (wordsAt(state.doc, from, to) !== claim.sentence.text) {
    useNotices.getState().showError(new Error(translateNow("claim.cutSentence.moved")));
    return;
  }
  const $from = state.doc.resolve(from);
  const [start, end] = [$from.start(), $from.end()];
  const spaces = (pattern: RegExp, first: number, last: number) =>
    pattern.exec(wordsAt(state.doc, first, last))?.[0].length ?? 0;
  const lead = spaces(/\s*$/u, start, from);
  const trail = spaces(/^\s*/u, to, end);
  const tr = state.tr;
  if (from - lead === start && to + trail === end) tr.deleteRange($from.before(), $from.after());
  else if (to + trail < end) tr.delete(from, to + trail);
  else tr.delete(from - lead, to + trail);
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("claim.cutSentence.done"));
}

/** Makes the sentence the User's own view: their words, and a check that no longer counts. */
export function keepAsView(editor: Editor, claim: ShownClaim): void {
  const { state } = editor;
  const type = state.schema.marks[CLAIM_CHECK_MARK];
  if (!type) return;
  const tr = state.tr;
  writeSentenceCheck(
    tr,
    { ...claim, ...(claim.kind === "chart" && { node: true as const }) },
    { ...claim.check, kept: true },
  );
  makeMine(state, tr, claim.sentence.from, claim.sentence.to);
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("claim.keptAsView"));
}

/** Where the characters a figure fix changes are in the document; null when the sentence has moved. */
function placeInSentence(
  editor: Editor,
  claim: ShownClaim,
  fix: Pick<FigureFix, "from" | "to">,
): { from: number; to: number } | null {
  const $start = editor.state.doc.resolve(claim.sentence.from);
  if (!$start.parent.isTextblock) return null;
  const places = paragraphPlaces($start.parent, $start.start() - 1);
  const at = places.starts.indexOf(claim.sentence.from);
  if (at < 0 || places.text.slice(at, at + claim.sentence.text.length) !== claim.sentence.text)
    return null;
  const from = places.starts[at + fix.from];
  const to = places.ends[at + fix.to - 1];
  return from === undefined || to === undefined ? null : { from, to };
}

/**
 * Puts back the check a Use took the sentence's mark from, once Undo has
 * brought its number back: every check over the sentence goes, as the
 * re-check's may run past where the earlier one ended.
 */
function restoreCheck(editor: Editor, claim: ShownClaim, earlier: ClaimCheckAttributes): void {
  if (editor.isDestroyed) return;
  const type = editor.state.schema.marks[CLAIM_CHECK_MARK];
  if (!type) return;
  const from = Math.max(0, Math.min(claim.from, claim.sentence.from));
  const to = Math.min(editor.state.doc.content.size, Math.max(claim.to, claim.sentence.to));
  if (from >= to) return;
  const tr = editor.state.tr;
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type === type))
      tr.removeMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), type);
    return true;
  });
  tr.addMark(from, to, type.create({ ...earlier })).setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

/**
 * Changes the one number of a sentence that a check's calculated figure
 * disagrees with to the figure, keeping the sentence's Citations, and checks
 * the sentence again (#1247). One step of the note's Undo, which brings the
 * number back with the check it had.
 */
export function applyFigure(editor: Editor, mindId: string, doc: Y.Doc, claim: ShownClaim): void {
  if (claim.shown.state !== "supported" && claim.shown.state !== "contradicted") return;
  const calculation = claim.check.calculation;
  const fix = figureFix(calculation, claim.sentence.text);
  if (!fix || !calculation) return;
  const place = placeInSentence(editor, claim, fix);
  const words = place === null ? null : editor.state.doc.textBetween(place.from, place.to);
  if (place === null || words !== calculation.stated) {
    useNotices.getState().showError(new Error(translateNow("claim.useFigure.moved")));
    return;
  }
  const earlier = claim.check;
  asOneStep(editor, () => {
    editor.view.dispatch(editor.state.tr.insertText(fix.shown, place.from, place.to));
  });
  offerEditorUndo(
    editor,
    (t) => t("claim.useFigure.done", { figure: fix.shown }),
    undefined,
    () => restoreCheck(editor, claim, earlier),
  );
  const again = shownClaims(editor.state).find((each) => each.check.id === earlier.id);
  if (again) void checkAgain(editor, mindId, doc, again);
}
