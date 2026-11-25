import { Fragment, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { LayoutGroup } from "../../../../core/api";
import { useExportDialog } from "../../exportDialog";
import { useT } from "../../i18n";
import {
  activeTabOf,
  currentTabOf,
  focusedGroupOf,
  GROUP_MIN_WIDTH,
  useCardWidth,
} from "../../layoutSlice";
import { useShareDialog } from "../../shareDialog";
import { useAppStore } from "../../store";
import { forgetTabCloseFocus, resumeTabCloseFocus } from "../../tabFocus";
import { useGroupsMerged } from "../../useWindowWidth";
import { CanvasTab } from "../canvases/CanvasTab";
import { ExportDialog } from "../ExportDialog";
import { FigureScheduleTab } from "../figures/FigureScheduleTab";
import { HomePane } from "../home/HomePane";
import { LibraryPane } from "../LibraryPane";
import { ResizeRod } from "../ResizeRod";
import { ShareDialog } from "../ShareDialog";
import { DocumentTab } from "./DocumentTab";
import { MindTab, NoTabOpen } from "./MindTab";
import { TabStrip } from "./TabStrip";
import { TabPlaceContext } from "./tabItems";
import { type DropTarget, type TabDrag, useTabDrag } from "./useTabDrag";
import { columnFits, scrollbarRoom, sharesBeside, WindowColumnContext } from "./windowColumn";

/**
 * The card's content: up to three groups side by side, each with its tab
 * strip and its shown tab, split by one full-height divider that resizes them
 * (a double-click makes them equal). Below 1,000px they merge into one strip
 * holding every tab, and come back when the window is wider. Left of them, the
 * tab area's full height, the column a Note's conversation opens in, as the
 * page views of the User's AI apps have it (#3759).
 */
export function TabGroups() {
  const layout = useAppStore((state) => state.layout);
  const merged = useGroupsMerged();
  const drag = useTabDrag(merged);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const width = useWidth(container);
  /** Widths while a divider is dragged, before it is let go. */
  const [dragging, setDragging] = useState<number[] | null>(null);
  /**
   * Widths asked of the core and not yet answered, oldest first. The core answers in the order it
   * was asked, so the newest ask is the newest word, and it stays on screen until the last is
   * answered: an earlier answer is older than the key or drag that came after it.
   */
  const [asked, setAsked] = useState<readonly number[][]>([]);
  /** The Mind whose Export options sheet is open (⋯, ⌘K, or its References block's Export…). */
  const exporting = useExportDialog((state) => state.mindId);
  const exportMind = useAppStore((state) => state.minds.find((mind) => mind.id === exporting));
  /** The Mind whose Share sheet is open (Export › More formats, ⌘K). */
  const sharing = useShareDialog((state) => state.mindId);
  const shareMind = useAppStore((state) => state.minds.find((mind) => mind.id === sharing));
  const [scrollbar] = useState(scrollbarRoom);
  const column = useWindowColumn(merged, scrollbar);

  // A double-click on a divider makes the groups equal, as in VS Code.
  useEffect(() => {
    if (!container) return;
    const equalize = (event: MouseEvent) => {
      if ((event.target as Element).closest('[data-testid="group-divider"]')) {
        void useAppStore.getState().changeLayout({ type: "equalize" });
      }
    };
    container.addEventListener("dblclick", equalize);
    return () => container.removeEventListener("dblclick", equalize);
  }, [container]);

  if (!layout) return null;
  const groups = merged ? [focusedGroupOf(layout)] : layout.groups;
  const kept = dragging ?? asked.at(-1) ?? groups.map((group) => group.width);
  /** What the groups share: the card, less the 1px dividers. */
  const room = Math.max(0, width - (groups.length - 1));
  // Beside the column, its Note keeps a readable width, which the other groups give up first.
  const shares = column.value.drawn
    ? sharesBeside(
        kept,
        groups.findIndex((group) => group.activeTabId === column.value.tabId),
        room,
        scrollbar,
      )
    : kept;

  return (
    <>
      {column.place}
      <div
        ref={setContainer}
        data-testid="tab-groups"
        data-merged={merged || undefined}
        data-resizing={asked.length > 0 || undefined}
        className="tab-groups"
        {...drag.dropProps}
      >
        <WindowColumnContext.Provider value={column.value}>
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              {index > 0 && (
                <GroupDivider
                  index={index}
                  shares={shares}
                  room={room}
                  onPreview={setDragging}
                  onRelease={() => setDragging(null)}
                  onCommit={(next) => {
                    setDragging(null);
                    setAsked((all) => [...all, next]);
                    void useAppStore
                      .getState()
                      .changeLayout({ type: "resize", widths: next })
                      .finally(() => setAsked((all) => all.filter((each) => each !== next)));
                  }}
                />
              )}
              <TabGroup
                group={group}
                index={merged ? 0 : index}
                share={merged ? 1 : (shares[index] ?? 1)}
                merged={merged}
                drag={drag}
              />
            </Fragment>
          ))}
        </WindowColumnContext.Provider>
      </div>
      <DragFeedback dragged={drag.draggedTabId !== null} target={drag.target} />
      <ExportDialog mind={exportMind ?? null} onClose={() => useExportDialog.getState().close()} />
      <ShareDialog mind={shareMind ?? null} onClose={() => useShareDialog.getState().close()} />
    </>
  );
}

/**
 * The window's one column for a Note's conversation: the element it is drawn in, given to the Notes
 * while it fits beside the groups, measured on the card rather than on one group, and the Note tab
 * it follows. It follows the Note in focus; a press in a Document, the Library or Home leaves it on
 * the Note it showed.
 */
function useWindowColumn(merged: boolean, scrollbar: number) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const groups = useAppStore((state) => (merged ? 1 : (state.layout?.groups.length ?? 1)));
  const fits = useCardWidth((state) => columnFits(state.width, groups, scrollbar));
  const focused = useAppStore((state) => {
    const tab = currentTabOf(state.layout);
    return tab?.item.kind === "mind" ? tab.id : null;
  });
  const [tabId, setTabId] = useState(focused);
  if (focused !== null && focused !== tabId) setTabId(focused);
  const drawn = useFilled(slot) && fits;
  const value = useMemo(
    () => ({ slot: fits ? slot : null, tabId, drawn }),
    [fits, slot, tabId, drawn],
  );
  return {
    value,
    place: <div ref={setSlot} data-testid="note-column-place" className="note-column-place" />,
  };
}

/** Whether an element holds anything, followed as it changes. */
function useFilled(element: HTMLElement | null): boolean {
  const [filled, setFilled] = useState(false);
  useLayoutEffect(() => {
    if (!element) return;
    const follow = () => setFilled(element.childElementCount > 0);
    follow();
    const observer = new MutationObserver(follow);
    observer.observe(element, { childList: true });
    return () => observer.disconnect();
  }, [element]);
  return filled;
}

/** The width of an element, followed as it changes. */
function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** The divider before group `index`: it moves the width between that group and the one before. */
function GroupDivider({
  index,
  shares,
  room,
  onPreview,
  onRelease,
  onCommit,
}: {
  index: number;
  shares: number[];
  room: number;
  onPreview(shares: number[]): void;
  onRelease(): void;
  onCommit(shares: number[]): void;
}) {
  const t = useT();
  const before = shares[index - 1] ?? 0;
  const pair = before + (shares[index] ?? 0);
  const sharesWith = (px: number) => {
    const next = [...shares];
    next[index - 1] = px / room;
    next[index] = pair - px / room;
    return next;
  };
  const pairPx = Math.round(pair * room);
  // Two groups too narrow for their minimum each keep half.
  const min = Math.min(GROUP_MIN_WIDTH, Math.floor(pairPx / 2));
  return (
    <ResizeRod
      testId="group-divider"
      label={t("tabs.resize")}
      width={Math.round(before * room)}
      min={min}
      max={pairPx - min}
      direction={1}
      onPreview={(px) => onPreview(sharesWith(px))}
      onRelease={onRelease}
      onCommit={(px) => onCommit(sharesWith(px))}
    />
  );
}

/** One group: its strip and the tab it shows. Pressing in it makes it the focused group. */
function TabGroup({
  group,
  index,
  share,
  merged,
  drag,
}: {
  group: LayoutGroup;
  index: number;
  share: number;
  merged: boolean;
  drag: TabDrag;
}) {
  const t = useT();
  const focused = useAppStore((state) => merged || state.layout?.focusedGroupId === group.id);
  const tab = activeTabOf(group);
  useEffect(() => {
    resumeTabCloseFocus();
    return () => forgetTabCloseFocus(group.id, group.activeTabId);
  }, [group.id, group.activeTabId]);
  return (
    <section
      data-testid="tab-group"
      data-group-id={group.id}
      data-focused={focused || undefined}
      aria-label={t("tabs.group", { n: index + 1 })}
      className="tab-group"
      style={{ flexGrow: share }}
      onPointerDownCapture={() => {
        if (!focused)
          void useAppStore.getState().changeLayout({ type: "focus", groupId: group.id });
      }}
      onFocusCapture={() => {
        if (!focused)
          void useAppStore.getState().changeLayout({ type: "focus", groupId: group.id });
      }}
    >
      <TabStrip group={group} index={index} merged={merged} drag={drag} />
      <div
        data-group-body={group.id}
        className="tab-body"
        {...(tab && {
          role: "tabpanel",
          id: `tabpanel-${group.id}`,
          "aria-labelledby": `tab-${tab.id}`,
        })}
      >
        {!tab ? (
          <NoTabOpen />
        ) : (
          <TabPlaceContext.Provider value={{ tabId: tab.id, groupId: group.id }}>
            {tab.item.kind === "mind" ? (
              // Keyed, so another Mind starts a fresh title field and editor.
              <MindTab key={`${tab.id}:${tab.item.mindId}`} mindId={tab.item.mindId} />
            ) : tab.item.kind === "figures" ? (
              <FigureScheduleTab key={`${tab.id}:${tab.item.mindId}`} mindId={tab.item.mindId} />
            ) : tab.item.kind === "library" ? (
              <LibraryPane />
            ) : tab.item.kind === "home" ? (
              <HomePane />
            ) : tab.item.kind === "canvas" ? (
              <CanvasTab key={`${tab.id}:${tab.item.canvasId}`} canvasId={tab.item.canvasId} />
            ) : (
              <DocumentTab key={tab.id} tab={tab} />
            )}
          </TabPlaceContext.Provider>
        )}
      </div>
    </section>
  );
}

function DragFeedback({ dragged, target }: { dragged: boolean; target: DropTarget | null }) {
  const t = useT();
  if (!dragged || !target) return null;
  if (target.type === "strip") {
    return (
      <div
        data-testid="tab-drop-line"
        className="tab-drop-line"
        style={{ left: target.x - 1, top: target.top }}
      />
    );
  }
  return (
    <div
      data-testid="tab-drop-zone"
      data-zone={target.zone}
      className="tab-drop-zone"
      style={{
        left: target.rect.left + (target.zone === "right" ? target.rect.width / 2 : 0) + 6,
        top: target.rect.top + 6,
        width: (target.zone === "center" ? target.rect.width : target.rect.width / 2) - 12,
        height: target.rect.height - 12,
      }}
    >
      <span>
        {t(
          target.full
            ? "tabs.drop.max"
            : target.zone === "left"
              ? "tabs.drop.left"
              : target.zone === "right"
                ? "tabs.drop.right"
                : "tabs.drop.move",
        )}
      </span>
    </div>
  );
}
