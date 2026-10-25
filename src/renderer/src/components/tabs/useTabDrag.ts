import { type PointerEvent, useRef } from "react";
import { MAX_TAB_GROUPS } from "../../../../core/api";
import {
  type Dragged,
  type Dropped,
  useDragSource,
  useDragState,
  useDropTarget,
} from "../../dragDrop";
import { groupOfTab } from "../../layoutSlice";
import { useAppStore } from "../../store";

/*
 * Dragging a tab, as in VS Code and Chrome: within its strip to reorder, onto
 * another group's strip to move it there (an insertion line shows where), or
 * onto a group's body: its outer 30% splits off a new group on that side (the
 * half it will take lights up), its middle moves it into that group. The
 * tab's menu has the same moves (Move to the left or right group, Open to the
 * side), and ⌥⌘\ splits from the keyboard. It goes through the drag layer,
 * the tab travelling as an object of its own that only the groups take.
 */

/** The share of a group's width, from each side, that splits rather than moves. */
const EDGE = 0.3;

export type DropTarget =
  | { type: "strip"; groupId: string; before: string | null; x: number; top: number }
  | {
      type: "zone";
      groupId: string;
      zone: "left" | "right" | "center";
      rect: { left: number; top: number; width: number; height: number };
      /** An edge, with three groups already: it moves rather than splits. */
      full: boolean;
    };

/** Where a tab dragged to (x, y) would go, or null where it can't be dropped. */
function dropTargetAt(x: number, y: number, tabId: string, merged: boolean): DropTarget | null {
  const { layout } = useAppStore.getState();
  if (!layout) return null;
  const under = document.elementFromPoint(x, y);
  const strip = under?.closest<HTMLElement>('[data-testid="tab-strip"]');
  if (strip) {
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
    let index = tabs.findIndex((tab) => {
      const box = tab.getBoundingClientRect();
      return x < box.left + box.width / 2;
    });
    if (index === -1) index = tabs.length;
    const at = tabs[index];
    let before = at?.dataset.tabId ?? null;
    if (before === tabId) before = tabs[index + 1]?.dataset.tabId ?? null;
    // Merged, one strip holds every group's tabs: a tab lands in the group of the tab it goes before.
    const groupId = merged
      ? ((before && groupOfTab(layout, before)?.group.id) ?? layout.groups.at(-1)?.id)
      : strip.dataset.groupId;
    if (!groupId) return null;
    const stripBox = strip.getBoundingClientRect();
    const last = tabs.at(-1)?.getBoundingClientRect();
    const lineX = at ? at.getBoundingClientRect().left : (last?.right ?? stripBox.left + 6);
    return {
      type: "strip",
      groupId,
      before,
      x: Math.max(stripBox.left + 2, Math.min(lineX, stripBox.right - 4)),
      top: stripBox.top + 4,
    };
  }
  const body = under?.closest<HTMLElement>("[data-group-body]");
  const groupId = body?.dataset.groupBody;
  if (!body || !groupId || merged) return null;
  const box = body.getBoundingClientRect();
  const across = (x - box.left) / box.width;
  const edge = across < EDGE ? "left" : across > 1 - EDGE ? "right" : null;
  const full = edge !== null && layout.groups.length >= MAX_TAB_GROUPS;
  const zone = edge && !full ? edge : "center";
  const own = groupOfTab(layout, tabId)?.group;
  // Its own group's middle, or either side of a group it is alone in: nowhere to go.
  if (own?.id === groupId && (zone === "center" || own.tabs.length === 1)) return null;
  return {
    type: "zone",
    groupId,
    zone,
    rect: { left: box.left, top: box.top, width: box.width, height: box.height },
    full,
  };
}

function drop(tabId: string, target: DropTarget): void {
  const { changeLayout } = useAppStore.getState();
  if (target.type === "strip") {
    void changeLayout({ type: "move", tabId, groupId: target.groupId, before: target.before });
  } else if (target.zone === "center") {
    void changeLayout({ type: "move", tabId, groupId: target.groupId, before: null });
  } else {
    void changeLayout({
      type: "split",
      tabId,
      side: target.zone,
      copy: false,
      groupId: target.groupId,
    });
  }
}

const tabIn = (dragged: Dragged | Dropped): string | null => {
  if (dragged.kind !== "objects" || dragged.refs.length !== 1) return null;
  const [ref] = dragged.refs;
  return ref?.kind === "tab" ? ref.id : null;
};

export function useTabDrag(merged: boolean) {
  const draggedTabId = useDragState((state) => {
    const [ref] = state.source?.refs ?? [];
    return ref?.kind === "tab" ? ref.id : null;
  });
  const target = useDropTarget<DropTarget>("tab-groups", {
    accepts(dragged, at) {
      const tabId = tabIn(dragged);
      const place = tabId ? dropTargetAt(at.x, at.y, tabId, merged) : null;
      return place ? { kind: "move", place } : null;
    },
    drop(dropped, effect) {
      const tabId = tabIn(dropped);
      if (tabId && effect.place) drop(tabId, effect.place);
    },
  });
  return { draggedTabId, target: target.over?.place ?? null, dropProps: target.props };
}

export type TabDrag = ReturnType<typeof useTabDrag>;

/** A tab as the source of its drag; its buttons and its name being typed aren't handles. */
export function useTabSource(tabId: string, title: string) {
  const pressedOn = useRef<Element | null>(null);
  const source = useDragSource(() =>
    pressedOn.current?.closest('button, input, [role="menu"]')
      ? null
      : { refs: [{ kind: "tab", id: tabId }], name: title },
  );
  return {
    ...source,
    onPointerDown(event: PointerEvent<HTMLElement>) {
      pressedOn.current = event.target as Element;
    },
  };
}
