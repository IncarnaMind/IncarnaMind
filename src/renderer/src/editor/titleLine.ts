import { Extension } from "@tiptap/core";
import { type Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { isTitleLine } from "./EndHint";

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
            const { doc, schema } = view.state;
            const paragraph = schema.nodes.paragraph;
            if (!paragraph || doc.childCount !== 1 || !isTitleLine(doc.firstChild)) return false;
            const line = oneLineOf(slice.content);
            if (line) {
              view.dispatch(view.state.tr.replaceSelection(new Slice(line, 0, 0)).scrollIntoView());
              return true;
            }
            view.dispatch(view.state.tr.setNodeMarkup(0, paragraph));
            return false;
          },
        },
      }),
    ];
  },
});
