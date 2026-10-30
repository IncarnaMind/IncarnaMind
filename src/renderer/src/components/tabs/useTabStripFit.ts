import { type RefObject, useLayoutEffect } from "react";
import { fitStrip } from "../../tabStripFit";

// The tab list's end padding in styles.css: room for the last tab's foot, and the gap before the "+".
const END_GAP = 10;

// The width of the fade at a side of `.tab-list` that hides tabs, in styles.css.
const FADE_PX = 32;

// A wheel is a stream of small scrolls with no end event, so the strip settles after this quiet.
const WHEEL_QUIET_MS = 140;

/**
 * Keeps a group's tab strip resting on whole tabs, with part of a hidden tab's name faded at a
 * side that hides tabs (`fitStrip`); a strip being scrolled may show a part of any. A tab that
 * becomes active is brought whole into view, and again when a tab or the strip changes size,
 * until the User scrolls away on purpose.
 */
export function useTabStripFit(
  list: RefObject<HTMLDivElement | null>,
  spacer: RefObject<HTMLElement | null>,
  shownId: string | null,
  tabIds: string,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabIds stands for the tabs in the strip.
  useLayoutEffect(() => {
    const element = list.current;
    const spare = spacer.current;
    if (!element || !spare) return;
    let following = true;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;

    const place = (reveal: boolean, byUser = false) => {
      const tabs = Array.from(element.querySelectorAll<HTMLElement>(':scope > [role="tab"]'));
      const shown = tabs.findIndex((tab) => tab.dataset.tabId === shownId);
      const was = element.scrollLeft;
      // Tabs size to the strip they are in, so they are measured with it free of its cut.
      element.style.removeProperty("--tab-run");
      element.style.removeProperty("--tab-run-gap");
      const box = element.getBoundingClientRect();
      const offset = element.scrollLeft - box.left;
      const result = fitStrip({
        tabs: tabs.map((tab) => {
          const at = tab.getBoundingClientRect();
          const name =
            tab
              .querySelector('[data-testid="tab-title"], [data-testid="tab-rename"]')
              ?.getBoundingClientRect() ?? at;
          return {
            left: at.left + offset,
            right: at.right + offset,
            name: { left: name.left + offset, right: name.right + offset },
          };
        }),
        room: element.offsetWidth + spare.offsetWidth,
        endGap: END_GAP,
        fade: FADE_PX,
        scrollLeft: was,
        shown: reveal ? shown : -1,
      });
      if (result.run !== null) {
        element.style.setProperty("--tab-run", `${result.run}px`);
        element.style.setProperty("--tab-run-gap", `${result.gap}px`);
      }
      if (Math.abs(element.scrollLeft - result.scrollLeft) >= 0.5) {
        element.scrollLeft = result.scrollLeft;
      }
      if (reveal) following = true;
      else if (byUser) following = shown < 0 || (shown >= result.first && shown <= result.last);
    };

    const placeLater = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      // Not in the observer's own callback: the fit changes sizes the observer watches.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        place(following);
      });
    };

    const onWheel = (event: WheelEvent) => {
      // A mouse wheel turns vertically; the strip scrolls sideways. A trackpad's sideways swipe scrolls it itself.
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) element.scrollLeft += event.deltaY;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        wheelTimer = undefined;
        place(false, true);
      }, WHEEL_QUIET_MS);
    };
    // Scrolls that aren't the User's (a focus, a script) settle on whole tabs too, but they
    // don't say the User looked away from the shown tab.
    const onScrollEnd = () => {
      if (wheelTimer === undefined) place(false);
    };

    // The shown tab is the strip's keyboard stop: focused, or a key pressed on it (End on the last
    // tab, which is already shown), it comes whole into view, after any scroll the focus makes.
    const onKeyboard = (event: Event) => {
      const tab = (event.target as Element).closest<HTMLElement>('[role="tab"]');
      if (tab?.dataset.tabId !== shownId) return;
      following = true;
      placeLater();
    };

    place(true);
    const resized = new ResizeObserver(placeLater);
    resized.observe(spare);
    if (element.parentElement) resized.observe(element.parentElement);
    for (const tab of element.querySelectorAll(':scope > [role="tab"]')) resized.observe(tab);
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("scrollend", onScrollEnd);
    element.addEventListener("focusin", onKeyboard);
    element.addEventListener("keydown", onKeyboard);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(wheelTimer);
      resized.disconnect();
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("scrollend", onScrollEnd);
      element.removeEventListener("focusin", onKeyboard);
      element.removeEventListener("keydown", onKeyboard);
    };
  }, [list, spacer, shownId, tabIds]);
}
