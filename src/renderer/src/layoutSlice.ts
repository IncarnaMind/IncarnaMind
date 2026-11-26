import { create } from "zustand";
import type {
  AssistantPlace,
  LayoutChange,
  LayoutGroup,
  LayoutTab,
  TabItem,
  WindowLayout,
} from "../../core/api";
import { revealExistingTab } from "../../shared/layoutReveal";
import { groupsMergedAt } from "./assistantPlace";
import { core, files } from "./core";

/*
 * The window's tabs and groups, as the core keeps them (see src/core/layout.ts):
 * the store holds the core's last word on them, and changes them only
 * through the bridge.
 */

/** Which window this is: the main process names it in the page's address. */
export const WINDOW_ID =
  new URLSearchParams(globalThis.location?.search ?? "").get("window") ?? "main";

/**
 * The card's width as last measured, which the groups share (null until it is), with how many
 * groups the window has and what the first one's strip keeps before its tabs.
 */
export const useCardWidth = create<{ width: number | null; groups: number; lead: number }>()(
  () => ({ width: null, groups: 1, lead: 0 }),
);

/**
 * What the first group's strip keeps before its tabs (`.tab-strip > .sidebar-toggle` in
 * styles.css): the sidebar's 28px button with its 8px and 6px, and on macOS, where the button
 * stands in the sidebar while it shows, the traffic lights' 76px beside it while it is hidden.
 */
export const firstGroupLead = (sidebarHidden: boolean): number =>
  files.titleBar !== "inset" ? 42 : sidebarHidden ? 76 + 34 : 0;

/**
 * Whether there is no room for groups side by side right now: the window is
 * narrow, or the card is (`groupsMergedAt`).
 */
export const groupsMerged = () => {
  const { width, groups, lead } = useCardWidth.getState();
  return groupsMergedAt(window.innerWidth, width, groups, lead);
};

/** A line about the tabs, shown in the sidebar foot's one slot. */
export type TabNotice =
  | { kind: "closed"; item: TabItem; count: number }
  | { kind: "maxGroups" }
  | { kind: "noGroup"; group: number; shortcut: string }
  | { kind: "pinned"; item: TabItem }
  | { kind: "merged" }
  /** A side dock chosen in a narrow window: it stays at the bottom until the window is wider. */
  | { kind: "assistantNarrow" };

export interface LayoutSlice {
  /** Null until loaded. */
  layout: WindowLayout | null;
  /** The tab whose name is being typed in it, if any. */
  renamingTabId: string | null;
  /** Reads the window's layout from the core, as it was left. */
  loadLayout(): Promise<void>;
  /**
   * Changes the layout through the core; resolves with it once the store has it (null if refused).
   * `quiet` where the caller says the failure where it happened, as Undo does in its own line.
   */
  changeLayout(change: LayoutChange, options?: { quiet?: boolean }): Promise<WindowLayout | null>;
  /**
   * Moves, resizes, folds or unfolds the assistant: shown at once, then kept
   * through the core (and put back as the core has it if it refuses). A fold or an unfold is the
   * User's own unless `foldedBy` says otherwise.
   */
  placeAssistant(place: Partial<AssistantPlace>): Promise<void>;
  /** Starts typing a tab's name in it, or stops (null). */
  renameTab(tabId: string | null): void;
}

type Set = (partial: Partial<LayoutSlice>) => void;
type Get = () => LayoutSlice;

/** How many times the assistant was placed in this window, to tell the latest answer. */
let placings = 0;
/** How many layout changes have started, so an older answer never reverts a newer tab switch. */
let layoutChanges = 0;

export function createLayoutSlice(
  set: Set,
  get: Get,
  report: (error: unknown) => void,
): LayoutSlice {
  /** Last layout confirmed by the core, used to roll back a refused optimistic tab switch. */
  let confirmed: WindowLayout | null = null;
  let inFlightOptimistic = 0;
  /**
   * For the core's answer to what is asked now: its assistant is older than a placing made since,
   * which is shown already and kept.
   */
  const keepPlacingsSince = (): ((answered: WindowLayout) => WindowLayout) => {
    const asked = placings;
    return (answered) => {
      const shown = get().layout?.assistant;
      return placings === asked || !shown ? answered : { ...answered, assistant: shown };
    };
  };
  return {
    layout: null,
    renamingTabId: null,
    async loadLayout() {
      const keep = keepPlacingsSince();
      const layout = keep(await core.getLayout(WINDOW_ID));
      confirmed = layout;
      set({ layout });
    },
    async changeLayout(change, options) {
      const keep = keepPlacingsSince();
      const previous = get().layout;
      const fallback = inFlightOptimistic === 0 ? previous : (confirmed ?? previous);
      const immediate = previous ? revealExistingTab(previous, change) : null;
      const changeId = ++layoutChanges;
      if (immediate) {
        if (inFlightOptimistic === 0) confirmed = previous;
        inFlightOptimistic += 1;
        set({ layout: immediate });
      }
      try {
        const layout = keep(await core.changeLayout(WINDOW_ID, change));
        confirmed = layout;
        if (changeId === layoutChanges) set({ layout });
        return layout;
      } catch (error) {
        if (immediate && fallback && changeId === layoutChanges) set({ layout: keep(fallback) });
        if (!options?.quiet) report(error);
        return null;
      } finally {
        if (immediate) inFlightOptimistic -= 1;
      }
    },
    async placeAssistant(asked) {
      const layout = get().layout;
      if (!layout) return;
      const place: Partial<AssistantPlace> =
        asked.folded !== undefined && asked.foldedBy === undefined
          ? { ...asked, foldedBy: "user" }
          : asked;
      const placing = ++placings;
      set({ layout: { ...layout, assistant: { ...layout.assistant, ...place } } });
      try {
        const kept = await core.changeLayout(WINDOW_ID, { type: "assistant", place });
        confirmed = kept;
        // A later move is shown already: its own answer comes next.
        if (placing === placings) set({ layout: kept });
      } catch (error) {
        report(error);
        if (placing === placings) await get().loadLayout().catch(report);
      }
    },
    renameTab(tabId) {
      set({ renamingTabId: tabId });
    },
  };
}

/** Follows the core's word on this window's layout, e.g. when a deleted Mind's tab closes. */
export function followLayout(set: Set, report: (error: unknown) => void): void {
  core.on("layout.changed", ({ windowId }) => {
    if (windowId !== WINDOW_ID) return;
    // The event can reach the window after the answers to placings already shown, so the layout
    // is read afresh. It is applied only if no placing of the assistant started after the event:
    // that placing is shown already, and its own answer brings the core's word.
    const asked = placings;
    const seenChange = layoutChanges;
    core.getLayout(WINDOW_ID).then((layout) => {
      if (placings === asked && layoutChanges === seenChange) set({ layout });
    }, report);
  });
}

// ---------------------------------------------------------------------------
// Reading a layout.

export const focusedGroupOf = (layout: WindowLayout): LayoutGroup =>
  (layout.groups.find((group) => group.id === layout.focusedGroupId) ??
    layout.groups[0]) as LayoutGroup;

export const activeTabOf = (group: LayoutGroup | undefined): LayoutTab | null =>
  group?.tabs.find((tab) => tab.id === group.activeTabId) ?? null;

/** The tab the User is in: the focused group's shown tab. */
export const currentTabOf = (layout: WindowLayout | null): LayoutTab | null =>
  layout ? activeTabOf(focusedGroupOf(layout)) : null;

/** The groups on screen: all of them, or only the focused one while they are merged. */
export const visibleGroupsOf = (layout: WindowLayout, merged: boolean): LayoutGroup[] =>
  merged ? [focusedGroupOf(layout)] : layout.groups;

/**
 * The Mind the User is in: the focused group's, else the first Mind shown in
 * a group. Null when no group shows a Mind.
 */
export function currentMindIdOf(layout: WindowLayout | null): string | null {
  if (!layout) return null;
  const shown = [focusedGroupOf(layout), ...layout.groups].map((group) => activeTabOf(group));
  const mind = shown.find((tab) => tab?.item.kind === "mind")?.item;
  return mind?.kind === "mind" ? mind.mindId : null;
}

/** Whether two tabs show the same place: the same Note or its figures, Document, Canvas, Library or Home. */
export function sameTabItem(a: TabItem | null, b: TabItem | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "mind":
    case "figures":
      return b.kind === a.kind && a.mindId === b.mindId;
    case "document":
      return b.kind === "document" && a.documentId === b.documentId;
    case "canvas":
      return b.kind === "canvas" && a.canvasId === b.canvasId;
    case "library":
    case "home":
      return true;
  }
}

function tabsOnScreenOf(layout: WindowLayout, merged: boolean): (LayoutTab | null)[] {
  const focused = focusedGroupOf(layout);
  const shown = [focused, ...visibleGroupsOf(layout, merged).filter((group) => group !== focused)];
  return shown.map((group) => activeTabOf(group));
}

/**
 * The Mind tab the assistant reads and asks in: the focused group's shown
 * tab when it is a Mind, else the first group on screen that shows a Mind
 * (a Document opened beside it, say). Null when no group on screen shows one.
 */
export function assistantTabOf(layout: WindowLayout | null, merged: boolean): LayoutTab | null {
  if (!layout) return null;
  return tabsOnScreenOf(layout, merged).find((tab) => tab?.item.kind === "mind") ?? null;
}

/** The Documents shown on screen, by id, the focused group's first: what "this document" means (#1334). */
export function documentsOnScreenOf(layout: WindowLayout | null, merged: boolean): string[] {
  if (!layout) return [];
  return tabsOnScreenOf(layout, merged).flatMap((tab) =>
    tab?.item.kind === "document" ? [tab.item.documentId] : [],
  );
}

export function frontTabOfMind(
  layout: WindowLayout | null,
  mindId: string,
  merged: boolean,
  accepts?: (tab: LayoutTab) => boolean,
): LayoutTab | null {
  if (!layout) return null;
  const focused = focusedGroupOf(layout);
  const shown = [focused, ...visibleGroupsOf(layout, merged).filter((group) => group !== focused)];
  return (
    shown
      .map((group) => activeTabOf(group))
      .find(
        (tab) =>
          tab?.item.kind === "mind" && tab.item.mindId === mindId && (accepts?.(tab) ?? true),
      ) ?? null
  );
}

/** Whether a group shows this, in its front tab. */
export function isShown(layout: WindowLayout | null, item: TabItem, merged = false): boolean {
  if (!layout) return false;
  return visibleGroupsOf(layout, merged).some((group) => {
    const tab = activeTabOf(group)?.item;
    if (!tab || tab.kind !== item.kind) return false;
    if (tab.kind === "mind") return item.kind === "mind" && tab.mindId === item.mindId;
    if (tab.kind === "document") {
      return item.kind === "document" && tab.documentId === item.documentId;
    }
    if (tab.kind === "canvas") return item.kind === "canvas" && tab.canvasId === item.canvasId;
    return true;
  });
}

/** Where a tab is: its group, and that group's place from the left. */
export function groupOfTab(
  layout: WindowLayout | null,
  tabId: string,
): { group: LayoutGroup; index: number } | null {
  if (!layout) return null;
  const index = layout.groups.findIndex((group) => group.tabs.some((tab) => tab.id === tabId));
  return index === -1 ? null : { group: layout.groups[index] as LayoutGroup, index };
}
