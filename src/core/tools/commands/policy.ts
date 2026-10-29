/**
 * Whether a command the assistant runs asks the User first (#1110, #1421, ADR-0013): decided here
 * alone, from what the command's entry says it does and what the check found, never by the
 * command's own code. It runs at once only when it changes a few things inside IncarnaMind,
 * which Undo takes back, acts on the window in front, or saves a file in the Output location
 * itself. Everything else asks, with Allow or Don't allow and never "always":
 * - a file saved anywhere else, a folder's files read, and a new Output location;
 * - every delete, whatever the Answer read: a web page's title or a Document's text could ask for it;
 * - a command of the window's that can't be taken back;
 * - one that can turn on the microphone or the computer's sound, whoever asked for it: a
 *   Document's text could; and one that stops a recording once the Answer has read text the User
 *   didn't write, a Document or the live Transcript, where a participant could ask for it;
 * - a change that would take the Answer's changes past `COMMAND_AT_ONCE`.
 * One that is the User's alone never asks: it runs nothing.
 */

import { runsByDefault } from "../../../shared/approvalRules";
import {
  COMMAND_AT_ONCE,
  type CommandAsk,
  type CommandItem,
  type ConversationMessage,
} from "../../api";
import type { CheckedCommand } from "./run";

/** How many of the things a change would make the approval names. */
const NAMES_SHOWN = 50;

/** A rename the assistant's commands made in the Conversation. */
export interface CommandRename {
  id: string;
  from: string;
  to: string;
}

export interface CommandContext {
  /** How many things the Answer's commands changed without asking, since the User last allowed more. */
  changed: number;
  /** The Conversation's renames, oldest first: the names the User knew before them. */
  renames: readonly CommandRename[];
  /** The Answer has read text the User didn't write: a Document, a web page or the live Transcript. */
  read: boolean;
}

/** The renames the commands of a Conversation's Answers made, oldest first, from what each call returned. */
export const renamesIn = (messages: readonly ConversationMessage[]): CommandRename[] =>
  messages.flatMap((message) =>
    message.kind === "answer"
      ? message.toolCalls.flatMap((call) => renamesOf(call.command?.items ?? []))
      : [],
  );

export const renamesOf = (items: readonly CommandItem[]): CommandRename[] =>
  items.flatMap((item) =>
    item.renamed === undefined ? [] : [{ id: item.id, from: item.name, to: item.renamed }],
  );

/** What the User is asked before the call runs; null: it runs at once. */
export function askOf(checked: CheckedCommand, context: CommandContext): CommandAsk | null {
  const { command } = checked;
  if (checked.yours) return null;
  if (checked.outside) return checked.outside;
  const items = () =>
    checked.items.slice(0, NAMES_SHOWN).map((item) => asKnown(item, context.renames));
  if (checked.recording === "starts" || (checked.recording === "ends" && context.read)) {
    return { kind: "listen", command };
  }
  if (checked.final) return { kind: "final", command, items: items() };
  const reason = checked.deletes
    ? "delete"
    : checked.changes && context.changed + checked.items.length > COMMAND_AT_ONCE
      ? "many"
      : null;
  if (reason) {
    return {
      kind: "change",
      command,
      reason,
      count: checked.items.length,
      items: items(),
      into: checked.into,
      changed: context.changed,
    };
  }
  // Nothing outside to show, and only an in-app change or the Output location runs at once.
  if (checked.effects.every(runsByDefault)) return null;
  throw new Error(`${checked.command} would do what nothing can ask the User about.`);
}

/**
 * An item by the name the User knew before the Conversation's renames, followed back from its
 * name now: a rename taken back since, by Undo or by the User, breaks the chain there.
 */
function asKnown(item: CommandItem, renames: readonly CommandRename[]): CommandItem {
  let known = item.name;
  for (const rename of [...renames].reverse()) {
    if (rename.id === item.id && rename.to === known) known = rename.from;
  }
  return known === item.name ? item : { ...item, name: known, renamed: item.name };
}
