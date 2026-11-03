import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AssistantDock } from "../../../../core/api";
import {
  type Rect,
  type Size,
  type SnapZone,
  snapZones,
  WINDOW_EDGE,
  zoneAt,
} from "../../assistantPlace";

/*
 * Moving the assistant by its header (or its folded rail), as a panel moves
 * between docks in VS Code and Cursor: while dragging, a short bar marks each
 * edge it can dock to; near one, that zone fills and names itself; let go
 * there, it docks; anywhere else, it floats where its stand-in is. Its ⋯ menu
 * and ⌘K do the same without a drag. Pointer events, so it works the same with
 * a mouse, a pen or a test's sliding mouse; Esc puts it back.
 */

/** How far the pointer moves, held down, before a press is a drag. */
const DRAG_AFTER_PX = 5;
/** The stand-in is the floating box's width, and at most this tall. */
const STAND_IN_MAX_HEIGHT = 260;

export interface AssistantDragging {
  zones: readonly SnapZone[];
  /** The zone the pointer is near, which dropping docks to; null: it floats. */
  zone: SnapZone["dock"] | null;
  /** The stand-in's size. */
  size: Size;
  /** Where the stand-in's top left was at this render; the pointer moves it in between. */
  at: { left: number; top: number };
}

export type AssistantDrop =
  | { dock: Exclude<AssistantDock, "float"> }
  | { dock: "float"; rect: Rect };

interface Press {
  x: number;
  y: number;
  /** Where in the assistant it was pressed. */
  dx: number;
  dy: number;
  started: boolean;
  /** Its zones and stand-in are on screen. */
  shown: boolean;
  zone: SnapZone["dock"] | null;
  /** Where the stand-in's top left is. */
  at: { left: number; top: number };
}

export function useAssistantDrag({
  area,
  floatSize,
  place,
  onDrop,
}: {
  /** Where the card and the assistant are, in the window. */
  area(): Rect | null;
  /** The floating box's size, which a drop away from the edges gives it. */
  floatSize: Size;
  /** The sizes it would have docked. */
  place: { width: number; height: number };
  onDrop(drop: AssistantDrop): void;
}) {
  const [dragging, setDragging] = useState<AssistantDragging | null>(null);
  const pressed = useRef<Press | null>(null);
  /** The stand-in: moved straight from the pointer's events, never through a render. */
  const standIn = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ area, floatSize, place, onDrop });
  latest.current = { area, floatSize, place, onDrop };
  /** Set as a drag ends, so the click it makes (on the title, say) does nothing. */
  const ended = useRef(false);

  useEffect(() => {
    const stop = () => {
      pressed.current = null;
      document.body.classList.remove("assistant-dragging");
      setDragging(null);
    };
    const moveStandIn = (press: Press, size: Size, x: number, y: number) => {
      const dx = Math.min(press.dx, size.width - 40);
      const dy = Math.min(press.dy, 30);
      press.at = { left: Math.round(x - dx), top: Math.round(y - dy) };
      if (standIn.current) {
        standIn.current.style.transform = `translate(${press.at.left}px, ${press.at.top}px)`;
      }
    };
    const onMove = (event: PointerEvent) => {
      const press = pressed.current;
      if (!press) return;
      const { area: areaOf, floatSize, place } = latest.current;
      const room = areaOf();
      if (!room) return;
      const size = {
        width: floatSize.width,
        height: Math.min(floatSize.height, STAND_IN_MAX_HEIGHT),
      };
      if (!press.started) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_AFTER_PX) return;
        press.started = true;
        document.body.classList.add("assistant-dragging");
      }
      event.preventDefault();
      const zones = snapZones(room, place, window.innerWidth);
      const zone = zoneAt({ x: event.clientX, y: event.clientY }, room, zones);
      moveStandIn(press, size, event.clientX, event.clientY);
      // A render only when what shows changes: the zones as the drag starts, the one lit.
      if (!press.shown || press.zone !== zone) {
        press.shown = true;
        press.zone = zone;
        setDragging({ zones, zone, size, at: press.at });
      }
    };
    const onUp = () => {
      const press = pressed.current;
      const size = latest.current.floatSize;
      stop();
      if (!press?.started) return;
      ended.current = true;
      setTimeout(() => {
        ended.current = false;
      });
      if (press.zone) {
        latest.current.onDrop({ dock: press.zone });
        return;
      }
      // Dropped away from the edges: it floats where its stand-in was, inside the window.
      const left = Math.max(
        WINDOW_EDGE,
        Math.min(press.at.left, window.innerWidth - size.width - WINDOW_EDGE),
      );
      const top = Math.max(
        WINDOW_EDGE,
        Math.min(press.at.top, window.innerHeight - size.height - WINDOW_EDGE),
      );
      latest.current.onDrop({ dock: "float", rect: { left, top, ...size } });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !pressed.current?.started) return;
      event.preventDefault();
      event.stopPropagation();
      stop();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
    };
  }, []);

  /** On the header or the rail: a press there, away from its other buttons, may start a drag. */
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // Its buttons are buttons, except the title, which is also a handle (as a window's is).
    const target = event.target as Element;
    if (target.closest("button:not([data-assistant-title]), input, [popover]")) return;
    const box = event.currentTarget.closest("[data-assistant]")?.getBoundingClientRect();
    if (!box) return;
    pressed.current = {
      x: event.clientX,
      y: event.clientY,
      dx: event.clientX - box.left,
      dy: event.clientY - box.top,
      started: false,
      shown: false,
      zone: null,
      at: { left: box.left, top: box.top },
    };
  }, []);

  return {
    dragging,
    standIn,
    onPointerDown,
    /** Whether a drag has just ended: the click it makes is not a click on the title. */
    justDragged: () => ended.current,
  };
}
