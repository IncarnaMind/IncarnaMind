/**
 * The mode of the call-help panel's field (#2925): kept for the rest of its Meeting on this
 * computer, through a panel closed and shown again, and Note for any other Meeting.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { savedFieldMode, saveFieldMode } from "../../src/renderer/src/meetingPanel/fieldMode";

let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a Meeting's field starts in Note, keeps Ask once chosen, and any other Meeting starts in Note", () => {
  expect(savedFieldMode("meeting-1")).toBe("note");
  saveFieldMode("meeting-1", "ask");
  expect(savedFieldMode("meeting-1")).toBe("ask");
  expect(savedFieldMode("meeting-2")).toBe("note");
  saveFieldMode("meeting-1", "note");
  expect(savedFieldMode("meeting-1")).toBe("note");
});

test("with nothing it can read or keep, the field is in Note", () => {
  stored.set("incarnamind.callHelp.fieldMode", "{not json");
  expect(savedFieldMode("meeting-1")).toBe("note");
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage is off.");
    },
    setItem: () => {
      throw new Error("Storage is off.");
    },
  });
  expect(() => saveFieldMode("meeting-1", "ask")).not.toThrow();
  expect(savedFieldMode("meeting-1")).toBe("note");
});
