export interface Point {
  x: number;
  y: number;
}

/** How far behind where the pointer last was the way starts, for a hand's wobble. */
const PAD_PX = 8;

const side = (point: Point, a: Point, b: Point) =>
  (point.x - b.x) * (a.y - b.y) - (a.x - b.x) * (point.y - b.y);

/**
 * Whether `point` is on the way from `apex`, where the pointer last was on a
 * submenu's item, to the submenu `box`: inside the triangle between them and
 * the box's near edge, which a diagonal slide to a lower choice crosses the
 * rows beside the item in.
 */
export function isSlidingTo(
  point: Point,
  apex: Point,
  box: { left: number; right: number; top: number; bottom: number },
): boolean {
  const toTheRight = apex.x < box.left;
  const edge = toTheRight ? box.left : box.right;
  const from = { x: apex.x + (toTheRight ? -PAD_PX : PAD_PX), y: apex.y };
  const top = { x: edge, y: box.top };
  const bottom = { x: edge, y: box.bottom };
  const signs = [side(point, from, top), side(point, top, bottom), side(point, bottom, from)];
  return !(signs.some((each) => each < 0) && signs.some((each) => each > 0));
}
