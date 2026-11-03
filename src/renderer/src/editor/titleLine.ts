import { Extension } from "@tiptap/core";
import { type Fragment, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

/** The line a new Mind starts with: an empty Heading 1, its title to be typed. */
export const isTitleLine = (node: ProseMirrorNode | null) =>
  node?.type.name === "heading" && node.attrs.level === 1 && node.content.size === 0;

/**
 * One line of what was pasted over a new Mind's empty title: words with no
 * Block around them (a sentence copied from a web page), or one paragraph,
 * perhaps with the empty line its newline makes. Null for more.
 */
function oneLineOf(pasted: Fragment): Fragment | null {
  if (pasted.childCount > 0 && pasted.content.every((node) => node.isInline)) return pasted;
  const last = pasted.lastChild;
  const lines =
    last?.isTextblock && last.content.size === 0 && pasted.childCount > 1
      ? pasted.childCount - 1
      : pasted.childCount;
  const first = pasted.firstChild;
  return lines === 1 && first?.isTextblock ? first.content : null;
}

export function titlePaste(
  state: EditorState,
  slice: Slice,
): { transaction: Transaction; inserted: boolean } | null {
  const { doc, schema } = state;
  const paragraph = schema.nodes.paragraph;
  if (!paragraph || doc.childCount !== 1 || !isTitleLine(doc.firstChild)) return null;
  const line = oneLineOf(slice.content);
  return line
    ? { transaction: state.tr.replaceSelection(new Slice(line, 0, 0)), inserted: true }
    : { transaction: state.tr.setNodeMarkup(0, paragraph), inserted: false };
}

/**
 * Text pasted into a new Mind keeps its formatting: pasted over the empty
 * title its first line starts with, one line is the title, and anything more
 * makes that line body text first, so the first pasted paragraph isn't made
 * the title.
 */
export const TitleLine = Extension.create({
  name: "titleLine",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("titleLine"),
        props: {
          handlePaste(view, _event, slice) {
            const prepared = titlePaste(view.state, slice);
            if (!prepared) return false;
            view.dispatch(
              prepared.inserted ? prepared.transaction.scrollIntoView() : prepared.transaction,
            );
            return prepared.inserted;
          },
        },
      }),
    ];
  },
});
