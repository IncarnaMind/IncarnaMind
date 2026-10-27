import { Extension } from "@tiptap/core";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { MIND_FIGURE_RUNS_FIELD } from "../../../core/api";
import { isRecord } from "../../../core/errors";
import { pruneFigureRuns } from "../../../shared/figureRuns";

export const FigureEvidence = Extension.create<{ doc: Y.Doc | null }>({
  name: "figureEvidence",
  addOptions: () => ({ doc: null }),
  dispatchTransaction({ transaction, next }) {
    const { doc } = this.options;
    const sync: unknown = transaction.getMeta(ySyncPluginKey);
    if (!doc || !this.editor.isEditable || (isRecord(sync) && sync.isChangeOrigin)) {
      next(transaction);
      return;
    }
    yUndoPluginKey
      .getState(this.editor.state)
      ?.undoManager.addToScope(doc.getMap(MIND_FIGURE_RUNS_FIELD));
    // The run's removal belongs to the edit's existing Undo item, before Yjs emits it (#1932).
    doc.transact(() => {
      try {
        next(transaction);
      } finally {
        pruneFigureRuns(doc);
      }
    }, ySyncPluginKey);
  },
});
