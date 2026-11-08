import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * How long the pointer rests on a trigger before its tip opens, so a pointer on its way to
 * something else opens nothing: the settled delay of a tooltip on Windows (the double-click time)
 * and in Chrome. #2844
 */
export const TIP_DELAY_MS = 500;

/** How long a tip stays after the pointer leaves it and its trigger. */
export const TIP_LEAVE_MS = 100;

type Timer = ReturnType<typeof setTimeout>;

/** Tips open now, across the window: while one is, the pointer's next trigger opens its tip at once, as on macOS. */
let open = 0;

/** What a tip asks of the page it is on. */
export interface TipHost {
  /** Whether the pointer is over the trigger. */
  hovered(): boolean;
  /** Whether the trigger has the focus. */
  focused(): boolean;
  /** Whether something else keeps the tip open, such as a click on its trigger. */
  held(): boolean;
}

/**
 * A tip's open state, for the triggers a small popover opens from: on the keyboard's focus and on a
 * click (`show`) at once; on the pointer after it rests `TIP_DELAY_MS` on the trigger, or at once
 * while another tip is open. A pointer that passes over opens nothing. Pointing is a move, not an
 * enter: a tip that opens for the keyboard under a resting pointer hears it enter, and would stay
 * once the focus moves on (#1519). An open tip stays while the pointer is over it, and closes
 * `TIP_LEAVE_MS` after the pointer leaves, unless the focus, or `held`, keeps it.
 */
export function createTip(host: TipHost, onChange: (shown: boolean) => void) {
  let shown = false;
  let pointing = false;
  let waiting: Timer | null = null;
  let closing: Timer | null = null;

  const set = (next: boolean) => {
    if (next === shown) return;
    shown = next;
    open += next ? 1 : -1;
    onChange(next);
  };
  const stopWaiting = () => {
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
  };
  const stopClosing = () => {
    if (closing !== null) clearTimeout(closing);
    closing = null;
  };

  const show = () => {
    stopWaiting();
    stopClosing();
    set(true);
  };
  const close = () => {
    stopWaiting();
    stopClosing();
    pointing = host.hovered();
    set(false);
  };
  const point = () => {
    if (pointing) return;
    pointing = true;
    stopClosing();
    if (shown) return;
    if (open > 0) {
      set(true);
      return;
    }
    waiting = setTimeout(() => {
      waiting = null;
      set(true);
    }, TIP_DELAY_MS);
  };
  const leave = () => {
    pointing = false;
    stopWaiting();
    if (!shown) return;
    stopClosing();
    closing = setTimeout(() => {
      closing = null;
      if (!pointing && !host.focused() && !host.held()) set(false);
    }, TIP_LEAVE_MS);
  };
  const blur = () => {
    if (!pointing) close();
  };
  /** The trigger goes: no timer fires after it, and its open tip no longer counts. */
  const dispose = () => {
    stopWaiting();
    stopClosing();
    if (shown) {
      shown = false;
      open -= 1;
    }
  };
  return { show, close, point, leave, blur, dispose };
}

/** `createTip` for a component: `shown` says whether to draw the tip, and the rest go to the trigger's and the tip's events. */
export function useTip(trigger: RefObject<HTMLElement | null>, held: () => boolean = () => false) {
  const [shown, setShown] = useState(false);
  const holding = useRef(held);
  holding.current = held;
  const tip = useRef<ReturnType<typeof createTip> | null>(null);
  tip.current ??= createTip(
    {
      hovered: () => trigger.current?.matches(":hover") ?? false,
      focused: () => document.activeElement === trigger.current,
      held: () => holding.current(),
    },
    setShown,
  );
  const { show, close, point, leave, blur, dispose } = tip.current;
  useEffect(() => dispose, [dispose]);
  return { shown, show, close, point, leave, blur };
}
