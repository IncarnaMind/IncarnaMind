import { create } from "zustand";
import type { Meeting } from "../../core/api";

export type MeetingNoteView = "notes" | "mine" | "transcript";
type Views = Record<string, { mindId: string; view: MeetingNoteView }>;

/**
 * Where the focus goes when a view shows: a switch the User made from a key, ⌘K or the pointer
 * takes them to the view, as Notes brings back their cursor; one made in the switcher by its
 * arrow keys leaves the focus there.
 */
interface FocusAsked {
  tabId: string;
  view: MeetingNoteView;
  at: number;
}

export const useMeetingNoteViews = create<{
  views: Views;
  focus: FocusAsked | null;
  /** The stopped call's chip asked to open on its recording details, by a line on its page. */
  details: { mindId: string; at: number } | null;
}>(() => ({ views: {}, focus: null, details: null }));

/** Opens a stopped call's chip on its recording details, from a problem line that names them. */
export function showMeetingDetails(mindId: string): void {
  useMeetingNoteViews.setState((state) => ({
    details: { mindId, at: (state.details?.at ?? 0) + 1 },
  }));
}

/** A Meeting's views, in the order ⌥⌘← and ⌥⌘→ go through: My notes once the call is over. */
export const meetingViewsOf = (meeting: Meeting): readonly MeetingNoteView[] =>
  meeting.status === "stopped" ? ["notes", "mine", "transcript"] : ["notes", "transcript"];

/** Whether a Meeting's Note has views to switch: a call while it records and after it. */
export const hasMeetingViews = (meeting: Meeting | undefined): meeting is Meeting =>
  meeting?.kind === "meeting" &&
  (meeting.status === "recording" || meeting.status === "paused" || meeting.status === "stopped");

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

export function showMeetingNoteView(
  tabId: string,
  mindId: string,
  view: MeetingNoteView,
  { focus = false }: { focus?: boolean } = {},
): void {
  useMeetingNoteViews.setState((state) => {
    const asked = focus ? { tabId, view, at: (state.focus?.at ?? 0) + 1 } : state.focus;
    if (viewIn(state.views, tabId, mindId) === view) {
      return asked === state.focus ? state : { focus: asked };
    }
    if (view === "notes") {
      const { [tabId]: _, ...views } = state.views;
      return { views, focus: asked };
    }
    return { views: { ...state.views, [tabId]: { mindId, view } }, focus: asked };
  });
}

/** The view before or after the one shown, staying at the ends. */
export function stepMeetingNoteView(tabId: string, meeting: Meeting, by: -1 | 1): void {
  const views = meetingViewsOf(meeting);
  const next = views[views.indexOf(meetingNoteViewFor(tabId, meeting.mindId)) + by];
  if (next) showMeetingNoteView(tabId, meeting.mindId, next, { focus: true });
}

/** A view asked to take the focus once it shows, in this tab: the request's number, else null. */
export function useMeetingViewFocus(
  tabId: string | undefined,
  view: MeetingNoteView,
): number | null {
  return useMeetingNoteViews((state) =>
    state.focus && state.focus.tabId === tabId && state.focus.view === view ? state.focus.at : null,
  );
}

/** The view took the focus it was asked to: a later mount of it doesn't take it again. */
export function focusTaken(at: number): void {
  useMeetingNoteViews.setState((state) => (state.focus?.at === at ? { focus: null } : state));
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
