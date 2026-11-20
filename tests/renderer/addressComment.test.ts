import { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { COMMENT_MARK } from "../../src/core/api";
import {
  ASSISTANT_AUTHOR,
  addressComment,
  commentById,
  saveComment,
} from "../../src/renderer/src/comments";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

/*
 * Asking the assistant to address a comment replies to it once the text has changed, and a
 * failure's Try again runs all of it again: an edit that fails and then works on Try again posts
 * its reply too (#3383).
 */

const edits = vi.hoisted(() => ({
  asked: [] as { action: string; instruction?: string }[],
  /** Whether the next edit changes the text. */
  works: false,
  /** What the failure's Try again would run, from the last request. */
  again: null as (() => Promise<unknown>) | null,
}));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  requestEdit: (
    _editor: Editor,
    _mindId: string,
    _doc: Y.Doc,
    action: string,
    instruction?: string,
    _range?: { from: number; to: number },
    _from?: "menu",
    again?: () => Promise<unknown>,
  ) => {
    edits.asked.push({ action, ...(instruction && { instruction }) });
    edits.again = again ?? null;
    return Promise.resolve(edits.works);
  },
}));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ settings: { language: "en" } }) },
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  translateNow: (key: string) => key,
}));

const WORDS = "Spring tides happen at new moon.";

function commented(): { editor: Editor; doc: Y.Doc } {
  const editor = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [
            { type: "text", text: WORDS, marks: [{ type: COMMENT_MARK, attrs: { id: "c1" } }] },
          ],
        },
      ],
    },
  });
  const doc = new Y.Doc();
  saveComment(editor, doc, "c1", "Say full moon too.", "2026-11-20T00:00:00.000Z", null);
  onTestFinished(() => {
    editor.destroy();
    doc.destroy();
  });
  return { editor, doc };
}

const repliesOf = (doc: Y.Doc) =>
  (commentById(doc, "c1")?.replies ?? []).map((reply) => [reply.author, reply.text]);

beforeEach(() => {
  edits.asked.length = 0;
  edits.works = false;
  edits.again = null;
});

describe("Addressing a comment with the assistant", () => {
  test("asks for the change the comment says, and replies once the text has changed", async () => {
    const { editor, doc } = commented();
    edits.works = true;

    expect(await addressComment(editor, "mind", doc, "c1")).toBe(true);

    expect(edits.asked).toEqual([
      { action: "instruction", instruction: "comments.assistant.instruction" },
    ]);
    expect(repliesOf(doc)).toEqual([[ASSISTANT_AUTHOR, "comments.assistant.replied"]]);
  });

  test("tried again after a failure, replies once the change is made", async () => {
    const { editor, doc } = commented();

    expect(await addressComment(editor, "mind", doc, "c1")).toBe(false);
    expect(repliesOf(doc)).toEqual([]);

    edits.works = true;
    await edits.again?.();

    expect(edits.asked).toHaveLength(2);
    expect(repliesOf(doc)).toEqual([[ASSISTANT_AUTHOR, "comments.assistant.replied"]]);
  });
});
