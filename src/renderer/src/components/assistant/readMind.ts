import { create } from "zustand";
import { assistantTabOf } from "../../layoutSlice";
import { useAppStore } from "../../store";
import { useGroupsMerged } from "../../useWindowWidth";

/**
 * The Mind the assistant reads: the one in focus, whose composer asks in it,
 * and where Add to note puts an Answer. Null with no Mind in focus.
 */
export function useReadMindId(): string | null {
  const merged = useGroupsMerged();
  return useAppStore((state) => {
    const item = assistantTabOf(state.layout, merged)?.item;
    return item?.kind === "mind" ? item.mindId : null;
  });
}

// The editor is the one place that knows the page is empty as the User sees it.
const useReadMindState = create<{ mindId: string | null; empty: boolean }>(() => ({
  mindId: null,
  empty: false,
}));

export const publishReadMindEmpty = (mindId: string, empty: boolean) =>
  useReadMindState.setState({ mindId, empty });

export const forgetReadMind = (mindId: string) => {
  if (useReadMindState.getState().mindId === mindId) {
    useReadMindState.setState({ mindId: null, empty: false });
  }
};

export const useReadMindEmpty = (mindId: string | null): boolean =>
  useReadMindState((state) => mindId !== null && state.mindId === mindId && state.empty);
