/**
 * The window's side of the assistant's commands (#1421). With each Question it offers the
 * assistant its command list, as ⌘K offers it now: every command but those the assistant never
 * runs, those of the User's alone named so it can say where they are, each with what it acts on,
 * whether it deletes and whether it can be taken back. Asked to run one, it runs it as ⌘K does, on
 * what the assistant found, and says how it went; what it changed goes with the Answer's other
 * changes, as one Undo.
 */
import type { WindowCommandRequest, WindowCommandResult } from "../../core/api";
import { COMMAND_TARGETS, type CommandTarget, type OfferedCommand } from "../../shared/commands";
import { translate } from "../../shared/i18n";
import {
  type Command,
  type CommandContext,
  commands,
  isEnabled,
  labelOf,
  offered,
} from "./commands/registry";
import { translateNow } from "./i18n";
import type { Translate } from "./objects";
import { objectInFront } from "./palette";
import type { Undoable } from "./undo";

const english: Translate = (key, params) => translate("en", key, params);

const isTarget = (kind: string): kind is CommandTarget =>
  COMMAND_TARGETS.some((each) => each === kind);

/**
 * Where the assistant's commands act with nothing found: the Note the Question was asked from,
 * else what the tab in front shows, as ⌘K does. "Check this Note" means that Note, even when a
 * Document opened beside it is in front.
 */
const inFront = (mindId: string | null): CommandContext => ({
  selection: [],
  focus: mindId ? { kind: "mind", id: mindId } : objectInFront(),
  surface: "palette",
});

/** What a command acts on that the assistant can find; null: the window. Empty: nothing it can. */
const targetsOf = (command: Command): CommandTarget[] | null =>
  command.appliesTo ? command.appliesTo.filter(isTarget) : null;

/** One entry of the list, as the assistant is offered it; null for one it isn't. */
function entryOf(command: Command, front: CommandContext): OfferedCommand | null {
  if (command.palette === false || command.assistant === false) return null;
  const yours = command.assistant?.never ?? null;
  const acts = targetsOf(command);
  // One of the User's alone is named whatever it acts on, so the assistant can say where it is.
  const on = yours && acts?.length === 0 ? null : acts;
  if (on !== null && on.length === 0) return null;
  // What acts on the window is offered as ⌘K offers it now; what acts on things, for each it finds.
  if (yours === null && on === null && !(offered(command, front) && isEnabled(command, front))) {
    return null;
  }
  return {
    id: command.id,
    label: labelOf(command, front, english),
    purpose: command.purpose ? english(command.purpose) : null,
    on,
    deletes: command.destructive === true && command.reversible === true,
    final: command.reversible !== true,
    yours,
  };
}

/** The window's commands the assistant may run now, for a Question asked here from `mindId`. */
export function offeredCommands(mindId: string | null): OfferedCommand[] {
  const front = inFront(mindId);
  return commands.all().flatMap((command) => {
    try {
      return entryOf(command, front) ?? [];
    } catch (error) {
      // One command that can't say its name now is left out; the Question still goes.
      console.error(`The command ${command.id} couldn't be offered to the assistant.`, error);
      return [];
    }
  });
}

/** Where a command the assistant runs acts: what it found, else as `inFront`. */
function contextFor({ targets, mindId }: WindowCommandRequest): CommandContext {
  const [one] = targets;
  if (!one) return inFront(mindId);
  return targets.length === 1
    ? { selection: [], focus: one, surface: "palette" }
    : { selection: targets, focus: null, surface: "palette" };
}

/**
 * Runs a command the assistant asked for, as ⌘K runs it, and says how it went: the change it
 * made, for the Answer's Undo, and why it didn't run, in English for the model and in the
 * interface's words for the card.
 */
export async function runForAssistant(
  request: WindowCommandRequest,
): Promise<{ result: WindowCommandResult; change: Undoable | undefined }> {
  const command = commands.get(request.command);
  if (!command || command.assistant === false || command.assistant?.never) {
    return {
      result: {
        ran: false,
        why: `The window has no command ${request.command} the assistant may run.`,
        wording: null,
      },
      change: undefined,
    };
  }
  const ctx = contextFor(request);
  const label = labelOf(command, ctx, english);
  try {
    const tried = await commands.attempt(request.command, ctx);
    if (tried.ran)
      return { result: { ran: true, changed: tried.change !== undefined }, change: tried.change };
    const wording =
      tried.why === "not-offered"
        ? {
            key: "commands.window.notOffered" as const,
            values: { command: labelOf(command, ctx, translateNow) },
          }
        : { key: tried.why };
    const why =
      tried.why === "not-offered"
        ? `“${label}” doesn't apply here now, so it didn't run.`
        : `“${label}” can't run now: ${english(tried.why)}`;
    return { result: { ran: false, why, wording }, change: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: { ran: false, why: message, wording: null }, change: undefined };
  }
}
