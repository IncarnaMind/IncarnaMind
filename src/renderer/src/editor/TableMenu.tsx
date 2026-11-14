import { autoUpdate } from "@floating-ui/dom";
import { type Editor, useEditorState } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { withoutOwnDelete } from "../commands/blocks";
import { shortcutLabel } from "../commands/keymap";
import { ObjectMenu } from "../components/ObjectMenu";
import { openMenuFromRightClick } from "../components/usePopoverMenu";
import { useT } from "../i18n";
import { findBlock } from "./blockCommands";
import { BLOCK_ID_ATTRIBUTE } from "./noteSchema";
import { sameSpot, type TableSpot, tableSpot } from "./tableCommands";

const BUTTON_SIZE = 20;
/** How far the button sits inside the cell's top-right corner. */
const INSET = 4;

/** In `frame`, not fixed, so it scrolls with the text and stays under the composer. */
function placeOnCell(cell: HTMLElement, anchor: HTMLElement, frame: HTMLElement): () => void {
  const place = () => {
    const box = cell.getBoundingClientRect();
    const shown = cell.closest(".tableWrapper")?.getBoundingClientRect() ?? box;
    const right = Math.min(box.right, shown.right);
    const origin = frame.getBoundingClientRect();
    anchor.style.left = `${right - INSET - BUTTON_SIZE - origin.left}px`;
    anchor.style.top = `${box.top + INSET - origin.top}px`;
    anchor.style.visibility =
      right - BUTTON_SIZE - INSET < Math.max(box.left, shown.left) ? "hidden" : "";
  };
  return autoUpdate(cell, anchor, place);
}

/**
 * The table's ⋯ button at the top-right corner of the cell the cursor is in, as Confluence has,
 * or ⌘/ (its command, `table.menu`). It opens the Block's menu, the one the Block handle and a
 * right-click open, whose table commands add rows and columns where the cursor is, turn the
 * heading row on and off, and delete rows, columns or the table, each an Undo step of its own.
 * Drawn inside `.mind-editor-frame`.
 */
export function TableMenu({ editor }: { editor: Editor }) {
  const t = useT();
  const spot = useEditorState({
    editor,
    selector: ({ editor: current }): TableSpot | null =>
      current.isEditable ? tableSpot(current.state) : null,
    equalityFn: sameSpot,
  });
  const focused = useEditorState({ editor, selector: ({ editor: current }) => current.isFocused });
  const block = useEditorState({
    editor,
    selector: ({ editor: current }): string | null => {
      const { $from } = current.state.selection;
      const id: unknown = $from.depth > 0 ? $from.node(1).attrs[BLOCK_ID_ATTRIBUTE] : null;
      return typeof id === "string" ? id : null;
    },
  });
  const [open, setOpen] = useState(false);
  /** The menu was asked for (⌘/) and opens once its button is there. */
  const [asked, setAsked] = useState(false);
  const shown = spot !== null && block !== null && (focused || open || asked);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    editor.storage.tableKeys.openMenu = () => setAsked(true);
    return () => {
      editor.storage.tableKeys.openMenu = null;
    };
  }, [editor]);

  useEffect(() => {
    if (!asked) return;
    setAsked(false);
    const button = anchor.current?.querySelector("button");
    if (button) openMenuFromRightClick(button, 0);
  }, [asked]);

  const cell = spot?.cell ?? null;
  useLayoutEffect(() => {
    const element = anchor.current;
    const frame = element?.parentElement;
    const dom = cell === null || editor.isDestroyed ? null : editor.view.nodeDOM(cell);
    if (!shown || !element || !frame || !(dom instanceof HTMLElement)) return;
    return placeOnCell(dom, element, frame);
  }, [editor, cell, shown]);

  const label = t("editor.table.menu");
  const node = block === null ? null : findBlock(editor.state.doc, block)?.node;

  return (
    <div
      ref={anchor}
      className="table-menu-anchor"
      hidden={!shown}
      // Keep the cursor in the cell: the menu acts where it is.
      onMouseDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-object-menu]")) {
          event.preventDefault();
        }
      }}
    >
      {block !== null && spot !== null && (
        <ObjectMenu
          target={{ kind: "block", id: block }}
          label={label}
          hint={`${label} (${shortcutLabel("table.menu")})`}
          testId="table"
          className="table-menu-button"
          onOpenChange={setOpen}
          without={node ? withoutOwnDelete(node) : []}
        />
      )}
    </div>
  );
}
