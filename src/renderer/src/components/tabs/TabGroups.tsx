import { Fragment, useEffect, useLayoutEffect, useState } from "react";
import type { LayoutGroup } from "../../../../core/api";
import { useExportDialog } from "../../exportDialog";
import { useT } from "../../i18n";
import { activeTabOf, focusedGroupOf } from "../../layoutSlice";
import { useAppStore } from "../../store";
import { forgetTabCloseFocus, resumeTabCloseFocus } from "../../tabFocus";
import { useGroupsMerged } from "../../useWindowWidth";
import { ExportDialog } from "../ExportDialog";
import { FigureScheduleTab } from "../figures/FigureScheduleTab";
import { HomePane } from "../home/HomePane";
import { LibraryPane } from "../LibraryPane";
import { ResizeRod } from "../ResizeRod";
import { DocumentTab } from "./DocumentTab";
import { MindTab, NoTabOpen } from "./MindTab";
import { TabStrip } from "./TabStrip";
import { TabPlaceContext } from "./tabItems";
import { type DropTarget, type TabDrag, useTabDrag } from "./useTabDrag";

/** A group is never dragged narrower than this. */
const GROUP_MIN_PX = 220;

/**
 * The card's content: up to three groups side by side, each with its tab
 * strip and its shown tab, split by one full-height divider that resizes them
 * (a double-click makes them equal). Below 1,000px they merge into one strip
 * holding every tab, and come back when the window is wider.
 */
export function TabGroups() {
  const layout = useAppStore((state) => state.layout);
  const merged = useGroupsMerged();
  const drag = useTabDrag(merged);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const width = useWidth(container);
  /** Widths while a divider is dragged, before the core has them. */
  const [dragging, setDragging] = useState<number[] | null>(null);
  /** The Mind whose Export options sheet is open (⋯, ⌘K, or its References block's Export…). */
  const exporting = useExportDialog((state) => state.mindId);
  const exportMind = useAppStore((state) => state.minds.find((mind) => mind.id === exporting));

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
  const shares = dragging ?? groups.map((group) => group.width);
  /** What the groups share: the card, less the 1px dividers. */
  const room = Math.max(0, width - (groups.length - 1));

  return (
    <>
      <div
        ref={setContainer}
        data-testid="tab-groups"
        data-merged={merged || undefined}
        className="tab-groups"
        {...drag.dropProps}
      >
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && (
              <GroupDivider
                index={index}
                shares={shares}
                room={room}
                onPreview={setDragging}
                onCommit={(next) => {
                  void useAppStore
                    .getState()
                    .changeLayout({ type: "resize", widths: next })
                    .finally(() => setDragging(null));
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
      </div>
      <DragFeedback dragged={drag.draggedTabId !== null} target={drag.target} />
      <ExportDialog mind={exportMind ?? null} onClose={() => useExportDialog.getState().close()} />
    </>
  );
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
  onCommit,
}: {
  index: number;
  shares: number[];
  room: number;
  onPreview(shares: number[]): void;
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
  const min = Math.min(GROUP_MIN_PX, Math.floor(pairPx / 2));
  return (
    <ResizeRod
      testId="group-divider"
      label={t("tabs.resize")}
      width={Math.round(before * room)}
      min={min}
      max={pairPx - min}
      direction={1}
      onPreview={(px) => onPreview(sharesWith(px))}
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
