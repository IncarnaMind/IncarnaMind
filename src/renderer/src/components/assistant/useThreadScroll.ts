import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** How near the foot counts as being at it, so the thread keeps up with an Answer being written. */
const AT_FOOT_PX = 24;
/** A scroll this far above where the thread put the Question is the User's, reading further back. */
const MOVED_BY_USER_PX = 2;
/** Set on the thread while a Question holds the top with room under it (`useKeepInView` leaves it be). */
export const ANCHORED = "data-anchored";

/** Where the thread scrolls from, so an eased scroll can replace the jump in one place (#1685). */
export function scrollThreadTo(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top;
  // What keeps the thread in view as it resizes learns of this move now, not a frame later.
  scroller.dispatchEvent(new Event("scroll"));
}

const paddingOf = (scroller: HTMLElement, side: "Top" | "Bottom"): number =>
  Number.parseFloat(getComputedStyle(scroller)[`padding${side}`]) || 0;

const newestQuestion = (log: HTMLElement): Element | undefined =>
  [...log.querySelectorAll(".assistant-question")].at(-1);

function release(turn: { current: unknown }, scroller: HTMLElement): void {
  turn.current = null;
  scroller.removeAttribute(ANCHORED);
}

// The room the newest Question needs under its turn to stay at the top of the panel: what the
// panel holds under it, less what its Answer fills so far.
function roomUnder(scroller: HTMLElement, log: HTMLElement): number {
  const last = log.lastElementChild;
  const question = newestQuestion(log);
  if (!last || !question) return 0;
  const filled = last.getBoundingClientRect().bottom - question.getBoundingClientRect().top;
  const inner = scroller.clientHeight - paddingOf(scroller, "Top") - paddingOf(scroller, "Bottom");
  return Math.max(0, Math.round(inner - filled));
}

/**
 * How the assistant's thread scrolls. A thread shorter than its panel doesn't: it starts at the
 * top, so a Question holds its place while its Answer grows below it. A thread longer than its
 * panel scrolls the Question just sent to the top once, with the room under it that holds the
 * Answer as it grows; the thread follows the foot only once the Answer reaches it, and not after
 * the User has scrolled up. `changed` lists what makes the thread grow; `holdOff` keeps it still.
 */
export function useThreadScroll(
  log: RefObject<HTMLDivElement | null>,
  {
    asking,
    holdOff,
    conversationId,
    changed,
  }: {
    asking: boolean;
    holdOff: boolean;
    conversationId: string | null;
    changed: readonly unknown[];
  },
): void {
  const atFoot = useRef(true);
  const turn = useRef<{ top: number } | null>(null);
  const wasAsking = useRef(false);
  const where = useRef<string | null>(conversationId);

  const settle = () => {
    const element = log.current;
    const scroller = element?.parentElement;
    if (!element || !scroller || scroller.clientHeight === 0) return;
    if (turn.current) {
      const room = roomUnder(scroller, element);
      element.style.paddingBottom = `${room}px`;
      if (room > 0) {
        // A shorter Answer for a moment clamps the scroll before the room is refilled.
        if (scroller.scrollTop < turn.current.top) scrollThreadTo(scroller, turn.current.top);
        return;
      }
      release(turn, scroller);
      atFoot.current = true;
    }
    // After a scroll up released the Question, the room under it still closes as the Answer fills
    // it: the thread's height stays, so what the User reads doesn't move, and no blank is left.
    const held = Number.parseFloat(element.style.paddingBottom);
    if (held > 0) element.style.paddingBottom = `${Math.min(held, roomUnder(scroller, element))}px`;
    if (atFoot.current) scrollThreadTo(scroller, scroller.scrollHeight);
  };
  const settleNow = useRef(settle);
  settleNow.current = settle;

  useEffect(() => {
    const element = log.current;
    const scroller = element?.parentElement;
    if (!element || !scroller) return;
    const onScroll = () => {
      atFoot.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_FOOT_PX;
      if (turn.current && scroller.scrollTop < turn.current.top - MOVED_BY_USER_PX) {
        release(turn, scroller);
      }
    };
    scroller.addEventListener("scroll", onScroll);
    const resized = new ResizeObserver(() => settleNow.current());
    resized.observe(scroller);
    resized.observe(element);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      resized.disconnect();
    };
  }, [log]);

  useLayoutEffect(() => {
    const element = log.current;
    const scroller = element?.parentElement;
    if (!element || !scroller || holdOff) return;
    if (where.current !== conversationId) {
      where.current = conversationId;
      release(turn, scroller);
      element.style.paddingBottom = "";
      atFoot.current = true;
    }
    const sent = asking && !wasAsking.current;
    wasAsking.current = asking;
    if (!sent) {
      settleNow.current();
      return;
    }
    release(turn, scroller);
    element.style.paddingBottom = "";
    if (scroller.scrollHeight <= scroller.clientHeight) {
      atFoot.current = true;
      return;
    }
    const question = newestQuestion(element);
    if (!question) return;
    element.style.paddingBottom = `${roomUnder(scroller, element)}px`;
    const top =
      question.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      paddingOf(scroller, "Top");
    turn.current = { top };
    scroller.setAttribute(ANCHORED, "");
    scrollThreadTo(scroller, top);
    turn.current = { top: scroller.scrollTop };
    atFoot.current = false;
  }, [log, asking, holdOff, conversationId, ...changed]);
}
