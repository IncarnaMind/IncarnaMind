/** A rectangle in viewport pixels, as a change or the page view measures one. */
export interface ChangeBarBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The room a change's card needs right of it to sit beside it: about the card's own width. */
export const BESIDE_ROOM_PX = 300;

/** Between a change and its card, and between the card and the page view's edges. */
export const GAP_PX = 8;
/** How far the docked card keeps from the page view's foot, where the count and check badge sit. */
const FOOT_PX = 16;
/** The card's widest, as styles.css caps it. */
const WIDEST_PX = 420;

export type ChangeBarPlace =
  | { kind: "beside"; x: number; y: number; maxWidth: number }
  | { kind: "dock"; x: number; y: number; maxWidth: number };

/** Where the docked card may not pass: the check badge's left, and the Ask pill's top. */
export interface DockLimits {
  right: number;
  bottom: number;
}

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, Math.max(low, high)));

/**
 * Where a change's card goes (#1358, #1826): beside the change in the page
 * view's right margin when about 300px are free there and the card fits the
 * change's lines within the page; otherwise docked at the page view's foot,
 * even when the change is too near that foot for the card beside it. The card
 * is never at the window's corner or over the sidebar, being kept inside
 * `page`, and never over text: beside, it starts past `textRight`, where the
 * text on the change's lines ends, so a change partway along a line leaves its
 * card past the line; docked, the Mind scrolls the change above it.
 *
 * `change` is what the change shows, `page` the page view (its `top` under the
 * Mind's bar of changes), `card` the card as it is drawn, and `lineHeight` the
 * text's line box. `limits` keeps the docked card clear of what sits at the
 * page's foot: the check badge and the Ask pill.
 */
export function changeBarPlace(
  change: ChangeBarBox,
  textRight: number,
  page: ChangeBarBox,
  card: { width: number; height: number },
  lineHeight: number,
  limits?: DockLimits,
): ChangeBarPlace {
  const height = change.bottom - change.top;
  const lines = Math.max(1, Math.ceil(height / Math.max(1, lineHeight)));
  const room = page.right - textRight - GAP_PX;
  // The first line's own box, so the card starts level with the line rather than the ink.
  const leading = Math.max(0, (lineHeight - (height - (lines - 1) * lineHeight)) / 2);
  const top = change.top - leading;
  const highest = page.bottom - GAP_PX - card.height;
  if (room >= BESIDE_ROOM_PX && card.height <= lines * lineHeight && top <= highest) {
    return {
      kind: "beside",
      x: textRight + GAP_PX,
      y: clamp(top, page.top + GAP_PX, highest),
      maxWidth: Math.min(WIDEST_PX, room),
    };
  }
  const right = Math.min(limits?.right ?? page.right, page.right);
  const bottom = Math.min(limits?.bottom ?? page.bottom, page.bottom);
  const span = Math.max(0, right - page.left - FOOT_PX * 2);
  const width = Math.min(card.width, span);
  return {
    kind: "dock",
    x: clamp(
      Math.round((page.left + right - width) / 2),
      page.left + FOOT_PX,
      right - FOOT_PX - width,
    ),
    y: bottom - FOOT_PX - card.height,
    maxWidth: Math.min(WIDEST_PX, span),
  };
}
