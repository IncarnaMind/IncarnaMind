let quiet: Element | null = null;

/** A focus that goes to a mark on purpose doesn't open its card; the User opens it. */
export const isQuietFocus = (element: Element): boolean => element === quiet;

/** Takes the User to an element: in view and focused, whatever a focus opens closed. */
export function focusQuietly(element: HTMLElement): void {
  element.scrollIntoView({ block: "nearest" });
  quiet = element;
  try {
    // The ring shows as it does for a key press, whatever moved the focus here.
    element.focus({ focusVisible: true } as FocusOptions);
  } finally {
    quiet = null;
  }
}
