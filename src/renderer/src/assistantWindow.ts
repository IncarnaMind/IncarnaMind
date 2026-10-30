/**
 * The window's side of the assistant's commands (#1421). With each Question it offers the
 * assistant its command list, as ⌘K offers it now: every command but those the assistant never
 * runs, those of the User's alone named so it can say where they are, each with what it acts on,
 * whether it deletes and whether it can be taken back. Asked to run one, it runs it as ⌘K does, on
 * what the assistant found, and says how it went; what it changed goes with the Answer's other
 * changes, as one Undo.
 */
import type { WindowCommandEnd, WindowCommandRequest } from "../../core/api";
import { COMMAND_TARGETS, type CommandTarget, type OfferedCommand } from "../../shared/commands";
import { type MessageKey, translate } from "../../shared/i18n";
import { mindName } from "../../shared/naming";
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
import { useAppStore } from "./store";
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
    final: command.reversible !== true && command.recording !== "ends",
    recording: command.recording ?? null,
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
function contextFor(command: Command, { targets, mindId }: WindowCommandRequest): CommandContext {
  if (!command.appliesTo) return { ...inFront(mindId), checked: targets };
  const [one] = targets;
  if (!one) return inFront(mindId);
  return targets.length === 1
    ? { selection: [], focus: one, surface: "palette" }
    : { selection: targets, focus: null, surface: "palette" };
}

/** How a command the assistant asked for ended: why it didn't, or the change it made, for the Undo. */
export interface AssistantRunEnd {
  result: WindowCommandEnd;
  change: Undoable | undefined;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why ⌘K offers a command but not now, as the assistant's card says it with the Note's name. */
const NAMED_REASONS: Partial<Record<MessageKey, MessageKey>> = {
  "mindCheck.alreadyChecking": "commands.window.alreadyChecking",
};

/** The name of the Note a command acts on, by the Note's own name; null for none. */
function noteOf(ctx: CommandContext): string | null {
  if (ctx.focus?.kind !== "mind") return null;
  const id = ctx.focus.id;
  const mind = useAppStore.getState().minds.find((each) => each.id === id);
  return mind ? mindName(mind) : null;
}

/**
 * Starts a command the assistant asked for, as ⌘K runs it: whether it started, and how it ends,
 * with the change it made, for the Answer's Undo, and why it didn't run, in English for the model
 * and in the interface's words for the card. A Check, or a recording waiting for the system's
 * microphone permission, has started while it goes on.
 */
export function startForAssistant(request: WindowCommandRequest): {
  started: boolean;
  ended: Promise<AssistantRunEnd>;
} {
  const refused = (result: WindowCommandEnd) => ({
    started: false,
    ended: Promise.resolve({ result, change: undefined }),
  });
  const command = commands.get(request.command);
  if (!command || command.assistant === false || command.assistant?.never) {
    return refused({
      ran: false,
      why: `The window has no command ${request.command} the assistant may run.`,
      wording: null,
    });
  }
  const ctx = contextFor(command, request);
  const label = labelOf(command, ctx, english);
  let tried: ReturnType<typeof commands.start>;
  try {
    tried = commands.start(request.command, ctx);
  } catch (error) {
    return refused({ ran: false, why: messageOf(error), wording: null });
  }
  if (!tried.ran) {
    const named = tried.why === "not-offered" ? undefined : NAMED_REASONS[tried.why];
    const note = noteOf(ctx);
    const wording: Extract<WindowCommandEnd, { ran: false }>["wording"] =
      tried.why === "not-offered"
        ? {
            key: "commands.window.notOffered" as const,
            values: { command: labelOf(command, ctx, translateNow) },
          }
        : named && note !== null
          ? { key: named, values: { name: note } }
          : { key: tried.why };
    const why =
      tried.why === "not-offered"
        ? `“${label}” doesn't apply here now, so it didn't run.`
        : `“${label}” can't run now: ${english(tried.why)}`;
    return refused({ ran: false, why, wording });
  }
  return {
    started: true,
    ended: tried.change.then(
      (change) => ({ result: { ran: true, changed: change !== undefined }, change }),
      (error: unknown) => ({
        result: { ran: false, why: messageOf(error), wording: null },
        change: undefined,
      }),
    ),
  };
}
