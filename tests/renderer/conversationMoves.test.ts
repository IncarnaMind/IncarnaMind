import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type {
  Conversation,
  ConversationAskResult,
  ConversationMessage,
  ConversationQuestion,
  ExampleReadyAsked,
} from "../../src/core/api";

/*
 * The assistant shows the conversation the User moved to last: a reply that comes after they
 * opened another one, or started a new chat, doesn't take them back (#2302).
 */

/** A promise this test settles when the call it stands for is done. */
function held<T>(): { promise: Promise<T>; settle(value: T): void } {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const question = (conversationId: string): ConversationQuestion => ({
  kind: "question",
  id: `question in ${conversationId}`,
  conversationId,
  text: `Asked in ${conversationId}`,
  askedFrom: null,
  focus: null,
  scope: null,
  model: null,
  forcedSkill: null,
  analyse: false,
  quotes: [],
  createdAt: "2026-10-31T09:00:00.000Z",
});

const conversation = (id: string): Conversation => ({
  id,
  title: "",
  autoTitle: `Asked in ${id}`,
  folderId: null,
  askedFrom: [],
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
});

const reads = new Map<string, Promise<{ messages: ConversationMessage[] }>>();
let ask: () => Promise<ConversationAskResult> = async () => {
  throw new Error("No Question is asked in this test.");
};
let deleting: Promise<void> = Promise.resolve();
let exampleAsk: () => Promise<ExampleReadyAsked> = async () => {
  throw new Error("No ready Question is asked in this test.");
};

const bridge = new Proxy(
  {
    on: () => () => undefined,
    listConversations: async () => [],
    getConversation: (id: string) => reads.get(id) ?? Promise.resolve({ messages: [question(id)] }),
    getSettings: async () => ({ device: {} }),
    askInConversation: () => ask(),
    deleteConversation: () => deleting,
    askExampleReadyQuestion: () => exampleAsk(),
  },
  {
    get: (target: object, name: string) =>
      name in target ? (target as Record<string, unknown>)[name] : async () => undefined,
  },
);

let conversations: typeof import("../../src/renderer/src/conversations");

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
});

afterAll(() => {
  Object.assign(globalThis, { window: undefined, localStorage: undefined });
});

beforeEach(() => {
  reads.clear();
  conversations.startNewChat();
});

const shown = () => conversations.useConversations.getState().openId;

const askedIn = (id: string): ConversationAskResult => ({
  asked: true,
  conversation: conversation(id),
  questionId: `question in ${id}`,
  answerId: `answer in ${id}`,
});

/** A Question asked in a new chat, whose reply waits until the test settles it. */
function askHeld() {
  const reply = held<ConversationAskResult>();
  ask = () => reply.promise;
  const asked = conversations.askInAssistant({ text: "What changed?", mindId: null });
  return { reply, asked };
}

test("a Question asked in a new chat shows its conversation when the User stayed", async () => {
  const { reply, asked } = askHeld();
  reply.settle(askedIn("new"));
  await asked;

  expect(shown()).toBe("new");
  expect(conversations.useConversations.getState().messages).toEqual([question("new")]);
});

test("a Question asked in a new chat doesn't take the User back from a conversation they opened", async () => {
  const { reply, asked } = askHeld();
  await conversations.openConversation("other");
  reply.settle(askedIn("new"));
  await asked;

  expect(shown()).toBe("other");
  expect(conversations.useConversations.getState().messages).toEqual([question("other")]);
});

test("a Question asked in a new chat doesn't take the User back from a New chat", async () => {
  const { reply, asked } = askHeld();
  conversations.startNewChat();
  reply.settle(askedIn("new"));
  await asked;

  expect(shown()).toBeNull();
  expect(conversations.useConversations.getState().messages).toEqual([]);
});

test("a conversation opening slowly doesn't replace a New chat started since", async () => {
  const slow = held<{ messages: ConversationMessage[] }>();
  reads.set("slow", slow.promise);
  const opening = conversations.openConversation("slow");
  conversations.startNewChat();
  slow.settle({ messages: [question("slow")] });
  await opening;

  expect(shown()).toBeNull();
});

test("a conversation opening slowly doesn't replace one opened after it", async () => {
  const slow = held<{ messages: ConversationMessage[] }>();
  reads.set("slow", slow.promise);
  const opening = conversations.openConversation("slow");
  await conversations.openConversation("quick");
  slow.settle({ messages: [question("slow")] });
  await opening;

  expect(shown()).toBe("quick");
  expect(conversations.useConversations.getState().messages).toEqual([question("quick")]);
});

test("clearing a conversation doesn't take the User from one they opened while it went", async () => {
  await conversations.openConversation("cleared");
  const gone = held<void>();
  deleting = gone.promise;
  const clearing = conversations.clearConversation();
  await conversations.openConversation("other");
  gone.settle();
  await clearing;
  deleting = Promise.resolve();

  expect(shown()).toBe("other");
});

test("clearing a conversation starts a new chat when the User stayed", async () => {
  await conversations.openConversation("cleared");
  await conversations.clearConversation();

  expect(shown()).toBeNull();
});

test("a new conversation's first read doesn't replace a newer one the User opened it with since", async () => {
  const first = held<{ messages: ConversationMessage[] }>();
  reads.set("new", first.promise);
  const { reply, asked } = askHeld();
  reply.settle(askedIn("new"));
  for (let turn = 0; turn < 10 && shown() !== "new"; turn++) await Promise.resolve();
  expect(shown()).toBe("new");
  // The User goes to another conversation and back, which reads it again, before the first read.
  await conversations.openConversation("other");
  reads.set("new", Promise.resolve({ messages: [question("new"), question("later")] }));
  await conversations.openConversation("new");
  first.settle({ messages: [question("new")] });
  await asked;

  expect(shown()).toBe("new");
  expect(conversations.useConversations.getState().messages).toEqual([
    question("new"),
    question("later"),
  ]);
});

test.each(["opens another conversation", "starts a New chat"] as const)(
  "the example's ready Question doesn't take the User away when they %s while its Documents are read",
  async (move) => {
    const reading = held<ExampleReadyAsked>();
    exampleAsk = () => reading.promise;
    const asking = conversations.askReadyQuestion({
      question: "What’s the leverage cap?",
      scope: null,
      waitingFor: "Northwind Retail · Q3 2026 results",
    });
    if (move === "opens another conversation") await conversations.openConversation("other");
    else conversations.startNewChat();
    reading.settle({ conversationId: "example", answerId: "answer in example", stopped: false });
    await asking;

    expect(shown()).toBe(move === "opens another conversation" ? "other" : null);
  },
);

test("the example's ready Question shows its conversation when the User stayed", async () => {
  exampleAsk = async () => ({
    conversationId: "example",
    answerId: "answer in example",
    stopped: false,
  });
  await conversations.askReadyQuestion({
    question: "What’s the leverage cap?",
    scope: null,
    waitingFor: null,
  });

  expect(shown()).toBe("example");
});
