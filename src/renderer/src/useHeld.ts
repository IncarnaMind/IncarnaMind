import { type RefObject, useEffect, useState } from "react";

/**
 * Whether the pointer or the focus rests on `element`, which keeps what it shows open: a line
 * that goes by itself stays while the User is reaching for it. A focus that moves within the
 * element keeps it held.
 */
export function useHeld(element: RefObject<HTMLElement | null>): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const hold = () => setHeld(true);
    const release = (event: Event) => {
      if (event.type === "focusout" && node.contains((event as FocusEvent).relatedTarget as Node))
        return;
      setHeld(node.matches(":hover"));
    };
    node.addEventListener("pointerenter", hold);
    node.addEventListener("pointerleave", release);
    node.addEventListener("focusin", hold);
    node.addEventListener("focusout", release);
    return () => {
      node.removeEventListener("pointerenter", hold);
      node.removeEventListener("pointerleave", release);
      node.removeEventListener("focusin", hold);
      node.removeEventListener("focusout", release);
    };
  }, [element]);
  return held;
}
