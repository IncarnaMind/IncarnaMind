import type { Editor } from "@tiptap/core";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";

/** A place in the editor that stays with the words around it while others write before or over it. */
export function keptPlace(editor: Editor, position: number): () => number | null {
  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  if (!binding) return () => null;
  const relative = absolutePositionToRelativePosition(position, binding.type, binding.mapping);
  return () =>
    editor.isDestroyed
      ? null
      : relativePositionToAbsolutePosition(binding.doc, binding.type, relative, binding.mapping);
}
