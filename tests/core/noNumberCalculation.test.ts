import { expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel, type Plan } from "../helpers/checks";
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
  const { core, client, mind } = await setUpWithDocuments(checkingModel({ [claim]: plan }), [
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
  return { state: span?.check.state, reason: span?.check.reason };
}

const plainReply = (verdict: "supported" | "contradicted", change = "", calculation = "none") =>
  `Verdict: ${verdict}\n${OWN_LINES}\nExplanation: The Document gives both counts. [^1]\n${change}Evidence: [1]\nCalculation: ${calculation}`;

const difference = (numbers: readonly [string, string], stated: string) => ({
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
});

type Call = { tool: string; input: unknown };

/** Records the quote, with `beside` in the same turn, then replies. */
const quotes = (quote: string, text: string, beside: readonly Call[]) => (call: ModelCall) =>
  call.results.some((result) => result.tool === "cite")
    ? { text }
    : { calls: [cite(quote), ...beside] };

const NO_NUMBER = [
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

// protects=a sentence that states no number reads as the model's verdict on its recorded quote, Supported for the right direction and Contradicted for the wrong one, whatever the model does with calculate beside the quote: nothing, a difference worked out with the sentence's verb as its stated value, the same with the verb on the reply's Calculation line, or a call the Tool couldn't read; fails_when=a calculate call no repair can bind to a sentence without a number, or a Calculation line naming a word that is no quantity, ends the check Not checked ("the model's quote isn't in that Document", or "the number wasn't worked out"); no_claim=a sentence that does state a quantity (the next test), or what a real model answers.
test.each(NO_NUMBER)(
  "what the model works out beside the quote of a sentence with no number changes nothing: $right.claim (#3190)",
  async ({ contents, quote, numbers, right, wrong }) => {
    const change = `Change 1: ${wrong.stated}\nTo 1: ${quote} [^1]\n`;
    const unread = { tool: "calculate", input: { figures: "the difference" } };
    const marks = [];
    for (const shape of [
      "quote alone",
      "worked out",
      "named on its line",
      "unread call",
    ] as const) {
      const beside = (stated: string) =>
        shape === "quote alone"
          ? []
          : shape === "unread call"
            ? [unread]
            : [difference(numbers, stated)];
      const line = (stated: string) => (shape === "named on its line" ? stated : "none");
      marks.push(
        await checked(contents, right.claim, {
          reply: quotes(
            quote,
            plainReply("supported", "", line(right.stated)),
            beside(right.stated),
          ),
        }),
        await checked(contents, wrong.claim, {
          judgement: "conflict",
          reply: quotes(
            quote,
            plainReply("contradicted", change, line(wrong.stated)),
            beside(wrong.stated),
          ),
        }),
      );
    }

    expect(marks.map(({ state, reason }) => [state, reason])).toEqual(
      Array.from({ length: 4 }, () => [
        ["supported", null],
        ["contradicted", null],
      ]).flat(),
    );
  },
);

// protects=a sentence that states a quantity still needs the calculation the model was refused: a stated value that is no quantity of the sentence, left unrepaired, keeps the sentence from a ✓; fails_when=the rule for a sentence with no number is widened to one that has a number; no_claim=which reason the mark gives.
test("a refused calculation still stops a sentence that states a quantity", async () => {
  const [{ contents, quote, numbers }] = NO_NUMBER;
  const claim = "签约客户比上年增加 12 家。";
  const mark = await checked(contents, claim, {
    reply: quotes(quote, plainReply("supported"), [difference(numbers, "增加")]),
  });

  expect(mark.state).toBe("not-checked");
});
