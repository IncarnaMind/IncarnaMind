/**
 * The mode of the call-help panel's field (#2925): kept for the rest of its Meeting on this
 * computer, through a panel closed and shown again, and Ask for any other Meeting.
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

test("a Meeting's field starts in Ask, keeps Note once chosen, and any other Meeting starts in Ask", () => {
  expect(savedFieldMode("meeting-1")).toBe("ask");
  saveFieldMode("meeting-1", "note");
  expect(savedFieldMode("meeting-1")).toBe("note");
  expect(savedFieldMode("meeting-2")).toBe("ask");
  saveFieldMode("meeting-1", "ask");
  expect(savedFieldMode("meeting-1")).toBe("ask");
});

test("with nothing it can read or keep, the field is in Ask", () => {
  stored.set("incarnamind.callHelp.fieldMode", "{not json");
  expect(savedFieldMode("meeting-1")).toBe("ask");
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage is off.");
    },
    setItem: () => {
      throw new Error("Storage is off.");
    },
  });
  expect(() => saveFieldMode("meeting-1", "note")).not.toThrow();
  expect(savedFieldMode("meeting-1")).toBe("ask");
});
