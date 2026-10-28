import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * The viewer's Add to note with a note in focus adds at once; with the example in
 * focus it asks which note, because the example is never a target (#1940). The
 * guard is what the selection menu and ⌘K share, so it is asked on its own.
 */

beforeAll(() => {
  // The commands and the store read the bridge the preload exposes, and some modules a store:
  // its methods answer at once, as the core's do, and events are listened to and never sent.
  const bridge = new Proxy(
    { on: () => () => undefined },
    { get: (target, name) => (name === "on" ? target.on : async () => undefined) },
  );
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
  Object.assign(globalThis, {
    window: { incarnamind: bridge, incarnamindFiles: bridge },
    localStorage,
  });
});

afterAll(() => {
  Object.assign(globalThis, { window: undefined, localStorage: undefined });
});

describe("a viewer selection's Add to note", () => {
  // protects=a selection goes straight into a note of the User's own in focus, and asks which note for the example; fails_when=it writes the example's text into the example
  test("adds at once for a note of the User's own, and asks which note for the example", async () => {
    const { readMindHandle } = await import("../../src/renderer/src/commands/handles");
    const { addsWithoutAsking } = await import("../../src/renderer/src/viewer/selectionActions");
    const { useAppStore } = await import("../../src/renderer/src/store");
    useAppStore.setState({
      examples: {
        group: "credit",
        available: true,
        mindId: "example",
        linkedFolderId: null,
        answerId: null,
        more: [],
      },
      otherExamples: [],
    } as never);

    readMindHandle.current = { mindId: "own" } as never;
    expect(addsWithoutAsking()).toBe(true);
    readMindHandle.current = { mindId: "example" } as never;
    expect(addsWithoutAsking()).toBe(false);
    readMindHandle.current = null;
    expect(addsWithoutAsking()).toBe(false);
  });
});
