import { useEffect } from "react";
import type { CommandId, ShortcutKeys } from "../../../shared/commands";
import { topModalNow } from "../components/useModal";
import { files } from "../core";
import type { ObjectRef } from "../objects";
import { useAppStore } from "../store";
import { taskAt } from "../taskFocus";
import { nextToRedo, nextToUndo, typesText, useUndo } from "../undo";
import { keysLabel, keysOn, pressed } from "./keys";
import { menuKinds } from "./menus";
import {
  type Command,
  type CommandContext,
  commands,
  isEnabled,
  offered,
  SURFACES,
  type Surface,
} from "./registry";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Lists whose items can be selected, where a list's own keys act. */
const SELECTABLE_LIST =
  '[role="listbox"], [role="tree"], [role="treegrid"], [role="grid"], [role="tablist"]';

/** A row of an object (a Document, a Folder) counts as a list's, the sidebar's and the Library's having no roles. */
const ROW = "[data-object-row]";

const inList = (target: EventTarget | null) =>
  target instanceof Element &&
  !typesText(target) &&
  target.closest(`${SELECTABLE_LIST}, ${ROW}`) !== null;

/**
 * The object whose row holds the focus: the one the row names, or else its ⋯ button, so a row
 * holding other objects' buttons, such as a comparison cell's Citations, is still its own.
 */
export function objectAt(target: EventTarget | null): ObjectRef | null {
  if (!inList(target) || !(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(ROW);
  const named =
    row?.dataset.objectRow ||
    row?.querySelector<HTMLElement>("[data-object-menu]")?.dataset.objectMenu;
  const colon = named?.indexOf(":") ?? -1;
  const kind = menuKinds().find((each) => each === named?.slice(0, colon));
  return named && kind ? { kind, id: named.slice(colon + 1) } : null;
}

const isSurface = (value: string | undefined): value is Surface =>
  (SURFACES as readonly (string | undefined)[]).includes(value);

/** The surface an element is on: the nearest `data-surface`, or else the Mind. */
export function surfaceOf(target: EventTarget | null): Surface {
  const marked =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-surface]")?.dataset.surface
      : undefined;
  return isSurface(marked) ? marked : "mind";
}

const contextAt = (target: EventTarget | null): CommandContext => ({
  selection: [],
  focus: null,
  surface: surfaceOf(target),
  task: taskAt(target),
});

const dialogOpen = () => document.querySelector("dialog[open]") !== null;

/** The places whose undo lines are on screen in a modal: not those on a hidden page of it. */
const linesShownIn = (modal: HTMLElement | null): string[] =>
  modal
    ? [...modal.querySelectorAll<HTMLElement>("[data-undo-place]")]
        .filter((each) => each.checkVisibility())
        .flatMap((each) => each.dataset.undoPlace ?? [])
    : [];

/**
 * Whether an open modal keeps a command's keys from the page behind it. ⌘Z and ⇧⌘Z get past only
 * to a step whose line is drawn on screen in the modal on top (`shown`), as Settings draws its
 * own: a modal on top of that one (a consent question) holds them, and so does another page of
 * Settings, so no key but a dialog's own buttons answers it or changes what the User can't see.
 */
export function holdsKey(
  id: CommandId,
  shown: readonly string[],
  state: Parameters<typeof nextToUndo>[0] & Parameters<typeof nextToRedo>[0],
): boolean {
  if (id !== "edit.undo" && id !== "edit.redo") return true;
  const step = id === "edit.undo" ? nextToUndo(state) : nextToRedo(state);
  return !(step?.shownAt !== undefined && shown.includes(step.shownAt));
}

const dialogHolds = (id: CommandId) =>
  dialogOpen() && holdsKey(id, linesShownIn(topModalNow()), useUndo.getState());

const report = (error: unknown) => useAppStore.getState().reportError(error);

/**
 * Runs the command this key is the shortcut of, if it is offered and enabled
 * here: true if it took the key. Nothing while a dialog is open. With `objectsOnly`,
 * only commands that act on objects are considered.
 */
export function runShortcut(
  event: KeyboardEvent,
  ctx: CommandContext,
  { objectsOnly = false } = {},
): boolean {
  // Windows reports AltGr as Ctrl+Alt: what it types (a German \, a Polish ą) is text.
  if (event.getModifierState("AltGraph")) return false;
  for (const command of commands.all()) {
    const shortcut = command.shortcut;
    if (!shortcut || (objectsOnly && !command.appliesTo)) continue;
    if (shortcut.macOnly && !isMac) continue;
    const keys = [
      keysOn(shortcut.keys, isMac),
      ...(!isMac && shortcut.alsoOther ? [shortcut.alsoOther] : []),
      ...(shortcut.also ? [shortcut.also] : []),
    ];
    if (!keys.some((each) => pressed(each, event, isMac))) continue;
    if (shortcut.list && !inList(event.target)) continue;
    if (shortcut.outsideText && typesText(event.target)) continue;
    if (shortcut.notInText && typesText(event.target)) {
      // On macOS the menu takes a key the page leaves alone, and would run the command from the text.
      event.preventDefault();
      return true;
    }
    // Only now, for keys that are a shortcut: the search goes through the whole page.
    if (dialogHolds(command.id)) return false;
    // A list's own keys act on the row the focus is in.
    const here = shortcut.list ? { ...ctx, focus: ctx.focus ?? objectAt(event.target) } : ctx;
    if (!offered(command, here) || !isEnabled(command, here)) continue;
    event.preventDefault();
    commands.run(command.id, here).catch(report);
    return true;
  }
  return false;
}

/**
 * The window's keymap, where every command's shortcut is bound, and the
 * application menu's items, which run their commands here.
 */
export function useKeymap(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.defaultPrevented) runShortcut(event, contextAt(event.target));
    };
    window.addEventListener("keydown", onKey);
    const stopMenu = files.onMenuCommand((id) => {
      const focus = document.activeElement;
      // macOS sends text commands through the menu even when a dialog holds focus (#1351).
      const textsOwn =
        typesText(focus) &&
        (id === "edit.selectAll" || commands.get(id)?.shortcut?.outsideText === true);
      if (textsOwn || !dialogHolds(id)) commands.run(id, contextAt(focus)).catch(report);
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      stopMenu();
    };
  }, []);
}

/** Whether a key pressed is a command's shortcut, for a place that takes the keys itself. */
export function pressesShortcut(id: CommandId, event: KeyboardEvent): boolean {
  const shortcut = commands.get(id)?.shortcut;
  return shortcut !== undefined && pressed(keysOn(shortcut.keys, isMac), event, isMac);
}

/** Keys as this system writes them. */
export const keysHere = (keys: ShortcutKeys): string => keysLabel(keysOn(keys, isMac), isMac);

/** A command's shortcut as this system writes it, for tooltips and menus. */
export function shortcutLabel(id: CommandId): string {
  const shortcut = commands.get(id)?.shortcut;
  if (!shortcut) throw new Error(`The command ${id} has no shortcut.`);
  return keysHere(shortcut.keys);
}

/** The keys a menu shows beside a command: its shortcut, or the keys its row takes, as this system writes them. */
export function menuKeysLabel(command: Command): string | null {
  if (command.shortcut?.macOnly && !isMac) return null;
  const keys = command.shortcut?.keys ?? command.rowKeys;
  return keys ? keysLabel(keysOn(keys, isMac), isMac) : (command.globalKeys?.() ?? null);
}
