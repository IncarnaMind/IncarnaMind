import { useTabPlace } from "./components/tabs/tabItems";
import { frontTabOfMind } from "./layoutSlice";
import { useAppStore } from "./store";
import { useGroupsMerged } from "./useWindowWidth";

/** Whether the User is looking at this Mind: a hint shows there, not in a note kept in a background tab. */
export function useMindInFront(mindId: string): boolean {
  const place = useTabPlace();
  const merged = useGroupsMerged();
  return useAppStore(
    (state) =>
      place?.tabId === undefined ||
      frontTabOfMind(state.layout, mindId, merged)?.id === place.tabId,
  );
}
