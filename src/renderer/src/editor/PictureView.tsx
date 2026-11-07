import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { inAnswerAt } from "../pictureGroups";
import { openPictureViewer, pictureClickHandlers, picturesAt } from "../pictureViewer";
import { asOneStep } from "./editorUndo";
import { ExpandIcon } from "./icons";
import { PictureSurfaceContext } from "./mindContext";

/**
 * A picture in a Note (#1937) or in an Answer (#2377): the picture itself,
 * and the alt text the User writes for it. The alt text is a line under the
 * picture, shown while the picture is selected, while the line is being
 * written, and whenever it says something, so a Note with pictures reads
 * quiet until one is chosen. Enter or leaving the line keeps it, in one Undo
 * step with ⌘Z of its own, never one that also takes the picture back.
 *
 * In a Note a click selects it like any Block, and a double-click, Space or
 * the hover button opens it at full size; in an Answer a click opens it, and
 * a drag over it still selects (#2377).
 */
export function PictureView({
  node,
  selected,
  editor,
  updateAttributes,
  getPos,
}: ReactNodeViewProps) {
  const t = useT();
  const surface = useContext(PictureSurfaceContext);
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(alt);
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => setDraft(alt), [alt]);

  const open = () => {
    const at = typeof getPos === "function" ? getPos() : undefined;
    if (at === undefined) return;
    const found = picturesAt(editor.state.doc, at, surface);
    if (!found) return;
    openPictureViewer({
      group: { kind: found.kind },
      pictures: found.pictures,
      index: found.index,
      source: image.current,
    });
  };
  // The press is remembered across the selection change a press makes, which redraws this view.
  const openNow = useRef(open);
  openNow.current = open;
  const click = useMemo(() => pictureClickHandlers(() => openNow.current()), []);

  const commit = () => {
    if (draft !== alt) asOneStep(editor, () => updateAttributes({ alt: draft }));
  };
  const width = typeof node.attrs.width === "number" ? node.attrs.width : undefined;
  const height = typeof node.attrs.height === "number" ? node.attrs.height : undefined;
  // A Note's picture is selected and opened with a double-click; an Answer's opens on a press.
  const at = typeof getPos === "function" ? getPos() : undefined;
  const opensOnPress =
    surface === "answer" || (at !== undefined && inAnswerAt(editor.state.doc, at));

  return (
    <NodeViewWrapper
      className="mind-picture-block group relative"
      data-testid="mind-picture"
      data-picture-selected={selected ? "true" : undefined}
    >
      <img
        ref={image}
        className="mind-picture-block-image"
        data-testid="mind-picture-image"
        data-picture-viewer=""
        src={String(node.attrs.src ?? "")}
        alt={alt}
        width={width}
        height={height}
        draggable={false}
        tabIndex={-1}
        onPointerDown={opensOnPress ? click.onPointerDown : undefined}
        onClick={opensOnPress ? click.onClick : undefined}
        onDoubleClick={
          opensOnPress
            ? undefined
            : (event) => {
                event.preventDefault();
                open();
              }
        }
        onKeyDown={(event) => {
          if (event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          open();
        }}
      />
      <button
        type="button"
        data-testid="picture-expand"
        aria-label={t("editor.picture.open")}
        title={t("editor.picture.open")}
        tabIndex={opensOnPress ? 0 : -1}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        className="pointer-events-none absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-md bg-sheet/90 text-ink-secondary opacity-0 shadow-popover group-hover:pointer-events-auto group-hover:opacity-100 hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100"
      >
        <ExpandIcon className="size-4" />
      </button>
      {(selected || writing || alt !== "") && editor.isEditable && (
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
