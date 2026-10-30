/** Left and right edges, in the strip's own scrolled coordinates. */
export interface Span {
  left: number;
  right: number;
}

/** A tab's edges, and its name's. */
export interface TabSpan extends Span {
  name: Span;
}

export interface StripFit {
  /** The width the strip is cut to, or null when every tab fits. */
  run: number | null;
  /** Room the strip leaves before the "+" when it stops short of the last tab. */
  gap: number;
  scrollLeft: number;
  /** The tabs it shows whole, by index. */
  first: number;
  last: number;
  /**
   * The one tab in view leaves too little room for a readable part of a hidden name at each side
   * that hides tabs; a shown tab narrowed to its least width makes the room.
   */
  squeezed: boolean;
}

/** Edges measured in fractions of a pixel are the same edge within this. */
const EPSILON = 0.5;

/**
 * Where a strip of tabs comes to rest. `room` is the width the strip and its spare space share,
 * and `endGap` what the strip keeps after its last tab (the last tab's foot, and the gap before
 * the "+"). A `shown` tab is brought whole into view, moving the strip as little as it can; with
 * none, the strip rests on the tab edge nearest `scrollLeft`.
 *
 * The tabs in view are whole. A side that hides tabs fades out over `fade` pixels, and the strip
 * reaches that far into the name of the hidden tab beyond, so part of a name shows, faded: the
 * sign that there are more (#2244). A cut on a tab's edge would fade only the blank at its ends.
 * Where a tab in view and those names don't fit together, the tab is hidden too. With one tab in
 * view the names may shrink to half the fade, which still reads and keeps the fade off that tab;
 * below that the strip is `squeezed`.
 */
export function fitStrip({
  tabs,
  room,
  endGap,
  fade,
  scrollLeft,
  shown,
}: {
  tabs: readonly TabSpan[];
  room: number;
  endGap: number;
  fade: number;
  scrollLeft: number;
  shown: number;
}): StripFit {
  const count = tabs.length;
  const final = tabs[count - 1];
  if (!final || final.right + endGap <= room + EPSILON) {
    return {
      run: null,
      gap: 0,
      scrollLeft: 0,
      first: 0,
      last: Math.max(0, count - 1),
      squeezed: false,
    };
  }

  /** How far the strip reaches past its whole tabs into a hidden one's name, by `seen` of it. */
  const into = (beyond: TabSpan | undefined, side: "before" | "after", seen = fade) => {
    if (!beyond) return 0;
    const blank =
      side === "before" ? beyond.right - beyond.name.right : beyond.name.left - beyond.left;
    return Math.min(beyond.right - beyond.left, Math.max(fade, Math.max(0, blank) + seen));
  };
  /** Where tab `first` starts: its left edge, or the strip's own start for the first tab. */
  const leftOf = (first: number) => (first > 0 ? (tabs[first]?.left ?? 0) : 0);
  const intoBefore = (first: number) => (first > 0 ? into(tabs[first - 1], "before") : 0);
  const startAt = (first: number) => leftOf(first) - intoBefore(first);
  /** The strip's end after tab `last`: its foot at the end, or a name beyond it, and the gap. */
  const endAt = (last: number) =>
    (tabs[last]?.right ?? 0) + endGap + (last === count - 1 ? 0 : into(tabs[last + 1], "after"));
  /** The last tab whole in view from tab `first`: at least `first` itself. */
  const lastFrom = (first: number) => {
    let last = first;
    while (last + 1 < count && endAt(last + 1) - startAt(first) <= room + EPSILON) last++;
    return last;
  };

  let first = 0;
  for (let index = 1; index < count; index++) {
    if (Math.abs(startAt(index) - scrollLeft) < Math.abs(startAt(first) - scrollLeft))
      first = index;
  }
  if (shown >= 0 && shown < first) first = shown;
  else if (shown > lastFrom(first)) {
    first = tabs.findIndex((_, start) => lastFrom(start) >= shown);
  }
  // Reaching the last tab, start as early as that allows, so no room is left blank.
  if (lastFrom(first) === count - 1) {
    first = tabs.findIndex((_, start) => lastFrom(start) === count - 1);
  }

  const last = lastFrom(first);
  const reachesEnd = last === count - 1;
  const gap = reachesEnd ? 0 : endGap;
  let before = intoBefore(first);
  let after = reachesEnd ? 0 : into(tabs[last + 1], "after");
  const whole = (tabs[last]?.right ?? 0) + (reachesEnd ? endGap : 0) - leftOf(first);
  const spare = Math.max(0, room - gap - whole);
  let squeezed = false;
  if (before + after > spare + EPSILON) {
    const least = (full: number, side: "before" | "after", beyond: TabSpan | undefined) =>
      full > 0 ? into(beyond, side, fade / 2) : 0;
    const leastBefore = least(before, "before", tabs[first - 1]);
    const leastAfter = least(after, "after", tabs[last + 1]);
    squeezed = leastBefore + leastAfter > spare + EPSILON;
    const share = squeezed
      ? spare / (leastBefore + leastAfter)
      : (spare - leastBefore - leastAfter) / (before - leastBefore + after - leastAfter);
    before = squeezed ? leastBefore * share : leastBefore + (before - leastBefore) * share;
    after = squeezed ? leastAfter * share : leastAfter + (after - leastAfter) * share;
  }
  return {
    run: Math.min(whole + before + after, room - gap),
    gap,
    scrollLeft: leftOf(first) - before,
    first,
    last,
    squeezed,
  };
}
