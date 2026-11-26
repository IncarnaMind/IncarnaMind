import { useMemo, useSyncExternalStore } from "react";
import { groupsMergedAt } from "./assistantPlace";
import { useCardWidth } from "./layoutSlice";

const subscribeToResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};

/** The window's width, followed as it is resized. */
export const useWindowWidth = () =>
  useSyncExternalStore(subscribeToResize, () => window.innerWidth);

/** The window's height, followed as it is resized. */
const useWindowHeight = () => useSyncExternalStore(subscribeToResize, () => window.innerHeight);

/** The window's size, followed as it is resized. */
export function useWindowSize(): { width: number; height: number } {
  const width = useWindowWidth();
  const height = useWindowHeight();
  return useMemo(() => ({ width, height }), [width, height]);
}

/**
 * Whether there is no room for groups side by side: they merge into one
 * strip, in a narrow window or a narrow card (`groupsMergedAt`).
 */
export function useGroupsMerged(): boolean {
  const windowWidth = useWindowWidth();
  // Only a change of the answer draws again, not every pixel the card is resized by.
  return useCardWidth((state) =>
    groupsMergedAt(windowWidth, state.width, state.groups, state.lead),
  );
}
