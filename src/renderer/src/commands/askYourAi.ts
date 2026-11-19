import { comparableSentence } from "../../../shared/sentences";
import { agentsToAsk, askAgent, noModel } from "../askYourAi";
import { fixesFree } from "../checks";
import { askableAt, askVerdictOf, sentenceOf } from "../unsupportedFixes";
import { noteHandle } from "./handles";
import type { Command } from "./registry";

/*
 * Ask your AI (#3373) from ⌘K: the card's Ask {agent} on the sentence at the caret, and, with no
 * model set up, a request that names the Note, for the agent connected or used last. Each hands the
 * User's own AI a request to send; neither changes the Note, and the assistant runs neither.
 */

function withAskableSentence() {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed || !fixesFree(note.mindId)) return null;
  const claim = askableAt(note.editor);
  const [agent] = agentsToAsk(note.mindId);
  return claim && agent ? { ...note, claim, agent } : null;
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
      if (!at) return;
      const verdict = askVerdictOf(at.editor, at.claim);
      const sentence = comparableSentence(sentenceOf(at.editor, at.claim));
      if (verdict && sentence) {
        void askAgent(at.agent, at.mindId, { kind: "fix", sentence, verdict });
      }
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
