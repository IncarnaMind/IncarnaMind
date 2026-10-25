import { TaskItem } from "@tiptap/extension-list";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export function checklistItem(label: (text: string) => string) {
  return TaskItem.extend({
    addProseMirrorPlugins() {
      return [
        ...(this.parent?.() ?? []),
        new Plugin({
          props: {
            decorations(state) {
              const labels: Decoration[] = [];
              state.doc.descendants((node, pos) => {
                if (node.type.name === "taskItem") {
                  labels.push(
                    Decoration.node(pos, pos + node.nodeSize, {
                      // A changed language must refresh Tiptap's checkbox even when its text hasn't changed (#1468).
                      "data-checklist-label": label(node.textContent),
                    }),
                  );
                }
              });
              return DecorationSet.create(state.doc, labels);
            },
          },
        }),
      ];
    },
  }).configure({ nested: true, a11y: { checkboxLabel: (node) => label(node.textContent) } });
}
