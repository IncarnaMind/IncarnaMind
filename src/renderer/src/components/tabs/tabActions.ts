import {
  type LayoutChange,
  type LayoutTab,
  MAX_TAB_GROUPS,
  type WindowLayout,
} from "../../../../core/api";
import { shortcutLabel } from "../../commands/keymap";
import { activeTabOf, focusedGroupOf, groupOfTab, groupsMerged } from "../../layoutSlice";
import { useAppStore } from "../../store";
import { focusTab } from "../../tabFocus";

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
