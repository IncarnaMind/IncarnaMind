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
 * The least a Note keeps beside its column: about 490px of text, as Claude's page view keeps beside
 * its conversation, with the 40px gutter a narrow Note keeps on each side.
 */
const NOTE_PANE = 570;

/** The least every other group keeps beside the column: a Document's toolbar still fits whole. */
const OTHER_PANE = 400;

/**
 * Whether the column fits beside `groups` groups in a card `card` px wide: the Note it follows keeps
 * `NOTE_PANE` and every other group `OTHER_PANE`; when it doesn't, the conversation opens upward
 * from the input at the Note's foot.
 */
export const columnFits = (card: number | null, groups: number): boolean =>
  card !== null &&
  card - COLUMN_WIDTH - Math.max(0, groups - 1) >= NOTE_PANE + Math.max(0, groups - 1) * OTHER_PANE;

/**
 * The groups' shares of `room` px with the column beside them: the group at `at`, the Note's,
 * keeps `NOTE_PANE` at least, taken from the others as far as they are wider than `OTHER_PANE`,
 * the widest giving most. Shares as the layout keeps them, which sum to 1.
 */
export function sharesBeside(shares: readonly number[], at: number, room: number): number[] {
  const total = shares.reduce((sum, share) => sum + share, 0);
  if (at < 0 || room <= 0 || total <= 0) return [...shares];
  const widths = shares.map((share) => (share / total) * room);
  const short = Math.min(room, NOTE_PANE) - (widths[at] ?? 0);
  if (short <= 0) return [...shares];
  const spare = widths.map((width, index) => (index === at ? 0 : Math.max(0, width - OTHER_PANE)));
  const all = spare.reduce((sum, each) => sum + each, 0);
  const given = Math.min(short, all);
  return widths.map((width, index) =>
    index === at
      ? (width + given) / room
      : (width - (all > 0 ? (given * (spare[index] ?? 0)) / all : 0)) / room,
  );
}
