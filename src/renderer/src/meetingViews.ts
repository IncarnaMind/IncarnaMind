import { create } from "zustand";

export type MeetingNoteView = "notes" | "transcript";
type Views = Record<string, { mindId: string; view: MeetingNoteView }>;

export const useMeetingNoteViews = create<{ views: Views }>(() => ({ views: {} }));

const viewIn = (views: Views, tabId: string | undefined, mindId: string): MeetingNoteView => {
  const selected = tabId ? views[tabId] : undefined;
  return selected?.mindId === mindId ? selected.view : "notes";
};

export function useMeetingNoteView(tabId: string | undefined, mindId: string): MeetingNoteView {
  return useMeetingNoteViews((state) => viewIn(state.views, tabId, mindId));
}

export function meetingNoteViewFor(tabId: string | undefined, mindId: string): MeetingNoteView {
  return viewIn(useMeetingNoteViews.getState().views, tabId, mindId);
}

export function showMeetingNoteView(tabId: string, mindId: string, view: MeetingNoteView): void {
  useMeetingNoteViews.setState((state) => {
    if (viewIn(state.views, tabId, mindId) === view) return state;
    if (view === "notes") {
      const { [tabId]: _, ...views } = state.views;
      return { views };
    }
    return { views: { ...state.views, [tabId]: { mindId, view } } };
  });
}

/** Opening a Note shows its page: a tab showing the Note's Transcript goes back to its notes. */
export function showNotesOf(mindId: string): void {
  useMeetingNoteViews.setState((state) => {
    const kept = Object.entries(state.views).filter(([, each]) => each.mindId !== mindId);
    return kept.length === Object.keys(state.views).length
      ? state
      : { views: Object.fromEntries(kept) };
  });
}
