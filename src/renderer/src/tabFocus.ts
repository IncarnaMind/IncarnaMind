import type { TabItem, WindowLayout } from "../../core/api";
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

function focusOnceDrawn(find: () => HTMLElement | null, from?: Element | null): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (from !== undefined && active !== from && active !== document.body) return;
    find()?.focus();
  });
}

/**
 * Moves the keyboard's focus to a tab once it is drawn. With `onlyIfLost`, only if the focus
 * is nowhere by then. With `from`, a place the User focused since the request keeps the focus.
 */
export function focusTab(
  tabId: string | null | undefined,
  { onlyIfLost = false, from }: { onlyIfLost?: boolean; from?: Element | null } = {},
): void {
  forgetContentFocus();
  if (!tabId) return;
  focusOnceDrawn(
    () => document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"]`),
    onlyIfLost ? document.body : from,
  );
}

/** The Note's text drawn in each tab, as what puts the focus in it where the cursor was. */
const contentTakers = new Map<string, () => void>();
/** The tab whose Note is to take the focus once drawn, and where the focus was when that was asked. */
let contentWanted: { tabId: string; origin: Element | null } | null = null;

/**
 * A click on a tab, or a shortcut that shows one, puts the focus in what it shows (#3115): a Note's
 * text, its cursor where it was, now or once its editor is drawn. No other tab's content takes the
 * focus when it opens, so the focus stays on the tab itself. A place the User focused meanwhile
 * keeps it.
 */
export function focusShownContent(tabId: string, kind: TabItem["kind"]): void {
  if (typeof document === "undefined") return;
  contentWanted = null;
  if (kind !== "mind") {
    focusTab(tabId);
    return;
  }
  const take = contentTakers.get(tabId);
  if (take) take();
  else contentWanted = { tabId, origin: document.activeElement };
}

/**
 * The keyboard is on the tabs now: what a click or shortcut asked of a tab's content no longer
 * holds, so a Note drawn later, as when its copy could only open later, leaves the focus there.
 */
export function forgetContentFocus(): void {
  contentWanted = null;
}

/** The Note's text drawn in `tabId` takes the focus asked of the tab, until the function this returns is called. */
export function takeContentFocus(tabId: string, focus: () => void): () => void {
  contentTakers.set(tabId, focus);
  const wanted = contentWanted;
  if (wanted?.tabId === tabId) {
    contentWanted = null;
    // The place the focus was asked from may have gone with the tab's last content.
    const now = document.activeElement;
    if (now === wanted.origin || now === document.body || now === null) focus();
  }
  return () => {
    if (contentTakers.get(tabId) === focus) contentTakers.delete(tabId);
  };
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
        // Its cursor is where the User left it (#3115): coming back to it scrolls nothing.
        editor.focus({ preventScroll: true });
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
    }, document.body);
  };
}
