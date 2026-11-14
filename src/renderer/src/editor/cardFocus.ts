export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusablesIn(container: Element | null): HTMLElement[] {
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

/**
 * Cards that show on keyboard focus (#3102, docs/agents/interaction.md): Tab and Shift+Tab move
 * between the page's stops as if the card weren't there; Space on its control goes into it, where
 * they move through its controls and, past either end, back to the control. Esc goes back to the
 * control.
 */
export function enterCard(card: Element | null): boolean {
  focusablesIn(card)[0]?.focus();
  return card?.contains(document.activeElement) ?? false;
}

/** Past either end of a card's controls the focus goes back to its control; it does not wrap. */
export function returnAtEnds(
  event: TabPress,
  card: Element,
  control: { focus(): void } | null,
): void {
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || !control) return;
  const stops = focusablesIn(card);
  const edge = event.shiftKey ? stops[0] : stops.at(-1);
  if (!edge || event.target !== edge) return;
  event.preventDefault();
  control.focus();
}

/**
 * Whether the focus leaving a control or its card goes somewhere else, so the card goes at once
 * instead of staying beside the card of the control the focus reaches. Into the card, or back to its
 * control, it stays.
 */
export function goingElsewhere(
  to: EventTarget | null,
  ...stays: (Element | null | undefined)[]
): boolean {
  return to instanceof Node && !stays.some((each) => each?.contains(to));
}

/** Space, alone and not while an input method composes: the key that goes into a card. */
export function isSpaceKey(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing: boolean };
}): boolean {
  return (
    event.key === " " &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.nativeEvent?.isComposing !== true &&
    event.keyCode !== 229
  );
}
