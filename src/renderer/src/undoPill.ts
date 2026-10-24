/** The part of the window's sidebar state the undo line's place depends on (`SidebarControl`). */
export interface SidebarSight {
  /** The User hid the sidebar. */
  hidden: boolean;
  /** Hidden, but slid out over the content for now. */
  peeking: boolean;
}

/**
 * Whether the undo line shows as the pill (#1776): with the sidebar out of sight, a User working
 * with the mouse has nowhere to click Undo at the sidebar's foot. A peeked sidebar shows it there
 * again, and so does the sidebar shown; exactly one of the two places draws the line.
 */
export const showsUndoPill = (sidebar: SidebarSight | null): boolean =>
  sidebar?.hidden === true && !sidebar.peeking;
