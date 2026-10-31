import type { VirtualElement } from "@floating-ui/dom";
import type { NodeViewRenderer } from "@tiptap/core";
import { type Editor, useEditorState } from "@tiptap/react";
import { useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { useWritingProperties } from "../mindStyles";
import { numberedFootnotes } from "./citationNumbers";
import { FootnoteText, type FootnoteTextHandle } from "./FootnoteText";
import {
  closeFootnote,
  findFootnote,
  focusNow,
  openFootnoteOf,
  returnToFootnote,
} from "./footnoteSchema";
import { useMindId } from "./mindContext";
import { noteMarker } from "./noteLabels";
import { Popover } from "./Popover";
import { asOwnUndoStep } from "./selectionCommands";

/** A footnote's marker in the editor, as drawn now: the editor may draw it anew at any change. */
const markerOf = (editor: Editor, id: string) =>
  editor.view.dom.querySelector<HTMLElement>(`[data-footnote-id="${CSS.escape(id)}"]`);

/**
 * The popover at a footnote's marker, where its text is written and edited
 * in place (`FootnoteText`), open while the editor says so (`openFootnote`):
 * at once for a footnote just inserted, or when its marker is clicked or, by
 * keyboard, selected and Enter pressed. Enter or Esc puts the cursor back
 * after the marker; a click elsewhere just closes it. "Remove footnote" deletes the
 * footnote, which Undo brings back.
 */
export function FootnotePopover({
  editor,
  citationView,
}: {
  editor: Editor;
  citationView: NodeViewRenderer | null;
}) {
  const t = useT();
  const writing = useWritingProperties(useMindId());
  const open = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const id = openFootnoteOf(current.state);
      const found = id ? numberedFootnotes(current.state).find((each) => each.id === id) : null;
      return id ? { id, number: found?.number ?? 0, endnote: found?.endnote === true } : null;
    },
    equalityFn: (a, b) => a?.id === b?.id && a?.number === b?.number && a?.endnote === b?.endnote,
  });
  const text = useRef<FootnoteTextHandle>(null);
  const id = open?.id ?? null;

  // Follows the marker wherever the editor draws it, and keeps its last place if it goes.
  const anchor = useMemo<VirtualElement | null>(() => {
    if (!id) return null;
    let last = markerOf(editor, id)?.getBoundingClientRect() ?? new DOMRect();
    return {
      contextElement: editor.view.dom,
      getBoundingClientRect: () => {
        const marker = markerOf(editor, id);
        if (marker?.isConnected) last = marker.getBoundingClientRect();
        return last;
      },
    };
  }, [editor, id]);

  if (!open || !anchor) return null;
  const close = () => closeFootnote(editor);
  const number = noteMarker(editor, open.number, open.endnote);
  const label = t(open.endnote ? "editor.endnote.text" : "editor.footnote.text", { number });
  return createPortal(
    <Popover
      key={open.id}
      anchor={anchor}
      initialFocus={text}
      onDismiss={close}
      aria-label={label}
      data-testid="footnote-popover"
      className="editor-menu footnote-popover"
      // In the body, outside the Mind's page: the footnote is still written in the Mind's font.
      style={writing}
    >
      <FootnoteText
        ref={text}
        mind={editor}
        id={open.id}
        label={label}
        placeholder={t(open.endnote ? "editor.endnote.placeholder" : "editor.footnote.placeholder")}
        variant="popover"
        citationView={citationView}
        onLeave={() => {
          close();
          returnToFootnote(editor, open.id);
        }}
        onGone={close}
      />
      {editor.isEditable && (
        <div className="footnote-popover-foot">
          <span className="footnote-popover-hint">{t("editor.footnote.hint")}</span>
          <button
            type="button"
            data-testid="footnote-remove"
            className="footnote-popover-remove"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const found = findFootnote(editor.state.doc, open.id);
              close();
              if (found) {
                asOwnUndoStep(editor, () =>
                  editor.view.dispatch(
                    editor.state.tr.delete(found.pos, found.pos + found.node.nodeSize),
                  ),
                );
              }
              // Back in the text, where the marker was.
              focusNow(editor);
            }}
          >
            {t(open.endnote ? "editor.endnote.remove" : "editor.footnote.remove")}
          </button>
        </div>
      )}
    </Popover>,
    document.body,
  );
}
