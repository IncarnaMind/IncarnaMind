import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { asOneStep } from "./editorUndo";

/**
 * A picture pasted or dropped into a Note (#1937): the picture itself, and the
 * alt text the User writes for it. The alt text is a line under the picture,
 * shown while the picture is selected, while the line is being written, and
 * whenever it says something, so a Note with pictures reads quiet until one is
 * chosen. Enter or leaving the line keeps it, in one Undo step with ⌘Z of its
 * own, never one that also takes the picture back.
 */
export function PictureView({ node, selected, editor, updateAttributes }: ReactNodeViewProps) {
  const t = useT();
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(alt);

  useEffect(() => setDraft(alt), [alt]);

  const commit = () => {
    if (draft !== alt) asOneStep(editor, () => updateAttributes({ alt: draft }));
  };
  const width = typeof node.attrs.width === "number" ? node.attrs.width : undefined;
  const height = typeof node.attrs.height === "number" ? node.attrs.height : undefined;

  return (
    <NodeViewWrapper className="mind-picture-block" data-testid="mind-picture">
      <img
        className="mind-picture-block-image"
        data-testid="mind-picture-image"
        src={String(node.attrs.src ?? "")}
        alt={alt}
        width={width}
        height={height}
        draggable={false}
      />
      {(selected || writing || alt !== "") && (
        <input
          data-testid="picture-alt"
          data-picture-alt="true"
          className="mind-picture-alt"
          aria-label={t("editor.picture.alt")}
          placeholder={t("editor.picture.altPlaceholder")}
          value={draft}
          onFocus={() => setWriting(true)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setWriting(false);
            commit();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            }
          }}
        />
      )}
    </NodeViewWrapper>
  );
}
