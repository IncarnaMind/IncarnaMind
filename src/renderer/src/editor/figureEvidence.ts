import { Extension } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  type AnalysisTableBinding,
  MIND_FIGURE_RUNS_FIELD,
  type RetainedFigureAnalysis,
} from "../../../core/api";
import { InvalidInputError } from "../../../core/errors";
import {
  boundTablesIn,
  calculatedFiguresIn,
  installFigureRuns,
  readFigureRunClosure,
  sameBinding,
  withoutChecks,
} from "../../../shared/figureRuns";
import { useAppStore } from "../store";
import { withoutTableBindings } from "./analysisTableCommands";
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
            let runs: RetainedFigureAnalysis[] = [];
            let transaction: Transaction;
            try {
              const blocks = clipboardBlocks(slice.content);
              const analysis = calculatedFiguresIn(blocks).some(({ figure }) => figure.analysis);
              const tables = boundTablesIn(blocks).length > 0;
              const html = event.clipboardData?.getData("text/html") ?? "";
              if (!analysis && !tables && !html.includes(FIGURE_RUNS_ATTRIBUTE)) return false;
              const holder = view.dom.ownerDocument.implementation.createHTMLDocument("").body;
              holder.innerHTML = html;
              const carriers = holder.querySelectorAll(`[${FIGURE_RUNS_ATTRIBUTE}]`);
              if (!analysis && !tables && carriers.length === 0) return false;
              if ((!analysis && !tables) || (analysis && carriers.length !== 1))
                throw new Error("The pasted figures need one Analysis record carrier.");
              // Its column rules are worked out again when its Analysis runs, never read from a
              // clipboard (`withoutChecks`). A table whose run doesn't come with it is a typed table.
              let unbound = carriers.length !== 1;
              if (!unbound) {
                try {
                  runs = readFigureRunClosure(
                    blocks,
                    withoutChecks(
                      JSON.parse(carriers[0]?.getAttribute(FIGURE_RUNS_ATTRIBUTE) ?? "null"),
                    ),
                  );
                } catch (error) {
                  if (analysis) throw error;
                  unbound = true;
                }
              }
              if (unbound) {
                runs = [];
                slice = new Slice(
                  withoutTableBindings(slice.content),
                  slice.openStart,
                  slice.openEnd,
                );
              } else {
                // One run's table stands once in a Note: a copy of one it holds comes in typed.
                const held = boundTablesIn(view.state.doc.toJSON().content ?? []);
                const repeated = (binding: AnalysisTableBinding) =>
                  held.some((each) => sameBinding(each, binding));
                if (boundTablesIn(blocks).some(repeated))
                  slice = new Slice(
                    withoutTableBindings(slice.content, repeated),
                    slice.openStart,
                    slice.openEnd,
                  );
              }
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
});
