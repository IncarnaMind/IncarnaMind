/**
 * The guard that fails a test whose scripted model was asked a judge's question it had no reply
 * for (tests/setup/judges.ts, #2895): for a question that streams too, the retries of an Answer's
 * quotes and figures, and the Citations it left out.
 */
import { describe, expect, test } from "vitest";
import { judge } from "../../src/core/answers/judge";
import { CORRECTIONS_REPLY } from "../../src/core/answers/quoteRetry";
import { CITED_REPLY } from "../../src/core/answers/unmarkedQuotes";
import { type ModelCall, type ScriptedReply, scriptedModel, UNSCRIPTED } from "./models";

const NO_QUOTES: ScriptedReply = { text: '{"quotes":[]}' };

function retryQuotes(script: (call: ModelCall) => ScriptedReply) {
  return judge({
    model: scriptedModel(script),
    question: { id: "quote-retry", instructions: "Quote the Passages again." },
    parts: [{ tag: "sentence", text: "Spring tides come at new moon." }],
    data: ["sentence"],
    reply: CORRECTIONS_REPLY,
    retries: 0,
    signal: new AbortController().signal,
    stream: true,
  });
}

function askForCitations(script: (call: ModelCall) => ScriptedReply) {
  return judge({
    model: scriptedModel(script),
    question: { id: "unmarked-quotes", instructions: "Find the Citations." },
    parts: [{ tag: "sentence", text: "Spring tides come at new moon." }],
    data: ["sentence"],
    reply: CITED_REPLY,
    retries: 0,
    signal: new AbortController().signal,
    stream: true,
  });
}

describe("a judge's question that streams", () => {
  // protects=a script that never looks at which question a request asks, or whether it wants JSON, can't be taken for one that has a reply to a judge's question, so the question fails the test instead of passing as a check that failed closed (#2895); fails_when=the blind script's reply is read and nothing is recorded; no_claim=what the question's reply says.
  test("fails the test when the script never looks at the question", async () => {
    UNSCRIPTED.length = 0;

    const judged = await retryQuotes(() => NO_QUOTES);

    expect(judged).toMatchObject({ ok: false, reason: "failed" });
    expect(UNSCRIPTED).toEqual([expect.stringContaining("quote-retry")]);
    UNSCRIPTED.length = 0;
  });

  test("is answered when the script looks at it, by its name or by the JSON it asks for", async () => {
    const named = await retryQuotes((call) =>
      call.question === "quote-retry" ? NO_QUOTES : { text: "Not this." },
    );
    const byShape = await retryQuotes((call) => (call.json ? NO_QUOTES : { text: "Not this." }));

    expect(named).toMatchObject({ ok: true });
    expect(byShape).toMatchObject({ ok: true });
    expect(UNSCRIPTED).toEqual([]);
  });

  test("finds no Citations for an Answer when the script never looks at the question, and fails nothing", async () => {
    const judged = await askForCitations(() => ({ text: "The Answer, again." }));

    expect(judged).toMatchObject({ ok: true, value: [] });
    expect(UNSCRIPTED).toEqual([]);
  });
});
