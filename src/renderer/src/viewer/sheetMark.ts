/** A box in the grid's own coordinates, in CSS pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The Citation's mark as measured: with its label, without it, and its height. */
export interface MarkSize {
  full: number;
  compact: number;
  height: number;
}

export interface MarkPlace {
  left: number;
  top: number;
  /** Whether the label fits there; without it, the mark's tooltip carries it. */
  label: boolean;
}

/** The space between the cited cells and the mark beside them. */
const GAP = 8;
/** The space between the cited rows and the mark above or below them. */
const ROW_GAP = 2;

/**
 * The room kept after the cited cells for the mark when a sheet is scrolled to
 * them: the slides' gutter, narrower in a narrow viewer.
 */
export const markGutter = (body: number): number => (body < 520 ? 48 : 104);

/**
 * How far to scroll a sheet across to show cited columns, from `left` to
 * `right` in the grid's coordinates, in a `body` that many pixels wide whose
 * first `frozen` pixels are frozen columns. The least scroll that shows them
 * all with the mark's gutter after them, so column A stays in view when it
 * can; without the gutter when only the cells fit; and, when they are wider
 * than the view, their right end and the gutter, as a row's figures sit right
 * of its label.
 */
export function scrollAcross(
  cited: { left: number; right: number },
  frozen: number,
  body: number,
): number {
  const width = cited.right - Math.max(cited.left, frozen);
  const room = body - frozen;
  const gutter = markGutter(body);
  const after = width <= room && width + gutter > room ? 0 : gutter;
  return Math.max(0, cited.right + after - body);
}

const inside = (view: Box, left: number, top: number, width: number, height: number) =>
  left >= view.left && left + width <= view.right && top >= view.top && top + height <= view.bottom;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, Math.max(low, high)));

/**
 * Where a sheet Citation's mark goes, so it never covers a cited cell: right
 * of the `cited` cells, level with their first row (`firstRow`, its top and
 * bottom), then left of them, then above, then below: the first of these in
 * the `view`, with its label if it fits there. Beside them it stays level with
 * the part of the cited rows in view as they scroll. With no room in view
 * outside the cells, it keeps its place right of them, out of view.
 */
export function placeSheetMark(
  cited: Box,
  firstRow: { top: number; bottom: number },
  view: Box,
  size: MarkSize,
): MarkPlace {
  const beside = (firstRow.top + firstRow.bottom) / 2 - size.height / 2;
  const level = clamp(
    beside,
    Math.max(cited.top, view.top),
    Math.min(cited.bottom, view.bottom) - size.height,
  );
  const above = cited.top - ROW_GAP - size.height;
  const below = cited.bottom + ROW_GAP;
  const rowsShow = cited.top < view.bottom && cited.bottom > view.top;
  const columnsShow = cited.left < view.right && cited.right > view.left;
  const across = (width: number) => clamp(cited.right - width, view.left, view.right - width);
  const places: ((width: number) => { left: number; top: number })[] = [
    ...(rowsShow
      ? [
          () => ({ left: cited.right + GAP, top: level }),
          (width: number) => ({ left: cited.left - GAP - width, top: level }),
        ]
      : []),
    ...(columnsShow
      ? [
          (width: number) => ({ left: across(width), top: above }),
          (width: number) => ({ left: across(width), top: below }),
        ]
      : []),
  ];
  for (const placed of places) {
    for (const label of [true, false]) {
      const width = label ? size.full : size.compact;
      const place = placed(width);
      if (inside(view, place.left, place.top, width, size.height)) return { ...place, label };
    }
  }
  return { left: cited.right + GAP, top: beside, label: true };
}
