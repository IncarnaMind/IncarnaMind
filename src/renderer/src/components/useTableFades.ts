import { type RefObject, useEffect } from "react";

export const scrollsSideways = (frame: HTMLElement): boolean =>
  frame.scrollWidth > frame.clientWidth;

/**
 * A table wider than its frame (`.tableWrapper`) scrolls sideways in it:
 * each side that still has table beyond it is marked, and the styles fade it,
 * so the cut edge reads as more to come (#612, #1035). With a `label`, a frame
 * that scrolls is also a region the keyboard reaches; in a Mind the caret
 * reaches it instead, and a focusable frame would take the clicks meant for
 * its cells.
 */
export function useTableFades(frame: RefObject<HTMLElement | null>, label: string | null): void {
  useEffect(() => {
    const root = frame.current;
    if (!root) return;
    let pending = 0;
    const mark = () => {
      pending = 0;
      for (const wrapper of root.querySelectorAll<HTMLElement>(".tableWrapper")) {
        const start = wrapper.scrollLeft;
        const end = wrapper.scrollWidth - wrapper.clientWidth - start;
        wrapper.toggleAttribute("data-more-before", start > 1);
        wrapper.toggleAttribute("data-more-after", end > 1);
        if (label === null) continue;
        const scrolls = scrollsSideways(wrapper);
        const region = { tabindex: "0", role: "region", "aria-label": label };
        for (const [name, value] of Object.entries(region)) {
          if (scrolls) wrapper.setAttribute(name, value);
          else wrapper.removeAttribute(name);
        }
      }
    };
    // Once a frame, however many changes come in it: typing in a long Mind changes the page at every key.
    const later = () => {
      if (pending === 0) pending = requestAnimationFrame(mark);
    };
    mark();
    // Scrolling doesn't bubble: it is heard on the way down.
    root.addEventListener("scroll", later, true);
    const resized = new ResizeObserver(later);
    resized.observe(root);
    const changed = new MutationObserver(later);
    changed.observe(root, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(pending);
      root.removeEventListener("scroll", later, true);
      resized.disconnect();
      changed.disconnect();
    };
  }, [frame, label]);
}
