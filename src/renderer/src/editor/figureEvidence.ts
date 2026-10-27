import { Extension } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { MIND_FIGURE_RUNS_FIELD, type RetainedFigureAnalysis } from "../../../core/api";
import { InvalidInputError, isRecord } from "../../../core/errors";
import {
  calculatedFiguresIn,
  installFigureRuns,
  pruneFigureRuns,
  readFigureRunClosure,
} from "../../../shared/figureRuns";
import { useAppStore } from "../store";
import { clipboardBlocks, FIGURE_RUNS_ATTRIBUTE } from "./copyCitations";
import { titlePaste } from "./titleLine";

export const FigureEvidence = Extension.create<{ doc: Y.Doc | null }>({
  name: "figureEvidence",
  priority: 200,
  addOptions: () => ({ doc: null }),
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event, slice) => {
            const { doc } = this.options;
            if (!doc || !this.editor.isEditable) return false;
            let runs: RetainedFigureAnalysis[];
            let transaction: Transaction;
            try {
              const blocks = clipboardBlocks(slice.content);
              const analysis = calculatedFiguresIn(blocks).some(({ figure }) => figure.analysis);
              const html = event.clipboardData?.getData("text/html") ?? "";
              if (!analysis && !html.includes(FIGURE_RUNS_ATTRIBUTE)) return false;
              const holder = view.dom.ownerDocument.implementation.createHTMLDocument("").body;
              holder.innerHTML = html;
              const carriers = holder.querySelectorAll(`[${FIGURE_RUNS_ATTRIBUTE}]`);
              if (!analysis && carriers.length === 0) return false;
              if (!analysis || carriers.length !== 1)
                throw new Error("The pasted figures need one Analysis record carrier.");
              runs = readFigureRunClosure(
                blocks,
                JSON.parse(carriers[0]?.getAttribute(FIGURE_RUNS_ATTRIBUTE) ?? "null"),
              );
              const preview = new Y.Doc();
              try {
                Y.applyUpdate(preview, Y.encodeStateAsUpdate(doc));
                installFigureRuns(preview, runs);
              } finally {
                preview.destroy();
              }
              const prepared = titlePaste(view.state, slice);
              transaction = prepared?.transaction ?? view.state.tr;
              if (!prepared?.inserted) transaction.replaceSelection(slice);
            } catch (error) {
              useAppStore
                .getState()
                .reportError(
                  new InvalidInputError({ key: "error.figure.paste" }, { cause: error }),
                );
              return true;
            }
            yUndoPluginKey
              .getState(view.state)
              ?.undoManager.addToScope(doc.getMap(MIND_FIGURE_RUNS_FIELD));
            doc.transact(() => {
              installFigureRuns(doc, runs);
              view.dispatch(
                transaction.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"),
              );
            }, ySyncPluginKey);
            return true;
          },
        },
      }),
    ];
  },
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
