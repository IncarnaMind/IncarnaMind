import type { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { CheckSentencesInput } from "../../src/core/api";
import type * as Checks from "../../src/renderer/src/checks";

/*
 * Asking for a check from a mark an older version made: its action says
 * "find-support", which is Check against Documents now (#903), so the request
 * and what the line under the title says are both Check against Documents.
 */

vi.mock("../../src/renderer/src/editor/editSelection", () => ({
  selectionForEdit: () => ({
    range: { from: 1, to: 9 },
    from: { blockId: "block-1", offset: 0 },
    to: { blockId: "block-1", offset: 8 },
  }),
}));

const asked: { input: CheckSentencesInput; running: unknown }[] = [];
let checks: typeof Checks;

beforeAll(async () => {
  const bridge = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "checkSentences"
          ? async (input: CheckSentencesInput) => {
              asked.push({ input, running: checks.useChecks.getState().running["mind-1"] });
              return { kind: "checked", sentences: 1, checked: 1, smallModel: false };
            }
          : () => () => undefined,
    },
  );
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  checks = await import("../../src/renderer/src/checks");
});

const editor = {
  isDestroyed: false,
  state: { selection: { from: 0, to: 0 } },
  view: { dispatch: () => undefined },
} as unknown as Editor;

describe("a check asked again", () => {
  test.each([
    ["find-support", "check-against-documents"],
    ["check-against-documents", "check-against-documents"],
    ["contradiction-watch", "contradiction-watch"],
  ] as const)("from a %s mark is asked, and said to run, as %s", async (action, expected) => {
    asked.length = 0;

    await checks.checkSentences(editor, "mind-1", new Y.Doc(), action);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.input.action).toBe(expected);
    expect(asked[0]?.running).toMatchObject({ action: expected });
    expect(checks.useChecks.getState().running["mind-1"]).toBeUndefined();
  });
});
