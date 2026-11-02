import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationAnswer } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { translate } from "../../src/shared/i18n";

/** Add to note says when an Answer's Citations are copied out of a walled Folder (#1934). */

vi.mock("../../src/renderer/src/conversations", () => ({
  questionOf: () => ({ id: "q1", text: "What is the notice?" }),
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    addToNote: async () => ({ blockIds: ["b1"] }),
  },
}));

const library = {
  groups: [{ id: "a", name: "Client A", parentId: null, keepInside: true }],
  assignments: [{ documentId: "lease-a", groupId: "a" }],
};
const reportError = vi.fn();
const minds = [
  { id: "outside", title: "General note", autoTitle: "", folderId: null },
  { id: "inside", title: "Client A note", autoTitle: "", folderId: "a" },
];
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({ changeLayout: async () => true, reportError, minds, library }),
  },
  exampleMindIds: () => [],
}));

const pushed: { said: (t: typeof en) => string }[] = [];
vi.mock("../../src/renderer/src/undo", () => ({
  answerUndoPlace: (id: string) => `answer:${id}`,
  useUndo: { getState: () => ({ push: (entry: (typeof pushed)[number]) => pushed.push(entry) }) },
}));

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);

const answer: ConversationAnswer = {
  kind: "answer",
  id: "a1",
  conversationId: "c1",
  questionId: "q1",
  text: "",
  citations: [],
  figures: [],
  analyses: [],
  model: null,
  status: "done",
  errorKind: null,
  errorMessage: null,
  errorSignInRoute: null,
  citationSupport: null,
  toolCalls: [],
  textOrigin: null,
  read: null,
  steps: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};

const citing = (documentId: string): NodeJSON[] => [
  {
    type: "paragraph",
    content: [
      { type: "text", text: "The notice is 90 days." },
      { type: "citation", attrs: { documentId, quote: "Notice: 90 days." } },
    ],
  },
];

const { addAnswer } = await import("../../src/renderer/src/addToNote");
const { keptInsideName } = await import("../../src/renderer/src/walls");

beforeEach(() => {
  pushed.length = 0;
  reportError.mockClear();
});

describe("Add to note across a Folder wall", () => {
  test("into a Note outside the wall, it says the Answer was copied out of that Folder", async () => {
    await addAnswer(
      { answer, conversation: undefined, blocks: citing("lease-a") },
      { kind: "mind", mindId: "outside" },
    );
    expect(pushed[0]?.said(en)).toBe("Added to “General note” · copied out of “Client A”");
    // Its Citation, in the Note outside, says where its Document is kept.
    expect(keptInsideName(library, "lease-a", null)).toBe("Client A");
    expect(keptInsideName(library, "lease-a", "a")).toBeNull();
  });

  test("inside the wall, or with no walled Citation, the line is as before", async () => {
    await addAnswer(
      { answer, conversation: undefined, blocks: citing("lease-a") },
      { kind: "mind", mindId: "inside" },
    );
    await addAnswer(
      { answer, conversation: undefined, blocks: citing("memo") },
      { kind: "mind", mindId: "outside" },
    );
    expect(pushed.map((each) => each.said(en))).toEqual([
      "Added to “Client A note”",
      "Added to “General note”",
    ]);
  });

  test("in Chinese, the line names the Folder in “ ” quotes", async () => {
    await addAnswer(
      { answer, conversation: undefined, blocks: citing("lease-a") },
      { kind: "mind", mindId: "outside" },
    );
    expect(pushed[0]?.said((key, params) => translate("zh-CN", key, params))).toBe(
      "已添加到“General note” · 从“Client A”中复制",
    );
  });
});
