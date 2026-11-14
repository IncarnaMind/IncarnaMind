/** The room kept clear between the check card and the window's edge. */
export const CARD_MARGIN = 8;

/**
 * How long what lands in an empty card must stay still before the card takes its height. The
 * Note's health is counted 300 ms after its last change, and the rows can come in two counts, so
 * the first of them alone would leave the others scrolling out of sight.
 */
export const SETTLE_MS = 700;
/** The longest it waits for that. */
export const SETTLE_AT_MOST_MS = 3000;

/** Whether the card's body holds only its title, so nothing in it could move yet (#2313). */
export function bodyIsEmpty(body: HTMLElement): boolean {
  const title = body.querySelector(".check-card-title")?.textContent ?? "";
  return (body.textContent ?? "").trim() === title.trim();
}

export interface HeldRoom {
  /** The body's height with everything that has landed. */
  natural: number;
  /** The body's height before anything landed. */
  rest: number;
  /** The card's box now, with that content in it. */
  card: { top: number; bottom: number };
  /** The card's height beyond its body: its padding, its foot and the rule above it. */
  chrome: number;
  /** The badge the card hangs from. */
  badge: { top: number; bottom: number };
}

/**
 * The height an empty card's body takes when its first content lands, once. The card hangs from
 * its foot, so the foot, with the Check in it, stays where it is, and only the card's top edge
 * moves. Above its badge that edge may go as far as the window's margin. Below it, where there was
 * no room above, the only room is the gap the card is placed at under the badge, and taking it
 * would have the card placed again, with its foot moved: the body stays as it was. What doesn't
 * fit stays in the body, which scrolls.
 */
export function firstHeight({ natural, rest, card, chrome, badge }: HeldRoom): number {
  if (isBelow(card, badge)) return rest;
  return Math.max(0, Math.min(natural, card.bottom - CARD_MARGIN - chrome));
}

/** Whether the card is placed under its badge, as when there was no room above it. */
export const isBelow = (card: { bottom: number }, badge: { top: number }) =>
  card.bottom > badge.top + 1;

/** Whether the body's card is under the badge it hangs from. */
export function isBelowOf(body: HTMLElement, badge: Element): boolean {
  const card = body.closest<HTMLElement>(".check-card")?.getBoundingClientRect();
  return card !== undefined && isBelow(card, badge.getBoundingClientRect());
}

/** `firstHeight` for the body as it is laid out now, under the badge it hangs from. */
export function firstHeightOf(body: HTMLElement, badge: Element, rest: number): number {
  const element = body.closest<HTMLElement>(".check-card");
  if (!element) return body.offsetHeight;
  return firstHeight({
    natural: body.offsetHeight,
    rest,
    card: element.getBoundingClientRect(),
    // Its scroll height, not its box: a body taller than the room has already clamped the card.
    chrome: element.scrollHeight - body.offsetHeight,
    badge: badge.getBoundingClientRect(),
  });
}
