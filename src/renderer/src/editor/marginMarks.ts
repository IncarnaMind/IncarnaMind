/**
 * Where the check marks in the margin stand (DESIGN.md, Check marks, at 760px
 * and wider): each level with the line its sentence starts on, the first 8px
 * after the measure. Sentences that start on one line put their marks side by
 * side, in reading order, 4px apart; a mark that would end within 8px of the
 * pane's edge goes under the line's first mark, 4px below, and a mark below it
 * that it would overlap moves down. A sentence not checked yet takes no room
 * (#1941). Under 760px the marks stand in the text instead, and none of this
 * applies. See `MarginChecks`.
 */
export const MARK_HEIGHT = 18;
/** Between two marks, side by side or stacked. */
export const MARK_GAP = 4;
/** A mark that would end nearer than this to the pane's edge goes under the line's first. */
export const EDGE_GAP = 8;
/** A plain ✓'s width before it has rendered: 3px padding, its 11px icon and 5px padding. */
export const PLAIN_MARK_WIDTH = 19;

/** A mark's sentence, as the margin sees it. */
export interface MarkLine {
  /** The sentence's first line, from the top of the check column. */
  top: number;
  bottom: number;
  /** That line's vertical middle. */
  middle: number;
  /** Where the sentence starts, from the left of the text: its reading order on the line. */
  left: number;
  /** The mark's rendered width. */
  width: number;
  /** A sentence not checked yet: its hidden button takes no room. */
  silent: boolean;
}

/** The room the marks stand in, from the measure's right edge. */
export interface MarginRoom {
  /** The first mark's left edge. */
  gap: number;
  /** The furthest a mark's right edge may reach: the pane's edge less `EDGE_GAP`. */
  edge: number;
}

export interface MarkSpot {
  top: number;
  left: number;
}

/** Whether a sentence's first line is the line's: they overlap by more than half the shorter. */
function onOneLine(
  line: { top: number; bottom: number },
  mark: { top: number; bottom: number },
): boolean {
  return (
    Math.min(line.bottom, mark.bottom) - Math.max(line.top, mark.top) >
    Math.min(line.bottom - line.top, mark.bottom - mark.top) / 2
  );
}

/**
 * The top and left of each mark, in the order given. Lines run top to bottom;
 * a line's marks keep its own top unless a stack above reaches into it, and
 * then they all move down together, staying level with their sentence.
 */
export function placeMarginMarks(marks: readonly MarkLine[], room: MarginRoom): MarkSpot[] {
  const spots: MarkSpot[] = marks.map(() => ({ top: 0, left: room.gap }));
  const order = marks
    .map((mark, index) => ({ mark, index }))
    .sort((a, b) => a.mark.middle - b.mark.middle);
  const lines: { of: { mark: MarkLine; index: number }[]; top: number; bottom: number }[] = [];
  for (const each of order) {
    const line = lines.at(-1);
    if (line && onOneLine(line, each.mark)) {
      line.of.push(each);
      line.top = Math.min(line.top, each.mark.top);
      line.bottom = Math.max(line.bottom, each.mark.bottom);
    } else {
      lines.push({ of: [each], top: each.mark.top, bottom: each.mark.bottom });
    }
  }
  let bottom = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    const top = Math.max(
      Math.round(Math.min(...line.of.map(({ mark }) => mark.middle)) - MARK_HEIGHT / 2),
      bottom + MARK_GAP,
    );
    const reading = [...line.of].sort((a, b) => a.mark.left - b.mark.left);
    const wrapped: { mark: MarkLine; index: number }[] = [];
    let x = room.gap;
    let placed = 0;
    for (const each of reading) {
      const { mark, index } = each;
      if (mark.silent) {
        spots[index] = { top, left: room.gap };
        continue;
      }
      if (wrapped.length === 0 && (placed === 0 || x + mark.width <= room.edge)) {
        spots[index] = { top, left: x };
        x += mark.width + MARK_GAP;
        placed++;
        bottom = Math.max(bottom, top + MARK_HEIGHT);
      } else wrapped.push(each);
    }
    // A mark that didn't fit goes under the line's first mark, 4px below it, and every later mark
    // under the one before, so the line's own marks stay in reading order.
    wrapped.forEach(({ index }, at) => {
      const wrappedTop = top + (at + 1) * (MARK_HEIGHT + MARK_GAP);
      spots[index] = { top: wrappedTop, left: room.gap };
      bottom = Math.max(bottom, wrappedTop + MARK_HEIGHT);
    });
  }
  return spots;
}

/** The order a check's marks appear in: top to bottom, then left to right within a line. */
export function revealOrder<T extends { top: number; left: number }>(marks: readonly T[]): T[] {
  return [...marks].sort((a, b) => a.top - b.top || a.left - b.left);
}
