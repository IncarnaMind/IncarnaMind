import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { CITATION_NODE, type CitationAttributes } from "../../../core/api";
import { citationState } from "../../../shared/citations";
import { useAppStore } from "../store";

/**
 * Where the Citations are whose Document changed after they were cited (#99), top to bottom; those
 * the User chose to keep over the current version don't count.
 */
export function changedCitationPositions(
  editor: Editor,
  documents: ReturnType<typeof useAppStore.getState>["documents"] | null,
  kept: ReturnType<typeof useAppStore.getState>["keptCitationTexts"],
): number[] {
  const found: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== CITATION_NODE) return;
    const attributes = node.attrs as CitationAttributes;
    const state = citationState(attributes, documents, kept);
    const live = documents?.find((each) => each.id === state.documentId);
    if (
      state.changedAfterCited &&
      !(attributes.keptOver && attributes.keptOver === live?.contentHash)
    ) {
      found.push(pos);
    }
  });
  return found;
}

const same = (left: readonly number[], right: readonly number[] | null) =>
  right !== null &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/** The positions of the Mind's Citations whose Document changed after they were cited. */
export function useChangedCitations(editor: Editor): number[] {
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const kept = useAppStore((state) => state.keptCitationTexts);
  return (
    useEditorState({
      editor,
      selector: () => changedCitationPositions(editor, documents, kept),
      equalityFn: same,
    }) ?? []
  );
}
