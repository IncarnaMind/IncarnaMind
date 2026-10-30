import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import type { ClaimCheckPart } from "../../core/api";
import { attributionCorrection } from "../../shared/claimParts";
import { placeInSentence, type ShownClaim, shownClaims } from "./editor/claimChecks";
import { requestEdit } from "./editWithAi";
import { translateNow } from "./i18n";
import { useNotices } from "./notices";
import { useAppStore } from "./store";
import { fixesFree } from "./unsupportedFixes";

export function attributionAt(editor: Editor, kind: "source" | "time", objectId?: string) {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { from, to } = editor.state.selection;
  const documents = useAppStore.getState().documents;
  const matches = shownClaims(editor.state).flatMap((claim) => {
    if (claim.shown.state === "needs-recheck" || claim.shown.state === "checking") return [];
    return (claim.check.parts ?? []).flatMap((part) => {
      const correction = attributionCorrection(claim.check, part, documents);
      if (correction?.kind !== kind) return [];
      if (objectId !== undefined)
        return objectId === `${claim.check.id}:${part.span.start}:${part.span.end}`
          ? [{ claim, part, correction }]
          : [];
      const range = placeInSentence(editor.state, claim, {
        from: part.span.start,
        to: part.span.end,
      });
      return range && from >= range.from && to <= range.to ? [{ claim, part, correction }] : [];
    });
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function correctAttribution(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
  part: ClaimCheckPart,
): Promise<boolean> {
  if (editor.isDestroyed || !editor.isEditable || !fixesFree(mindId)) return false;
  const current = shownClaims(editor.state).find((each) => each.check.id === claim.check.id);
  const row = current?.check.parts?.find(
    (each) => each.span.start === part.span.start && each.span.end === part.span.end,
  );
  if (
    !current ||
    !row ||
    row.facet?.kind !== part.facet?.kind ||
    current.check.text !== claim.check.text ||
    current.shown.state === "needs-recheck" ||
    current.shown.state === "checking" ||
    !attributionCorrection(current.check, row, useAppStore.getState().documents)
  ) {
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
    return false;
  }
  return requestEdit(
    editor,
    mindId,
    doc,
    "follow-citation",
    undefined,
    { from: current.sentence.from, to: current.sentence.to },
    undefined,
    { id: current.check.id, span: row.span },
  );
}
