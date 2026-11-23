import { type RefObject, useLayoutEffect } from "react";

/**
 * What the page gives up, one more at each step: Added, then Format, then the Tags' room (the
 * words the columns' classes read), and last the chips themselves.
 */
const STEPS: readonly string[] = [
  "",
  "added",
  "added format",
  "added format narrow",
  "added format narrower",
  "added format narrowest",
  "added format chips",
];

const NARROWEST = STEPS.indexOf("added format narrowest");

/** A name that would take more than this is asked for no more: one long name doesn't clear the columns. */
const WORTH_ROOM = 320;

/** What a name wider than that is asked for: enough to read its start. */
const LEAST_ROOM = 160;

/** Cut by this much or less, a name is left cut to keep the chips: a few letters, not a few words. */
const A_FEW_LETTERS = 24;

const isCut = (name: HTMLElement, slack = 0) =>
  name.clientWidth + 1 + slack < (name.scrollWidth <= WORTH_ROOM ? name.scrollWidth : LEAST_ROOM);

/**
 * Find the first step with enough room. Each probe lays out the page. On opening, bisect the
 * steps after checking the full columns. On resizing, start at the step already in force.
 */
export function leastGivenUp(
  from: number | null,
  last: number,
  fits: (step: number) => boolean,
): number {
  if (from === null) {
    if (fits(0)) return 0;
    let tooNarrow = 0;
    let enough = last;
    while (enough - tooNarrow > 1) {
      const middle = Math.floor((tooNarrow + enough) / 2);
      if (fits(middle)) enough = middle;
      else tooNarrow = middle;
    }
    return enough;
  }
  let step = from;
  if (!fits(step)) {
    while (step < last) if (fits(++step)) return step;
    return step;
  }
  while (step > 0 && fits(step - 1)) step--;
  return step;
}

const widthsOf = (page: HTMLElement) =>
  [page, ...page.children].map((each) => each.clientWidth).join();

const namesOf = (page: HTMLElement) => [...page.querySelectorAll<HTMLElement>("[data-fit-name]")];

/**
 * Gives up the columns past a Document's name, Added first, then Format, then some of the Tags'
 * room, only as far as it takes for no name to be cut, and their chips only when keeping them
 * would cut a name by more than a few letters (`data-hide` on the page, read by the columns'
 * classes), so every row's columns keep the same edges. It measures again only when the page's width or a name changes.
 */
export function useFittingColumns(page: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = page.current;
    if (!element) return;
    let widths = "";
    let words = "";
    let settled: number | null = null;
    const fitColumns = () => {
      const names = namesOf(element);
      settled = leastGivenUp(settled, STEPS.length - 1, (step) => {
        element.dataset.hide = STEPS[step] ?? "";
        if (step === STEPS.length - 1) return true;
        return !names.some((name) => isCut(name, step === NARROWEST ? A_FEW_LETTERS : 0));
      });
      element.dataset.hide = STEPS[settled] ?? "";
      widths = widthsOf(element);
      words = names.map((name) => name.textContent).join("\n");
    };
    fitColumns();
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitColumns);
    };
    const resized = new ResizeObserver(() => {
      if (widthsOf(element) !== widths) later();
    });
    resized.observe(element);
    for (const child of element.children) resized.observe(child);
    // Rows come and go, and are renamed, without the page changing size.
    const changed = new MutationObserver(() => {
      if (
        namesOf(element)
          .map((name) => name.textContent)
          .join("\n") !== words
      )
        later();
    });
    changed.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      changed.disconnect();
    };
  }, [page]);
}
