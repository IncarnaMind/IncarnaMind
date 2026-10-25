import type { WindowLayout } from "../../core/api";
import { activeTabOf, focusedGroupOf, groupOfTab, groupsMerged } from "./layoutSlice";

let pending: {
  groupId: string;
  tabId: string;
  finish(): void;
  stop(): void;
} | null = null;

export function resumeTabCloseFocus(): void {
  pending?.finish();
}

export function forgetTabCloseFocus(groupId: string, tabId: string | null): void {
  if (pending?.groupId === groupId && pending.tabId === tabId) pending.stop();
}

function focusOnceDrawn(find: () => HTMLElement | null, onlyIfLost: boolean): void {
  requestAnimationFrame(() => {
    if (onlyIfLost && document.activeElement !== document.body) return;
    find()?.focus();
  });
}

/**
 * Moves the keyboard's focus to a tab once it is drawn. With `onlyIfLost`, only if the focus
 * is nowhere by then: a field the User has moved to since keeps it.
 */
export function focusTab(
  tabId: string | null | undefined,
  { onlyIfLost = false }: { onlyIfLost?: boolean } = {},
): void {
  if (!tabId) return;
  focusOnceDrawn(
    () => document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"]`),
    onlyIfLost,
  );
}

/** Captures a closing tab's focus before its layout change removes the focused element (#1309). */
export function returnFocusAfterTabClose(
  tabId: string,
  before: WindowLayout | null,
): (after: WindowLayout) => void {
  pending?.stop();
  const group = groupOfTab(before, tabId)?.group;
  const origin = document.activeElement;
  const onTab = origin?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId === tabId;
  const inPage =
    group?.activeTabId === tabId &&
    origin?.closest<HTMLElement>("[data-group-body]")?.dataset.groupBody === group.id;
  const inEditor = inPage && origin?.closest('[data-testid="mind-editor"]') !== null;
  return (after) => {
    if (!group || (!onTab && !inPage)) return;
    const next =
      (!groupsMerged() && after.groups.find((each) => each.id === group.id)) ||
      focusedGroupOf(after);
    const nextTab = activeTabOf(next);
    if (inEditor && nextTab?.item.kind === "mind") {
      let frame: number | undefined;
      const stop = () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        document.removeEventListener("focusin", stop, true);
        document.removeEventListener("pointerdown", stop, true);
        document.removeEventListener("keydown", stop, true);
        if (pending?.finish === finish) pending = null;
      };
      const finish = () => {
        if (pending?.finish !== finish) return;
        if (document.activeElement === origin && origin?.isConnected) return;
        if (document.activeElement !== document.body) {
          stop();
          return;
        }
        const tab = document.querySelector<HTMLElement>(
          `[data-tab-id="${CSS.escape(nextTab.id)}"][aria-selected="true"]`,
        );
        if (!tab) return;
        const pane = tab.closest<HTMLElement>('[data-testid="tab-group"]');
        if (pane?.dataset.groupId !== next.id) {
          stop();
          return;
        }
        const editor = pane.querySelector<HTMLElement>('[data-testid="mind-editor"]');
        if (!editor) return;
        stop();
        editor.focus();
      };
      pending = { groupId: next.id, tabId: nextTab.id, finish, stop };
      document.addEventListener("focusin", stop, true);
      document.addEventListener("pointerdown", stop, true);
      document.addEventListener("keydown", stop, true);
      frame = requestAnimationFrame(finish);
      return;
    }
    focusOnceDrawn(() => {
      const pane = document.querySelector<HTMLElement>(
        `[data-testid="tab-group"][data-group-id="${CSS.escape(next.id)}"]`,
      );
      return (
        (next.activeTabId
          ? document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.activeTabId)}"]`)
          : pane?.querySelector<HTMLElement>('[data-testid="new-tab"]')) ?? null
      );
    }, true);
  };
}
