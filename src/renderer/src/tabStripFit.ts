/** A tab's left and right edge, in the strip's own scrolled coordinates. */
export interface Span {
  left: number;
  right: number;
}

export interface StripFit {
  /** The width the strip is cut to so it ends on a tab's edge, or null when every tab fits. */
  run: number | null;
  /** Room the strip leaves before the "+" when it stops short of the last tab. */
  gap: number;
  scrollLeft: number;
  /** The tabs it shows whole, by index. */
  first: number;
  last: number;
}

/** Edges measured in fractions of a pixel are the same edge within this. */
const EPSILON = 0.5;

/**
 * Where a strip of tabs comes to rest: scrolled to a tab's left edge and cut after a tab's right
 * edge, so no tab is clipped. `room` is the width the strip and its spare space share, and
 * `endGap` what a run keeps after its last tab (the last tab's foot, and the gap before the "+").
 * A `shown` tab is brought into the run, moving it as little as it can; with none, the run is the
 * one nearest `scrollLeft`.
 */
export function fitStrip({
  tabs,
  room,
  endGap,
  scrollLeft,
  shown,
}: {
  tabs: readonly Span[];
  room: number;
  endGap: number;
  scrollLeft: number;
  shown: number;
}): StripFit {
  const count = tabs.length;
  const final = tabs[count - 1];
  if (!final || final.right + endGap <= room + EPSILON) {
    return { run: null, gap: 0, scrollLeft: 0, first: 0, last: Math.max(0, count - 1) };
  }
  const starts = tabs.map((tab, index) => (index === 0 ? 0 : tab.left));
  const lastFrom = (from: number) => {
    let end = from;
    while (
      end + 1 < count &&
      (tabs[end + 1]?.right ?? Infinity) + endGap <= (starts[from] ?? 0) + room + EPSILON
    ) {
      end++;
    }
    return end;
  };

  let from = 0;
  for (let index = 1; index < count; index++) {
    if (Math.abs((starts[index] ?? 0) - scrollLeft) < Math.abs((starts[from] ?? 0) - scrollLeft)) {
      from = index;
    }
  }
  if (shown >= 0 && shown < from) from = shown;
  else if (shown > lastFrom(from)) from = starts.findIndex((_, start) => lastFrom(start) >= shown);
  // Reaching the last tab, start as early as that allows, so no room is left blank.
  if (lastFrom(from) === count - 1) {
    from = starts.findIndex((_, start) => lastFrom(start) === count - 1);
  }

  const last = lastFrom(from);
  const reachesEnd = last === count - 1;
  const gap = reachesEnd ? 0 : endGap;
  const start = starts[from] ?? 0;
  const edge = (tabs[last]?.right ?? 0) + (reachesEnd ? endGap : 0);
  return { run: Math.min(edge - start, room - gap), gap, scrollLeft: start, first: from, last };
}
