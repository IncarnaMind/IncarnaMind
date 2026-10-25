import type {
  AssistantCorner,
  AssistantDock,
  AssistantFloat,
  AssistantPlace,
} from "../../core/api";
import { DEFAULT_ASSISTANT } from "../../core/api";
import type { TitleBar } from "../../shared/titleBar";

/*
 * Where the assistant is drawn and how big (#253), from the User's choices
 * (`AssistantPlace`, kept with the window's layout) and the room there is.
 * Pure, so the rules are tested without a window: the components measure the
 * room and lay the assistant out at once at what these give.
 */

/** Below this window width a side dock is drawn at the bottom; wider, it goes back. */
export const SIDE_DOCK_FROM = 1000;
/** Below this card width the groups share one strip: the card a 1,000px window gives beside the sidebar. */
export const CARD_MERGE_BELOW = 736;

/** A side dock's width: at least this, and it leaves the card `CARD_MIN_WIDTH`. */
export const SIDE_MIN = 280;
export const CARD_MIN_WIDTH = 360;
/** A bottom dock's height: at least this, and it leaves the card `CARD_MIN_HEIGHT`. */
export const BOTTOM_MIN = 160;
export const CARD_MIN_HEIGHT = 200;
/** A floating box is at least this big, and kept this far inside the window. */
export const FLOAT_MIN = { width: 300, height: 220 };
export const WINDOW_EDGE = 8;
/** The gap between the card and a docked assistant, which is also the line that resizes it (#1099). */
export const GAP = 4;
/** A side dock folded: a rail this wide. */
export const RAIL = 44;
/** The assistant's header, level with the card's tab strip. */
export const HEADER = 36;
/** How near an edge the pointer must be, dragging the header, for that edge's dock. */
export const SNAP_DISTANCE = 96;

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

export const isSide = (dock: AssistantDock) => dock === "right" || dock === "left";

/** Where it is drawn: a side dock in a narrow window is drawn at the bottom, the choice kept. */
export const shownDock = (place: AssistantPlace, windowWidth: number): AssistantDock =>
  isSide(place.dock) && windowWidth < SIDE_DOCK_FROM ? "bottom" : place.dock;

/** The widest a side dock may be in `room` (the width the card and the assistant share). */
export const sideMax = (room: number) => Math.max(SIDE_MIN, room - GAP - CARD_MIN_WIDTH);

/** The tallest a bottom dock may be in `room` (the height the card and the assistant share). */
export const bottomMax = (room: number) => Math.max(BOTTOM_MIN, room - GAP - CARD_MIN_HEIGHT);

/** A side dock's width as drawn: the User's, kept between its minimum and what leaves the card its room. */
export const sideWidth = (width: number, room: number) => clamp(width, SIDE_MIN, sideMax(room));

export const bottomHeight = (height: number, room: number, max = bottomMax(room)) =>
  clamp(height, BOTTOM_MIN, max);

/** What a waiting question leaves the card when the bottom dock grows to fit it: its tab strip. */
export const QUESTION_LEAVES = 48;

/**
 * A bottom dock's height while a question waits in it (#1400): grown to `fits`, the height the
 * question needs, up to `room` less the card's tab strip; never shorter than the User's `height`.
 */
export const questionHeight = (height: number, fits: number, room: number) =>
  Math.round(Math.max(height, Math.min(fits, questionMax(room))));

/** The tallest a bottom dock may be while a question waits in it, grown or resized: the column less the tab strip. */
export const questionMax = (room: number) => Math.max(bottomMax(room), room - QUESTION_LEAVES);

/** The largest a floating box may be in this window. */
export const floatMax = (window: Size): Size => ({
  width: window.width - 2 * WINDOW_EDGE,
  height: window.height - 2 * WINDOW_EDGE,
});

const fromRight = (corner: AssistantCorner) => corner.endsWith("right");
const fromBottom = (corner: AssistantCorner) => corner.startsWith("bottom");

/**
 * A floating box's rect in this window: its size, kept between its minimum
 * and the window, at its distance from its corner, kept inside the window.
 * Folded, it is its header, where the box's top was.
 */
export function floatRect(float: AssistantFloat, folded: boolean, window: Size): Rect {
  const max = floatMax(window);
  const width = clamp(float.width, Math.min(FLOAT_MIN.width, max.width), max.width);
  const height = clamp(float.height, Math.min(FLOAT_MIN.height, max.height), max.height);
  const left = fromRight(float.corner) ? window.width - float.x - width : float.x;
  const top = fromBottom(float.corner) ? window.height - float.y - height : float.y;
  const shownHeight = folded ? HEADER : height;
  return {
    left: clamp(left, WINDOW_EDGE, window.width - width - WINDOW_EDGE),
    top: clamp(top, WINDOW_EDGE, window.height - shownHeight - WINDOW_EDGE),
    width,
    height: shownHeight,
  };
}

/** A floating box put at `rect`: its size, and its distance to the window's corner nearest it. */
export function floatAt(rect: Rect, window: Size): AssistantFloat {
  const right = rect.left + rect.width / 2 > window.width / 2;
  const bottom = rect.top + rect.height / 2 > window.height / 2;
  const corner = `${bottom ? "bottom" : "top"}-${right ? "right" : "left"}` as AssistantCorner;
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    corner,
    x: Math.max(0, Math.round(right ? window.width - rect.left - rect.width : rect.left)),
    y: Math.max(0, Math.round(bottom ? window.height - rect.top - rect.height : rect.top)),
  };
}

/** Where dropping the header docks it: an edge's zone, the rect it would take there. */
export interface SnapZone {
  dock: Exclude<AssistantDock, "float">;
  rect: Rect;
}

/**
 * The edges the assistant can be dragged to, in `area` (where the card and the
 * assistant are, inside the window's margins): the bottom, and in a window
 * wide enough for a side dock, the right and the left.
 */
export function snapZones(
  area: Rect,
  place: Pick<AssistantPlace, "width" | "height">,
  windowWidth: number,
): SnapZone[] {
  const height = bottomHeight(place.height, area.height);
  const zones: SnapZone[] = [
    {
      dock: "bottom",
      rect: { left: area.left, top: area.top + area.height - height, width: area.width, height },
    },
  ];
  if (windowWidth >= SIDE_DOCK_FROM) {
    const width = sideWidth(place.width, area.width);
    zones.push(
      {
        dock: "right",
        rect: { left: area.left + area.width - width, top: area.top, width, height: area.height },
      },
      { dock: "left", rect: { left: area.left, top: area.top, width, height: area.height } },
    );
  }
  return zones;
}

/** The zone whose edge the pointer is nearest to, within `SNAP_DISTANCE`; null: it floats. */
export function zoneAt(
  point: { x: number; y: number },
  area: Rect,
  zones: readonly SnapZone[],
): SnapZone["dock"] | null {
  const distance = (dock: SnapZone["dock"]) =>
    dock === "right"
      ? area.left + area.width - point.x
      : dock === "left"
        ? point.x - area.left
        : area.top + area.height - point.y;
  let nearest: { dock: SnapZone["dock"]; distance: number } | null = null;
  for (const zone of zones) {
    const away = distance(zone.dock);
    if (away < SNAP_DISTANCE && (!nearest || away < nearest.distance)) {
      nearest = { dock: zone.dock, distance: away };
    }
  }
  return nearest?.dock ?? null;
}

/**
 * Whether the groups share one strip: in a narrow window, or when the card is
 * narrower than a 1,000px window gives it, e.g. beside a wide side dock.
 * Folding the assistant, or moving it to the bottom or floating it, gives the
 * room back. Before the card is measured, only the window counts.
 */
export const groupsMergedAt = (windowWidth: number, cardWidth: number | null): boolean =>
  windowWidth < SIDE_DOCK_FROM || (cardWidth !== null && cardWidth < CARD_MERGE_BELOW);

/**
 * Its default size where it is drawn, as a double-click on its edge restores
 * it; a floating box keeps its corner and its distance to it.
 */
export function restoredSize(place: AssistantPlace, dock: AssistantDock): Partial<AssistantPlace> {
  if (dock === "bottom") return { height: DEFAULT_ASSISTANT.height };
  if (dock === "float") {
    const { width, height } = DEFAULT_ASSISTANT.float;
    return { float: { ...place.float, width, height } };
  }
  return { width: DEFAULT_ASSISTANT.width };
}

/**
 * Whether the assistant's Fold is in its ⋯ menu rather than its header
 * (#657): on Windows, docked right, the header also holds the window's
 * buttons, and its title needs the room.
 */
export const foldsInMenu = (titleBar: TitleBar, dock: AssistantDock): boolean =>
  titleBar === "overlay" && dock === "right";
