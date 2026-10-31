import { describe, expect, test } from "vitest";
import { SEARCH_AGAIN, searchAgain } from "../../src/core/answers/checks/searchAgain";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readClaimCheck, saysNotFound } from "../../src/shared/claimChecks";
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
const TIDES_ZH = {
  name: "潮汐.md",
  contents: "# 潮汐\n\n潮汐中的大潮出现在新月和满月，太阳和月球共同产生引力。",
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

  test("a check that finds its Passage, or names the part a Passage states, sends nothing more", async () => {
    const found = await check(FOUND);
    const part = await check({
      reply: {
        text: "Verdict: unsupported\nTopic: found\nThe Documents name new and full moon only.\nCovered: spring tides\nNot covered: twice a lunar month",
      },
    });

    for (const checked of [found, part]) {
      expect(checked.askedAgain).toBe(0);
      expect(checked.queries).toEqual([SENTENCE]);
    }
    expect(found.check?.state).toBe("supported");
  });

  test("parts named for a topic no Passage is about don't spare the ask, which a model that searched more than once, or not at all, never gets", async () => {
    const reply = "Verdict: unsupported\nThe Documents don't say how often.";
    const fits = () => true;
    const once = searchAgain(() => 1, fits);
    expect((await once.check(reply))?.note).toBe(SEARCH_AGAIN);
    const offTopic = `${reply}\nTopic: not found\nCovered: tides\nNot covered: how often`;
    expect((await once.check(offTopic))?.note).toBe(SEARCH_AGAIN);
    expect(await searchAgain(() => 2, fits).check(reply)).toBeNull();
    expect(await searchAgain(() => 0, fits).check(reply)).toBeNull();
  });

  test("an absence is asked to search again only when its scope is too long to read whole", async () => {
    const absence = "Verdict: unsupported\nAbsence: yes\nThe Documents don't mention one.";
    const once = () => 1;
    expect(await searchAgain(once, () => true).check(absence)).toBeNull();
    expect((await searchAgain(once, () => false).check(absence))?.note).toBe(SEARCH_AGAIN);
  });
});

describe("Not found only when nothing in the scope was about the sentence (#1608)", () => {
  const UNSUPPORTED_ON_TOPIC =
    "Verdict: unsupported\nScope: none, same\nTopic: found\nRoles: none, same\nTides says spring tides come at new and full moon, not how often.";

  test("a reply that says a Passage is about the sentence is Unsupported, with its words, and isn't asked to search again", async () => {
    const checked = await check({ reply: { text: UNSUPPORTED_ON_TOPIC } });

    expect(checked.check?.state).toBe("unsupported");
    expect(checked.check?.unsupported).toMatchObject({
      found: true,
      reason: "Tides says spring tides come at new and full moon, not how often.",
    });
    expect(checked.notFound).toBe(false);
    expect(checked.askedAgain).toBe(0);
  });

  test("a reply that names the part a Passage states, with no Topic line and no quote, is Unsupported and isn't asked again", async () => {
    const checked = await check({
      reply: {
        text: "Verdict: unsupported\nTides doesn't say how often.\nCovered: spring tides\nNot covered: twice a lunar month",
      },
    });

    expect(checked.check?.state).toBe("unsupported");
    expect(checked.check?.unsupported).toMatchObject({ found: true, covered: "spring tides" });
    expect(checked.notFound).toBe(false);
    expect(checked.askedAgain).toBe(0);
  });

  test("must for may, with no part to show, is Unsupported with the check's words", async () => {
    const checked = await check({
      ...FOUND,
      says: "Roles: big tides must come twice / spring tides happen, differs\nTides says spring tides happen at new and full moon.",
    });

    expect(checked.check?.state).toBe("unsupported");
    expect(checked.check?.unsupported).toMatchObject({
      found: true,
      reason: "Tides says spring tides happen at new and full moon.",
    });
    expect(checked.notFound).toBe(false);
  });

  test.each(["same", "neither"] as const)(
    "a contradiction the judgement calls %s is Unsupported: the check found the Passage it quoted",
    async (judgement) => {
      const checked = await check({
        verdict: "contradicted",
        quote: FOUND.quote,
        says: "Tides says spring tides come twice a month, at new and full moon.",
        judgement,
      });

      expect(checked.check?.state).toBe("unsupported");
      expect(checked.check?.unsupported?.found).toBe(true);
      expect(checked.notFound).toBe(false);
    },
  );

  test.each([
    {
      language: "English",
      sentence: SENTENCE,
      says: "Tides says nothing of how often tides come.",
      document: TIDES,
      quote: FOUND.quote,
    },
    {
      language: "Chinese",
      sentence: "最大的潮汐每个朔望月出现两次。",
      says: "文档没有写潮汐出现的频率。",
      document: TIDES_ZH,
      quote: "大潮出现在新月和满月",
    },
  ])(
    "a $language contradiction whose reply says no Passage is about the sentence is Not found",
    async ({ sentence, says, document, quote }) => {
      const checked = await check(
        {
          verdict: "contradicted",
          quote,
          says: `Topic: not found\n${says}`,
          judgement: "neither",
        },
        sentence,
        document,
      );

      expect(
        checked.check?.state,
        JSON.stringify({ reason: checked.check?.reason, detail: checked.check?.detail }),
      ).toBe("unsupported");
      expect(checked.check?.unsupported?.found).toBeUndefined();
      expect(checked.check?.evidence).toBeNull();
      expect(checked.check?.parts?.[0]?.evidence).toEqual([
        expect.objectContaining({ check: "found", quote }),
      ]);
      expect(readClaimCheck(checked.check)).toEqual(checked.check);
      expect(checked.notFound).toBe(true);
    },
  );
});
