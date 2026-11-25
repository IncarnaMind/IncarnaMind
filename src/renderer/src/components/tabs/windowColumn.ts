import { createContext } from "react";

/**
 * The window's one column for a Note's conversation, the tab area's full height left of every tab
 * group (#3759), and the tab whose Note it shows.
 */
export interface WindowColumn {
  /** Where the column is drawn while it fits beside the groups; null while it doesn't. */
  slot: HTMLElement | null;
  /**
   * The Note tab in focus, kept while the focus is in a Document, the Library or Home: the column
   * shows that Note's conversation only.
   */
  tabId: string | null;
  /** The column is drawn, at the window's left. */
  drawn: boolean;
}

export const WindowColumnContext = createContext<WindowColumn>({
  slot: null,
  tabId: null,
  drawn: false,
});

/** The column's width, as `styles.css` › `.note-column` draws it. */
const COLUMN_WIDTH = 360;

/**
 * The least a Note keeps beside its column: about 490px of text, as the page views of the User's AI
 * apps keep beside their conversation, with the 40px gutter a narrow Note keeps on each side. A
 * scrollbar that takes room (`scrollbar`, the Note's scroller keeps it) comes on top.
 */
const NOTE_PANE = 570;

/** The least every other group keeps beside the column: a Document's toolbar still fits whole. */
const OTHER_PANE = 400;

/**
 * Whether the column fits beside `groups` groups in a card `card` px wide: the Note it follows keeps
 * `NOTE_PANE` and its scrollbar's room, and every other group `OTHER_PANE`; when it doesn't, the
 * conversation opens upward from the input at the Note's foot.
 */
export const columnFits = (card: number | null, groups: number, scrollbar = 0): boolean =>
  card !== null &&
  card - COLUMN_WIDTH - Math.max(0, groups - 1) >=
    NOTE_PANE + scrollbar + Math.max(0, groups - 1) * OTHER_PANE;

/**
 * The groups' shares of `room` px as they are drawn with the column beside them: the group at
 * `at`, the Note's, keeps `NOTE_PANE` and its scrollbar's room at least, and every other group
 * `OTHER_PANE`, what they lack taken from the groups wider than they need, the widest giving most.
 * The shares the layout keeps, which come back as the column leaves, are not changed; the shares
 * given back sum to 1. Where `room` can't hold every group's least, which `columnFits` never lets
 * happen, they are given back as kept.
 */
export function sharesBeside(
  shares: readonly number[],
  at: number,
  room: number,
  scrollbar = 0,
): number[] {
  const total = shares.reduce((sum, share) => sum + share, 0);
  const least = shares.map((_, index) => (index === at ? NOTE_PANE + scrollbar : OTHER_PANE));
  if (at < 0 || total <= 0 || least.reduce((sum, each) => sum + each, 0) > room) {
    return [...shares];
  }
  const widths = shares.map((share) => (share / total) * room);
  const short = widths.reduce(
    (sum, width, index) => sum + Math.max(0, (least[index] ?? 0) - width),
    0,
  );
  if (short <= 0) return [...shares];
  const spare = widths.map((width, index) => Math.max(0, width - (least[index] ?? 0)));
  const all = spare.reduce((sum, each) => sum + each, 0);
  return widths.map(
    (width, index) =>
      (Math.max(width, least[index] ?? 0) - (short * (spare[index] ?? 0)) / all) / room,
  );
}

/**
 * The room a scrollbar takes beside a scrolling pane, where scrollbars take room rather than
 * overlay the text (Windows, most Linux desktops): 0 where they overlay (macOS by default).
 */
export function scrollbarRoom(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position: absolute; visibility: hidden; width: 100px; overflow: scroll";
  document.body.append(probe);
  const room = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return room;
}
