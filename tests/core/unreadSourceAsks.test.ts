import { expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel, type Plan, requestedFigures } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

const OWN_LINES =
  "Absence: no\nScope: none, same\nTopic: found\nRoles: none / none, same\nTime: none / none, same\nDuty: none / none, same\nCondition: none / none, same";

const cite = (quote: string) => ({
  tool: "cite",
  input: { citations: [{ marker: 1, passage: "P1", quote }] },
});

/** Check this Note's mark for one sentence over one Document, on a provider offered `calculate`. */
async function checked(contents: string, claim: string, plan: Plan) {
  const calls: ModelCall[] = [];
  const { core, client, mind } = await setUpWithDocuments(checkingModel({ [claim]: plan }, calls), [
    { name: "Report.md", contents: `${contents}\n` },
  ]);
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
  writeMind(client, [
    { type: "paragraph", attrs: { id: "block-1" }, content: [{ type: "text", text: claim }] },
  ]);
  await client.settled();
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "block-1", offset: 0 },
    to: { blockId: "block-1", offset: claim.length },
  });
  await client.settled();
  const [span] = claimSpans(readMind(client));
  const asks = calls
    .map((call) => call.prompt.trimEnd().slice(-400))
    .filter((tail) => tail.includes("write your whole reply again"));
  return { state: span?.check.state, reason: span?.check.reason, asks: [...new Set(asks)] };
}

const MEMBERS = "Members at 31 March numbered 2,360, against 2,105 a year before.";

/**
 * As Claude Haiku 5.5 checked a count: a Figures line on a marker it never recorded, the cite
 * when asked for it, and the number's reading only when asked which of two it is.
 */
const skipsCite = (call: ModelCall) => {
  const [figure] = requestedFigures(call);
  const cited = call.results.some((result) => result.tool === "cite");
  if (!cited && call.prompt.includes("never recorded")) return { calls: [cite(MEMBERS)] };
  const reading = call.prompt.includes("can be read two ways") ? 1 : null;
  const figures = {
    items: [
      {
        id: figure?.id,
        verdict: "supported",
        scope: "same",
        topic: "found",
        roles: "same",
        says: null,
        reading,
        relation: "equals",
        source: { citation: 1, number: "2,360", reading, unitQuote: null },
        calculation: null,
      },
    ],
    remainder: null,
  };
  return {
    text: `Found: "${MEMBERS}"\nVerdict: supported\n${OWN_LINES}\nExplanation: The Document gives the count.\nEvidence: [1]\nFigures: ${JSON.stringify(figures)}`,
  };
};

// protects=a count whose quote the model recorded only when asked still gets its ✓ where the Document's one line leaves "2,360" two readings: the reading is asked for after the quote is there, as it is when the cite wasn't skipped, and a sentence with another number is caught by the comparison, never ✓; fails_when=the missing cite and the unread source share one ask again, so the check ends Not checked with "the model's quote isn't in that Document" over a quote it recorded; no_claim=which reading a real model gives, or a Document long enough to tell its separators.
test("a number's reading is still asked for after the ask for its skipped cite (#3190)", async () => {
  const right = await checked(MEMBERS, "Membership was 2,360 at the end of March.", {
    reply: skipsCite,
  });
  const wrong = await checked(MEMBERS, "Membership was 2,630 at the end of March.", {
    judgement: "conflict",
    reply: skipsCite,
  });

  expect(right.asks).toHaveLength(2);
  expect(right.asks[0]).toContain("never recorded");
  expect(right.asks[1]).toContain('"2,360" can be read two ways in this Document');
  expect(right.asks[1]).not.toContain("never recorded");
  expect({ state: right.state, reason: right.reason }).toEqual({
    state: "supported",
    reason: null,
  });
  expect(wrong.state).toBe("contradicted");
});

const plainReply = (verdict: "supported" | "contradicted", change = "") =>
  `Verdict: ${verdict}\n${OWN_LINES}\nExplanation: The Document gives both counts. [^1]\n${change}Evidence: [1]\nCalculation: none`;

/** Records the quote, with a difference worked out beside it where `stated` is given, then replies. */
const quotes =
  (quote: string, text: string, numbers?: readonly [string, string], stated?: string) =>
  (call: ModelCall) =>
    call.results.some((result) => result.tool === "cite")
      ? { text }
      : {
          calls: [
            cite(quote),
            ...(numbers && stated
              ? [
                  {
                    tool: "calculate",
                    input: {
                      figures: [
                        {
                          marker: 1,
                          label: "Change over the year",
                          inputs: [
                            { name: "now", label: "This year", citation: 1, number: numbers[0] },
                            { name: "prev", label: "Last year", citation: 1, number: numbers[1] },
                          ],
                          formula: "now - prev",
                          stated,
                          relation: "equals",
                        },
                      ],
                    },
                  },
                ]
              : []),
          ],
        };

const NO_FIGURE = [
  {
    contents: "期末签约客户为 86 家，上年期末为 74 家。",
    quote: "期末签约客户为 86 家，上年期末为 74 家",
    numbers: ["86", "74"],
    right: { claim: "签约客户比上年有所增加。", stated: "增加" },
    wrong: { claim: "签约客户比上年有所减少。", stated: "减少" },
  },
  {
    contents: "Branches at year end numbered 41, against 37 a year earlier.",
    quote: "Branches at year end numbered 41, against 37 a year earlier.",
    numbers: ["41", "37"],
    right: { claim: "The number of branches rose over the year.", stated: "rose" },
    wrong: { claim: "The number of branches fell over the year.", stated: "fell" },
  },
] as const;

// protects=a sentence that states no number reads as the model's verdict on its recorded quote, Supported for the right direction and Contradicted for the wrong one, whether or not the model also worked out the difference with calculate and named the sentence's verb as the stated quantity; fails_when=that calculate call, which no repair can bind to a sentence without a number, ends the check Not checked with "the model's quote isn't in that Document"; no_claim=a sentence that does state a quantity (the next test), or what a real model answers.
test.each(NO_FIGURE)(
  "a calculation beside the quote of a sentence with no number changes nothing: $right.claim (#3190)",
  async ({ contents, quote, numbers, right, wrong }) => {
    const change = `Change 1: ${wrong.stated}\nTo 1: ${quote} [^1]\n`;
    const marks = [];
    for (const stated of [undefined, "stated"] as const) {
      marks.push(
        await checked(contents, right.claim, {
          reply: quotes(quote, plainReply("supported"), numbers, stated && right.stated),
        }),
        await checked(contents, wrong.claim, {
          judgement: "conflict",
          reply: quotes(quote, plainReply("contradicted", change), numbers, stated && wrong.stated),
        }),
      );
    }

    expect(marks.map(({ state, reason }) => [state, reason])).toEqual([
      ["supported", null],
      ["contradicted", null],
      ["supported", null],
      ["contradicted", null],
    ]);
  },
);

// protects=a sentence that states a quantity still needs the calculation the model was refused: a stated value that is no quantity of the sentence, left unrepaired, keeps the sentence from a ✓; fails_when=the rule for a sentence with no number is widened to one that has a number; no_claim=which reason the mark gives.
test("a refused calculation still stops a sentence that states a quantity", async () => {
  const [{ contents, quote, numbers }] = NO_FIGURE;
  const claim = "签约客户比上年增加 12 家。";
  const mark = await checked(contents, claim, {
    reply: quotes(quote, plainReply("supported"), numbers, "增加"),
  });

  expect(mark.state).toBe("not-checked");
});
