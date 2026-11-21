/**
 * What an outside agent made opens in a tab (#3534): behind the tab in front, as it always did for a
 * Note it wrote or a Canvas it published (#3406); in front, with the app, when the User asked that
 * agent from IncarnaMind and it read the request (the shell brings the window forward). The check
 * of a file handed over again takes the tab of an earlier version's check, as Show version does
 * (#3493), so the file stays one tab rather than one a version.
 */
import type { AgentOpened } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";

/** Where an earlier version's check of the file a Note checks is open: an unpinned tab. */
interface EarlierVersionTab {
  groupId: string;
  tabId: string;
  /** It is the tab its group shows. */
  shown: boolean;
}

async function earlierVersionTab(mindId: string): Promise<EarlierVersionTab | null> {
  const handed = await core.handedFileOf(mindId);
  if (!handed) return null;
  const earlier = new Set(
    handed.versions.flatMap((each) =>
      each.mindId !== null && each.mindId !== mindId ? [each.mindId] : [],
    ),
  );
  for (const group of useAppStore.getState().layout?.groups ?? []) {
    const tab = group.tabs.find(
      (each) => !each.pinned && each.item.kind === "mind" && earlier.has(each.item.mindId),
    );
    if (tab) return { groupId: group.id, tabId: tab.id, shown: group.activeTabId === tab.id };
  }
  return null;
}

async function openNote(mindId: string, front: boolean): Promise<void> {
  const earlier = await earlierVersionTab(mindId).catch((error: unknown) => {
    console.error(
      `The versions of the file Note ${mindId} checks couldn't be read; it opens in a tab of its own.`,
      error,
    );
    return null;
  });
  const { openMind, changeLayout } = useAppStore.getState();
  if (!earlier) {
    openMind(mindId, front ? { newTab: true } : { behind: true });
    return;
  }
  const next = await changeLayout({
    type: "open",
    item: { kind: "mind", mindId },
    where: { in: "group", groupId: earlier.groupId, before: earlier.tabId },
    ...(front ? {} : earlier.shown ? { focus: false } : { behind: true }),
  });
  const opened = next?.groups.some((group) =>
    group.tabs.some((tab) => tab.item.kind === "mind" && tab.item.mindId === mindId),
  );
  if (opened) await changeLayout({ type: "close", tabId: earlier.tabId });
}

function heardOpened({ item, front }: AgentOpened): void {
  const state = useAppStore.getState();
  if (front && state.settingsOpen) state.closeSettings();
  if (item.kind === "mind") {
    void openNote(item.mindId, front);
    return;
  }
  void state.changeLayout({
    type: "open",
    item: { kind: "canvas", canvasId: item.canvasId },
    where: { in: "group" },
    ...(!front && { behind: true }),
  });
}

export function installAgentOpened(): void {
  core.on("agents.opened", heardOpened);
}
