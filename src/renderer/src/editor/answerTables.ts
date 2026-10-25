import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NodeJSON } from "../../../shared/blockJson";
import { withoutCitationGlue } from "./citationGlue";

export const TABLE_SLOT_CLASS = "answer-table-slot";
export const TABLE_SLOT_INDEX = "data-table-index";

const slotFor = (index: number) => {
  const slot = document.createElement("div");
  slot.className = TABLE_SLOT_CLASS;
  slot.setAttribute(TABLE_SLOT_INDEX, String(index));
  return slot;
};

export function tablesOf(doc: ProseMirrorNode): NodeJSON[] {
  const tables: NodeJSON[] = [];
  doc.forEach((node) => {
    if (node.type.name !== "table") return;
    const json: NodeJSON = node.toJSON();
    tables.push(json);
  });
  return withoutCitationGlue(tables);
}

/**
 * A slot before each top-level table of the Answer's editor, drawn there only: it is not in the
 * document, so it is never copied or added to a note.
 */
export const AnswerTableSlots = Extension.create({
  name: "answerTableSlots",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: ({ doc }) => {
            const slots: Decoration[] = [];
            doc.forEach((node, offset) => {
              if (node.type.name !== "table") return;
              const index = slots.length;
              slots.push(
                Decoration.widget(offset, () => slotFor(index), {
                  // The same slot as the Answer grows, so the button in it stays where it is.
                  key: `table-slot:${index}`,
                  stopEvent: () => true,
                }),
              );
            });
            return DecorationSet.create(doc, slots);
          },
        },
      }),
    ];
  },
});
