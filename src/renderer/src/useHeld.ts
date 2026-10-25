import { type RefObject, useEffect, useState } from "react";

/**
 * Whether the pointer or the focus rests on `element`, which keeps what it shows open: a line
 * that goes by itself stays while the User is reaching for it. `focusHolds`: a focus inside keeps
 * it after the pointer has left, for a line the User reaches with the keyboard.
 */
export function useHeld(
  element: RefObject<HTMLElement | null>,
  { focusHolds = false }: { focusHolds?: boolean } = {},
): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    // Drawn under a pointer that hasn't moved yet, it is held from the start.
    setHeld(node.matches(":hover"));
    const hold = () => setHeld(true);
    const release = (event: Event) => {
      if (event.type === "focusout" && node.contains((event as FocusEvent).relatedTarget as Node))
        return;
      setHeld(node.matches(":hover") || (focusHolds && node.contains(document.activeElement)));
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
  }, [element, focusHolds]);
  return held;
}
