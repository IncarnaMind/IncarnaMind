import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection } from "@tiptap/pm/state";
import type { MindFocus } from "../../../core/api";
import { PICTURE_NODE } from "../../../core/api";

/** A line break as a line of its own; any other inline node that isn't text reads as nothing. */
const leafText = (leaf: ProseMirrorNode) => (leaf.type.name === "hardBreak" ? "\n" : "");

/** The text selected in the Mind as the editor reads it; "" with nothing selected. */
export function selectedText(state: EditorState): string {
  const { selection, doc } = state;
  return selection.empty ? "" : doc.textBetween(selection.from, selection.to, "\n\n", leafText);
}

/**
 * Where the User is in the Mind when they ask in the assistant (#544): the
 * text they selected, and the top-level Blocks it is in; with nothing
 * selected, the Block the cursor is in. A picture the User selected is asked
 * about: its Block id is named, and only then does its picture go to a model
 * (#1937).
 */
export function mindFocusOf(state: EditorState): MindFocus {
  const { selection, doc } = state;
  const blockIds: string[] = [];
  const add = (node: ProseMirrorNode | null | undefined) => {
    const id: unknown = node?.attrs.id;
    if (typeof id === "string" && id !== "") blockIds.push(id);
  };
  if (selection.empty) {
    const { $from } = selection;
    add($from.depth > 0 ? $from.node(1) : $from.nodeAfter);
    return { selection: "", blockIds };
  }
  if (selection instanceof NodeSelection && selection.node.type.name === PICTURE_NODE) {
    add(selection.node);
    return { selection: "", blockIds, pictures: [...new Set(blockIds)] };
  }
  doc.nodesBetween(selection.from, selection.to, (node) => {
    add(node);
    return false;
  });
  return { selection: selectedText(state), blockIds };
}
