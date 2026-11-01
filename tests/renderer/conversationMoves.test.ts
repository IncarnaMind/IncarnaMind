import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type {
  Conversation,
  ConversationAskResult,
  ConversationMessage,
  ConversationQuestion,
  ExampleReadyAsked,
  Meeting,
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
const readsAsked: string[] = [];
const stopped: string[] = [];
const listeners = new Map<string, (payload: unknown) => void>();
let ask: () => Promise<ConversationAskResult> = async () => {
  throw new Error("No Question is asked in this test.");
};
let deleting: Promise<void> = Promise.resolve();
let exampleAsk: () => Promise<ExampleReadyAsked> = async () => {
  throw new Error("No ready Question is asked in this test.");
};
let helpAsk: () => Promise<ConversationAskResult> = async () => {
  throw new Error("No help is asked in this test.");
};

const bridge = new Proxy(
  {
    on: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    listConversations: async () => [],
    getConversation: (id: string) => {
      readsAsked.push(id);
      return reads.get(id) ?? Promise.resolve({ messages: [question(id)] });
    },
    getSettings: async () => ({ device: {} }),
    askInConversation: () => ask(),
    stopConversationAnswer: async ({ answerId }: { answerId: string }) =>
      void stopped.push(answerId),
    deleteConversation: () => deleting,
    askExampleReadyQuestion: () => exampleAsk(),
    askMeetingHelp: () => helpAsk(),
  },
  {
    get: (target: object, name: string) =>
      name in target ? (target as Record<string, unknown>)[name] : async () => undefined,
  },
);

let conversations: typeof import("../../src/renderer/src/conversations");

/** Kept by the browser: localStorage for good, sessionStorage through a reload of the page. */
function storage(): Storage {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  } as Storage;
}

beforeAll(async () => {
  Object.assign(globalThis, {
    window: { incarnamind: bridge, incarnamindFiles: bridge },
    localStorage: storage(),
    sessionStorage: storage(),
  });
  conversations = await import("../../src/renderer/src/conversations");
});

afterAll(() => {
  Object.assign(globalThis, {
    window: undefined,
    localStorage: undefined,
    sessionStorage: undefined,
  });
});

beforeEach(() => {
  reads.clear();
  readsAsked.length = 0;
  stopped.length = 0;
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

/** Lets the ask's reply be handled until it has asked for the new conversation's messages. */
async function untilRead(id: string) {
  for (let turn = 0; turn < 10 && !readsAsked.includes(id); turn++) await Promise.resolve();
  expect(readsAsked).toContain(id);
}

test("a new conversation's first read doesn't replace a newer one the User opened it with since", async () => {
  const first = held<{ messages: ConversationMessage[] }>();
  reads.set("new", first.promise);
  const { reply, asked } = askHeld();
  reply.settle(askedIn("new"));
  await untilRead("new");
  // The User opens another conversation, then this one, which reads it again, before the first read.
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

const answerTo = (conversationId: string): ConversationMessage =>
  ({
    kind: "answer",
    id: `answer in ${conversationId}`,
    conversationId,
    questionId: `question in ${conversationId}`,
    status: "streaming",
    text: "The first words",
  }) as unknown as ConversationMessage;

test("an Answer written while a new conversation is read never shows above its Question (#1741)", async () => {
  const first = held<{ messages: ConversationMessage[] }>();
  reads.set("new", first.promise);
  const drawn: (readonly ConversationMessage[])[] = [];
  const unsubscribe = conversations.useConversations.subscribe(({ messages }) =>
    drawn.push(messages),
  );
  const { reply, asked } = askHeld();
  reply.settle(askedIn("new"));
  await untilRead("new");
  // Written before the core read the conversation, its first words come ahead of the read.
  listeners.get("conversation.message")?.(answerTo("new"));
  first.settle({ messages: [question("new"), answerTo("new")] });
  await asked;
  unsubscribe();

  // The thread draws its messages, then the Question still on its way: never an Answer before it.
  expect(drawn.filter((messages) => messages.at(0)?.kind === "answer")).toEqual([]);
  expect(shown()).toBe("new");
  expect(conversations.useConversations.getState().messages).toEqual([
    question("new"),
    answerTo("new"),
  ]);
});

test("Stop pressed while a new conversation is read stops its Answer", async () => {
  const first = held<{ messages: ConversationMessage[] }>();
  reads.set("new", first.promise);
  const { reply, asked } = askHeld();
  reply.settle(askedIn("new"));
  await untilRead("new");
  conversations.stopWriting();
  first.settle({ messages: [question("new"), answerTo("new")] });
  await asked;

  expect(stopped).toEqual(["answer in new"]);
});

/** A call being recorded, whose help buttons ask in the assistant. */
async function inACall() {
  const { useMeetings } = await import("../../src/renderer/src/meetings");
  const call = { id: "call", mindId: "notes", kind: "meeting", status: "recording" };
  useMeetings.setState({ meetings: [call as Meeting] });
  return import("../../src/renderer/src/meetingHelp");
}

test.each(["open another conversation", "start a New chat"] as const)(
  "help asked during a call doesn't take the User away when they %s while it is asked",
  async (move) => {
    const { askHelpInAssistant } = await inACall();
    const reply = held<ConversationAskResult>();
    helpAsk = () => reply.promise;
    const asking = askHelpInAssistant("sum");
    if (move === "open another conversation") await conversations.openConversation("other");
    else conversations.startNewChat();
    reply.settle(askedIn("help"));
    await asking;

    expect(shown()).toBe(move === "open another conversation" ? "other" : null);
    expect(readsAsked).not.toContain("help");
  },
);

test("help asked during a call doesn't take the User from a Question they asked in the new chat meanwhile", async () => {
  const { askHelpInAssistant } = await inACall();
  const help = held<ConversationAskResult>();
  helpAsk = () => help.promise;
  const asking = askHelpInAssistant("sum");
  const { reply, asked } = askHeld();
  reply.settle(askedIn("new"));
  await asked;
  help.settle(askedIn("help"));
  await asking;

  expect(shown()).toBe("new");
  expect(readsAsked).not.toContain("help");
});

test.each(["first", "last"] as const)(
  "the help pressed last in a New chat shows when the help pressed before it comes back %s",
  async (order) => {
    const { askHelpInAssistant } = await inACall();
    const replies = [held<ConversationAskResult>(), held<ConversationAskResult>()];
    const [first, second] = replies;
    let asks = 0;
    helpAsk = () => (replies[asks++] as (typeof replies)[number]).promise;
    const pressed = [askHelpInAssistant("sum"), askHelpInAssistant("ask")];
    if (order === "first") first?.settle(askedIn("help1"));
    second?.settle(askedIn("help2"));
    if (order === "last") first?.settle(askedIn("help1"));
    await Promise.all(pressed);

    expect(shown()).toBe("help2");
  },
);

test("help asked during a call shows its conversation when the User stayed", async () => {
  const { askHelpInAssistant } = await inACall();
  helpAsk = async () => askedIn("help");
  await askHelpInAssistant("sum");

  expect(shown()).toBe("help");
});

/** The window as a reload of its page leaves it, with the conversation it showed kept. */
async function reloadedShowing(conversationId: string) {
  sessionStorage.setItem("incarnamind.window.conversation", JSON.stringify(conversationId));
  const { installWindowMemory } = await import("../../src/renderer/src/windowMemory");
  installWindowMemory();
}

test("a New chat clicked while a reload shows the conversation again stays a New chat", async () => {
  const restoring = held<{ messages: ConversationMessage[] }>();
  reads.set("kept", restoring.promise);
  await reloadedShowing("kept");
  conversations.startNewChat();
  restoring.settle({ messages: [question("kept")] });
  // A second reload starts in the New chat too: what is kept says so once the read is done.
  await vi.waitFor(() =>
    expect(sessionStorage.getItem("incarnamind.window.conversation")).toBeNull(),
  );

  expect(readsAsked).toContain("kept");
  expect(shown()).toBeNull();
});

test("a reload shows the conversation it showed again when the User stayed", async () => {
  await reloadedShowing("kept");
  await vi.waitFor(() => expect(shown()).toBe("kept"));

  expect(conversations.useConversations.getState().messages).toEqual([question("kept")]);
});
