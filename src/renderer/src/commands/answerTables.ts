import type { ConversationAnswer } from "../../../core/api";
import type { NodeJSON } from "../../../shared/blockJson";
import { openTable } from "../addToNote";
import { answerTables, tableHolding } from "../answerEditors";
import { conversationById, lastAnswer, useConversations } from "../conversations";
import { usePalette } from "../palette";
import { useAppStore } from "../store";
import { assistantHandle } from "./handles";
import type { Command } from "./registry";

const MOST_LISTED = 4;

interface InView {
  answer: ConversationAnswer;
  tables: NodeJSON[];
  held: number | null;
}

function lookAt(active: Element | null): InView | null {
  // An Answer out of sight, in a folded assistant, never makes a note (#2291).
  if (useAppStore.getState().layout?.assistant.folded) return null;
  const id = active?.closest("[data-answer-id]")?.getAttribute("data-answer-id");
  const focused = useConversations
    .getState()
    .messages.find((each) => each.kind === "answer" && each.id === id);
  const answer = focused?.kind === "answer" ? focused : lastAnswer();
  if (!answer || answer.status === "streaming") return null;
  const tables = answerTables(answer.id);
  return tables.length > 0 ? { answer, tables, held: tableHolding(answer.id, active) } : null;
}

// ⌘K takes the focus into its field: what held it is read as it opens. A command runs in the
// task that closes it, so what was read stays until that task is over.
let atOpen: InView | null | undefined;
usePalette.subscribe((state, before) => {
  if (state.open && !before.open) {
    atOpen = typeof document === "undefined" ? null : lookAt(document.activeElement);
  } else if (!state.open && before.open) {
    queueMicrotask(() => {
      atOpen = undefined;
    });
  }
});

const inView = (): InView | null =>
  atOpen !== undefined
    ? atOpen
    : typeof document === "undefined"
      ? null
      : lookAt(document.activeElement);

const listed = (n: number): Command => ({
  id: n === 1 ? "answer.openTable" : `answer.openTable${n}`,
  assistant: false,
  label: (_ctx, t) => {
    const view = inView();
    return view && view.held === null && view.tables.length > 1
      ? t("answer.table.openNth", { n })
      : t("answer.table.open");
  },
  group: "open",
  // Undo, on its line under the Answer, deletes the Mind it made.
  reversible: true,
  when: () => {
    const view = inView();
    if (!view || assistantHandle.current === null) return false;
    return view.held !== null ? n === 1 : n <= Math.min(view.tables.length, MOST_LISTED);
  },
  run: () => {
    const view = inView();
    const table = view?.tables[view.held ?? n - 1];
    if (!view || !table) return;
    const { answer } = view;
    void openTable({
      answer,
      conversation: conversationById(answer.conversationId),
      blocks: [table],
    });
  },
});

export const answerTableCommands: readonly Command[] = Array.from(
  { length: MOST_LISTED },
  (_, at) => listed(at + 1),
);
