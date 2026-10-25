export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A selected Citation marker's outline: its 2px, and the 1px it keeps from the marker. */
const REACH = 3;

/**
 * One box for each line the rectangles are on: a line's words and its Citation markers, which are
 * a different height, share it when they overlap by more than half of the shorter one.
 */
export function lineBoxes(rects: Iterable<Box>): Box[] {
  const lines: { top: number; bottom: number; left: number; right: number }[] = [];
  for (const rect of rects) {
    if (rect.width < 1 || rect.height < 1) continue;
    const bottom = rect.top + rect.height;
    const line = lines.find(
      (each) =>
        Math.min(each.bottom, bottom) - Math.max(each.top, rect.top) >
        Math.min(each.bottom - each.top, rect.height) / 2,
    );
    if (!line) {
      lines.push({ top: rect.top, bottom, left: rect.left, right: rect.left + rect.width });
      continue;
    }
    line.top = Math.min(line.top, rect.top);
    line.bottom = Math.max(line.bottom, bottom);
    line.left = Math.min(line.left, rect.left);
    line.right = Math.max(line.right, rect.left + rect.width);
  }
  return lines
    .sort((a, b) => a.top - b.top)
    .map((line) => ({
      left: line.left - REACH,
      top: line.top - REACH,
      width: line.right - line.left + REACH * 2,
      height: line.bottom - line.top + REACH * 2,
    }));
}
