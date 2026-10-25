import { focusQuietly } from "./quietFocus";

/**
 * Takes the User to the first Citation to check: an Answer's in the assistant,
 * else the page's; in view and focused, its card closed.
 */
export function goToCitation(): void {
  const shown = [...document.querySelectorAll<HTMLElement>('[data-testid="citation-chip"]')].filter(
    (chip) => chip.getClientRects().length > 0,
  );
  const chip = shown.find((each) => each.closest('[data-testid="assistant"]')) ?? shown[0];
  if (chip) focusQuietly(chip);
}
