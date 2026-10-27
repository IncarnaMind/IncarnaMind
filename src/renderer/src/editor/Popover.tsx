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
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const focusFirst = useRef(initialFocus);
  focusFirst.current = initialFocus;
  const placing = useRef(middleware);
  placing.current = middleware;
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
    let shown = false;
    const place = () => {
      void computePosition(anchor, element, {
        placement,
        strategy: "fixed",
        middleware: placing.current?.() ?? [offset(4), flip(), shift({ padding: 8 })],
      }).then(({ x, y, middlewareData }) => {
        // With `hide()` among its middleware, it goes while its anchor is scrolled out of view.
        const away = middlewareData.hide?.referenceHidden === true;
        Object.assign(element.style, {
          left: `${x}px`,
          top: `${y}px`,
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
      });
    };
    const stopFollowing = autoUpdate(anchor, element, place);
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
      if (event.key !== "Escape" || event.defaultPrevented || inLater(event.target)) return;
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
      document.removeEventListener("pointerdown", dismissOnPressOutside, true);
      document.removeEventListener("keydown", dismissOnEscape, true);
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [anchor, placement]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it has a role, a dialog's unless the caller gives another (e.g. menu).
    <div
      ref={ref}
      popover="manual"
      role={role}
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Escape" && !event.defaultPrevented) {
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
