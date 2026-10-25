let quiet: Element | null = null;

/** A focus that goes to a mark on purpose doesn't open its card; the User opens it. */
export const isQuietFocus = (element: Element): boolean => element === quiet;

/** Takes the User to the page's first red ≠: in view and focused, its card closed. */
export function goToMistake(from: Element): void {
  const mark = from
    .closest('[data-testid="mind-pane"]')
    ?.querySelector<HTMLElement>('[data-testid="claim-mark"][data-check="contradicted"]');
  if (!mark) return;
  mark.scrollIntoView({ block: "nearest" });
  quiet = mark;
  try {
    // The ring shows as it does for a key press, whatever moved the focus here.
    mark.focus({ focusVisible: true } as FocusOptions);
  } finally {
    quiet = null;
  }
}
