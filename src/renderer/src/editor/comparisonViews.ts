import type { NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { cellProblemMessage, comparisonCellOf } from "../../../shared/comparisons";
import { translateNow } from "../i18n";
import { useAppStore } from "../store";

/** Mutations outside a view's content are its own drawing, never the User's typing. */
const ownDrawing = (contentDOM: HTMLElement) => (mutation: { target: Node; type: string }) =>
  mutation.type !== "selection" && !contentDOM.contains(mutation.target);

/** The live Document a row is, or null once it was deleted. */
const liveDocument = (documentId: unknown) =>
  useAppStore.getState().documents.find((document) => document.id === documentId) ?? null;

/**
 * A comparison table's row (#98): its Document's name, sticky as the table
 * scrolls sideways, then its cells. A deleted Document's row says its
 * source was removed.
 */
export const comparisonRowView: NodeViewRenderer = ({ node: first }) => {
  let node: ProseMirrorNode = first;
  const dom = document.createElement("div");
  dom.className = "comparison-row";
  dom.setAttribute("role", "row");
  dom.dataset.testid = "comparison-row";
  const head = document.createElement("div");
  head.className = "comparison-document";
  head.setAttribute("role", "rowheader");
  head.contentEditable = "false";
  const name = document.createElement("span");
  name.className = "comparison-document-name";
  const removed = document.createElement("span");
  removed.className = "comparison-document-removed";
  removed.dataset.testid = "comparison-source-removed";
  head.append(name, removed);
  const contentDOM = document.createElement("div");
  contentDOM.className = "comparison-row-cells";
  dom.append(head, contentDOM);

  const draw = () => {
    const live = liveDocument(node.attrs.documentId);
    const shown = live?.name ?? String(node.attrs.documentName ?? "");
    name.textContent = shown;
    name.title = shown;
    removed.textContent = live ? "" : translateNow("comparison.cell.sourceRemoved");
    removed.hidden = live !== null;
    dom.dataset.removed = live ? "false" : "true";
  };
  draw();
  const unsubscribe = useAppStore.subscribe((state, before) => {
    if (state.documents !== before.documents || state.settings !== before.settings) draw();
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
    destroy: unsubscribe,
  };
};

/**
 * A comparison table's cell: its Answer, Citations and all, never typed in;
 * "Waiting…" until its turn, "Reading…" once it is being written, then its
 * words as they arrive, its Task going or paused (#126); once its fill has
 * ended without it, "stopped"; or, with no Answer, a "!" and why ("not
 * found", "not checked: cost cap"…), the provider's own words in its tooltip.
 */
export const comparisonCellView: NodeViewRenderer = ({ node: first }) => {
  let node: ProseMirrorNode = first;
  const dom = document.createElement("div");
  dom.className = "comparison-cell";
  dom.setAttribute("role", "cell");
  dom.dataset.testid = "comparison-cell";
  const contentDOM = document.createElement("div");
  contentDOM.className = "comparison-cell-content";
  contentDOM.contentEditable = "false";
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
  dom.append(contentDOM, running, reading, stopped, problem);

  const draw = () => {
    const cell = comparisonCellOf(node.attrs);
    dom.dataset.status = cell.status;
    if (cell.status === "writing") {
      dom.setAttribute("aria-busy", "true");
      if (node.textContent.trim() !== "") dom.dataset.streaming = "true";
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
  };
  draw();
  const unsubscribe = useAppStore.subscribe((state, before) => {
    if (state.settings !== before.settings) draw();
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
    destroy: unsubscribe,
  };
};
