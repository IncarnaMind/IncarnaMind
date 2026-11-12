import { type RefObject, useLayoutEffect } from "react";

/** A chip's name keeps this many characters on screen, or all of it when it is shorter. */
const NAME_CHARS = 6;

let measuring: CanvasRenderingContext2D | null = null;

/**
 * Keeps each chip of a row's list from going narrower than its icon, the first characters of its
 * name (all of it when short) and its ×, whatever its language: a name that is cut shows six
 * characters of Chinese as wide as six of English. The list itself keeps what its items keep, so
 * the row can tell when they no longer fit (`useRowGivesWay`).
 */
export function useChipFloors(list: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const element = list.current;
    if (!active || !element) return;
    measuring ??= document.createElement("canvas").getContext("2d");
    const canvas = measuring;
    if (!canvas) return;
    const items = Array.from(element.children).filter(
      (item): item is HTMLElement => item instanceof HTMLElement,
    );
    // What was set before is not part of what a chip needs.
    element.style.minWidth = "";
    for (const item of items) item.style.minWidth = "";
    const chips = items.filter((item) => item.classList.contains("scope-chip"));

    const kept = chips.map((chip) => {
      const name = chip.querySelector<HTMLElement>(".truncate");
      if (!name) return 0;
      const letters = Array.from(name.textContent ?? "");
      canvas.font = getComputedStyle(name).font;
      const shown =
        letters.length <= NAME_CHARS
          ? letters.join("")
          : `${letters.slice(0, NAME_CHARS).join("")}…`;
      return canvas.measureText(shown).width;
    });

    // A chip with its name shut to nothing and no "· empty": the icon, the ×, their gaps and padding.
    const names = chips.flatMap((chip) =>
      Array.from(chip.querySelectorAll<HTMLElement>(".truncate")),
    );
    const hints = chips.flatMap((chip) =>
      Array.from(chip.querySelectorAll<HTMLElement>(".scope-chip-empty")),
    );
    for (const chip of chips) chip.style.flex = "none";
    for (const name of names) {
      name.style.flex = "none";
      name.style.width = "0";
    }
    for (const hint of hints) hint.style.display = "none";
    const chrome = chips.map((chip) => chip.getBoundingClientRect().width);
    for (const hint of hints) hint.style.display = "";
    for (const name of names) {
      name.style.flex = "";
      name.style.width = "";
    }
    for (const chip of chips) chip.style.flex = "";

    const floors = items.map((item) => {
      const at = chips.indexOf(item);
      if (at >= 0) return Math.ceil((chrome[at] ?? 0) + (kept[at] ?? 0) + 1);
      // "+N more" keeps its own width; the chip that says where Back goes, its least.
      return item.classList.contains("scope-chips-more")
        ? item.offsetWidth
        : Number.parseFloat(getComputedStyle(item).minWidth) || 0;
    });
    items.forEach((item, at) => {
      if (chips.includes(item)) item.style.minWidth = `${floors[at]}px`;
    });
    const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
    const total = floors.reduce((sum, floor) => sum + floor, 0);
    element.style.minWidth = `${Math.ceil(total + gap * Math.max(0, items.length - 1))}px`;
  });
}
