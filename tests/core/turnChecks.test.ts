import { describe, expect, test } from "vitest";
import type { AnswerToolCall, ClaimedChange } from "../../src/core";
import {
  type AnswerEngineEvent,
  type AnswerTools,
  createAiSdkAnswerEngine,
} from "../../src/core/answers/engine";
import {
  createNudges,
  MAX_NUDGES,
  settleReply,
  type TurnCheck,
} from "../../src/core/answers/turnChecks";
import { askAndFinish, setUpWithDocuments } from "../helpers/citations";
import { answerIn, answerText } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

/**
 * The end-of-turn checks (#946): one list, run in order when the model
 * stops; each asks at most once, all of them together at most MAX_NUDGES
 * times, never past the step budget; what is left is flagged the same way.
 * And no hard cap of searches: a search that comes twice is told to use
 * what the model has.
 */

const trips = (name: string, claims: ClaimedChange[] = []): TurnCheck => ({
  name,
  check: () => ({ note: `Note from ${name}.`, claims }),
});

describe("The list of end-of-turn checks", () => {
  // protects=checks run in order and the first to trip asks; a check that asked already, or has none left to ask with, only flags; fails_when=a later check asks first, a check asks twice, or the asks pass the total; no_claim=none beyond protects.
  test("the first check to trip asks, each asks once, and the total is MAX_NUDGES", async () => {
    const checks = [trips("first", ["added"]), trips("second", ["made"]), trips("third")];
    const nudges = createNudges(10, () => 0);

    expect(await settleReply(checks, "reply", nudges)).toEqual({ nudge: "Note from first." });
    expect(await settleReply(checks, "reply", nudges)).toEqual({ nudge: "Note from second." });
    expect(MAX_NUDGES).toBe(2);
    // The total is spent: the third doesn't ask, and every check flags what it found.
    const last = await settleReply(checks, "reply", nudges);
    expect(last).toEqual({ claims: ["added", "made"] });
  });

  // protects=a check that finds nothing asks nothing and flags nothing; fails_when=a quiet reply is asked about; no_claim=none beyond protects.
  test("a reply no check trips on is settled with no claims", async () => {
    const quiet: TurnCheck = { name: "quiet", check: () => null };
    expect(
      await settleReply(
        [quiet],
        "reply",
        createNudges(10, () => 0),
      ),
    ).toEqual({ claims: [] });
  });

  // protects=no ask goes past the step budget: with no step left, a check flags and doesn't ask; fails_when=a check asks at the step budget; no_claim=none beyond protects.
  test("with no step left, a check flags instead of asking", async () => {
    const check = trips("claims", ["changed"]);
    expect(
      await settleReply(
        [check],
        "reply",
        createNudges(3, () => 3),
      ),
    ).toEqual({
      claims: ["changed"],
    });
    expect(
      await settleReply(
        [check],
        "reply",
        createNudges(3, () => 2),
      ),
    ).toEqual({
      nudge: "Note from claims.",
    });
  });
});

/** A document search with nothing to find: the checks are what is under test. */
const documents: AnswerTools = {
  documentCount: 1,
  async searchDocuments() {
    return { text: "", passageCount: 0 };
  },
  cite: () => "Recorded.",
};

async function answer(model: ReturnType<typeof scriptedModel>, checks: TurnCheck[], maxSteps = 10) {
  const events: AnswerEngineEvent[] = [];
  for await (const event of createAiSdkAnswerEngine({ maxSteps }).generate({
    instructions: () => "Answer.",
    messages: [{ role: "user", content: "Do it." }],
    question: "Do it.",
    model,
    documents,
    tools: [],
    support: "tools",
    turnChecks: checks,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

describe("An Answer whose reply trips two checks", () => {
  // protects=two checks that trip on every reply cost MAX_NUDGES more model calls and no more, and what they found is flagged once; fails_when=the model is asked more than that, or a flag is lost; no_claim=none beyond protects.
  test("gets at most MAX_NUDGES more model calls, and is flagged with what both found", async () => {
    const model = scriptedModel((call: ModelCall) => ({ text: `Reply ${call.index + 1}.` }));

    const events = await answer(model, [trips("a", ["added"]), trips("b", ["made"])]);

    expect(model.doStreamCalls).toHaveLength(1 + MAX_NUDGES);
    expect(events.filter((event) => event.type === "claims-unbacked")).toEqual([
      { type: "claims-unbacked", claims: ["added", "made"] },
    ]);
    expect(events.at(-1)).toEqual({ type: "finished" });
  });

  // protects=every ask sits inside the step budget: with two steps in all, one ask at most; fails_when=the model is called more times than the budget; no_claim=none beyond protects.
  test("never asks past the step budget", async () => {
    const model = scriptedModel((call: ModelCall) => ({ text: `Reply ${call.index + 1}.` }));

    const events = await answer(model, [trips("a", ["added"]), trips("b", ["made"])], 2);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(events).toContainEqual({ type: "claims-unbacked", claims: ["added", "made"] });
  });

  // protects=a reply that is asked about again and then fails or is refused leaves the reply before it standing, with its flags; fails_when=the Answer fails, or loses its text; no_claim=none beyond protects.
  test("when asking once more fails, the reply before stands, flagged", async () => {
    const model = scriptedModel((call: ModelCall) =>
      call.index === 0 ? { text: "First reply." } : { error: { status: 500, message: "down" } },
    );

    const events = await answer(model, [trips("a", ["added"])]);

    let shown = "";
    for (const event of events) {
      if (event.type === "text-delta") shown += event.text;
      else if (event.type === "text-retracted") shown = shown.slice(0, -event.length);
    }
    expect(shown).toBe("First reply.");
    expect(events).toContainEqual({ type: "claims-unbacked", claims: ["added"] });
    expect(events.at(-1)).toEqual({ type: "finished" });
  });
});

/** 14 short Documents, each about one thing. */
const SUBJECTS = [
  "lighthouse",
  "harbour",
  "ferry",
  "tide",
  "anchor",
  "pilot",
  "buoy",
  "dock",
  "cargo",
  "estuary",
  "mooring",
  "breakwater",
  "channel",
  "shipyard",
];
const FOLDER = SUBJECTS.map((subject) => ({
  name: `${subject}.md`,
  contents: `# The ${subject}\n\nThe ${subject} is described here, with its history and its use in the port.\n`,
}));

const searchCalls = (client: Parameters<typeof answerIn>[0], answerId: string) =>
  (JSON.parse(String(answerIn(client, answerId).attrs.toolCalls)) as AnswerToolCall[]).filter(
    (call) => call.tool === "search_documents",
  );

describe("Searching has no cap, only repeat detection", { timeout: 60_000 }, () => {
  // protects=a model that searches twelve times with different words over fourteen Documents gets all its searches, and the Answer never mentions a limit; fails_when=a search is refused after the fifth, or the model is told it has searched enough; no_claim=how a real model chooses its words.
  test("twelve different searches over fourteen Documents all run", async () => {
    const queries = SUBJECTS.slice(0, 12).map((subject) => `the ${subject} and its history`);
    const model = scriptedModel((call: ModelCall) => {
      const done = call.results.filter((result) => result.tool === "search_documents");
      if (done.length < queries.length) {
        return {
          calls: queries
            .slice(done.length, done.length + 3)
            .map((query) => ({ tool: "search_documents", input: { query } })),
        };
      }
      return { text: "These are the Documents in the port folder, and what each says." };
    });
    const { core, client, mind } = await setUpWithDocuments(model, FOLDER);

    const { answerId } = await askAndFinish(core, client, mind.id, "What do the Documents cover?");

    const searches = searchCalls(client, answerId);
    expect(searches).toHaveLength(12);
    expect(searches.every((call) => call.status === "done" && (call.resultCount ?? 0) > 0)).toBe(
      true,
    );
    const told = model.doStreamCalls
      .at(-1)
      ?.prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" && part.output.type === "text" ? [part.output.value] : [],
            )
          : [],
      );
    expect(told).toHaveLength(12);
    expect(told?.some((text) => /enough|already|limit/i.test(text))).toBe(false);
    expect(answerText(client, answerId)).not.toMatch(/limit/i);
  });

  // protects=a model that repeats one search, in other letters or punctuation, is told once to use what it has, and then answers; fails_when=the repeat runs again, or isn't told; no_claim=none beyond protects.
  test("a repeated search is told once to use what the model has, and then it answers", async () => {
    const model = scriptedModel((call: ModelCall) => {
      const done = call.results.filter((result) => result.tool === "search_documents").length;
      if (done === 0)
        return { calls: [{ tool: "search_documents", input: { query: "the tide" } }] };
      if (done === 1) {
        return { calls: [{ tool: "search_documents", input: { query: "The  tide!" } }] };
      }
      return { text: "The tide is described in its document." };
    });
    const { core, client, mind } = await setUpWithDocuments(model, FOLDER);

    const { answerId } = await askAndFinish(core, client, mind.id, "What is the tide?");

    const results = model.doStreamCalls
      .at(-1)
      ?.prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" && part.output.type === "text" ? [part.output.value] : [],
            )
          : [],
      );
    expect(results).toHaveLength(2);
    expect(results?.[0]).toContain("<passage");
    expect(results?.[1]).toMatch(/already searched for this.*answer with them/);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(answerText(client, answerId)).toBe("The tide is described in its document.");
  });
});
