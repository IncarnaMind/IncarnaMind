import { type Editor, Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, type Selection } from "@tiptap/pm/state";
import { BLOCK_ID_ATTRIBUTE, PICTURE_NODE } from "../../../core/api";
import { runShortcut } from "../commands/keymap";
import type { ObjectRef } from "../objects";
import { openPictureFromEditor } from "../pictureViewer";
import { findBlock } from "./blockCommands";

const openNotes = new Set<Editor>();

/** Every open note holding the Block: the same Note open in two panes is held by two editors. */
export function notesHolding(blockId: string): Editor[] {
  return [...openNotes].filter(
    (editor) => !editor.isDestroyed && findBlock(editor.state.doc, blockId) !== null,
  );
}

export function noteHolding(blockId: string): Editor | null {
  return notesHolding(blockId)[0] ?? null;
}

/** The note the element is in, whose own undo ⌘Z reaches there. */
export function noteAround(element: Element | null): Editor | null {
  if (!element) return null;
  for (const editor of openNotes) {
    if (!editor.isDestroyed && editor.view.dom.contains(element)) return editor;
  }
  return null;
}

/** The top-level Block the selection starts in, or right after. */
export function blockAt({ $from }: Selection): ObjectRef | null {
  const node = $from.depth > 0 ? $from.node(1) : $from.nodeAfter;
  const id: unknown = node?.attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? { kind: "block", id } : null;
}

/**
 * The keymap in the note: the shortcuts of commands that act on Blocks, with
 * the Block at the cursor as the focus, bound inside the editor as its own
 * keys are, so the editor doesn't use the key first. The window's shortcuts
 * go on to the window.
 */
export const NoteKeymap = Extension.create({
  name: "noteKeymap",

  onCreate() {
    openNotes.add(this.editor);
  },

  onDestroy() {
    openNotes.delete(this.editor);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("noteKeymap"),
        props: {
          handleKeyDown: (view, event) => {
            // Space on the selected picture opens it at full size (#2377), as a double-click does.
            if (
              event.key === " " &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.isComposing
            ) {
              const { selection } = view.state;
              if (selection instanceof NodeSelection && selection.node.type.name === PICTURE_NODE) {
                event.preventDefault();
                openPictureFromEditor(this.editor, selection.from);
                return true;
              }
            }
            return runShortcut(
              event,
              { selection: [], focus: blockAt(view.state.selection), surface: "mind" },
              { objectsOnly: true },
            );
          },
        },
      }),
    ];
  },
});
