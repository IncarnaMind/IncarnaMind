import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ToggleEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type Box, enterFrom, exitToward } from "../motion";
import { isSlidingTo, type Point } from "./submenuSlide";
import { useFocusReturn } from "./useFocusReturn";

const GAP_PX = 4;
const EDGE_PX = 8;
/** The top band's height, which a menu over the window buttons stays below. */
const BAND_PX = 44;
/** Less room than this beside a row, and a scrolling menu would show too little to use. */
const MIN_BESIDE_ROW_PX = 120;
/** Menu items of every kind: plain, radio and checkbox. */
const ITEMS = '[role^="menuitem"]';

/** A row crossed on the way to an open submenu takes over once the pointer has rested on it this long. */
const SLIDE_REST_MS = 300;

const itemsOf = (menu: HTMLElement | null) =>
  Array.from(menu?.querySelectorAll<HTMLElement>(ITEMS) ?? []);

/** Everything Tab reaches in the menu, in reading order: its items and any field it holds. */
const tabbablesOf = (menu: HTMLElement | null) =>
  Array.from(
    menu?.querySelectorAll<HTMLElement>(
      `${ITEMS}, input:not([disabled]), select:not([disabled]), textarea:not([disabled])`,
    ) ?? [],
  ).filter((each) => each.checkVisibility());

/** Where a menu opened with a right-click or a key was asked for, if it was. */
function pointOf(button: HTMLElement | null): { x: number; y: number; above: number } | null {
  const at = button?.dataset.menuAt?.split(",").map(Number);
  return at?.length === 3 && at.every(Number.isFinite)
    ? { x: at[0] ?? 0, y: at[1] ?? 0, above: at[2] ?? 0 }
    : null;
}

/** How far the system's window buttons reach into the top band from each side. */
function windowButtonsReach(): { left: number; right: number } {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;height:0;visibility:hidden";
  document.body.append(probe);
  const reach = (name: string) => {
    probe.style.width = `var(${name})`;
    return probe.offsetWidth;
  };
  const reaches = { left: reach("--window-buttons-left"), right: reach("--window-buttons-right") };
  probe.remove();
  return reaches;
}

/** What a menu grows from and shrinks to: the pointer if it opened there, else its button. */
function sourceOf(button: HTMLElement | null): Element | Box | null {
  const point = pointOf(button);
  return point ? { left: point.x, top: point.y, width: 0, height: 0 } : button;
}

/**
 * Below the button, or above it if the window is too short. A popover that
 * isn't showing yet isn't laid out (it has no size), so it is laid out for a
 * moment to measure it as it will show. Returns where it put it.
 */
function place(
  button: HTMLElement | null,
  menu: HTMLElement | null,
  around: HTMLElement | null,
  align: "start" | "end",
): Box | null {
  const point = pointOf(button);
  const atPoint = point !== null;
  const box = point
    ? new DOMRect(point.x, point.above, 0, point.y - point.above)
    : button?.getBoundingClientRect();
  if (!box || !menu) return null;
  menu.style.removeProperty("max-height");
  const hidden = !menu.matches(":popover-open");
  if (hidden) menu.style.display = "block";
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  if (hidden) menu.style.removeProperty("display");
  // Above or below what the button sits in, if given, so the menu doesn't cover it, its
  // right edge by the button's.
  const outer = around?.getBoundingClientRect();
  const anchor = outer
    ? { left: box.right + GAP_PX - width, top: outer.top, bottom: outer.bottom }
    : align === "end" && !atPoint
      ? { left: box.right - width, top: box.top, bottom: box.bottom }
      : box;
  // At the pointer the menu overlaps it by 1px, so letting go of the button lands inside the menu
  // and doesn't dismiss it.
  const gap = atPoint ? -1 : GAP_PX;
  const left = Math.max(
    EDGE_PX,
    Math.min(anchor.left - (atPoint ? 1 : 0), window.innerWidth - width - EDGE_PX),
  );
  const below = anchor.bottom + gap;
  // The window buttons are covered by a menu that reaches them, so it stays under the band (#1517).
  const buttons = windowButtonsReach();
  const overButtons = left < buttons.left || left + width > window.innerWidth - buttons.right;
  const floor = overButtons ? BAND_PX : EDGE_PX;
  const roomBelow = window.innerHeight - EDGE_PX - below;
  const roomAbove = anchor.top - gap - floor;
  // A menu a key opened from a row that fits neither side stays beside the row, on the side with
  // more room, and scrolls there; it would cover the row anywhere else (#1517).
  const besideRow =
    point !== null &&
    point.above < point.y &&
    height > roomBelow &&
    height > roomAbove &&
    Math.max(roomBelow, roomAbove) >= MIN_BESIDE_ROW_PX;
  let top: number;
  let room: number;
  if (besideRow) {
    const downward = roomBelow >= roomAbove;
    top = downward ? below : floor;
    room = downward ? roomBelow : roomAbove;
  } else {
    const wanted = height > roomBelow ? Math.max(EDGE_PX, anchor.top - gap - height) : below;
    // Neither below nor above fits: the menu sits as high as the window lets all of it show.
    top = Math.max(floor, Math.min(wanted, window.innerHeight - EDGE_PX - height));
    room = window.innerHeight - EDGE_PX - top;
  }
  if (height > room) menu.style.maxHeight = `${room}px`;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  return { left, top, width, height: Math.min(height, room) };
}

/** The checked item, or the first; with `first`, the first whatever is checked. */
function firstItem(menu: HTMLElement | null, first = false): HTMLElement | undefined {
  const all = itemsOf(menu);
  const checked = first
    ? undefined
    : all.find((each) => each.getAttribute("aria-checked") === "true");
  return checked ?? all[0];
}

function focusFirst(menu: HTMLElement | null, first = false): void {
  firstItem(menu, first)?.focus();
}

function itemForKey(key: string, all: readonly HTMLElement[]): HTMLElement | undefined {
  const index = all.indexOf(document.activeElement as HTMLElement);
  switch (key) {
    case "ArrowDown":
      return all[(index + 1) % all.length];
    case "ArrowUp":
      return all[(index - 1 + all.length) % all.length];
    case "Home":
      return all[0];
    case "End":
      return all.at(-1);
    default:
      return undefined;
  }
}

function openSubmenus(menu: HTMLElement | null): { trigger: HTMLElement; submenu: HTMLElement }[] {
  return Array.from(
    menu?.querySelectorAll<HTMLButtonElement>('[aria-haspopup="menu"]') ?? [],
  ).flatMap((trigger) => {
    const submenu = trigger.popoverTargetElement;
    return submenu instanceof HTMLElement && submenu.matches(":popover-open")
      ? [{ trigger, submenu }]
      : [];
  });
}

function closeSubmenusBut(menu: HTMLElement | null, item: Element): void {
  for (const { trigger, submenu } of openSubmenus(menu)) {
    if (trigger !== item) submenu.hidePopover();
  }
}

/**
 * Marks the item the browser focuses as the popover shows. Opened from the
 * keyboard, the menu renders just before it shows, when nothing in it can take
 * the focus, and its `toggle` event comes only after a frame: a key pressed in
 * between went to the button (#584).
 */
function autofocusFirst(menu: HTMLElement | null, first = false): void {
  clearAutofocus(menu);
  firstItem(menu, first)?.setAttribute("autofocus", "");
}

function clearAutofocus(menu: HTMLElement | null): void {
  for (const marked of menu?.querySelectorAll("[autofocus]") ?? []) {
    marked.removeAttribute("autofocus");
  }
}

/**
 * Opens a menu from its ⋯ button for a right-click, so the right-click menu
 * and the ⋯ menu are one. With `at` it opens at once at that point, and, if it doesn't fit below,
 * above `at.above` (the top of the row a key opened it on, so it doesn't cover the row). Without, it opens under the button: at once, or, with
 * a mouse button still held (`buttons`), once it is let go, as letting go
 * outside the menu would close it.
 */
export function openMenuFromRightClick(
  button: HTMLButtonElement,
  buttons: number,
  at?: { x: number; y: number; above?: number },
): void {
  // The popover itself, not aria-expanded, which lags a render behind a menu that was just dismissed.
  const expanded = button.popoverTargetElement?.matches(":popover-open") ?? false;
  if (at) {
    if (expanded) return;
    // Where the menu opens instead of under the button; cleared when it closes.
    button.dataset.menuAt = `${at.x},${at.y},${at.above ?? at.y}`;
    button.click();
    return;
  }
  if (expanded) return;
  if (buttons === 0) button.click();
  else {
    const open = () => {
      if (button.isConnected) button.click();
    };
    window.addEventListener("pointerup", () => setTimeout(open), { once: true });
  }
}

/**
 * A menu that opens from a button as a popover, so it sits above everything
 * and a click outside or Esc closes it (Esc closes only the menu, not the
 * Document viewer too). It shows below the button, or above it if the window
 * is too short, growing from the button and, closed, shrinking back toward it
 * (`../motion`); opening focuses the checked item (or the first), and the
 * arrow keys, Home and End move between items. The menu may render its items
 * only while `open`, and may get them a moment later (a list that loads): it
 * is then placed again, and the checked item takes the focus, unless the
 * User has already pressed a key or the pointer in the menu.
 *
 * Spread `buttonProps` on the button and `menuProps` on the menu's element,
 * which also takes `role="menu"`, an `aria-label` and `menuClass` (./ui).
 * `around` names what the button sits in, which the menu then opens above or
 * below rather than covering it (e.g. the composer, for its model chip).
 * `focus: "first"` focuses the first item even when one is checked: for a
 * menu of actions with a switch among them, rather than a choice of options.
 * `align: "end"` lines its right edge up with the button's, for a button at
 * the right of what it sits in.
 */
export function usePopoverMenu({
  around,
  focus = "checked",
  align = "start",
}: {
  around?: (button: HTMLElement) => HTMLElement | null;
  focus?: "checked" | "first";
  align?: "start" | "end";
} = {}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const outer = useRef(around);
  outer.current = around;
  const first = focus === "first";
  /** Whether the User has pressed a key or the pointer in the menu since it opened. */
  const touched = useRef(false);
  /** Whether it has grown from its button since it opened. */
  const entered = useRef(false);
  const apex = useRef<Point | null>(null);
  const crossing = useRef<{ row: Element; timer: number } | null>(null);
  /** Where the User was when the menu opened, to give the focus back to. */
  const focusReturn = useFocusReturn();
  /** Esc asked for the focus back: it is given once the popover has closed (see `onToggle`). */
  const returnWanted = useRef(false);

  const stopCrossing = () => {
    if (crossing.current) window.clearTimeout(crossing.current.timer);
    crossing.current = null;
  };
  const keepWhileCrossing = (row: Element) => {
    if (crossing.current) window.clearTimeout(crossing.current.timer);
    const timer = window.setTimeout(() => {
      crossing.current = null;
      // The pointer may have reached the submenu since its last move over the menu.
      for (const { submenu } of openSubmenus(menu.current)) {
        if (!submenu.matches(":hover")) closeSubmenusBut(menu.current, row);
      }
    }, SLIDE_REST_MS);
    crossing.current = { row, timer };
  };

  // Once rendered with its items, and before it is drawn: placed. A click
  // renders it just before the popover shows, so it shows where it belongs;
  // its `toggle` event comes only after a frame is drawn, too late to place it.
  // It takes the focus once it shows: here if it already does, or else as the browser shows
  // it (`autofocusFirst`), as a popover that hasn't shown can't be focused.
  // It grows from the button from that first frame (DESIGN.md, Motion), and is usable at once.
  useLayoutEffect(() => {
    if (!open) {
      entered.current = false;
      delete button.current?.dataset.menuAt;
      return;
    }
    const anchor = button.current;
    const box = place(
      anchor,
      menu.current,
      anchor && outer.current ? outer.current(anchor) : null,
      align,
    );
    // Once each time it opens: a menu that stays open is never animated again.
    if (menu.current && box && !entered.current) enterFrom(menu.current, sourceOf(anchor), box);
    entered.current = true;
    if (menu.current?.matches(":popover-open")) focusFirst(menu.current, first);
    else autofocusFirst(menu.current, first);
  }, [open, first, align]);

  useEffect(() => {
    if (open) return;
    apex.current = null;
    if (crossing.current) window.clearTimeout(crossing.current.timer);
    crossing.current = null;
  }, [open]);

  // Esc closes it even with nothing in it to take the focus, as a menu that says it has nothing
  // to show: the browser's own close request only reaches a popover the focus is in.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!menu.current?.matches(":popover-open")) return;
      event.preventDefault();
      returnWanted.current = true;
      menu.current.hidePopover();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Items that come after it opened, such as models still being listed then: placed again for
  // the menu's new size, and the checked one focused, as it would have been had it been there.
  useEffect(() => {
    const element = menu.current;
    if (!open || !element) return;
    const observer = new MutationObserver(() => {
      const anchor = button.current;
      place(anchor, element, anchor && outer.current ? outer.current(anchor) : null, align);
      if (!touched.current && element.matches(":popover-open")) focusFirst(element, first);
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, first, align]);

  const onKeyDown = (event: KeyboardEvent) => {
    touched.current = true;
    if (event.key === "Escape") {
      // Handled here, so the Document viewer's Esc doesn't close it too.
      event.preventDefault();
      returnWanted.current = true;
      menu.current?.hidePopover();
      return;
    }
    if (event.key === "Tab") {
      // A menu closes only when Tab leaves it: from its last item, or its first with Shift. So the
      // field a menu holds stays reachable, and Esc then belongs to the card or page behind it.
      const tabbables = tabbablesOf(menu.current);
      const leaving = event.shiftKey
        ? document.activeElement === tabbables[0]
        : document.activeElement === tabbables.at(-1);
      if (leaving) menu.current?.hidePopover();
      return;
    }
    const next = itemForKey(event.key, itemsOf(menu.current));
    if (!next) return;
    event.preventDefault();
    next.focus();
    closeSubmenusBut(menu.current, next);
  };

  return {
    open,
    close: () => menu.current?.hidePopover(),
    buttonProps: {
      ref: button,
      popoverTarget: id,
      "aria-haspopup": "menu" as const,
      "aria-expanded": open,
    },
    menuProps: {
      ref: menu,
      id,
      popover: "auto" as const,
      // Before it shows, so a menu that renders its items only while open has them when it paints.
      // Closing, it is copied as it shows, and the copy shrinks back toward the button.
      onBeforeToggle: (event: ToggleEvent<HTMLDivElement>) => {
        if (event.newState === "closed" && menu.current)
          exitToward(menu.current, sourceOf(button.current));
        // Untouched from the moment it opens, not from a render after: keys can come first.
        if (event.newState === "open") {
          touched.current = false;
          returnWanted.current = false;
          focusReturn.remember();
        }
        setOpen(event.newState === "open");
      },
      // Now it shows, where it was placed: it can take the focus, unless the User has moved it
      // already (the event can come after their first keys), or something in it has it: the
      // browser focuses an item as it shows (`autofocusFirst`), and by this event, a frame
      // later, the focus may have moved on to the menu's field. Closed after Esc, the focus goes
      // back now, not during the key: a focus the browser's own close work runs over takes no text.
      onToggle: (event: ToggleEvent<HTMLDivElement>) => {
        if (event.newState === "closed") {
          if (!returnWanted.current) return;
          returnWanted.current = false;
          focusReturn.giveBack(menu.current, button.current);
          return;
        }
        if (touched.current) return;
        if (menu.current?.contains(document.activeElement)) return;
        focusFirst(menu.current, first);
      },
      onKeyDown,
      onPointerDown: () => {
        touched.current = true;
      },
      onPointerOver: (event: PointerEvent) => {
        const item = event.target instanceof Element ? event.target.closest(ITEMS) : null;
        if (!item) return;
        const onItsWay = openSubmenus(menu.current).some(
          ({ trigger, submenu }) =>
            trigger !== item &&
            apex.current !== null &&
            isSlidingTo(
              { x: event.clientX, y: event.clientY },
              apex.current,
              submenu.getBoundingClientRect(),
            ),
        );
        if (onItsWay) keepWhileCrossing(item);
        else {
          stopCrossing();
          closeSubmenusBut(menu.current, item);
        }
      },
      onPointerMove: (event: PointerEvent) => {
        const point = { x: event.clientX, y: event.clientY };
        const item = event.target instanceof Element ? event.target.closest(ITEMS) : null;
        const open = openSubmenus(menu.current);
        if (open.some(({ trigger }) => trigger === item)) {
          apex.current = point;
          stopCrossing();
        } else if (item && crossing.current) {
          const onItsWay = open.some(
            ({ submenu }) =>
              apex.current !== null &&
              isSlidingTo(point, apex.current, submenu.getBoundingClientRect()),
          );
          if (onItsWay) keepWhileCrossing(item);
          else {
            stopCrossing();
            closeSubmenusBut(menu.current, item);
          }
        }
      },
    },
  };
}

/**
 * A submenu of an item in a `usePopoverMenu` menu, such as Export's More
 * formats. It opens beside its item as the pointer comes onto it, on a
 * click, or with →, Enter or Space, which also focus its first item; ← and
 * Esc close it, back on its item. In it, ↑↓, Home and End move between
 * items. Moving to another item of the menu, with the pointer or the keys,
 * closes it, and so does closing the menu.
 *
 * Spread `itemProps` on its item, a `<button>` in the menu, and `menuProps`
 * on the submenu's element, outside the menu's, which also takes
 * `role="menu"`, an `aria-label` and `menuClass` (./ui).
 */
export function useSubmenu() {
  const id = useId();
  const item = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const show = (focus: boolean) => {
    const submenu = menu.current;
    if (!submenu) return;
    if (focus) autofocusFirst(submenu, true);
    else clearAutofocus(submenu);
    // Its item names it as its source, so it opens nested in the menu rather than closing it.
    if (!submenu.matches(":popover-open"))
      submenu.showPopover({ source: item.current ?? undefined });
    if (focus) focusFirst(submenu, true);
  };
  const hide = () => {
    if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
  };

  const placeBeside = () => {
    const anchor = item.current;
    const submenu = menu.current;
    if (!anchor || !submenu) return;
    void computePosition(anchor, submenu, {
      placement: "right-start",
      strategy: "fixed",
      middleware: [
        offset({ mainAxis: GAP_PX, crossAxis: -GAP_PX }),
        flip(),
        shift({ padding: EDGE_PX }),
      ],
    }).then(({ x, y }) => {
      Object.assign(submenu.style, { left: `${x}px`, top: `${y}px` });
      enterFrom(submenu, anchor);
    });
  };

  return {
    open,
    itemProps: {
      ref: item,
      role: "menuitem" as const,
      "aria-haspopup": "menu" as const,
      "aria-expanded": open,
      popoverTarget: id,
      // Shown already by the pointer coming onto it, a click mustn't close it again.
      popoverTargetAction: "show" as const,
      onPointerEnter: () => show(false),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        show(true);
      },
    },
    menuProps: {
      ref: menu,
      id,
      popover: "auto" as const,
      onBeforeToggle: (event: ToggleEvent<HTMLDivElement>) => {
        setOpen(event.newState === "open");
        if (event.newState === "open") placeBeside();
        else if (menu.current) exitToward(menu.current, item.current);
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "ArrowLeft" || event.key === "Escape") {
          // Only the submenu closes, not the menu it is in.
          event.preventDefault();
          event.stopPropagation();
          hide();
          item.current?.focus();
          return;
        }
        const next = itemForKey(event.key, itemsOf(menu.current));
        if (!next) return;
        event.preventDefault();
        next.focus();
      },
    },
  };
}
