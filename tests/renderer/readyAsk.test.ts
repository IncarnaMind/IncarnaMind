import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
  AskInConversationInput,
  ConversationAskResult,
  ExampleReadyAsked,
} from "../../src/core/api";
import type { AppState } from "../../src/renderer/src/store";

/*
 * The card's one click asks the Question the button showed, not one the core reads again at click
 * time, and starts a fresh conversation so the example's earlier turns never reach the model. The
 * example's Answer waits while its Documents are read, saying so, and Stop stops it (#2218).
 */

const asked: AskInConversationInput[] = [];
let readyReads = 0;
let answer: () => Promise<ConversationAskResult> = async () => ({
  asked: false,
  reason: "not-ready",
  readiness: { ready: false, reason: "no-provider" },
});
/** What the example's ready Question does: resolves when the test says its Documents are read. */
let exampleAsk: () => Promise<ExampleReadyAsked> = async () => ({
  conversationId: "example's conversation",
  answerId: "example's answer",
  stopped: false,
});
let exampleStops = 0;

const bridge = new Proxy(
  {
    on: () => () => undefined,
    listConversations: async () => [],
    getConversation: async () => ({ messages: [] }),
    getSettings: async () => ({ device: {} }),
    updateSettings: async () => undefined,
    readyQuestion: async () => {
      readyReads += 1;
      return null;
    },
    askInConversation: async (input: AskInConversationInput) => {
      asked.push(input);
      return answer();
    },
    askExampleReadyQuestion: async () => exampleAsk(),
    stopExampleReadyQuestion: async () => {
      exampleStops += 1;
    },
  },
  {
    get: (target: object, name: string) =>
      name in target ? (target as Record<string, unknown>)[name] : async () => undefined,
  },
);

let conversations: typeof import("../../src/renderer/src/conversations");
let useConversations: typeof import("../../src/renderer/src/conversations").useConversations;
let useReadyAsk: typeof import("../../src/renderer/src/conversations").useReadyAsk;
let useModelSetup: typeof import("../../src/renderer/src/modelSetup").useModelSetup;
let useAnswers: typeof import("../../src/renderer/src/answers").useAnswers;
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;

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
  useReadyAsk = conversations.useReadyAsk;
  useModelSetup = (await import("../../src/renderer/src/modelSetup")).useModelSetup;
  useAnswers = (await import("../../src/renderer/src/answers")).useAnswers;
  useAppStore = (await import("../../src/renderer/src/store")).useAppStore;
});

afterAll(() => {
  Object.assign(globalThis, { window: undefined, localStorage: undefined });
});

const rendered = {
  question: "What does ‘Harbour brief’ say?",
  scope: { folderIds: [], tagIds: [], documentIds: ["harbour"] },
  waitingFor: null,
};

/** The example's, waiting for the Document still being read. */
const example = {
  question: "What leverage does the agreement allow?",
  scope: null,
  waitingFor: "Northwind Retail · Q3 2026 results",
};

const steps = (askedReady: boolean) =>
  ({
    user: { language: "en", chatModel: null },
    device: {
      gettingStarted: {
        started: true,
        citationChecked: false,
        mistakeSeen: false,
        indexed: true,
        askedOwn: false,
        askedReady,
        exported: false,
        hidden: false,
      },
    },
    language: "en",
  }) as unknown as AppState["settings"];

/** A promise this test settles when the read it stands for is done. */
function held<T>(): { promise: Promise<T>; settle(value: T): void } {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

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

describe("the example's ready Question while its Documents are read (#2218)", () => {
  // protects=the press says it is waiting at once, and the Answer opens the conversation once the read finishes; fails_when=the press does nothing until the read ends, or never says it is waiting
  test("says it is waiting at once, and answers when the read finishes", async () => {
    const read = held<ExampleReadyAsked>();
    exampleAsk = () => read.promise;
    useReadyAsk.setState({ asking: false });
    const accepted = conversations.askReadyQuestion(example);
    // Before the core answers: the card's row says what it is reading, and can stop it.
    expect(useReadyAsk.getState().asking).toBe(true);
    read.settle({ conversationId: "asked", answerId: "answer", stopped: false });
    expect(await accepted).toBe(true);
    expect(useReadyAsk.getState().asking).toBe(false);
    expect(useConversations.getState().openId).toBe("asked");
  });

  // protects=an Answer that is there at once shows no waiting state; fails_when=the row says it is reading after the Answer is in
  test("an Answer that is ready at once leaves no waiting state", async () => {
    exampleAsk = async () => ({ conversationId: "asked", answerId: "answer", stopped: false });
    const accepted = await conversations.askReadyQuestion(example);
    expect(await accepted).toBe(true);
    expect(useReadyAsk.getState().asking).toBe(false);
    expect(useConversations.getState().openId).toBe("asked");
  });

  // protects=a Document that can't be read says why where the button is, with the way on; fails_when=it is a notice that passes, or nothing at all
  test("a Document that can't be read says why in the card's row", async () => {
    exampleAsk = async () => {
      throw new Error(
        "The example’s Document “Northwind Retail · Q3 2026 results” couldn’t be read. Add a file of your own, or remove the examples.",
      );
    };
    useAnswers.setState({ blocked: {} });
    const accepted = await conversations.askReadyQuestion(example);
    expect(await accepted).toBe(false);
    expect(useAnswers.getState().blocked["composer:assistant"]).toMatchObject({
      kind: "error",
      message:
        "The example’s Document “Northwind Retail · Q3 2026 results” couldn’t be read. Add a file of your own, or remove the examples.",
    });
  });

  // protects=Stop stops the wait; fails_when=Stop leaves the core waiting, or the press cannot be stopped at all
  test("Stop stops the wait", async () => {
    const read = held<ExampleReadyAsked>();
    exampleAsk = () => read.promise;
    exampleStops = 0;
    const accepted = conversations.askReadyQuestion(example);
    expect(useReadyAsk.getState().asking).toBe(true);
    conversations.stopReadyAsk();
    expect(exampleStops).toBe(1);
    read.settle({ conversationId: "asked", answerId: "answer", stopped: true });
    expect(await accepted).toBe(false);
    expect(useReadyAsk.getState().asking).toBe(false);
    // Its Question and a stopped Answer are kept, where the User asked.
    expect(useConversations.getState().openId).toBe("asked");
  });

  // protects=the row says what this ask is reading, not what the last one failed at; fails_when=an old problem stays beside the new reading line
  test("a new ask clears the last one's problem", async () => {
    useAnswers.setState({
      blocked: { "composer:assistant": { kind: "error", message: "The last ask failed." } },
    });
    exampleAsk = async () => ({ conversationId: "asked", answerId: "answer", stopped: false });
    await conversations.askReadyQuestion(example);
    expect(useAnswers.getState().blocked["composer:assistant"]).toBeUndefined();
  });

  // protects=a stopped Answer does not tick step 2, so the card stays to ask again; fails_when=Stop counts as answered
  test("a stopped Answer leaves step 2 open", async () => {
    useAppStore.setState({ settings: steps(false) });
    exampleAsk = async () => ({ conversationId: "asked", answerId: "answer", stopped: true });
    await conversations.askReadyQuestion(example);
    expect(useAppStore.getState().settings?.device.gettingStarted.askedReady).toBe(false);
  });
});
