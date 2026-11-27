import type { LayoutChange, LayoutGroup, LayoutTab, TabItem, WindowLayout } from "../core/api";

/** Items that have at most one tab per window: revealed wherever they are open. */
export const oneTabEach = (item: TabItem): item is { kind: "library" } | { kind: "home" } =>
  item.kind === "library" || item.kind === "home";

export const sameTabItem = (a: TabItem, b: TabItem): boolean =>
  a.kind === b.kind &&
  (a.kind === "mind" || a.kind === "figures"
    ? a.mindId === (b as typeof a).mindId
    : a.kind === "document"
      ? a.documentId === (b as typeof a).documentId
      : a.kind === "canvas"
        ? a.canvasId === (b as typeof a).canvasId
        : true);

/** Where `item` is open in `layout`, searching the focused group first. */
export function findOpenTab(
  layout: Pick<WindowLayout, "groups" | "focusedGroupId">,
  item: TabItem,
): { group: LayoutGroup; tab: LayoutTab } | null {
  const focused =
    layout.groups.find((group) => group.id === layout.focusedGroupId) ?? layout.groups[0];
  if (!focused) return null;
  for (const group of [focused, ...layout.groups.filter((each) => each !== focused)]) {
    const tab = group.tabs.find((each) => sameTabItem(each.item, item));
    if (tab) return { group, tab };
  }
  return null;
}

/**
 * The next layout when `change` only reveals a tab that is already open (`show`, or an in-place
 * `open` of a single-tab item such as Library or Home with no `behind` or `place`), or null when
 * the change creates, moves, or updates a tab or is already shown.
 */
export function revealExistingTab(layout: WindowLayout, change: LayoutChange): WindowLayout | null {
  let target: { group: LayoutGroup; tab: LayoutTab; focus: boolean } | null = null;
  if (change.type === "show") {
    for (const group of layout.groups) {
      const tab = group.tabs.find((each) => each.id === change.tabId);
      if (tab) {
        target = { group, tab, focus: true };
        break;
      }
    }
  } else if (
    change.type === "open" &&
    !change.behind &&
    !change.place &&
    (change.where === undefined || change.where.in === "place") &&
    oneTabEach(change.item)
  ) {
    const found = findOpenTab(layout, change.item);
    if (found) target = { ...found, focus: change.focus !== false };
  }
  if (!target) return null;
  const focusedGroupId = target.focus ? target.group.id : layout.focusedGroupId;
  if (target.group.activeTabId === target.tab.id && layout.focusedGroupId === focusedGroupId) {
    return null;
  }
  return {
    ...layout,
    focusedGroupId,
    groups: layout.groups.map((group) =>
      group.id === target.group.id ? { ...group, activeTabId: target.tab.id } : group,
    ),
  };
}
