import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { create } from "zustand";
import type { ChangeItem, ReviewItem } from "./editor/theirChanges";
import { heldByMind } from "./heldByMind";

/** Under a Mind this wide the pane folds to its button (DESIGN.md, the reviewing pane). */
export const NARROWEST_MIND = 760;

export type ReviewFilter = "all" | "unresolved";

export interface ReviewPaneState {
  /** Open at the page's right edge while the Mind is too narrow to have it beside; else folded to its button. */
  over: boolean;
  /** Null until the User picks: Unresolved once anything has been decided, else All. */
  filter: ReviewFilter | null;
  /** The author shown (`authorKey`); null for everyone. */
  who: string | null;
  selected: string | null;
  /**
   * The changes decided one by one from the pane, most recent last: the one
   * Undo makes wait again is selected again.
   */
  decided: readonly string[];
  /** Counts the times it was asked to open, so it takes the focus each time. */
  opened: number;
}

interface ReviewPanes {
  panes: Readonly<Record<string, ReviewPaneState>>;
  open(mindId: string): void;
  close(mindId: string): void;
  update(mindId: string, patch: Partial<ReviewPaneState>): void;
}

const CLOSED: ReviewPaneState = {
  over: false,
  filter: null,
  who: null,
  selected: null,
  decided: [],
  opened: 0,
};

/** Which Minds show their reviewing pane (#697), and what it shows. */
export const useReviewPanes = create<ReviewPanes>((set) => ({
  panes: {},
  open: (mindId) =>
    set((state) => {
      const pane = state.panes[mindId];
      return {
        panes: {
          ...state.panes,
          [mindId]: { ...(pane ?? CLOSED), over: true, opened: (pane?.opened ?? 0) + 1 },
        },
      };
    }),
  close: (mindId) =>
    set((state) => {
      const { [mindId]: _closed, ...rest } = state.panes;
      return { panes: rest };
    }),
  update: (mindId, patch) =>
    set((state) => {
      const pane = state.panes[mindId];
      return pane ? { panes: { ...state.panes, [mindId]: { ...pane, ...patch } } } : state;
    }),
}));

/** The key an author is filtered by: the name, or "" for someone the file doesn't name. */
export const authorKey = (author: string | null): string => author ?? "";

export const isDecided = (item: Pick<ReviewItem, "kind"> & { state?: ChangeItem["state"] }) =>
  item.kind === "change" && (item.state === "accepted" || item.state === "rejected");

/** The filter a pane shows: the one the User picked, else Unresolved once anything has been decided. */
export function filterOf(
  pane: Pick<ReviewPaneState, "filter"> | undefined,
  items: readonly (Pick<ReviewItem, "kind"> & { state?: ChangeItem["state"] })[],
): ReviewFilter {
  return pane?.filter ?? (items.some(isDecided) ? "unresolved" : "all");
}

type Listed = Pick<ReviewItem, "kind" | "author"> & { state?: ChangeItem["state"] };

const inFilterOf = (filter: ReviewFilter) => (item: Listed) => filter === "all" || !isDecided(item);

/** The author a pane shows, or null for everyone: also once the filter shows nothing of theirs. */
export function authorShown(
  items: readonly Listed[],
  pane: Pick<ReviewPaneState, "filter" | "who"> | undefined,
): string | null {
  const who = pane?.who ?? null;
  const inFilter = inFilterOf(filterOf(pane, items));
  return who !== null && items.some((item) => inFilter(item) && authorKey(item.author) === who)
    ? who
    : null;
}

/** The cards a pane shows, by its filter and its author. */
export function shownIn<T extends Listed>(
  items: readonly T[],
  pane: Pick<ReviewPaneState, "filter" | "who"> | undefined,
): T[] {
  const inFilter = inFilterOf(filterOf(pane, items));
  const who = authorShown(items, pane);
  return items.filter((item) => inFilter(item) && (who === null || authorKey(item.author) === who));
}

const reviewables = heldByMind<{ editor: Editor; has(): boolean; open(): void }>();
export const useReviewables = reviewables.use;
export const holdReviewable = reviewables.hold;

/**
 * Whether the Mind, `row`, is wide enough to have the pane beside its page:
 * else it folds to "Changes ({n})", which opens it at the page's right edge.
 */
export function useRoomBeside(row: HTMLElement | null): boolean {
  const [beside, setBeside] = useState(true);
  useEffect(() => {
    if (!row) return;
    const measure = () => setBeside(row.clientWidth >= NARROWEST_MIND);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [row]);
  return beside;
}
