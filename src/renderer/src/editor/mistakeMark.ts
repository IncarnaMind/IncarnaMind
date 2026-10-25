import { focusQuietly } from "./quietFocus";

/** Takes the User to the page's first red ≠: in view and focused, its card closed. */
export function goToMistake(from: Element): void {
  const mark = from
    .closest('[data-testid="mind-pane"]')
    ?.querySelector<HTMLElement>('[data-testid="claim-mark"][data-check="contradicted"]');
  if (mark) focusQuietly(mark);
}
