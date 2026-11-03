import { type NodeViewProps, NodeViewWrapper, useEditorState } from "@tiptap/react";
import { useT } from "../i18n";
import { jumpTo, outlineOf } from "./outline";

/** A table of contents as the page draws it: the Note's headings, each jumping to its own. */
export function TableOfContentsView({ editor }: NodeViewProps) {
  const t = useT();
  const entries = useEditorState({
    editor,
    selector: ({ editor: now }) => outlineOf(now),
  });
  const lowest = entries.length > 0 ? Math.min(...entries.map((entry) => entry.level)) : 1;
  return (
    <NodeViewWrapper
      data-testid="table-of-contents"
      className="table-of-contents"
      role="navigation"
      aria-label={t("editor.toc.title")}
      contentEditable={false}
    >
      <p className="table-of-contents-title">{t("editor.toc.title")}</p>
      {entries.length === 0 ? (
        <p className="table-of-contents-empty" data-testid="table-of-contents-empty">
          {t("editor.outline.empty")}
        </p>
      ) : (
        <ol className="table-of-contents-list">
          {entries.map((entry) => (
            <li
              key={`${entry.pos}:${entry.level}`}
              style={{ paddingLeft: (entry.level - lowest) * 16 }}
            >
              <button
                type="button"
                data-testid="table-of-contents-entry"
                data-level={entry.level}
                className="table-of-contents-entry"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => jumpTo(editor, entry.pos)}
              >
                {entry.text}
              </button>
            </li>
          ))}
        </ol>
      )}
    </NodeViewWrapper>
  );
}
