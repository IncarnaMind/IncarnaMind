/** What Tab moves through in a card: its actions, in reading order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(container: Element | null): HTMLElement[] {
  if (!container) return [];
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((each) =>
    each.checkVisibility(),
  );
}

/**
 * Where Tab or Shift+Tab goes among `count` actions when `index` is the one
 * focused: the action to wrap to at either end, or null to let the browser
 * move to the next or previous one.
 */
export function wrappedFocus(index: number, count: number, backward: boolean): number | null {
  if (count === 0) return null;
  if (backward) return index <= 0 ? count - 1 : null;
  return index < 0 || index >= count - 1 ? 0 : null;
}

/** Keeps Tab and Shift+Tab within a card, wrapping at its ends (#1762). */
export function keepFocusInside(
  event: { key: string; shiftKey: boolean; preventDefault(): void },
  container: HTMLElement,
): void {
  if (event.key !== "Tab") return;
  const focusables = focusablesIn(container);
  const active = document.activeElement;
  const index = active instanceof HTMLElement ? focusables.indexOf(active) : -1;
  const next = wrappedFocus(index, focusables.length, event.shiftKey);
  if (next === null) return;
  event.preventDefault();
  focusables[next]?.focus();
}

/** The first of a card's actions takes the focus, or the card itself when it has none yet. */
export function focusFirstAction(container: HTMLElement | null): void {
  if (!container) return;
  (focusablesIn(container)[0] ?? container).focus();
}
