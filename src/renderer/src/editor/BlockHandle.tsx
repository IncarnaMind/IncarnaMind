import type { ComputePositionConfig, VirtualElement } from "@floating-ui/dom";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { NodeRangeSelection } from "@tiptap/extension-node-range";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import {
  type BlockOrigin,
  INCLUDE_IN_CONTEXT_ATTRIBUTE,
  NOTE_BLOCK_TYPES,
  QUESTION_BLOCK,
} from "../../../core/api";
import { shortcutLabel } from "../commands/keymap";
import { CheckIcon, GripIcon, TrashIcon } from "../components/icons";
import { ConversationLineIcon } from "../components/lineIcons";
import { useT } from "../i18n";
import { findBlock, questionWithAnswer } from "./blockCommands";
import { blockMenuOpeners } from "./blockMenuOpeners";
import { originOf } from "./blockOrigins";
import { BLOCK_ID_ATTRIBUTE } from "./noteSchema";
import { openOrigin } from "./originActions";
import { Popover } from "./Popover";

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

/** The list item the caret is in, when the menu is opened from the keyboard and names that Block. */
function itemAtCaret(
  editor: Editor,
  block: { node: ProseMirrorNode; pos: number },
): { node: ProseMirrorNode; pos: number; textPos: number | null } | null {
  const dom = editor.view.nodeDOM(block.pos);
  if (!(dom instanceof Element) || !dom.matches("ul, ol")) return null;
  const $from = editor.view.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "listItem" && node.type.name !== "taskItem") continue;
    const pos = $from.before(depth);
    // A command can name another Block: the caret's item anchors the menu only inside this one.
    if (pos < block.pos || pos >= block.pos + block.node.nodeSize) return null;
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
  usePointer = true,
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
      const item = usePointer
        ? itemUnderPointer(editor, block, pointer)
        : itemAtCaret(editor, block);
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

const isNote = (node: ProseMirrorNode) =>
  (NOTE_BLOCK_TYPES as readonly string[]).includes(node.type.name);

/** The Block whose menu is open: its ID, where it was when the menu opened, and what it is. */
interface MenuTarget {
  anchor: Element | VirtualElement;
  id: unknown;
  pos: number;
  /** Null for Blocks that aren't Notes (Questions, Answers), which have no context flag. */
  included: boolean | null;
}

/**
 * The handle left of the Block under the mouse. Dragging it moves the Block;
 * clicking it opens the Block's menu.
 */
export function BlockHandle({ editor }: { editor: Editor }) {
  const t = useT();
  const hovered = useRef<{ node: ProseMirrorNode; pos: number } | null>(null);
  /** Where the pointer is, so a list's handle stands by the item under it, not the list's first. */
  const pointer = useRef({ x: 0, y: 0 });
  const grip = useRef<HTMLButtonElement>(null);
  const [menuFor, setMenuFor] = useState<MenuTarget | null>(null);

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

  // While the menu is open, the handle stays on its Block.
  const lockHandle = (locked: boolean) => {
    if (!editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta("lockDragHandle", locked));
  };

  const openMenuFor = (
    block: { node: ProseMirrorNode; pos: number },
    anchor: MenuTarget["anchor"],
  ) => {
    lockHandle(true);
    setMenuFor({
      anchor,
      id: block.node.attrs[BLOCK_ID_ATTRIBUTE],
      pos: block.pos,
      included: isNote(block.node)
        ? block.node.attrs[INCLUDE_IN_CONTEXT_ATTRIBUTE] !== false
        : null,
    });
  };

  const openMenu = () => {
    const block = hovered.current;
    if (block && grip.current) openMenuFor(block, grip.current);
  };

  const open = useRef(openMenuFor);
  open.current = openMenuFor;
  useEffect(() => {
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", track, true);
    return () => window.removeEventListener("pointermove", track, true);
  }, []);
  useEffect(() => {
    blockMenuOpeners.set(editor, (id) => {
      const found = findBlock(editor.state.doc, id);
      if (found)
        open.current(found, handleAnchor(editor, found, pointer.current, false) ?? editor.view.dom);
    });
    return () => {
      blockMenuOpeners.delete(editor);
    };
  }, [editor]);

  const closeMenu = (refocus: boolean) => {
    setMenuFor(null);
    lockHandle(false);
    if (refocus) editor.commands.focus();
  };

  /** Where the menu's Block is now: found by ID, which stays right even if the Mind changed meanwhile. */
  const targetPos = (target: MenuTarget) =>
    typeof target.id === "string" ? findBlock(editor.state.doc, target.id)?.pos : target.pos;

  const deleteBlock = () => {
    if (!menuFor) return;
    const pos = targetPos(menuFor);
    closeMenu(false);
    if (pos !== undefined) editor.chain().focus().deleteBlock(pos).run();
  };

  const toggleContext = () => {
    if (!menuFor || menuFor.included === null) return;
    const pos = targetPos(menuFor);
    const include = !menuFor.included;
    closeMenu(true);
    if (pos === undefined) return;
    editor
      .chain()
      .command(({ tr }) => {
        // On is the default, so it isn't stored.
        tr.setNodeAttribute(pos, INCLUDE_IN_CONTEXT_ATTRIBUTE, include ? null : false);
        return true;
      })
      .run();
  };

  return (
    <>
      <DragHandle
        editor={editor}
        className="block-handle"
        computePositionConfig={HANDLE_POSITION}
        getReferencedVirtualElement={() => handleAnchor(editor, hovered.current, pointer.current)}
        onNodeChange={({ node, pos }) => {
          hovered.current = node ? { node, pos } : null;
          for (const shown of editor.view.dom.querySelectorAll("[data-handle-on]"))
            shown.removeAttribute("data-handle-on");
          // Only a Question's node view ignores attribute changes; on a text Block ProseMirror would redraw it.
          const dom = node?.type.name === QUESTION_BLOCK ? editor.view.nodeDOM(pos) : null;
          if (dom instanceof Element) dom.setAttribute("data-handle-on", "");
        }}
      >
        <button
          ref={grip}
          type="button"
          data-testid="block-handle"
          aria-label={t("editor.block.handle")}
          title={t("editor.block.handle")}
          aria-haspopup="menu"
          aria-expanded={menuFor !== null}
          onClick={openMenu}
        >
          <GripIcon className="size-4" />
        </button>
      </DragHandle>
      {menuFor && (
        <BlockMenu
          anchor={menuFor.anchor}
          included={menuFor.included}
          origin={originOf(editor.state, menuFor.id)}
          onOpenOrigin={(origin) => {
            closeMenu(false);
            void openOrigin(origin);
          }}
          onDelete={deleteBlock}
          onToggleContext={toggleContext}
          onClose={closeMenu}
        />
      )}
    </>
  );
}

function BlockMenu({
  anchor,
  included,
  origin,
  onOpenOrigin,
  onDelete,
  onToggleContext,
  onClose,
}: {
  anchor: Element | VirtualElement;
  /** The Note's context flag, or null when the Block isn't a Note. */
  included: boolean | null;
  /** Where the Block came from: an Answer in the assistant (#201), or null. */
  origin: BlockOrigin | null;
  onOpenOrigin(origin: BlockOrigin): void;
  onDelete(): void;
  onToggleContext(): void;
  onClose(refocus: boolean): void;
}) {
  const t = useT();
  const first = useRef<HTMLButtonElement>(null);

  return (
    <Popover
      anchor={anchor}
      initialFocus={first}
      role="menu"
      aria-label={t("editor.block.menu")}
      data-testid="block-menu"
      onDismiss={() => onClose(false)}
      onKeyDown={(event) => {
        // Esc returns to writing.
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose(true);
      }}
      className="editor-menu w-[240px]"
    >
      {origin && (
        <button
          ref={first}
          type="button"
          role="menuitem"
          data-testid="block-menu-open-conversation"
          onClick={() => onOpenOrigin(origin)}
          className="editor-menu-item"
        >
          <span className="editor-menu-icon">
            <ConversationLineIcon className="size-4" />
          </span>
          <span className="flex-1">{t("origin.open")}</span>
        </button>
      )}
      {included !== null && (
        <button
          ref={origin ? undefined : first}
          type="button"
          role="menuitemcheckbox"
          aria-checked={included}
          data-testid="block-menu-context"
          onClick={onToggleContext}
          className="editor-menu-item"
        >
          <span className="editor-menu-icon">{included && <CheckIcon className="size-4" />}</span>
          <span className="flex-1">{t("question.context.include")}</span>
        </button>
      )}
      <button
        ref={included === null && !origin ? first : undefined}
        type="button"
        role="menuitem"
        data-testid="block-menu-delete"
        onClick={onDelete}
        className="editor-menu-item"
      >
        <span className="editor-menu-icon">
          <TrashIcon className="size-4" />
        </span>
        <span className="flex-1">{t("editor.block.delete")}</span>
        <kbd className="editor-menu-shortcut">{shortcutLabel("block.delete")}</kbd>
      </button>
    </Popover>
  );
}
