/**
 * The fixes for a sentence found unsupported or contradicted, from its card and
 * ⌘K. With a Citation (#1111): Cut the unsupported part, an Edit with AI that
 * applies at once with Undo. With none: Cut it, which takes the whole sentence
 * out with no model. Either: Search all Documents, its check again in every
 * Document, while it searched less than all; and Keep as my view, which makes
 * the sentence the User's own, as Mark as mine does, and keeps its check from
 * showing or counting. A contradicted sentence can be kept as the User's view
 * too (#1768). Each is one step of Undo.
 */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type * as Y from "yjs";
import { CLAIM_CHECK_MARK } from "../../core/api";
import { checkedScope } from "../../shared/claimChecks";
import { INLINE_NODE } from "../../shared/sentences";
import { checkAgain, useChecks } from "./checks";
import { makeMine } from "./editor/aiText";
import { citationsOf } from "./editor/alreadyCited";
import { type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
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
    claim.shown.state === "unsupported" &&
    !claim.check.citedCaseUnchecked &&
    citationsOf(editor.state, claim).length === 0
  );
}

export function offersKeepAsView(editor: Editor, claim: ShownClaim): boolean {
  return editor.isEditable && claim.shown.state === "contradicted";
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

/** The contradicted sentence the selection is in, for ⌘K; null for none. */
export const contradictedAt = (editor: Editor): ShownClaim | null =>
  claimAt(editor, offersKeepAsView);

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
  const kept = type.create({ ...claim.check, kept: true });
  const tr = state.tr;
  // Only its words: the binding keeps no marks on a Citation.
  state.doc.nodesBetween(claim.from, claim.to, (node, pos) => {
    const marked = node.marks.some(
      (mark) => mark.type === type && mark.attrs.id === claim.check.id,
    );
    if (!node.isText || !marked) return;
    tr.addMark(Math.max(pos, claim.from), Math.min(pos + node.nodeSize, claim.to), kept);
  });
  makeMine(state, tr, claim.sentence.from, claim.sentence.to);
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("claim.keptAsView"));
}
