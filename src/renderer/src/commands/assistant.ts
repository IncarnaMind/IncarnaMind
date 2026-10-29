import type { AssistantDock, ConversationAnswer } from "../../../core/api";
import { answerBlocks, hasText } from "../../../shared/answerBlocks";
import type { MessageKey } from "../../../shared/i18n";
import { addAnswer } from "../addToNote";
import { copyAnswer, notesToAdd } from "../answerEditors";
import { useAnswers } from "../answers";
import { shownDock } from "../assistantPlace";
import { useComposer } from "../composer";
import {
  answerBeingWritten,
  clearConversation,
  conversationById,
  lastAnswer,
  regenerateAnswer,
  startNewChat,
  stopReadyAsk,
  stopWriting,
  useConversations,
  useReadyAsk,
} from "../conversations";
import { requestEditField } from "../editor/selectionCommands";
import { startEditing } from "../editWithAi";
import { billingUrlOfProvider, keyProviderOf, useKeyRefusals } from "../keyRefusals";
import { assistantTabOf, groupsMerged } from "../layoutSlice";
import { exampleMindIds, useAppStore } from "../store";
import { assistantHandle, noteHandle, viewerSelectionHandle } from "./handles";
import type { Command } from "./registry";

/*
 * The assistant's commands (#253, #201): where it sits, folding it, ⌘J to its
 * composer, New chat and History; adding, copying, regenerating and stopping
 * an Answer, writing the last Answer as a note, and clearing the conversation.
 * Its ⋯ menu, its header and rail, its Answers' buttons and ⌘K run these, so
 * each has a keyboard and a menu way beside the drag.
 */

const store = () => useAppStore.getState();
const isThere = () => assistantHandle.current !== null;
const folded = () => store().layout?.assistant.folded ?? false;

/** The dock commands, in the order the ⋯ menu lists them. */
export const DOCKS: readonly { dock: AssistantDock; label: MessageKey }[] = [
  { dock: "right", label: "assistant.dock.right" },
  { dock: "left", label: "assistant.dock.left" },
  { dock: "bottom", label: "assistant.dock.bottom" },
  { dock: "float", label: "assistant.dock.float" },
];

export const dockCommandId = (dock: AssistantDock) =>
  dock === "float" ? "assistant.float" : (`assistant.dock-${dock}` as const);

/**
 * Docks it, or floats it, unfolded. A side dock chosen in a narrow window is
 * kept for when it is wider; meanwhile a line says why it stays at the bottom.
 */
export function placeAt(dock: AssistantDock): Promise<void> {
  const place = store().layout?.assistant;
  // The same rule the Workbench draws it by: the notice says what the window shows.
  if (place && shownDock({ ...place, dock }, window.innerWidth) !== dock) {
    store().showTabNotice({ kind: "assistantNarrow" });
  }
  return store().placeAssistant({ dock, folded: false });
}

/** Puts the cursor in the composer, unfolding the assistant for it. */
export function focusComposer(): void {
  if (folded()) void store().placeAssistant({ folded: false });
  useComposer.getState().requestFocus();
}

/**
 * ⌘J: the assistant's composer. From a note with text selected in it, the
 * Edit with AI… field of the selection menu takes the cursor; where that menu
 * can't open (all of the Mind selected), the composer says what to change in
 * the selection. With words selected in a Document, it asks about them.
 */
function askOrEdit(): void {
  const viewer = viewerSelectionHandle.current;
  if (viewer?.ask) {
    viewer.ask();
    return;
  }
  const note = noteHandle.current;
  if (note && !note.editor.isDestroyed) {
    if (requestEditField(note.editor)) return;
    if (note.editor.view.hasFocus()) startEditing(note.editor, note.mindId);
  }
  focusComposer();
}

/** New chat: the assistant shows a new, empty conversation (an empty one is reused), ready to ask. */
export function newChat(): void {
  startNewChat();
  focusComposer();
}

/** The Answer an Answer's command acts on: the one the focus is in, else the newest. */
function answerInFocus(): ConversationAnswer | undefined {
  const active = document.activeElement;
  const id = active?.closest("[data-answer-id]")?.getAttribute("data-answer-id");
  const focused = useConversations
    .getState()
    .messages.find((each) => each.kind === "answer" && each.id === id);
  return focused?.kind === "answer" && focused.status !== "streaming" ? focused : lastAnswer();
}

/** Whether an Answer has something to keep: not one that failed before writing a word. */
const keepable = (answer: ConversationAnswer | undefined): answer is ConversationAnswer =>
  answer !== undefined && hasText(answerBlocks(answer));

const noAnswer = (): true | { reason: MessageKey } =>
  keepable(answerInFocus()) ? true : { reason: "assistant.writeNote.unavailable" };

function providerInFocus() {
  const providerId = answerInFocus()?.model?.providerId;
  return useAnswers.getState().models?.find((group) => group.provider.id === providerId)?.provider;
}

function creditInFocus() {
  const answer = answerInFocus();
  if (answer?.status !== "failed" || answer.errorKind !== "out-of-credit") return null;
  const url = billingUrlOfProvider(providerInFocus());
  return url ? { answer, url } : null;
}

/**
 * ⌘⇧A: adds the Answer in focus, or the newest, to the note in focus, as its
 * Add to note does; with no note in focus, or the example, its ▾ opens to
 * choose one.
 */
function addAnswerInFocus(): void {
  const answer = answerInFocus();
  if (!keepable(answer)) return;
  const item = assistantTabOf(store().layout, groupsMerged())?.item;
  if (item?.kind !== "mind" || exampleMindIds(store()).includes(item.mindId)) {
    if (folded()) void store().placeAssistant({ folded: false });
    document
      .querySelector<HTMLElement>(`[data-answer-id="${answer.id}"] [data-testid="answer-add-to"]`)
      ?.click();
    return;
  }
  const conversation = conversationById(answer.conversationId);
  void addAnswer(
    { answer, conversation, blocks: notesToAdd(answer) },
    {
      kind: "mind",
      mindId: item.mindId,
    },
  );
}

/** "Write as a note" under the Answer in focus, or the newest (#1940): it makes the note beside the Answer. */
function writeAsNote(): void {
  const answer = answerInFocus();
  if (!keepable(answer)) return;
  const conversation = conversationById(answer.conversationId);
  void addAnswer({ answer, conversation, blocks: notesToAdd(answer) }, { kind: "new" });
}

const conversationEmpty = (): true | { reason: MessageKey } =>
  useConversations.getState().messages.length > 0
    ? true
    : { reason: "assistant.clear.unavailable" };

export const assistantCommands: readonly Command[] = [
  ...DOCKS.map(
    ({ dock, label }): Command => ({
      id: dockCommandId(dock),
      label: (_ctx, t) => t("command.assistant.dock", { dock: t(label) }),
      group: "main",
      // Another place puts it back.
      reversible: true,
      when: isThere,
      run: () => placeAt(dock),
    }),
  ),
  {
    id: "assistant.fold",
    label: (_ctx, t) => t(folded() ? "command.assistant.unfold" : "command.assistant.fold"),
    group: "main",
    reversible: true,
    when: isThere,
    run: () => store().placeAssistant({ folded: !folded() }),
  },
  {
    // ⌘J, as in Cursor: the assistant's composer, wherever the User is.
    id: "composer.focus",
    label: "command.composer.focus",
    shortcut: { keys: "CmdOrCtrl+J" },
    group: "main",
    top: 10,
    reversible: true,
    when: isThere,
    run: askOrEdit,
  },
  {
    // The conversation it leaves stays in History (#258).
    id: "assistant.newChat",
    label: "assistant.newChat",
    shortcut: { keys: "CmdOrCtrl+Shift+O" },
    group: "main",
    reversible: true,
    when: isThere,
    run: newChat,
  },
  {
    id: "answer.addToNote",
    label: "command.answer.addToNote",
    shortcut: { keys: "CmdOrCtrl+Shift+A" },
    group: "main",
    // Undo, on its line under the Answer, or ⌘Z.
    reversible: true,
    when: isThere,
    enabled: noAnswer,
    run: addAnswerInFocus,
  },
  {
    // Not "answer.copy": that is the Copy in the menu of an Answer in a Mind written before.
    id: "assistant.copyAnswer",
    label: "command.answer.copy",
    shortcut: { keys: "CmdOrCtrl+Shift+C" },
    group: "edit",
    // Copying changes nothing.
    reversible: true,
    when: isThere,
    enabled: noAnswer,
    run: () => {
      const answer = answerInFocus();
      if (keepable(answer)) void copyAnswer(answer.id);
    },
  },
  {
    id: "assistant.regenerateAnswer",
    label: "command.answer.regenerate",
    group: "main",
    // As Regenerate in a Mind: the Answer is written again in its place.
    reversible: true,
    when: isThere,
    enabled: () => (answerInFocus() ? true : { reason: "assistant.writeNote.unavailable" }),
    run: () => {
      const answer = answerInFocus();
      if (answer) void regenerateAnswer(answer.id);
    },
  },
  {
    id: "answer.useAllDocuments",
    label: "command.answer.useAll",
    group: "main",
    // Its new text is one change in the Mind it wrote, which that Mind's Undo takes back.
    reversible: true,
    when: isThere,
    enabled: () =>
      answerInFocus()?.steps?.writtenFrom ? true : { reason: "command.answer.useAll.unavailable" },
    run: () => {
      const answer = answerInFocus();
      if (answer?.steps?.writtenFrom) void regenerateAnswer(answer.id, { clearScope: true });
    },
  },
  {
    // The composer's Stop, which its send button is while an Answer is written.
    id: "answer.stop",
    label: "command.answer.stop",
    group: "main",
    // What was written stays, and Regenerate writes it again.
    reversible: true,
    when: isThere,
    enabled: () =>
      answerBeingWritten() !== null ? true : { reason: "command.answer.stop.unavailable" },
    run: stopWriting,
  },
  {
    id: "ready.stop",
    label: "command.ready.stop",
    group: "main",
    // The Question stays, and can be asked again.
    reversible: true,
    when: () => useReadyAsk.getState().asking,
    run: stopReadyAsk,
  },
  {
    id: "assistant.writeNote",
    label: "assistant.writeNote",
    group: "main",
    // Filling the empty Mind in front is one step of its Undo; what a Mind it makes holds is too.
    reversible: true,
    when: isThere,
    enabled: noAnswer,
    run: writeAsNote,
  },
  {
    id: "answer.addCredit",
    label: "answer.error.addCredit",
    group: "main",
    reversible: true,
    when: () => isThere() && creditInFocus() !== null,
    run: () => {
      const credit = creditInFocus();
      if (!credit) return;
      useKeyRefusals.getState().openBilling(credit.answer.model?.providerId ?? null, credit.url);
    },
  },
  {
    id: "answer.useAnotherKey",
    label: "answer.error.useAnotherKey",
    group: "main",
    reversible: true,
    when: () =>
      isThere() &&
      keyProviderOf(providerInFocus()) !== null &&
      answerInFocus()?.errorKind === "out-of-credit",
    run: () => {
      const answer = answerInFocus();
      if (!answer) return;
      return useKeyRefusals
        .getState()
        .check(
          answer.model?.providerId ?? null,
          answer.model?.modelId ?? "",
          answer.updatedAt,
          "out-of-credit",
        );
    },
  },
  {
    id: "assistant.clear",
    label: "assistant.clear",
    group: "danger",
    // To Recently deleted, with Undo.
    reversible: true,
    when: isThere,
    enabled: conversationEmpty,
    run: () => clearConversation().catch(store().reportError),
  },
  {
    // No shortcut: ⌘Y, the browsers' History key on a Mac, is Redo on Windows.
    id: "assistant.history",
    label: "command.assistant.history",
    group: "open",
    reversible: true,
    when: isThere,
    run: () => assistantHandle.current?.openHistory(),
  },
];
