import type { NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { COMPARISON_ROW_NODE, COMPARISON_TABLE_NODE } from "../../../core/api";
import { cellProblemMessage, comparisonCellOf } from "../../../shared/comparisons";
import { staleAnswerKey, useComparisonColumns } from "../comparisonColumnState";
import { translateNow } from "../i18n";
import { useAppStore } from "../store";

/** Mutations outside a view's content are its own drawing, never the User's typing. */
const ownDrawing = (contentDOM: HTMLElement) => (mutation: { target: Node; type: string }) =>
  mutation.type !== "selection" && !contentDOM.contains(mutation.target);

/**
 * A comparison table's cell: its Answer, Citations and all, never typed in;
 * "Waiting…" until its turn, "Reading…" once it is being written, then its
 * words as they arrive, its Task going or paused (#126); once its fill has
 * ended without it, "stopped"; or, with no Answer, a "!" and why ("not
 * found", "not checked: cost cap"…), the provider's own words in its tooltip.
 */
export const comparisonCellView: NodeViewRenderer = ({ node: first, getPos, view }) => {
  let node: ProseMirrorNode = first;
  const dom = document.createElement("div");
  dom.className = "comparison-cell";
  dom.setAttribute("role", "cell");
  dom.dataset.testid = "comparison-cell";
  const contentDOM = document.createElement("div");
  contentDOM.className = "comparison-cell-content";
  contentDOM.contentEditable = "false";
  const stale = document.createElement("div");
  stale.className = "comparison-cell-stale";
  stale.contentEditable = "false";
  stale.setAttribute("aria-hidden", "true");
  const running = document.createElement("span");
  running.className = "comparison-cell-running";
  const reading = document.createElement("span");
  reading.className = "comparison-cell-reading";
  const stopped = document.createElement("span");
  stopped.className = "comparison-cell-stopped";
  const problem = document.createElement("span");
  problem.className = "comparison-cell-problem";
  problem.dataset.testid = "comparison-cell-problem";
  const mark = document.createElement("span");
  mark.className = "comparison-cell-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "!";
  const reason = document.createElement("span");
  problem.append(mark, reason);
  for (const each of [running, reading, stopped, problem]) each.contentEditable = "false";
  dom.append(contentDOM, stale, running, reading, stopped, problem);

  const columnAndRow = (): { tableId: string; documentId: string } | null => {
    const pos = getPos();
    if (typeof pos !== "number") return null;
    const state = view.state;
    if (pos < 0 || pos > state.doc.content.size) return null;
    const at = state.doc.resolve(pos);
    let tableId = "";
    let documentId = "";
    for (let depth = at.depth; depth > 0; depth--) {
      const ancestor = at.node(depth);
      if (!documentId && ancestor.type.name === COMPARISON_ROW_NODE) {
        documentId = String(ancestor.attrs.documentId ?? "");
      }
      if (!tableId && ancestor.type.name === COMPARISON_TABLE_NODE) {
        tableId = String(ancestor.attrs.id ?? "");
      }
    }
    return tableId && documentId ? { tableId, documentId } : null;
  };

  const hasWords = () => node.content.size > 2;

  const drawStale = (status: string): void => {
    const column = columnAndRow();
    const key = column
      ? staleAnswerKey(column.tableId, column.documentId, String(node.attrs.questionId ?? ""))
      : null;
    const kept = key ? useComparisonColumns.getState().stale[key] : undefined;
    const showing =
      kept !== undefined && !hasWords() && (status === "waiting" || status === "writing");
    stale.textContent = showing ? kept : "";
    dom.dataset.stale = showing ? "true" : "false";
    // The new Answer, or why there is none, has landed: the old one is no longer shown.
    if (key && kept !== undefined && !showing && status !== "waiting") {
      useComparisonColumns.getState().forgetStale(key);
    }
  };

  const draw = () => {
    const cell = comparisonCellOf(node.attrs);
    // Which column it is: the table draws its cells in the Questions' order.
    dom.dataset.questionId = cell.questionId;
    dom.dataset.status = cell.status;
    if (cell.status === "writing") {
      dom.setAttribute("aria-busy", "true");
      if (hasWords()) dom.dataset.streaming = "true";
      else delete dom.dataset.streaming;
    } else {
      dom.removeAttribute("aria-busy");
      delete dom.dataset.streaming;
    }
    if (cell.problem) dom.dataset.problem = cell.problem;
    else delete dom.dataset.problem;
    running.setAttribute(
      "aria-label",
      translateNow(
        cell.status === "writing" ? "comparison.cell.writing" : "comparison.cell.waiting",
      ),
    );
    running.textContent = translateNow("comparison.cell.waitingText");
    reading.textContent = translateNow("comparison.cell.readingText");
    stopped.textContent = translateNow("comparison.cell.stopped");
    if (cell.problem) {
      const { key, params } = cellProblemMessage(cell.problem, cell.message);
      reason.textContent = translateNow(key, params);
    } else reason.textContent = "";
    problem.title = cell.message ?? "";
    drawStale(cell.status);
  };
  draw();
  const unsubscribe = useAppStore.subscribe((state, before) => {
    if (state.settings !== before.settings) draw();
  });
  const unsubscribeStale = useComparisonColumns.subscribe((state, before) => {
    if (state.stale !== before.stale) drawStale(comparisonCellOf(node.attrs).status);
  });

  return {
    dom,
    contentDOM,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      draw();
      return true;
    },
    ignoreMutation: ownDrawing(contentDOM),
    destroy() {
      unsubscribe();
      unsubscribeStale();
    },
  };
};
