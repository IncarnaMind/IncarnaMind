import { useCallback, useMemo, useRef } from "react";

/** What had the focus as an overlay opened, to give it back when the overlay closes. */
export interface Remembered {
  readonly element: HTMLElement;
  /**
   * Where a text field's caret was. Chromium gives the element the focus back
   * over an overlay's close, but neither the caret, nor the editing it needs:
   * the keys reach the field and no `input` fires until the selection is set
   * again, so the word typed next went nowhere (#2107).
   */
  readonly caret: readonly [number, number] | null;
}

/** How an overlay gives the focus back when it closes. */
export interface FocusReturn {
  /** Notes what has the focus now, with its caret, as the overlay opens. */
  remember(): void;
  /**
   * Gives the focus back to what had it when the overlay opened, once the
   * overlay has closed. A place something else has given the focus since keeps
   * it, and so does anything still inside the closing overlay's.
   * `fallback` is where to go when what the overlay opened from has gone.
   * Says whether the focus went anywhere.
   */
  giveBack(overlay: Element | null, fallback?: HTMLElement | null): boolean;
}

const caretOf = (field: HTMLElement): readonly [number, number] | null => {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return null;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  // Null for the kinds of field with no selection, such as an email address.
  return start === null || end === null ? null : [start, end];
};

/** The element that had the focus as an overlay opened, and the caret it had. */
export function rememberFocus(): Remembered | null {
  const focused = document.activeElement;
  return focused instanceof HTMLElement ? { element: focused, caret: caretOf(focused) } : null;
}

const usable = (element: HTMLElement | null): element is HTMLElement =>
  element !== null &&
  element !== document.body &&
  element.isConnected &&
  !element.hasAttribute("aria-hidden");

/**
 * Gives the focus back to what had it as an overlay opened, as the overlay
 * closes: the one rule for the command palette, the popover menus and ⋯ menus,
 * the dialogs and the pickers beside a row. Says whether it went anywhere, so
 * a caller can send it somewhere of its own when the place it was is gone.
 */
export function giveFocusBack(
  remembered: Remembered | null,
  overlay: Element | null,
  fallback: HTMLElement | null = null,
): boolean {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Somewhere else that isn't the overlay's own: whatever gave it there keeps it.
  if (
    focused !== null &&
    focused !== document.body &&
    focused !== remembered?.element &&
    overlay?.contains(focused) !== true
  ) {
    return true;
  }
  const target = remembered?.element ?? null;
  let to: HTMLElement | null = null;
  if (usable(target)) to = target;
  else if (usable(fallback)) to = fallback;
  if (!to) return false;
  if (focused !== to) to.focus();
  const caret = target === to ? (remembered?.caret ?? null) : null;
  if (caret !== null && (to instanceof HTMLInputElement || to instanceof HTMLTextAreaElement)) {
    to.setSelectionRange(caret[0], caret[1]);
  }
  return true;
}

/** Keeps what an overlay takes the focus from, to give it back when the overlay closes. */
export function useFocusReturn(): FocusReturn {
  const remembered = useRef<Remembered | null>(null);
  const remember = useCallback(() => {
    remembered.current = rememberFocus();
  }, []);
  const giveBack = useCallback(
    (overlay: Element | null, fallback: HTMLElement | null = null) =>
      giveFocusBack(remembered.current, overlay, fallback),
    [],
  );
  return useMemo(() => ({ remember, giveBack }), [remember, giveBack]);
}
