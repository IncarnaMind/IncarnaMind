import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { keepRequestWords, requestWordsOf } from "../../eval/everyday/requestWords";
import type { AnswerToolCall } from "../../src/core";
import { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { scriptedModel } from "../helpers/models";

const MINDS = [{ id: "q3", name: "Q3 review" }];
const names = (id: string) => MINDS.find((mind) => mind.id === id)?.name ?? null;

const edit = (status: "done" | "failed"): AnswerToolCall => ({
  id: "edit-1",
  tool: "edit_mind",
  source: "minds",
  input: { instruction: "Make it longer" },
  status,
  resultCount: null,
  ...(status === "done" && {
    mindChange: { mindId: "q3", created: false, request: "r1", proposals: 2 },
  }),
});

/** The app's check with a quick model that answers the request question `told`. */
async function checked(told: string, calls: AnswerToolCall[]) {
  const words = keepRequestWords();
  const model = wrapLanguageModel({
    model: scriptedModel(() => ({ text: "" }), {
      generate: (call) => ({ text: call.question === "request-done" ? told : '{"claims":[]}' }),
    }),
    middleware: words.middleware,
  });
  const result = await unbackedClaims("Done.", calls, MINDS, null, {
    model,
    request: "Make Q3 review longer.",
    names,
    states: () => ({ waiting: 0, accepted: 0, rejected: 0, applied: true }),
    signal: new AbortController().signal,
  });
  return { result, told: words.take(), after: words.take() };
}

describe("The words the request question gave, kept beside each check", () => {
  test("are kept as given, with the check unmarked, when the app reads them", async () => {
    const { result, told, after } = await checked('{"asks_change":"yes","request":"done"}', [
      edit("failed"),
    ]);
    expect(told).toEqual({ asks_change: "yes", request: "done" });
    expect(result.unfinished).toBe(true);
    expect(result.failed).toBeUndefined();
    expect(after).toBeUndefined();
  });

  test("keep a missing word as null beside the check's failed mark", async () => {
    const { result, told } = await checked('{"request":"done"}', [edit("failed")]);
    expect(told).toEqual({ asks_change: null, request: "done" });
    expect(result.failed).toBe(true);
    expect(result.unfinished).toBeUndefined();
  });

  test("keep a reply with no JSON object as its text", async () => {
    const { result, told } = await checked("I can't tell from this.", [edit("failed")]);
    expect(told).toEqual({ asks_change: null, request: null, text: "I can't tell from this." });
    expect(result.failed).toBe(true);
  });

  test("are none when the check didn't ask the question", async () => {
    const { result, told } = await checked('{"asks_change":"yes","request":"done"}', [
      edit("done"),
    ]);
    expect(told).toBeUndefined();
    expect(result.unfinished).toBeUndefined();
  });

  test("are read from a tool call's input, as a provider without JSON output returns them", () => {
    const call = {
      type: "tool-call",
      toolCallId: "json-1",
      toolName: "json",
      input: '{"asks_change":"no","request":"none"}',
    };
    expect(requestWordsOf([call])).toEqual({ asks_change: "no", request: "none" });
  });
});
