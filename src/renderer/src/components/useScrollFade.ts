import { type RefObject, useLayoutEffect } from "react";

/**
 * Marks a `.scroll-fade` frame (`data-more-after`) while more of its content lies below what
 * shows, so the fade over its foot appears only when a line is cut there (#2616). A frame
 * scrolled to its end, or short enough to need no scroll, carries no mark and no fade.
 */
export function useScrollFade(frame: RefObject<HTMLElement | null>, active = true): void {
  useLayoutEffect(() => {
    const element = frame.current;
    if (!active || !element || typeof ResizeObserver === "undefined") return;
    const mark = () =>
      element.toggleAttribute(
        "data-more-after",
        element.scrollHeight - element.scrollTop - element.clientHeight > 1,
      );
    // A frame following its end (an Answer streaming in) grows first and scrolls in the same
    // frame; marking a frame later never shows the fade over a line that is about to be reached.
    let pending = 0;
    const later = () => {
      if (pending === 0) {
        pending = requestAnimationFrame(() => {
          pending = 0;
          mark();
        });
      }
    };
    // Content growing inside a frame of the same size changes only the size of what it holds.
    const resized = new ResizeObserver(later);
    const watch = () => {
      resized.disconnect();
      resized.observe(element);
      for (const child of element.children) resized.observe(child);
    };
    const changed = new MutationObserver(() => {
      watch();
      later();
    });
    watch();
    mark();
    element.addEventListener("scroll", mark, { passive: true });
    changed.observe(element, { childList: true });
    return () => {
      cancelAnimationFrame(pending);
      element.removeEventListener("scroll", mark);
      resized.disconnect();
      changed.disconnect();
      element.removeAttribute("data-more-after");
    };
  }, [frame, active]);
}
