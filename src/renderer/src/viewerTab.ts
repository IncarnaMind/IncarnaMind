import { useAppStore } from "./store";
import { findTab } from "./tabs";

/** The tab whose viewer shows `documentId`, by the layout's groups, or null when none does. */
export function viewerTabOf(documentId: string): string | null {
  const layout = useAppStore.getState().layout;
  if (!layout) return null;
  for (const group of layout.groups) {
    const tab = group.activeTabId ? findTab(layout, group.activeTabId) : null;
    if (tab?.item.kind === "document" && tab.item.documentId === documentId) return tab.id;
  }
  return null;
}
