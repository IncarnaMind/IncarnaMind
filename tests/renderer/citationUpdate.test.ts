import { beforeEach, describe, expect, test, vi } from "vitest";

const { requestEdit, noteBusy, pending, binding } = vi.hoisted(() => ({
  requestEdit: vi.fn(),
  noteBusy: vi.fn(),
  pending: {} as Record<string, unknown>,
  binding: { doc: { id: "the-doc" } as unknown },
}));

vi.mock("../../src/renderer/src/editWithAi", () => ({
  requestEdit,
  noteBusy,
  useEdits: { getState: () => ({ pending }) },
}));
vi.mock("@tiptap/y-tiptap", () => ({
  ySyncPluginKey: { getState: () => ({ binding }) },
}));

const { updateSentenceToNewWords } = await import("../../src/renderer/src/citationUpdate");

const editor = { state: {} } as never;
const RANGE = { from: 3, to: 40 };

beforeEach(() => {
  requestEdit.mockReset();
  noteBusy.mockReset();
  for (const key of Object.keys(pending)) delete pending[key];
  binding.doc = { id: "the-doc" };
});

describe("Update the sentence… asks Edit with AI to follow the Citation's new words", () => {
  test("asks for the sentence's range with no instruction of its own", () => {
    updateSentenceToNewWords(editor, "mind", RANGE);
    expect(requestEdit).toHaveBeenCalledWith(
      editor,
      "mind",
      binding.doc,
      "follow-citation",
      undefined,
      RANGE,
    );
    expect(noteBusy).not.toHaveBeenCalled();
  });

  test("says the Note is busy, and asks nothing, while another edit runs in it", () => {
    pending.mind = { requestId: "running" };
    updateSentenceToNewWords(editor, "mind", RANGE);
    expect(noteBusy).toHaveBeenCalledWith("mind");
    expect(requestEdit).not.toHaveBeenCalled();
  });

  test("asks nothing of a Note whose text isn't open to edit", () => {
    binding.doc = undefined;
    updateSentenceToNewWords(editor, "mind", RANGE);
    expect(requestEdit).not.toHaveBeenCalled();
  });
});
