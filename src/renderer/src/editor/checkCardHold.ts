/** The room kept clear between the check card and the window's edge. */
export const CARD_MARGIN = 8;

/** Whether the card's body holds only its title, so nothing in it could move yet (#2313). */
export function bodyIsEmpty(body: HTMLElement): boolean {
  const title = body.querySelector(".check-card-title")?.textContent ?? "";
  return (body.textContent ?? "").trim() === title.trim();
}

export interface HeldRoom {
  /** The body's height with everything that has landed. */
  natural: number;
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
 * moves: above its badge it may go as far as the window's margin, below it only to the badge's
 * bottom edge, never over the badge. What doesn't fit stays in the body, which scrolls.
 */
export function firstHeight({ natural, card, chrome, badge }: HeldRoom): number {
  const above = card.bottom <= badge.top + 1;
  const reach = above ? CARD_MARGIN : badge.bottom;
  return Math.max(0, Math.min(natural, card.bottom - reach - chrome));
}

/** `firstHeight` for the body as it is laid out now, under the badge it hangs from. */
export function firstHeightOf(body: HTMLElement, badge: Element): number {
  const element = body.closest<HTMLElement>(".check-card");
  if (!element) return body.offsetHeight;
  return firstHeight({
    natural: body.offsetHeight,
    card: element.getBoundingClientRect(),
    // Its scroll height, not its box: a body taller than the room has already clamped the card.
    chrome: element.scrollHeight - body.offsetHeight,
    badge: badge.getBoundingClientRect(),
  });
}
