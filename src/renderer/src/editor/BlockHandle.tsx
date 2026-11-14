import type { ComputePositionConfig, VirtualElement } from "@floating-ui/dom";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { NodeRangeSelection } from "@tiptap/extension-node-range";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import { CellSelection, cellAround } from "@tiptap/pm/tables";
import type { Editor } from "@tiptap/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { QUESTION_BLOCK } from "../../../core/api";
import { withoutOwnDelete } from "../commands/blocks";
import { GripIcon } from "../components/icons";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { useT } from "../i18n";
import { findBlock, questionWithAnswer } from "./blockCommands";
import { BLOCK_ID_ATTRIBUTE } from "./noteSchema";

/** Centred on the point `handleAnchor` gives, to its left. */
const HANDLE_POSITION: ComputePositionConfig = { placement: "left", middleware: [] };

/** The position just inside a node's first textblock, if it has one. */
function firstTextPos(node: ProseMirrorNode, pos: number): number | null {
  if (node.isTextblock) return pos + 1;
  let found: number | null = null;
  node.descendants((child, offset) => {
    if (found !== null) return false;
    if (child.isTextblock) found = pos + 1 + offset + 1;
    return found === null;
  });
  return found;
}

/** A list's marker hangs this far inside its own list's indent (DESIGN.md, Lists). */
const MARKER_HANG = 24;

/**
 * What starts the Block's first line: a Question's fold chevron, a list item's
 * checkbox or marker, or its first letter at the text edge (DESIGN.md, Mind column).
 * `touching` is the Question's, whose handle and chevron meet.
 */
function firstOfLine(
  editor: Editor,
  block: { node: ProseMirrorNode; pos: number },
  textPos: number,
): { left: number; touching: boolean } | null {
  const at = editor.view.nodeDOM(block.pos);
  const dom = at instanceof Element ? at : (at?.parentElement ?? null);
  // A Question's node sits in a wrapper of its own, and marks itself while the handle points at it.
  const question =
    dom?.closest(".question-block") ??
    dom?.querySelector(".question-block") ??
    editor.view.dom.querySelector("[data-handle-on]")?.closest(".question-block") ??
    null;
  if (question) {
    const fold = question.querySelector(".question-fold");
    if (fold instanceof HTMLElement)
      return { left: fold.getBoundingClientRect().left, touching: true };
  }
  if (!dom) return null;
  // A hovered list is the first item's line; a paragraph in one is its own item's.
  const item = dom.closest("li") ?? (dom.matches("ul, ol") ? dom.querySelector("li") : null);
  if (!item) return null;
  const checkbox = item.querySelector(":scope > label > input");
  if (checkbox instanceof HTMLElement)
    return { left: checkbox.getBoundingClientRect().left, touching: false };
  // A wide marker widens the list's room, and the marker stays at the room's left edge.
  const room = Number.parseFloat(getComputedStyle(item).getPropertyValue("--marker-room")) || 0;
  return { left: editor.view.coordsAtPos(textPos, 1).left - MARKER_HANG - room, touching: false };
}

/**
 * The list item the pointer is over, when the Block Tiptap names is the whole list: the handle
 * then stands by that item's marker, not the list's first.
 */
function itemUnderPointer(
  editor: Editor,
  block: { node: ProseMirrorNode; pos: number },
  pointer: { x: number; y: number },
): { node: ProseMirrorNode; pos: number; textPos: number | null } | null {
  const dom = editor.view.nodeDOM(block.pos);
  if (!(dom instanceof Element) || !dom.matches("ul, ol")) return null;
  const at = editor.view.posAtCoords({ left: pointer.x, top: pointer.y });
  if (!at) return null;
  const $pos = editor.view.state.doc.resolve(at.pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name !== "listItem" && node.type.name !== "taskItem") continue;
    const pos = $pos.before(depth);
    return { node, pos, textPos: firstTextPos(node, pos) };
  }
  return null;
}

/**
 * Where the handle goes: in the left margin, its right edge a fixed gap before
 * the first thing on the Block's first line (the CSS sets `--handle-gap`), level
 * with that line. A Question's handle meets its fold chevron instead.
 */
function handleAnchor(
  editor: Editor,
  block: { node: ProseMirrorNode; pos: number } | null,
  pointer: { x: number; y: number },
): VirtualElement | null {
  if (!block || editor.isDestroyed) return null;
  const { view } = editor;
  return {
    contextElement: view.dom,
    getBoundingClientRect: () => {
      const style = getComputedStyle(view.dom);
      const gap = Number.parseFloat(style.getPropertyValue("--handle-gap")) || 0;
      // The text edge: the editor's box reaches over the margin (styles.css, `--editor-gutter`).
      const edge = view.dom.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft);
      const item = itemUnderPointer(editor, block, pointer);
      const textPos = item?.textPos ?? firstTextPos(block.node, block.pos);
      const first = textPos === null ? null : firstOfLine(editor, item ?? block, textPos);
      const x = first === null ? edge - gap : first.left - (first.touching ? 0 : gap);
      let y: number;
      if (textPos !== null) {
        const line = view.coordsAtPos(textPos);
        y = (line.top + line.bottom) / 2;
      } else {
        // A formula or a rule: the middle of its first line.
        const dom = view.nodeDOM(block.pos);
        const rect = dom instanceof Element ? dom.getBoundingClientRect() : new DOMRect();
        y = rect.top + Math.min(rect.height, Number.parseFloat(style.lineHeight) || 28) / 2;
      }
      return new DOMRect(x, y, 0, 0);
    },
  };
}

/** The top-level Block under a point of the window, or the one the caret is in when there is none. */
function blockFor(editor: Editor, point: { x: number; y: number } | undefined) {
  const { doc, selection } = editor.state;
  const over = point && editor.view.posAtCoords({ left: point.x, top: point.y });
  if (point && !over) return null;
  const $in = over ? doc.resolve(over.inside >= 0 ? over.inside : over.pos) : selection.$from;
  const node = $in.depth > 0 ? $in.node(1) : $in.nodeAfter;
  const id: unknown = node?.attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? findBlock(doc, id) : null;
}

/**
 * Puts the cursor in the Block a menu is about, so a command that acts at the cursor (a table's
 * row, a footnote) acts there. A right-click in a table cell keeps a cell selection that holds
 * the cell, and otherwise goes to the cell under it.
 */
function enter(
  editor: Editor,
  block: { node: ProseMirrorNode; pos: number },
  point: { x: number; y: number } | undefined,
): void {
  const { doc, selection } = editor.state;
  // A leaf Block has no inside for the cursor: it is selected itself, so its commands act on it.
  if (block.node.isLeaf && NodeSelection.isSelectable(block.node)) {
    if (!(selection instanceof NodeSelection && selection.from === block.pos)) {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(doc, block.pos)));
    }
    editor.view.focus();
    return;
  }
  const over = point && editor.view.posAtCoords({ left: point.x, top: point.y });
  const cell = over ? cellAround(doc.resolve(over.pos)) : null;
  const from = cell ? cell.pos : block.pos;
  const to = from + (cell ? (cell.nodeAfter?.nodeSize ?? 0) : block.node.nodeSize);
  let held = selection.from > from && selection.to < to;
  if (selection instanceof CellSelection) {
    held =
      cell === null &&
      selection.from >= block.pos &&
      selection.to <= block.pos + block.node.nodeSize;
    selection.forEachCell((_cell, pos) => {
      if (cell && pos === cell.pos) held = true;
    });
  }
  if (!held) {
    const at = over ? over.pos : block.pos + 1;
    editor.view.dispatch(editor.state.tr.setSelection(Selection.near(doc.resolve(at))));
  }
  editor.view.focus();
}

/**
 * Every Block's one menu: the handle left of the Block under the mouse (drag it to move the
 * Block, click it for its menu), a right-click on a Block and the context-menu key all open the
 * shared Block menu, through `useObjectMenu` and `ObjectMenu`. Wraps the note's text, which the
 * handle sits among.
 */
export function BlockHandle({
  editor,
  enabled,
  children,
}: {
  editor: Editor;
  /** Off while the Note can't be written in, or isn't showing its text. */
  enabled: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const hovered = useRef<{ node: ProseMirrorNode; pos: number } | null>(null);
  /** Where the pointer is, so a list's handle stands by the item under it, not the list's first. */
  const pointer = useRef({ x: 0, y: 0 });
  /**
   * The Block the menu is for: the one under the handle, until it opens, then the one asked about.
   * Empty until the pointer first comes to a Block, when the handle is not showing yet, but is
   * drawn so that it has its size when it is first placed.
   */
  const [target, setTarget] = useState("");
  const menuOpen = useRef(false);

  // A Question and the Answer right after it are dragged as one. This runs
  // after the handle's own dragstart (it listens on the document), so it
  // replaces what Tiptap set up: the selection a move deletes, what is dropped,
  // and the picture under the pointer.
  useEffect(() => {
    const dragWithAnswer = (event: DragEvent) => {
      const block = hovered.current;
      if (!(event.target instanceof Element) || !event.target.closest(".block-handle")) return;
      if (!block || editor.isDestroyed) return;
      const pair = questionWithAnswer(editor.state.doc, block.pos);
      if (!pair) return;
      const selection = NodeRangeSelection.create(editor.state.doc, pair.from, pair.to);
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      editor.view.dragging = { slice: selection.content(), move: true };

      const picture = document.createElement("div");
      // Drawn as in the editor, with room on the left for the Question band.
      picture.className = "mind-editor";
      Object.assign(picture.style, {
        position: "absolute",
        top: "-10000px",
        marginLeft: "0",
        paddingLeft: "56px",
        width: `${editor.view.dom.clientWidth}px`,
      });
      for (const pos of [
        pair.from,
        pair.from + (editor.state.doc.nodeAt(pair.from)?.nodeSize ?? 0),
      ]) {
        const dom = editor.view.nodeDOM(pos);
        if (dom instanceof Element) picture.append(dom.cloneNode(true));
      }
      document.body.append(picture);
      event.dataTransfer?.setDragImage(picture, 0, 0);
      // The browser takes its picture once this event is over.
      setTimeout(() => picture.remove(), 0);
    };
    document.addEventListener("dragstart", dragWithAnswer);
    return () => document.removeEventListener("dragstart", dragWithAnswer);
  }, [editor]);

  useEffect(() => {
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", track, true);
    return () => window.removeEventListener("pointermove", track, true);
  }, []);

  // While the menu is open, the handle stays on its Block.
  const onOpenChange = (open: boolean) => {
    menuOpen.current = open;
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("lockDragHandle", open));
  };

  const menu = useObjectMenu(null, (row, point) => {
    if (!enabled || editor.isDestroyed || !editor.isEditable) return null;
    // A key pressed in the open menu is the menu's own.
    if (!point && document.activeElement?.closest('[role="menu"]')) return null;
    const found = blockFor(editor, point);
    const id: unknown = found?.node.attrs[BLOCK_ID_ATTRIBUTE];
    if (!found || typeof id !== "string") return null;
    enter(editor, found, point);
    flushSync(() => setTarget(id));
    return row.querySelector<HTMLButtonElement>('[data-testid="block-menu"]');
  });

  const block = findBlock(editor.state.doc, target);
  const label = t("editor.block.menu");

  return (
    <div className="contents" data-keeps-focus="" {...menu.rowProps}>
      {children}
      {enabled && (
        <DragHandle
          editor={editor}
          className="block-handle"
          computePositionConfig={HANDLE_POSITION}
          getReferencedVirtualElement={() => handleAnchor(editor, hovered.current, pointer.current)}
          onNodeChange={({ node, pos }) => {
            hovered.current = node ? { node, pos } : null;
            const id: unknown = node?.attrs[BLOCK_ID_ATTRIBUTE];
            if (typeof id === "string" && !menuOpen.current) setTarget(id);
            for (const shown of editor.view.dom.querySelectorAll("[data-handle-on]"))
              shown.removeAttribute("data-handle-on");
            // Only a Question's node view ignores attribute changes; on a text Block ProseMirror would redraw it.
            const dom = node?.type.name === QUESTION_BLOCK ? editor.view.nodeDOM(pos) : null;
            if (dom instanceof Element) dom.setAttribute("data-handle-on", "");
          }}
        >
          <div
            className="contents"
            onClickCapture={(event) => {
              // The handle's click is for the Block it stands by, whichever one was asked about
              // last; a click the right-click or the key made is for the Block they chose.
              const stands = hovered.current?.node.attrs[BLOCK_ID_ATTRIBUTE];
              if (!event.nativeEvent.isTrusted || menuOpen.current) return;
              if (!(event.target instanceof Element) || !event.target.closest("[data-object-menu]"))
                return;
              if (typeof stands !== "string") return;
              const found = findBlock(editor.state.doc, stands);
              if (!found) return;
              enter(editor, found, undefined);
              flushSync(() => setTarget(stands));
            }}
          >
            <ObjectMenu
              target={{ kind: "block", id: target }}
              label={label}
              hint={t("editor.block.handle")}
              icon={GripIcon}
              className="block-grip"
              onOpenChange={onOpenChange}
              without={block ? withoutOwnDelete(block.node) : []}
              here={{
                "block.delete": () => {
                  const found = findBlock(editor.state.doc, target);
                  if (found) editor.chain().focus().deleteBlock(found.pos).run();
                },
              }}
            />
          </div>
        </DragHandle>
      )}
    </div>
  );
}
