import { type RefObject, useContext, useLayoutEffect, useRef } from "react";
import { visibleGroupsOf } from "../layoutSlice";
import { useFade } from "../motion";
import { useAppStore } from "../store";
import { type UndoLineState, useUndo } from "../undo";
import {
  bandsUnderPill,
  type PageUnderPill,
  setUndoPillBands,
  showsUndoPill,
  useUndoPillBands,
} from "../undoPill";
import { useHeld } from "../useHeld";
import { useGroupsMerged } from "../useWindowWidth";
import { SidebarControlContext } from "./SidebarToggle";
import { UndoLineBody } from "./UndoLine";

/**
 * The line with the sidebar out of sight (#1776): in the card's bottom left corner, where a User
 * working with the mouse can reach Undo, clear of the page's text (#1914).
 */
export function UndoPill() {
  const sidebar = useContext(SidebarControlContext);
  const line = useUndo((state) => state.line);
  const place = useRef<HTMLDivElement>(null);
  const merged = useGroupsMerged();
  // Every page on screen, by the tab in front of it: a page brought forward is when to measure again.
  const onScreen = useAppStore((state) =>
    state.layout
      ? visibleGroupsOf(state.layout, merged)
          .map((group) => `${group.id}:${group.activeTabId ?? ""}`)
          .join("|")
      : "",
  );
  const shown = showsUndoPill(sidebar) && line !== null && !line.change?.shownAt;
  usePillBands(place, shown, shown && line ? line.id : null, onScreen);
  if (!showsUndoPill(sidebar)) return null;
  return (
    <div
      ref={place}
      role="status"
      aria-live="polite"
      data-testid="undo-pill-place"
      className="undo-pill-place"
    >
      {line && !line.change?.shownAt && <Pill key={line.id} line={line} />}
    </div>
  );
}

function usePillBands(
  place: RefObject<HTMLDivElement | null>,
  shown: boolean,
  lineId: number | null,
  onScreen: string,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pages on screen are when to measure again.
  useLayoutEffect(() => {
    const anchor = place.current;
    const card = anchor?.parentElement;
    if (!shown || lineId === null || !anchor || !card) {
      setUndoPillBands({});
      return;
    }
    const measure = () => {
      const pill = anchor.getBoundingClientRect();
      const cardLeft = card.getBoundingClientRect().left;
      const kept = useUndoPillBands.getState().bands;
      const pages: PageUnderPill[] = [];
      for (const group of card.querySelectorAll<HTMLElement>(".tab-group")) {
        const groupId = group.dataset.groupId;
        const scroller = group.querySelector<HTMLElement>(".mind-scroller");
        const column = group.querySelector<HTMLElement>(".mind-measure");
        if (groupId === undefined || !scroller || !column) continue;
        const box = group.getBoundingClientRect();
        pages.push({
          groupId,
          left: box.left,
          right: box.right,
          columnLeft: column.getBoundingClientRect().left,
          scrollerBottom: scroller.getBoundingClientRect().bottom,
          applied: kept[groupId] ?? 0,
        });
      }
      setUndoPillBands(bandsUnderPill(pill, cardLeft, pages));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(card);
    watch.observe(anchor);
    for (const group of card.querySelectorAll<HTMLElement>(".tab-group")) {
      watch.observe(group);
      const scroller = group.querySelector<HTMLElement>(".mind-scroller");
      if (scroller) watch.observe(scroller);
    }
    return () => watch.disconnect();
  }, [shown, lineId, onScreen, place.current]);
}

/** The pill fades as a whole: its background and shadow with its words, never the words alone. */
function Pill({ line }: { line: UndoLineState }) {
  const pill = useRef<HTMLDivElement>(null);
  useFade(pill);
  const held = useHeld(pill, { focusHolds: true });
  return (
    <div ref={pill} data-testid="undo-pill" className="undo-pill">
      <UndoLineBody line={line} inPill held={held} fade={false} />
    </div>
  );
}
