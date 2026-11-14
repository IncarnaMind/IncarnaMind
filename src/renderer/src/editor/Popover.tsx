import {
  autoUpdate,
  computePosition,
  flip,
  type Middleware,
  offset,
  type Placement,
  shift,
  type VirtualElement,
} from "@floating-ui/dom";
import {
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
} from "react";
import { enterFrom, useExitToward } from "../motion";

interface PopoverProps extends HTMLAttributes<HTMLDivElement> {
  /** What the popover sits next to. It follows it as the Mind scrolls. */
  anchor: Element | VirtualElement;
  placement?: Placement;
  /** Where it goes, if not under (or over) `anchor`, called each time it is placed: a chart's value card (`chartCardPlace`). */
  middleware?: () => Middleware[];
  /** Something else it keeps clear of, placed again as that changes size: a page's check badge. */
  follows?: () => Element | null | undefined;
  /**
   * A menu of a selection follows its words on a scroll or a resize, but not on its own resize
   * or a layout shift: those re-place it in a loop on a busy renderer.
   */
  still?: boolean;
  /**
   * Hung by its bottom edge: a change of its height moves its top and nothing below it, in the
   * frame it happens, before the next placement catches up (the check card's foot, #2313).
   */
  fromBottom?: boolean;
  /**
   * Called on Esc, wherever the focus is, or on a press outside both the
   * popover and `anchor`.
   */
  onDismiss(how: "escape" | "outside"): void;
  /** What gets the focus once the popover shows, e.g. a menu's first item, or a text editor. */
  initialFocus?: RefObject<{ focus(): void } | null>;
  /** Esc puts the focus back on `anchor`, the control that opened it, when that is a control. */
  returnFocus?: boolean;
  children: ReactNode;
}

/** Records the height the popover was placed at. */
const heightPlaced: Middleware = {
  name: "heightPlaced",
  fn: ({ rects }) => ({ data: { height: rects.floating.height } }),
};

/** Native popovers that are open, in the order they opened. */
const openPopovers: HTMLElement[] = [];

/** A native picker portaled out of an editor Popover joins the stack for outside presses and Esc. */
export function registerNativePopover(element: HTMLElement): void {
  if (!openPopovers.includes(element)) openPopovers.push(element);
}

export function unregisterNativePopover(element: HTMLElement): void {
  const index = openPopovers.indexOf(element);
  if (index !== -1) openPopovers.splice(index, 1);
}

/**
 * A native popover in the top layer, next to `anchor`, for the editor's small
 * menus and fields, and a Citation's card: it grows from `anchor`, and goes
 * back toward it when it closes (`../motion`), each of several open from its
 * own anchor.
 */
export function Popover({
  anchor,
  placement = "bottom-start",
  middleware,
  follows,
  still = false,
  fromBottom = false,
  onDismiss,
  initialFocus,
  returnFocus = false,
  children,
  className = "",
  role = "dialog",
  onKeyDown,
  ...props
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  // It grows from its anchor once: a new anchor, as a selection is read again, only moves it.
  const entered = useRef(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const focusFirst = useRef(initialFocus);
  focusFirst.current = initialFocus;
  const placing = useRef(middleware);
  placing.current = middleware;
  const following = useRef(follows);
  following.current = follows;
  const returning = useRef(returnFocus);
  returning.current = returnFocus;
  const dismissByEscape = useRef((from: Element | VirtualElement) => {
    if (returning.current && from instanceof HTMLElement) from.focus({ preventScroll: true });
    dismiss.current("escape");
  });

  // First, so it is copied while it still shows: closed, it shrinks back toward its anchor.
  useExitToward(ref, () => (anchor instanceof Element ? anchor : anchor.getBoundingClientRect()));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.showPopover();
    let shown = entered.current;
    const place = () => {
      void computePosition(anchor, element, {
        placement,
        strategy: "fixed",
        middleware: [
          ...(placing.current?.() ?? [offset(4), flip(), shift({ padding: 8 })]),
          ...(fromBottom ? [heightPlaced] : []),
        ],
      }).then(({ x, y, middlewareData }) => {
        // With `hide()` among its middleware, it goes while its anchor is scrolled out of view.
        const away = middlewareData.hide?.referenceHidden === true;
        // The height it was placed at, not the one it has now: it can have changed since.
        const placedAt = (middlewareData.heightPlaced as { height: number } | undefined)?.height;
        const edge =
          fromBottom && placedAt !== undefined
            ? { top: "auto", bottom: `${document.documentElement.clientHeight - (y + placedAt)}px` }
            : { top: `${y}px` };
        Object.assign(element.style, {
          left: `${x}px`,
          ...edge,
          visibility: away ? "hidden" : "visible",
        });
        if (!shown) {
          // Hidden until placed, so it can only grow from its anchor and take the focus now.
          enterFrom(element, anchor.getBoundingClientRect(), {
            left: x,
            top: y,
            width: element.offsetWidth,
            height: element.offsetHeight,
          });
          focusFirst.current?.current?.focus();
        }
        shown = true;
        entered.current = true;
      });
    };
    const stopFollowing = autoUpdate(
      anchor,
      element,
      place,
      still ? { elementResize: false, layoutShift: false } : undefined,
    );
    const followed = following.current?.();
    const resized = followed ? new ResizeObserver(place) : null;
    if (followed) resized?.observe(followed);
    registerNativePopover(element);
    /**
     * Whether an event happened in a popover opened after this one, such as
     * the card of a Citation in a footnote's text: from inside this one, so
     * not outside it. Esc there closes that one, the innermost, first.
     */
    const inLater = (target: EventTarget | null) =>
      target instanceof Node &&
      openPopovers.slice(openPopovers.indexOf(element) + 1).some((later) => later.contains(target));
    const dismissOnPressOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || element.contains(target) || inLater(target)) return;
      if (anchor instanceof Element && anchor.contains(target)) return;
      const dialog = target instanceof Element ? target.closest("dialog[open]") : null;
      if (dialog && !dialog.contains(element)) return;
      dismiss.current("outside");
    };
    // Esc while the focus is elsewhere, e.g. still in the editor or on the
    // button that opened it. Captured, and marked handled, before the
    // Document viewer's own Esc sees it; inside, `onKeyDown` handles it.
    const dismissOnEscape = (event: KeyboardEvent) => {
      // A Chinese input method's Esc takes back its composition, not what is open here.
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (inLater(event.target)) return;
      // Esc in a dialog on top closes that dialog, the innermost thing open, not this popover behind it.
      const dialog = event.target instanceof Element ? event.target.closest("dialog[open]") : null;
      if (dialog && !dialog.contains(element)) return;
      if (event.target instanceof Node && element.contains(event.target)) return;
      event.preventDefault();
      dismissByEscape.current(anchor);
    };
    document.addEventListener("pointerdown", dismissOnPressOutside, true);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      unregisterNativePopover(element);
      stopFollowing();
      resized?.disconnect();
      document.removeEventListener("pointerdown", dismissOnPressOutside, true);
      document.removeEventListener("keydown", dismissOnEscape, true);
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [anchor, placement, still, fromBottom]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it has a role, a dialog's unless the caller gives another (e.g. menu).
    <div
      ref={ref}
      popover="manual"
      role={role}
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Escape" && !event.nativeEvent.isComposing && !event.defaultPrevented) {
          // Handled here, so Esc doesn't also close the Document viewer.
          event.preventDefault();
          dismissByEscape.current(anchor);
        }
      }}
      className={`editor-popover ${className}`}
    >
      {children}
    </div>
  );
}
