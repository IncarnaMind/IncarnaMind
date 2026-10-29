import type { EditorState } from "@tiptap/pm/state";
import type { CitationAttributes } from "../../../core/api";
import { citationState } from "../../../shared/citations";
import { useAppStore } from "../store";
import { keptSpans, shownClaims } from "./claimChecks";
import { type NoteHealth, noteHealth } from "./healthCounts";

/** An open Mind's health now, read as its badge reads it (`useHealth`). */
export function healthNow(state: EditorState): NoteHealth {
  const { status, documents, keptCitationTexts } = useAppStore.getState();
  const live = status.kind === "ready" ? documents : null;
  return noteHealth(state.doc, {
    claims: shownClaims(state),
    kept: keptSpans(state),
    citationCheck: (attributes: CitationAttributes) =>
      citationState(attributes, live, keptCitationTexts).check,
  });
}
