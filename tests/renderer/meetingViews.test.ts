import { beforeEach, expect, test } from "vitest";
import {
  meetingNoteViewFor,
  showMeetingNoteView,
  showNotesOf,
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
