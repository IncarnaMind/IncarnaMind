import { useAppStore } from "./store";
import { findTab } from "./tabs";

/** The focused group's tab that shows `documentId`, or null when it doesn't. */
export function focusedViewerTabOf(documentId: string): string | null {
  const layout = useAppStore.getState().layout;
  if (!layout) return null;
  const group = layout.groups.find((each) => each.id === layout.focusedGroupId);
  return shownTab(group?.activeTabId ?? null, layout, documentId);
}

/** The viewer's tab that shows `documentId`: the focused group's first, then any group's. */
export function viewerTabOf(documentId: string): string | null {
  const focused = focusedViewerTabOf(documentId);
  if (focused) return focused;
  const layout = useAppStore.getState().layout;
  if (!layout) return null;
  for (const group of layout.groups) {
    const tab = shownTab(group.activeTabId, layout, documentId);
    if (tab) return tab;
  }
  return null;
}

function shownTab(
  tabId: string | null,
  layout: NonNullable<ReturnType<typeof useAppStore.getState>["layout"]>,
  documentId: string,
): string | null {
  const tab = tabId ? findTab(layout, tabId) : null;
  return tab?.item.kind === "document" && tab.item.documentId === documentId ? tab.id : null;
}
