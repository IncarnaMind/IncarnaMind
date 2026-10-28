import { create } from "zustand";

export interface SidebarSight {
  hidden: boolean;
  peeking: boolean;
}

/**
 * With the sidebar out of sight a User working with the mouse has nowhere to click Undo at its
 * foot, so the line shows as the pill; a peeked or shown sidebar has it at the foot again, and
 * exactly one of the two places draws it.
 */
export const showsUndoPill = (sidebar: SidebarSight | null): boolean =>
  sidebar?.hidden === true && !sidebar.peeking;

/** Room the pill keeps from the card's left edge, 16px from the window's. */
const PILL_INSET_PX = 8;

/**
 * Whether the pill clears the page's text: the text column's left, measured in the card, is at
 * least the pill's own width past the pill's left edge.
 */
export const fitsLeftOfText = (columnLeft: number, pillWidth: number): boolean =>
  columnLeft >= pillWidth + PILL_INSET_PX;

/**
 * How much a page's scroll area gives up for a pill's band: from its foot, as the page would draw
 * it, up to the pill's top. `applied` is the band it has now, which its measured foot already
 * excludes.
 */
export const undoBandHeight = (scrollerBottom: number, applied: number, pillTop: number): number =>
  Math.max(0, Math.ceil(scrollerBottom + applied - pillTop));

/** A page the pill can reach: its group's box and its page's text column and scroll area. */
export interface PageUnderPill {
  groupId: string;
  /** The group's left and right, in the window. */
  left: number;
  right: number;
  /** The text column's left, in the window. */
  columnLeft: number;
  /** The scroll area's bottom, as the band it has already moved it. */
  scrollerBottom: number;
  /** The band the page gives up already. */
  applied: number;
}

/**
 * The band each page under the pill gives up, by group. The pill is placed against the card, so a
 * wide one reaches past its own group into the next: every page its span covers keeps its text
 * clear of it, not only the page under the pill's left edge (#1914).
 */
export const bandsUnderPill = (
  pill: { left: number; right: number; width: number; top: number },
  cardLeft: number,
  pages: readonly PageUnderPill[],
): Record<string, number> => {
  const bands: Record<string, number> = {};
  for (const page of pages) {
    if (pill.right <= page.left || page.right <= pill.left) continue;
    if (fitsLeftOfText(page.columnLeft - cardLeft, pill.width)) continue;
    bands[page.groupId] = undoBandHeight(page.scrollerBottom, page.applied, pill.top);
  }
  return bands;
};

/** The bands the pages under the pill give up while it shows, so no text lies under it. */
export const useUndoPillBands = create<{ bands: Readonly<Record<string, number>> }>(() => ({
  bands: {},
}));

export const setUndoPillBands = (bands: Readonly<Record<string, number>>): void => {
  const now = useUndoPillBands.getState().bands;
  const kept = Object.keys(bands);
  if (
    kept.length === Object.keys(now).length &&
    kept.every((groupId) => now[groupId] === bands[groupId])
  )
    return;
  useUndoPillBands.setState({ bands });
};

/** The band `groupId`'s page gives up; 0 for a page the pill isn't over. */
export const undoBandFor = (
  bands: Readonly<Record<string, number>>,
  groupId: string | undefined,
): number => (groupId === undefined ? 0 : (bands[groupId] ?? 0));
