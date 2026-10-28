import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AskInConversationInput, ConversationAskResult } from "../../src/core/api";

/*
 * The card's one click asks the Question the button showed, not one the core reads again at click
 * time, and starts a fresh conversation so the example's earlier turns never reach the model.
 */

const asked: AskInConversationInput[] = [];
let readyReads = 0;
let answer: () => Promise<ConversationAskResult> = async () => ({
  asked: false,
  reason: "not-ready",
  readiness: { ready: false, reason: "no-provider" },
});

const bridge = new Proxy(
  {
    on: () => () => undefined,
    listConversations: async () => [],
    readyQuestion: async () => {
      readyReads += 1;
      return null;
    },
    askInConversation: async (input: AskInConversationInput) => {
      asked.push(input);
      return answer();
    },
  },
  {
    get: (target: object, name: string) =>
      name in target ? (target as Record<string, unknown>)[name] : async () => undefined,
  },
);

let conversations: typeof import("../../src/renderer/src/conversations");
let useConversations: typeof import("../../src/renderer/src/conversations").useConversations;
let useModelSetup: typeof import("../../src/renderer/src/modelSetup").useModelSetup;
let useAnswers: typeof import("../../src/renderer/src/answers").useAnswers;

beforeAll(async () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    window: { incarnamind: bridge, incarnamindFiles: bridge },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  conversations = await import("../../src/renderer/src/conversations");
  useConversations = conversations.useConversations;
  useModelSetup = (await import("../../src/renderer/src/modelSetup")).useModelSetup;
  useAnswers = (await import("../../src/renderer/src/answers")).useAnswers;
});

afterAll(() => {
  Object.assign(globalThis, { window: undefined, localStorage: undefined });
});

const rendered = {
  question: "What does ‘Harbour brief’ say?",
  scope: { folderIds: [], tagIds: [], documentIds: ["harbour"] },
};

describe("the card's ready Question", () => {
  // protects=the click asks the Question the button showed and starts a fresh conversation; fails_when=the core is read again at click time, or the example conversation is asked in
  test("asks what the button showed, in a new conversation", async () => {
    asked.length = 0;
    readyReads = 0;
    useConversations.setState({ openId: "the example's conversation", messages: [] });
    const accepted = await conversations.askReadyQuestion(rendered);
    expect(accepted).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      text: rendered.question,
      scope: rendered.scope,
      mindId: null,
      conversationId: null,
    });
    expect(readyReads).toBe(0);
    expect(useConversations.getState().openId).toBeNull();
    expect(useModelSetup.getState().waiting?.text).toBe(rendered.question);
  });

  // protects=a failed ask leaves its problem where the card reads it; fails_when=the problem goes under the example Note's composer key and is never seen
  test("a failed ask keeps its problem under the card's own key", async () => {
    asked.length = 0;
    answer = async () => {
      throw new Error("Ollama is not running.");
    };
    useAnswers.setState({ blocked: {} });
    const accepted = await conversations.askReadyQuestion(rendered);
    expect(accepted).toBe(false);
    expect(useAnswers.getState().blocked["composer:assistant"]).toMatchObject({
      kind: "error",
      message: "Ollama is not running.",
    });
  });
});
