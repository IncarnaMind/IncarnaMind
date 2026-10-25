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
 * How much the page's scroll area gives up for the pill's band: from its foot, as the page would
 * draw it, up to the pill's top. `applied` is the band it has now, which its measured foot
 * already excludes.
 */
export const undoBandHeight = (scrollerBottom: number, applied: number, pillTop: number): number =>
  Math.max(0, Math.ceil(scrollerBottom + applied - pillTop));

export interface UndoPillBand {
  /** The group whose page gives up the band, or null for none. */
  groupId: string | null;
  height: number;
}

/** The band the page under the pill gives up while the pill shows, so no text lies under it. */
export const useUndoPillBand = create<UndoPillBand>(() => ({ groupId: null, height: 0 }));

export const setUndoPillBand = (groupId: string | null, height: number): void => {
  const now = useUndoPillBand.getState();
  if (now.groupId === groupId && now.height === height) return;
  useUndoPillBand.setState({ groupId, height });
};

/** The band `groupId`'s page gives up; 0 for a page the pill isn't over. */
export const undoBandFor = (band: UndoPillBand, groupId: string | undefined): number =>
  band.groupId !== null && band.groupId === groupId ? band.height : 0;
