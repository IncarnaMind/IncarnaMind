import type { ReactNode } from "react";

/** One thing a check card offers, in the order the card has always listed them. */
export interface CardAction {
  key: string;
  testId: string;
  label: string;
  /** What the card styled as its main action: the first of them is the card's first button. */
  primary?: boolean;
  /** Keep as my view, the second button wherever the card offers it (#2869). */
  keep?: boolean;
  /** Never a button: Open the page, which the quote is, and Add all as Citations. */
  menuOnly?: boolean;
  disabled?: boolean;
  onClick(): void;
  /** Drawn by a component of its own when it is a button, for what it shows beside it. */
  render?: () => ReactNode;
}

/**
 * The card's buttons and what goes under its ⋯ (#2869): the first main action, then Keep as my view
 * where it is offered, else the next action, at most two; everything else in the same order under
 * the ⋯, Open the page first.
 */
export function splitActions(actions: readonly CardAction[]): {
  buttons: CardAction[];
  menu: CardAction[];
} {
  const candidates = actions.filter((action) => !action.menuOnly);
  const first = candidates.find((action) => action.primary) ?? candidates[0];
  const keep = candidates.find((action) => action.keep && action !== first);
  const second = keep ?? candidates.find((action) => action !== first);
  const buttons = [first, second].filter((action): action is CardAction => action !== undefined);
  const rest = actions.filter((action) => !buttons.includes(action));
  return {
    buttons,
    menu: [
      ...rest.filter((action) => action.testId === "claim-open"),
      ...rest.filter((action) => action.testId !== "claim-open"),
    ],
  };
}
