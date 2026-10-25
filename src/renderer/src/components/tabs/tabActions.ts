import {
  type LayoutChange,
  type LayoutGroup,
  type LayoutTab,
  MAX_TAB_GROUPS,
  type WindowLayout,
} from "../../../../core/api";
import { shortcutLabel } from "../../commands/keymap";
import { activeTabOf, focusedGroupOf, groupOfTab, groupsMerged } from "../../layoutSlice";
import { useAppStore } from "../../store";
import { focusTab } from "../../tabFocus";
import { tabTitle } from "../../tabs";
import { type Undoable, UndoRefused } from "../../undo";

/*
 * What the tab commands and buttons do beyond one change to the layout: they
 * say why nothing happened, and move the keyboard's focus with the tab.
 */

/** ⌥⌘\: a copy of a tab (the shown one by default) in a new group on the right. */
export async function splitToTheRight(tabId?: string): Promise<void> {
  const store = useAppStore.getState();
  const { layout } = store;
  if (!layout) return;
  const tab = tabId ?? activeTabOf(focusedGroupOf(layout))?.id;
  if (!tab) return;
  if (layout.groups.length >= MAX_TAB_GROUPS) {
    store.showTabNotice({ kind: "maxGroups" });
    return;
  }
  const next = await store.changeLayout({ type: "split", tabId: tab, side: "right", copy: true });
  if (!next) return;
  if (groupsMerged()) store.showTabNotice({ kind: "merged" });
  focusTab(activeTabOf(focusedGroupOf(next))?.id);
}

/** ⌘1–⌘3: the keyboard's focus to a group's shown tab. */
export async function focusGroup(number: number): Promise<void> {
  const store = useAppStore.getState();
  const group = store.layout?.groups[number - 1];
  if (!group) {
    store.showTabNotice({ kind: "noGroup", group: number, shortcut: shortcutLabel("tab.split") });
    return;
  }
  const next = await store.changeLayout({ type: "focus", groupId: group.id });
  if (next) focusTab(group.activeTabId);
}

/** Moves a tab to the group on its left or right, or into a new group on the right. */
export async function moveToGroup(tabId: string, direction: -1 | 1): Promise<void> {
  const store = useAppStore.getState();
  const at = groupOfTab(store.layout, tabId);
  if (!at || !store.layout) return;
  const target = store.layout.groups[at.index + direction];
  const next = target
    ? await store.changeLayout({ type: "move", tabId, groupId: target.id, before: null })
    : await store.changeLayout({ type: "split", tabId, side: "right", copy: false });
  if (next) focusTab(tabId);
}

/** The tabs either side of a tab in its group, by ID. */
interface Neighbours {
  left: string | null;
  right: string | null;
}

function neighboursOf(group: LayoutGroup, tab: LayoutTab): Neighbours {
  const place = group.tabs.indexOf(tab);
  return { left: group.tabs[place - 1]?.id ?? null, right: group.tabs[place + 1]?.id ?? null };
}

/**
 * A neighbour that has closed gives way to the other one; with both gone the place is gone too,
 * so Undo refuses rather than put the tab somewhere else.
 */
async function moveTabBetween(tabId: string, place: Neighbours): Promise<void> {
  const store = useAppStore.getState();
  const at = groupOfTab(store.layout, tabId);
  if (!at) throw new UndoRefused((t) => t("undo.tabClosed"), null);
  const others = at.group.tabs.filter((each) => each.id !== tabId);
  const right = others.findIndex((each) => each.id === place.right);
  const left = others.findIndex((each) => each.id === place.left);
  let before: string | null;
  if (right !== -1) before = place.right;
  else if (left !== -1) before = others[left + 1]?.id ?? null;
  else if (place.left === null) before = others[0]?.id ?? null;
  else if (place.right === null) before = null;
  else throw new UndoRefused((t) => t("undo.tabNeighboursClosed"), null);
  const next = await store.changeLayout({ type: "move", tabId, groupId: at.group.id, before });
  if (!next) throw new UndoRefused((t) => t("undo.tabMoveRefused"), null);
}

/** The tab next to this one in the same run of pinned or unpinned tabs: none across that line. */
export function neighbourInRun(tabs: LayoutTab[], tab: LayoutTab, step: -1 | 1): LayoutTab | null {
  const neighbour = tabs[tabs.indexOf(tab) + step];
  return neighbour && neighbour.pinned === tab.pinned ? neighbour : null;
}

/**
 * Moves a tab one place earlier or later among its group's tabs, only among those pinned as it
 * is, shows it and offers Undo.
 */
export async function moveWithinGroup(tabId: string, step: -1 | 1): Promise<Undoable | undefined> {
  const store = useAppStore.getState();
  const at = groupOfTab(store.layout, tabId);
  const tab = at?.group.tabs.find((each) => each.id === tabId);
  if (!at || !tab) return;
  const tabs = at.group.tabs;
  const place = tabs.indexOf(tab);
  const neighbour = neighbourInRun(tabs, tab, step);
  if (!neighbour) return;
  const before = step === -1 ? neighbour.id : (tabs[place + 2]?.id ?? null);
  const from = neighboursOf(at.group, tab);
  const next = await store.changeLayout({ type: "move", tabId, groupId: at.group.id, before });
  if (!next) return;
  const movedAt = groupOfTab(next, tabId);
  const moved = movedAt?.group.tabs.find((each) => each.id === tabId);
  if (!movedAt || !moved) return;
  focusTab(tabId);
  return {
    said: (t) =>
      t(step === -1 ? "undo.tabMovedLeft" : "undo.tabMovedRight", {
        name: tabTitle(useAppStore.getState(), tab.item, t),
      }),
    name: (t) => t("undo.name.tabMove"),
    undo: () => moveTabBetween(tabId, from),
    redo: () => moveTabBetween(tabId, neighboursOf(movedAt.group, moved)),
  };
}

const openTabs = (layout: WindowLayout | null) =>
  layout?.groups.reduce((sum, group) => sum + group.tabs.length, 0) ?? 0;

/** Closes tabs, then says how many, with Reopen. */
export async function closeSome(change: LayoutChange, tab: LayoutTab): Promise<void> {
  const store = useAppStore.getState();
  // Not from `reopenable`, which stops growing once it holds as many as the core keeps.
  const before = openTabs(store.layout);
  const next = await store.changeLayout(change);
  const count = next ? before - openTabs(next) : 0;
  if (count > 0) store.showTabNotice({ kind: "closed", item: tab.item, count });
}

/** Shows the next or previous tab of the focused group (Ctrl+Tab, Ctrl+Shift+Tab). */
export function cycleTabs(step: 1 | -1): void {
  const store = useAppStore.getState();
  if (!store.layout) return;
  const group = focusedGroupOf(store.layout);
  if (group.tabs.length === 0) return;
  const index = group.tabs.findIndex((tab) => tab.id === group.activeTabId);
  const next = group.tabs[(index + step + group.tabs.length) % group.tabs.length];
  if (next) void store.changeLayout({ type: "show", tabId: next.id });
}

/**
 * The focused group's tab at this place from 1, or its last for 9 (⌃1–⌃9); null where there is
 * none. With the groups merged, their one strip holds every group's tabs, as the User sees them.
 */
export function tabByNumber(number: number): LayoutTab | null {
  const { layout } = useAppStore.getState();
  if (!layout) return null;
  const tabs = groupsMerged()
    ? layout.groups.flatMap((group) => group.tabs)
    : focusedGroupOf(layout).tabs;
  return (number === 9 ? tabs.at(-1) : tabs[number - 1]) ?? null;
}

export async function showTabByNumber(number: number): Promise<void> {
  const tab = tabByNumber(number);
  if (tab) await useAppStore.getState().changeLayout({ type: "show", tabId: tab.id });
}
