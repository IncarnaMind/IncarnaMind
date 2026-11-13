import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { addFoundCitations, foundCitationInserts } from "../checks";
import { useLanguage, useT } from "../i18n";
import { offerEditorUndo } from "./editorUndo";

/** How many Passages the Note's checks found that its sentences don't cite yet. */
export function useFoundPassages(editor: Editor): number {
  return (
    useEditorState({
      editor,
      selector: ({ editor: current }) =>
        foundCitationInserts(current.state).reduce(
          (count, each) => count + each.citations.length,
          0,
        ),
    }) ?? 0
  );
}

/**
 * The check's result line when its checks left more than one Passage the sentences don't cite
 * (#3019): "3 passages found, not yet cited · Add all", which adds every one as its part's
 * Citation, as one Undo. The check itself never writes them into the Note.
 */
export function FoundPassagesLine({
  editor,
  className = "mind-health-line",
}: {
  editor: Editor;
  className?: string;
}) {
  const t = useT();
  const language = useLanguage();
  const found = useFoundPassages(editor);
  if (found < 2) return null;
  const count = new Intl.NumberFormat(language).format(found);
  return (
    <span data-testid="found-passages-line" className={className}>
      {t("found.notCited", { count })}
      {" · "}
      <button
        type="button"
        data-testid="found-passages-add"
        className="citation-card-action"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const added = addFoundCitations(editor);
          if (added === 0) return;
          const many = new Intl.NumberFormat(language).format(added);
          offerEditorUndo(editor, (say) =>
            say(added === 1 ? "found.added.one" : "found.added", { count: many }),
          );
        }}
      >
        {t("found.addAll")}
      </button>
    </span>
  );
}
