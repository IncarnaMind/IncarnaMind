import { flip, type Middleware, offset, shift, type VirtualElement } from "@floating-ui/dom";

/** The room a card keeps from the window's edge and from the check badge. */
const GAP = 8;

/**
 * Where a sentence's check card goes: under its mark, flipped above when the
 * window leaves no room below, and moved clear of the page's check badge
 * (#1686), which sits at the page's bottom right, where a card opened near
 * the foot would cover it.
 */
export function claimCardPlace(anchor: Element | VirtualElement): Middleware[] {
  return [offset(4), flip(), shift({ padding: GAP }), clearOfBadge(anchor)];
}

/**
 * Where a card at `card` goes so it doesn't cover `badge`, all in viewport
 * pixels, with `markTop` where its mark starts: above the mark or the badge,
 * else left of the badge, else up clear of it. Null when the card is already
 * clear, or there is nowhere to go.
 */
export function movedClearOfBadge(
  card: { x: number; y: number; width: number; height: number },
  markTop: number,
  badge: { left: number; top: number; right: number; bottom: number },
): { x?: number; y?: number } | null {
  const { x, y, width, height } = card;
  const apart =
    x + width <= badge.left || x >= badge.right || y + height <= badge.top || y >= badge.bottom;
  if (apart) return null;
  const above = Math.min(markTop, badge.top) - GAP - height;
  if (above >= GAP) return { y: above };
  const aside = badge.left - GAP - width;
  if (aside >= GAP) return { x: aside };
  const lower = badge.top - GAP - height;
  return lower >= GAP ? { y: lower } : null;
}

function clearOfBadge(anchor: Element | VirtualElement): Middleware {
  return {
    name: "clearOfBadge",
    fn({ x, y, rects }) {
      const context = anchor instanceof Element ? anchor : anchor.contextElement;
      const badge = context
        ?.closest(".mind-tab-page")
        ?.querySelector(".mind-foot-badge .check-badge")
        ?.getBoundingClientRect();
      if (!badge) return {};
      const { width, height } = rects.floating;
      return movedClearOfBadge({ x, y, width, height }, rects.reference.y, badge) ?? {};
    },
  };
}
