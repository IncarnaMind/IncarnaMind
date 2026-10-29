import type { ComponentType } from "react";
import type { EditMenuState } from "../../../shared/bridge";
import {
  type CommandId,
  type Keys,
  MENU_COMMANDS,
  type MenuCommandId,
  type ShortcutKeys,
} from "../../../shared/commands";
import type { MessageKey } from "../../../shared/i18n";
import type { ObjectKind, ObjectRef, Translate, Undoable } from "../objects";
import { useUndo } from "../undo";
import { checkKeys } from "./keys";

/** Where the User is acting, as `data-surface` marks it on the page. */
export const SURFACES = [
  "sidebar",
  "library",
  "deleted",
  "home",
  "mind",
  "viewer",
  "palette",
] as const;
export type Surface = (typeof SURFACES)[number];

/** The menus' order of commands (docs/agents/interaction.md, rule 5). */
export const COMMAND_GROUPS = ["open", "main", "move", "tags", "edit", "file", "danger"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface Shortcut {
  keys: ShortcutKeys;
  /**
   * A list's own keys (⌘⌫, Enter, F2, Space): they act only while the focus
   * is in a list, and never while the User types. Other shortcuts act
   * anywhere in the window.
   */
  list?: true;
  /**
   * Keys the User also types with (⌘⌫ deletes to the line's start), which the
   * command takes only where its `when` holds in the note: ⌘⌫ rejects the
   * change the cursor is in, and deletes as ever anywhere else. Such a
   * command acts on a Block (`appliesTo`) and says where it applies (`when`).
   */
  inText?: true;
  /**
   * Keys the User also types with (⌘Z), which the command takes only while the
   * focus isn't in text: there they keep their meaning, the text's own undo.
   */
  outsideText?: true;
  /**
   * Keys that do nothing while the focus is in text, so a picker never opens over what the User
   * is typing; the key is still taken, so the menu doesn't run it on macOS. Unlike `outsideText`,
   * the menu item and ⌘K run the command from anywhere.
   */
  notInText?: true;
  /** The same command's second keys on Windows and Linux: Ctrl+Y redoes there, as Ctrl+Shift+Z does. */
  alsoOther?: Keys;
  /** More keys that run it too but that nothing shows: ⌘N still makes a Mind, though ⌘T is the one shown. */
  also?: Keys;
  /** Keys only macOS has (Finder's ⌃⌘N): elsewhere the command has none, and stays in menus and ⌘K. */
  macOnly?: true;
  /**
   * The command with the same keys that takes them first where it applies:
   * ⌘↵ accepts the waiting change the cursor is in, and inserts a page break
   * anywhere else.
   */
  yields?: CommandId;
}

export interface CommandContext {
  selection: readonly ObjectRef[];
  focus: ObjectRef | null;
  surface: Surface;
  /**
   * The Task whose block or row held the focus when this context was made;
   * null when none did. ⌘K's field holds the focus once the palette is open,
   * so a command chosen there acts on this Task rather than on another.
   */
  task?: string | null;
  /**
   * Where ⌘Z would act when ⌘K opened: the note's own history, a field's, or
   * the app's changes (null). ⌘K holds the focus in its field, so Undo reads
   * where the User was rather than where the palette is.
   */
  place?: EditMenuState["text"];
  /**
   * What only the place that shows the object can do, by command: renaming
   * in the row's own field, or opening a Citation's card. A command that needs
   * one is offered only where the menu was given it (`needsHere`).
   */
  here?: Partial<Record<CommandId, () => void>>;
}

export interface Command {
  id: CommandId;
  label: MessageKey | ((ctx: CommandContext, t: Translate) => string);
  /** Shorter than `label`, in the menu of the object it acts on, which says what it acts on. */
  menuLabel?: Command["label"];
  keywords?: readonly MessageKey[];
  /** One line under its name in ⌘K, for a command whose name alone doesn't say what it is for. */
  purpose?: MessageKey;
  /** What the menu says of it in a tooltip, where its label alone doesn't. */
  hint?: MessageKey;
  icon?: ComponentType<{ className?: string }>;
  shortcut?: Shortcut;
  /** Keys the row binds itself (Enter or F2 renames, ⇧⌘M moves), shown in menus; #224 and #225 make them shortcuts. */
  rowKeys?: ShortcutKeys;
  /**
   * A global shortcut the main process holds for it while a meeting records, as this
   * system writes it; the window never binds it. Null: none.
   */
  globalKeys?(): string | null;
  /** False keeps it out of ⌘K; it then needs a shortcut. */
  palette?: false;
  /** Listed in ⌘K before anything is typed, where it applies, the lowest first and six at most. */
  top?: number;
  group: CommandGroup;
  /** The kinds it acts on, as the selection or the focus. Without them, it acts on the window. */
  appliesTo?: readonly ObjectKind[];
  /** It deletes or takes something away: the conformance check expects it to change the core with no question. */
  destructive?: true;
  /** Whether it is offered at all. */
  when?(ctx: CommandContext): boolean;
  /** A toggle's state: menus and ⌘K show it ticked while it is on. */
  checked?(ctx: CommandContext): boolean;
  /** Offered, but not now, and why. */
  enabled?(ctx: CommandContext): true | { reason: MessageKey };
  /** Undone with ⌘Z, or asked about first, naming what will be lost (rule 4). */
  reversible: true | { confirm: MessageKey };
  run(ctx: CommandContext): void | Undoable | Promise<Undoable | void>;
}

/** A menu item's command takes its label and keys from the menu's list, so they agree. */
export const fromMenu = (id: MenuCommandId) => ({
  id,
  label: MENU_COMMANDS[id].label,
  ...(MENU_COMMANDS[id].keys && { shortcut: { keys: MENU_COMMANDS[id].keys } }),
});

/** For a command that only the place showing the object can do: offered where it was given. */
export const needsHere = (id: CommandId) => ({
  when: (ctx: CommandContext) => ctx.here?.[id] !== undefined,
  run: (ctx: CommandContext) => ctx.here?.[id]?.(),
});

const NO_CONTEXT: CommandContext = { selection: [], focus: null, surface: "mind" };

const targetsOf = (ctx: CommandContext): readonly ObjectRef[] =>
  ctx.selection.length > 0 ? ctx.selection : ctx.focus ? [ctx.focus] : [];

/** Whether a command is offered here: it fits what is selected or focused, and `when` agrees. */
export function offered(command: Command, ctx: CommandContext): boolean {
  const kinds = command.appliesTo;
  if (kinds) {
    const targets = targetsOf(ctx);
    if (targets.length === 0 || !targets.every((target) => kinds.includes(target.kind))) {
      return false;
    }
  }
  return command.when?.(ctx) ?? true;
}

export const isEnabled = (command: Command, ctx: CommandContext): boolean =>
  (command.enabled?.(ctx) ?? true) === true;

export const menuLabelOf = (command: Command, ctx: CommandContext, t: Translate): string =>
  labelOf({ ...command, label: command.menuLabel ?? command.label }, ctx, t);

export const labelOf = (command: Command, ctx: CommandContext, t: Translate): string =>
  typeof command.label === "string" ? t(command.label) : command.label(ctx, t);

const registered = new Map<CommandId, Command>();

export const commands = {
  register(command: Command): () => void {
    if (registered.has(command.id)) throw new Error(`Two commands are called ${command.id}.`);
    if (command.shortcut) checkKeys(command.shortcut.keys);
    if (command.shortcut?.alsoOther) checkKeys(command.shortcut.alsoOther);
    if (command.shortcut?.also) checkKeys(command.shortcut.also);
    registered.set(command.id, command);
    return () => {
      if (registered.get(command.id) === command) registered.delete(command.id);
    };
  },

  get: (id: CommandId): Command | undefined => registered.get(id),

  all: (): Command[] => [...registered.values()],

  /** The commands offered here, enabled or not. */
  list: (ctx: CommandContext): Command[] =>
    [...registered.values()].filter((command) => offered(command, ctx)),

  /**
   * Runs a command, if it is offered and enabled here. What it changed goes on
   * the undo stack, and is what it resolves to.
   */
  async run(id: CommandId, given: Partial<CommandContext> = {}): Promise<Undoable | undefined> {
    const command = registered.get(id);
    if (!command) throw new Error(`There is no command ${id}.`);
    const ctx = { ...NO_CONTEXT, ...given };
    if (!offered(command, ctx) || !isEnabled(command, ctx)) return undefined;
    const done: unknown = await command.run(ctx);
    // What a row's own action (`here`) hands back, such as a frame's handle, is no change to undo.
    const change = typeof done === "object" && done !== null ? (done as Undoable) : undefined;
    if (change) useUndo.getState().push(change);
    return change;
  },
};
