import { type RefObject, useLayoutEffect } from "react";

/**
 * Marks a `.scroll-fade` frame (`data-more-after`) while content lies below its foot, so the
 * fade shows only over a cut line (#2616). The room a frame's last child keeps blank under its
 * own content, and the frame's padding, are not content: a thread resting 5px short of its end
 * has all its text in view.
 */
export function useScrollFade(frame: RefObject<HTMLElement | null>, active = true): void {
  useLayoutEffect(() => {
    const element = frame.current;
    if (!active || !element) return;
    const mark = () => {
      const last = element.lastElementChild;
      // The check card's body grows in scaled: its top moves with the scale and its height does
      // not, so the foot is the rect's bottom, which both follow (#2622).
      const foot = element.getBoundingClientRect().bottom;
      const end = last
        ? last.getBoundingClientRect().bottom -
          (Number.parseFloat(getComputedStyle(last).paddingBottom) || 0)
        : foot;
      element.toggleAttribute("data-more-after", end - foot > 1);
    };
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
