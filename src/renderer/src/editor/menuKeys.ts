import { type KeyboardEvent, useRef } from "react";
import { isComposing } from "./composing";

const itemsOf = (menu: HTMLElement | null) =>
  Array.from(
    menu?.querySelectorAll<HTMLElement>(':scope [role^="menuitem"]:not([aria-disabled="true"])') ??
      [],
  );

/** The arrow keys, Home and End between a menu's items; Esc (and ← in a submenu) closes it. */
export function useMenuKeys(onClose: (refocus: boolean) => void, submenu: boolean) {
  const menu = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Escape" || (submenu && event.key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    // A submenu below this menu handles its keys first; this menu must not move again.
    if (event.defaultPrevented) return;
    const all = itemsOf(menu.current);
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? all.indexOf(active) : -1;
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    const next =
      event.key === "Home"
        ? all[0]
        : event.key === "End"
          ? all.at(-1)
          : step
            ? all[(index + step + all.length) % all.length]
            : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  return { menu, onKeyDown };
}

/** Keeps the text selected while a menu item is pressed: the menu acts on it. */
export const keepSelection = (event: { preventDefault(): void }) => event.preventDefault();

/** → on a row that opens a submenu opens it there, as a click would; false for other keys and rows. */
export function submenuOpensOnRight(event: KeyboardEvent<HTMLDivElement>): boolean {
  const active = document.activeElement;
  if (
    event.key !== "ArrowRight" ||
    !(active instanceof HTMLElement) ||
    !active.getAttribute("aria-haspopup")
  ) {
    return false;
  }
  event.preventDefault();
  active.click();
  return true;
}
