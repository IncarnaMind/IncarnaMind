import { type RefObject, useEffect, useRef, useSyncExternalStore } from "react";

/** The native modal dialogs that are open, the one opened last on top. */
const openModals: HTMLDialogElement[] = [];
const watchers = new Set<() => void>();

/**
 * Notes `element`, a dialog just shown as a modal, as the one on top until it closes, however it
 * closes (Esc does it without going through React). Returns what takes it out again.
 */
function trackModal(element: HTMLDialogElement): () => void {
  openModals.push(element);
  for (const watcher of watchers) watcher();
  const untrack = () => {
    element.removeEventListener("close", untrack);
    const at = openModals.indexOf(element);
    if (at === -1) return;
    openModals.splice(at, 1);
    for (const watcher of watchers) watcher();
  };
  element.addEventListener("close", untrack);
  return untrack;
}

/**
 * The modal dialog on top, or null. Everything outside it is inert, so a line that must stay
 * readable and clickable over a dialog has to be drawn inside it: the top layer alone isn't enough.
 */
export function useTopModal(): HTMLDialogElement | null {
  return useSyncExternalStore(
    (watch) => {
      watchers.add(watch);
      return () => watchers.delete(watch);
    },
    () => openModals.at(-1) ?? null,
  );
}

/**
 * The modal dialog on top now, or null when none is open, or when one this stack doesn't know
 * (the command palette) is open too, since that one may be above it.
 */
export function topModalNow(): HTMLDialogElement | null {
  const shown = document.querySelectorAll("dialog:modal").length;
  return shown === openModals.length ? (openModals.at(-1) ?? null) : null;
}

/**
 * Keeps a native <dialog> shown as a modal while `open` is true. With
 * `focusDialog`, opening focuses the dialog itself (give it tabIndex={-1})
 * instead of its first control, e.g. so no choice looks picked before the
 * User picks one. `request` is a value that changes with each ask to show the
 * dialog: the browser closes it on Esc without telling React until a task
 * later, and an ask arriving meanwhile must show it again.
 */
export function useModal(
  open: boolean,
  { focusDialog = false, request = 0 }: { focusDialog?: boolean; request?: number } = {},
) {
  const dialog = useRef<HTMLDialogElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `request` is when to look again, not what is read: each ask shows the dialog and tracks it again, though `open` did not change.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      if (focusDialog) element.focus();
    }
    if (!open && element.open) {
      element.close();
      // Chromium gives the focus back to the text field the dialog took it from, but leaves the
      // caret outside it, so what is typed next goes nowhere (e.g. a follow-up after "Allow").
      const field = document.activeElement;
      if (
        (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) &&
        field.selectionStart !== null &&
        field.selectionEnd !== null
      ) {
        field.setSelectionRange(field.selectionStart, field.selectionEnd);
      }
    }
    if (!open) return;
    // A close the browser made has already untracked it, so an ask that shows it again must
    // track it again: the list holds what is on top now.
    return trackModal(element);
  }, [open, focusDialog, request]);
  return dialog;
}

/**
 * Closes a modal dialog on a press on its dimmed area, as the prototype's scrim does (#1360).
 * Only a press that starts there counts, so dragging a selection out of a field keeps the dialog.
 */
export function useBackdropClose(
  dialog: RefObject<HTMLDialogElement | null>,
  close: () => void,
): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onPress = (event: MouseEvent) => {
      if (event.target === element) latest.current();
    };
    element.addEventListener("mousedown", onPress);
    return () => element.removeEventListener("mousedown", onPress);
  }, [dialog]);
}
