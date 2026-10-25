import type { MouseEvent } from "react";

/** A row's or a tab's middle click, as a browser takes one on a link or a tab. */
export function onMiddleClick(act: (event: MouseEvent) => void) {
  return {
    onMouseDown(event: MouseEvent) {
      // No autoscroll.
      if (event.button === 1) event.preventDefault();
    },
    onAuxClick(event: MouseEvent) {
      if (event.button === 1) act(event);
    },
  };
}
