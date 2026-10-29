/**
 * The commands of the window's list (#1421): the window whose Question asked runs each as ⌘K
 * runs it, on what the assistant found (none: the window in front), and says how it went. What
 * it changed is the window's to take back with the Run's other changes. One that is the User's
 * alone runs nothing.
 */
import type { CommandId, CommandTarget, OfferedCommand, Yours } from "../../../shared/commands";
import type { CommandItem } from "../../api";
import { InvalidInputError, NotFoundError, TranslatableError } from "../../errors";
import type { Findable } from "./find";
import { all } from "./find";
import { type CheckedCommand, type CommandsHost, IN_APP } from "./run";

/** What the model is told of a request for what only the User changes, and where they change it. */
export const YOURS_SAID: Readonly<Record<Yours, string>> = {
  keys: "Keys and sign-ins are the User's to change, never yours. They're in Settings › Models.",
  privacy:
    "Keeping everything on this computer (Local mode), consent, privacy and what leaves the computer are the User's to change, never yours. They're in Settings › Privacy.",
  approvals:
    "What you may do without asking is the User's to change, never yours. It's in Settings › Privacy.",
  spending:
    "The monthly spending cap is the User's to change, never yours. It's in Settings › General.",
  permanent:
    "Deleting for good is the User's to do, never yours: it can't be undone. Recently deleted keeps what's deleted for 30 days.",
};

/** A refusal: nothing runs, and the card under the reply says where the User changes it. */
export const yoursChecked = (command: CommandId, yours: Yours): CheckedCommand => ({
  command,
  effects: [],
  items: [],
  into: null,
  outside: null,
  changes: false,
  deletes: false,
  final: false,
  yours,
  run: async () => ({ done: { items: [], yours }, step: null, said: YOURS_SAID[yours] }),
});

export interface WindowRun {
  answerId: string;
  runId: string;
  toolCallId: string;
}

function targetsOf(
  entry: OfferedCommand,
  ids: readonly string[],
  findable: Findable,
): CommandItem[] {
  const kinds: readonly CommandTarget[] = entry.on ?? [];
  if (kinds.length === 0) return [];
  if (ids.length === 0) throw new InvalidInputError({ key: "error.commands.noIds" });
  const known = kinds.flatMap((kind) => all(kind, findable));
  return [...new Set(ids)].map((id) => {
    const found = known.find((each) => each.id === id);
    if (!found) throw new NotFoundError({ key: "error.commands.noTarget", values: { id } });
    return { kind: found.kind, id: found.id, name: found.name };
  });
}

/** Checks a call of a window command: what it acts on, and what its entry says it does. */
export function windowChecked(
  entry: OfferedCommand,
  ids: readonly string[],
  findable: Findable,
  context: WindowRun,
  window: CommandsHost["window"],
): CheckedCommand {
  if (entry.yours) return yoursChecked(entry.id, entry.yours);
  const items = targetsOf(entry, ids, findable);
  const on = items.length === 0 ? "" : ` on ${items.map((each) => `“${each.name}”`).join(", ")}`;
  return {
    command: entry.id,
    effects: IN_APP,
    items,
    into: null,
    outside: null,
    changes: entry.on !== null,
    deletes: entry.deletes,
    final: entry.final,
    yours: null,
    async run(_asking, signal) {
      if (!window) throw new InvalidInputError({ key: "error.commands.noWindow" });
      const result = await window(
        {
          answerId: context.answerId,
          toolCallId: context.toolCallId,
          run: context.runId,
          command: entry.id,
          targets: items.map(({ kind, id }) => ({ kind, id })),
        },
        signal,
      );
      if (!result.ran) throw new TranslatableError(result.wording ?? result.why);
      return {
        done: { items, window: { changed: result.changed } },
        step: null,
        said: `Ran “${entry.label}”${on} in the User's window${result.changed ? "; the User can undo it" : ""}.`,
      };
    },
  };
}
