import { beforeEach, expect, test } from "vitest";
import type { Meeting } from "../../src/core/api";
import {
  hasMeetingViews,
  meetingNoteViewFor,
  meetingViewsOf,
  showMeetingNoteView,
  showNotesOf,
  stepMeetingNoteView,
  useMeetingNoteViews,
} from "../../src/renderer/src/meetingViews";

beforeEach(() => useMeetingNoteViews.setState({ views: {}, focus: null, details: null }));

test("each Note tab starts with its notes", () => {
  expect(meetingNoteViewFor("tab", "note")).toBe("notes");
  expect(meetingNoteViewFor(undefined, "note")).toBe("notes");
});

test("the same Note can show different views in two tabs", () => {
  showMeetingNoteView("left", "note", "transcript");
  expect(meetingNoteViewFor("left", "note")).toBe("transcript");
  expect(meetingNoteViewFor("right", "note")).toBe("notes");
  showMeetingNoteView("right", "note", "transcript");
  showMeetingNoteView("left", "note", "notes");
  expect(meetingNoteViewFor("left", "note")).toBe("notes");
  expect(meetingNoteViewFor("right", "note")).toBe("transcript");
});

test("reusing a tab for another Note does not inherit its Transcript view", () => {
  showMeetingNoteView("tab", "first", "transcript");
  expect(meetingNoteViewFor("tab", "second")).toBe("notes");
  showMeetingNoteView("tab", "second", "transcript");
  expect(meetingNoteViewFor("tab", "second")).toBe("transcript");
  expect(meetingNoteViewFor("tab", "first")).toBe("notes");
});

test("choosing the current view changes no state and Notes clears only that tab", () => {
  showMeetingNoteView("tab", "note", "transcript");
  const shown = useMeetingNoteViews.getState();
  showMeetingNoteView("tab", "note", "transcript");
  expect(useMeetingNoteViews.getState()).toBe(shown);
  showMeetingNoteView("tab", "note", "notes");
  expect(useMeetingNoteViews.getState().views).toEqual({});
  expect(useMeetingNoteViews.getState().focus).toBeNull();
});

test("⌥⌘← and ⌥⌘→ step through the views, stay at the ends, and take the User to the view", () => {
  const live = { mindId: "note", status: "recording", kind: "meeting" } as Meeting;
  stepMeetingNoteView("tab", live, -1);
  expect(meetingNoteViewFor("tab", "note")).toBe("notes");
  stepMeetingNoteView("tab", live, 1);
  expect(meetingNoteViewFor("tab", "note")).toBe("transcript");
  expect(useMeetingNoteViews.getState().focus).toMatchObject({ tabId: "tab", view: "transcript" });
  stepMeetingNoteView("tab", live, 1);
  expect(meetingNoteViewFor("tab", "note")).toBe("transcript");
  stepMeetingNoteView("tab", live, -1);
  expect(meetingNoteViewFor("tab", "note")).toBe("notes");
  expect(useMeetingNoteViews.getState().focus).toMatchObject({ tabId: "tab", view: "notes" });
});

test("after the call My notes sits between Notes and the Transcript; during it there is none", () => {
  const call = (status: Meeting["status"]) =>
    ({ mindId: "note", status, kind: "meeting" }) as Meeting;
  expect(meetingViewsOf(call("recording"))).toEqual(["notes", "transcript"]);
  expect(meetingViewsOf(call("paused"))).toEqual(["notes", "transcript"]);
  expect(meetingViewsOf(call("stopped"))).toEqual(["notes", "mine", "transcript"]);
  stepMeetingNoteView("tab", call("stopped"), 1);
  expect(meetingNoteViewFor("tab", "note")).toBe("mine");
  stepMeetingNoteView("tab", call("stopped"), 1);
  expect(meetingNoteViewFor("tab", "note")).toBe("transcript");
  stepMeetingNoteView("tab", call("stopped"), -1);
  expect(meetingNoteViewFor("tab", "note")).toBe("mine");
});

test("a switch made with the switcher's own arrows leaves the focus where it is", () => {
  showMeetingNoteView("tab", "note", "transcript");
  expect(useMeetingNoteViews.getState().focus).toBeNull();
  showMeetingNoteView("tab", "note", "transcript", { focus: true });
  const asked = useMeetingNoteViews.getState().focus;
  showMeetingNoteView("tab", "note", "transcript", { focus: true });
  expect(useMeetingNoteViews.getState().focus?.at).toBeGreaterThan(asked?.at ?? 0);
});

test("a call has views while it records and after it; a voice memo and a call not started have none", () => {
  const call = (status: Meeting["status"], kind: Meeting["kind"] = "meeting") =>
    ({ status, kind }) as Meeting;
  expect(hasMeetingViews(call("recording"))).toBe(true);
  expect(hasMeetingViews(call("paused"))).toBe(true);
  expect(hasMeetingViews(call("stopped"))).toBe(true);
  expect(hasMeetingViews(call("ready"))).toBe(false);
  expect(hasMeetingViews(call("recording", "memo"))).toBe(false);
  expect(hasMeetingViews(undefined)).toBe(false);
});

test("opening a Note shows its notes in every tab that showed its Transcript, and no other Note's", () => {
  showMeetingNoteView("left", "note", "transcript");
  showMeetingNoteView("right", "note", "transcript");
  showMeetingNoteView("other", "elsewhere", "transcript");
  showNotesOf("note");
  expect(meetingNoteViewFor("left", "note")).toBe("notes");
  expect(meetingNoteViewFor("right", "note")).toBe("notes");
  expect(meetingNoteViewFor("other", "elsewhere")).toBe("transcript");
  const shown = useMeetingNoteViews.getState();
  showNotesOf("note");
  expect(useMeetingNoteViews.getState()).toBe(shown);
});
