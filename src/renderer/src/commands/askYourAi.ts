import { agentsToAsk, askAgent, noModel } from "../askYourAi";
import { fixesFree } from "../checks";
import {
  openNoteHistory,
  startNewConversation,
  useNoteColumns,
  useNoteConversations,
} from "../noteConversations";
import {
  backgroundAgentNow,
  focusNoteAsk,
  isGoing,
  noteAskShownNow,
  useNoteAsks,
} from "../ownAiInNote";
import { useRequests } from "../requests";
import { askableAt, askedSentenceOf, askedSentences } from "../unsupportedFixes";
import { noteHandle } from "./handles";
import type { Command } from "./registry";

/*
 * Ask your AI (#3373) from ⌘K: the card's Ask {agent} on the sentence at the caret, one request to
 * fix every sentence of the Note that needs a look (#3419), and, with no model set up, a request
 * that names the Note, for the agent connected or used last. Each hands the User's own AI a request
 * to send; none changes the Note, and the assistant runs none.
 */

function withAskableSentence() {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed || !fixesFree(note.mindId)) return null;
  const claim = askableAt(note.editor);
  const [agent] = agentsToAsk(note.mindId);
  return claim && agent ? { ...note, claim, agent } : null;
}

/** The Note in front with two or more sentences that need a look, and the agent to ask. */
function withSentencesToAsk() {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed || !fixesFree(note.mindId)) return null;
  const [agent] = agentsToAsk(note.mindId);
  const sentences = agent ? askedSentences(note.editor) : [];
  return agent && sentences.length >= 2 ? { mindId: note.mindId, agent, sentences } : null;
}

function withNoteToAsk() {
  const note = noteHandle.current;
  const [agent] = note ? agentsToAsk(note.mindId) : [];
  return note && agent && noModel() ? { mindId: note.mindId, agent } : null;
}

export const askYourAiCommands: readonly Command[] = [
  {
    id: "check.askAgent",
    label: "agents.ask.fixCommand",
    group: "main",
    reversible: true,
    assistant: false,
    when: () => withAskableSentence() !== null,
    run() {
      const at = withAskableSentence();
      const sentence = at && askedSentenceOf(at.editor, at.claim);
      if (at && sentence)
        void askAgent(at.agent, at.mindId, { kind: "fix", sentences: [sentence] });
    },
  },
  {
    id: "check.askAgentAll",
    label: "agents.ask.fixAllCommand",
    group: "main",
    reversible: true,
    assistant: false,
    when: () => withSentencesToAsk() !== null,
    run() {
      const at = withSentencesToAsk();
      if (at) void askAgent(at.agent, at.mindId, { kind: "fix", sentences: at.sentences });
    },
  },
  {
    id: "mind.askInNote",
    label: "noteAsk.command",
    group: "main",
    reversible: true,
    assistant: false,
    when: () => {
      const mindId = noteHandle.current?.mindId;
      return mindId !== undefined && noteAskShownNow(mindId);
    },
    run() {
      const mindId = noteHandle.current?.mindId;
      if (mindId !== undefined) focusNoteAsk(mindId);
    },
  },
  {
    id: "mind.noteConversationHistory",
    label: "noteColumn.historyCommand",
    group: "main",
    reversible: true,
    assistant: false,
    when: () => {
      const mindId = noteHandle.current?.mindId;
      return mindId !== undefined && noteAskShownNow(mindId);
    },
    run() {
      openNoteHistory();
    },
  },
  {
    id: "mind.newNoteConversation",
    label: "noteColumn.newCommand",
    group: "main",
    reversible: true,
    assistant: false,
    when: () => {
      const mindId = noteHandle.current?.mindId;
      if (mindId === undefined || !noteAskShownNow(mindId)) return false;
      const agent = backgroundAgentNow(mindId);
      if (!agent) return false;
      const activeId = useNoteColumns.getState().activeByPairing[agent.id] ?? null;
      const ask = activeId ? useNoteAsks.getState().byConversation[activeId] : undefined;
      return !isGoing(ask);
    },
    run() {
      const mindId = noteHandle.current?.mindId;
      if (mindId === undefined) return;
      const agent = backgroundAgentNow(mindId);
      if (!agent) return;
      startNewConversation(agent.id);
      requestAnimationFrame(() => focusNoteAsk(mindId));
    },
  },
  {
    id: "mind.deleteNoteConversation",
    label: "noteColumn.deleteCommand",
    group: "danger",
    destructive: true,
    assistant: { never: "permanent" },
    reversible: { confirm: "noteColumn.delete.body" },
    when: () => {
      const mindId = noteHandle.current?.mindId;
      if (mindId === undefined || !noteAskShownNow(mindId)) return false;
      const agent = backgroundAgentNow(mindId);
      const activeId = agent ? (useNoteColumns.getState().activeByPairing[agent.id] ?? null) : null;
      return Boolean(
        activeId && useNoteConversations.getState().list.some((each) => each.id === activeId),
      );
    },
    run() {
      const mindId = noteHandle.current?.mindId;
      if (mindId === undefined) return;
      const agent = backgroundAgentNow(mindId);
      const activeId = agent ? (useNoteColumns.getState().activeByPairing[agent.id] ?? null) : null;
      const summary = activeId
        ? useNoteConversations.getState().list.find((each) => each.id === activeId)
        : undefined;
      if (summary) useRequests.getState().ask({ deleteNoteConversation: summary });
    },
  },
  {
    id: "mind.askAgent",
    label: "agents.ask.noteCommand",
    group: "main",
    reversible: true,
    assistant: false,
    when: () => withNoteToAsk() !== null,
    run() {
      const at = withNoteToAsk();
      if (at) void askAgent(at.agent, at.mindId, { kind: "note" });
    },
  },
];
