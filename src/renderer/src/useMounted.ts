import { useCallback, useEffect, useRef } from "react";

/**
 * Whether the component is still on screen, for work that finishes after an `await`. The effect
 * sets it on every mount: React's development check mounts each component twice, and a flag set
 * only at first render would read "gone" for good after the first pretend unmount.
 */
export function useMounted(): () => boolean {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}
