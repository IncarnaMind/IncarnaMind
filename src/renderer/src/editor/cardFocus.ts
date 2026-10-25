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

export interface TabPress {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

export function keepFocusInside(event: TabPress, container: HTMLElement): void {
  // Ctrl+Tab and Ctrl+Shift+Tab switch tabs (commands/tabs.ts): a modified Tab is never the card's.
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
  if (!(event.target instanceof Node) || !container.contains(event.target)) return;
  const focusables = focusablesIn(container);
  const active = document.activeElement;
  const index = active instanceof HTMLElement ? focusables.indexOf(active) : -1;
  const next = wrappedFocus(index, focusables.length, event.shiftKey);
  if (next === null) return;
  event.preventDefault();
  focusables[next]?.focus();
}

export function focusFirstAction(
  container: HTMLElement | null,
  fallback: HTMLElement | null,
): void {
  (focusablesIn(container)[0] ?? fallback)?.focus();
}
