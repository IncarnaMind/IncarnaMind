import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
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
let failNext = false;

beforeAll(async () => {
  const bridge = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "checkSentences"
          ? async (input: CheckSentencesInput) => {
              asked.push({ input, running: checks.useChecks.getState().running["mind-1"] });
              if (failNext) {
                failNext = false;
                throw new Error("temporary failure");
              }
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

test("Check anyway sends an explicit part target even when the selection reader expands its sentence", async () => {
  asked.length = 0;
  const part = { id: "mixed", span: { start: 24, end: 52 } };
  await checks.checkSentences(editor, "mind-1", new Y.Doc(), "check-against-documents", {
    ranges: [{ from: 25, to: 53 }],
    part,
  });
  expect(asked).toHaveLength(1);
  expect(asked[0]?.input).toMatchObject({
    from: { blockId: "block-1", offset: 0 },
    to: { blockId: "block-1", offset: 8 },
    part,
  });
});

test("retrying a failed Check anyway keeps its explicit part target", async () => {
  asked.length = 0;
  failNext = true;
  const part = { id: "pure-opinion", span: { start: 0, end: 28 } };
  await checks.checkSentences(editor, "mind-1", new Y.Doc(), "check-against-documents", { part });
  const problem = checks.useChecks.getState().problems["mind-1"];
  expect(problem?.kind).toBe("failed");
  if (problem?.kind !== "failed") throw new Error("The retry was not offered.");
  problem.retry?.();
  expect(asked).toHaveLength(2);
  expect(asked[1]?.input.part).toEqual(part);
});

test.each([true, false])(
  "an explicit part keeps the selected words while an ordinary check leaves its caret at the end: part=%s",
  async (isPart) => {
    const schema = new Schema({
      nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
    });
    const note = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("Opinion words.")),
    ]);
    let state = EditorState.create({ doc: note, selection: TextSelection.create(note, 1, 9) });
    const current = {
      isDestroyed: false,
      get state() {
        return state;
      },
      view: {
        dispatch(transaction: Transaction) {
          state = state.apply(transaction);
        },
      },
    } as unknown as Editor;
    await checks.checkSentences(
      current,
      "mind-1",
      new Y.Doc(),
      "check-against-documents",
      isPart ? { part: { id: "opinion", span: { start: 0, end: 8 } } } : {},
    );
    expect({ from: state.selection.from, to: state.selection.to }).toEqual(
      isPart ? { from: 1, to: 9 } : { from: 9, to: 9 },
    );
  },
);
