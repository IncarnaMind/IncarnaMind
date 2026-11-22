/**
 * A Note's selection handed to the User's own AI (#3612), for a User with only their own AI: the
 * selection menu's Explain, Improve writing, Shorten, Translate and Edit with AI… ask the AI the
 * Ask pill asks, with the selected words and the task, as one press of an Ask does. What it
 * changes comes back as changes that wait for the User; Explain's answer is its reply there.
 */
import type { AgentPairing, AskedSelection, SelectionAction } from "../../../core/api";
import { askAgent, askFirstAgent } from "../askYourAi";
import type { EditSelection } from "./editSelection";

/** The words last handed over from each Note, and the Block the line about them stands at. */
const handed = new Map<string, { blockId: string | null; ask: AskedSelection }>();

export const handedSelectionIn = (mindId: string) => handed.get(mindId) ?? null;

/**
 * Asks the User's own AI to do `action` with `selection`, in the Note `mindId`: "none" when no AI
 * of theirs can read the Note.
 */
export function handSelectionToOwnAi(
  selection: EditSelection,
  mindId: string,
  action: Exclude<SelectionAction, "ask">,
  { language, instruction }: { language?: string; instruction?: string } = {},
): ReturnType<typeof askFirstAgent> {
  const ask: AskedSelection = {
    kind: "selection",
    action,
    text: selection.text,
    ...(language && { language }),
    ...(instruction?.trim() && { instruction: instruction.trim() }),
  };
  handed.set(mindId, { blockId: selection.from.blockId, ask });
  return askFirstAgent(mindId, ask);
}

/** The line's Continue in the open chat: the same words, copied for the chat the User has open (#3588). */
export function continueInOpenChat(mindId: string, agent: AgentPairing): void {
  const kept = handed.get(mindId);
  if (kept) void askAgent(agent, mindId, kept.ask, undefined, { openChat: true });
}
