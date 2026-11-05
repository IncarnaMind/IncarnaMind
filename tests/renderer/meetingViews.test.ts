import { beforeEach, expect, test } from "vitest";
import {
  meetingNoteViewFor,
  showMeetingNoteView,
  useMeetingNoteViews,
} from "../../src/renderer/src/meetingViews";

beforeEach(() => useMeetingNoteViews.setState({ views: {} }));

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
});
