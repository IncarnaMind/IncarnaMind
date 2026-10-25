import type { LayoutTab, TabItem, WindowLayout } from "../../core/api";
import { displayName } from "../../shared/documentNames";
import { mindName } from "../../shared/naming";
import type { Translate } from "./objects";
import type { useAppStore } from "./store";

type AppState = ReturnType<typeof useAppStore.getState>;

export function tabTitle(state: AppState, item: TabItem, t: Translate): string {
  if (item.kind === "library") return t("library.title");
  if (item.kind === "home") return t("home.title");
  if (item.kind === "mind") {
    const mind = state.minds.find((each) => each.id === item.mindId);
    return (mind && mindName(mind)) || t("mind.untitled");
  }
  const document = state.documents.find((each) => each.id === item.documentId);
  return document ? displayName(document) : t("viewer.label");
}

export function findTab(layout: WindowLayout | null, tabId: string): LayoutTab | null {
  for (const group of layout?.groups ?? []) {
    const tab = group.tabs.find((each) => each.id === tabId);
    if (tab) return tab;
  }
  return null;
}
