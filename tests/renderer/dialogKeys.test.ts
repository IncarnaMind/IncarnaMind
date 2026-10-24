import { beforeAll, describe, expect, test } from "vitest";
import type { Undoable } from "../../src/renderer/src/undo";

/*
 * An open modal keeps every command's keys from the page behind it, except ⌘Z and ⇧⌘Z for a
 * step whose line the modal on top draws on a page in view (Settings). A consent question over
 * Settings, or a hidden page of Settings, must never let them reach a step: Undo of a Stop
 * allowing would otherwise answer the question as Allow.
 */

const PLACE = "settings:privacy:services";

const step: Undoable = {
  said: () => "Stopped allowing arXiv",
  undo: async () => undefined,
  redo: async () => undefined,
  shownAt: PLACE,
};
const state = { done: [step], undone: [step], running: null };

let holdsKey: typeof import("../../src/renderer/src/commands/keymap").holdsKey;

beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  ({ holdsKey } = await import("../../src/renderer/src/commands/keymap"));
});

describe("⌘Z and ⇧⌘Z with a modal open", () => {
  test("get past to a step whose line is on a page in view in the modal on top", () => {
    const settings = [PLACE];
    expect(holdsKey("edit.undo", settings, state)).toBe(false);
    expect(holdsKey("edit.redo", settings, state)).toBe(false);
  });

  test("are held by a hidden page of Settings, whose line the User can't see: it is not among those shown", () => {
    expect(holdsKey("edit.undo", [], state)).toBe(true);
    expect(holdsKey("edit.redo", [], state)).toBe(true);
  });

  test("are held by a modal that draws no line for the step: a consent question never takes them as Allow", () => {
    expect(holdsKey("edit.undo", [], state)).toBe(true);
    expect(holdsKey("edit.redo", [], state)).toBe(true);
    expect(holdsKey("edit.undo", ["settings:privacy:local"], state)).toBe(true);
  });

  test("are held for a step with no line of its own", () => {
    const plain: Undoable = { said: step.said, undo: step.undo, redo: step.redo };
    const other = { done: [plain], undone: [plain], running: null };
    expect(holdsKey("edit.undo", [PLACE], other)).toBe(true);
    expect(holdsKey("edit.redo", [PLACE], other)).toBe(true);
  });

  test("leave every other command's keys held", () => {
    expect(holdsKey("edit.selectAll", [PLACE], state)).toBe(true);
  });
});
