/**
 * Use the Document's wording on a Citation whose quote differs from the page only in the kind of
 * its quotation marks (#2605): the page's own words go in place in the sentence, the Citation is
 * found by matching the new words against that wording (a text match, not a verdict), and the
 * sentence is checked again, so the verdict is the check's. One step of Undo.
 */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { CITATION_NODE } from "../../core/api";
import { parseQuotedWords } from "../../shared/citations";
import { differsOnlyInMarks } from "../../shared/quoteMarks";
import { findQuote } from "../../shared/quoteMatch";
import { checkAgain, fixesFree, restoreCheck } from "./checks";
import { underReview } from "./correctionFixes";
import { placeInSentence, type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { translateNow } from "./i18n";
import { flushMindUpdates } from "./mindCopies";
import { useNotices } from "./notices";

/** What Use the Document's wording does: the quote in the sentence, its Citation, and the check. */
export interface CitationWording {
  /** The Citation node's position in the document. */
  citation: number;
  /** Where the Answer's quote is in the sentence. */
  from: number;
  to: number;
  /** The Document's own words for it. */
  wording: string;
  /** The check of the sentence the quote is in: its verdict is asked for again after the change. */
  claim: ShownClaim;
}

/**
 * Where Use the Document's wording would put the page's words, or null where it isn't offered:
 * only a quote whose Document's wording differs from it in nothing but the kind of its quotation
 * marks, still in the sentence as the Answer wrote it, and a sentence a check can read again.
 */
export function citationWordingFix(editor: Editor, citation: number): CitationWording | null {
  if (!editor.isEditable || citation < 0 || citation >= editor.state.doc.content.size) return null;
  const node = editor.state.doc.nodeAt(citation);
  if (!node || node.type.name !== CITATION_NODE) return null;
  // Only a quote the quoted-words check didn't find, whose marks alone kept it from being found.
  if (node.attrs.check !== "not-found" || node.attrs.checkReason !== "quoted-words-not-on-pages")
    return null;
  const quoted = parseQuotedWords(node.attrs.quotedWords);
  const wording = quoted?.documentWording;
  if (!quoted || !wording) return null;
  const words = quoted.answer.map((piece) => piece.text).join("");
  // Marks are one character each, so the sentence keeps its length and nothing after it moves.
  if (!differsOnlyInMarks(words, wording) || wording.length !== words.length) return null;
  const claim = shownClaims(editor.state).find(
    (each) => each.sentence.from <= citation && citation < each.sentence.to,
  );
  // A whole read asks its card to size it and its cost first, so no verdict would follow here.
  if (!claim || (claim.check.action === "check-against-document" && claim.check.scope.chosen))
    return null;
  const found = findQuote(claim.sentence.text, words, { unique: true });
  const range = found?.length === 1 ? found[0] : undefined;
  if (!range || claim.sentence.text.slice(range.start, range.end) !== words) return null;
  const place = placeInSentence(editor.state, claim, { from: range.start, to: range.end });
  if (!place || underReview(editor.state, place.from, place.to)) return null;
  return { citation, from: place.from, to: place.to, wording, claim };
}

/**
 * Puts the Document's own words in place of an Answer's quote that differs only in the kind of
 * its quotation marks, with one Undo, marks the Citation found, and checks its sentence again.
 * Never a verdict: only the check that follows says how the sentence stands.
 */
export function applyCitationWording(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  citation: number,
): boolean {
  if (!fixesFree(mindId)) {
    useNotices.getState().showError(new Error(translateNow("error.check.partChecking")));
    return false;
  }
  const fix = citationWordingFix(editor, citation);
  const node = fix ? editor.state.doc.nodeAt(fix.citation) : null;
  if (!fix || !node) {
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
    return false;
  }
  const tr = editor.state.tr.insertText(fix.wording, fix.from, fix.to);
  const at = tr.mapping.map(fix.citation);
  tr.setNodeMarkup(at, undefined, {
    ...node.attrs,
    // The quoted words are the Document's now, so its quote is found: a text match, not a verdict.
    check: "found",
    checkReason: null,
    quotedWords: null,
  });
  asOneStep(editor, () => editor.view.dispatch(tr));
  // The check the sentence had, again: its verdict is the one the sentence shows.
  const recheck = () => {
    void (async () => {
      await flushMindUpdates(mindId);
      if (editor.isDestroyed) return;
      const again = shownClaims(editor.state).find((each) => each.check.id === fix.claim.check.id);
      if (again) await checkAgain(editor, mindId, doc, again);
    })();
  };
  offerEditorUndo(
    editor,
    (t) => t("citation.usedDocumentWording"),
    undefined,
    () => restoreCheck(editor, fix.claim, fix.claim.check),
    recheck,
  );
  recheck();
  return true;
}
