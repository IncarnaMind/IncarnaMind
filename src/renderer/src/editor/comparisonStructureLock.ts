import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { COMPARISON_TABLE_NODE } from "../../../core/api";
import { useComparisonColumns } from "../comparisonColumnState";

/**
 * A table whose structure the core is writing takes no local edits until the
 * core's change lands (#1833): the note's transaction that would write into
 * it is dropped, so no local `questions` or cell write can cross the core's.
 */
export const ComparisonStructureLock = Extension.create({
  name: "comparisonStructureLock",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("comparisonStructureLock"),
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged) return true;
          // The core's own change arrives as a remote Yjs update: it is what the table waits for.
          if (transaction.getMeta(ySyncPluginKey)?.isChangeOrigin) return true;
          const holds = useComparisonColumns.getState().holds;
          if (holds.size === 0) return true;
          let blocked = false;
          state.doc.descendants((node, pos) => {
            if (blocked) return false;
            if (node.type.name !== COMPARISON_TABLE_NODE) return true;
            if ((holds.get(String(node.attrs.id ?? ""))?.size ?? 0) === 0) return false;
            const after = transaction.doc.nodeAt(transaction.mapping.map(pos));
            if (!after || !node.eq(after)) blocked = true;
            return false;
          });
          return !blocked;
        },
      }),
    ];
  },
});
