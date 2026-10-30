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
    /** How much of each tab was in view when the strip last came to rest. */
    let rested: number[] = [];
    const inView = () => {
      const view = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll(':scope > [role="tab"]'), (tab) => {
        const at = tab.getBoundingClientRect();
        return Math.max(0, Math.min(at.right, view.right) - Math.max(at.left, view.left));
      });
    };

    const place = (reveal: boolean, afterScroll = false, keep = -1) => {
      const tabs = Array.from(element.querySelectorAll<HTMLElement>(':scope > [role="tab"]'));
      const shown = tabs.findIndex((tab) => tab.dataset.tabId === shownId);
      const was = element.scrollLeft;
      const fitFrom = (scrollLeft: number, bring: number) => {
        const box = element.getBoundingClientRect();
        const offset = element.scrollLeft - box.left;
        return fitStrip({
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
          scrollLeft,
          shown: bring,
        });
      };
      // Tabs size to the strip they are in, so they are measured with it free of its cut.
      element.style.removeProperty("--tab-run");
      element.style.removeProperty("--tab-run-gap");
      delete element.dataset.squeezed;
      element.style.removeProperty("--tab-room");
      // Whether the shown tab must narrow depends on the tabs and the room alone, not on the
      // scroll or on who asked, so every place agrees and the strip comes to rest.
      if (shown >= 0) {
        const room = element.offsetWidth + spare.offsetWidth - END_GAP;
        const alone = fitFrom(0, shown);
        if (alone.squeezed && alone.first === shown && alone.last === shown) {
          // Narrowed to its least width (`data-squeezed` in styles.css), it makes the room. The
          // room is taken before, free of the cut and the narrowing, so the width holds wherever
          // the strip rests.
          element.style.setProperty("--tab-room", `${room}px`);
          element.dataset.squeezed = "";
        }
      }
      const result = fitFrom(was, reveal ? shown : keep);
      if (result.run !== null) {
        element.style.setProperty("--tab-run", `${result.run}px`);
        element.style.setProperty("--tab-run-gap", `${result.gap}px`);
      }
      if (Math.abs(element.scrollLeft - result.scrollLeft) >= 0.5) {
        element.scrollLeft = result.scrollLeft;
      }
      rested = inView();
      if (reveal) following = true;
      else if (afterScroll)
        following = shown < 0 || (shown >= result.first && shown <= result.last);
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
    // Scrolls that aren't the wheel's (a focus, a script, a screen reader) settle on whole tabs
    // too, keeping whole the tab the scroll brought into view (the one it showed most more of),
    // or else the tab most in view. Settled by the nearest start alone, that tab could end as the
    // faded part of a name, and the cut's change of width would bring the shown tab back over it.
    // The strip follows the shown tab again only while it is in view.
    const onScrollEnd = () => {
      if (wheelTimer !== undefined) return;
      const seen = inView();
      const best = (score: (index: number) => number) => {
        let pick = -1;
        let most = 0.5;
        seen.forEach((_, index) => {
          if (score(index) > most) {
            most = score(index);
            pick = index;
          }
        });
        return pick;
      };
      const brought = best((index) => (seen[index] ?? 0) - (rested[index] ?? 0));
      place(false, true, brought >= 0 ? brought : best((index) => seen[index] ?? 0));
    };

    // The shown tab is the strip's keyboard stop: focused, or a key pressed on it (End on the last
    // tab, which is already shown), it comes whole into view, after any scroll the focus makes.
    const onKeyboard = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const tab = event.target.closest<HTMLElement>('[role="tab"]');
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
