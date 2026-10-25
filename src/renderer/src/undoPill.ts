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
