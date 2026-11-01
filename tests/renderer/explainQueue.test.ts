import { expect, test } from "vitest";
import type { QueuedExplain } from "../../src/renderer/src/explainQueue";
import {
  cancelExplain,
  queueExplain,
  takeExplain,
  useExplainQueue,
} from "../../src/renderer/src/explainQueue";

const question = (quote: string): QueuedExplain => ({
  mindId: "mind-1",
  text: `Explain “${quote}”`,
  focus: { selection: quote, blockIds: ["block-1"] },
  scope: { folderIds: [], tagIds: [], documentIds: [] },
  model: null,
});

test("one waits at most: a second Explain replaces the first", () => {
  queueExplain(question("first"));
  queueExplain(question("second"));

  expect(useExplainQueue.getState().waiting?.text).toBe("Explain “second”");
});

test("taking the queued Explain clears it, and cancelling drops it", () => {
  queueExplain(question("first"));
  expect(takeExplain()?.text).toBe("Explain “first”");
  expect(useExplainQueue.getState().waiting).toBeNull();
  expect(takeExplain()).toBeNull();

  queueExplain(question("second"));
  cancelExplain();
  expect(useExplainQueue.getState().waiting).toBeNull();
});
