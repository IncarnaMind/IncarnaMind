import { focusQuietly } from "./quietFocus";

/**
 * Takes the User to a Citation to check: the newest Answer's first in the
 * assistant, else the page's; in view and focused, its card closed.
 */
export function goToCitation(): void {
  const shown = [...document.querySelectorAll<HTMLElement>('[data-testid="citation-chip"]')].filter(
    (chip) => chip.getClientRects().length > 0,
  );
  const newest = [...document.querySelectorAll('[data-testid="assistant-answer"]')].at(-1);
  const chip =
    shown.find((each) => newest?.contains(each)) ??
    shown.find((each) => !each.closest('[data-testid="assistant"]')) ??
    shown[0];
  if (chip) focusQuietly(chip);
}
