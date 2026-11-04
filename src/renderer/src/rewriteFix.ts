/**
 * Rewrite with what the Documents say (#1554), the window's side: offered on the card of a
 * sentence with no Citation whose check found a close Passage that gives another value for it
 * (#770). The core asks the model which words to change and keeps only words the Passage's quote
 * holds, with every figure the rewritten sentence gives among the quote's. The old words become
 * those as AI text, cited at the sentence's end, as Change to… writes a correction (#1481), in one
 * step of Undo, and the sentence is checked again on its new Citation.
 */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import type { RewriteFromDocumentsResult } from "../../core/api";
import { showsPartRows } from "../../shared/claimChecks";
import { checkedCitation } from "../../shared/claimParts";
import { checkAgain, setCheckProblem, setRewriting, useChecks } from "./checks";
import { core } from "./core";
import { planEdits, recordCorrections, writeCorrections } from "./correctionFixes";
import { citationsOf } from "./editor/alreadyCited";
import { type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { providerErrorText } from "./errors";
import { translateNow } from "./i18n";
import { modelInUseOf } from "./modelInUse";
import { useNotices } from "./notices";
import { fixesFree, restoreCheck } from "./unsupportedFixes";

/**
 * Whether a sentence's card offers the rewrite: unsupported as it reads now, with no Citation,
 * beside a found Passage its check shows as saying something different.
 */
export function offersRewrite(editor: Editor, claim: ShownClaim): boolean {
  const { check } = claim;
  return (
    editor.isEditable &&
    claim.kind !== "chart" &&
    claim.shown.state === "unsupported" &&
    checkedCitation(check.evidence ?? undefined) !== null &&
    !check.citedCaseUnchecked &&
    !showsPartRows(check) &&
    citationsOf(editor.state, claim).length === 0
  );
}

/** The sentence the selection is in whose card offers the rewrite, for ⌘K; null for none. */
export function rewriteAt(editor: Editor): ShownClaim | null {
  const { from, to } = editor.state.selection;
  return (
    shownClaims(editor.state).find(
      (claim) =>
        claim.sentence.from <= from && to <= claim.sentence.to && offersRewrite(editor, claim),
    ) ?? null
  );
}

const showError = (message: string) => useNotices.getState().showError(new Error(message));

function said(result: Exclude<RewriteFromDocumentsResult, { kind: "rewritten" }>, mindId: string) {
  switch (result.kind) {
    case "kept":
      showError(translateNow("claim.rewrite.kept"));
      return;
    case "changed":
      showError(translateNow("error.check.partChanged"));
      return;
    case "failed":
      showError(providerErrorText(result.error, translateNow));
      return;
    case "not-ready":
    case "local-mode":
      setCheckProblem(mindId, result);
      return;
    case "cancelled":
      return;
  }
}

/**
 * Asks for the rewrite and writes it: the old words as the Passage's, cited, as one step of Undo
 * that brings the sentence back with the check it had; then checks it again. Says whether it
 * wrote one. While the model works, the sentence's mark shows it is being worked on.
 */
export async function rewriteWithDocuments(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
): Promise<boolean> {
  if (!fixesFree(mindId) || !offersRewrite(editor, claim)) return false;
  const earlier = claim.check;
  setRewriting(mindId, earlier.id);
  let result: RewriteFromDocumentsResult;
  try {
    result = await core.rewriteFromDocuments({
      mindId,
      checkId: earlier.id,
      model: modelInUseOf(doc),
    });
  } catch (error) {
    useNotices.getState().showError(error);
    return false;
  } finally {
    if (useChecks.getState().rewriting[mindId] === earlier.id) setRewriting(mindId, null);
  }
  if (editor.isDestroyed) return false;
  if (result.kind !== "rewritten") {
    said(result, mindId);
    return false;
  }
  const now = shownClaims(editor.state).find((each) => each.check.id === earlier.id);
  const plan =
    now && offersRewrite(editor, now) && fixesFree(mindId)
      ? planEdits(editor.state, now, [{ correction: result.correction, span: null }])
      : null;
  const tr = editor.state.tr;
  if (!now || !plan || !writeCorrections(tr, [plan])) {
    showError(translateNow("error.check.partChanged"));
    return false;
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  const recheck = () => {
    const again = shownClaims(editor.state).find((each) => each.check.id === earlier.id);
    if (again) void checkAgain(editor, mindId, doc, again);
  };
  offerEditorUndo(
    editor,
    (t) => t("claim.usedDocumentWording"),
    undefined,
    () => restoreCheck(editor, now, earlier),
    recheck,
  );
  recordCorrections(editor, mindId, [plan], tr);
  recheck();
  return true;
}
