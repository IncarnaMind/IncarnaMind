import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { type AssistantPlace, DEFAULT_ASSISTANT } from "../../../../core/api";
import {
  BOTTOM_MIN,
  bottomHeight,
  bottomMax,
  floatAt,
  floatRect,
  GAP,
  isSide,
  questionHeight,
  questionMax,
  RAIL,
  type Rect,
  restoredSize,
  SIDE_MIN,
  type Size,
  shownDock,
  sideMax,
  sideWidth,
} from "../../assistantPlace";
import { ComposerDockContext } from "../../editor/mindContext";
import { useT } from "../../i18n";
import { useCardWidth } from "../../layoutSlice";
import { useQuestionRoom } from "../../questionRoom";
import { useQuietAssistant } from "../../quietAssistant";
import { useAppStore } from "../../store";
import { useWindowSize } from "../../useWindowWidth";
import { PanelBoundary } from "../PanelBoundary";
import { ResizeRod } from "../ResizeRod";
import { TabGroups } from "../tabs/TabGroups";
import { AskPill } from "./AskPill";
import { Assistant } from "./Assistant";
import { FloatResize } from "./FloatResize";
import { SnapZones } from "./SnapZones";
import { useAssistantDrag } from "./useAssistantDrag";

/**
 * Everything right of the sidebar: the card with the tab groups, and the
 * window's one assistant beside it (#253), docked on the right (by default),
 * the left or the bottom, with the 8px line between them that resizes it, or
 * floating over the card. A side dock is drawn at the bottom while the window
 * is under 1,000px.
 *
 * The card and the assistant keep their places in the page whatever the dock
 * (only the flex direction changes), so nothing in either is remounted: the
 * Mind's editor, the composer's draft and a streaming Answer stay as they are.
 * Each change is laid out at once at its new size; the card is measured, and
 * the groups share what it is given (`useGroupsMerged`).
 */
export function Workbench({
  ref,
  sidebarHidden,
  cardOverlay,
}: {
  ref: RefObject<HTMLDivElement | null>;
  sidebarHidden: boolean;
  /** Drawn over the card, such as where dropped links go. */
  cardOverlay: ReactNode;
}) {
  const t = useT();
  const place = useAppStore((state) => state.layout?.assistant) ?? DEFAULT_ASSISTANT;
  const placeAssistant = useAppStore((state) => state.placeAssistant);
  const quiet = useQuietAssistant();
  const viewport = useWindowSize();
  /** Sizes while the User drags a line or an edge, before they are kept. */
  const [preview, setPreview] = useState<Partial<AssistantPlace> | null>(null);
  const shown: AssistantPlace = preview ? { ...place, ...preview } : place;
  const dock = shownDock(shown, viewport.width);
  const side = isSide(dock);
  const { folded } = shown;
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const holdArea = useCallback(
    (element: HTMLDivElement | null) => {
      ref.current = element;
      setArea(element);
    },
    [ref],
  );
  const room = useContentSize(area);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  useMeasuredCard(card, sidebarHidden);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // The same element every time: moving or resizing the assistant draws the groups again only
  // as far as their own measurements change, so it keeps up with the pointer.
  const groups = useMemo(() => <TabGroups />, []);

  const width = sideWidth(shown.width, room.width);
  const waits = useQuestionRoom((state) => state.fits !== null) && dock === "bottom" && !folded;
  const fits = useQuestionRoom((state) => (state.resized ? null : state.fits));
  // One largest height while a question waits, for its growth, the keys and a drag alike.
  const tallest = waits ? questionMax(room.height) : bottomMax(room.height);
  const ownHeight = bottomHeight(shown.height, room.height, tallest);
  const height = waits && fits !== null ? questionHeight(ownHeight, fits, room.height) : ownHeight;
  const float = floatRect(shown.float, folded, viewport);
  const atWindowLeft = dock === "left" && sidebarHidden;

  const drag = useAssistantDrag({
    area: () => contentRect(area),
    floatSize: { width: float.width, height: floatRect(shown.float, false, viewport).height },
    place: { width: shown.width, height: shown.height },
    onDrop: (drop) => {
      if (drop.dock === "float") {
        void placeAssistant({ dock: "float", float: floatAt(drop.rect, viewport) });
      } else void placeAssistant({ dock: drop.dock });
    },
  });

  const style: CSSProperties =
    dock === "float"
      ? { left: float.left, top: float.top, width: float.width, height: float.height }
      : side
        ? { width: folded ? RAIL : width }
        : folded
          ? {}
          : { height };
  /** Room the assistant takes from the card on its side, for what the window draws there. */
  const beside = quiet ? 0 : side ? (folded ? RAIL : width) + GAP : 0;

  const resizedNow = () => {
    if (useQuestionRoom.getState().fits !== null) useQuestionRoom.setState({ resized: true });
  };
  const resize = (next: Partial<AssistantPlace>) => {
    resizedNow();
    setPreview(next);
  };
  const keep = (next: Partial<AssistantPlace>) => {
    resizedNow();
    setPreview(null);
    void placeAssistant(next);
  };
  const restore = () => keep(restoredSize(shown, dock));

  return (
    <div
      ref={holdArea}
      data-testid="workbench"
      data-dock={dock}
      data-folded={folded || undefined}
      data-sidebar-hidden={sidebarHidden || undefined}
      className="workbench"
      style={
        {
          "--assistant-left": `${dock === "left" ? beside : 0}px`,
          "--assistant-right": `${dock === "right" ? beside : 0}px`,
        } as CSSProperties
      }
    >
      <div
        ref={setCard}
        data-testid="card"
        data-sidebar-hidden={sidebarHidden || undefined}
        data-assistant-right={dock === "right" || undefined}
        className="app-card"
      >
        <ComposerDockContext.Provider value={slot}>
          <PanelBoundary name="card">{groups}</PanelBoundary>
        </ComposerDockContext.Provider>
        {cardOverlay}
        {quiet && <AskPill />}
      </div>
      {quiet || dock === "float" ? null : folded ? (
        <div aria-hidden="true" className="workbench-gap" />
      ) : (
        <ResizeRod
          testId="assistant-resize"
          label={t(side ? "assistant.resize.side" : "assistant.resize.bottom")}
          axis={side ? "x" : "y"}
          gap
          width={side ? width : height}
          min={side ? SIDE_MIN : BOTTOM_MIN}
          max={side ? sideMax(room.width) : tallest}
          // The assistant is after the line, except on the left, where it is before it.
          direction={dock === "left" ? 1 : -1}
          onPreview={(px) => resize(side ? { width: px } : { height: px })}
          onCommit={(px) => keep(side ? { width: px } : { height: px })}
          onReset={restore}
        />
      )}
      <PanelBoundary
        name="assistant"
        frame={{
          tag: "aside",
          className: "assistant",
          style: quiet ? { display: "none" } : style,
          attributes: {
            "data-assistant": "",
            "data-testid": "assistant",
            "data-dock": dock,
            "data-chosen-dock": place.dock,
            "data-at-window-left": atWindowLeft ? "" : undefined,
          },
        }}
      >
        <Assistant
          dock={dock}
          folded={folded}
          style={quiet ? { display: "none" } : style}
          attributes={{
            "data-chosen-dock": place.dock,
            "data-at-window-left": atWindowLeft ? "" : undefined,
          }}
          onComposerSlot={setSlot}
          onHandlePointerDown={drag.onPointerDown}
          justMoved={drag.justDragged}
        >
          {dock === "float" && !folded && (
            <FloatResize
              rect={float}
              onPreview={(next) => resize({ float: next })}
              onCommit={(next) => keep({ float: next })}
              onReset={restore}
            />
          )}
        </Assistant>
      </PanelBoundary>
      <SnapZones dragging={drag.dragging} standIn={drag.standIn} />
    </div>
  );
}

/** An element's content box in the window: where the card and the assistant are. */
function contentRect(element: HTMLElement | null): Rect | null {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const left = Number.parseFloat(style.paddingLeft);
  const top = Number.parseFloat(style.paddingTop);
  return {
    left: box.left + left,
    top: box.top + top,
    width: box.width - left - Number.parseFloat(style.paddingRight),
    height: box.height - top - Number.parseFloat(style.paddingBottom),
  };
}

/** The size of an element's content box, followed as it changes. */
function useContentSize(element: HTMLElement | null): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const rect = contentRect(element);
      if (rect) setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** Keeps the card's width where the groups read it (`useCardWidth`). */
function useMeasuredCard(card: HTMLElement | null, sidebarHidden: boolean): void {
  // Before the sidebar's slide starts, so the groups merge or part first and what they draw slides too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sidebarHidden` is when to measure again.
  useLayoutEffect(() => {
    if (!card) return;
    // The laid-out width: a slide's transform must not count.
    const measure = () => useCardWidth.setState({ width: card.offsetWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [card, sidebarHidden]);
}
