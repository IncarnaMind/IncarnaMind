import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { noteRememberedFor, rememberNoteChat } from "../../src/renderer/src/noteChats";

/** A profile's localStorage, as the renderer has one. */
class Store {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new Store());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the chat a note was made from, remembered", () => {
  // protects=History names a chat under the note's title after the note closes; fails_when=the last chat wins over the first, which is the one the note's ⋯ opens
  test("keeps the first chat a note came from, and finds its note", () => {
    rememberNoteChat("note-1", "chat-a");
    rememberNoteChat("note-1", "chat-b");
    expect(noteRememberedFor("chat-a")).toBe("note-1");
    expect(noteRememberedFor("chat-b")).toBeNull();
    rememberNoteChat("note-2", "chat-b");
    expect(noteRememberedFor("chat-b")).toBe("note-2");
  });

  // protects=a profile that refuses storage loses only the label; fails_when=the add throws and the Answer never goes into the note
  test("a store that refuses the label loses only the label", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberNoteChat("note-1", "chat-a")).not.toThrow();
    expect(noteRememberedFor("chat-a")).toBeNull();
  });
});
