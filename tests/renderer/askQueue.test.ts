import { beforeEach, expect, test } from "vitest";
import {
  draftWithQueued,
  giveBackQueuedAsk,
  type QueuedAsk,
  queueAsk,
  returnToBox,
  takeQueuedAsk,
  useAskQueue,
} from "../../src/renderer/src/askQueue";
import { type Draft, useComposer } from "../../src/renderer/src/composer";

const quote = (text: string) => ({
  documentId: "doc-1",
  documentName: "Tides",
  quote: text,
  pageFrom: null,
  pageTo: null,
  location: null,
});

const asking = (text: string): QueuedAsk => ({
  input: { mindId: "mind-1", text },
  draft: { text, pastes: [], skill: null, analyse: false, quotes: [] },
  stayed: () => true,
});

const box = (change: Partial<Draft>): Draft => ({
  text: "",
  scope: null,
  skill: null,
  pastes: [],
  ...change,
});

beforeEach(() => {
  useAskQueue.setState({ waiting: null });
  useComposer.setState({ drafts: {}, focusWanted: false });
});

test("one waits at most: a second Question replaces the first", () => {
  queueAsk(asking("first"));
  queueAsk(asking("second"));

  expect(useAskQueue.getState().waiting?.input.text).toBe("second");
});

test("taking the queued Question clears it, and nothing is taken twice", () => {
  queueAsk(asking("first"));

  expect(takeQueuedAsk()?.input.text).toBe("first");
  expect(useAskQueue.getState().waiting).toBeNull();
  expect(takeQueuedAsk()).toBeNull();
});

test("cancelling puts its words back in an empty box, unsent, and gives it the cursor", () => {
  queueAsk(asking("And neap tides?"));

  giveBackQueuedAsk("mind-1");

  expect(useAskQueue.getState().waiting).toBeNull();
  expect(useComposer.getState().draft("mind-1").text).toBe("And neap tides?");
  expect(useComposer.getState().focusWanted).toBe(true);
});

test("cancelling with nothing queued changes nothing", () => {
  useComposer.getState().update("mind-1", { text: "typed since" });

  giveBackQueuedAsk("mind-1");

  expect(useComposer.getState().draft("mind-1").text).toBe("typed since");
  expect(useComposer.getState().focusWanted).toBe(false);
});

test("words typed since keep their place: the queued words come ahead of them, neither lost", () => {
  const now = box({ text: "and why", pastes: [], quotes: [quote("new moon")] });

  expect(
    draftWithQueued(
      {
        text: "When do spring tides happen?",
        pastes: [],
        skill: null,
        analyse: false,
        quotes: [quote("full moon")],
      },
      now,
    ),
  ).toEqual({
    text: "When do spring tides happen?\nand why",
    pastes: [],
    skill: null,
    analyse: false,
    quotes: [quote("full moon"), quote("new moon")],
  });
});

test("a Skill chosen since wins, a pasted text and Analyse come back with the Question", () => {
  const paste = {
    id: "paste-1",
    text: "a long paste",
    place: { mindId: null, conversationId: null },
  };

  expect(
    draftWithQueued(
      { text: "Summarise", pastes: [paste], skill: "summarise", analyse: true, quotes: [] },
      box({ skill: "translate" }),
    ),
  ).toMatchObject({ text: "Summarise", pastes: [paste], skill: "translate", analyse: true });

  expect(
    draftWithQueued(
      { text: "Summarise", pastes: [paste], skill: "summarise", analyse: true, quotes: [] },
      box({}),
    ),
  ).toMatchObject({ skill: "summarise" });
});

test("a Question that wasn't asked returns to the box it is named for", () => {
  useComposer.getState().update("assistant", { text: "" });

  returnToBox("assistant", {
    text: "你好吗？",
    pastes: [],
    skill: null,
    analyse: false,
    quotes: [],
  });

  expect(useComposer.getState().draft("assistant").text).toBe("你好吗？");
});
