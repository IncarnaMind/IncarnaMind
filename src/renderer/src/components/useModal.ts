import { type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

/** The native modal dialogs that are open, the one opened last on top. */
const openModals: HTMLDialogElement[] = [];
const watchers = new Set<() => void>();
/** What takes each dialog out of the list again. */
const tracked = new Map<HTMLDialogElement, () => void>();

function untrackModal(element: HTMLDialogElement): void {
  const untrack = tracked.get(element);
  if (untrack) {
    tracked.delete(element);
    element.removeEventListener("close", untrack);
  }
  const at = openModals.indexOf(element);
  if (at === -1) return;
  openModals.splice(at, 1);
  for (const watcher of watchers) watcher();
}

/**
 * Notes `element`, a dialog just shown as a modal, as the one on top until it closes, however it
 * closes (Esc does it without going through React). Returns what takes it out again.
 */
function trackModal(element: HTMLDialogElement): () => void {
  untrackModal(element);
  openModals.push(element);
  for (const watcher of watchers) watcher();
  const untrack = () => untrackModal(element);
  tracked.set(element, untrack);
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
  const wanted = useRef(open);
  wanted.current = open;
  const focusesDialog = useRef(focusDialog);
  focusesDialog.current = focusDialog;
  // The browser closes a dialog it shows as a modal on Esc by itself, and says so through a `close`
  // event a task later. An ask to open it again can arrive before that event, writing the `open`
  // the store already holds: nothing re-renders, `showModal()` never runs, and the late close then
  // clears the store. Report the close in the Esc's own task instead, so the ask that follows is a
  // change from closed to open; and ignore a close that finds the dialog open again.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    let ownClose = false;
    let escClosing = false;
    const onCancel = (event: Event) => {
      // React's own `onCancel` runs first, on this same element, and says so in `defaultPrevented`.
      if (event.defaultPrevented) return;
      escClosing = true;
      ownClose = true;
      // React must hear the close before an input task can ask for the dialog again, so the ask
      // reaches `showModal()`; a later task would come after the ask and lose it.
      flushSync(() => element.dispatchEvent(new Event("close")));
    };
    const onClose = (event: Event) => {
      // Capture on the way down reaches the dialogs a dialog's page holds: only its own close.
      if (event.target !== element) return;
      if (ownClose) {
        ownClose = false;
        return;
      }
      // Shown again since the browser decided to close it: that close is old news.
      if (element.open) {
        escClosing = false;
        event.stopImmediatePropagation();
        return;
      }
      if (escClosing) {
        escClosing = false;
        return;
      }
      // Wanted open while the browser shut it: show it again and keep the store's word.
      if (!wanted.current) return;
      event.stopImmediatePropagation();
      element.showModal();
      if (focusesDialog.current) element.focus();
      trackModal(element);
    };
    element.addEventListener("cancel", onCancel);
    element.addEventListener("close", onClose, true);
    return () => {
      element.removeEventListener("cancel", onCancel);
      element.removeEventListener("close", onClose, true);
    };
  }, []);
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
    return trackModal(element);
  }, [open, focusDialog]);
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
