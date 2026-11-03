import type { Editor, JSONContent } from "@tiptap/core";

/**
 * Puts a new Block after the one the cursor is in, or in its place if that is
 * an empty paragraph, and returns where it starts. A Block added at the very end
 * gets an empty paragraph after it, to carry on writing in.
 */
export function insertBlock(
  editor: Editor,
  range: { from: number; to: number },
  block: JSONContent,
): number | null {
  editor.commands.deleteRange(range);
  const { $from } = editor.state.selection;
  if ($from.depth === 0) return null;
  const replacesEmptyLine =
    $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.childCount === 0;
  const from = replacesEmptyLine ? $from.before(1) : $from.after(1);
  const to = replacesEmptyLine ? $from.after(1) : from;
  const atEnd = to === editor.state.doc.content.size;
  editor
    .chain()
    .insertContentAt({ from, to }, atEnd ? [block, { type: "paragraph" }] : block, {
      updateSelection: false,
    })
    .run();
  return from;
}
