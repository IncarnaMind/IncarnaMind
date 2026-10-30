import { type RefObject, useLayoutEffect, useState } from "react";
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
 *
 * A strip too full for its tabs makes room in three steps, each only while the one before isn't
 * enough, and takes them back in reverse when the room returns (`data-fit` in styles.css):
 * Export's label alone, then the split button leaving, then tabs hidden at the strip's ends.
 * Returns how many tabs it hides, so the strip can offer them in a list (#2244).
 */
export function useTabStripFit(
  strip: RefObject<HTMLElement | null>,
  list: RefObject<HTMLDivElement | null>,
  spacer: RefObject<HTMLElement | null>,
  shownId: string | null,
  tabIds: string,
): number {
  const [hidden, setHidden] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabIds stands for the tabs in the strip.
  useLayoutEffect(() => {
    const element = list.current;
    const spare = spacer.current;
    const band = strip.current;
    if (!element || !spare || !band) return;
    let following = true;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    /** Where the strip last came to rest. */
    let restedAt = 0;

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
      // Each step is taken only while the tabs' own extent, never the strip's `scrollWidth` (the
      // shown tab's feet reach past it, and always read as overflow), still doesn't fit.
      band.removeAttribute("data-fit");
      if (fitFrom(0, -1).run !== null) {
        band.dataset.fit = "label";
        if (fitFrom(0, -1).run !== null) band.dataset.fit = "split";
      }
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
      const hiding = result.run === null ? 0 : tabs.length - (result.last - result.first + 1);
      // A strip narrowed to its one shown tab hides none of its tabs: only a hidden tab is a step
      // of its own, with the list that reaches it.
      if (hiding > 0) band.dataset.fit = "cut";
      setHidden((current) => (current === hiding ? current : hiding));
      restedAt = element.scrollLeft;
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
    // too, keeping whole the tab the scroll brought into view: the last whole tab on the side it
    // moved towards. Settled by the nearest start alone, that tab could end as the faded part of
    // a name, and the cut's change of width would bring the shown tab back over it. The strip
    // follows the shown tab again only while it is in view.
    const onScrollEnd = () => {
      if (wheelTimer !== undefined) return;
      const moved = element.scrollLeft - restedAt;
      if (Math.abs(moved) < 1) return;
      const view = element.getBoundingClientRect();
      const whole = Array.from(element.querySelectorAll(':scope > [role="tab"]')).flatMap(
        (tab, index) => {
          const at = tab.getBoundingClientRect();
          return at.left >= view.left - 1 && at.right <= view.right + 1 ? [index] : [];
        },
      );
      place(false, true, (moved > 0 ? whole.at(-1) : whole[0]) ?? -1);
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
    // The list too: the "Show all tabs" button takes room from it as it comes and goes.
    resized.observe(element);
    resized.observe(band);
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
  }, [strip, list, spacer, shownId, tabIds]);
  return hidden;
}
