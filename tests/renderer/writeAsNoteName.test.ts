import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationAnswer } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { translate } from "../../src/shared/i18n";

/*
 * A Note made from an Answer (#2870, Write as a note): named from the Answer's first heading, else
 * its Question, never from a sentence in the middle of the Answer; a name the User gave the
 * conversation, or a Mind already has, is kept or numbered.
 */

const QUESTION = { text: "What are the revenue and adjusted EBITDA?" };
vi.mock("../../src/renderer/src/conversations", () => ({
  questionOf: () => ({ id: "q1", text: QUESTION.text, model: null }),
}));

const made: Record<string, unknown>[] = [];
const minds: { id: string; title: string; autoTitle: string; folderId: string | null }[] = [];
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    createMind: async (input: { title: string }) => {
      made.push(input);
      return { id: "made", title: input.title, autoTitle: "", folderId: null };
    },
    addToNote: async () => ({ blockIds: ["b1"] }),
  },
}));

const reportError = vi.fn();
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({
      changeLayout: async () => true,
      reportError,
      minds,
      library: { groups: [], assignments: [] },
    }),
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
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
};

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const heading = (text: string): NodeJSON => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});
const SENTENCE = paragraph("Figures are in GBP million, as the Harbourline documents state them.");

const { addAnswer } = await import("../../src/renderer/src/addToNote");

beforeEach(() => {
  made.length = 0;
  minds.length = 0;
  pushed.length = 0;
  QUESTION.text = "What are the revenue and adjusted EBITDA?";
  reportError.mockClear();
});

describe("Write as a note names the note it makes", () => {
  test("from the Question, not a sentence from the middle of the Answer", async () => {
    await addAnswer(
      { answer, conversation: undefined, blocks: [SENTENCE, paragraph("Revenue was 668.3.")] },
      { kind: "new" },
    );
    expect(made[0]).toMatchObject({ title: "What are the revenue and adjusted EBITDA" });
    expect(pushed[0]?.said(en)).toBe("Wrote “What are the revenue and adjusted EBITDA”");
    expect(reportError).not.toHaveBeenCalled();
  });

  test("from the Answer's first heading when it has one", async () => {
    await addAnswer(
      { answer, conversation: undefined, blocks: [SENTENCE, heading("Harbourline key figures")] },
      { kind: "new" },
    );
    expect(made[0]).toMatchObject({ title: "Harbourline key figures" });
  });

  test("in Chinese, from the Question without its mark", async () => {
    QUESTION.text = "营业收入和调整后 EBITDA 是多少？";
    await addAnswer({ answer, conversation: undefined, blocks: [SENTENCE] }, { kind: "new" });
    expect(made[0]).toMatchObject({ title: "营业收入和调整后 EBITDA 是多少" });
  });

  test("with a number when another note has the name, and whole when the User named the conversation", async () => {
    minds.push({
      id: "m1",
      title: "What are the revenue and adjusted EBITDA",
      autoTitle: "",
      folderId: null,
    });
    await addAnswer({ answer, conversation: undefined, blocks: [SENTENCE] }, { kind: "new" });
    expect(made[0]).toMatchObject({ title: "What are the revenue and adjusted EBITDA 2" });

    await addAnswer(
      {
        answer,
        conversation: { title: "Half-year review", folderId: null } as never,
        blocks: [SENTENCE],
      },
      { kind: "new" },
    );
    expect(made[1]).toMatchObject({ title: "Half-year review" });
  });
});
