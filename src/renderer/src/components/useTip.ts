import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * A tip's open state: a small popover that opens while the pointer moves over
 * its trigger, on the focus, and when the caller says so (a click). Pointing
 * is a move, not an enter: a tip that opens for the keyboard under a resting
 * pointer hears it enter, and would stay once the focus moves on (#1519). It
 * stays while the pointer is over the tip, and closes 100 ms after the pointer
 * leaves, unless the focus keeps it.
 */
export function useTip(trigger: RefObject<HTMLElement | null>) {
  const [shown, setShown] = useState(false);
  const pointing = useRef(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closing.current !== null) clearTimeout(closing.current);
    closing.current = null;
  };
  const show = () => {
    cancelClose();
    setShown(true);
  };
  const close = () => {
    cancelClose();
    pointing.current = trigger.current?.matches(":hover") ?? false;
    setShown(false);
  };
  const closeAfterPointer = () => {
    cancelClose();
    closing.current = setTimeout(() => {
      closing.current = null;
      if (!pointing.current && document.activeElement !== trigger.current) {
        setShown(false);
      }
    }, 100);
  };
  const point = () => {
    if (pointing.current) return;
    pointing.current = true;
    show();
  };
  const leave = () => {
    pointing.current = false;
    closeAfterPointer();
  };
  const blur = () => {
    if (!pointing.current) close();
  };
  useEffect(
    () => () => {
      if (closing.current !== null) clearTimeout(closing.current);
    },
    [],
  );
  return { shown, show, close, point, leave, blur };
}
