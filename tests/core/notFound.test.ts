import { describe, expect, test } from "vitest";
import { SEARCH_AGAIN } from "../../src/core/answers/checks/claimCheck";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { saysNotFound } from "../../src/shared/claimChecks";
import { checkingModel, isCheckRun, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
  ].join("\n"),
};

const SENTENCE = "The biggest tides come twice a lunar month.";
const FOUND: Plan = {
  verdict: "supported",
  quote: "Spring tides happen at new moon and at full moon",
  says: "Tides says spring tides happen at new and full moon.",
};

/** Checks SENTENCE, alone in a Mind beside Tides, with a model that checks as `plan` says. */
async function check(plan: Plan, sentence = SENTENCE, document = TIDES) {
  const calls: ModelCall[] = [];
  const { core, client, mind } = await setUpWithDocuments(
    checkingModel({ [sentence]: plan }, calls),
    [document],
  );
  const block = {
    type: "paragraph",
    attrs: { id: "block-1" },
    content: [{ type: "text", text: sentence }],
  };
  writeMind(client, [block]);
  await client.settled();
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    action: "find-support",
    from: { blockId: "block-1", offset: 0 },
    to: { blockId: "block-1", offset: sentence.length },
  });
  await client.settled();
  const runs = calls.filter(isCheckRun);
  const last = runs.at(-1)?.options.prompt ?? [];
  const queries = last.flatMap((message) =>
    message.role === "assistant" && typeof message.content !== "string"
      ? message.content.flatMap((part) =>
          part.type === "tool-call" && part.toolName === "search_documents"
            ? [String((part.input as { query?: unknown }).query)]
            : [],
        )
      : [],
  );
  const checked = claimSpans(readMind(client))[0]?.check;
  return {
    check: checked,
    notFound:
      checked?.state === "unsupported" && saysNotFound({ state: "unsupported" }, checked, 0),
    queries,
    askedAgain: runs.filter((call) => call.prompt.includes(SEARCH_AGAIN)).length,
    runs: runs.length,
  };
}

describe("Before a check says a sentence isn't found (#1608)", () => {
  test("it searches again with words the model chooses, and a Passage found then backs the sentence", async () => {
    const checked = await check({
      verdict: "unsupported",
      again: { query: "spring tides new moon full moon", plan: FOUND },
    });

    expect(checked.queries).toEqual([SENTENCE, "spring tides new moon full moon"]);
    expect(checked.askedAgain).toBeGreaterThan(0);
    expect(checked.check?.state).toBe("supported");
    expect(checked.check?.evidence?.quote).toBe("Spring tides happen at new moon and at full moon");
  });

  test("still nothing after the second search: the sentence is unsupported with nothing quoted, and it is asked only once", async () => {
    const checked = await check({
      verdict: "unsupported",
      again: { query: "lunar month tide size", plan: { verdict: "unsupported" } },
    });

    expect(checked.queries).toEqual([SENTENCE, "lunar month tide size"]);
    expect(checked.check?.state).toBe("unsupported");
    expect(checked.check?.evidence).toBeNull();
    expect(checked.notFound).toBe(true);
    // The ask is the last message of every request after it: one ask, two requests that carry it.
    expect(checked.runs).toBe(checked.askedAgain + 2);
  });

  test("“not found” on no quote is asked to search again, as the older “unsupported” is", async () => {
    const checked = await check({
      verdict: "not found",
      again: { query: "spring tides new moon full moon", plan: FOUND },
    });

    expect(checked.askedAgain).toBeGreaterThan(0);
    expect(checked.check?.state).toBe("supported");
  });

  test.each([
    {
      verdict: "overstated",
      says: "Tides says when spring tides come, not that they are the biggest.",
    },
    { verdict: "partly supported", says: "Tides doesn't say they are the biggest." },
    { verdict: "not found", says: "Tides says when spring tides come, not how big they are." },
  ] as const)("$verdict on a quote it recorded isn't sent back to search", async (plan) => {
    const checked = await check({
      ...plan,
      quote: "Spring tides happen at new moon and at full moon",
      again: { query: "tide size lunar month", plan: FOUND },
    });

    expect(checked.askedAgain).toBe(0);
    expect(checked.queries).toEqual([SENTENCE]);
    expect(checked.check?.state).toBe("unsupported");
  });

  test("a check that finds its Passage sends nothing more", async () => {
    const found = await check(FOUND);

    expect(found.askedAgain).toBe(0);
    expect(found.queries).toEqual([SENTENCE]);
    expect(found.check?.state).toBe("supported");
  });
});
