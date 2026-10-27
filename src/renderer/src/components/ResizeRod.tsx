import { type KeyboardEvent, type PointerEvent, useRef } from "react";

interface ResizeRodProps {
  label: string;
  testId?: string;
  /** Current width (or, across the window, height) of the pane this rod resizes. */
  width: number;
  min: number;
  max: number;
  /**
   * 1 if the pane is before the rod (left of it, or above it: dragging right or
   * down grows it), -1 if it is after the rod.
   */
  direction: 1 | -1;
  /**
   * "x" (the default): a vertical rod between panes side by side, moved with
   * ← and →. "y": a horizontal one between panes above and below each other,
   * moved with ↑ and ↓.
   */
  axis?: "x" | "y";
  /** Called while dragging. */
  onPreview(width: number): void;
  /** Called once with the final width. */
  onCommit(width: number): void;
  /** A drag ended with nothing to commit (cancelled, or back where it started): its preview isn't wanted. */
  onRelease?(): void;
  /** A double-click: the pane goes back to its default size. */
  onReset?(): void;
  /** Starts below the 44px band the panes' headers share (`.pane-divider--below-band`). */
  belowBand?: boolean;
  /** The 8px gap between the sidebar and the card: no rule, only a grip while pointed at. */
  gap?: boolean;
  /** Dragging this far past `min` and letting go calls this (the pane folds away) instead of resizing. */
  onCollapse?(): void;
}

/** How far past its minimum a drag must go to fold the pane away. */
const COLLAPSE_PAST_MIN = 40;

/**
 * The divider between two panes: a 1px rule that shows a three-dot grip only
 * while pointed at, dragged or focused (see `.pane-divider`). Draggable, and
 * keyboard-operable with the arrow keys.
 */
export function ResizeRod({
  label,
  testId,
  width,
  min,
  max,
  direction,
  axis = "x",
  onPreview,
  onCommit,
  onRelease,
  onReset,
  belowBand = false,
  gap = false,
  onCollapse,
}: ResizeRodProps) {
  const drag = useRef<{
    start: number;
    startWidth: number;
    latest: number;
    collapse: boolean;
  } | null>(null);
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
  const along = (event: PointerEvent) => (axis === "x" ? event.clientX : event.clientY);

  const startDrag = (event: PointerEvent<HTMLHRElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: along(event), startWidth: width, latest: width, collapse: false };
  };
  const moveDrag = (event: PointerEvent<HTMLHRElement>) => {
    const current = drag.current;
    if (!current) return;
    const raw = current.startWidth + direction * (along(event) - current.start);
    current.collapse = onCollapse !== undefined && raw < min - COLLAPSE_PAST_MIN;
    current.latest = clamp(raw);
    onPreview(current.latest);
  };
  const endDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.collapse) {
      // The width it had is kept, for when it comes back.
      onPreview(current.startWidth);
      onCollapse?.();
    } else if (current && current.latest !== current.startWidth) onCommit(current.latest);
    else if (current) onRelease?.();
  };
  const cancelDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    onPreview(current.startWidth);
    onRelease?.();
  };
  const [less, more] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const resizeWithKeys = (event: KeyboardEvent<HTMLHRElement>) => {
    const step = event.shiftKey ? 50 : 10;
    const delta = event.key === more ? step : event.key === less ? -step : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = clamp(width + direction * delta);
    onPreview(next);
    onCommit(next);
  };

  return (
    <hr
      data-testid={testId}
      // A rod between panes side by side stands upright; one between panes stacked lies flat.
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      // A focusable separator is the ARIA window-splitter pattern: arrow keys resize.
      tabIndex={0}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
      onKeyDown={resizeWithKeys}
      onDoubleClick={onReset}
      className={
        axis === "y"
          ? `pane-divider pane-divider--y${gap ? " pane-divider--gap-y" : ""}`
          : gap
            ? "pane-divider pane-divider--gap"
            : belowBand
              ? "pane-divider pane-divider--below-band"
              : "pane-divider"
      }
    />
  );
}
