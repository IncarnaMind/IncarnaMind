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

const { followNewVersion } = await import("../../src/renderer/src/citationUpdate");

const editor = { state: {} } as never;
const RANGE = { from: 3, to: 40 };
const switchCitation = vi.fn();
const update = (over: { wordsChanged?: boolean; range?: typeof RANGE | null } = {}) =>
  followNewVersion({
    editor,
    mindId: "mind",
    range: RANGE,
    wordsChanged: true,
    switchCitation,
    ...over,
  });

beforeEach(() => {
  requestEdit.mockReset();
  noteBusy.mockReset();
  switchCitation.mockReset();
  for (const key of Object.keys(pending)) delete pending[key];
  binding.doc = { id: "the-doc" };
});

describe("Update the sentence… follows the Citation's new version", () => {
  test("switches the Citation and asks Edit with AI for the sentence's range, with no instruction of its own", () => {
    expect(update()).toBe(true);
    expect(switchCitation).toHaveBeenCalledOnce();
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

  test("while another edit runs and the words changed, says the Note is busy and leaves the Citation as it was", () => {
    pending.mind = { requestId: "running" };
    expect(update()).toBe(false);
    expect(noteBusy).toHaveBeenCalledWith("mind");
    expect(switchCitation).not.toHaveBeenCalled();
    expect(requestEdit).not.toHaveBeenCalled();
  });

  test("a quote that only moved switches the Citation with no model, even while an edit runs", () => {
    pending.mind = { requestId: "running" };
    expect(update({ wordsChanged: false })).toBe(true);
    expect(switchCitation).toHaveBeenCalledOnce();
    expect(requestEdit).not.toHaveBeenCalled();
    expect(noteBusy).not.toHaveBeenCalled();
  });

  test("a Citation with no sentence around it switches and asks nothing", () => {
    expect(update({ range: null })).toBe(true);
    expect(switchCitation).toHaveBeenCalledOnce();
    expect(requestEdit).not.toHaveBeenCalled();
  });

  test("asks nothing of a Note whose text isn't open to edit", () => {
    binding.doc = undefined;
    expect(update()).toBe(true);
    expect(requestEdit).not.toHaveBeenCalled();
  });
});
