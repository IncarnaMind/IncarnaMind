/**
 * Whether a command the assistant runs asks the User first (#1110, ADR-0013): decided here
 * alone, from what its entry in `ASSISTANT_COMMANDS` says it does and what the check found, never
 * by the command's own code. It runs at once only when it changes a few things inside
 * IncarnaMind, which Undo takes back, or saves a file in the Output location itself.
 * Everything else asks, with Allow or Don't allow and never "always":
 * - a file saved anywhere else, and a folder's files read;
 * - every delete, whatever the Answer read: a web page's title or a Document's text could ask for it;
 * - a change that would take the Answer's changes past `COMMAND_AT_ONCE`.
 */

import { runsByDefault } from "../../../shared/approvalRules";
import { ASSISTANT_COMMANDS, isAppCommand } from "../../../shared/commands";
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
  const { does, deletes } = ASSISTANT_COMMANDS[command];
  if (checked.outside) return checked.outside;
  if (isAppCommand(command)) {
    const reason = deletes
      ? "delete"
      : context.changed + checked.items.length > COMMAND_AT_ONCE
        ? "many"
        : null;
    if (reason) {
      return {
        kind: "change",
        command,
        reason,
        count: checked.items.length,
        items: checked.items.slice(0, NAMES_SHOWN).map((item) => asKnown(item, context.renames)),
        into: checked.into,
        changed: context.changed,
      };
    }
  }
  // Nothing outside to show, and only an in-app change or the Output location runs at once.
  if ((does === "app" || does === "export") && checked.effects.every(runsByDefault)) return null;
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
