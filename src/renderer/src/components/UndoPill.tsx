import { type RefObject, useContext, useLayoutEffect, useRef } from "react";
import { useFade } from "../motion";
import { type UndoLineState, useUndo } from "../undo";
import {
  fitsLeftOfText,
  setUndoPillBand,
  showsUndoPill,
  undoBandHeight,
  useUndoPillBand,
} from "../undoPill";
import { useHeld } from "../useHeld";
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
  const shown = showsUndoPill(sidebar) && line !== null && !line.change?.shownAt;
  usePillBand(place, shown, shown && line ? line.id : null);
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

function usePillBand(
  place: RefObject<HTMLDivElement | null>,
  shown: boolean,
  lineId: number | null,
) {
  useLayoutEffect(() => {
    const anchor = place.current;
    const card = anchor?.parentElement;
    if (!shown || lineId === null || !anchor || !card) {
      setUndoPillBand(null, 0);
      return;
    }
    const measure = () => {
      const pill = anchor.getBoundingClientRect();
      const group = groupUnder(card, pill);
      const scroller = group?.querySelector<HTMLElement>(".mind-scroller");
      const column = group?.querySelector<HTMLElement>(".mind-measure");
      const groupId = group?.dataset.groupId ?? null;
      if (!group || !scroller || !column) {
        setUndoPillBand(null, 0);
        return;
      }
      const cardLeft = card.getBoundingClientRect().left;
      if (fitsLeftOfText(column.getBoundingClientRect().left - cardLeft, pill.width)) {
        setUndoPillBand(groupId, 0);
        return;
      }
      // The page's own foot each time, which the band it has already given doesn't move.
      const applied = useUndoPillBand.getState();
      const kept = applied.groupId === groupId ? applied.height : 0;
      setUndoPillBand(
        groupId,
        undoBandHeight(scroller.getBoundingClientRect().bottom, kept, pill.top),
      );
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(card);
    watch.observe(anchor);
    const group = groupUnder(card, anchor.getBoundingClientRect());
    if (group) watch.observe(group);
    const scroller = group?.querySelector<HTMLElement>(".mind-scroller");
    if (scroller) watch.observe(scroller);
    return () => watch.disconnect();
  }, [shown, lineId, place.current]);
}

function groupUnder(card: HTMLElement, pill: DOMRect): HTMLElement | null {
  for (const group of card.querySelectorAll<HTMLElement>(".tab-group")) {
    const box = group.getBoundingClientRect();
    if (box.left <= pill.left + 1 && pill.left + 1 < box.right) return group;
  }
  return null;
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
