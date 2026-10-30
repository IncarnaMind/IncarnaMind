import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import type { ClaimCheckPart } from "../../core/api";
import { checkWithParts } from "../../shared/claimParts";
import { displayName } from "../../shared/documentNames";
import { checkAgain, useChecks } from "./checks";
import { type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { writeSentenceCheck } from "./editor/figurePlaces";
import { translateNow } from "./i18n";
import { flushMindUpdates } from "./mindCopies";
import { useNotices } from "./notices";
import { sourceFacetChoices } from "./sourceFacets";
import { useAppStore } from "./store";
import { restoreCheck } from "./unsupportedFixes";

export async function chooseSourceFacet(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
  part: ClaimCheckPart,
  documentId: string,
): Promise<void> {
  if (editor.isDestroyed || !editor.isEditable || useChecks.getState().running[mindId]) return;
  const current = shownClaims(editor.state).find((each) => each.check.id === claim.check.id);
  const row = current?.check.parts?.find(
    (each) =>
      each.facet?.kind === "source" &&
      each.span.start === part.span.start &&
      each.span.end === part.span.end,
  );
  if (
    !current ||
    !row ||
    current.check.text !== claim.check.text ||
    current.sentence.text !== current.check.text ||
    (current.shown.state === "needs-recheck" && current.shown.why !== "source-choice") ||
    current.shown.state === "checking"
  ) {
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
    return;
  }
  const state = useAppStore.getState();
  const folderId = state.minds.find((mind) => mind.id === mindId)?.folderId ?? null;
  const choices = sourceFacetChoices(
    current.check,
    row,
    {
      documents: state.documents,
      folders: state.folders,
      tags: state.tags,
      groups: state.library?.groups,
      assignments: state.library?.assignments,
    },
    folderId,
  );
  const chosen = choices?.choices.find((choice) => choice.document.id === documentId);
  if (!chosen || row.facet?.kind !== "source") {
    useNotices.getState().showError(new Error(translateNow("claim.source.chooseAgain")));
    return;
  }
  const facet = row.facet;
  const before = current.check;
  const parts = before.parts?.map((each) =>
    each === row ? { ...each, facet: { ...facet, selectedDocumentId: documentId } } : each,
  );
  if (!parts) return;
  const changed = checkWithParts(before, parts);
  const tr = editor.state.tr;
  writeSentenceCheck(
    tr,
    { ...current, ...(current.kind === "chart" && { node: true as const }) },
    changed,
  );
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(
    editor,
    (t) => t("claim.source.chosen", { document: displayName(chosen.document) }),
    undefined,
    () => restoreCheck(editor, current, before),
  );
  try {
    await flushMindUpdates(mindId);
    const again = shownClaims(editor.state).find((each) => each.check.id === before.id);
    if (
      again?.check.parts?.some(
        (each) =>
          each.facet?.kind === "source" &&
          each.span.start === row.span.start &&
          each.span.end === row.span.end &&
          each.facet.selectedDocumentId === documentId,
      )
    )
      await checkAgain(editor, mindId, doc, again);
  } catch (error) {
    useNotices.getState().showError(error);
  }
}
