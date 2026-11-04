import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { ANALYSIS_TABLE_ATTRIBUTE, ANALYSIS_TABLE_NODE } from "../../../core/api";
import { readTableBinding, sameBinding } from "../../../shared/figureRuns";
import { tableAround } from "./chartCommands";

/** A transaction with this meta may take an Analysis table's marker away: its Convert to text. */
const CONVERTING = "analysisTable.convert";

/** Whether the table at the cursor is an Analysis's own (#2378). */
export function inAnalysisTable(state: EditorState): boolean {
  const table = tableAround(state);
  return table !== null && readTableBinding(table.node.attrs[ANALYSIS_TABLE_ATTRIBUTE]) !== null;
}

/**
 * Convert to text, in the table's menu (#2378): the table at the cursor becomes a table the User
 * typed, its cells then checked as any are, and its caption's marker goes; its caption's words stay.
 */
export function convertAnalysisTable(editor: Editor): boolean {
  const table = tableAround(editor.state);
  const binding = table && readTableBinding(table.node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
  if (!table || !binding) return false;
  return editor.commands.command(({ tr }) => {
    tr.setNodeAttribute(table.pos, ANALYSIS_TABLE_ATTRIBUTE, null);
    const markers: number[] = [];
    tr.doc.descendants((node, pos) => {
      if (pos >= table.pos) return false;
      const named =
        node.type.name === ANALYSIS_TABLE_NODE
          ? readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE])
          : null;
      if (named && sameBinding(named, binding)) markers.push(pos);
      return true;
    });
    const last = markers.at(-1);
    if (last !== undefined) tr.delete(last, last + 1);
    tr.setMeta(CONVERTING, true);
    return true;
  });
}

const boundTables = (doc: ProseMirrorNode) => {
  const bindings: unknown[] = [];
  doc.descendants((node) => {
    if (node.type.name === "table") {
      bindings.push(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
      return false;
    }
    return true;
  });
  return bindings.flatMap((each) => readTableBinding(each) ?? []);
};

const markersIn = (doc: ProseMirrorNode) => {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === ANALYSIS_TABLE_NODE) count++;
    return true;
  });
  return count;
};

/**
 * An Analysis table's marker goes only with Convert to text, as a figure's does (#2378): an edit
 * that would delete it while its table stays bound keeps it. Deleting the table with it, a sync
 * from the Note's other windows and Undo are left alone.
 */
export const AnalysisTableGuard = Extension.create({
  name: "analysisTableGuard",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("analysisTableGuard"),
        filterTransaction(tr: Transaction) {
          if (!tr.docChanged || tr.getMeta(CONVERTING)) return true;
          // The Note's other windows, the core and Undo change it through Yjs, which is the record.
          if (
            (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin
          )
            return true;
          if (markersIn(tr.doc) >= markersIn(tr.before)) return true;
          const kept = boundTables(tr.doc);
          let removed = false;
          tr.before.descendants((node) => {
            if (removed || node.type.name !== ANALYSIS_TABLE_NODE) return true;
            const named = readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
            let still = false;
            tr.doc.descendants((now) => {
              if (still || now.type.name !== ANALYSIS_TABLE_NODE) return true;
              const same = readTableBinding(now.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
              still = named !== null && same !== null && sameBinding(named, same);
              return !still;
            });
            if (!still && named && kept.some((binding) => sameBinding(binding, named)))
              removed = true;
            return !removed;
          });
          return !removed;
        },
      }),
    ];
  },
});
