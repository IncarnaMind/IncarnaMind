import { useEffect, useRef, useSyncExternalStore } from "react";

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
 * User picks one.
 */
export function useModal(open: boolean, { focusDialog = false } = {}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  }, [open, focusDialog]);
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    return trackModal(element);
  }, [open]);
  return dialog;
}
